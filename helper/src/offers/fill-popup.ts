// A grounded fill as a pop-up: when every text field of a proposal has a value copied from a source on
// screen or from what the user told Caret (fill/about.ts), the host shows "Fill N fields" with each
// destination and value, and Tab fills them all through the executor in one transaction: one task under
// one grant, each field read back, stopped by the user's input, a revoke or a page that moved, and undone
// in one undo (D2-04). Whatever Caret does not write is listed as the user's to set. Pure: it reads the
// screen model, memory and the proposal and builds the message, the recheck and the plan; publishing and
// running are the helper's.
import { ABOUT_SAYS, type AboutValue } from "../fill/about.ts";
import { PAGE_SUBROLE, PROTOCOL_VERSION, type FillField, type FillMemory, type FillProposal, type FillSource, type OfferPopup } from "../protocol.ts";
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import { describeField } from "../fill/descriptor.ts";
import { boxNeverTicked, formControls, inWebArea } from "../fill/controls.ts";
import { labelledLines } from "../fill/candidates.ts";
import { describeInput, emptyInput, memoryRefOf, memoryValue } from "../fill/fill.ts";
import type { PopupBlock, PopupRef } from "../popup.ts";
import type { Plan } from "../executor/schema.ts";
import { offerField } from "./field.ts";

/** Rows the fields block, and the block of fields the user sets, list before "and N more". Assumed, not measured. */
export const MAX_FILL_ROWS = 5;

/**
 * A field Caret writes, with its value in the form the field takes it: a text field's text, or (D2-04) a control's
 * option name, PAGE_CHECKED, or date or time in the input's own format. `span` is the source text the value was read
 * from, which a recheck looks for in the source again, on the line labelled `context` when the value came from a
 * "Label: value" line (FillHandoff.context); `display` is how the pop-up says the value.
 */
type GroundedField = FillField & { value: string; span: string; display: string; context: string | null } & ({ source: FillSource; memory: null } | { source: null; memory: FillMemory });

/** A field of the form that Caret leaves to the user: its name, and the value Caret would use when it has one. */
export interface YourField {
  key: string;
  /** The value as the pop-up says it, and where it came from; null when Caret has none. */
  value: { display: string; ref: PopupRef } | null;
}

/** The fields of a proposal Caret writes, each with a value and where it came from, and the form's fields it leaves to the user. */
export type GroundedProposal = Omit<FillProposal, "fields"> & { fields: GroundedField[]; yours: YourField[] };

/** An About entry as a fill may use it now, or null when it is gone, paused, not typed or fits no field (the helper reads memory). */
export type AboutNow = (id: string) => AboutValue | null;

/** Where a value came from, as a pop-up ref: the source node and the span quoted there, or the memory entry. */
function sourceRef(source: FillSource | null, memory: FillMemory | null, span: string): PopupRef | null {
  if (source !== null) return { node: `${source.windowId}/${source.nodeKey}`, quote: span };
  return memory === null ? null : { memory: memory.id };
}

/**
 * The part of a proposal Caret writes, and what it leaves to the user. Written: every text field with a value, and
 * (D2-04) every control whose hand-off says Caret writes it (FillHandoff.writes: in a window the page engine owns, a
 * native select, radio group, checkbox, date, time or custom dropdown). Left to the user: every other field of the
 * proposal, with the value Caret would use when it has one, and, when `w` (the form's window) is given, the form's
 * empty controls fill never asks about: a file input, a consent or sign-up box, a control past the question's cap.
 */
export function writtenFields(p: FillProposal, w?: WindowState): GroundedProposal {
  const fields: GroundedField[] = [];
  const yours: YourField[] = [];
  for (const f of p.fields) {
    const span = f.asks[0]?.value ?? null;
    if (f.control === "text" && f.value !== null && (f.source !== null || f.memory !== null)) {
      fields.push({ ...f, value: f.value, span: f.value, display: f.value, context: null } as GroundedField);
      continue;
    }
    const h = f.handoff;
    if (h !== null && h.writes === true && (h.source !== null || h.memory !== null)) {
      fields.push({ ...f, handoff: null, value: h.value, source: h.source, memory: h.memory, span: span ?? h.value, display: h.display, context: h.context ?? null } as GroundedField);
      continue;
    }
    const ref = h === null ? null : sourceRef(h.source, h.memory, span ?? h.value);
    yours.push({ key: f.key, value: h === null || ref === null ? null : { display: h.display, ref } });
  }
  if (w !== undefined) {
    const asked = new Set(p.fields.map((f) => f.key));
    const empty = (k: string): void => {
      if (!asked.has(k) && !yours.some((y) => y.key === k)) yours.push({ key: k, value: null });
    };
    for (const c of formControls(w)) empty(c.node.key);
    for (const n of w.nodes.values()) {
      if (n.states?.includes("disabled") === true || !inWebArea(w, n)) continue;
      const file = n.subrole === PAGE_SUBROLE.file && (n.value ?? "") === "";
      const consent = n.role === "AXCheckBox" && n.states?.includes("checked") !== true && boxNeverTicked(n.label ?? "");
      if (file || consent) empty(n.key);
    }
  }
  return { ...p, fields, yours };
}

/**
 * Whether a proposal makes a pop-up: every text field has a value and the window or memory entry it came from, and
 * Caret writes at least two fields. A text field without one leaves the form to per-field offers, as before D2-04;
 * a control without one is listed as the user's.
 */
export function fillPopupEligible(p: FillProposal): boolean {
  return p.fields.every((f) => f.control !== "text" || (f.value !== null && (f.source !== null || f.memory !== null))) && writtenFields(p).fields.length >= 2;
}

/** Where a field's value came from, as a pop-up ref. */
function valueRef(f: GroundedField): PopupRef {
  return sourceRef(f.source, f.memory, f.span) as PopupRef;
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

/**
 * The block listing what the user sets: "You set" beside the first row, each row the field's name and the value Caret
 * would use ("Resume", "Shift: Night"), then "and N more". Null when Caret writes everything.
 */
function yoursBlock(model: ScreenModel, windowId: string, yours: readonly YourField[]): PopupBlock | null {
  if (yours.length === 0) return null;
  const shown = yours.slice(0, MAX_FILL_ROWS);
  const rows = shown.map((y, i) => {
    const name = fieldLabel(model, windowId, y.key);
    const field = nodeRef(windowId, y.key);
    return {
      label: i === 0 ? "You set" : "",
      value: y.value === null ? { text: name, ref: { rule: "fieldLabel", derived: [field] } } : { text: `${name}: ${y.value.display}`, ref: { rule: "handoff", derived: [field, y.value.ref] } },
      secondary: true as const,
    };
  });
  const more = yours.length - shown.length;
  if (more > 0) rows.push({ label: "", value: { text: `and ${more} more`, ref: { rule: "count", derived: yours.slice(MAX_FILL_ROWS).map((y) => nodeRef(windowId, y.key)) } }, secondary: true });
  return { type: "facts", id: "yours", rows };
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
    value: { text: f.display, ref: valueRef(f) },
    state: "ready" as const,
  }));
  const more = fields.length - rows.length;
  const yours = yoursBlock(model, p.windowId, p.yours);
  const blocks: PopupBlock[] = [
    { type: "header", title: { text: `Fill ${fields.length} fields`, ref: { rule: "count", derived: fields.map((f) => nodeRef(p.windowId, f.key)) } } },
    { type: "source", value: { text, ref: source } },
    { type: "fields", rows, ...(more > 0 ? { more } : {}) },
    ...(yours === null ? [] : [yours]),
    // "Fill all" only when it is all: with fields left to the user, the action says how many it fills (plan section 4).
    { type: "actions", items: [{ id: "fillAll", label: yours === null ? "Fill all" : `Fill ${fields.length}`, key: "tab" }] },
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
 * Why the fill can no longer be done as shown, or null. Every destination must still be there, empty (no text, no
 * box ticked, no option picked) and described as it was when Jev was asked, and every source must still show what
 * the value was read from: a fill value is a span, so the source node's text must contain it, or one of its typed
 * values must be it. A value from memory must still be what that entry holds: forgetting, pausing or editing it ends
 * the offer.
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
      if (now === null || memoryValue(now.value, f.memory.part) !== f.span || now.label !== f.memory.label) return `what you told Caret as ${f.memory.label} changed`;
      continue;
    }
    const sw = model.windows.get(f.source.windowId);
    const src = sw?.nodes.get(f.source.nodeKey);
    if (sw === undefined || src === undefined) return `the source ${f.source.nodeKey} is gone`;
    // A value read from a "Label: value" line needs that very line: "Valid driving license: no" beside "Needs renewal:
    // yes" still shows "yes", but no longer says it (D2-04 review).
    if (f.context !== null) {
      const key = f.source.nodeKey;
      if (!labelledLines(sw).some((l) => l.node.key === key && l.label === f.context && l.value === f.span)) return `the source ${key} changed`;
      continue;
    }
    if (!nodeText(src).includes(f.span) && !sw.values.some((v) => v.nodeKey === f.source.nodeKey && v.text === f.span)) return `the source ${f.source.nodeKey} changed`;
  }
  return null;
}

/**
 * One value end state per field, on the exact key, so a field that has gone stops the step instead of falling back to
 * another. The steps run in the form's document order (D2-04), so a field a page fills from another (a state list
 * that follows the country) comes after it. Every string read from the screen (title, labels, values) is passed as a
 * slot, so braces in it are never read as a placeholder.
 */
export function fillPlan(model: ScreenModel, p: GroundedProposal): { plan: Plan; slots: Record<string, string> } {
  const w = model.windows.get(p.windowId);
  const slots: Record<string, string> = { title: w?.window.title ?? "" };
  const declared: Record<string, string> = { title: "the form window's title" };
  // Where each slot was read, so a target question that quotes one charges that window (Plan.sources).
  const sources: Record<string, string> = { title: p.windowId };
  const order = new Map([...(w?.nodes.keys() ?? [])].map((k, i) => [k, i]));
  const fields = [...p.fields].sort((a, b) => (order.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.key) ?? Number.MAX_SAFE_INTEGER));
  const steps = fields.map((f, i) => {
    slots[`v${i}`] = f.value;
    slots[`l${i}`] = fieldLabel(model, p.windowId, f.key);
    // A value from memory is no window's text, so no window is charged when a question quotes it.
    if (f.source !== null) sources[`v${i}`] = f.source.windowId;
    sources[`l${i}`] = p.windowId;
    declared[`v${i}`] = `value ${i + 1}`;
    declared[`l${i}`] = `the name of field ${i + 1}`;
    const control = f.control !== "text";
    // A control's step says its value as the pop-up does ("Shift set to Night"), not as the field holds it.
    if (control) {
      slots[`d${i}`] = f.display;
      declared[`d${i}`] = `value ${i + 1} as the pop-up says it`;
      if (f.source !== null) sources[`d${i}`] = f.source.windowId;
    }
    return {
      says: control ? `{{l${i}}} set to {{d${i}}}` : `{{l${i}}} holds {{v${i}}}`,
      // A value from memory is checked against the entry again right before it is written (executor.ts).
      // A part of a remembered name names its part ("about-1#first"), so the check splits the entry the same way.
      ...(f.memory === null ? {} : { memory: memoryRefOf(f.memory) }),
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
