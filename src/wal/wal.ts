import { open } from "node:fs/promises";

/**
 * Append-only write-ahead log.
 *
 * Records are JSON lines next to the database file (`<db>.wal`):
 *   {"v":1,"xid":5,"stmt":{...}}   a write statement (serialized AST)
 *   {"v":1,"xid":5,"commit":true}  commit marker for transaction 5
 *
 * Durability rule: statement records are buffered by the OS; the COMMIT
 * marker is always fsynced. A transaction is durable once its commit marker
 * has been synced, and recovery picks it up if the engine crashed before
 * its data pages reached disk. Aborted/rolled-back transactions have no
 * commit marker and are discarded by recovery.
 */
export interface WalRecord {
  v: 1;
  xid: number;
  stmt?: unknown;
  commit?: boolean;
}

type FileHandle = Awaited<ReturnType<typeof open>>;

export class Wal {
  readonly path: string;
  private fd: FileHandle | null = null;
  private enabled = true;

  private constructor(path: string) {
    this.path = path;
  }

  static async open(path: string): Promise<Wal> {
    const w = new Wal(path);
    w.fd = await open(path, "a+");
    return w;
  }

  /** While disabled (during recovery replay) appends are no-ops. */
  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  get enabledValue(): boolean {
    return this.enabled;
  }

  async appendStmt(xid: number, stmt: unknown): Promise<void> {
    if (!this.enabled || !this.fd) return;
    const line = JSON.stringify({ v: 1 as const, xid, stmt }) + "\n";
    await this.fd.write(line);
  }

  async appendCommit(xid: number): Promise<void> {
    if (!this.enabled || !this.fd) return;
    const line = JSON.stringify({ v: 1 as const, xid, commit: true }) + "\n";
    await this.fd.write(line);
    await this.fd.sync();
  }

  /** Read every record back (used by crash recovery). */
  async readAll(): Promise<WalRecord[]> {
    if (!this.fd) return [];
    const buf = Buffer.alloc(64 * 1024);
    let pos = 0;
    let raw = "";
    for (;;) {
      const { bytesRead } = await this.fd.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      raw += buf.subarray(0, bytesRead).toString("utf8");
      pos += bytesRead;
    }
    const out: WalRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        out.push(JSON.parse(trimmed) as WalRecord);
      } catch {
        // torn/partial tail line (crash mid-append): ignored
      }
    }
    return out;
  }

  /** Empty the log after successful recovery or a clean close. */
  async truncate(): Promise<void> {
    if (!this.fd) return;
    await this.fd.close();
    this.fd = null;
    // ftruncate on an O_APPEND handle is EPERM on some platforms: use a
    // separate read/write handle, and recreate the append handle afterwards
    let h: FileHandle;
    try {
      h = await open(this.path, "r+");
    } catch {
      h = await open(this.path, "a+");
    }
    try {
      await h.truncate(0);
      await h.sync();
    } finally {
      await h.close();
    }
    this.fd = await open(this.path, "a+");
  }

  async close(): Promise<void> {
    if (this.fd) {
      await this.fd.close();
      this.fd = null;
    }
  }
}