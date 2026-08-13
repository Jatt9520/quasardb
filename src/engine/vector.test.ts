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
  dir = mkdtempSync(join(tmpdir(), "quasar-vec-"));
  engine = await Engine.create(join(dir, "test.db"));
});

afterAll(async () => {
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("VECTOR type", () => {
  it("stores and reads vector columns", async () => {
    await q("CREATE TABLE points (id INTEGER PRIMARY KEY, name TEXT, v VECTOR)");
    await q("INSERT INTO points (name, v) VALUES ('a', [1, 2, 3])");
    await q("INSERT INTO points (name, v) VALUES ('b', [0.5, -1, 4])");

    const r = await q("SELECT id, name, v FROM points ORDER BY id");
    expect(r.rows).toEqual([
      [1, "a", [1, 2, 3]],
      [2, "b", [0.5, -1, 4]],
    ]);
  });

  it("computes euclidean distance with <->", async () => {
    const r = await q("SELECT [3, 4] <-> [0, 0]");
    expect(r.rows[0][0]).toBe(5);
    const r2 = await q("SELECT [1, 1] <-> [4, 5]");
    expect(r2.rows[0][0]).toBe(5);
  });

  it("rejects dimension mismatch", async () => {
    await expect(q("SELECT [1, 2] <-> [1, 2, 3]")).rejects.toThrow(/dimension mismatch/);
    await expect(q("SELECT 5 <-> [1, 2]")).rejects.toThrow(/requires two VECTOR/);
  });

  it("can filter on distance in WHERE", async () => {
    await q("INSERT INTO points (name, v) VALUES ('c', [3, 4, 0])");
    const r = await q("SELECT name FROM points WHERE v <-> [0, 0, 0] < 4.5 ORDER BY id");
    expect(r.rows).toEqual([
      ["a"],
      ["b"],
    ]);
  });

  it("rejects vector primary keys, uniques and indexes", async () => {
    await expect(q("CREATE TABLE bad (v VECTOR PRIMARY KEY)")).rejects.toThrow(/cannot be a primary key/);
    await expect(q("CREATE TABLE bad2 (id INT PRIMARY KEY, v VECTOR UNIQUE)")).rejects.toThrow(/cannot be a primary key/);
    await expect(q("CREATE INDEX idx_v ON points(v)")).rejects.toThrow(/cannot be indexed/);
  });
});

describe("KNN (ORDER BY v <-> q LIMIT k)", () => {
  // distances from [0,0,0]: a=sqrt(14)=3.74, b=sqrt(17.25)=4.15, c=5
  it("returns the k nearest rows in distance order", async () => {
    const r = await q("SELECT name FROM points ORDER BY v <-> [0, 0, 0] LIMIT 2");
    expect(r.rows).toEqual([["a"], ["b"]]);
  });

  it("uses the dedicated knn plan node", async () => {
    const r = await q("EXPLAIN SELECT name FROM points ORDER BY v <-> [0, 0, 0] LIMIT 2");
    expect(r.explain).toContain("knn");
    expect(r.explain).toContain("k=2");
  });

  it("agrees with the generic sort path when there is no limit", async () => {
    const knn = await q("SELECT name FROM points ORDER BY v <-> [0, 0, 0] LIMIT 3");
    const sort = await q("SELECT name FROM points ORDER BY v <-> [0, 0, 0]");
    expect(knn.rows).toEqual([["a"], ["b"], ["c"]]);
    expect(sort.rows).toEqual([["a"], ["b"], ["c"]]);
  });

  it("persists vectors across reopen", async () => {
    const dbPath = join(dir, "test.db");
    await engine.close();
    engine = await Engine.open(dbPath);
    const r = await q("SELECT name, v FROM points ORDER BY id LIMIT 1");
    expect(r.rows).toEqual([["a", [1, 2, 3]]]);
    const knn = await q("SELECT name FROM points ORDER BY v <-> [3, 4, 0] LIMIT 1");
    expect(knn.rows).toEqual([["c"]]);
  });
});
