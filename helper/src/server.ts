// Unix socket server. Every client's first line is a hello naming its role. The reader then
// streams ReaderMessages and receives the executor's readerCommands; consumers send fill requests,
// plans and task controls, and receive every HelperMessage.
// Invalid lines are answered with an error message and counted, never silently dropped.
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { ConsumerMessage, Hello, PROTOCOL_VERSION, ReaderMessage, type HelperMessage, type ReaderCommand } from "./protocol.ts";
import type { Helper } from "./helper.ts";

/** One line may carry a whole window; a longer line is a reader bug, not a bigger window. */
const MAX_LINE_CHARS = 32 * 1024 * 1024;

export class HelperServer {
  private readonly consumers = new Set<Socket>();
  /** The most recent reader connection; commands go there. */
  private reader: Socket | null = null;
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;
  private readonly helper: () => Helper;
  private readonly path: string;
  private readonly warn: (line: string) => void;

  constructor(path: string, helper: () => Helper, warn: (line: string) => void) {
    this.path = path;
    this.helper = helper;
    this.warn = warn;
  }

  sendToReader(cmd: ReaderCommand): boolean {
    if (this.reader === null || this.reader.destroyed) return false;
    this.reader.write(JSON.stringify(cmd) + "\n");
    return true;
  }

  publish(m: HelperMessage): void {
    const line = JSON.stringify(m) + "\n";
    for (const c of this.consumers) c.write(line);
  }

  async listen(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (existsSync(this.path)) {
      if (await isAlive(this.path)) throw new Error(`another helper is already listening on ${this.path}`);
      unlinkSync(this.path);
    }
    const server = createServer((s) => this.accept(s));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.path, () => resolve());
    });
    chmodSync(this.path, 0o600);
    this.server = server;
  }

  async close(): Promise<void> {
    // Every connection, readers included: server.close() waits for all of them to end.
    for (const c of this.sockets) c.destroy();
    await new Promise<void>((r) => (this.server === null ? r() : this.server.close(() => r())));
    if (existsSync(this.path)) unlinkSync(this.path);
  }

  private accept(s: Socket): void {
    this.sockets.add(s);
    let role: "reader" | "consumer" | null = null;
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE_CHARS) {
        this.reject(s, `line over ${MAX_LINE_CHARS} characters; closing`);
        s.destroy();
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          this.reject(s, "invalid JSON line");
          continue;
        }
        if (role === null) {
          const hello = Hello.safeParse(json);
          if (!hello.success) {
            this.reject(s, `first message must be hello: ${hello.error.message}`);
            s.destroy();
            return;
          }
          role = hello.data.role;
          if (role === "consumer") this.consumers.add(s);
          else {
            this.reader = s;
            void this.helper().handleReader(hello.data);
          }
          continue;
        }
        if (role === "reader") {
          const m = ReaderMessage.safeParse(json);
          if (!m.success) {
            this.reject(s, `invalid reader message: ${m.error.message.slice(0, 500)}`);
            continue;
          }
          void this.helper().handleReader(m.data);
        } else {
          const m = ConsumerMessage.safeParse(json);
          if (!m.success) {
            this.reject(s, `invalid consumer message: ${m.error.message.slice(0, 500)}`);
            continue;
          }
          if (m.data.type === "fillRequest") void this.helper().handleConsumer(m.data);
          else if (m.data.type === "runPlan" || m.data.type === "taskControl") void this.helper().handleTask(m.data);
          else if (m.data.type === "offerControl") void this.helper().handleOffer(m.data);
          else if (m.data.type === "memoryRequest") {
            // A bad request is answered in the reply; this catches only a failure of the store itself.
            try {
              s.write(JSON.stringify(this.helper().handleMemory(m.data)) + "\n");
            } catch (e) {
              this.reject(s, `memory request ${m.data.requestId} failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      }
    });
    s.on("close", () => {
      this.consumers.delete(s);
      if (this.reader === s) this.reader = null;
      this.sockets.delete(s);
    });
    s.on("error", (e) => this.warn(`socket error: ${e.message}`));
  }

  private reject(s: Socket, message: string): void {
    this.warn(message);
    s.write(JSON.stringify({ type: "error", v: PROTOCOL_VERSION, at: Date.now(), message }) + "\n");
  }
}

function isAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = createConnection(path);
    c.once("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.once("error", () => resolve(false));
  });
}
