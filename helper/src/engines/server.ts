// page.sock: the page engines' own socket, apart from the reader's screen.sock. Every connection is a bridge.
// The helper speaks first with a challenge; the bridge must answer with an engineHello whose HMAC proves it holds
// this run's secret (auth.ts), within HANDSHAKE_MS, or the connection closes having received nothing else. Only
// then does the helper prove itself in turn, issue the engine session id and hand the session to the registry.
// Lines after that are EngineMessages; an invalid one is logged and dropped, never acted on.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { EngineHello, EngineMessage, PROTOCOL_VERSION, type EngineChallenge, type EngineWelcome, type HelperToEngine } from "../protocol.ts";
import { bridgeProof, checkPrivateDir, helperProof, newNonce, proofMatches, removeSecret, writeSecret } from "./auth.ts";
import type { EngineRegistry } from "./registry.ts";
import { EngineSession } from "./session.ts";

/** A snapshot line holds every control of a tab's frames; longer than this is a bug, not a bigger page. */
const MAX_LINE_CHARS = 32 * 1024 * 1024;
/** Time a bridge has to answer the challenge. Assumed: the bridge answers from memory in well under a second. */
export const HANDSHAKE_MS = 5000;

export interface EngineServerOptions {
  path: string;
  registry: EngineRegistry;
  warn: (line: string) => void;
  handshakeMs?: number;
}

export class EngineServer {
  private server: Server | null = null;
  private secret: Buffer | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly opts: EngineServerOptions;
  /** Connections refused at the handshake, by reason, for tests and the status line. */
  readonly refused = new Map<string, number>();

  constructor(opts: EngineServerOptions) {
    this.opts = opts;
  }

  async listen(): Promise<void> {
    const dir = dirname(this.opts.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    checkPrivateDir(dir);
    if (existsSync(this.opts.path)) {
      if (await isAlive(this.opts.path)) throw new Error(`another helper is already listening on ${this.opts.path}`);
      unlinkSync(this.opts.path);
    }
    this.secret = writeSecret(this.opts.path);
    const server = createServer((s) => this.accept(s));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.path, () => resolve());
    });
    chmodSync(this.opts.path, 0o600);
    this.server = server;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server === null ? r() : this.server.close(() => r())));
    if (existsSync(this.opts.path)) unlinkSync(this.opts.path);
    removeSecret(this.opts.path);
    this.secret = null;
  }

  private refuse(s: Socket, reason: string): void {
    this.refused.set(reason, (this.refused.get(reason) ?? 0) + 1);
    this.opts.warn(`page bridge refused: ${reason}`);
    s.destroy();
  }

  private accept(s: Socket): void {
    const secret = this.secret;
    if (secret === null) return void s.destroy();
    this.sockets.add(s);
    const challenge = newNonce();
    let session: EngineSession | null = null;
    let buf = "";
    const timer = setTimeout(() => {
      if (session === null) this.refuse(s, "no valid hello within the handshake time");
    }, this.opts.handshakeMs ?? HANDSHAKE_MS);
    const write = (m: object): boolean => {
      if (s.destroyed) return false;
      s.write(JSON.stringify(m) + "\n");
      return true;
    };
    s.setEncoding("utf8");
    write({ type: "engineChallenge", v: PROTOCOL_VERSION, nonce: challenge } satisfies EngineChallenge);
    s.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE_CHARS) return this.refuse(s, `line over ${MAX_LINE_CHARS} characters`);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          if (session === null) return this.refuse(s, "invalid JSON before the handshake");
          this.opts.warn(`page engine ${session.info.engine}: invalid JSON line dropped`);
          continue;
        }
        if (session === null) {
          const hello = EngineHello.safeParse(json);
          if (!hello.success) return this.refuse(s, "first line is not a valid engineHello");
          if (!proofMatches(bridgeProof(secret, challenge, hello.data.nonce), hello.data.proof)) return this.refuse(s, "the bridge's proof does not match this run's secret");
          clearTimeout(timer);
          const engine = randomBytes(6).toString("hex");
          session = new EngineSession(
            { engine, browser: hello.data.browser, extensionId: hello.data.extensionId, bridgeVersion: hello.data.bridgeVersion, connectedAt: Date.now() },
            (m: HelperToEngine) => write(m),
          );
          write({ type: "engineWelcome", v: PROTOCOL_VERSION, engine, proof: helperProof(secret, challenge, hello.data.nonce) } satisfies EngineWelcome);
          this.opts.registry.add(session);
          continue;
        }
        const m = EngineMessage.safeParse(json);
        if (!m.success) {
          this.opts.warn(`page engine ${session.info.engine}: invalid message dropped: ${m.error.message.slice(0, 300)}`);
          continue;
        }
        const problem = session.receive(m.data);
        if (problem !== null) this.opts.warn(`page engine ${session.info.engine}: ${problem}`);
      }
    });
    s.on("close", () => {
      clearTimeout(timer);
      this.sockets.delete(s);
      if (session !== null) this.opts.registry.remove(session.info.engine);
    });
    s.on("error", (e) => this.opts.warn(`page socket error: ${e.message}`));
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
