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
  it("derived table in FROM", async () => {
    const r = await q(
      "SELECT t.name FROM (SELECT name, age FROM users WHERE age > 24) AS t ORDER BY t.age",
    );
    expect(r.rows).toEqual([["bob"], ["alice"], ["carol"], ["alice"]]);
    const r2 = await q(
      "SELECT t.n FROM (SELECT count(*) AS n FROM orders) AS t WHERE t.n > 0",
    );
    expect(r2.rows).toEqual([[3]]);
    const r3 = await q(
      "SELECT a.name, b.cnt FROM users a JOIN (SELECT user_id, count(*) AS cnt FROM orders GROUP BY user_id) AS b ON a.id = b.user_id ORDER BY a.id",
    );
    expect(r3.rows).toEqual([
      ["alice", 1],
      ["bob", 1],
    ]);
  });
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

describe("set operations", () => {
  it("UNION dedupes and UNION ALL keeps duplicates", async () => {
    const r = await q("SELECT name FROM users WHERE age >= 25 UNION SELECT name FROM users WHERE name LIKE 'a%' ORDER BY name");
    expect(r.rows).toEqual([["alice"], ["bob"], ["carol"]]);
    const r2 = await q("SELECT name FROM users WHERE age >= 25 UNION ALL SELECT name FROM users WHERE name LIKE 'a%' ORDER BY name");
    expect(r2.rows).toEqual([
      ["alice"], ["alice"], ["alice"], ["alice"], ["bob"], ["carol"],
    ]);
  });

  it("INTERSECT / INTERSECT ALL", async () => {
    const r = await q("SELECT name FROM users WHERE age >= 25 INTERSECT SELECT name FROM users WHERE name LIKE 'a%' ORDER BY name");
    expect(r.rows).toEqual([["alice"]]);
    const r2 = await q("SELECT name FROM users WHERE name LIKE 'a%' INTERSECT ALL SELECT name FROM users WHERE name LIKE 'a%' ORDER BY name");
    expect(r2.rows).toEqual([["alice"], ["alice"]]);
  });

  it("EXCEPT / EXCEPT ALL", async () => {
    const r = await q("SELECT name FROM users WHERE age >= 25 EXCEPT SELECT name FROM users WHERE name LIKE 'a%' ORDER BY name");
    expect(r.rows).toEqual([["bob"], ["carol"]]);
    const r2 = await q("SELECT name FROM users WHERE name LIKE 'a%' EXCEPT ALL SELECT name FROM users WHERE name = 'nobody' ORDER BY name");
    expect(r2.rows).toEqual([["alice"], ["alice"]]);
    const r3 = await q("SELECT name FROM users WHERE name LIKE 'a%' EXCEPT ALL SELECT name FROM users WHERE name LIKE 'a%'");
    expect(r3.rowCount).toBe(0);
  });

  it("set ops combine columns and mixed-table operands", async () => {
    await q("CREATE TABLE left_t (v INTEGER)");
    await q("CREATE TABLE right_t (v INTEGER)");
    await q("INSERT INTO left_t VALUES (1), (2), (3)");
    await q("INSERT INTO right_t VALUES (2), (3), (4)");
    const u = await q("SELECT v FROM left_t UNION SELECT v FROM right_t ORDER BY v");
    expect(u.rows).toEqual([[1], [2], [3], [4]]);
    const i = await q("SELECT v FROM left_t INTERSECT SELECT v FROM right_t ORDER BY v");
    expect(i.rows).toEqual([[2], [3]]);
    const e = await q("SELECT v FROM left_t EXCEPT SELECT v FROM right_t ORDER BY v");
    expect(e.rows).toEqual([[1]]);
  });

  it("rejects mismatched column counts", async () => {
    await expect(q("SELECT name, age FROM users UNION SELECT name FROM users")).rejects.toThrow(/same number of columns/);
  });

  it("supports set ops in derived tables and subqueries", async () => {
    const r = await q(
      "SELECT t.v FROM (SELECT v FROM left_t UNION SELECT v FROM right_t) AS t WHERE t.v > 2 ORDER BY t.v",
    );
    expect(r.rows).toEqual([[3], [4]]);
    const r2 = await q("SELECT v FROM left_t WHERE v IN (SELECT v FROM right_t UNION SELECT v FROM left_t WHERE v = 5) ORDER BY v");
    expect(r2.rows).toEqual([[2], [3]]);
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

describe("transactions", () => {
  it("rolls back INSERT, UPDATE and DELETE together", async () => {
    await q("BEGIN");
    await q("INSERT INTO users (name, age) VALUES ('txn1', 50)");
    await q("UPDATE users SET age = 1 WHERE name = 'bob'");
    await q("DELETE FROM names WHERE first = 'alice'");
    expect((await q("SELECT COUNT(*) FROM users")).rows[0][0]).toBe(5);
    await q("ROLLBACK");
    expect((await q("SELECT COUNT(*) FROM users")).rows[0][0]).toBe(4);
    expect((await q("SELECT age FROM users WHERE name = 'bob'")).rows[0][0]).toBe(25);
    expect((await q("SELECT COUNT(*) FROM names")).rows[0][0]).toBe(4);
    const r = await q("SELECT name FROM users WHERE age = 25");
    expect(r.rows).toEqual([["bob"]]);
  });

  it("restores heap header (row count) even when the page was evicted", async () => {
    const meta = engine.catalogData.tables.find((t) => t.name === "users")!;
    await q("BEGIN");
    await q("INSERT INTO users (name, age) VALUES ('evicted', 1)");
    await engine.bufferPool.dropPage(meta.headerPageId);
    expect(engine.bufferPool.chainLength(meta.headerPageId)).toBeGreaterThan(0);
    await q("ROLLBACK");
    expect((await q("SELECT COUNT(*) FROM users")).rows[0][0]).toBe(4);
    const r = await q("SELECT name FROM users WHERE name = 'evicted'");
    expect(r.rowCount).toBe(0);
  });

  it("rolls back DDL: CREATE TABLE and its data", async () => {
    await q("BEGIN");
    await q("CREATE TABLE txn_t (id INTEGER PRIMARY KEY, v TEXT)");
    await q("INSERT INTO txn_t VALUES (1, 'x')");
    expect(engine.catalogData.tables.some((t) => t.name === "txn_t")).toBe(true);
    await q("ROLLBACK");
    expect(engine.catalogData.tables.some((t) => t.name === "txn_t")).toBe(false);
    await expect(q("SELECT * FROM txn_t")).rejects.toThrow(/not found/);
    await expect(q("CREATE TABLE txn_t (id INTEGER)")).resolves.toBeTruthy();
  });

  it("rolls back DDL: DROP TABLE", async () => {
    await q("BEGIN");
    await q("DROP TABLE left_t");
    expect(engine.catalogData.tables.some((t) => t.name === "left_t")).toBe(false);
    await q("ROLLBACK");
    expect(engine.catalogData.tables.some((t) => t.name === "left_t")).toBe(true);
    const r = await q("SELECT COUNT(*) FROM left_t");
    expect(r.rows[0][0]).toBe(3);
  });

  it("rejects wrong transaction control", async () => {
    await expect(q("COMMIT")).rejects.toThrow(/no transaction/);
    await expect(q("ROLLBACK")).rejects.toThrow(/no transaction/);
    await q("BEGIN");
    await expect(q("BEGIN")).rejects.toThrow(/already in a transaction/);
    await q("ROLLBACK");
    await expect(q("ROLLBACK")).rejects.toThrow(/no transaction/);
  });

  it("statement errors inside a transaction keep it open and rollable", async () => {
    await q("BEGIN");
    await q("INSERT INTO users (name, age) VALUES ('txn3', 1)");
    await expect(q("INSERT INTO missing_table VALUES (1)")).rejects.toThrow(/not found/);
    expect(engine.inTransaction).toBe(true);
    await q("ROLLBACK");
    expect((await q("SELECT COUNT(*) FROM users")).rows[0][0]).toBe(4);
  });

  it("commit persists across reopen", async () => {
    await q("BEGIN");
    await q("INSERT INTO users (name, age) VALUES ('persist', 2)");
    const rows = await q("SELECT COUNT(*) FROM users");
    expect(rows.rows[0][0]).toBe(5);
    await q("COMMIT");
    await engine.close();
    engine = await Engine.open(join(dir, "test.db"));
    const r = await q("SELECT name FROM users WHERE name = 'persist'");
    expect(r.rows).toEqual([["persist"]]);
  });
});

describe("MVCC sessions", () => {
  // a helper that runs SQL through an isolated session of the shared engine
  const sess = () => {
    const s = engine.session();
    return async (sql: string) => {
      const p = parseStatement(sql);
      return s.execute(p.statement, { explain: p.explain, analyze: p.analyze });
    };
  };

  it("hides uncommitted writes from other sessions until commit", async () => {
    await q("CREATE TABLE mvcc_t (id INTEGER PRIMARY KEY, v TEXT)");
    const a = sess();
    const b = sess();
    await a("BEGIN");
    await a("INSERT INTO mvcc_t VALUES (1, 'one')");
    // the writer sees its own uncommitted write (heap and pk index paths)
    expect((await a("SELECT v FROM mvcc_t WHERE id = 1")).rows).toEqual([["one"]]);
    expect((await a("SELECT COUNT(*) FROM mvcc_t")).rows[0][0]).toBe(1);
    // another session sees nothing, through either access path
    expect((await b("SELECT COUNT(*) FROM mvcc_t")).rows[0][0]).toBe(0);
    expect((await b("SELECT v FROM mvcc_t WHERE id = 1")).rowCount).toBe(0);
    // a concurrent writer is rejected conservatively
    await expect(b("INSERT INTO mvcc_t VALUES (2, 'two')")).rejects.toThrow(/write conflict/);
    // commit publishes the row to everyone
    await a("COMMIT");
    expect((await b("SELECT * FROM mvcc_t")).rowCount).toBe(1);
    expect((await b("INSERT INTO mvcc_t VALUES (2, 'two')")).rowCount).toBe(1);
    await q("DROP TABLE mvcc_t");
  });

  it("rollback restores the pre-transaction state for other sessions", async () => {
    await q("CREATE TABLE rb_t (id INTEGER PRIMARY KEY, v TEXT)");
    await q("INSERT INTO rb_t VALUES (1, 'x')");
    const a = sess();
    const b = sess();
    await a("BEGIN");
    await a("UPDATE rb_t SET v = 'y' WHERE id = 1");
    expect((await a("SELECT v FROM rb_t WHERE id = 1")).rows).toEqual([["y"]]);
    // outsider still reads the old value through heap and pk index
    expect((await b("SELECT v FROM rb_t WHERE id = 1")).rows).toEqual([["x"]]);
    expect((await q("SELECT COUNT(*) FROM rb_t")).rows[0][0]).toBe(1);
    await a("ROLLBACK");
    expect((await q("SELECT v FROM rb_t WHERE id = 1")).rows).toEqual([["x"]]);
    expect((await q("SELECT COUNT(*) FROM rb_t")).rows[0][0]).toBe(1);
    await q("DROP TABLE rb_t");
  });

  it("autocommit write statements are atomic on error", async () => {
    await q("CREATE TABLE at_t (id INTEGER PRIMARY KEY)");
    await q("INSERT INTO at_t VALUES (1)");
    await expect(q("INSERT INTO at_t VALUES (2), (1)")).rejects.toThrow(/UNIQUE/);
    expect((await q("SELECT COUNT(*) FROM at_t")).rows[0][0]).toBe(1);
    await q("DROP TABLE at_t");
  });

  it("commits publish to later snapshots; version chains are garbage-collected", async () => {
    await q("CREATE TABLE gc_t (id INTEGER PRIMARY KEY, v TEXT)");
    const a = sess();
    await a("BEGIN");
    await a("INSERT INTO gc_t VALUES (1, 'one')");
    const b = sess();
    // b's snapshot predates a's commit: still hidden
    expect((await b("SELECT COUNT(*) FROM gc_t")).rows[0][0]).toBe(0);
    await a("COMMIT");
    expect((await q("SELECT COUNT(*) FROM gc_t")).rows[0][0]).toBe(1);
    // all committed: no live chain should survive on the table pages
    const meta = engine.catalogData.tables.find((t) => t.name === "gc_t")!;
    expect(engine.bufferPool.chainLength(meta.headerPageId)).toBe(0);
    await q("DROP TABLE gc_t");
  });
});