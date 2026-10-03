// A grounded fill as a pop-up: when every field of a proposal has a value copied from a source on
// screen, the host shows "Fill N fields" with each destination and value, and Tab fills them all
// through the executor. Pure: it reads the screen model and the proposal and builds the message, the
// recheck and the plan; publishing and running are the helper's.
import { PROTOCOL_VERSION, type FillField, type FillProposal, type FillSource, type OfferPopup } from "../protocol.ts";
import { nodeText, type ScreenModel } from "../model.ts";
import { describeField } from "../fill/descriptor.ts";
import type { PopupBlock, PopupRef } from "../popup.ts";
import type { Plan } from "../executor/schema.ts";
import { offerField } from "./field.ts";

/** Rows the fields block lists before "and N more". Assumed, not measured. */
export const MAX_FILL_ROWS = 5;

type GroundedField = FillField & { value: string; source: FillSource };
/** A proposal every field of which carries a value and its source. */
export type GroundedProposal = Omit<FillProposal, "fields"> & { fields: GroundedField[] };

/** A pop-up is offered only for two or more fields, each with a value and the source it was copied from. */
export function fillPopupEligible(p: FillProposal): p is GroundedProposal {
  return p.fields.length >= 2 && p.fields.every((f) => f.value !== null && f.source !== null);
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
  const first = fields[0] as GroundedField;
  const sourceWindows = new Set(fields.map((f) => f.source.windowId));
  let source: PopupRef;
  let text: string;
  if (sourceWindows.size === 1) {
    source = nodeRef(first.source.windowId, first.source.nodeKey);
    text = sourceText(first.source);
  } else {
    const refs = [...new Set(fields.map((f) => `${f.source.windowId}/${f.source.nodeKey}`))].map((node) => ({ node }));
    source = { rule: "sources", derived: refs };
    text = [...new Set(fields.map((f) => sourceText(f.source)))].join(" and ");
  }
  const rows = fields.slice(0, MAX_FILL_ROWS).map((f) => ({
    destination: { text: fieldLabel(model, p.windowId, f.key), ref: { rule: "fieldLabel", derived: [nodeRef(p.windowId, f.key)] } },
    value: { text: f.value, ref: { node: `${f.source.windowId}/${f.source.nodeKey}`, quote: f.value } },
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
    sourceApps: [...new Set(fields.map((f) => f.source.appName))],
  };
}

/**
 * Why the fill can no longer be done as shown, or null. Every destination must still be there, editable
 * and empty, and every source must still show the value: a fill value is a span, so the source node's
 * text must contain it, or one of its typed values must be it.
 */
export function recheckFill(model: ScreenModel, p: GroundedProposal): string | null {
  const w = model.windows.get(p.windowId);
  if (w === undefined) return "the form's window closed";
  for (const f of p.fields) {
    const node = w.nodes.get(f.key);
    if (node === undefined) return `the field ${f.key} is gone`;
    if (node.editable !== true || (node.value ?? "") !== "") return `the field ${f.key} is no longer empty`;
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
  const steps = p.fields.map((f, i) => {
    slots[`v${i}`] = f.value;
    slots[`l${i}`] = fieldLabel(model, p.windowId, f.key);
    declared[`v${i}`] = `value ${i + 1}`;
    declared[`l${i}`] = `the name of field ${i + 1}`;
    return {
      says: `{{l${i}}} holds {{v${i}}}`,
      end: {
        kind: "valueEquals" as const,
        window: { bundleId: p.bundleId, title: "{{title}}" },
        target: { key: f.key, describe: `the {{l${i}}} field` },
        value: `{{v${i}}}`,
      },
    };
  });
  return { plan: { id: p.id, title: `Fill ${p.fields.length} fields`, slots: declared, steps }, slots };
}
