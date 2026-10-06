// Page snapshots into the fill path (W2). When focus moves in the tab the user is in, the worker says so (pageFocus,
// nothing about the element). If the reader reports that browser frontmost, this walks the tab, which puts the page
// window in the screen model, and hands the helper the same focus message the reader sends for a native field: the
// page window and the focused control's node. The helper then asks for a fill exactly as it does on a native focus
// (Helper.handleReader "focus"), so a form in Chrome is filled from the page engine, never from Accessibility.
import { PROTOCOL_VERSION, type Focus, type PageFocusMoved } from "../protocol.ts";
import type { ScreenModel } from "../model.ts";
import type { EngineSession } from "./session.ts";
import { pageWindowId } from "./windows.ts";

export interface PageFocusOptions {
  model: ScreenModel;
  /** Hands the helper a focus message (Helper.handleReader). */
  focus: (m: Focus) => void;
  /** Tests and evals that play the user without a reader (Helper allowBackgroundFocus): walk whatever the browser's place. */
  allowBackground?: boolean;
  warn: (line: string) => void;
}

export class PageFocus {
  private readonly opts: PageFocusOptions;
  /** Tabs being walked, and whether another report came meanwhile (then one more walk follows). */
  private readonly walking = new Map<string, boolean>();

  constructor(opts: PageFocusOptions) {
    this.opts = opts;
  }

  /** Starts listening to a session's focus reports. */
  attach(session: EngineSession): void {
    session.onFocus = (m) => void this.moved(m, session);
  }

  /** The browser of `session` is where the user is: the reader reported it frontmost. */
  private inFront(session: EngineSession): boolean {
    return this.opts.model.frontmostPid === session.info.browser.pid;
  }

  async moved(m: PageFocusMoved, session: EngineSession): Promise<void> {
    if (!this.inFront(session) && this.opts.allowBackground !== true) return;
    const k = `${session.info.engine}:${m.tabId}`;
    if (this.walking.has(k)) {
      this.walking.set(k, true);
      return;
    }
    this.walking.set(k, false);
    try {
      do {
        this.walking.set(k, false);
        await this.walkAndFocus(session, m.tabId);
      } while (this.walking.get(k) === true && !session.closed);
    } finally {
      this.walking.delete(k);
    }
  }

  private async walkAndFocus(session: EngineSession, tabId: number): Promise<void> {
    const a = await session.command({ kind: "pageWalk", tabId });
    if (a.result.outcome !== "ok" || a.snapshot === null) {
      if (a.result.outcome !== "siteOff") this.opts.warn(`page focus: walking tab ${tabId} gave ${a.result.outcome}${a.result.detail === null ? "" : `: ${a.result.detail}`}`);
      return;
    }
    // Only the active tab of the focused window counts: the worker sent the report for it, and the walk shows it still is.
    // A background window's selected tab is active too, so the window must be the one Chrome last focused (W3).
    if (!a.snapshot.active || !a.snapshot.inFocusedWindow) return;
    const windowId = pageWindowId(session.info.engine, tabId);
    const w = this.opts.model.windows.get(windowId);
    if (w === undefined || w.focusedKey === null) return;
    const n = w.nodes.get(w.focusedKey);
    if (n === undefined) return;
    this.opts.focus({
      type: "focus",
      v: PROTOCOL_VERSION,
      at: a.snapshot.at,
      app: session.info.browser,
      windowId,
      key: n.key,
      role: n.role,
      editable: n.editable === true,
      empty: (n.value ?? "") === "",
      frontmost: this.inFront(session),
    });
  }
}
