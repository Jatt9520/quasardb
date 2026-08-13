import { describe, it, expect } from "vitest";
import { Engine } from "../engine/engine.js";
import { BtreeIndex } from "./btree.js";
import { renderTree, renderLeafChain, renderStats } from "./render.js";
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

describe("B+tree rendering", () => {
  it("renders an empty tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-r1-"));
    const e = await Engine.create(join(dir, "x.db"));
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const idx = await openPkIndex(e);

    const snap = await idx.dumpTree();
    expect(snap).toEqual([]);
    expect(renderTree(snap)).toBe("(empty tree)");
    expect(renderLeafChain(snap)).toBe("(empty tree)");
    expect(renderStats(snap, await idx.orderValue)).toBe("(empty tree)");

    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders a single-page tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-r2-"));
    const e = await Engine.create(join(dir, "x.db"));
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await run(e, "INSERT INTO t VALUES (1), (2), (3)");
    const idx = await openPkIndex(e);

    const snap = await idx.dumpTree();
    const tree = renderTree(snap);
    expect(tree).toMatch(/\[p\d+\] leaf 3 key\(s\): 1, 2, 3 -> end/);
    expect(tree).toMatch(/depth 0, 1 page\(s\)/);

    const chain = renderLeafChain(snap);
    expect(chain).toContain("[p");
    expect(chain).toMatch(/-> end/);
    expect(chain).toContain("1 leaf page(s)");

    const stats = renderStats(snap, await idx.orderValue);
    expect(stats).toContain("pages: 1 (0 internal, 1 leaf)");
    expect(stats).toContain("depth: 1");

    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders a multi-level tree with leaf sibling links and stats", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-r3-"));
    const e = await Engine.create(join(dir, "x.db"));
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const rows = Array.from({ length: 400 }, (_, i) => `(${i + 1})`).join(",");
    await run(e, `INSERT INTO t VALUES ${rows}`);
    const idx = await openPkIndex(e);

    const snap = await idx.dumpTree();
    const order = await idx.orderValue;

    const tree = renderTree(snap);
    expect(tree).toMatch(/\[p\d+\] internal \d+ key\(s\): .*left→p\d+/);
    expect(tree).toMatch(/\[p\d+\] leaf \d+ key\(s\): .* -> p\d+/);
    expect(tree).toMatch(/depth 1, \d+ page\(s\)/);

    const chain = renderLeafChain(snap);
    expect(chain).toContain("4 leaf page(s)");
    expect(chain.split("\n")[0]).toMatch(/\[p\d+\] \d+ key\(s\): 1, 2, 3/);
    expect(chain).toMatch(/-> end/);

    const stats = renderStats(snap, order);
    expect(stats).toContain("pages: 5 (1 internal, 4 leaf)");
    expect(stats).toContain("depth: 2");
    expect(stats).toContain("keys: 403 total, 400 in leaves");
    expect(stats).toContain(`order: ${order} (max keys per node)`);
    expect(stats).toMatch(/leaf fill: avg \d+\.\d\d, max \d+, utilization \d+\.\d%/);

    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });
});