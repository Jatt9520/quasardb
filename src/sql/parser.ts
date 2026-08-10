import { Lexer, Token } from "./lexer.js";
import {
  ColumnDef, CreateIndexStmt, CreateTableStmt, DeleteStmt, DropIndexStmt,
  DropTableStmt, Expr, InsertStmt, JoinClause, Literal, OrderByItem, ParseResult,
  SelectItem, SelectStmt, SetOpStmt, SqlType, Statement, TableRef, UpdateStmt,
} from "./ast.js";

export class ParseError extends Error {
  constructor(message: string, public pos: number) {
    super(`${message} (at position ${pos})`);
  }
}

const TYPE_NAMES: Record<string, SqlType> = {
  int: "int",
  integer: "int",
  bigint: "bigint",
  real: "real",
  double: "real",
  float: "real",
  text: "text",
  varchar: "text",
  char: "text",
  boolean: "boolean",
  bool: "boolean",
};

class Parser {
  private tokens: Token[];
  private i = 0;

  constructor(src: string) {
    this.tokens = new Lexer(src).tokenize();
  }

  private peek(): Token {
    return this.tokens[this.i];
  }

  private next(): Token {
    return this.tokens[this.i++];
  }

  private isKeyword(kw: string): boolean {
    return this.peek().type === "keyword" && this.peek().text.toLowerCase() === kw;
  }

  private isOp(op: string): boolean {
    return this.peek().type === "op" && this.peek().text === op;
  }

  private expectKeyword(kw: string): Token {
    if (!this.isKeyword(kw)) {
      throw new ParseError(`Expected keyword "${kw}", found "${this.peek().text || "EOF"}"`, this.peek().pos);
    }
    return this.next();
  }

  private expectOp(op: string): Token {
    if (!this.isOp(op)) {
      throw new ParseError(`Expected "${op}", found "${this.peek().text || "EOF"}"`, this.peek().pos);
    }
    return this.next();
  }

  private expectIdent(context: string): string {
    const t = this.peek();
    if (t.type === "ident" || (t.type === "keyword" && t.text.toLowerCase() !== "select")) {
      // allow keywords as quoted-ish identifiers only for a few well-known ones
      return this.next().text;
    }
    throw new ParseError(`Expected identifier for ${context}, found "${t.text || "EOF"}"`, t.pos);
  }

  private matchKeyword(kw: string): boolean {
    if (this.isKeyword(kw)) {
      this.next();
      return true;
    }
    return false;
  }

  /** Parse a full statement list; stops before a trailing semicolon. */
  parseStatement(): Statement {
    const t = this.peek();
    if (t.type === "eof") throw new ParseError("Empty statement", t.pos);
    const kw = t.text.toLowerCase();
    switch (kw) {
      case "select": {
        const stmt = this.parseSelect();
        this.consumeOptionalSemicolon();
        return stmt;
      }
      case "insert":
        return this.parseInsert();
      case "update":
        return this.parseUpdate();
      case "delete":
        return this.parseDelete();
      case "create": {
        this.next();
        if (this.matchKeyword("table")) return this.parseCreateTable();
        if (this.matchKeyword("unique")) {
          this.expectKeyword("index");
          return this.parseCreateIndex(true);
        }
        if (this.matchKeyword("index")) return this.parseCreateIndex(false);
        throw new ParseError("Expected TABLE or INDEX after CREATE", this.peek().pos);
      }
      case "drop": {
        this.next();
        if (this.matchKeyword("table")) return this.parseDropTable();
        if (this.matchKeyword("index")) return this.parseDropIndex();
        throw new ParseError("Expected TABLE or INDEX after DROP", this.peek().pos);
      }
      default:
        throw new ParseError(`Unsupported statement: "${kw}"`, t.pos);
    }
  }

  private consumeOptionalSemicolon(): void {
    if (this.isOp(";")) this.next();
  }

  // ------------------------------------------------------------------

  private parseCreateTable(): CreateTableStmt {
    const ifNotExists = this.matchKeyword("if") && !!this.expectKeyword("not") && !!this.expectKeyword("exists");
    const table = this.expectIdent("table name");
    this.expectOp("(");
    const columns: ColumnDef[] = [];
    let primaryKey: string | null = null;
    for (;;) {
      if (this.isKeyword("primary")) {
        this.next();
        this.expectKeyword("key");
        this.expectOp("(");
        const col = this.expectIdent("primary key column");
        this.expectOp(")");
        primaryKey = col;
      } else if (this.isKeyword("unique")) {
        this.next();
        this.expectOp("(");
        this.expectIdent("unique column");
        this.expectOp(")");
      } else {
        columns.push(this.parseColumnDef());
      }
      if (this.isOp(",")) {
        this.next();
        continue;
      }
      break;
    }
    this.expectOp(")");
    return { kind: "create_table", ifNotExists, table, columns, primaryKey };
  }

  private parseColumnDef(): ColumnDef {
    const name = this.expectIdent("column name");
    const typeTok = this.peek();
    const tn = typeTok.text.toLowerCase();
    if (!(tn in TYPE_NAMES)) {
      throw new ParseError(`Unknown type "${typeTok.text}" for column "${name}"`, typeTok.pos);
    }
    this.next();
    const type = TYPE_NAMES[tn];
    if (this.isOp("(")) {
      // e.g. VARCHAR(255)
      this.next();
      this.next();
      this.expectOp(")");
    }
    const def: ColumnDef = { name, type, default: null };
    for (;;) {
      if (this.isKeyword("primary")) {
        this.next();
        this.expectKeyword("key");
        def.primaryKey = true;
        def.notNull = true;
      } else if (this.isKeyword("unique")) {
        this.next();
        def.unique = true;
      } else if (this.isKeyword("not")) {
        this.next();
        this.expectKeyword("null");
        def.notNull = true;
      } else if (this.isKeyword("null")) {
        this.next();
      } else if (this.isKeyword("auto_increment")) {
        this.next();
        def.autoIncrement = true;
      } else if (this.isKeyword("default")) {
        this.next();
        def.default = this.parseExpression();
      } else {
        break;
      }
    }
    return def;
  }

  private parseCreateIndex(unique: boolean): CreateIndexStmt {
    const ifNotExists = this.matchKeyword("if") && !!this.expectKeyword("not") && !!this.expectKeyword("exists");
    const index = this.expectIdent("index name");
    this.expectKeyword("on");
    const table = this.expectIdent("table name");
    this.expectOp("(");
    const cols: string[] = [];
    for (;;) {
      cols.push(this.expectIdent("index column"));
      if (this.isOp(",")) {
        this.next();
        continue;
      }
      break;
    }
    this.expectOp(")");
    void unique;
    return { kind: "create_index", ifNotExists, index, table, cols };
  }

  private parseDropTable(): DropTableStmt {
    const ifExists = this.matchKeyword("if") && !!this.expectKeyword("exists");
    const table = this.expectIdent("table name");
    return { kind: "drop_table", ifExists, table };
  }

  private parseDropIndex(): DropIndexStmt {
    const ifExists = this.matchKeyword("if") && !!this.expectKeyword("exists");
    const index = this.expectIdent("index name");
    return { kind: "drop_index", ifExists, index };
  }

  private parseInsert(): InsertStmt {
    this.expectKeyword("insert");
    this.expectKeyword("into");
    const table = this.expectIdent("table name");
    let columns: string[] | null = null;
    if (this.isOp("(")) {
      this.next();
      columns = [];
      for (;;) {
        columns.push(this.expectIdent("column name"));
        if (this.isOp(",")) {
          this.next();
          continue;
        }
        break;
      }
      this.expectOp(")");
    }
    this.expectKeyword("values");
    const rows: Expr[][] = [];
    for (;;) {
      this.expectOp("(");
      const row: Expr[] = [];
      for (;;) {
        row.push(this.parseExpression());
        if (this.isOp(",")) {
          this.next();
          continue;
        }
        break;
      }
      this.expectOp(")");
      rows.push(row);
      if (this.isOp(",")) {
        this.next();
        continue;
      }
      break;
    }
    this.consumeOptionalSemicolon();
    return { kind: "insert", table, columns, rows };
  }

  private parseUpdate(): UpdateStmt {
    this.expectKeyword("update");
    const table = this.expectIdent("table name");
    this.expectKeyword("set");
    const sets: { column: string; value: Expr }[] = [];
    for (;;) {
      const column = this.expectIdent("column name");
      this.expectOp("=");
      sets.push({ column, value: this.parseExpression() });
      if (this.isOp(",")) {
        this.next();
        continue;
      }
      break;
    }
    let where: Expr | null = null;
    if (this.matchKeyword("where")) where = this.parseExpression();
    this.consumeOptionalSemicolon();
    return { kind: "update", table, sets, where };
  }

  private parseDelete(): DeleteStmt {
    this.expectKeyword("delete");
    this.expectKeyword("from");
    const table = this.expectIdent("table name");
    let where: Expr | null = null;
    if (this.matchKeyword("where")) where = this.parseExpression();
    this.consumeOptionalSemicolon();
    return { kind: "delete", table, where };
  }

  // ------------------------------------------------------------------

  private parseSelect(): SelectStmt | SetOpStmt {
    let root: SelectStmt | SetOpStmt = this.parseSelectCore();
    for (;;) {
      let op: "union" | "intersect" | "except" | null = null;
      if (this.isKeyword("union")) {
        this.next();
        op = "union";
      } else if (this.isKeyword("intersect")) {
        this.next();
        op = "intersect";
      } else if (this.isKeyword("except")) {
        this.next();
        op = "except";
      }
      if (!op) break;
      const all = this.matchKeyword("all");
      const right = this.parseSelectCore();
      root = { kind: "setop", op, all, left: root, right, orderBy: [], limit: null, offset: null };
    }
    const orderBy: OrderByItem[] = [];
    if (this.matchKeyword("order")) {
      this.expectKeyword("by");
      for (;;) {
        const expr = this.parseExpression();
        let desc = false;
        if (this.isKeyword("asc")) this.next();
        else if (this.isKeyword("desc")) {
          this.next();
          desc = true;
        }
        orderBy.push({ expr, desc });
        if (this.isOp(",")) {
          this.next();
          continue;
        }
        break;
      }
    }
    let limit: Expr | null = null;
    if (this.matchKeyword("limit")) limit = this.parseExpression();
    let offset: Expr | null = null;
    if (this.matchKeyword("offset")) offset = this.parseExpression();
    if (root.kind === "setop") {
      root.orderBy = orderBy;
      root.limit = limit;
      root.offset = offset;
      return root;
    }
    root.orderBy = orderBy;
    root.limit = limit;
    root.offset = offset;
    return root;
  }

  /** SELECT ... HAVING, without ORDER BY / LIMIT (those belong to a set-op tail). */
  private parseSelectCore(): SelectStmt {
    this.expectKeyword("select");
    const distinct = this.matchKeyword("distinct");
    const items: SelectItem[] = [];
    for (;;) {
      if (this.isOp("*")) {
        this.next();
        items.push({ kind: "star" });
      } else {
        const expr = this.parseExpression();
        let alias: string | null = null;
        if (this.matchKeyword("as")) {
          alias = this.expectIdent("alias");
        } else if (this.peek().type === "ident" && !this.isKeyword("from")) {
          alias = this.next().text;
        }
        items.push({ kind: "expr", expr, alias });
      }
      if (this.isOp(",")) {
        this.next();
        continue;
      }
      break;
    }

    let from: TableRef | null = null;
    const joins: JoinClause[] = [];
    if (this.matchKeyword("from")) {
      from = this.parseTableRef();
      for (;;) {
        let type: JoinClause["type"] | null = null;
        if (this.isKeyword("join")) {
          this.next();
          type = "inner";
        } else if (this.isKeyword("inner")) {
          this.next();
          this.expectKeyword("join");
          type = "inner";
        } else if (this.isKeyword("left")) {
          this.next();
          this.expectKeyword("join");
          type = "left";
        } else if (this.isKeyword("right")) {
          this.next();
          this.expectKeyword("join");
          type = "right";
        } else if (this.isKeyword("cross")) {
          this.next();
          this.expectKeyword("join");
          type = "cross";
        } else if (this.isKeyword(",")) {
          this.next();
          type = "cross";
        }
        if (!type) break;
        const ref = this.parseTableRef();
        let on: Expr | null = null;
        if (this.matchKeyword("on")) on = this.parseExpression();
        joins.push({ type, ref, on });
      }
    }

    let where: Expr | null = null;
    if (this.matchKeyword("where")) where = this.parseExpression();

    const groupBy: Expr[] = [];
    if (this.matchKeyword("group")) {
      this.expectKeyword("by");
      for (;;) {
        groupBy.push(this.parseExpression());
        if (this.isOp(",")) {
          this.next();
          continue;
        }
        break;
      }
    }

    let having: Expr | null = null;
    if (this.matchKeyword("having")) having = this.parseExpression();

    return { kind: "select", distinct, items, from, joins, where, groupBy, having, orderBy: [], limit: null, offset: null };
  }

  private parseTableRef(): TableRef {
    if (this.isOp("(")) {
      this.next();
      const sub = this.parseSelect();
      this.expectOp(")");
      this.expectKeyword("as");
      const alias = this.expectIdent("subquery alias");
      return { kind: "subquery", query: sub, alias };
    }
    const table = this.expectIdent("table name");
    let alias: string | null = null;
    if (this.matchKeyword("as")) {
      alias = this.expectIdent("alias");
    } else if (this.peek().type === "ident" && !this.isKeyword("on") && !this.isKeyword("join") &&
      !this.isKeyword("where") && !this.isKeyword("group") && !this.isKeyword("order") &&
      !this.isKeyword("having") && !this.isKeyword("limit") && !this.isKeyword("offset")) {
      alias = this.next().text;
      if (alias === "as") alias = null;
    }
    return { kind: "table", table, alias };
  }

  // ---------------- expressions ----------------

  parseExpression(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.isKeyword("or")) {
      this.next();
      left = { kind: "binop", op: "or", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseComparison();
    while (this.isKeyword("and")) {
      this.next();
      left = { kind: "binop", op: "and", left, right: this.parseComparison() };
    }
    return left;
  }

  private parseComparison(): Expr {
    let left = this.parseAdditive();
    for (;;) {
      if (this.isKeyword("in")) {
        this.next();
        const negated = false;
        if (this.isOp("(")) {
          this.next();
          if (this.isKeyword("select")) {
            const sub = this.parseSelect();
            this.expectOp(")");
            left = { kind: "in", expr: left, subquery: sub, list: null, negated };
          } else {
            const list: Expr[] = [];
            for (;;) {
              list.push(this.parseExpression());
              if (this.isOp(",")) {
                this.next();
                continue;
              }
              break;
            }
            this.expectOp(")");
            left = { kind: "in", expr: left, subquery: null, list, negated };
          }
        }
        continue;
      }
      if (this.isKeyword("not")) {
        const save = this.i;
        this.next();
        if (this.isKeyword("in")) {
          this.next();
          if (this.isOp("(")) {
            this.next();
            if (this.isKeyword("select")) {
              const sub = this.parseSelect();
              this.expectOp(")");
              left = { kind: "in", expr: left, subquery: sub, list: null, negated: true };
            } else {
              const list: Expr[] = [];
              for (;;) {
                list.push(this.parseExpression());
                if (this.isOp(",")) {
                  this.next();
                  continue;
                }
                break;
              }
              this.expectOp(")");
              left = { kind: "in", expr: left, subquery: null, list, negated: true };
            }
            continue;
          }
        }
        this.i = save;
        break;
      }
      if (this.isKeyword("between")) {
        this.next();
        const low = this.parseAdditive();
        this.expectKeyword("and");
        const high = this.parseAdditive();
        left = { kind: "between", expr: left, low, high, negated: false };
        continue;
      }
      if (this.isKeyword("is")) {
        this.next();
        let negated = false;
        if (this.isKeyword("not")) {
          this.next();
          negated = true;
        }
        if (this.isKeyword("null")) {
          this.next();
          left = { kind: "isnull", expr: left, negated };
          continue;
        }
        if (this.isKeyword("true")) {
          this.next();
          left = { kind: "is", expr: left, value: true, negated };
          continue;
        }
        if (this.isKeyword("false")) {
          this.next();
          left = { kind: "is", expr: left, value: false, negated };
          continue;
        }
        throw new ParseError("Expected NULL/TRUE/FALSE after IS", this.peek().pos);
      }
      if (this.isKeyword("like")) {
        this.next();
        const pattern = this.parseAdditive();
        left = { kind: "like", expr: left, pattern, negated: false };
        continue;
      }
      // comparison operators
      const opTok = this.peek();
      if (opTok.type === "op" && ["=", "!=", "<>", "<", "<=", ">", ">="].includes(opTok.text)) {
        this.next();
        left = { kind: "binop", op: opTok.text, left, right: this.parseAdditive() };
        continue;
      }
      break;
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    for (;;) {
      if (this.isOp("+") || this.isOp("-")) {
        const op = this.next().text;
        left = { kind: "binop", op, left, right: this.parseMultiplicative() };
        continue;
      }
      if (this.isOp("||")) {
        this.next();
        left = { kind: "binop", op: "||", left, right: this.parseMultiplicative() };
        continue;
      }
      break;
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    for (;;) {
      if (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
        const op = this.next().text;
        left = { kind: "binop", op, left, right: this.parseUnary() };
        continue;
      }
      break;
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.isOp("-")) {
      this.next();
      return { kind: "unop", op: "-", operand: this.parseUnary() };
    }
    if (this.isOp("+")) {
      this.next();
      return this.parseUnary();
    }
    if (this.isKeyword("not") && !this.isKeyword("in")) {
      const t = this.next();
      if (this.isKeyword("exists")) {
        this.next();
        if (!this.isOp("(")) {
          // NOT EXISTS shortcut with paren handled below
        }
        this.expectOp("(");
        const sub = this.parseSelect();
        this.expectOp(")");
        return { kind: "exists", subquery: sub, negated: true };
      }
      // NOT ... fall back: treat as boolean negation
      void t;
      return { kind: "unop", op: "not", operand: this.parseUnary() };
    }
    if (this.isKeyword("exists")) {
      this.next();
      this.expectOp("(");
      const sub = this.parseSelect();
      this.expectOp(")");
      return { kind: "exists", subquery: sub, negated: false };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    if (this.isOp("::")) {
      this.next();
      const t = this.peek().text.toLowerCase();
      if (!(t in TYPE_NAMES)) throw new ParseError(`Unknown cast type "${t}"`, this.peek().pos);
      this.next();
      e = { kind: "cast", expr: e, type: TYPE_NAMES[t] };
    }
    return e;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.type === "number") {
      this.next();
      return { kind: "literal", value: t.num! };
    }
    if (t.type === "string") {
      this.next();
      return { kind: "literal", value: t.text };
    }
    if (t.type === "op" && t.text === "(") {
      this.next();
      if (this.isKeyword("select")) {
        // scalar subquery: (SELECT ...)
        const sub = this.parseSelect();
        this.expectOp(")");
        return { kind: "scalar", subquery: sub };
      }
      const e = this.parseExpression();
      this.expectOp(")");
      return e;
    }
    if (t.type === "keyword") {
      const kw = t.text.toLowerCase();
      if (kw === "null") {
        this.next();
        return { kind: "literal", value: null };
      }
      if (kw === "true") {
        this.next();
        return { kind: "literal", value: true };
      }
      if (kw === "false") {
        this.next();
        return { kind: "literal", value: false };
      }
      if (kw === "case") return this.parseCase();
      if (kw === "cast") {
        this.next();
        this.expectOp("(");
        const expr = this.parseExpression();
        this.expectKeyword("as");
        const tn = this.peek().text.toLowerCase();
        if (!(tn in TYPE_NAMES)) throw new ParseError(`Unknown cast type "${tn}"`, this.peek().pos);
        this.next();
        this.expectOp(")");
        return { kind: "cast", expr, type: TYPE_NAMES[tn] };
      }
    }
    if (t.type === "ident" || t.type === "keyword") {
      const name = this.next().text;
      // qualified column: table.column
      if (this.isOp(".")) {
        this.next();
        const col = this.expectIdent("column name");
        return { kind: "col", table: name, name: col };
      }
      if (this.isOp("(")) {
        this.next();
        const funcName = name.toLowerCase();
        let star = false;
        let distinct = false;
        const args: Expr[] = [];
        if (funcName === "count" && this.isOp("*")) {
          this.next();
          star = true;
        } else {
          if (this.matchKeyword("distinct") || this.isKeyword("distinct")) {
            if (this.isKeyword("distinct")) this.next();
            distinct = true;
          }
          for (;;) {
            args.push(this.parseExpression());
            if (this.isOp(",")) {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expectOp(")");
        return { kind: "func", name: funcName, args, distinct, star };
      }
      return { kind: "col", table: null, name };
    }
    throw new ParseError(`Unexpected token "${t.text}" in expression`, t.pos);
  }

  private parseCase(): Expr {
    this.expectKeyword("case");
    let operand: Expr | null = null;
    if (!this.isKeyword("when")) operand = this.parseExpression();
    const whens: { when: Expr; then: Expr }[] = [];
    while (this.isKeyword("when")) {
      this.next();
      const when = this.parseExpression();
      this.expectKeyword("then");
      const then = this.parseExpression();
      whens.push({ when, then });
    }
    let els: Expr | null = null;
    if (this.isKeyword("else")) {
      this.next();
      els = this.parseExpression();
    }
    this.expectKeyword("end");
    return { kind: "case", operand, whens, els };
  }
}

export function parseSelectStatement(src: string): SelectStmt {
  const p = new Parser(src);
  const stmt = p.parseStatement();
  if (stmt.kind !== "select") throw new ParseError("Expected SELECT statement", 0);
  return stmt;
}

/** Parse one SQL statement, honoring EXPLAIN [ANALYZE] prefixes. */
export function parseStatement(src: string): ParseResult {
  const trimmed = src.trim();
  let explain = false;
  let analyze = false;
  let body = trimmed;
  const lower = body.toLowerCase();
  if (lower.startsWith("explain analyze")) {
    explain = true;
    analyze = true;
    body = body.slice("explain analyze".length);
  } else if (lower.startsWith("explain")) {
    explain = true;
    body = body.slice("explain".length);
  }
  const p = new Parser(body);
  const statement = p.parseStatement();
  return { statement, explain, analyze, rest: "" };
}

export function tokenize(sql: string): Token[] {
  return new Lexer(sql).tokenize();
}

export function literalToPrimitive(e: Expr): Literal | undefined {
  return e.kind === "literal" ? e.value : undefined;
}