import type { Expr, Literal, SelectStmt, SetOpStmt, SqlType, TableRef } from "../sql/ast.js";
import type { Value } from "../expr/value.js";
import { compareValues } from "../expr/value.js";
import {
  AggregateNode, DistinctNode, FilterNode, IndexScanNode, JoinNode, LimitNode, PlanNode,
  ProjectNode, SetOpNode, SortNode, TableScanNode,
} from "./plan.js";
import { isAggregateCall } from "./plan.js";

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface PlannerContext {
  /** table -> list of column names (from catalog) */
  tables: Map<string, string[]>;
  /** table -> available indexes (from catalog) */
  indexes?: Map<string, IndexInfo[]>;
  /** table -> estimated row count (from catalog/heap) */
  sizes?: Map<string, number>;
}

export class PlannerError extends Error {}

/**
 * Builds a logical plan from a SELECT / set-op AST:
 *   scan → join → filter → (aggregate → relabel) → project → distinct → sort → limit
 */
export class Planner {
  private ctx: PlannerContext;

  constructor(ctx: PlannerContext) {
    this.ctx = ctx;
  }

  planSelect(stmt: SelectStmt | SetOpStmt): PlanNode {
    if (stmt.kind === "setop") return this.planSetOp(stmt);
    return this.planSelectCore(stmt);
  }

  private planSelectCore(stmt: SelectStmt): PlanNode {
    let root: PlanNode;

    if (!stmt.from) {
      root = { kind: "scan", table: "__single_row__", alias: "", columns: [], children: [], output: [] } as TableScanNode;
    } else {
      const plan = this.planFromAndWhere(stmt);
      root = plan.root;
      if (plan.residual.length > 0) {
        const filter: FilterNode = {
          kind: "filter",
          expr: plan.residual.length === 1 ? plan.residual[0] : andExpr(plan.residual),
          children: [root],
          output: root.output,
        };
        root = filter;
      }
    }

    const hasAggregates =
      stmt.groupBy.length > 0 || stmt.items.some((i) => i.kind === "expr" && isAggregateCall(i.expr));

    if (hasAggregates) {
      // aggregate → HAVING → sort, all over __grp_i / __agg_i → relabel
      root = this.buildAggregate(stmt, root);
      if (stmt.having) {
        const filter: FilterNode = {
          kind: "filter",
          expr: this.rewriteHavingExpr(stmt, stmt.having),
          children: [root],
          output: root.output,
        };
        root = filter;
      }
      if (stmt.orderBy.length > 0) {
        root = this.buildSort(stmt, root, true);
      }
      root = this.buildRelabel(stmt, root);
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

  private planSetOp(stmt: SetOpStmt): PlanNode {
    const left = this.planSelect(stmt.left);
    const right = this.planSelect(stmt.right);
    if (left.output.length !== right.output.length) {
      throw new PlannerError(
        `Set operation requires the same number of columns on both sides (${left.output.length} vs ${right.output.length})`,
      );
    }
    let root: PlanNode = {
      kind: "setop",
      op: stmt.op,
      all: stmt.all,
      children: [left, right],
      output: left.output,
    } as SetOpNode;
    if (stmt.orderBy.length > 0) {
      const sort: SortNode = {
        kind: "sort",
        by: stmt.orderBy.map((o) => ({ expr: o.expr, desc: o.desc })),
        children: [root],
        output: root.output,
      };
      root = sort;
    }
    let limit: number | null = null;
    let offset = 0;
    if (stmt.limit) limit = Math.trunc(Number(this.constEval(stmt.limit) ?? 0));
    if (stmt.offset) offset = Math.trunc(Number(this.constEval(stmt.offset) ?? 0));
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
    if (aggregate) return this.rewriteHavingExpr(stmt, expr);
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
   * aggregate output rows (columns are __grp_i / __agg_i). References may target
   * select aliases, aggregates, and group columns (selected or not).
   */
  private rewriteHavingExpr(stmt: SelectStmt, expr: Expr): Expr {
    return this.rwHaving(stmt, expr, true);
  }

  private rwHaving(stmt: SelectStmt, expr: Expr, allowAlias: boolean): Expr {
    if (isAggregateCall(expr)) {
      const idx = this.aggItemIndex(stmt, expr);
      if (idx >= 0) return { kind: "col", table: null, name: `__agg_${idx}` };
      throw new PlannerError("references an aggregate not present in the SELECT list");
    }
    if (expr.kind === "col") {
      if (allowAlias) {
        const item = stmt.items.find((i) => i.kind === "expr" && (i.alias ?? outputName(i.expr)).toLowerCase() === expr.name.toLowerCase());
        if (item && item.kind === "expr") return this.rwHaving(stmt, item.expr, false);
      }
      const gbIdx = stmt.groupBy.findIndex((g) => exprEq(g, expr));
      if (gbIdx >= 0) return { kind: "col", table: null, name: `__grp_${gbIdx}` };
      throw new PlannerError(`references column "${expr.name}" which is not a group column, alias, or aggregate`);
    }
    if (expr.kind === "binop") {
      return {
        kind: "binop",
        op: expr.op,
        left: this.rewriteHavingExpr(stmt, expr.left),
        right: this.rewriteHavingExpr(stmt, expr.right),
      };
    }
    if (expr.kind === "unop") {
      return { kind: "unop", op: expr.op, operand: this.rewriteHavingExpr(stmt, expr.operand) };
    }
    if (expr.kind === "func") {
      return {
        kind: "func",
        name: expr.name,
        star: expr.star,
        distinct: expr.distinct,
        args: expr.args.map((a) => this.rewriteHavingExpr(stmt, a)),
      };
    }
    if (expr.kind === "case") {
      return {
        kind: "case",
        operand: expr.operand ? this.rewriteHavingExpr(stmt, expr.operand) : null,
        whens: expr.whens.map((w) => ({
          when: this.rewriteHavingExpr(stmt, w.when),
          then: this.rewriteHavingExpr(stmt, w.then),
        })),
        els: expr.els ? this.rewriteHavingExpr(stmt, expr.els) : null,
      };
    }
    if (expr.kind === "between") {
      return {
        kind: "between",
        expr: this.rewriteHavingExpr(stmt, expr.expr),
        low: this.rewriteHavingExpr(stmt, expr.low),
        high: this.rewriteHavingExpr(stmt, expr.high),
        negated: expr.negated,
      };
    }
    if (expr.kind === "like") {
      return {
        kind: "like",
        expr: this.rewriteHavingExpr(stmt, expr.expr),
        pattern: this.rewriteHavingExpr(stmt, expr.pattern),
        negated: expr.negated,
      };
    }
    if (expr.kind === "isnull") {
      return { kind: "isnull", expr: this.rewriteHavingExpr(stmt, expr.expr), negated: expr.negated };
    }
    if (expr.kind === "is") {
      return {
        kind: "is",
        expr: this.rewriteHavingExpr(stmt, expr.expr),
        value: expr.value,
        negated: expr.negated,
      };
    }
    if (expr.kind === "cast") {
      return { kind: "cast", expr: this.rewriteHavingExpr(stmt, expr.expr), type: expr.type };
    }
    if (expr.kind === "in") {
      return {
        kind: "in",
        expr: this.rewriteHavingExpr(stmt, expr.expr),
        subquery: expr.subquery,
        list: expr.list ? expr.list.map((x) => this.rewriteHavingExpr(stmt, x)) : null,
        negated: expr.negated,
      };
    }
    return expr;
  }

  private aggItemIndex(stmt: SelectStmt, expr: Expr): number {
    const aggItems = stmt.items.filter(
      (i): i is { kind: "expr"; expr: Expr; alias: string | null } => i.kind === "expr" && isAggregateCall(i.expr),
    );
    return aggItems.findIndex((i) => exprEq(i.expr, expr));
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

  /**
   * Optimizer: attribute WHERE conjuncts to their table refs (predicate
   * push-down), pick index access paths per table, and reorder inner/cross
   * joins by estimated cardinality.
   */
  private planFromAndWhere(stmt: SelectStmt): { root: PlanNode; residual: Expr[] } {
    const mkSlot = (ref: TableRef, joinType: RefSlot["joinType"], on: Expr | null): RefSlot => {
      const alias = ref.kind === "table" ? (ref.alias ?? ref.table).toLowerCase() : ref.alias.toLowerCase();
      const cols = ref.kind === "table" ? this.ctx.tables.get(ref.table.toLowerCase()) ?? [] : [];
      return {
        ref,
        joinType,
        on,
        preds: [],
        size: this.estRefRows(ref),
        node: undefined as unknown as PlanNode,
        alias,
        cols,
      };
    };
    const slots: RefSlot[] = [];
    slots.push(mkSlot(stmt.from!, null, null));
    for (const j of stmt.joins) {
      slots.push(mkSlot(j.ref, j.type === "cross" ? "cross" : j.type, j.on));
    }

    // partition WHERE conjuncts; only refs before the first outer join may take
    // pushed predicates (filters on the nullable side of an outer join must stay above it)
    const residual: Expr[] = [];
    if (stmt.where) {
      const firstOuter = slots.findIndex((s, i) => i > 0 && (s.joinType === "left" || s.joinType === "right"));
      const pushRange = firstOuter === -1 ? slots.length : firstOuter;
      for (const c of splitAnd(stmt.where)) {
        const owner = this.attributeExpr(c, slots);
        if (owner !== null && owner < pushRange) {
          slots[owner].preds.push(c);
        } else {
          residual.push(c);
        }
      }
    }

    // per-table access path + post-access filter
    for (const s of slots) {
      if (s.preds.length === 0) {
        s.node = this.planTableRef(s.ref);
        s.node.estRows = s.size;
        continue;
      }
      const base = this.planTableRef(s.ref);
      base.estRows = s.size;
      const idx = this.tryIndexScan(s.ref, s.preds);
      s.node = (idx ?? base) as PlanNode;
      if (idx) s.node.estRows = Math.max(1, Math.round((s.size * 10) / Math.max(1, idx.prefix.length * 100 + 10)));
      const filter: FilterNode = {
        kind: "filter",
        expr: s.preds.length === 1 ? s.preds[0] : andExpr(s.preds),
        children: [s.node],
        output: s.node.output,
      };
      filter.estRows = Math.max(1, Math.round((s.node.estRows ?? s.size) * Math.pow(0.3, s.preds.length)));
      s.node = filter;
    }

    // reorder inner/cross joins by estimated row count (cheapest first);
    // join edges (ON / join kind) keep their original left-to-right order;
    // skip entirely when SELECT * would observe a different column order
    const canReorder =
      stmt.joins.every((j) => j.type === "inner" || j.type === "cross") &&
      !stmt.items.some((i) => i.kind === "star");
    if (canReorder) {
      slots.sort((a, b) => (a.node.estRows ?? a.size) - (b.node.estRows ?? b.size));
    }

    let root = slots[0].node;
    for (let i = 1; i < slots.length; i++) {
      const s = slots[i];
      const edge = stmt.joins[i - 1];
      const join: JoinNode = {
        kind: "join",
        joinType: edge.type === "cross" ? "cross" : edge.type,
        on: edge.on,
        equi: edge.on ? this.allocEqui(edge.on, i, slots) : null,
        children: [root, s.node],
        output: [],
      };
      join.estRows = this.joinEstimate(join, s);
      this.computeOutput(join);
      root = join;
    }
    return { root, residual };
  }

  private estRefRows(ref: TableRef): number {
    if (ref.kind === "subquery") return 100;
    return this.ctx.sizes?.get(ref.table.toLowerCase()) ?? 10;
  }

  /**
   * Split an ON expr into equi-join keys aligned with children[0] (root side,
   * slots 0..rightIdx-1) and children[1] (slot rightIdx). Returns null when the
   * expr cannot be safely attributed (e.g. unqualified columns).
   */
  private allocEqui(
    on: Expr,
    rightIdx: number,
    slots: RefSlot[],
  ): { leftKeys: Expr[]; rightKeys: Expr[]; extraOn: Expr | null } | null {
    const side = (col: Expr): 0 | 1 | null => {
      if (col.kind !== "col" || !col.table) return null;
      const owner = slots.findIndex((s) => s.alias === col.table!.toLowerCase());
      if (owner === -1) return null;
      return owner === rightIdx ? 1 : 0;
    };
    if (on.kind === "binop" && on.op === "=") {
      const ls = side(on.left);
      const rs = side(on.right);
      if (ls === null || rs === null || ls === rs) return null;
      return ls === 0
        ? { leftKeys: [on.left], rightKeys: [on.right], extraOn: null }
        : { leftKeys: [on.right], rightKeys: [on.left], extraOn: null };
    }
    if (on.kind === "binop" && on.op === "and") {
      const p1 = this.allocEqui(on.left, rightIdx, slots);
      const p2 = this.allocEqui(on.right, rightIdx, slots);
      if (p1 && p2) {
        return {
          leftKeys: [...p1.leftKeys, ...p2.leftKeys],
          rightKeys: [...p1.rightKeys, ...p2.rightKeys],
          extraOn: null,
        };
      }
      if (p1) return { ...p1, extraOn: on.right };
      if (p2) return { ...p2, extraOn: on.left };
      return null;
    }
    return null;
  }

  private joinEstimate(join: JoinNode, right: RefSlot): number {
    const l = join.children[0].estRows ?? 10;
    const r = right.node.estRows ?? right.size;
    switch (join.joinType) {
      case "cross":
        return l * r;
      case "inner":
        return Math.max(1, Math.round(l * r * 0.1));
      case "left":
        return l + Math.round(l * r * 0.5);
      case "right":
        return r + Math.round(r * l * 0.5);
    }
  }

  /**
   * Attribute a conjunct to exactly one table ref. Returns the slot index, or
   * null when the conjunct references more than one ref / unknown columns.
   */
  private attributeExpr(e: Expr, slots: RefSlot[]): number | null {
    const owner = new Set<number>();
    let unknown = false;
    (function walk(x: Expr): void {
      switch (x.kind) {
        case "col": {
          if (x.table) {
            const idx = slots.findIndex((s) => s.alias === x.table!.toLowerCase());
            if (idx < 0) unknown = true;
            else owner.add(idx);
          } else {
            const matches = slots
              .map((s, i) => ({ s, i }))
              .filter(({ s }) => s.cols.some((c) => c.toLowerCase() === x.name.toLowerCase()));
            if (matches.length === 1) owner.add(matches[0].i);
            else unknown = true;
          }
          break;
        }
        case "binop":
          walk(x.left);
          walk(x.right);
          break;
        case "unop":
          walk(x.operand);
          break;
        case "func":
          for (const a of x.args) walk(a);
          break;
        case "case":
          if (x.operand) walk(x.operand);
          for (const w of x.whens) {
            walk(w.when);
            walk(w.then);
          }
          if (x.els) walk(x.els);
          break;
        case "cast":
          walk(x.expr);
          break;
        case "between":
          walk(x.expr);
          walk(x.low);
          walk(x.high);
          break;
        case "like":
          walk(x.expr);
          walk(x.pattern);
          break;
        case "in":
          walk(x.expr);
          for (const v of x.list ?? []) walk(v);
          break;
        case "is":
        case "isnull":
          walk(x.expr);
          break;
        default:
          break;
      }
    })(e);
    if (!unknown && owner.size === 1) return [...owner][0];
    return null;
  }

  /** Pick an index usable by the given predicates; returns an index scan node or null. */
  private tryIndexScan(ref: TableRef, preds: Expr[]): IndexScanNode | null {
    if (ref.kind !== "table") return null;
    const tableKey = ref.table.toLowerCase();
    const alias = (ref.alias ?? ref.table).toLowerCase();
    const tCols = this.ctx.tables.get(tableKey) ?? [];
    const candidates = this.ctx.indexes?.get(tableKey) ?? [];
    if (candidates.length === 0) return null;
    const indexed: IndexPred[] = [];
    for (const c of preds) {
      const p = asIndexPred(c, tCols, alias);
      if (p) indexed.push(p);
    }
    if (indexed.length === 0) return null;
    let best: { name: string; prefix: IndexPred[]; range: IndexPred | null; score: number } | null = null;
    for (const info of candidates) {
      const prefix: IndexPred[] = [];
      let range: IndexPred | null = null;
      for (const col of info.columns) {
        const c = col.toLowerCase();
        const eq = indexed.find((p) => p.col === c && p.op === "eq");
        if (eq) {
          prefix.push(eq);
          continue;
        }
        const r = indexed.find((p) => p.col === c && p.op !== "eq");
        if (r && !range) range = r;
        break;
      }
      if (prefix.length === 0 && !range) continue;
      const score = prefix.length * 100 + (range ? 10 : 0) - info.columns.length;
      if (!best || score > best.score) best = { name: info.name, prefix, range, score };
    }
    if (!best) return null;
    let lo: { col: string; value: Value } | null = null;
    let hi: { col: string; value: Value } | null = null;
    if (best.range) {
      const r = best.range;
      switch (r.op) {
        case "gt":
        case "ge":
          lo = { col: r.col, value: r.values[0] };
          break;
        case "lt":
        case "le":
          hi = { col: r.col, value: r.values[0] };
          break;
        case "between":
          lo = { col: r.col, value: r.values[0] };
          hi = { col: r.col, value: r.values[1] };
          break;
        case "in": {
          let min = r.values[0];
          let max = r.values[0];
          for (const v of r.values) {
            if (compareValues(min, v) > 0) min = v;
            if (compareValues(max, v) < 0) max = v;
          }
          lo = { col: r.col, value: min };
          hi = { col: r.col, value: max };
          break;
        }
      }
    }
    const node: IndexScanNode = {
      kind: "indexscan",
      table: ref.table,
      alias: ref.alias ?? ref.table,
      columns: tCols,
      index: best.name,
      prefix: best.prefix.map((p) => ({ col: p.col, value: p.values[0] })),
      lo,
      hi,
      children: [],
      output: tCols,
    };
    return node;
  }

  private planTableRef(ref: TableRef): PlanNode {
    if (ref.kind === "subquery") {
      const subPlanner = new Planner(this.ctx);
      const subPlan = subPlanner.planSelect(ref.query);
      // rename the derived table's columns onto its alias
      const proj: ProjectNode = {
        kind: "project",
        exprs: subPlan.output.map((name) => ({
          expr: { kind: "col", table: null, name },
          out: name,
          table: ref.alias,
        })),
        children: [subPlan],
        output: subPlan.output,
      };
      return proj;
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
      case "setop":
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
    case "scalar":
      return a.subquery === (b as { subquery: SelectStmt }).subquery;
  }
}

export function hasAggregateExpr(e: Expr): boolean {
  if (isAggregateCall(e)) return true;
  if (e.kind === "binop") return hasAggregateExpr(e.left) || hasAggregateExpr(e.right);
  if (e.kind === "unop") return hasAggregateExpr(e.operand);
  if (e.kind === "func") return e.args.some(hasAggregateExpr);
  return false;
}

// ---------------- index predicate helpers ----------------

interface IndexPred {
  col: string;
  op: "eq" | "gt" | "ge" | "lt" | "le" | "between" | "in";
  values: Value[];
}

/** A FROM/JOIN table reference and the predicates pushed down to it. */
interface RefSlot {
  ref: TableRef;
  joinType: "inner" | "left" | "right" | "cross" | null;
  on: Expr | null;
  preds: Expr[];
  size: number;
  node: PlanNode;
  readonly alias: string;
  readonly cols: string[];
}

function andExpr(parts: Expr[]): Expr {
  let root: Expr = parts[0];
  for (let i = 1; i < parts.length; i++) {
    root = { kind: "binop", op: "and", left: root, right: parts[i] };
  }
  return root;
}

function splitAnd(e: Expr): Expr[] {
  if (e.kind === "binop" && e.op === "and") return [...splitAnd(e.left), ...splitAnd(e.right)];
  return [e];
}

function literalValue(e: Expr): Value | null {
  if (e.kind === "literal") return e.value as Value;
  if (e.kind === "unop" && e.op === "-" && e.operand.kind === "literal" && typeof e.operand.value === "number") {
    return -e.operand.value;
  }
  return null;
}

function colName(e: Expr, cols: string[], alias: string): string | null {
  if (e.kind !== "col") return null;
  if (e.table && e.table.toLowerCase() !== alias) return null;
  const n = e.name.toLowerCase();
  if (!cols.some((c) => c.toLowerCase() === n)) return null;
  return n;
}

function asIndexPred(e: Expr, cols: string[], alias: string): IndexPred | null {
  if (e.kind === "binop" && ["=", ">", ">=", "<", "<="].includes(e.op)) {
    const c = colName(e.left, cols, alias);
    const v = c ? literalValue(e.right) : null;
    if (c && v !== null) {
      const op = e.op === "=" ? "eq" : e.op === ">" ? "gt" : e.op === ">=" ? "ge" : e.op === "<" ? "lt" : "le";
      return { col: c, op, values: [v] };
    }
    const cr = colName(e.right, cols, alias);
    const cv = cr ? literalValue(e.left) : null;
    if (cr && cv !== null) {
      const op = e.op === "=" ? "eq" : e.op === ">" ? "lt" : e.op === ">=" ? "le" : e.op === "<" ? "gt" : "ge";
      return { col: cr, op, values: [cv] };
    }
    return null;
  }
  if (e.kind === "between" && !e.negated) {
    const c = colName(e.expr, cols, alias);
    if (!c) return null;
    const lo = literalValue(e.low);
    const hi = literalValue(e.high);
    if (lo === null || hi === null) return null;
    return { col: c, op: "between", values: [lo, hi] };
  }
  if (e.kind === "in" && !e.negated && e.list && !e.subquery) {
    const c = colName(e.expr, cols, alias);
    if (!c) return null;
    const vals: Value[] = [];
    for (const item of e.list) {
      const v = literalValue(item);
      if (v === null) return null;
      vals.push(v);
    }
    if (vals.length === 0) return null;
    return { col: c, op: "in", values: vals };
  }
  return null;
}