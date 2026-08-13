#!/usr/bin/env node
import { createInterface } from "node:readline";
import { Engine } from "../engine/engine.js";
import { parseStatement } from "../sql/parser.js";
import { formatValue } from "../expr/value.js";

const BANNER = `
╔══════════════════════════════════════════════════════╗
║   QUASARDB — a from-scratch relational database      ║
║   SQL parser · planner · executor · B+tree · MVCC    ║
║   Type "exit" or Ctrl-C to leave.  Type ".help"      ║
╚══════════════════════════════════════════════════════╝
`;

async function main() {
  const dbPath = process.argv[2] ?? "quasar.db";
  let engine: Engine;
  try {
    engine = await Engine.create(dbPath);
    console.log(`(+) created new database at ${dbPath}`);
  } catch {
    engine = await Engine.open(dbPath);
    console.log(`(+) opened database at ${dbPath}`);
  }
  console.log(BANNER);

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "quasar> " });
  rl.prompt();

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }
    if (trimmed === "exit" || trimmed === ".quit") {
      await engine.close();
      rl.close();
      process.exit(0);
    }
    if (trimmed === ".help") {
      console.log("  .tables   list tables");
      console.log("  .indexes  list indexes");
      console.log("  .stats    buffer pool stats");
      console.log("  .verify   verify index invariants");
      console.log("  .btree    render index trees (.btree <idx> [--leaves|--stats])");
      console.log("  exit      quit");
      rl.prompt();
      return;
    }
    if (trimmed === ".tables") {
      for (const t of engine.catalogData.tables) {
        const cols = t.columns.map((c) => `${c.name} ${c.type.toUpperCase()}`).join(", ");
        console.log(`  ${t.name}(${cols})`);
      }
      rl.prompt();
      return;
    }
    if (trimmed === ".indexes") {
      for (const i of engine.catalogData.indexes) {
        console.log(`  ${i.name} ON ${i.table}(${i.columns.join(", ")})${i.unique ? " UNIQUE" : ""}`);
      }
      rl.prompt();
      return;
    }
    if (trimmed === ".stats") {
      const s = engine.bufferPool.stats;
      console.log(`  buffer pool: size=${engine.bufferPool.size}/${engine.bufferPool.capacityValue} hits=${s.hits} misses=${s.misses} evictions=${s.evictions} writes=${s.writes}`);
      console.log(`  hit rate: ${(engine.bufferPool.hitRate() * 100).toFixed(2)}%`);
      rl.prompt();
      return;
    }
    if (trimmed === ".verify") {
      const { BtreeIndex } = await import("../btree/btree.js");
      for (const i of engine.catalogData.indexes) {
        const idx = new BtreeIndex(i.name, i.table, i.columns, i.metaPageId, engine.bufferPool, i.unique);
        const res = await idx.verify();
        console.log(`  index ${i.name}: ${res.ok ? "OK" : "FAILED " + res.errors.join("; ")}`);
      }
      rl.prompt();
      return;
    }
    if (trimmed === ".btree" || trimmed.startsWith(".btree ")) {
      const { BtreeIndex } = await import("../btree/btree.js");
      const { renderTree, renderLeafChain, renderStats } = await import("../btree/render.js");
      const [name, flag] = trimmed.slice(".btree".length).trim().split(/\s+/);
      if (!name) {
        for (const i of engine.catalogData.indexes) {
          console.log(`  ${i.name} ON ${i.table}(${i.columns.join(", ")})${i.unique ? " UNIQUE" : ""}`);
        }
        console.log("  usage: .btree <index> [--leaves|--stats]");
        rl.prompt();
        return;
      }
      const idxMeta = engine.catalogData.indexes.find((i) => i.name === name);
      if (!idxMeta) {
        console.log(`  no such index: ${name}`);
        rl.prompt();
        return;
      }
      const idx = new BtreeIndex(idxMeta.name, idxMeta.table, idxMeta.columns, idxMeta.metaPageId, engine.bufferPool, idxMeta.unique);
      const snap = await idx.dumpTree();
      const order = await idx.orderValue;
      const out = flag === "--stats"
        ? renderStats(snap, order)
        : flag === "--leaves"
          ? renderLeafChain(snap)
          : renderTree(snap);
      console.log(`index ${idxMeta.name}${idxMeta.unique ? " (unique)" : ""}:`);
      console.log(out);
      rl.prompt();
      return;
    }

    try {
      const parsed = parseStatement(trimmed);
      const result = await engine.execute(parsed.statement, { explain: parsed.explain, analyze: parsed.analyze });
      if (parsed.explain && result.explain) {
        console.log(result.explain);
      } else if (result.rowCount === 0 && result.columns.length === 0) {
        console.log("ok, 0 rows affected");
      } else {
        // pretty table
        const widths = result.columns.map((c, i) => {
          let w = c.length;
          for (const r of result.rows) {
            const s = formatValue(r[i]);
            if (s.length > w) w = s.length;
          }
          return Math.min(w, 40);
        });
        const render = (cells: string[]) => "| " + cells.map((c, i) => c.padEnd(widths[i])).join(" | ") + " |";
        const sep = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
        console.log(sep);
        console.log(render(result.columns));
        console.log(sep);
        for (const r of result.rows.slice(0, 200)) {
          console.log(render(r.map((v, i) => formatValue(v))));
        }
        if (result.rows.length > 200) console.log(`  ... ${result.rows.length - 200} more rows`);
        console.log(sep);
        console.log(`${result.rowCount} rows in ${result.timeMs.toFixed(1)}ms`);
      }
    } catch (e) {
      console.log(`ERROR: ${(e as Error).message}`);
    }
    rl.prompt();
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});