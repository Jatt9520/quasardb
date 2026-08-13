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

async function openPkIndex(e: Engine): Promise<BtreeIndex> {
  const meta = e.catalogData.indexes.find((i) => i.columns.length === 1 && i.columns[0] === "id")!;
  return new BtreeIndex(meta.name, meta.table, meta.columns, meta.metaPageId, e.bufferPool, meta.unique);
}

describe("B+tree: delete", () => {
  it("removes entries and keeps size, lookups, and structure consistent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-d4-"));
    const e = await Engine.create(join(dir, "x.db"));
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const rows = Array.from({ length: 400 }, (_, i) => `(${i + 1})`).join(",");
    await run(e, `INSERT INTO t VALUES ${rows}`);
    const idx = await openPkIndex(e);

    // delete every third key
    for (let k = 3; k <= 400; k += 3) {
      expect(await idx.delete(encodeKeyNumber(k))).toBe(true);
    }

    expect(await idx.size()).toBe(400 - Math.floor(400 / 3));
    for (let k = 1; k <= 400; k++) {
      const expectFound = k % 3 !== 0;
      expect(await idx.find(encodeKeyNumber(k))).toEqual(
        expectFound ? { found: true, value: k } : { found: false, value: 0 },
      );
    }
    expect(await idx.delete(encodeKeyNumber(1))).toBe(true);
    expect(await idx.delete(encodeKeyNumber(1))).toBe(false);
    expect((await idx.verify()).ok).toBe(true);

    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes every entry down to an empty leaf chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-d4b-"));
    const e = await Engine.create(join(dir, "x.db"));
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const rows = Array.from({ length: 50 }, (_, i) => `(${i + 1})`).join(",");
    await run(e, `INSERT INTO t VALUES ${rows}`);
    const idx = await openPkIndex(e);

    for (let k = 1; k <= 50; k++) await idx.delete(encodeKeyNumber(k));
    expect(await idx.size()).toBe(0);
    expect(await idx.find(encodeKeyNumber(25))).toEqual({ found: false, value: 0 });
    const all: unknown[] = [];
    for await (const entry of idx.scanAll()) all.push(entry.value);
    expect(all).toEqual([]);
    expect((await idx.verify()).ok).toBe(true);

    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });
});