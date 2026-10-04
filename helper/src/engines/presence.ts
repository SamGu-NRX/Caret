// The host's signal for "Caret can't see this page yet" (memo section 6; the line itself is built on v2/host). The
// helper says `missing` when the reader reports a Chromium browser frontmost, the user has typed in it since it came
// to the front, and no page engine is connected for that browser process; `connected` when an engine for it says
// hello. One message per change of state per browser process (protocol.ts PageEngineState).
//
// "Typed in it" is a key the reader saw in that process (userInput, which the reader sends only while it watches
// input) or the reader's focus on an editable element there, which is the signal it sends all the time. The memo
// asks for a few seconds of real key input; the reader cannot report that outside a watch, so focus stands in.
import { PROTOCOL_VERSION, type AppRef, type PageEngineState, type ReaderMessage } from "../protocol.ts";

/**
 * Bundle ids of browsers that can run Caret for Chrome: Chrome's channels and Chrome for Testing, Chromium, Helium,
 * Brave, Edge, Vivaldi, Arc and Opera. A prefix match, so a channel suffix (".beta", ".canary") counts.
 */
const CHROMIUM_BROWSERS = [
  "com.google.Chrome", "com.google.chrome.for.testing", "org.chromium.Chromium", "net.imput.helium", "com.brave.Browser",
  "com.microsoft.edgemac", "com.vivaldi.Vivaldi", "company.thebrowser.Browser", "com.operasoftware.Opera",
];

export function isChromiumBrowser(bundleId: string): boolean {
  const id = bundleId.toLowerCase();
  return CHROMIUM_BROWSERS.some((p) => id === p.toLowerCase() || id.startsWith(`${p.toLowerCase()}.`));
}

export interface PresenceOptions {
  publish: (m: PageEngineState) => void;
  /** Whether a page engine with a hello is connected for this browser process. */
  hasEngine: (pid: number) => boolean;
  now?: () => number;
}

export class BrowserPresence {
  private readonly opts: PresenceOptions;
  private front: AppRef | null = null;
  private typed = false;
  /** The last state published for each browser process. */
  private readonly said = new Map<number, PageEngineState["state"]>();

  constructor(opts: PresenceOptions) {
    this.opts = opts;
  }

  private say(browser: AppRef, state: PageEngineState["state"]): void {
    if (this.said.get(browser.pid) === state) return;
    this.said.set(browser.pid, state);
    this.opts.publish({ type: "pageEngine", v: PROTOCOL_VERSION, at: (this.opts.now ?? Date.now)(), browser, state });
  }

  private check(): void {
    const f = this.front;
    if (f === null || !this.typed || !isChromiumBrowser(f.bundleId) || this.opts.hasEngine(f.pid)) return;
    this.say(f, "missing");
  }

  /** Every reader message, before the helper handles it. */
  onReader(m: ReaderMessage): void {
    switch (m.type) {
      case "hello":
        this.front = null;
        this.typed = false;
        return;
      case "appSwitch":
        if (this.front?.pid !== m.to.pid) this.typed = false;
        this.front = m.to;
        return;
      case "focus":
        // A page window's focus comes from the page engine (page-focus.ts), which is connected by definition.
        if (!m.frontmost || m.windowId.startsWith("page:")) return;
        if (this.front?.pid !== m.app.pid) {
          this.front = m.app;
          this.typed = false;
        }
        if (m.editable) {
          this.typed = true;
          this.check();
        }
        return;
      case "userInput":
        if (m.kind !== "key" || this.front?.pid !== m.pid) return;
        this.typed = true;
        this.check();
        return;
      default:
        return;
    }
  }

  /** An engine said hello for this browser. */
  engineConnected(browser: AppRef): void {
    if (isChromiumBrowser(browser.bundleId)) this.say(browser, "connected");
  }

  /** An engine for this browser went away: the next typing in it may say `missing` again. */
  engineGone(browser: AppRef): void {
    if (this.said.get(browser.pid) === "connected") this.said.delete(browser.pid);
  }
}
