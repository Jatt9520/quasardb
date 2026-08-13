import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Engine } from "../engine/engine.js";
import { Replicator } from "./replicator.js";
import { parseStatement } from "../sql/parser.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let master: Engine;
let replica: Engine;
let replicator: Replicator;
let masterWalPath: string;

async function q(e: Engine, sql: string) {
  const parsed = parseStatement(sql);
  return e.execute(parsed.statement, { explain: parsed.explain, analyze: parsed.analyze });
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = await cond();
    } catch {
      ok = false; // table may not exist yet; keep polling
    }
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for replica condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "quasar-repl-"));
  masterWalPath = join(dir, "master.db.wal");
  master = await Engine.create(join(dir, "master.db"));
  replica = await Engine.create(join(dir, "replica.db"));
});

afterAll(async () => {
  await replicator.stop();
  await master.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("WAL replication", () => {
  it("catches up on start and replays later commits", async () => {
    await q(master, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
    await q(master, "INSERT INTO users (name) VALUES ('alice')");
    await q(master, "INSERT INTO users (name) VALUES ('bob')");

    replicator = new Replicator(masterWalPath, replica, join(dir, "replica.db"), 20);
    await replicator.start();

    await waitFor(async () => (await q(replicator.engine, "SELECT COUNT(*) FROM users")).rows[0][0] === 2);
    expect(replicator.applied.length).toBe(3);

    await q(master, "INSERT INTO users (name) VALUES ('carol')");
    await waitFor(async () => (await q(replicator.engine, "SELECT COUNT(*) FROM users")).rows[0][0] === 3);

    const rows = await q(replicator.engine, "SELECT * FROM users ORDER BY id");
    expect(rows.rows).toEqual([
      [1, "alice"],
      [2, "bob"],
      [3, "carol"],
    ]);
  });

  it("does not apply a transaction until its commit marker arrives", async () => {
    const s = master.session();
    await s.execute({ kind: "begin" });
    await s.execute(parseStatement("INSERT INTO users (name) VALUES ('dave')").statement);
    await new Promise((r) => setTimeout(r, 200));
    expect((await q(replicator.engine, "SELECT COUNT(*) FROM users")).rows[0][0]).toBe(3);

    await s.execute({ kind: "commit" });
    await waitFor(async () => (await q(replicator.engine, "SELECT COUNT(*) FROM users")).rows[0][0] === 4);
  });

  it("rebuilds the replica when the master log is truncated", async () => {
    await q(master, "DROP TABLE users");
    await master.wal.truncate(); // simulate a clean master close / reset
    await new Promise((r) => setTimeout(r, 100));

    await q(master, "CREATE TABLE fresh (id INTEGER PRIMARY KEY, v TEXT)");
    await q(master, "INSERT INTO fresh (v) VALUES ('reborn')");
    await waitFor(async () => (await q(replicator.engine, "SELECT v FROM fresh")).rows[0][0] === "reborn");

    await expect(q(replicator.engine, "SELECT COUNT(*) FROM users")).rejects.toThrow(/no such table|does not exist|not found/i);
  });
});
