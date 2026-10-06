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
import { splitAddress, splitPlace } from "../fill/derive.ts";
import { describeInput, emptyInput, memoryRefOf, memoryValue } from "../fill/fill.ts";
import type { PopupBlock, PopupRef } from "../popup.ts";
import type { Plan } from "../executor/schema.ts";
import { offerField } from "./field.ts";
import { PAGE_WINDOW_KIND } from "../engines/windows.ts";
import { ANSWER_SAYS, guardAnswer, pageText, type PageContext } from "../fill/answers.ts";
import type { SavedAnswer } from "../memory/answers.ts";
import { SAVED_ANSWER_RULE } from "./answer-gate.ts";

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
  /** P2: why a field Caret meant to write is the user's after all (it failed its recheck, recheckFields); absent otherwise. */
  why?: string;
}

/** The fields of a proposal Caret writes, each with a value and where it came from, and the form's fields it leaves to the user. */
export type GroundedProposal = Omit<FillProposal, "fields"> & { fields: GroundedField[]; yours: YourField[] };

/** An About entry as a fill may use it now, or null when it is gone, paused, not typed or fits no field (the helper reads memory). */
export type AboutNow = (id: string) => AboutValue | null;
/** A saved answer as answers.md holds it now, read by content, or null when it is gone, paused or broken (S1). */
export type AnswerNow = (id: string) => SavedAnswer | null;

/** Where a value came from, as a pop-up ref: the source node and the span quoted there, or the memory entry. */
function sourceRef(source: FillSource | null, memory: FillMemory | null, span: string): PopupRef | null {
  if (source !== null) return { node: `${source.windowId}/${source.nodeKey}`, quote: span };
  return memory === null ? null : { memory: memory.id };
}

/** Whether a field's value is a saved answer (S1). */
const isAnswer = (f: FillField): boolean => f.answer !== undefined && f.answer.withheld === null && f.value !== null;

/**
 * The part of a proposal Caret writes, and what it leaves to the user. Written: every text field with a value, and
 * (D2-04) every control whose hand-off says Caret writes it (FillHandoff.writes: in a window the page engine owns, a
 * native select, radio group, checkbox, date, time or custom dropdown). Left to the user: every other field of the
 * proposal, with the value Caret would use when it has one, and, when `w` (the form's window) is given, the form's
 * empty controls fill never asks about: a file input, a consent or sign-up box, a control past the question's cap.
 */
export function writtenFields(p: FillProposal, w?: WindowState, opts: { answers?: boolean } = {}): GroundedProposal {
  const fields: GroundedField[] = [];
  const yours: YourField[] = [];
  let answers = 0;
  for (const f of p.fields) {
    const span = f.asks[0]?.value ?? null;
    // S1: a saved answer is written only from a pop-up row that shows it whole, and buildFillPopup lists every answer
    // first, so at most MAX_FILL_ROWS of them are written; one more, or any on a path with no preview of its own
    // (`answers: false`, the host's Command-1), is the user's to fill.
    if (isAnswer(f) && (opts.answers === false || answers >= MAX_FILL_ROWS)) {
      yours.push({ key: f.key, value: null });
      continue;
    }
    if (isAnswer(f)) answers++;
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
    // A field dropped by its recheck says why, in place of the value Caret no longer stands behind (P2).
    const value = y.why !== undefined ? { text: `${name}: ${y.why}`, ref: { rule: "fieldLabel", derived: [field] } } : y.value === null ? { text: name, ref: { rule: "fieldLabel", derived: [field] } } : { text: `${name}: ${y.value.display}`, ref: { rule: "handoff", derived: [field, y.value.ref] } };
    return { label: i === 0 ? "You set" : "", value, secondary: true as const };
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
  const told = fields.some((f) => f.memory !== null && !isAnswer(f));
  const saved = fields.filter(isAnswer).length;
  // The source line names each window once, then what the user told Caret: "from Mail, Invoice 2041 and what you told Caret".
  const refs: PopupRef[] = [...[...new Set(windows.map((s) => `${s.windowId}/${s.nodeKey}`))].map((node) => ({ node })), ...memories.map((memory) => ({ memory }))];
  // One window and nothing from memory: the first field's source node stands for the window, as before B17.
  const first = windows[0];
  const oneWindow = memories.length === 0 && first !== undefined && windows.every((s) => s.windowId === first.windowId);
  const source: PopupRef = oneWindow ? nodeRef(first.windowId, first.nodeKey) : refs.length === 1 ? (refs[0] as PopupRef) : { rule: "sources", derived: refs };
  const text = [...new Set(windows.map(sourceText)), ...(told ? [ABOUT_SAYS] : []), ...(saved === 0 ? [] : [saved === 1 ? ANSWER_SAYS : `${ANSWER_SAYS}s`])].join(" and ");
  // S1: every saved answer is in a row the pop-up shows, never in "and N more", and its value is the whole answer: it
  // is written only as the user saw it (writtenFields keeps at most MAX_FILL_ROWS of them).
  const room = Math.max(0, MAX_FILL_ROWS - saved);
  const others = fields.filter((f) => !isAnswer(f)).slice(0, room);
  const shown = fields.filter((f) => isAnswer(f) || others.includes(f));
  const rows = shown.map((f) => ({
    destination: { text: fieldLabel(model, p.windowId, f.key), ref: { rule: "fieldLabel", derived: [nodeRef(p.windowId, f.key)] } },
    value: { text: f.display, ref: isAnswer(f) ? { rule: SAVED_ANSWER_RULE, derived: [valueRef(f)] } : valueRef(f) },
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
 * Whether a part code derives from a whole unlabelled line is exactly `span` (P2): a place's city, state or country
 * (derive.ts splitPlace), or an address's street, unit, city, state or ZIP (splitAddress). The derivation fill made is
 * made again on the line as it reads now, so a line that is no longer the place is not enough however much of it is
 * left. A line that gained a label is not this line: "Do not use: Oakland, California, United States" passes nothing
 * (P2 review). A value from a labelled line is checked by its label instead (sourceHolds).
 */
function derivesSpan(line: string, span: string): boolean {
  const t = line.trim();
  const place = splitPlace(t);
  if (place !== null && (place.city === span || place.state === span || place.country === span)) return true;
  const address = splitAddress(t);
  return address !== null && Object.values(address).includes(span);
}

/**
 * Whether a source window still shows a fill value the way fill read it: `span` is the source text the value was read
 * from, `context` the label of its "Label: value" line (FillHandoff.context), `control` what it was read for. Shared by
 * recheckFill and a page goal's precheck (P2, goals/runs.ts), so both hold a value to one rule.
 *   - From a "Label: value" line: that very line must still hold the span; a box's line must still say exactly it.
 *     "Valid driving license: no" beside "Needs renewal: yes" still shows "yes", but no longer says it (D2-04 review).
 *   - A control's value from an unlabelled line: a line that is the span, the same typed value, or (P2) a line whose
 *     place or address still derives the span (derivesSpan). "I have a valid driving license? No." holds the old span
 *     "No" but says otherwise, and is still refused: a span inside a longer line passes only by that same derivation.
 *   - A text field's value: the node's text holds the span, or one of its typed values is it.
 */
export function sourceHolds(sw: WindowState, nodeKey: string, span: string, context: string | null, control: string): boolean {
  const src = sw.nodes.get(nodeKey);
  if (src === undefined) return false;
  const typed = sw.values.some((v) => v.nodeKey === nodeKey && v.text === span);
  if (context !== null) {
    const box = control === "checkbox";
    return labelledLines(sw).some((l) => l.node.key === nodeKey && l.label === context && (box ? l.value === span : l.value.includes(span)));
  }
  if (control !== "text") return typed || nodeText(src).split(/\r?\n/).some((l) => l.trim() === span.trim() || derivesSpan(l, span));
  return nodeText(src).includes(span) || typed;
}

/** Why one field of a proposal can no longer be filled as shown: `log` names keys for the log, `says` is the user's sentence. */
type FieldStale = { log: string; says: string };

function recheckField(model: ScreenModel, w: WindowState, f: GroundedField, about: AboutNow, answer: AnswerNow, page: PageContext | null): FieldStale | null {
  const node = w.nodes.get(f.key);
  if (node === undefined) return { log: `the field ${f.key} is gone`, says: "the field is gone" };
  const input = emptyInput(w, f.key);
  if (input === null) return { log: `the field ${f.key} is no longer empty`, says: "it's no longer empty" };
  if (describeInput(w, input) !== f.descriptor) return { log: `the field ${f.key} now reads differently`, says: "it reads differently now" };
  if (f.source === null && f.answer !== undefined) {
    // S1: the answer as answers.md holds it now must still be the text shown, word for word, for the same question, and
    // still pass the guards on the page as it is now: its organization, and a maxlength the page may have lowered.
    const now = answer(f.memory.id);
    if (now === null || now.fields.answer !== f.value || now.fields.question !== f.memory.label) {
      const said = `your saved answer to "${f.memory.label}" changed`;
      return { log: said, says: said };
    }
    const held = guardAnswer(now, pageText(w, page ?? { site: null, headings: [] }), node.maxLength);
    return held === null ? null : { log: held.says, says: held.says };
  }
  if (f.source === null) {
    // The label decided which fields the entry was offered to (about.ts), so a renamed entry ends the offer too.
    const now = about(f.memory.id);
    if (now === null || memoryValue(now.value, f.memory.part) !== f.span || now.label !== f.memory.label) {
      const said = `what you told Caret as ${f.memory.label} changed`;
      return { log: said, says: said };
    }
    return null;
  }
  const sw = model.windows.get(f.source.windowId);
  const key = f.source.nodeKey;
  if (sw === undefined || sw.nodes.get(key) === undefined) return { log: `the source ${key} is gone`, says: "where Caret read its value is gone" };
  return sourceHolds(sw, key, f.span, f.context, f.control) ? null : { log: `the source ${key} changed`, says: "where Caret read its value changed" };
}

/**
 * Why the fill can no longer be done as shown, or null. Every destination must still be there, empty (no text, no
 * box ticked, no option picked) and described as it was when Jev was asked, and every source must still show what
 * the value was read from (sourceHolds). A value from memory must still be what that entry holds: forgetting, pausing
 * or editing it ends the offer. The first field that fails says why; recheckFields drops each one instead.
 */
export function recheckFill(model: ScreenModel, p: GroundedProposal, about: AboutNow, answer: AnswerNow = () => null, page: PageContext | null = null): string | null {
  const w = model.windows.get(p.windowId);
  if (w === undefined) return "the form's window closed";
  for (const f of p.fields) {
    const stale = recheckField(model, w, f, about, answer, page);
    if (stale !== null) return stale.log;
  }
  return null;
}

/**
 * P2: the proposal with each field that fails recheckFill's checks moved to the user's, with why, so one bad field no
 * longer cancels the whole fill (P1: on W4's saved Greenhouse pages one Country value refused every field). `stale`
 * only when the form's window closed. `dropped` lists each field left out, with the log's words.
 */
export function recheckFields(model: ScreenModel, p: GroundedProposal, about: AboutNow, answer: AnswerNow = () => null, page: PageContext | null = null): { proposal: GroundedProposal; dropped: { key: string; log: string }[] } | { stale: string } {
  const w = model.windows.get(p.windowId);
  if (w === undefined) return { stale: "the form's window closed" };
  const fields: GroundedField[] = [];
  const yours: YourField[] = [...p.yours];
  const dropped: { key: string; log: string }[] = [];
  for (const f of p.fields) {
    const stale = recheckField(model, w, f, about, answer, page);
    if (stale === null) {
      fields.push(f);
      continue;
    }
    dropped.push({ key: f.key, log: stale.log });
    yours.unshift({ key: f.key, value: null, why: stale.says });
  }
  return { proposal: { ...p, fields, yours }, dropped };
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
    // S1: a saved answer's step never quotes it: step sentences reach every consumer in progress and activity messages,
    // and only a host that shows answers whole may see one.
    const saved = f.answer !== undefined;
    // A control's step says its value as the pop-up does ("Shift set to Night"), not as the field holds it.
    if (control) {
      slots[`d${i}`] = f.display;
      declared[`d${i}`] = `value ${i + 1} as the pop-up says it`;
      if (f.source !== null) sources[`d${i}`] = f.source.windowId;
    }
    return {
      says: control ? `{{l${i}}} set to {{d${i}}}` : saved ? `{{l${i}}} holds your saved answer` : `{{l${i}}} holds {{v${i}}}`,
      // A value from memory is checked against the entry again right before it is written (executor.ts).
      // A part of a remembered name names its part ("about-1#first"), so the check splits the entry the same way.
      ...(f.memory === null ? {} : { memory: memoryRefOf(f.memory) }),
      end: {
        kind: "valueEquals" as const,
        window: { bundleId: p.bundleId, title: "{{title}}", ...(w?.window.kind === PAGE_WINDOW_KIND ? { page: true as const, windowId: p.windowId } : {}) },
        target: { key: f.key, describe: `the {{l${i}}} field` },
        value: `{{v${i}}}`,
      },
    };
  });
  return { plan: { id: p.id, title: `Fill ${p.fields.length} fields`, slots: declared, sources, steps }, slots };
}
