import { describe, it, expect } from "vitest";
import { Engine } from "../engine/engine.js";
import { BtreeIndex } from "./btree.js";
import { encodeKeyNumber } from "./btree.js";
import { renderTree } from "./render.js";
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

describe("B+tree: single-page tree", () => {
  it("keeps everything in one leaf root below the split threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-d2-"));
    const e = await Engine.create(join(dir, "x.db"));
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const rows = Array.from({ length: 50 }, (_, i) => `(${i + 1})`).join(",");
    await run(e, `INSERT INTO t VALUES ${rows}`);
    const idx = await openPkIndex(e);

    expect(await idx.size()).toBe(50);
    const snap = await idx.dumpTree();
    expect(snap).toHaveLength(1);
    expect(snap[0].kind).toBe("leaf");
    expect(snap[0].parent).toBe(0);
    expect(snap[0].keys[0]).toBe("1");
    expect(snap[0].keys[49]).toBe("50");
    expect(snap[0].nextLeaf).toBe(0);

    for (let i = 1; i <= 50; i++) {
      expect(await idx.find(encodeKeyNumber(i))).toEqual({ found: true, value: i });
    }
    expect(await idx.find(encodeKeyNumber(0))).toEqual({ found: false, value: 0 });
    expect(await idx.find(encodeKeyNumber(51))).toEqual({ found: false, value: 0 });
    expect(renderTree(snap)).toMatch(/\[p\d+\] leaf 50 key\(s\): 1, 2, 3.*-> end/);
    expect((await idx.verify()).ok).toBe(true);

    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });
});