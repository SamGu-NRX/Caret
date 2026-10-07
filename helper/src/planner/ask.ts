import { instructionForModel, instructionView } from "../fill/redact.ts";
import { mentionedKind } from "../memory/sensitive.ts";
import { assertNoSecrets } from "../privacy.ts";
// Ask (B25): an instruction becomes an intent (intent.ts), code checks it, and the route decides what runs.
//   - fill: the fill engine (fill/fill.ts proposeFill) restricted to the intent's fields, sources, person and
//     spelled-out values; its text writes become the planner's plan of field writes, checked by validatePlan as
//     every plan is, and its controls (a select's option, a date) are listed for the user to set.
//   - plan: for a host that runs goal plans (B30, AskOptions.goals), an AskGoal: the caller plans the instruction as a
//     D2-06 goal, with its preview, segments, acceptances and receipts, and nothing here plans it. For any other
//     consumer, the planner as before: the deterministic planner, then the code-mode writer for an instruction it
//     cannot ground. Plans still run only after the host accepts them.
//   - ask or refuse: a PlannerError whose sentence code wrote. An Ask left unclear about which fields, where to copy
//     from or whose details asks one question with choices instead, when code can list them (B29, choices.ts):
//     AskAsks, a refusal that carries the question. The user's pick comes back as AskOptions.resume, which continues
//     the same intent with that part fixed through every check below.
// Nothing here acts.
import { randomUUID } from "node:crypto";
import { unnamedTargets } from "./targets.ts";
import { settleFields } from "./intent-heads.ts";
import { askScope, fieldFingerprint, type AskScope, type Authority, type DocumentReader, type Settled } from "../fill/ask-scope.ts";
import type { ScreenModel, WindowState } from "../model.ts";
import { MAX_ASK_OPTIONS, type AskOption, type FillField, type FillProposal, type Node } from "../protocol.ts";
import type { AskJev, JevRequest } from "../fill/jev.ts";
import type { AboutValue } from "../fill/about.ts";
import { conversionOf, FillError, identityRefOf, memoryRefOf, mintOf, PAGE_WINDOW_KIND, proposeFill, type FillOptions, type FillScope } from "../fill/fill.ts";
import { describeField, fieldLabelText, sectionNode } from "../fill/descriptor.ts";
import { formControls } from "../fill/controls.ts";
import type { Plan, Step, WindowSel } from "../executor/schema.ts";
import type { WriterPort } from "../writer/port.ts";
import { namesShortLabel, PLAN_CUTOFF, planTask, relevance, taskWindow, wordsOf, type PlanDraft, type PlannerMemory } from "./planner.ts";
import { planWithCode, type WriterUse } from "./codeplan.ts";
import { checkIntent, intentSnapshot, leftToYouSays, UNCLEAR_PART, type AskFixed, type AskIntent, type IntentField, type IntentSnapshot } from "./intent.ts";
import { SAYS, SaidError, Unclear, asksFieldsBeside, jevFailedError, saysAmbiguous, saysFor, saysNeverTyped, saysNoValue, saysOptionsUnseen, saysPress, saysUnsure, saysUnsureFields, type AskPart } from "./says.ts";
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
  /**
   * I2: which page document a window shows now (the helper's page engine). The Ask's scope records the document its
   * question was asked on, and every check of the scope reads the document through this; without it, a page's scope
   * holds nothing on any page.
   */
  documentOf?: DocumentReader;
  /** I2: what this request's scope question already settled (the direct attach rule's, helper.ts), used in place of asking again. */
  settled?: Settled;
  /** W1: passed to the fill step's proposal (FillOptions.trace), for evaluation harnesses only. */
  fillTrace?: FillOptions["trace"];
  /** Fault-injection seam for the planner evaluation (PlanTaskOptions.beforeCheck). */
  beforeCheck?: () => Promise<void>;
  /**
   * The consumer runs goal plans (protocol GOAL_PLANS_CAPABILITY): the plan route returns an AskGoal for the goal path
   * instead of planning in one window (B30).
   */
  goals?: boolean;
  /**
   * Continues an Ask that asked a question (B29): its intent, as the maker gave it, with the user's picks so far in
   * `fixed`. The maker is not asked again; the window must be the one the question was about.
   */
  resume?: AskResume;
  /**
   * I6: the model the fill step reads its sources from, for the form in `formWindowId` (helper.ts: the model with the text
   * of the tab the user just left, read then and held for this Ask's offer, engines/tab-source.ts). Called once, only when
   * the Ask reaches its fill step, so no read happens for an Ask that plans, asks a question, refuses or is a page goal;
   * everything before it (the window, the intent and its scope) reads `model`. The plan's own check reads it too, as the
   * offer's acceptance does (helper.ts acceptPlan).
   */
  fillModel?: (formWindowId: string) => Promise<ScreenModel>;
}

/** The snapshot refs an intent names, by what they stand for, so it can be read against a later snapshot. */
interface SnapRefs {
  fields: Record<string, string>;
  /** I2: upload field refs (IntentSnapshot.uploads) to their keys. */
  uploads: Record<string, string>;
  windows: Record<string, string>;
  persons: Record<string, string>;
  sections: Record<string, string>;
}

/** What continues an Ask after a question: the instruction, the form, the maker's intent and the picks so far. */
export interface AskResume {
  instruction: string;
  /** I2: the Ask's id (AskScope.askId), kept by every question it asks. */
  askId?: string;
  windowId: string;
  intent: AskIntent;
  refs: SnapRefs;
  maker: MakerUse;
  makerName: IntentMaker["name"];
  fixed: AskFixed;
  /**
   * The form as the question saw it: its title, and each field as fieldSeen reads it. Every field the continued Ask
   * fills must read the same, and the title must too, or the Ask refuses (B29 review 1: a field relabelled "Recovery
   * email" and filled after the question was written over; re-check: a whole-form scope, and a select swapped for a
   * text field, got past a check of the intent's named fields only).
   */
  seen: { title: string; fields: Record<string, string> };
  /** I2 ruling B: the page document the first question was asked on, read when its snapshot was taken (null: none). */
  document: string | null;
  /**
   * I2: the field and upload keys the per-field scope question settled before this question was asked (the fields it
   * chose and the ones it offers); absent when it had not been asked yet. A continued Ask never asks it again: its scope
   * is these, narrowed by the user's picks.
   */
  scopeKeys?: string[];
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

/** An Ask whose intent is a plan, for a host that runs goal plans (B30): the caller offers it as a goal. */
export interface AskGoal {
  route: "goal";
  intent: AskIntent;
  maker: MakerUse;
  /** The window the Ask was about: the goal reads it first. */
  windowId: string;
  /**
   * P2: an Ask about a page window, fill or plan, checked like any fill: the caller plans it with the page planner
   * (goals/page-planner.ts) under this scope. `kind` is which fields the scope takes (every empty one, a section's, or
   * the ones named), for the reveal continuation; a scope narrowed by Jev's confirmation is a list. Absent for a goal
   * about native windows, which the writer plans.
   */
  page?: { scope: FillScope; trigger: string; kind: "all" | "section" | "list"; section: string | null; unsure?: readonly string[] };
  /** I2: the Ask's settled scope, which the goal's write contract and goal gate enforce (fill/ask-scope.ts). */
  askScope?: AskScope;
  /** I2: the Ask's id, which every scope the goal holds carries (a window with no field gives no scope of its own). */
  askId: string;
  /** I2: whether the goal continues an Ask that asked a question: it settles nothing (helper.ts takes no settle ticket). */
  resumed: boolean;
}

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
  uploads: Object.fromEntries(snap.uploads.map((f) => [f.ref, f.key])),
  windows: Object.fromEntries(snap.windows.map((w) => [w.ref, w.windowId])),
  persons: Object.fromEntries(snap.persons.map((p) => [p.ref, p.span])),
  sections: Object.fromEntries(snap.sections.map((x) => [x.ref, x.name])),
});

/** The form changed since the question: a field, window, person or section the intent names is not in this snapshot. */
const changed = (what: string): never => {
  throw new SaidError("unknownWindow", SAYS.windowChanged, `since Caret asked, ${what}`);
};

/** What a field is, as a continued Ask compares it and as the Ask's scope records it (fill/ask-scope.ts fieldFingerprint). */
const fieldSeen = (w: WindowState, f: IntentField): string => fieldFingerprint(w, f.key);

/**
 * I2 ruling: a field no name reads is in no Ask's inventory (targets.ts), so the Ask says it left such fields to the
 * user, after what it left for other reasons; null when there is nothing to say.
 */
function withUnnamed(left: string | null, w: WindowState): string | null {
  const n = unnamedTargets(w).length;
  if (n === 0) return left;
  const says = `${n === 1 ? "A field with no name is" : `${n} fields with no name are`} yours to fill.`;
  return left === null ? says : `${left} ${says}`;
}

/**
 * V4: the scoped menus whose options the window does not show (FormControl.options null: Chrome's Accessibility shows a
 * closed menu's selected option only), which fill never asks about and Caret never opens to read; the Ask says they are
 * the user's.
 */
function unseenOptions(w: WindowState, fields: readonly IntentField[]): IntentField[] {
  const shut = new Set(formControls(w).filter((c) => c.control === "select" && c.options === null).map((c) => c.node.key));
  return fields.filter((f) => shut.has(f.key));
}

/** `left`, then the sentence for the scoped menus whose options Caret cannot see (unseenOptions). */
function withUnseen(left: string | null, w: WindowState, fields: readonly IntentField[]): string | null {
  const says = saysOptionsUnseen(unseenOptions(w, fields).map((f) => f.name));
  return says === null ? left : left === null ? says : `${left} ${says}`;
}

/** A planner's refusal, with the fields no name reads said as the user's (withUnnamed): an Ask never writes them. */
function saidWithUnnamed(e: unknown, w: WindowState): unknown {
  if (!(e instanceof PlannerError) || unnamedTargets(w).length === 0) return e;
  const said = withUnnamed(e instanceof SaidError ? e.message : saysFor(e.code), w) as string;
  return new SaidError(e.code, said, e.message);
}

/** What a question records of the form; a later question of the same Ask keeps the first one's record of each field. */
function seenOf(snap: IntentSnapshot, earlier: AskResume["seen"] | undefined): AskResume["seen"] {
  const now = Object.fromEntries([...snap.fields, ...snap.uploads].map((f) => [f.key, fieldSeen(snap.window, f)]));
  return earlier === undefined ? { title: snap.window.window.title, fields: now } : { title: earlier.title, fields: { ...now, ...earlier.fields } };
}

/**
 * Refuses a continued Ask when the form's title, or any field it is about to fill, no longer reads as the question saw
 * it. Only the fields in the final scope count: an unpicked field may change or go (re-check). Run on a snapshot taken
 * after the fill's last model call, so a change made while Jev answered is seen too (second re-check).
 */
function checkSeen(r: AskResume, snap: IntentSnapshot, keys: readonly string[]): void {
  if (snap.window.window.title !== r.seen.title) changed("the form's title changed");
  for (const key of keys) {
    const f = snap.fields.find((x) => x.key === key);
    if (f === undefined || r.seen.fields[key] !== fieldSeen(snap.window, f)) changed(`the field '${f?.name ?? key}' changed`);
  }
}

/** An intent read against a later snapshot of the same form: each ref by what it stood for. */
function remapIntent(intent: AskIntent, refs: SnapRefs, snap: IntentSnapshot, fieldsPicked: boolean): AskIntent {
  const field = (r: string): string => {
    const key = refs.fields[r];
    return snap.fields.find((f) => f.key === key)?.ref ?? changed(`the field ${r} is gone`);
  };
  // Fields the user picked replace the intent's own (applyFixed): one of those that is gone does not matter (re-check).
  const kept = (r: string): boolean => !fieldsPicked || snap.fields.some((f) => f.key === refs.fields[r]);
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
    fields: intent.fields.filter(kept).map(field),
    ...(intent.options === undefined ? {} : { options: intent.options.filter(kept).map(field) }),
    // I3: the fields Jev settled stay in scope through the pick, so one that is gone changes the form under the question.
    ...(intent.sure === undefined ? {} : { sure: intent.sure.map(field) }),
    ...(intent.unsure === undefined ? {} : { unsure: intent.unsure.filter((r) => snap.fields.some((f) => f.key === refs.fields[r])).map(field) }),
    sources: intent.sources.map(source),
    whose: whose(intent.whose),
    section: section === undefined ? intent.section : (snap.sections.find((x) => x.name === section)?.ref ?? changed(`the section ${intent.section} is gone`)),
    literals: intent.literals.filter((l) => kept(l.field)).map((l) => ({ ...l, field: field(l.field) })),
    ...(intent.uploads === undefined ? {} : { uploads: intent.uploads.map((r) => snap.uploads.find((u) => u.key === refs.uploads[r])?.ref ?? changed(`the upload field ${r} is gone`)) }),
  };
}

/** Whether the intent's fields are Jev's scope ask's (intent-heads.ts): chosen in both wordings, or offered to ask. */
const fromJev = (intent: AskIntent): boolean => intent.agreed === true || intent.options !== undefined;

/** An intent whose scope is no longer the fields Jev chose, once planAsk rewrites it. */
function withoutAgreement(intent: AskIntent): AskIntent {
  const { agreed: _, ...rest } = intent;
  return rest;
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
    // I3: the fields Jev settled beside the question (`sure`) stay; the user's pick adds to them.
    const picked = fixed.fields.map((k) => snap.fields.find((f) => f.key === k)?.ref ?? changed("a field you picked is gone"));
    const keep = new Set([...(intent.sure ?? []), ...picked]);
    const refs = snap.fields.filter((f) => keep.has(f.ref)).map((f) => f.ref);
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

/**
 * Plans an Ask. Throws AskRefused with the failing check's code, the user's sentence and the check's detail. With
 * `goals`, a plan intent comes back as an AskGoal, checked like every intent and planned by nothing here.
 */
export async function planAsk(instruction: string, model: ScreenModel, memory: PlannerMemory, about: readonly AboutValue[], o: AskOptions & { goals?: false }): Promise<AskDraft>;
export async function planAsk(instruction: string, model: ScreenModel, memory: PlannerMemory, about: readonly AboutValue[], o: AskOptions): Promise<AskDraft | AskGoal>;
export async function planAsk(instruction: string, model: ScreenModel, memory: PlannerMemory, about: readonly AboutValue[], o: AskOptions): Promise<AskDraft | AskGoal> {
  // PV1: refuse a wholly forbidden instruction locally, before even window selection can build a request.
  // A mixed instruction keeps its original local checks; each outbound builder projects the safe clauses instead.
  const kind = mentionedKind(instruction);
  const safeAction = instructionView(instruction).retained.some((span) => /[\p{L}\p{N}]/u.test(span.replace(/\b(?:and|then)\b/giu, "")));
  if (kind !== null && !safeAction) throw new AskRefused(new SaidError("notEditable", saysNeverTyped(kind.kind, kind.ssn), "the instruction only asks for a kind Caret never types"), null, null);
  const now = o.now ?? Date.now();
  const jev = { calls: 0, costUsd: 0, latencyMs: 0 };
  const askJev: AskJev = async (req) => {
    let r: Awaited<ReturnType<AskJev>>;
    try {
      r = await o.askJev(req);
    } catch (e) {
      // A Jev failure anywhere in an Ask (a timeout, an HTTP error) is reported as the planner reports one.
      throw jevFailedError(e);
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
  // I2 ruling B: the page document the question is asked on, read with the snapshot, before any planning awaits; a
  // continued Ask keeps its first question's.
  const documentOf = o.documentOf ?? null;
  // I2 ruling: one request, one settlement: a settlement this request already made on this window (the direct attach
  // rule's, helper.ts) is used, with its id, document and fingerprints, and the scope question is not asked again.
  const presettled = resume === undefined && o.settled !== undefined && o.settled.windowId === w.window.windowId ? o.settled : undefined;
  const document = resume !== undefined ? resume.document : presettled !== undefined ? presettled.document : documentOf === null ? null : documentOf(w.window.windowId);
  try {
    snap = intentSnapshot(instruction, model, w, memory.values());
    // A continued Ask reads the maker's intent against the form as it is now, and asks the maker nothing.
    made = resume === undefined ? await o.maker.make(snap, undefined, presettled) : { intent: remapIntent(resume.intent, resume.refs, snap, fixed.fields !== undefined), use: resume.maker };
    intent = applyFixed(made.intent, fixed, snap);
    // A window with no field at all (the email the user is reading) has nothing to fill or to ask which fields of, so
    // for a host that runs goals an Ask from it is about other windows: a fill or an unsettled intent is a plan, which
    // checkIntent still refuses for a kind Caret never types or a source no window could be (B30: the Jev maker left
    // four of B30's live asks from an email unsettled, and each was told "Which fields do you mean?").
    if (o.goals === true && resume === undefined && snap.fields.length === 0 && (intent.route === "fill" || intent.route === "ask")) intent = { ...withoutAgreement(intent), route: "plan", why: "none", scope: "none", fields: [], literals: [] };
  } catch (e) {
    if (e instanceof PlannerError) throw new AskRefused(e, null, null);
    throw e;
  }
  const use = made.use;
  // I2 rulings: the Ask's own id, which its scope and every mint's authority carry; a continued Ask keeps it, carries
  // the scope its first question froze, and is on the document that question was asked on, or it goes no further
  // (no goal, no settling: settlement is a fresh Ask's or a carry's, helper.ts).
  const askId = resume?.askId ?? presettled?.askId ?? randomUUID();
  if (resume !== undefined) {
    if (resume.scopeKeys === undefined || resume.askId === undefined) throw new AskRefused(new SaidError("questionGone", SAYS.questionGone, "the question carries no settled scope"), null, null);
    const docNow = documentOf === null ? null : documentOf(w.window.windowId);
    if (docNow !== resume.document) throw new AskRefused(new SaidError("unknownWindow", SAYS.windowChanged, "the page is another document than the one the question was asked on"), null, null);
  }
  // I2: the keys the per-field scope question settled, frozen for a continued Ask: a resumed Ask's own record, else the
  // heads maker's scope ask (its intent's chosen and offered fields and chosen uploads), else none until settleFields.
  let frozen: string[] | undefined = resume?.scopeKeys;
  const settledKeys = (): string[] | undefined => {
    if (frozen !== undefined) return frozen;
    if (made.intent.settled !== undefined) {
      const k = (r: string): string | undefined => snap.fields.find((f) => f.ref === r)?.key ?? snap.uploads.find((u) => u.ref === r)?.key;
      return made.intent.settled.flatMap((r) => k(r) ?? []);
    }
    if (!fromJev(intent)) return undefined;
    const key = (r: string): string | undefined => snap.fields.find((f) => f.ref === r)?.key ?? snap.uploads.find((u) => u.ref === r)?.key;
    return [...new Set([...intent.fields, ...(intent.options ?? []), ...(intent.uploads ?? [])].flatMap((r) => key(r) ?? []))];
  };
  // P2: on a page with fields, for a host that runs goals, a fill or a plan is planned by the page planner, and Caret
  // still presses nothing on the page. Another maker's plan is read as a fill of the whole form, which Jev must confirm
  // the instruction asks for (confirmScope, as an inferred whole form). A3: a heads-maker plan fills Jev's fields from
  // the sources and for the person it read, after asking what it left open (intent-heads.ts).
  const pageGoal = o.goals === true && w.window.kind === PAGE_WINDOW_KIND && snap.fields.length > 0;
  const planAsAll = pageGoal && intent.route === "plan";
  if (planAsAll) {
    const pending = (intent.pageOpen ?? []).filter((p) => fixed[p] === undefined);
    intent = !fromJev(intent)
      ? { ...withoutAgreement(intent), route: "fill", why: "none", scope: "list", fields: [], literals: [] }
      : pending.length > 0
        ? { ...intent, route: "ask", why: ASKED_WHY[pending[0] as AskPart], open: pending }
        : { ...intent, route: "fill", why: "none" };
  }
  // I2 (review of the A3 merge): any other plan from Jev's scope ask is held to Jev's fields, or the user's pick, by the
  // Ask's scope (below, enforced by the write contract). Before it, the native planner rebuilt its own field list from
  // the instruction's words: "fill the form and submit" with only Name chosen wrote Name and Email, and an "unclear"
  // Email was written without asking. The planner is asked only about those fields (nativeFields), which saves
  // questions about writes the contract would refuse. A part left open is asked first, as for a page goal. Fields open
  // with nothing to offer means Jev chose no field: the plan may only hand off a press ("hit submit"), so nothing is asked.
  let nativeFields: string[] | undefined;
  // A window with no field (the email a reply goal starts from) gives no scope: the goal settles one on the window it
  // writes in (helper.ts settleScopeFor), never an empty one from here.
  if (!planAsAll && intent.route === "plan" && snap.fields.length > 0 && fromJev(intent)) {
    const offersFields = (intent.options ?? []).length > 0;
    const pending = (intent.pageOpen ?? []).filter((p) => fixed[p] === undefined && (p !== "fields" || offersFields));
    nativeFields = pending.includes("fields") ? [] : intent.fields.map((r) => snap.fields.find((f) => f.ref === r)?.key ?? changed(`the field ${r} is gone`));
    if (pending.length > 0 && (pending.includes("fields") || nativeFields.length > 0)) intent = { ...intent, route: "ask", why: ASKED_WHY[pending[0] as AskPart], open: pending };
  }
  /** The question for an unclear part, when it is not one the user already picked and code can list its candidates. */
  const question = (e: Unclear): AskQuestionDraft | string => {
    if (fixed[e.part] !== undefined) return `the user already picked the ${e.part}`;
    // A3: an intent from Jev's scope ask offers exactly the fields Jev left unclear or chose, never fields code picked.
    const offered = intent.options === undefined ? null : intent.options.map((r) => snap.fields.find((f) => f.ref === r) ?? changed(`the field ${r} is gone`));
    // I2 rulings: no question is saved for an Ask whose scope is not settled; every question carries that scope, and
    // offers (and looks for sources of) the settled fields only.
    const settled = settledKeys();
    if (settled === undefined) return "the Ask's scope was not settled";
    const r = choicesFor(e.part, snap, model, scopeFields(intent, snap), now, offered, new Set(settled));
    if (r.choices === null) return r.why;
    // I3: a fields question beside fields Jev settled says those are filled whatever the pick.
    const sure = e.part === "fields" ? (intent.sure ?? []).map((ref) => snap.fields.find((f) => f.ref === ref)?.name ?? changed(`the field ${ref} is gone`)) : [];
    return {
      ...r.choices,
      ...(sure.length === 0 ? {} : { text: asksFieldsBeside(sure) }),
      window: { pid: w.app.pid, windowId: w.window.windowId, appName: w.app.name, title: w.window.title },
      resume: {
        instruction,
        windowId: w.window.windowId,
        intent: made.intent,
        refs: refsOf(snap),
        maker: use,
        makerName,
        fixed,
        seen: seenOf(snap, resume?.seen ?? (presettled === undefined ? undefined : { title: w.window.title, fields: { ...presettled.seen } })),
        document,
        askId,
        scopeKeys: settled,
      },
    };
  };
  const refused = (e: unknown): never => {
    if (e instanceof PlannerError) {
      e.windowId ??= w.window.windowId;
      if (e instanceof Unclear) {
        // I3 lead ruling: Jev settled no field and offers more than one question lists. Nothing is filled, and the
        // sentence names those fields as the user's, never "which fields?".
        const offered = intent.options ?? [];
        if (e.part === "fields" && fixed.fields === undefined && (intent.sure ?? []).length === 0 && offered.length > MAX_ASK_OPTIONS) {
          const names = offered.map((ref) => snap.fields.find((f) => f.ref === ref)?.name ?? ref);
          throw new AskRefused(new SaidError("unsure", saysUnsureFields(names), `${e.detail}; no question: ${offered.length} fields Jev offers, more than one question lists, and Jev settled none`), intent, use);
        }
        const q = question(e);
        if (typeof q !== "string") throw new AskAsks(e, intent, use, q);
        throw new AskRefused(new Unclear(e.part, e.message, `${e.detail}; no question: ${q}`), intent, use);
      }
      throw new AskRefused(e, intent, use);
    }
    throw e;
  };
  /** I3: fields the writer's or staged maker's settlement left to the user (unsure), beside the heads maker's intent.unsure. */
  let unsureLeft: IntentField[] = [];
  // I2 ruling (order): an Ask settles its scope before it asks any question. The heads maker's scope ask is in its intent;
  // the writer's and the staged maker's fields are asked here, every field and upload field of the form in one
  // question, before code reads the intent, so every question carries the frozen scope (AskResume.scopeKeys). Fields
  // left unclear are asked about first. No whole-form confirmation stands in for this question.
  if (frozen === undefined && made.intent.settled === undefined && !fromJev(intent)) {
    if (snap.fields.length === 0 && snap.uploads.length === 0) frozen = [];
    else if (fixed.fields === undefined) {
      let settled: Awaited<ReturnType<typeof settleFields>>;
      if (presettled !== undefined) {
        const of = (keys: readonly string[]): IntentField[] => [...snap.fields, ...snap.uploads].filter((f) => keys.includes(f.key));
        settled = { asks: of(presettled.asks), unclear: of(presettled.unclear) };
      } else
        try {
          settled = await settleFields(snap, askJev);
        } catch (e) {
          return refused(e);
        }
      const unclear = settled.unclear.filter((f) => f.upload !== true);
      frozen = [...settled.asks, ...unclear].map((f) => f.key);
      // I3 lead ruling, as the heads maker reads it (intent-heads.ts): the fields Jev chose are filled; the unclear ones
      // are asked about beside them when one question lists them all, else each is left to the user, said.
      const sure = snap.fields.filter((f) => settled.asks.includes(f));
      if (unclear.length > MAX_ASK_OPTIONS && sure.length > 0) {
        frozen = settled.asks.map((f) => f.key);
        unsureLeft = unclear;
      } else if (unclear.length > 0) {
        const sureRefs = sure.map((f) => f.ref);
        intent = { ...intent, options: (sure.length > 0 ? unclear : snap.fields.filter((f) => unclear.includes(f))).map((f) => f.ref), ...(sure.length > 0 ? { sure: sureRefs } : {}) };
        // A continued Ask reads the maker's intent again (AskResume.intent): the settled fields go with it.
        if (sure.length > 0) made = { ...made, intent: { ...made.intent, sure: sureRefs } };
        return refused(new Unclear("fields", SAYS.whichFields, `Jev left ${unclear.map((f) => `'${f.name}'`).join(", ")} unclear`));
      }
    }
  }
  // The words that may name fields are the instruction without its source phrases (sources.ts): "from my note"
  // never names the form's "Add a gift note" (B25 held-08).
  const words = fieldWords(instruction);
  // A field is named by the words that tell it from the form's other fields, not by words it shares with them (P1
  // review): "fill Work email" names Work email, and Personal email is not named by "email". A field whose every word
  // another field shares is named by all of them, unless a field with more words is named the same way ("work email"
  // names Work email, not Email too).
  const said = new Set(wordsOf(words));
  const nameWords = new Map(snap.fields.map((f) => [f.key, new Set(wordsOf(f.name))]));
  const namesField = (f: IntentField): boolean => {
    if (namesShortLabel(words, f.name)) return true;
    const own = nameWords.get(f.key) ?? new Set(wordsOf(f.name));
    const others = snap.fields.filter((g) => g.key !== f.key).map((g) => nameWords.get(g.key) ?? new Set<string>());
    const distinct = [...own].filter((x) => !others.some((o) => o.has(x)));
    if (distinct.length > 0) return distinct.some((x) => said.has(x));
    if (own.size === 0 || ![...own].every((x) => said.has(x))) return false;
    return !others.some((o) => o.size > own.size && [...own].every((x) => o.has(x)) && [...o].every((x) => said.has(x)));
  };
  // A writer's fill with an empty list, for an instruction whose field words name no field, is read as the whole form,
  // which Jev must then confirm (confirmScope): B25's writer gave "can you get this enrollment form done from what I
  // jotted down" an empty list, and the Ask refused it as a field the form does not have (held-07).
  // The writer's intent and the heads maker's one request are each one answer; the staged Jev maker asked every part
  // twice and confirmed its fields itself. The checks below hold the first two to Jev's confirmation (P1).
  const oneAnswer = makerName !== "jev";
  const inferredAll = (oneAnswer || planAsAll) && fixed.fields === undefined && intent.route === "fill" && intent.scope === "list" && intent.fields.length === 0 && (planAsAll || !snap.fields.some(namesField));
  // A writer's list of every empty field Caret may type is the whole form, and Jev must confirm it as one question, as
  // for an inferred whole form: B26's held-out-2 run listed all nine fields for "fill out the pizza order from my
  // note", "pizza" named only Pizza Size, and Jev, asked about each other field alone, said no to eight. Taken as a
  // plain "all", it stood without any confirmation when no field word named a field ("fill only the first box"; B26's
  // second review).
  const empties = snap.fields.filter((f) => !f.filled && f.neverTyped === null).map((f) => f.ref);
  // A3: fields Jev chose in both wordings of its scope ask (intent-heads.ts) need no further confirmation, here or below.
  const agreed = intent.agreed === true && fixed.fields === undefined;
  const listsAll = oneAnswer && !agreed && fixed.fields === undefined && intent.route === "fill" && intent.scope === "list" && empties.length > 1 && empties.every((r) => intent.fields.includes(r));
  let checked: ReturnType<typeof checkIntent>;
  try {
    checked = checkIntent(inferredAll || listsAll ? { ...intent, scope: "all" } : intent, snap, fixed);
  } catch (e) {
    return refused(e);
  }
  const extra = { intent, maker: use, fill: null };
  /** I3: the fields left to the user because Jev wasn't sure the request asks for them, never one the Ask writes. */
  const unsureOf = (writes: Iterable<string>): { key: string; name: string }[] => {
    const writing = new Set(writes);
    const fields = [...unsureLeft, ...(intent.unsure ?? []).flatMap((r) => snap.fields.find((f) => f.ref === r) ?? [])];
    return fields.filter((f) => !writing.has(f.key)).map((f) => ({ key: f.key, name: f.name }));
  };
  const withUnsure = (writes: Iterable<string>): { unsure?: { key: string; name: string }[] } => {
    const u = unsureOf(writes);
    return u.length === 0 ? {} : { unsure: u };
  };
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
  let sectionName: string | null = null;
  /** The section's fields before Jev confirmed the ones its phrase does not ask for by meaning (P2: fewer is a list). */
  let sectionBefore = 0;
  if (checked.route === "fill" && !agreed && (inferredAll || listsAll || intent.scope === "all" || intent.scope === "section")) {
    try {
      const chosen = !inferredAll && !listsAll && intent.scope === "section" ? (snap.sections.find((x) => x.ref === intent.section)?.name ?? null) : null;
      const n = sectionScope(instruction, checked, snap, chosen);
      if (n !== null) {
        bySection = true;
        sectionName = n.section;
        sectionBefore = n.checked.fields.length;
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
  // The fields in scope before Jev's confirmation may narrow them: a scope that loses one is a list (P2's page kind).
  const scopedBefore = checked.route === "fill" ? checked.fields.length : 0;
  if (checked.route === "fill" && (oneAnswer || planAsAll) && !agreed && !bySection && fixed.fields === undefined) {
    try {
      checked = await confirmScope(instruction, checked, inferredAll || listsAll ? "inferred" : intent.scope, intent.section, snap, askJev, namesField);
    } catch (e) {
      return refused(e);
    }
  }

  // H11: a plan intent is a goal only when a writer can plan it. Since L1 there is none by default, and without one a
  // goal refuses every native plan ("no plan writer") that planTask below would still make; a page fill is a goal
  // (planPage, below) and needs no writer.
  // I2 rulings D and order: the frozen scope (settled above, or a continued Ask's) holds the writer's and the staged
  // maker's routes: a fill keeps only the fields it settled, a plan writes only those or the user's picks.
  let uploadKeys: string[] = (intent.uploads ?? []).flatMap((r) => snap.uploads.find((u) => u.ref === r)?.key ?? []);
  const settledNow = settledKeys();
  if (!fromJev(intent) && settledNow !== undefined && (checked.route === "fill" || checked.route === "plan")) {
    if (fixed.fields === undefined) uploadKeys = settledNow.filter((k) => snap.uploads.some((u) => u.key === k));
    if (checked.route === "fill" && fixed.fields === undefined) {
      try {
        checked = narrowed(checked, (f) => settledNow.includes(f.key), () => new SaidError("nothingToDo", SAYS.whichFields, "Jev's scope question chose none of the fields the instruction was read to ask for"));
      } catch (e) {
        return refused(e);
      }
    } else if (checked.route === "plan" && nativeFields === undefined) {
      // A pick is the intent's list now (applyFixed): the user's fields with the ones Jev settled beside the question.
      nativeFields = fixed.fields === undefined ? settledNow.filter((k) => snap.fields.some((f) => f.key === k)) : intent.fields.map((r) => snap.fields.find((f) => f.ref === r)?.key ?? changed(`the field ${r} is gone`));
    }
  }
  const fieldKeys = checked.route === "fill" ? checked.fields.map((f) => f.key) : (nativeFields ?? []);
  // Only keys the scope question settled: a continued Ask's picks narrow its frozen scope and never widen it.
  const scopeKeys = [...fieldKeys, ...uploadKeys].filter((k) => settledNow === undefined || settledNow.includes(k));
  let scope: AskScope;
  try {
    // A window with no field gives a scope of no field: it authorizes nothing (a goal settles each window it writes in).
    scope = askScope(w.window.windowId, document, scopeKeys, resume?.seen.fields ?? { ...seenOf(snap, undefined).fields, ...(presettled?.seen ?? {}) }, fixed.person?.kind === "person" ? fixed.person.name : null, askId, fixed.fields ?? []);
  } catch (e) {
    return refused(new SaidError("unknownWindow", SAYS.windowChanged, e instanceof Error ? e.message : String(e)));
  }
  // I2: every write an Ask plans carries the Ask's authority, its scope, never none.
  const authority: Authority = { kind: "ask", scope };
  const asked = { authority, documentOf };

  // H11: a plan intent is a goal only when a writer can plan it. Since L1 there is none by default, and without one a
  // goal refuses every native plan ("no plan writer") that planTask below would still make; a page fill is a goal
  // (planPage, below) and needs no writer.
  // I2 ruling: no goal is handed off for a page that became another document since the Ask's scope was settled, fresh
  // Ask or continued: the goal would settle again on the new one.
  const movedOn = (): boolean => documentOf !== null && documentOf(w.window.windowId) !== document;
  if (checked.route === "plan" && o.goals === true && o.writer !== null && movedOn()) return refused(new SaidError("unknownWindow", SAYS.windowChanged, "the page became another document while Caret planned"));
  if (checked.route === "plan" && o.goals === true && o.writer !== null) return { route: "goal", intent, maker: use, windowId: w.window.windowId, askId, resumed: resume !== undefined, ...(snap.fields.length === 0 ? {} : { askScope: scope }) };
  if (checked.route === "plan") {
    try {
      const d = await planTask(instruction, model, memory, { askJev, offerKey: o.offerKey, windowId: w.window.windowId, now, ...(o.rand === undefined ? {} : { rand: o.rand }), ...(o.beforeCheck === undefined ? {} : { beforeCheck: o.beforeCheck }), ...(nativeFields === undefined ? {} : { fields: nativeFields }), ...asked });
      return onlyPress(d) ?? { ...d, ...extra, route: "plan", leftToYou: withUnnamed(d.leftToYou ?? null, w), ...withUnsure(d.checked.writes.map((x) => x.node.key)) };
    } catch (e) {
      if (!(e instanceof PlannerError) || (e.code !== "unsure" && e.code !== "nothingToDo") || o.writer === null) return refused(saidWithUnnamed(e, w));
      try {
        const d = await planWithCode(instruction, model, memory, { writer: o.writer, askJev, offerKey: o.offerKey, windowId: w.window.windowId, now, ...(nativeFields === undefined ? {} : { fields: nativeFields }), ...asked });
        return onlyPress(d) ?? { ...d, ...extra, route: "plan", leftToYou: withUnnamed(d.leftToYou ?? null, w), ...withUnsure(d.checked.writes.map((x) => x.node.key)) };
      } catch (e2) {
        if (e2 instanceof PlannerError) return refused(new SaidError(e.code, e instanceof SaidError ? e.message : saysFor(e.code), `${e.message}; the plan writer did not help either: ${e2.message}`));
        throw e2;
      }
    }
  }

  // Checked before the fill too, so a form that changed while the question was open is said as such, and no Jev call
  // is spent on it.
  if (resume !== undefined && checked.route === "fill") {
    try {
      checkSeen(resume, snap, [...checked.fields, ...checked.leftToYou].map((f) => f.key));
    } catch (e) {
      return refused(e);
    }
  }
  if (pageGoal && checked.route === "fill" && movedOn()) return refused(new SaidError("unknownWindow", SAYS.windowChanged, "the page became another document while Caret planned"));
  if (pageGoal && checked.route === "fill") {
    const whole = fixed.fields === undefined && !bySection && (inferredAll || listsAll || intent.scope === "all");
    const section = bySection ? sectionName : intent.scope === "section" && fixed.fields === undefined ? (snap.sections.find((x) => x.ref === intent.section)?.name ?? null) : null;
    const narrowed = bySection ? checked.fields.length !== sectionBefore : checked.fields.length !== scopedBefore;
    const kind = narrowed ? "list" : whole ? "all" : section !== null ? "section" : "list";
    const unsure = unsureOf(checked.scope.fields).map((f) => f.key);
    return { route: "goal", intent, maker: use, windowId: w.window.windowId, page: { scope: uploadKeys.length === 0 ? checked.scope : { ...checked.scope, fields: [...checked.scope.fields, ...uploadKeys] }, trigger: checked.trigger, kind, section: kind === "section" ? section : null, ...(unsure.length === 0 ? {} : { unsure }) }, askId, resumed: resume !== undefined, ...(snap.fields.length === 0 ? {} : { askScope: scope }) };
  }
  // I6: the sources the fill reads, which may hold the tab the user just left, read now that a fill needs them.
  const sourceModel = o.fillModel === undefined ? model : await o.fillModel(w.window.windowId);
  let p: FillProposal;
  try {
    p = await proposeFill(sourceModel, askJev, w.window.windowId, checked.trigger, now, { about, scope: checked.scope, newId: () => o.offerKey, ...(o.rand === undefined ? {} : { rand: o.rand }), ...(o.fillTrace === undefined ? {} : { trace: o.fillTrace }), ...asked });
  } catch (e) {
    if (e instanceof FillError) return refused(new SaidError("nothingToDo", SAYS.nothingOnScreen, `the fill found nothing: ${e.message}`));
    return refused(e);
  }
  // A continued Ask fills only a form that still reads as the question saw it, field by field in the final scope, read
  // after the fill's last call to Jev.
  if (resume !== undefined) {
    try {
      const now = model.windows.get(w.window.windowId);
      if (now === undefined) throw new SaidError("unseenWindow", SAYS.windowClosed, `window ${w.window.windowId} closed while Caret planned`);
      checkSeen(resume, intentSnapshot(instruction, model, now, memory.values()), [...checked.fields, ...checked.leftToYou].map((f) => f.key));
    } catch (e) {
      return refused(e);
    }
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
    const left = withUnseen(withUnnamed(leftToYouSays(checked.leftToYou), w), w, checked.fields);
    // V4: a menu whose options Caret cannot see is named once, as the user's, not also as one with nothing found.
    const unseen = new Set(unseenOptions(w, checked.fields).map((f) => f.key));
    const empty = checked.fields.filter((f) => !unseen.has(f.key)).map((f) => f.name);
    const said = [empty.length === 0 ? null : saysNoValue(empty), left].filter((x): x is string => x !== null).join(" ");
    return refused(new SaidError("nothingToDo", said, `no value for ${checked.fields.map((f) => f.name).join(", ")} on screen, in memory or in the instruction${unseen.size === 0 ? "" : `; ${unseen.size} of them menus whose options the window does not show`}`));
  }

  const sel: WindowSel = { bundleId: w.app.bundleId, title: w.window.title, ...(w.window.number === undefined ? {} : { number: w.window.number }), ...(w.window.kind === PAGE_WINDOW_KIND ? { page: true as const, windowId: w.window.windowId } : {}) };
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
      ...(f.memory === null ? {} : { memory: memoryRefOf(f.memory, conversionOf(f.control)) }),
      // G2: a window's value that is exactly the user's identity is checked against its entry right before it is written.
      ...(identityRefOf(f, f.value as string) === null ? {} : { memory: identityRefOf(f, f.value as string) as string }),
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
  const ctx: PlanContext = { model: sourceModel, memory: memory.values(), instruction, origin: authority, documentOf };
  let checkedPlan: ReturnType<typeof validatePlan>;
  try {
    // W2: the write contract's mint fill made for each written field (fill.ts mintOf), by the step's slot.
    const mints = new Map(writes.flatMap((f, i) => {
      const m = mintOf(f);
      return m === undefined ? [] : [[`v${i + 1}`, m] as const];
    }));
    checkedPlan = validatePlan(plan, slots, ctx, mints);
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
    leftToYou: withUnseen(withUnnamed(leftToYouSays(checked.leftToYou), w), w, checked.fields),
    ...withUnsure(checked.fields.map((f) => f.key)),
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
  instruction = instructionForModel(instruction);
  const declared = snap.ledger.declared();
  return async (all, fields) => {
    const req = (wording: 0 | 1): JevRequest => {
      const questions: JevRequest["questions"] = {};
      if (all) questions.all = { type: "choice", instructions: CONFIRM_ALL[wording](instruction), criteria: { ...CONFIRM } };
      fields.forEach((f, i) => {
        questions[`f${i + 1}`] = { type: "choice", instructions: CONFIRM_FIELD[wording](instruction, f.modelName ?? f.name), criteria: { ...CONFIRM } };
      });
      const sent = JSON.stringify([instruction, questions]);
      return assertNoSecrets({ purpose: "ask.confirm", state: { instruction, task: "Caret checks which fields of the form the user's instruction asks it to fill." }, questions, snippets: declared.snippets.filter((x) => sent.includes(x.text)), charged: declared.charged });
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
