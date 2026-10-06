// The visible text of one frame, read once when the worker asks for the tab the user just left (P4, brief rule 4).
// Nothing here runs on its own: no observer, no timer. content.ts calls readFrameText on the worker's one-shot message.
//
// What is read, and why each exclusion is decided here, before anything leaves the frame:
//   - Only the page's main region: the first rendered `main` or `[role=main]`, else `body`. A mailbox's message list,
//     a site's navigation and its footer are not the note or message the user was reading.
//   - Only text a person could see. A subtree is skipped when it is not rendered, transparent, aria-hidden or inert,
//     clipped to nothing, cut to a pixel by its own overflow (the visually-hidden pattern), or placed wholly outside
//     what the document can scroll to. Text that only assistive technology or a script was meant to get is not the
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
  const r = el.getBoundingClientRect();
  const clips = (v: string): boolean => v === "hidden" || v === "clip";
  if ((clips(cs.overflowX) || clips(cs.overflowY)) && (r.width <= 1 || r.height <= 1)) return true;
  if (r.width > 0 && r.height > 0) {
    const doc = document.documentElement;
    const left = r.left + window.scrollX;
    const top = r.top + window.scrollY;
    if (left + r.width <= 0 || top + r.height <= 0) return true;
    if (left >= Math.max(doc.scrollWidth, window.innerWidth) || top >= Math.max(doc.scrollHeight, window.innerHeight)) return true;
  }
  return false;
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

/** The region a person reads on this page: the first rendered main or [role=main], else body. */
export function mainRegion(doc: Document = document): Element | null {
  for (const el of doc.querySelectorAll("main, [role=main]")) if (el.checkVisibility()) return el;
  return doc.body;
}

/**
 * The visible text of the main region, and of what the user selected anywhere in the document, under the exclusions
 * above, capped. `max` is for tests.
 */
export function readMainText(doc: Document = document, max = TAB_TEXT_BYTES): FrameText & { cut: boolean } {
  const main = mainRegion(doc);
  const body = doc.body;
  if (main === null || body === null) return { selection: [], blocks: [], cut: false };
  const ranges = selectionRanges(doc);
  // The selection may lie outside the main region (a sidebar); then the whole body is walked, main text still only from main.
  const root = ranges.some((r) => !main.contains(r.commonAncestorContainer)) ? body : main;
  const blocks = new Paragraphs();
  const selected = new Paragraphs();
  let visited = 0;
  /** Enough read: the main text alone is over the cap (it is cut later, at a paragraph boundary), or the walk is too long. */
  const full = (): boolean => visited > MAX_ELEMENTS || (blocks.bytes > max && selected.bytes > max) || (ranges.length === 0 && blocks.bytes > max);
  const visit = (n: Node, inMain: boolean, pre: boolean, visible: boolean): void => {
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
    if (n instanceof HTMLSlotElement) for (const a of n.assignedNodes({ flatten: true })) visit(a, nowMain, isPre, shows);
    else for (const c of kids) visit(c, nowMain, isPre, shows);
    if (layout === "block") each((p) => p.end());
    else if (layout === "inlineBox") each((p) => p.space());
  };
  visit(root, root === main, false, true);
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
