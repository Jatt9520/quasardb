import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createConnection, Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../engine/engine.js";
import { QuasarServer, encodeFrame } from "./server.js";

class TestClient {
  private sock: Socket = null as unknown as Socket;
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private pending: ((frame: unknown) => void)[] = [];

  connect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sock = createConnection({ port, host: "127.0.0.1" }, () => resolve());
      this.sock.on("data", (chunk) => this.onData(chunk));
      this.sock.on("error", reject);
    });
  }

  send(obj: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      this.pending.push(resolve);
      this.sock.write(encodeFrame(obj));
    });
  }

  sendRaw(body: string): Promise<unknown> {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(Buffer.byteLength(body), 0);
    return new Promise((resolve) => {
      this.pending.push(resolve);
      this.sock.write(Buffer.concat([head, Buffer.from(body, "utf8")]));
    });
  }

  close(): void {
    this.sock.destroy();
  }

  private onData(chunk: Buffer | string): void {
    const c = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.buf = this.buf.length === 0 ? c : Buffer.concat([this.buf, c]);
    for (;;) {
      if (this.buf.length < 4) return;
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) return;
      const body = this.buf.subarray(4, 4 + len).toString("utf8");
      this.buf = this.buf.subarray(4 + len);
      const resolve = this.pending.shift();
      if (resolve) resolve(JSON.parse(body));
    }
  }
}

let engine: Engine;
let server: QuasarServer;
let port: number;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "quasar-server-"));
  engine = await Engine.create(join(dir, "test.db"));
  server = new QuasarServer(engine, { port: 0 });
  port = await server.listen();
});

afterAll(async () => {
  await server.close();
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

async function query(c: TestClient, sql: string) {
  return (await c.send({ sql })) as {
    ok: boolean;
    result?: { columns: string[]; rows: unknown[][]; rowCount: number; timeMs: number };
    error?: string;
    code?: string;
  };
}

describe("QuasarServer", () => {
  it("executes DDL, DML and queries over the wire", async () => {
    const c = new TestClient();
    await c.connect(port);
    expect((await query(c, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")).ok).toBe(true);
    expect((await query(c, "INSERT INTO t VALUES (1, 'alice'), (2, 'bob')")).ok).toBe(true);
    const r = await query(c, "SELECT name, id FROM t ORDER BY id");
    expect(r.ok).toBe(true);
    expect(r.result!.columns).toEqual(["name", "id"]);
    expect(r.result!.rows).toEqual([["alice", 1], ["bob", 2]]);
    expect(r.result!.rowCount).toBe(2);
    expect(r.result!.timeMs).toBeGreaterThanOrEqual(0);
    c.close();
  });

  it("returns error frames with stable codes", async () => {
    const c = new TestClient();
    await c.connect(port);
    const r1 = await query(c, "SELEC 1");
    expect(r1.ok).toBe(false);
    expect(r1.code).toBe("syntax_error");
    const r2 = await query(c, "SELECT x FROM missing_table");
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe("engine_error");
    expect(r2.error).toContain("missing_table");
    const r3 = await query(c, "SELECT name FROM t WHERE age IN (1, 2");
    expect(r3.ok).toBe(false);
    expect(r3.code).toBe("syntax_error");
    c.close();
  });

  it("handles pipelined requests in order", async () => {
    const c = new TestClient();
    await c.connect(port);
    const p1 = c.send({ sql: "INSERT INTO t VALUES (3, 'carol')" });
    const p2 = c.send({ sql: "SELECT count(*) AS n FROM t" });
    const p3 = c.send({ sql: "SELECT name FROM t WHERE id = 3" });
    const [a, b, d] = await Promise.all([p1, p2, p3]) as unknown[];
    expect((a as { ok: boolean }).ok).toBe(true);
    expect((b as { result: { rows: unknown[][] } }).result.rows).toEqual([[3]]);
    expect((d as { result: { rows: unknown[][] } }).result.rows).toEqual([["carol"]]);
    c.close();
  });

  it("supports EXPLAIN over the wire", async () => {
    const c = new TestClient();
    await c.connect(port);
    const r = (await c.send({ sql: "EXPLAIN SELECT name FROM t WHERE id > 0" })) as {
      ok: boolean;
      result: { explain?: string; rows: unknown[][] };
    };
    expect(r.ok).toBe(true);
    expect(r.result.explain).toContain("scan");
    expect((r.result.rows[0][0] as string)).toContain("scan");
    c.close();
  });
});

describe("QuasarServer errors and auth", () => {
  let authEngine: Engine;
  let authServer: QuasarServer;
  let authPort: number;
  let authDir: string;

  beforeAll(async () => {
    authDir = mkdtempSync(join(tmpdir(), "quasar-auth-"));
    authEngine = await Engine.create(join(authDir, "auth.db"));
    authServer = new QuasarServer(authEngine, { port: 0, token: "s3cret" });
    authPort = await authServer.listen();
  });

  afterAll(async () => {
    await authServer.close();
    await authEngine.close();
    rmSync(authDir, { recursive: true, force: true });
  });

  it("rejects requests without the shared token", async () => {
    const c = new TestClient();
    await c.connect(authPort);
    const r1 = await query(c, "SELECT 1");
    expect(r1.ok).toBe(false);
    expect(r1.error).toBe("unauthorized");
    const r2 = (await c.send({ sql: "SELECT 1", token: "s3cret" })) as { ok: boolean };
    expect(r2.ok).toBe(true);
    c.close();
  });

  it("rejects malformed frames", async () => {
    const c = new TestClient();
    await c.connect(authPort);
    const resp = (await c.sendRaw("{not-json")) as { ok: boolean; error: string };
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe("invalid JSON frame");
    const empty = (await c.send({})) as { ok: boolean; error: string };
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain("'sql'");
    c.close();
  });
});