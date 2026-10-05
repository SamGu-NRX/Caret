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
import { windowRevision } from "./inventory.ts";
import { executable, segmentDigest, type GoalPlan, type GoalSegment, type GoalStep } from "./plan.ts";

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
  windowGone: "the window closed",
  you: "you stopped it",
  readerRestarted: "the screen reader restarted",
  hostGone: "the app that showed the plan disconnected",
  expired: "the plan was not accepted in time",
  error: "something went wrong",
};

/** Stops after which a fresh plan from the screen as it is now may be offered. */
const REPLANNABLE: ReadonlySet<GoalStopReason> = new Set(["dialog", "reload", "sourceChanged", "targetChanged", "timeout", "unexpectedEffect", "windowGone"]);

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
  propose(given: GoalPlan, session: string | undefined, requestId: string | null, replaces: { goalId: string; carried: StepReceipt[] } | null = null): GoalProgress {
    if (this.runs.has(given.goalId)) throw new Error(`goal ${given.goalId} already exists`);
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
        }
      }
    }
    for (const s of seg.steps) {
      const v = s.value;
      if (v === null) continue;
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
   * Every taskProgress the executor publishes. For a goal's segment task, a step verified, skipped or handed off gets a
   * receipt and a step message; the run's end moves the goal on.
   */
  onProgress(m: TaskProgress): void {
    const goalId = this.tasks.get(m.taskId);
    const run = goalId === undefined ? undefined : this.runs.get(goalId);
    if (run === undefined || run.task === null || run.task.id !== m.taskId) return;
    const seg = run.plan.segments[run.task.segment] as GoalSegment;
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
    run.cursor.receipts.push({ goalId: run.plan.goalId, segment: seg.index, step: s.index, stepRef: s.ref, status, target: { windowId, key: s.target.key }, effect: s.effect, before, after, at: this.deps.now() });
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
    // The last step showed new fields: the plan could not name them, so what remains needs a fresh plan.
    const last = seg.steps.at(-1);
    this.finish(run, "done");
    if (last?.kind === "press") this.track(this.fresh(run, "unexpectedEffect", "afterReveal").then((m) => m !== null && this.deps.publish(m)));
  }

  private finish(run: Run, outcome: "done" | "handoff"): void {
    this.endTask(run);
    run.state = "finished";
    const verified = run.cursor.receipts.filter((r) => r.status === "verified").length;
    const skipped = run.cursor.receipts.filter((r) => r.status === "alreadyTrue").length;
    const handoff = run.plan.segments.flatMap((x) => x.steps).find((x) => x.kind === "handoff");
    const says = outcome === "handoff" && handoff !== undefined ? `Ready: ${verified} done${skipped > 0 ? `, ${skipped} already so` : ""}. ${handoff.says}.` : `Done: ${verified} step${verified === 1 ? "" : "s"} verified${skipped > 0 ? `, ${skipped} already so` : ""}.`;
    this.deps.publish({ type: "goalProgress", v: PROTOCOL_VERSION, at: this.deps.now(), goalId: run.plan.goalId, requestId: null, event: "finished", outcome, verified, skipped, says });
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

  private async stopAndReplan(run: Run, reason: GoalStopReason, step: number | null, says: string): Promise<void> {
    if (run.state === "stopped") return;
    run.state = "stopped";
    const done = run.cursor.receipts.filter((r) => r.status !== "handoff").length;
    const total = run.plan.segments.reduce((n, x) => n + x.steps.length, 0);
    const sentence = `${says.charAt(0).toUpperCase()}${says.slice(1)}, so Caret stopped after ${done} of ${total} steps.`;
    const fresh = REPLANNABLE.has(reason) ? await this.fresh(run, reason, "freshPlan") : null;
    this.deps.publish({ type: "goalProgress", v: PROTOCOL_VERSION, at: this.deps.now(), goalId: run.plan.goalId, requestId: null, event: "stopped", segment: run.cursor.segment, step, reason, says: fresh === null ? sentence : `${sentence} A fresh plan from the screen as it is now is ready for you to check.`, freshPlan: fresh?.event === "segment" ? fresh.goalId : null });
    if (fresh !== null) this.deps.publish(fresh);
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
    let plan: GoalPlan | null;
    try {
      plan = await replan({ goalId: `${run.plan.goalId.replace(/~\d+$/, "")}~${++this.replans}`, instruction: run.plan.instruction, completed, why });
    } catch {
      plan = null;
    }
    if (plan === null || this.runs.has(plan.goalId)) return null;
    const msg = this.propose(plan, run.session, null, { goalId: run.plan.goalId, carried: completed });
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
      steps: seg.steps.map((s) => ({ index: s.index, kind: s.kind, says: s.says })),
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
      const src = s.value?.source;
      if (src === undefined || src === null || run.cursor.receipts.some((r) => r.step === s.index)) continue;
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

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}
