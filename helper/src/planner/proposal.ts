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
import { saysFor, saysUnsureField } from "./says.ts";

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
  // H5: a plan that attaches the file the user confirms says so; Tab confirms the file and runs.
  if (d.checked.attach !== null) return n === 0 ? "Attach it" : `Fill ${n === 1 ? "1 field" : `${n} fields`} and attach`;
  return n === 0 ? "Got it" : n === 1 ? "Fill 1 field" : `Fill ${n} fields`;
}

/**
 * H1: the labels of the facts blocks that name fields the plan leaves to the user: those Caret never types (B25), and
 * those Jev wasn't sure the request asks for (I3). The host's Ask card lists a block whose first row carries one of
 * these as the user's steps (AskCaret.swift AskCopy.leftLabels), so they are part of the wire.
 */
export const YOU_TYPE_LABEL = "You type";
export const LEFT_TO_YOU_LABEL = "Left to you";

export function planSpec(d: PlanDraft): PopupSpecT {
  const w = d.checked.window;
  const windowId = w.window.windowId;
  const writes = d.checked.writes;
  const attach = d.checked.attach;
  const title =
    writes.length > 0
      ? `${writes.length === 1 ? "1 field" : `${writes.length} fields`} in '${w.window.title}'`
      : attach !== null
        ? `A file for '${w.window.title}'`
        : `Over to you in '${w.window.title}'`;
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
  // The file input and the file it takes, in the user's words ("your resume"). The host shows the likely file in its
  // place once it has found one, and the user confirms that file for the run (fileConfirm).
  if (attach !== null) {
    blocks.push({
      type: "fields",
      rows: [
        {
          destination: { text: attach.label === "" ? "File" : attach.label, ref: { rule: "fieldLabel", derived: [node(windowId, attach.node.key)] } },
          value: { text: attach.wants, ref: { rule: "attach", derived: [node(windowId, attach.node.key)] } },
          state: "ready" as const,
        },
      ],
    });
  }
  // An Ask's form controls the user sets (a select's option, a date), each a row of its own with the value to set and
  // the state `yours` (H5): Caret never writes or presses them. They are a fields block apart from the writes, so each
  // block's `more` counts its own rows.
  const controls = d.controls ?? [];
  if (controls.length > 0) {
    const shown = controls.slice(0, MAX_FILL_ROWS);
    blocks.push({
      type: "fields",
      rows: shown.map((c) => ({
        destination: { text: c.name, ref: { rule: "fieldLabel", derived: [node(windowId, c.key)] } },
        value: { text: c.display, ref: { rule: "fieldLabel", derived: [node(windowId, c.key)] } },
        state: "yours" as const,
      })),
      ...(controls.length > shown.length ? { more: controls.length - shown.length } : {}),
    });
  }
  // The fields Caret never types (B25).
  if ((d.leftToYou ?? null) !== null) {
    blocks.push({ type: "facts", rows: [{ label: YOU_TYPE_LABEL, value: { text: d.leftToYou as string, ref: { rule: "plan", derived: [{ node: windowId }] } } }] });
  }
  // I3: the fields Jev wasn't sure the request asks for, each the user's with its sentence, as fill's "You set" rows are.
  const unsure = d.unsure ?? [];
  if (unsure.length > 0) {
    const shown = unsure.slice(0, MAX_FILL_ROWS);
    const rows = shown.map((u, i) => ({ label: i === 0 ? LEFT_TO_YOU_LABEL : "", value: { text: saysUnsureField(u.name), ref: { rule: "fieldLabel", derived: [node(windowId, u.key)] } }, secondary: true as const }));
    const more = unsure.length - shown.length;
    if (more > 0) rows.push({ label: "", value: { text: `and ${more} more`, ref: { rule: "count", derived: unsure.slice(MAX_FILL_ROWS).map((u) => node(windowId, u.key)) } }, secondary: true });
    blocks.push({ type: "facts", rows });
  }
  const h = d.checked.handoff;
  // A hand-off step that only carries an Ask's controls is listed above, not as a press.
  if (h !== null && !controlHandoff(d)) {
    const label = h.label === "" ? "the unlabelled button" : h.label;
    blocks.push({ type: "facts", rows: [{ label: h.why === "unverifiable" ? "You press" : `You press (${h.why})`, value: { text: label, ref: { ...node(windowId, h.node.key), quote: h.label } } }] });
  }
  blocks.push({ type: "actions", items: [{ id: "run", label: runLabel(d), key: "tab" }] });
  return { v: 1, id: d.plan.id, figure: "offering", blocks };
}

/** The plan's hand-off is the step that hands an Ask's controls to the user, not a press. */
function controlHandoff(d: PlanDraft): boolean {
  const h = d.checked.handoff;
  return h !== null && (d.controls ?? []).some((c) => c.key === h.node.key);
}

export function proposed(requestId: string, d: PlanDraft, at: number): PlanProposal {
  const w = d.checked.window;
  // `handoff` names a press. A run that only hands over controls has none: the spec's `yours` rows say what to set (H5).
  const h = controlHandoff(d) ? null : d.checked.handoff;
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
    ...(d.checked.attach === null ? {} : { attach: { step: d.checked.attach.step, field: d.checked.attach.label === "" ? "File" : d.checked.attach.label, wants: d.checked.attach.wants } }),
  };
}

/** A refusal. `says` is the user's sentence (planner/says.ts); `detail` is what the check found, for logs. */
export function planError(requestId: string, code: PlanErrorCode, detail: string, at: number, says: string = saysFor(code)): PlanProposal {
  return { type: "planProposal", v: PROTOCOL_VERSION, requestId, at, outcome: "error", offerKey: null, window: null, spec: null, handoff: null, error: { code, detail, says } };
}
