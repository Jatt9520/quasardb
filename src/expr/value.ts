import { SqlType } from "../sql/ast.js";

export type Value = number | string | boolean | null;
export type ColType = SqlType;

export const NULL: Value = null;

export function typeName(v: Value): string {
  if (v === null) return "null";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "real";
  if (typeof v === "boolean") return "boolean";
  return "text";
}

export function sqlTypeOf(v: Value): SqlType {
  if (v === null) return "text";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "real";
  if (typeof v === "boolean") return "boolean";
  return "text";
}

export function compareValues(a: Value, b: Value): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === "boolean") a = a ? 1 : 0;
  if (typeof b === "boolean") b = b ? 1 : 0;
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  const sa = String(a);
  const sb = String(b);
  if (sa === sb) return 0;
  return sa < sb ? -1 : 1;
}

export function valuesEqual(a: Value, b: Value): boolean {
  if (a === null || b === null) return a === null && b === null;
  return compareValues(a, b) === 0;
}

export function valuesEqualNoNull(a: Value, b: Value): boolean {
  return compareValues(a, b) === 0;
}

/** Parse a string/number literal into a Value of the given column type. */
export function coerceToType(v: Value, type: SqlType): Value {
  if (v === null) return null;
  switch (type) {
    case "int": {
      if (typeof v === "number") return Math.trunc(v);
      const n = Number(v);
      return Number.isNaN(n) ? 0 : Math.trunc(n);
    }
    case "bigint": {
      if (typeof v === "number") return Math.trunc(v);
      const n = Number(v);
      return Number.isNaN(n) ? 0 : Math.trunc(n);
    }
    case "real": {
      if (typeof v === "number") return v;
      const n = Number(v);
      return Number.isNaN(n) ? 0 : n;
    }
    case "boolean": {
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
      const s = String(v).toLowerCase();
      if (s === "true" || s === "1") return true;
      if (s === "false" || s === "0") return false;
      return Boolean(s);
    }
    case "text":
      return String(v);
  }
}

/** Type coercion used by binary operators: SQL-ish affinity. */
export function binaryOperands(a: Value, b: Value): [Value, Value] {
  if (a === null || b === null) return [a, b];
  if (typeof a === "number" && typeof b === "number") return [a, b];
  // numeric-string affinity: if both are numeric strings, treat as numbers
  if (typeof a === "string" && typeof b === "string") {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(a) && /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(b)) {
      return [na, nb];
    }
  }
  return [a, b];
}

export function num(v: Value): number | null {
  if (v === null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

export function bool(v: Value): boolean | null {
  if (v === null) return null;
  if (typeof v === "boolean") return v;
  const n = num(v);
  if (n !== null) return n !== 0;
  const s = String(v).toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return null;
}

export function truthy(v: Value): boolean {
  const b = bool(v);
  return b !== null && b;
}

/** Stable string used for hashing / grouping keys. */
export function valueHashKey(v: Value): string {
  if (v === null) return "\u0000N";
  if (typeof v === "number") return `\u0000N${v}`;
  if (typeof v === "boolean") return `\u0000B${v ? 1 : 0}`;
  return `\u0000S${v.length}\u0000${v}`;
}

/** Format a value for display (SQL-ish). */
export function formatValue(v: Value): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
    return String(v);
  }
  return v;
}

export function sqlLiteral(v: Value): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${v.replace(/'/g, "''")}'`;
}