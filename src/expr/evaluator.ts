import { Expr, SqlType, SubqueryStmt } from "../sql/ast.js";
import { Value, NULL, binaryOperands, bool, compareValues, num, sqlTypeOf, truthy, valueHashKey } from "./value.js";

export interface RowMetadata {
  /** columnType[i] gives the runtime type of output column i */
  columnCount: number;
  columnTypes: SqlType[];
  columnNames: string[];
}

export class EvalError extends Error {}

/** Standard eval context: resolve by column name (first match wins). */
export interface EvalContext {
  getColumn(name: string, tableHint?: string | null): Value;
}

export function evalExpr(expr: Expr, row: EvalContext, meta?: RowMetadata | null): Value {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "vector":
      return expr.value.slice();

    case "col": {
      let v: Value;
      try {
        v = row.getColumn(expr.name, expr.table);
      } catch {
        throw new EvalError(`Unknown column "${expr.table ? expr.table + "." : ""}${expr.name}"`);
      }
      return v;
    }

    case "unop": {
      const v = evalExpr(expr.operand, row);
      switch (expr.op) {
        case "-":
          return v === null ? NULL : -(num(v) ?? NULL as number);
        case "not": {
          const b = bool(v);
          return b === null ? NULL : !b;
        }
        case "+":
          return v;
        default:
          throw new EvalError(`Unsupported unary operator "${expr.op}"`);
      }
    }

    case "binop": {
      const l = evalExpr(expr.left, row);
      const r = evalExpr(expr.right, row);
      return evalBinOp(expr.op, l, r);
    }

    case "isnull":
      return expr.negated ? valueIsNotNull(evalExpr(expr.expr, row)) : valueIsNull(evalExpr(expr.expr, row));

    case "is": {
      const v = evalExpr(expr.expr, row);
      const target = expr.value;
      if (target === null) return expr.negated ? valueIsNotNull(v) : valueIsNull(v);
      const eq = v !== null && compareValues(v, target) === 0;
      return expr.negated ? !eq : eq;
    }

    case "between": {
      const v = evalExpr(expr.expr, row);
      const low = evalExpr(expr.low, row);
      const high = evalExpr(expr.high, row);
      if (v === null || low === null || high === null) return NULL;
      const inRange = compareValues(v, low) >= 0 && compareValues(v, high) <= 0;
      return expr.negated ? !inRange : inRange;
    }

    case "like": {
      const v = evalExpr(expr.expr, row);
      const pat = evalExpr(expr.pattern, row);
      if (v === null || pat === null) return NULL;
      const m = likeMatch(String(v), String(pat));
      return expr.negated ? !m : m;
    }

    case "in": {
      const v = evalExpr(expr.expr, row);
      if (v === null) return NULL;
      if (expr.list) {
        for (const item of expr.list) {
          const iv = evalExpr(item, row);
          if (iv !== null && compareValues(v, iv) === 0) return !expr.negated;
        }
        return expr.negated;
      }
      if (expr.subquery) return evalInSubquery(v, expr.subquery, expr.negated, row);
      return NULL;
    }

    case "exists": {
      const r = subqueryHasRows(expr.subquery, row);
      return expr.negated ? !r : r;
    }

    case "cast": {
      const v = evalExpr(expr.expr, row);
      return castValue(v, expr.type);
    }

    case "case": {
      const operand = expr.operand;
      for (const { when, then } of expr.whens) {
        if (operand === null) {
          const w = bool(evalExpr(when, row));
          if (w === null) continue;
          if (w) return evalExpr(then, row);
        } else {
          const ov = evalExpr(operand, row);
          const wv = evalExpr(when, row);
          if (ov !== null && wv !== null && compareValues(ov, wv) === 0) return evalExpr(then, row);
        }
      }
      return expr.els ? evalExpr(expr.els, row) : NULL;
    }

    case "func":
      return evalFunc(expr, row);

    case "scalar":
      throw new EvalError("Scalar subquery requires asynchronous evaluation");
  }
}

export function evalBinOp(op: string, a: Value, b: Value): Value {
  if (op === "and") {
    const ba = bool(a);
    const bb = bool(b);
    if (ba === false || bb === false) return false;
    if (ba === null || bb === null) return NULL;
    return ba && bb;
  }
  if (op === "or") {
    const ba = bool(a);
    const bb = bool(b);
    if (ba === true || bb === true) return true;
    if (ba === null || bb === null) return NULL;
    return ba || bb;
  }
  if (a === null || b === null) {
    // SQL: comparisons with NULL are NULL, arithmetic with NULL is NULL,
    // string concat with NULL yields NULL as well (we keep it strict).
    return NULL;
  }
  const [x, y] = binaryOperands(a, b);
  switch (op) {
    case "+": {
      const nx = num(x), ny = num(y);
      if (nx === null || ny === null) return concatIfStrings(x, y);
      return nx + ny;
    }
    case "-":
      return (num(x) ?? NULL as number) - (num(y) ?? NULL as number);
    case "*":
      return (num(x) ?? NULL as number) * (num(y) ?? NULL as number);
    case "/": {
      const nx = num(x), ny = num(y);
      if (nx === null || ny === null) return NULL;
      if (ny === 0) throw new EvalError("Division by zero");
      return nx / ny;
    }
    case "%": {
      const nx = num(x), ny = num(y);
      if (nx === null || ny === null) return NULL;
      if (ny === 0) throw new EvalError("Division by zero");
      return nx % ny;
    }
    case "<->": {
      if (a === null || b === null) return NULL;
      if (!Array.isArray(a) || !Array.isArray(b)) {
        throw new EvalError("Vector distance (<->) requires two VECTOR operands");
      }
      if (a.length !== b.length) {
        throw new EvalError(`Vector distance dimension mismatch: ${a.length} vs ${b.length}`);
      }
      let sum = 0;
      for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
      }
      return Math.sqrt(sum);
    }
    case "||": {
      if (a === null || b === null) return NULL;
      return String(a) + String(b);
    }
    case "=":
    case "==": {
      if (a === null || b === null) return NULL;
      return compareValues(a, b) === 0;
    }
    case "!=":
    case "<>": {
      if (a === null || b === null) return NULL;
      return compareValues(a, b) !== 0;
    }
    case "<":
      return (a === null || b === null) ? NULL : compareValues(a, b) < 0;
    case "<=":
      return (a === null || b === null) ? NULL : compareValues(a, b) <= 0;
    case ">":
      return (a === null || b === null) ? NULL : compareValues(a, b) > 0;
    case ">=":
      return (a === null || b === null) ? NULL : compareValues(a, b) >= 0;
    default:
      throw new EvalError(`Unsupported operator "${op}"`);
  }
}

function concatIfStrings(x: Value, y: Value): Value {
  if (typeof x === "string" && typeof y === "string") return x + y;
  return NULL;
}

// ========================= Subqueries (EXISTS / IN (SELECT)) =========================

/** Row shape produced by subquery execution. */
export interface SubqueryRow {
  values: Value[];
  schema: string[];
}

/** Executes a subquery SELECT against the engine. */
export interface SubqueryRunner {
  run(sub: SubqueryStmt, outer: EvalContext | null): Promise<SubqueryRow[]>;
}

/** True when the expression contains EXISTS or IN (subquery) nodes. */
export function containsSubquery(e: Expr): boolean {
  switch (e.kind) {
    case "exists":
    case "scalar":
      return true;
    case "in":
      return e.subquery !== null || containsSubquery(e.expr);
    case "binop":
      return containsSubquery(e.left) || containsSubquery(e.right);
    case "unop":
      return containsSubquery(e.operand);
    case "func":
      return e.args.some(containsSubquery);
    case "case":
      return (
        (e.operand !== null && containsSubquery(e.operand)) ||
        e.whens.some((w) => containsSubquery(w.when) || containsSubquery(w.then)) ||
        (e.els !== null && containsSubquery(e.els))
      );
    case "is":
    case "between":
    case "like":
    case "isnull":
    case "cast":
      return containsSubquery(e.expr);
    default:
      return false;
  }
}

/**
 * Async expression evaluation that can execute subqueries. Used when the
 * expression tree contains EXISTS or IN (subquery) nodes; otherwise the
 * synchronous evalExpr path is used.
 */
export async function evalExprAsync(expr: Expr, row: EvalContext, sub: SubqueryRunner): Promise<Value> {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "vector":
      return expr.value.slice();
    case "col":
      return row.getColumn(expr.name, expr.table);
    case "unop": {
      const v = await evalExprAsync(expr.operand, row, sub);
      switch (expr.op) {
        case "-":
          return v === null ? NULL : -(num(v) ?? (NULL as number));
        case "not": {
          const b = bool(v);
          return b === null ? NULL : !b;
        }
        case "+":
          return v;
        default:
          throw new EvalError(`Unsupported unary operator "${expr.op}"`);
      }
    }
    case "binop": {
      const l = await evalExprAsync(expr.left, row, sub);
      const r = await evalExprAsync(expr.right, row, sub);
      return evalBinOp(expr.op, l, r);
    }
    case "isnull":
      return expr.negated
        ? valueIsNotNull(await evalExprAsync(expr.expr, row, sub))
        : valueIsNull(await evalExprAsync(expr.expr, row, sub));
    case "is": {
      const v = await evalExprAsync(expr.expr, row, sub);
      const target = expr.value;
      if (target === null) return expr.negated ? valueIsNotNull(v) : valueIsNull(v);
      const eq = v !== null && compareValues(v, target) === 0;
      return expr.negated ? !eq : eq;
    }
    case "between": {
      const v = await evalExprAsync(expr.expr, row, sub);
      const low = await evalExprAsync(expr.low, row, sub);
      const high = await evalExprAsync(expr.high, row, sub);
      if (v === null || low === null || high === null) return NULL;
      const inRange = compareValues(v, low) >= 0 && compareValues(v, high) <= 0;
      return expr.negated ? !inRange : inRange;
    }
    case "like": {
      const v = await evalExprAsync(expr.expr, row, sub);
      const pat = await evalExprAsync(expr.pattern, row, sub);
      if (v === null || pat === null) return NULL;
      const m = likeMatch(String(v), String(pat));
      return expr.negated ? !m : m;
    }
    case "in": {
      const v = await evalExprAsync(expr.expr, row, sub);
      if (expr.list) {
        for (const item of expr.list) {
          const iv = await evalExprAsync(item, row, sub);
          if (iv !== null && compareValues(v, iv) === 0) return !expr.negated;
        }
        return expr.negated;
      }
      if (expr.subquery) {
        const rows = await sub.run(expr.subquery, row);
        if (v === null) return NULL;
        let sawNull = false;
        for (const r of rows) {
          if (r.schema.length === 0) continue;
          const rv = r.values[0];
          if (rv === null) {
            sawNull = true;
            continue;
          }
          if (compareValues(v, rv) === 0) return !expr.negated;
        }
        if (sawNull) return NULL;
        return expr.negated;
      }
      return NULL;
    }
    case "exists": {
      const rows = await sub.run(expr.subquery, row);
      const has = rows.length > 0;
      return expr.negated ? !has : has;
    }
    case "scalar": {
      const rows = await sub.run(expr.subquery, row);
      if (rows.length === 0) return NULL;
      const r = rows[0];
      return r.schema.length > 0 ? r.values[0] : NULL;
    }
    case "cast": {
      const v = await evalExprAsync(expr.expr, row, sub);
      return castValue(v, expr.type);
    }
    case "case": {
      const operand = expr.operand;
      for (const { when, then } of expr.whens) {
        if (operand === null) {
          const w = bool(await evalExprAsync(when, row, sub));
          if (w === null) continue;
          if (w) return evalExprAsync(then, row, sub);
        } else {
          const ov = await evalExprAsync(operand, row, sub);
          const wv = await evalExprAsync(when, row, sub);
          if (ov !== null && wv !== null && compareValues(ov, wv) === 0) return evalExprAsync(then, row, sub);
        }
      }
      return expr.els ? evalExprAsync(expr.els, row, sub) : NULL;
    }
    case "func":
      return evalFunc(expr, row);
  }
}

function castValue(v: Value, type: SqlType): Value {
  if (v === null) return null;
  switch (type) {
    case "int":
    case "bigint": {
      const n = num(v);
      if (n === null) throw new EvalError(`Cannot cast "${String(v)}" to ${type}`);
      return Math.trunc(n);
    }
    case "real": {
      const n = num(v);
      if (n === null) throw new EvalError(`Cannot cast "${String(v)}" to real`);
      return n;
    }
    case "boolean": {
      const b = bool(v);
      if (b === null) throw new EvalError(`Cannot cast "${String(v)}" to boolean`);
      return b;
    }
    case "text":
      return v === null ? null : String(v);
    case "vector": {
      if (Array.isArray(v)) return v.slice();
      throw new EvalError(`Cannot cast "${String(v)}" to vector`);
    }
  }
}

export function valueIsNull(v: Value): boolean {
  return v === null;
}

export function valueIsNotNull(v: Value): boolean {
  return v !== null;
}

/** SQL LIKE with % and _ wildcards. */
export function likeMatch(s: string, pattern: string): boolean {
  let si = 0;
  let pi = 0;
  let starP = -1;
  let starS = 0;
  while (si < s.length) {
    if (pi < pattern.length) {
      const pc = pattern[pi];
      if (pc === "%") {
        starP = pi++;
        starS = si;
        continue;
      }
      if (pc === "_" || pc.toLowerCase() === s[si].toLowerCase()) {
        si++;
        pi++;
        continue;
      }
    }
    if (starP >= 0) {
      pi = starP + 1;
      starS++;
      si = starS;
      continue;
    }
    return false;
  }
  while (pi < pattern.length && pattern[pi] === "%") pi++;
  return pi === pattern.length;
}

function evalFunc(expr: Extract<Expr, { kind: "func" }>, row: EvalContext): Value {
  const name = expr.name.toLowerCase();
  switch (name) {
    case "abs":
      return withOne(expr, row, (v) => {
        if (v === null) return NULL;
        const n = num(v);
        return n === null ? NULL : Math.abs(n);
      });
    case "round": {
      const a = evalExpr(expr.args[0], row);
      if (a === null) return NULL;
      const n = num(a);
      if (n === null) return NULL;
      if (expr.args.length >= 2) {
        const d = num(evalExpr(expr.args[1], row)) ?? 0;
        const m = Math.pow(10, d);
        return Math.round(n * m) / m;
      }
      return Math.round(n);
    }
    case "floor":
      return withOne(expr, row, (v) => (v === null ? NULL : Math.floor(num(v) ?? 0)));
    case "ceil":
    case "ceiling":
      return withOne(expr, row, (v) => (v === null ? NULL : Math.ceil(num(v) ?? 0)));
    case "upper":
    case "lower":
    case "length":
    case "trim":
    case "ltrim":
    case "rtrim":
    case "substr":
    case "substring":
    case "replace":
    case "coalesce":
    case "ifnull":
    case "nullif":
    case "min":
    case "max":
    case "greatest":
    case "least":
    case "concat":
    case "mod":
    case "pow":
    case "power":
    case "sqrt":
    case "exp":
    case "ln":
    case "log10":
    case "sign":
    case "random":
    case "now":
    case "date_now":
    case "typeof":
    case "if":
      return evalScalarFunc(name, expr, row);
    default:
      throw new EvalError(`Unknown scalar function "${expr.name}()"`);
  }
}

function withOne(expr: Extract<Expr, { kind: "func" }>, row: EvalContext, fn: (v: Value) => Value): Value {
  if (expr.args.length < 1) throw new EvalError(`Function ${expr.name}() requires an argument`);
  return fn(evalExpr(expr.args[0], row));
}

function evalScalarFunc(name: string, expr: Extract<Expr, { kind: "func" }>, row: EvalContext): Value {
  const args = expr.args.map((a) => evalExpr(a, row));
  switch (name) {
    case "upper":
      return args[0] === null ? NULL : String(args[0]).toUpperCase();
    case "lower":
      return args[0] === null ? NULL : String(args[0]).toLowerCase();
    case "length":
      return args[0] === null ? NULL : String(args[0]).length;
    case "trim":
      return args[0] === null ? NULL : String(args[0]).trim();
    case "ltrim": {
      const s = args[0];
      if (s === null) return NULL;
      const chars = args.length > 1 && args[1] !== null ? String(args[1]) : " ";
      const str = String(s);
      let i = 0;
      while (i < str.length && chars.includes(str[i])) i++;
      return str.slice(i);
    }
    case "rtrim": {
      const s = args[0];
      if (s === null) return NULL;
      const chars = args.length > 1 && args[1] !== null ? String(args[1]) : " ";
      const str = String(s);
      let i = str.length - 1;
      while (i >= 0 && chars.includes(str[i])) i--;
      return str.slice(0, i + 1);
    }
    case "substr":
    case "substring": {
      const s = args[0];
      if (s === null) return NULL;
      const str = String(s);
      const start = num(args[1]);
      if (start === null) return NULL;
      const begin = Math.trunc(start);
      const fromIdx = begin > 0 ? begin - 1 : 0;
      if (args.length >= 3) {
        const len = num(args[2]);
        if (len === null) return NULL;
        return str.slice(fromIdx, fromIdx + Math.max(0, Math.trunc(len)));
      }
      return str.slice(fromIdx);
    }
    case "replace": {
      const s = args[0];
      if (s === null) return NULL;
      return String(s).split(args[1] === null ? "" : String(args[1])).join(args[2] === null ? "" : String(args[2]));
    }
    case "coalesce":
    case "ifnull": {
      for (const a of args) if (a !== null) return a;
      return NULL;
    }
    case "nullif": {
      if (args.length < 2) throw new EvalError("nullif() requires 2 arguments");
      if (args[0] === null && args[1] === null) return NULL;
      if (args[0] !== null && args[1] !== null && compareValues(args[0], args[1]) === 0) return NULL;
      return args[0];
    }
    case "min":
    case "greatest": {
      let best: Value = NULL;
      for (const a of args) {
        if (a === null) continue;
        if (best === null || compareValues(a, best) > 0) best = a;
      }
      return best;
    }
    case "max":
    case "least": {
      let best: Value = NULL;
      for (const a of args) {
        if (a === null) continue;
        if (best === null || compareValues(a, best) < 0) best = a;
      }
      return best;
    }
    case "concat": {
      let out = "";
      for (const a of args) if (a !== null) out += String(a);
      return out;
    }
    case "mod": {
      const a = num(args[0]), b = num(args[1]);
      if (a === null || b === null) return NULL;
      if (b === 0) throw new EvalError("Division by zero");
      return a % b;
    }
    case "pow":
    case "power": {
      const a = num(args[0]), b = num(args[1]);
      if (a === null || b === null) return NULL;
      return Math.pow(a, b);
    }
    case "sqrt": {
      const a = num(args[0]);
      return a === null ? NULL : Math.sqrt(a);
    }
    case "exp": {
      const a = num(args[0]);
      return a === null ? NULL : Math.exp(a);
    }
    case "ln": {
      const a = num(args[0]);
      if (a === null) return NULL;
      if (a <= 0) throw new EvalError("ln() domain error");
      return Math.log(a);
    }
    case "log10": {
      const a = num(args[0]);
      if (a === null) return NULL;
      if (a <= 0) throw new EvalError("log10() domain error");
      return Math.log10(a);
    }
    case "sign": {
      const a = num(args[0]);
      if (a === null) return NULL;
      return Math.sign(a);
    }
    case "random": {
      if (expr.args.length > 0) {
        const seed = num(args[0]);
        if (seed !== null) {
          const s = Math.trunc(seed);
          const x = Math.sin(s * 127.1 + 311.7) * 43758.5453;
          return x - Math.floor(x);
        }
      }
      return Math.random();
    }
    case "now":
    case "date_now":
      return String(new Date().toISOString());
    case "typeof":
      return args[0] === null ? "null" : typeof args[0];
    case "if": {
      const c = bool(args[0]);
      if (c === null) throw new EvalError("if() condition cannot be NULL");
      return c ? args[1] : args[2] ?? NULL;
    }
    default:
      throw new EvalError(`Unknown scalar function "${name}()"`);
  }
}

/** Evaluate a scalar subquery (IN (...) with subquery, EXISTS). */
function evalInSubquery(v: Value, sub: SubqueryStmt, negated: boolean, outer: EvalContext): Value {
  // Note: full correlated-subquery support drops into the executor; this path
  // is used by the planner only for uncorrelated checks.
  throw new EvalError("Subquery evaluation requires executor context");
}

function subqueryHasRows(sub: SubqueryStmt, outer: EvalContext): boolean {
  throw new EvalError("Subquery evaluation requires executor context");
}

export { valueHashKey, sqlTypeOf };