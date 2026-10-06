// One page engine: one extension instance (one browser profile) behind one authenticated bridge connection. It
// sends page commands and matches each pageResult by id, keeping the pageSnapshot a walk sent before its result.
// A command with no answer within the timeout resolves as `error`, and the command carries the same deadline, so
// the engine refuses to act after the helper stopped waiting. Closing ends every pending command; the worker drops
// every grant when its port closes, so a new session starts with none.
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, type AppRef, type EngineMessage, type HelperToEngine, type PageFocusMoved, type PageHello, type PageInput, type PagePong, type PageResult, type PageSnapshot, type PageVerb, type ScopedActGrant } from "../protocol.ts";

export interface EngineInfo {
  /** The session id the helper issued at the handshake; part of every page window id. */
  engine: string;
  /** The browser that launched the bridge. */
  browser: AppRef;
  extensionId: string;
  bridgeVersion: string;
  connectedAt: number;
}

export interface CommandAnswer {
  result: PageResult;
  /** The snapshot a pageWalk sent before its result; null for every other verb. */
  snapshot: PageSnapshot | null;
}

/** Sessions wait this long for an answer. Assumed, not measured: the reader's own verbs wait 5 s. */
export const COMMAND_TIMEOUT_MS = 5000;

export class EngineSession {
  readonly info: EngineInfo;
  hello: PageHello | null = null;
  closed = false;
  /** The latest snapshot of each tab, as walked. */
  readonly tabs = new Map<number, PageSnapshot>();
  private readonly send: (m: HelperToEngine) => boolean;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, { resolve: (a: CommandAnswer) => void; snapshot: PageSnapshot | null; timer: NodeJS.Timeout }>();
  private readonly pongs = new Map<string, (p: PagePong | null) => void>();
  private readonly helloWaiters: ((h: PageHello | null) => void)[] = [];
  /** Called with every snapshot the engine sends, after `tabs` holds it. */
  onSnapshot: ((s: PageSnapshot, session: EngineSession) => void) | null = null;
  /** Called when focus moved in the tab the user is in (engines/page-focus.ts). */
  onFocus: ((m: PageFocusMoved, session: EngineSession) => void) | null = null;
  /** Called when the user pressed a key or a pointer in a frame under a live grant (W3; engines/wire.ts pauses tasks there). */
  onInput: ((m: PageInput, session: EngineSession) => void) | null = null;

  constructor(info: EngineInfo, send: (m: HelperToEngine) => boolean, timeoutMs = COMMAND_TIMEOUT_MS) {
    this.info = info;
    this.send = send;
    this.timeoutMs = timeoutMs;
  }

  private failed(id: string, detail: string): PageResult {
    return { type: "pageResult", v: PROTOCOL_VERSION, id, at: Date.now(), outcome: "error", detail };
  }

  command(verb: PageVerb, timeoutMs = this.timeoutMs): Promise<CommandAnswer> {
    return this.request((id, expires) => ({ type: "pageCommand", v: PROTOCOL_VERSION, id, expires, verb }), timeoutMs);
  }

  /**
   * P4: the text of the tab the user just left (PageReadText), answered by a pageResult whose `text` holds it. Only
   * engines/tab-source.ts calls this. The answer is the caller's alone: nothing here keeps it past resolving.
   */
  readText(tabId: number, timeoutMs = this.timeoutMs): Promise<PageResult> {
    return this.request((id, expires) => ({ type: "pageReadText", v: PROTOCOL_VERSION, id, expires, tabId }), timeoutMs).then((a) => a.result);
  }

  /** Sends one message the engine answers with a pageResult of the same id, and waits for that answer. */
  private request(message: (id: string, expires: number) => HelperToEngine, timeoutMs: number): Promise<CommandAnswer> {
    const id = randomUUID();
    return new Promise((resolve) => {
      if (this.closed) return resolve({ result: this.failed(id, "the engine is gone"), snapshot: null });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ result: this.failed(id, `no answer from the engine within ${timeoutMs} ms`), snapshot: null });
      }, timeoutMs);
      this.pending.set(id, { resolve, snapshot: null, timer });
      if (!this.send(message(id, Date.now() + timeoutMs))) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ result: this.failed(id, "the engine's connection is closed"), snapshot: null });
      }
    });
  }

  grant(g: ScopedActGrant): boolean {
    return this.send(g);
  }

  revoke(taskId: string): boolean {
    return this.send({ type: "actRevoke", v: PROTOCOL_VERSION, taskId, at: Date.now() });
  }

  /** "Not on this site": the whole list of origins Caret is off for, replacing the worker's. */
  sitesOff(origins: readonly string[]): boolean {
    return this.send({ type: "pageSitesOff", v: PROTOCOL_VERSION, origins: [...origins] });
  }

  /** The worker's answer to a ping, or null when none comes within the timeout or the engine closes. */
  ping(timeoutMs = this.timeoutMs): Promise<PagePong | null> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pongs.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pongs.set(id, (p) => {
        clearTimeout(timer);
        resolve(p);
      });
      if (!this.send({ type: "pagePing", v: PROTOCOL_VERSION, id })) this.pongs.get(id)?.(null);
    });
  }

  /** The worker's hello, now or when it comes; null if the engine closes or `ms` pass first. */
  waitForHello(ms: number): Promise<PageHello | null> {
    if (this.hello !== null || this.closed) return Promise.resolve(this.hello);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.helloWaiters.indexOf(done);
        if (i >= 0) this.helloWaiters.splice(i, 1);
        resolve(null);
      }, ms);
      const done = (h: PageHello | null): void => {
        clearTimeout(timer);
        resolve(h);
      };
      this.helloWaiters.push(done);
    });
  }

  /** One message from the engine, already validated against EngineMessage. Returns a problem to log, or null. */
  receive(m: EngineMessage): string | null {
    switch (m.type) {
      case "pageHello": {
        if (this.hello !== null) return "a second pageHello on one connection; ignored";
        if (m.extensionId !== this.info.extensionId) return `pageHello names extension ${m.extensionId}, the bridge was launched for ${this.info.extensionId}; ignored`;
        this.hello = m;
        for (const w of this.helloWaiters.splice(0)) w(m);
        return null;
      }
      case "pageSnapshot": {
        const p = this.pending.get(m.id);
        if (p === undefined) return `a snapshot for command ${m.id}, which nobody is waiting for`;
        p.snapshot = m;
        // P4 item 7: the text around the caret goes to the one waiting for this walk only; the tab's kept snapshot holds
        // none of it, so the field's text is not kept past the walk that read it (P4 review).
        const kept = withoutFieldText(m);
        this.tabs.set(m.tabId, kept);
        this.onSnapshot?.(kept, this);
        return null;
      }
      case "pageResult": {
        const p = this.pending.get(m.id);
        if (p === undefined) return `a result for command ${m.id}, which nobody is waiting for`;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        p.resolve({ result: m, snapshot: p.snapshot });
        return null;
      }
      case "pageFocus": {
        if (this.hello === null) return "a focus report before the engine's hello; ignored";
        this.onFocus?.(m, this);
        return null;
      }
      case "pageInput": {
        if (this.hello === null) return "user input before the engine's hello; ignored";
        this.onInput?.(m, this);
        return null;
      }
      case "pagePong": {
        const done = this.pongs.get(m.id);
        if (done === undefined) return `a pong for ping ${m.id}, which nobody sent`;
        this.pongs.delete(m.id);
        done(m);
        return null;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ result: this.failed(id, "the engine's connection closed"), snapshot: null });
    }
    this.pending.clear();
    for (const done of this.pongs.values()) done(null);
    this.pongs.clear();
    for (const w of this.helloWaiters.splice(0)) w(null);
  }
}

/**
 * A snapshot without the text around the caret (focused.text, docs.field), as a tab's last walk is kept. Only those
 * two go: whatever else a walk says about the focused field stays.
 */
export function withoutFieldText(s: PageSnapshot): PageSnapshot {
  let focused = s.focused;
  if (focused !== null && focused.text !== undefined) {
    const { text: _dropped, ...rest } = focused;
    focused = rest;
  }
  return { ...s, focused, ...(s.docs === undefined ? {} : { docs: { ...s.docs, field: null } }) };
}
