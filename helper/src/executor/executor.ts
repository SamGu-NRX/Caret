// The executor (deep plan section 7). For each step of a plan:
//   1. Re-read the step's window and stop if anything it saw at the start has changed under it.
//   2. If the end state already holds, skip the step. A finished plan therefore reruns as a no-op.
//   3. Pick the means: a value or focus write, a press, a raise, the calendar, or a URL. A press whose label
//      reads as send, submit, delete or pay is never made; the run stops and hands it to the user.
//   4. Predict the change, act through a reader verb that rechecks the exact target, re-read the
//      window, and compare what changed against the prediction. A mismatch stops the run at that step.
// Real input in a window the task acts in, or a pause or take-over from a consumer, pauses it at the
// next step boundary: before the next step starts, or before the current step acts if its reads are
// still under way. A stop ends it there. Every pause and stop revokes the task's act grant the moment it
// is recorded, so an act already queued in the reader is refused. Every write goes in an undo ledger with
// the value it replaced.
// A task started from an accepted offer holds an act grant for its window (protocol.ts ActGrant): the
// reader acts in no other process or window for it, and in none at all once the grant ends.
import { randomInt } from "node:crypto";
import { GRANT_MAX_MS, PROTOCOL_VERSION, type ActionType, type AppRef, type UseOutcome, type CalendarBlock, type Frame, type Node, type StopReason, type TaskCause, type TaskPhase, type TaskProgress, type UserInput, type ReaderVerb, type VerbResult } from "../protocol.ts";
import { nodeText, type Change, type ScreenModel, type WindowState } from "../model.ts";
import type { AskJev } from "../fill/jev.ts";
import { CalendarBlocked, CalendarRefused, type CalendarPort, type ReaderLink, type UrlOpener } from "./means.ts";
import { classifyPress, type RiskClass } from "./risk.ts";
import { fillSlots, Plan, PlanError, type EndState, type Step, type Target, type WindowSel } from "./schema.ts";
import { norm, resolveLocally, resolveTarget, type JevTrace, type Resolution } from "./target.ts";

export interface ExecutorDeps {
  model: ScreenModel;
  reader: ReaderLink;
  calendar: CalendarPort | null;
  urls: UrlOpener | null;
  askJev: AskJev | null;
  publish: (m: TaskProgress) => void;
  /** Every phase with what the activity feed needs beyond taskProgress: who caused it, what remains, whether undo applies. */
  onTask?: (e: TaskEvent) => void;
  /** Registers a listener for changes the model records; returns the function that removes it. */
  onChanges: (listener: (changes: readonly Change[]) => void) => () => void;
  /** Pause between re-reads while waiting for a press or URL to show its effect. */
  sleep?: (ms: number) => Promise<void>;
  rand?: (n: number) => number;
  /**
   * Fault-injection seams for the fixture evaluation: awaited before each step starts, and right
   * after a step's last read and before its act. Never set in normal use.
   */
  beforeStep?: (taskId: string, step: number) => Promise<void>;
  beforeAct?: (taskId: string, step: number) => Promise<void>;
  /** Overrides TARGET_CUTOFF, for runs that measure the confidences of target questions. */
  targetCutoff?: number;
  /** Each use of a permission a run made, reported when the run ends (B17; the helper keeps the last few in memory). */
  onUse?: (u: TaskUse) => void;
  /** Whether memory entry `id` still holds `value` (Step.memory). Without it, a step that names an entry is refused. */
  memoryHolds?: (id: string, value: string) => boolean;
  /**
   * Whether the task may still act, asked right before every write, press, raise and calendar add, and by
   * `recheck` for every live task: what it depends on (Caret not paused, its skill still on its own, the
   * permission for the action it is about to take, the host session that started it) may have changed
   * since it started (S1 audit #4, #5). `action` is null for the checks that do not depend on one. Without
   * it every act is allowed, as in tests that predate B22.
   */
  authorize?: (a: Authorization) => Revocation | null;
}

/** What `authorize` is asked about: a task, whether a skill started it with no Tab, and the permission its next act falls under. */
export interface Authorization {
  taskId: string;
  unprompted: boolean;
  action: ActionType | null;
}

/**
 * Why a task may no longer act. `you`: the user changed something it depended on (a permission, Caret's
 * pause, the skill, a memory entry, the settings); the run stops as stopped by you. `host`: the host
 * session that started it is gone; the run stops as an error Caret reports.
 */
export interface Revocation {
  why: string;
  by: "you" | "host";
}

/** One use of a permission by a run: its action type, what it did as a sentence, the app, and how it ended. */
export interface TaskUse {
  action: ActionType;
  says: string;
  app: string | null;
  outcome: UseOutcome;
}

/** The permission a press of this risk class falls under (plan section 3); a safe press needs none of these. */
/** A system prompt falls under "Money, passwords, system dialogs", which is always handed off (B22). */
const RISK_ACTION: Record<Exclude<RiskClass, "safe">, ActionType> = { outbound: "outbound", destructive: "destructive", money: "sensitive", system: "sensitive" };

/** How a run was started. Only a run from an accepted offer may hold an act grant. */
export interface RunOptions {
  /**
   * The user accepted an offer that starts this task, so the reader may act for it in the one window the
   * task binds. Without it the reader acts only in `--act-pids` processes, which exist only in tests.
   */
  grant?: boolean;
  /**
   * A skill started the run from its trigger without a Tab (B19), under the agreement the user gave when
   * it was promoted. Every taskProgress of the task says so, for the host's toast.
   */
  unprompted?: boolean;
}

export type Outcome = "done" | "stopped" | "handoff" | "paused";

export interface TaskEvent {
  taskId: string;
  /** The plan's title, as the task's sentence. */
  title: string;
  phase: TaskPhase;
  step: number | null;
  steps: number;
  says: string | null;
  detail: string | null;
  /** Who caused a pause or stop; null for phases Caret reaches on its own way through the plan. */
  cause: TaskCause | null;
  /** End states not yet reached. */
  remaining: string[];
  undoable: boolean;
  /** The first window the plan bound, for the activity row. */
  window: { app: AppRef; windowId: string; title: string; frame: Frame | null } | null;
}

/**
 * Why a run must stop at its next step boundary. `takeOver` is a pause that hands the run back to the user.
 * `revoked`: a stop because something the task depended on changed (Executor.revoke), said in the stop's detail.
 */
interface Interrupt {
  kind: "pause" | "stop";
  by: "input" | "control" | "takeOver";
  why: string;
  revoked?: Revocation;
}

export interface TaskResult {
  taskId: string;
  outcome: Outcome;
  /** The step the run ended or paused at; null when done. */
  step: number | null;
  detail: string | null;
  acted: number;
  skipped: number;
  jevCalls: number;
}

/** One undo ledger entry. Writes record the value they replaced; presses are recorded as not undoable. */
/** The numbers a done or undone taskProgress carries beside its sentence, and a calendar hand-off's reason. */
type ProgressCounts = Pick<TaskProgress, "written" | "restored" | "notRestored" | "notUndoablePresses"> & { blocked?: CalendarBlock };

export type LedgerEntry =
  | { kind: "write"; step: number; pid: number; windowId: string; key: string; role: string; before: string; after: string }
  | { kind: "calendar"; step: number; eventId: string; calendar: string; title: string; start: string; end: string }
  | { kind: "press"; step: number; label: string; windowId: string };

export interface UndoResult {
  restored: number;
  notRestored: { step: number; reason: string }[];
  notUndoable: number;
}

/**
 * The writes tried, in order, after a value write that answered ok and changed nothing (B15, B20), each with
 * what it does in words for the activity feed.
 */
const FALLBACKS = [
  { name: "focusValue", does: "focus the field, then write the value" },
  { name: "insert", does: "focus, select all and replace" },
] as const;

/** How many re-reads a press or URL gets to show its effect, and the pause between them. Assumed, not measured. */
const EFFECT_POLLS = 4;
/** Extra tries for a failed walk. One cut-short walk in 20 shipping runs stopped a run on a loaded Mac. */
const WALK_RETRIES = 2;
const EFFECT_POLL_MS = 150;

interface Task {
  id: string;
  plan: Plan;
  /** Window selector (as JSON) to windowId, fixed when first resolved. */
  windows: Map<string, string>;
  /** Per window, the text each editable field should hold: what the task saw at the start, plus its own writes. */
  expected: Map<string, Map<string, string>>;
  next: number;
  ledger: LedgerEntry[];
  interrupt: Interrupt | null;
  acted: number;
  skipped: number;
  jevCalls: number;
  finished: Outcome | null;
  /** Resolved targets, keyed by step index and the target's JSON, so a step's end target and its press target never share an entry. */
  resolved: Map<string, Resolution>;
  /** The reader session the task's window ids belong to. */
  session: number;
  /** True while undo is restoring this task's writes. */
  undoing: boolean;
  /** Why an undo under way was stopped (the user stopped or took it over, Caret was paused, the host left), or null: the restores not yet made are left as they are. */
  undoStopped: string | null;
  /**
   * Slot values the plan copied from windows, by the window's id (Plan.sources), each with its window as
   * the task found it: a target question charges that window for the value even after it has closed.
   */
  sourced: { text: string; windowId: string; window: WindowState | undefined }[];
  /** Started from an accepted offer, so it may hold an act grant. */
  granted: boolean;
  /** Started by a skill with no Tab (RunOptions.unprompted). */
  unprompted: boolean;
  /** The act grant the reader holds for this task now, or null. One window per task. */
  grant: { pid: number; windowId: string } | null;
  /** The reader holds a calendar grant for this task now (protocol.ts CalendarGrant). */
  calendarGranted: boolean;
  /**
   * The window the user was in when the run started: writes there use "Write where you are", writes to any
   * other window "Reversible write elsewhere". Null when the model knows no frontmost window.
   */
  userWindow: string | null;
  /** Ledger entries already reported as uses, so a resumed run reports each once. */
  reported: Set<LedgerEntry>;
  /** The press or field a hand-off left to the user, with the permission it falls under; null when none. */
  handedOff: { action: ActionType; what: string; windowId: string } | null;
}

/**
 * Lets go of the source windows a task kept, once it can no longer ask a target question: tasks stay in
 * the executor's map for undo, which needs only the write ledger, and a kept window holds all its nodes.
 */
function releaseSources(task: Task): void {
  task.sourced = task.sourced.map((v) => ({ ...v, window: undefined }));
}

class StepStop extends Error {
  readonly outcome: "stopped" | "handoff";
  /** Why, on a stop; a handoff has none (protocol.ts StopReason). */
  readonly reason: StopReason | null;
  /** A stop caused by the screen changing under the task, not by a mismatch after Caret acted. */
  readonly by: TaskCause;
  /** On a hand-off from the calendar: what the user has to give. */
  readonly blocked: CalendarBlock | null;
  private constructor(outcome: "stopped" | "handoff", reason: StopReason | null, message: string, by: TaskCause, blocked: CalendarBlock | null = null) {
    super(message);
    this.outcome = outcome;
    this.reason = reason;
    this.by = by;
    this.blocked = blocked;
  }

  static stop(reason: StopReason, message: string, by: TaskCause = "caret"): StepStop {
    return new StepStop("stopped", reason, message, by);
  }

  static handoff(message: string, blocked: CalendarBlock | null = null): StepStop {
    return new StepStop("handoff", null, message, "caret", blocked);
  }
}

/** Thrown at a step boundary when the task has a pending interrupt. */
class Interrupted extends Error {}

export class Executor {
  private readonly tasks = new Map<string, Task>();
  /** Every Jev target question this executor asked, for evaluation. Holds element keys, not screen text. */
  readonly targetChoices: { taskId: string; step: number; chose: string | null; jev: JevTrace }[] = [];
  /** Bumped when a new reader connects: window ids start over, so older tasks may no longer act or undo. */
  private session = 0;
  /** The pid set the reader was last asked to watch, as a sorted list. */
  private watching = "";
  private readonly deps: ExecutorDeps;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** A new reader numbers windows from scratch; every existing task's window ids now mean nothing. */
  readerRestarted(): void {
    this.session++;
    // The reader dropped every grant with the old connection.
    for (const t of this.tasks.values()) {
      t.grant = null;
      t.calendarGranted = false;
    }
  }

  /** Whether a run with this id exists, running or finished. */
  has(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  /** Whether a run with this id is under way or paused, so a working line for it is still open. */
  live(taskId: string): boolean {
    const t = this.tasks.get(taskId);
    return t !== undefined && (t.finished === null || t.finished === "paused");
  }

  ledger(taskId: string): readonly LedgerEntry[] {
    return this.tasks.get(taskId)?.ledger ?? [];
  }

  /**
   * Validates the plan, fills its slots, and runs it from the first step. `expect` names field values,
   * by window id and key, that must still hold when the task first reads each window: an offer checked
   * its fields empty when the user took it, and a value typed while the first walk was under way must
   * stop the run, not become the value the write expects and replaces.
   */
  async run(taskId: string, rawPlan: unknown, slots: Record<string, string>, expect?: Record<string, Record<string, string>>, opts: RunOptions = {}): Promise<TaskResult> {
    if (this.tasks.has(taskId)) throw new PlanError(`task ${taskId} already exists`);
    const parsed = Plan.safeParse(rawPlan);
    if (!parsed.success) throw new PlanError(`invalid plan: ${parsed.error.message.slice(0, 400)}`);
    const plan = fillSlots(parsed.data, slots);
    const task: Task = {
      id: taskId,
      plan,
      windows: new Map(),
      expected: new Map(),
      next: 0,
      ledger: [],
      interrupt: null,
      acted: 0,
      skipped: 0,
      jevCalls: 0,
      finished: null,
      resolved: new Map(),
      session: this.session,
      undoing: false,
      undoStopped: null,
      sourced: Object.entries(parsed.data.sources ?? {}).flatMap(([slot, windowId]) => {
        const text = slots[slot];
        return text === undefined ? [] : [{ text, windowId, window: this.deps.model.windows.get(windowId) }];
      }),
      granted: opts.grant === true,
      unprompted: opts.unprompted === true,
      grant: null,
      calendarGranted: false,
      userWindow: this.userWindow(),
      reported: new Set(),
      handedOff: null,
    };
    for (const [windowId, values] of Object.entries(expect ?? {})) task.expected.set(windowId, new Map(Object.entries(values)));
    this.tasks.set(taskId, task);
    this.progress(task, "started", null, null);
    return this.loop(task);
  }

  /** Continues a paused task from the step it paused at, accepting whatever the user changed meanwhile. */
  async resume(taskId: string): Promise<TaskResult> {
    const no = this.resumeRefusal(taskId);
    if (no !== null) throw new PlanError(no);
    const task = this.need(taskId);
    task.interrupt = null;
    task.finished = null;
    task.expected.clear();
    return this.loop(task);
  }

  /** Why the task cannot be resumed now, or null. */
  resumeRefusal(taskId: string): string | null {
    const task = this.tasks.get(taskId);
    if (task === undefined) return `no task ${taskId}`;
    if (task.finished !== "paused") return `task ${taskId} is ${task.finished ?? "running"}, not paused`;
    return null;
  }

  /**
   * Why the task cannot be undone now, or null: it is unknown, running or already being undone, its window ids
   * belong to an earlier reader, or Caret may not act at all now (paused, or the host that asked is gone). An
   * undo is the user's own request about the task, so the permissions it ran under are not asked again.
   */
  undoRefusal(taskId: string): string | null {
    const task = this.tasks.get(taskId);
    if (task === undefined) return `no task ${taskId}`;
    if (task.finished === null) return `task ${taskId} is still running`;
    if (task.undoing) return `task ${taskId} is already being undone`;
    if (task.session !== this.session) return `task ${taskId} ran under an earlier reader session; its window ids no longer apply, so nothing is restored`;
    const r = this.undoBlocked(task);
    return r === null ? null : `nothing was restored: ${r.why}`;
  }

  /** What stops an undo, before it starts and before each restore: Caret's general checks only (`authorize` with no action). */
  private undoBlocked(task: Task): Revocation | null {
    return this.deps.authorize?.({ taskId: task.id, unprompted: false, action: null }) ?? null;
  }

  /**
   * Real input from the reader: pause any task acting in that window. The grant ends here, not at the next
   * step boundary (S1 audit #3): a write already queued in the reader behind a slow call is refused there.
   */
  onUserInput(m: UserInput): void {
    for (const task of this.tasks.values()) {
      if (task.finished !== null || task.interrupt?.kind === "stop") continue;
      for (const windowId of task.windows.values()) {
        const w = this.deps.model.windows.get(windowId);
        if (w === undefined || w.app.pid !== m.pid) continue;
        const inside = m.kind === "mouse" ? m.point !== null && w.window.frame !== null && contains(w.window.frame, m.point) : w.focused;
        if (!inside) continue;
        task.interrupt = { kind: "pause", by: "input", why: `${m.kind === "key" ? "typing" : "a click"} in '${w.window.title}'` };
        this.revokeGrant(task);
      }
    }
  }

  /**
   * Pauses a running task; the running `run` or `resume` call then resolves as paused at its next step
   * boundary. Every pause ends the grant at once, as a take-over and a stop do (S1 audit #3): the user has
   * the window from the moment they ask, so an act already on its way to the reader is refused there. An
   * act the reader has already dispatched to the app cannot be called back. `takeOver` hands the run back
   * to the user: the paused phase names the step it reached. Taking over an already paused task reports it
   * again as handed back. A pause for `input` (the host saw the user's own input) leaves a pending pause
   * from the reader's userInput as it is, since that one names what the user did and where; a userInput
   * after it replaces its wording in turn.
   */
  pause(taskId: string, takeOver: boolean, reason?: "input"): void {
    const task = this.need(taskId);
    if (takeOver && task.undoing) return this.stopUndo(task);
    const by = takeOver ? "takeOver" : reason ?? "control";
    if (task.finished === "paused") {
      if (takeOver) this.progress(task, "paused", this.stepAt(task), this.pauseDetail(task, { kind: "pause", by, why: "" }), "you");
      return;
    }
    if (task.finished !== null) throw new PlanError(`task ${taskId} is ${task.finished}; there is nothing to pause`);
    if (task.interrupt?.kind === "stop" || (by === "input" && task.interrupt?.by === "input")) return;
    task.interrupt = { kind: "pause", by, why: takeOver ? "you took over" : by === "input" ? "your input" : "you paused it" };
    this.revokeGrant(task);
  }

  /** Ends a running task at its next step boundary, or a paused one now. What it wrote stays; undo restores it. */
  stop(taskId: string): void {
    const task = this.need(taskId);
    if (task.undoing) return this.stopUndo(task);
    if (task.finished === "paused") {
      task.finished = "stopped";
      releaseSources(task);
      this.stopped(task, this.stepAt(task), `stopped by you ${this.boundary(task)}`, "you", "you");
      this.reportUses(task, "stopped");
      return;
    }
    if (task.finished !== null) throw new PlanError(`task ${taskId} is ${task.finished}; there is nothing to stop`);
    task.interrupt = { kind: "stop", by: "control", why: "you stopped it" };
    this.revokeGrant(task);
  }

  /**
   * Ends a task because something it depended on changed (S1 audit #4, #5): its grant now, so an act
   * already on its way is refused, and the run at its next step boundary, as stopped with `r.why`. A paused
   * task stops now; an undo under way stops its remaining restores, as a stop does. A finished task holds no
   * grant and is left as it is.
   */
  revoke(taskId: string, r: Revocation): void {
    const task = this.tasks.get(taskId);
    if (task === undefined) return;
    if (task.undoing) return this.stopUndo(task, r.why);
    if (task.finished === "paused") {
      task.finished = "stopped";
      releaseSources(task);
      this.stoppedBy(task, r);
      this.reportUses(task, "stopped");
      return;
    }
    if (task.finished !== null || task.interrupt?.kind === "stop") return;
    task.interrupt = { kind: "stop", by: "control", why: r.why, revoked: r };
    this.revokeGrant(task);
  }

  /**
   * Asks `authorize` again about every task that may still act, after a change to what tasks depend on (the
   * user's settings, a permission, a skill or memory entry, a host session): Caret's general checks, the
   * permission of every window its remaining steps act in, as that window stands to the user now, and every
   * memory entry a remaining step copies. A task that fails any of them is revoked.
   */
  recheck(): void {
    for (const task of this.tasks.values()) {
      if (task.undoing) {
        const r = this.undoBlocked(task);
        if (r !== null) this.stopUndo(task, r.why);
        continue;
      }
      if (task.finished !== null && task.finished !== "paused") continue;
      const r = this.dependencyBroken(task);
      if (r !== null) this.revoke(task.id, r);
    }
  }

  private dependencyBroken(task: Task): Revocation | null {
    const authorize = this.deps.authorize;
    const ask = (action: ActionType | null): Revocation | null => authorize?.({ taskId: task.id, unprompted: task.unprompted, action }) ?? null;
    const general = ask(null);
    if (general !== null) return general;
    for (const step of task.plan.steps.slice(task.next)) {
      const end = step.end;
      if (end.kind === "calendarEvent") {
        const r = ask("writeElsewhere");
        if (r !== null) return r;
        continue;
      }
      const windowId = task.windows.get(JSON.stringify(end.window));
      if (windowId !== undefined) {
        const r = ask(this.actionIn(windowId));
        if (r !== null) return r;
      }
      if (step.memory !== undefined && end.kind === "valueEquals" && this.deps.memoryHolds?.(step.memory, end.value) !== true) {
        return { why: `what you told Caret for '${step.says}' changed or is gone`, by: "you" };
      }
    }
    return null;
  }

  /** The permission an act in this window falls under now: "Write where you are" in the window the user is in, "Reversible write elsewhere" anywhere else. */
  private actionIn(windowId: string | null): ActionType {
    return windowId !== null && windowId === this.userWindow() ? "writeHere" : "writeElsewhere";
  }

  /**
   * Asked right before an act is dispatched: a task whose dependency broke since the last check (the user
   * moved to another window, turning a write where they are into a write elsewhere, or changed a permission)
   * is revoked, and the run stops here rather than acting.
   */
  private authorizeAct(task: Task, windowId: string | null): void {
    const r = this.deps.authorize?.({ taskId: task.id, unprompted: task.unprompted, action: this.actionIn(windowId) }) ?? null;
    if (r === null) return;
    this.revoke(task.id, r);
    throw new Interrupted();
  }

  /** The stopped phase of a revoked task: who caused it, and why in the detail. */
  private stoppedBy(task: Task, r: Revocation): string {
    const detail = `stopped ${this.boundary(task)}: ${r.why}`;
    this.stopped(task, this.stepAt(task), detail, r.by === "you" ? "you" : "caret", r.by === "you" ? "you" : "error");
    return detail;
  }

  /** Ends an undo under way: its grant now, so a restore already sent is refused, and the rest are not tried, each for `why`. */
  private stopUndo(task: Task, why = "you stopped the undo"): void {
    if (task.undoStopped === null) task.undoStopped = why;
    this.revokeGrant(task);
  }

  private need(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new PlanError(`no task ${taskId}`);
    return task;
  }

  /** Throws at a step boundary when a pause or stop is pending. */
  private checkInterrupt(task: Task): void {
    if (task.interrupt !== null) throw new Interrupted();
  }

  /** The step a run stands before, or null once it is past the last one. */
  private stepAt(task: Task): number | null {
    return task.next < task.plan.steps.length ? task.next : null;
  }

  /** Where a run stands between steps, in words: before a step, or after the last one. */
  private boundary(task: Task): string {
    const n = task.plan.steps.length;
    return task.next >= n ? `after the last of ${n} steps` : `before step ${task.next + 1} of ${n}`;
  }

  private pauseDetail(task: Task, it: Interrupt): string {
    const where = this.boundary(task);
    if (it.by === "takeOver") return `Caret handed this back to you ${where}`;
    return `paused ${where}: ${it.why}`;
  }

  /**
   * Restores every write of a task, newest first, each only if the field still holds what the task
   * wrote. Calendar events are removed only if unchanged. Presses cannot be undone and are counted.
   */
  async undo(taskId: string): Promise<UndoResult> {
    const no = this.undoRefusal(taskId);
    if (no !== null) throw new PlanError(no);
    const task = this.need(taskId);
    // A paused run whose writes are being restored cannot continue from where it was, so it stops
    // being resumable before the first restore is awaited.
    if (task.finished === "paused") {
      task.finished = "stopped";
      this.reportUses(task, "stopped");
    }
    releaseSources(task);
    task.undoing = true;
    task.undoStopped = null;
    // The run is over; a stop or pause still pending from it (a write that ended in axError) is not this undo's.
    task.interrupt = null;
    const out: UndoResult = { restored: 0, notRestored: [], notUndoable: 0 };
    const remaining: LedgerEntry[] = [];
    // Undo is the user's own request about this task, so a task that held a grant gets one again, for
    // the window its writes went to, until the restore ends.
    const written = task.ledger.find((e) => e.kind === "write");
    if (written !== undefined) this.issueGrant(task, written.pid, written.windowId);
    if (task.ledger.some((e) => e.kind === "calendar")) this.issueCalendarGrant(task);
    try {
      for (const e of [...task.ledger].reverse()) {
        if (e.kind === "press") {
          out.notUndoable++;
          remaining.push(e);
          continue;
        }
        // Caret paused, or the host gone, since the last restore: the rest are left as they are.
        const blocked = task.undoStopped === null ? this.undoBlocked(task) : null;
        if (blocked !== null) this.stopUndo(task, blocked.why);
        const reason =
          task.session !== this.session
            ? "the reader restarted during undo"
            : task.undoStopped !== null
              ? task.undoStopped
              : e.kind === "write"
                ? await this.undoWrite(task, e)
                : await this.undoCalendar(task, e);
        if (reason === null) out.restored++;
        else {
          out.notRestored.push({ step: e.step, reason });
          remaining.push(e);
        }
      }
      task.ledger = remaining.reverse();
    } finally {
      task.undoing = false;
      this.revokeGrant(task);
    }
    const detail = `restored ${out.restored}; not restored ${out.notRestored.length}; presses not undoable ${out.notUndoable}`;
    this.progress(task, "undone", null, detail, null, { restored: out.restored, notRestored: out.notRestored.length, notUndoablePresses: out.notUndoable });
    return out;
  }

  // MARK: - the loop

  private async loop(task: Task): Promise<TaskResult> {
    const steps = task.plan.steps;
    try {
      // Every window the plan names is read now, so a field that changes under the task later is
      // caught even in a window the first steps do not touch. A window that does not exist yet is
      // bound when a step first needs it.
      for (const sel of planWindows(task.plan)) {
        try {
          await this.refresh(task, sel);
        } catch (e) {
          if (!(e instanceof StepStop && e.message.startsWith("no window matches"))) throw e;
        }
      }
      await this.updateWatch();
      while (task.next < steps.length) {
        const i = task.next;
        const step = steps[i] as Step;
        this.checkInterrupt(task);
        await this.deps.beforeStep?.(task.id, i);
        this.checkInterrupt(task);
        await this.updateWatch();
        await this.runStep(task, i, step);
        task.next = i + 1;
      }
      // A take over, pause or stop that came in while the last act was on its way: the act landed and stays
      // in the ledger for undo, but the run ends as the user asked rather than as done (B19 review: a skill
      // must not count a run the user interrupted as clean).
      this.checkInterrupt(task);
      task.finished = "done";
      // Fields this run wrote, each once however many writes it took; presses and calendar events are not fields.
      const written = new Set(task.ledger.flatMap((e) => (e.kind === "write" ? [`${e.windowId}\u0000${e.key}`] : []))).size;
      this.progress(task, "done", null, `${task.acted} acted, ${task.skipped} already true`, null, { written });
      this.reportUses(task, "done");
      return this.result(task, "done", null, null);
    } catch (e) {
      const i = task.next;
      const it = task.interrupt;
      if (e instanceof Interrupted && it !== null) {
        task.interrupt = null;
        const at = this.stepAt(task);
        if (it.kind === "stop") {
          task.finished = "stopped";
          let detail: string;
          if (it.revoked === undefined) {
            detail = `stopped by you ${this.boundary(task)}`;
            this.stopped(task, at, detail, "you", "you");
          } else detail = this.stoppedBy(task, it.revoked);
          this.reportUses(task, "stopped");
          return this.result(task, "stopped", at, detail);
        }
        const detail = this.pauseDetail(task, it);
        task.finished = "paused";
        this.progress(task, "paused", at, detail, "you");
        return this.result(task, "paused", at, detail);
      }
      const outcome = e instanceof StepStop ? e.outcome : "stopped";
      const detail = e instanceof Error ? e.message : String(e);
      task.finished = outcome;
      if (outcome === "handoff") this.progress(task, "handoff", i, detail, e instanceof StepStop ? e.by : "caret", e instanceof StepStop && e.blocked !== null ? { blocked: e.blocked } : {});
      else this.stopped(task, i, detail, e instanceof StepStop ? e.by : "caret", e instanceof StepStop ? (e.reason ?? "error") : "error");
      this.reportUses(task, outcome);
      return this.result(task, outcome, i, detail);
    } finally {
      if (task.finished !== null && task.finished !== "paused") releaseSources(task);
      // Done, handed off, stopped or paused: nothing more is done for the task until the user resumes it.
      if (task.finished !== null) this.revokeGrant(task);
      await this.updateWatch();
    }
  }

  /** Asks the reader to report real input in every process a running task acts in, and nothing else. */
  private async updateWatch(): Promise<void> {
    const pids = new Set<number>();
    for (const t of this.tasks.values()) {
      if (t.finished !== null) continue;
      for (const id of t.windows.values()) {
        const w = this.deps.model.windows.get(id);
        if (w !== undefined) pids.add(w.app.pid);
      }
    }
    const key = [...pids].sort((a, b) => a - b).join(",");
    if (key === this.watching) return;
    const r = await this.deps.reader.run({ kind: "watchInput", pids: [...pids] });
    // Without the watch the run would not pause on real input, so a failure is not ignored.
    if (r.outcome !== "ok") throw StepStop.stop("reader", `the reader cannot watch for input: ${r.outcome}`);
    this.watching = key;
  }

  private async runStep(task: Task, i: number, step: Step): Promise<void> {
    const end = step.end;
    if (end.kind === "calendarEvent") return this.calendarStep(task, i, end);

    const w = await this.refresh(task, end.window);
    if (await this.holds(task, i, w, end)) {
      task.skipped++;
      this.progress(task, "skipped", i, "already true");
      return;
    }
    if (end.kind === "windowFocused") return this.raiseStep(task, i, w, step);
    if (end.kind === "handoff") {
      const node = await this.resolve(task, i, w, end.target, step.says);
      const label = (node.label ?? "").trim();
      const what = label === "" ? end.target.describe : `'${label}'`;
      // The control's own label decides the reason, as for a press: a plan cannot call a Send press unverifiable.
      const risk = classifyPress({ label, windowKind: w.window.kind, bundleId: w.app.bundleId });
      if (risk !== "safe") task.handedOff = { action: RISK_ACTION[risk], what, windowId: w.window.windowId };
      throw StepStop.handoff(risk === "safe" ? `Caret cannot check what pressing ${what} changes, so it leaves that press to you` : `${what} reads as ${risk}; Caret leaves that press to you`);
    }

    if (end.kind === "valueEquals" || end.kind === "focused") {
      const node = await this.resolve(task, i, w, end.target, step.says);
      if (end.kind === "valueEquals" && node.editable === true) return this.writeStep(task, i, w, node, "value", end.value, step);
      if (end.kind === "focused" && step.via === undefined) return this.writeStep(task, i, w, node, "focused", "", step);
    }
    if (step.via === undefined) throw StepStop.stop("unreachable", `no means to reach '${step.says}': the target is not a field and the step names no press or URL`);
    if (step.via.kind === "press") return this.pressStep(task, i, w, step.via.target, step);
    return this.urlStep(task, i, w, step.via.url, step);
  }

  // MARK: - means

  private async writeStep(task: Task, i: number, w: WindowState, node: Node, attribute: "value" | "focused", value: string, step: Step): Promise<void> {
    if (node.states?.includes("secure")) {
      task.handedOff = { action: "sensitive", what: "a password field", windowId: w.window.windowId };
      throw StepStop.handoff(`'${step.says}' targets a password field; that is left to you`);
    }
    const before = node.value ?? "";
    const prediction = attribute === "value" ? `${node.key}: '${clip(before)}' becomes '${clip(value)}'` : `${node.key} becomes focused`;
    this.checkInterrupt(task);
    this.progress(task, "acting", i, `write ${attribute}; expect ${prediction}`);
    const verb: ReaderVerb = { kind: "write", pid: w.app.pid, windowId: w.window.windowId, key: node.key, role: node.role, attribute, expect: before, value, taskId: task.id };
    await this.deps.beforeAct?.(task.id, i);
    const sent = async (v: ReaderVerb): Promise<Change[]> => {
      // A value from memory must still be what its entry holds at each dispatch, the insert fallback's
      // included, after everything awaited before it: the user may forget or pause the entry mid-run.
      if (step.memory !== undefined && this.deps.memoryHolds?.(step.memory, value) !== true) {
        throw StepStop.stop("changed", `what you told Caret for '${step.says}' changed or is gone, so Caret did not write it`);
      }
      try {
        return await this.act(task, v, w.window.windowId);
      } catch (e) {
        // An axError may come after the value was set (a timeout while the reader settles and re-walks),
        // so the write is recorded as if it happened. Undo restores it only if the field holds `value`.
        if (attribute === "value" && e instanceof StepStop && e.message.includes("axError")) {
          task.ledger.push({ kind: "write", step: i, pid: w.app.pid, windowId: w.window.windowId, key: node.key, role: node.role, before, after: value });
        }
        throw e;
      }
    };
    let seen = await sent(verb);
    // A field the walk lost right after the write (B15's WebKit window) is read once more before it is judged.
    if (attribute === "value" && this.window(w.window.windowId).nodes.get(node.key) === undefined) seen = [...seen, ...(await this.walk(this.window(w.window.windowId)))];
    // B15, B20: a web view whose window is not key answers a value write with ok and changes nothing. It takes
    // the value once the field has focus (focusValue, 3 of 3 in B20's candidate table); insert (focus, select
    // all, replace) is the last means. Each runs only when the one before changed nothing, and the comparison
    // below checks whichever landed.
    for (const fallback of attribute === "value" ? FALLBACKS : []) {
      if (!this.dropped(w.window.windowId, node.key, before, seen)) break;
      // Something else at work in the window stops the run before Caret writes again.
      this.checkUnexpected(seen, node.key);
      this.checkInterrupt(task);
      this.progress(task, "acting", i, `${fallback.name}; the write before it changed nothing, so ${fallback.does}; expect ${prediction}`);
      seen = [...seen, ...(await sent({ ...verb, attribute: fallback.name }))];
      // A WebKit window that is not key can leave the field out of the walk right after a write (B15: the
      // field read as gone); one more read tells a field that is back from one that really went.
      if (this.window(w.window.windowId).nodes.get(node.key) === undefined) seen = [...seen, ...(await this.walk(this.window(w.window.windowId)))];
      // A write that landed is judged and goes in the ledger below before any pause is honoured, so undo has it.
      if (!this.dropped(w.window.windowId, node.key, before, seen)) break;
      // A pause, stop or take-over that came in meanwhile is the user's word on the run, not a hand-off.
      this.checkSession(task);
      this.checkInterrupt(task);
    }
    if (attribute === "value") {
      // Every means answered ok and the field holds what it held: this app takes no text written these ways.
      // Nothing was written, so the field is the user's to fill, said plainly, not a failed run.
      if (this.dropped(w.window.windowId, node.key, before, seen)) {
        this.checkUnexpected(seen, node.key);
        const label = (node.label ?? "").trim();
        const field = label === "" ? "this field" : `the ${label} field`;
        const here = w.window.windowId === task.userWindow;
        task.handedOff = { action: here ? "writeHere" : "writeElsewhere", what: field, windowId: w.window.windowId };
        throw StepStop.handoff(`${w.app.name} did not take the text for ${field}${here ? "" : " while its window was in the background"}, so Caret left it to you`);
      }
    }

    const after = this.window(w.window.windowId);
    const now = after.nodes.get(node.key);
    if (attribute === "value") {
      // The reader wrote, so the write goes in the ledger before it is judged: an app that reformats
      // the value fails the comparison but must still be undoable. `after` is what the field holds now.
      if (now !== undefined && (now.value ?? "") !== before) {
        task.ledger.push({ kind: "write", step: i, pid: w.app.pid, windowId: w.window.windowId, key: node.key, role: node.role, before, after: now.value ?? "" });
      }
      // A field the walk lost and then found again (B15's WebKit window) comes back as an added node holding the value.
      const recorded = seen.some((c) => (c.kind === "value" || (c.kind === "added" && seen.some((r) => r.kind === "removed" && r.key === node.key))) && c.key === node.key && c.after === value);
      if (now === undefined || (now.value ?? "") !== value || !recorded) {
        throw StepStop.stop("mismatch", `mismatch: expected ${prediction}; the field now holds '${clip(now?.value ?? "(gone)")}'`);
      }
      this.expectedFor(task, w.window.windowId).set(node.key, value);
    } else if (after.focusedKey !== node.key) {
      throw StepStop.stop("mismatch", `mismatch: expected ${prediction}; focus is on ${after.focusedKey ?? "nothing"}`);
    }
    this.checkUnexpected(seen, attribute === "value" ? node.key : null);
    await this.verified(task, i, step);
  }

  private async pressStep(task: Task, i: number, w: WindowState, target: Target, step: Step): Promise<void> {
    const node = await this.resolve(task, i, w, target, step.says);
    const label = (node.label ?? "").trim();
    const risk = classifyPress({ label, windowKind: w.window.kind, bundleId: w.app.bundleId });
    if (risk === "system") {
      task.handedOff = { action: RISK_ACTION.system, what: label === "" ? "a control" : `'${label}'`, windowId: w.window.windowId };
      throw StepStop.handoff(`${label === "" ? "This control" : `'${label}'`} is in a system prompt; Caret leaves that press to you`);
    }
    if (label === "") throw StepStop.handoff(`the control for '${step.says}' has no label, so its effect cannot be classified; press it yourself`);
    if (risk !== "safe") {
      task.handedOff = { action: RISK_ACTION[risk], what: `'${label}'`, windowId: w.window.windowId };
      throw StepStop.handoff(`'${label}' reads as ${risk}; Caret leaves that press to you`);
    }
    this.checkInterrupt(task);
    this.progress(task, "acting", i, `press '${label}'; expect: ${step.says}`);
    await this.deps.beforeAct?.(task.id, i);
    const seen = await this.act(task, { kind: "press", pid: w.app.pid, windowId: w.window.windowId, key: node.key, role: node.role, label, taskId: task.id }, w.window.windowId);
    task.ledger.push({ kind: "press", step: i, label, windowId: w.window.windowId });
    await this.awaitEffect(task, i, step, w.window.windowId, seen);
    this.checkUnexpected(seen, null);
    await this.verified(task, i, step);
  }

  /** Brings the window to the front. Nothing is written, so nothing goes in the ledger. */
  private async raiseStep(task: Task, i: number, w: WindowState, step: Step): Promise<void> {
    this.checkInterrupt(task);
    this.progress(task, "acting", i, `raise; expect '${clip(w.window.title)}' in ${w.app.name} to be the focused window`);
    await this.deps.beforeAct?.(task.id, i);
    const seen = await this.act(task, { kind: "raise", pid: w.app.pid, windowId: w.window.windowId, taskId: task.id }, w.window.windowId);
    await this.awaitEffect(task, i, step, w.window.windowId, seen);
    this.checkUnexpected(seen, null);
    await this.verified(task, i, step);
  }

  private async urlStep(task: Task, i: number, w: WindowState, url: string, step: Step): Promise<void> {
    if (this.deps.urls === null) throw StepStop.stop("notConfigured", "no URL opener is configured");
    this.checkInterrupt(task);
    this.progress(task, "acting", i, `open ${url}; expect: ${step.says}`);
    await this.deps.urls.open(url);
    await this.awaitEffect(task, i, step, w.window.windowId, []);
    await this.verified(task, i, step);
  }

  private async calendarStep(task: Task, i: number, end: Extract<EndState, { kind: "calendarEvent" }>): Promise<void> {
    try {
      await this.calendarAct(task, i, end);
    } catch (e) {
      // No Calendar access or no local account is the user's to give: a hand-off that says which.
      if (e instanceof CalendarBlocked) throw StepStop.handoff(e.message, e.reason);
      if (e instanceof CalendarRefused) throw StepStop.stop("reader", e.message);
      throw e;
    }
  }

  private async calendarAct(task: Task, i: number, end: Extract<EndState, { kind: "calendarEvent" }>): Promise<void> {
    const cal = this.deps.calendar;
    if (cal === null) throw StepStop.stop("notConfigured", "no calendar is configured");
    if ((await cal.find(end.calendar, end.title, end.start, end.end)) !== null) {
      task.skipped++;
      this.progress(task, "skipped", i, "already true");
      return;
    }
    this.checkInterrupt(task);
    this.progress(task, "acting", i, `add event '${end.title}' to ${end.calendar}; expect it to be found there`);
    this.checkSession(task);
    this.authorizeAct(task, null);
    // Only a task from an accepted offer gets one; without it the reader refuses the add.
    this.issueCalendarGrant(task);
    let ev: Awaited<ReturnType<CalendarPort["add"]>>;
    try {
      ev = await cal.add(end.calendar, end.title, end.start, end.end, task.id);
    } catch (e) {
      // An add whose answer was lost (no answer in time, axError) may still have been saved: if the event is
      // there now, it goes in the ledger so undo can remove it, and the run still stops on the error. Any
      // other refusal (an identical event another task added) means this task added nothing.
      if (e instanceof CalendarRefused && e.outcome === "axError") {
        const late = await cal.find(end.calendar, end.title, end.start, end.end).catch(() => null);
        if (late !== null) task.ledger.push({ kind: "calendar", step: i, eventId: late.id, calendar: late.calendar, title: late.title, start: late.start, end: late.end });
      }
      throw e;
    }
    // In the ledger before it is checked, so undo can remove an event that fails the check.
    task.ledger.push({ kind: "calendar", step: i, eventId: ev.id, calendar: ev.calendar, title: ev.title, start: ev.start, end: ev.end });
    const found = await cal.find(end.calendar, end.title, end.start, end.end);
    if (found === null || found.id !== ev.id) throw StepStop.stop("mismatch", "mismatch: the added event is not found by the same query");
    task.acted++;
    this.progress(task, "verified", i, null);
  }

  // MARK: - acting and comparing

  /** Sends a verb and returns every change the model recorded while it ran. */
  private async act(task: Task, verb: ReaderVerb, windowId: string): Promise<Change[]> {
    this.checkSession(task);
    // The last boundary: a pause or stop that arrived while the step published or prepared its act.
    this.checkInterrupt(task);
    if (verb.kind === "write" || verb.kind === "press" || verb.kind === "raise") this.authorizeAct(task, windowId);
    const seen: Change[] = [];
    const off = this.deps.onChanges((cs) => {
      for (const c of cs) if (c.windowId === windowId) seen.push(c);
    });
    try {
      const r = await this.deps.reader.run(verb);
      // A pause, stop or take-over came in while the verb was on its way (a stop or take-over also revoked
      // the grant, so the reader refused). The reader acted on none of these outcomes, so the run ends as the
      // user asked, not as a reader failure. An axError may follow an act that landed, so it keeps its path.
      if (r.outcome !== "ok" && r.outcome !== "axError" && task.interrupt !== null) throw new Interrupted();
      if (r.outcome !== "ok") throw StepStop.stop("reader", `the reader refused: ${r.outcome}${r.detail === null ? "" : ` (${r.detail})`}`);
    } finally {
      off();
    }
    return seen;
  }

  // MARK: - act grants

  /**
   * Gives the reader a grant for this task's window, if the task may hold one and does not already hold
   * one. The first window a task binds gets the grant; acts in any other window are refused by the reader.
   * None is issued while a pause or stop is pending, so a stop's revoke is not undone by the next read.
   */
  private issueGrant(task: Task, pid: number, windowId: string): void {
    if (!task.granted || task.grant !== null || task.interrupt !== null || this.deps.reader.grant === undefined) return;
    const at = Date.now();
    this.deps.reader.grant({ type: "actGrant", v: PROTOCOL_VERSION, taskId: task.id, pid, windowId, at, expires: at + GRANT_MAX_MS });
    task.grant = { pid, windowId };
  }

  /** Gives the reader a calendar grant for this task, on the same terms as issueGrant. */
  private issueCalendarGrant(task: Task): void {
    if (!task.granted || task.calendarGranted || task.interrupt !== null || this.deps.reader.grant === undefined) return;
    const at = Date.now();
    this.deps.reader.grant({ type: "calendarGrant", v: PROTOCOL_VERSION, taskId: task.id, at, expires: at + GRANT_MAX_MS });
    task.calendarGranted = true;
  }

  /** Ends both of the task's grants with one revoke. */
  private revokeGrant(task: Task): void {
    if (task.grant === null && !task.calendarGranted) return;
    task.grant = null;
    task.calendarGranted = false;
    this.deps.reader.grant?.({ type: "actRevoke", v: PROTOCOL_VERSION, taskId: task.id, at: Date.now() });
  }

  /** Re-reads the window a few times until the end state holds, collecting changes into `seen`. */
  private async awaitEffect(task: Task, i: number, step: Step, windowId: string, seen: Change[]): Promise<void> {
    for (let n = 0; ; n++) {
      const w = this.window(windowId);
      if (step.end.kind !== "calendarEvent" && (await this.holds(task, i, w, step.end))) return;
      if (n >= EFFECT_POLLS) throw StepStop.stop("mismatch", `mismatch: after acting, '${step.says}' does not hold`);
      await this.sleep(EFFECT_POLL_MS);
      seen.push(...(await this.walk(w)));
    }
  }

  /** The reader answered a value write with ok, yet the field still holds what it held before and the model recorded no change to it. */
  private dropped(windowId: string, key: string, before: string, seen: readonly Change[]): boolean {
    const now = this.deps.model.windows.get(windowId)?.nodes.get(key);
    return now !== undefined && (now.value ?? "") === before && !seen.some((c) => c.kind === "value" && c.key === key);
  }

  /** A field the step did not target changed while it acted: something other than the plan is at work. */
  private checkUnexpected(seen: readonly Change[], allowedKey: string | null): void {
    for (const c of seen) {
      if (!c.editable || c.key === allowedKey) continue;
      if (c.kind === "value" || c.kind === "removed") {
        throw StepStop.stop("changed", `mismatch: ${c.key} ${c.kind === "removed" ? "disappeared" : "changed"} although the step did not touch it`);
      }
    }
  }

  private async verified(task: Task, i: number, step: Step): Promise<void> {
    task.acted++;
    this.progress(task, "verified", i, step.says);
  }

  // MARK: - reading the screen

  /** Binds the selector to a window, re-reads it, and stops if a sheet covers it or a field changed under the task. */
  private async refresh(task: Task, sel: WindowSel): Promise<WindowState> {
    const id = this.bind(task, sel);
    const w = this.window(id);
    this.issueGrant(task, w.app.pid, id);
    await this.walk(w);
    // A pause or take-over that came in during the walk wins over anything the walk found: the user
    // may already be changing the window, and the run must pause, not fail.
    this.checkInterrupt(task);
    const fresh = this.window(id);
    for (const n of fresh.nodes.values()) {
      if (n.role === "AXSheet") throw StepStop.stop("sheet", `a sheet covers '${fresh.window.title}'`, "screen");
    }
    const exp = task.expected.get(id);
    if (exp === undefined) {
      task.expected.set(id, editableValues(fresh));
    } else {
      for (const [key, text] of editableValues(fresh)) {
        const want = exp.get(key);
        if (want === undefined) exp.set(key, text);
        else if (want !== text) throw StepStop.stop("changed", `${key} changed since the plan started: '${clip(want)}' is now '${clip(text)}'`, "screen");
      }
    }
    return fresh;
  }

  private async walk(w: WindowState): Promise<Change[]> {
    const seen: Change[] = [];
    const off = this.deps.onChanges((cs) => {
      for (const c of cs) if (c.windowId === w.window.windowId) seen.push(c);
    });
    try {
      // A walk only reads, so one that fails (a busy app cuts a walk short past its deadline) is tried
      // again before the step stops. Writes and presses are never retried.
      let r = await this.deps.reader.run({ kind: "walk", pid: w.app.pid, windowId: w.window.windowId });
      for (let n = 0; n < WALK_RETRIES && r.outcome === "axError"; n++) {
        r = await this.deps.reader.run({ kind: "walk", pid: w.app.pid, windowId: w.window.windowId });
      }
      if (r.outcome !== "ok") throw StepStop.stop("reader", `cannot re-read '${w.window.title}': ${r.outcome}${r.detail === null ? "" : ` (${r.detail})`}`);
    } finally {
      off();
    }
    return seen;
  }

  private checkSession(task: Task): void {
    if (task.session !== this.session) throw StepStop.stop("readerRestarted", "the reader restarted since this task began, so its window ids no longer apply", "screen");
  }

  private bind(task: Task, sel: WindowSel): string {
    this.checkSession(task);
    const k = JSON.stringify(sel);
    const bound = task.windows.get(k);
    if (bound !== undefined) {
      if (!this.deps.model.windows.has(bound)) throw StepStop.stop("windowGone", `the window '${sel.title ?? sel.titleStartsWith}' closed`, "screen");
      return bound;
    }
    const hits = [...this.deps.model.windows.values()].filter(
      (w) =>
        (sel.bundleId === undefined || w.app.bundleId === sel.bundleId) &&
        (sel.title === undefined || w.window.title === sel.title) &&
        (sel.titleStartsWith === undefined || w.window.title.startsWith(sel.titleStartsWith)) &&
        (sel.number === undefined || w.window.number === sel.number),
    );
    if (hits.length === 0) throw StepStop.stop("windowGone", `no window matches ${k}`, "screen");
    if (hits.length > 1) throw StepStop.stop("ambiguous", `${hits.length} windows match ${k}; the plan must name one`);
    const id = (hits[0] as WindowState).window.windowId;
    task.windows.set(k, id);
    return id;
  }

  private window(id: string): WindowState {
    const w = this.deps.model.windows.get(id);
    if (w === undefined) throw StepStop.stop("windowGone", `window ${id} is gone`, "screen");
    return w;
  }

  private expectedFor(task: Task, windowId: string): Map<string, string> {
    let m = task.expected.get(windowId);
    if (m === undefined) task.expected.set(windowId, (m = new Map()));
    return m;
  }

  private async resolve(task: Task, i: number, w: WindowState, t: Target, goal: string): Promise<Node> {
    const cacheKey = `${i}|${JSON.stringify(t)}`;
    const cached = task.resolved.get(cacheKey);
    if (cached?.ok === true) {
      const n = w.nodes.get(cached.node.key);
      // A cached choice still has to fit the locator in the current tree.
      if (n !== undefined && (t.role === undefined || n.role === t.role) && (t.label === undefined || norm(n.label) === norm(t.label))) return n;
    }
    // The window as it is now, or as the task found it once it has closed (B13 review: a closed source's
    // value went out as uncharged plan text).
    const sourced = task.sourced.map((v) => ({ text: v.text, window: this.deps.model.windows.get(v.windowId) ?? v.window }));
    const r = await resolveTarget(w, this.deps.model.windows.values(), t, goal, this.deps.askJev, this.deps.rand ?? randomInt, this.deps.targetCutoff, sourced);
    if (r.jev !== null) {
      task.jevCalls += 2;
      this.targetChoices.push({ taskId: task.id, step: i, chose: r.ok ? r.node.key : null, jev: r.jev });
    }
    if (!r.ok) throw StepStop.stop("unreachable", `target for '${goal}' not found: ${r.reason}`);
    task.resolved.set(cacheKey, r);
    return r.node;
  }

  /** Whether an end state holds in the model now. Exists and absent never ask Jev. */
  private async holds(task: Task, i: number, w: WindowState, end: Exclude<EndState, { kind: "calendarEvent" }>): Promise<boolean> {
    switch (end.kind) {
      case "windowTitle":
        return w.window.title === end.title;
      case "handoff":
        // The user's own press is never something Caret finds already done.
        return false;
      case "windowFocused":
        // The window must be the app's focused one and the app the one the user is in: a request walk
        // marks a background app's own focused window as focused, which alone would skip the raise.
        return this.deps.model.focusedWindowId === w.window.windowId && this.deps.model.frontmostPid === w.app.pid;
      case "exists":
      case "absent": {
        const r = resolveLocally(w, end.target);
        const present = !("missing" in r);
        return end.kind === "exists" ? present : !present;
      }
      case "valueEquals":
      case "focused": {
        const local = resolveLocally(w, end.target);
        if ("missing" in local) return false;
        const node = "node" in local ? local.node : await this.resolve(task, i, w, end.target, task.plan.steps[i]?.says ?? "");
        if (end.kind === "focused") return w.focusedKey === node.key;
        const text = node.editable === true ? (node.value ?? "") : nodeText(node);
        return text === end.value;
      }
    }
  }

  // MARK: - undo

  private async undoWrite(task: Task, e: Extract<LedgerEntry, { kind: "write" }>): Promise<string | null> {
    const w = this.deps.model.windows.get(e.windowId);
    if (w === undefined) return "the window closed";
    // The reader acts only on an element it saw in a walk the executor asked for, so undo reads first.
    const walked = await this.deps.reader.run({ kind: "walk", pid: e.pid, windowId: e.windowId });
    if (walked.outcome !== "ok") return `cannot re-read the window: ${walked.outcome}`;
    if (task.undoStopped !== null) return task.undoStopped;
    const restore: ReaderVerb = { kind: "write", pid: e.pid, windowId: e.windowId, key: e.key, role: e.role, attribute: "value", expect: e.after, value: e.before, taskId: task.id };
    const seen: Change[] = [];
    const off = this.deps.onChanges((cs) => {
      for (const c of cs) if (c.windowId === e.windowId) seen.push(c);
    });
    let r: VerbResult;
    try {
      r = await this.deps.reader.run(restore);
      // The same fallback as the run's own writes, for an app that drops value writes, and with the same
      // conditions: the user has not stopped the undo, and no other field changed meanwhile.
      // As for the run's own writes, a field the walk lost right after a restore is read once more before it is judged.
      const refind = async (): Promise<void> => {
        const now = this.deps.model.windows.get(e.windowId);
        if (r.outcome === "ok" && now !== undefined && !now.nodes.has(e.key)) await this.deps.reader.run({ kind: "walk", pid: e.pid, windowId: e.windowId });
      };
      await refind();
      for (const fallback of FALLBACKS) {
        if (r.outcome !== "ok" || !this.dropped(e.windowId, e.key, e.after, seen)) break;
        if (task.undoStopped !== null) return task.undoStopped;
        const other = seen.find((c) => c.editable && c.key !== e.key && (c.kind === "value" || c.kind === "removed"));
        if (other !== undefined) return `${other.key} changed while the field was restored, so the restore was not tried again`;
        r = await this.deps.reader.run({ ...restore, attribute: fallback.name });
        await refind();
      }
    } finally {
      off();
    }
    if (r.outcome !== "ok") return r.outcome === "changed" ? `the field changed after Caret wrote it (${r.detail ?? "no detail"})` : `${r.outcome}: ${r.detail ?? ""}`;
    const now = this.deps.model.windows.get(e.windowId)?.nodes.get(e.key);
    if (now === undefined) return "after the restore the field is gone";
    if ((now.value ?? "") !== e.before) return `after the restore the field holds '${clip(now.value ?? "")}'`;
    return null;
  }

  private async undoCalendar(task: Task, e: Extract<LedgerEntry, { kind: "calendar" }>): Promise<string | null> {
    try {
      return await this.undoCalendarEvent(task, e);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private async undoCalendarEvent(task: Task, e: Extract<LedgerEntry, { kind: "calendar" }>): Promise<string | null> {
    const cal = this.deps.calendar;
    if (cal === null) return "no calendar is configured";
    const ev = await cal.get(e.eventId);
    if (ev === null) return "the event is already gone";
    if (ev.title !== e.title || ev.calendar !== e.calendar || Date.parse(ev.start) !== Date.parse(e.start) || Date.parse(ev.end) !== Date.parse(e.end)) {
      return "the event changed after Caret added it";
    }
    await cal.remove(e.eventId, task.id);
    return (await cal.get(e.eventId)) === null ? null : "the event is still there after removal";
  }

  // MARK: - reporting

  /** The focused window of the frontmost app, where the user is; null when the model cannot say. */
  private userWindow(): string | null {
    // The frontmost app's last focused window: a request walk of a background app moves focusedWindowId (B21, B22 review).
    // With the frontmost app unknown, no window counts as the user's: a write there falls under the stricter permission.
    const m = this.deps.model;
    return m.frontmostPid === null ? null : (m.userWindow()?.window.windowId ?? null);
  }

  /**
   * Reports what a run that ended did under each permission (B17): its writes, grouped by window, as
   * "Write where you are" in the window the user was in when it started and "Reversible write elsewhere"
   * anywhere else; each calendar event it added, elsewhere; and the press or field it handed off, under
   * the permission that press needs. A paused run reports when it ends, each ledger entry once.
   */
  private reportUses(task: Task, outcome: Exclude<Outcome, "paused">): void {
    const onUse = this.deps.onUse;
    if (onUse === undefined) return;
    const fresh = task.ledger.filter((e) => !task.reported.has(e));
    for (const e of fresh) task.reported.add(e);
    const appOf = (windowId: string): string | null => this.deps.model.windows.get(windowId)?.app.name ?? null;
    const done: UseOutcome = outcome === "stopped" ? "stopped" : "done";
    const byWindow = new Map<string, { fields: Set<string>; labels: string[]; presses: string[] }>();
    const group = (windowId: string) => {
      let g = byWindow.get(windowId);
      if (g === undefined) byWindow.set(windowId, (g = { fields: new Set(), labels: [], presses: [] }));
      return g;
    };
    for (const e of fresh) {
      if (e.kind === "write") {
        const g = group(e.windowId);
        if (g.fields.has(e.key)) continue;
        g.fields.add(e.key);
        g.labels.push(this.deps.model.windows.get(e.windowId)?.nodes.get(e.key)?.label?.trim() || "a field");
      } else if (e.kind === "press") group(e.windowId).presses.push(`'${e.label}'`);
      else onUse({ action: "writeElsewhere", says: `${outcome === "stopped" ? "Added, before stopping," : "Added"} '${e.title}' to your ${e.calendar} calendar`, app: "Calendar", outcome: done });
    }
    for (const [windowId, g] of byWindow) {
      const app = appOf(windowId);
      const what = [...(g.labels.length === 0 ? [] : [`filled ${names(g.labels)}`]), ...(g.presses.length === 0 ? [] : [`pressed ${names(g.presses)}`])].join(" and ");
      const said = `${what.charAt(0).toUpperCase()}${what.slice(1)}${app === null ? "" : ` in ${app}`}${outcome === "stopped" ? ", then stopped" : ""}`;
      onUse({ action: windowId === task.userWindow ? "writeHere" : "writeElsewhere", says: said, app, outcome: done });
    }
    const h = task.handedOff;
    if (outcome === "handoff" && h !== null) {
      const app = appOf(h.windowId);
      onUse({ action: h.action, says: `Left ${h.what}${app === null ? "" : ` in ${app}`} to you`, app, outcome: "handedOff" });
    }
    task.handedOff = null;
  }

  /** A stop, which always says why (protocol.ts StopReason); progress() takes every other phase. */
  private stopped(task: Task, step: number | null, detail: string, cause: TaskCause, reason: StopReason): void {
    this.publishProgress(task, { phase: "stopped", stopReason: reason }, step, detail, cause);
  }

  private progress(task: Task, phase: Exclude<TaskPhase, "stopped">, step: number | null, detail: string | null, cause: TaskCause | null = null, counts: ProgressCounts = {}): void {
    const { blocked, ...numbers } = counts;
    if (phase === "handoff") this.publishProgress(task, blocked === undefined ? { phase } : { phase, blocked }, step, detail, cause);
    else this.publishProgress(task, { phase, ...numbers }, step, detail, cause);
  }

  /** `head` is the phase with what only that phase carries: a stop's reason, a hand-off's calendar block, or a done or undone's counts. */
  private publishProgress(
    task: Task,
    head: { phase: "stopped"; stopReason: StopReason } | { phase: "handoff"; blocked?: CalendarBlock } | ({ phase: Exclude<TaskPhase, "stopped" | "handoff"> } & Omit<ProgressCounts, "blocked">),
    step: number | null,
    detail: string | null,
    cause: TaskCause | null,
  ): void {
    const phase = head.phase;
    const says = step === null ? null : (task.plan.steps[step]?.says ?? null);
    const steps = task.plan.steps.length;
    this.deps.publish({ type: "taskProgress", v: PROTOCOL_VERSION, at: Date.now(), taskId: task.id, planId: task.plan.id, step, steps, says, detail, ...head, ...(task.unprompted ? { unprompted: true as const } : {}) });
    if (this.deps.onTask === undefined) return;
    // The first step not yet reached: past this one once it is verified or skipped, none once done.
    const from = phase === "done" ? steps : phase === "verified" || phase === "skipped" ? (step ?? task.next) + 1 : (step ?? task.next);
    const bound = [...task.windows.values()].map((id) => this.deps.model.windows.get(id)).find((w) => w !== undefined);
    this.deps.onTask({
      taskId: task.id,
      title: task.plan.title,
      phase,
      step,
      steps,
      says,
      detail,
      cause,
      remaining: task.plan.steps.slice(from).map((s) => s.says),
      undoable: task.finished !== null && task.ledger.some((e) => e.kind !== "press"),
      window: bound === undefined ? null : { app: bound.app, windowId: bound.window.windowId, title: bound.window.title, frame: bound.window.frame },
    });
  }

  private result(task: Task, outcome: Outcome, step: number | null, detail: string | null): TaskResult {
    return { taskId: task.id, outcome, step, detail, acted: task.acted, skipped: task.skipped, jevCalls: task.jevCalls };
  }
}

function planWindows(plan: Plan): WindowSel[] {
  const out = new Map<string, WindowSel>();
  for (const s of plan.steps) if ("window" in s.end) out.set(JSON.stringify(s.end.window), s.end.window);
  return [...out.values()];
}

function editableValues(w: WindowState): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of w.nodes.values()) if (n.editable === true && !n.states?.includes("secure")) out.set(n.key, n.value ?? "");
  return out;
}

function contains(f: [number, number, number, number], p: [number, number]): boolean {
  return p[0] >= f[0] && p[0] <= f[0] + f[2] && p[1] >= f[1] && p[1] <= f[1] + f[3];
}

/** "Name", "Name and Email", or "3 fields" past two. */
function names(xs: readonly string[]): string {
  if (xs.length <= 2) return xs.join(" and ");
  return xs.every((x) => x.startsWith("'")) ? `${xs.length} controls` : `${xs.length} fields`;
}

function clip(s: string): string {
  return s.length <= 60 ? s : `${s.slice(0, 59)}…`;
}
