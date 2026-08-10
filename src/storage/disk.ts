import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { PAGE_SIZE, Page } from "./page.js";
import { stat as statF } from "node:fs/promises";

export interface DiskIO {
  readPage(id: number): Promise<Uint8Array | null>;
  writePage(id: number, data: Uint8Array): Promise<void>;
  pageCount(): Promise<number>;
  sync(): Promise<void>;
  close(): Promise<void>;
  flush(): Promise<void>;
}

/** File-backed storage: a simple flat file of fixed-size pages. */
export class FileDisk implements DiskIO {
  readonly path: string;
  private fd: FileHandle | null = null;
  private count: number;

  constructor(path: string, existingPages = 0) {
    this.path = path;
    this.count = existingPages;
  }

  static async open(path: string): Promise<FileDisk> {
    let h: FileHandle;
    let size = 0;
    try {
      const st = await stat(path);
      size = st.size;
      h = await open(path, "r+");
    } catch {
      h = await open(path, "w+");
    }
    const disk = new FileDisk(path, Math.floor(size / PAGE_SIZE));
    disk.fd = h;
    return disk;
  }

  async pageCount(): Promise<number> {
    return this.count;
  }

  async readPage(id: number): Promise<Uint8Array | null> {
    if (id >= this.count) return null;
    const buf = Buffer.alloc(PAGE_SIZE);
    const res = await this.fd!.read(buf, 0, PAGE_SIZE, id * PAGE_SIZE);
    if (res.bytesRead === 0) return null;
    return new Uint8Array(buf);
  }

  async writePage(id: number, data: Uint8Array): Promise<void> {
    if (id >= this.count) this.count = id + 1;
    const buf = data instanceof Uint8Array ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : data;
    await this.fd!.write(buf, 0, PAGE_SIZE, id * PAGE_SIZE);
  }

  async sync(): Promise<void> {
    if (this.fd) await this.fd.sync();
  }

  async flush(): Promise<void> {
    if (this.fd) await this.fd.sync();
  }

  async close(): Promise<void> {
    if (this.fd) await this.fd.close();
    this.fd = null;
  }
}

/** Deleting implementation of page-wrap writer. */
export async function writeFileShim(path: string, pages: Uint8Array[]): Promise<void> {
  const ws = createWriteStream(path);
  for (const p of pages) {
    await new Promise<void>((resolve, reject) => {
      ws.write(Buffer.from(p.buffer, p.byteOffset, p.byteLength), (e) => (e ? reject(e) : resolve()));
    });
  }
  await new Promise<void>((resolve, reject) => ws.end((e?: Error | null) => (e ? reject(e) : resolve())));
}

// Node fs/promises FileHandle typing helper
type FileHandle = Awaited<ReturnType<typeof open>>;

async function stat(path: string): Promise<{ size: number }> {
  return statF(path);
}