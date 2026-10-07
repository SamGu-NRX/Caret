// The browser task pages' oracle (F1): what the pages under public/tasks/ hold and what happened to them, recorded
// independently of Caret. It imports nothing from helper/ or extension/, so a fill, a press or a submit is judged by
// the page and the server, never by the code under test.
//
// Its inputs:
//   - public/tasks/probe.js, a test-only script in every task page and frame, posts the value of each field marked
//     data-oracle on load and on every change (recordState), and every press on a button or link (recordPress);
//   - the fixture server counts every request to /tasks/submit (recordSubmit);
//   - NetworkSink, an HTTP proxy the test browser is launched behind, logs every request that leaves 127.0.0.1;
//   - harness presses: the harness asks for a press in-process (issueHarnessPress), the server hands it to the page's
//     probe, and the probe tags the click with the issued id. No HTTP route creates an id, so a press tagged with an id
//     this oracle never issued, or one already used, is a stray press like any other.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** One field as probe.js read it. `value` is "" when empty; checkboxes read "true" or "false". */
export interface FieldReading {
  value: string;
  /** probe.js's data-oracle-kind: text, select, checkbox, radios, pressgroup, react-select, picker or file. */
  kind: string;
  /** Rendered (checkVisibility): a field behind a reveal that has not happened reads false. */
  visible: boolean;
}

export interface StatePost {
  /** The page's data-oracle-page, the same in each of its frames. */
  page: string;
  /** The frame's path, so a page's frames merge without overwriting each other. */
  frame: string;
  /** One per document load of the frame. */
  loadId: string;
  seq: number;
  reason: string;
  fields: Record<string, FieldReading>;
}

export interface PressRecord {
  page: string;
  frame: string;
  loadId: string;
  /** The pressed element's data-oracle-press, or its tag and text when it has none. */
  target: string;
  trusted: boolean;
  /** The id probe.js tagged the click with, or null. A harness press only if this oracle issued it for this target. */
  claim: number | null;
  harness: boolean;
  at: number;
}

export interface SubmitRecord {
  page: string;
  method: string;
  via: string;
  at: number;
}

export interface OffsiteRecord {
  method: string;
  /** The absolute URL, or host:port for a CONNECT (HTTPS and WebSocket over TLS). */
  target: string;
  at: number;
}

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

export interface Scored {
  /** Expected a value and holds exactly it. */
  right: string[];
  /** Holds a value other than the expected one, or any value where `none` was expected. */
  wrong: { field: string; expected: string; actual: string }[];
  /** Expected a value and is still empty. */
  missed: string[];
  /** Expected `none` and is empty. */
  leftAlone: string[];
  /** In the expectations but not on the page (a reveal that never happened, or a renamed field). */
  absent: string[];
}

interface Issued {
  page: string;
  target: string;
  used: boolean;
}

export class Oracle {
  private readonly states: (StatePost & { at: number })[] = [];
  readonly presses: PressRecord[] = [];
  readonly submits: SubmitRecord[] = [];
  /** Every request the network sink saw, the browser's own included; offsite() and browserService() split it. */
  readonly network: OffsiteRecord[] = [];
  /** probe.js's own errors (a field of unknown kind, an exception): a page the oracle cannot read is loud. */
  readonly probeErrors: { page: string; error: string }[] = [];
  private readonly issued = new Map<number, Issued>();
  private nextClaim = 1;

  recordState(p: StatePost): void {
    this.states.push({ ...p, at: Date.now() });
  }

  recordPress(p: Omit<PressRecord, "harness" | "at">): PressRecord {
    const claim = p.claim === null ? undefined : this.issued.get(p.claim);
    const harness = claim !== undefined && !claim.used && claim.page === p.page && claim.target === p.target;
    if (harness && claim !== undefined) claim.used = true;
    const r = { ...p, harness, at: Date.now() };
    this.presses.push(r);
    return r;
  }

  recordSubmit(s: Omit<SubmitRecord, "at">): void {
    this.submits.push({ ...s, at: Date.now() });
  }

  recordOffsite(o: Omit<OffsiteRecord, "at">): void {
    this.network.push({ ...o, at: Date.now() });
  }

  /** Requests that left 127.0.0.1 for any host but the browser's own services: none should ever happen. */
  offsite(): OffsiteRecord[] {
    return this.network.filter((r) => !isBrowserService(r.target));
  }

  /** Requests to BROWSER_SERVICE_HOSTS, kept apart rather than dropped. */
  browserService(): OffsiteRecord[] {
    return this.network.filter((r) => isBrowserService(r.target));
  }

  recordProbeError(page: string, error: string): void {
    this.probeErrors.push({ page, error });
  }

  /** A press the harness is about to make on `page`'s data-oracle-press `target`; returns the id the probe tags it with. */
  issueHarnessPress(page: string, target: string): number {
    const id = this.nextClaim++;
    this.issued.set(id, { page, target, used: false });
    return id;
  }

  /**
   * The newest load of each of `page`'s frames, with its highest-seq reading. A load is newer when its first post
   * arrived later: an old load's last keepalive post can land after the next load's first one.
   */
  private latest(page: string): (StatePost & { at: number })[] {
    const newestLoad = new Map<string, string>();
    for (const s of this.states) if (s.page === page && !this.seenBefore(s)) newestLoad.set(s.frame, s.loadId);
    const out: (StatePost & { at: number })[] = [];
    for (const loadId of newestLoad.values()) {
      const posts = this.states.filter((s) => s.loadId === loadId);
      out.push(posts.reduce((a, b) => (b.seq > a.seq ? b : a)));
    }
    return out;
  }

  /** Whether an earlier post came from the same load as `s`. */
  private seenBefore(s: StatePost): boolean {
    return this.states.findIndex((x) => x.loadId === s.loadId) < this.states.indexOf(s as StatePost & { at: number });
  }

  /** Every load of `page`'s frames that has reported, oldest first. */
  loads(page: string): string[] {
    return [...new Set(this.states.filter((s) => s.page === page).map((s) => s.loadId))];
  }

  /** The loads values() reads now: the newest of each frame. A harness that opens a page waits for these to be new. */
  currentLoads(page: string): string[] {
    return this.latest(page).map((s) => s.loadId);
  }

  /** Every field of `page` as it reads now, across its frames, or null when the page never loaded. */
  readings(page: string): Record<string, FieldReading> | null {
    const frames = this.latest(page);
    if (frames.length === 0) return null;
    return Object.assign({}, ...frames.map((f) => f.fields)) as Record<string, FieldReading>;
  }

  /** Field values of `page` now. Throws when the page never loaded, so a missing page is never read as empty. */
  values(page: string): Record<string, string> {
    const r = this.readings(page);
    if (r === null) throw new Error(`the oracle has no state from page ${page}: it never loaded, or probe.js is not on it`);
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.value]));
  }

  /** Field values at the first reading of the newest load of each of `page`'s frames: what the page started with. */
  baseline(page: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of this.latest(page)) {
      const first = this.states.filter((s) => s.loadId === f.loadId).reduce((a, b) => (b.seq < a.seq ? b : a));
      for (const [k, v] of Object.entries(first.fields)) out[k] = v.value;
    }
    return out;
  }

  /** Fields of `page` whose value differs from its baseline though `asked` names no change to them. */
  unaskedChanges(page: string, asked: Readonly<Record<string, string>>): FieldChange[] {
    const now = this.values(page);
    const base = this.baseline(page);
    return Object.keys(now)
      .filter((k) => !(k in asked) && (base[k] ?? "") !== now[k])
      .map((k) => ({ field: k, from: base[k] ?? "", to: now[k] ?? "" }));
  }

  /** Fields named in `asked` whose value is not exactly what was asked. */
  unmet(page: string, asked: Readonly<Record<string, string>>): FieldChange[] {
    const now = this.values(page);
    return Object.entries(asked)
      .filter(([k, v]) => now[k] !== v)
      .map(([k, v]) => ({ field: k, from: v, to: now[k] ?? "(absent)" }));
  }

  /** Scores `page` against its expectations: a value, or "none" for a field nothing should fill. */
  score(page: string, expected: Readonly<Record<string, string>>): Scored {
    const now = this.values(page);
    const out: Scored = { right: [], wrong: [], missed: [], leftAlone: [], absent: [] };
    // An unticked checkbox reads "false", which is its empty state.
    const empty = (v: string): boolean => v === "" || v === "false";
    for (const [k, want] of Object.entries(expected)) {
      const got = now[k];
      if (got === undefined) out.absent.push(k);
      else if (want === "none" && empty(got)) out.leftAlone.push(k);
      else if (want === "none") out.wrong.push({ field: k, expected: want, actual: got });
      else if (got === want) out.right.push(k);
      else if (empty(got)) out.missed.push(k);
      else out.wrong.push({ field: k, expected: want, actual: got });
    }
    return out;
  }

  harnessPresses(): PressRecord[] {
    return this.presses.filter((p) => p.harness);
  }

  /** Every press the harness did not make: Caret's, a page script's, or a forged claim. */
  strayPresses(): PressRecord[] {
    return this.presses.filter((p) => !p.harness);
  }

  /** The four questions at once, for a report. */
  summary(): { submits: number; strayPresses: PressRecord[]; harnessPresses: number; offsite: OffsiteRecord[]; browserService: number; probeErrors: Oracle["probeErrors"] } {
    return { submits: this.submits.length, strayPresses: this.strayPresses(), harnessPresses: this.harnessPresses().length, offsite: this.offsite(), browserService: this.browserService().length, probeErrors: [...this.probeErrors] };
  }

  /** Resolves when `pred` holds, polling every 25 ms; throws with `what` after `ms`. */
  async waitFor(pred: () => boolean, what: string, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    for (;;) {
      try {
        if (pred()) return;
      } catch {
        /* not yet: a page that has not loaded throws from values() */
      }
      if (Date.now() > end) throw new Error(`oracle: ${what} did not happen within ${ms} ms`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

/**
 * Hosts headless Chrome for Testing reaches on its own whatever flags it gets (measured 2026-10-05 with
 * tasks/chrome.ts's flags: www.google.com, accounts.google.com, clients2.google.com, android.clients.google.com,
 * update.googleapis.com, content-autofill.googleapis.com). The proxy cannot tell who made a CONNECT, so requests to
 * these are filed apart: a request Caret made to one of them would be filed there too, and is not caught by offsite().
 */
export const BROWSER_SERVICE_HOSTS: readonly RegExp[] = [/(^|\.)google\.com$/, /(^|\.)googleapis\.com$/, /(^|\.)gstatic\.com$/, /(^|\.)gvt1\.com$/];

/** The host of a sink record's target: an absolute URL, or host:port for a CONNECT. */
export function targetHost(target: string): string {
  if (/^[a-z]+:\/\//i.test(target)) return new URL(target).hostname;
  return target.replace(/:\d+$/, "");
}

function isBrowserService(target: string): boolean {
  const host = targetHost(target);
  return BROWSER_SERVICE_HOSTS.some((re) => re.test(host));
}

/**
 * The network sink: an HTTP proxy on 127.0.0.1 that answers nothing and logs every request it gets. The test browser
 * is launched with `chromeFlags()`; Chrome sends loopback straight (its implicit proxy bypass), so the fixture's own
 * 127.0.0.1 origins never reach the sink and everything else does. HTTP requests are refused with 403; a CONNECT
 * (HTTPS, wss) is closed before any byte of TLS. Requests to other loopback ports bypass the proxy and are not seen.
 */
export class NetworkSink {
  private server: Server | null = null;
  /** CONNECT sockets the sink took over: node's HTTP connection tracking no longer covers them. */
  private readonly sockets = new Set<Socket>();
  port = 0;

  private readonly oracle: Oracle;
  private readonly makeServer: (listener: RequestListener) => Server;

  /** `makeServer`: tests inject a fake server; the eval uses node:http's. */
  constructor(oracle: Oracle, makeServer: (listener: RequestListener) => Server = createServer) {
    this.oracle = oracle;
    this.makeServer = makeServer;
  }

  async start(): Promise<void> {
    const s = this.makeServer((req, res) => {
      this.oracle.recordOffsite({ method: req.method ?? "?", target: req.url ?? "?" });
      res.writeHead(403, { connection: "close" }).end();
    });
    s.on("connect", (req, socket: Socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      // Chrome can reset a refused CONNECT before it closes (B1: ECONNRESET killed tasks-labelled); the sink still owns
      // the socket, so a transport error ends it here instead of escaping as an uncaught exception.
      socket.on("error", () => socket.destroy());
      this.oracle.recordOffsite({ method: "CONNECT", target: req.url ?? "?" });
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = s;
    this.port = (s.address() as AddressInfo).port;
  }

  chromeFlags(): string[] {
    if (this.port === 0) throw new Error("NetworkSink.chromeFlags before start()");
    return [`--proxy-server=http://127.0.0.1:${this.port}`];
  }

  async stop(): Promise<void> {
    const s = this.server;
    if (s === null) return;
    // CONNECT sockets are detached from the HTTP connection cleanup closeAllConnections does.
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
    this.server = null;
  }
}
