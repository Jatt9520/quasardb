export type TokenType =
  | "ident"
  | "keyword"
  | "number"
  | "string"
  | "op"
  | "eof";

export interface Token {
  type: TokenType;
  text: string;
  pos: number;
  /** numeric value for number tokens */
  num?: number;
}

const KEYWORDS = new Set([
  "select", "from", "where", "group", "by", "having", "order", "limit",
  "offset", "insert", "into", "values", "update", "set", "delete",
  "create", "table", "index", "drop", "on", "primary", "key",
  "unique", "not", "null", "default", "join", "inner", "left",
  "right", "outer", "cross", "as", "and", "or", "like", "in",
  "is", "between", "asc", "desc", "distinct", "exists", "if",
  "int", "integer", "bigint", "real", "double", "text", "varchar",
  "boolean", "bool", "blob", "auto_increment", "explain", "analyze",
]);

const TWO_CHAR_OPS = ["<=", ">=", "<>", "!=", "||", "::"];
const SINGLE_OPS = new Set([
  "+", "-", "*", "/", "%", "=", "<", ">", "(", ")", ",", ";", ".", "[", "]",
]);

export class LexerError extends Error {
  constructor(message: string, public pos: number) {
    super(`${message} (at position ${pos})`);
  }
}

export class Lexer {
  private src: string;
  private i = 0;

  constructor(src: string) {
    this.src = src;
  }

  private peek(offset = 0): string {
    return this.src[this.i + offset] ?? "";
  }

  private advance(): string {
    return this.src[this.i++] ?? "";
  }

  private skipWhitespaceAndComments(): void {
    for (;;) {
      while (/\s/.test(this.peek())) this.advance();
      if (this.peek() === "-" && this.peek(1) === "-") {
        while (this.i < this.src.length && this.src[this.i] !== "\n") this.advance();
        continue;
      }
      if (this.peek() === "/" && this.peek(1) === "*") {
        this.advance();
        this.advance();
        while (this.i < this.src.length && !(this.peek() === "*" && this.peek(1) === "/")) this.advance();
        if (this.i < this.src.length) {
          this.advance();
          this.advance();
        }
        continue;
      }
      break;
    }
  }

  private readIdent(): Token {
    const start = this.i;
    while (/[A-Za-z0-9_$]/.test(this.peek())) this.advance();
    const text = this.src.slice(start, this.i);
    return {
      type: KEYWORDS.has(text.toLowerCase()) ? "keyword" : "ident",
      text,
      pos: start,
    };
  }

  private readNumber(): Token {
    const start = this.i;
    while (/[0-9a-fA-FxX.]/.test(this.peek())) this.advance();
    const text = this.src.slice(start, this.i);
    const num = Number(text.replace(/_/g, ""));
    if (Number.isNaN(num)) throw new LexerError(`Invalid number literal "${text}"`, start);
    return { type: "number", text, pos: start, num };
  }

  private readString(): Token {
    const start = this.i;
    const quote = this.advance();
    let out = "";
    while (this.i < this.src.length) {
      const c = this.advance();
      if (c === quote) {
        if (this.peek() === quote) {
          out += quote;
          this.advance();
          continue;
        }
        return { type: "string", text: out, pos: start };
      }
      out += c;
    }
    throw new LexerError("Unterminated string literal", start);
  }

  next(): Token {
    this.skipWhitespaceAndComments();
    if (this.i >= this.src.length) return { type: "eof", text: "", pos: this.i };

    const c = this.peek();
    if (/[A-Za-z_]/.test(c)) return this.readIdent();
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(this.peek(1)))) return this.readNumber();
    if (c === "'" || c === '"' || c === "`") return this.readString();

    for (const op of TWO_CHAR_OPS) {
      if (this.src.startsWith(op, this.i)) {
        this.i += 2;
        return { type: "op", text: op, pos: this.i - 2 };
      }
    }
    if (SINGLE_OPS.has(c)) {
      this.advance();
      return { type: "op", text: c, pos: this.i - 1 };
    }
    throw new LexerError(`Unexpected character "${c}"`, this.i);
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    for (;;) {
      const t = this.next();
      tokens.push(t);
      if (t.type === "eof") break;
    }
    return tokens;
  }
}