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
  type FillProposal,
  type FillRequest,
  type HelperMessage,
  type ReaderCommand,
  type ReaderMessage,
  type RunPlan,
  type TaskControl,
} from "./protocol.ts";
import type { Change } from "./model.ts";
import { Executor, type ExecutorDeps, type TaskResult, type UndoResult } from "./executor/executor.ts";
import { SocketReaderLink, type CalendarPort, type ReaderLink, type UrlOpener } from "./executor/means.ts";

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
  urls?: UrlOpener | null;
  /** Fault-injection seams for the executor evaluation; see ExecutorDeps. */
  executorHooks?: Pick<ExecutorDeps, "beforeStep" | "beforeAct">;
  publish: (m: HelperMessage) => void;
  warn?: (line: string) => void;
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
  private lastPrune = 0;
  readonly executor: Executor;
  private readonly socketLink: SocketReaderLink | null;
  private readonly changeListeners = new Set<(changes: readonly Change[]) => void>();
  /** Field values of a window just before a focus walk replaced them, for the shadow logger. */
  private preFocus: { windowId: string; values: Map<string, string> } | null = null;

  constructor(opts: HelperOptions) {
    this.opts = opts;
    this.mode = opts.shadow ? "shadow" : "live";
    this.transfers = new TransferDetector(this.model, this.text);
    this.shadowLogger = new ShadowLogger(this.model, this.text, opts.store);
    this.socketLink = opts.readerLink === undefined ? new SocketReaderLink(opts.sendToReader ?? (() => false)) : null;
    this.executor = new Executor({
      model: this.model,
      reader: opts.readerLink ?? (this.socketLink as SocketReaderLink),
      calendar: opts.calendar ?? null,
      urls: opts.urls ?? null,
      askJev: opts.askJev,
      publish: (m) => opts.publish(m),
      onChanges: (l) => {
        this.changeListeners.add(l);
        return () => this.changeListeners.delete(l);
      },
      ...opts.executorHooks,
    });
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
        this.transfers.onChanges(changes);
        if (this.mode === "shadow") this.shadowLogger.onChanges(changes);
        if (prevFocused !== null && prevFocused !== this.model.focusedWindowId) this.record(this.transfers.flush(prevFocused));
        return null;
      }
      case "focus": {
        if (this.mode === "shadow") {
          const before = this.preFocus?.windowId === m.windowId && m.key !== null ? this.preFocus.values.get(m.key) : undefined;
          this.shadowLogger.onFocus(m, before);
        }
        this.preFocus = null;
        store.count(m.editable ? "reader.focus_editable" : "reader.focus_other", 1, m.at);
        const triggers = this.mode === "live" && m.editable && m.empty && m.key !== null && (m.frontmost || this.opts.allowBackgroundFocus);
        if (!triggers || m.key === null) return null;
        return this.fill(m.windowId, m.key, false);
      }
      case "appSwitch":
        if (this.mode === "shadow") this.shadowLogger.onAppSwitch(m);
        store.count("reader.app_switch", 1, m.at);
        return null;
      case "windowClosed": {
        this.record(this.transfers.flush(m.windowId));
        // The shadow logger judges an open episode in this window before the window leaves the model,
        // since the judgment reads the window's typed values.
        if (this.mode === "shadow") this.shadowLogger.onWindowClosing(m.windowId);
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

  handleConsumer(m: FillRequest): Promise<FillProposal | null> {
    return this.fill(m.windowId, m.fieldKey, true);
  }

  /** Runs a plan or controls a task. Errors in the request itself are published, not thrown. */
  async handleTask(m: RunPlan | TaskControl): Promise<TaskResult | UndoResult | null> {
    if (this.mode !== "live") {
      this.error(`task ${m.taskId}: the helper is in shadow mode and does not act`);
      return null;
    }
    try {
      if (m.type === "runPlan") return await this.executor.run(m.taskId, m.plan, m.slots);
      return m.action === "resume" ? await this.executor.resume(m.taskId) : await this.executor.undo(m.taskId);
    } catch (e) {
      this.error(`task ${m.taskId}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** Periodic work: settled transfers, idle shadow episodes, pruning and count flushes. */
  tick(now = Date.now()): void {
    this.record(this.transfers.tick(now));
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
      this.opts.store.flush();
    }
  }

  shutdown(): void {
    this.record(this.transfers.flush());
    this.shadowLogger.close();
    this.opts.store.flush();
  }

  private record(ts: Transfer[]): void {
    const store = this.opts.store;
    for (const t of ts) {
      this.recentTransfers.push(t);
      store.count(`transfer.${t.match}`, 1, t.at);
      store.addTransfer({
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
    }
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
