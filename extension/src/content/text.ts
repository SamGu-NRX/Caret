// The visible text of one frame, read once when the worker asks for the tab the user just left (P4, brief rule 4).
// Nothing here runs on its own: no observer, no timer. content.ts calls readFrameText on the worker's one-shot message.
//
// What is read, and why each exclusion is decided here, before anything leaves the frame:
//   - Only the page's main region: the first rendered `main` or `[role=main]`, else `body`. A mailbox's message list,
//     a site's navigation and its footer are not the note or message the user was reading.
//   - Only text a person could see. A subtree is skipped when it is not rendered, transparent, aria-hidden or inert,
//     clipped to nothing, cut to a pixel by its own overflow (the visually-hidden pattern), placed wholly outside what
//     the document (or the scrolling box it is in) can scroll to, or wholly outside the box of an ancestor that clips
//     its overflow. The main region's
//     own ancestors are held to the same rules before it is read (P4 review: a main inside an aria-hidden wrapper). Text that only assistive technology or a script was meant to get is not the
//     user's to copy, and a page can hide a "helpful" line there (the same reason the walker never reads hidden fields).
//   - No form control and nothing inside one: inputs (password and hidden among them), selects, textareas, buttons,
//     ARIA widgets and editable regions. The walk already reads controls under its own rules, and an editable region is
//     the user's own draft, not a source. Links stay: an address or a phone number on a page is usually one.
//   - Frames are each read by their own script; this reads no iframe. The worker keeps only frames it can show are
//     visible (worker/compose.ts).
//   - A selection the user made in this document is read first, under the same exclusions.
//   - Capped at TAB_TEXT_BYTES, cut between paragraphs (shared/tab-text.ts).
//
// Google Docs and Sheets (brief item 6) draw their text on a canvas, so their main region holds none of it. When the
// user has turned on screen reader and braille support there, the document's own text is also kept for assistive
// technology, off screen: in Docs the body of the text-event iframe, in Sheets an off-screen textbox. That text is the
// document itself, rendered for assistive technology at the user's choice: the same text a native app's
// Accessibility tree gives the reader. It is read only on these pages, under the same rules and cap, and only when it
// is there. Caret never turns those settings on and presses no key in the page; when the text is absent the read says
// docsText "off", so the host can tell the user how to turn it on rather than find nothing silently.
import { TAB_TEXT_BYTES, capFrame, utf8Bytes, type FrameText } from "../shared/tab-text.ts";
import { clipBox, clipsToNothing, shadowRootOf } from "./walker.ts";
import { composedParent } from "./names.ts";

/** Elements whose content is never page text a person reads. */
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "LINK", "IFRAME", "FRAME", "FRAMESET", "OBJECT", "EMBED",
  "CANVAS", "SVG", "VIDEO", "AUDIO", "IMG", "PICTURE", "SOURCE", "TRACK", "MAP", "AREA", "INPUT", "SELECT", "TEXTAREA", "BUTTON",
  "OPTION", "OPTGROUP", "DATALIST", "OUTPUT", "METER", "PROGRESS", "DIALOG",
]);

/** ARIA widgets: the walker reads them as controls (or they hold the user's input), so their text is not page text. */
const WIDGET_ROLES = new Set([
  "button", "checkbox", "radio", "switch", "combobox", "textbox", "searchbox", "spinbutton", "slider", "listbox", "option",
  "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "tree", "treeitem", "grid", "gridcell", "dialog", "alertdialog",
]);

/** Elements visited before the read stops, whatever it found. Assumed: well over a long message's DOM, well under a mailbox's. */
const MAX_ELEMENTS = 40_000;

/** Why an element's whole subtree is not read, or null. `cs` is its computed style. */
function skipped(el: Element, cs: CSSStyleDeclaration): boolean {
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
  const role = el.getAttribute("role");
  if (role !== null && WIDGET_ROLES.has(role.trim().toLowerCase())) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("inert") || (el instanceof HTMLElement && el.hidden)) return true;
  if (cs.display === "none" || cs.contentVisibility === "hidden") return true;
  // display: contents has no box of its own; its children are judged by theirs.
  if (cs.display === "contents") return false;
  if (Number.parseFloat(cs.opacity) === 0) return true;
  if (clipsToNothing(cs, ...clipBox(el))) return true;
  // The body's overflow is the viewport's (CSS propagates it), so it hides nothing of its own.
  if (el === el.ownerDocument.body) return false;
  const r = el.getBoundingClientRect();
  const clips = (v: string): boolean => v === "hidden" || v === "clip";
  return (clips(cs.overflowX) || clips(cs.overflowY)) && (r.width <= 1 || r.height <= 1);
}

type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * Where a person can see or scroll to, in viewport coordinates, for what is inside the document at large: the whole
 * area the document scrolls over.
 */
function documentReach(): Box {
  const d = document.documentElement;
  return { x0: -window.scrollX, y0: -window.scrollY, x1: Math.max(d.scrollWidth, window.innerWidth) - window.scrollX, y1: Math.max(d.scrollHeight, window.innerHeight) - window.scrollY };
}

/** `reach` as `el` leaves it for its descendants: on an axis it scrolls, the area it scrolls over. */
function reachIn(el: Element, cs: CSSStyleDeclaration, reach: Box): Box {
  if (el === el.ownerDocument.body) return reach;
  const scrolls = (v: string): boolean => v === "auto" || v === "scroll" || v === "overlay";
  if (!scrolls(cs.overflowX) && !scrolls(cs.overflowY)) return reach;
  const r = el.getBoundingClientRect();
  const x0 = r.left - el.scrollLeft;
  const y0 = r.top - el.scrollTop;
  return {
    x0: scrolls(cs.overflowX) ? x0 : reach.x0,
    x1: scrolls(cs.overflowX) ? x0 + el.scrollWidth : reach.x1,
    y0: scrolls(cs.overflowY) ? y0 : reach.y0,
    y1: scrolls(cs.overflowY) ? y0 + el.scrollHeight : reach.y1,
  };
}

const outside = (r: DOMRect, b: Box): boolean => r.right <= b.x0 || r.left >= b.x1 || r.bottom <= b.y0 || r.top >= b.y1;

/**
 * What `el`'s ancestors make of it, folded from the outermost in, exactly as the traversal folds them: hidden when an
 * ancestor would have been skipped (skipped(): not rendered, transparent, aria-hidden, a control or editable region,
 * a 1 px overflow box) or lies wholly outside what its own ancestors leave visible or reachable; else the clip and the
 * reachable area `el` starts with. So a main region gets the same rules from above as any element gets in the walk
 * (P4 review: a main under a hidden or tiny wrapper, or in an off-screen scroller).
 */
function ancestry(el: Element): { hidden: true } | { hidden: false; clip: Box | null; reach: Box } {
  const chain: Element[] = [];
  for (let p = composedParent(el); p !== null && p !== document.documentElement; p = composedParent(p)) chain.unshift(p);
  let clip: Box | null = null;
  let reach = documentReach();
  for (const p of chain) {
    const cs = getComputedStyle(p);
    if (skipped(p, cs)) return { hidden: true };
    if (cs.display !== "contents") {
      const r = p.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && ((clip !== null && outside(r, clip)) || outside(r, reach))) return { hidden: true };
    }
    clip = clipBy(p, cs, clip);
    reach = reachIn(p, cs, reach);
  }
  return { hidden: false, clip, reach };
}

/**
 * `clip` as `el` leaves it for its descendants, on each axis: narrowed to its box where it cuts off its overflow, and
 * lifted where it scrolls, since the user can scroll to anything a scrolling box holds (whether the scroller itself
 * shows is judged when it is visited). The walker's visible() reads a scroller the same way.
 */
function clipBy(el: Element, cs: CSSStyleDeclaration, clip: Box | null): Box | null {
  // The body's overflow is the viewport's (CSS propagates it): what it holds is bounded by what the document scrolls over.
  if (el === el.ownerDocument.body) return clip;
  const cuts = (v: string): boolean => v === "hidden" || v === "clip";
  const scrolls = (v: string): boolean => v === "auto" || v === "scroll" || v === "overlay";
  if (!cuts(cs.overflowX) && !cuts(cs.overflowY) && (clip === null || (!scrolls(cs.overflowX) && !scrolls(cs.overflowY)))) return clip;
  const r = el.getBoundingClientRect();
  const c = clip ?? { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity };
  const axis = (v: string, lo: number, hi: number, boxLo: number, boxHi: number): [number, number] =>
    cuts(v) ? [Math.max(lo, boxLo), Math.min(hi, boxHi)] : scrolls(v) ? [-Infinity, Infinity] : [lo, hi];
  const [x0, x1] = axis(cs.overflowX, c.x0, c.x1, r.left, r.right);
  const [y0, y1] = axis(cs.overflowY, c.y0, c.y1, r.top, r.bottom);
  return x0 === -Infinity && y0 === -Infinity && x1 === Infinity && y1 === Infinity ? null : { x0, y0, x1, y1 };
}

/** Paragraphs as a reader sees them: a block-level box starts one, a line break breaks a line, a table cell is tab-separated. */
class Paragraphs {
  readonly out: string[] = [];
  private cur = "";
  bytes = 0;

  text(s: string, pre: boolean): void {
    if (s === "") return;
    if (pre) {
      this.cur += s.replace(/\r\n?/g, "\n");
      return;
    }
    const t = s.replace(/[\t\n\r\f ]+/g, " ");
    if (t === " " && (this.cur === "" || /[\s]$/.test(this.cur))) return;
    this.cur += /[\s]$/.test(this.cur) && t.startsWith(" ") ? t.slice(1) : t;
  }

  space(): void {
    if (this.cur !== "" && !/\s$/.test(this.cur)) this.cur += " ";
  }

  newline(): void {
    this.cur = `${this.cur.replace(/[ \t]+$/, "")}\n`;
  }

  cell(): void {
    if (this.cur !== "" && !this.cur.endsWith("\n")) this.cur = `${this.cur.replace(/ +$/, "")}\t`;
  }

  end(): void {
    const t = this.cur
      .split("\n")
      .map((l) => l.replace(/^ +| +$/g, "").replace(/\t+$/, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    this.cur = "";
    if (t === "") return;
    this.out.push(t);
    this.bytes += utf8Bytes(t) + 1;
  }
}

type Layout = "block" | "inline" | "inlineBox" | "row" | "cell" | "contents";

function layoutOf(cs: CSSStyleDeclaration): Layout {
  const d = cs.display;
  if (d === "contents") return "contents";
  if (d === "table-row") return "row";
  if (d === "table-cell") return "cell";
  if (d === "inline") return "inline";
  if (d.startsWith("inline") || d === "ruby" || d === "ruby-text") return "inlineBox";
  return "block";
}

/** The selection's ranges in this document, when the user selected anything. */
function selectionRanges(doc: Document): Range[] {
  const sel = doc.getSelection();
  if (sel === null || sel.isCollapsed) return [];
  const out: Range[] = [];
  for (let i = 0; i < sel.rangeCount; i++) out.push(sel.getRangeAt(i));
  return out;
}

/** The part of a text node a range covers, or null. */
function selectedPart(node: Text, ranges: readonly Range[]): string | null {
  let out: string | null = null;
  for (const r of ranges) {
    if (!r.intersectsNode(node)) continue;
    const start = r.startContainer === node ? r.startOffset : 0;
    const end = r.endContainer === node ? r.endOffset : node.data.length;
    if (end > start) out = (out ?? "") + node.data.slice(start, end);
  }
  return out;
}

/** The region a person reads on this page: the first rendered main or [role=main] nothing above hides, else body. */
export function mainRegion(doc: Document = document): Element | null {
  for (const el of doc.querySelectorAll("main, [role=main]")) if (el.checkVisibility() && !ancestry(el).hidden) return el;
  return doc.body;
}

/**
 * The visible text of the main region, and of what the user selected anywhere in the document, under the exclusions
 * above, capped. `max` is for tests.
 */
export function readMainText(doc: Document = document, max = TAB_TEXT_BYTES): FrameText & { cut: boolean } {
  const main = mainRegion(doc);
  const body = doc.body;
  if (main === null || body === null || ancestry(main).hidden) return { selection: [], blocks: [], cut: false };
  const ranges = selectionRanges(doc);
  // The selection may lie outside the main region (a sidebar); then the whole body is walked, main text still only from main.
  const root = ranges.some((r) => !main.contains(r.commonAncestorContainer)) ? body : main;
  const blocks = new Paragraphs();
  const selected = new Paragraphs();
  let visited = 0;
  /** Enough read: the main text alone is over the cap (it is cut later, at a paragraph boundary), or the walk is too long. */
  const full = (): boolean => visited > MAX_ELEMENTS || (blocks.bytes > max && selected.bytes > max) || (ranges.length === 0 && blocks.bytes > max);
  const visit = (n: Node, inMain: boolean, pre: boolean, visible: boolean, clip: Box | null, reach: Box): void => {
    if (full()) return;
    if (n.nodeType === Node.TEXT_NODE) {
      if (!visible) return;
      const t = n as Text;
      if (inMain) blocks.text(t.data, pre);
      if (ranges.length > 0) {
        const part = selectedPart(t, ranges);
        if (part !== null) selected.text(part, pre);
      }
      return;
    }
    if (!(n instanceof Element)) return;
    visited++;
    const nowMain = inMain || n === main;
    const cs = getComputedStyle(n);
    if (skipped(n, cs)) return;
    // Wholly outside what an ancestor's clipped overflow leaves visible, or outside everything the document or the
    // nearest scrolling box can scroll to (a box placed at left: -10000px). A box of no size is judged by its children.
    if (cs.display !== "contents") {
      const r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && ((clip !== null && outside(r, clip)) || outside(r, reach))) return;
    }
    if (n.tagName === "BR") {
      if (nowMain) blocks.newline();
      selected.newline();
      return;
    }
    const layout = layoutOf(cs);
    const each = (f: (p: Paragraphs) => void): void => {
      if (nowMain) f(blocks);
      if (ranges.length > 0) f(selected);
    };
    if (layout === "block") each((p) => p.end());
    else if (layout === "row") each((p) => p.newline());
    else if (layout === "cell") each((p) => p.cell());
    else if (layout === "inlineBox") each((p) => p.space());
    const isPre = cs.whiteSpace.startsWith("pre") || cs.whiteSpace === "break-spaces";
    // visibility is inherited and a child may set it back to visible, so it decides text, not the subtree.
    const shows = cs.visibility === "visible";
    const kids = shadowRootOf(n)?.childNodes ?? n.childNodes;
    const inner = clipBy(n, cs, clip);
    const within = reachIn(n, cs, reach);
    if (n instanceof HTMLSlotElement) for (const a of n.assignedNodes({ flatten: true })) visit(a, nowMain, isPre, shows, inner, within);
    else for (const c of kids) visit(c, nowMain, isPre, shows, inner, within);
    if (layout === "block") each((p) => p.end());
    else if (layout === "inlineBox") each((p) => p.space());
  };
  const start = ancestry(root);
  if (start.hidden) return { selection: [], blocks: [], cut: false };
  visit(root, root === main, false, true, start.clip, start.reach);
  blocks.end();
  selected.end();
  return capFrame({ selection: selected.out, blocks: blocks.out }, max);
}

// ---- Google Docs and Sheets (brief item 6) ----

/** A Google Docs or Sheets editor page, whose text is drawn on a canvas; null for every other page. */
export type DocsKind = "document" | "spreadsheet";

/** Docs' and Sheets' editors, by origin and path (the /htmlview and /pub pages are ordinary HTML and are read as such). */
export function docsKind(origin: string, path: string): DocsKind | null {
  if (origin !== "https://docs.google.com") return null;
  const m = /^\/(document|spreadsheets)\/(?:u\/\d+\/)?d\/[^/]+\/edit\b/.exec(path);
  return m === null ? null : m[1] === "document" ? "document" : "spreadsheet";
}

/**
 * Whether `el` is an HTML element of its own document's window. Docs' text-event target is in a same-origin iframe,
 * another realm, where `instanceof HTMLElement` against this frame's constructor is false.
 */
export function isHtml(el: Element | null): el is HTMLElement {
  const view = el?.ownerDocument.defaultView;
  return el !== null && view !== null && view !== undefined && el instanceof view.HTMLElement;
}

/** Zero-width characters Docs keeps in its text-event target while it holds no text. */
const ZERO_WIDTH = /[​‌‍﻿]/g;

/**
 * Where Docs or Sheets keeps the document's text for assistive technology, measured by GD1 (evidence/browser/gd1):
 * Docs, the editable textbox in the body of `iframe.docs-texteventtarget-iframe` (same-origin, off screen); Sheets, an
 * editable textbox placed wholly off screen. Null when the page has none.
 */
export function docsTextbox(doc: Document, kind: DocsKind): HTMLElement | null {
  if (kind === "document") {
    const f = doc.querySelector("iframe.docs-texteventtarget-iframe");
    let inner: Document | null = null;
    try {
      inner = f instanceof HTMLIFrameElement ? f.contentDocument : null;
    } catch {
      inner = null;
    }
    const box = inner?.querySelector("[role=textbox][contenteditable]") ?? null;
    return isHtml(box) ? box : null;
  }
  for (const el of doc.querySelectorAll("[role=textbox][contenteditable]")) {
    if (!(el instanceof HTMLElement) || !el.isContentEditable) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.right < 0) return el;
  }
  return null;
}

/** The text of the textbox docsTextbox found, as paragraphs: Docs' blank-line breaks, Sheets' rows. */
export function docsParagraphs(text: string, kind: DocsKind): string[] {
  const t = text.replace(ZERO_WIDTH, "").replace(/\r\n?/g, "\n");
  const parts = kind === "document" ? t.split(/\n{2,}/) : t.split("\n");
  return parts.map((p) => p.replace(/\t+$/, "").trim()).filter((p) => p !== "");
}

/** Docs' or Sheets' own text for assistive technology, capped; `on` false when the user has not turned it on. */
export function readDocsText(doc: Document, kind: DocsKind, max = TAB_TEXT_BYTES): FrameText & { cut: boolean; on: boolean } {
  const box = docsTextbox(doc, kind);
  const blocks = box === null ? [] : docsParagraphs(box.innerText, kind);
  if (blocks.length === 0) return { selection: [], blocks: [], cut: false, on: false };
  return { ...capFrame({ selection: [], blocks }, max), on: true };
}

/** What one frame answers a text read with: its text, and for a Docs or Sheets editor whether its text was there. */
export interface FrameTextReport extends FrameText {
  cut: boolean;
  /** "on" or "off" for a Docs or Sheets editor's top frame (brief item 6); null on every other page. */
  docsText: "on" | "off" | null;
}

/** This frame's text read. `origin` and `path` are the frame's own (content.ts walk computes them the same way). */
export function readFrameText(origin: string, path: string, isTop: boolean, doc: Document = document): FrameTextReport {
  const kind = isTop ? docsKind(origin, path) : null;
  if (kind !== null) {
    const d = readDocsText(doc, kind);
    return { selection: d.selection, blocks: d.blocks, cut: d.cut, docsText: d.on ? "on" : "off" };
  }
  return { ...readMainText(doc), docsText: null };
}
