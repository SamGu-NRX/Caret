// Ask (B25): an instruction becomes an intent (intent.ts), code checks it, and the route decides what runs.
//   - fill: the fill engine (fill/fill.ts proposeFill) restricted to the intent's fields, sources, person and
//     spelled-out values; its text writes become the planner's plan of field writes, checked by validatePlan as
//     every plan is, and its controls (a select's option, a date) are listed for the user to set.
//   - plan: the planner as before: the deterministic planner, then the code-mode writer for an instruction it
//     cannot ground. Plans still run only after the host accepts them.
//   - ask or refuse: a PlannerError whose sentence code wrote. An Ask left unclear about which fields, where to copy
//     from or whose details asks one question with choices instead, when code can list them (B29, choices.ts):
//     AskAsks, a refusal that carries the question. The user's pick comes back as AskOptions.resume, which continues
//     the same intent with that part fixed through every check below.
// Nothing here acts.
import type { ScreenModel, WindowState } from "../model.ts";
import type { AskOption, FillField, FillProposal, Node } from "../protocol.ts";
import type { AskJev, JevRequest } from "../fill/jev.ts";
import type { AboutValue } from "../fill/about.ts";
import { FillError, memoryRefOf, proposeFill } from "../fill/fill.ts";
import { describeField, fieldLabelText, sectionNode } from "../fill/descriptor.ts";
import type { Plan, Step, WindowSel } from "../executor/schema.ts";
import type { WriterPort } from "../writer/port.ts";
import { namesShortLabel, PLAN_CUTOFF, planTask, relevance, taskWindow, type PlanDraft, type PlannerMemory } from "./planner.ts";
import { planWithCode, type WriterUse } from "./codeplan.ts";
import { checkIntent, intentSnapshot, leftToYouSays, UNCLEAR_PART, type AskFixed, type AskIntent, type IntentField, type IntentSnapshot } from "./intent.ts";
import { SAYS, SaidError, Unclear, saysAmbiguous, saysFor, saysNoValue, saysPress, saysUnsure, type AskPart } from "./says.ts";
import { choicesFor, type Choice } from "./choices.ts";
import { fieldWords } from "./sources.ts";
import { asksForWholeForm, exclusionsIn, namedSection } from "./scope-words.ts";
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
  /**
   * Continues an Ask that asked a question (B29): its intent, as the maker gave it, with the user's picks so far in
   * `fixed`. The maker is not asked again; the window must be the one the question was about.
   */
  resume?: AskResume;
}

/** The snapshot refs an intent names, by what they stand for, so it can be read against a later snapshot. */
interface SnapRefs {
  fields: Record<string, string>;
  windows: Record<string, string>;
  persons: Record<string, string>;
  sections: Record<string, string>;
}

/** What continues an Ask after a question: the instruction, the form, the maker's intent and the picks so far. */
export interface AskResume {
  instruction: string;
  windowId: string;
  intent: AskIntent;
  refs: SnapRefs;
  maker: MakerUse;
  makerName: IntentMaker["name"];
  fixed: AskFixed;
  /**
   * The form as the question saw it: its title, and each field's name, section and whether it held text. A field the
   * continued Ask acts on must read the same, and the title must too, or the Ask refuses (B29 review 1: a field
   * relabelled "Recovery email" and filled after the question was written over).
   */
  seen: { title: string; fields: Record<string, { name: string; section: string | null; filled: boolean }> };
}

/** One question an Ask asks (B29): its part, text and options, the form it is about, and what continues it. */
export interface AskQuestionDraft {
  part: AskPart;
  text: string;
  pick: "one" | "many";
  options: Choice[];
  window: { pid: number; windowId: string; appName: string; title: string };
  resume: AskResume;
}

/** The wire options of a question: what the host shows, never a key or window id. */
export const wireOptions = (q: AskQuestionDraft): AskOption[] => q.options.map((c) => c.option);

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

/**
 * An Ask that asks the user a question with choices (B29). It is still a refusal: a caller that cannot ask shows its
 * sentence, as before B29.
 */
export class AskAsks extends AskRefused {
  readonly question: AskQuestionDraft;
  constructor(e: Unclear, intent: AskIntent | null, maker: MakerUse | null, question: AskQuestionDraft) {
    super(e, intent, maker);
    this.question = question;
  }
}

const refsOf = (snap: IntentSnapshot): SnapRefs => ({
  fields: Object.fromEntries(snap.fields.map((f) => [f.ref, f.key])),
  windows: Object.fromEntries(snap.windows.map((w) => [w.ref, w.windowId])),
  persons: Object.fromEntries(snap.persons.map((p) => [p.ref, p.span])),
  sections: Object.fromEntries(snap.sections.map((x) => [x.ref, x.name])),
});

/** The form changed since the question: a field, window, person or section the intent names is not in this snapshot. */
const changed = (what: string): never => {
  throw new SaidError("unknownWindow", SAYS.windowChanged, `since Caret asked, ${what}`);
};

/** Refuses a continued Ask when the form, or a field it would act on, no longer reads as the question saw it. */
function checkSeen(r: AskResume, snap: IntentSnapshot): void {
  if (snap.window.window.title !== r.seen.title) changed("the form's title changed");
  const keys = [...(r.fixed.fields ?? []), ...r.intent.fields.map((x) => r.refs.fields[x]), ...r.intent.literals.map((l) => r.refs.fields[l.field])];
  for (const key of new Set(keys)) {
    const was = key === undefined ? undefined : r.seen.fields[key];
    const now = snap.fields.find((f) => f.key === key);
    if (was === undefined || now === undefined || now.name !== was.name || now.section !== was.section || now.filled !== was.filled) changed(`the field '${was?.name ?? key ?? "?"}' changed`);
  }
}

/** An intent read against a later snapshot of the same form: each ref by what it stood for. */
function remapIntent(intent: AskIntent, refs: SnapRefs, snap: IntentSnapshot): AskIntent {
  const field = (r: string): string => {
    const key = refs.fields[r];
    return snap.fields.find((f) => f.key === key)?.ref ?? changed(`the field ${r} is gone`);
  };
  const source = (r: string): string => {
    const id = refs.windows[r];
    if (id === undefined) return r; // any, memory, instruction, missing
    return snap.windows.find((w) => w.windowId === id)?.ref ?? changed(`the window ${r} is gone`);
  };
  const whose = (r: string): string => {
    const span = refs.persons[r];
    if (span === undefined) return r; // user, unnamed
    return snap.persons.find((p) => p.span === span)?.ref ?? changed(`the person ${r} is no longer found`);
  };
  const section = refs.sections[intent.section];
  return {
    ...intent,
    fields: intent.fields.map(field),
    sources: intent.sources.map(source),
    whose: whose(intent.whose),
    section: section === undefined ? intent.section : (snap.sections.find((x) => x.name === section)?.ref ?? changed(`the section ${intent.section} is gone`)),
    literals: intent.literals.map((l) => ({ ...l, field: field(l.field) })),
  };
}

/** The reason each open part is asked under (intent.ts REASONS). */
const ASKED_WHY = { fields: "whichFields", source: "whichSource", person: "whichPerson" } as const;

/** The parts an intent leaves open: the maker's list, else the one its `why` names, and the fields when it has no scope. */
function openParts(intent: AskIntent): AskPart[] {
  if (intent.open !== undefined) return [...intent.open];
  const asks = intent.route === "ask" || (intent.route === "refuse" && intent.why === "otherPersonUnnamed");
  if (!asks) return [];
  const part = UNCLEAR_PART[intent.why] ?? "fields";
  return part !== "fields" && intent.scope === "none" ? [part, "fields"] : [part];
}

/**
 * The intent with the user's picks in place of the parts they fix: picked fields as the list (with only their own
 * literals), a picked window as the one source, a picked person in checkIntent. With no part left open, the intent is a
 * fill; otherwise it still asks, about the next open part.
 */
function applyFixed(intent: AskIntent, fixed: AskFixed, snap: IntentSnapshot): AskIntent {
  if (fixed.fields === undefined && fixed.source === undefined && fixed.person === undefined) return intent;
  let open = openParts(intent);
  let it: AskIntent = intent;
  if (fixed.fields !== undefined) {
    const refs = fixed.fields.map((k) => snap.fields.find((f) => f.key === k)?.ref ?? changed("a field you picked is gone"));
    it = { ...it, scope: "list", section: "none", fields: refs, literals: it.literals.filter((l) => refs.includes(l.field)) };
    open = open.filter((p) => p !== "fields");
  }
  if (fixed.source !== undefined) {
    const src = fixed.source;
    const ref = src.kind === "memory" ? "memory" : (snap.windows.find((w) => w.windowId === src.windowId)?.ref ?? changed("the window you picked is gone"));
    it = { ...it, sources: [ref] };
    open = open.filter((p) => p !== "source");
  }
  if (fixed.person !== undefined) {
    it = { ...it, whose: "user" };
    open = open.filter((p) => p !== "person");
  }
  const { open: _, ...rest } = it;
  if (openParts(intent).length === 0) return rest;
  return open.length === 0 ? { ...rest, route: "fill", why: "none" } : { ...rest, route: "ask", why: ASKED_WHY[open[0] as AskPart], open };
}

/** The fields an intent has in scope in its snapshot, for a source question: the list, the section, or every empty field. */
function scopeFields(intent: AskIntent, snap: IntentSnapshot): IntentField[] {
  const empty = snap.fields.filter((f) => !f.filled && f.neverTyped === null);
  if (intent.scope === "list" && intent.fields.length > 0) return snap.fields.filter((f) => intent.fields.includes(f.ref));
  const section = snap.sections.find((x) => x.ref === intent.section)?.name;
  if (intent.scope === "section" && section !== undefined) return empty.filter((f) => f.section === section);
  return empty;
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
  const windowId = o.resume?.windowId ?? o.windowId;
  if (windowId !== undefined) {
    const named = model.windows.get(windowId);
    if (named === undefined) throw new AskRefused(new SaidError("unseenWindow", SAYS.windowClosed, `window ${windowId} is not open`), null, null);
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
  const resume = o.resume;
  const fixed: AskFixed = resume?.fixed ?? {};
  const makerName = resume?.makerName ?? o.maker.name;
  let intent: AskIntent;
  try {
    snap = intentSnapshot(instruction, model, w, memory.values());
    // A continued Ask reads the maker's intent against the form as it is now, and asks the maker nothing.
    if (resume !== undefined) checkSeen(resume, snap);
    made = resume === undefined ? await o.maker.make(snap) : { intent: remapIntent(resume.intent, resume.refs, snap), use: resume.maker };
    intent = applyFixed(made.intent, fixed, snap);
  } catch (e) {
    if (e instanceof PlannerError) throw new AskRefused(e, null, null);
    throw e;
  }
  const use = made.use;
  /** The question for an unclear part, when it is not one the user already picked and code can list its candidates. */
  const question = (e: Unclear): AskQuestionDraft | string => {
    if (fixed[e.part] !== undefined) return `the user already picked the ${e.part}`;
    const r = choicesFor(e.part, snap, model, scopeFields(intent, snap), now);
    if (r.choices === null) return r.why;
    return {
      ...r.choices,
      window: { pid: w.app.pid, windowId: w.window.windowId, appName: w.app.name, title: w.window.title },
      resume: {
        instruction,
        windowId: w.window.windowId,
        intent: made.intent,
        refs: refsOf(snap),
        maker: use,
        makerName,
        fixed,
        seen: { title: w.window.title, fields: Object.fromEntries(snap.fields.map((f) => [f.key, { name: f.name, section: f.section, filled: f.filled }])) },
      },
    };
  };
  const refused = (e: unknown): never => {
    if (e instanceof PlannerError) {
      e.windowId ??= w.window.windowId;
      if (e instanceof Unclear) {
        const q = question(e);
        if (typeof q !== "string") throw new AskAsks(e, intent, use, q);
        throw new AskRefused(new Unclear(e.part, e.message, `${e.detail}; no question: ${q}`), intent, use);
      }
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
  const inferredAll = makerName === "writer" && fixed.fields === undefined && intent.route === "fill" && intent.scope === "list" && intent.fields.length === 0 && !snap.fields.some(namesField);
  // A writer's list of every empty field Caret may type is the whole form, and Jev must confirm it as one question, as
  // for an inferred whole form: B26's held-out-2 run listed all nine fields for "fill out the pizza order from my
  // note", "pizza" named only Pizza Size, and Jev, asked about each other field alone, said no to eight. Taken as a
  // plain "all", it stood without any confirmation when no field word named a field ("fill only the first box"; B26's
  // second review).
  const empties = snap.fields.filter((f) => !f.filled && f.neverTyped === null).map((f) => f.ref);
  const listsAll = makerName === "writer" && fixed.fields === undefined && intent.route === "fill" && intent.scope === "list" && empties.length > 1 && empties.every((r) => intent.fields.includes(r));
  let checked: ReturnType<typeof checkIntent>;
  try {
    checked = checkIntent(inferredAll || listsAll ? { ...intent, scope: "all" } : intent, snap, fixed);
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
  // so: when the whole instruction is a section request (scope-words.ts SECTION) the fill narrows to the form's
  // section of that meaning, and otherwise Caret asks which fields (B28 lead decision 1; G1's heldout2-04 filled
  // Graduation Date and LinkedIn for "just do my contact info up top"). Within the section, only the fields the
  // phrase asks for by its meaning stand without Jev (B28b lead decision 2; a "Contact information" heading can hold
  // a Graduation Date). A maker's own section intent is read the same way: the writer's section for "do my contact
  // info" was trusted whole because the instruction names it (B28b review).
  let bySection = false;
  if (checked.route === "fill" && (inferredAll || listsAll || intent.scope === "all" || intent.scope === "section")) {
    try {
      const chosen = !inferredAll && !listsAll && intent.scope === "section" ? (snap.sections.find((x) => x.ref === intent.section)?.name ?? null) : null;
      const n = sectionScope(instruction, checked, snap, chosen);
      if (n !== null) {
        bySection = true;
        checked = n.checked;
        if (n.unsure.length > 0) {
          const yes = await jevConfirms(instruction, snap, askJev)(false, n.unsure);
          checked = narrowed(checked, (f) => !n.unsure.includes(f) || yes(`f${n.unsure.indexOf(f) + 1}`), () => new Unclear("fields", SAYS.whichFields, `Jev confirmed none of the fields under '${n.section}' that ${n.said} does not ask for by its meaning`));
        }
      }
    } catch (e) {
      return refused(e);
    }
  }
  // A writer's intent names fields by ref, which code checks against the snapshot, not against what the instruction
  // asks: a field the instruction does not name by its words, and "every field" when the whole instruction is not a
  // whole-form request (scope-words.ts WHOLE_FORM), and every field when the instruction holds an exclusion word
  // (B28b), stand only when Jev, asked twice, agrees the
  // instruction asks for them (B25 review; B28 lead decision 1; the rule the code-mode writer has had since B24,
  // codeplan.ts confirmFields). Jev's own intents confirmed their fields already.
  // Fields the user picked are the scope they asked for (B29): no maker's reading of the instruction is checked there.
  if (checked.route === "fill" && makerName === "writer" && !bySection && fixed.fields === undefined) {
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
 * A whole-form or section fill narrowed to the section the instruction names by a section phrase (scope-words.ts),
 * or null when it uses none. `chosen` is the section a maker's section intent chose, which must be that one. `unsure` are the section's fields the phrase does not ask for by its meaning, which stand only
 * on Jev's yes. Throws SAYS.whichFields when the whole instruction is not a section request (scope-words.ts
 * SECTION), or a phrase means no section of this form, or more than one; SAYS.nothingToDo when that section has no
 * empty field Caret may type.
 */
function sectionScope(instruction: string, checked: FillChecked, snap: IntentSnapshot, chosen: string | null): { checked: FillChecked; unsure: IntentField[]; section: string; said: string } | null {
  const { phrases, section, why, fits } = namedSection(instruction, snap.sections.map((s) => s.name), snap.fields[0]?.section ?? null);
  if (phrases.length === 0) return null;
  const said = phrases.map((p) => `"${p}"`).join(" and ");
  if (section === null) {
    const has = snap.sections.length === 0 ? "the form has no sections" : `the form's sections are ${snap.sections.map((s) => `'${s.name}'`).join(", ")}`;
    throw new Unclear("fields", SAYS.whichFields, `the instruction names a part of the form by ${said}, and ${why ?? "no one section means that"} (${has})`);
  }
  // The heading is matched by its text, and the text says nothing of whose it is when it sits inside another heading
  // ("Contact information" inside "Emergency contact"), or which part is meant when two parts share it. Both ask.
  const w = snap.window;
  const heads = new Map(snap.fields.filter((f) => f.section === section).map((f) => {
    const n = w.nodes.get(f.key);
    const h = n === undefined ? null : sectionNode(w, n);
    return [h?.key ?? null, h] as const;
  }));
  if (heads.size !== 1 || heads.has(null)) throw new Unclear("fields", SAYS.whichFields, `${said} means '${section}', and more than one part of the form is headed that`);
  const outer = sectionNode(w, [...heads.values()][0] as Node);
  if (outer !== null) throw new Unclear("fields", SAYS.whichFields, `${said} means '${section}', which sits inside '${fieldLabelText(outer.label) ?? ""}' and may be someone else's`);
  if (chosen !== null && chosen !== section) throw new Unclear("fields", SAYS.whichFields, `${said} means '${section}', and the maker chose '${chosen}'`);
  const inSection = narrowed(checked, (f) => f.section === section, () => new SaidError("nothingToDo", SAYS.nothingToDo, `${said} means the section '${section}', which has no empty field Caret may type`));
  // A field is read by the label words fill reads for it (fill.ts proposeFill); one whose node is gone fits nothing.
  const meant = (f: IntentField): boolean => {
    const n = w.nodes.get(f.key);
    if (n === undefined) return false;
    const d = describeField(w, n);
    return fits({ labelWords: [d.label, d.nearest, d.placeholder], name: f.name, typed: f.control === "text" || f.control === "combobox" });
  };
  return { checked: inSection, unsure: inSection.fields.filter((f) => !meant(f)), section, said };
}

/**
 * Asks Jev, in both wordings in parallel, whether the instruction asks for the whole form (`all`) and for each of
 * `fields` (ids f1, f2, ... in order). The answer holds for an id both wordings answer yes at PLAN_CUTOFF.
 */
function jevConfirms(instruction: string, snap: IntentSnapshot, askJev: AskJev): (all: boolean, fields: readonly IntentField[]) => Promise<(id: string) => boolean> {
  const declared = snap.ledger.declared();
  return async (all, fields) => {
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
}

/**
 * The writer's fill scope with every field the instruction does not name by its words confirmed by Jev, both asks
 * answering yes at PLAN_CUTOFF; an "all" or section scope the instruction does not state is confirmed the same way.
 * An "all" stands without asking only when the whole instruction is a scope-words.ts WHOLE_FORM sentence. A whole
 * form Jev does not confirm narrows to the fields the instruction names that Jev then confirms. An instruction that
 * holds an exclusion word (scope-words.ts EXCLUSION_WORDS) grants no trust by naming: every field in scope is
 * confirmed, after the whole form when that is asked too.
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
  // "Every field" stands on the writer's word only when the whole instruction is a whole-form request (B28 lead
  // decision 1). Naming no field is not asking for the form: G1's local maker said "whole form" for "just do my
  // contact info up top", and Graduation Date and LinkedIn were filled. A whole form code inferred from an empty
  // list, or from a list of every field, always needs Jev's yes.
  const whole = scope === "inferred" ? true : scope === "all" ? !asksForWholeForm(instruction) : scope === "section" ? relevance(words, snap.sections.find((x) => x.ref === section)?.name ?? "") === 0 : false;
  // A field or section the instruction names stands on its words, unless the instruction rules something out: the
  // writer listed Email and Phone for "fill out the email and not phone", and gave the whole section for "do the
  // contact section except phone", and both were written without a question (B28b lead decision 1).
  const excluding = exclusionsIn(instruction).length > 0;
  // A section named by its words is not asked for whole when the instruction also names a field in it: "fill only
  // Email in the contact section" (B28b re-check).
  const namesInSection = scope === "section" && checked.fields.some(named);
  const unsure = excluding || namesInSection ? checked.fields : scope === "list" ? checked.fields.filter((f) => !named(f)) : [];
  // When Jev does not confirm the whole form, the fields the instruction names are what is left, each confirmed by
  // Jev: "Fill only Email; do not change Phone" names Phone too.
  const fallback = whole && scope !== "section" ? checked.fields.filter(named) : [];
  if (!whole && unsure.length === 0) return checked;
  const confirm = jevConfirms(instruction, snap, askJev);
  if (whole) {
    // The whole form is one question, asked alone (B26: asked field by field, Jev said no to eight of nine). Only
    // when it is not confirmed are the fields the instruction names asked about, in a second pair.
    const yes = await confirm(true, []);
    if (!yes("all")) {
      const notWhole = "Jev did not confirm the instruction asks for the whole form";
      if (fallback.length === 0) throw new Unclear("fields", SAYS.whichFields, `${notWhole}, and it names no field`);
      const named2 = await confirm(false, fallback);
      return narrowed(checked, (f) => fallback.includes(f) && named2(`f${fallback.indexOf(f) + 1}`), () => new Unclear("fields", SAYS.whichFields, `${notWhole}, nor any field it names`));
    }
    if (unsure.length === 0) return checked;
  }
  const yes = await confirm(false, unsure);
  const none = excluding ? "Jev confirmed none of the fields in scope, and the instruction rules something out" : "Jev confirmed none of the fields the instruction does not name";
  return narrowed(checked, (f) => !unsure.includes(f) || yes(`f${unsure.indexOf(f) + 1}`), () => new Unclear("fields", SAYS.whichFields, none));
}
