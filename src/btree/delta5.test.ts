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

describe("B+tree: persistence across reopen", () => {
  it("survives close and reopen: lookups, scans, and structure intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q-d5-"));
    const path = join(dir, "x.db");

    const e1 = await Engine.create(path);
    await run(e1, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const rows = Array.from({ length: 400 }, (_, i) => `(${i + 1})`).join(",");
    await run(e1, `INSERT INTO t VALUES ${rows}`);
    await e1.close();

    const e2 = await Engine.open(path);
    const idx = await openPkIndex(e2);
    expect(await idx.size()).toBe(400);
    expect(await idx.find(encodeKeyNumber(1))).toEqual({ found: true, value: 1 });
    expect(await idx.find(encodeKeyNumber(250))).toEqual({ found: true, value: 250 });
    expect(await idx.find(encodeKeyNumber(401))).toEqual({ found: false, value: 0 });

    const snap = await idx.dumpTree();
    expect(snap.some((s) => s.kind === "internal")).toBe(true);
    expect((await idx.verify()).ok).toBe(true);

    // index remains writable after reopen
    await run(e2, "INSERT INTO t VALUES (401)");
    expect(await idx.size()).toBe(401);
    expect((await idx.find(encodeKeyNumber(401))).found).toBe(true);
    await e2.close();

    rmSync(dir, { recursive: true, force: true });
  });
});