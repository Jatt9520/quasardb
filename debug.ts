import { Engine } from "./src/engine/engine.js";
import { parseStatement } from "./src/sql/parser.js";

async function q(engine: Engine, sql: string) {
  const parsed = parseStatement(sql);
  const r = await engine.execute(parsed.statement, { explain: parsed.explain });
  if (parsed.explain) {
    console.log("EXPLAIN:", r.explain);
    return r;
  }
  console.log("SQL:", sql);
  console.log("  cols:", r.columns, "rows:", JSON.stringify(r.rows), "count:", r.rowCount);
  return r;
}

const engine = await Engine.create("debug.db");
await q(engine, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, score REAL)");
await q(engine, "INSERT INTO users (name, age, score) VALUES ('alice', 30, 9.5)");
await q(engine, "INSERT INTO users (name, age, score) VALUES ('bob', 25, 7.2)");
await q(engine, "INSERT INTO users (name, age, score) VALUES ('carol', 35, 8.8)");
await q(engine, "SELECT * FROM users ORDER BY id");
await q(engine, "EXPLAIN SELECT name FROM users WHERE age > 28 ORDER BY age DESC");
await q(engine, "SELECT name FROM users WHERE age > 28 ORDER BY age DESC");
await engine.close();