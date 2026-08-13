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

describe("B+tree: splits into a multi-level tree", () => {
  it("grows an internal root with a chained leaf level and stays structurally valid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-d3-"));
    const e = await Engine.create(join(dir, "x.db"));
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const rows = Array.from({ length: 400 }, (_, i) => `(${i + 1})`).join(",");
    await run(e, `INSERT INTO t VALUES ${rows}`);
    const idx = await openPkIndex(e);

    expect(await idx.size()).toBe(400);
    const snap = await idx.dumpTree();

    const internals = snap.filter((s) => s.kind === "internal");
    const leaves = snap.filter((s) => s.kind === "leaf");
    expect(internals).toHaveLength(1);
    expect(internals[0].parent).toBe(0);
    expect(leaves.length).toBeGreaterThan(1);

    // every leaf belongs to the internal root — exercises parent pointers
    // (regression: leaf row-ids used to clobber parent links)
    for (const leaf of leaves) {
      expect(leaf.parent).toBe(internals[0].pageId);
    }

    // the leaf chain must visit every page exactly once, ascending
    const chain: string[] = [];
    const seen = new Set<number>();
    let cur: number = internals[0].leftmostChild;
    while (cur !== 0 && !seen.has(cur)) {
      seen.add(cur);
      const node = snap.find((s) => s.pageId === cur)!;
      chain.push(...node.keys);
      cur = node.nextLeaf;
    }
    expect(chain).toHaveLength(400);
    for (let i = 0; i < 400; i++) expect(chain[i]).toBe(String(i + 1));

    for (const k of [1, 100, 193, 288, 289, 400]) {
      expect(await idx.find(encodeKeyNumber(k))).toEqual({ found: true, value: k });
    }
    expect((await idx.verify()).ok).toBe(true);

    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });
});