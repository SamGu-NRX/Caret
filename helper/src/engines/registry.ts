// The helper's page engines (browser layer W1). Each extension instance, one per browser profile, is its own engine
// session with its own handshake and hello; a Helium instance and two Chrome profiles are three. The executor asks
// engineFor(windowId) through RoutedReaderLink (executor/means.ts) and otherwise does not change. When a session
// ends (the worker restarted, the browser quit, the bridge died), its windows close in the screen model and its
// window ids match nothing again, as the reader's do after readerRestarted(); the worker drops its grants itself.
import type { Snapshot, WindowClosed } from "../protocol.ts";
import { PROTOCOL_VERSION } from "../protocol.ts";
import type { EngineDirectory, ReaderLink } from "../executor/means.ts";
import { PageEngineLink } from "./page-link.ts";
import type { EngineSession } from "./session.ts";
import { pageWindowId, parsePageWindow } from "./windows.ts";

export interface RegistryHooks {
  /** Applies a page window's snapshot to the screen model (Helper.handleReader). */
  apply(m: Snapshot | WindowClosed): void;
}

export class EngineRegistry implements EngineDirectory {
  private readonly sessions = new Map<string, { session: EngineSession; link: PageEngineLink }>();
  private readonly hooks: RegistryHooks;
  private readonly waiters: { pred: (s: EngineSession) => boolean; resolve: (s: EngineSession) => void }[] = [];

  constructor(hooks: RegistryHooks) {
    this.hooks = hooks;
  }

  /** Takes a session once its handshake passed. Its hello may come later. */
  add(session: EngineSession): void {
    const link = new PageEngineLink(session, (s) => this.hooks.apply(s));
    this.sessions.set(session.info.engine, { session, link });
    void session.waitForHello(30_000).then((h) => {
      if (h === null) return;
      for (const w of [...this.waiters]) {
        if (!w.pred(session)) continue;
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(session);
      }
    });
  }

  /** Ends a session: pending commands fail, and every window it showed closes in the model. */
  remove(engine: string): void {
    const e = this.sessions.get(engine);
    if (e === undefined) return;
    this.sessions.delete(engine);
    e.session.close();
    for (const tabId of e.session.tabs.keys()) this.hooks.apply({ type: "windowClosed", v: PROTOCOL_VERSION, at: Date.now(), windowId: pageWindowId(engine, tabId) });
  }

  session(engine: string): EngineSession | undefined {
    return this.sessions.get(engine)?.session;
  }

  list(): EngineSession[] {
    return [...this.sessions.values()].map((e) => e.session);
  }

  engineFor(windowId: string): ReaderLink | null {
    const w = parsePageWindow(windowId);
    return w === null ? null : (this.sessions.get(w.engine)?.link ?? null);
  }

  *engines(): Iterable<ReaderLink> {
    for (const e of this.sessions.values()) yield e.link;
  }

  /** The first session with a hello that matches, now or later; rejects after `ms`. */
  waitForEngine(pred: (s: EngineSession) => boolean, ms: number): Promise<EngineSession> {
    const now = this.list().find((s) => s.hello !== null && pred(s));
    if (now !== undefined) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve: (s: EngineSession) => (clearTimeout(timer), resolve(s)) };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`no page engine said hello within ${ms} ms`));
      }, ms);
      this.waiters.push(w);
    });
  }
}
