// The helper's page engines (browser layer W1). Each extension instance, one per browser profile, is its own engine
// session with its own handshake and hello; a Helium instance and two Chrome profiles are three. The executor asks
// engineFor(windowId) through RoutedReaderLink (executor/means.ts) and otherwise does not change. When a session
// ends (the worker restarted, the browser quit, the bridge died), its windows close in the screen model and its
// window ids match nothing again, as the reader's do after readerRestarted(); the worker drops its grants itself.
import type { PageExclusion, Snapshot, WindowClosed } from "../protocol.ts";
import { PROTOCOL_VERSION } from "../protocol.ts";
import type { EngineDirectory, ReaderLink } from "../executor/means.ts";
import { PageEngineLink, topFrameOn, type VerbTiming } from "./page-link.ts";
import type { EngineSession } from "./session.ts";
import { pageWindowId, parsePageWindow } from "./windows.ts";
import { noteSwitchedOff } from "../privacy/read-policy.ts";

export interface RegistryHooks {
  /** Applies a page window's snapshot to the screen model (Helper.handleReader). */
  apply(m: Snapshot | WindowClosed): void;
  /**
   * Replaces a page window's text in the screen model when a site was switched off (Helper.purgeWindow), before anything
   * else hears of it, and as no window close or change: no pattern, offer or task handler reads what it removes.
   */
  purge(s: Snapshot): void;
  /** Told each page command's timing (P1: page-link.ts VerbTiming). */
  onTiming?(t: VerbTiming): void;
}

/** Told when a session says hello and when it ends (engines/wire.ts: page focus and the presence signal). */
export interface SessionListener {
  onHello(s: EngineSession): void;
  onRemove(s: EngineSession): void;
}

export class EngineRegistry implements EngineDirectory {
  private readonly sessions = new Map<string, { session: EngineSession; link: PageEngineLink }>();
  private readonly hooks: RegistryHooks;
  private readonly waiters: { pred: (s: EngineSession) => boolean; resolve: (s: EngineSession) => void }[] = [];
  private readonly listeners = new Set<SessionListener>();
  /** "Not on this site", as the helper last set it; every engine gets it after its hello and on each change. */
  private offSites: readonly string[] = [];

  constructor(hooks: RegistryHooks) {
    this.hooks = hooks;
  }

  /** Takes a session once its handshake passed. Its hello may come later. */
  add(session: EngineSession): void {
    const link = new PageEngineLink(session, (s) => this.hooks.apply(s), this.hooks.onTiming === undefined ? null : (t) => this.hooks.onTiming?.(t));
    this.sessions.set(session.info.engine, { session, link });
    void session.waitForHello(30_000).then((h) => {
      if (h === null) return;
      session.sitesOff(this.offSites);
      for (const l of this.listeners) l.onHello(session);
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
    for (const l of this.listeners) l.onRemove(e.session);
    for (const tabId of e.session.tabs.keys()) this.hooks.apply({ type: "windowClosed", v: PROTOCOL_VERSION, at: Date.now(), windowId: pageWindowId(engine, tabId) });
  }

  listen(l: SessionListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /**
   * Sets "Not on this site" and sends it to every engine that has said hello. When a site is newly off (PV2 review and
   * re-review): every request built before now is refused when sent (privacy/read-policy.ts noteSwitchedOff), and each
   * tab showing that site is purged first, its text replaced from its last walk without that site's frames (nothing at
   * all when its top frame is that site's), by the purge hook, never as a window close.
   */
  setSitesOff(origins: readonly string[]): void {
    const before = new Set(this.offSites);
    this.offSites = [...new Set(origins)].sort();
    const now = this.offSites.filter((o) => !before.has(o));
    if (now.length > 0) noteSwitchedOff();
    for (const e of this.sessions.values()) {
      // The engine's session filters every later walk by the new list, so it takes it before the purge reads one again.
      e.session.offSites = new Set(this.offSites);
      for (const tab of e.session.tabs.values()) if (tab.frames.some((f) => now.includes(f.origin))) this.hooks.purge(e.link.readAgain(tab));
      if (e.session.hello !== null) e.session.sitesOff(this.offSites);
    }
  }

  sitesOff(): readonly string[] {
    return this.offSites;
  }

  /** The session with a hello whose browser is this process, or undefined. */
  forBrowser(pid: number): EngineSession | undefined {
    return this.list().find((s) => s.hello !== null && !s.closed && s.info.browser.pid === pid);
  }

  session(engine: string): EngineSession | undefined {
    return this.sessions.get(engine)?.session;
  }

  list(): EngineSession[] {
    return [...this.sessions.values()].map((e) => e.session);
  }

  /**
   * A page window's document generation as its last walk saw it: each frame's document and navigation, so a reload or a
   * navigation of any frame changes it (D2-06: a goal plan made before one is another page's). Null for a native
   * window, or a tab no live engine has walked.
   */
  documentOf(windowId: string): string | null {
    const w = parsePageWindow(windowId);
    const tab = w === null ? undefined : this.sessions.get(w.engine)?.session.tabs.get(w.tabId);
    return tab === undefined ? null : tab.frames.map((f) => `${f.frameId}:${f.documentId}:${f.navGen}`).join("|");
  }

  /**
   * S1: where a page window is, as its last walk saw it: the top frame's origin and path (no query or fragment; the
   * walker drops them), and the h1 and h2 headings of every frame. Null for a native window or a tab no engine walked.
   * P3: and what the walk left out, by count over every frame (a password or card field), for the check before a page
   * load's Fill all asks Jev (offers/ready-on-load.ts).
   */
  contextOf(windowId: string): { site: string | null; headings: string[]; excluded: Partial<Record<PageExclusion, number>> } | null {
    const w = parsePageWindow(windowId);
    const tab = w === null ? undefined : this.sessions.get(w.engine)?.session.tabs.get(w.tabId);
    if (tab === undefined) return null;
    const top = tab.frames.find((f) => f.parentFrameId < 0);
    // SC1 2a: nothing of a tab whose top frame is at a site switched off or unreported, and no heading of a frame at a
    // site switched off (PV2 review and re-review).
    const off = new Set(this.offSites);
    if (top === undefined || !topFrameOn(tab, off)) return null;
    const frames = tab.frames.filter((f) => !off.has(f.origin));
    const site = top === undefined || top.origin === "null" ? null : `${top.origin}${top.path}`;
    const excluded: Partial<Record<PageExclusion, number>> = {};
    for (const f of frames) for (const [k, n] of Object.entries(f.excluded) as [PageExclusion, number][]) excluded[k] = (excluded[k] ?? 0) + n;
    return { site, headings: frames.flatMap((f) => f.headings), excluded };
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
