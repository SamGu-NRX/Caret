// Page snapshots into the fill path (W2). When focus moves in the tab the user is in, the worker says so (pageFocus,
// nothing about the element). If the reader reports that browser frontmost, this walks the tab, which puts the page
// window in the screen model, and hands the helper the same focus message the reader sends for a native field: the
// page window and the focused control's node. The helper then asks for a fill exactly as it does on a native focus
// (Helper.handleReader "focus"), so a form in Chrome is filled from the page engine, never from Accessibility.
//
// H10: each walk also tells the host which field has focus there and where it is on screen (pageField), because the
// host cannot see it: Chrome shows Accessibility no web content (evidence/host/h10/probe). The worker reports focus
// moving, focus leaving, a scroll or zoom while a control has focus, and another tab or window coming to the front, so
// the record follows the field. The helper's own focus message goes out only when the field changed: a scroll is no
// new focus, and must not ask for a fill again.
import { PROTOCOL_VERSION, type Focus, type PageField, type PageFieldText, type PageFocusMoved } from "../protocol.ts";
import type { ScreenModel } from "../model.ts";
import type { EngineSession } from "./session.ts";
import { pageWindowId } from "./windows.ts";
import { pageFieldText } from "./field-text.ts";
import { elementToken, screenRect } from "./page-link.ts";

export interface PageFocusOptions {
  model: ScreenModel;
  /** Hands the helper a focus message (Helper.handleReader). */
  focus: (m: Focus) => void;
  /** Tells consumers which page field has focus (H10); absent in tests that need only the helper's focus. */
  publish?: (m: PageField) => void;
  /** Tests and evals that play the user without a reader (Helper allowBackgroundFocus): walk whatever the browser's place. */
  allowBackground?: boolean;
  /**
   * P3: the active tab of the browser the user is in was walked, whether or not a field has focus: the page may have
   * just loaded (the content script reports a document that became ready as it reports focus). Helper.pageWalked.
   */
  walked?: (windowId: string) => void;
  warn: (line: string) => void;
}

export class PageFocus {
  private readonly opts: PageFocusOptions;
  /** Tabs being walked, and whether another report came meanwhile (then one more walk follows). */
  private readonly walking = new Map<string, boolean>();
  /** The last focus handed to the helper, per browser process: "windowId key". */
  private readonly lastFocus = new Map<number, string>();

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

  /** The host's record of the field the user is in on this tab: `key` null for none. */
  private tell(session: EngineSession, windowId: string, title: string, at: number, n: { key: string; role: string; editable: boolean; empty: boolean; frame: PageField["frame"]; look?: PageField["look"]; text?: PageFieldText; caret?: PageField["caret"]; token?: string; pageFocused?: boolean } | null): void {
    this.opts.publish?.({
      type: "pageField",
      v: PROTOCOL_VERSION,
      at,
      app: session.info.browser,
      windowId,
      title,
      key: n?.key ?? null,
      role: n?.role ?? "",
      editable: n?.editable ?? false,
      empty: n?.empty ?? true,
      frame: n?.frame ?? null,
      ...(n?.look === undefined ? {} : { look: n.look }),
      // H13: the text around the caret and the caret, for the host's inline text, when the page said anything about them
      // (a field from an extension before P4 reads as before). The server sends them only to a host that declared
      // pageText; nothing here logs them.
      ...(n?.text === undefined || (n.text.text === null && n.text.ownSuggestions === null && n.text.docsText === null) ? {} : n.text),
      ...(n?.caret === undefined || n.caret === null ? {} : { caret: n.caret }),
      ...(n?.token === undefined || n.text === undefined || n.text.text === null ? {} : { token: n.token }),
      ...(n?.pageFocused === undefined || n.text === undefined || n.text.text === null ? {} : { pageFocused: n.pageFocused }),
    });
  }

  private async walkAndFocus(session: EngineSession, tabId: number): Promise<void> {
    const a = await session.command({ kind: "pageWalk", tabId });
    const windowId = pageWindowId(session.info.engine, tabId);
    if (a.result.outcome !== "ok" || a.snapshot === null) {
      if (a.result.outcome !== "siteOff") this.opts.warn(`page focus: walking tab ${tabId} gave ${a.result.outcome}${a.result.detail === null ? "" : `: ${a.result.detail}`}`);
      // A tab Caret cannot read (a site it is off for, a page with no frame that answered) has no field of Caret's.
      this.lastFocus.delete(session.info.browser.pid);
      return this.tell(session, windowId, "", Date.now(), null);
    }
    // Only the active tab of the focused window counts: the worker sent the report for it, and the walk shows it still is.
    // A background window's selected tab is active too, so the window must be the one Chrome last focused (W3).
    if (!a.snapshot.active || !a.snapshot.inFocusedWindow) return;
    this.opts.walked?.(windowId);
    const w = this.opts.model.windows.get(windowId);
    const n = w === undefined || w.focusedKey === null ? undefined : w.nodes.get(w.focusedKey);
    const pid = session.info.browser.pid;
    if (w === undefined || n === undefined) {
      this.lastFocus.delete(pid);
      return this.tell(session, windowId, a.snapshot.title, a.snapshot.at, null);
    }
    // The field's look in screen points: the page's CSS pixels times its zoom, for a field of the top frame, which alone has
    // a screen frame (page-link screenRect).
    const f = a.snapshot.focused;
    const view = a.snapshot.view ?? null;
    const look = f?.look !== undefined && f.frameId === 0 && view !== null && n.frame !== undefined ? { inset: f.look.inset * view.zoom, fontSize: f.look.fontSize * view.zoom, placeholder: f.look.placeholder, dark: f.look.dark } : undefined;
    // H13: the caret on screen, for a field of the top frame only, which alone has a screen frame (page-link screenRect).
    const caret = f?.caret !== undefined && f.caret !== null && f.frameId === 0 && view !== null && n.frame !== undefined ? screenRect(view, f.caret) : null;
    const doc = f === null ? undefined : a.snapshot.frames.find((x) => x.frameId === f.frameId)?.documentId;
    const token = f === null || doc === undefined ? undefined : elementToken({ frameId: f.frameId, documentId: doc, id: f.id });
    this.tell(session, windowId, w.window.title, a.snapshot.at, { key: n.key, role: n.role, editable: n.editable === true, empty: (n.value ?? "") === "", frame: n.frame ?? null, ...(look === undefined ? {} : { look }), text: pageFieldText(a.snapshot), caret, ...(token === undefined ? {} : { token }), ...(f?.hasFocus === undefined ? {} : { pageFocused: f.hasFocus }) });
    const said = `${windowId} ${n.key}`;
    if (this.lastFocus.get(pid) === said) return;
    this.lastFocus.set(pid, said);
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
