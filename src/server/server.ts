import { createServer, Socket } from "node:net";
import { Engine } from "../engine/engine.js";
import { parseStatement, ParseError } from "../sql/parser.js";
import { PlannerError } from "../planner/planner.js";

export interface QueryFrame {
  sql: string;
  explain?: boolean;
  analyze?: boolean;
  token?: string;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  token?: string;
}

const MAX_FRAME = 16 * 1024 * 1024;

export function encodeFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

export class FrameReader {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer | string): Buffer[] {
    const c = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.buf = this.buf.length === 0 ? c : Buffer.concat([this.buf, c]);
    const frames: Buffer[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME) throw new Error("frame too large");
      if (this.buf.length < 4 + len) break;
      frames.push(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
    return frames;
  }
}

export class QuasarServer {
  private srv = createServer();
  private queue: Promise<unknown> = Promise.resolve();
  private socks = new Set<Socket>();

  constructor(
    private engine: Engine,
    private opts: ServerOptions = {},
  ) {}

  async listen(): Promise<number> {
    const port = this.opts.port ?? 7171;
    const host = this.opts.host ?? "127.0.0.1";
    this.srv.on("connection", (sock) => this.handle(sock));
    await new Promise<void>((resolve, reject) => {
      this.srv.once("error", reject);
      this.srv.listen(port, host, () => {
        this.srv.off("error", reject);
        resolve();
      });
    });
    const addr = this.srv.address();
    return typeof addr === "object" && addr !== null ? addr.port : port;
  }

  async close(): Promise<void> {
    for (const sock of this.socks) sock.destroy();
    await new Promise<void>((resolve) => this.srv.close(() => resolve()));
  }

  private handle(sock: Socket): void {
    this.socks.add(sock);
    const reader = new FrameReader();
    sock.on("data", (chunk) => {
      let frames: Buffer[];
      try {
        frames = reader.push(chunk);
      } catch (e) {
        sock.end(encodeFrame({ ok: false, error: (e as Error).message }));
        sock.destroy();
        return;
      }
      for (const frame of frames) this.enqueue(frame, sock);
    });
    sock.on("close", () => this.socks.delete(sock));
    sock.on("error", () => sock.destroy());
  }

  private enqueue(frame: Buffer, sock: Socket): void {
    let req: QueryFrame;
    try {
      const parsed = JSON.parse(frame.toString("utf8")) as QueryFrame;
      if (typeof parsed.sql !== "string" || parsed.sql.length === 0) {
        sock.write(encodeFrame({ ok: false, error: "request must contain a non-empty 'sql' string" }));
        return;
      }
      req = parsed;
    } catch {
      sock.write(encodeFrame({ ok: false, error: "invalid JSON frame" }));
      return;
    }
    if (this.opts.token && req.token !== this.opts.token) {
      sock.write(encodeFrame({ ok: false, error: "unauthorized" }));
      return;
    }
    this.queue = this.queue
      .then(async () => {
        try {
          const parsed = parseStatement(req.sql);
          const result = await this.engine.execute(parsed.statement, {
            explain: parsed.explain || req.explain,
            analyze: parsed.analyze || req.analyze,
          });
          sock.write(encodeFrame({ ok: true, result }));
        } catch (e) {
          const err = e as Error;
          const code =
            err instanceof ParseError
              ? "syntax_error"
              : err instanceof PlannerError
                ? "plan_error"
                : "engine_error";
          sock.write(encodeFrame({ ok: false, error: err.message, code }));
        }
      })
      .catch(() => {});
  }
}

function extractFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const dbPath = extractFlag(args, "--db") ?? "quasar.db";
  const port = Number(extractFlag(args, "--port") ?? "7171");
  const token = extractFlag(args, "--token");
  let engine: Engine;
  try {
    engine = await Engine.create(dbPath);
    console.log(`(+) created new database at ${dbPath}`);
  } catch {
    engine = await Engine.open(dbPath);
    console.log(`(+) opened database at ${dbPath}`);
  }
  const server = new QuasarServer(engine, { port, token });
  const p = await server.listen();
  console.log(`quasardb server listening on 127.0.0.1:${p} (Ctrl-C to stop)${token ? " [auth on]" : ""}`);
  const shutdown = async () => {
    await server.close();
    await engine.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1]?.endsWith("server.ts")) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}