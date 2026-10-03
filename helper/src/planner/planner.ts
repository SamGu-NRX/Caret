// The planner: "do X" becomes a checked plan (brief B16). Jev answers only choice questions, so the
// house rule holds here too: code proposes, Jev chooses, code copies and verifies.
//   1. Code picks the window: the one the host names, the only window with fields or buttons, or Jev's
//      choice among the titles of those windows.
//   2. Code lists the window's writable fields and labelled buttons, and the values the plan could
//      write: spans of the instruction (spans.ts), memory values, and the fill generator's candidates
//      from the other windows. Jev answers one question per field ("which value, or keep") and one about
//      buttons ("which to press, or none"), asked twice with the options shuffled and the wording
//      changed. A field is written only when both asks pick the same value and the lower confidence
//      clears the cutoff; otherwise it is withheld and left as it is, as fill withholds a field (fill.ts).
//      The plan fails as unsure only when it withheld something and has nothing left to do.
//   3. Code writes the plan: one valueEquals step per field that gets a value, keyed by element key,
//      then a handoff step for the press, its reason from the risk table (risk.ts). A press is never a
//      step Caret takes: code cannot predict what a press changes, so it could not verify it.
//   4. validatePlan checks the plan against the screen model and memory as they are once Jev answered.
// Nothing here acts. The helper offers the plan, and it runs only after the user accepts it.
import { randomInt } from "node:crypto";
import type { ScreenModel, WindowState } from "../model.ts";
import type { Node } from "../protocol.ts";
import type { AskJev, JevRequest, JevResult } from "../fill/jev.ts";
import { FILL_CUTOFF, FILLABLE_ROLES, shuffled } from "../fill/fill.ts";
import { describeCandidate, generateCandidates } from "../fill/candidates.ts";
import { describeField } from "../fill/descriptor.ts";
import { SnippetLedger, type Declared } from "../privacy.ts";
import type { Plan, Step, WindowSel } from "../executor/schema.ts";
import { instructionValues } from "./spans.ts";
import type { MemoryValue } from "./trace.ts";
import { handoffWhy, PlannerError, validatePlan, type CheckedPlan, type PlanContext } from "./validate.ts";

/**
 * Lowest agreed confidence at which a value is written. Assumed: it is the fill cutoff (fill.ts), which
 * was calibrated on fill questions, not on these; no planner calibration exists.
 */
export const PLAN_CUTOFF = FILL_CUTOFF;
/** Fields, buttons and values one question lists. Assumed, sized like the fill question's. */
export const MAX_PLAN_FIELDS = 20;
export const MAX_PLAN_BUTTONS = 20;
export const MAX_PLAN_VALUES = 40;
const KEEP = "keep";
const NONE = "none";
/** A refused SnippetLedger take means the text cannot go out at all, so the question is not asked. */
const PRIVACY_SAYS = "your instruction quotes more of an open window than one question to Jev may carry, so Caret did not ask";

/** Memory as the planner reads it, at the start and again when it checks the plan. */
export interface PlannerMemory {
  values(): readonly MemoryValue[];
}

export interface PlanTaskOptions {
  askJev: AskJev;
  /** The plan's id, which is also the offer's key and the task id it runs under. */
  offerKey: string;
  /** The window the user means, when the host knows it. */
  windowId?: string;
  now?: number;
  rand?: (n: number) => number;
  cutoff?: number;
  /** Called after Jev's last answer and before the plan is checked. Fault injection for the evaluation only. */
  beforeCheck?: () => Promise<void>;
}

/** One question's two answers, as text: a value, a window or button label, or keep and none. */
export type AskPair = [string, string];

export interface PlanDraft {
  /** The plan with {{slots}}; `slots` fills them. */
  plan: Plan;
  slots: Record<string, string>;
  checked: CheckedPlan;
  /** Each question's two answers, for evaluation: `window`, each field by name, and `press`. */
  answers: Record<string, AskPair>;
  /** Fields (and `press`) left as they are because the asks disagreed or agreed below the cutoff. */
  withheld: { name: string; why: "disagree" | "lowConfidence" }[];
  jev: { calls: number; costUsd: number; latencyMs: number };
}

interface Option {
  id: string;
  text: string;
  describe: string;
}

interface Field {
  id: string;
  node: Node;
  name: string;
  descriptor: string;
}

/** Plans an instruction against the screen model and memory. Throws PlannerError with the failing check's code. */
export async function planTask(instruction: string, model: ScreenModel, memory: PlannerMemory, o: PlanTaskOptions): Promise<PlanDraft> {
  const rand = o.rand ?? randomInt;
  const cutoff = o.cutoff ?? PLAN_CUTOFF;
  const answers: Record<string, AskPair> = {};
  const jev = { calls: 0, costUsd: 0, latencyMs: 0 };
  const ask = async (a: JevRequest, b: JevRequest): Promise<[JevResult, JevResult]> => {
    let r: [JevResult, JevResult];
    try {
      r = await Promise.all([o.askJev(a), o.askJev(b)]);
    } catch (e) {
      throw new PlannerError("jevFailed", `the Jev request failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    }
    jev.calls += 2;
    jev.costUsd += r[0].costUsd + r[1].costUsd;
    jev.latencyMs += Math.max(r[0].latencyMs, r[1].latencyMs);
    return r;
  };

  const w = await chooseWindow(instruction, model, o, rand, cutoff, ask, answers);
  const fields = writableFields(w);
  const buttons = labelledButtons(w);
  const ledger = new SnippetLedger(model.windows.values());
  if (!ledger.plan([instruction])) throw new PlannerError("privacy", PRIVACY_SAYS);
  // A title that does not fit the window's budget is left out; the question then names the app alone.
  const title = ledger.take(w, "descriptor", [w.window.title]) ? w.window.title : null;
  // A window that is not a card gives a question less than half its text (privacy.ts), which may not hold
  // every field and button: what the instruction names is taken first, the rest in document order.
  const order = byRelevance(instruction, [...fields.map((f) => ({ key: f.node.key, name: f.name, text: f.descriptor })), ...buttons.map((b) => ({ key: b.key, name: b.label, text: b.label }))]);
  const taken = new Set(order.filter((x) => ledger.take(w, "descriptor", [x.text])).map((x) => x.key));
  // When the instruction names any field, only the fields it names are asked about: the second live pass
  // (evidence/screen/b16/planner-live) wrote an order number into two fields "Put the order number ... in
  // Reference" never named. An instruction that names no field still has every field asked about.
  const named = new Set(fields.filter((f) => relevance(instruction, f.name) > 0).map((f) => f.node.key));
  const askedFields = fields.filter((f) => taken.has(f.node.key) && (named.size === 0 || named.has(f.node.key)));
  const askedButtons = buttons.filter((b) => taken.has(b.key));
  const values = valueOptions(instruction, model, w, memory.values(), ledger, o.now ?? Date.now());
  if ((askedFields.length === 0 || values.length === 0) && askedButtons.length === 0) {
    throw new PlannerError("nothingToDo", `'${w.window.title}' has no field Caret could fill from what is on screen, in memory or in your instruction, and no button`);
  }

  // The ledger took every field's and button's descriptor that fit, but the questions carry only the asked
  // ones, so the rest are not declared; their window was still charged for them, which errs on the side of
  // saying less, as fill.ts does (B17: the privacy test's planner session caught the over-declaration).
  const questioned = values.length === 0 ? [] : askedFields;
  const sent = new Set<string | null>([title, ...questioned.map((f) => f.descriptor), ...askedButtons.map((b) => b.label)]);
  const all = ledger.declared();
  const declared: Declared = { snippets: all.snippets.filter((x) => !(x.kind === "descriptor" && x.windowId === w.window.windowId && !sent.has(x.text))), charged: all.charged };
  const second = { values: shuffled(values, rand).map((v, i) => ({ ...v, id: `k${i + 1}` })), buttons: shuffled(askedButtons, rand).map((b, i) => ({ ...b, id: `d${i + 1}` })) };
  const [r1, r2] = await ask(
    fieldRequest(instruction, w, title, questioned, values, askedButtons, 0, declared),
    fieldRequest(instruction, w, title, questioned, second.values, second.buttons, 1, declared),
  );
  const withheld: PlanDraft["withheld"] = [];
  /** The agreed option, or null for keep or none and for an answer withheld as unsure. */
  const agreed = (q: string, name: string, map1: ReadonlyMap<string, string>, map2: ReadonlyMap<string, string>, idle: string): string | null => {
    const a1 = r1.answers[q];
    const a2 = r2.answers[q];
    if (a1 === undefined || a2 === undefined) throw new PlannerError("jevFailed", `Jev gave no answer about ${name}`);
    const t1 = a1.choice === idle ? idle : map1.get(a1.choice);
    const t2 = a2.choice === idle ? idle : map2.get(a2.choice);
    if (t1 === undefined || t2 === undefined) throw new PlannerError("jevFailed", `Jev chose an option that was not offered for ${name}`);
    answers[name] = [t1, t2];
    if (t1 !== t2) {
      withheld.push({ name, why: "disagree" });
      return null;
    }
    if (t1 === idle) return null;
    if (Math.min(a1.confidence, a2.confidence) < cutoff) {
      withheld.push({ name, why: "lowConfidence" });
      return null;
    }
    return t1;
  };
  const byId = (xs: readonly { id: string; text: string }[]): Map<string, string> => new Map(xs.map((x) => [x.id, x.text]));
  const writes: { field: Field; value: string }[] = [];
  for (const f of questioned) {
    const v = agreed(f.id, f.name, byId(values), byId(second.values), KEEP);
    if (v !== null) writes.push({ field: f, value: v });
  }
  const pressLabel = askedButtons.length === 0 ? null : agreed("press", "press", byId(askedButtons.map((b) => ({ id: b.id, text: b.key }))), byId(second.buttons.map((b) => ({ id: b.id, text: b.key }))), NONE);
  const press = pressLabel === null ? null : (askedButtons.find((b) => b.key === pressLabel) ?? null);
  if (press !== null) answers.press = [press.label, press.label];
  if (writes.length === 0 && press === null) {
    if (withheld.length > 0) throw new PlannerError("unsure", `Jev was not sure enough about ${withheld.map((x) => `${x.name} (${x.why === "disagree" ? "the asks disagreed" : "low confidence"})`).join(", ")}, and nothing else is left to do`);
    throw new PlannerError("nothingToDo", "Jev found nothing in your instruction to write or press here");
  }

  const sel: WindowSel = { bundleId: w.app.bundleId, title: w.window.title };
  const slots: Record<string, string> = {};
  const slotNames: Record<string, string> = {};
  const steps: Step[] = writes.map(({ field, value }, i) => {
    const slot = `v${i + 1}`;
    slots[slot] = value;
    slotNames[slot] = `the value for ${field.name}`;
    // The element key alone: a field that is gone is refused, never matched again by its label.
    return { says: `${field.name} holds {{${slot}}}`, end: { kind: "valueEquals", window: sel, target: { key: field.node.key, describe: `the ${field.name} field` }, value: `{{${slot}}}` } };
  });
  if (press !== null) {
    steps.push({ says: `You press '${press.label}'`, end: { kind: "handoff", window: sel, target: { key: press.key, describe: `the ${press.label} button` }, why: handoffWhy(press.label) } });
  }
  const plan: Plan = { id: o.offerKey, title: titleOf(instruction), slots: slotNames, steps };

  await o.beforeCheck?.();
  const ctx: PlanContext = { model, memory: memory.values(), instruction };
  const checked = validatePlan(plan, slots, ctx);
  // The plan names its window by app and title; one that replaced the chosen window while Jev answered is another window.
  if (checked.window.window.windowId !== w.window.windowId) throw new PlannerError("unknownWindow", `'${w.window.title}' closed while Caret planned, and another window took its title`);
  // A value copied from a window charges that window when a target question quotes it (Plan.sources).
  const sources: Record<string, string> = {};
  // Writes come first, in order, so step i fills slot v<i+1>.
  for (const wr of checked.writes) if (wr.trace.from === "window") sources[`v${wr.step + 1}`] = wr.trace.windowId;
  const withSources: Plan = Object.keys(sources).length === 0 ? plan : { ...plan, sources };
  return { plan: withSources, slots, checked, answers, withheld, jev };
}

/** Words that say what to do rather than where; they do not make a field or button relevant. */
const COMMON = new Set(["the", "and", "for", "from", "into", "with", "this", "that", "set", "put", "write", "fill", "copy", "use", "make", "add", "enter", "type", "change", "her", "his", "their", "our", "your", "its"]);
const wordsOf = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 3 && !COMMON.has(x));

/** How many of the instruction's words a name shares. */
export function relevance(instruction: string, name: string): number {
  const said = new Set(wordsOf(instruction));
  return new Set(wordsOf(name).filter((x) => said.has(x))).size;
}

/** Items by how many of the instruction's words their names share, most first; ties keep document order. */
export function byRelevance<T extends { name: string }>(instruction: string, items: readonly T[]): T[] {
  return items
    .map((it, i) => ({ it, i, score: relevance(instruction, it.name) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.it);
}

/** The plan's sentence: the instruction, cut to a line. */
function titleOf(instruction: string): string {
  const t = instruction.replace(/\s+/g, " ").trim();
  return t.length <= 100 ? t : `${t.slice(0, 99)}…`;
}

/** A field's name as the plan and its pop-up say it: its section, then its label, nearest label or placeholder. */
export function fieldName(w: WindowState, n: Node): string {
  const d = describeField(w, n);
  return [d.section, d.label ?? d.nearest ?? d.placeholder].filter((x) => x !== null).join(" ") || "field";
}

function writableFields(w: WindowState): Field[] {
  const out: Field[] = [];
  for (const n of w.nodes.values()) {
    if (out.length >= MAX_PLAN_FIELDS) break;
    if (n.editable !== true || !FILLABLE_ROLES.has(n.role) || n.states?.includes("secure")) continue;
    out.push({ id: `f${out.length + 1}`, node: n, name: fieldName(w, n), descriptor: describeField(w, n).text });
  }
  return out;
}

interface Button {
  id: string;
  key: string;
  label: string;
}

function labelledButtons(w: WindowState): Button[] {
  const out: Button[] = [];
  for (const n of w.nodes.values()) {
    if (out.length >= MAX_PLAN_BUTTONS) break;
    const label = (n.label ?? "").trim();
    if (n.role !== "AXButton" || label === "" || n.states?.includes("disabled")) continue;
    out.push({ id: `b${out.length + 1}`, key: n.key, label });
  }
  return out;
}

/** A window the planner can act in: it has a writable field or a labelled button. */
function actionable(w: WindowState): boolean {
  return writableFields(w).length > 0 || labelledButtons(w).length > 0;
}

/** Values to choose from: the instruction's spans, then memory, then the other windows' candidates; each text once. */
function valueOptions(instruction: string, model: ScreenModel, w: WindowState, memory: readonly MemoryValue[], ledger: SnippetLedger, now: number): Option[] {
  const out: Option[] = [];
  const seen = new Set<string>();
  const add = (text: string, describe: string): void => {
    if (out.length >= MAX_PLAN_VALUES || seen.has(text)) return;
    seen.add(text);
    out.push({ id: `v${out.length + 1}`, text, describe });
  };
  const spans = instructionValues(instruction);
  if (ledger.plan(spans)) for (const s of spans) add(s, `"${s}" (written in the instruction)`);
  for (const m of memory) if (ledger.plan([m.text, m.label])) add(m.text, `"${m.text}" (from the user's memory: ${m.label})`);
  for (const c of generateCandidates(model, w.window.windowId, MAX_PLAN_VALUES, now, ledger)) add(c.text, describeCandidate(c));
  return out;
}

const WINDOW_WORDINGS = [
  (instr: string) => `The user asked: "${instr}". In which of these windows should that be done? Choose none if no window fits.`,
  (instr: string) => `Instruction: "${instr}". Pick the window the instruction is about, or none if it is about none of them.`,
] as const;

async function chooseWindow(
  instruction: string,
  model: ScreenModel,
  o: PlanTaskOptions,
  rand: (n: number) => number,
  cutoff: number,
  ask: (a: JevRequest, b: JevRequest) => Promise<[JevResult, JevResult]>,
  answers: Record<string, AskPair>,
): Promise<WindowState> {
  if (o.windowId !== undefined) {
    const w = model.windows.get(o.windowId);
    if (w === undefined || !actionable(w)) throw new PlannerError("noWindow", `window ${o.windowId} is not open or has no field or button`);
    return w;
  }
  const candidates = [...model.windows.values()].filter(actionable);
  if (candidates.length === 0) throw new PlannerError("noWindow", "no open window has a field or a button");
  if (candidates.length === 1) return candidates[0] as WindowState;
  const ledger = new SnippetLedger(model.windows.values());
  if (!ledger.plan([instruction])) throw new PlannerError("privacy", PRIVACY_SAYS);
  const listed = candidates.filter((w) => ledger.take(w, "descriptor", [w.window.title]));
  if (listed.length === 0) throw new PlannerError("privacy", "no open window's title fits what one question to Jev may carry");
  const declared = ledger.declared();
  const first = listed.map((w, i) => ({ id: `w${i + 1}`, w }));
  const second = shuffled(first, rand).map((x, i) => ({ id: `x${i + 1}`, w: x.w }));
  const req = (list: typeof first, wording: 0 | 1): JevRequest => ({
    state: { instruction, task: "Caret is about to plan the user's instruction in one of the user's open windows." },
    questions: {
      window: {
        type: "choice",
        instructions: WINDOW_WORDINGS[wording](instruction),
        criteria: { ...Object.fromEntries(list.map((x) => [x.id, `${x.w.app.name} window '${x.w.window.title}'`])), [NONE]: "None of these windows." },
      },
    },
    snippets: declared.snippets,
    charged: declared.charged,
  });
  const [r1, r2] = await ask(req(first, 0), req(second, 1));
  const pick = (r: JevResult, list: typeof first): { w: WindowState | null; conf: number } => {
    const a = r.answers.window;
    if (a === undefined) throw new PlannerError("jevFailed", "Jev gave no answer about the window");
    if (a.choice === NONE) return { w: null, conf: a.confidence };
    const hit = list.find((x) => x.id === a.choice);
    if (hit === undefined) throw new PlannerError("jevFailed", `Jev chose ${a.choice}, which is not a window it was offered`);
    return { w: hit.w, conf: a.confidence };
  };
  const a1 = pick(r1, first);
  const a2 = pick(r2, second);
  const name = (x: { w: WindowState | null }): string => (x.w === null ? NONE : x.w.window.windowId);
  answers.window = [name(a1), name(a2)];
  if (a1.w !== a2.w) throw new PlannerError("unsure", "the two asks disagreed about which window the instruction is about");
  if (a1.w === null) throw new PlannerError("noWindow", "Jev found no open window the instruction is about");
  const conf = Math.min(a1.conf, a2.conf);
  if (conf < cutoff) throw new PlannerError("unsure", `the asks agreed on '${a1.w.window.title}' at confidence ${conf.toFixed(2)}, under ${cutoff}`);
  return a1.w;
}

const FIELD_WORDINGS = [
  (instr: string, d: string) => `The user asked: "${instr}". This field is in the window: ${d} After the task is done, which value should this field hold? Choose keep if the instruction does not ask to change this field.`,
  (instr: string, d: string) => `Instruction: "${instr}". Field: ${d} Pick the value the instruction asks to put in this field, or keep if it asks for no change here.`,
] as const;
const PRESS_WORDINGS = [
  (instr: string) => `The user asked: "${instr}". Which button does the instruction ask to press? Choose none if it asks for no press.`,
  (instr: string) => `Instruction: "${instr}". If the instruction asks for a button to be pressed, pick it; otherwise pick none.`,
] as const;

function fieldRequest(instruction: string, w: WindowState, title: string | null, fields: readonly Field[], values: readonly Option[], buttons: readonly Button[], wording: 0 | 1, declared: Declared): JevRequest {
  const criteria: Record<string, string> = { ...Object.fromEntries(values.map((v) => [v.id, v.describe])), [KEEP]: "Leave the field as it is." };
  const questions: JevRequest["questions"] = {};
  for (const f of fields) questions[f.id] = { type: "choice", instructions: FIELD_WORDINGS[wording](instruction, f.descriptor), criteria };
  if (buttons.length > 0) {
    questions.press = {
      type: "choice",
      instructions: PRESS_WORDINGS[wording](instruction),
      criteria: { ...Object.fromEntries(buttons.map((b) => [b.id, `the '${b.label}' button`])), [NONE]: "No button." },
    };
  }
  return {
    state: {
      instruction,
      window: title === null ? `${w.app.name} window` : `${w.app.name} window '${title}'`,
      task: "Caret plans the instruction as values written into this window's fields. Values come from the instruction, the user's memory and the user's other open windows; Caret writes only a value listed here.",
    },
    questions,
    snippets: declared.snippets,
    charged: declared.charged,
  };
}

export { PlannerError };
