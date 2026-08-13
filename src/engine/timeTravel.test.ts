import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Engine } from "../engine/engine.js";
import { parseStatement } from "../sql/parser.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let engine: Engine;
let dir: string;

async function q(sql: string) {
  const parsed = parseStatement(sql);
  return engine.execute(parsed.statement, { explain: parsed.explain, analyze: parsed.analyze });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "quasar-asof-"));
  engine = await Engine.create(join(dir, "test.db"));
  await q("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)");
});

afterAll(async () => {
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("time travel AS OF", () => {
  it("reads the table as of a past commit", async () => {
    await q("INSERT INTO items (name, qty) VALUES ('rope', 3)");
    const afterRope = engine.catalog.lastTxnId;
    await q("INSERT INTO items (name, qty) VALUES ('ax', 1)");
    const afterAx = engine.catalog.lastTxnId;
    await q("INSERT INTO items (name, qty) VALUES ('torch', 5)");

    const past = await q(`SELECT id, name FROM items ORDER BY id AS OF ${afterRope}`);
    expect(past.rows).toEqual([[1, "rope"]]);

    const mid = await q(`SELECT id, name FROM items ORDER BY id AS OF ${afterAx}`);
    expect(mid.rows).toEqual([
      [1, "rope"],
      [2, "ax"],
    ]);

    const now = await q("SELECT id, name FROM items ORDER BY id");
    expect(now.rowCount).toBe(3);
  });

  it("sees pre-update values at the older snapshot", async () => {
    const before = engine.catalog.lastTxnId;
    await q("UPDATE items SET qty = 99 WHERE name = 'rope'");
    await q("DELETE FROM items WHERE name = 'ax'");

    const past = await q(`SELECT id, name, qty FROM items ORDER BY id AS OF ${before}`);
    expect(past.rows).toEqual([
      [1, "rope", 3],
      [2, "ax", 1],
      [3, "torch", 5],
    ]);

    const now = await q("SELECT id, name, qty FROM items ORDER BY id");
    expect(now.rows).toEqual([
      [1, "rope", 99],
      [3, "torch", 5],
    ]);
  });

  it("works inside an explicit transaction", async () => {
    const before = engine.catalog.lastTxnId;
    await q("BEGIN");
    const past = await q(`SELECT name FROM items AS OF ${before}`);
    expect(past.rows).toEqual([
      ["rope"],
      ["torch"],
    ]);
    await q("COMMIT");
  });

  it("works on a set operation", async () => {
    const snap = engine.catalog.lastTxnId;
    const r = await q(`SELECT name FROM items UNION SELECT name FROM items AS OF ${snap}`);
    expect(r.rows).toEqual([
      ["rope"],
      ["torch"],
    ]);
  });

  it("rejects an uncommitted transaction id", async () => {
    const xid = engine.pool.nextXid();
    await expect(q(`SELECT * FROM items AS OF ${xid}`)).rejects.toThrow(/not committed/);
  });

  it("rejects snapshots outside the retained window", async () => {
    const saved = engine.timeTravelDepth;
    engine.timeTravelDepth = 2;
    const first = engine.catalog.lastTxnId;
    await q("INSERT INTO items (name, qty) VALUES ('lamp', 2)");
    await q("INSERT INTO items (name, qty) VALUES ('pick', 4)");
    await q("INSERT INTO items (name, qty) VALUES ('helm', 6)");

    await expect(q(`SELECT * FROM items AS OF ${first}`)).rejects.toThrow(/outside the time-travel window/);

    const window = engine.timeTravelWindow;
    const stillThere = await q(`SELECT * FROM items AS OF ${window.oldest}`);
    expect(stillThere.rowCount).toBeGreaterThan(0);
    engine.timeTravelDepth = saved;
  });

  it("exposes the reachable window via the engine", async () => {
    const w = engine.timeTravelWindow;
    expect(w.newest).toBe(engine.catalog.lastTxnId);
    expect(w.oldest).toBeGreaterThan(0);
    expect(w.oldest).toBeLessThanOrEqual(w.newest);
    expect(w.depth).toBe(engine.timeTravelDepth);
  });
});
