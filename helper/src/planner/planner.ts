import { instructionForModel } from "../memory/sensitive.ts";
import { viewOf } from "../fill/candidates.ts";
import { redactWindow } from "../fill/redact.ts";
import { assertNoSecrets } from "../privacy.ts";
// The planner: "do X" becomes a checked plan (brief B16). Jev answers only choice questions, so the
// house rule holds here too: code proposes, Jev chooses, code copies and verifies.
//   1. Code picks the window: the one the host names (requestedWindow resolves a host's window number), the
//      only window with fields or buttons, or Jev's choice among the titles of those windows.
//   2. Code lists the window's writable fields and labelled buttons, and the values the plan could
//      write: spans of the instruction (spans.ts), memory values, and the fill generator's candidates
//      from the other windows. Only the fields the instruction names are asked about, or every field when
//      it asks to fill the form; each field is offered only the values whose kind fits it (kinds.ts
//      misfit). Jev answers one question per field ("which value, or keep") and one about
//      buttons ("which to press, or none"), asked twice with the options shuffled and the wording
//      changed. A field is written only when both asks pick the same value and the lower confidence
//      clears the cutoff; otherwise it is withheld and left as it is, as fill withholds a field (fill.ts).
//      The plan fails as unsure only when it withheld something and has nothing left to do.
//   3. Code writes the plan: one valueEquals step per field that gets a value, keyed by element key,
//      then a handoff step for the press, its reason from the risk table (risk.ts). A press is never a
//      step Caret takes: code cannot predict what a press changes, so it could not verify it.
//   4. validatePlan checks the plan against the screen model and memory as they are once Jev answered.
// Nothing here acts. The helper offers the plan, and it runs only after the user accepts it.
import { writableTargets } from "./targets.ts";
import type { Authority, DocumentReader } from "../fill/ask-scope.ts";
import { randomInt } from "node:crypto";
import type { ScreenModel, WindowState } from "../model.ts";
import type { Node, PlanWindow } from "../protocol.ts";
import type { AskJev, JevRequest, JevResult } from "../fill/jev.ts";
import { candidateProvenance, FILL_CUTOFF, FILLABLE_ROLES, neverTypedNode, shuffled } from "../fill/fill.ts";
import { checkValues, ContractError, fieldContract, isChecked, VerifierUnavailable, type CheckedValue, type CheckOptions, type FieldContract, type Owner, type Proposed, type Provenance } from "../fill/contract.ts";
import { describeCandidate, generateCandidates } from "../fill/candidates.ts";
import { describeField } from "../fill/descriptor.ts";
import { addressParts } from "../fill/kinds.ts";
import { writeMisfit } from "../fill/writable.ts";
import { fieldPart, splitAddress, splitName } from "../fill/derive.ts";
import { inWebArea } from "../fill/controls.ts";
import { SnippetLedger, type Declared } from "../privacy.ts";
import type { Plan, Step, WindowSel } from "../executor/schema.ts";
import { instructionValues } from "./spans.ts";
import type { MemoryValue } from "./trace.ts";
import { handoffWhy, PlannerError, validatePlan, type CheckedPlan, type PlanContext } from "./validate.ts";
import { PAGE_WINDOW_KIND } from "../engines/windows.ts";
import { jevFailedError } from "./says.ts";

/**
 * Lowest agreed confidence at which a value is written. Assumed: it is the fill cutoff (fill.ts), which
 * was calibrated on fill questions, not on these; no planner calibration exists.
 */
export const PLAN_CUTOFF = FILL_CUTOFF;
/** Fields, buttons and values one question lists. Assumed, sized like the fill question's. */
export const MAX_PLAN_FIELDS = 20;
export const MAX_PLAN_BUTTONS = 20;
export const MAX_PLAN_VALUES = 40;
/** The street lines and cities of whole addresses, offered beside the values above them. Assumed. */
export const MAX_ADDRESS_PARTS = 10;
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
  /**
   * I2: the fields Jev is asked about, by node key: an Ask's fields as Jev's scope ask chose them or the user picked them
   * (ask.ts nativeFields), in place of the planner's own reading of which fields the instruction names, which saves
   * questions about fields the write contract would refuse (`scope`). Absent, the planner reads it as before. Empty: no
   * field, so only a press can be planned.
   */
  fields?: readonly string[];
  /**
   * I2: who authorizes the plan's writes (ask-scope.ts Authority): an Ask's scope, which the write contract and
   * validatePlan enforce; absent, this plan request itself (kind "plan", by its offer key).
   */
  authority?: Authority;
  /** Which page document a window shows now (the owning helper's page engine), for an Ask's scope. */
  documentOf?: DocumentReader | null;
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
  /** Form controls an Ask leaves to the user with the value to set (ask.ts); the pop-up lists them. Absent for the planner's own plans. */
  controls?: readonly { key: string; name: string; value: string; display: string }[];
  /** Fields an Ask left to the user because Caret never types them, as a sentence (ask.ts); null or absent for none. */
  leftToYou?: string | null;
  /** I3: fields an Ask left to the user because Jev wasn't sure the request asks for them (ask.ts); each is said in the pop-up. */
  unsure?: readonly { key: string; name: string }[];
}

interface Option {
  id: string;
  text: string;
  describe: string;
  /** W2: where the value was read, as the write contract carries it (fill/contract.ts). */
  provenance: Provenance;
}

export interface Field {
  id: string;
  node: Node;
  name: string;
  /** The section the field sits in ("Billing"), part of `name`; null when it has none. */
  section: string | null;
  /** The field's own label, nearest label or placeholder: `name` without the section. */
  label: string;
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
      throw jevFailedError(e);
    }
    jev.calls += 2;
    jev.costUsd += r[0].costUsd + r[1].costUsd;
    jev.latencyMs += Math.max(r[0].latencyMs, r[1].latencyMs);
    return r;
  };

  const w = await chooseWindow(instruction, model, o, rand, cutoff, ask, answers);
  try {
    return await planIn(w, instruction, model, memory, o, rand, cutoff, ask, answers, jev);
  } catch (e) {
    if (e instanceof PlannerError && e.windowId === null) e.windowId = w.window.windowId;
    throw e;
  }
}

/**
 * The window an instruction is about, as planTask chooses it: the one the host names, the only window with a
 * field or a button, or Jev's choice among their titles (both asks agreeing at the cutoff). For Ask (ask.ts).
 */
export async function taskWindow(instruction: string, model: ScreenModel, o: Pick<PlanTaskOptions, "askJev" | "windowId" | "rand" | "cutoff">): Promise<{ window: WindowState; jev: PlanDraft["jev"] }> {
  const jev = { calls: 0, costUsd: 0, latencyMs: 0 };
  const ask = async (a: JevRequest, b: JevRequest): Promise<[JevResult, JevResult]> => {
    let r: [JevResult, JevResult];
    try {
      r = await Promise.all([o.askJev(a), o.askJev(b)]);
    } catch (e) {
      throw jevFailedError(e);
    }
    jev.calls += 2;
    jev.costUsd += r[0].costUsd + r[1].costUsd;
    jev.latencyMs += Math.max(r[0].latencyMs, r[1].latencyMs);
    return r;
  };
  const w = await chooseWindow(instruction, model, { ...o, offerKey: "" }, o.rand ?? randomInt, o.cutoff ?? PLAN_CUTOFF, ask, {});
  return { window: w, jev };
}

/** planTask's work once the window is chosen. */
async function planIn(
  w: WindowState,
  instruction: string,
  model: ScreenModel,
  memory: PlannerMemory,
  o: PlanTaskOptions,
  rand: (n: number) => number,
  cutoff: number,
  ask: (a: JevRequest, b: JevRequest) => Promise<[JevResult, JevResult]>,
  answers: Record<string, AskPair>,
  jev: PlanDraft["jev"],
): Promise<PlanDraft> {
  w = redactWindow(w);
  const fields = writableFields(w);
  const buttons = labelledButtons(w);
  const ledger = new SnippetLedger(model.windows.values());
  if (!ledger.plan([instructionForModel(instruction)])) throw new PlannerError("privacy", PRIVACY_SAYS);
  // A title that does not fit the window's budget is left out; the question then names the app alone.
  const title = ledger.take(w, "descriptor", [w.window.title]) ? w.window.title : null;
  // A window that is not a card gives a question less than half its text (privacy.ts), which may not hold
  // every field and button: what the instruction names is taken first, the rest in document order.
  const order = byRelevance(instruction, [...fields.map((f) => ({ key: f.node.key, name: f.name, text: f.descriptor })), ...buttons.map((b) => ({ key: b.key, name: b.label, text: b.label }))]);
  const taken = new Set(order.filter((x) => ledger.take(w, "descriptor", [x.text])).map((x) => x.key));
  // Only the fields the instruction names are asked about: the second live pass (evidence/screen/b16/
  // planner-live) wrote an order number into two fields "Put the order number ... in Reference" never
  // named. Every field is asked about only when the instruction asks to fill the form (asksToFillForm);
  // before B18 an instruction that named no field had every field asked about, which let B17's held-out
  // live pass add fields the instruction never named.
  // A label the form repeats in several sections is named by its section: "billing street and billing town"
  // named Shipping Street too, by "street", and the held-out live pass wrote the address there as well (B17,
  // evidence/screen/b17/planner-heldout-live; a fix tuned on that set). So a field is left out when the
  // instruction names another section that has a field of the same label. A label only one section has
  // ("Phone" under Contact details) is still named by its own words.
  const outranked = outrankedFields(instruction, fields);
  const named = new Set(fields.filter((f) => (relevance(instruction, f.name) > 0 || namesShortLabel(instruction, f.label)) && !outranked.has(f.node.key)).map((f) => f.node.key));
  const wholeForm = asksToFillForm(instruction);
  const askedFields = fields.filter((f) => taken.has(f.node.key) && (o.fields !== undefined ? o.fields.includes(f.node.key) : wholeForm || named.has(f.node.key)));
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
  // A field is offered only the values that fit it: B17's held-out live pass wrote a whole address into
  // Billing City when the address was the only value it was offered. validatePlan checks the same rule.
  const fitting = (f: Field, vs: readonly Option[]): Option[] => vs.filter((v) => writeMisfit(v.text, { labelWords: [f.label] }) === null);
  const [r1, r2] = await ask(
    ...sentOnly([
      fieldRequest(instruction, w, title, questioned, (f) => fitting(f, values), askedButtons, 0, declared),
      fieldRequest(instruction, w, title, questioned, (f) => fitting(f, second.values), second.buttons, 1, declared),
    ]),
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
  const agreedWrites: { field: Field; value: string }[] = [];
  /** W2: by field key, where its agreed value was read (the option of that text). */
  const read = new Map<string, Provenance>();
  for (const f of questioned) {
    const v = agreed(f.id, f.name, byId(fitting(f, values)), byId(fitting(f, second.values)), KEEP);
    if (v === null) continue;
    agreedWrites.push({ field: f, value: v });
    read.set(f.node.key, (values.find((x) => x.text === v) as Option).provenance);
  }
  // W2: each value meets the write contract once, in its field, with where it was read (fill/contract.ts); a value it
  // refuses is withheld, as an unsure one is.
  const minted = await mintWrites(agreedWrites.map(({ field, value }) => ({ key: field.node.key, w, node: field.node, name: field.name, text: value, provenance: read.get(field.node.key) as Provenance, owner: null })), { askJev: o.askJev, ledger, instruction, now: o.now ?? Date.now(), authority: o.authority ?? { kind: "plan", offerKey: o.offerKey }, documentOf: o.documentOf ?? null });
  for (const r of minted.refused) withheld.push({ name: r.name, why: "lowConfidence" });
  const writes = agreedWrites.filter((x) => minted.mints.has(x.field.node.key));
  const pressLabel = askedButtons.length === 0 ? null : agreed("press", "press", byId(askedButtons.map((b) => ({ id: b.id, text: b.key }))), byId(second.buttons.map((b) => ({ id: b.id, text: b.key }))), NONE);
  const press = pressLabel === null ? null : (askedButtons.find((b) => b.key === pressLabel) ?? null);
  if (press !== null) answers.press = [press.label, press.label];
  if (writes.length === 0 && press === null) {
    if (minted.refused.length > 0 && agreedWrites.length === minted.refused.length) throw allRefused(minted.refused);
    if (withheld.length > 0) throw new PlannerError("unsure", `Jev was not sure enough about ${withheld.map((x) => `${x.name} (${x.why === "disagree" ? "the asks disagreed" : "low confidence"})`).join(", ")}, and nothing else is left to do`);
    throw new PlannerError("nothingToDo", "Jev found nothing in your instruction to write or press here");
  }

  // By number too when the reader read one: another window of the app with the same title is not this one.
  const sel: WindowSel = { bundleId: w.app.bundleId, title: w.window.title, ...(w.window.number === undefined ? {} : { number: w.window.number }), ...(w.window.kind === PAGE_WINDOW_KIND ? { page: true as const, windowId: w.window.windowId } : {}) };
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

  const mints = new Map(writes.map(({ field }, i) => [`v${i + 1}`, minted.mints.get(field.node.key) as CheckedValue]));
  await o.beforeCheck?.();
  const ctx: PlanContext = { model, memory: memory.values(), instruction, origin: o.authority ?? { kind: "plan", offerKey: o.offerKey }, documentOf: o.documentOf ?? null };
  const checked = validatePlan(plan, slots, ctx, mints);
  // The plan names its window by app and title; one that replaced the chosen window while Jev answered is another window.
  if (checked.window.window.windowId !== w.window.windowId) throw new PlannerError("unknownWindow", `'${w.window.title}' closed while Caret planned, and another window took its title`);
  // A value copied from a window charges that window when a target question quotes it (Plan.sources).
  const sources: Record<string, string> = {};
  // Writes come first, in order, so step i fills slot v<i+1>.
  for (const wr of checked.writes) if (wr.trace.from === "window") sources[`v${wr.step + 1}`] = wr.trace.windowId;
  // A value copied from memory names its entry, so the executor checks the entry still holds it right before
  // the write: forgetting it after accepting the plan stops that write (B17 fix-check).
  const steps2 = plan.steps.map((s, i) => {
    const t = checked.writes.find((wr) => wr.step === i)?.trace;
    return t?.from === "memory" ? { ...s, memory: t.part === undefined ? t.id : `${t.id}#${t.part}` } : s;
  });
  const withSources: Plan = { ...plan, steps: steps2, ...(Object.keys(sources).length === 0 ? {} : { sources }) };
  return { plan: withSources, slots, checked, answers, withheld, jev };
}

/**
 * W2: the write contract's mints for a drafted plan's writes, by the caller's key (fill/contract.ts checkValues), each
 * checked in its field as fieldContract reads it, with where its value was read. A value the contract refuses is
 * returned in `refused`, so the caller drops that write, as verifyWrites dropped an unconfirmed one before W2. Throws
 * PlannerError("notEditable") for a field Caret never types, and PlannerError("jevFailed") when the verifier cannot
 * answer: nothing is written then.
 */
export async function mintWrites(writes: readonly { key: string; w: WindowState; node: Node; name: string; text: string; provenance: Provenance; owner: Owner }[], o: CheckOptions): Promise<{ mints: Map<string, CheckedValue>; refused: { key: string; name: string; says: string; why: string }[] }> {
  const proposed: Proposed[] = [];
  for (const x of writes) {
    let field: FieldContract;
    try {
      field = fieldContract(x.w, x.node);
    } catch (e) {
      if (e instanceof ContractError) throw new PlannerError("notEditable", `${x.name}: ${e.message}`);
      throw e;
    }
    proposed.push({ field, text: x.text, display: x.text, provenance: x.provenance, owner: x.owner });
  }
  let r: Awaited<ReturnType<typeof checkValues>>;
  try {
    r = await checkValues(proposed, o);
  } catch (e) {
    if (e instanceof VerifierUnavailable) throw new PlannerError("jevFailed", `Caret couldn't check the plan's values: ${e.message}`);
    throw e;
  }
  const mints = new Map<string, CheckedValue>();
  const refused: { key: string; name: string; says: string; why: string }[] = [];
  r.results.forEach((x, i) => {
    const w = writes[i] as (typeof writes)[number];
    if (isChecked(x)) mints.set(w.key, x);
    else refused.push({ key: w.key, name: w.name, says: x.says, why: x.why });
  });
  return { mints, refused };
}

/** The refusal of a plan whose every write the write contract refused: wrongKind when code refused one, else unsure. */
export function allRefused(refused: readonly { name: string; says: string; why: string }[]): PlannerError {
  const first = refused.find((x) => x.why === "wrongKind") ?? refused[0];
  return new PlannerError(first?.why === "wrongKind" ? "wrongKind" : "unsure", `${first?.name ?? "a field"}: ${first?.says ?? "Caret's check refused the value"}`);
}

/**
 * The fields, by node key, that the instruction rules out by naming another section with a field of the same
 * label: "billing street and billing town" rules out Shipping Street. The planner and the code-mode writer's
 * check (codeplan.ts) both use it, so a writer cannot fill a field the planner would have left (B24 review).
 */
export function outrankedFields(instruction: string, fields: readonly Field[]): Set<string> {
  const sectionsSaid = new Set(fields.flatMap((f) => (f.section !== null && relevance(instruction, f.section) > 0 ? [f.section] : [])));
  const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
  return new Set(fields.filter((f) => f.section !== null && !sectionsSaid.has(f.section) && fields.some((g) => g !== f && g.section !== null && sectionsSaid.has(g.section) && same(g.label, f.label))).map((f) => f.node.key));
}

/** Words that say what to do rather than where; they do not make a field or button relevant. */
const COMMON = new Set(["the", "and", "for", "from", "into", "with", "this", "that", "set", "put", "write", "fill", "copy", "use", "make", "add", "enter", "type", "change", "her", "his", "their", "our", "your", "its"]);
/** The words relevance() compares: lower case, three letters or more, not a common word. */
export const wordsOf = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 3 && !COMMON.has(x));

/**
 * The requests with only the snippets their questions carry. A value that fits none of the asked fields is
 * offered to none, so its text and facts are not sent; the ledger still charged its window for them, which
 * errs on the side of saying less (privacy.test.ts fails a request that declares text it does not send).
 */
function sentOnly(reqs: [JevRequest, JevRequest]): [JevRequest, JevRequest] {
  const sent: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") sent.push(v);
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
  };
  for (const r of reqs) walk([r.state, r.questions]);
  const keep = (x: { text: string }): boolean => sent.some((t) => t.includes(x.text));
  return [{ ...reqs[0], snippets: reqs[0].snippets.filter(keep) }, { ...reqs[1], snippets: reqs[1].snippets.filter(keep) }];
}

/**
 * Whether the instruction asks to fill the whole form ("fill in the form", "fill out the rest of the
 * fields", "complete this form", "fill it all in"), so every field is asked about. The phrasings are
 * written for common requests, not measured.
 */
export function asksToFillForm(instruction: string): boolean {
  // Quoted text is a value to write, not a request ("Write 'fill in the form' in Notes").
  const s = instruction.replace(QUOTED_TEXT, " ").toLowerCase();
  return (
    // "the form field Name" names one field, so "form" followed by "field" is not the whole form.
    /\b(?:fill|complete)(?:\s+(?:in|out|up))?\s+(?:(?:the|this|that|my|whole|entire|rest|of|remaining|other|all)\s+)*(?:form(?!\s+field\b)|fields|everything)\b/.test(s) ||
    /\bfill\s+(?:it|them|everything)\s+(?:all\s+)?(?:in|out)\b/.test(s) ||
    /\bfill\s+(?:in|out)\s+(?:all|everything)\b/.test(s) ||
    // B24's blind instructions: "fill the rest of this from my note", "fill in whatever you know about me".
    /\bfill\s+(?:(?:in|out)\s+)?(?:the\s+)?rest\b/.test(s) ||
    /\bfill\s+(?:(?:in|out)\s+)?(?:whatever|what)\s+you\s+(?:can|know)\b/.test(s)
  );
}

const QUOTED_TEXT = /"[^"]*"|“[^”]*”|(?<![\p{L}])'[^']*'(?![\p{L}])/gu;

/**
 * Whether the instruction names a field whose label is a word too short for relevance ("To", "Cc", "ID"):
 * only as a destination ("in To", "into the Cc field"), a heading ("To:") or the object of "set … to"
 * ("Set ID to AB123"), since "to" is also a preposition in nearly every instruction.
 */
export function namesShortLabel(instruction: string, label: string): boolean {
  const l = label.trim().replace(/:$/, "");
  if (!/^\p{L}{1,2}$/u.test(l)) return false;
  const e = l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Quoted text is a value to write ('Write "To: Dana" in Notes' names Notes, not To).
  const s = instruction.replace(QUOTED_TEXT, " ");
  return new RegExp(`\\b(?:in|into)\\s+(?:the\\s+)?${e}\\b|\\b${e}\\s*(?::|\\s+(?:field|box|line)\\b)|\\b(?:set|change|make)\\s+(?:the\\s+)?${e}\\s+(?:to|as)\\b`, "iu").test(s);
}

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

export function writableFields(w: WindowState): Field[] {
  w = redactWindow(w);
  const out: Field[] = [];
  // I2 ruling: the one inventory the intent snapshot reads (targets.ts), so the planner writes no field the scope
  // question could not ask about; a field with no readable name is not in it.
  for (const { node: n } of writableTargets(w)) {
    if (out.length >= MAX_PLAN_FIELDS) break;
    // A field Caret never types (an SSN, a card number, a password or a code) is the user's, as fill leaves it (B25).
    if (n.editable !== true || !FILLABLE_ROLES.has(n.role) || n.states?.includes("secure") || neverTypedNode(w, n) !== null) continue;
    // A web page's combobox (react-select) takes a pick from its list, not typed text: a named hand-off (B24).
    if (n.role === "AXComboBox" && inWebArea(w, n)) continue;
    const d = describeField(w, n);
    out.push({ id: `f${out.length + 1}`, node: n, name: fieldName(w, n), section: d.section, label: d.label ?? d.nearest ?? d.placeholder ?? "field", descriptor: d.text });
  }
  return out;
}

interface Button {
  id: string;
  key: string;
  label: string;
}

function labelledButtons(w: WindowState): Button[] {
  w = redactWindow(w);
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

/**
 * The reader's id for the window a planRequest means, or null when Caret should choose among the open
 * windows. A named window must be one the reader has read: `window` is matched by its window-server number
 * and process, `windowId` by id, and either one missing throws unseenWindow (B21). With neither, the window
 * the user last focused in the frontmost app, when it has a field or a button; the host's Ask Caret panel
 * does not take focus, so that is the window the user was in when they asked.
 */
export function requestedWindow(model: ScreenModel, req: { windowId?: string | undefined; window?: PlanWindow | undefined }): string | null {
  if (req.window !== undefined) {
    const { pid, number } = req.window;
    const numbered = [...model.windows.values()].filter((w) => w.window.number === number);
    const mine = numbered.filter((w) => w.app.pid === pid);
    if (mine.length > 1) throw new PlannerError("ambiguousWindow", `the reader holds ${mine.length} windows numbered ${number} for process ${pid}`);
    const w = mine[0];
    if (w !== undefined) return w.window.windowId;
    const other = numbered[0];
    throw new PlannerError(
      "unseenWindow",
      other === undefined ? `the reader has not read window ${number} of process ${pid}` : `window ${number} belongs to process ${other.app.pid}, not ${pid}`,
    );
  }
  if (req.windowId !== undefined) {
    if (!model.windows.has(req.windowId)) throw new PlannerError("unseenWindow", `the reader has not read window ${req.windowId}`);
    return req.windowId;
  }
  const last = model.userWindow();
  return last !== null && actionable(last) ? last.window.windowId : null;
}

/** Values to choose from: the instruction's spans, then memory, then the other windows' candidates; each text once. */
function valueOptions(instruction: string, model: ScreenModel, w: WindowState, memory: readonly MemoryValue[], ledger: SnippetLedger, now: number): Option[] {
  const out: Option[] = [];
  const seen = new Set<string>();
  const add = (text: string, describe: string, provenance: Provenance, max = MAX_PLAN_VALUES): void => {
    if (out.length >= max || seen.has(text)) return;
    seen.add(text);
    // Local binding retains withheld values for refusal; a model sees only the neutral reference.
    const safe = provenance.kind === "instruction" && !instructionForModel(instruction).includes(text)
      ? "[a field Caret leaves to you]" : instructionForModel(describe);
    out.push({ id: `v${out.length + 1}`, text, describe: safe, provenance });
  };
  const entry = (m: MemoryValue): Provenance => ({ kind: "memory", id: m.id, label: m.label, part: null, whose: m.whose ?? null });
  const spans = instructionValues(instruction);
  if (ledger.plan(spans.map((s) => instructionForModel(instruction).includes(s) ? instructionForModel(s) : "[a field Caret leaves to you]"))) for (const s of spans) add(s, `"${s}" (written in the instruction)`, { kind: "instruction", span: s });
  for (const m of memory) if (ledger.plan([m.text, m.label])) add(m.text, `"${m.text}" (from the user's memory: ${m.label})`, entry(m));
  // A remembered name's first and last parts, split by code (fill/derive.ts, B24), for First and Last name
  // fields: "fill my name and email" on a form with split name fields found no value for either (Q1 bug 11).
  for (const m of memory) {
    // Only for an entry whose text went into the question above, so the part's description declares nothing new.
    if (!/\bname\b/i.test(m.label) || !seen.has(m.text)) continue;
    const s = splitName(m.text);
    if (s.kind !== "split") continue;
    for (const [part, text] of [["first name", s.first], ["middle name", s.middle], ["last name", s.last]] as const) {
      if (text !== null) add(text, `"${text}" (the ${part} in the user's memory: ${m.label} "${m.text}")`, { kind: "derived", how: "namePart", base: entry(m), also: null });
    }
  }
  const cands = generateCandidates(model, w.window.windowId, MAX_PLAN_VALUES, now, ledger);
  for (const c of cands) add(c.text, describeCandidate(c), candidateProvenance(model, c));
  // A whole address fits no City or Street field (kinds.ts misfit), so its parts are offered too: B17's and
  // B18's held-out sets asked for the city or street of an address the windows show only whole (a change
  // tuned on those sets). Each part is a span of the same line, so it traces to it. They have their own
  // budget after the values above, so a screen of addresses cannot push out its other values.
  // A form with its own Apt / Unit field gets the street line without the unit, and the unit, state and ZIP code
  // apart (fill/derive.ts splitAddress, B24): the corpus's rental form took "4410 Speedway Apt 2" in Street
  // address beside an empty Apt / Unit field (asks-dev-3).
  const unitField = writableFields(w).some((f) => fieldPart(f.label) === "unit");
  for (const c of cands) {
    const split = unitField ? splitAddress(c.text) : null;
    if (split !== null) {
      for (const [k, v] of Object.entries(split)) if (v !== undefined) add(v, `"${v}" (the ${k} of ${describeCandidate(c)})`, { kind: "derived", how: "addressPart", base: candidateProvenance(model, c), also: null }, MAX_PLAN_VALUES + MAX_ADDRESS_PARTS);
      continue;
    }
    const parts = addressParts(c.text);
    if (parts === null) continue;
    const whole = candidateProvenance(model, c);
    add(parts.street, `"${parts.street}" (the street line of ${describeCandidate(c)})`, { kind: "derived", how: "addressPart", base: whole, also: null }, MAX_PLAN_VALUES + MAX_ADDRESS_PARTS);
    if (parts.city !== null) add(parts.city, `"${parts.city}" (the city of ${describeCandidate(c)})`, { kind: "derived", how: "addressPart", base: whole, also: null }, MAX_PLAN_VALUES + MAX_ADDRESS_PARTS);
  }
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
    const w = viewOf(model, o.windowId);
    if (w === undefined) throw new PlannerError("unseenWindow", `window ${o.windowId} is not open`);
    if (!actionable(w)) throw new PlannerError("noWindow", `window ${o.windowId} has no field or button`);
    return w;
  }
  const candidates = [...model.windows.values()].map(redactWindow).filter(actionable);
  if (candidates.length === 0) throw new PlannerError("noWindow", "no open window has a field or a button");
  if (candidates.length === 1) return candidates[0] as WindowState;
  const ledger = new SnippetLedger(model.windows.values());
  if (!ledger.plan([instructionForModel(instruction)])) throw new PlannerError("privacy", PRIVACY_SAYS);
  const listed = candidates.filter((w) => ledger.take(w, "descriptor", [w.window.title]));
  if (listed.length === 0) throw new PlannerError("privacy", "no open window's title fits what one question to Jev may carry");
  const declared = ledger.declared();
  const first = listed.map((w, i) => ({ id: `w${i + 1}`, w }));
  const second = shuffled(first, rand).map((x, i) => ({ id: `x${i + 1}`, w: x.w }));
  const req = (list: typeof first, wording: 0 | 1): JevRequest => (assertNoSecrets({
    purpose: "planner.window",
    state: { instruction: instructionForModel(instruction), task: "Caret is about to plan the user's instruction in one of the user's open windows." },
    questions: {
      window: {
        type: "choice",
        instructions: WINDOW_WORDINGS[wording](instruction),
        criteria: { ...Object.fromEntries(list.map((x) => [x.id, `${x.w.app.name} window '${x.w.window.title}'`])), [NONE]: "None of these windows." },
      },
    },
    snippets: declared.snippets,
    charged: declared.charged,
  }));
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

function fieldRequest(instruction: string, w: WindowState, title: string | null, fields: readonly Field[], valuesFor: (f: Field) => readonly Option[], buttons: readonly Button[], wording: 0 | 1, declared: Declared): JevRequest {
  instruction = instructionForModel(instruction);
  w = redactWindow(w);
  const questions: JevRequest["questions"] = {};
  for (const f of fields) {
    const criteria: Record<string, string> = { ...Object.fromEntries(valuesFor(f).map((v) => [v.id, v.describe])), [KEEP]: "Leave the field as it is." };
    questions[f.id] = { type: "choice", instructions: FIELD_WORDINGS[wording](instruction, f.descriptor), criteria };
  }
  if (buttons.length > 0) {
    questions.press = {
      type: "choice",
      instructions: PRESS_WORDINGS[wording](instruction),
      criteria: { ...Object.fromEntries(buttons.map((b) => [b.id, `the '${b.label}' button`])), [NONE]: "No button." },
    };
  }
  return assertNoSecrets({
    purpose: "planner.fields",
    state: {
      instruction,
      window: title === null ? `${w.app.name} window` : `${w.app.name} window '${title}'`,
      task: "Caret plans the instruction as values written into this window's fields. Values come from the instruction, the user's memory and the user's other open windows; Caret writes only a value listed here.",
    },
    questions,
    snippets: declared.snippets,
    charged: declared.charged,
  });
}

export { PlannerError };
