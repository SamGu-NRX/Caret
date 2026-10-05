// Ask (B25): an instruction becomes an intent (intent.ts), code checks it, and the route decides what runs.
//   - fill: the fill engine (fill/fill.ts proposeFill) restricted to the intent's fields, sources, person and
//     spelled-out values; its text writes become the planner's plan of field writes, checked by validatePlan as
//     every plan is, and its controls (a select's option, a date) are listed for the user to set.
//   - plan: the planner as before: the deterministic planner, then the code-mode writer for an instruction it
//     cannot ground. Plans still run only after the host accepts them.
//   - ask or refuse: a PlannerError whose sentence code wrote.
// Nothing here acts.
import type { ScreenModel, WindowState } from "../model.ts";
import type { FillField, FillProposal } from "../protocol.ts";
import type { AskJev, JevRequest } from "../fill/jev.ts";
import type { AboutValue } from "../fill/about.ts";
import { FillError, memoryRefOf, proposeFill } from "../fill/fill.ts";
import type { Plan, Step, WindowSel } from "../executor/schema.ts";
import type { WriterPort } from "../writer/port.ts";
import { namesShortLabel, PLAN_CUTOFF, planTask, relevance, taskWindow, type PlanDraft, type PlannerMemory } from "./planner.ts";
import { planWithCode, type WriterUse } from "./codeplan.ts";
import { checkIntent, intentSnapshot, leftToYouSays, type AskIntent, type IntentField, type IntentSnapshot } from "./intent.ts";
import { SAYS, SaidError, saysAmbiguous, saysFor, saysNoValue, saysPress, saysUnsure } from "./says.ts";
import { fieldWords } from "./sources.ts";
import { namedSection, wholeFormPhrase } from "./scope-words.ts";
import type { IntentMaker, MakerUse } from "./intent-makers.ts";
import { handoffWhy, PlannerError, validatePlan, type PlanContext } from "./validate.ts";

export interface AskOptions {
  askJev: AskJev;
  maker: IntentMaker;
  /** The code-mode writer for the plan route; null leaves an instruction the planner cannot ground refused. */
  writer: WriterPort | null;
  offerKey: string;
  /** The window the user means, when the host knows it. */
  windowId?: string;
  now?: number;
  rand?: (n: number) => number;
  /** Fault-injection seam for the planner evaluation (PlanTaskOptions.beforeCheck). */
  beforeCheck?: () => Promise<void>;
}

export type AskDraft = PlanDraft & {
  route: "fill" | "plan";
  intent: AskIntent;
  maker: MakerUse;
  /** The fill the plan came from, for evaluation; null on the plan route. */
  fill: FillProposal | null;
  writer?: WriterUse;
};

/**
 * An Ask that ended without a plan, with the intent and what making it cost when the maker got that far. Its message
 * is the sentence the user reads (says.ts); `detail` is what the failing check found, for logs and the scoreboard.
 */
export class AskRefused extends SaidError {
  readonly intent: AskIntent | null;
  readonly maker: MakerUse | null;
  constructor(e: PlannerError, intent: AskIntent | null, maker: MakerUse | null) {
    super(e.code, e instanceof SaidError ? e.message : saysFor(e.code), e instanceof SaidError ? e.detail : e.message);
    this.windowId = e.windowId;
    this.intent = intent;
    this.maker = maker;
  }
}

/** Plans an Ask. Throws AskRefused with the failing check's code, the user's sentence and the check's detail. */
export async function planAsk(instruction: string, model: ScreenModel, memory: PlannerMemory, about: readonly AboutValue[], o: AskOptions): Promise<AskDraft> {
  const now = o.now ?? Date.now();
  const jev = { calls: 0, costUsd: 0, latencyMs: 0 };
  const askJev: AskJev = async (req) => {
    let r: Awaited<ReturnType<AskJev>>;
    try {
      r = await o.askJev(req);
    } catch (e) {
      // A Jev failure anywhere in an Ask (a timeout, an HTTP error) is reported as the planner reports one.
      throw new SaidError("jevFailed", SAYS.unreachable, `the Jev request failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    }
    jev.calls++;
    jev.costUsd += r.costUsd;
    return r;
  };
  let w: WindowState;
  if (o.windowId !== undefined) {
    const named = model.windows.get(o.windowId);
    if (named === undefined) throw new AskRefused(new SaidError("unseenWindow", SAYS.windowClosed, `window ${o.windowId} is not open`), null, null);
    w = named;
  } else {
    try {
      w = (await taskWindow(instruction, model, { askJev, ...(o.rand === undefined ? {} : { rand: o.rand }) })).window;
    } catch (e) {
      if (e instanceof PlannerError) throw new AskRefused(e, null, null);
      throw e;
    }
  }

  let snap: IntentSnapshot;
  let made: Awaited<ReturnType<IntentMaker["make"]>>;
  try {
    snap = intentSnapshot(instruction, model, w, memory.values());
    made = await o.maker.make(snap);
  } catch (e) {
    if (e instanceof PlannerError) throw new AskRefused(e, null, null);
    throw e;
  }
  const { intent, use } = made;
  const refused = (e: unknown): never => {
    if (e instanceof PlannerError) {
      e.windowId ??= w.window.windowId;
      throw new AskRefused(e, intent, use);
    }
    throw e;
  };
  // The words that may name fields are the instruction without its source phrases (sources.ts): "from my note"
  // never names the form's "Add a gift note" (B25 held-08).
  const words = fieldWords(instruction);
  const namesField = (f: IntentField): boolean => relevance(words, f.name) > 0 || namesShortLabel(words, f.name);
  // A writer's fill with an empty list, for an instruction whose field words name no field, is read as the whole form,
  // which Jev must then confirm (confirmScope): B25's writer gave "can you get this enrollment form done from what I
  // jotted down" an empty list, and the Ask refused it as a field the form does not have (held-07).
  const inferredAll = o.maker.name === "writer" && intent.route === "fill" && intent.scope === "list" && intent.fields.length === 0 && !snap.fields.some(namesField);
  // A writer's list of every empty field Caret may type is the whole form, and Jev must confirm it as one question, as
  // for an inferred whole form: B26's held-out-2 run listed all nine fields for "fill out the pizza order from my
  // note", "pizza" named only Pizza Size, and Jev, asked about each other field alone, said no to eight. Taken as a
  // plain "all", it stood without any confirmation when no field word named a field ("fill only the first box"; B26's
  // second review).
  const empties = snap.fields.filter((f) => !f.filled && f.neverTyped === null).map((f) => f.ref);
  const listsAll = o.maker.name === "writer" && intent.route === "fill" && intent.scope === "list" && empties.length > 1 && empties.every((r) => intent.fields.includes(r));
  let checked: ReturnType<typeof checkIntent>;
  try {
    checked = checkIntent(inferredAll || listsAll ? { ...intent, scope: "all" } : intent, snap);
  } catch (e) {
    return refused(e);
  }
  const extra = { intent, maker: use, fill: null };
  // A plan whose one step hands the user a press does nothing for them ("hit submit"), so it is said, not offered:
  // "Submitting is yours to do." (B26 lead decision 3; B25's held-out run showed the user nothing for it).
  const onlyPress = (d: PlanDraft): never | null => {
    const h = d.checked.handoff;
    if (d.checked.writes.length > 0 || h === null || d.plan.steps.length !== 1) return null;
    return refused(new SaidError("unsupportedStep", saysPress(h.why, h.label), `the plan only hands the user the press '${h.label}' (${h.why})`));
  };
  // A phrase that names a part of the form ("contact info", "up top") is never the whole form, whichever maker said
  // so: the fill narrows to the form's section of that meaning, or Caret asks which fields (B28 lead decision 1;
  // G1's heldout2-04 filled Graduation Date and LinkedIn for "just do my contact info up top").
  let bySection = false;
  if (checked.route === "fill" && (inferredAll || listsAll || intent.scope === "all")) {
    try {
      const n = sectionScope(instruction, checked, snap);
      if (n !== null) (checked = n), (bySection = true);
    } catch (e) {
      return refused(e);
    }
  }
  // A writer's intent names fields by ref, which code checks against the snapshot, not against what the instruction
  // asks: a field the instruction does not name by its words, and "every field" when the instruction does not ask
  // for the whole form in words code reads (scope-words.ts), stand only when Jev, asked twice, agrees the
  // instruction asks for them (B25 review; B28 lead decision 1; the rule the code-mode writer has had since B24,
  // codeplan.ts confirmFields). Jev's own intents confirmed their fields already.
  if (checked.route === "fill" && o.maker.name === "writer" && !bySection) {
    try {
      checked = await confirmScope(instruction, checked, inferredAll || listsAll ? "inferred" : intent.scope, intent.section, snap, askJev, namesField);
    } catch (e) {
      return refused(e);
    }
  }

  if (checked.route === "plan") {
    try {
      const d = await planTask(instruction, model, memory, { askJev, offerKey: o.offerKey, windowId: w.window.windowId, now, ...(o.rand === undefined ? {} : { rand: o.rand }), ...(o.beforeCheck === undefined ? {} : { beforeCheck: o.beforeCheck }) });
      return onlyPress(d) ?? { ...d, ...extra, route: "plan" };
    } catch (e) {
      if (!(e instanceof PlannerError) || (e.code !== "unsure" && e.code !== "nothingToDo") || o.writer === null) return refused(e);
      try {
        const d = await planWithCode(instruction, model, memory, { writer: o.writer, askJev, offerKey: o.offerKey, windowId: w.window.windowId, now });
        return onlyPress(d) ?? { ...d, ...extra, route: "plan" };
      } catch (e2) {
        if (e2 instanceof PlannerError) return refused(new SaidError(e.code, e instanceof SaidError ? e.message : saysFor(e.code), `${e.message}; the plan writer did not help either: ${e2.message}`));
        throw e2;
      }
    }
  }

  let p: FillProposal;
  try {
    p = await proposeFill(model, askJev, w.window.windowId, checked.trigger, now, { about, scope: checked.scope, newId: () => o.offerKey, ...(o.rand === undefined ? {} : { rand: o.rand }) });
  } catch (e) {
    if (e instanceof FillError) return refused(new SaidError("nothingToDo", SAYS.nothingOnScreen, `the fill found nothing: ${e.message}`));
    return refused(e);
  }
  const nameOf = new Map(checked.fields.map((f) => [f.key, f]));
  const name = (f: FillField): string => nameOf.get(f.key)?.name ?? f.descriptor;
  // A value the user spelled out that the value resolver cannot read alone ("8:15" with no am or pm) is asked
  // about rather than guessed, and nothing else is proposed until it is answered.
  for (const f of p.fields) {
    const said = checked.scope.literals.get(f.key);
    if (said !== undefined && f.withheld === "ambiguous" && f.asks.some((a) => a.value === said)) return refused(new SaidError("unsure", saysAmbiguous(said, nameOf.get(f.key)?.control, nameOf.get(f.key)?.name), `"${said}" for ${name(f)} reads more than one way`));
  }
  const writes = p.fields.filter((f) => f.control === "text" && f.value !== null);
  const controls = p.fields.filter((f) => f.handoff !== null);
  if (writes.length === 0 && controls.length === 0) {
    const unsure = p.fields.filter((f) => f.withheld === "disagree" || f.withheld === "lowConfidence");
    if (unsure.length > 0) return refused(new SaidError("unsure", saysUnsure(unsure.map(name)), `Jev was not sure enough about ${unsure.map((f) => `${name(f)} (${f.withheld === "disagree" ? "the asks disagreed" : "low confidence"})`).join(", ")}, and nothing else is left to do`));
    const left = leftToYouSays(checked.leftToYou);
    return refused(new SaidError("nothingToDo", `${saysNoValue(checked.fields.map((f) => f.name))}${left === null ? "" : ` ${left}`}`, `no value for ${checked.fields.map((f) => f.name).join(", ")} on screen, in memory or in the instruction`));
  }

  const sel: WindowSel = { bundleId: w.app.bundleId, title: w.window.title, ...(w.window.number === undefined ? {} : { number: w.window.number }) };
  const slots: Record<string, string> = {};
  const slotNames: Record<string, string> = {};
  const steps: Step[] = writes.map((f, i) => {
    const slot = `v${i + 1}`;
    slots[slot] = f.value as string;
    slotNames[slot] = `the value for ${name(f)}`;
    return {
      says: `${name(f)} holds {{${slot}}}`,
      end: { kind: "valueEquals", window: sel, target: { key: f.key, describe: `the ${name(f)} field` }, value: `{{${slot}}}` },
      // A value copied from memory names its entry, so the executor checks it is still there before writing (B17).
      ...(f.memory === null ? {} : { memory: memoryRefOf(f.memory) }),
    };
  });
  // A plan needs a step; with only controls to set, it is one hand-off that names the first of them.
  if (steps.length === 0) {
    const first = controls[0] as FillField;
    const label = (w.nodes.get(first.key)?.label ?? "").trim();
    steps.push({ says: `You set ${name(first)}`, end: { kind: "handoff", window: sel, target: { key: first.key, describe: `the ${name(first)} control` }, why: handoffWhy(label) } });
  }
  const plan: Plan = { id: o.offerKey, title: instruction.replace(/\s+/g, " ").trim().slice(0, 100), slots: slotNames, steps };
  await o.beforeCheck?.();
  const ctx: PlanContext = { model, memory: memory.values(), instruction };
  let checkedPlan: ReturnType<typeof validatePlan>;
  try {
    checkedPlan = validatePlan(plan, slots, ctx);
  } catch (e) {
    return refused(e);
  }
  if (checkedPlan.window.window.windowId !== w.window.windowId) return refused(new SaidError("unknownWindow", SAYS.windowChanged, `'${w.window.title}' closed while Caret planned, and another window took its title`));
  // A value copied from a window charges that window when a target question quotes it (Plan.sources).
  const sources: Record<string, string> = {};
  for (const wr of checkedPlan.writes) if (wr.trace.from === "window") sources[`v${wr.step + 1}`] = wr.trace.windowId;
  return {
    plan: { ...plan, ...(Object.keys(sources).length === 0 ? {} : { sources }) },
    slots,
    checked: checkedPlan,
    answers: {},
    withheld: p.fields.flatMap((f) => (f.withheld === "disagree" || f.withheld === "lowConfidence" ? [{ name: name(f), why: f.withheld }] : [])),
    jev: { calls: jev.calls, costUsd: jev.costUsd, latencyMs: p.jev.latencyMs + use.latencyMs },
    controls: controls.map((f) => ({ key: f.key, name: name(f), value: f.handoff?.value ?? "", display: f.handoff?.display ?? "" })),
    leftToYou: leftToYouSays(checked.leftToYou),
    route: "fill",
    intent,
    maker: use,
    fill: p,
  };
}

const CONFIRM = { yes: "Yes: the instruction asks for this.", no: "No: the instruction does not ask for this." } as const;
const CONFIRM_FIELD = [
  (instr: string, name: string): string => `The user asked: "${instr}". Does that ask to fill in or change the field '${name}'?`,
  (instr: string, name: string): string => `Field: '${name}'. Instruction: "${instr}". Is this field one the instruction asks to fill or change?`,
] as const;
const CONFIRM_ALL = [
  (instr: string): string => `The user asked: "${instr}". Does that ask Caret to fill in every field of the form it can?`,
  (instr: string): string => `Instruction: "${instr}". Is it a request to fill in the whole form?`,
] as const;

type FillChecked = Extract<ReturnType<typeof checkIntent>, { route: "fill" }>;

/** The checked fill with only the fields `keep` holds for; throws `none` when no field is left. */
function narrowed(checked: FillChecked, keep: (f: IntentField) => boolean, none: () => SaidError): FillChecked {
  const kept = checked.fields.filter(keep);
  if (kept.length === 0) throw none();
  const keys = new Set(kept.map((f) => f.key));
  const literals = new Map([...checked.scope.literals].filter(([k]) => keys.has(k)));
  const trigger = keys.has(checked.trigger) ? checked.trigger : (kept[0] as IntentField).key;
  return { ...checked, fields: kept, trigger, leftToYou: checked.leftToYou.filter(keep), scope: { ...checked.scope, fields: kept.map((f) => f.key), literals } };
}

/**
 * A whole-form fill narrowed to the section the instruction names by a section phrase (scope-words.ts), or null
 * when it uses none. Throws SAYS.whichFields when the instruction says more than the section (a word that is not
 * filler, or quoted text), or a phrase means no section of this form, or more than one; SAYS.nothingToDo when that
 * section has no empty field Caret may type.
 */
function sectionScope(instruction: string, checked: FillChecked, snap: IntentSnapshot): FillChecked | null {
  const { phrases, section, why } = namedSection(instruction, snap.sections.map((s) => s.name), snap.fields[0]?.section ?? null);
  if (phrases.length === 0) return null;
  const said = phrases.map((p) => `"${p}"`).join(" and ");
  if (section === null) {
    const has = snap.sections.length === 0 ? "the form has no sections" : `the form's sections are ${snap.sections.map((s) => `'${s.name}'`).join(", ")}`;
    throw new SaidError("unsure", SAYS.whichFields, `the instruction names a part of the form by ${said}, and ${why ?? "no one section means that"} (${has})`);
  }
  return narrowed(checked, (f) => f.section === section, () => new SaidError("nothingToDo", SAYS.nothingToDo, `${said} means the section '${section}', which has no empty field Caret may type`));
}

/**
 * The writer's fill scope with every field the instruction does not name by its words confirmed by Jev, both asks
 * answering yes at PLAN_CUTOFF; an "all" or section scope the instruction does not state is confirmed the same way.
 * An "all" the instruction asks for by a phrase on scope-words.ts WHOLE_FORM_WORDS stands without asking. A whole
 * form Jev does not confirm narrows to the fields the instruction names that Jev then confirms.
 * Throws PlannerError when nothing in scope is left.
 */
async function confirmScope(
  instruction: string,
  checked: FillChecked,
  scope: AskIntent["scope"] | "inferred",
  section: string,
  snap: IntentSnapshot,
  askJev: AskJev,
  named: (f: IntentField) => boolean,
): Promise<FillChecked> {
  const words = fieldWords(instruction);
  // "Every field" stands on the writer's word only when the instruction asks for the whole form in words code reads
  // (B28 lead decision 1). Naming no field is not asking for the form: G1's local maker said "whole form" for "just
  // do my contact info up top", and Graduation Date and LinkedIn were filled. A whole form code inferred from an
  // empty list, or from a list of every field, always needs Jev's yes.
  const whole =
    scope === "inferred" ? true : scope === "all" ? wholeFormPhrase(instruction, snap.window.window.title) === null : scope === "section" ? relevance(words, snap.sections.find((x) => x.ref === section)?.name ?? "") === 0 : false;
  const unnamed = scope === "list" ? checked.fields.filter((f) => !named(f)) : [];
  // When Jev does not confirm the whole form, the fields the instruction names are what is left, each confirmed by
  // Jev: "Fill only Email; do not change Phone" names Phone too.
  const fallback = whole && scope !== "section" ? checked.fields.filter(named) : [];
  if (!whole && unnamed.length === 0) return checked;
  const declared = snap.ledger.declared();
  /** Both wordings of the questions, asked in parallel; true for an id both answer yes at PLAN_CUTOFF. */
  const confirm = async (all: boolean, fields: readonly IntentField[]): Promise<(id: string) => boolean> => {
    const req = (wording: 0 | 1): JevRequest => {
      const questions: JevRequest["questions"] = {};
      if (all) questions.all = { type: "choice", instructions: CONFIRM_ALL[wording](instruction), criteria: { ...CONFIRM } };
      fields.forEach((f, i) => {
        questions[`f${i + 1}`] = { type: "choice", instructions: CONFIRM_FIELD[wording](instruction, f.name), criteria: { ...CONFIRM } };
      });
      const sent = JSON.stringify([instruction, questions]);
      return { state: { instruction, task: "Caret checks which fields of the form the user's instruction asks it to fill." }, questions, snippets: declared.snippets.filter((x) => sent.includes(x.text)), charged: declared.charged };
    };
    const [a, b] = await Promise.all([askJev(req(0)), askJev(req(1))]);
    return (id) => {
      const x = a.answers[id];
      const y = b.answers[id];
      return x?.choice === "yes" && y?.choice === "yes" && Math.min(x.confidence, y.confidence) >= PLAN_CUTOFF;
    };
  };
  const yes = await confirm(whole, unnamed);
  if (whole && !yes("all")) {
    // The whole form is one question, asked alone (B26: asked field by field, Jev said no to eight of nine). Only
    // when it is not confirmed are the fields the instruction names asked about, in a second pair.
    const notWhole = "Jev did not confirm the instruction asks for the whole form";
    if (fallback.length === 0) throw new SaidError("unsure", SAYS.whichFields, `${notWhole}, and it names no field`);
    const named2 = await confirm(false, fallback);
    return narrowed(checked, (f) => fallback.includes(f) && named2(`f${fallback.indexOf(f) + 1}`), () => new SaidError("unsure", SAYS.whichFields, `${notWhole}, nor any field it names`));
  }
  return narrowed(checked, (f) => !unnamed.includes(f) || yes(`f${unnamed.indexOf(f) + 1}`), () => new SaidError("unsure", SAYS.whichFields, "Jev confirmed none of the fields the instruction does not name"));
}
