#!/usr/bin/env node
/**
 * Replica follower: tails a master's WAL (`<db>.wal`) and replays every
 * committed transaction into a local replica database.
 *
 *   npm run replicate -- <master.wal> <replica.db>
 *
 * Run the master (e.g. `npm run repl -- master.db`) in another terminal;
 * every committed write on the master lands here within one poll interval.
 */
import { Engine } from "../engine/engine.js";
import { Replicator } from "../replication/replicator.js";

async function main() {
  const masterWalPath = process.argv[2];
  const replicaDbPath = process.argv[3];
  if (!masterWalPath || !replicaDbPath) {
    console.error("usage: npm run replicate -- <master.wal> <replica.db>");
    process.exit(1);
  }

  const engine = await Engine.create(replicaDbPath);
  const replicator = new Replicator(masterWalPath, engine, replicaDbPath, 250);

  console.log(`(+) replica of ${masterWalPath} -> ${replicaDbPath}`);
  console.log(`(+) applied so far: ${replicator.applied.length} transactions`);

  const poller = setInterval(() => {
    const applied = replicator.applied;
    console.log(`(>) applied ${applied.length} transactions (last xid ${applied.at(-1) ?? "-"})`);
  }, 1000);

  const shutdown = async () => {
    clearInterval(poller);
    await replicator.stop();
    console.log("(x) replica stopped");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await replicator.start();
}

void main();
