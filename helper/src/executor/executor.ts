// The executor (deep plan section 7). For each step of a plan:
//   1. Re-read the step's window and stop if anything it saw at the start has changed under it.
//   2. If the end state already holds, skip the step. A finished plan therefore reruns as a no-op.
//   3. Pick the means: a value or focus write, a press, a raise, the calendar, or a URL. A press whose label
//      reads as send, submit, delete or pay is never made; the run stops and hands it to the user.
//   4. Predict the change, act through a reader verb that rechecks the exact target, re-read the
//      window, and compare what changed against the prediction. A mismatch stops the run at that step.
// Real input in a window the task acts in, or a pause or take-over from a consumer, pauses it at the
// next step boundary: before the next step starts, or before the current step acts if its reads are
// still under way. A stop ends it there. Every write goes in an undo ledger with the value it replaced.
import { randomInt } from "node:crypto";
import { PROTOCOL_VERSION, type AppRef, type Frame, type Node, type TaskCause, type TaskPhase, type TaskProgress, type UserInput, type ReaderVerb } from "../protocol.ts";
import { nodeText, type Change, type ScreenModel, type WindowState } from "../model.ts";
import type { AskJev } from "../fill/jev.ts";
import type { CalendarPort, ReaderLink, UrlOpener } from "./means.ts";
import { classifyLabel } from "./risk.ts";
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

/** Why a run must stop at its next step boundary. `takeOver` is a pause that hands the run back to the user. */
interface Interrupt {
  kind: "pause" | "stop";
  by: "input" | "control" | "takeOver";
  why: string;
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
/** The numbers a done or undone taskProgress carries beside its sentence. */
type ProgressCounts = Pick<TaskProgress, "written" | "restored" | "notRestored" | "notUndoablePresses">;

export type LedgerEntry =
  | { kind: "write"; step: number; pid: number; windowId: string; key: string; role: string; before: string; after: string }
  | { kind: "calendar"; step: number; eventId: string; calendar: string; title: string; start: string; end: string }
  | { kind: "press"; step: number; label: string };

export interface UndoResult {
  restored: number;
  notRestored: { step: number; reason: string }[];
  notUndoable: number;
}

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
  /**
   * Slot values the plan copied from windows, by the window's id (Plan.sources), each with its window as
   * the task found it: a target question charges that window for the value even after it has closed.
   */
  sourced: { text: string; windowId: string; window: WindowState | undefined }[];
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
  /** A stop caused by the screen changing under the task, not by a mismatch after Caret acted. */
  readonly by: TaskCause;
  constructor(outcome: "stopped" | "handoff", message: string, by: TaskCause = "caret") {
    super(message);
    this.outcome = outcome;
    this.by = by;
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
  async run(taskId: string, rawPlan: unknown, slots: Record<string, string>, expect?: Record<string, Record<string, string>>): Promise<TaskResult> {
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
      sourced: Object.entries(parsed.data.sources ?? {}).flatMap(([slot, windowId]) => {
        const text = slots[slot];
        return text === undefined ? [] : [{ text, windowId, window: this.deps.model.windows.get(windowId) }];
      }),
    };
    for (const [windowId, values] of Object.entries(expect ?? {})) task.expected.set(windowId, new Map(Object.entries(values)));
    this.tasks.set(taskId, task);
    this.progress(task, "started", null, null);
    return this.loop(task);
  }

  /** Continues a paused task from the step it paused at, accepting whatever the user changed meanwhile. */
  async resume(taskId: string): Promise<TaskResult> {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new PlanError(`no task ${taskId}`);
    if (task.finished !== "paused") throw new PlanError(`task ${taskId} is ${task.finished ?? "running"}, not paused`);
    task.interrupt = null;
    task.finished = null;
    task.expected.clear();
    return this.loop(task);
  }

  /** Real input from the reader: pause any task acting in that window at its next step boundary. */
  onUserInput(m: UserInput): void {
    for (const task of this.tasks.values()) {
      if (task.finished !== null || task.interrupt?.kind === "stop") continue;
      for (const windowId of task.windows.values()) {
        const w = this.deps.model.windows.get(windowId);
        if (w === undefined || w.app.pid !== m.pid) continue;
        const inside = m.kind === "mouse" ? m.point !== null && w.window.frame !== null && contains(w.window.frame, m.point) : w.focused;
        if (inside) task.interrupt = { kind: "pause", by: "input", why: `${m.kind === "key" ? "typing" : "a click"} in '${w.window.title}'` };
      }
    }
  }

  /**
   * Pauses a running task at its next step boundary; the running `run` or `resume` call then resolves
   * as paused. `takeOver` hands the run back to the user: the paused phase names the step it reached.
   * Taking over an already paused task reports it again as handed back. A pause for `input` (the host
   * saw the user's own input) leaves a pending pause from the reader's userInput as it is, since that one
   * names what the user did and where; a userInput after it replaces its wording in turn.
   */
  pause(taskId: string, takeOver: boolean, reason?: "input"): void {
    const task = this.need(taskId);
    const by = takeOver ? "takeOver" : reason ?? "control";
    if (task.finished === "paused") {
      if (takeOver) this.progress(task, "paused", task.next, this.pauseDetail(task, { kind: "pause", by, why: "" }), "you");
      return;
    }
    if (task.finished !== null) throw new PlanError(`task ${taskId} is ${task.finished}; there is nothing to pause`);
    if (task.interrupt?.kind === "stop" || (by === "input" && task.interrupt?.by === "input")) return;
    task.interrupt = { kind: "pause", by, why: takeOver ? "you took over" : by === "input" ? "your input" : "you paused it" };
  }

  /** Ends a running task at its next step boundary, or a paused one now. What it wrote stays; undo restores it. */
  stop(taskId: string): void {
    const task = this.need(taskId);
    if (task.finished === "paused") {
      task.finished = "stopped";
      releaseSources(task);
      this.progress(task, "stopped", task.next, `stopped by you before step ${task.next + 1} of ${task.plan.steps.length}`, "you");
      return;
    }
    if (task.finished !== null) throw new PlanError(`task ${taskId} is ${task.finished}; there is nothing to stop`);
    task.interrupt = { kind: "stop", by: "control", why: "you stopped it" };
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

  private pauseDetail(task: Task, it: Interrupt): string {
    const where = `before step ${task.next + 1} of ${task.plan.steps.length}`;
    if (it.by === "takeOver") return `Caret handed this back to you ${where}`;
    return `paused ${where}: ${it.why}`;
  }

  /**
   * Restores every write of a task, newest first, each only if the field still holds what the task
   * wrote. Calendar events are removed only if unchanged. Presses cannot be undone and are counted.
   */
  async undo(taskId: string): Promise<UndoResult> {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new PlanError(`no task ${taskId}`);
    if (task.finished === null) throw new PlanError(`task ${taskId} is still running`);
    if (task.undoing) throw new PlanError(`task ${taskId} is already being undone`);
    if (task.session !== this.session) throw new PlanError(`task ${taskId} ran under an earlier reader session; its window ids no longer apply, so nothing is restored`);
    // A paused run whose writes are being restored cannot continue from where it was, so it stops
    // being resumable before the first restore is awaited.
    if (task.finished === "paused") task.finished = "stopped";
    releaseSources(task);
    task.undoing = true;
    const out: UndoResult = { restored: 0, notRestored: [], notUndoable: 0 };
    const remaining: LedgerEntry[] = [];
    try {
      for (const e of [...task.ledger].reverse()) {
        if (e.kind === "press") {
          out.notUndoable++;
          remaining.push(e);
          continue;
        }
        const reason = task.session !== this.session ? "the reader restarted during undo" : e.kind === "write" ? await this.undoWrite(e) : await this.undoCalendar(e);
        if (reason === null) out.restored++;
        else {
          out.notRestored.push({ step: e.step, reason });
          remaining.push(e);
        }
      }
      task.ledger = remaining.reverse();
    } finally {
      task.undoing = false;
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
      task.finished = "done";
      // Fields this run wrote, each once however many writes it took; presses and calendar events are not fields.
      const written = new Set(task.ledger.flatMap((e) => (e.kind === "write" ? [`${e.windowId}\u0000${e.key}`] : []))).size;
      this.progress(task, "done", null, `${task.acted} acted, ${task.skipped} already true`, null, { written });
      return this.result(task, "done", null, null);
    } catch (e) {
      const i = task.next;
      const it = task.interrupt;
      if (e instanceof Interrupted && it !== null) {
        task.interrupt = null;
        if (it.kind === "stop") {
          const detail = `stopped by you before step ${i + 1} of ${steps.length}`;
          task.finished = "stopped";
          this.progress(task, "stopped", i, detail, "you");
          return this.result(task, "stopped", i, detail);
        }
        const detail = this.pauseDetail(task, it);
        task.finished = "paused";
        this.progress(task, "paused", i, detail, "you");
        return this.result(task, "paused", i, detail);
      }
      const outcome = e instanceof StepStop ? e.outcome : "stopped";
      const detail = e instanceof Error ? e.message : String(e);
      task.finished = outcome;
      this.progress(task, outcome === "handoff" ? "handoff" : "stopped", i, detail, e instanceof StepStop ? e.by : "caret");
      return this.result(task, outcome, i, detail);
    } finally {
      if (task.finished !== null && task.finished !== "paused") releaseSources(task);
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
    if (r.outcome !== "ok") throw new StepStop("stopped", `the reader cannot watch for input: ${r.outcome}`);
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

    if (end.kind === "valueEquals" || end.kind === "focused") {
      const node = await this.resolve(task, i, w, end.target, step.says);
      if (end.kind === "valueEquals" && node.editable === true) return this.writeStep(task, i, w, node, "value", end.value, step);
      if (end.kind === "focused" && step.via === undefined) return this.writeStep(task, i, w, node, "focused", "", step);
    }
    if (step.via === undefined) throw new StepStop("stopped", `no means to reach '${step.says}': the target is not a field and the step names no press or URL`);
    if (step.via.kind === "press") return this.pressStep(task, i, w, step.via.target, step);
    return this.urlStep(task, i, w, step.via.url, step);
  }

  // MARK: - means

  private async writeStep(task: Task, i: number, w: WindowState, node: Node, attribute: "value" | "focused", value: string, step: Step): Promise<void> {
    if (node.states?.includes("secure")) throw new StepStop("handoff", `'${step.says}' targets a password field; that is left to you`);
    const before = node.value ?? "";
    const prediction = attribute === "value" ? `${node.key}: '${clip(before)}' becomes '${clip(value)}'` : `${node.key} becomes focused`;
    this.checkInterrupt(task);
    this.progress(task, "acting", i, `write ${attribute}; expect ${prediction}`);
    const verb: ReaderVerb = { kind: "write", pid: w.app.pid, windowId: w.window.windowId, key: node.key, role: node.role, attribute, expect: before, value };
    await this.deps.beforeAct?.(task.id, i);
    let seen: Change[];
    try {
      seen = await this.act(task, verb, w.window.windowId);
    } catch (e) {
      // An axError may come after the value was set (a timeout while the reader settles and re-walks),
      // so the write is recorded as if it happened. Undo restores it only if the field holds `value`.
      if (attribute === "value" && e instanceof StepStop && e.message.includes("axError")) {
        task.ledger.push({ kind: "write", step: i, pid: w.app.pid, windowId: w.window.windowId, key: node.key, role: node.role, before, after: value });
      }
      throw e;
    }

    const after = this.window(w.window.windowId);
    const now = after.nodes.get(node.key);
    if (attribute === "value") {
      // The reader wrote, so the write goes in the ledger before it is judged: an app that reformats
      // the value fails the comparison but must still be undoable. `after` is what the field holds now.
      if (now !== undefined && (now.value ?? "") !== before) {
        task.ledger.push({ kind: "write", step: i, pid: w.app.pid, windowId: w.window.windowId, key: node.key, role: node.role, before, after: now.value ?? "" });
      }
      const recorded = seen.some((c) => c.kind === "value" && c.key === node.key && c.after === value);
      if (now === undefined || (now.value ?? "") !== value || !recorded) {
        throw new StepStop("stopped", `mismatch: expected ${prediction}; the field now holds '${clip(now?.value ?? "(gone)")}'`);
      }
      this.expectedFor(task, w.window.windowId).set(node.key, value);
    } else if (after.focusedKey !== node.key) {
      throw new StepStop("stopped", `mismatch: expected ${prediction}; focus is on ${after.focusedKey ?? "nothing"}`);
    }
    this.checkUnexpected(seen, attribute === "value" ? node.key : null);
    await this.verified(task, i, step);
  }

  private async pressStep(task: Task, i: number, w: WindowState, target: Target, step: Step): Promise<void> {
    const node = await this.resolve(task, i, w, target, step.says);
    const label = (node.label ?? "").trim();
    if (label === "") throw new StepStop("handoff", `the control for '${step.says}' has no label, so its effect cannot be classified; press it yourself`);
    const risk = classifyLabel(label);
    if (risk !== "safe") throw new StepStop("handoff", `'${label}' reads as ${risk}; Caret leaves that press to you`);
    this.checkInterrupt(task);
    this.progress(task, "acting", i, `press '${label}'; expect: ${step.says}`);
    await this.deps.beforeAct?.(task.id, i);
    const seen = await this.act(task, { kind: "press", pid: w.app.pid, windowId: w.window.windowId, key: node.key, role: node.role, label }, w.window.windowId);
    task.ledger.push({ kind: "press", step: i, label });
    await this.awaitEffect(task, i, step, w.window.windowId, seen);
    this.checkUnexpected(seen, null);
    await this.verified(task, i, step);
  }

  /** Brings the window to the front. Nothing is written, so nothing goes in the ledger. */
  private async raiseStep(task: Task, i: number, w: WindowState, step: Step): Promise<void> {
    this.checkInterrupt(task);
    this.progress(task, "acting", i, `raise; expect '${clip(w.window.title)}' in ${w.app.name} to be the focused window`);
    await this.deps.beforeAct?.(task.id, i);
    const seen = await this.act(task, { kind: "raise", pid: w.app.pid, windowId: w.window.windowId }, w.window.windowId);
    await this.awaitEffect(task, i, step, w.window.windowId, seen);
    this.checkUnexpected(seen, null);
    await this.verified(task, i, step);
  }

  private async urlStep(task: Task, i: number, w: WindowState, url: string, step: Step): Promise<void> {
    if (this.deps.urls === null) throw new StepStop("stopped", "no URL opener is configured");
    this.checkInterrupt(task);
    this.progress(task, "acting", i, `open ${url}; expect: ${step.says}`);
    await this.deps.urls.open(url);
    await this.awaitEffect(task, i, step, w.window.windowId, []);
    await this.verified(task, i, step);
  }

  private async calendarStep(task: Task, i: number, end: Extract<EndState, { kind: "calendarEvent" }>): Promise<void> {
    const cal = this.deps.calendar;
    if (cal === null) throw new StepStop("stopped", "no calendar is configured");
    if ((await cal.find(end.calendar, end.title, end.start, end.end)) !== null) {
      task.skipped++;
      this.progress(task, "skipped", i, "already true");
      return;
    }
    this.checkInterrupt(task);
    this.progress(task, "acting", i, `add event '${end.title}' to ${end.calendar}; expect it to be found there`);
    this.checkSession(task);
    const ev = await cal.add(end.calendar, end.title, end.start, end.end);
    const found = await cal.find(end.calendar, end.title, end.start, end.end);
    if (found === null || found.id !== ev.id) throw new StepStop("stopped", "mismatch: the added event is not found by the same query");
    task.ledger.push({ kind: "calendar", step: i, eventId: ev.id, calendar: ev.calendar, title: ev.title, start: ev.start, end: ev.end });
    task.acted++;
    this.progress(task, "verified", i, null);
  }

  // MARK: - acting and comparing

  /** Sends a verb and returns every change the model recorded while it ran. */
  private async act(task: Task, verb: ReaderVerb, windowId: string): Promise<Change[]> {
    this.checkSession(task);
    // The last boundary: a pause or stop that arrived while the step published or prepared its act.
    this.checkInterrupt(task);
    const seen: Change[] = [];
    const off = this.deps.onChanges((cs) => {
      for (const c of cs) if (c.windowId === windowId) seen.push(c);
    });
    try {
      const r = await this.deps.reader.run(verb);
      if (r.outcome !== "ok") throw new StepStop("stopped", `the reader refused: ${r.outcome}${r.detail === null ? "" : ` (${r.detail})`}`);
    } finally {
      off();
    }
    return seen;
  }

  /** Re-reads the window a few times until the end state holds, collecting changes into `seen`. */
  private async awaitEffect(task: Task, i: number, step: Step, windowId: string, seen: Change[]): Promise<void> {
    for (let n = 0; ; n++) {
      const w = this.window(windowId);
      if (step.end.kind !== "calendarEvent" && (await this.holds(task, i, w, step.end))) return;
      if (n >= EFFECT_POLLS) throw new StepStop("stopped", `mismatch: after acting, '${step.says}' does not hold`);
      await this.sleep(EFFECT_POLL_MS);
      seen.push(...(await this.walk(w)));
    }
  }

  /** A field the step did not target changed while it acted: something other than the plan is at work. */
  private checkUnexpected(seen: readonly Change[], allowedKey: string | null): void {
    for (const c of seen) {
      if (!c.editable || c.key === allowedKey) continue;
      if (c.kind === "value" || c.kind === "removed") {
        throw new StepStop("stopped", `mismatch: ${c.key} ${c.kind === "removed" ? "disappeared" : "changed"} although the step did not touch it`);
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
    await this.walk(w);
    // A pause or take-over that came in during the walk wins over anything the walk found: the user
    // may already be changing the window, and the run must pause, not fail.
    this.checkInterrupt(task);
    const fresh = this.window(id);
    for (const n of fresh.nodes.values()) {
      if (n.role === "AXSheet") throw new StepStop("stopped", `a sheet covers '${fresh.window.title}'`, "screen");
    }
    const exp = task.expected.get(id);
    if (exp === undefined) {
      task.expected.set(id, editableValues(fresh));
    } else {
      for (const [key, text] of editableValues(fresh)) {
        const want = exp.get(key);
        if (want === undefined) exp.set(key, text);
        else if (want !== text) throw new StepStop("stopped", `${key} changed since the plan started: '${clip(want)}' is now '${clip(text)}'`, "screen");
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
      if (r.outcome !== "ok") throw new StepStop("stopped", `cannot re-read '${w.window.title}': ${r.outcome}${r.detail === null ? "" : ` (${r.detail})`}`);
    } finally {
      off();
    }
    return seen;
  }

  private checkSession(task: Task): void {
    if (task.session !== this.session) throw new StepStop("stopped", "the reader restarted since this task began, so its window ids no longer apply", "screen");
  }

  private bind(task: Task, sel: WindowSel): string {
    this.checkSession(task);
    const k = JSON.stringify(sel);
    const bound = task.windows.get(k);
    if (bound !== undefined) {
      if (!this.deps.model.windows.has(bound)) throw new StepStop("stopped", `the window '${sel.title ?? sel.titleStartsWith}' closed`, "screen");
      return bound;
    }
    const hits = [...this.deps.model.windows.values()].filter(
      (w) =>
        (sel.bundleId === undefined || w.app.bundleId === sel.bundleId) &&
        (sel.title === undefined || w.window.title === sel.title) &&
        (sel.titleStartsWith === undefined || w.window.title.startsWith(sel.titleStartsWith)),
    );
    if (hits.length === 0) throw new StepStop("stopped", `no window matches ${k}`, "screen");
    if (hits.length > 1) throw new StepStop("stopped", `${hits.length} windows match ${k}; the plan must name one`);
    const id = (hits[0] as WindowState).window.windowId;
    task.windows.set(k, id);
    return id;
  }

  private window(id: string): WindowState {
    const w = this.deps.model.windows.get(id);
    if (w === undefined) throw new StepStop("stopped", `window ${id} is gone`, "screen");
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
    if (!r.ok) throw new StepStop("stopped", `target for '${goal}' not found: ${r.reason}`);
    task.resolved.set(cacheKey, r);
    return r.node;
  }

  /** Whether an end state holds in the model now. Exists and absent never ask Jev. */
  private async holds(task: Task, i: number, w: WindowState, end: Exclude<EndState, { kind: "calendarEvent" }>): Promise<boolean> {
    switch (end.kind) {
      case "windowTitle":
        return w.window.title === end.title;
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

  private async undoWrite(e: Extract<LedgerEntry, { kind: "write" }>): Promise<string | null> {
    const w = this.deps.model.windows.get(e.windowId);
    if (w === undefined) return "the window closed";
    // The reader acts only on an element it saw in a walk the executor asked for, so undo reads first.
    const walked = await this.deps.reader.run({ kind: "walk", pid: e.pid, windowId: e.windowId });
    if (walked.outcome !== "ok") return `cannot re-read the window: ${walked.outcome}`;
    const r = await this.deps.reader.run({ kind: "write", pid: e.pid, windowId: e.windowId, key: e.key, role: e.role, attribute: "value", expect: e.after, value: e.before });
    if (r.outcome !== "ok") return r.outcome === "changed" ? `the field changed after Caret wrote it (${r.detail ?? "no detail"})` : `${r.outcome}: ${r.detail ?? ""}`;
    const now = this.deps.model.windows.get(e.windowId)?.nodes.get(e.key);
    if ((now?.value ?? "") !== e.before) return `after the restore the field holds '${clip(now?.value ?? "(gone)")}'`;
    return null;
  }

  private async undoCalendar(e: Extract<LedgerEntry, { kind: "calendar" }>): Promise<string | null> {
    const cal = this.deps.calendar;
    if (cal === null) return "no calendar is configured";
    const ev = await cal.get(e.eventId);
    if (ev === null) return "the event is already gone";
    if (ev.title !== e.title || ev.calendar !== e.calendar || Date.parse(ev.start) !== Date.parse(e.start) || Date.parse(ev.end) !== Date.parse(e.end)) {
      return "the event changed after Caret added it";
    }
    await cal.remove(e.eventId);
    return (await cal.get(e.eventId)) === null ? null : "the event is still there after removal";
  }

  // MARK: - reporting

  private progress(task: Task, phase: TaskPhase, step: number | null, detail: string | null, cause: TaskCause | null = null, counts: ProgressCounts = {}): void {
    const says = step === null ? null : (task.plan.steps[step]?.says ?? null);
    const steps = task.plan.steps.length;
    this.deps.publish({ type: "taskProgress", v: PROTOCOL_VERSION, at: Date.now(), taskId: task.id, planId: task.plan.id, phase, step, steps, says, detail, ...counts });
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

function clip(s: string): string {
  return s.length <= 60 ? s : `${s.slice(0, 59)}…`;
}
