// H11: how a page segment's preview reads in the host's page task panel (protocol GoalPageView): where to anchor it,
// where its values came from, each field and value as a row, and the file inputs Caret leaves to the user. Built from
// the plan and the page as the model holds it when the preview is sent; it decides nothing and nothing acts on it.
import type { ScreenModel, WindowState } from "../model.ts";
import { PAGE_SUBROLE, type Frame, type GoalPageView } from "../protocol.ts";
import { ABOUT_SAYS } from "../fill/about.ts";
import { describeField } from "../fill/descriptor.ts";
import { fieldName } from "../planner/planner.ts";
import type { GoalPlan, GoalSegment } from "./plan.ts";

/** Controls whose value is chosen from a list the page offers, which the panel marks "(picked from the list)". */
const PICKED = new Set(["select", "combobox"]);
/** Controls whose write reads as "field: value"; a box to tick reads from its step's words. */
const ROWS = new Set(["text", "select", "combobox", "radio", "date", "time"]);
/** What a value that came from the instruction itself is called on the source line. */
export const REQUEST_SAYS = "your request";

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The page view for `seg`, or undefined when it does not write in the page window of a page goal. */
export function pageView(model: ScreenModel, plan: GoalPlan, seg: GoalSegment): GoalPageView | undefined {
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
  const rows = writes
    .filter((s) => ROWS.has(s.target.control))
    .map((s) => ({ step: s.index, label: clip(s.target.label, 300), value: clip(s.writes ?? s.value?.text ?? "", 900), picked: PICKED.has(s.target.control) }));
  return { windowId: d.windowId, anchor, viewport, from, rows: rows.slice(0, 24), attach: w === undefined ? [] : attachLeft(w, plan.page) };
}

/** The top frame's visible area on screen: its web area node's frame (engines/page-link.ts). */
function viewportOf(w: WindowState): Frame | null {
  for (const n of w.nodes.values()) if (n.role === "AXWebArea" && (n.parent ?? null) === null) return n.frame ?? null;
  return null;
}

function inside(f: Frame, v: Frame): boolean {
  return f[0] >= v[0] && f[1] >= v[1] && f[0] + f[2] <= v[0] + v[2] && f[1] + f[3] <= v[1] + v[3];
}

/** The labels of the page's empty, enabled file inputs the goal's scope takes: every one for "all", the section's for "section", none for a list. */
function attachLeft(w: WindowState, page: NonNullable<GoalPlan["page"]>): string[] {
  if (page.kind === "list") return [];
  const out: string[] = [];
  for (const n of w.nodes.values()) {
    if (n.subrole !== PAGE_SUBROLE.file || (n.value ?? "") !== "" || n.states?.includes("disabled") === true) continue;
    if (page.kind === "section" && describeField(w, n).section !== page.section) continue;
    const label = clip(fieldName(w, n), 200);
    if (label !== "" && !out.includes(label)) out.push(label);
  }
  return out.slice(0, 8);
}
