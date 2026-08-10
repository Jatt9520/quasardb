import { DiskIO } from "./disk.js";
import { Page } from "./page.js";

export interface Frame {
  page: Page;
  dirty: boolean;
  clock: boolean;
  pin: number;
}

/** Buffer Pool with CLOCK(second-chance) replacement. */
export class BufferPool {
  private frames = new Map<number, Frame>();
  private disk: DiskIO;
  private capacity: number;
  private clockHand = 0;
  private nextPageId: number;

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

  async pin(pageId: number): Promise<Page> {
    const existing = this.frames.get(pageId);
    if (existing) {
      existing.pin++;
      existing.clock = true;
      this.stats.hits++;
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
    return page;
  }

  private evictIfNeeded(): void {
    while (this.frames.size >= this.capacity) {
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
      if (frame.dirty) {
        await this.disk.writePage(frame.page.id, frame.page.data);
        frame.dirty = false;
        this.stats.writes++;
      }
    }
    await this.disk.sync();
  }

  /** Force an eviction of a specific page even if pinned (used by tests). */
  async dropPage(pageId: number): Promise<void> {
    const frame = this.frames.get(pageId);
    if (!frame) return;
    if (frame.dirty) {
      await this.disk.writePage(frame.page.id, frame.page.data);
      this.stats.writes++;
    }
    this.frames.delete(pageId);
  }

  async close(): Promise<void> {
    await this.flushAll();
    await this.disk.close();
  }
}