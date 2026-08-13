import { describe, it, expect } from "vitest";
import { Engine } from "../engine/engine.js";
import { BtreeIndex } from "./btree.js";
import { encodeKeyNumber } from "./btree.js";
import { parseStatement } from "../sql/parser.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(e: Engine, sql: string) {
  const p = parseStatement(sql);
  return e.execute(p.statement, {});
}

export async function openPkIndex(e: Engine): Promise<BtreeIndex> {
  const meta = e.catalogData.indexes.find((i) => i.columns.length === 1 && i.columns[0] === "id")!;
  return new BtreeIndex(meta.name, meta.table, meta.columns, meta.metaPageId, e.bufferPool, meta.unique);
}

describe("B+tree: empty tree", () => {
  it("behaves correctly before any insert", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-d1-"));
    const e = await Engine.create(join(dir, "x.db"));
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const idx = await openPkIndex(e);

    expect(await idx.rootPage()).toBe(0);
    expect(await idx.size()).toBe(0);
    expect(await idx.dumpTree()).toEqual([]);
    expect((await idx.verify()).ok).toBe(true);
    expect(await idx.find(encodeKeyNumber(42))).toEqual({ found: false, value: 0 });

    const all: unknown[] = [];
    for await (const entry of idx.scanAll()) all.push(entry.value);
    expect(all).toEqual([]);

    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("querying an empty tree does not create nodes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-d1b-"));
    const e = await Engine.create(join(dir, "x.db"));
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const idx = await openPkIndex(e);

    await idx.find(encodeKeyNumber(1));
    await idx.scanRange(encodeKeyNumber(0), encodeKeyNumber(10));
    expect(await idx.rootPage()).toBe(0);

    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });
});