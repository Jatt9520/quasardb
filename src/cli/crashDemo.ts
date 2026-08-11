import { Engine } from "../engine/engine.js";
import { parseStatement } from "../sql/parser.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Two-process crash-recovery demo.
 *
 *   npm run crash-demo
 *
 * Phase 1 (--write): writes committed rows, then "crashes" mid-commit —
 * the WAL commit marker is fsynced but no data page reaches the file.
 * Phase 2 (--check): a fresh process reopens the database; crash recovery
 * replays the WAL and every committed row must be present.
 */

const ROOT = join(".crash-demo");
const DB = join(ROOT, "crash.db");

async function run(e: Engine, sql: string) {
  const p = parseStatement(sql);
  return e.execute(p.statement, { explain: p.explain, analyze: p.analyze });
}

const mode = (process.argv[2] ?? "write").replace(/^-+/, "");

if (mode === "write") {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const e = await Engine.create(DB);
  await run(e, "CREATE TABLE crash_demo (id INTEGER PRIMARY KEY, msg TEXT)");
  await run(e, "INSERT INTO crash_demo VALUES (1, 'alpha')");
  await run(e, "BEGIN");
  await run(e, "INSERT INTO crash_demo VALUES (2, 'beta')");
  await run(e, "INSERT INTO crash_demo VALUES (3, 'gamma')");
  await run(e, "COMMIT");
  console.log("[write] 3 rows committed; WAL markers fsynced.");
  console.log("[write] killing the process exactly at the crash window (commit marker durable, data pages NOT)");
  // crash inside the real commit window: equivalent to an OS-level kill
  e.onCommitMarker = async () => {
    await e.simulateCrash();
  };
  try {
    await run(e, "INSERT INTO crash_demo VALUES (4, 'delta')");
  } catch {
    // process "died" as intended before the data flush
  }
  console.log("[write] process crashed. starting fresh process...\n");
} else {
  console.log("[check] reopening the database in a new process...");
  const e = await Engine.open(DB);
  const r = await run(e, "SELECT id, msg FROM crash_demo ORDER BY id");
  console.log("[check] rows after crash:", JSON.stringify(r.rows));
  const ok = r.rows.length === 4 && (r.rows[3] as [number, string])[1] === "delta";
  await e.close();
  if (ok) {
    console.log("[check] OK — all 4 committed rows survived the crash via WAL recovery");
  } else {
    console.error("[check] FAIL — expected 4 rows including 'delta'");
    process.exit(1);
  }
}