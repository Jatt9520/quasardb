import { describe, it, expect } from "vitest";
import { Engine } from "../engine/engine.js";
import { BtreeIndex } from "./btree.js";
import { encodeKeyNumber, decodeTypedKey } from "./btree.js";
import { parseStatement } from "../sql/parser.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(e: Engine, sql: string) {
  const p = parseStatement(sql);
  return e.execute(p.statement, {});
}

async function openIdx(e: Engine, indexName: string): Promise<BtreeIndex> {
  const meta = e.catalogData.indexes.find((i) => i.name === indexName)!;
  return new BtreeIndex(meta.name, meta.table, meta.columns, meta.metaPageId, e.bufferPool, meta.unique);
}

async function openAnyIdx(e: Engine): Promise<BtreeIndex> {
  const meta = e.catalogData.indexes[0];
  return new BtreeIndex(meta.name, meta.table, meta.columns, meta.metaPageId, e.bufferPool, meta.unique);
}

describe("B+tree: insert semantics", () => {
  it("rejects duplicates on a unique index and keeps the original value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-ins-"));
    const e = await Engine.create(join(dir, "x.db"));
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const idx = await openAnyIdx(e);

    expect(await idx.insert(encodeKeyNumber(7), 100)).toBe(true);
    await expect(idx.insert(encodeKeyNumber(7), 200)).rejects.toThrow(/UNIQUE constraint failed/);
    expect(await idx.size()).toBe(1);
    expect(await idx.find(encodeKeyNumber(7))).toEqual({ found: true, value: 100 });
    expect((await idx.verify()).ok).toBe(true);

    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("overwrites the value on a non-unique index without growing the tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-insb-"));
    const e = await Engine.create(join(dir, "x.db"));
    await run(e, "CREATE TABLE t (a INTEGER)");
    await run(e, "CREATE INDEX idx ON t (a)");
    const idx = await openIdx(e, "idx");
    expect(idx.unique).toBe(false);

    await idx.insert(encodeKeyNumber(5), 1);
    await idx.insert(encodeKeyNumber(5), 2);
    expect(await idx.size()).toBe(1);
    expect(await idx.find(encodeKeyNumber(5))).toEqual({ found: true, value: 2 });

    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts out-of-order inserts and still scans ascending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-insc-"));
    const e = await Engine.create(join(dir, "x.db"));
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const idx = await openAnyIdx(e);

    const shuffled = [300, 1, 250, 99, 400, 42, 150, 7, 200, 333];
    for (const k of shuffled) await idx.insert(encodeKeyNumber(k), k);

    const scanned: number[] = [];
    for await (const entry of idx.scanAll()) scanned.push(decodeTypedKey(entry.key) as number);
    expect(scanned).toEqual([1, 7, 42, 99, 150, 200, 250, 300, 333, 400]);
    expect((await idx.verify()).ok).toBe(true);

    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });
});