import { Engine } from "./src/engine/engine.js";
import { parseStatement } from "./src/sql/parser.js";

const engine = await Engine.create("debug.db");
async function q(sql: string) {
  const parsed = parseStatement(sql);
  try {
    const r = await engine.execute(parsed.statement, { explain: parsed.explain });
    console.log("SQL: " + sql + "\n  cols:", r.columns, "rows:", JSON.stringify(r.rows), "count:", r.rowCount);
  } catch (e) {
    console.log("SQL: " + sql + "\n  ERROR: " + (e as Error).message);
  }
}

await q("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, score REAL)");
await q("CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, total REAL, created TEXT)");
await q("INSERT INTO users (name, age, score) VALUES ('alice', 30, 9.5)");
await q("INSERT INTO users (name, age, score) VALUES ('bob', 25, 7.2)");
await q("INSERT INTO users (name, age, score) VALUES ('carol', 35, 8.8)");
await q("INSERT INTO users (name, age, score) VALUES ('dave', 30, 1.0)");
await q("UPDATE users SET score = 10 WHERE name = 'bob'");
await q("DELETE FROM users WHERE name = 'dave'");
await q("SELECT COUNT(*) FROM users");
await q("INSERT INTO orders (user_id, total) VALUES (1, 99.5), (2, 42.0)");
await q("SELECT users.name, orders.total FROM users LEFT JOIN orders ON users.id = orders.user_id ORDER BY users.id");
await engine.close();