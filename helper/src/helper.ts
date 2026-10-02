// The helper's core, independent of sockets: it applies reader messages to the screen model,
// feeds the rolling text window, the transfer detector and the shadow logger, and asks for
// grounded fill proposals. server.ts connects it to the socket; tests drive it directly.
// Everything the helper sends consumers leaves through `publish`, which checks every offer for the
// host against the protocol before it goes and records it for the host's offerAccept.
import { ScreenModel } from "./model.ts";
import { RollingText } from "./rolling-text.ts";
import { TransferDetector, type Transfer } from "./transfers.ts";
import { ShadowLogger } from "./shadow.ts";
import type { Store } from "./store.ts";
import type { AskJev } from "./fill/jev.ts";
import { FillError, formFields, proposeFill } from "./fill/fill.ts";
import {
  HOST_OFFER_TYPES,
  HelperMessage,
  PROTOCOL_VERSION,
  type ActivityReply,
  type ActivityRequest,
  type FillProposal,
  type FillResult,
  type FillRequest,
  type Focus,
  type MemoryReply,
  type MemoryRequest,
  type OfferAccept,
  type OfferControl,
  type OfferStop,
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
import { HostOfferRegistry, acceptRefusal, type AcceptHandler, type AcceptResult, type HostOffer } from "./offers/registry.ts";
import { buildFillPopup, fillPlan, fillPopupEligible, recheckFill, type GroundedProposal } from "./offers/fill-popup.ts";
import { OpenAppOffers } from "./offers/open-app.ts";

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
  /** For the audit: how often to probe the generator on the real windows (Audit.tick); absent for never. */
  auditProbeEveryMs?: number;
  /** Fault-injection seams for the executor evaluation; see ExecutorDeps. */
  executorHooks?: Pick<ExecutorDeps, "beforeStep" | "beforeAct" | "targetCutoff">;
  /** Makes the random part of proposal and watch ids, so tests can expect exact messages. */
  newId?: () => string;
  /** The helper's clock for message times, fill proposals and the task feed. Tests pass a fake one. */
  now?: () => number;
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
  /** Bumped on each reader hello; a fill whose Jev answer arrives in a later session is dropped. */
  private readerSession = 0;
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
  /** Every alternatives, action and popup message published and not yet withdrawn. */
  readonly offers: HostOfferRegistry;
  /**
   * Fill pop-ups on offer, by offerKey, with the form's field keys when each was made. A pop-up has no
   * timer (OFFER_LIFETIMES.fill): focus in another field ends it, and so does any change to the form
   * or a source; see checkFills and onFillFocus.
   */
  private readonly fillPopups = new Map<string, { p: GroundedProposal; form: string }>();
  /** The latest focus in an editable field of the app the user is in, for a pop-up whose Jev answer arrives after the user moved on. */
  private lastEditableFocus: { windowId: string; key: string } | null = null;
  private readonly now: () => number;
  /** "Open <app>" action lines for watched windows that finished or need the user. */
  readonly openApp: OpenAppOffers;

  constructor(opts: HelperOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.offers = new HostOfferRegistry(this.now);
    if (opts.audit === true && (!opts.shadow || opts.askJev !== null)) throw new Error("the audit runs only in shadow mode with Jev off");
    this.mode = opts.shadow ? "shadow" : "live";
    this.transfers = new TransferDetector(this.model, this.text);
    this.shadowLogger = new ShadowLogger(this.model, this.text, opts.store);
    this.socketLink = opts.readerLink === undefined ? new SocketReaderLink(opts.sendToReader ?? (() => false)) : null;
    this.tasks = new TaskRegistry((m) => this.publish(m), this.now);
    this.executor = new Executor({
      model: this.model,
      reader: opts.readerLink ?? (this.socketLink as SocketReaderLink),
      calendar: opts.calendar ?? null,
      urls: opts.urls ?? null,
      askJev: opts.askJev,
      publish: (m) => this.publish(m),
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
      publish: (m, accept) => {
        if (this.mode !== "live") return;
        this.publish(m, accept);
        this.onPatternMessage(m);
      },
      run: (taskId, plan, slots, expect) => this.executor.run(taskId, plan, slots, expect),
      shadow: () => this.mode === "shadow",
    });
    this.pending = new PendingWatcher({
      model: this.model,
      askJev: opts.askJev,
      tasks: this.tasks,
      reader: (v) => this.readerVerb(v),
      live: () => this.mode === "live",
      onResolved: (e) => this.openApp.resolved(e),
      ...(opts.newId === undefined ? {} : { newId: opts.newId }),
      ...(opts.warn === undefined ? {} : { warn: opts.warn }),
    });
    this.openApp = new OpenAppOffers({ model: this.model, publish: (m, accept) => this.publish(m, accept), run: (taskId, plan, slots) => this.executor.run(taskId, plan, slots), now: this.now });
    this.audit = opts.audit === true ? new Audit({ model: this.model, reader: (v) => this.readerVerb(v), ...(opts.auditProbeEveryMs === undefined ? {} : { probeEveryMs: opts.auditProbeEveryMs }) }) : null;
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
        this.openApp.readerRestarted();
        // Whatever is still offered (a fill pop-up) names windows and fields of the old session, whose
        // ids the new reader may give to other windows.
        for (const id of this.offers.keys()) this.publish({ type: "offerWithdrawn", v: PROTOCOL_VERSION, at: this.now(), id, reason: "stale" });
        this.fillPopups.clear();
        this.readerSession++;
        this.audit?.readerRestarted(this.now());
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
        // Only when the user is in that app: a request walk marks a background app's own window focused.
        if (moved && this.model.focusedWindowId !== null && this.model.frontmostPid === m.app.pid) this.openApp.onFocusedWindow(this.model.focusedWindowId);
        if (prevFocused !== null && moved) this.record(this.transfers.flush(prevFocused));
        this.pending.onSnapshot(m.window.windowId, m.stats.truncated);
        this.checkFills(m.window.windowId);
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
        if (m.frontmost) this.model.frontmostPid = m.app.pid;
        this.audit?.onFocus(m);
        store.count(m.editable ? "reader.focus_editable" : "reader.focus_other", 1, m.at);
        if (this.mode === "live") {
          this.openApp.onFocus(m);
          this.onFillFocus(m);
        }
        const triggers = this.mode === "live" && m.editable && m.empty && m.key !== null && (m.frontmost || this.opts.allowBackgroundFocus);
        if (!triggers || m.key === null) return null;
        return this.fill(m.windowId, m.key, false);
      }
      case "appSwitch":
        this.model.frontmostPid = m.to.pid;
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
        this.openApp.onWindowClosed(m.windowId);
        this.audit?.onWindowClosed(m.windowId, m.at);
        this.model.close(m.windowId, m.at);
        this.checkFills(m.windowId);
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

  /**
   * The host took an action of an action line or pop-up. The offer must be live, not yet accepted, and
   * the action and overrides must be ones the host was shown; then the offer's producer runs it as the
   * task whose id is the offerId. Any refusal publishes an error and, unless a run already has that id,
   * a terminal taskProgress, so the host's working line ends.
   */
  async handleOfferAccept(m: OfferAccept): Promise<TaskResult | null> {
    if (this.mode !== "live") return this.refuseAccept(m.offerId, "the helper is in shadow mode and does not act");
    const r = this.offers.get(m.offerId);
    if (r === undefined) return this.refuseAccept(m.offerId, "no such offer, or it expired");
    if (r.accepted) return this.refuseAccept(m.offerId, "already accepted");
    const why = acceptRefusal(r, m);
    if (why !== null) return this.refuseAccept(m.offerId, why);
    if (r.accept === null) return this.refuseAccept(m.offerId, "the offer has nothing to run");
    r.accepted = true;
    let out: AcceptResult;
    try {
      out = await r.accept(m);
    } catch (e) {
      return this.refuseAccept(m.offerId, e instanceof Error ? e.message : String(e));
    }
    return "refused" in out ? this.refuseAccept(m.offerId, out.refused) : out;
  }

  /** Esc on running work: a stop for the task the offer started. */
  handleOfferStop(m: OfferStop): Promise<TaskResult | UndoResult | null> {
    return this.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: m.offerId, action: "stop" });
  }

  private refuseAccept(offerId: string, reason: string): null {
    this.error(`offer ${offerId}: ${reason}`);
    // A second accept of an offer whose run is still going must not end that run's working line; one
    // after the run finished opened a new line on the host, which this ends.
    if (!this.executor.live(offerId)) {
      this.publish({ type: "taskProgress", v: PROTOCOL_VERSION, at: this.now(), taskId: offerId, planId: offerId, phase: "stopped", step: null, steps: 0, says: null, detail: reason });
    }
    return null;
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
      ...(e.window === null ? {} : { app: e.window.app, windowId: e.window.windowId, windowTitle: e.window.title, frame: e.window.frame }),
    };
    try {
      if (this.tasks.get(e.taskId) === undefined) {
        this.tasks.create({ id: e.taskId, kind: "plan", says: e.title, app: null, windowId: null, windowTitle: null, frame: null, pending: null, ...fields });
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
        frame: w?.window.frame ?? null,
        step: null,
        steps: null,
        stepSays: null,
        remaining: [],
        detail: null,
        undoable: false,
        pending: null,
      });
    } else if (m.type === "offerWithdrawn" && m.reason !== "taken" && this.tasks.get(m.id)?.state === "ready") {
      const by: TaskCause = m.reason === "dismissed" || m.reason === "diverged" ? "you" : m.reason === "expired" ? "caret" : "screen";
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
      if (m.reason !== undefined && m.action !== "pause") throw new Error(`reason ${m.reason} goes only with pause, not ${m.action}`);
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
          this.executor.pause(m.taskId, m.action === "takeOver", m.action === "pause" ? m.reason : undefined);
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
  tick(now = this.now()): void {
    this.record(this.transfers.tick(now));
    this.patterns.tick(now);
    if (this.mode === "shadow") this.shadowLogger.tick(now);
    this.audit?.tick(now);
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
    const now = this.now();
    if (this.inflight.has(formKey)) return null;
    if (!explicit && now - (this.lastFill.get(formKey) ?? -Infinity) < FILL_REPEAT_MS) return null;
    // A pop-up already on offer covers this form, however long ago it was made.
    if (!explicit && [...this.fillPopups.values()].some((f) => f.form === formKey)) return null;
    this.inflight.add(formKey);
    const session = this.readerSession;
    try {
      const asked = await proposeFill(this.model, ask, windowId, key, now, {
        ...(this.opts.fillCutoff === undefined ? {} : { cutoff: this.opts.fillCutoff }),
        ...(this.opts.newId === undefined ? {} : { newId: this.opts.newId }),
      });
      const p = session === this.readerSession ? this.revalidate(asked) : null;
      this.lastFill.set(formKey, now);
      if (p === null) {
        store.count("fill.stale", 1, now);
        return null;
      }
      store.count("fill.request", 1, now);
      store.count("fill.fields", p.fields.length, now);
      store.count("fill.proposed_values", p.fields.filter((f) => f.value !== null).length, now);
      // Every field grounded: the host shows one pop-up and Caret fills them all on Tab, so there is
      // no per-field insert for a fillResult to report, and the proposal is not kept for one. An
      // explicit fillRequest asks for the proposal itself (scripts/fill-eval.ts reads its fields), so it
      // always gets one.
      if (!explicit && fillPopupEligible(p)) {
        if (this.fillOverBeforeShown(p, formKey) !== null) {
          store.count("fill.popup_stale", 1, now);
          return p;
        }
        store.count("fill.popup", 1, now);
        if (this.publish(buildFillPopup(this.model, p), () => this.acceptFill(p))) this.fillPopups.set(p.id, { p, form: formKey });
        return p;
      }
      this.proposals.set(p.id, { at: now, windowId: p.windowId, values: new Map(p.fields.flatMap((f) => (f.value === null ? [] : [[f.key, f.value] as const]))) });
      this.publish(p);
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

  /**
   * "Fill all": every destination still empty and every source still showing its value, then one
   * executor run under the proposal id. The pop-up is withdrawn either way.
   */
  private async acceptFill(p: GroundedProposal): Promise<AcceptResult> {
    const stale = recheckFill(this.model, p);
    if (stale !== null) {
      this.withdrawFill(p.id, "stale");
      return { refused: `${stale}; nothing was written` };
    }
    const { plan, slots } = fillPlan(this.model, p);
    this.withdrawFill(p.id, "taken");
    // The destinations were empty just now; one the user fills before the run's first read stops it.
    return this.executor.run(p.id, plan, slots, { [p.windowId]: Object.fromEntries(p.fields.map((f) => [f.key, ""])) });
  }

  /**
   * The form's window or a source window changed or closed: a fill pop-up it no longer matches is
   * withdrawn as stale. It no longer matches when a destination is gone or filled, a source stops
   * showing its value (recheckFill), or the form gained or lost a field.
   */
  private checkFills(windowId: string): void {
    for (const [id, { p, form }] of this.fillPopups) {
      if (p.windowId !== windowId && !p.fields.some((f) => f.source.windowId === windowId)) continue;
      const w = this.model.windows.get(p.windowId);
      let changed = recheckFill(this.model, p) !== null;
      if (!changed && w !== undefined) {
        try {
          changed = `${p.windowId}|${formFields(w, p.triggerKey).map((n) => n.key).sort().join(",")}` !== form;
        } catch {
          changed = true;
        }
      }
      if (changed) this.withdrawFill(id, "stale");
    }
  }

  /**
   * Focus in an editable field the pop-up does not fill, in the app the user is in, ends the pop-up's
   * lifetime. Focus on anything else (a list, a button, another window's text) keeps it: the user may be
   * checking a source.
   */
  private onFillFocus(m: Focus): void {
    if (!m.editable || m.key === null || !(m.frontmost || this.opts.allowBackgroundFocus)) return;
    this.lastEditableFocus = { windowId: m.windowId, key: m.key };
    for (const [id, { p }] of this.fillPopups) if (!inFillForm(p, m.windowId, m.key)) this.withdrawFill(id, "expired");
  }

  /**
   * Why a pop-up about to be published would already be over, or null: focus moved to a field outside
   * the form while Jev answered, a source stopped showing its value, or the form's fields changed. The
   * events that would have ended it came before it existed.
   */
  private fillOverBeforeShown(p: GroundedProposal, form: string): string | null {
    const f = this.lastEditableFocus;
    if (f !== null && !inFillForm(p, f.windowId, f.key)) return "focus left the form";
    const stale = recheckFill(this.model, p);
    if (stale !== null) return stale;
    const w = this.model.windows.get(p.windowId);
    try {
      if (w === undefined || `${p.windowId}|${formFields(w, p.triggerKey).map((n) => n.key).sort().join(",")}` !== form) return "the form changed";
    } catch {
      return "the form changed";
    }
    return null;
  }

  private withdrawFill(id: string, reason: "taken" | "stale" | "expired"): void {
    this.fillPopups.delete(id);
    this.publish({ type: "offerWithdrawn", v: PROTOCOL_VERSION, at: this.now(), id, reason });
  }

  /**
   * The one way out to consumers. An alternatives, action or popup message is parsed against the
   * protocol first; one that fails is not sent, and the error names the offer and the first issue's
   * rule and path, never its text. A valid one is recorded with `accept`, how taking it runs; a
   * withdrawal removes the record. Returns false when the message was refused.
   */
  private publish(m: HelperMessage, accept?: AcceptHandler): boolean {
    if (HOST_OFFER_TYPES.has(m.type)) {
      const offerKey = String((m as HostOffer).offerKey);
      const parsed = HelperMessage.safeParse(m);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        this.opts.store.count("offers.refused", 1);
        const message = `offer ${offerKey} refused: ${issue?.message ?? "invalid"} at ${issuePath(issue?.path ?? [])}`;
        this.opts.warn?.(message);
        this.opts.publish({ type: "error", v: PROTOCOL_VERSION, at: this.now(), message });
        return false;
      }
      this.offers.record(m as HostOffer, accept ?? null);
    } else if (m.type === "offerWithdrawn") this.offers.remove(m.id);
    this.opts.publish(m);
    return true;
  }

  private error(message: string): void {
    this.opts.warn?.(message);
    this.publish({ type: "error", v: PROTOCOL_VERSION, at: this.now(), message });
  }
}

/** Whether a field is the pop-up's trigger or one of the fields it fills. */
function inFillForm(p: GroundedProposal, windowId: string, key: string): boolean {
  return windowId === p.windowId && (key === p.triggerKey || p.fields.some((f) => f.key === key));
}

/** A zod issue path as a JSON path: ["spec", "blocks", 2, "rows", 0] is spec.blocks[2].rows[0]. */
function issuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "the message";
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join("");
}
