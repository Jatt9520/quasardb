import { describe, it, expect } from "vitest";
import { Engine } from "../engine/engine.js";
import { BtreeIndex, encodeKeyNumber, encodeKeyString, encodeKeyBoolean, encodeKeyNull, decodeTypedKey } from "./btree.js";
import { parseStatement } from "../sql/parser.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(e: Engine, sql: string) {
  const p = parseStatement(sql);
  return e.execute(p.statement, {});
}

async function openPkIndex(e: Engine): Promise<BtreeIndex> {
  const meta = e.catalogData.indexes.find((i) => i.columns.length === 1 && i.columns[0] === "id")!;
  return new BtreeIndex(meta.name, meta.table, meta.columns, meta.metaPageId, e.bufferPool, meta.unique);
}

async function indexValues(idx: BtreeIndex): Promise<number[]> {
  const out: number[] = [];
  for await (const entry of idx.scanAll()) out.push(entry.value);
  return out;
}

describe("B+tree: key ordering and range boundaries", () => {
  it("scans with inclusive start and exclusive end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-bis-"));
    const e = await Engine.create(join(dir, "x.db"));
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const rows = Array.from({ length: 100 }, (_, i) => `(${i + 1})`).join(",");
    await run(e, `INSERT INTO t VALUES ${rows}`);
    const idx = await openPkIndex(e);

    expect(await indexValuesOf(idx, encodeKeyNumber(10), encodeKeyNumber(20))).toEqual(
      Array.from({ length: 10 }, (_, i) => 10 + i),
    );
    expect(await indexValuesOf(idx, encodeKeyNumber(1), encodeKeyNumber(1))).toEqual([]);
    expect(await indexValuesOf(idx, encodeKeyNumber(100), null)).toEqual([100]);
    expect(await indexValuesOf(idx, null, encodeKeyNumber(3))).toEqual([1, 2]);

    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("orders negatives, ints, and floats by their encoded tags", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-bisb-"));
    const e = await Engine.create(join(dir, "x.db"));
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const idx = await openPkIndex(e);

    await idx.insert(encodeKeyNumber(-5), 1);
    await idx.insert(encodeKeyNumber(0), 2);
    await idx.insert(encodeKeyNumber(100.5), 3);
    await idx.insert(encodeKeyNumber(-2.25), 4);
    await idx.insert(encodeKeyNumber(7), 5);

    const scanned: number[] = [];
    for await (const entry of idx.scanAll()) scanned.push(decodeTypedKey(entry.key) as number);
    // int(-5) < int(0) < int(7) < int/float by tag: all integers (TAG_INT)
    // sort before floats (TAG_FLOAT)
    expect(scanned).toEqual([-5, 0, 7, -2.25, 100.5]);
    expect((await idx.find(encodeKeyNumber(-2.25))).found).toBe(true);

    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips encoded key values through decode", () => {
    expect(decodeTypedKey(encodeKeyNumber(42))).toBe(42);
    expect(decodeTypedKey(encodeKeyNumber(-1))).toBe(-1);
    expect(decodeTypedKey(encodeKeyNumber(1.5))).toBe(1.5);
    expect(decodeTypedKey(encodeKeyString("hello"))).toBe("hello");
    expect(decodeTypedKey(encodeKeyString(""))).toBe("");
    expect(decodeTypedKey(encodeKeyBoolean(true))).toBe(true);
    expect(decodeTypedKey(encodeKeyBoolean(false))).toBe(false);
    expect(decodeTypedKey(encodeKeyNull())).toBeNull();
  });

  it("orders strings after numbers and compares by prefix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-bisc-"));
    const e = await Engine.create(join(dir, "x.db"));
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const idx = await openPkIndex(e);

    await idx.insert(encodeKeyNumber(1), 1);
    await idx.insert(encodeKeyString("a"), 2);
    await idx.insert(encodeKeyString("ab"), 3);
    await idx.insert(encodeKeyString("b"), 4);
    await idx.insert(encodeKeyString("1"), 5);

    const scanned: (number | string | boolean | null)[] = [];
    for await (const entry of idx.scanAll()) scanned.push(decodeTypedKey(entry.key));
    expect(scanned).toEqual([1, "1", "a", "ab", "b"]);

    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

async function indexValuesOf(idx: BtreeIndex, start: Uint8Array | null, end: Uint8Array | null): Promise<number[]> {
  const out: number[] = [];
  for await (const entry of idx.scanRange(start, end)) out.push(entry.value);
  return out;
}