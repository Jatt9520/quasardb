import { BufferPool } from "../storage/bufferPool.js";
import { Catalog, CatalogData } from "../storage/catalog.js";
import { BtreeIndex, compareKeys, keyToString } from "../btree/btree.js";
import { TableHeap } from "../storage/tableHeap.js";
import { Statement } from "../sql/ast.js";
import { Value } from "../expr/value.js";
import { FileDisk } from "../storage/disk.js";
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
  private defaultSession: Session;

  private constructor(pool: BufferPool, catalog: Catalog) {
    this.pool = pool;
    this.catalog = catalog;
    this.loadState();
    this.defaultSession = new Session(this);
  }

  static async create(path: string): Promise<Engine> {
    const disk = await FileDisk.open(path);
    const pool = new BufferPool(disk, 512);
    await pool.initAllocator();
    const catalog = await Catalog.create(pool);
    const engine = new Engine(pool, catalog);
    await engine.commitCatalog();
    return engine;
  }

  static async open(path: string): Promise<Engine> {
    const disk = await FileDisk.open(path);
    const pool = new BufferPool(disk, 512);
    await pool.initAllocator();
    const catalog = await Catalog.open(pool);
    return new Engine(pool, catalog);
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

  async close(): Promise<void> {
    await this.syncAll();
  }

  /** Execute a prepared statement; returns query result. */
  execute(statement: Statement, opts: { explain?: boolean; analyze?: boolean } = {}): Promise<QueryResult> {
    return this.defaultSession.execute(statement, opts);
  }
}

export { keyToString, compareKeys };