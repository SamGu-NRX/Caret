// Accepted goal plans, run one segment at a time (D2-06, plan section 5 "Validation and resume").
//
// A goal is offered one segment at a time. A segment runs only after a goalAccept that names its goal, its index and
// its digest, from the connection the goal was offered to, before the preview expires, and only once: a second
// acceptance of a segment that ran or is running is refused and nothing is dispatched again. Right before a segment
// runs, code checks that what the plan was built from still holds: the reader session, each target's window, node,
// role and label, a page's document, and each value's source. Then the segment is one executor task under one forward
// grant for its one window (or the calendar grant).
//
// After each step the executor has re-read the window; the run keeps a receipt with the window's revision before (as
// planned) and after, in a cursor that holds the program hash, the plan digest, the next step, the source revisions,
// the receipts and the target bindings. Moving to the next segment uses the cursor: the program never runs again,
// and a step with a receipt is never dispatched again. A step whose end state already holds (a field already holding
// its value) is skipped by the executor's own check, never written twice.
//
// A dialog in the segment's app, a reload, a source that changed, a step whose effect did not show in time, or an
// effect other than the predicted one revokes the task's grant and stops the goal. When a replanner is configured, the
// goal is then offered again as a fresh plan built from the screen as it is now; it needs its own acceptance. Nothing
// here persists: a helper that crashes leaves the executor's journal row (B23), and no goal resumes on its own.
import type { Change, ScreenModel } from "../model.ts";
import type { Executor, Revocation, TaskResult } from "../executor/executor.ts";
import { nodeText } from "../model.ts";
import { PROTOCOL_VERSION, type GoalAccept, type GoalEdit, type GoalProgress, type GoalStopReason, type StopReason, type TaskProgress } from "../protocol.ts";
import { basisText, windowRevision } from "./inventory.ts";
import { checkDraftText, DraftRefused, senderOf } from "./drafts.ts";
import { isDerived } from "./gates.ts";
import { memoryWrites, parseMemoryRef } from "../fill/fill.ts";
import { identityKey } from "../fill/whose.ts";
import { continuationScope, pageInputKeys } from "./page-planner.ts";
import { pageView } from "./page-view.ts";
import { describeField } from "../fill/descriptor.ts";
import { formControls } from "../fill/controls.ts";
import { fieldName } from "../planner/planner.ts";
import type { WindowState } from "../model.ts";
import { owedFields } from "./left.ts";
import { executable, goalDigest, segmentDigest, sha256, type GoalPlan, type GoalSegment, type GoalStep, type LeftItem, type PageGoal, type ValueBinding } from "./plan.ts";
import { effectKey, proposedFor, segmentOf, type DonePress } from "./lower.ts";
import { contractStale, ContractError, guardFor, mintExempt, provenanceStale, requireChecked, type CheckedValue } from "../fill/contract.ts";
import { codeGate } from "./gates.ts";

/** How long a segment's preview may wait for its acceptance: the act grant's own limit (protocol.ts GRANT_MAX_MS). */
export const ACCEPT_MS = 120_000;

/**
 * How long a finished page goal whose scope was the whole form or a section waits for the user's own Next (P3, memo
 * "Authority contract"): a new document in its tab within this long gets a fresh preview of that page under the same
 * instruction and scope. Assumed, not measured: the memo's number, as long as a preview waits for its Tab.
 */
export const CARRY_MS = 120_000;

export interface StepReceipt {
  goalId: string;
  segment: number;
  step: number;
  stepRef: string;
  status: "verified" | "alreadyTrue" | "handoff";
  /** What the step acted on, and the effect a press had: a fresh plan may not press the same control for it again. */
  target: { windowId: string | null; key: string };
  effect: string | null;
  /** The window's revision when the plan was frozen, and right after the step (the executor's fresh read). */
  before: string;
  after: string;
  at: number;
  /**
   * P1: from the executor's "acting" on the step to its receipt, in ms by the runs' clock: the write and its read-back
   * through the app or the page engine. Null for a step that never acted (already so, or a hand-off).
   */
  ms: number | null;
}

export interface GoalCursor {
  programHash: string;
  planDigest: string;
  /** The segment that runs next or is running. */
  segment: number;
  /** The first step of the goal without a receipt. */
  nextStep: number;
  sourceRevisions: Record<string, string>;
  receipts: StepReceipt[];
  bindings: Record<string, { windowId: string | null; key: string; role: string; label: string }>;
}

type State = "awaiting" | "running" | "finished" | "stopped";

interface Run {
  /** W2: each write step's write-contract mint, by `${segment}:${ref}` (GoalRuns.propose; edit replaces one). */
  mints: Map<string, CheckedValue>;
  plan: GoalPlan;
  /** The host session it was offered to; acceptances from any other are refused. Undefined in process. */
  session: string | undefined;
  requestId: string | null;
  replaces: string | null;
  /** Steps of an earlier goal this one was replanned from, verified there. */
  carried: StepReceipt[];
  /**
   * Every press a segment of this goal (or one it replaces) dispatched, verified or not: one whose effect did not show
   * may still have landed, so a fresh plan may not make it again (re-check: a Next that timed out was pressed twice).
   */
  pressed: DonePress[];
  /**
   * What the goal must account for before it can be done (G2), checked again when it ends (leftNow): its plan's left
   * items; every field its windows' kind requires as frozen, filled or not, so a window that closes cannot erase one;
   * and, from every goal it replaces, the same plus each write that goal planned and never made.
   */
  owed: LeftItem[];
  cursor: GoalCursor;
  state: State;
  expires: number;
  /** Segments accepted, each at most once. */
  accepted: Set<number>;
  /** The segment's executor task while it runs, with the windows its app (by process or bundle id) showed when it started. */
  task: { id: string; segment: number; pid: number | null; bundleId: string | null; windows: Set<string> } | null;
  /** Why code revoked the running task, when it did: the stop is reported as this, not as the executor's wording. */
  cause: { reason: GoalStopReason; says: string } | null;
  /** The reason the first segment was previewed with when it was not its own (a fresh plan's), so an edit's preview keeps it. */
  firstReason: "afterReveal" | "freshPlan" | null;
  /** When the executor first said it was acting on each step, by the step's index in the goal (P1: StepReceipt.ms). */
  acting: Map<number, number>;
  /**
   * P3: for the running segment, the position in its `steps` of each step the executor task runs, by the task's own
   * step index. The task runs the segment's plan less the attach steps the acceptance gave no file.
   */
  stepMap: number[];
  /** P3: the file the acceptance confirmed, for the attach step at this index in the goal. */
  confirmed: { step: number; path: string } | null;
}

/**
 * P3: a finished page goal waiting for the user's own Next (CARRY_MS). It keeps what the memo's carry keeps and nothing
 * else: the instruction, the scope kind and section with its sources and person (no field of the old page and no value
 * the instruction tied to one), the host session, what the goal and those before it did (receipts) and left (owed),
 * with every key qualified by the old document so no field of the new page can match one. Never a value.
 */
interface Carry {
  goalId: string;
  instruction: string;
  page: PageGoal;
  document: string;
  session: string | undefined;
  completed: StepReceipt[];
  owed: LeftItem[];
  until: number;
}

export interface Replan {
  goalId: string;
  instruction: string;
  /** What the stopped goal already did, verified. */
  completed: readonly StepReceipt[];
  /** Every press it dispatched, verified or not: the fresh plan may make none of them again. */
  pressed: readonly DonePress[];
  /** Writes the stopped goal meant (dropped, or planned and never made): the fresh plan's preview names those it leaves. */
  owed: readonly LeftItem[];
  /** Why a fresh plan is asked for: the stop, or (P3) `nextPage` when the user's own Next carried the goal to a new document. */
  why: GoalStopReason | "nextPage";
  /** P3: the host session the goal was offered to: what its previews may show (an attach row needs GOAL_FILES_CAPABILITY). */
  session: string | undefined;
  /**
   * P2: a page goal's continuation context (GoalPlan.page), so the replanner plans the page again (page-planner.ts)
   * rather than asking a writer; `revealed` names the controls a finished page goal's writes showed, which are then the
   * fresh plan's only fields.
   */
  page?: PageGoal & { revealed?: readonly string[] };
}

export interface GoalRunDeps {
  executor: Executor;
  model: ScreenModel;
  publish: (m: GoalProgress) => void;
  now: () => number;
  readerSession: () => number;
  /** Binds a new task to the host session that accepted it (Helper.bindNew), so that session leaving revokes it. */
  bind: (taskId: string, session: string | undefined) => void;
  /** Whether memory entry `ref` still gives `value` (Step.memory). */
  memoryHolds: (ref: string, value: string) => boolean;
  /** A page window's document generation now; null for a native window or one whose engine is gone. */
  pageDocument?: (windowId: string) => string | null;
  /** Builds a fresh plan for what remains, from the screen as it is now; null when none can be offered. */
  replan?: (r: Replan) => Promise<GoalPlan | null>;
  /**
   * P2: reads a page window again (the executor's walk verb). A page goal's last write is no longer followed by a walk
   * (engines/page-link.ts act), so the goal reads the page once before it ends, to see what its writes revealed.
   */
  walk?: (windowId: string) => Promise<void>;
  /**
   * P2: an About entry as a fill may use it now (helper.ts aboutNow), or null when it is gone, paused or not typed. A
   * page goal's value from memory must still be that entry's under the same label before it runs, as a Fill all's is.
   */
  aboutNow?: (id: string) => { value: string; label: string } | null;
  /**
   * P3: binds the file the user confirmed in a preview to one attach step's field for one task (engines/attach.ts
   * ConfirmedFiles.confirm), reading it once now. Without it no acceptance may name a file.
   */
  confirmFile?: (taskId: string, path: string, windowId: string, key: string) => { ok: true } | { refused: string };
  /** P3: drops a task's confirmation (a precheck that failed after it was made). */
  forgetFile?: (taskId: string) => void;
  /** P3: an attach step verified with the file the user confirmed: the helper may offer to keep it for this question. */
  onAttached?: (a: { goalId: string; session: string | undefined; path: string; windowId: string; key: string; label: string }) => void;
  /**
   * I6: the model a goal's sources are checked against (at acceptance and while its segment runs): the model with the
   * text of the tab the user left while this goal holds it (helper.ts fillModel, engines/tab-source.ts), else the model.
   * Only source checks read it; targets, documents and fields are always the model's own.
   */
  sourceModel?: (goalId: string) => ScreenModel;
  /** I6: a goal ended (finished or stopped), or a plan made for it was never offered: what it held for its plan goes. */
  ended?: (goalId: string) => void;
}

const SAYS: Record<GoalStopReason, string> = {
  refused: "Caret will not offer this plan",
  dialog: "a dialog opened",
  reload: "the page reloaded",
  sourceChanged: "what Caret was copying from changed",
  targetChanged: "a field changed before Caret reached it",
  timeout: "a step's effect did not show in time",
  unexpectedEffect: "something other than what Caret expected changed",
  handedOff: "Caret could not do a step and left it to you",
  revealed: "the last press showed more fields than this plan covers",
  windowGone: "the window closed",
  you: "you stopped it",
  readerRestarted: "the screen reader restarted",
  hostGone: "the app that showed the plan disconnected",
  expired: "the plan was not accepted in time",
  error: "something went wrong",
};

/** Stops after which a fresh plan from the screen as it is now may be offered. */
const REPLANNABLE: ReadonlySet<GoalStopReason> = new Set(["revealed", "dialog", "reload", "sourceChanged", "targetChanged", "timeout", "unexpectedEffect", "windowGone"]);

export class GoalRuns {
  private readonly runs = new Map<string, Run>();
  /** Executor task id to its goal, while the task runs. */
  private readonly tasks = new Map<string, string>();
  /** Every task id a goal ever ran: none of them is resumed or run by any other path (owns). */
  private readonly ever = new Set<string>();
  private replans = 0;
  /** P3: host sessions that left (hostGone): a fresh plan that finishes planning after its host left is not offered. Never reused. */
  private readonly goneHosts = new Set<string>();
  /** P3: finished page goals waiting for the user's Next, by page window id (one per window: the latest finished). */
  private readonly carries = new Map<string, Carry>();
  /** P3: the document of each page window a carry is planning or planned for, so the ambient offer stays out of its way. */
  private readonly carried = new Map<string, string>();
  /** Stops and fresh plans under way (each may wait on the writer): idle() waits for them. */
  private readonly pending = new Set<Promise<unknown>>();
  private readonly deps: GoalRunDeps;

  constructor(deps: GoalRunDeps) {
    this.deps = deps;
  }

  /** Resolves once no stop or fresh plan is under way, for tests and evaluations. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private track(p: Promise<unknown>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** Whether a goal ran this task: a generic resume of it is refused (Helper.handleTask), since only an acceptance runs a goal's steps. */
  owns(taskId: string): boolean {
    return this.ever.has(taskId);
  }

  get(goalId: string): { state: State; cursor: GoalCursor } | null {
    const r = this.runs.get(goalId);
    return r === undefined ? null : { state: r.state, cursor: structuredClone(r.cursor) };
  }

  /** A copy of the plan a goal was offered with, for evaluations (P2's disagreement report); a copy is never offered. */
  planOf(goalId: string): GoalPlan | null {
    const r = this.runs.get(goalId);
    return r === undefined ? null : structuredClone(r.plan);
  }

  /** Offers a goal's first segment for acceptance, as the reply to `requestId` (or as a fresh plan replacing another). */
  propose(given: GoalPlan, session: string | undefined, requestId: string | null, replaces: { goalId: string; carried: StepReceipt[]; pressed: DonePress[]; owed: LeftItem[] } | null = null): GoalProgress {
    if (this.runs.has(given.goalId)) throw new Error(`goal ${given.goalId} already exists`);
    // I6: a hand-off row is a page plan's, and the goal's very last step, after its attach rows: it is never run, and the
    // executor plan stops before it (lower.ts executorPlan).
    const all = given.segments.flatMap((s) => s.steps);
    const misplacedRow = all.find((s, i) => s.row === true && (i !== all.length - 1 || s.kind !== "handoff" || given.page === undefined || s.target.domain.kind !== "window" || !s.target.domain.page));
    if (misplacedRow !== undefined) throw new Error(`goal ${given.goalId}: step ${misplacedRow.ref} is not a hand-off row a page plan may offer`);
    // Only lowering's gates (G2, gates.ts) mark a write: a plan built any other way is a bug, never offered.
    // A "derived" step skipped Jev, so it must be the very object lowering marked (gates.ts isDerived), not a copy.
    // A "fill" step (P2) carries fill's own mint for its target, which the write contract check below requires (W2).
    const unchecked = given.segments.flatMap((s) => s.steps).find((s) => (s.kind === "write" || s.kind === "calendar") && (s.gate === null || (s.gate === "derived" && !isDerived(s)) || (s.gate === "fill" && s.checked?.verdict.by !== "verifier" && s.checked?.verdict.by !== "exempt")));
    if (unchecked !== undefined) throw new Error(`goal ${given.goalId}: step ${unchecked.ref} writes '${unchecked.target.label}' without passing the value gates`);
    // W2: every write carries the write contract's mint for exactly what it writes, in exactly its target
    // (fill/contract.ts); checked here, on the very objects lowering built, before the run keeps its own copy.
    // The mints themselves, kept by segment and ref: the run's own copy below is a structuredClone, which carries none,
    // so acceptance and the executor's guard read these (W2 review: what runs is checked against the very mint).
    const mints = new Map<string, CheckedValue>();
    for (const seg of given.segments) for (const s of seg.steps) if (s.kind === "write" && s.row !== true) mints.set(`${seg.index}:${s.ref}`, requireChecked(s.checked, s.writes ?? "", s.target.key, s.target.domain.kind === "window" ? s.target.domain.windowId : "", `goal ${given.goalId}: step ${s.ref}`));
    // P3: an attach step is a page plan's, into a page's file control, with the file its row offers, after every other
    // step of its segment (runs drop the ones the acceptance gives no file, which must hold up nothing after them).
    for (const seg of given.segments) {
      const acts = seg.steps.filter((s) => s.row !== true);
      const first = acts.findIndex((s) => s.kind === "attach");
      if (first < 0) continue;
      const bad = acts.find((s, i) => (s.kind === "attach") !== (i >= first) || (s.kind === "attach" && (s.file === undefined || s.target.control !== "file" || given.page === undefined || s.target.domain.kind !== "window" || !s.target.domain.page)));
      if (bad !== undefined) throw new Error(`goal ${given.goalId}: step ${bad.ref} is not an attach a page plan may offer`);
    }
    // The run owns its own frozen copy: what is shown is what runs, whatever the caller does with its object later.
    const plan = structuredClone(given);
    for (const seg of plan.segments) deepFreeze(seg);
    const bindings: GoalCursor["bindings"] = {};
    for (const t of plan.inventory.targets.values()) bindings[t.ref] = { windowId: t.domain.kind === "window" ? t.domain.windowId : null, key: t.key, role: t.role, label: t.label };
    const run: Run = {
      plan,
      session,
      requestId,
      replaces: replaces?.goalId ?? null,
      carried: replaces?.carried ?? [],
      pressed: replaces?.pressed ?? [],
      owed: obligations(plan, replaces?.owed ?? []),
      cursor: { programHash: plan.programHash, planDigest: plan.digest, segment: 0, nextStep: 0, sourceRevisions: Object.fromEntries(plan.inventory.revisions), receipts: [], bindings },
      state: "awaiting",
      expires: this.deps.now() + ACCEPT_MS,
      accepted: new Set(),
      task: null,
      cause: null,
      firstReason: replaces === null ? null : "freshPlan",
      acting: new Map(),
      stepMap: [],
      confirmed: null,
      mints,
    };
    this.runs.set(plan.goalId, run);
    return this.segmentMessage(run, replaces === null ? undefined : "freshPlan");
  }

  /** A goal code refused before anything was offered, as the reply to its request. */
  refused(goalId: string, requestId: string, says: string): GoalProgress {
    return { type: "goalProgress", v: PROTOCOL_VERSION, at: this.deps.now(), goalId, requestId, event: "stopped", segment: null, step: null, reason: "refused", says, freshPlan: null };
  }

  /**
   * The user's acceptance of one segment. Refused (with why, and nothing dispatched) unless it names the segment the
   * goal is waiting on, with that segment's digest, from the connection the goal was offered to, in time, and once.
   */
  async accept(m: GoalAccept, session: string | undefined): Promise<{ refused: string } | { result: TaskResult }> {
    const run = this.runs.get(m.goalId);
    if (run === undefined) return { refused: `no goal ${m.goalId}` };
    if (run.session !== undefined && run.session !== session) return { refused: `goal ${m.goalId} was offered to another connection; nothing runs` };
    if (run.accepted.has(m.segment)) return { refused: `segment ${m.segment + 1} of goal ${m.goalId} was already accepted; nothing runs twice` };
    if (run.state !== "awaiting") return { refused: `goal ${m.goalId} is ${run.state}, not waiting for an acceptance` };
    if (m.segment !== run.cursor.segment) return { refused: `goal ${m.goalId} waits for segment ${run.cursor.segment + 1}, not ${m.segment + 1}` };
    const seg = run.plan.segments[m.segment] as GoalSegment;
    if (m.digest !== seg.digest) return { refused: `the acceptance names another plan than the one shown for segment ${m.segment + 1}; nothing runs` };
    // What is about to run must still be what that digest covers: its steps, and the executor plan and slots made from them.
    if (segmentDigest(run.plan.programHash, seg, run.plan.warnings, executable(seg)) !== seg.digest) return { refused: `segment ${m.segment + 1} of goal ${m.goalId} no longer matches its digest; nothing runs` };
    if (this.deps.now() > run.expires) {
      this.stop(run, "expired", null, `${SAYS.expired}; nothing was done for it`);
      return { refused: `segment ${m.segment + 1} of goal ${m.goalId} expired before it was accepted` };
    }
    const taskId = segmentTaskId(run.plan.goalId, seg.index);
    // P3: the file the user confirmed in this preview, for one of its attach rows. Checked and read before the segment
    // counts as accepted: a file Caret refuses (a link, not a regular file, too large) leaves the preview waiting, so the
    // user can choose another. Attach rows given no file are dropped from the run below and left to the user.
    const cf = m.confirmedFile;
    const attachStep = cf === undefined ? undefined : seg.steps.find((s) => s.index === cf.step);
    // A segment of attach rows alone runs nothing without a file: the preview waits for one (P3 review).
    if (cf === undefined && seg.steps.every((s) => s.kind === "attach" || s.row === true)) return { refused: "this preview only attaches files: choose one, then accept again; nothing ran" };
    if (cf !== undefined) {
      if (attachStep === undefined || attachStep.kind !== "attach" || attachStep.target.domain.kind !== "window") return { refused: `step ${cf.step + 1} of segment ${m.segment + 1} is not an attach step; nothing runs` };
      if (this.deps.confirmFile === undefined) return { refused: "this helper attaches no files; nothing runs" };
      const r = this.deps.confirmFile(taskId, cf.path, attachStep.target.domain.windowId, attachStep.target.key);
      if ("refused" in r) return { refused: `Caret can't attach the file you chose (${r.refused}); nothing ran, so choose another and accept again` };
    }
    run.accepted.add(m.segment);
    const why = this.precheck(run, seg);
    if (why !== null) {
      this.deps.forgetFile?.(taskId);
      await this.stopAndReplan(run, why.reason, seg.steps[0]?.index ?? null, why.says);
      return { refused: why.says };
    }
    const w = seg.domain.kind === "window" ? this.deps.model.windows.get(seg.domain.windowId) : undefined;
    const pid = w?.app.pid ?? null;
    const bundleId = w?.app.bundleId ?? null;
    const sameApp = (x: { app: { pid: number; bundleId: string } }): boolean => (pid !== null && x.app.pid === pid) || (bundleId !== null && x.app.bundleId === bundleId);
    run.task = { id: taskId, segment: seg.index, pid, bundleId, windows: new Set([...this.deps.model.windows.values()].filter(sameApp).map((x) => x.window.windowId)) };
    run.state = "running";
    run.cause = null;
    // What runs: the previewed plan, less each attach row the acceptance gave no file (a subset of what the digest
    // covers, never anything it does not).
    // I6: a hand-off row never runs (the executor plan has no step for it).
    const keep = seg.steps.map((s) => s.row !== true && (s.kind !== "attach" || s.index === attachStep?.index));
    run.stepMap = seg.steps.flatMap((_, i) => (keep[i] === true ? [i] : []));
    run.confirmed = cf === undefined || attachStep === undefined ? null : { step: attachStep.index, path: cf.path };
    const plan = { ...seg.plan, steps: seg.plan.steps.filter((_, i) => keep[i] === true) };
    // W2 review: every write the executor will make, as its slots resolve, must be the very mint checked for its step's
    // text and target; then the executor rechecks each one's source right before its dispatch (guard).
    const runMints = new Map<number, CheckedValue>();
    for (const [j, i] of run.stepMap.entries()) {
      const s = seg.steps[i] as GoalStep;
      const end = plan.steps[j]?.end;
      if (s.kind !== "write" || end?.kind !== "valueEquals") continue;
      const resolved = end.value.replace(/\{\{(\w+)\}\}/gu, (_, k: string) => seg.slots[k] ?? "");
      const key = end.target.key === undefined ? "" : end.target.key.replace(/\{\{(\w+)\}\}/gu, (_, k: string) => seg.slots[k] ?? "");
      try {
        runMints.set(j, requireChecked(run.mints.get(`${seg.index}:${s.ref}`), resolved, key, seg.domain.kind === "window" ? seg.domain.windowId : "", `step ${s.ref}`));
      } catch (e) {
        if (!(e instanceof ContractError)) throw e;
        // Nothing was dispatched: refused as the executor's own refusal of a plan is.
        const says = `${SAYS.error}: ${e.message.slice(0, 200)}`;
        this.endTask(run);
        this.stop(run, "error", null, says);
        return { refused: says };
      }
    }
    this.tasks.set(taskId, run.plan.goalId);
    this.ever.add(taskId);
    this.deps.bind(taskId, session);
    // What the precheck just read is what the task's first walk must still find: a field typed into in between stops it.
    const expect: Record<string, Record<string, string>> = {};
    if (w !== undefined) expect[w.window.windowId] = Object.fromEntries(seg.steps.filter((s) => s.kind === "write").map((s) => [s.target.key, w.nodes.get(s.target.key)?.value ?? ""]));
    try {
      // C1: a pick the page put back and the executor read back as it was is listed as the user's (leftNow), and the
      // segment's other steps still run.
      return { result: await this.deps.executor.run(taskId, plan, seg.slots, expect, { grant: true, leaveFailedToYou: true, guard: guardFor(() => this.sourcesOf(run), runMints) }) };
    } catch (e) {
      // The executor refused the plan before its first step (PlanError): nothing was dispatched.
      const says = `${SAYS.error}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
      this.endTask(run);
      this.stop(run, "error", null, says);
      return { refused: says };
    }
  }

  /**
   * H9: the user's own words in place of the text Caret drafted for one step of the segment waiting for acceptance. The
   * same checks as an acceptance (this goal, this connection, the segment waiting, its digest, unchanged, in time), and
   * the step must be a drafted write. The words pass the draft's field and never-typed checks (gates.ts codeGate) and no
   * fact check: they are the user's. The segment is lowered again with them (lower.ts segmentOf) under a new digest and
   * previewed again; nothing runs, and an acceptance of the old digest is refused from now on.
   */
  edit(m: GoalEdit, session: string | undefined): { refused: string } | { preview: GoalProgress } {
    const run = this.runs.get(m.goalId);
    if (run === undefined) return { refused: `no goal ${m.goalId}` };
    if (run.session !== undefined && run.session !== session) return { refused: `goal ${m.goalId} was offered to another connection` };
    if (run.state !== "awaiting" || run.accepted.has(m.segment)) return { refused: `goal ${m.goalId} is not waiting for segment ${m.segment + 1}; only a preview can be edited` };
    if (m.segment !== run.cursor.segment) return { refused: `goal ${m.goalId} waits for segment ${run.cursor.segment + 1}, not ${m.segment + 1}` };
    const at = run.cursor.segment;
    const seg = run.plan.segments[at] as GoalSegment;
    if (m.digest !== seg.digest) return { refused: `the edit names another plan than the one shown for segment ${m.segment + 1}` };
    if (segmentDigest(run.plan.programHash, seg, run.plan.warnings, executable(seg)) !== seg.digest) return { refused: `segment ${m.segment + 1} of goal ${m.goalId} no longer matches its digest` };
    if (this.deps.now() > run.expires) {
      this.stop(run, "expired", null, `${SAYS.expired}; nothing was done for it`);
      return { refused: `segment ${m.segment + 1} of goal ${m.goalId} expired before it was edited` };
    }
    const i = seg.steps.findIndex((x) => x.index === m.step);
    const s = seg.steps[i];
    if (s === undefined) return { refused: `step ${m.step + 1} is not in segment ${m.segment + 1}` };
    if (s.kind !== "write" || s.value === null || s.value.draft === null) return { refused: `step ${m.step + 1} is not text Caret drafted; only a draft can be edited` };
    const text = m.text;
    if (text.trim() === "") return { refused: "the edit is empty" };
    const gated = codeGate(s.target, text, text, "draft", run.plan.instruction);
    if (gated !== null) return { refused: gated };
    const value: ValueBinding = { ...s.value, text, display: text, origin: { kind: "you", digest: sha256(text) }, source: null, memory: null, event: null, draft: null, owner: "user" };
    // W2: the user's own words over a draft, under the draft's exemption: its field rule passed (codeGate above).
    const checked = mintExempt(proposedFor(s.target, value, text), "userTyped", this.deps.now(), run.plan.instruction);
    const step: GoalStep = { ...s, value, writes: text, says: `${s.target.label}: ${text}`, gate: "you", checked };
    run.mints.set(`${seg.index}:${s.ref}`, checked);
    const edited = segmentOf(run.plan.programHash, { index: seg.index, domain: seg.domain, reason: seg.reason, steps: seg.steps.map((x, k) => (k === i ? step : x)) }, run.plan.warnings);
    deepFreeze(edited);
    run.plan.segments[at] = edited;
    run.plan.digest = goalDigest(run.plan.programHash, run.plan.segments.map((x) => x.digest), run.plan.warnings);
    run.cursor.planDigest = run.plan.digest;
    run.expires = this.deps.now() + ACCEPT_MS;
    return { preview: this.segmentMessage(run) };
  }

  /**
   * What must still hold for a segment to run as previewed, or why not: the same reader session, each target's window
   * (and a page's document) and node as frozen, and each value's source.
   */
  private precheck(run: Run, seg: GoalSegment): { reason: GoalStopReason; says: string } | null {
    const inv = run.plan.inventory;
    if (this.deps.readerSession() !== inv.readerSession) return { reason: "readerRestarted", says: `${SAYS.readerRestarted} since Caret planned this, so the window ids no longer apply` };
    if (seg.domain.kind === "window") {
      const d = seg.domain;
      const w = this.deps.model.windows.get(d.windowId);
      if (w === undefined) return { reason: "windowGone", says: `'${d.title}' closed` };
      const doc = inv.documents.get(d.windowId);
      if (doc !== undefined && this.deps.pageDocument?.(d.windowId) !== doc) return { reason: "reload", says: `'${d.title}' reloaded or went to another page since Caret planned this` };
      if (w.window.title !== d.title) return { reason: "targetChanged", says: `'${d.title}' is now titled '${w.window.title}'` };
      for (const s of seg.steps) {
        // I6: a hand-off row names what the user does next; nothing of it runs, so nothing of it is checked.
        if (s.row === true) continue;
        const n = w.nodes.get(s.target.key);
        // A button is the control its label names (the boundary checks the label again right before the press), and so is
        // a file control (P3 review: a page that relabels it to another upload question is not the row the user saw).
        if (n === undefined || n.role !== s.target.role || ((s.target.control === "button" || s.target.control === "file") && (n.label ?? "").trim() !== s.target.label)) {
          return { reason: "targetChanged", says: `'${s.target.label}' in '${d.title}' is gone or was replaced` };
        }
        if (s.kind === "write") {
          const now = n.value ?? "";
          if (now !== s.target.value && now !== s.writes) return { reason: "targetChanged", says: `'${s.target.label}' changed since Caret planned this` };
          // The gates judged the value against this field's name (G2): a field that now reads as another is not that field.
          if (!sameField(w, s)) return { reason: "targetChanged", says: `'${s.target.label}' in '${d.title}' now reads as another field` };
          // W2: nor one whose input kind, autocomplete field name or maxlength changed since its value was checked.
          const m = run.mints.get(`${seg.index}:${s.ref}`);
          if (m !== undefined && contractStale(n, m.field, s.writes ?? "") !== null) return { reason: "targetChanged", says: `'${s.target.label}' in '${d.title}' now asks for something else` };
        }
      }
    }
    for (const s of seg.steps) {
      const v = s.value;
      if (v === null) continue;
      const draftMoved = this.draftMoved(run, s);
      if (draftMoved !== null) return draftMoved;
      // A To field's address must still be the From of the message the reply answers, as the windows read now (B30).
      if (s.to) {
        const reply = s.target.domain.kind === "window" ? this.deps.model.windows.get(s.target.domain.windowId) : undefined;
        const src = v.source === null ? undefined : this.deps.model.windows.get(v.source.windowId);
        if (reply === undefined || src === undefined || !senderOf(reply.window.title, basisText(src), v.text)) return { reason: "sourceChanged", says: `'${v.text}' is no longer the sender of the message you're answering` };
      }
      if (v.memory !== null && !this.deps.memoryHolds(v.memory, v.text)) return { reason: "sourceChanged", says: `what you told Caret for '${s.target.label}' changed or is gone` };
      // A page goal's value from memory (P2): the entry must still give it under the label fill offered it by
      // (offers/fill-popup.ts recheckFill holds a Fill all to the same); no way to read the entry is no entry.
      if (v.memory !== null && v.fill?.memoryLabel !== undefined) {
        const ref = parseMemoryRef(v.memory);
        const now = this.deps.aboutNow?.(ref.id) ?? null;
        if (now === null || !memoryWrites(now.value, ref.part, v.text, ref.conv) || now.label !== v.fill.memoryLabel) return { reason: "sourceChanged", says: `what you told Caret for '${s.target.label}' changed or is gone` };
      }
      // W2: a copied value's source must still say what it said when its value was checked (fill/contract.ts).
      const m = s.kind === "write" ? run.mints.get(`${seg.index}:${s.ref}`) : undefined;
      if (m !== undefined && provenanceStale(this.sourcesOf(run), m.provenance) !== null) return { reason: "sourceChanged", says: `what '${s.target.label}' was copied from changed since Caret planned this` };
      // G2: a value code decided was the user's by their identity in memory, a part split from one included, holds only
      // while the entry is still that identity (no way to read the entry is no entry).
      const id = v.fill?.identity;
      if (id !== undefined) {
        const now = this.deps.aboutNow?.(id.memoryId) ?? null;
        if (now === null || identityKey(id.kind, now.value) !== id.key) return { reason: "sourceChanged", says: `what you told Caret about yourself, which '${s.target.label}' rests on, changed or is gone` };
      }
      if (v.source === null) continue;
      if (!this.sourceShows(run, v)) return { reason: "sourceChanged", says: `the window Caret copies '${s.target.label}' from no longer shows it` };
    }
    return null;
  }

  /** The model a goal's sources are read from: the tab text its plan read (I6), else the screen. */
  private sourcesOf(run: Run): ScreenModel {
    return this.deps.sourceModel?.(run.plan.goalId) ?? this.deps.model;
  }

  /**
   * Whether a value's source window still shows it: a value fill read (P2) by its write-contract provenance (fill/
   * contract.ts provenanceStale, the one recheck a Fill all's acceptance and every write's guard hold it to; I1: it
   * replaced offers/fill-popup.ts sourceHolds here), any other the text it copies (an event its sentence).
   */
  private sourceShows(run: Run, v: NonNullable<GoalStep["value"]>): boolean {
    const src = v.source;
    if (src === null) return true;
    // I6: a value from the tab the user left is shown only while this goal still holds that tab's text.
    const sw = (this.deps.sourceModel?.(run.plan.goalId) ?? this.deps.model).windows.get(src.windowId);
    if (sw === undefined) return false;
    // A fill value always carries its provenance (goals/page-planner.ts); one without is not shown.
    if (v.fill !== undefined) return v.provenance !== undefined && provenanceStale(this.sourcesOf(run), v.provenance) === null;
    const node = sw.nodes.get(src.key);
    const want = v.event?.sentence ?? v.text;
    const typed = sw.values.some((x) => x.nodeKey === src.key && x.text === want);
    return node !== undefined && (nodeText(node).includes(want) || typed);
  }

  /**
   * For a drafted value (B30): why its facts no longer hold, or null. Every window it was drafted from must still be open,
   * every memory entry must still give its value, and the draft must pass goals/drafts.ts's code checks against those
   * windows as they read now: a fact that left the screen leaves the draft unsupported.
   */
  private draftMoved(run: Run, s: GoalStep): { reason: GoalStopReason; says: string } | null {
    const d = s.value?.draft;
    if (d === null || d === undefined || s.value === null) return null;
    const moved = { reason: "sourceChanged" as const, says: `what Caret's draft for '${s.target.label}' was based on changed` };
    const windows: { title: string; text: string }[] = [];
    for (const id of d.windows) {
      const w = this.deps.model.windows.get(id);
      if (w === undefined) return moved;
      windows.push(basisText(w));
    }
    if (d.memory.some((m) => !this.deps.memoryHolds(m.id, m.text))) return moved;
    try {
      checkDraftText(s.value.text, { instruction: run.plan.instruction, windows, memory: d.memory.map((m) => m.text) });
    } catch (e) {
      if (e instanceof DraftRefused) return moved;
      throw e;
    }
    return null;
  }

  /**
   * Every taskProgress the executor publishes. For a goal's segment task, a step verified, skipped or handed off gets a
   * receipt and a step message; the run's end moves the goal on.
   */
  onProgress(m: TaskProgress): void {
    const goalId = this.tasks.get(m.taskId);
    const run = goalId === undefined ? undefined : this.runs.get(goalId);
    if (run === undefined || run.task === null || run.task.id !== m.taskId) return;
    const seg = run.plan.segments[run.task.segment] as GoalSegment;
    // A press is counted from the moment the executor says it is about to make it: a refused one is counted too, which
    // only makes a fresh plan stricter, and one whose answer was lost (it may have landed) is never missed.
    if (m.phase === "acting" && m.step !== null) {
      const s = stepOf(run, seg, m.step);
      // The first "acting" of a step: a fallback means acts again and its time counts from the first try.
      if (s !== undefined && !run.acting.has(s.index)) run.acting.set(s.index, this.deps.now());
      if (s?.kind === "press" && seg.domain.kind === "window" && !run.pressed.some((p) => p.key === s.target.key && p.effect === s.effect)) run.pressed.push({ windowId: seg.domain.windowId, key: s.target.key, effect: s.effect });
    }
    if ((m.phase === "verified" || m.phase === "skipped") && m.step !== null) {
      const s = stepOf(run, seg, m.step);
      if (s !== undefined) this.receipt(run, seg, s, m.phase === "verified" ? "verified" : "alreadyTrue");
      if (s?.kind === "attach" && m.phase === "verified" && run.confirmed?.step === s.index && s.target.domain.kind === "window") {
        this.deps.onAttached?.({ goalId: run.plan.goalId, session: run.session, path: run.confirmed.path, windowId: s.target.domain.windowId, key: s.target.key, label: s.target.label });
      }
    }
    if (m.phase === "done") this.segmentDone(run, seg);
    else if (m.phase === "handoff") {
      const s = m.step === null ? undefined : stepOf(run, seg, m.step);
      // The planned hand-off was reached: the goal is ready for the user's press. Any other hand-off is a step Caret
      // could not do (a write the app did not take, focus that moved): the goal stops there and says so.
      if (s?.kind === "handoff") {
        this.receipt(run, seg, s, "handoff");
        this.finish(run, "handoff");
      } else if (s?.kind === "attach") {
        // P3: an attach the page engine refused (the confirmation expired, the file changed since): every write before
        // it ran, and attach steps come last, so the segment ends here as one whose attach is the user's.
        this.receipt(run, seg, s, "handoff");
        this.segmentDone(run, seg);
      } else {
        run.cause = { reason: "handedOff", says: m.detail ?? "Caret could not do a step and left it to you" };
        this.track(this.segmentStopped(run, seg, { step: m.step, stopReason: "error", detail: m.detail }));
      }
    } else if (m.phase === "paused") {
      // A goal's segment does not wait paused: going on would run steps the user took the window back from, without
      // an acceptance. The task stops (after the executor has finished reporting the pause) and the goal with it.
      run.cause = { reason: "you", says: `you took the window back (${m.detail ?? "paused"})` };
      const taskId = m.taskId;
      queueMicrotask(() => {
        try {
          this.deps.executor.stop(taskId);
        } catch {
          // Already ended another way (stopped or undone): nothing more to stop.
        }
      });
    } else if (m.phase === "stopped") this.track(this.segmentStopped(run, seg, m));
  }

  private receipt(run: Run, seg: GoalSegment, s: GoalStep, status: StepReceipt["status"]): void {
    if (run.cursor.receipts.some((r) => r.step === s.index)) return;
    const windowId = seg.domain.kind === "window" ? seg.domain.windowId : null;
    const w = windowId === null ? undefined : this.deps.model.windows.get(windowId);
    const before = windowId === null ? "calendar" : (run.plan.inventory.revisions.get(windowId) ?? "");
    const after = windowId === null ? "calendar" : w === undefined ? "gone" : windowRevision(w);
    const at = this.deps.now();
    const acted = status === "verified" ? run.acting.get(s.index) : undefined;
    run.cursor.receipts.push({ goalId: run.plan.goalId, segment: seg.index, step: s.index, stepRef: s.ref, status, target: { windowId, key: effectKey(s.target, s.value) }, effect: s.effect, before, after, at, ms: acted === undefined ? null : at - acted });
    if (status !== "handoff") run.cursor.nextStep = s.index + 1;
    const total = run.plan.segments.reduce((n, x) => n + x.steps.filter((y) => y.row !== true).length, 0);
    this.deps.publish({ type: "goalProgress", v: PROTOCOL_VERSION, at: this.deps.now(), goalId: run.plan.goalId, requestId: null, event: "step", segment: seg.index, taskId: run.task?.id ?? "", step: s.index, steps: total, phase: status === "verified" ? "verified" : status === "alreadyTrue" ? "skipped" : "handoff", says: s.says });
  }

  private segmentDone(run: Run, seg: GoalSegment): void {
    this.endTask(run);
    const next = run.plan.segments[seg.index + 1];
    if (next !== undefined) {
      run.cursor.segment = next.index;
      run.state = "awaiting";
      run.expires = this.deps.now() + ACCEPT_MS;
      this.deps.publish(this.segmentMessage(run));
      return;
    }
    // The last step showed new fields the plan could not name: the goal is not done. It stops, offering a fresh plan
    // for them when one can be made (D2-06 live run: "Done" after a reveal whose fresh plan was refused).
    if (seg.steps.at(-1)?.kind === "press") {
      this.track(this.stopAndReplan(run, "revealed", null, SAYS.revealed, "afterReveal"));
      return;
    }
    // P2: a page goal reads its page once more before it ends (its writes are no longer each followed by a walk), then
    // offers a fresh plan for any control its writes revealed in its scope.
    const page = run.plan.page;
    if (page !== undefined && this.deps.walk !== undefined) {
      const walk = this.deps.walk;
      this.track(
        (async () => {
          await walk(page.windowId).catch(() => undefined);
          this.finish(run, "done", this.notHeld(run));
          await this.afterReveal(run, page);
        })(),
      );
      return;
    }
    this.finish(run, "done");
  }

  /**
   * A page goal's verified writes its page no longer shows as written, read from the walk at its end (P2 review): the
   * page link takes a write's own read-back instead of walking after it (engines/page-link.ts), so a page that changed
   * the value later (its own script, another injector) is seen here, and the goal is not done.
   */
  private notHeld(run: Run): LeftItem[] {
    const out: LeftItem[] = [];
    for (const s of run.plan.segments.flatMap((x) => x.steps)) {
      if (s.kind !== "write" || s.writes === null || s.target.domain.kind !== "window") continue;
      if (!run.cursor.receipts.some((r) => r.step === s.index && r.status === "verified")) continue;
      const n = this.deps.model.windows.get(s.target.domain.windowId)?.nodes.get(s.target.key);
      if (n === undefined || (n.value ?? "") === s.writes) continue;
      out.push({ windowId: s.target.domain.windowId, key: s.target.key, label: s.target.label, why: "planned", says: `'${s.target.label}' no longer holds what Caret wrote` });
    }
    return out;
  }

  /**
   * The controls a finished page goal's writes revealed (P2): empty controls the page now shows in the goal's scope that
   * were not on the page when it was planned, on the same document. A list scope takes none (the user named fields that
   * existed); a section scope, those under the same section. For them, a fresh goal with segment reason afterReveal,
   * which needs its own acceptance. A new document is P3's (carry), not a reveal.
   */
  private async afterReveal(run: Run, page: PageGoal): Promise<void> {
    if (page.kind === "list" || this.deps.replan === undefined) return;
    const w = this.deps.model.windows.get(page.windowId);
    if (w === undefined) return;
    const doc = run.plan.inventory.documents.get(page.windowId);
    if (doc === undefined || this.deps.pageDocument?.(page.windowId) !== doc) return;
    const before = new Set(page.keys);
    const revealed = pageInputKeys(w).filter((k) => {
      if (before.has(k)) return false;
      if (page.kind !== "section") return true;
      const n = w.nodes.get(k);
      return n !== undefined && describeField(w, n).section === page.section;
    });
    if (revealed.length === 0) return;
    const next = await this.fresh(run, "revealed", "afterReveal", revealed);
    if (next !== null) this.deps.publish(next);
  }

  /**
   * The goal's end. `reached` is how its last segment ended: every step verified ("done"), or at the hand-off the plan
   * planned ("handoff"). What is still left then decides the outcome (G2): anything besides the recipient makes it
   * partial, a recipient alone makes it a hand-off, and only nothing left is done.
   */
  private finish(run: Run, reached: "done" | "handoff", notHeld: readonly LeftItem[] = []): void {
    this.endTask(run);
    run.state = "finished";
    this.deps.ended?.(run.plan.goalId);
    const verified = run.cursor.receipts.filter((r) => r.status === "verified").length;
    const skipped = run.cursor.receipts.filter((r) => r.status === "alreadyTrue").length;
    const left = [...notHeld, ...this.leftNow(run).filter((l) => !notHeld.some((x) => x.windowId === l.windowId && x.key === l.key))];
    const outcome = left.some((l) => l.why !== "recipient") ? "partial" : left.length > 0 ? "handoff" : reached;
    const handoff = reached === "handoff" ? run.plan.segments.flatMap((x) => x.steps).find((x) => x.kind === "handoff" && x.row !== true) : undefined;
    // I6: a page plan's hand-off row says who goes on, after whatever the goal did ("You press Next.").
    const row = run.plan.segments.flatMap((x) => x.steps).find((x) => x.row === true);
    const tally = `${verified}${skipped > 0 ? `, ${skipped} already so` : ""}`;
    const names = left.map((l) => `'${l.label}'`).join(", ");
    const says =
      outcome === "partial"
        ? `Partly done: ${verified} step${verified === 1 ? "" : "s"} verified${skipped > 0 ? `, ${skipped} already so` : ""}. Left for you: ${names}.`
        : outcome === "handoff"
          ? [`Ready: ${tally} done.`, ...left.map((l) => `You add the recipient in '${l.label}'.`), ...(handoff === undefined ? [] : [`${handoff.says}.`])].join(" ")
          : `Done: ${verified} step${verified === 1 ? "" : "s"} verified${skipped > 0 ? `, ${skipped} already so` : ""}.`;
    this.deps.publish({ type: "goalProgress", v: PROTOCOL_VERSION, at: this.deps.now(), goalId: run.plan.goalId, requestId: null, event: "finished", outcome, verified, skipped, left: left.slice(0, 24).map((l) => clip(l.says, 300)), says: clip(row === undefined ? says : `${says} ${row.says}.`, 600) });
    this.keepCarry(run, left);
  }

  /**
   * P3: a finished page goal over the whole form or a section waits CARRY_MS for the user's own Next (memo "Authority
   * contract"). A list of fields does not carry: the user named fields of a page that will be gone. Nothing is carried
   * that could stand for a value: the scope keeps its sources and person only (continuationScope, as a reveal's), and
   * receipts and what was left keep their keys qualified by this document.
   */
  private keepCarry(run: Run, left: readonly LeftItem[]): void {
    const page = run.plan.page;
    if (page === undefined || page.kind === "list") return;
    const doc = run.plan.inventory.documents.get(page.windowId);
    if (doc === undefined) return;
    const qualify = (windowId: string | null, key: string): string => (windowId === page.windowId && !key.startsWith("doc(") ? `doc(${doc}):${key}` : key);
    const completed = [...run.carried, ...run.cursor.receipts.filter((r) => r.status !== "handoff")].map((r) => ({ ...r, target: { ...r.target, key: qualify(r.target.windowId, r.target.key) } }));
    const owed = left.map((l): LeftItem => ({ ...l, key: qualify(l.windowId, l.key), why: "dropped", says: l.key.startsWith("doc(") ? l.says : `On an earlier page, ${l.says.charAt(0).toLowerCase()}${l.says.slice(1)}` }));
    this.carries.set(page.windowId, { goalId: run.plan.goalId, instruction: run.plan.instruction, page: { ...page, scope: continuationScope(page, true), keys: [] }, document: doc, session: run.session, completed, owed, until: this.deps.now() + CARRY_MS });
  }

  /**
   * P3: whether a carried goal is planning (or has planned) the page `windowId` shows as `document`, or still waits for
   * that window's next page: the ambient offer on load (helper.ts) leaves such a page to it.
   */
  carrying(windowId: string, document: string | null): boolean {
    if (document !== null && this.carried.get(windowId) === document) return true;
    const c = this.carries.get(windowId);
    // A carry waiting on this very document waits for the page after it: this one is not the carry's.
    return c !== undefined && c.until >= this.deps.now() && (document === null || c.document !== document);
  }

  /**
   * P3: the page a carry waits on showed a new document: a fresh plan of it under the goal's instruction and scope,
   * with segment reason nextPage. Every value is chosen again from the sources as they read now and goes through every
   * gate again (helper.ts replanPage, page-planner.ts); the preview needs its own acceptance. A preview of the old
   * document still waiting for its Tab stops: it could only be refused now.
   */
  private carryOn(c: Carry, windowId: string, document: string): void {
    // The carry goes on waiting for the page after this one, under the same instruction and scope, until a carried goal
    // finishes (keepCarry then replaces it with what that goal did and left): a page Caret found nothing for, or whose
    // preview the user did not take, does not end it (P3 eval: wizard-2 had nothing to fill, and wizard-3 then got none).
    this.carries.set(windowId, { ...c, document, until: this.deps.now() + CARRY_MS });
    this.carried.set(windowId, document);
    if (this.carried.size > 64) this.carried.delete(this.carried.keys().next().value as string);
    for (const run of this.runs.values()) {
      if (run.state === "awaiting" && run.plan.page?.windowId === windowId && run.plan.inventory.documents.get(windowId) !== document) this.stop(run, "reload", null, `'${run.plan.segments[0]?.domain.kind === "window" ? run.plan.segments[0].domain.title : "the page"}' went to another page before you accepted`);
    }
    const replan = this.deps.replan;
    if (replan === undefined) return;
    this.track(
      (async () => {
        let plan: GoalPlan | null;
        try {
          plan = await replan({ goalId: `${c.goalId.replace(/~\d+$/, "")}~${++this.replans}`, instruction: c.instruction, completed: c.completed, pressed: [], owed: c.owed, why: "nextPage", session: c.session, page: c.page });
        } catch {
          plan = null;
        }
        // Planning took Jev's time: the host may have gone, or the user may already be on yet another page (P3 review).
        const current = this.carried.get(windowId) === document && this.deps.pageDocument?.(windowId) === document;
        if (plan === null || !current || this.gone(c.session) || this.runs.has(plan.goalId)) {
          // A page the carry has no plan for is the ambient offer's again (helper.ts pageWalked): P3 review.
          if (this.carried.get(windowId) === document) this.carried.delete(windowId);
          if (plan !== null && !this.runs.has(plan.goalId)) this.deps.ended?.(plan.goalId);
          return;
        }
        const msg = this.propose(plan, c.session, null, { goalId: c.goalId, carried: c.completed, pressed: [], owed: c.owed });
        this.deps.publish(msg.event === "segment" ? { ...msg, reason: "nextPage" } : msg);
      })(),
    );
  }

  /**
   * What the goal leaves undone as the screen reads now. A write code dropped, or one a stopped goal planned and never
   * made, stays left unless a step of this goal (or one it replaces) wrote that field. A required field or a recipient
   * is left while it reads empty, and when its window or node is gone, since nothing can show it is still filled. Every
   * window the goal meant to write in is read again for fields its kind requires (left.ts), and a step Caret planned
   * that has no receipt is left too.
   */
  private leftNow(run: Run): LeftItem[] {
    const receipts = [...run.carried, ...run.cursor.receipts].filter((r) => r.status !== "handoff");
    const wrote = (windowId: string, key: string): boolean => receipts.some((r) => (r.target.windowId ?? "calendar") === windowId && r.target.key === key);
    const out: LeftItem[] = [];
    const add = (l: LeftItem): void => {
      if (!out.some((x) => x.windowId === l.windowId && x.key === l.key)) out.push(l);
    };
    // C1: the steps a segment's run left to the user (Executor.leftToYou) come first, with the executor's reason.
    for (const seg of run.plan.segments) {
      for (const l of this.deps.executor.leftToYou(segmentTaskId(run.plan.goalId, seg.index))) {
        // The executor's step index, mapped back to the segment's (P3: a run may drop attach rows given no file).
        const x = stepOf(run, seg, l.step);
        if (x !== undefined && !wrote(whereOf(x), effectKey(x.target, x.value))) add({ windowId: whereOf(x), key: effectKey(x.target, x.value), label: x.target.label, why: "planned", says: l.says });
      }
    }
    for (const l of run.owed) {
      if (l.why === "dropped" || l.why === "planned") {
        if (!wrote(l.windowId, l.key)) add(l);
        continue;
      }
      // Events the instruction asked for: as many distinct events as it asked must have been added, by this goal or one
      // it replaces (all from the same instruction).
      if (l.why === "asked") {
        const added = new Set(receipts.filter((r) => r.target.windowId === null).map((r) => r.target.key)).size;
        if (added < (l.count ?? 1)) add(l);
        continue;
      }
      const w = this.deps.model.windows.get(l.windowId);
      const n = w?.nodes.get(l.key);
      if (w === undefined || n === undefined) add({ ...l, says: `'${l.label}' could not be checked: ${w === undefined ? "its window closed" : "it is gone from its window"}` });
      else if (owedFields(w).some((f) => f.key === l.key && f.empty)) add(l);
    }
    const steps = run.plan.segments.flatMap((x) => x.steps);
    const windows = new Set([...run.owed.map((l) => l.windowId), ...steps.flatMap((x) => (x.kind === "write" && x.target.domain.kind === "window" ? [x.target.domain.windowId] : []))]);
    for (const id of windows) {
      const w = this.deps.model.windows.get(id);
      if (w === undefined) continue;
      for (const f of owedFields(w)) {
        if (!f.empty) continue;
        add({ windowId: id, key: f.key, label: f.label, why: f.why, says: f.why === "recipient" ? `You add the recipient in '${f.label}'` : `'${f.label}' is required, and this plan leaves it empty` });
      }
    }
    for (const x of steps) {
      if (x.kind === "handoff" || run.cursor.receipts.some((r) => r.step === x.index && r.status !== "handoff")) continue;
      add({ windowId: whereOf(x), key: effectKey(x.target, x.value), label: x.target.label, why: "planned", says: x.kind === "attach" ? `Attaching a file to '${x.target.label}' is yours` : `Caret didn't confirm '${x.target.label}'` });
    }
    return out;
  }

  private async segmentStopped(run: Run, seg: GoalSegment, m: Pick<Extract<TaskProgress, { phase: "stopped" }>, "step" | "stopReason" | "detail">): Promise<void> {
    const why = run.cause ?? this.classify(run, seg, m.stopReason, m.detail ?? "");
    const at = m.step === null ? null : (stepOf(run, seg, m.step)?.index ?? null);
    this.endTask(run);
    await this.stopAndReplan(run, why.reason, at, why.says);
  }

  /** The executor's stop, in the goal's words. A page whose document changed reloaded, whatever the executor saw first. */
  private classify(run: Run, seg: GoalSegment, reason: StopReason, detail: string): { reason: GoalStopReason; says: string } {
    const title = seg.domain.kind === "window" ? seg.domain.title : seg.domain.calendar;
    if (seg.domain.kind === "window") {
      const doc = run.plan.inventory.documents.get(seg.domain.windowId);
      if (doc !== undefined && this.deps.pageDocument?.(seg.domain.windowId) !== doc) return { reason: "reload", says: `'${title}' reloaded or went to another page` };
    }
    switch (reason) {
      case "you":
        return { reason: "you", says: SAYS.you };
      case "sheet":
        return { reason: "dialog", says: `a sheet opened over '${title}'` };
      case "readerRestarted":
        return { reason: "readerRestarted", says: SAYS.readerRestarted };
      case "windowGone":
        return { reason: "windowGone", says: `'${title}' closed` };
      case "changed":
        return /^mismatch: /.test(detail) ? { reason: "unexpectedEffect", says: `${SAYS.unexpectedEffect} in '${title}'` } : { reason: "targetChanged", says: `${SAYS.targetChanged} in '${title}'` };
      case "mismatch":
        return /does not hold/.test(detail) ? { reason: "timeout", says: `${SAYS.timeout} in '${title}'` } : { reason: "unexpectedEffect", says: `${SAYS.unexpectedEffect} in '${title}'` };
      default:
        return { reason: "error", says: `${SAYS.error}: ${detail.slice(0, 200)}` };
    }
  }

  private async stopAndReplan(run: Run, reason: GoalStopReason, step: number | null, says: string, fresh: "afterReveal" | "freshPlan" = "freshPlan"): Promise<void> {
    if (run.state === "stopped") return;
    run.state = "stopped";
    this.deps.ended?.(run.plan.goalId);
    const done = run.cursor.receipts.filter((r) => r.status !== "handoff").length;
    const total = run.plan.segments.reduce((n, x) => n + x.steps.filter((y) => y.row !== true).length, 0);
    const sentence = `${says.charAt(0).toUpperCase()}${says.slice(1)}, so Caret stopped after ${done} of ${total} steps.`;
    const next = REPLANNABLE.has(reason) ? await this.fresh(run, reason, fresh) : null;
    this.deps.publish({ type: "goalProgress", v: PROTOCOL_VERSION, at: this.deps.now(), goalId: run.plan.goalId, requestId: null, event: "stopped", segment: run.cursor.segment, step, reason, says: next === null ? sentence : `${sentence} A fresh plan from the screen as it is now is ready for you to check.`, freshPlan: next?.event === "segment" ? next.goalId : null });
    if (next !== null) this.deps.publish(next);
  }

  private stop(run: Run, reason: GoalStopReason, step: number | null, says: string): void {
    if (run.state === "stopped") return;
    run.state = "stopped";
    this.deps.ended?.(run.plan.goalId);
    // P3 fix-check: a carried preview that ends untaken (expired, its host gone) gives its page back to the ambient offer.
    const page = run.plan.page;
    const doc = page === undefined ? undefined : run.plan.inventory.documents.get(page.windowId);
    if (page !== undefined && doc !== undefined && this.carried.get(page.windowId) === doc) this.carried.delete(page.windowId);
    this.deps.publish({ type: "goalProgress", v: PROTOCOL_VERSION, at: this.deps.now(), goalId: run.plan.goalId, requestId: null, event: "stopped", segment: run.cursor.segment, step, reason, says: `${says.charAt(0).toUpperCase()}${says.slice(1)}.`, freshPlan: null });
  }

  /**
   * Asks the replanner for what remains and returns its first segment's preview, as a new goal that needs its own
   * acceptance; null when there is no replanner or it offers nothing.
   */
  private async fresh(run: Run, why: GoalStopReason, reason: "afterReveal" | "freshPlan", revealed?: readonly string[]): Promise<GoalProgress | null> {
    const replan = this.deps.replan;
    if (replan === undefined) return null;
    const completed = [...run.carried, ...run.cursor.receipts.filter((r) => r.status !== "handoff")];
    // Every write this goal meant and has not made goes with it: the fresh plan may leave some out, and is not done then.
    const unmade = run.plan.segments.flatMap((x) => x.steps).flatMap((x): LeftItem[] => {
      if ((x.kind !== "write" && x.kind !== "calendar") || run.cursor.receipts.some((r) => r.step === x.index && r.status !== "handoff")) return [];
      return [{ windowId: whereOf(x), key: effectKey(x.target, x.value), label: x.target.label, why: "planned", says: `Caret's stopped plan meant to write ${x.target.control === "calendar" ? `the event in '${x.target.label}'` : `'${x.target.label}'`}, and has not` }];
    });
    const owed = [...run.owed, ...unmade.filter((u) => !run.owed.some((o) => o.windowId === u.windowId && o.key === u.key))];
    let plan: GoalPlan | null;
    try {
      const page = run.plan.page === undefined ? undefined : { ...run.plan.page, ...(revealed === undefined ? {} : { revealed }) };
      plan = await replan({ goalId: `${run.plan.goalId.replace(/~\d+$/, "")}~${++this.replans}`, instruction: run.plan.instruction, completed, pressed: [...run.pressed], owed: owed.filter((l) => l.why === "dropped" || l.why === "planned"), why, session: run.session, ...(page === undefined ? {} : { page }) });
    } catch {
      plan = null;
    }
    if (plan === null) return null;
    // A reveal's fresh plan is for the document the writes revealed it on: one the user has left by now is not offered.
    const page = run.plan.page;
    if (this.runs.has(plan.goalId) || this.gone(run.session) || (reason === "afterReveal" && page !== undefined && this.deps.pageDocument?.(page.windowId) !== run.plan.inventory.documents.get(page.windowId))) {
      if (!this.runs.has(plan.goalId)) this.deps.ended?.(plan.goalId);
      return null;
    }
    const msg = this.propose(plan, run.session, null, { goalId: run.plan.goalId, carried: completed, pressed: [...run.pressed], owed });
    const fresh = this.runs.get(plan.goalId);
    if (fresh !== undefined) fresh.firstReason = reason;
    return msg.event === "segment" ? { ...msg, reason } : msg;
  }

  private segmentMessage(run: Run, reason?: "freshPlan"): GoalProgress {
    const seg = run.plan.segments[run.cursor.segment] as GoalSegment;
    const d = seg.domain;
    return {
      type: "goalProgress",
      v: PROTOCOL_VERSION,
      at: this.deps.now(),
      goalId: run.plan.goalId,
      requestId: run.cursor.segment === 0 ? run.requestId : null,
      event: "segment",
      segment: seg.index,
      segments: run.plan.segments.length,
      reason: reason ?? (run.cursor.segment === 0 ? (run.firstReason ?? seg.reason) : seg.reason),
      replaces: run.cursor.segment === 0 ? run.replaces : null,
      digest: seg.digest,
      expires: run.expires,
      where: d.kind === "window" ? { kind: "window", app: d.appName, title: d.title } : { kind: "calendar", calendar: d.calendar },
      steps: seg.steps.map((s) => ({ index: s.index, kind: s.kind, says: s.says, ...(s.value?.draft == null ? {} : { drafted: s.value.text }), ...(s.kind === "attach" && s.file !== undefined ? { file: s.file } : {}) })),
      warnings: run.cursor.segment === 0 ? run.plan.warnings : [],
      ...pageOf(this.deps.model, run.plan, seg),
    };
  }

  private endTask(run: Run): void {
    if (run.task !== null) this.tasks.delete(run.task.id);
    run.task = null;
  }

  /**
   * Asked by the helper's authorize right before every act of every task (Executor.authorizeAct, S1's live-scope check):
   * for a goal's running segment, why it may no longer act (screenMoved), or null. The cause is kept so the stop reports
   * it in the goal's words. A finished segment's task is no goal's anymore: its undo is never blocked here.
   */
  blocked(taskId: string): Revocation | null {
    const goalId = this.tasks.get(taskId);
    const run = goalId === undefined ? undefined : this.runs.get(goalId);
    if (run === undefined || run.state !== "running" || run.task?.id !== taskId) return null;
    const why = this.screenMoved(run);
    if (why === null) return null;
    run.cause ??= why;
    return { why: why.says, by: "screen" };
  }

  /**
   * A snapshot, change or closed window arrived: a running segment the screen moved under is revoked at once, so an act
   * already queued in the reader is refused there; blocked() catches the same right before the next act.
   */
  onChanges(_changes: readonly Change[]): void {
    const now = this.deps.now();
    for (const [windowId, c] of [...this.carries]) {
      if (c.until < now || !this.deps.model.windows.has(windowId)) {
        this.carries.delete(windowId);
        continue;
      }
      const doc = this.deps.pageDocument?.(windowId) ?? null;
      if (doc !== null && doc !== c.document) this.carryOn(c, windowId, doc);
    }
    for (const run of this.runs.values()) {
      if (run.state !== "running" || run.task === null) continue;
      const why = this.screenMoved(run);
      if (why !== null) this.revoke(run, why.reason, why.says);
    }
  }

  /**
   * What moved under a running segment, or null: its page reloaded or navigated; its app (by process or bundle id) opened
   * a window it did not show when the segment started, or a sheet over the segment's window; a value a step not yet
   * done copies is no longer shown by its source window, or its window closed.
   */
  private screenMoved(run: Run): { reason: GoalStopReason; says: string } | null {
    const task = run.task;
    if (task === null) return null;
    const seg = run.plan.segments[task.segment] as GoalSegment;
    if (seg.domain.kind === "window") {
      const d = seg.domain;
      const doc = run.plan.inventory.documents.get(d.windowId);
      if (doc !== undefined && this.deps.pageDocument?.(d.windowId) !== doc) return { reason: "reload", says: `'${d.title}' reloaded or went to another page` };
      const opened = [...this.deps.model.windows.values()].find((w) => ((task.pid !== null && w.app.pid === task.pid) || (task.bundleId !== null && w.app.bundleId === task.bundleId)) && !task.windows.has(w.window.windowId));
      if (opened !== undefined) return { reason: "dialog", says: `a new window '${opened.window.title}' opened in ${opened.app.name}` };
      const w = this.deps.model.windows.get(d.windowId);
      if (w !== undefined && [...w.nodes.values()].some((n) => n.role === "AXSheet")) return { reason: "dialog", says: `a sheet opened over '${d.title}'` };
    }
    for (const s of seg.steps) {
      if (run.cursor.receipts.some((r) => r.step === s.index)) continue;
      if (s.kind === "write" && seg.domain.kind === "window") {
        const w = this.deps.model.windows.get(seg.domain.windowId);
        if (w !== undefined && w.nodes.has(s.target.key) && !sameField(w, s)) return { reason: "targetChanged", says: `'${s.target.label}' in '${seg.domain.title}' now reads as another field` };
      }
      const draftMoved = this.draftMoved(run, s);
      if (draftMoved !== null) return draftMoved;
      if (s.value === null || s.value.source === null) continue;
      if (!this.sourceShows(run, s.value)) return { reason: "sourceChanged", says: `the window Caret copies '${s.target.label}' from no longer shows it` };
    }
    return null;
  }

  private revoke(run: Run, reason: GoalStopReason, says: string): void {
    if (run.task === null) return;
    run.cause ??= { reason, says };
    this.deps.executor.revoke(run.task.id, { why: says, by: "screen" });
  }

  /**
   * I6: the text of the tab the user left, which this goal's plan read, was dropped (its time ran out, its site was
   * turned off, the tab moved on). A preview waiting for its acceptance whose values that text showed stops now, as a
   * Fill all made from it is withdrawn (helper.ts tabTextDropped); a running segment is revoked by screenMoved.
   */
  sourceDropped(goalId: string): void {
    const run = this.runs.get(goalId);
    if (run === undefined || run.state !== "awaiting") return;
    const seg = run.plan.segments[run.cursor.segment] as GoalSegment;
    const gone = seg.steps.find((s) => s.value !== null && s.value.source !== null && !this.sourceShows(run, s.value));
    if (gone !== undefined) this.stop(run, "sourceChanged", null, `the text Caret read for '${gone.target.label}' from the tab you left has expired, so this plan can't run`);
  }

  /**
   * I6: whether a goal for page window `windowId` is waiting for its acceptance or running. The ambient Fill all and ready
   * on load leave that page to it (helper.ts goalOnPage), so neither reads the tab the goal's plan holds.
   */
  previewing(windowId: string): boolean {
    for (const r of this.runs.values()) if ((r.state === "awaiting" || r.state === "running") && r.plan.page?.windowId === windowId) return true;
    return false;
  }

  /**
   * I6 (P4 rule 6): a goal that has ended keeps its plan (planOf, receipts, carry), so the values and spans its plan took
   * from `windowId`, the tab the user left, are forgotten from it once the text that gave them is let go: those values,
   * the step sentences and slots that quote them, and the warnings and left items that quote them. Receipts and keys
   * stay. Only a goal that has ended: a live one still needs them to run and to check its sources.
   */
  forgetSource(goalId: string, windows: ReadonlySet<string>): void {
    const run = this.runs.get(goalId);
    if (run === undefined || (run.state !== "finished" && run.state !== "stopped")) return;
    const quoted = new Set<string>();
    const fromTab = (v: ValueBinding | null): boolean => v !== null && ((v.source !== null && windows.has(v.source.windowId)) || (v.origin.kind === "span" && windows.has(v.origin.source)));
    const blank = (v: ValueBinding): ValueBinding => {
      for (const t of [v.text, v.fill?.span ?? "", v.fill?.context ?? ""]) if (t.trim() !== "") quoted.add(t);
      // W2: the write contract's provenance and mint quote the source too (its span, line and label); a goal that ended
      // needs neither. I1: G2's clause and source texts now travel only in the provenance, so they go with it.
      const { provenance: _p, checked: _c, ...rest } = v;
      return { ...rest, text: "", display: "", ...(v.fill === undefined ? {} : { fill: { ...v.fill, span: "", context: null } }) };
    };
    // A left item's quoted value (a hand-off's), wherever the item went: the plan, the run's obligations, a carry.
    const items = [...run.plan.left, ...run.owed, ...[...this.carries.values()].filter((c) => c.goalId === goalId).flatMap((c) => c.owed)];
    for (const l of items) if (l.quotes !== undefined && windows.has(l.quotes.windowId) && l.quotes.text.trim() !== "") quoted.add(l.quotes.text);
    const plan = structuredClone(run.plan);
    const values = new Map([...plan.inventory.values].map(([k, v]) => [k, fromTab(v) ? blank(v) : v]));
    const texts = new Map([...plan.inventory.texts].filter(([k]) => !windows.has(k)));
    for (const seg of plan.segments) {
      for (const s of seg.steps) {
        if (s.value === null || !fromTab(s.value)) continue;
        s.value = blank(s.value);
        delete s.checked;
        if (s.writes !== null) s.writes = "";
      }
    }
    const scrub = (x: string): string => [...quoted].sort((a, b) => b.length - a.length).reduce((a, t) => a.split(t).join("…"), x);
    const scrubItem = (l: LeftItem): LeftItem => {
      const { quotes, ...rest } = l;
      return { ...rest, says: scrub(l.says), ...(quotes === undefined || windows.has(quotes.windowId) ? {} : { quotes }) };
    };
    for (const seg of plan.segments) {
      for (const s of seg.steps) s.says = scrub(s.says);
      seg.slots = Object.fromEntries(Object.entries(seg.slots).map(([k, v]) => [k, seg.plan.sources?.[k] !== undefined && windows.has(seg.plan.sources[k] as string) ? "" : scrub(v)]));
    }
    const next: GoalPlan = { ...plan, inventory: { ...plan.inventory, values, texts }, warnings: plan.warnings.map(scrub), left: plan.left.map(scrubItem) };
    for (const seg of next.segments) deepFreeze(seg);
    run.plan = next;
    run.owed = run.owed.map(scrubItem);
    for (const c of this.carries.values()) if (c.goalId === goalId) c.owed = c.owed.map(scrubItem);
  }

  /** Previews not accepted in time stop. Called on the helper's tick. */
  tick(now: number): void {
    for (const run of this.runs.values()) if (run.state === "awaiting" && now > run.expires) this.stop(run, "expired", null, `${SAYS.expired}; nothing more was done`);
    for (const [windowId, c] of [...this.carries]) if (c.until < now) this.carries.delete(windowId);
  }

  /** The host session a goal was offered to left: its previews end. A running segment is revoked by the helper's own binding. */
  hostGone(session: string): void {
    for (const run of this.runs.values()) if (run.session === session && run.state === "awaiting") this.stop(run, "hostGone", null, SAYS.hostGone);
    for (const [windowId, c] of [...this.carries]) if (c.session === session) this.carries.delete(windowId);
    this.goneHosts.add(session);
    if (this.goneHosts.size > 256) this.goneHosts.delete(this.goneHosts.keys().next().value as string);
  }

  /** Whether the host session a goal was offered to has left. In process (no session) it never does. */
  private gone(session: string | undefined): boolean {
    return session !== undefined && this.goneHosts.has(session);
  }

  /** A new reader numbers windows from scratch: no preview of the old session can run. */
  readerRestarted(): void {
    for (const run of this.runs.values()) if (run.state === "awaiting") this.stop(run, "readerRestarted", null, `${SAYS.readerRestarted}, so the plan's windows no longer apply`);
    this.carries.clear();
    this.carried.clear();
  }
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The executor task id of a goal's segment. */
const segmentTaskId = (goalId: string, segment: number): string => `${goalId}:s${segment}`;

/** Where a step acts, as a left item names it: its window, or "calendar". */
const whereOf = (x: GoalStep): string => (x.target.domain.kind === "window" ? x.target.domain.windowId : "calendar");

/**
 * Whether a write's field still reads as the field the gates judged (G2), as inventory.ts named it: the same
 * placeholder, and a text field's planner.ts fieldName or a page control's label among formControls' unset controls.
 * A field already holding the step's value needs no name (the executor finds it already true); one whose name cannot
 * be read is not the same. A name read from the nearest text moves with the layout, so a moved field can stop a goal
 * that a fresh plan then offers again: a false stop, never a write.
 */
function sameField(w: WindowState, s: GoalStep): boolean {
  const n = w.nodes.get(s.target.key);
  if (n === undefined) return false;
  if (s.writes !== null && (n.value ?? "") === s.writes) return true;
  if ((n.placeholder ?? null) !== s.target.placeholder) return false;
  // A web dropdown (P2) is named as a text field is (page-planner.ts binds it so).
  if (s.target.control === "text" || s.target.control === "combobox") return fieldName(w, n) === s.target.label;
  // A control with no label of its own is bound as "" (page-planner.ts); one formControls no longer lists is not the same.
  const c = formControls(w).find((x) => x.node.key === n.key);
  return c !== undefined && (c.label ?? "") === s.target.label;
}

/** H11: a page segment's view for the host's panel, as a spread: empty for every other segment. */
function pageOf(model: ScreenModel, plan: GoalPlan, seg: GoalSegment): { page?: NonNullable<ReturnType<typeof pageView>> } {
  const page = pageView(model, plan, seg);
  return page === undefined ? {} : { page };
}

/** The segment step the running task's step `i` is (P3: the task may run fewer steps than the segment lists). */
function stepOf(run: Run, seg: GoalSegment, i: number): GoalStep | undefined {
  const at = run.task !== null && run.task.segment === seg.index ? run.stepMap[i] : i;
  return at === undefined ? undefined : seg.steps[at];
}

/**
 * What a run must account for (G2): the plan's left items first (their sentences say most), then every field the
 * windows it writes in owe as frozen (left.ts), empty or not, then what a goal it replaces still owed.
 */
function obligations(plan: GoalPlan, carried: readonly LeftItem[]): LeftItem[] {
  const out: LeftItem[] = [];
  const add = (l: LeftItem): void => {
    if (!out.some((x) => x.windowId === l.windowId && x.key === l.key)) out.push(l);
  };
  for (const l of plan.left) add(l);
  const touched = new Set([...plan.left.map((l) => l.windowId), ...plan.segments.flatMap((x) => x.steps).flatMap((x) => (x.kind === "write" && x.target.domain.kind === "window" ? [x.target.domain.windowId] : []))]);
  for (const id of touched) for (const f of plan.inventory.owed.get(id) ?? []) add({ windowId: id, key: f.key, label: f.label, why: f.why, says: f.why === "recipient" ? `You add the recipient in '${f.label}'` : `'${f.label}' is required, and this plan leaves it empty` });
  for (const l of carried) add(l);
  return out;
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}
