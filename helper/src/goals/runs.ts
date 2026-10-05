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
import { PROTOCOL_VERSION, type GoalAccept, type GoalProgress, type GoalStopReason, type StopReason, type TaskProgress } from "../protocol.ts";
import { basisText, windowRevision } from "./inventory.ts";
import { checkDraftText, DraftRefused, senderOf } from "./drafts.ts";
import { formControls } from "../fill/controls.ts";
import { fieldName } from "../planner/planner.ts";
import type { WindowState } from "../model.ts";
import { owedFields } from "./left.ts";
import { executable, segmentDigest, type GoalPlan, type GoalSegment, type GoalStep, type LeftItem } from "./plan.ts";
import { effectKey, type DonePress } from "./lower.ts";

/** How long a segment's preview may wait for its acceptance: the act grant's own limit (protocol.ts GRANT_MAX_MS). */
export const ACCEPT_MS = 120_000;

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
  why: GoalStopReason;
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

  /** Offers a goal's first segment for acceptance, as the reply to `requestId` (or as a fresh plan replacing another). */
  propose(given: GoalPlan, session: string | undefined, requestId: string | null, replaces: { goalId: string; carried: StepReceipt[]; pressed: DonePress[]; owed: LeftItem[] } | null = null): GoalProgress {
    if (this.runs.has(given.goalId)) throw new Error(`goal ${given.goalId} already exists`);
    // Only lowering's gates (G2, gates.ts) mark a write: a plan built any other way is a bug, never offered.
    const unchecked = given.segments.flatMap((s) => s.steps).find((s) => (s.kind === "write" || s.kind === "calendar") && s.gate === null);
    if (unchecked !== undefined) throw new Error(`goal ${given.goalId}: step ${unchecked.ref} writes '${unchecked.target.label}' without passing the value gates`);
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
    run.accepted.add(m.segment);
    const why = this.precheck(run, seg);
    if (why !== null) {
      await this.stopAndReplan(run, why.reason, seg.steps[0]?.index ?? null, why.says);
      return { refused: why.says };
    }
    const taskId = `${run.plan.goalId}:s${seg.index}`;
    const w = seg.domain.kind === "window" ? this.deps.model.windows.get(seg.domain.windowId) : undefined;
    const pid = w?.app.pid ?? null;
    const bundleId = w?.app.bundleId ?? null;
    const sameApp = (x: { app: { pid: number; bundleId: string } }): boolean => (pid !== null && x.app.pid === pid) || (bundleId !== null && x.app.bundleId === bundleId);
    run.task = { id: taskId, segment: seg.index, pid, bundleId, windows: new Set([...this.deps.model.windows.values()].filter(sameApp).map((x) => x.window.windowId)) };
    run.state = "running";
    run.cause = null;
    this.tasks.set(taskId, run.plan.goalId);
    this.ever.add(taskId);
    this.deps.bind(taskId, session);
    // What the precheck just read is what the task's first walk must still find: a field typed into in between stops it.
    const expect: Record<string, Record<string, string>> = {};
    if (w !== undefined) expect[w.window.windowId] = Object.fromEntries(seg.steps.filter((s) => s.kind === "write").map((s) => [s.target.key, w.nodes.get(s.target.key)?.value ?? ""]));
    try {
      return { result: await this.deps.executor.run(taskId, seg.plan, seg.slots, expect, { grant: true }) };
    } catch (e) {
      // The executor refused the plan before its first step (PlanError): nothing was dispatched.
      const says = `${SAYS.error}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
      this.endTask(run);
      this.stop(run, "error", null, says);
      return { refused: says };
    }
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
        const n = w.nodes.get(s.target.key);
        // A button is the control its label names (the boundary checks the label again right before the press).
        if (n === undefined || n.role !== s.target.role || (s.target.control === "button" && (n.label ?? "").trim() !== s.target.label)) {
          return { reason: "targetChanged", says: `'${s.target.label}' in '${d.title}' is gone or was replaced` };
        }
        if (s.kind === "write") {
          const now = n.value ?? "";
          if (now !== s.target.value && now !== s.writes) return { reason: "targetChanged", says: `'${s.target.label}' changed since Caret planned this` };
          // The gates judged the value against this field's name (G2): a field that now reads as another is not that field.
          if (!sameField(w, s)) return { reason: "targetChanged", says: `'${s.target.label}' in '${d.title}' now reads as another field` };
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
      if (v.source === null) continue;
      const sw = this.deps.model.windows.get(v.source.windowId);
      const node = sw?.nodes.get(v.source.key);
      const want = v.event?.sentence ?? v.text;
      const typed = sw?.values.some((x) => x.nodeKey === v.source?.key && x.text === want) === true;
      if (sw === undefined || node === undefined || (!nodeText(node).includes(want) && !typed)) return { reason: "sourceChanged", says: `the window Caret copies '${s.target.label}' from no longer shows it` };
    }
    return null;
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
      const s = seg.steps[m.step];
      if (s?.kind === "press" && seg.domain.kind === "window" && !run.pressed.some((p) => p.key === s.target.key && p.effect === s.effect)) run.pressed.push({ windowId: seg.domain.windowId, key: s.target.key, effect: s.effect });
    }
    if ((m.phase === "verified" || m.phase === "skipped") && m.step !== null) {
      const s = seg.steps[m.step];
      if (s !== undefined) this.receipt(run, seg, s, m.phase === "verified" ? "verified" : "alreadyTrue");
    }
    if (m.phase === "done") this.segmentDone(run, seg);
    else if (m.phase === "handoff") {
      const s = m.step === null ? undefined : seg.steps[m.step];
      // The planned hand-off was reached: the goal is ready for the user's press. Any other hand-off is a step Caret
      // could not do (a write the app did not take, focus that moved): the goal stops there and says so.
      if (s?.kind === "handoff") {
        this.receipt(run, seg, s, "handoff");
        this.finish(run, "handoff");
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
    run.cursor.receipts.push({ goalId: run.plan.goalId, segment: seg.index, step: s.index, stepRef: s.ref, status, target: { windowId, key: effectKey(s.target, s.value) }, effect: s.effect, before, after, at: this.deps.now() });
    if (status !== "handoff") run.cursor.nextStep = s.index + 1;
    const total = run.plan.segments.reduce((n, x) => n + x.steps.length, 0);
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
    this.finish(run, "done");
  }

  /**
   * The goal's end. `reached` is how its last segment ended: every step verified ("done"), or at the hand-off the plan
   * planned ("handoff"). What is still left then decides the outcome (G2): anything besides the recipient makes it
   * partial, a recipient alone makes it a hand-off, and only nothing left is done.
   */
  private finish(run: Run, reached: "done" | "handoff"): void {
    this.endTask(run);
    run.state = "finished";
    const verified = run.cursor.receipts.filter((r) => r.status === "verified").length;
    const skipped = run.cursor.receipts.filter((r) => r.status === "alreadyTrue").length;
    const left = this.leftNow(run);
    const outcome = left.some((l) => l.why !== "recipient") ? "partial" : left.length > 0 ? "handoff" : reached;
    const handoff = reached === "handoff" ? run.plan.segments.flatMap((x) => x.steps).find((x) => x.kind === "handoff") : undefined;
    const tally = `${verified}${skipped > 0 ? `, ${skipped} already so` : ""}`;
    const names = left.map((l) => `'${l.label}'`).join(", ");
    const says =
      outcome === "partial"
        ? `Partly done: ${verified} step${verified === 1 ? "" : "s"} verified${skipped > 0 ? `, ${skipped} already so` : ""}. Left for you: ${names}.`
        : outcome === "handoff"
          ? [`Ready: ${tally} done.`, ...left.map((l) => `You add the recipient in '${l.label}'.`), ...(handoff === undefined ? [] : [`${handoff.says}.`])].join(" ")
          : `Done: ${verified} step${verified === 1 ? "" : "s"} verified${skipped > 0 ? `, ${skipped} already so` : ""}.`;
    this.deps.publish({ type: "goalProgress", v: PROTOCOL_VERSION, at: this.deps.now(), goalId: run.plan.goalId, requestId: null, event: "finished", outcome, verified, skipped, left: left.slice(0, 24).map((l) => clip(l.says, 300)), says: clip(says, 600) });
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
    for (const l of run.owed) {
      if (l.why === "dropped" || l.why === "planned") {
        if (!wrote(l.windowId, l.key)) add(l);
        continue;
      }
      // An event the instruction asked for: any event this goal (or one it replaces) added answers it.
      if (l.why === "asked") {
        if (!receipts.some((r) => r.target.windowId === null)) add(l);
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
      add({ windowId: whereOf(x), key: effectKey(x.target, x.value), label: x.target.label, why: "planned", says: `Caret didn't confirm '${x.target.label}'` });
    }
    return out;
  }

  private async segmentStopped(run: Run, seg: GoalSegment, m: Pick<Extract<TaskProgress, { phase: "stopped" }>, "step" | "stopReason" | "detail">): Promise<void> {
    const why = run.cause ?? this.classify(run, seg, m.stopReason, m.detail ?? "");
    const at = m.step === null ? null : (seg.steps[m.step]?.index ?? null);
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
    const done = run.cursor.receipts.filter((r) => r.status !== "handoff").length;
    const total = run.plan.segments.reduce((n, x) => n + x.steps.length, 0);
    const sentence = `${says.charAt(0).toUpperCase()}${says.slice(1)}, so Caret stopped after ${done} of ${total} steps.`;
    const next = REPLANNABLE.has(reason) ? await this.fresh(run, reason, fresh) : null;
    this.deps.publish({ type: "goalProgress", v: PROTOCOL_VERSION, at: this.deps.now(), goalId: run.plan.goalId, requestId: null, event: "stopped", segment: run.cursor.segment, step, reason, says: next === null ? sentence : `${sentence} A fresh plan from the screen as it is now is ready for you to check.`, freshPlan: next?.event === "segment" ? next.goalId : null });
    if (next !== null) this.deps.publish(next);
  }

  private stop(run: Run, reason: GoalStopReason, step: number | null, says: string): void {
    if (run.state === "stopped") return;
    run.state = "stopped";
    this.deps.publish({ type: "goalProgress", v: PROTOCOL_VERSION, at: this.deps.now(), goalId: run.plan.goalId, requestId: null, event: "stopped", segment: run.cursor.segment, step, reason, says: `${says.charAt(0).toUpperCase()}${says.slice(1)}.`, freshPlan: null });
  }

  /**
   * Asks the replanner for what remains and returns its first segment's preview, as a new goal that needs its own
   * acceptance; null when there is no replanner or it offers nothing.
   */
  private async fresh(run: Run, why: GoalStopReason, reason: "afterReveal" | "freshPlan"): Promise<GoalProgress | null> {
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
      plan = await replan({ goalId: `${run.plan.goalId.replace(/~\d+$/, "")}~${++this.replans}`, instruction: run.plan.instruction, completed, pressed: [...run.pressed], owed: owed.filter((l) => l.why === "dropped" || l.why === "planned"), why });
    } catch {
      plan = null;
    }
    if (plan === null || this.runs.has(plan.goalId)) return null;
    const msg = this.propose(plan, run.session, null, { goalId: run.plan.goalId, carried: completed, pressed: [...run.pressed], owed });
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
      reason: reason ?? seg.reason,
      replaces: run.cursor.segment === 0 ? run.replaces : null,
      digest: seg.digest,
      expires: run.expires,
      where: d.kind === "window" ? { kind: "window", app: d.appName, title: d.title } : { kind: "calendar", calendar: d.calendar },
      steps: seg.steps.map((s) => ({ index: s.index, kind: s.kind, says: s.says, ...(s.value?.draft == null ? {} : { drafted: s.value.text }) })),
      warnings: run.cursor.segment === 0 ? run.plan.warnings : [],
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
      const src = s.value?.source;
      if (src === undefined || src === null) continue;
      const sw = this.deps.model.windows.get(src.windowId);
      const node = sw?.nodes.get(src.key);
      const want = s.value?.event?.sentence ?? s.value?.text ?? "";
      const typed = sw?.values.some((x) => x.nodeKey === src.key && x.text === want) === true;
      if (sw === undefined || node === undefined || (!nodeText(node).includes(want) && !typed)) return { reason: "sourceChanged", says: `the window Caret copies '${s.target.label}' from no longer shows it` };
    }
    return null;
  }

  private revoke(run: Run, reason: GoalStopReason, says: string): void {
    if (run.task === null) return;
    run.cause ??= { reason, says };
    this.deps.executor.revoke(run.task.id, { why: says, by: "screen" });
  }

  /** Previews not accepted in time stop. Called on the helper's tick. */
  tick(now: number): void {
    for (const run of this.runs.values()) if (run.state === "awaiting" && now > run.expires) this.stop(run, "expired", null, `${SAYS.expired}; nothing more was done`);
  }

  /** The host session a goal was offered to left: its previews end. A running segment is revoked by the helper's own binding. */
  hostGone(session: string): void {
    for (const run of this.runs.values()) if (run.session === session && run.state === "awaiting") this.stop(run, "hostGone", null, SAYS.hostGone);
  }

  /** A new reader numbers windows from scratch: no preview of the old session can run. */
  readerRestarted(): void {
    for (const run of this.runs.values()) if (run.state === "awaiting") this.stop(run, "readerRestarted", null, `${SAYS.readerRestarted}, so the plan's windows no longer apply`);
  }
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** Where a step acts, as a left item names it: its window, or "calendar". */
const whereOf = (x: GoalStep): string => (x.target.domain.kind === "window" ? x.target.domain.windowId : "calendar");

/**
 * Whether a write's field still reads as the field the gates judged (G2), as inventory.ts named it: a text field by
 * planner.ts fieldName, a page control by its label among formControls' unset controls. A field already holding the
 * step's value needs no name (the executor finds it already true); one whose name cannot be read is not the same.
 */
function sameField(w: WindowState, s: GoalStep): boolean {
  const n = w.nodes.get(s.target.key);
  if (n === undefined) return false;
  if (s.writes !== null && (n.value ?? "") === s.writes) return true;
  if (s.target.control === "text") return fieldName(w, n) === s.target.label;
  return formControls(w).find((c) => c.node.key === n.key)?.label === s.target.label;
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
