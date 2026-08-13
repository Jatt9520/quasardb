import { describe, it, expect } from "vitest";
import { Engine } from "../engine/engine.js";
import { BtreeIndex, encodeKeyNumber, encodeCompositeKey, decodeCompositeKeyParts } from "./btree.js";
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

describe("B+tree: entry preservation across splits", () => {
  it("keeps every inserted key findable after repeated splits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-cp-"));
    const e = await Engine.create(join(dir, "x.db"));
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const rows = Array.from({ length: 400 }, (_, i) => `(${i + 1})`).join(",");
    await run(e, `INSERT INTO t VALUES ${rows}`);
    const idx = await openIdx(e, e.catalogData.indexes[0].name);

    // every key present exactly once, in order
    const seen: number[] = [];
    for await (const entry of idx.scanAll()) seen.push(entry.value);
    expect(seen).toHaveLength(400);
    for (let i = 0; i < 400; i++) expect(seen[i]).toBe(i + 1);

    const snap = await idx.dumpTree();
    const keysOnPages = snap.filter((s) => s.kind === "leaf").reduce((acc, s) => acc + s.keys.length, 0);
    expect(keysOnPages).toBe(400);
    expect((await idx.verify()).ok).toBe(true);

    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("handles composite keys: split points preserve full key equality", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-cpb-"));
    const e = await Engine.create(join(dir, "x.db"));
    await run(e, "CREATE TABLE t (a INTEGER, b INTEGER)");
    await run(e, "CREATE INDEX idx_ab ON t (a, b)");
    const idx = await openIdx(e, "idx_ab");

    // composite entries are larger than plain int keys, so stay under the
    // per-page byte budget (splits are count-based, not space-based)
    const expected: Array<[number, number]> = [];
    for (let i = 1; i <= 100; i++) {
      expected.push([i, i * 10]);
      await idx.insert(encodeCompositeKey([encodeKeyNumber(i), encodeKeyNumber(i * 10)]), i);
    }

    const scanned: number[] = [];
    let scanIndex = 0;
    for await (const entry of idx.scanAll()) {
      const parts = decodeCompositeKeyParts(entry.key);
      expect(parts).toEqual([expected[scanIndex][0], expected[scanIndex][1]]);
      scanned.push(scanIndex + 1);
      scanIndex++;
    }
    expect(scanned).toEqual(expected.map((_, i) => i + 1));
    expect(await idx.size()).toBe(100);
    expect((await idx.verify()).ok).toBe(true);

    const hit = await idx.find(encodeCompositeKey([encodeKeyNumber(50), encodeKeyNumber(500)]));
    expect(hit).toEqual({ found: true, value: 50 });
    const miss = await idx.find(encodeCompositeKey([encodeKeyNumber(50), encodeKeyNumber(501)]));
    expect(miss).toEqual({ found: false, value: 0 });

    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });
});