import { ColumnDef, SqlType } from "../sql/ast.js";
import { Value } from "../expr/value.js";

/**
 * Row serialization: compact binary layout driven by table schema.
 *   int/bigint  → i64 (8B, null = 0x80 mask byte)
 *   real        → f64 (8B)
 *   boolean     → 1B
 *   text        → u32 length + UTF-8 bytes
 * Each column is prefixed with a 1B presence flag (0 = NULL, 1 = present)
 * so mixed nullability is lossless.
 */

export interface Schema {
  name: string;
  columns: ColumnDef[];
}

export function schemaOf(name: string, columns: ColumnDef[]): Schema {
  return { name, columns };
}

export function serializeRow(schema: Schema, values: Value[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < schema.columns.length; i++) {
    const v = values[i];
    const col = schema.columns[i];
    const flag = new Uint8Array(1);
    if (v === null) {
      flag[0] = 0;
      parts.push(flag);
      continue;
    }
    flag[0] = 1;
    parts.push(flag);
    switch (col.type) {
      case "int":
      case "bigint": {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setBigInt64(0, BigInt(Math.trunc(v as number)), true);
        parts.push(b);
        break;
      }
      case "real": {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setFloat64(0, v as number, true);
        parts.push(b);
        break;
      }
      case "boolean": {
        parts.push(new Uint8Array([v ? 1 : 0]));
        break;
      }
      case "text": {
        const bytes = enc.encode(String(v));
        const len = new Uint8Array(4);
        new DataView(len.buffer).setUint32(0, bytes.length, true);
        parts.push(len, bytes);
        break;
      }
      case "vector": {
        const vec = v as number[];
        const dim = new Uint8Array(4);
        new DataView(dim.buffer).setUint32(0, vec.length, true);
        const body = new Uint8Array(vec.length * 8);
        const dv = new DataView(body.buffer);
        for (let i = 0; i < vec.length; i++) dv.setFloat64(i * 8, vec[i], true);
        parts.push(dim, body);
        break;
      }
    }
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function deserializeRow(schema: Schema, data: Uint8Array): Value[] {
  const out: Value[] = [];
  const dec = new TextDecoder();
  let off = 0;
  for (const col of schema.columns) {
    const flag = data[off++];
    if (flag === 0) {
      out.push(null);
      continue;
    }
    switch (col.type) {
      case "int":
      case "bigint": {
        const bi = new DataView(data.buffer, data.byteOffset + off, 8).getBigInt64(0, true);
        off += 8;
        out.push(Number(bi));
        break;
      }
      case "real": {
        const f = new DataView(data.buffer, data.byteOffset + off, 8).getFloat64(0, true);
        off += 8;
        out.push(f);
        break;
      }
      case "boolean": {
        out.push(data[off++] === 1);
        break;
      }
      case "text": {
        const len = new DataView(data.buffer, data.byteOffset + off, 4).getUint32(0, true);
        off += 4;
        out.push(dec.decode(data.subarray(off, off + len)));
        off += len;
        break;
      }
      case "vector": {
        const dim = new DataView(data.buffer, data.byteOffset + off, 4).getUint32(0, true);
        off += 4;
        const vec: number[] = new Array(dim);
        const dv = new DataView(data.buffer, data.byteOffset + off, dim * 8);
        for (let i = 0; i < dim; i++) vec[i] = dv.getFloat64(i * 8, true);
        off += dim * 8;
        out.push(vec);
        break;
      }
    }
  }
  return out;
}

/** Test coercion: apply column type affinity to raw values. */
export function coerceRow(schema: Schema, values: Value[]): Value[] {
  return schema.columns.map((c, i) => coerceColumn(c, values[i]));
}

function coerceColumn(col: ColumnDef, v: Value): Value {
  if (v === null) return null;
  return coerceToValue(v, col.type);
}

function coerceToValue(v: Value, type: SqlType): Value {
  switch (type) {
    case "int":
    case "bigint":
      if (typeof v === "number") return Math.trunc(v);
      if (typeof v === "boolean") return v ? 1 : 0;
      {
        const n = Number(v);
        return Number.isNaN(n) ? 0 : Math.trunc(n);
      }
    case "real":
      if (typeof v === "number") return v;
      if (typeof v === "boolean") return v ? 1 : 0;
      {
        const n = Number(v);
        return Number.isNaN(n) ? 0 : n;
      }
    case "boolean":
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v !== 0;
      {
        const s = String(v).toLowerCase();
        return s === "true" || s === "1";
      }
    case "text":
      return String(v);
    case "vector": {
      if (Array.isArray(v)) return v.slice();
      if (typeof v === "string" && v.startsWith("[") && v.endsWith("]")) {
        const parts = v.slice(1, -1).split(",").map((s) => Number(s.trim()));
        if (parts.every((n) => !Number.isNaN(n))) return parts;
      }
      throw new Error(`Cannot coerce ${JSON.stringify(v)} to VECTOR`);
    }
  }
}

export function toStringValues(values: Value[]): string[] {
  return values.map((v) => (v === null ? "NULL" : String(v)));
}