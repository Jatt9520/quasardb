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
  dir = mkdtempSync(join(tmpdir(), "quasar-"));
  engine = await Engine.create(join(dir, "test.db"));
});

afterAll(async () => {
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("DDL", () => {
  it("creates and lists tables", async () => {
    await q("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, score REAL)");
    await q("CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, total REAL, created TEXT)");
    expect(engine.catalogData.tables.map((t) => t.name)).toContain("users");
    expect(engine.catalogData.tables.map((t) => t.name)).toContain("orders");
  });

  it("rejects duplicate table", async () => {
    await expect(q("CREATE TABLE users (id INT)")).rejects.toThrow(/already exists/);
  });

  it("creates and drops indexes", async () => {
    await q("CREATE INDEX idx_orders_user ON orders(user_id)");
    expect(engine.catalogData.indexes.length).toBeGreaterThan(0);
    await q("DROP INDEX idx_orders_user");
    expect(engine.catalogData.indexes.some((i) => i.name === "idx_orders_user")).toBe(false);
  });
});

describe("INSERT / SELECT", () => {
  it("inserts rows and selects them back", async () => {
    await q("INSERT INTO users (name, age, score) VALUES ('alice', 30, 9.5)");
    await q("INSERT INTO users (name, age, score) VALUES ('bob', 25, 7.2)");
    await q("INSERT INTO users (name, age, score) VALUES ('carol', 35, 8.8)");
    const r = await q("SELECT * FROM users ORDER BY id");
    expect(r.rowCount).toBe(3);
    expect(r.rows[0]).toEqual([1, "alice", 30, 9.5]);
  });

  it("filters with WHERE", async () => {
    const r = await q("SELECT name FROM users WHERE age > 28 ORDER BY age DESC");
    expect(r.rows).toEqual([["carol"], ["alice"]]);
  });

  it("handles NULLs and IS NULL", async () => {
    await q("INSERT INTO users (name, age) VALUES ('dave', NULL)");
    const r = await q("SELECT COUNT(*) AS n FROM users WHERE age IS NULL");
    expect(r.rows[0][0]).toBe(1);
  });

  it("aggregates with GROUP BY", async () => {
    const r = await q("SELECT count(*), avg(age) FROM users");
    expect(r.rows[0][0]).toBe(4);
    expect(Number((r.rows[0][1] as number).toFixed(1))).toBe(30);
  });

  it("filters groups with HAVING and orders by aggregate", async () => {
    await q("CREATE TABLE names (first TEXT)");
    await q("INSERT INTO names (first) VALUES ('alice'), ('bob'), ('alice'), ('carol')");
    const r = await q("SELECT first, count(*) AS n FROM names GROUP BY first HAVING n > 1 ORDER BY n DESC");
    expect(r.rows).toEqual([["alice", 2]]);
    const r2 = await q("SELECT first, count(*) AS n FROM names GROUP BY first HAVING count(*) = 1 ORDER BY first");
    expect(r2.rows).toEqual([["bob", 1], ["carol", 1]]);
    const r3 = await q(
      "SELECT count(*) AS n FROM names GROUP BY first HAVING first = 'alice' ORDER BY n",
    );
    expect(r3.rows).toEqual([[2]]);
    const r4 = await q(
      "SELECT count(*) AS n FROM names GROUP BY first HAVING first != 'alice' ORDER BY first",
    );
    expect(r4.rows).toEqual([[1], [1]]);
  });

  it("supports LIKE", async () => {
    const r = await q("SELECT name FROM users WHERE name LIKE 'a%'");
    expect(r.rows).toEqual([["alice"]]);
  });

  it("supports IN and BETWEEN", async () => {
    const r = await q("SELECT name FROM users WHERE age BETWEEN 25 AND 30");
    expect(r.rows.sort()).toEqual([["alice"], ["bob"]]);
    const r2 = await q("SELECT name FROM users WHERE name IN ('bob', 'nobody')");
    expect(r2.rows).toEqual([["bob"]]);
  });

  it("supports UPDATE and DELETE", async () => {
    await q("UPDATE users SET score = 10 WHERE name = 'bob'");
    const r = await q("SELECT score FROM users WHERE name = 'bob'");
    expect(r.rows[0][0]).toBe(10);
    await q("DELETE FROM users WHERE name = 'dave'");
    const r2 = await q("SELECT COUNT(*) FROM users");
    expect(r2.rows[0][0]).toBe(3);
  });

  it("supports ORDER BY + LIMIT + DISTINCT", async () => {
    await q("INSERT INTO users (name, age) VALUES ('alice', 40)");
    const r = await q("SELECT DISTINCT name FROM users ORDER BY name LIMIT 2");
    expect(r.rows).toEqual([["alice"], ["bob"]]);
  });
});

describe("JOINs", () => {
  it("inner join", async () => {
    await q("INSERT INTO orders (user_id, total) VALUES (1, 99.5), (2, 42.0)");
    const r = await q("SELECT users.name, orders.total FROM users JOIN orders ON users.id = orders.user_id ORDER BY orders.total");
    expect(r.rows).toEqual([
      ["bob", 42],
      ["alice", 99.5],
    ]);
  });

  it("left join", async () => {
    const r = await q("SELECT users.name, orders.total FROM users LEFT JOIN orders ON users.id = orders.user_id ORDER BY users.id");
    expect(r.rowCount).toBe(4);
    expect(r.rows[2]).toEqual(["carol", null]);
    expect(r.rows[3]).toEqual(["alice", null]);
  });

  it("right join", async () => {
    await q("INSERT INTO orders (user_id, total) VALUES (99, 7.0)");
    const r = await q("SELECT users.name, orders.total FROM users RIGHT JOIN orders ON users.id = orders.user_id ORDER BY orders.total");
    expect(r.rowCount).toBe(3);
    expect(r.rows[0]).toEqual([null, 7]);
    expect(r.rows[1]).toEqual(["bob", 42]);
    expect(r.rows[2]).toEqual(["alice", 99.5]);
  });
});

describe("subqueries", () => {
  it("IN (subquery) and NOT IN", async () => {
    const r = await q("SELECT name FROM users WHERE id IN (SELECT user_id FROM orders) ORDER BY id");
    expect(r.rows).toEqual([["alice"], ["bob"]]);
    const r2 = await q("SELECT name FROM users WHERE id NOT IN (SELECT user_id FROM orders) ORDER BY id");
    expect(r2.rows).toEqual([["carol"], ["alice"]]);
  });

  it("EXISTS / NOT EXISTS", async () => {
    const r = await q("SELECT name FROM users WHERE EXISTS (SELECT 1 FROM orders) ORDER BY id");
    expect(r.rowCount).toBe(4);
    const r2 = await q("SELECT name FROM users WHERE NOT EXISTS (SELECT 1 FROM orders WHERE total > 1000) ORDER BY id");
    expect(r2.rowCount).toBe(4);
    const r3 = await q("SELECT name FROM users WHERE EXISTS (SELECT 1 FROM orders WHERE total > 1000)");
    expect(r3.rowCount).toBe(0);
  });

  it("correlated EXISTS", async () => {
    const r = await q(
      "SELECT name FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id) ORDER BY u.id",
    );
    expect(r.rows).toEqual([["alice"], ["bob"]]);
    const r2 = await q(
      "SELECT name FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id) ORDER BY u.id",
    );
    expect(r2.rows).toEqual([["carol"], ["alice"]]);
  });

  it("correlated IN", async () => {
    const r = await q("SELECT name FROM users u WHERE u.id IN (SELECT o.user_id FROM orders o WHERE o.total > 50)");
    expect(r.rows).toEqual([["alice"]]);
  });

  it("scalar subquery in SELECT list", async () => {
    const r = await q(
      "SELECT name, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS n FROM users u ORDER BY u.id",
    );
    expect(r.rows).toEqual([
      ["alice", 1],
      ["bob", 1],
      ["carol", 0],
      ["alice", 0],
    ]);
  });
});

describe("EXPLAIN", () => {
  it("produces a plan", async () => {
    const r = await q("EXPLAIN SELECT name FROM users WHERE age > 10");
    expect(r.explain).toContain("scan");
    expect(r.explain).toContain("users");
    expect(r.explain).toContain("filter");
  });
});

describe("persistence", () => {
  it("reopens the database file", async () => {
    await engine.close();
    engine = await Engine.open(join(dir, "test.db"));
    const r = await q("SELECT COUNT(*) FROM users");
    expect(r.rows[0][0]).toBe(4);
  });
});

describe("indexes speed up equality lookups", () => {
  it("uses index path on PK lookup", async () => {
    const r = await q("SELECT name FROM users WHERE id = 2");
    expect(r.rows).toEqual([["bob"]]);
  });
});