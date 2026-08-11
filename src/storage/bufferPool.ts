import { DiskIO } from "./disk.js";
import { Page, PAGE_SIZE } from "./page.js";

export interface Frame {
  page: Page;
  dirty: boolean;
  clock: boolean;
  pin: number;
}

/**
 * A version-chain node. `data` holds the page state as it was BEFORE
 * `xnid`'s first write to the page (the pre-image).
 *
 * Chains are per-page arrays of nodes ordered OLDEST first (index 0) to
 * NEWEST last (the head). The head pre-image sits below the live in-memory
 * buffer: the frame's `page.data` always holds the tip (committed +
 * uncommitted).
 *
 * Visibility rule for a snapshot `S`:
 *   - visible = LIVE  iff  S >= head.xnid AND (head.xnid committed OR S == head.xnid)
 *   - else visible = data of the first node (from the head down) with xnid > S
 *   - else (no such node) visible = head.data
 *
 * At most ONE node per chain can be uncommitted, and it is always the head:
 * a write transaction that pins a page whose head is a *different*
 * uncommitted xid raises a write-conflict error (documented conservative
 * limitation; even read-only pins inside a write statement are affected).
 */
export interface ChainNode {
  xnid: number;
  data: Uint8Array;
}

/** Thrown when two write transactions touch the same page concurrently. */
export class WriteConflictError extends Error {
  constructor(pageId: number, xnid: number) {
    super(`MVCC write conflict on page ${pageId}: uncommitted changes by transaction ${xnid}`);
    this.name = "WriteConflictError";
  }
}

/** Buffer Pool with CLOCK(second-chance) replacement and MVCC version chains. */
export class BufferPool {
  private frames = new Map<number, Frame>();
  private chains = new Map<number, ChainNode[]>();
  private committed = new Set<number>();
  private activeSnapshots = new Set<number>();
  private disk: DiskIO;
  private capacity: number;
  private clockHand = 0;
  private nextPageId: number;
  private txnSeq = 0;
  private activeWriter: number | null = null;
  private writerPages = new Map<number, Set<number>>();

  /** stats for the visualization dashboard */
  readonly stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    writes: 0,
    totalPins: 0,
  };

  constructor(disk: DiskIO, capacity = 128) {
    this.disk = disk;
    this.capacity = capacity;
    this.nextPageId = 0;
  }

  /** sync the allocator's high-water mark with the disk (call before allocating). */
  async initAllocator(): Promise<void> {
    this.nextPageId = await this.disk.pageCount();
  }

  get size(): number {
    return this.frames.size;
  }

  get capacityValue(): number {
    return this.capacity;
  }

  hitRate(): number {
    const total = this.stats.hits + this.stats.misses;
    return total === 0 ? 1 : this.stats.hits / total;
  }

  /** Allocate a fresh transaction id. */
  nextXid(): number {
    return ++this.txnSeq;
  }

  /** Allocate a snapshot id and register it (optionally reuse an existing xid). */
  takeSnapshot(xid?: number): number {
    const id = xid ?? this.nextXid();
    this.activeSnapshots.add(id);
    return id;
  }

  releaseSnapshot(id: number): void {
    this.activeSnapshots.delete(id);
  }

  /** Start write tracking for a transaction (must pair with commitXid/rollbackXid). */
  beginWrite(xid: number): void {
    this.activeWriter = xid;
    if (!this.writerPages.has(xid)) this.writerPages.set(xid, new Set());
  }

  private endWrite(): void {
    this.activeWriter = null;
  }

  get activeWriterValue(): number | null {
    return this.activeWriter;
  }

  private minActiveSnapshot(): number {
    let min = Infinity;
    for (const s of this.activeSnapshots) if (s < min) min = s;
    return min;
  }

  private chainHead(pageId: number): ChainNode | undefined {
    const arr = this.chains.get(pageId);
    return arr && arr.length > 0 ? arr[arr.length - 1] : undefined;
  }

  /** Enforce the single-uncommitted-writer rule and record the pre-image. */
  private onWriterPin(pageId: number, live: Uint8Array): void {
    const writer = this.activeWriter!;
    const arr = this.chains.get(pageId);
    const head = arr && arr.length > 0 ? arr[arr.length - 1] : undefined;
    if (head && head.xnid !== writer && !this.committed.has(head.xnid)) {
      throw new WriteConflictError(pageId, head.xnid);
    }
    if (!head || head.xnid !== writer) {
      const chain = arr ?? [];
      chain.push({ xnid: writer, data: live.slice() });
      this.chains.set(pageId, chain);
      this.writerPages.get(writer)!.add(pageId);
    }
  }

  async pin(pageId: number): Promise<Page> {
    const existing = this.frames.get(pageId);
    if (existing) {
      existing.pin++;
      existing.clock = true;
      this.stats.hits++;
      if (this.activeWriter !== null) this.onWriterPin(pageId, existing.page.data);
      return existing.page;
    }
    this.stats.misses++;
    const raw = await this.disk.readPage(pageId);
    if (raw === null) {
      throw new Error(`Page ${pageId} does not exist on disk`);
    }
    const page: Page = { id: pageId, type: "free", data: raw };
    this.evictIfNeeded();
    const frame: Frame = { page, dirty: false, clock: true, pin: 1 };
    this.frames.set(pageId, frame);
    this.stats.totalPins++;
    if (this.activeWriter !== null) this.onWriterPin(pageId, raw);
    return page;
  }

  /** Allocate a new page (appends to the disk file). */
  async createPage(type: "table_page" | "btree_leaf" | "btree_internal" | "table_header" | "btree_meta"): Promise<Page> {
    const id = this.nextPageId++;
    const data = new Uint8Array(4096);
    const page: Page = { id, type, data };
    this.evictIfNeeded();
    this.frames.set(id, { page, dirty: true, clock: true, pin: 1 });
    this.stats.totalPins++;
    if (this.activeWriter !== null) {
      // a fresh page's pre-image is the empty page
      this.onWriterPin(id, new Uint8Array(PAGE_SIZE));
    }
    return page;
  }

  private evictIfNeeded(): void {
    let passes = 0;
    while (this.frames.size >= this.capacity) {
      if (passes++ > 64) break; // uncommitted dirty pages block eviction; allow over-capacity
      const ids = [...this.frames.keys()];
      if (ids.length === 0) return;
      const id = ids[this.clockHand % ids.length];
      this.clockHand++;
      const frame = this.frames.get(id)!;
      if (frame.pin > 0) continue;
      if (frame.clock) {
        frame.clock = false;
        continue;
      }
      const head = this.chainHead(id);
      if (head && !this.committed.has(head.xnid) && frame.dirty) continue; // uncommitted: keep in memory
      this.evict(id);
    }
  }

  private async evict(id: number): Promise<void> {
    const frame = this.frames.get(id)!;
    if (frame.dirty) {
      await this.disk.writePage(frame.page.id, frame.page.data);
      this.stats.writes++;
    }
    this.frames.delete(id);
    this.stats.evictions++;
  }

  async unpin(pageId: number, dirty: boolean): Promise<void> {
    const frame = this.frames.get(pageId);
    if (!frame) return;
    if (dirty) frame.dirty = true;
    frame.pin--;
    if (frame.pin < 0) frame.pin = 0;
  }

  async flushAll(): Promise<void> {
    for (const frame of this.frames.values()) {
      if (!frame.dirty) continue;
      const head = this.chainHead(frame.page.id);
      if (head && !this.committed.has(head.xnid)) continue; // never flush uncommitted changes
      await this.disk.writePage(frame.page.id, frame.page.data);
      frame.dirty = false;
      this.stats.writes++;
    }
    await this.disk.sync();
  }

  /** Force an eviction of a specific page even if pinned (used by tests). */
  async dropPage(pageId: number): Promise<void> {
    const frame = this.frames.get(pageId);
    if (!frame) return;
    if (frame.dirty) {
      const head = this.chainHead(pageId);
      if (head && !this.committed.has(head.xnid)) return; // uncommitted: keep in memory
      await this.disk.writePage(frame.page.id, frame.page.data);
      this.stats.writes++;
    }
    this.frames.delete(pageId);
  }

  async close(): Promise<void> {
    await this.flushAll();
    await this.disk.close();
  }

  // ================= MVCC =================

  /** Read a page as seen by snapshot `snap`. Returns an independent copy. */
  async readSnapshot(pageId: number, snap: number): Promise<Page> {
    const arr = this.chains.get(pageId);
    if (arr && arr.length > 0) {
      const head = arr[arr.length - 1];
      if (snap >= head.xnid && (this.committed.has(head.xnid) || snap === head.xnid)) {
        const live = await this.readLive(pageId);
        return live ? { id: pageId, type: live.type, data: live.data.slice() } : this.emptyPage(pageId);
      }
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].xnid > snap) {
          return { id: pageId, type: "free", data: arr[i].data.slice() };
        }
      }
      return { id: pageId, type: "free", data: head.data.slice() };
    }
    const live = await this.readLive(pageId);
    return live ? { id: pageId, type: live.type, data: live.data.slice() } : this.emptyPage(pageId);
  }

  private emptyPage(pageId: number): Page {
    return { id: pageId, type: "free", data: new Uint8Array(PAGE_SIZE) };
  }

  private async readLive(pageId: number): Promise<Page | null> {
    const frame = this.frames.get(pageId);
    if (frame) return frame.page;
    const raw = await this.disk.readPage(pageId);
    if (raw === null) return null;
    return { id: pageId, type: "free", data: raw };
  }

  /** Mark a transaction committed and garbage-collect now-obsolete chain nodes. */
  commitXid(xid: number): void {
    this.committed.add(xid);
    const pages = this.writerPages.get(xid);
    if (pages) {
      const minActive = this.minActiveSnapshot();
      for (const pageId of pages) this.gcChain(pageId, minActive);
      this.writerPages.delete(xid);
    }
    this.endWrite();
  }

  private gcChain(pageId: number, minActive: number): void {
    const arr = this.chains.get(pageId);
    if (!arr || arr.length === 0) return;
    // drop from the front (oldest) while no live snapshot can still need them
    while (arr.length > 0 && this.committed.has(arr[0].xnid) && arr[0].xnid <= minActive) {
      arr.shift();
    }
    if (arr.length === 0) this.chains.delete(pageId);
  }

  /**
   * Roll a transaction back: restore each page's pre-image and drop its
   * chain node. Only allowed while the transaction is the head of every
   * chain it touched; otherwise an error is thrown.
   */
  async rollbackXid(xid: number): Promise<void> {
    const pages = this.writerPages.get(xid) ?? new Set<number>();
    for (const pageId of pages) {
      const arr = this.chains.get(pageId);
      if (!arr || arr.length === 0) continue;
      const head = arr[arr.length - 1];
      if (head.xnid !== xid) {
        throw new Error(`Cannot roll back transaction ${xid}: page ${pageId} was modified by another transaction`);
      }
      const pre = head.data;
      arr.pop();
      if (arr.length === 0) this.chains.delete(pageId);
      const frame = this.frames.get(pageId);
      if (frame) {
        frame.page.data.set(pre);
        frame.dirty = true;
      }
    }
    this.writerPages.delete(xid);
    this.endWrite();
  }

  /** Chain length for a page (0 when none) — exposed for tests/debugging. */
  chainLength(pageId: number): number {
    return this.chains.get(pageId)?.length ?? 0;
  }

  get committedXids(): ReadonlySet<number> {
    return this.committed;
  }

  get activeSnapshotCount(): number {
    return this.activeSnapshots.size;
  }
}
