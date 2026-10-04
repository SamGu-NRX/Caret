// A planned task as the host shows it: a pop-up listing each field the plan writes with the value and
// where it came from, and the press left to the user. Code writes every label; the action bar's Tab
// action runs the plan. Every value carries a ref back to its window node, memory entry, or the
// instruction (rule "instruction", derived from the field it is written to, since an instruction has
// no node of its own).
import { PROTOCOL_VERSION, type PlanErrorCode, type PlanProposal } from "../protocol.ts";
import type { PopupBlock, PopupRef, PopupSpecT } from "../popup.ts";
import { MAX_FILL_ROWS } from "../offers/fill-popup.ts";
import { fieldName, type PlanDraft } from "./planner.ts";
import type { Trace } from "./trace.ts";

const node = (windowId: string, key: string): { node: string } => ({ node: `${windowId}/${key}` });

function valueRef(trace: Trace, value: string, windowId: string, fieldKey: string): PopupRef {
  switch (trace.from) {
    case "window":
      return trace.nodeKey === null ? { rule: "windowTitle", derived: [{ node: trace.windowId }] } : { ...node(trace.windowId, trace.nodeKey), quote: value };
    case "memory":
      return { memory: trace.id };
    case "instruction":
      return { rule: "instruction", derived: [node(windowId, fieldKey)] };
  }
}

/** The action's label, from what the plan does: the number of fields it fills, or only a hand-off. */
export function runLabel(d: PlanDraft): string {
  const n = d.checked.writes.length;
  return n === 0 ? "Got it" : n === 1 ? "Fill 1 field" : `Fill ${n} fields`;
}

export function planSpec(d: PlanDraft): PopupSpecT {
  const w = d.checked.window;
  const windowId = w.window.windowId;
  const writes = d.checked.writes;
  const title = writes.length > 0 ? `${writes.length === 1 ? "1 field" : `${writes.length} fields`} in '${w.window.title}'` : `Over to you in '${w.window.title}'`;
  const blocks: PopupBlock[] = [{ type: "header", title: { text: title, ref: { rule: "plan", derived: [{ node: windowId }] } } }];
  if (writes.length > 0) {
    const rows = writes.slice(0, MAX_FILL_ROWS).map((wr) => ({
      destination: { text: fieldName(w, wr.node), ref: { rule: "fieldLabel", derived: [node(windowId, wr.node.key)] } },
      value: { text: wr.value, ref: valueRef(wr.trace, wr.value, windowId, wr.node.key) },
      state: "ready" as const,
    }));
    const more = writes.length - rows.length;
    blocks.push({ type: "fields", rows, ...(more > 0 ? { more } : {}) });
  }
  // An Ask's form controls the user sets (a select's option, a date), and the fields Caret never types (B25).
  const controls = d.controls ?? [];
  if (controls.length > 0 || (d.leftToYou ?? null) !== null) {
    blocks.push({
      type: "facts",
      rows: [
        ...controls.map((c) => ({ label: `You set ${c.name}`, value: { text: c.display, ref: { rule: "fieldLabel", derived: [node(windowId, c.key)] } } })),
        ...(d.leftToYou === null || d.leftToYou === undefined ? [] : [{ label: "You type", value: { text: d.leftToYou, ref: { rule: "plan", derived: [{ node: windowId }] } } }]),
      ],
    });
  }
  const h = d.checked.handoff;
  // A hand-off step that only carries an Ask's controls is listed above, not as a press.
  if (h !== null && !controls.some((c) => c.key === h.node.key)) {
    const label = h.label === "" ? "the unlabelled button" : h.label;
    blocks.push({ type: "facts", rows: [{ label: h.why === "unverifiable" ? "You press" : `You press (${h.why})`, value: { text: label, ref: { ...node(windowId, h.node.key), quote: h.label } } }] });
  }
  blocks.push({ type: "actions", items: [{ id: "run", label: runLabel(d), key: "tab" }] });
  return { v: 1, id: d.plan.id, figure: "offering", blocks };
}

export function proposed(requestId: string, d: PlanDraft, at: number): PlanProposal {
  const w = d.checked.window;
  const h = d.checked.handoff;
  return {
    type: "planProposal",
    v: PROTOCOL_VERSION,
    requestId,
    at,
    outcome: "proposed",
    offerKey: d.plan.id,
    window: { pid: w.app.pid, windowId: w.window.windowId, appName: w.app.name, title: w.window.title },
    spec: planSpec(d),
    handoff: h === null ? null : { label: h.label, why: h.why },
    error: null,
  };
}

export function planError(requestId: string, code: PlanErrorCode, detail: string, at: number): PlanProposal {
  return { type: "planProposal", v: PROTOCOL_VERSION, requestId, at, outcome: "error", offerKey: null, window: null, spec: null, handoff: null, error: { code, detail } };
}
