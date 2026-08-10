import type { Expr, JoinClause, SelectItem, SelectStmt, TableRef } from "../sql/ast.js";

// ==================== Logical plan tree ====================

export interface PlanNode {
  kind: string;
  children: PlanNode[];
  /** output column names */
  output: string[];
  /** estimated rows (set by optimizer) */
  estRows?: number;
}

export interface TableScanNode extends PlanNode {
  kind: "scan";
  table: string;
  alias: string;
  columns: string[];
  children: [];
}

export interface FilterNode extends PlanNode {
  kind: "filter";
  expr: Expr;
  children: [PlanNode];
}

export interface ProjectNode extends PlanNode {
  kind: "project";
  exprs: { expr: Expr; out: string | null; table?: string }[];
  children: [PlanNode];
}

export interface JoinNode extends PlanNode {
  kind: "join";
  joinType: "inner" | "left" | "right" | "cross";
  on: Expr | null;
  children: [PlanNode, PlanNode];
}

export interface AggregateNode extends PlanNode {
  kind: "aggregate";
  groupBy: Expr[];
  /** projection items that use aggregate functions */
  aggs: { expr: Expr; out: string | null }[];
  children: [PlanNode];
}

export interface SortNode extends PlanNode {
  kind: "sort";
  by: { expr: Expr; desc: boolean }[];
  children: [PlanNode];
}

export interface LimitNode extends PlanNode {
  kind: "limit";
  limit: number | null;
  offset: number;
  children: [PlanNode];
}

export interface DistinctNode extends PlanNode {
  kind: "distinct";
  children: [PlanNode];
}

export interface SetOpNode extends PlanNode {
  kind: "setop";
  op: "union" | "intersect" | "except";
  all: boolean;
  children: [PlanNode, PlanNode];
}

export type AnyPlan = PlanNode;

// ==================== help ====================

export function collectColumns(plan: PlanNode, out: Set<string>): void {
  if (plan.kind === "scan") {
    (plan as TableScanNode).columns.forEach((c) => out.add(c));
  }
  for (const c of plan.children) collectColumns(c, out);
}

export function planToString(plan: PlanNode, indent = 0): string {
  const pad = "  ".repeat(indent);
  let s = `${pad}${plan.kind}`;
  switch (plan.kind) {
    case "scan": {
      const p = plan as TableScanNode;
      s += ` ${p.table} [${p.columns.join(", ")}]`;
      break;
    }
    case "filter":
      s += ` ${exprToString((plan as FilterNode).expr)}`;
      break;
    case "join": {
      const p = plan as JoinNode;
      s += ` ${p.joinType}${p.on ? " ON " + exprToString(p.on) : ""}`;
      break;
    }
    case "aggregate":
      s += ` GROUP BY [${(plan as AggregateNode).groupBy.map(exprToString).join(", ")}]`;
      break;
    case "sort":
      s += ` [${(plan as SortNode).by.map((b) => exprToString(b.expr) + (b.desc ? " DESC" : "")).join(", ")}]`;
      break;
    case "limit":
      s += ` ${(plan as LimitNode).limit ?? "ALL"} OFFSET ${(plan as LimitNode).offset}`;
      break;
    case "project":
      break;
    case "setop": {
      const p = plan as SetOpNode;
      s += ` ${p.op.toUpperCase()}${p.all ? " ALL" : ""}`;
      break;
    }
  }
  if (plan.estRows !== undefined) s += ` (~${plan.estRows} rows)`;
  for (const c of plan.children) s += "\n" + planToString(c, indent + 1);
  return s;
}

export function exprToString(e: Expr): string {
  switch (e.kind) {
    case "literal":
      return String(e.value);
    case "col":
      return e.table ? `${e.table}.${e.name}` : e.name;
    case "binop":
      if (e.op === "and" || e.op === "or") return `(${exprToString(e.left)} ${e.op} ${exprToString(e.right)})`;
      return `${exprToString(e.left)} ${e.op} ${exprToString(e.right)}`;
    case "unop":
      return `${e.op}(${exprToString(e.operand)})`;
    case "func":
      return `${e.name}(${e.star ? "*" : e.args.map(exprToString).join(", ")})`;
    case "case":
      return `CASE WHEN ${e.whens.map((w) => exprToString(w.when)).join(" OR ")} ... END`;
    case "cast":
      return `CAST(${exprToString(e.expr)} AS ${e.type})`;
    case "between":
      return `${exprToString(e.expr)} BETWEEN ${exprToString(e.low)} AND ${exprToString(e.high)}`;
    case "like":
      return `${exprToString(e.expr)} LIKE ${exprToString(e.pattern)}`;
    case "in":
      return `${exprToString(e.expr)} IN (...)`;
    case "is":
      return `${exprToString(e.expr)} IS ${e.negated ? "NOT " : ""}${e.value === null ? "NULL" : String(e.value)}`;
    case "isnull":
      return `${exprToString(e.expr)} IS ${e.negated ? "NOT " : ""}NULL`;
    case "exists":
      return `${e.negated ? "NOT " : ""}EXISTS(...)`;
    case "scalar":
      return `(SELECT ...)`;
  }
}

export function exprColumns(e: Expr, out: Set<string>): void {
  switch (e.kind) {
    case "col":
      out.add(e.name);
      break;
    case "binop":
      exprColumns(e.left, out);
      exprColumns(e.right, out);
      break;
    case "unop":
      exprColumns(e.operand, out);
      break;
    case "func":
      for (const a of e.args) exprColumns(a, out);
      break;
    case "case":
      if (e.operand) exprColumns(e.operand, out);
      for (const w of e.whens) {
        exprColumns(w.when, out);
        exprColumns(w.then, out);
      }
      if (e.els) exprColumns(e.els, out);
      break;
    case "cast":
      exprColumns(e.expr, out);
      break;
    case "between":
      exprColumns(e.expr, out);
      exprColumns(e.low, out);
      exprColumns(e.high, out);
      break;
    case "like":
      exprColumns(e.expr, out);
      exprColumns(e.pattern, out);
      break;
    case "in":
      exprColumns(e.expr, out);
      for (const x of e.list ?? []) exprColumns(x, out);
      break;
    default:
      break;
  }
}

export function isAggregateCall(e: Expr): boolean {
  return e.kind === "func" && ["count", "sum", "avg", "min", "max", "group_concat"].includes(e.name.toLowerCase());
}