import type { Expr, Literal, SelectStmt, SqlType, TableRef } from "../sql/ast.js";
import {
  AggregateNode, DistinctNode, FilterNode, JoinNode, LimitNode, PlanNode,
  ProjectNode, SortNode, TableScanNode,
} from "./plan.js";
import { isAggregateCall } from "./plan.js";

export interface PlannerContext {
  /** table -> list of column names (from catalog) */
  tables: Map<string, string[]>;
}

export class PlannerError extends Error {}

/**
 * Builds a logical plan from a SELECT AST:
 *   scan → join → filter → (aggregate → relabel) → project → distinct → sort → limit
 */
export class Planner {
  private ctx: PlannerContext;

  constructor(ctx: PlannerContext) {
    this.ctx = ctx;
  }

  planSelect(stmt: SelectStmt): PlanNode {
    let root: PlanNode;

    if (!stmt.from) {
      root = { kind: "scan", table: "__single_row__", alias: "", columns: [], children: [], output: [] } as TableScanNode;
    } else {
      root = this.planTableRef(stmt.from);
      for (const join of stmt.joins) {
        const right = this.planTableRef(join.ref);
        root = {
          kind: "join",
          joinType: join.type === "cross" ? "cross" : join.type,
          on: join.on,
          children: [root, right],
          output: [],
        } as JoinNode;
        this.computeOutput(root);
      }
    }

    if (stmt.where) {
      const filter: FilterNode = {
        kind: "filter",
        expr: stmt.where,
        children: [root],
        output: root.output,
      };
      root = filter;
    }

    const hasAggregates =
      stmt.groupBy.length > 0 || stmt.items.some((i) => i.kind === "expr" && isAggregateCall(i.expr));

    if (hasAggregates) {
      // aggregate → relabel: HAVING / ORDER BY reference final output names (alias or outputName)
      root = this.buildAggregate(stmt, root);
      root = this.buildRelabel(stmt, root);
      if (stmt.having) {
        const filter: FilterNode = {
          kind: "filter",
          expr: this.rewriteAggExpr(stmt, stmt.having),
          children: [root],
          output: root.output,
        };
        root = filter;
      }
      if (stmt.orderBy.length > 0) {
        root = this.buildSort(stmt, root, true);
      }
    } else {
      // sort before project so keys may reference non-selected / qualified columns
      if (stmt.orderBy.length > 0) {
        root = this.buildSort(stmt, root, false);
      }
      const p = this.buildProject(stmt, root);
      this.computeOutput(p);
      root = p;
    }

    if (stmt.distinct) {
      const d: DistinctNode = { kind: "distinct", children: [root], output: root.output };
      root = d;
    }

    let limit: number | null = null;
    let offset = 0;
    if (stmt.limit) {
      const v = this.constEval(stmt.limit);
      if (v !== null) limit = Math.trunc(Number(v));
    }
    if (stmt.offset) {
      const v = this.constEval(stmt.offset);
      if (v !== null) offset = Math.trunc(Number(v));
    }
    if (limit !== null || offset > 0) {
      const lim: LimitNode = { kind: "limit", limit, offset, children: [root], output: root.output };
      root = lim;
    }

    return root;
  }

  /** Adds the aggregate node only (output rows carry __grp_i / __agg_i columns). */
  private buildAggregate(stmt: SelectStmt, child: PlanNode): PlanNode {
    const agg: AggregateNode = {
      kind: "aggregate",
      groupBy: stmt.groupBy,
      aggs: stmt.items
        .filter((i) => i.kind === "expr" && isAggregateCall(i.expr))
        .map((i) => ({
          expr: (i as { expr: Expr }).expr,
          out: (i as { expr: Expr; alias: string | null }).alias ?? outputName((i as { expr: Expr }).expr),
        })),
      children: [child],
      output: [],
    };
    return agg;
  }

  /** Relabels aggregate output rows to the final SELECT names. */
  private buildRelabel(stmt: SelectStmt, child: PlanNode): ProjectNode {
    const aggItems = stmt.items.filter((i) => i.kind === "expr" && isAggregateCall(i.expr));
    const refs: { expr: Expr; out: string | null }[] = [];
    let aggIdx = 0;
    for (const item of stmt.items) {
      if (item.kind === "star") {
        refs.push({ expr: { kind: "col", table: null, name: "__star__" }, out: null });
        continue;
      }
      if (isAggregateCall(item.expr)) {
        refs.push({ expr: { kind: "col", table: null, name: `__agg_${aggIdx++}` }, out: item.alias ?? outputName(item.expr) });
        continue;
      }
      const gbIdx = stmt.groupBy.findIndex((g) => exprEq(g, item.expr));
      if (gbIdx >= 0) {
        refs.push({ expr: { kind: "col", table: null, name: `__grp_${gbIdx}` }, out: item.alias ?? outputName(item.expr) });
        continue;
      }
      // expression not in group by: evaluated on the first row of the group
      refs.push({ expr: item.expr, out: item.alias ?? outputName(item.expr) });
    }
    const proj: ProjectNode = {
      kind: "project",
      exprs: refs,
      children: [child],
      output: [],
    };
    this.computeOutput(proj);
    return proj;
  }

  private buildSort(stmt: SelectStmt, child: PlanNode, aggregate: boolean): SortNode {
    const sort: SortNode = {
      kind: "sort",
      by: stmt.orderBy.map((o) => {
        const expr = this.rewriteSortExpr(stmt, o.expr, aggregate);
        return { expr, desc: o.desc };
      }),
      children: [child],
      output: child.output,
    };
    return sort;
  }

  private rewriteSortExpr(stmt: SelectStmt, expr: Expr, aggregate: boolean): Expr {
    if (aggregate) return this.rewriteAggExpr(stmt, expr);
    // non-aggregate: ORDER BY alias → the underlying select expression
    if (expr.kind === "col") {
      const item = stmt.items.find(
        (i): i is { kind: "expr"; expr: Expr; alias: string | null } =>
          i.kind === "expr" && (i.alias ?? outputName(i.expr)).toLowerCase() === expr.name.toLowerCase(),
      );
      if (item) return item.expr;
    }
    return expr;
  }

  /**
   * Rewrites a HAVING / aggregate ORDER BY expression so it can be evaluated on
   * relabeled aggregate rows (columns are the final output names).
   */
  private rewriteAggExpr(stmt: SelectStmt, expr: Expr): Expr {
    if (isAggregateCall(expr)) {
      const item = stmt.items.find((i) => i.kind === "expr" && exprEq(i.expr, expr));
      if (item && item.kind === "expr") {
        return { kind: "col", table: null, name: item.alias ?? outputName(item.expr) };
      }
      return expr;
    }
    if (expr.kind === "col") {
      const item = stmt.items.find(
        (i): i is { kind: "expr"; expr: Expr; alias: string | null } =>
          i.kind === "expr" && (i.alias ?? outputName(i.expr)).toLowerCase() === expr.name.toLowerCase(),
      );
      if (item) return { kind: "col", table: null, name: item.alias ?? outputName(item.expr) };
      return expr;
    }
    if (expr.kind === "binop") {
      return {
        kind: "binop",
        op: expr.op,
        left: this.rewriteAggExpr(stmt, expr.left),
        right: this.rewriteAggExpr(stmt, expr.right),
      };
    }
    if (expr.kind === "unop") {
      return { kind: "unop", op: expr.op, operand: this.rewriteAggExpr(stmt, expr.operand) };
    }
    if (expr.kind === "func") {
      return {
        kind: "func",
        name: expr.name,
        star: expr.star,
        distinct: expr.distinct,
        args: expr.args.map((a) => this.rewriteAggExpr(stmt, a)),
      };
    }
    return expr;
  }

  private buildProject(stmt: SelectStmt, child: PlanNode): ProjectNode {
    const p: ProjectNode = {
      kind: "project",
      exprs: stmt.items.map((i) =>
        i.kind === "star" ? { expr: { kind: "col", table: null, name: "*" }, out: null } : { expr: i.expr, out: i.alias ?? outputName(i.expr) },
      ),
      children: [child],
      output: [],
    };
    this.computeOutput(p);
    return p;
  }

  private constEval(e: Expr): number | null {
    if (e.kind === "literal" && typeof e.value === "number") return e.value;
    if (e.kind === "literal" && typeof e.value === "string") {
      const n = Number(e.value);
      return Number.isNaN(n) ? null : n;
    }
    return null;
  }

  private planTableRef(ref: TableRef): PlanNode {
    if (ref.kind === "subquery") {
      const subPlanner = new Planner(this.ctx);
      return subPlanner.planSelect(ref.query);
    }
    const cols = this.ctx.tables.get(ref.table.toLowerCase()) ?? [];
    const node: TableScanNode = {
      kind: "scan",
      table: ref.table,
      alias: ref.alias ?? ref.table,
      columns: cols,
      children: [],
      output: cols,
    };
    return node;
  }

  private computeOutput(n: PlanNode): void {
    switch (n.kind) {
      case "join": {
        const j = n as JoinNode;
        n.output = [...j.children[0].output, ...j.children[1].output];
        break;
      }
      case "project": {
        const p = n as ProjectNode;
        n.output = p.exprs.map((x) => x.out ?? "");
        break;
      }
      case "filter":
        n.output = n.children[0].output;
        break;
      default:
        break;
    }
  }
}

function outputName(e: Expr): string {
  if (e.kind === "col") return e.name;
  if (e.kind === "func") return e.name;
  if (e.kind === "literal") return String(e.value);
  return "expr";
}

/** Structural equality: the parser creates separate objects for identical exprs. */
function exprEq(a: Expr, b: Expr): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "col": {
      const o = b as { table: string | null; name: string };
      return a.name.toLowerCase() === o.name.toLowerCase() && (a.table ?? "").toLowerCase() === (o.table ?? "").toLowerCase();
    }
    case "literal":
      return a.value === (b as { value: Literal }).value;
    case "func": {
      const f = b as { name: string; args: Expr[]; distinct?: boolean; star?: boolean };
      return (
        a.name.toLowerCase() === f.name.toLowerCase() &&
        (a.star ?? false) === (f.star ?? false) &&
        (a.distinct ?? false) === (f.distinct ?? false) &&
        a.args.length === f.args.length &&
        a.args.every((x, i) => exprEq(x, f.args[i]))
      );
    }
    case "binop": {
      const o = b as { op: string; left: Expr; right: Expr };
      return a.op === o.op && exprEq(a.left, o.left) && exprEq(a.right, o.right);
    }
    case "unop": {
      const o = b as { op: string; operand: Expr };
      return a.op === o.op && exprEq(a.operand, o.operand);
    }
    case "is": {
      const o = b as { expr: Expr; value: Literal | null; negated: boolean };
      return exprEq(a.expr, o.expr) && a.value === o.value && a.negated === o.negated;
    }
    case "cast": {
      const o = b as { expr: Expr; type: SqlType };
      return a.type === o.type && exprEq(a.expr, o.expr);
    }
    case "case": {
      const o = b as { operand: Expr | null; whens: { when: Expr; then: Expr }[]; els: Expr | null };
      return (
        (a.operand === null && o.operand === null || (a.operand !== null && o.operand !== null && exprEq(a.operand, o.operand))) &&
        a.whens.length === o.whens.length &&
        a.whens.every((w, i) => exprEq(w.when, o.whens[i].when) && exprEq(w.then, o.whens[i].then)) &&
        (a.els === null && o.els === null || (a.els !== null && o.els !== null && exprEq(a.els, o.els)))
      );
    }
    case "between": {
      const o = b as { expr: Expr; low: Expr; high: Expr; negated: boolean };
      return a.negated === o.negated && exprEq(a.expr, o.expr) && exprEq(a.low, o.low) && exprEq(a.high, o.high);
    }
    case "like": {
      const o = b as { expr: Expr; pattern: Expr; negated: boolean };
      return a.negated === o.negated && exprEq(a.expr, o.expr) && exprEq(a.pattern, o.pattern);
    }
    case "isnull": {
      const o = b as { expr: Expr; negated: boolean };
      return a.negated === o.negated && exprEq(a.expr, o.expr);
    }
    case "in": {
      const o = b as { expr: Expr; subquery: SelectStmt | null; list: Expr[] | null; negated: boolean };
      return (
        a.negated === o.negated &&
        exprEq(a.expr, o.expr) &&
        a.subquery === o.subquery &&
        (a.list === null && o.list === null ||
          (a.list !== null && o.list !== null && a.list.length === o.list.length && a.list.every((x, i) => exprEq(x, o.list![i]))))
      );
    }
    case "exists":
      return a.subquery === (b as { subquery: SelectStmt }).subquery && a.negated === (b as { negated: boolean }).negated;
  }
}

export function hasAggregateExpr(e: Expr): boolean {
  if (isAggregateCall(e)) return true;
  if (e.kind === "binop") return hasAggregateExpr(e.left) || hasAggregateExpr(e.right);
  if (e.kind === "unop") return hasAggregateExpr(e.operand);
  if (e.kind === "func") return e.args.some(hasAggregateExpr);
  return false;
}