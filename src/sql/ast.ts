export type SqlType = "int" | "bigint" | "real" | "text" | "boolean";

export interface ColumnDef {
  name: string;
  type: SqlType;
  primaryKey?: boolean;
  unique?: boolean;
  notNull?: boolean;
  autoIncrement?: boolean;
  default?: Expr | null;
}

export interface TableElement {
  kind: "column";
  def: ColumnDef;
}

export interface CreateTableStmt {
  kind: "create_table";
  ifNotExists: boolean;
  table: string;
  columns: ColumnDef[];
  primaryKey: string | null;
}

export interface CreateIndexStmt {
  kind: "create_index";
  ifNotExists: boolean;
  index: string;
  table: string;
  cols: string[];
}

export interface DropTableStmt {
  kind: "drop_table";
  ifExists: boolean;
  table: string;
}

export interface DropIndexStmt {
  kind: "drop_index";
  ifExists: boolean;
  index: string;
}

export interface InsertStmt {
  kind: "insert";
  table: string;
  columns: string[] | null;
  rows: Expr[][];
}

export interface UpdateStmt {
  kind: "update";
  table: string;
  sets: { column: string; value: Expr }[];
  where: Expr | null;
}

export interface DeleteStmt {
  kind: "delete";
  table: string;
  where: Expr | null;
}

export interface SelectStmt {
  kind: "select";
  distinct: boolean;
  items: SelectItem[];
  from: TableRef | null;
  joins: JoinClause[];
  where: Expr | null;
  groupBy: Expr[];
  having: Expr | null;
  orderBy: OrderByItem[];
  limit: Expr | null;
  offset: Expr | null;
}

export type SelectItem =
  | { kind: "star" }
  | { kind: "expr"; expr: Expr; alias: string | null };

export type TableRef =
  | { kind: "table"; table: string; alias: string | null }
  | { kind: "subquery"; query: SelectStmt; alias: string };

export interface JoinClause {
  type: "inner" | "left" | "right" | "cross";
  ref: TableRef;
  on: Expr | null;
}

export interface OrderByItem {
  expr: Expr;
  desc: boolean;
}

export type Expr =
  | { kind: "literal"; value: Literal }
  | { kind: "col"; table: string | null; name: string }
  | { kind: "binop"; op: string; left: Expr; right: Expr }
  | { kind: "unop"; op: string; operand: Expr }
  | { kind: "func"; name: string; args: Expr[]; distinct?: boolean; star?: boolean }
  | { kind: "case"; operand: Expr | null; whens: { when: Expr; then: Expr }[]; els: Expr | null }
  | { kind: "cast"; expr: Expr; type: SqlType }
  | { kind: "exists"; subquery: SelectStmt; negated: boolean }
  | { kind: "in"; expr: Expr; subquery: SelectStmt | null; list: Expr[] | null; negated: boolean }
  | { kind: "between"; expr: Expr; low: Expr; high: Expr; negated: boolean }
  | { kind: "like"; expr: Expr; pattern: Expr; negated: boolean }
  | { kind: "isnull"; expr: Expr; negated: boolean }
  | { kind: "is"; expr: Expr; value: Literal | null; negated: boolean }
  | { kind: "scalar"; subquery: SelectStmt };

export type Literal = number | string | boolean | null;

export type Statement =
  | SelectStmt
  | InsertStmt
  | UpdateStmt
  | DeleteStmt
  | CreateTableStmt
  | CreateIndexStmt
  | DropTableStmt
  | DropIndexStmt;

export interface ParseResult {
  statement: Statement;
  /** set when an EXPLAIN prefix was present */
  explain: boolean;
  analyze: boolean;
  rest: string;
}