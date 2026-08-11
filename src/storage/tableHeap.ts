import { BufferPool } from "./bufferPool.js";
import { TablePage } from "./tablePage.js";

/**
 * A heap table: a doubly-linked chain of table pages starting at a header
 * page that tracks the first page, record count and the auto-increment cursor.
 */
export class TableHeap {
  readonly name: string;
  private headerPageId: number;
  private pool: BufferPool;
  private dirty = false;

  private static HEADER_RECORDS_OFFSET = 16;
  private static HEADER_NEXT_PAGE_OFFSET = 8;
  private static HEADER_AUTOINC_OFFSET = 20;
  private static HEADER_RID_SEQ_OFFSET = 24;

  constructor(name: string, headerPageId: number, pool: BufferPool) {
    this.name = name;
    this.headerPageId = headerPageId;
    this.pool = pool;
  }

  static async create(name: string, pool: BufferPool): Promise<TableHeap> {
    const header = await pool.createPage("table_header");
    const dv = new DataView(header.data.buffer, header.data.byteOffset, header.data.byteLength);
    dv.setUint32(0, header.id, true);
    dv.setUint8(4, 1); // table_header type
    dv.setUint16(8, 0, true); // next page = none
    dv.setUint32(16, 0, true); // record count
    dv.setUint32(20, 0, true); // autoinc cursor
    dv.setUint32(24, 0, true); // rid sequence (immutable record ids for indexes)
    await pool.unpin(header.id, true);
    return new TableHeap(name, header.id, pool);
  }

  static async open(name: string, headerPageId: number, pool: BufferPool): Promise<TableHeap> {
    return new TableHeap(name, headerPageId, pool);
  }

  get headerPage(): number {
    return this.headerPageId;
  }

  private async readHeader(snap?: number): Promise<{ firstPage: number; count: number; autoinc: number; ridSeq: number }> {
    const page = snap === undefined ? await this.pool.pin(this.headerPageId) : await this.pool.readSnapshot(this.headerPageId, snap);
    try {
      const dv = new DataView(page.data.buffer, page.data.byteOffset, page.data.byteLength);
      return {
        firstPage: dv.getUint16(8, true),
        count: dv.getUint32(16, true),
        autoinc: dv.getUint32(20, true),
        ridSeq: dv.getUint32(24, true),
      };
    } finally {
      if (snap === undefined) await this.pool.unpin(this.headerPageId, false);
    }
  }

  private async writeHeader(firstPage: number, count: number, autoinc: number, ridSeq: number): Promise<void> {
    const page = await this.pool.pin(this.headerPageId);
    try {
      const dv = new DataView(page.data.buffer, page.data.byteOffset, page.data.byteLength);
      dv.setUint16(8, firstPage, true);
      dv.setUint32(16, count, true);
      dv.setUint32(20, autoinc, true);
      dv.setUint32(24, ridSeq, true);
      this.dirty = true;
    } finally {
      await this.pool.unpin(this.headerPageId, true);
    }
  }

  async recordCount(): Promise<number> {
    const h = await this.readHeader();
    return h.count;
  }

  async nextAutoInc(): Promise<number> {
    const h = await this.readHeader();
    const v = h.autoinc + 1;
    await this.writeHeader(h.firstPage, h.count, v, h.ridSeq);
    return v;
  }

  /** Allocate the next immutable record id (used by indexes). */
  async nextRid(): Promise<number> {
    const h = await this.readHeader();
    const v = h.ridSeq + 1;
    await this.writeHeader(h.firstPage, h.count, h.autoinc, v);
    return v;
  }

  async append(record: Uint8Array): Promise<void> {
    const h = await this.readHeader();
    let pid = h.firstPage;
    let prevPid = 0;
    // walk to the last page
    if (pid !== 0) {
      for (;;) {
        const pg = await this.pool.pin(pid);
        const tp = new TablePage(pg);
        const next = tp.nextPage;
        if (next === 0) {
          const ok = tp.insert(record);
          await this.pool.unpin(pid, ok);
          if (ok) {
            await this.bumpCount(1);
            return;
          }
          prevPid = pid;
          pid = 0;
          break;
        }
        prevPid = pid;
        await this.pool.unpin(pid, false);
        pid = next;
      }
    } else {
      prevPid = 0;
    }
    // create new page
    const newPage = await this.pool.createPage("table_page");
    const tp = new TablePage(newPage);
    tp.initEmpty(0);
    const ok = tp.insert(record);
    if (!ok) throw new Error("Record too large for a page");
    // link
    if (prevPid !== 0) {
      const prev = await this.pool.pin(prevPid);
      new TablePage(prev).setNextPage(newPage.id);
      await this.pool.unpin(prevPid, true);
    } else {
      await this.writeHeader(newPage.id, h.count + 1, h.autoinc, h.ridSeq);
    }
    await this.pool.unpin(newPage.id, true);
    await this.bumpCount(1);
  }

  private async bumpCount(delta: number): Promise<void> {
    const h = await this.readHeader();
    await this.writeHeader(h.firstPage, h.count + delta, h.autoinc, h.ridSeq);
  }

  scan(snap?: number): AsyncIterable<{ pageId: number; index: number; rid: number; record: Uint8Array; delete: () => Promise<void> }> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const h = await self.readHeader(snap);
        let pid = h.firstPage;
        let rid = 0;
        while (pid !== 0) {
          const pg = snap === undefined ? await self.pool.pin(pid) : await self.pool.readSnapshot(pid, snap);
          const tp = new TablePage(pg);
          const next = tp.nextPage;
          const slots = tp.slots();
          for (let i = 0; i < slots.length; i++) {
            rid++;
            if (slots[i].length === 0) continue; // tombstoned
            const rec = pg.data.slice(slots[i].offset, slots[i].offset + slots[i].length);
            yield {
              pageId: pid,
              index: i,
              rid,
              record: rec,
              delete: async () => {
                const pg2 = await self.pool.pin(pid);
                const tp2 = new TablePage(pg2);
                tp2.delete(i);
                await self.pool.unpin(pid, true);
                await self.bumpCount(-1);
              },
            };
          }
          await self.pool.unpin(pid, false);
          pid = next;
        }
      },
    };
  }

  async getSlot(pageId: number, index: number, snap?: number): Promise<Uint8Array | null> {
    const pg = snap === undefined ? await this.pool.pin(pageId) : await this.pool.readSnapshot(pageId, snap);
    try {
      const tp = new TablePage(pg);
      const slots = tp.slots();
      if (index >= slots.length) return null;
      return pg.data.slice(slots[index].offset, slots[index].offset + slots[index].length);
    } finally {
      if (snap === undefined) await this.pool.unpin(pageId, false);
    }
  }

  async replaceSlot(pageId: number, index: number, record: Uint8Array): Promise<void> {
    const pg = await this.pool.pin(pageId);
    try {
      const tp = new TablePage(pg);
      const ok = tp.update(index, record);
      if (!ok) throw new Error("Record update did not fit; compaction needed");
    } finally {
      await this.pool.unpin(pageId, true);
    }
  }
}