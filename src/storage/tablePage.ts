import { BufferPool } from "./bufferPool.js";
import { PAGE_SIZE, Page } from "./page.js";

/** Header of a data page: slot count, free space offset, next page pointer. */
export const PAGE_HEADER_SIZE = 12; // bytes 8..11 reserved

/** On-logical-page layout:
 *  [0..3] page id      (used by page.setPageType)
 *  [4]    type marker  (used by page.setPageType)
 *  [5..7] reserved
 *  [8..11] next page id (linked list of overflow)
 *  [12]   slot count (u16)
 *  [14]   free offset (u16)
 *  [16..] slot array: [offset u16, length u16] per record
 *  then records packed at the end
 */

interface Slot {
  offset: number;
  length: number;
}

export interface TablePageView {
  page: Page;
  nextPage: number;
  setNextPage(n: number): void;
  slots(): Slot[];
  getRecord(index: number): Uint8Array;
  insert(record: Uint8Array): boolean;
  delete(index: number): void;
  update(index: number, record: Uint8Array): boolean;
  size(): number;
}

export function readU16(page: Page, off: number): number {
  const dv = new DataView(page.data.buffer, page.data.byteOffset, page.data.byteLength);
  return dv.getUint16(off, true);
}

export function writeU16(page: Page, off: number, v: number): void {
  const dv = new DataView(page.data.buffer, page.data.byteOffset, page.data.byteLength);
  dv.setUint16(off, v, true);
}

export class TablePage implements TablePageView {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  initEmpty(next: number): void {
    this.setNextPage(next);
    writeU16(this.page, 12, 0);
    writeU16(this.page, 14, PAGE_SIZE);
  }

  get nextPage(): number {
    return readU16(this.page, 8);
  }

  setNextPage(n: number): void {
    writeU16(this.page, 8, n);
  }

  slotCount(): number {
    return readU16(this.page, 12);
  }

  freeOffset(): number {
    return readU16(this.page, 14);
  }

  private slotOffsetOf(index: number): number {
    return 16 + index * 4;
  }

  slots(): Slot[] {
    const n = this.slotCount();
    const out: Slot[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        offset: readU16(this.page, this.slotOffsetOf(i)),
        length: readU16(this.page, this.slotOffsetOf(i) + 2),
      });
    }
    return out;
  }

  getRecord(index: number): Uint8Array {
    const s = this.slots()[index];
    return this.page.data.slice(s.offset, s.offset + s.length);
  }

  size(): number {
    let total = 0;
    for (const s of this.slots()) total += s.length;
    return total;
  }

  insert(record: Uint8Array): boolean {
    const n = this.slotCount();
    const free = this.freeOffset();
    const neededHead = 4 + (16 + n * 4); // record + slot entry
    const available = free - (16 + n * 4);
    if (record.length > available) return false;
    const slotOff = this.slotOffsetOf(n);
    const recOff = free - record.length;
    this.page.data.set(record, recOff);
    writeU16(this.page, slotOff, recOff);
    writeU16(this.page, slotOff + 2, record.length);
    writeU16(this.page, 12, n + 1);
    writeU16(this.page, 14, recOff);
    return true;
  }

  delete(index: number): void {
    const n = this.slotCount();
    if (index >= n) return;
    const slots = this.slots();
    const s = slots[index];
    // swap-last deletion to keep the array compact
    if (index !== n - 1) {
      const last = slots[n - 1];
      writeU16(this.page, this.slotOffsetOf(index), last.offset);
      writeU16(this.page, this.slotOffsetOf(index) + 2, last.length);
    }
    writeU16(this.page, 12, n - 1);
    void s;
  }

  update(index: number, record: Uint8Array): boolean {
    const s = this.slots()[index];
    const n = this.slotCount();
    if (record.length <= s.length) {
      this.page.data.set(record, s.offset);
      writeU16(this.page, this.slotOffsetOf(index) + 2, record.length);
      return true;
    }
    // need to re-insert: mark old as free and place at the end
    const available = this.freeOffset() - (16 + n * 4);
    if (record.length > available) {
      // attempt compact after freeing old slot space
      this.compact();
      return false;
    }
    // place record at the new free position, update slot
    const free = this.freeOffset();
    const recOff = free - record.length;
    this.page.data.set(record, recOff);
    writeU16(this.page, this.slotOffsetOf(index), recOff);
    writeU16(this.page, this.slotOffsetOf(index) + 2, record.length);
    writeU16(this.page, 14, recOff);
    return true;
  }

  /** compact records to reclaim space (called by table when page fills) */
  compact(): void {
    const slots = this.slots();
    if (slots.length === 0) {
      writeU16(this.page, 14, PAGE_SIZE);
      return;
    }
    const tmp = new Uint8Array(PAGE_SIZE);
    // rebuild records stacked at the end
    let cursor = PAGE_SIZE;
    for (let i = slots.length - 1; i >= 0; i--) {
      const recStart = cursor - slots[i].length;
      tmp.set(this.page.data.slice(slots[i].offset, slots[i].offset + slots[i].length), recStart);
      // slot array lives in the same buffer: rewrite slots below the header
      writeU16(this.page, this.slotOffsetOf(i), recStart);
      cursor = recStart;
    }
    // copy back
    const copy = tmp.slice();
    this.page.data.set(copy, 0);
    writeU16(this.page, 14, cursor);
  }
}