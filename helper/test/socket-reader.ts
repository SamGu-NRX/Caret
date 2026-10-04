// A reader on the real socket, for acceptance tests: it replays recorded synthetic snapshots and answers
// the helper's readerCommands the way caret-screen does. `walk` resends the window; `write` rechecks
// the expected value, sets it and resends the window; `raise` makes the window the focused one and its
// app frontmost and resends it with `focused: true`; `watchInput` and `watchWindows` are acknowledged.
// Every snapshot a verb produces is sent before the verb's answer, as the reader does.
import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { HelperToReader, isCalendarVerb, PROTOCOL_VERSION, ReaderMessage, type CalendarVerb, type ReaderCommand, type ReaderVerb, type Snapshot, type VerbResult } from "../src/protocol.ts";
import { FakeGrants } from "./fake-grants.ts";

/** A line-oriented client: every message received is kept in order, and a test can wait for one. */
export class LineClient {
  readonly received: unknown[] = [];
  readonly s: Socket;
  onMessage: ((m: unknown) => void) | null = null;
  private readonly waiters: { pred: (m: unknown) => boolean; resolve: (m: unknown) => void }[] = [];
  private buf = "";

  private constructor(s: Socket) {
    this.s = s;
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      this.buf += d;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const m: unknown = JSON.parse(this.buf.slice(0, nl));
        this.buf = this.buf.slice(nl + 1);
        this.received.push(m);
        this.onMessage?.(m);
        for (const w of [...this.waiters]) {
          if (!w.pred(m)) continue;
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
  }

  static connect(path: string): Promise<LineClient> {
    return new Promise((resolve, reject) => {
      const s = createConnection(path);
      s.once("connect", () => resolve(new LineClient(s)));
      s.once("error", reject);
    });
  }

  /** Messages this client has sent, of every kind. */
  sent = 0;

  send(m: unknown): void {
    this.sent++;
    this.s.write(JSON.stringify(m) + "\n");
  }

  /** The first message, received already or later, that matches. Fails after `ms` with what did arrive. */
  waitFor<T = Record<string, unknown>>(pred: (m: Record<string, unknown>) => boolean, ms = 3000): Promise<T> {
    const p = (m: unknown): boolean => typeof m === "object" && m !== null && pred(m as Record<string, unknown>);
    const hit = this.received.find(p);
    if (hit !== undefined) return Promise.resolve(hit as T);
    return new Promise((resolve, reject) => {
      const w = { pred: p, resolve: (m: unknown) => (clearTimeout(timer), resolve(m as T)) };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        const types = this.received.map((m) => (m as { type?: string }).type).join(", ");
        reject(new Error(`no matching message within ${ms} ms; received: ${types}`));
      }, ms);
      this.waiters.push(w);
    });
  }

  close(): void {
    this.s.destroy();
  }
}

/** A recorded session from fixtures/recorded, each line checked against the protocol. */
export function loadRecording(name: string): ReaderMessage[] {
  const path = fileURLToPath(new URL(`../fixtures/recorded/${name}`, import.meta.url));
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => ReaderMessage.parse(JSON.parse(l)));
}

export interface ReplayHooks {
  /** True once the helper has applied the snapshot of `windowId` stamped `at`; replay waits for it. */
  applied: (windowId: string, at: number) => boolean;
  /** The helper's periodic work, run at each line's time so edits settle as they would live. */
  tick: (at: number) => void;
}

export class SocketReader {
  readonly client: LineClient;
  /** Each window as the reader last sent it. */
  readonly windows = new Map<string, Snapshot>();
  readonly verbs: ReaderVerb[] = [];
  /** Milliseconds to hold the answer to a verb of this kind, to keep a run in flight. */
  readonly delayMs: Partial<Record<ReaderVerb["kind"], number>> = {};
  frontmostPid: number | null = null;
  /** Every act grant and revoke the helper sent on the socket, applied in socket order before later commands. */
  readonly grants = new FakeGrants();
  /** Refuses write, press and raise without a live grant, as caret-screen without --act-pids does. Off by default. */
  enforceGrants = false;
  /** Plays caret-screen's EventKit adapter for calendar verbs; null answers as a reader without --calendar-test does. */
  calendar: ((verb: CalendarVerb) => Pick<VerbResult, "outcome" | "detail" | "event" | "blocked">) | null = null;
  /** Each app's own focused window, which it keeps while it is in the background. */
  private readonly appFocus = new Map<number, string>();
  /** The recording's clock, carried on into the snapshots verbs produce. */
  clock = 0;
  private seq = 0;

  private constructor(client: LineClient) {
    this.client = client;
    client.onMessage = (m) => {
      const msg = HelperToReader.safeParse(m);
      if (!msg.success) return;
      if (msg.data.type === "readerCommand") void this.answer(msg.data);
      else this.grants.receive(msg.data);
    };
  }

  static async connect(path: string): Promise<SocketReader> {
    const r = new SocketReader(await LineClient.connect(path));
    r.client.send({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 1, version: "socket-reader" });
    return r;
  }

  /** Sends one reader message and keeps the state of every window it describes. */
  send(m: ReaderMessage): void {
    if (m.type === "snapshot") {
      if (m.root !== null) throw new Error("the simulator keeps whole windows only");
      this.windows.set(m.window.windowId, structuredClone(m));
      this.seq = Math.max(this.seq, m.seq);
      if (m.focused) this.focus(m.window.windowId);
    }
    if ("at" in m) this.clock = Math.max(this.clock, m.at);
    this.client.send(m);
  }

  /** Sends each line, waits until the helper has applied it, and ticks the helper at its time; then once more after the last edit has settled. */
  async replay(lines: readonly ReaderMessage[], hooks: ReplayHooks): Promise<void> {
    for (const m of lines) {
      this.send(m);
      if (m.type === "snapshot") await until(() => hooks.applied(m.window.windowId, m.at));
      if ("at" in m) hooks.tick(m.at);
    }
    // SETTLE_MS is 1.5 s; 2 s later every edit of the recording has been judged.
    this.clock += 2000;
    hooks.tick(this.clock);
  }

  /**
   * Resends a window as a fresh walk would, stamped after everything sent so far. Like caret-screen's
   * request walk, it marks the window focused when it is its app's own focused window, even while that
   * app is in the background.
   */
  show(windowId: string): Snapshot {
    const w = this.window(windowId);
    this.clock += 10;
    const s: Snapshot = { ...structuredClone(w), seq: ++this.seq, at: this.clock, reason: "request", focused: this.appFocus.get(w.app.pid) === windowId };
    this.windows.set(windowId, s);
    this.client.send(s);
    return s;
  }

  /** Changes a field's value as something outside the helper would (the host inserting text), and sends the window. */
  setValue(windowId: string, key: string, value: string): Snapshot {
    const n = this.window(windowId).nodes.find((x) => x.key === key);
    if (n === undefined) throw new Error(`no node ${key} in ${windowId}`);
    if (value === "") delete n.value;
    else n.value = value;
    return this.show(windowId);
  }

  value(windowId: string, key: string): string {
    return this.window(windowId).nodes.find((n) => n.key === key)?.value ?? "";
  }

  /** The focused window of the frontmost app: the one the user is in. */
  focusedWindow(): string | null {
    return this.frontmostPid === null ? null : (this.appFocus.get(this.frontmostPid) ?? null);
  }

  close(): void {
    this.client.close();
  }

  private window(windowId: string): Snapshot {
    const w = this.windows.get(windowId);
    if (w === undefined) throw new Error(`the simulator has no window ${windowId}`);
    return w;
  }

  /** The window becomes its app's focused window, and its app frontmost. */
  private focus(windowId: string): void {
    const pid = this.window(windowId).app.pid;
    this.appFocus.set(pid, windowId);
    for (const w of this.windows.values()) if (w.app.pid === pid) w.focused = w.window.windowId === windowId;
    this.frontmostPid = pid;
  }

  private async answer(cmd: ReaderCommand): Promise<void> {
    const verb = cmd.verb;
    this.verbs.push(verb);
    const delay = this.delayMs[verb.kind];
    if (delay !== undefined) await new Promise((r) => setTimeout(r, delay));
    const reply = (outcome: VerbResult["outcome"], detail: string | null = null): void =>
      this.client.send({ type: "verbResult", v: PROTOCOL_VERSION, id: cmd.id, at: this.clock, outcome, detail } satisfies VerbResult);
    if (verb.kind === "watchInput" || verb.kind === "watchWindows" || verb.kind === "watchPresses") return reply("ok");
    if (isCalendarVerb(verb)) {
      // As caret-screen answers: nothing without --calendar-test (no adapter here), and a write only under its task's calendar grant.
      const refused = this.calendar !== null && "taskId" in verb ? this.grants.calendarRefusal(verb.taskId) : null;
      const r = this.calendar === null ? { outcome: "notAllowed" as const, detail: "the reader was not started with --calendar-test" } : refused !== null ? { outcome: "notAllowed" as const, detail: refused } : this.calendar(verb);
      this.client.send({ type: "verbResult", v: PROTOCOL_VERSION, id: cmd.id, at: this.clock, ...r } satisfies VerbResult);
      return;
    }
    const refused = this.enforceGrants ? this.grants.refusal(verb) : null;
    if (refused !== null) return reply("notAllowed", refused);
    const w = this.windows.get(verb.windowId);
    if (w === undefined) return reply("noWindow");
    if (w.app.pid !== verb.pid) return reply("notAllowed");
    switch (verb.kind) {
      case "walk":
        this.show(verb.windowId);
        return reply("ok");
      case "raise": {
        // As caret-screen does on activation: an appSwitch, then the raised window's walk.
        const to = this.window(verb.windowId).app;
        const from = [...this.windows.values()].find((x) => x.app.pid === this.frontmostPid)?.app ?? null;
        this.clock += 10;
        if (from?.pid !== to.pid) this.client.send({ type: "appSwitch", v: PROTOCOL_VERSION, at: this.clock, from, to });
        this.focus(verb.windowId);
        this.show(verb.windowId);
        return reply("ok");
      }
      case "press":
        return reply("noElement", verb.key);
      case "write": {
        const n = w.nodes.find((x) => x.key === verb.key);
        if (n === undefined) return reply("noElement", verb.key);
        if (n.role !== verb.role) return reply("changed", `role is ${n.role}`);
        if (verb.attribute === "focused") w.focusedKey = verb.key;
        else if ((n.value ?? "") !== verb.expect) return reply("changed", "the value differs from what was expected");
        else if (verb.value === "") delete n.value;
        else n.value = verb.value;
        this.show(verb.windowId);
        return reply("ok");
      }
    }
  }
}

/** Resolves once `cond` holds, checking between turns of the event loop; fails after `ms`. */
export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setImmediate(r));
  }
}
