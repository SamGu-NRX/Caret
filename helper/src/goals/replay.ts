// Observe and replay (CU-COUNSEL-R2 D4, slice 2). A goal program that opens a list row calls observe() right after
// it, and the sandbox ends the run there as pending: nothing after the navigation is planned until the window shows
// the item. Once the user accepts and the navigation is verified, the goal reads the window into observation n and runs
// the same program again in a fresh worker on what it recorded: the gen-0 snapshots the writer saw, every observation
// so far, every choice Jev answered, and the steps already executed (the prefix). The program is deterministic (no
// clock, no randomness), so the replay registers the prefix again step for step; any difference ends the goal as
// diverged before any new chooser call. Only the steps after the prefix are lowered and shown. The writer is never
// called again: one writer call per goal.
//
// Everything here lives in memory for the goal's life and is never journaled, so a helper restart ends the goal and
// leaves the rest to the user.
import { compileProgram } from "../codemode/compile.ts";
import { jevChooser } from "../codemode/jev-chooser.ts";
import { DEFAULT_LIMITS } from "../codemode/limits.ts";
import { runProgramJs, type ChooserPort } from "../codemode/sandbox.ts";
import type { PendingObserve, PlanStep, PlanningSnapshot, RefusalKind } from "../codemode/types.ts";
import type { DocumentReader, ScopeSet } from "../fill/ask-scope.ts";
import type { AskJev } from "../fill/jev.ts";
import { ScreenModel, type WindowState } from "../model.ts";
import type { EventClock } from "../offers/event-time.ts";
import type { Disclosure } from "../privacy/disclosure.ts";
import { confirmClaims, DraftRefused } from "./drafts.ts";
import { redactWindow } from "../fill/redact.ts";
import { inListItem } from "./identity.ts";
import { basisText, buildInventory } from "./inventory.ts";
import { frozenBasis, GoalError, lowerGoal } from "./lower.ts";
import type { GoalInventory, GoalPlan, TargetBinding, ValueBinding } from "./plan.ts";

/** Observations one goal may take (CU-COUNSEL-R2 D4). Assumed: the two fixture tasks need one and two. */
export const MAX_OBSERVES = 3;
/** Jev choices one goal may make across its replays, recorded ones not counted (D4). Assumed. */
export const GOAL_NEW_CHOICES = 8;
/** Steps one goal may register across its replays, the prefix not counted (D4). Assumed: two passes of 24. */
export const GOAL_NEW_STEPS = 48;

/** What a replay is served from. `observations[i]` carries `g<i+1>:` refs on its window, targets, values and questions. */
export interface ReplayRecord {
  programDigest: string;
  /** The writer's TypeScript, compiled again for each replay. */
  source: string;
  gen0: PlanningSnapshot[];
  observations: PlanningSnapshot[];
  choices: { requestDigest: string; chosen: string | null }[];
  /** Executed steps, in registration order, each observe after its navigate. */
  prefix: PlanStep[];
  /** Where each run of the program ended: the step count at that point, and whether it ended at an observe. */
  segments: { end: number; by: "observe" | "window" }[];
}

/** A goal that observes, as its run keeps it. Never cloned or journaled. */
export interface ReplayState {
  record: ReplayRecord;
  /** The observe the last run stopped at, or null once a run reached plan(). */
  pending: PendingObserve | null;
  /** The steps the last run registered before its pending observe: the prefix once the observe is served. */
  pendingSteps: PlanStep[];
  /** The ledger that minted each generation's texts: gen 0's (the writer's), then each observation's. */
  ledgers: Disclosure[];
  /** Each observed window as it was read, by its observation id (observationId): what values copied from it are rechecked against. */
  retained: Map<string, WindowState>;
  /** New Jev choices and new steps across the goal so far, against GOAL_NEW_CHOICES and GOAL_NEW_STEPS. */
  used: { newChoices: number; newSteps: number };
  /** The model that wrote the program, recorded on each later draft's origin as on the first run's. */
  writerModel: string;
}

/** The window id a frozen observation is kept under: never a reader's window id, so nothing acts in it. */
export const observationId = (n: number, windowId: string): string => `obs${n}:${windowId}`;

const gen = (n: number) => (ref: string): string => `g${n}:${ref}`;

/** A snapshot with every ref the program may hold prefixed `g<n>:` (effects are capability names, never prefixed). */
export function prefixSnapshot(s: PlanningSnapshot, n: number): PlanningSnapshot {
  const p = gen(n);
  return {
    ...s,
    snapshot: p(s.snapshot),
    window: p(s.window),
    targets: s.targets.map((t) => ({ ...t, ref: p(t.ref), options: t.options.map(p) })),
    values: s.values.map((v) => ({ ...v, ref: p(v.ref), origin: v.origin.kind === "span" ? { ...v.origin, snapshot: p(v.origin.snapshot) } : v.origin })),
    questions: s.questions.map((q) => ({ ...q, ref: p(q.ref), options: q.options.map((o) => ({ ...o, ref: p(o.ref) })) })),
  };
}

/** The bindings behind a prefixed snapshot: each target, value and window ref renamed the same way. */
function prefixInventory(inv: GoalInventory, n: number): GoalInventory {
  const p = gen(n);
  const targets = new Map<string, TargetBinding>([...inv.targets].map(([k, b]) => [p(k), { ...b, ref: p(b.ref) }]));
  const values = new Map<string, ValueBinding>([...inv.values].map(([k, v]) => [p(k), { ...v, ref: p(v.ref), origin: v.origin.kind === "span" ? { ...v.origin, snapshot: p(v.origin.snapshot) } : v.origin }]));
  return { ...inv, targets, values, windowRefs: new Map([...inv.windowRefs].map(([k, id]) => [p(k), id])) };
}

/** Both inventories' bindings; for a window both froze, the later reading wins (revision, document, text, obligations). */
export function mergeInventory(base: GoalInventory, add: GoalInventory): GoalInventory {
  const join = <K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): Map<K, V> => new Map([...a, ...b]);
  const alternates = base.alternates === undefined && add.alternates === undefined ? undefined : { fields: join(base.alternates?.fields ?? new Map(), add.alternates?.fields ?? new Map()), saved: add.alternates?.saved ?? base.alternates?.saved ?? [] };
  const notes = base.notes === undefined && add.notes === undefined ? undefined : join(base.notes ?? new Map(), add.notes ?? new Map());
  return {
    readerSession: base.readerSession,
    targets: join(base.targets, add.targets),
    values: join(base.values, add.values),
    revisions: join(base.revisions, add.revisions),
    documents: join(base.documents, add.documents),
    windowRefs: join(base.windowRefs, add.windowRefs),
    texts: join(base.texts, add.texts),
    owed: join(base.owed, add.owed),
    ...(alternates === undefined ? {} : { alternates }),
    ...(notes === undefined ? {} : { notes }),
  };
}

/**
 * The screen as a goal's source checks read it: every window the model shows, plus each observation the goal froze,
 * under its observation id. A value read in an observation is checked against the item as it was read there, which the
 * window may no longer show once the user or Caret moved on (the native task reads Kayak's code, then opens Dana's
 * message to reply). Measured, for disclosure, as the live model it was made from (privacy.ts SnippetLedger).
 */
export function retainedView(model: ScreenModel, retained: ReadonlyMap<string, WindowState>): ScreenModel {
  if (retained.size === 0) return model;
  const v = new ScreenModel();
  v.live = model.live ?? model;
  for (const [id, w] of model.windows) v.windows.set(id, w);
  for (const [id, w] of retained) v.windows.set(id, w);
  v.focusedWindowId = model.focusedWindowId;
  v.frontmostPid = model.frontmostPid;
  return v;
}

export interface ObserveOptions {
  instruction: string;
  clock: EventClock;
  now: number;
  readerSession: number;
  pageDocument?: (windowId: string) => string | null;
}

export interface Observation {
  /** What observe() hands the program, refs prefixed. */
  snapshot: PlanningSnapshot;
  /** The bindings behind it, refs prefixed. */
  inventory: GoalInventory;
  /** The ledger that minted the targets and questions: what a choose() over this observation is sent through. */
  ledger: Disclosure;
  /** The ledger that minted the values: what the value checks and draft claims of the steps after it are sent through. */
  valuesLedger: Disclosure;
  /** The window as read, under its observation id. */
  frozen: [string, WindowState];
}

/** A view of the screen holding `windows` only, measured, for disclosure, as the live model it was made from. */
function viewOf(model: ScreenModel, windows: readonly WindowState[]): ScreenModel {
  const v = new ScreenModel();
  v.live = model.live ?? model;
  for (const w of windows) v.windows.set(w.window.windowId, w);
  v.focusedWindowId = model.focusedWindowId;
  v.frontmostPid = model.frontmostPid;
  return v;
}

/**
 * Observation `n` of window `windowId`, as the model shows it now. Its targets and questions are the live window's (the
 * fields and rows a later step acts in). Its values are read from a frozen copy kept under observationId(n, windowId), so
 * candidates code finds in the item (a confirmation code) are listed as values of that copy, as another window's would
 * be, and the snapshot's window ref names the copy: a draft drawing on it is checked against the item as it was read.
 * Instruction and memory values are gen 0's and are not repeated.
 *
 * The copy holds the item, not the list: it is the window as redaction leaves it (fill/redact.ts), in the window's own
 * order, less the list's rows. Redacting first matters: the redactor reads neighbouring nodes ("Verification" above
 * "code: 4471"), so dropping or moving a node before it could make a withheld code read as an ordinary value. Values
 * are still cut to the copy's share of what one request may disclose (a mail item is a conversation: under half of it),
 * in the item's own order.
 *
 * Targets and values go through two ledgers because they leave in different requests: a choose() carries the rows of a
 * list question, a value check or draft claim carries values. In one ledger the copy, itself a conversation of which a
 * request may reveal under half, was charged for every row cell its Subject line repeats, and the rows Dana's reply
 * needed were cut after the values. Each request is still held to its window's limit at its seal.
 */
export function observe(model: ScreenModel, windowId: string, n: number, o: ObserveOptions): Observation {
  const live = model.windows.get(windowId);
  if (live === undefined) throw new GoalError("nothingToDo", "the window closed before Caret could read what it shows", windowId);
  const qid = observationId(n, windowId);
  const seen = redactWindow(live);
  const item = new Map([...seen.nodes].filter(([, n]) => !inListItem(seen, n)));
  const frozen: WindowState = { ...seen, window: { ...seen.window, windowId: qid }, nodes: item, values: seen.values.filter((v) => item.has(v.nodeKey)) };
  const base = { instruction: o.instruction, windows: [windowId], memory: [], calendar: null, clock: o.clock, now: o.now, readerSession: o.readerSession, ...(o.pageDocument === undefined ? {} : { pageDocument: o.pageDocument }) };
  const acted = buildInventory(viewOf(model, [live]), base);
  const read = buildInventory(viewOf(model, [live, frozen]), base);
  const own = acted.snapshots[0];
  if (own === undefined) throw new GoalError("nothingToDo", "Caret could not read the window after the navigation", windowId);
  // The copy's snapshot in the values inventory; its window ref is the observation's, so a draft's basis is the copy.
  const copyRef = [...read.inventory.windowRefs].find(([, id]) => id === qid)?.[0];
  const copy = copyRef === undefined ? undefined : read.snapshots.find((x) => x.window === copyRef);
  const windowRef = copyRef ?? own.window;
  const snapshot: PlanningSnapshot = { snapshot: own.snapshot, window: windowRef, revision: own.revision, title: own.title, targets: own.targets, values: copy?.values ?? [], questions: own.questions };
  const values = new Map([...read.inventory.values].filter(([, v]) => v.source?.windowId === qid));
  const texts = new Map(acted.inventory.texts);
  texts.set(qid, basisText(frozen));
  const trimmed: GoalInventory = { ...acted.inventory, values, windowRefs: new Map([[windowRef, qid]]), texts, ...(read.inventory.notes === undefined ? {} : { notes: new Map([...read.inventory.notes].filter(([ref]) => values.has(ref))) }) };
  return { snapshot: prefixSnapshot(snapshot, n), inventory: prefixInventory(trimmed, n), ledger: acted.ledger, valuesLedger: read.ledger, frozen: [qid, frozen] };
}

/** choose() for a replay: Jev through the ledger that minted the question's generation (gen 0's, or observation n's). */
export function replayChooser(askJev: AskJev | null, instruction: string, ledgers: readonly Disclosure[]): ChooserPort {
  if (askJev === null) return async () => null;
  return async (req) => {
    const m = /^g(\d+):/u.exec(req.question.ref);
    const ledger = ledgers[m === null ? 0 : Number(m[1])];
    return ledger === undefined ? null : jevChooser(askJev, instruction, ledger)(req);
  };
}

export interface ContinueOptions {
  goalId: string;
  instruction: string;
  state: ReplayState;
  /** The window the verified navigation changed. */
  windowId: string;
  /**
   * Whether the window still shows what the navigation was verified to show (its end state, as the executor checked it).
   * Asked right before the window is read into the observation, in the same turn, so an item the user switched away from
   * after the check is never what the steps after it read (review of 49901539: Dana's old booking, and its code).
   */
  stillShows: (w: WindowState) => boolean;
  /** The goal's inventory so far (gen 0 and every observation before this one). */
  inventory: GoalInventory;
  askJev: AskJev | null;
  clock: EventClock;
  now: number;
  readerSession: number;
  pageDocument?: (windowId: string) => string | null;
  scopes?: ScopeSet;
  documentOf?: DocumentReader | null;
  signal?: AbortSignal;
}

export type ContinueResult =
  /** `plan`: the steps after the prefix, lowered; null when the program registered none. */
  | { ok: true; plan: GoalPlan | null; inventory: GoalInventory }
  | { ok: false; kind: RefusalKind | "goal"; says: string; detail: string };

/**
 * One replay: observe the window, run the program again on its record, and lower the steps after the prefix against the
 * goal's inventory with this observation's bindings added. `o.state` is updated in place (the observation, the prefix,
 * the choices, the pending observe and the counts), whatever the outcome: a refused replay ends the goal.
 */
export async function continueGoal(model: ScreenModel, o: ContinueOptions): Promise<ContinueResult> {
  const state = o.state;
  const pending = state.pending;
  if (pending === null) return { ok: false, kind: "goal", says: "Caret has nothing left to read for this goal", detail: "no pending observe" };
  const n = state.record.observations.length + 1;
  const now = model.windows.get(o.windowId);
  if (now === undefined || !o.stillShows(now)) return { ok: false, kind: "goal", says: "the window no longer showed the item Caret opened when Caret went to read it", detail: o.windowId };
  let obs: Observation;
  try {
    obs = observe(model, o.windowId, n, { instruction: o.instruction, clock: o.clock, now: o.now, readerSession: o.readerSession, ...(o.pageDocument === undefined ? {} : { pageDocument: o.pageDocument }) });
  } catch (e) {
    if (e instanceof GoalError) return { ok: false, kind: "goal", says: e.says, detail: e.message };
    return { ok: false, kind: "goal", says: "Caret could not read the window after the navigation", detail: e instanceof Error ? e.message : String(e) };
  }
  const record = state.record;
  record.observations.push(obs.snapshot);
  record.prefix = [...state.pendingSteps, { ref: pending.ref, kind: "observe", after: pending.after }];
  record.segments.push({ end: record.prefix.length, by: "observe" });
  state.ledgers.push(obs.ledger);
  state.retained.set(...obs.frozen);
  state.pending = null;
  state.pendingSteps = [];
  const inventory = mergeInventory(o.inventory, obs.inventory);

  const compiled = compileProgram(record.source, DEFAULT_LIMITS.sourceBytes);
  if (!compiled.ok || compiled.digest !== record.programDigest) return { ok: false, kind: "source", says: "Caret could not run the plan again", detail: compiled.ok ? "the program's digest changed" : compiled.detail };
  const ran = await runProgramJs(compiled.js, compiled.digest, record.gen0, replayChooser(o.askJev, o.instruction, state.ledgers), {
    multiWindow: true,
    drafts: true,
    navigation: true,
    replay: { observations: record.observations, choices: record.choices, prefix: record.prefix, mayObserve: record.observations.length < MAX_OBSERVES },
    limits: { chooseCalls: Math.max(0, Math.min(DEFAULT_LIMITS.chooseCalls, GOAL_NEW_CHOICES - state.used.newChoices)), steps: Math.max(0, Math.min(DEFAULT_LIMITS.steps, GOAL_NEW_STEPS - state.used.newSteps)) },
    ...(o.signal === undefined ? {} : { signal: o.signal }),
  });
  if (!ran.ok) {
    const says = ran.kind === "observeBudget" ? `Caret reads at most ${MAX_OBSERVES} views for one goal` : ran.kind === "diverged" ? "the plan ran differently the second time" : "the plan broke the rules a plan must keep";
    return { ok: false, kind: ran.kind, says, detail: ran.detail };
  }
  state.used.newChoices += ran.stats.chooseCalls;
  state.used.newSteps += ran.stats.steps;
  record.choices = ran.plan.choices.map((c) => ({ requestDigest: c.requestDigest, chosen: c.chosen }));
  state.pending = ran.pending;
  state.pendingSteps = ran.pending === null ? [] : ran.plan.steps;
  if (ran.pending === null) record.segments.push({ end: ran.plan.steps.length, by: "window" });
  const fresh = ran.plan.steps.slice(record.prefix.length);
  if (fresh.length === 0) return { ok: true, plan: null, inventory };
  try {
    // Lowered with this observation's values ledger: its registry is the window now plus the item as read (observe).
    const plan = await lowerGoal(o.goalId, o.instruction, { ...ran.plan, steps: fresh }, inventory, { askJev: o.askJev, ledger: obs.valuesLedger, writerModel: state.writerModel, ...(o.scopes === undefined ? {} : { scopes: o.scopes, documentOf: o.documentOf ?? null }) });
    const drafts = plan.segments.flatMap((g) => g.steps.flatMap((x) => (x.value?.draft == null ? [] : [{ text: x.value.text, basis: frozenBasis(o.instruction, x.value, inventory) }])));
    await confirmClaims(o.instruction, drafts, o.askJev, obs.valuesLedger.declared().snippets, retainedView(model, state.retained));
    return { ok: true, plan, inventory };
  } catch (e) {
    if (e instanceof GoalError) return { ok: false, kind: "goal", says: e.says, detail: e.message };
    if (e instanceof DraftRefused) return { ok: false, kind: "goal", says: e.says, detail: `${e.why}: ${e.word ?? ""}` };
    throw e;
  }
}
