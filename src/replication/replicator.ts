import { open } from "node:fs/promises";
import { Engine } from "../engine/engine.js";
import { Statement } from "../sql/ast.js";
import { WalRecord } from "../wal/wal.js";

/**
 * Master-replica replication by WAL tailing.
 *
 * The master appends JSON-line records to `<db>.wal`; commit markers are
 * fsynced. A replica polls that file, replays every committed transaction
 * (statements buffered per xid until its commit marker) onto its own
 * engine, and keeps replaying as new transactions land. The master's log
 * is source-of-truth only; the replica's engine is rebuilt from scratch
 * when the master log is truncated (clean close / database reset).
 *
 * Crash semantics mirror crash recovery: a torn tail line is ignored, a
 * transaction whose marker never arrived is left unapplied, and a replay
 * failure is logged and skipped (documented fastest-path limitation).
 */
export class Replicator {
  private offset = 0;
  private remainder = "";
  private pending = new Map<number, Statement[]>();
  private marked = new Set<number>();
  private appliedXids: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private busy = false;

  constructor(
    private masterWalPath: string,
    private replicaEngine: Engine,
    private replicaDbPath: string,
    private pollMs = 250,
  ) {}

  /** Transaction ids applied so far, in order. */
  get applied(): readonly number[] {
    return this.appliedXids;
  }

  /** The replica engine (replaced on rebuild). */
  get engine(): Engine {
    return this.replicaEngine;
  }

  async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(() => {
      void this.poll().catch((e) => console.error(`[replica] poll failed: ${(e as Error).message}`));
    }, this.pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.replicaEngine.close();
  }

  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      let fh;
      try {
        fh = await open(this.masterWalPath, "r");
      } catch {
        return; // master log not created yet; try again next tick
      }
      try {
        const { size } = await fh.stat();
        if (size < this.offset) {
          // master log was truncated: rebuild the replica from scratch
          await this.rebuild();
          this.offset = 0;
          this.remainder = "";
          this.pending.clear();
          this.marked.clear();
        }
        if (size > this.offset) {
          const buf = Buffer.alloc(64 * 1024);
          let raw = this.remainder;
          while (this.offset < size) {
            const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
            if (bytesRead === 0) break;
            raw += buf.subarray(0, bytesRead).toString("utf8");
            this.offset += bytesRead;
          }
          const newline = raw.lastIndexOf("\n");
          this.remainder = newline === -1 ? raw : raw.slice(newline + 1);
          const lines = newline === -1 ? [] : raw.slice(0, newline).split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            try {
              const rec = JSON.parse(trimmed) as WalRecord;
              this.ingest(rec);
            } catch {
              // torn/partial line: ignored, matches recovery semantics
            }
          }
          await this.applyCommitted();
        }
      } finally {
        await fh.close();
      }
    } finally {
      this.busy = false;
    }
  }

  private ingest(rec: WalRecord): void {
    if (rec.v !== 1) return;
    if (rec.stmt !== undefined) {
      const list = this.pending.get(rec.xid) ?? [];
      list.push(rec.stmt as Statement);
      this.pending.set(rec.xid, list);
    }
    if (rec.commit) {
      // commit marker arrived: apply once the batch is parsed
      this.marked.add(rec.xid);
    }
  }

  private async applyCommitted(): Promise<void> {
    for (const [xid, stmts] of this.pending) {
      if (!this.marked.has(xid)) continue; // marker not seen yet
      try {
        const s = this.replicaEngine.session();
        await s.execute({ kind: "begin" });
        for (const stmt of stmts) await s.execute(stmt);
        await s.execute({ kind: "commit" });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[replica] replay of xid ${xid} failed: ${(e as Error).message}`);
      }
      this.pending.delete(xid);
      this.marked.delete(xid);
      if (!this.appliedXids.includes(xid)) this.appliedXids.push(xid);
    }
  }

  private async rebuild(): Promise<void> {
    if (this.stopped) return;
    await this.replicaEngine.close();
    this.replicaEngine = await Engine.create(this.replicaDbPath);
    this.appliedXids = [];
  }
}
