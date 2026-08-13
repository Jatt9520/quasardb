import { BufferPool } from "../storage/bufferPool.js";
import { Catalog, CatalogData } from "../storage/catalog.js";
import { BtreeIndex, compareKeys, keyToString } from "../btree/btree.js";
import { TableHeap } from "../storage/tableHeap.js";
import { Statement } from "../sql/ast.js";
import { Value } from "../expr/value.js";
import { FileDisk } from "../storage/disk.js";
import { Wal } from "../wal/wal.js";
import { Session } from "./session.js";

export interface QueryResult {
  columns: string[];
  rows: Value[][];
  rowCount: number;
  timeMs: number;
  explain?: string;
  analyze?: { operator: string; rows: number; timeMs: number; pages: number }[];
}

/**
 * The database engine. Owns the shared buffer pool and catalog; every
 * connection works through its own {@link Session} against the same pool.
 */
export class Engine {
  readonly pool: BufferPool;
  readonly catalog: Catalog;
  readonly heaps = new Map<string, TableHeap>();
  readonly metas = new Map<string, import("../storage/catalog.js").TableMeta>();
  readonly indexes = new Map<string, BtreeIndex[]>();
  readonly wal: Wal;
  private defaultSession: Session;

  private constructor(pool: BufferPool, catalog: Catalog, wal: Wal) {
    this.pool = pool;
    this.catalog = catalog;
    this.wal = wal;
    // xids must stay above the durable watermark so a fresh pool can never
    // re-record transactions low enough to be skipped by the next recovery
    this.pool.setXidBase(catalog.lastTxnId);
    this.loadState();
    this.defaultSession = new Session(this);
  }

  static async create(path: string): Promise<Engine> {
    const disk = await FileDisk.open(path);
    const pool = new BufferPool(disk, 512);
    await pool.initAllocator();
    const catalog = await Catalog.create(pool);
    const wal = await Wal.open(`${path}.wal`);
    const engine = new Engine(pool, catalog, wal);
    await engine.commitCatalog();
    // fresh database: nothing to recover
    await wal.truncate();
    return engine;
  }

  static async open(path: string): Promise<Engine> {
    const disk = await FileDisk.open(path);
    const pool = new BufferPool(disk, 512);
    await pool.initAllocator();
    const catalog = await Catalog.open(pool);
    const wal = await Wal.open(`${path}.wal`);
    const engine = new Engine(pool, catalog, wal);
    await engine.recoverWals();
    return engine;
  }

  /**
   * Crash recovery: replay every committed transaction whose id exceeds the
   * durable watermark, then truncate the log. Statements that fail replay
   * (e.g. a duplicate key already made durable in the rare crash window
   * between the data flush and the watermark persist) are skipped and
   * reported. This is fastest-path recovery only; see the WAL module docs.
   */
  private async recoverWals(): Promise<void> {
    const recs = await this.wal.readAll();
    if (recs.length === 0) {
      await this.wal.truncate();
      return;
    }
    const committed = new Set<number>();
    for (const r of recs) {
      if (r.v === 1 && r.commit) committed.add(r.xid);
    }
    const watermark = this.catalog.lastTxnId;
    const todo = recs.filter((r) => r.v === 1 && r.stmt !== undefined && r.xid > watermark && committed.has(r.xid));
    if (todo.length > 0) {
      this.wal.setEnabled(false);
      const replay = this.session();
      const recovered: number[] = [];
      for (const r of todo) {
        try {
          await replay.execute(r.stmt as Statement);
          recovered.push(r.xid);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`[wal] replay of xid ${r.xid} skipped: ${(e as Error).message}`);
        }
      }
      this.wal.setEnabled(true);
      // advance the watermark past recovered transactions only, so a failed
      // replay would be retried on the next recovery
      for (const xid of recovered) this.catalog.setLastTxnId(xid);
      await this.commitWatermark();
    }
    await this.wal.truncate();
  }

  /** Persist the watermark durably (data must already be flushed). */
  private async commitWatermark(): Promise<void> {
    await this.catalog.persist();
    await this.pool.flushAll();
  }

  private loadState(): void {
    for (const t of this.catalog.dataValue.tables) {
      this.metas.set(t.name.toLowerCase(), t);
      this.heaps.set(t.name.toLowerCase(), new TableHeap(t.name, t.headerPageId, this.pool));
    }
    for (const i of this.catalog.dataValue.indexes) {
      const idx = new BtreeIndex(i.name, i.table, i.columns, i.metaPageId, this.pool, i.unique);
      const arr = this.indexes.get(i.table.toLowerCase()) ?? [];
      arr.push(idx);
      this.indexes.set(i.table.toLowerCase(), arr);
    }
  }

  refreshState(): void {
    this.heaps.clear();
    this.metas.clear();
    this.indexes.clear();
    this.loadState();
  }

  async commitCatalog(): Promise<void> {
    await this.catalog.persist();
  }

  async syncAll(): Promise<void> {
    await this.pool.flushAll();
    await this.catalog.persist();
  }

  get bufferPool(): BufferPool {
    return this.pool;
  }

  get catalogData(): CatalogData {
    return this.catalog.dataValue;
  }

  /** Create a new isolated session over this engine (network connections get one each). */
  session(): Session {
    return new Session(this);
  }

  get inTransaction(): boolean {
    return this.defaultSession.inTransaction;
  }

  /*
   * Test/demo hook: invoked inside commit() right after the WAL commit
   * marker is fsynced but BEFORE any data page is flushed. Simulating a
   * crash here exercises the exact replay path recovery must handle.
   */
  onCommitMarker?: () => Promise<void>;

  /**
   * Commit sequence (crash-safe ordering):
   *  1. WAL commit marker + fsync   -> the transaction is durably logged
   *  2. flushAll data pages         -> the writes reach the database file
   *  3. persist + flushAll          -> the lastTxnId watermark, so recovery
   *                                    never replays already-durable commits
   */
  async commit(xid: number): Promise<void> {
    await this.wal.appendCommit(xid);
    if (this.onCommitMarker) await this.onCommitMarker();
    this.catalog.setLastTxnId(xid);
    this.retainTimeTravelSnapshot(xid);
    await this.pool.flushAll();
    await this.catalog.persist();
    await this.pool.flushAll();
  }

  /** Number of most-recent commits kept readable via `SELECT ... AS OF <xid>`. */
  timeTravelDepth = 64;

  /** Committed xids pinned as active snapshots so their pre-images survive GC. */
  private historySnapshots: number[] = [];

  private retainTimeTravelSnapshot(xid: number): void {
    this.pool.takeSnapshot(xid);
    this.historySnapshots.push(xid);
    while (this.historySnapshots.length > this.timeTravelDepth) {
      const oldest = this.historySnapshots.shift()!;
      this.pool.releaseSnapshot(oldest);
    }
  }

  /** Range of transaction ids currently reachable via AS OF. */
  get timeTravelWindow(): { oldest: number; newest: number; depth: number } {
    return {
      oldest: this.historySnapshots[0] ?? -1,
      newest: this.historySnapshots[this.historySnapshots.length - 1] ?? -1,
      depth: this.timeTravelDepth,
    };
  }

  /** Abort the process without flushing (test/demo hook). */
  async simulateCrash(): Promise<void> {
    await this.wal.close();
    await this.pool.simulateCrash();
  }

  async close(): Promise<void> {
    await this.syncAll();
    await this.wal.truncate();
    await this.wal.close();
    await this.pool.close();
  }

  /** Execute a prepared statement; returns query result. */
  execute(statement: Statement, opts: { explain?: boolean; analyze?: boolean } = {}): Promise<QueryResult> {
    return this.defaultSession.execute(statement, opts);
  }
}

export { keyToString, compareKeys };