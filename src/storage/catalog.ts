import { BufferPool } from "./bufferPool.js";
import { PAGE_SIZE } from "./page.js";
import { SqlType } from "../sql/ast.js";

export interface TableMeta {
  name: string;
  headerPageId: number;
  columns: { name: string; type: SqlType; primaryKey: boolean; unique: boolean; notNull: boolean; autoIncrement: boolean }[];
  primaryKey: string | null;
}

export interface IndexMeta {
  name: string;
  table: string;
  columns: string[];
  metaPageId: number;
  unique: boolean;
}

export interface CatalogData {
  tables: TableMeta[];
  indexes: IndexMeta[];
}

/**
 * The catalog is a JSON document kept in a chain of catalog pages starting
 * at page 0. It is the source of truth for schema; data lives in heap pages
 * and B+ tree pages referenced by ids stored here.
 */
export class Catalog {
  private pool: BufferPool;
  private catalogPages: number[];
  private data: CatalogData;

  private constructor(pool: BufferPool, catalogPages: number[], data: CatalogData) {
    this.pool = pool;
    this.catalogPages = catalogPages;
    this.data = data;
  }

  /** Initialize a fresh database: page 0 is the first catalog page. */
  static async create(pool: BufferPool): Promise<Catalog> {
    const p0 = await pool.createPage("table_header");
    // page 0: catalog page 0
    void p0;
    await pool.unpin(p0.id, true);
    const catalog = new Catalog(pool, [0], { tables: [], indexes: [] });
    await catalog.persist();
    return catalog;
  }

  static async open(pool: BufferPool): Promise<Catalog> {
    const p0 = await pool.pin(0);
    const pages: number[] = [];
    let next = 0;
    let tries = 0;
    await pool.unpin(0, false);
    // read chain of catalog pages
    for (;;) {
      const p = await pool.pin(next);
      const dv = new DataView(p.data.buffer, p.data.byteOffset, p.data.byteLength);
      const nxt = dv.getUint32(8, true);
      pages.push(next);
      const end = dv.getUint32(12, true); // byte length of payload
      const hasMore = nxt !== 0;
      void end;
      await pool.unpin(next, false);
      if (!hasMore) break;
      if (++tries > 10000) throw new Error("Catalog page chain is corrupted");
      next = nxt;
    }
    const json = await Catalog.readPages(pool, pages);
    let data: CatalogData;
    try {
      data = JSON.parse(json) as CatalogData;
      if (!Array.isArray(data.tables)) throw new Error("bad catalog");
    } catch (e) {
      throw new Error(`Catalog is corrupt: ${(e as Error).message}`);
    }
    return new Catalog(pool, pages, data);
  }

  private static async readPages(pool: BufferPool, pages: number[]): Promise<string> {
    let json = "";
    for (const id of pages) {
      const p = await pool.pin(id);
      const dv = new DataView(p.data.buffer, p.data.byteOffset, p.data.byteLength);
      const start = dv.getUint32(12, true) === 0 && id !== 0 ? 16 : 16;
      // payload starts at offset 16
      const dec = new TextDecoder();
      let data = dec.decode(p.data.subarray(16));
      data = data.slice(0, data.indexOf("\u0000") === -1 ? data.length : data.indexOf("\u0000"));
      json += data;
      await pool.unpin(id, false);
    }
    return json;
  }

  private static PAGE_PAYLOAD = PAGE_SIZE - 16;
  private static PAGE_CONTINUE_MARKER = 1;

  async persist(): Promise<void> {
    const json = JSON.stringify(this.data);
    // dynamically grow catalog pages
    const needed = Math.ceil(json.length / Catalog.PAGE_PAYLOAD);
    while (this.catalogPages.length < needed) {
      const np = await this.pool.createPage("table_header");
      this.catalogPages.push(np.id);
    }
    const bytes = new TextEncoder().encode(json);
    for (let i = 0; i < this.catalogPages.length; i++) {
      const id = this.catalogPages[i];
      const p = await this.pool.pin(id);
      try {
        const dv = new DataView(p.data.buffer, p.data.byteOffset, p.data.byteLength);
        dv.setUint32(0, id, true);
        dv.setUint8(4, 1);
        dv.setUint32(8, i + 1 < needed ? this.catalogPages[i + 1] : 0, true);
        const start = i * Catalog.PAGE_PAYLOAD;
        const chunk = bytes.slice(start, start + Catalog.PAGE_PAYLOAD);
        p.data.fill(0, 16);
        p.data.set(chunk, 16);
        dv.setUint32(12, chunk.length, true);
      } finally {
        await this.pool.unpin(id, true);
      }
    }
    // zero out trailing catalog pages that are no longer needed
    if (this.catalogPages.length > needed) {
      for (let i = needed - 1; i < this.catalogPages.length; i++) {
        const id = this.catalogPages[i];
        const p = await this.pool.pin(id);
        try {
          p.data.fill(0, 8);
          const dv = new DataView(p.data.buffer, p.data.byteOffset, p.data.byteLength);
          dv.setUint32(12, 0, true);
        } finally {
          await this.pool.unpin(id, true);
        }
      }
    }
  }

  get dataValue(): CatalogData {
    return this.data;
  }

  addTable(meta: TableMeta): void {
    this.data.tables.push(meta);
  }

  dropTable(name: string): void {
    this.data.tables = this.data.tables.filter((t) => t.name.toLowerCase() !== name.toLowerCase());
    this.data.indexes = this.data.indexes.filter((i) => i.table.toLowerCase() !== name.toLowerCase());
  }

  getTable(name: string): TableMeta | undefined {
    return this.data.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
  }

  getIndex(name: string): IndexMeta | undefined {
    return this.data.indexes.find((i) => i.name.toLowerCase() === name.toLowerCase());
  }

  indexesFor(table: string): IndexMeta[] {
    return this.data.indexes.filter((i) => i.table.toLowerCase() === table.toLowerCase());
  }

  addIndex(meta: IndexMeta): void {
    this.data.indexes.push(meta);
  }

  dropIndex(name: string): void {
    this.data.indexes = this.data.indexes.filter((i) => i.name.toLowerCase() !== name.toLowerCase());
  }
}