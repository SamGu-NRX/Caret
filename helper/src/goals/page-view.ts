// H11: how a page segment's preview reads in the host's page task panel (protocol GoalPageView): where to anchor it,
// where its values came from, each field and value as a row, each attach step's row (H14), and the file inputs Caret
// leaves to the user. Built from the plan and the page as the model holds it when the preview is sent; it decides
// nothing and nothing acts on it.
// L1: each row also says where its value came from, and, for a host that declared SOURCE_EXCERPTS_CAPABILITY, carries a
// crop of that source's text with the value's span marked; the view also names the plan's left items the panel draws.
// An excerpt is the user's own text: it is built here, only as the preview message is built (after planning, so no
// model ever sees it), and only when the caller says the goal's host asked for it. Nothing here keeps, logs or counts it.
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import { PAGE_SUBROLE, type Frame, type GoalPageView, type SourceExcerpt } from "../protocol.ts";
import { ABOUT_SAYS } from "../fill/about.ts";
import { describeField } from "../fill/descriptor.ts";
import { parseMemoryRef } from "../fill/fill.ts";
import { parsePageWindow } from "../engines/windows.ts";
import { fieldName } from "../planner/planner.ts";
import type { GoalPlan, GoalSegment, ValueBinding } from "./plan.ts";

/** Controls whose value is chosen from a list the page offers, which the panel marks "(picked from the list)". */
const PICKED = new Set(["select", "combobox"]);
/** Controls whose write reads as "field: value"; a box to tick reads from its step's words. */
const ROWS = new Set(["text", "select", "combobox", "radio", "date", "time"]);
/** What a value that came from the instruction itself is called on the source line. */
export const REQUEST_SAYS = "your request";

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
/** The most attach rows a view carries (protocol GoalPageView.files). */
const MAX_FILE_ROWS = 8;

/** What a page view reads beyond the plan and the page (L1). */
export interface PageViewOptions {
  /**
   * Whether the goal's host session declared SOURCE_EXCERPTS_CAPABILITY (helper.ts excerptsFor). False: no row carries
   * an excerpt, so the user's text is never even cut for a host that did not ask for it.
   */
  excerpts: boolean;
  /** The model the goal's sources are read from (runs.ts GoalRunDeps.sourceModel): the tab the user left, while held. */
  sourceModel?: ScreenModel;
  /** An About entry as a fill may use it now (helper.ts aboutNow), or null. */
  aboutNow?: (id: string) => { value: string; label: string } | null;
  /** A page window's address (origin and path of its top frame), or null when the page engines do not know it. */
  site?: (windowId: string) => string | null;
}

/** The page view for `seg`, or undefined when it does not write in the page window of a page goal. */
export function pageView(model: ScreenModel, plan: GoalPlan, seg: GoalSegment, o: PageViewOptions): GoalPageView | undefined {
  const d = seg.domain;
  if (d.kind !== "window" || !d.page || plan.page === undefined || plan.page.windowId !== d.windowId) return undefined;
  const w = model.windows.get(d.windowId);
  const viewport = w === undefined ? null : viewportOf(w);
  const writes = seg.steps.filter((s) => s.kind === "write");
  const first = writes[0] === undefined || w === undefined ? undefined : w.nodes.get(writes[0].target.key)?.frame;
  const anchor = first !== undefined && first !== null && viewport !== null && inside(first, viewport) ? first : null;
  const windows: string[] = [];
  let told = false;
  let asked = false;
  for (const s of writes) {
    const v = s.value;
    if (v === null) continue;
    if (v.source !== null) {
      const src = model.windows.get(v.source.windowId);
      if (src !== undefined) {
        const title = src.window.title.trim();
        const name = title === "" || title === src.app.name ? src.app.name : `${src.app.name}, ${title}`;
        if (!windows.includes(name)) windows.push(name);
      }
    } else if (v.memory !== null) told = true;
    else asked = true;
  }
  const from = clip([...windows, ...(told ? [ABOUT_SAYS] : []), ...(asked ? [REQUEST_SAYS] : [])].join(" and "), 300);
  const sources = o.sourceModel ?? model;
  const rows = writes
    .filter((s) => ROWS.has(s.target.control))
    .slice(0, MAX_ROWS)
    .map((s) => {
      const row = { step: s.index, label: clip(s.target.label, 300), value: clip(s.writes ?? s.value?.text ?? "", 900), picked: PICKED.has(s.target.control) };
      if (s.value === null) return row;
      const excerpt = o.excerpts ? excerptOf(s.value, sources, o) : null;
      return { ...row, source: sourceOf(s.value, sources), ...(excerpt === null ? {} : { excerpt }) };
    });
  const files = seg.steps
    .filter((s) => s.kind === "attach")
    .map((s) => {
      const node = w?.nodes.get(s.target.key);
      const label = (w === undefined || node === undefined ? "" : fieldName(w, node)) || s.target.label || "File";
      return { step: s.index, label: clip(label, 200), accept: node?.accept ?? [] };
    })
    .slice(0, MAX_FILE_ROWS);
  // L1: what the plan leaves in this page that the panel draws, each with the sentence it adds to the warnings (lower.ts).
  const left = plan.left
    .flatMap((l) => (l.windowId === d.windowId && l.mark !== undefined && l.label.trim() !== "" ? [{ label: clip(l.label, 300), why: l.mark, says: clip(`${l.says}.`, 600) }] : []))
    .slice(0, MAX_ROWS);
  return {
    windowId: d.windowId,
    app: { pid: d.pid, bundleId: d.bundleId, name: d.appName },
    anchor,
    viewport,
    from,
    rows,
    attach: w === undefined ? [] : attachLeft(w, plan),
    ...(files.length === 0 ? {} : { files }),
    ...(left.length === 0 ? {} : { left }),
  };
}

/** The most rows a view carries (protocol GoalPageView.rows). */
const MAX_ROWS = 24;
/** An excerpt's bounds (protocol SourceExcerpt): whole lines, at most this many, of at most this many UTF-16 units. */
const EXCERPT_LINES = 6;
const EXCERPT_UNITS = 600;

/** L1: where a row's value came from (protocol GoalPageView rows' `source`). */
function sourceOf(v: ValueBinding, sources: ScreenModel): NonNullable<GoalPageView["rows"][number]["source"]> {
  if (v.source !== null) {
    const src = sources.windows.get(v.source.windowId);
    return { kind: parsePageWindow(v.source.windowId) !== null ? "tab" : "window", name: clip(src?.app.name ?? "", 120) };
  }
  return { kind: v.memory !== null ? "memory" : "request", name: "" };
}

/**
 * L1: a crop of a row's source with its value's span marked, or null when there is none to show: the request, a source
 * that is gone, or a span not found in it (never guessed). The span is fill's (`fill.span`, what the source shows) when
 * fill chose the value, else the value's text. Built per preview message and dropped with it.
 */
function excerptOf(v: ValueBinding, sources: ScreenModel, o: PageViewOptions): SourceExcerpt | null {
  if (v.source !== null) {
    const src = sources.windows.get(v.source.windowId);
    const node = src?.nodes.get(v.source.key);
    if (src === undefined || node === undefined) return null;
    const text = nodeText(node);
    const span = v.fill?.span ?? v.text;
    // The occurrence on the line fill read it from ("Work email: ..."), when that line is there; else the first.
    const ctx = v.fill?.context == null ? -1 : text.indexOf(v.fill.context);
    const after = ctx < 0 ? -1 : text.indexOf(span, ctx);
    const at = after >= 0 ? after : text.indexOf(span);
    const cut = at < 0 ? null : around(text, at, at + span.length);
    if (cut === null) return null;
    const title = src.window.title.trim();
    const name = clip(title === "" ? src.app.name : title, 200);
    if (name === "") return null;
    const host = parsePageWindow(v.source.windowId) === null ? null : hostOf(o.site?.(v.source.windowId) ?? null);
    return { ...cut, name, edited: null, ...(host === null ? {} : { tab: { title: clip(src.window.title, 300), host } }) };
  }
  if (v.memory !== null) {
    const entry = o.aboutNow?.(parseMemoryRef(v.memory).id) ?? null;
    if (entry === null || entry.label.trim() === "") return null;
    // The value's text in the entry (a part of it, for a first name), else what fill read from it.
    const span = [v.text, v.fill?.span ?? ""].find((x) => x !== "" && entry.value.includes(x));
    const at = span === undefined ? -1 : entry.value.indexOf(span);
    const cut = span === undefined || at < 0 ? null : around(entry.value, at, at + span.length);
    return cut === null ? null : { ...cut, name: clip(entry.label, 200), edited: null };
  }
  return null;
}

/** A page's host from its address, or null when there is none or it does not parse. */
function hostOf(site: string | null): string | null {
  if (site === null) return null;
  try {
    const host = new URL(site).host;
    return host === "" || host.length > 253 ? null : host;
  } catch {
    return null;
  }
}

/**
 * The whole lines of `text` around [start, end): the span's own lines, then one line before and one after in turn while
 * the crop stays within EXCERPT_LINES lines and EXCERPT_UNITS units, so the far lines are the ones dropped. When the
 * span's own lines are already longer, a window of EXCERPT_UNITS units around the span within them, cut with no
 * ellipsis (so the offsets stay exact) and never through a surrogate pair. Null for an empty span, one longer than
 * EXCERPT_UNITS, or one over more than EXCERPT_LINES lines. Offsets are UTF-16 code units, as JavaScript indexes.
 */
export function around(text: string, start: number, end: number): { text: string; start: number; end: number } | null {
  if (end <= start || end - start > EXCERPT_UNITS || end > text.length) return null;
  const lineStart = (i: number): number => text.lastIndexOf("\n", i - 1) + 1;
  const lineEnd = (i: number): number => {
    const nl = text.indexOf("\n", i);
    return nl < 0 ? text.length : nl;
  };
  let lo = lineStart(start);
  let hi = lineEnd(end - 1);
  let lines = text.slice(lo, hi).split("\n").length;
  if (lines > EXCERPT_LINES) return null;
  if (hi - lo > EXCERPT_UNITS) {
    const room = EXCERPT_UNITS - (end - start);
    let a = Math.min(Math.max(lo, start - Math.floor(room / 2)), hi - EXCERPT_UNITS);
    let b = a + EXCERPT_UNITS;
    if (a > lo && a < start && isLow(text.charCodeAt(a))) a += 1;
    if (b < hi && b > end && isLow(text.charCodeAt(b))) b -= 1;
    return { text: text.slice(a, b), start: start - a, end: end - a };
  }
  let before = true;
  for (let blocked = 0; blocked < 2 && lines < EXCERPT_LINES; before = !before) {
    const next = before ? (lo === 0 ? -1 : lineStart(lo - 1)) : hi === text.length ? -1 : lineEnd(hi + 1);
    if (next < 0 || (before ? hi - next : next - lo) > EXCERPT_UNITS) {
      blocked += 1;
      continue;
    }
    blocked = 0;
    if (before) lo = next;
    else hi = next;
    lines += 1;
  }
  return { text: text.slice(lo, hi), start: start - lo, end: end - lo };
}

const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** The top frame's visible area on screen: its web area node's frame (engines/page-link.ts). */
function viewportOf(w: WindowState): Frame | null {
  for (const n of w.nodes.values()) if (n.role === "AXWebArea" && (n.parent ?? null) === null) return n.frame ?? null;
  return null;
}

function inside(f: Frame, v: Frame): boolean {
  return f[0] >= v[0] && f[1] >= v[1] && f[0] + f[2] <= v[0] + v[2] && f[1] + f[3] <= v[1] + v[3];
}

/**
 * The labels of the page's empty, enabled file inputs the goal's scope takes and no step of the plan attaches to: every
 * one for "all", the section's for "section", none for a list. One the plan attaches to has its own attach row (H14).
 */
function attachLeft(w: WindowState, plan: GoalPlan): string[] {
  const page = plan.page;
  if (page === undefined || page.kind === "list") return [];
  const attached = new Set(plan.segments.flatMap((g) => g.steps.filter((s) => s.kind === "attach").map((s) => s.target.key)));
  const out: string[] = [];
  for (const n of w.nodes.values()) {
    if (n.subrole !== PAGE_SUBROLE.file || (n.value ?? "") !== "" || n.states?.includes("disabled") === true || attached.has(n.key)) continue;
    if (page.kind === "section" && describeField(w, n).section !== page.section) continue;
    const label = clip(fieldName(w, n), 200);
    if (label !== "" && !out.includes(label)) out.push(label);
  }
  return out.slice(0, 8);
}
