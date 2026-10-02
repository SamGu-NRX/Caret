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
import { PROTOCOL_VERSION, type FillProposal, type FillRequest, type HelperMessage, type ReaderMessage } from "./protocol.ts";

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
  /** Field values of a window just before a focus walk replaced them, for the shadow logger. */
  private preFocus: { windowId: string; values: Map<string, string> } | null = null;

  constructor(opts: HelperOptions) {
    this.opts = opts;
    this.mode = opts.shadow ? "shadow" : "live";
    this.transfers = new TransferDetector(this.model, this.text);
    this.shadowLogger = new ShadowLogger(this.model, this.text, opts.store);
  }

  /** Returns the fill proposal promise when the message triggered one, for tests and evals. */
  handleReader(m: ReaderMessage): Promise<FillProposal | null> | null {
    const store = this.opts.store;
    switch (m.type) {
      case "hello":
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
        const c = this.model.close(m.windowId, m.at);
        if (c !== null && this.mode === "shadow") this.shadowLogger.onChanges([c]);
        return null;
      }
      case "pasteboard":
        store.count("reader.pasteboard_change", 1, m.at);
        return null;
    }
  }

  handleConsumer(m: FillRequest): Promise<FillProposal | null> {
    return this.fill(m.windowId, m.fieldKey, true);
  }

  /** Periodic work: settled transfers, idle shadow episodes, pruning and count flushes. */
  tick(now = Date.now()): void {
    this.record(this.transfers.tick(now));
    if (this.mode === "shadow") this.shadowLogger.tick(now);
    if (now - this.lastPrune >= PRUNE_EVERY_MS) {
      this.lastPrune = now;
      this.model.prune(now);
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
      const p = await proposeFill(this.model, ask, windowId, key, now);
      this.lastFill.set(formKey, now);
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

  private error(message: string): void {
    this.opts.warn?.(message);
    this.opts.publish({ type: "error", v: PROTOCOL_VERSION, at: Date.now(), message });
  }
}
