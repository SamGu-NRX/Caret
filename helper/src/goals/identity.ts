// Which row a navigation step means, and the two end states that check it (CU-COUNSEL-R2 D2, slice 2). A list row is
// named by its cells as the plan read them; lowering picks the cells that must match (anchors), never the program. A
// cell anchors unless it is under 3 characters or shaped like a time ("3m ago", "Oct", "9:41 AM"): a detail pane rarely
// repeats a row's time, and two rows that differ only by time are not told apart by it anyway. The sender must anchor,
// or two "Flight itinerary" rows from two people collapse into one.
//
// Matching is by the first ANCHOR_PREFIX characters of each anchor, as a substring of one node's text, because a list
// shortens what its detail shows in full ("Your flight to SFO dep…" against "Your flight to SFO departs at 7:05").
import type { WindowState } from "../model.ts";
import { nodeText } from "../model.ts";
import type { Node } from "../protocol.ts";
import type { Identity } from "../executor/schema.ts";

/**
 * Characters of an anchor that must appear in a node of the detail. Assumed, not measured (CU-COUNSEL-R2 D2): the fixture
 * rows test it, and a real list that shortens a cell under 24 characters would need a lower number.
 */
export const ANCHOR_PREFIX = 24;

/** A cell shorter than this never anchors: "Re", "1", an icon's letter. Assumed with ANCHOR_PREFIX. */
const MIN_ANCHOR = 3;

const WEEKDAYS = ["mon", "monday", "tue", "tues", "tuesday", "wed", "wednesday", "thu", "thur", "thurs", "thursday", "fri", "friday", "sat", "saturday", "sun", "sunday"];
const MONTHS = ["jan", "january", "feb", "february", "mar", "march", "apr", "april", "may", "jun", "june", "jul", "july", "aug", "august", "sep", "sept", "september", "oct", "october", "nov", "november", "dec", "december"];

/**
 * A cell that reads as a time, which never anchors (CU-COUNSEL-R2 D2; the regex is assumed): only digits, punctuation
 * and am/pm ("9:41 AM", "10/08/2026"); anything ending in "ago"; today or yesterday; a bare weekday or month.
 */
export function timeShaped(cell: string): boolean {
  const t = cell.toLowerCase();
  if (/^[\d\s.,:/\-–]*\d[\d\s.,:/\-–]*(?:\s*[ap]\.?\s?m\.?)?$/u.test(t)) return true;
  if (/\bago$/u.test(t)) return true;
  if (t === "today" || t === "yesterday") return true;
  const bare = t.replace(/\.$/u, "");
  return WEEKDAYS.includes(bare) || MONTHS.includes(bare);
}

/** A cell as identity reads it: trimmed, inner spaces collapsed, and a trailing ellipsis (… or ...) dropped. */
export function normalizeCell(cell: string): string {
  return cell.replace(/\s+/gu, " ").trim().replace(/(?:…|\.\.\.)$/u, "").trim();
}

/**
 * A row's identity from its cells as read: each cell normalized, and the indexes of the cells that anchor. Null when no
 * cell anchors, so the row cannot be told from its neighbours by anything a detail would show: lowering refuses it.
 */
export function identityOf(cells: readonly string[]): Identity | null {
  const normalized = cells.map(normalizeCell).filter((c) => c !== "").slice(0, 8).map((c) => c.slice(0, 200));
  const anchors = normalized.flatMap((c, i) => (c.length >= MIN_ANCHOR && !timeShaped(c) ? [i] : []));
  if (normalized.length === 0 || anchors.length === 0) return null;
  return { cells: normalized, anchors };
}

/** The anchor cells of an identity, in order. */
export function anchorsOf(id: Identity): string[] {
  return id.anchors.flatMap((i) => (id.cells[i] === undefined ? [] : [id.cells[i] as string]));
}

/**
 * Roles of a list's own items, whose text is the list's and never a detail's. Native rows are AXRow (an outline's too,
 * and their AXCell children). AXOption and AXListItem are the roles the page engine gives a listbox option and a
 * qualifying list item when slice 2 step 3 projects them; no reader sends them before then.
 */
export const LIST_ITEM_ROLES: ReadonlySet<string> = new Set(["AXRow", "AXOutlineRow", "AXCell", "AXOption", "AXListItem"]);

/** Whether `n` is a list item or inside one, by its parent chain in `w`. */
export function inListItem(w: WindowState, n: Node): boolean {
  let at: Node | undefined = n;
  for (let depth = 0; at !== undefined && depth < 64; depth++) {
    if (LIST_ITEM_ROLES.has(at.role)) return true;
    at = at.parent === null ? undefined : w.nodes.get(at.parent);
  }
  return false;
}

const collapse = (s: string): string => s.replace(/\s+/gu, " ").trim();

/**
 * The texts itemOpened may match an anchor in: every node that is not editable and not a list item or inside one, by
 * key. `since`, when given, keeps only nodes that are new or whose text changed since that read (the strong form).
 */
function detailTexts(w: WindowState, since?: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const n of w.nodes.values()) {
    if (n.editable === true || inListItem(w, n)) continue;
    const t = collapse(nodeText(n));
    if (t === "") continue;
    if (since !== undefined && since.get(n.key) === t) continue;
    out.push(t);
  }
  return out;
}

/** Each node's text as itemOpened reads it, by key: the read right before an act, for the strong form. */
export function textsByKey(w: WindowState): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of w.nodes.values()) out.set(n.key, collapse(nodeText(n)));
  return out;
}

/**
 * Whether the item `id` names is shown outside its list: each anchor's first ANCHOR_PREFIX characters are in the text of
 * one node that is not a row, option or list item (nor inside one) and is not editable. Weak form without `since`: the
 * pre-act no-op check and the hold condition while the user makes the transition. Strong form with `since` (the read
 * right before Caret's act): only nodes new or changed since then count, so a detail already on screen for another item
 * cannot verify Caret's act.
 *
 * A sidebar or header that happens to repeat every anchor makes the weak form hold falsely; that fails safe: Caret skips
 * the step, the observation lacks the value, and the fill that needed it refuses.
 */
export function itemOpened(w: WindowState, id: Identity, since?: ReadonlyMap<string, string>): boolean {
  const texts = detailTexts(w, since);
  const anchors = anchorsOf(id);
  return anchors.length > 0 && anchors.every((a) => texts.some((t) => t.includes(a.slice(0, ANCHOR_PREFIX))));
}

/** The rows under `container` in `w`, in document order: nodes of `role` whose parent chain reaches the container. */
export function rowsOf(w: WindowState, containerKey: string, role: string): Node[] {
  return [...w.nodes.values()].filter((n) => n.role === role && descendsFrom(w, n, containerKey));
}

function descendsFrom(w: WindowState, n: Node, ancestor: string): boolean {
  let at = n.parent === null ? undefined : w.nodes.get(n.parent);
  for (let depth = 0; at !== undefined && depth < 64; depth++) {
    if (at.key === ancestor) return true;
    at = at.parent === null ? undefined : w.nodes.get(at.parent);
  }
  return false;
}

/**
 * Whether row `rowKey` (with `role`, exactly) is selected in `containerKey` and no other row of that container is
 * (rowSelected). Selection is the reader's `selected` state on the row node itself, never focus or a child's text.
 */
export function rowSelected(w: WindowState, containerKey: string, rowKey: string, role: string): boolean {
  const row = w.nodes.get(rowKey);
  if (row === undefined || row.role !== role || !descendsFrom(w, row, containerKey)) return false;
  if (row.states?.includes("selected") !== true) return false;
  return rowsOf(w, containerKey, role).every((r) => r.key === rowKey || r.states?.includes("selected") !== true);
}

/**
 * Where each of a row's cells is read: for each node under the row, in document order, its label (else its value) as
 * the reader sent it, skipping a node whose child repeats that text (a cell and its static text are one cell). At most
 * 8, as Identity holds. The inventory mints each cell at its own node, so a subject five rows share charges only the row
 * it names (privacy/ledger/source.ts nodePart).
 */
export function rowCellParts(w: WindowState, rowKey: string): { key: string; part: "label" | "value"; raw: string }[] {
  const under = [...w.nodes.values()].filter((n) => descendsFrom(w, n, rowKey));
  const own = (n: Node): { part: "label" | "value"; raw: string } | null => (n.label !== undefined && n.label.trim() !== "" ? { part: "label", raw: n.label } : n.value !== undefined && n.value.trim() !== "" ? { part: "value", raw: n.value } : null);
  const out: { key: string; part: "label" | "value"; raw: string }[] = [];
  for (const n of under) {
    const t = own(n);
    if (t === null) continue;
    // A container whose own text one of its children repeats (an AXCell labelled as its AXStaticText) counts once, as the child.
    if (under.some((c) => c.parent === n.key && collapse(own(c)?.raw ?? "") === collapse(t.raw))) continue;
    out.push({ key: n.key, ...t });
    if (out.length === 8) break;
  }
  return out;
}

/** A row's cells as identity reads them: rowCellParts' texts, spaces collapsed. */
export function rowCells(w: WindowState, rowKey: string): string[] {
  return rowCellParts(w, rowKey).map((c) => collapse(c.raw));
}

/** The nearest ancestor of `rowKey` with one of `roles` (the row's table, outline or list), or null. */
export function containerOf(w: WindowState, rowKey: string, roles: ReadonlySet<string>): Node | null {
  const row = w.nodes.get(rowKey);
  let at = row?.parent === null || row === undefined ? undefined : w.nodes.get(row.parent);
  for (let depth = 0; at !== undefined && depth < 64; depth++) {
    if (roles.has(at.role)) return at;
    at = at.parent === null ? undefined : w.nodes.get(at.parent);
  }
  return null;
}
