// The tab the user just left, as a fill source (P4). A webmail message or a note in another tab is where a form's
// values usually come from, and page walks carry controls only, so fill could never read it (H10 round 2). This reads
// that one tab's visible text, once, when a fill needs its source, and holds it for that fill only.
//
// The rules (brief P4), and where each holds:
//   1. One tab: the window the user was in just before they came to the form (ScreenModel.windowBefore, fill's own
//      source rule) must be a page window; the extension's worker then reads it only if it is also the tab it saw the
//      user leave (extension worker/left-tab.ts).
//   2. Recent and unchanged: here, within LEFT_TAB_MS of the user leaving it by the model's focus history and by the
//      worker's clock; there, only while its frames hold the documents and navigation generations they held then.
//   3. On demand: one pageReadText per fill that needs it, and only from fill (helper.ts fill). Nothing is read otherwise.
//   4. What is read: the extension decides, before the text leaves the frame (content/text.ts); the schema checks the cap.
//   5. Never from an excluded site: the worker never asks such a frame; here, a read naming a frame on a site the user
//      turned Caret off for since is dropped whole.
//   6. Short-lived: the text is never put in the model. It is static text of the tab's window only in the view fill
//      reads (ScreenModel.withNodes), until LEFT_TAB_MS after the user left the tab or the fill's offer ends, whichever
//      is first. Then it is dropped, with the privacy ledger's tables, which kept the lines it was asked about. Nothing
//      here writes it to disk or a log; counts name outcomes only.
//   7. The same ledger: fill takes these nodes through the SnippetLedger like any window's text, and they are another
//      tab's, never the form's own.
import { LEFT_TAB_MS, PAGE_SUBROLE, type Node, type PageResult, type PageTabText } from "../protocol.ts";
import type { ScreenModel } from "../model.ts";
import { forgetWindows } from "../privacy.ts";
import { parsePageWindow } from "./windows.ts";
import type { EngineSession } from "./session.ts";

/** What TabSource needs from the page engines. */
export interface TabReader {
  /** Reads the tab a page window shows (EngineSession.readText); null when no live engine has that window. */
  readText(windowId: string): Promise<PageResult | null>;
  /** "Not on this site" as the helper holds it now (EngineRegistry.sitesOff). */
  sitesOff(): readonly string[];
  /** The page window's document as its last walk saw it (EngineRegistry.documentOf); null when no engine walked it. */
  documentOf(windowId: string): string | null;
}

/** Why a fill got no text from the tab just left, for counts: never any of the page's text. */
export type Refusal = "notAPage" | "notLeft" | "tooLong" | "noEngine" | "refused" | "siteOff" | "moved";

/** Thrown into a fill that is still asking Jev after the text it read was dropped (rule 6); the fill then ends quietly. */
export class TabTextExpired extends Error {
  constructor() {
    super("the text of the tab you left is no longer held");
  }
}

interface Held {
  windowId: string;
  title: string;
  nodes: Node[];
  /** Every frame's origin the text came from: a site turned off later drops it (rule 5). */
  origins: string[];
  /** The tab's document as the helper's last walk of it saw it when it was read: another one drops it. */
  document: string | null;
  /** When it is dropped whatever holds it: LEFT_TAB_MS after the user left the tab. */
  until: number;
  /** The fill, and then the offers, it was read for; only they see it, and it is dropped when the last lets go. */
  owners: Set<string>;
  timer: NodeJS.Timeout;
}

export interface TabSourceOptions {
  model: ScreenModel;
  reader: TabReader;
  now: () => number;
  /** Counts an outcome by name (Store.count). */
  count: (metric: string) => void;
  /**
   * Told when held text is dropped, with every owner that held it (the fill and the offers it made), so what was made
   * from it is checked again or let go (Helper.tabTextDropped).
   */
  dropped: (windowId: string, owners: readonly string[]) => void;
}

/** The static-text nodes a read becomes: the selection's paragraphs first, then the main region's, under the top frame. */
export function readNodes(t: PageTabText, hasTopFrame: boolean): Node[] {
  const node = (key: string, value: string): Node => ({ key, parent: hasTopFrame ? "f0" : null, role: "AXStaticText", subrole: PAGE_SUBROLE.readOnDemand, value });
  return [...t.selection.map((v, i) => node(`f0/read~s${i}`, v)), ...t.blocks.map((v, i) => node(`f0/read~b${i}`, v))];
}

export class TabSource {
  private readonly opts: TabSourceOptions;
  private held: Held | null = null;

  constructor(opts: TabSourceOptions) {
    this.opts = opts;
  }

  /**
   * Reads the tab the user left for the form in `formWindowId` and holds its text for `owner`, when rules 1, 2 and 5
   * allow; otherwise reads nothing. Every fill reads afresh: text read for another fill is never handed on, since the
   * site may have been turned off or the tab may have moved since. Returns the page window read, or why not.
   */
  async readFor(formWindowId: string, owner: string): Promise<{ windowId: string } | { refused: Refusal }> {
    const r = await this.read(formWindowId, owner);
    this.opts.count("refused" in r ? `tabtext.refused_${r.refused}` : "tabtext.read");
    return r;
  }

  private async read(formWindowId: string, owner: string): Promise<{ windowId: string } | { refused: Refusal }> {
    const { model, reader } = this.opts;
    const left = model.windowBefore(formWindowId);
    if (left === null || parsePageWindow(left) === null) return { refused: "notAPage" };
    const leftAt = model.leftAt(left);
    if (leftAt === null) return { refused: "notLeft" };
    if (this.opts.now() - leftAt > LEFT_TAB_MS) return { refused: "tooLong" };
    const document = reader.documentOf(left);
    const res = await reader.readText(left);
    if (res === null) return { refused: "noEngine" };
    if (res.outcome !== "ok" || res.text === undefined) return { refused: res.outcome === "siteOff" ? "siteOff" : "refused" };
    const t = res.text;
    const now = this.opts.now();
    // Rule 5 again: the user may have turned Caret off for one of its sites while it was read.
    const off = new Set(reader.sitesOff());
    if (t.frames.some((f) => off.has(f.origin))) return { refused: "siteOff" };
    // Rule 1 again: the user may have moved on while it was read; rule 2 by the worker's clock too.
    if (model.windowBefore(formWindowId) !== left || model.leftAt(left) !== leftAt || reader.documentOf(left) !== document) return { refused: "moved" };
    const until = Math.min(leftAt, t.leftAt) + LEFT_TAB_MS;
    if (now >= until) return { refused: "tooLong" };
    // A view can only add nodes to a window the model has; one that closed while it was read is not brought back.
    const w = model.windows.get(left);
    if (w === undefined) return { refused: "moved" };
    // Rule 1: one tab. Whatever another fill held is dropped first.
    this.drop();
    const timer = setTimeout(() => this.drop(), until - now);
    timer.unref();
    this.held = { windowId: left, title: t.title, nodes: readNodes(t, w.nodes.has("f0")), origins: t.frames.map((f) => f.origin), document, until, owners: new Set([owner]), timer };
    return { windowId: left };
  }

  /**
   * The model as `owner` (a fill, or the offer it made) reads it: with the text it read as static text of its tab's
   * window while that text is held for it, the model itself otherwise. Another fill never sees it (P4 review: a fill
   * refused a read was given the text another fill held). Built anew for each use, so it never outlives the text.
   */
  viewFor(owner: string): ScreenModel {
    const h = this.live();
    if (h === null || !h.owners.has(owner)) return this.opts.model;
    return this.opts.model.withNodes(new Map([[h.windowId, { nodes: h.nodes, title: h.title === "" ? null : h.title }]]));
  }

  /** Whether `owner` still holds text it read. */
  holds(owner: string): boolean {
    return this.live()?.owners.has(owner) === true;
  }

  /** The page window whose text is held now, if any. */
  holding(): string | null {
    return this.live()?.windowId ?? null;
  }

  /** `to` holds the text `from` holds (a fill's offer, once published, holds what the fill read). */
  pass(from: string, to: string): void {
    if (this.held?.owners.has(from) === true) this.held.owners.add(to);
  }

  /** `owner` (a fill, or the offer it made) is over; the text goes when nothing holds it. */
  release(owner: string): void {
    const h = this.held;
    if (h === null || !h.owners.delete(owner)) return;
    if (h.owners.size === 0) this.drop();
  }

  /**
   * The held text, after dropping it if it may no longer be kept: its time ran out (its timer does the same; this
   * covers a clock the helper was given), one of its sites was turned off, the helper saw its tab hold another
   * document, or its window closed (P4 review: held text outlived a site turned off).
   */
  private live(): Held | null {
    const h = this.held;
    if (h === null) return null;
    const off = new Set(this.opts.reader.sitesOff());
    const stale =
      this.opts.now() >= h.until || h.origins.some((o) => off.has(o)) || this.opts.reader.documentOf(h.windowId) !== h.document || !this.opts.model.windows.has(h.windowId);
    if (stale) this.drop();
    return this.held;
  }

  /** Drops the held text now, whoever holds it (a new reader session, a helper shutdown, or it may no longer be kept). */
  drop(): void {
    const h = this.held;
    if (h === null) return;
    this.held = null;
    clearTimeout(h.timer);
    // The privacy ledger keeps one line table per window id, holding the lines it was asked about, and caches which
    // texts each window holds; both were filled from this view, so they go with it. They are rebuilt from the model.
    forgetWindows();
    // Later, not here: a drop can come from inside a recheck that reads the view, which must finish first.
    const owners = [...h.owners];
    queueMicrotask(() => this.opts.dropped(h.windowId, owners));
  }
}

/**
 * How long a fill waits for the read. The worker gives each frame 1.5 s (worker.ts FRAME_WALK_MS) and reads them in
 * parallel; a fill that waits longer than this goes on without the tab. Assumed, not measured.
 */
export const READ_TIMEOUT_MS = 2500;

/** The page engines as TabSource reads them: the live session that shows a page window, and "Not on this site". */
export function pageTabReader(registry: { session(engine: string): EngineSession | undefined; sitesOff(): readonly string[]; documentOf(windowId: string): string | null }): TabReader {
  return {
    readText: async (windowId) => {
      const w = parsePageWindow(windowId);
      const s = w === null ? undefined : registry.session(w.engine);
      if (w === null || s === undefined || s.closed || s.hello === null) return null;
      return s.readText(w.tabId, READ_TIMEOUT_MS);
    },
    sitesOff: () => registry.sitesOff(),
    documentOf: (windowId) => registry.documentOf(windowId),
  };
}
