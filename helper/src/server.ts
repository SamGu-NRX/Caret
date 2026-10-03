// Unix socket server. Every client's first line is a hello naming its role. The reader then
// streams ReaderMessages and receives the executor's readerCommands; consumers send fill requests,
// plans, task controls and the host's offerAccept and offerStop, and receive every HelperMessage.
// Invalid lines are answered with an error message and counted, never silently dropped.
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { ConsumerMessage, Hello, PROTOCOL_VERSION, ReaderMessage, type ActRevoke, type HelperMessage, type HelperToReader } from "./protocol.ts";
import type { Helper } from "./helper.ts";
import { planError } from "./planner/proposal.ts";

/** One line may carry a whole window; a longer line is a reader bug, not a bigger window. */
const MAX_LINE_CHARS = 32 * 1024 * 1024;

export class HelperServer {
  private readonly consumers = new Set<Socket>();
  /** The most recent reader connection; commands go there. */
  private reader: Socket | null = null;
  /**
   * Tasks holding a grant on the current reader connection. When another reader says hello, the old
   * connection stays open, so its grants are revoked there: a command still queued in the old reader
   * must not act after the helper has moved on to a new session.
   */
  private granted = new Set<string>();
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

  /** Commands, act grants and revokes go to the reader only; no consumer ever receives one. */
  sendToReader(m: HelperToReader): boolean {
    if (this.reader === null || this.reader.destroyed) return false;
    this.reader.write(JSON.stringify(m) + "\n");
    // An act grant and a calendar grant both end with the task's one actRevoke.
    if (m.type === "actGrant" || m.type === "calendarGrant") this.granted.add(m.taskId);
    else if (m.type === "actRevoke") this.granted.delete(m.taskId);
    return true;
  }

  /** Ends every grant the outgoing reader holds, on its own connection, before a new reader takes over. */
  private revokeOnOldReader(old: Socket | null): void {
    if (old !== null && !old.destroyed) {
      for (const taskId of this.granted) old.write(JSON.stringify({ type: "actRevoke", v: PROTOCOL_VERSION, taskId, at: Date.now() } satisfies ActRevoke) + "\n");
    }
    this.granted = new Set();
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
    let replaced = false;
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
            this.revokeOnOldReader(this.reader);
            this.reader = s;
            void this.helper().handleReader(hello.data);
          }
          continue;
        }
        if (role === "reader") {
          // A reader another reader replaced numbers windows from its own session: its snapshots and
          // answers would describe windows under ids the current reader may give to others.
          if (s !== this.reader) {
            if (!replaced) this.reject(s, "another reader has connected since; this connection's messages are ignored");
            replaced = true;
            continue;
          }
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
          // The work an accept starts reports as taskProgress and activity under the offer id; a refusal as error plus a stopped taskProgress.
          else if (m.data.type === "offerAccept") void this.helper().handleOfferAccept(m.data);
          else if (m.data.type === "offerStop") void this.helper().handleOfferStop(m.data);
          else if (m.data.type === "fillResult") this.helper().handleFillResult(m.data);
          else if (m.data.type === "settings") this.helper().handleSettings(m.data);
          else if (m.data.type === "skillAnswer") this.helper().handleSkillAnswer(m.data);
          // The reply names windows and quotes values, so it goes to the asker only, as memory does.
          else if (m.data.type === "firstLook") {
            const requestId = m.data.requestId;
            void this.helper()
              .handleFirstLook(m.data)
              .catch((e: unknown) => {
                this.warn(`first look ${requestId} failed: ${e instanceof Error ? e.message : String(e)}`);
                return { type: "firstLookReply", v: PROTOCOL_VERSION, requestId, at: Date.now(), outcome: "error", found: null, scanned: null, error: "the look failed" } as const;
              })
              .then((r) => {
                if (!s.destroyed) s.write(JSON.stringify(r) + "\n");
              });
          }
          // A proposal quotes values and names windows, so it goes to the asker only, as a first look's reply does.
          else if (m.data.type === "planRequest") {
            const requestId = m.data.requestId;
            void this.helper()
              .handlePlanRequest(m.data)
              .catch((e: unknown) => {
                this.warn(`plan ${requestId} failed: ${e instanceof Error ? e.message : String(e)}`);
                return planError(requestId, "internal", "the planner failed; the helper logged why", Date.now());
              })
              .then((r) => {
                if (!s.destroyed) s.write(JSON.stringify(r) + "\n");
              });
          }
          // Records hold window titles and status lines, so a list goes to the asker only, as memory does.
          else if (m.data.type === "activityRequest") s.write(JSON.stringify(this.helper().handleActivity(m.data)) + "\n");
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
      if (this.reader === s) {
        this.reader = null;
        // The reader drops its grants when its connection closes.
        this.granted = new Set();
        this.helper().readerClosed();
      }
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
