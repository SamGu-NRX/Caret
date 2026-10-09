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
import { randomInt, randomUUID } from "node:crypto";
import { GRANT_MAX_MS, PAGE_SUBROLE, PROTOCOL_VERSION, type ActionType, type AppRef, type UseOutcome, type CalendarBlock, type Frame, type Node, type StopReason, type TaskCause, type TaskPhase, type TaskProgress, type UserInput, type FieldInput, type ReaderVerb, type VerbResult } from "../protocol.ts";
import { nodeText, type Change, type ScreenModel, type WindowState } from "../model.ts";
import type { AskJev } from "../fill/jev.ts";
import { CalendarBlocked, CalendarRefused, type CalendarPort, type ReaderLink, type UrlOpener } from "./means.ts";
import { ConfirmedFiles } from "../engines/attach.ts";
import { classifyPress, type RiskClass } from "./risk.ts";
import type { JournalPort, JournalRecord, LedgerEntry, PendingAct } from "./journal.ts";
import { fillSlots, Plan, PlanError, type EndState, type Step, type Target, type WindowSel } from "./schema.ts";
import { norm, resolveLocally, resolveTarget, type JevTrace, type Resolution } from "./target.ts";
import { PAGE_WINDOW_KIND } from "../engines/windows.ts";
import { dependsOn } from "./dependents.ts";

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
  /** The file each task may attach, confirmed by the user (H5). Without it every attach step is handed to the user. */
  files?: ConfirmedFiles;
  /**
   * Whether the task may still act, asked right before every write, press, raise and calendar add, and by
   * `recheck` for every live task: what it depends on (Caret not paused, its skill still on its own, the
   * permission for the action it is about to take, the host session that started it) may have changed
   * since it started (S1 audit #4, #5). `action` is null for the checks that do not depend on one. Without
   * it every act is allowed, as in tests that predate B22.
   */
  authorize?: (a: Authorization) => Revocation | null;
  /**
   * Where each task is saved before every write, press and calendar add and after each lands, so a helper
   * that crashes mid-run leaves its undo behind (B23, S1 audit #11; journal.ts). Without it nothing is saved.
   */
  journal?: JournalPort;
  /** Where a failure that does not change a task's result is said: the watch a finished run cannot drop. */
  warn?: (line: string) => void;
}

/** What the executor saves of a task; the helper adds the skill it counts for (journal.ts JournalRecord.skillId). */
export type TaskSnapshot = Omit<JournalRecord, "skillId">;

/** What `authorize` is asked about: a task, whether a skill started it with no Tab, and the permission its next act falls under. */
export interface Authorization {
  taskId: string;
  unprompted: boolean;
  action: ActionType | null;
}

/**
 * Why a task may no longer act. `you`: the user changed something it depended on (a permission, Caret's
 * pause, the skill, a memory entry, the settings); the run stops as stopped by you. `host`: the host
 * session that started it is gone; the run stops as an error Caret reports. `screen` (D2-06): the screen
 * changed under an accepted goal plan (a dialog opened, a source it copies from changed); the run stops as
 * changed, caused by the screen.
 */
export interface Revocation {
  why: string;
  by: "you" | "host" | "screen";
}

/** One use of a permission by a run: its action type, what it did as a sentence, the app, and how it ended. */
export interface TaskUse {
  action: ActionType;
  says: string;
  app: string | null;
  outcome: UseOutcome;
}

/** The permission a press of this risk class falls under (plan section 3); a safe press needs none of these. */
/** Roles of the form controls fill and Ask hand to the user rather than write (fill/controls.ts). */
const CONTROL_ROLES: ReadonlySet<string> = new Set(["AXPopUpButton", "AXCheckBox", "AXRadioButton", "AXDateField", "AXTimeField", "AXComboBox", "AXGroup"]);
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
  /**
   * C1 (lead decision for item 4): a write whose page put the control back after it failed (VerbResult restored), and
   * which the executor then reads back as it was, is left to the user with its reason (leftToYou) instead of stopping
   * the run; the later steps that do not depend on it (dependents.ts) still run, in the same task and under the same
   * undo. Only a caller that lists those fields as the user's sets it (goals/runs.ts); without it such a write stops
   * the run, as every other failure does.
   */
  leaveFailedToYou?: boolean;
  /**
   * W2: why a copied value may no longer be written at step `step` (its index in the plan) with `value`, or null: the
   * caller holds each step's write-contract mint and rechecks its text and provenance (fill/contract.ts provenanceStale)
   * immediately before each dispatch, as memoryHolds does for a memory entry. A refusal stops the run there.
   */
  guard?: (step: number, value: string, target?: { windowId: string; node: Node; window?: WindowState }) => string | null;
}

/** A step a run left to the user (RunOptions.leaveFailedToYou): its index in the plan, and the sentence that says why. */
export interface LeftToYou {
  step: number;
  says: string;
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

export type { LedgerEntry } from "./journal.ts";

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
/** Matches the links' ordinary 5 s deadline; a stopped run must not wait forever for an in-flight call. */
const STOP_RECONCILE_MS = 5000;

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
  /** W2: the caller's recheck of each copied value before its dispatch (RunOptions.guard). */
  guard: ((step: number, value: string, target?: { windowId: string; node: Node; window?: WindowState }) => string | null) | null;
  unprompted: boolean;
  /** The act grant the reader holds for this task now, or null. One window per task. */
  grant: { pid: number; windowId: string } | null;
  /** The reader holds a calendar grant for this task now (protocol.ts CalendarGrant). */
  calendarGranted: boolean;
  /** RunOptions.leaveFailedToYou. */
  leaveFailedToYou: boolean;
  /** The steps this run left to the user, in order (RunOptions.leaveFailedToYou). */
  left: LeftToYou[];
  /** Later steps that depend on a step left to the user, with why each is left too: they are never written. */
  dependents: Map<number, string>;
  /**
   * The window the user was in when the run started: writes there use "Write where you are", writes to any
   * other window "Reversible write elsewhere". Null when the model knows no frontmost window.
   */
  userWindow: string | null;
  /** Ledger entries already reported as uses, so a resumed run reports each once. */
  reported: Set<LedgerEntry>;
  /** The press or field a hand-off left to the user, with the permission it falls under; null when none. */
  handedOff: { action: ActionType; what: string; windowId: string } | null;
  /**
   * The reader's launch id when the task last acted (Hello.session). Its marks and window ids hold only in that
   * reader, so undo is refused under another (B23).
   */
  readerId: string | null;
  startedAt: number;
  /** The journal holds a row for it (ExecutorDeps.journal). */
  journaled: boolean;
  /** Keep the reconciliation warning when a goal converts an input pause to Stop. */
  recoveryDetail?: string;
  /** When reconciliation must end: STOP_RECONCILE_MS after the first pause or stop of this run reached it. */
  reconcileBy?: number;
}

/**
 * The user's input that may have reached one value write's field since Caret sent the write (issue #26). A write whose
 * answer was lost is judged by a read made once the window is the user's again, and a field holding exactly Caret's
 * value reads the same whether Caret's write landed or the user typed that value. Input on the field from the moment
 * the write was sent decides it: Caret then leaves the field as it is, and Undo leaves it too.
 *
 * It starts at the send, not at the interrupt, because the pause a keystroke causes reaches the executor after the
 * keystroke did. A watch whose write answered ends with the write; one whose write left an unconfirmed entry stays with
 * that entry, since the reader's input can arrive after the recovery read (B29), and is dropped once the entry leaves
 * the ledger.
 */
interface InputWatch {
  task: Task;
  pid: number;
  windowId: string;
  key: string;
  /** When the write was sent, on the same wall clock the reader's and the page's input times use. */
  since: number;
  /** What the user did, in words, once input was seen; null before. */
  seen: string | null;
  /** The ledger entry the lost answer left, once there is one. */
  entry: Extract<LedgerEntry, { kind: "write" }> | null;
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

/** A reader call threw or a write answered axError; the write may have landed without confirmation. */
class UnconfirmedAct extends Error {}

/** The reader focused a web field for a focus-first write and focus was then elsewhere; it wrote nothing (verbResult focusMoved). */
class FocusMoved extends Error {}

/** A page engine's Yes/No press after which the page navigated or submitted (verbResult pageChanged, B28): it may have landed. */
class PageChanged extends Error {}

/**
 * A page engine's failed dropdown pick that the page put back (verbResult restored, C1), with the reader's detail and
 * every change the model recorded while the verb ran. Thrown with the message a refused act stops with, so a run that
 * does not leave failed fields to the user stops exactly as before.
 */
class Restored extends Error {
  readonly detail: string | null;
  readonly seen: Change[];
  constructor(message: string, detail: string | null, seen: Change[]) {
    super(message);
    this.detail = detail;
    this.seen = seen;
  }
}

export class Executor {
  private readonly tasks = new Map<string, Task>();
  private readonly interruptDeadlines = new Map<string, () => void>();
  /** Changes a write's act or read-back delivered once a pause or stop was pending: the user may have typed them. */
  private readonly heardAfterInterrupt = new WeakSet<Change>();
  /** The value writes on their way, and those a lost answer left in a ledger, whose field's input is watched (InputWatch). */
  private readonly inputWatches = new Set<InputWatch>();
  /** When each watched write was sent, for Undo's check of a page field's input time (PageControl.inputAt). */
  private readonly sentAt = new WeakMap<LedgerEntry, number>();
  /** Ends the subscription that reads a page field's inputAt from every later walk (keepWatch); null before the first. */
  private offInputAt: (() => void) | null = null;
  /** Every Jev target question this executor asked, for evaluation. Holds element keys, not screen text. */
  readonly targetChoices: { taskId: string; step: number; chose: string | null; jev: JevTrace }[] = [];
  /** Bumped on every reader connection: a running task stops at its next act when it changes. */
  private session = 0;
  /**
   * The connected reader's launch id (Hello.session), or a fresh one per connection from a reader that sends
   * none; null for an in-process reader link. Undo is allowed only under the reader a task acted in (B23).
   */
  private readerId: string | null = null;
  private anonymousReaders = 0;
  /** The pid set the reader was last asked to watch, as a sorted list. */
  private watching = "";
  private readonly deps: ExecutorDeps;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * A reader connected. Running tasks stop at their next act whatever it is. A reconnect of the same reader
   * (`readerId`, its launch id) keeps its window ids and the elements it recorded, so finished tasks stay
   * undoable; another reader numbers windows from scratch, so their undo is refused.
   */
  readerRestarted(readerId?: string): void {
    this.session++;
    this.readerId = readerId ?? `connection-${++this.anonymousReaders}`;
    // A finished run's saved row is only for undo, which a reader launched since can never carry out: it goes now
    // rather than listing the run again at every start (B23 second review).
    for (const t of this.tasks.values()) {
      if (t.journaled && t.finished !== null && t.finished !== "paused" && t.readerId !== null && t.readerId !== this.readerId) this.journalDrop(t);
    }
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
      leaveFailedToYou: opts.leaveFailedToYou === true,
      guard: opts.guard ?? null,
      left: [],
      dependents: new Map(),
      userWindow: this.userWindow(),
      reported: new Set(),
      handedOff: null,
      readerId: this.readerId,
      startedAt: Date.now(),
      journaled: false,
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
    delete task.reconcileBy;
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
    // The reader that acted for it, as its launch id says, is the only one that knows its windows and the elements
    // it wrote: a reconnect of that reader keeps them, a new reader does not (B23).
    if (task.readerId !== this.readerId) {
      return this.readerId === null
        ? `no reader is connected yet, so nothing of task ${taskId} is restored now`
        : `task ${taskId} ran under a reader that has since restarted; its window ids and fields no longer apply, so nothing is restored`;
    }
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
    // A click in the app of a watched write counts as input on its field (InputWatch): a click can put text in with
    // no key (a suggestion list, a context menu's Paste), and it moves focus before the reader reads the move, so the
    // keys that follow may still name the field that had focus before. The whole app, not the field's window: a
    // suggestion list can sit outside that window, and a window's frame can be unreadable (PR #33 review). Keys count
    // only through fieldInput, which leaves out the Esc that stops a run.
    if (m.kind === "mouse") {
      for (const watch of this.inputWatches) {
        if (watch.pid !== m.pid || m.at < watch.since) continue;
        const frame = this.deps.model.windows.get(watch.windowId)?.window.frame ?? null;
        this.inputSeen(watch, frame !== null && m.point !== null && contains(frame, m.point) ? "you clicked in its window" : "you clicked in its app");
      }
    }
    for (const task of this.tasks.values()) {
      if (!this.acting(task)) continue;
      for (const windowId of task.windows.values()) {
        const w = this.deps.model.windows.get(windowId);
        if (w === undefined || w.app.pid !== m.pid) continue;
        const inside = m.kind === "mouse" ? m.point !== null && w.window.frame !== null && contains(w.window.frame, m.point) : w.focused;
        if (inside) this.inputIn(task, `${m.kind === "key" ? "typing" : "a click"} in '${w.window.title}'`);
      }
    }
  }

  /**
   * Real input inside a page a task acts in (W3): the page engine saw a trusted pointer or key press in a frame of that
   * tab under a live grant. A page window has no frame on screen for the reader's click test, so this is how a click
   * in the page counts as taking the task over; it pauses exactly as onUserInput does.
   */
  onPageInput(windowId: string, kind: "key" | "mouse"): void {
    for (const task of this.tasks.values()) {
      if (!this.acting(task) || ![...task.windows.values()].includes(windowId)) continue;
      const title = this.deps.model.windows.get(windowId)?.window.title ?? "the page";
      this.inputIn(task, `${kind === "key" ? "typing" : "a click"} in '${title}'`);
    }
  }

  /**
   * A key the user pressed that may have changed text (protocol.ts FieldInput): input on every watched write's field it
   * may have reached. A key the reader could not place in a window or at an element counts for every field it could
   * have reached. Watches are kept per write, not per running task, so a stopped run's write still hears it.
   */
  onFieldInput(m: FieldInput): void {
    for (const watch of this.inputWatches) {
      if (watch.pid !== m.pid || m.at < watch.since) continue;
      if ((m.windowId !== null && m.windowId !== watch.windowId) || (m.key !== null && m.key !== watch.key)) continue;
      this.inputSeen(watch, m.key === null ? "you typed in its window" : "you typed in it");
    }
  }

  /**
   * Keeps a watch with the ledger entry its write left, until the entry leaves the ledger. A page keeps its record of
   * the user's input for only 30 s (PageControl.inputAt), so every later walk that changes the field is read for it
   * too: what a failed recovery read could not see stays with the entry for Undo, however late Undo comes (PR #33
   * review).
   */
  private keepWatch(watch: InputWatch, entry: Extract<LedgerEntry, { kind: "write" }>): void {
    watch.entry = entry;
    this.sentAt.set(entry, watch.since);
    this.inputWatches.add(watch);
    this.offInputAt ??= this.deps.onChanges((cs) => {
      for (const c of cs) {
        for (const w of this.inputWatches) {
          if (w.entry === null || c.windowId !== w.windowId || c.key !== w.key) continue;
          const at = this.deps.model.windows.get(w.windowId)?.nodes.get(w.key)?.inputAt;
          if (at !== undefined && at >= w.since) this.inputSeen(w, "you typed in it");
        }
      }
    });
  }

  /** Input on a watched write's field: noted for its recovery read, and an entry already in the ledger is kept from Undo. */
  private inputSeen(watch: InputWatch, why: string): void {
    const e = watch.entry;
    if (e !== null && !watch.task.ledger.includes(e)) {
      this.inputWatches.delete(watch);
      return;
    }
    watch.seen ??= why;
    if (e === null || e.mayIncludeInput === true) return;
    e.mayIncludeInput = true;
    // A paused run's row is saved now; a running one may have its next write on its way, and a save would drop that
    // pending row, so its next save carries the flag. An ended run has no row: its undo lives in memory.
    if (watch.task.journaled && watch.task.finished === "paused") this.journalSave(watch.task, null);
  }

  private acting(task: Task): boolean {
    return task.undoing || (task.finished === null && task.interrupt?.kind !== "stop");
  }

  /** The user's input in one of the task's windows: the grant ends now, and the run pauses (an undo stops) at its next boundary. */
  private inputIn(task: Task, why: string): void {
    // An undo under way stops its remaining restores, as a pause of it does (B22 review).
    if (task.undoing) this.stopUndo(task, `you used the window: ${why}`);
    else {
      task.interrupt = { kind: "pause", by: "input", why };
      this.revokeGrant(task);
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
    // Any pause of an undo under way stops it: the restores not yet made are left as they are (B22 review).
    if (task.undoing) return this.stopUndo(task, takeOver ? "you took over the undo" : "you paused the undo");
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
      // A paused run kept its row; stopped, it ends like any run (B23 second review: the row stayed for every start).
      this.journalDrop(task);
      this.stopped(task, this.stepAt(task), `stopped by you ${this.boundary(task)}${task.recoveryDetail === undefined ? "" : `; ${task.recoveryDetail}`}`, "you", "you");
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
      this.journalDrop(task);
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
    for (const [k, step] of task.plan.steps.slice(task.next).entries()) {
      const end = step.end;
      // W2: a copied value's source must still say what it said when its value was checked (RunOptions.guard).
      const stale = end.kind === "valueEquals" ? (task.guard?.(task.next + k, end.value) ?? null) : null;
      if (stale !== null) return { why: stale, by: "screen" };
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
  private stoppedBy(task: Task, r: Revocation, recovery = ""): string {
    const detail = `stopped ${this.boundary(task)}: ${r.why}${recovery}`;
    this.stopped(task, this.stepAt(task), detail, r.by === "you" ? "you" : r.by === "screen" ? "screen" : "caret", r.by === "you" ? "you" : r.by === "screen" ? "changed" : "error");
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
    // From here a reconnect of the reader, even the same one, stops the restores not yet made.
    task.session = this.session;
    // The user's input in the task's windows stops the undo, so the reader watches them before the first restore.
    try {
      await this.updateWatch();
    } catch {
      this.stopUndo(task, "the reader cannot watch for your input");
    }
    // The run is over; a stop or pause still pending from it (a write that ended in axError) is not this undo's.
    task.interrupt = null;
    delete task.reconcileBy;
    const out: UndoResult = { restored: 0, notRestored: [], notUndoable: 0 };
    const remaining: LedgerEntry[] = [];
    // Entries whose undo ended for good: restored, never landed, or refused for a reason that will not pass (the field
    // changed or was replaced, the window closed). A recovered run's row keeps every other entry, the ones this undo
    // never reached included, for another try after a restart (B23 second review).
    const settled = new Set<LedgerEntry>();
    const before = [...task.ledger];
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
                ? await this.undoWrite(task, e, settled)
                : await this.undoCalendar(task, e, settled);
        // A write a crash cut off that never landed: nothing of Caret's is there, so it counts as neither.
        if (reason === UNTOUCHED) {
          settled.add(e);
          continue;
        }
        if (reason === null) {
          out.restored++;
          settled.add(e);
        }
        else {
          out.notRestored.push({ step: e.step, reason });
          remaining.push(e);
        }
      }
      task.ledger = remaining.reverse();
    } finally {
      task.undoing = false;
      for (const watch of this.inputWatches) if (watch.task === task && (watch.entry === null || !task.ledger.includes(watch.entry))) this.inputWatches.delete(watch);
      this.revokeGrant(task);
      // A run a crash interrupted keeps its row while some of it may still be restored: what this undo was stopped
      // before, or could not restore for a passing reason (B23 review). What it found changed or replaced stays in
      // memory only, since a row kept for it would list the run again at every start.
      if (task.journaled) {
        const keep = before.filter((e) => e.kind !== "press" && !settled.has(e));
        if (keep.length > 0) this.journalSave(task, null, keep);
        else this.journalDrop(task);
      }
      // The watch for this undo ends with it; a failure here only leaves a watch on, which the next run replaces.
      await this.updateWatch().catch(() => undefined);
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
        // The saved row names the first step not yet verified, so a crash from here on reports the right one.
        if (task.journaled) this.journalSave(task, null);
      }
      // A take over, pause or stop that came in while the last act was on its way: the act landed and stays
      // in the ledger for undo, but the run ends as the user asked rather than as done (B19 review: a skill
      // must not count a run the user interrupted as clean).
      this.checkInterrupt(task);
      task.finished = "done";
      // Fields this run wrote, each once however many writes it took; presses and calendar events are not fields.
      const written = new Set(task.ledger.flatMap((e) => (e.kind === "write" ? [`${e.windowId}\u0000${e.key}`] : []))).size;
      const yours = task.left.length === 0 ? "" : `; left to you: ${task.left.map((l) => l.says).join(" ")}`;
      this.progress(task, "done", null, clip(`${task.acted} acted, ${task.skipped} already true${yours}`, 2000), null, { written });
      this.reportUses(task, "done");
      return this.result(task, "done", null, null);
    } catch (e) {
      const i = task.next;
      const it = task.interrupt;
      if (e instanceof Interrupted && it !== null) {
        task.interrupt = null;
        delete task.reconcileBy;
        const at = this.stepAt(task);
        if (e.message !== "") task.recoveryDetail = e.message;
        else delete task.recoveryDetail;
        const recovery = e.message === "" ? "" : `; ${e.message}`;
        if (it.kind === "stop") {
          task.finished = "stopped";
          let detail: string;
          if (it.revoked === undefined) {
            detail = `stopped by you ${this.boundary(task)}${recovery}`;
            this.stopped(task, at, detail, "you", "you");
          } else detail = this.stoppedBy(task, it.revoked, recovery);
          this.reportUses(task, "stopped");
          return this.result(task, "stopped", at, detail);
        }
        const detail = this.pauseDetail(task, it) + recovery;
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
      // A paused run keeps its row, now with nothing on its way; an ended one leaves undo to the executor's memory.
      if (task.finished === "paused") {
        if (task.journaled) this.journalSave(task, null);
      } else if (task.finished !== null) this.journalDrop(task);
      // Done, handed off, stopped or paused: nothing more is done for the task until the user resumes it.
      if (task.finished !== null) this.revokeGrant(task);
      // The run's result stands: a reader that will not drop the input watch now only leaves a watch on, which the
      // next run's updateWatch replaces. A throw here would turn a finished run into a rejection (CodeRabbit on PR #5).
      await this.updateWatch().catch((e: unknown) => this.deps.warn?.(`executor: after task ${task.id}, ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  /** Asks the reader to report real input in every process a running task acts in, and nothing else. */
  private async updateWatch(): Promise<void> {
    const pids = new Set<number>();
    for (const t of this.tasks.values()) {
      if (t.finished !== null && !t.undoing) continue;
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
    // A pick this run made but could not verify (readUnconfirmed) shows the option's name whether or not the option was
    // pressed, so the control cannot show the step already holds (PR #21 review). Checking it is the user's.
    if (end.kind === "valueEquals" && task.ledger.some((e) => e.kind === "write" && e.step === i && e.unconfirmed === true && pageCombobox(e.role, e.windowId))) {
      throw StepStop.handoff(`Caret cannot tell whether '${end.value}' was picked for '${step.says}', so checking it is yours`);
    }
    if (await this.holds(task, i, w, end)) {
      task.skipped++;
      this.progress(task, "skipped", i, "already true");
      return;
    }
    // A step that depends on one this run left to the user is left too, never written (RunOptions.leaveFailedToYou).
    const dependent = task.dependents.get(i);
    if (dependent !== undefined) {
      this.leave(task, i, dependent);
      return;
    }
    if (end.kind === "windowFocused") return this.raiseStep(task, i, w, step);
    if (end.kind === "fileAttached") return this.attachStep(task, i, w, end, step);
    if (end.kind === "handoff") {
      const node = await this.resolve(task, i, w, end.target, step.says);
      const label = (node.label ?? "").trim();
      const what = label === "" ? end.target.describe : `'${label}'`;
      // The control's own label decides the reason, as for a press: a plan cannot call a Send press unverifiable.
      const risk = classifyPress({ label, windowKind: w.window.kind, bundleId: w.app.bundleId });
      const known = risk === "safe" || risk === "unclassified" ? null : risk;
      if (known !== null) task.handedOff = { action: RISK_ACTION[known], what, windowId: w.window.windowId };
      // A form control an Ask hands over (a select, a date: planner/ask.ts) is the user's to set, not a press.
      if (known === null && CONTROL_ROLES.has(node.role)) throw StepStop.handoff(`Caret does not set ${what} itself, so it leaves setting it to you`);
      throw StepStop.handoff(known === null ? `Caret cannot check what pressing ${what} changes, so it leaves that press to you` : `${what} reads as ${known}; Caret leaves that press to you`);
    }

    if (end.kind === "valueEquals" || end.kind === "focused") {
      const node = await this.resolve(task, i, w, end.target, step.says);
      if (end.kind === "valueEquals" && node.editable === true) return this.writeStep(task, i, w, node, "value", end.value, step);
      if (end.kind === "focused" && step.via === undefined) return this.writeStep(task, i, w, node, "focused", "", step);
    }
    if (step.via === undefined) throw StepStop.stop("unreachable", `no means to reach '${step.says}': the target is not a field and the step names no press or URL`);
    if (end.kind === "fieldsRevealed" && step.via.kind !== "press") throw StepStop.stop("unreachable", `'${step.says}' reveals fields only through a press`);
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
    // The reader keeps the element it writes under this mark, so undo can require that same element (S1 audit #6).
    const mark = attribute === "value" ? randomUUID() : undefined;
    const verb: ReaderVerb = { kind: "write", pid: w.app.pid, windowId: w.window.windowId, key: node.key, role: node.role, attribute, expect: before, value, taskId: task.id, ...(mark === undefined ? {} : { mark }) };
    await this.deps.beforeAct?.(task.id, i);
    // Every value write this step sends, with the input seen on its field (InputWatch).
    const watches: InputWatch[] = [];
    const sent = async (v: ReaderVerb): Promise<Change[]> => {
      // A value from memory must still be what its entry holds at each dispatch, the insert fallback's
      // included, after everything awaited before it: the user may forget or pause the entry mid-run.
      if (step.memory !== undefined && this.deps.memoryHolds?.(step.memory, value) !== true) {
        throw StepStop.stop("changed", `what you told Caret for '${step.says}' changed or is gone, so Caret did not write it`);
      }
      // W2: and a copied value's source must still say what it said when the value was checked, right before each dispatch.
      // I2: the field as the model reads it now, not as this step resolved it: an earlier step, a fallback's write or the
      // page may have changed it since (the Ask's scope compares its fingerprint, contract.ts guardFor).
      const nowW = task.guard === null ? w : this.window(w.window.windowId);
      const nowNode = nowW.nodes.get(node.key);
      if (attribute === "value" && task.guard !== null && nowNode === undefined) throw StepStop.stop("changed", `the field for '${step.says}' is gone, so Caret did not write it`);
      const stale = attribute === "value" ? (task.guard?.(i, value, { windowId: nowW.window.windowId, node: nowNode ?? node, window: nowW }) ?? null) : null;
      if (stale !== null) throw StepStop.stop("changed", `${stale}, so Caret did not write it`);
      let answered = false;
      // Registered right before the send, which act makes before its first await.
      const watch: InputWatch | null = attribute === "value" ? { task, pid: w.app.pid, windowId: w.window.windowId, key: node.key, since: Date.now(), seen: null, entry: null } : null;
      if (watch !== null) {
        this.inputWatches.add(watch);
        watches.push(watch);
      }
      try {
        const changes = await this.act(task, v, w.window.windowId);
        answered = true;
        // A successful answer without read-back is not proof that the field took the write. Read before
        // judging it or trying another means; a stop revokes writes, not this read-only recovery check.
        const readBack = changes.some((c) => c.key === node.key && (c.kind === "value" || c.kind === "added"));
        if (attribute === "value" && (!readBack || !this.window(w.window.windowId).nodes.has(node.key))) {
          // Bounded by Stop's deadline like the act itself; a timeout here goes on to reconciliation (Greptile review).
          const read = await this.untilInterruptDeadline(task, this.walk(this.window(w.window.windowId), task), "no read-back after interruption");
          // Which of the walk's changes came before a pause or stop arrived during it is unknown, so none counts as before.
          if (task.interrupt !== null) for (const c of read) this.heardAfterInterrupt.add(c);
          return [...changes, ...read];
        }
        return changes;
      } catch (e) {
        // A page handler moved focus off the field once the reader focused it, so it wrote nothing (S1 audit #14).
        if (e instanceof FocusMoved) {
          const label = (node.label ?? "").trim();
          const field = label === "" ? "this field" : `the ${label} field`;
          task.handedOff = { action: w.window.windowId === task.userWindow ? "writeHere" : "writeElsewhere", what: field, windowId: w.window.windowId };
          throw StepStop.handoff(`focus moved away from ${field} when Caret focused it, so Caret did not write it; it is yours to fill`);
        }
        // B28 lead decision 2: a Yes/No press after which the page navigated or submitted. The press may have landed,
        // so it goes in the ledger unconfirmed for undo, and the run stops here, before any fallback or re-read: the
        // page Caret was acting on is gone or going.
        if (e instanceof PageChanged) {
          this.addLedger(task, { kind: "write", step: i, pid: w.app.pid, windowId: w.window.windowId, key: node.key, role: node.role, before, after: value, mark: mark ?? null, unconfirmed: true });
          this.deps.warn?.(`executor: task ${task.id} step ${i}: the page changed after the press: ${e.message}`);
          throw StepStop.stop("changed", `The page changed after Caret pressed '${value}', so Caret stopped.`);
        }
        // A fault or lost read-back can follow a landed write. Save before the recovery read, so even a
        // second failure keeps undo. S1 recognizes only original, intended, or a proper intended prefix.
        if (attribute === "value" && (answered || e instanceof UnconfirmedAct)) {
          const entry: Extract<LedgerEntry, { kind: "write" }> = { kind: "write", step: i, pid: w.app.pid, windowId: w.window.windowId, key: node.key, role: node.role, before, after: value, mark: mark ?? null, unconfirmed: true };
          if (watch !== null) {
            this.keepWatch(watch, entry);
            if (watch.seen !== null) entry.mayIncludeInput = true;
          }
          this.addLedger(task, entry);
          // What Undo will do, so the report promises no more. A Yes/No question is answered by a press, which undo
          // cannot take back (PageEngineLink.pressAnswer); a page radio group's undo only clears Caret's own pick, so it
          // cannot choose an earlier answer again (PageEngineLink.checkRadio).
          const pressed = node.subrole === PAGE_SUBROLE.pressGroup;
          const noUndo = pressed ? "Caret cannot take back a press, so change the answer yourself if it is wrong" : node.subrole === "AXFieldset" && before !== "" ? `Undo cannot put back the earlier choice ${JSON.stringify(before)}, so change it yourself if needed` : null;
          const recovery = await this.readUnconfirmed(task, entry, noUndo, pressed, watch);
          if (task.interrupt !== null) {
            if (recovery.state === "landed") {
              delete entry.unconfirmed;
              this.expectedFor(task, entry.windowId).set(entry.key, value);
              await this.verified(task, i, step);
              task.next = i + 1;
              this.journalSave(task, null);
              const when = task.interrupt.kind === "stop" ? "stop" : "pause";
              const what = node.label?.trim() || step.says;
              throw new Interrupted(`${pressed ? "Answered" : "Written"} before ${when}: ${what}. ${noUndo ?? "Undo puts it back"}.`);
            }
            if (recovery.state === "untouched") {
              task.ledger.splice(task.ledger.indexOf(entry), 1);
              this.journalSave(task, null);
            }
            throw new Interrupted(recovery.detail ?? "");
          }
          throw StepStop.stop("reader", `${e instanceof Error ? e.message : String(e)}${recovery.detail === null ? "" : `; ${recovery.detail}`}`);
        }
        throw e;
      } finally {
        // A watch stays only with an entry a lost answer left (InputWatch).
        if (watch !== null && (watch.entry === null || !task.ledger.includes(watch.entry))) this.inputWatches.delete(watch);
      }
    };
    let seen: Change[];
    try {
      seen = await sent(verb);
    } catch (e) {
      if (e instanceof Restored) return this.leaveRestored(task, i, w, node, before, step, e);
      throw e;
    }
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
      try {
        seen = [...seen, ...(await sent({ ...verb, attribute: fallback.name }))];
      } catch (e) {
        // A fallback follows a write that answered ok: one the page then put back is a stop, as before C1.
        if (e instanceof Restored) throw StepStop.stop("reader", e.message);
        throw e;
      }
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
      // The reader wrote, so the write goes in the ledger before it is judged. Its `after` is the value Caret meant to
      // write, never this read (B29 lead decision): a keystroke the user typed right as Caret wrote can reach the field
      // before the read-back and the task's input watch later, so a read that differs may hold the user's typing, and
      // an app's reformatting looks the same. Undo refuses unrecognized text rather than restore over the user's
      // typing. S1 permits recovery of a proper intended prefix for an unconfirmed whole-field replacement.
      // Before B29 a reader write kept the read as `after`, and undo erased the keystroke.
      // An earlier exact read-back remains evidence that the full write landed, even if the user
      // shortened it before the answer arrived. That later prefix is not an interrupted Caret write.
      const recorded = seen.some((c) => (c.kind === "value" || (c.kind === "added" && seen.some((r) => r.kind === "removed" && r.key === node.key))) && c.key === node.key && c.after === value);
      // Issue #26, PR #33 review: the user's input on the field since the first send makes whatever it holds possibly
      // theirs, a read-back of exactly Caret's value included, so Undo leaves it.
      const since = watches[0]?.since;
      const typed = watches.some((x) => x.seen !== null) || (since !== undefined && now?.inputAt !== undefined && now.inputAt >= since);
      const kept = (entry: Extract<LedgerEntry, { kind: "write" }>): void => {
        if (typed) entry.mayIncludeInput = true;
        this.addLedger(task, entry);
        if (since === undefined) return;
        this.sentAt.set(entry, since);
        // Under a pause or stop the reader's input can still arrive after this read (B29): the watch stays with the entry.
        const last = watches.at(-1);
        if (task.interrupt !== null && last !== undefined) {
          last.since = since;
          this.keepWatch(last, entry);
        }
      };
      if (now === undefined) {
        kept({ kind: "write", step: i, pid: w.app.pid, windowId: w.window.windowId, key: node.key, role: node.role, before, after: value, mark: mark ?? null, unconfirmed: true });
      } else if ((now.value ?? "") !== before) {
        const held = now.value ?? "";
        const ours = sameValue(node, held, value);
        // S1 takes a proper prefix for part of Caret's write only from a reading heard before a pause or stop handed the
        // window back; after that the user may have typed it (PR #21 review), so it may include input.
        const reading = seen.findLast((c) => c.key === node.key && (c.kind === "value" || c.kind === "added"));
        const heard = reading !== undefined && reading.after === held && !this.heardAfterInterrupt.has(reading);
        // Successful numeric read-back keeps its existing equivalence rule, not S1's faulted-prefix rule.
        const partial = !typed && !recorded && !ours && heard && partialReplacement(before, value, held);
        kept({ kind: "write", step: i, pid: w.app.pid, windowId: w.window.windowId, key: node.key, role: node.role, before, after: value, mark: mark ?? null, ...(partial ? { unconfirmed: true, partialWrite: held } : ours ? {} : { mayIncludeInput: true }) });
      }
      if (now === undefined || (now.value ?? "") !== value || !recorded) {
        const detail = `mismatch: expected ${prediction}; ${now === undefined ? `the field is gone; before the write it held ${JSON.stringify(before)}` : fieldContents(before, now.value ?? "")}`;
        if (task.interrupt !== null) throw new Interrupted(detail);
        throw StepStop.stop("mismatch", detail);
      }
      this.expectedFor(task, w.window.windowId).set(node.key, value);
    } else if (after.focusedKey !== node.key) {
      throw StepStop.stop("mismatch", `mismatch: expected ${prediction}; focus is on ${after.focusedKey ?? "nothing"}`);
    }
    this.checkUnexpected(seen, attribute === "value" ? node.key : null);
    await this.verified(task, i, step);
  }

  /**
   * Attaches the file the user confirmed for this task to the page's file input (H5, lead decision 7), through the
   * page engine, which checks the bytes against the confirmation and the page's own file list after. With no page
   * engine or no confirmation, the step is the user's. An attach cannot be undone, so it adds nothing to the ledger:
   * a page may upload a file the moment it gets one.
   */
  private async attachStep(task: Task, i: number, w: WindowState, end: Extract<EndState, { kind: "fileAttached" }>, step: Step): Promise<void> {
    const node = await this.resolve(task, i, w, end.target, step.says);
    const what = (node.label ?? "").trim() === "" ? end.target.describe : `'${(node.label ?? "").trim()}'`;
    const files = this.deps.files;
    const link = this.deps.reader;
    if (files === undefined || link.attachFile === undefined || !w.window.windowId.startsWith("page:")) {
      throw StepStop.handoff(`Caret attaches files only on a page Caret for Chrome reads, so attaching ${end.wants} to ${what} is yours`);
    }
    // The name and size, before the engine reads the confirmation (a read uses it up). P3: only a file confirmed for this
    // very field; one confirmed for another field of the run is never spent here.
    const confirmed = files.confirmed(task.id, ConfirmedFiles.target(w.window.windowId, node.key));
    if (confirmed === null) throw StepStop.handoff(`no file was confirmed for ${what} in this run, so attaching ${end.wants} to it is yours`);
    const name = confirmed.name;
    this.checkSession(task);
    this.checkInterrupt(task);
    this.authorizeAct(task, w.window.windowId);
    // I2 ruling A: an attachment meets the write contract's guard as a write does, on the field as it reads right now:
    // its "attachment" mint, under the Ask's scope when an Ask made the plan.
    if (task.guard !== null) {
      const nowW = this.window(w.window.windowId);
      const nowNode = nowW.nodes.get(node.key);
      if (nowNode === undefined) throw StepStop.stop("changed", `the file control for '${step.says}' is gone, so Caret attached nothing`);
      const stale = task.guard(i, end.wants, { windowId: nowW.window.windowId, node: nowNode, window: nowW });
      if (stale !== null) throw StepStop.stop("changed", `${stale}, so Caret attached nothing`);
    }
    const r = await link.attachFile(w.window.windowId, node.key, task.id, files);
    if (r.verb.outcome !== "ok" && task.interrupt !== null) throw new Interrupted();
    // The file the engine refused before the page saw it (a changed file, an expired confirmation): nothing landed.
    if (r.verb.outcome === "notAllowed") throw StepStop.handoff(`Caret did not attach ${end.wants}: ${r.verb.detail ?? "refused"}; attaching it is yours`);
    if (r.verb.outcome !== "ok") throw StepStop.stop("reader", `the page did not take the file: ${r.verb.outcome}${r.verb.detail === null ? "" : ` (${r.verb.detail})`}`);
    // Verified by the page: a file input's own file list names the file; a drop shows its name on the page.
    const attached = r.page?.attached;
    // P3: by name and size for an input (the content script checks both too), by the rendered name for a drop.
    const landed = attached !== undefined && (attached.via === "input" ? attached.file?.name === name && attached.file.size === confirmed.size : attached.shown);
    if (!landed) {
      throw StepStop.stop("mismatch", "mismatch: the page does not show the attached file");
    }
    task.acted++;
    this.progress(task, "verified", i, null);
  }

  /**
   * C1 (lead decision for item 4): a write the page put back after it failed (Restored). The run goes on only when it
   * leaves failed fields to the user (RunOptions.leaveFailedToYou), every later step is a value write, the planned
   * hand-off or an attach of a file the user confirmed for its own control (P3; a press may act on the form as it stands), and the executor's own read-back finds the field holding what it
   * held before and nothing else in the window changed while the verb ran. Then the field is the user's, with the
   * page's reason; the later steps that depend on it (dependents.ts) are left too; nothing goes in the undo ledger, since
   * nothing landed. Any other case stops the run with the refusal's own message, as before.
   */
  private async leaveRestored(task: Task, i: number, w: WindowState, node: Node, before: string, step: Step, e: Restored): Promise<void> {
    const later = task.plan.steps.slice(i + 1);
    if (!task.leaveFailedToYou || later.some((s) => s.via !== undefined || (s.end.kind !== "valueEquals" && s.end.kind !== "handoff" && s.end.kind !== "fileAttached"))) throw StepStop.stop("reader", e.message);
    // The name the plan gave the field (a goal's preview showed it), else the node's own label.
    const label = (step.end.kind === "valueEquals" ? step.end.target.describe.trim() : "") || (node.label ?? "").trim() || step.says;
    const seen = [...e.seen, ...(await this.walk(this.window(w.window.windowId)))];
    this.checkInterrupt(task);
    const now = this.window(w.window.windowId).nodes.get(node.key);
    if (now === undefined || (now.value ?? "") !== before) {
      throw StepStop.stop("reader", `${e.message}; Caret read '${clip(label)}' back as '${clip(now?.value ?? "(gone)")}', not '${clip(before)}' as before, so it stopped`);
    }
    // The control itself may have shown the filter and gone back; any other field that changed means more is at work.
    this.checkUnexpected(seen, node.key);
    this.leave(task, i, `'${clip(label)}' is yours: Caret could not set it, and put it back as it was (${clip(e.detail ?? "the page refused the pick", 240)}).`);
    const window = JSON.stringify(step.end.kind === "valueEquals" ? step.end.window : null);
    const name = step.end.kind === "valueEquals" ? step.end.target.describe : label;
    task.plan.steps.forEach((s, j) => {
      if (j <= i || task.dependents.has(j) || s.end.kind !== "valueEquals" || JSON.stringify(s.end.window) !== window || !dependsOn(name, s.end.target.describe)) return;
      task.dependents.set(j, `'${clip(s.end.target.describe)}' is yours: it may depend on '${clip(name)}', which Caret left to you, so Caret did not write it.`);
    });
  }

  /** Lists step `i` as the user's (RunOptions.leaveFailedToYou); the run goes on with the next step. */
  private leave(task: Task, i: number, says: string): void {
    task.left.push({ step: i, says });
    this.deps.warn?.(`executor: task ${task.id} step ${i}: ${says}`);
  }

  /** The steps a run left to the user (RunOptions.leaveFailedToYou), in order; none for a task this executor does not hold. */
  leftToYou(taskId: string): readonly LeftToYou[] {
    return [...(this.tasks.get(taskId)?.left ?? [])];
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
    // Only a press the table positively allows is made (B22 review): one it cannot classify is the user's too.
    if (risk === "unclassified") throw StepStop.handoff(`Caret cannot tell what pressing '${label}' does, so it leaves that press to you`);
    if (risk !== "safe") {
      task.handedOff = { action: RISK_ACTION[risk], what: `'${label}'`, windowId: w.window.windowId };
      throw StepStop.handoff(`'${label}' reads as ${risk}; Caret leaves that press to you`);
    }
    this.checkInterrupt(task);
    this.progress(task, "acting", i, `press '${label}'; expect: ${step.says}`);
    await this.deps.beforeAct?.(task.id, i);
    // A reveal is judged against the fields the window shows right before the press goes out (D2-06): the model as of
    // the dispatch, after every hook. It holds only with no sheet over the window, the same title, and an editable field
    // that was not there; a field the app adds on its own at that very moment cannot be told from one the press showed.
    const before = this.window(w.window.windowId);
    const shown = step.end.kind === "fieldsRevealed" ? { title: before.window.title, keys: new Set(editableValues(before).keys()) } : null;
    const seen = await this.act(task, { kind: "press", pid: w.app.pid, windowId: w.window.windowId, key: node.key, role: node.role, label, taskId: task.id }, w.window.windowId);
    this.addLedger(task, { kind: "press", step: i, label, windowId: w.window.windowId });
    const revealed = (now: WindowState): boolean => shown !== null && now.window.title === shown.title && ![...now.nodes.values()].some((n) => n.role === "AXSheet") && [...editableValues(now).keys()].some((k) => !shown.keys.has(k));
    await this.awaitEffect(task, i, step, w.window.windowId, seen, shown === null ? undefined : revealed);
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
    this.journalSave(task, { kind: "calendar", step: i, calendar: end.calendar, title: end.title, start: end.start, end: end.end });
    let ev: Awaited<ReturnType<CalendarPort["add"]>>;
    try {
      ev = await cal.add(end.calendar, end.title, end.start, end.end, task.id);
    } catch (e) {
      // An add whose answer was lost (no answer in time, axError) may still have been saved: if the event is
      // there now, it goes in the ledger so undo can remove it, and the run still stops on the error. Any
      // other refusal (an identical event another task added) means this task added nothing.
      if (e instanceof CalendarRefused && e.outcome === "axError") {
        const late = await cal.find(end.calendar, end.title, end.start, end.end).catch(() => null);
        if (late !== null) this.addLedger(task, { kind: "calendar", step: i, eventId: late.id, calendar: late.calendar, title: late.title, start: late.start, end: late.end });
      }
      throw e;
    }
    // In the ledger before it is checked, so undo can remove an event that fails the check.
    this.addLedger(task, { kind: "calendar", step: i, eventId: ev.id, calendar: ev.calendar, title: ev.title, start: ev.start, end: ev.end });
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
    // Saved before the reader gets it: a crash while it is on its way leaves a row that says what may have landed.
    if (verb.kind === "write" && verb.mark !== undefined) {
      this.journalSave(task, { kind: "write", step: task.next, pid: verb.pid, windowId: verb.windowId, key: verb.key, role: verb.role, before: verb.expect, value: verb.value, mark: verb.mark });
    } else if (verb.kind === "press") this.journalSave(task, { kind: "press", step: task.next, label: verb.label, windowId: verb.windowId });
    const seen: Change[] = [];
    const off = this.deps.onChanges((cs) => {
      for (const c of cs) {
        if (c.windowId !== windowId) continue;
        seen.push(c);
        if (task.interrupt !== null) this.heardAfterInterrupt.add(c);
      }
    });
    try {
      let r: VerbResult;
      try {
        r = await this.waitForAct(task, verb);
      } catch (e) {
        throw new UnconfirmedAct(e instanceof Error ? e.message : String(e));
      }
      // The page left or submitted after a press: nothing more runs, whatever else came in meanwhile (B28).
      if (r.pageChanged !== undefined) throw new PageChanged(`${r.pageChanged.join(", ")}${r.detail === null ? "" : ` (${r.detail})`}`);
      // An interruption wins over a refusal as the reason the run ends. Only notAllowed can follow a value that went in
      // (the grant ended after the setter ran), so only it goes to reconciliation. changed, noElement, notSameElement and
      // the rest mean Caret wrote nothing: a tick the user made meanwhile reads as changed (PageEngineLink.notUnderIt),
      // and reconciling it would let Undo clear their own tick (PR #21 review).
      if (r.outcome !== "ok" && r.outcome !== "axError" && task.interrupt !== null) {
        if (verb.kind === "write" && verb.attribute !== "focused" && r.outcome === "notAllowed") throw new UnconfirmedAct(`the reader answered ${r.outcome} after interruption`);
        throw new Interrupted();
      }
      if (r.outcome === "focusMoved") throw new FocusMoved(r.detail ?? "focus moved");
      if (r.outcome === "changed" && r.restored === true) throw new Restored(`the reader refused: ${r.outcome}${r.detail === null ? "" : ` (${r.detail})`}`, r.detail, [...seen]);
      // Use the outcome, not text inside the detail: a refused field may itself contain "axError".
      if (r.outcome === "axError" && verb.kind === "write" && verb.attribute !== "focused") {
        throw new UnconfirmedAct(`the reader refused: ${r.outcome}${r.detail === null ? "" : ` (${r.detail})`}`);
      }
      if (r.outcome !== "ok") throw StepStop.stop("reader", `the reader refused: ${r.outcome}${r.detail === null ? "" : ` (${r.detail})`}`);
    } finally {
      off();
    }
    return seen;
  }

  /** Revocation ends new acts, not the answer to one already dispatched. Bound the remaining wait from that moment. */
  private waitForAct(task: Task, verb: ReaderVerb): Promise<VerbResult> {
    return this.untilInterruptDeadline(task, this.deps.reader.run(verb), "no answer to the in-flight act after interruption");
  }

  /**
   * `work`, or a rejection with `timedOut` at the task's reconcileBy, which revokeGrant sets when the first pause or
   * stop reaches it. The in-flight act and its recovery read share that one deadline, however long either began before.
   */
  private async untilInterruptDeadline<T>(task: Task, work: Promise<T>, timedOut: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let start = (): void => {};
    const deadline = new Promise<never>((_, reject) => {
      start = () => {
        if (timer !== undefined || task.reconcileBy === undefined) return;
        timer = setTimeout(() => reject(new Error(timedOut)), Math.max(0, task.reconcileBy - Date.now()));
      };
    });
    this.interruptDeadlines.set(task.id, start);
    start();
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.interruptDeadlines.delete(task.id);
    }
  }

  // MARK: - the recovery journal (B23, S1 audit #11)

  /** Adds a ledger entry and saves the task with nothing on its way. */
  private addLedger(task: Task, e: LedgerEntry): void {
    task.ledger.push(e);
    this.journalSave(task, null);
  }

  /** Saves the task to the journal: its ledger (or `ledger`), the step it stands before, and what it is about to dispatch. */
  private journalSave(task: Task, pending: PendingAct | null, ledger: LedgerEntry[] = task.ledger): void {
    const j = this.deps.journal;
    if (j === undefined) return;
    const bound = [...task.windows.values()].map((id) => this.deps.model.windows.get(id)).find((w) => w !== undefined);
    j.save({
      taskId: task.id,
      startedAt: task.startedAt,
      savedAt: Date.now(),
      plan: task.plan,
      unprompted: task.unprompted,
      granted: task.granted,
      readerId: task.readerId,
      next: task.next,
      ledger,
      pending,
      window: bound === undefined ? null : { app: bound.app, windowId: bound.window.windowId, title: bound.window.title, frame: bound.window.frame },
      afterIntended: true,
    });
    task.journaled = true;
  }

  private journalDrop(task: Task): void {
    if (!task.journaled) return;
    this.deps.journal?.drop(task.id);
    task.journaled = false;
  }

  /**
   * Takes back a run a crash interrupted, from its journal row, as a stopped task whose undo restores what the row
   * says it wrote. A write that was on its way joins the ledger as unconfirmed: undo restores it only if the field
   * holds what it was writing, through the element the reader recorded. A press on its way counts as a press;
   * a calendar add on its way is looked up by its slot at undo. Nothing runs again.
   */
  recover(r: JournalRecord): void {
    if (this.tasks.has(r.taskId)) throw new PlanError(`task ${r.taskId} already exists`);
    // A row saved before B29 may hold a native write's read-back as `after` (review 1): its undo is refused, as for
    // any write that may include the user's input. A write whose answer was lost always kept the value it was writing.
    const ledger: LedgerEntry[] = r.ledger.map((e) => (r.afterIntended === true || e.kind !== "write" || e.unconfirmed === true ? e : { ...e, mayIncludeInput: true }));
    const p = r.pending;
    if (p?.kind === "write") ledger.push({ kind: "write", step: p.step, pid: p.pid, windowId: p.windowId, key: p.key, role: p.role, before: p.before, after: p.value, mark: p.mark, unconfirmed: true });
    else if (p?.kind === "press") ledger.push({ kind: "press", step: p.step, label: p.label, windowId: p.windowId });
    else if (p?.kind === "calendar") ledger.push({ kind: "calendar", step: p.step, eventId: null, calendar: p.calendar, title: p.title, start: p.start, end: p.end });
    const windows = new Map<string, string>();
    for (const e of ledger) if (e.kind !== "calendar") windows.set(`recovered:${e.windowId}`, e.windowId);
    this.tasks.set(r.taskId, {
      id: r.taskId,
      plan: r.plan,
      // A recovered task only undoes; it dispatches no write, so it rechecks no source.
      guard: null,
      windows,
      expected: new Map(),
      next: r.next,
      ledger,
      interrupt: null,
      acted: 0,
      skipped: 0,
      jevCalls: 0,
      finished: "stopped",
      resolved: new Map(),
      session: this.session,
      undoing: false,
      undoStopped: null,
      sourced: [],
      granted: r.granted,
      unprompted: r.unprompted,
      grant: null,
      calendarGranted: false,
      leaveFailedToYou: false,
      left: [],
      dependents: new Map(),
      userWindow: null,
      reported: new Set(ledger),
      handedOff: null,
      readerId: r.readerId,
      startedAt: r.startedAt,
      journaled: true,
    });
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
    if (task.interrupt !== null) {
      task.reconcileBy ??= Date.now() + STOP_RECONCILE_MS;
      this.interruptDeadlines.get(task.id)?.();
    }
    if (task.grant === null && !task.calendarGranted) return;
    task.grant = null;
    task.calendarGranted = false;
    this.deps.reader.grant?.({ type: "actRevoke", v: PROTOCOL_VERSION, taskId: task.id, at: Date.now() });
  }

  /** Re-reads the window a few times until the end state holds (or `effect`, when given, does), collecting changes into `seen`. */
  private async awaitEffect(task: Task, i: number, step: Step, windowId: string, seen: Change[], effect?: (w: WindowState) => boolean): Promise<void> {
    for (let n = 0; ; n++) {
      const w = this.window(windowId);
      if (effect !== undefined ? effect(w) : step.end.kind !== "calendarEvent" && (await this.holds(task, i, w, step.end))) return;
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

  /**
   * Reads the window. With `task`, no retry starts once a pause or stop is pending, nor once the run has ended: a read
   * Stop's deadline cut off can answer after the run cleared its interrupt (Greptile review).
   */
  private async walk(w: WindowState, task?: Task): Promise<Change[]> {
    const seen: Change[] = [];
    const off = this.deps.onChanges((cs) => {
      for (const c of cs) if (c.windowId === w.window.windowId) seen.push(c);
    });
    try {
      // A walk only reads, so one that fails (a busy app cuts a walk short past its deadline) is tried
      // again before the step stops. Writes and presses are never retried.
      let r = await this.deps.reader.run({ kind: "walk", pid: w.app.pid, windowId: w.window.windowId });
      for (let n = 0; n < WALK_RETRIES && r.outcome === "axError" && (task === undefined || (task.interrupt === null && task.finished === null)); n++) {
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
        (sel.number === undefined || w.window.number === sel.number) &&
        (sel.page === undefined || w.window.kind === PAGE_WINDOW_KIND) &&
        (sel.windowId === undefined || w.window.windowId === sel.windowId),
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
    if (cached?.ok === true && t.exact !== true) {
      const n = w.nodes.get(cached.node.key);
      // A cached choice still has to fit the locator in the current tree.
      if (n !== undefined && (t.role === undefined || n.role === t.role) && (t.label === undefined || norm(n.label) === norm(t.label))) return n;
    }
    // The window as it is now, or as the task found it once it has closed (B13 review: a closed source's
    // value went out as uncharged plan text).
    const sourced = task.sourced.map((v) => ({ text: v.text, window: this.deps.model.windows.get(v.windowId) ?? v.window }));
    const r = await resolveTarget(w, this.deps.model, t, goal, this.deps.askJev, this.deps.rand ?? randomInt, this.deps.targetCutoff, sourced);
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
      case "fieldsRevealed":
        // The user's own press is never something Caret finds already done; nor is a reveal, which is an event.
        return false;
      case "fileAttached":
        // A file input's contents are not in the walk: the attach runs, and the page's own file list verifies it.
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

  /**
   * Read a faulted whole-field write before acknowledging stop, without issuing or renewing a grant.
   *
   * Only a read that ended before any pause or stop reached the task may show part of Caret's own write. From then on
   * the window is the user's, and a proper prefix of the intended value reads the same whether the app took part of
   * the write or the user typed it: the journal holds only the original and the intended value (PR #21 review). Such
   * a read is unknown and Undo leaves it.
   *
   * The same holds for a whole value once the user's input may have reached the field since the write was sent
   * (InputWatch): whatever the read shows, other than the field as it was, is left to the user, and Undo leaves it.
   */
  private async readUnconfirmed(task: Task, e: Extract<LedgerEntry, { kind: "write" }>, noUndo: string | null, pressed: boolean, watch: InputWatch | null): Promise<{ state: "landed" | "untouched" | "unknown"; detail: string | null }> {
    try {
      this.checkSession(task);
      const w = this.window(e.windowId);
      // No retry starts once a pause or stop is pending, and no new grant: Stop gets one read, and none once its deadline
      // has passed. A read started then would be abandoned at once and could queue ahead of an Undo in the reader,
      // which serializes work per app (PR #21 review). The entry stays unconfirmed: Undo restores it only while the
      // field holds exactly what Caret was writing.
      if (task.reconcileBy !== undefined && Date.now() >= task.reconcileBy) throw new Error("Stop's wait ended before Caret could read the field");
      await this.untilInterruptDeadline(task, this.walk(w, task), "the recovery read timed out");
      this.checkSession(task);
    } catch (error) {
      // Undo is refused under a reader launched since (undoRefusal), so this outcome promises none.
      if (task.session !== this.session) return { state: "unknown", detail: `The field may have been written. The reader restarted before Caret could read it back; before the write it held ${JSON.stringify(e.before)}` };
      const why = error instanceof Error ? error.message : String(error);
      const may = pressed ? "The answer may have been pressed" : "The field may have been written";
      // Undo refuses a window the model no longer has (undoWrite), so a closed window or tab gets no promise.
      if (this.deps.model.windows.get(e.windowId) === undefined) return { state: "unknown", detail: `${may}, but its window is gone, so Undo cannot reach it; before, it held ${JSON.stringify(e.before)}: ${why}` };
      // The entry already carries mayIncludeInput (inputSeen), so Undo leaves the field.
      if (watch?.seen != null) return { state: "unknown", detail: `${may}, but ${watch.seen} after Caret sent it, so Undo leaves it; before, it held ${JSON.stringify(e.before)}: ${why}` };
      if (noUndo !== null) return { state: "unknown", detail: `${may}; ${noUndo}. Caret could not read it afterwards; before, it held ${JSON.stringify(e.before)}: ${why}` };
      return { state: "unknown", detail: `The field may have been written. Undo can put it back. Caret could not read the field after writing it; before the write it held ${JSON.stringify(e.before)}: ${why}` };
    }
    const field = this.deps.model.windows.get(e.windowId)?.nodes.get(e.key);
    if (field === undefined) return { state: "unknown", detail: `The field may have been written; the field is gone; before the write it held ${JSON.stringify(e.before)}` };
    const held = field.value ?? "";
    if (held === e.before) return { state: "untouched", detail: null };
    // Before any reading of the value as Caret's, a whole one or a prefix (issue #26).
    const input = watch === null ? null : (watch.seen ?? (field.inputAt !== undefined && field.inputAt >= watch.since ? "you typed in it" : null));
    if (input !== null) {
      e.mayIncludeInput = true;
      this.journalSave(task, null);
      return { state: "unknown", detail: `${fieldContents(e.before, held)}; ${input} after Caret sent its write, so Caret cannot tell its write from your input and left it as it is` };
    }
    if (sameValue(field, held, e.after)) {
      // A combobox shows the filter text Caret types before it presses the option, and a walk carries no sign of the
      // pick: only the content script's own answer does (content/combobox.ts), and that answer is what was lost.
      if (pageCombobox(field.role, e.windowId)) return { state: "unknown", detail: `Caret cannot tell whether the option was picked; ${fieldContents(e.before, held)}` };
      // No input on the field was seen since the send. Reader input that arrives after this read still keeps the entry
      // from Undo (inputSeen), though this report has promised it.
      return { state: "landed", detail: null };
    }
    if (partialReplacement(e.before, e.after, held)) {
      if (task.interrupt !== null) return { state: "unknown", detail: `${fieldContents(e.before, held)}; that may be part of Caret's write or your typing, so Caret left it as it is` };
      e.partialWrite = held;
      this.journalSave(task, null);
      return { state: "unknown", detail: "The field was partly written. Undo puts it back." };
    }
    return { state: "unknown", detail: `${fieldContents(e.before, held)}; Caret left it as it is` };
  }

  private async undoWrite(task: Task, e: Extract<LedgerEntry, { kind: "write" }>, settled: Set<LedgerEntry>): Promise<string | null | typeof UNTOUCHED> {
    /** A refusal that will not pass with time: the entry is settled. */
    const final = (reason: string): string => {
      settled.add(e);
      return reason;
    };
    // Only the element the reader recorded as written may be restored (S1 audit #6): without its mark, a sibling that
    // took the field's key, role and value would pass every other check.
    if (e.mark === null) return final("Caret did not record which element it wrote, so it cannot be sure the field is the same one");
    const w = this.deps.model.windows.get(e.windowId);
    if (w === undefined) return final("the window closed");
    // The reader acts only on an element it saw in a walk the executor asked for, so undo reads first.
    const walked = await this.deps.reader.run({ kind: "walk", pid: e.pid, windowId: e.windowId });
    if (walked.outcome !== "ok") return `cannot re-read the window: ${walked.outcome}`;
    if (task.undoStopped !== null) return task.undoStopped;
    // A write the crash cut off whose field, read just now, still holds what it held before: it never landed. A field
    // that is gone says nothing either way (a Yes/No press whose page then left, B28 review), so it is not counted.
    const field = this.deps.model.windows.get(e.windowId)?.nodes.get(e.key);
    if (e.unconfirmed === true && field === undefined) return final(`the field is gone; before the write it held ${JSON.stringify(e.before)}`);
    if (e.unconfirmed === true && field !== undefined && (field.value ?? "") === e.before) return UNTOUCHED;
    // The reader rechecks this exact held value and the recorded element right before restoring it.
    const contents = field === undefined ? "the field is gone" : fieldContents(e.before, field.value ?? "");
    if (e.mayIncludeInput === true) return final(`the field changed while Caret wrote it and may hold your typing, so Caret left it as it is; ${contents}`);
    // A page field's own record of the user's input since the write was sent, which a recovery read that failed could
    // not see (PR #33 review). The page keeps that record for 30 s after Caret's grant ends.
    const sentAt = this.sentAt.get(e);
    if (field?.inputAt !== undefined && sentAt !== undefined && field.inputAt >= sentAt) return final(`you typed in the field after Caret sent its write, so it may hold your typing and Caret left it as it is; ${contents}`);
    const shown = field?.value ?? "";
    // A prefix is put back only while the field holds exactly the one Caret read before the window was the user's
    // again (readUnconfirmed). A prefix first read here may be the user's typing (PR #21 review). A legacy `true`
    // records no reading, so it restores nothing.
    const partial = e.unconfirmed === true && field !== undefined && typeof e.partialWrite === "string" && shown === e.partialWrite;
    // An unconfirmed write is recognized only exactly (S1); numeric equivalence applies to a verified one.
    if (field !== undefined && !partial && !(e.unconfirmed === true ? shown === e.after : sameValue(field, shown, e.after))) {
      if (e.unconfirmed !== true) return final("the field changed after Caret wrote it, so Caret left it as it is");
      return final(partialReplacement(e.before, e.after, shown)
        ? `the field holds part of what Caret was writing, which may be your typing, so Caret left it as it is; ${contents}`
        : `the field does not hold what Caret was writing, so Caret left it as it is; ${contents}`);
    }
    // A field the walk lost (B15's WebKit window) is left to the reader's own check against what Caret wrote.
    const held = field === undefined ? e.after : (field.value ?? "");
    const restore: ReaderVerb = { kind: "write", pid: e.pid, windowId: e.windowId, key: e.key, role: e.role, attribute: "value", expect: held, value: e.before, taskId: task.id, sameAs: e.mark };
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
        if (r.outcome !== "ok" || !this.dropped(e.windowId, e.key, held, seen)) break;
        if (task.undoStopped !== null) return task.undoStopped;
        const other = seen.find((c) => c.editable && c.key !== e.key && (c.kind === "value" || c.kind === "removed"));
        if (other !== undefined) return final(`${other.key} changed while the field was restored, so the restore was not tried again`);
        r = await this.deps.reader.run({ ...restore, attribute: fallback.name });
        await refind();
      }
    } finally {
      off();
    }
    if (r.outcome !== "ok") {
      // A last-moment value refusal means the earlier undo read is stale. Read only for the diagnostic,
      // never retry the restore over the new text (S1).
      if (r.outcome === "changed" && e.unconfirmed === true) {
        try {
          this.checkSession(task);
          await this.walk(w);
          this.checkSession(task);
        } catch (error) {
          return final(`${undoRefused(e, r)}; cannot read the field now; before the write it held ${JSON.stringify(e.before)}: ${error instanceof Error ? error.message : String(error)}`);
        }
        const current = this.deps.model.windows.get(e.windowId)?.nodes.get(e.key);
        return final(`${undoRefused(e, r)}; ${current === undefined ? `the field is gone; before the write it held ${JSON.stringify(e.before)}` : fieldContents(e.before, current.value ?? "")}`);
      }
      // The reader not answering, or refusing for want of a grant, may pass; a field changed or replaced will not.
      const passing = r.outcome === "axError" || r.outcome === "notAllowed" || r.outcome === "noWindow";
      return passing ? undoRefused(e, r) : final(undoRefused(e, r));
    }
    const now = this.deps.model.windows.get(e.windowId)?.nodes.get(e.key);
    if (now === undefined) return final("after the restore the field is gone");
    if ((now.value ?? "") !== e.before) return final(`after the restore the field holds '${clip(now.value ?? "")}'`);
    return null;
  }

  private async undoCalendar(task: Task, e: Extract<LedgerEntry, { kind: "calendar" }>, settled: Set<LedgerEntry>): Promise<string | null> {
    try {
      const reason = await this.undoCalendarEvent(task, e);
      // An answer the calendar read and gave (gone, changed, still there) settles the entry; a throw below does not:
      // no access, a failed read or a refusal may pass, Calendar access given back included.
      if (reason !== null) settled.add(e);
      return reason;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private async undoCalendarEvent(task: Task, e: Extract<LedgerEntry, { kind: "calendar" }>): Promise<string | null> {
    const cal = this.deps.calendar;
    if (cal === null) return "no calendar is configured";
    // An add a crash cut off before its answer: the event, if it was saved, is found by its slot. The reader removes it
    // only if this task added it (CalendarAdapter ownership).
    let eventId = e.eventId;
    if (eventId === null) {
      const found = await cal.find(e.calendar, e.title, e.start, e.end);
      if (found === null) return "Caret stopped while adding this event, and the calendar does not hold it";
      eventId = found.id;
    }
    const ev = await cal.get(eventId);
    if (ev === null) return "the event is already gone";
    if (ev.title !== e.title || ev.calendar !== e.calendar || Date.parse(ev.start) !== Date.parse(e.start) || Date.parse(ev.end) !== Date.parse(e.end)) {
      return "the event changed after Caret added it";
    }
    await cal.remove(eventId, task.id);
    // A read that fails throws (S1 audit #16): only a read that succeeds and finds nothing counts as removed.
    return (await cal.get(eventId)) === null ? null : "the event is still there after removal";
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
      // Steps the run left to the user (RunOptions.leaveFailedToYou) are not reached, done or not.
      remaining: [...task.left.map((l) => task.plan.steps[l.step]?.says ?? l.says), ...task.plan.steps.slice(from).map((s) => s.says)],
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

/** undoWrite's answer for a write a crash cut off that never landed. */
const UNTOUCHED = Symbol("untouched");

/**
 * Whether field `n`, read as `held`, holds the value Caret wrote (B29: anything else may be the user's typing). Exactly,
 * except in a page's number field (PAGE_SUBROLE.number), where both are compared as plain decimal numbers, since a page
 * may show "1" as "1.00". Never in a text field, and never across grouping separators, signs of locale or units.
 * The comparison is exact on the digits (canonicalDecimal), not through Number(): review 1 found 9007199254740992 equal
 * to 9007199254740993, 1e309 to 2e309 and 1e-999 to 0 that way, so undo restored over the user's number.
 */
export function sameValue(n: Node, held: string, wrote: string): boolean {
  if (held === wrote) return true;
  if (n.subrole !== PAGE_SUBROLE.number) return false;
  const a = canonicalDecimal(held);
  return a !== null && a === canonicalDecimal(wrote);
}

/** A decimal number as an input of type number holds one: optional sign, digits with at most one point, optional exponent. */
const PLAIN_NUMBER = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,6}))?$/;

/**
 * One spelling per number: "-123e-2" for -1.23, "0" for any zero. Digits keep every place, so two spellings match only
 * when they are the same number exactly. Null for anything PLAIN_NUMBER does not take, or one with no digit.
 */
export function canonicalDecimal(s: string): string | null {
  const m = PLAIN_NUMBER.exec(s);
  if (m === null) return null;
  const whole = m[2] ?? "";
  const frac = m[3] ?? "";
  if (whole === "" && frac === "") return null;
  let digits = (whole + frac).replace(/^0+/, "");
  if (digits === "") return "0";
  let exp = Number(m[4] ?? "0") - frac.length;
  const trailing = /0+$/.exec(digits)?.[0].length ?? 0;
  digits = digits.slice(0, digits.length - trailing);
  exp += trailing;
  return `${m[1] === "-" ? "-" : ""}${digits}e${exp}`;
}

/**
 * A page's custom combobox, whose walk shows the filter text Caret typed and a picked option alike (content/combobox.ts).
 * A native AXComboBox write sets the value itself, so its read-back is its end state.
 */
function pageCombobox(role: string, windowId: string): boolean {
  return role === "AXComboBox" && windowId.startsWith("page:");
}

/** S1's whole-field replacement rule. An unchanged original takes precedence, even if it is a prefix. */
function partialReplacement(before: string, intended: string, held: string): boolean {
  return held !== before && held.length > 0 && held.length < intended.length && intended.startsWith(held);
}

/** JSON quoting preserves the full values and makes empty text, newlines and quotes distinguishable. */
function fieldContents(before: string, held: string): string {
  return `the field now holds ${JSON.stringify(held)}; before the write it held ${JSON.stringify(before)}`;
}

/** Why the reader refused a restore, in words for the activity row. */
function undoRefused(e: Extract<LedgerEntry, { kind: "write" }>, r: VerbResult): string {
  const detail = r.detail === null ? "" : ` (${r.detail})`;
  switch (r.outcome) {
    case "notSameElement":
      return `the field Caret wrote is no longer the element at that place, so Caret left it alone${detail}`;
    case "focusMoved":
      return `focus moved away from the field when Caret focused it, so Caret did not write it${detail}`;
    case "changed":
      return e.unconfirmed === true
        ? `Caret stopped while writing this field, and the field does not hold what it was writing${detail}`
        : `the field changed after Caret wrote it${detail}`;
    default:
      return `${r.outcome}: ${r.detail ?? ""}`;
  }
}

/** "Name", "Name and Email", or "3 fields" past two. */
function names(xs: readonly string[]): string {
  if (xs.length <= 2) return xs.join(" and ");
  return xs.every((x) => x.startsWith("'")) ? `${xs.length} controls` : `${xs.length} fields`;
}

function clip(s: string, max = 60): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
