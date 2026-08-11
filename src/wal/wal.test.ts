import { describe, it, expect } from "vitest";
import { Engine } from "../engine/engine.js";
import { parseStatement } from "../sql/parser.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(e: Engine, sql: string) {
  const p = parseStatement(sql);
  return e.execute(p.statement, { explain: p.explain, analyze: p.analyze });
}

describe("WAL crash recovery", () => {
  it("recovers transactions whose commit marker was fsynced before the crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-wal-"));
    const path = join(dir, "crash.db");
    let e: Engine = await Engine.create(path);
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await run(e, "INSERT INTO t VALUES (1, 'one')");
    await run(e, "BEGIN");
    await run(e, "INSERT INTO t VALUES (2, 'two')");
    await run(e, "COMMIT");
    // crash inside the real commit windows from here on: the WAL marker is
    // fsynced, but NO data page is flushed, so recovery must replay
    const crashPlan = [
      { sql: "INSERT INTO t VALUES (3, 'three')", expected: 3 },
      { sql: "INSERT INTO t VALUES (4, 'four')", expected: 4 },
    ];
    for (const step of crashPlan) {
      e.onCommitMarker = async () => {
        await e.simulateCrash();
      };
      try {
        await run(e, step.sql);
      } catch {
        // commit died mid-way (disk handles closed by simulateCrash)
      }
      e = await Engine.open(path); // recovery replays the unflushed commit
      e.onCommitMarker = undefined;
      expect((await run(e, "SELECT COUNT(*) FROM t")).rows[0][0]).toBe(step.expected);
      expect((await run(e, "SELECT v FROM t ORDER BY id")).rows).toEqual([
        ["one"], ["two"], ["three"], ["four"],
      ].slice(0, step.expected));
    }
    // a clean run afterwards keeps working and truncates the log
    await run(e, "INSERT INTO t VALUES (5, 'five')");
    await e.close();
    e = await Engine.open(path);
    expect((await run(e, "SELECT COUNT(*) FROM t")).rows[0][0]).toBe(5);
    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("discards uncommitted and rolled-back transactions on crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-wal-"));
    const path = join(dir, "crash.db");
    let e: Engine = await Engine.create(path);
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await run(e, "INSERT INTO t VALUES (1)");
    await run(e, "BEGIN");
    await run(e, "INSERT INTO t VALUES (2)"); // never committed
    await e.simulateCrash();
    e = await Engine.open(path);
    expect((await run(e, "SELECT COUNT(*) FROM t")).rows[0][0]).toBe(1);
    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("recovers DDL and index mutations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-wal-"));
    const path = join(dir, "crash.db");
    let e: Engine = await Engine.create(path);
    await run(e, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await run(e, "CREATE INDEX idx_v ON t(v)");
    await run(e, "INSERT INTO t VALUES (1, 'x')");
    await run(e, "UPDATE t SET v = 'y' WHERE id = 1");
    await e.simulateCrash();
    e = await Engine.open(path);
    expect((await run(e, "SELECT v FROM t WHERE id = 1")).rows).toEqual([["y"]]);
    expect((await run(e, "SELECT id FROM t WHERE v = 'y'")).rows).toEqual([[1]]); // index path
    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });
});