// A grounded fill as a pop-up: when every field of a proposal has a value copied from a source on
// screen or from what the user told Caret (fill/about.ts), the host shows "Fill N fields" with each
// destination and value, and Tab fills them all through the executor. Pure: it reads the screen model,
// memory and the proposal and builds the message, the recheck and the plan; publishing and running
// are the helper's.
import { ABOUT_SAYS, type AboutValue } from "../fill/about.ts";
import { PROTOCOL_VERSION, type FillField, type FillMemory, type FillProposal, type FillSource, type OfferPopup } from "../protocol.ts";
import { nodeText, type ScreenModel } from "../model.ts";
import { describeField } from "../fill/descriptor.ts";
import { describeInput, emptyInput, memoryValue } from "../fill/fill.ts";
import type { PopupBlock, PopupRef } from "../popup.ts";
import type { Plan } from "../executor/schema.ts";
import { offerField } from "./field.ts";

/** Rows the fields block lists before "and N more". Assumed, not measured. */
export const MAX_FILL_ROWS = 5;

type GroundedField = FillField & { value: string } & ({ source: FillSource; memory: null } | { source: null; memory: FillMemory });
/** A proposal every field of which carries a value and where it came from: a window, or memory. */
export type GroundedProposal = Omit<FillProposal, "fields"> & { fields: GroundedField[] };

/** An About entry as a fill may use it now, or null when it is gone, paused, not typed or fits no field (the helper reads memory). */
export type AboutNow = (id: string) => AboutValue | null;

/**
 * The part of a proposal Caret writes: its text fields. Selects, radio groups, boxes, dates and times are
 * hand-offs (FillField.handoff) the pop-up does not run, so a form's pop-up is judged on its text fields (B24).
 */
export function writtenFields(p: FillProposal): FillProposal {
  return { ...p, fields: p.fields.filter((f) => f.control === "text") };
}

/** A pop-up is offered only for two or more fields, each with a value and the window or memory entry it came from. */
export function fillPopupEligible(p: FillProposal): p is GroundedProposal {
  return p.fields.length >= 2 && p.fields.every((f) => f.value !== null && (f.source !== null || f.memory !== null));
}

/** Where a field's value came from, as a pop-up ref. */
function valueRef(f: GroundedField): PopupRef {
  return f.source !== null ? { node: `${f.source.windowId}/${f.source.nodeKey}`, quote: f.value } : { memory: f.memory.id };
}

const nodeRef = (windowId: string, key: string): { node: string } => ({ node: `${windowId}/${key}` });

/** "App, Title", or the app alone when the title is empty or repeats it. */
function sourceText(s: FillSource): string {
  const title = s.windowTitle.trim();
  return title === "" || title === s.appName ? s.appName : `${s.appName}, ${title}`;
}

/** The field's name as the pop-up shows it: its label, the nearest label text, its placeholder, or "Field". */
export function fieldLabel(model: ScreenModel, windowId: string, key: string): string {
  const w = model.windows.get(windowId);
  const n = w?.nodes.get(key);
  if (w === undefined || n === undefined) return "Field";
  const d = describeField(w, n);
  return d.label ?? d.nearest ?? d.placeholder ?? "Field";
}

/** The popup message for an eligible proposal. Its offerKey and spec id are the proposal id. */
export function buildFillPopup(model: ScreenModel, p: GroundedProposal): OfferPopup {
  const fields = p.fields;
  const windows = fields.flatMap((f) => (f.source === null ? [] : [f.source]));
  const memories = [...new Set(fields.flatMap((f) => (f.memory === null ? [] : [f.memory.id])))];
  // The source line names each window once, then what the user told Caret: "from Mail, Invoice 2041 and what you told Caret".
  const refs: PopupRef[] = [...[...new Set(windows.map((s) => `${s.windowId}/${s.nodeKey}`))].map((node) => ({ node })), ...memories.map((memory) => ({ memory }))];
  // One window and nothing from memory: the first field's source node stands for the window, as before B17.
  const first = windows[0];
  const oneWindow = memories.length === 0 && first !== undefined && windows.every((s) => s.windowId === first.windowId);
  const source: PopupRef = oneWindow ? nodeRef(first.windowId, first.nodeKey) : refs.length === 1 ? (refs[0] as PopupRef) : { rule: "sources", derived: refs };
  const text = [...new Set(windows.map(sourceText)), ...(memories.length > 0 ? [ABOUT_SAYS] : [])].join(" and ");
  const rows = fields.slice(0, MAX_FILL_ROWS).map((f) => ({
    destination: { text: fieldLabel(model, p.windowId, f.key), ref: { rule: "fieldLabel", derived: [nodeRef(p.windowId, f.key)] } },
    value: { text: f.value, ref: valueRef(f) },
    state: "ready" as const,
  }));
  const more = fields.length - rows.length;
  const blocks: PopupBlock[] = [
    { type: "header", title: { text: `Fill ${fields.length} fields`, ref: { rule: "count", derived: fields.map((f) => nodeRef(p.windowId, f.key)) } } },
    { type: "source", value: { text, ref: source } },
    { type: "fields", rows, ...(more > 0 ? { more } : {}) },
    { type: "actions", items: [{ id: "fillAll", label: "Fill all", key: "tab" }] },
  ];
  const form = model.windows.get(p.windowId);
  if (form === undefined) throw new Error(`the form's window ${p.windowId} is not in the model`);
  return {
    type: "popup",
    v: PROTOCOL_VERSION,
    offerKey: p.id,
    at: p.at,
    field: offerField(form, p.triggerKey),
    spec: { v: 1, id: p.id, figure: "offering", blocks },
    // Apps only: a pop-up filled from memory alone names none, and the key is left out.
    ...(windows.length === 0 ? {} : { sourceApps: [...new Set(windows.map((s) => s.appName))] }),
  };
}

/**
 * Why the fill can no longer be done as shown, or null. Every destination must still be there, editable,
 * empty and described as it was when Jev was asked, and every source must still show the value: a fill
 * value is a span, so the source node's text must contain it, or one of its typed values must be it. A
 * value from memory must still be what that entry holds: forgetting, pausing or editing it ends the offer.
 */
export function recheckFill(model: ScreenModel, p: GroundedProposal, about: AboutNow): string | null {
  const w = model.windows.get(p.windowId);
  if (w === undefined) return "the form's window closed";
  for (const f of p.fields) {
    const node = w.nodes.get(f.key);
    if (node === undefined) return `the field ${f.key} is gone`;
    const input = emptyInput(w, f.key);
    if (input === null) return `the field ${f.key} is no longer empty`;
    if (describeInput(w, input) !== f.descriptor) return `the field ${f.key} now reads differently`;
    if (f.source === null) {
      // The label decided which fields the entry was offered to (about.ts), so a renamed entry ends the offer too.
      const now = about(f.memory.id);
      if (now === null || memoryValue(now.value, f.memory.part) !== f.value || now.label !== f.memory.label) return `what you told Caret as ${f.memory.label} changed`;
      continue;
    }
    const sw = model.windows.get(f.source.windowId);
    const src = sw?.nodes.get(f.source.nodeKey);
    if (sw === undefined || src === undefined) return `the source ${f.source.nodeKey} is gone`;
    if (!nodeText(src).includes(f.value) && !sw.values.some((v) => v.nodeKey === f.source.nodeKey && v.text === f.value)) return `the source ${f.source.nodeKey} changed`;
  }
  return null;
}

/**
 * One value end state per field, on the exact key, so a field that has gone stops the step instead of
 * falling back to another. Every string read from the screen (title, labels, values) is passed as a
 * slot, so braces in it are never read as a placeholder.
 */
export function fillPlan(model: ScreenModel, p: GroundedProposal): { plan: Plan; slots: Record<string, string> } {
  const w = model.windows.get(p.windowId);
  const slots: Record<string, string> = { title: w?.window.title ?? "" };
  const declared: Record<string, string> = { title: "the form window's title" };
  // Where each slot was read, so a target question that quotes one charges that window (Plan.sources).
  const sources: Record<string, string> = { title: p.windowId };
  const steps = p.fields.map((f, i) => {
    slots[`v${i}`] = f.value;
    slots[`l${i}`] = fieldLabel(model, p.windowId, f.key);
    // A value from memory is no window's text, so no window is charged when a question quotes it.
    if (f.source !== null) sources[`v${i}`] = f.source.windowId;
    sources[`l${i}`] = p.windowId;
    declared[`v${i}`] = `value ${i + 1}`;
    declared[`l${i}`] = `the name of field ${i + 1}`;
    return {
      says: `{{l${i}}} holds {{v${i}}}`,
      // A value from memory is checked against the entry again right before it is written (executor.ts).
      ...(f.memory === null ? {} : { memory: f.memory.id }),
      end: {
        kind: "valueEquals" as const,
        window: { bundleId: p.bundleId, title: "{{title}}" },
        target: { key: f.key, describe: `the {{l${i}}} field` },
        value: `{{v${i}}}`,
      },
    };
  });
  return { plan: { id: p.id, title: `Fill ${p.fields.length} fields`, slots: declared, sources, steps }, slots };
}
