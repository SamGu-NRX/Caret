// The helper's core, independent of sockets: it applies reader messages to the screen model,
// feeds the rolling text window, the transfer detector and the shadow logger, and asks for
// grounded fill proposals. server.ts connects it to the socket; tests drive it directly.
import { ScreenModel } from "./model.ts";
import { RollingText } from "./rolling-text.ts";
import { TransferDetector, type Transfer } from "./transfers.ts";
import { ShadowLogger } from "./shadow.ts";
import type { Store } from "./store.ts";
import type { AskJev } from "./fill/jev.ts";
import { FillError, formFields, proposeFill } from "./fill/fill.ts";
import {
  PROTOCOL_VERSION,
  type ActivityReply,
  type ActivityRequest,
  type FillProposal,
  type FillResult,
  type FillRequest,
  type HelperMessage,
  type MemoryReply,
  type MemoryRequest,
  type OfferControl,
  type ReaderCommand,
  type ReaderMessage,
  type ReaderVerb,
  type VerbResult,
  type RunPlan,
  type TaskControl,
  type TaskCause,
  type TaskPhase,
  type TaskState,
} from "./protocol.ts";
import type { Change } from "./model.ts";
import { Executor, type ExecutorDeps, type TaskEvent, type TaskResult, type UndoResult } from "./executor/executor.ts";
import { SocketReaderLink, type CalendarPort, type ReaderLink, type UrlOpener } from "./executor/means.ts";
import { MemoryStore } from "./patterns/memory.ts";
import { PatternEngine } from "./patterns/engine.ts";
import { TaskRegistry, TransitionError } from "./tasks/registry.ts";
import { PendingWatcher } from "./tasks/pending.ts";
import { Audit } from "./audit.ts";

export interface HelperOptions {
  store: Store;
  /** Null disables Jev entirely: no fill proposals are made. */
  askJev: AskJev | null;
  /** Force shadow mode regardless of what the reader's hello says. */
  shadow: boolean;
  /**
   * Accept focus events from apps that are not frontmost as fill triggers. Only for fixture
   * evaluations, where the fixture must not take focus away from whoever is using the Mac.
   */
  allowBackgroundFocus: boolean;
  /** Overrides FILL_CUTOFF, for calibration runs that need every agreed choice. */
  fillCutoff?: number;
  /** Sends a command to the connected reader; false when none is connected. Without it the executor cannot act. */
  sendToReader?: (cmd: ReaderCommand) => boolean;
  /** Replaces the socket link to the reader, for tests that simulate the reader in process. */
  readerLink?: ReaderLink;
  calendar?: CalendarPort | null;
  /** Memory entries, the decision log and reactions. Defaults to a store beside `store`'s database. */
  memory?: MemoryStore;
  urls?: UrlOpener | null;
  /**
   * Runs the read-only audit beside the helper (src/audit.ts). Only with shadow mode and Jev off,
   * since the audit's numbers are about what the helper would have done, not what it did.
   */
  audit?: boolean;
  /** Fault-injection seams for the executor evaluation; see ExecutorDeps. */
  executorHooks?: Pick<ExecutorDeps, "beforeStep" | "beforeAct" | "targetCutoff">;
  publish: (m: HelperMessage) => void;
  warn?: (line: string) => void;
}

/** The activity state each executor phase puts its task in. */
const PHASE_STATE: Record<TaskPhase, TaskState> = {
  started: "running",
  skipped: "running",
  acting: "running",
  verified: "running",
  paused: "paused",
  handoff: "needsYou",
  stopped: "failed",
  done: "done",
  undone: "undone",
};

/** A host-reported insert and the transfer it explains are this close in time. Assumed: the transfer is judged after SETTLE_MS. */
const CARET_FILL_MATCH_MS = 10_000;
/** Proposals are remembered this long so a late fillResult can still be matched. Assumed. */
const PROPOSAL_KEEP_MS = 10 * 60 * 1000;

/** A value the host reported inserting for Caret, and the transfer it was matched to, if any yet. */
interface CaretFill {
  proposalId: string;
  at: number;
  value: string;
  /** When the host reported the undo. Only edits from before it belong to the fill. */
  undoneAt: number | null;
  /** Every transfer the fill explains: usually one, more when the inserted text holds several values. */
  transfers: Transfer[];
}

const fieldId = (windowId: string, key: string): string => `${windowId}\u0000${key}`;

/** Whether a transfer comes from this fill: the same field (checked by the caller), close in time, overlapping values, and an edit made before any undo. */
function fillMatches(f: CaretFill, t: Transfer): boolean {
  if (f.undoneAt !== null && t.at > f.undoneAt) return false;
  return Math.abs(t.at - f.at) <= CARET_FILL_MATCH_MS && (f.value.includes(t.value) || t.value.includes(f.value));
}

/** Re-asking Jev for the same form inside this window returns nothing new. Assumed. */
const FILL_REPEAT_MS = 30_000;
const PRUNE_EVERY_MS = 10_000;

export class Helper {
  readonly model = new ScreenModel();
  readonly text = new RollingText();
  readonly transfers: TransferDetector;
  readonly shadowLogger: ShadowLogger;
  readonly recentTransfers: Transfer[] = [];
  mode: "live" | "shadow";
  private readonly opts: HelperOptions;
  private readonly lastFill = new Map<string, number>();
  private readonly inflight = new Set<string>();
  /** Recent proposals, by id: the window and each proposed field's value, so fillResult can be checked and matched. */
  private readonly proposals = new Map<string, { at: number; windowId: string; values: Map<string, string> }>();
  /** Host-reported inserts, by window and field. */
  private readonly caretFills = new Map<string, CaretFill>();
  private lastPrune = 0;
  readonly executor: Executor;
  readonly memory: MemoryStore;
  readonly patterns: PatternEngine;
  /** Every piece of Caret's work and its state, published as activity messages. */
  readonly tasks: TaskRegistry;
  /** Watches on windows the user left while they showed unfinished work. */
  readonly pending: PendingWatcher;
  private readonly socketLink: SocketReaderLink | null;
  private readonly changeListeners = new Set<(changes: readonly Change[]) => void>();
  /** The read-only audit, when the helper runs one. */
  readonly audit: Audit | null;
  /** Field values of a window just before a focus walk replaced them, for the shadow logger. */
  private preFocus: { windowId: string; values: Map<string, string> } | null = null;

  constructor(opts: HelperOptions) {
    this.opts = opts;
    if (opts.audit === true && (!opts.shadow || opts.askJev !== null)) throw new Error("the audit runs only in shadow mode with Jev off");
    this.mode = opts.shadow ? "shadow" : "live";
    this.transfers = new TransferDetector(this.model, this.text);
    this.shadowLogger = new ShadowLogger(this.model, this.text, opts.store);
    this.socketLink = opts.readerLink === undefined ? new SocketReaderLink(opts.sendToReader ?? (() => false)) : null;
    this.tasks = new TaskRegistry((m) => opts.publish(m));
    this.executor = new Executor({
      model: this.model,
      reader: opts.readerLink ?? (this.socketLink as SocketReaderLink),
      calendar: opts.calendar ?? null,
      urls: opts.urls ?? null,
      askJev: opts.askJev,
      publish: (m) => opts.publish(m),
      onTask: (e) => this.onTaskEvent(e),
      onChanges: (l) => {
        this.changeListeners.add(l);
        return () => this.changeListeners.delete(l);
      },
      ...opts.executorHooks,
    });
    this.memory = opts.memory ?? new MemoryStore(opts.store.dir);
    this.patterns = new PatternEngine({
      model: this.model,
      text: this.text,
      memory: this.memory,
      hash: (t) => opts.store.hash(t),
      publish: (m) => {
        if (this.mode !== "live") return;
        opts.publish(m);
        this.onPatternMessage(m);
      },
      run: (taskId, plan, slots) => this.executor.run(taskId, plan, slots),
      shadow: () => this.mode === "shadow",
    });
    this.pending = new PendingWatcher({
      model: this.model,
      askJev: opts.askJev,
      tasks: this.tasks,
      reader: (v) => this.readerVerb(v),
      live: () => this.mode === "live",
      ...(opts.warn === undefined ? {} : { warn: opts.warn }),
    });
    this.audit = opts.audit === true ? new Audit({ model: this.model, reader: (v) => this.readerVerb(v) }) : null;
  }

  /** Returns the fill proposal promise when the message triggered one, for tests and evals. */
  handleReader(m: ReaderMessage): Promise<FillProposal | null> | null {
    const store = this.opts.store;
    switch (m.type) {
      case "hello":
        // A new reader numbers windows from scratch and walks everything again, so the old session's
        // windows, text and open edits are judged now and then forgotten.
        this.record(this.transfers.flush());
        this.shadowLogger.close();
        this.model.reset();
        this.text.clear();
        this.executor.readerRestarted();
        this.patterns.readerRestarted();
        this.pending.readerRestarted();
        this.audit?.readerRestarted(Date.now());
        if (m.mode === "shadow") this.mode = "shadow";
        store.count(`reader.hello_${m.mode}`, 1);
        return null;
      case "snapshot": {
        const prevFocused = this.model.focusedWindowId;
        if (m.reason === "focus") {
          const prior = this.model.windows.get(m.window.windowId);
          this.preFocus = { windowId: m.window.windowId, values: new Map(prior === undefined ? [] : [...prior.nodes].map(([k, n]) => [k, n.value ?? ""])) };
        }
        const changes = this.model.apply(m);
        if (changes.length > 0) for (const l of this.changeListeners) l(changes);
        const w = this.model.windows.get(m.window.windowId);
        if (w !== undefined) this.text.observe(w, m.at);
        store.count(`reader.snapshot_${m.reason}`, 1, m.at);
        store.count("reader.nodes", m.nodes.length, m.at);
        if (m.stats.truncated) store.count("reader.truncated", 1, m.at);
        const cleared = this.transfers.onChanges(changes);
        this.patterns.onChanges(changes);
        // Recorded after the pattern engine has seen the edits, the order tick-judged transfers arrive in.
        this.record(cleared);
        if (this.mode === "shadow") this.shadowLogger.onChanges(changes);
        const moved = prevFocused !== this.model.focusedWindowId;
        if (prevFocused !== null && moved) this.record(this.transfers.flush(prevFocused));
        this.pending.onSnapshot(m.window.windowId);
        this.audit?.onSnapshot(m);
        // The user left a window: the reader's leave walk of it, or focus arriving in another window.
        if (m.reason === "leave") this.left(m.window.windowId, m.at);
        if (prevFocused !== null && moved) this.left(prevFocused, m.at);
        return null;
      }
      case "focus": {
        if (this.mode === "shadow") {
          const before = this.preFocus?.windowId === m.windowId && m.key !== null ? this.preFocus.values.get(m.key) : undefined;
          this.shadowLogger.onFocus(m, before);
        }
        this.preFocus = null;
        this.audit?.onFocus(m);
        store.count(m.editable ? "reader.focus_editable" : "reader.focus_other", 1, m.at);
        const triggers = this.mode === "live" && m.editable && m.empty && m.key !== null && (m.frontmost || this.opts.allowBackgroundFocus);
        if (!triggers || m.key === null) return null;
        return this.fill(m.windowId, m.key, false);
      }
      case "appSwitch":
        if (this.mode === "shadow") this.shadowLogger.onAppSwitch(m);
        // The app being left may send no leave walk when its window did not change; its focused window was left all the same.
        if (m.from !== null) for (const w of this.model.windows.values()) if (w.app.pid === m.from.pid && w.focused) this.left(w.window.windowId, m.at);
        store.count("reader.app_switch", 1, m.at);
        return null;
      case "windowClosed": {
        this.record(this.transfers.flush(m.windowId));
        // The shadow logger judges an open episode in this window before the window leaves the model,
        // since the judgment reads the window's typed values.
        if (this.mode === "shadow") this.shadowLogger.onWindowClosing(m.windowId);
        this.patterns.onWindowClosed(m.windowId);
        this.pending.onWindowClosed(m.windowId);
        this.audit?.onWindowClosed(m.windowId, m.at);
        this.model.close(m.windowId, m.at);
        return null;
      }
      case "pasteboard":
        store.count("reader.pasteboard_change", 1, m.at);
        return null;
      case "verbResult":
        this.socketLink?.answer(m);
        return null;
      case "userInput":
        this.executor.onUserInput(m);
        return null;
    }
  }

  /** The user left a window: the pending watch, and the audit when one runs, look for markers. */
  private left(windowId: string, at: number): void {
    this.pending.left(windowId);
    this.audit?.left(windowId, at);
  }

  handleConsumer(m: FillRequest): Promise<FillProposal | null> {
    return this.fill(m.windowId, m.fieldKey, true);
  }

  /**
   * Sends one verb to the reader and resolves with its answer. For evaluation scripts that play the
   * user through the reader's pid-checked AX writes; the executor uses the same link.
   */
  readerVerb(verb: ReaderVerb): Promise<VerbResult> {
    return (this.opts.readerLink ?? (this.socketLink as SocketReaderLink)).run(verb);
  }

  /** Takes, dismisses or silences a pattern offer. Resolves when a taken offer's plan has run. */
  handleOffer(m: OfferControl): Promise<TaskResult | null> {
    return this.patterns.control(m);
  }

  /** Answers a memory request; the server sends the reply to the asking consumer only, since entries hold personal values. */
  handleMemory(m: MemoryRequest): MemoryReply {
    return this.patterns.memoryRequest(m);
  }

  /** Answers an activity request; the server sends the reply to the asking consumer only. */
  handleActivity(m: ActivityRequest): ActivityReply {
    return this.tasks.answer(m);
  }

  /**
   * The host's report on one proposed field. `inserted` marks the field's transfer as Caret's,
   * whether the transfer was judged already or is judged later; `undone` removes that transfer from
   * the log and the store again. Other outcomes are counted. A result for a proposal or field this
   * helper never proposed is an error, not a guess.
   */
  handleFillResult(m: FillResult): void {
    const store = this.opts.store;
    const p = this.proposals.get(m.proposalId);
    if (p === undefined) return this.error(`fillResult: unknown or expired proposal ${m.proposalId}`);
    if (p.windowId !== m.windowId) return this.error(`fillResult: proposal ${m.proposalId} is for window ${p.windowId}, not ${m.windowId}`);
    const value = p.values.get(m.fieldKey);
    if (value === undefined) return this.error(`fillResult: proposal ${m.proposalId} proposed no value for ${m.fieldKey}`);
    store.count(`fill.result_${m.outcome}`, 1, m.at);
    const id = fieldId(m.windowId, m.fieldKey);
    if (m.outcome === "inserted") {
      const fill: CaretFill = { proposalId: m.proposalId, at: m.at, value, undoneAt: null, transfers: [] };
      this.caretFills.set(id, fill);
      // The transfers may have been judged before the result arrived.
      for (const t of this.recentTransfers) if (fieldId(t.dst.windowId, t.dst.key) === id && fillMatches(fill, t)) this.markCaret(fill, t);
      return;
    }
    if (m.outcome === "undone") {
      const fill = this.caretFills.get(id);
      if (fill === undefined || fill.proposalId !== m.proposalId) return this.error(`fillResult: undone for ${m.fieldKey}, but no insert of proposal ${m.proposalId} was reported`);
      fill.undoneAt = m.at;
      for (const t of fill.transfers) {
        const i = this.recentTransfers.indexOf(t);
        if (i >= 0) this.recentTransfers.splice(i, 1);
        if (t.rowId !== undefined) store.removeTransfer(t.rowId);
      }
      fill.transfers = [];
    }
  }

  private markCaret(fill: CaretFill, t: Transfer): void {
    t.attribution = "caret";
    fill.transfers.push(t);
    if (t.rowId !== undefined) this.opts.store.setAttribution(t.rowId, "caret");
  }

  /** An executor phase becomes a task record: created on the run's first phase, updated on every later one. */
  private onTaskEvent(e: TaskEvent): void {
    const state = PHASE_STATE[e.phase];
    const cause: TaskCause | null = e.cause ?? (state === "running" ? null : state === "undone" ? "you" : "caret");
    const fields = {
      state,
      cause,
      step: e.step,
      steps: e.steps,
      stepSays: e.says,
      remaining: e.remaining,
      detail: e.detail,
      undoable: e.undoable,
      ...(e.window === null ? {} : { app: e.window.app, windowId: e.window.windowId, windowTitle: e.window.title }),
    };
    try {
      if (this.tasks.get(e.taskId) === undefined) {
        this.tasks.create({ id: e.taskId, kind: "plan", says: e.title, app: null, windowId: null, windowTitle: null, pending: null, ...fields });
      } else this.tasks.update(e.taskId, fields);
    } catch (err) {
      if (!(err instanceof TransitionError)) throw err;
      this.opts.warn?.(`activity: ${err.message}`);
    }
  }

  /**
   * A loopFinish or routine offer is prepared work: it is listed as ready under the offer's id, which
   * is also the task id its run gets when taken. Withdrawn before it ran, it becomes undone.
   */
  private onPatternMessage(m: HelperMessage): void {
    if (m.type === "patternOffer" && (m.kind === "loopFinish" || m.kind === "routine")) {
      const w = this.model.windows.get(m.windowId);
      this.tasks.create({
        id: m.id,
        kind: m.kind,
        state: "ready",
        cause: null,
        says: m.says,
        app: w?.app ?? null,
        windowId: m.windowId,
        windowTitle: w?.window.title ?? null,
        step: null,
        steps: null,
        stepSays: null,
        remaining: [],
        detail: null,
        undoable: false,
        pending: null,
      });
    } else if (m.type === "offerWithdrawn" && m.reason !== "taken" && this.tasks.get(m.id)?.state === "ready") {
      const by: TaskCause = m.reason === "dismissed" || m.reason === "diverged" ? "you" : "screen";
      this.tasks.update(m.id, { state: "undone", cause: by, detail: `withdrawn: ${m.reason}` });
    }
  }

  /** Runs a plan or controls a task. Errors in the request itself are published, not thrown. */
  async handleTask(m: RunPlan | TaskControl): Promise<TaskResult | UndoResult | null> {
    if (this.mode !== "live") {
      this.error(`task ${m.taskId}: the helper is in shadow mode and does not act`);
      return null;
    }
    try {
      if (m.type === "runPlan") {
        // A task id names one piece of work in the activity feed; a run may not take over another's record.
        if (this.tasks.get(m.taskId) !== undefined) throw new Error(`task id ${m.taskId} is already in use`);
        return await this.executor.run(m.taskId, m.plan, m.slots);
      }
      if (this.pending.has(m.taskId) || this.tasks.get(m.taskId)?.kind === "watch") {
        this.pending.control(m.taskId, m.action);
        return null;
      }
      switch (m.action) {
        case "resume":
          return await this.executor.resume(m.taskId);
        case "undo":
          return await this.executor.undo(m.taskId);
        case "pause":
        case "takeOver":
          // The run's own promise resolves as paused at the next step boundary.
          this.executor.pause(m.taskId, m.action === "takeOver");
          return null;
        case "stop":
          this.executor.stop(m.taskId);
          return null;
      }
    } catch (e) {
      this.error(`task ${m.taskId}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** Periodic work: settled transfers, idle shadow episodes, pruning and count flushes. */
  tick(now = Date.now()): void {
    this.record(this.transfers.tick(now));
    this.patterns.tick(now);
    if (this.mode === "shadow") this.shadowLogger.tick(now);
    if (now - this.lastPrune >= PRUNE_EVERY_MS) {
      this.lastPrune = now;
      this.model.prune(now);
      // The reader skips snapshots of unchanged windows, so text still on screen is marked seen here;
      // otherwise a window left untouched for ten minutes would drop out of the text window.
      for (const w of this.model.windows.values()) this.text.observe(w, now);
      this.text.prune(now);
      const cutoff = now - 10 * 60 * 1000;
      while ((this.recentTransfers[0]?.at ?? now) < cutoff) this.recentTransfers.shift();
      for (const [id, p] of this.proposals) if (now - p.at > PROPOSAL_KEEP_MS) this.proposals.delete(id);
      for (const [id, f] of this.caretFills) if (now - f.at > PROPOSAL_KEEP_MS) this.caretFills.delete(id);
      this.tasks.prune(now);
      this.opts.store.flush();
    }
  }

  shutdown(): void {
    this.record(this.transfers.flush());
    this.patterns.shutdown();
    this.pending.shutdown();
    this.shadowLogger.close();
    this.opts.store.flush();
  }

  private record(judged: Transfer[]): void {
    const store = this.opts.store;
    const ts: Transfer[] = [];
    for (const t of judged) {
      const fill = this.caretFills.get(fieldId(t.dst.windowId, t.dst.key));
      const caret = fill !== undefined && fillMatches(fill, t);
      // An edit from before the host undid the fill leaves nothing to log: it is gone from the field.
      if (caret && fill.undoneAt !== null) continue;
      if (caret) t.attribution = "caret";
      ts.push(t);
      this.recentTransfers.push(t);
      store.count(`transfer.${t.match}`, 1, t.at);
      t.rowId = store.addTransfer({
        at: t.at,
        valueHash: store.hash(t.value),
        kind: t.kind,
        length: t.value.length,
        match: t.match,
        srcBundle: t.src.bundleId,
        srcWindowKind: t.src.windowKind,
        srcKeyHash: store.hash(t.src.nodeKey),
        dstBundle: t.dst.bundleId,
        dstWindowKind: t.dst.windowKind,
        dstKeyHash: store.hash(t.dst.key),
        ageMs: t.ageMs,
        attribution: t.attribution,
      });
      if (caret) fill.transfers.push(t);
    }
    if (ts.length > 0) this.patterns.onTransfers(ts);
  }

  private async fill(windowId: string, key: string, explicit: boolean): Promise<FillProposal | null> {
    const ask = this.opts.askJev;
    const store = this.opts.store;
    if (ask === null || this.mode === "shadow") {
      if (explicit) this.error(`fill unavailable: ${ask === null ? "Jev is disabled" : "helper is in shadow mode"}`);
      return null;
    }
    const w = this.model.windows.get(windowId);
    if (w === undefined) {
      this.error(`fill: unknown window ${windowId}`);
      return null;
    }
    let formKey: string;
    try {
      formKey = `${windowId}|${formFields(w, key).map((n) => n.key).sort().join(",")}`;
    } catch (e) {
      this.error(`fill: ${(e as Error).message}`);
      return null;
    }
    const now = Date.now();
    if (this.inflight.has(formKey)) return null;
    if (!explicit && now - (this.lastFill.get(formKey) ?? -Infinity) < FILL_REPEAT_MS) return null;
    this.inflight.add(formKey);
    try {
      const asked = await proposeFill(this.model, ask, windowId, key, now, this.opts.fillCutoff === undefined ? {} : { cutoff: this.opts.fillCutoff });
      const p = this.revalidate(asked);
      this.lastFill.set(formKey, now);
      if (p !== null) {
        this.proposals.set(p.id, { at: now, windowId: p.windowId, values: new Map(p.fields.flatMap((f) => (f.value === null ? [] : [[f.key, f.value] as const]))) });
      }
      if (p === null) {
        store.count("fill.stale", 1, now);
        return null;
      }
      store.count("fill.request", 1, now);
      store.count("fill.fields", p.fields.length, now);
      store.count("fill.proposed_values", p.fields.filter((f) => f.value !== null).length, now);
      this.opts.publish(p);
      return p;
    } catch (e) {
      store.count("fill.error", 1, now);
      this.error(`fill: ${e instanceof FillError ? e.message : String(e)}`);
      return null;
    } finally {
      this.inflight.delete(formKey);
    }
  }

  /**
   * Jev answers in a few hundred milliseconds, and the screen can move meanwhile. A proposal is
   * dropped when the helper left live mode, the window closed, or its trigger field is gone or no
   * longer empty; a field that has since been filled, or whose source window closed, is left out.
   */
  private revalidate(p: FillProposal): FillProposal | null {
    if (this.mode !== "live") return null;
    const w = this.model.windows.get(p.windowId);
    const trigger = w?.nodes.get(p.triggerKey);
    if (w === undefined || trigger === undefined || (trigger.value ?? "") !== "") return null;
    const fields = p.fields.filter((f) => {
      const n = w.nodes.get(f.key);
      if (n === undefined || (n.value ?? "") !== "") return false;
      return f.source === null || this.model.windows.has(f.source.windowId);
    });
    return { ...p, fields };
  }

  private error(message: string): void {
    this.opts.warn?.(message);
    this.opts.publish({ type: "error", v: PROTOCOL_VERSION, at: Date.now(), message });
  }
}
