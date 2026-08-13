import { BufferPool } from "../storage/bufferPool.js";
import { PAGE_SIZE, Page } from "../storage/page.js";

// ========================= B+ tree on-disk page layout =========================
// [0..3]    page id
// [4]       type marker (4=leaf, 5=internal)
// [5..7]    reserved
// [8..9]    is_leaf (1/0)
// [10..11]  key count (n)
// [12..13]  leaf: next leaf page id  │  internal: leftmost child lo half
// [14..15]  internal: leftmost child hi half (leaf: 0)
// [16..17]  free space start (records grow downward from page end)
// [18..]    entries: { keyPtr u32, keyLen u32, then value u32 after key bytes }

export const BTREE_HEADER = 18;
export const BTREE_FREE_PTR_OFF = 16;

export type CompareFn = (a: Uint8Array, b: Uint8Array) => number;

// ---------------- key encoding ----------------
// byte 0: tag — 0: null, 1: i64, 2: f64, 3: string (8-byte BE length prefix),
//             4: bool, 5: composite (multi-part key)
const TAG_NULL = 0;
const TAG_INT = 1;
const TAG_FLOAT = 2;
const TAG_STRING = 3;
const TAG_BOOL = 4;
const TAG_COMPOSITE = 5;

const enc = new TextEncoder();

export function encodeKeyString(s: string): Uint8Array {
  const bytes = enc.encode(s);
  const out = new Uint8Array(1 + 8 + bytes.length);
  out[0] = TAG_STRING;
  new DataView(out.buffer).setBigUint64(1, BigInt(bytes.length), false);
  out.set(bytes, 9);
  return out;
}

export function encodeKeyNumber(n: number): Uint8Array {
  const out = new Uint8Array(9);
  if (Number.isInteger(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) {
    out[0] = TAG_INT;
    new DataView(out.buffer).setBigInt64(1, BigInt(n), false);
  } else {
    out[0] = TAG_FLOAT;
    new DataView(out.buffer).setFloat64(1, n, false);
  }
  return out;
}

export function encodeKeyBoolean(b: boolean): Uint8Array {
  const out = new Uint8Array(9);
  out[0] = TAG_BOOL;
  out[1] = b ? 1 : 0;
  return out;
}

export function encodeKeyNull(): Uint8Array {
  return new Uint8Array(9);
}

/** Encode a runtime value according to a column type ("int"|"real"|"text"|"boolean"). */
export function encodeTypedKey(v: number | string | boolean | null, type: string): Uint8Array {
  if (v === null) return encodeKeyNull();
  switch (type) {
    case "boolean":
      return encodeKeyBoolean(v as boolean);
    case "text":
      return encodeKeyString(String(v));
    default:
      return encodeKeyNumber(Number(v));
  }
}

/** Composite key: concatenation of typed parts, each 4-byte-length prefixed. */
export function encodeCompositeKey(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += 4 + p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    new DataView(out.buffer, out.byteOffset + off, 8).setUint32(0, p.length, true);
    off += 4;
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Decode a single typed key back to its runtime value. */
export function decodeTypedKey(bytes: Uint8Array): number | string | boolean | null {
  if (bytes.length === 0) return null;
  const tag = bytes[0];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (tag) {
    case TAG_NULL:
      return null;
    case TAG_INT:
      return Number(dv.getBigInt64(1, false));
    case TAG_FLOAT:
      return dv.getFloat64(1, false);
    case TAG_STRING: {
      const len = Number(dv.getBigUint64(1, false));
      return new TextDecoder().decode(bytes.subarray(9, 9 + len));
    }
    case TAG_BOOL:
      return bytes[1] !== 0;
    default:
      return null;
  }
}

/** Split a composite key into its typed parts. */
export function decodeCompositeKeyParts(c: Uint8Array): (number | string | boolean | null)[] {
  const out: (number | string | boolean | null)[] = [];
  let off = 0;
  while (off < c.length) {
    const len = new DataView(c.buffer, c.byteOffset + off, 8).getUint32(0, true);
    off += 4;
    out.push(decodeTypedKey(c.subarray(off, off + len)));
    off += len;
  }
  return out;
}

export function compositeKeyToString(c: Uint8Array): string {
  const parts: string[] = [];
  let off = 0;
  while (off < c.length) {
    const len = new DataView(c.buffer, c.byteOffset + off, 8).getUint32(0, true);
    off += 4;
    parts.push(keyToString(c.subarray(off, off + len)));
    off += len;
  }
  return parts.join(" ");
}

function compareSimple(a: Uint8Array, b: Uint8Array): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  switch (a[0]) {
    case TAG_NULL:
      return 0;
    case TAG_BOOL:
      return a[1] === b[1] ? 0 : a[1] < b[1] ? -1 : 1;
    case TAG_INT:
    case TAG_FLOAT: {
      const ai = new DataView(a.buffer, a.byteOffset, a.byteLength).getBigInt64(1, false);
      const bi = new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(1, false);
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    }
    case TAG_STRING: {
      const la = a.length - 9;
      const lb = b.length - 9;
      const n = Math.min(la, lb);
      for (let i = 0; i < n; i++) {
        if (a[9 + i] !== b[9 + i]) return a[9 + i] < b[9 + i] ? -1 : 1;
      }
      return la < lb ? -1 : la > lb ? 1 : 0;
    }
    default:
      return 0;
  }
}

/** Compare composite keys part by part. */
function compareComposite(a: Uint8Array, b: Uint8Array): number {
  let oa = 0;
  let ob = 0;
  for (;;) {
    const moreA = oa < a.length;
    const moreB = ob < b.length;
    if (!moreA && !moreB) return 0;
    if (!moreA) return -1;
    if (!moreB) return 1;
    const la = new DataView(a.buffer, a.byteOffset + oa, 8).getUint32(0, true);
    const lb = new DataView(b.buffer, b.byteOffset + ob, 8).getUint32(0, true);
    const partA = a.subarray(oa + 4, oa + 4 + la);
    const partB = b.subarray(ob + 4, ob + 4 + lb);
    const c = compareSimple(partA, partB);
    if (c !== 0) return c;
    oa += 4 + la;
    ob += 4 + lb;
  }
}

export function compareKeys(a: Uint8Array, b: Uint8Array): number {
  // A composite key is a sequence of length-prefixed typed parts; its first
  // byte is the length prefix of part 0 (always >= 9), whereas typed keys
  // start with a tag byte in 0..4 — so byte0 > 4 identifies composites.
  if (a[0] > 4 || b[0] > 4) {
    return compareComposite(a, b);
  }
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  switch (a[0]) {
    case TAG_NULL:
      return 0;
    case TAG_BOOL:
      return a[1] === b[1] ? 0 : a[1] < b[1] ? -1 : 1;
    case TAG_INT:
    case TAG_FLOAT: {
      const ai = new DataView(a.buffer, a.byteOffset, a.byteLength).getBigInt64(1, false);
      const bi = new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(1, false);
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    }
    case TAG_STRING: {
      const la = a.length - 9;
      const lb = b.length - 9;
      const n = Math.min(la, lb);
      for (let i = 0; i < n; i++) {
        if (a[9 + i] !== b[9 + i]) return a[9 + i] < b[9 + i] ? -1 : 1;
      }
      return la < lb ? -1 : la > lb ? 1 : 0;
    }
    default:
      return 0;
  }
}

export function keyToString(k: Uint8Array): string {
  switch (k[0]) {
    case TAG_NULL:
      return "NULL";
    case TAG_BOOL:
      return k[1] === 1 ? "true" : "false";
    case TAG_INT: {
      const bi = new DataView(k.buffer, k.byteOffset).getBigInt64(1, false);
      return bi <= BigInt(Number.MAX_SAFE_INTEGER) && bi >= BigInt(Number.MIN_SAFE_INTEGER)
        ? String(Number(bi))
        : bi.toString();
    }
    case TAG_FLOAT: {
      const f = new DataView(k.buffer, k.byteOffset).getFloat64(1, false);
      return String(f);
    }
    case TAG_STRING:
      return new TextDecoder().decode(k.slice(9));
    default:
      return k[0] > 4 ? compositeKeyToString(k) : "?";
  }
}

// ---------------- metadata page ----------------
export class BtreeMeta {
  readonly page: Page;
  constructor(metaPage: Page) {
    this.page = metaPage;
  }

  private dv(): DataView {
    return new DataView(this.page.data.buffer, this.page.data.byteOffset, this.page.data.byteLength);
  }

  get root(): number {
    return this.dv().getUint16(8, true);
  }
  setRoot(r: number): void {
    this.dv().setUint16(8, r, true);
  }
  get count(): number {
    return this.dv().getUint32(16, true);
  }
  setCount(c: number): void {
    this.dv().setUint32(16, c, true);
  }
  get order(): number {
    return this.dv().getUint16(20, true);
  }
  setOrder(o: number): void {
    this.dv().setUint16(20, o, true);
  }
}

export interface BtreeSnapshot {
  kind: "leaf" | "internal";
  pageId: number;
  keys: string[];
  values: number[];
  nextLeaf: number;
  parent: number;
  leftmostChild: number;
}

export interface BtreeEntry {
  key: Uint8Array;
  keyText: string;
  value: number;
}

interface SplitResult {
  splitKey: BtreeEntry;
  rightNode: number;
}

interface InsertOutcome {
  split?: SplitResult;
  added: boolean;
}

/**
 * A B+ tree stored across disk pages.
 *   leaves:    entries (key -> row id); siblings linked by next-leaf pointer.
 *   internals: entries (key -> child page id); the child covering keys strictly
 *              below the first key lives in a leftmostChild slot. Entry i's
 *              value is the child whose key range starts at entry i's key.
 */
export class BtreeIndex {
  readonly name: string;
  readonly table: string;
  readonly columns: string[];
  readonly unique: boolean;
  private metaPageId: number;
  private pool: BufferPool;

  constructor(name: string, table: string, columns: string[], metaPageId: number, pool: BufferPool, unique: boolean) {
    this.name = name;
    this.table = table;
    this.columns = columns;
    this.metaPageId = metaPageId;
    this.pool = pool;
    this.unique = unique;
  }

  static async create(name: string, table: string, columns: string[], pool: BufferPool, unique: boolean): Promise<BtreeIndex> {
    const metaPage = await pool.createPage("btree_meta");
    const dv = new DataView(metaPage.data.buffer, metaPage.data.byteOffset, metaPage.data.byteLength);
    dv.setUint32(0, metaPage.id, true);
    dv.setUint8(4, 3);
    dv.setUint16(8, 0, true); // no root yet
    dv.setUint32(16, 0, true); // count 0
    dv.setUint16(20, 192, true); // order (max entries per node)
    await pool.unpin(metaPage.id, true);
    return new BtreeIndex(name, table, columns, metaPage.id, pool, unique);
  }

  static async open(name: string, table: string, columns: string[], metaPageId: number, pool: BufferPool, unique: boolean): Promise<BtreeIndex> {
    await pool.pin(metaPageId);
    await pool.unpin(metaPageId, false);
    return new BtreeIndex(name, table, columns, metaPageId, pool, unique);
  }

  get metaPageIdValue(): number {
    return this.metaPageId;
  }

  get orderValue(): Promise<number> {
    return this.readMeta().then((m) => m.order);
  }

  private async readMeta(snap?: number): Promise<BtreeMeta> {
    const page = snap === undefined ? await this.pool.pin(this.metaPageId) : await this.pool.readSnapshot(this.metaPageId, snap);
    const m = new BtreeMeta(page);
    if (snap === undefined) await this.pool.unpin(this.metaPageId, false);
    return m;
  }

  private async mutateMeta(fn: (m: BtreeMeta) => void): Promise<void> {
    const page = await this.pool.pin(this.metaPageId);
    const m = new BtreeMeta(page);
    fn(m);
    await this.pool.unpin(this.metaPageId, true);
  }

  async rootPage(snap?: number): Promise<number> {
    return (await this.readMeta(snap)).root;
  }

  async size(): Promise<number> {
    return (await this.readMeta()).count;
  }

  // ---------------- node low-level helpers ----------------
  private static u16(page: Page, off: number): number {
    return new DataView(page.data.buffer, page.data.byteOffset, page.data.byteLength).getUint16(off, true);
  }
  private static setU16(page: Page, off: number, v: number): void {
    new DataView(page.data.buffer, page.data.byteOffset, page.data.byteLength).setUint16(off, v, true);
  }
  private static u32(page: Page, off: number): number {
    return new DataView(page.data.buffer, page.data.byteOffset, page.data.byteLength).getUint32(off, true);
  }
  private static setU32(page: Page, off: number, v: number): void {
    new DataView(page.data.buffer, page.data.byteOffset, page.data.byteLength).setUint32(off, v, true);
  }
  private static setU8(page: Page, off: number, v: number): void {
    new DataView(page.data.buffer, page.data.byteOffset, page.data.byteLength).setUint8(off, v);
  }

  private isLeaf(page: Page): boolean {
    return BtreeIndex.u16(page, 8) === 1;
  }
  private setIsLeaf(page: Page, v: boolean): void {
    BtreeIndex.setU16(page, 8, v ? 1 : 0);
  }
  private keyCount(page: Page): number {
    return BtreeIndex.u16(page, 10);
  }
  private setKeyCount(page: Page, n: number): void {
    BtreeIndex.setU16(page, 10, n);
  }
  private nextLeafOf(page: Page): number {
    return this.isLeaf(page) ? BtreeIndex.u16(page, 12) : 0;
  }
  private setNextLeaf(page: Page, n: number): void {
    BtreeIndex.setU16(page, 12, n);
  }
  private leftmostChildOf(page: Page): number {
    return this.isLeaf(page) ? 0 : BtreeIndex.u32(page, 12);
  }
  private setLeftmostChild(page: Page, n: number): void {
    BtreeIndex.setU32(page, 12, n);
  }
  private freeStart(page: Page): number {
    return BtreeIndex.u16(page, BTREE_FREE_PTR_OFF) || PAGE_SIZE;
  }
  private setFreeStart(page: Page, v: number): void {
    BtreeIndex.setU16(page, BTREE_FREE_PTR_OFF, v);
  }

  private initNode(page: Page, leaf: boolean): void {
    this.setIsLeaf(page, leaf);
    this.setKeyCount(page, 0);
    this.setNextLeaf(page, 0);
    this.setLeftmostChild(page, 0);
    this.setFreeStart(page, PAGE_SIZE);
    BtreeIndex.setU8(page, 4, leaf ? 4 : 5);
  }

  private entryPtr(i: number): number {
    return BTREE_HEADER + i * 8;
  }

  private readEntry(page: Page, i: number): BtreeEntry {
    const dv = new DataView(page.data.buffer, page.data.byteOffset, page.data.byteLength);
    const off = this.entryPtr(i);
    const ptr = dv.getUint32(off, true);
    const len = dv.getUint32(off + 4, true);
    const key = page.data.slice(ptr, ptr + len);
    const value = dv.getUint32(ptr + len, true);
    return { key, keyText: keyToString(key), value };
  }

  private writeEntry(page: Page, i: number, key: Uint8Array, value: number): void {
    const dv = new DataView(page.data.buffer, page.data.byteOffset, page.data.byteLength);
    const need = key.length + 4;
    const free = this.freeStart(page);
    const target = free - need;
    if (target <= this.entryPtr(this.keyCount(page))) {
      throw new Error(`B+ tree node full (need ${need} bytes)`);
    }
    this.setFreeStart(page, target);
    page.data.set(key, target);
    dv.setUint32(target + key.length, value, true);
    const off = this.entryPtr(i);
    dv.setUint32(off, target, true);
    dv.setUint32(off + 4, key.length, true);
  }

  private copyEntry(page: Page, from: number, to: number): void {
    const dv = new DataView(page.data.buffer, page.data.byteOffset, page.data.byteLength);
    const f = this.entryPtr(from);
    const t = this.entryPtr(to);
    dv.setUint32(t, dv.getUint32(f, true), true);
    dv.setUint32(t + 4, dv.getUint32(f + 4, true), true);
  }

  private removeEntry(page: Page, index: number): void {
    const n = this.keyCount(page);
    for (let i = index; i < n - 1; i++) this.copyEntry(page, i + 1, i);
    this.setKeyCount(page, n - 1);
  }

  /** index of the first entry whose key >= target */
  private lowerBound(page: Page, key: Uint8Array): number {
    const n = this.keyCount(page);
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareKeys(this.readEntry(page, mid).key, key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Route a key to a child of an internal node.
   *   key < entries[0].key            → leftmostChild
   *   entries[i].key <= key < entries[i+1].key → entries[i].value
   *   key >= entries[n-1].key         → entries[n-1].value
   */
  private childOf(page: Page, key: Uint8Array): number {
    const n = this.keyCount(page);
    if (n === 0) return this.leftmostChildOf(page);
    const idx = this.lowerBound(page, key);
    if (idx === 0) {
      // key == entries[0].key routes to entries[0].value; strictly smaller
      // keys go to leftmostChild
      const e0 = this.readEntry(page, 0);
      return compareKeys(e0.key, key) === 0 ? e0.value : this.leftmostChildOf(page);
    }
    if (idx < n) {
      const e = this.readEntry(page, idx);
      if (compareKeys(e.key, key) === 0) return e.value;
      return this.readEntry(page, idx - 1).value;
    }
    return this.readEntry(page, n - 1).value;
  }

  // ---------------- insert ----------------
  /** Insert an entry; unique trees reject duplicate keys. */
  async insert(key: Uint8Array, value: number): Promise<boolean> {
    const root = await this.rootPage();
    if (root === 0) {
      const leaf = await this.pool.createPage("btree_leaf");
      this.initNode(leaf, true);
      this.writeEntry(leaf, 0, key, value);
      this.setKeyCount(leaf, 1);
      await this.pool.unpin(leaf.id, true);
      await this.mutateMeta((m) => {
        m.setRoot(leaf.id);
        m.setCount(m.count + 1);
      });
      return true;
    }
    const outcome = await this.insertRecursive(root, key, value);
    if (outcome.added) {
      await this.mutateMeta((m) => m.setCount(m.count + 1));
    }
    if (outcome.split) {
      const oldRoot = await this.rootPage();
      const newRoot = await this.pool.createPage("btree_internal");
      this.initNode(newRoot, false);
      this.setLeftmostChild(newRoot, oldRoot);
      this.writeEntry(newRoot, 0, outcome.split.splitKey.key, outcome.split.rightNode);
      this.setKeyCount(newRoot, 1);
      await this.pool.unpin(newRoot.id, true);
      await this.mutateMeta((m) => m.setRoot(newRoot.id));
    }
    return true;
  }

  /** Recursive insert; reports whether a new entry was added and splits. */
  private async insertRecursive(pageId: number, key: Uint8Array, value: number): Promise<InsertOutcome> {
    const page = await this.pool.pin(pageId);
    try {
      let added = false;
      if (this.isLeaf(page)) {
        const idx = this.lowerBound(page, key);
        if (idx < this.keyCount(page)) {
          const existing = this.readEntry(page, idx);
          if (compareKeys(existing.key, key) === 0) {
            if (this.unique) {
              throw new Error(`UNIQUE constraint failed: duplicate key ${existing.keyText}`);
            }
            this.overwriteValue(page, idx, value);
            return { added: false };
          }
        }
        this.insertAt(page, idx, key, value);
        added = true;
      } else {
        const childId = this.childOf(page, key);
        if (childId === 0) throw new Error("B+ tree: internal node without children");
        const childOutcome = await this.insertRecursive(childId, key, value);
        added = childOutcome.added;
        if (childOutcome.split) {
          const pos = this.lowerBound(page, childOutcome.split.splitKey.key);
          this.insertAt(page, pos, childOutcome.split.splitKey.key, childOutcome.split.rightNode);
        }
      }

      const order = (await this.readMeta()).order;
      if (this.keyCount(page) > order) {
        return { split: await this.splitNode(page), added };
      }
      return { added };
    } finally {
      await this.pool.unpin(pageId, true);
    }
  }

  private insertAt(page: Page, index: number, key: Uint8Array, value: number): void {
    const n = this.keyCount(page);
    for (let i = n; i > index; i--) this.copyEntry(page, i - 1, i);
    this.writeEntry(page, index, key, value);
    this.setKeyCount(page, n + 1);
  }

  private overwriteValue(page: Page, index: number, value: number): void {
    const dv = new DataView(page.data.buffer, page.data.byteOffset, page.data.byteLength);
    const off = this.entryPtr(index);
    const ptr = dv.getUint32(off, true);
    const len = dv.getUint32(off + 4, true);
    dv.setUint32(ptr + len, value, true);
  }

  /**
   * Split a full node in half.
   *   leaf:     left keeps [0..mid), right takes [mid..n); a sibling link is
   *             established and splitKey = entry[mid] is raised to the parent.
   *   internal: left keeps [0..mid), right takes [mid+1..n) and its
   *             leftmostChild = entry[mid].value; splitKey = entry[mid].
   */
  private async splitNode(page: Page): Promise<SplitResult> {
    const n = this.keyCount(page);
    const mid = Math.floor(n / 2);
    const splitKey = this.readEntry(page, mid);

    const right = await this.pool.createPage(this.isLeaf(page) ? "btree_leaf" : "btree_internal");
    this.initNode(right, this.isLeaf(page));

    if (this.isLeaf(page)) {
      for (let i = mid; i < n; i++) {
        const e = this.readEntry(page, i);
        this.writeEntry(right, i - mid, e.key, e.value);
      }
      this.setKeyCount(right, n - mid);
      this.setKeyCount(page, mid);
      this.setNextLeaf(right, this.nextLeafOf(page));
      this.setNextLeaf(page, right.id);
    } else {
      for (let i = mid + 1; i < n; i++) {
        const e = this.readEntry(page, i);
        this.writeEntry(right, i - mid - 1, e.key, e.value);
      }
      this.setKeyCount(right, n - mid - 1);
      this.setLeftmostChild(right, splitKey.value);
      this.setKeyCount(page, mid);
    }
    await this.pool.unpin(right.id, true);
    return { splitKey, rightNode: right.id };
  }

  // ---------------- find ----------------
  async find(key: Uint8Array, snap?: number): Promise<{ found: boolean; value: number }> {
    const root = await this.rootPage(snap);
    if (root === 0) return { found: false, value: 0 };
    let current = root;
    for (;;) {
      const page = snap === undefined ? await this.pool.pin(current) : await this.pool.readSnapshot(current, snap);
      if (this.isLeaf(page)) {
        const idx = this.lowerBound(page, key);
        if (idx < this.keyCount(page) && compareKeys(this.readEntry(page, idx).key, key) === 0) {
          const v = this.readEntry(page, idx).value;
          if (snap === undefined) await this.pool.unpin(current, false);
          return { found: true, value: v };
        }
        if (snap === undefined) await this.pool.unpin(current, false);
        return { found: false, value: 0 };
      }
      const child = this.childOf(page, key);
      if (snap === undefined) await this.pool.unpin(current, false);
      if (child === 0) return { found: false, value: 0 };
      current = child;
    }
  }

  // ---------------- range scan ----------------
  /** Visit entries with key in [start, end); null = unbounded. */
  async *scanRange(start: Uint8Array | null, end: Uint8Array | null, snap?: number): AsyncGenerator<BtreeEntry & { pageId: number }> {
    const root = await this.rootPage(snap);
    if (root === 0) return;
    let leafId = await this.findLeaf(root, start, snap);
    while (leafId !== 0) {
      const leaf = snap === undefined ? await this.pool.pin(leafId) : await this.pool.readSnapshot(leafId, snap);
      const n = this.keyCount(leaf);
      const from = start === null ? 0 : this.lowerBound(leaf, start);
      for (let i = from; i < n; i++) {
        const e = this.readEntry(leaf, i);
        if (end !== null && compareKeys(e.key, end) >= 0) {
          if (snap === undefined) await this.pool.unpin(leafId, false);
          return;
        }
        yield { ...e, pageId: leafId };
      }
      const next = this.nextLeafOf(leaf);
      if (snap === undefined) await this.pool.unpin(leafId, false);
      leafId = next;
    }
  }

  /** Visit all entries ascending. */
  async *scanAll(snap?: number): AsyncGenerator<BtreeEntry & { pageId: number }> {
    yield* this.scanRange(null, null, snap);
  }

  private async findLeaf(pageId: number, key: Uint8Array | null, snap?: number): Promise<number> {
    for (;;) {
      const page = snap === undefined ? await this.pool.pin(pageId) : await this.pool.readSnapshot(pageId, snap);
      if (this.isLeaf(page)) {
        if (snap === undefined) await this.pool.unpin(pageId, false);
        return pageId;
      }
      // the leaf holding `key` is found by descending; for null start,
      // descend via leftmost children.
      const child = key === null ? this.leftmostChildOf(page) : this.childOf(page, key);
      if (snap === undefined) await this.pool.unpin(pageId, false);
      if (child === 0) return 0;
      pageId = child;
    }
  }

  // ---------------- delete ----------------
  async delete(key: Uint8Array): Promise<boolean> {
    const root = await this.rootPage();
    if (root === 0) return false;
    const removed = await this.deleteRecursive(root, key);
    if (removed) {
      await this.mutateMeta((m) => m.setCount(Math.max(0, m.count - 1)));
    }
    return removed;
  }

  private async deleteRecursive(pageId: number, key: Uint8Array): Promise<boolean> {
    const page = await this.pool.pin(pageId);
    try {
      if (this.isLeaf(page)) {
        const idx = this.lowerBound(page, key);
        if (idx < this.keyCount(page) && compareKeys(this.readEntry(page, idx).key, key) === 0) {
          this.removeEntry(page, idx);
          return true;
        }
        return false;
      }
      const child = this.childOf(page, key);
      if (child === 0) return false;
      return await this.deleteRecursive(child, key);
    } finally {
      await this.pool.unpin(pageId, true);
    }
  }

  // ---------------- introspection & verification ----------------
  async dumpTree(limit = 500): Promise<BtreeSnapshot[]> {
    const out: BtreeSnapshot[] = [];
    const root = await this.rootPage();
    if (root === 0) return [];
    const queue = [root];
    while (queue.length > 0 && out.length < limit) {
      const pid = queue.shift()!;
      const p = await this.pool.pin(pid);
      const leaf = this.isLeaf(p);
      const n = this.keyCount(p);
      const entries: BtreeEntry[] = [];
      for (let i = 0; i < n; i++) entries.push(this.readEntry(p, i));
      out.push({
        kind: leaf ? "leaf" : "internal",
        pageId: pid,
        keys: entries.map((e) => e.keyText),
        values: entries.map((e) => e.value),
        nextLeaf: leaf ? this.nextLeafOf(p) : 0,
        parent: 0,
        leftmostChild: leaf ? 0 : this.leftmostChildOf(p),
      });
      if (!leaf) {
        if (this.leftmostChildOf(p) !== 0) queue.push(this.leftmostChildOf(p));
        for (const e of entries) queue.push(e.value);
      }
      await this.pool.unpin(pid, false);
    }
    this.assignParents(out);
    return out;
  }

  private assignParents(snap: BtreeSnapshot[]): void {
    const byId = new Map<number, BtreeSnapshot>();
    for (const s of snap) byId.set(s.pageId, s);
    for (const s of snap) {
      // Only internal nodes own children; leaves' `values` are row ids, not
      // page ids, so they must never set parent pointers.
      if (s.kind !== "internal") continue;
      if (s.leftmostChild !== 0) {
        const child = byId.get(s.leftmostChild);
        if (child) child.parent = s.pageId;
      }
      for (const v of s.values) {
        const child = byId.get(v);
        if (child) child.parent = s.pageId;
      }
    }
  }

  /** Structural verification: sorted keys, intact chain, count matches metadata. */
  async verify(): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    const root = await this.rootPage();
    if (root === 0) return { ok: true, errors };
    const snap = await this.dumpTree(100000);
    const order = (await this.readMeta()).order;
    const rootPage = await this.pool.pin(root);
    const rootIsLeaf = this.isLeaf(rootPage);
    await this.pool.unpin(root, false);

    for (const node of snap) {
      for (let i = 1; i < node.keys.length; i++) {
        const a = encodeVerifyKey(node.keys[i - 1]);
        const b = encodeVerifyKey(node.keys[i]);
        if (compareKeys(a, b) >= 0) {
          errors.push(`page ${node.pageId}: keys not strictly ascending at index ${i}`);
        }
      }
      if (node.kind === "internal" && !rootIsLeaf && node.keys.length === 0 && snap.length > 1) {
        errors.push(`internal page ${node.pageId} is empty`);
      }
      if (node.keys.length > order) {
        errors.push(`page ${node.pageId}: overfull (${node.keys.length} > ${order})`);
      }
    }
    let scanned = 0;
    for await (const _ of this.scanAll()) scanned++;
    const meta = await this.readMeta();
    if (scanned !== meta.count) {
      errors.push(`leaf chain holds ${scanned} entries but metadata says ${meta.count}`);
    }
    return { ok: errors.length === 0, errors };
  }
}

// helper: create a page synchronously for splitNode via a pool that can allocate
// We offer a small wrapper: BtreeIndex uses pool.createPage inside splitNode which
// is async; to keep splitNode sync-free we instead convert splitNode to async.
// To minimize rewriting, export a function that allocates with the pool.

export function encodeTextKey(t: string): Uint8Array {
  if (t === "NULL") return encodeKeyNull();
  if (t === "true") return encodeKeyBoolean(true);
  if (t === "false") return encodeKeyBoolean(false);
  const n = Number(t);
  if (!Number.isNaN(n) && t.trim() !== "") return encodeKeyNumber(n);
  return encodeKeyString(t);
}

/** Re-encode a rendered key text for comparison; composite texts are split on spaces. */
function encodeVerifyKey(t: string): Uint8Array {
  if (t.includes(" ")) return encodeCompositeKey(t.split(" ").map(encodeTextKey));
  return encodeTextKey(t);
}