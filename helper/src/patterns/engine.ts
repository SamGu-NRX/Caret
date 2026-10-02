// The pattern engine: runs the loop and routine recognizers as transfers and changes arrive, turns
// what they find into offers through the gate, runs a taken offer's plan through the executor, and
// learns preferences from the user's edits to values it filled. No model is called anywhere here.
import { performance } from "node:perf_hooks";
import type { Change, ScreenModel } from "../model.ts";
import {
  PROTOCOL_VERSION,
  type HelperMessage,
  type MemoryReply,
  type MemoryRequest,
  type OfferCell,
  type OfferControl,
  type OfferKind,
  type OfferWithdrawn,
  type PatternOffer,
  type ValueKind,
} from "../protocol.ts";
import type { Transfer } from "../transfers.ts";
import type { RollingText } from "../rolling-text.ts";
import type { TaskResult } from "../executor/executor.ts";
import type { Plan } from "../executor/schema.ts";
import { decide, type Decision } from "./gate.ts";
import { LoopRecognizer, type LoopCell, type LoopEvent } from "./loops.ts";
import { MemoryError, type MemoryStore } from "./memory.ts";
import { applyMemory, captureEdit } from "./preferences.ts";
import { RoutineRecognizer, type Hash, type RoutineCell, type SilentPrediction } from "./routines.ts";
import { describeTransfer, templateOf } from "./shape.ts";

/** How long after Caret fills a field an edit to it is read as a preference. Assumed. */
export const EDIT_WATCH_MS = 60_000;
/** How long an edit must be still before it is judged, as for transfers. Assumed. */
const EDIT_SETTLE_MS = 1500;
/** Offers are kept this long after they close, so "Don't offer this here" can follow an undo. */
const OFFER_KEEP_MS = 10 * 60 * 1000;

export interface EngineDeps {
  model: ScreenModel;
  /** For every window that shows a transferred value, not only the one the transfer log credited. */
  text: RollingText;
  memory: MemoryStore;
  hash: Hash;
  publish: (m: HelperMessage) => void;
  /** Runs a plan through the executor. */
  run: (taskId: string, plan: Plan, slots: Record<string, string>) => Promise<TaskResult>;
  shadow: () => boolean;
}

type Cell = LoopCell | RoutineCell;

interface OfferState {
  msg: PatternOffer;
  cells: (Cell & { written: string; dstShapeHash: string })[];
  plan: Plan;
  slots: Record<string, string>;
  loopId: string | null;
  routineId: string | null;
  state: "open" | "taken" | "closed";
  closedAt: number | null;
}

interface Watch {
  windowId: string;
  key: string;
  /** The source text before memory rules; preference rules are keyed on it. */
  source: string;
  written: string;
  kind: ValueKind | null;
  dstShapeHash: string;
  label: string;
  app: string;
  until: number;
  pending: { value: string; at: number } | null;
}

/** Per-recognizer handling times, in milliseconds, for the 5 ms budget. */
export class Timings {
  private readonly samples = new Map<string, number[]>();
  static readonly MAX = 200_000;

  time<T>(name: string, f: () => T): T {
    const t0 = performance.now();
    try {
      return f();
    } finally {
      this.add(name, performance.now() - t0);
    }
  }

  add(name: string, ms: number): void {
    let s = this.samples.get(name);
    if (s === undefined) this.samples.set(name, (s = []));
    if (s.length < Timings.MAX) s.push(ms);
  }

  summary(): Record<string, { n: number; p50: number; p95: number; p99: number; max: number }> {
    const out: Record<string, { n: number; p50: number; p95: number; p99: number; max: number }> = {};
    for (const [name, s] of this.samples) {
      const v = [...s].sort((a, b) => a - b);
      const q = (p: number): number => v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? 0;
      out[name] = { n: v.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: v[v.length - 1] ?? 0 };
    }
    return out;
  }
}

export class PatternEngine {
  readonly loops: LoopRecognizer;
  readonly routines: RoutineRecognizer;
  readonly timings = new Timings();
  private readonly offers = new Map<string, OfferState>();
  private readonly watches = new Map<string, Watch>();
  private readonly deps: EngineDeps;
  private seq = 0;
  /** The latest event time seen; decisions are stamped with it so replays with a fake clock log consistent times. */
  private clock = 0;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.loops = new LoopRecognizer(deps.model);
    this.routines = new RoutineRecognizer(deps.model, deps.memory, deps.hash);
  }

  /** Every offer still open, for tests and the debug view. */
  openOffers(): PatternOffer[] {
    return [...this.offers.values()].filter((o) => o.state === "open").map((o) => o.msg);
  }

  onTransfers(ts: readonly Transfer[]): void {
    for (const t of ts) {
      this.clock = Math.max(this.clock, t.at);
      const p = this.timings.time("shape", () =>
        describeTransfer(this.deps.model, t, this.deps.text.findAll(t.value, t.kind, { excludeWindowId: t.dst.windowId, seenBy: t.at })),
      );
      if (p === null) {
        const events = this.timings.time("loops", () => this.loops.onOpaque(t.at, t.dst.windowId, t.dst.key, t.value, t.kind));
        for (const ev of events) this.onLoop(ev);
        continue;
      }
      const events = this.timings.time("loops", () => this.loops.onTransfer(p));
      this.timings.time("routines", () => this.routines.onTransfer(p));
      for (const ev of events) this.onLoop(ev);
    }
  }

  onChanges(changes: readonly Change[]): void {
    for (const c of changes) {
      this.clock = Math.max(this.clock, c.at);
      if (c.kind === "windowOpened") {
        const preds = this.timings.time("routines", () => this.routines.onWindowOpened(c.windowId, c.at));
        if (preds.length > 0) this.onPredictions(preds);
      } else if (c.kind === "value" && c.key !== null) {
        const w = this.watches.get(`${c.windowId}\u0000${c.key}`);
        if (w !== undefined) w.pending = c.after === w.written ? null : { value: c.after ?? "", at: c.at };
      }
    }
  }

  /** Called before the window leaves the model. */
  onWindowClosed(windowId: string): void {
    this.timings.time("routines", () => this.routines.onWindowClosed(windowId));
    for (const [id, w] of this.watches) {
      if (w.windowId !== windowId) continue;
      this.judgeEdit(w);
      this.watches.delete(id);
    }
    for (const o of this.offers.values()) {
      if (o.state === "open" && (o.msg.windowId === windowId || o.cells.some((c) => c.srcWindowId === windowId))) this.withdraw(o, "stale");
    }
  }

  tick(now: number): void {
    this.clock = Math.max(this.clock, now);
    const ended = this.timings.time("loops", () => this.loops.tick(now));
    if (ended !== null) this.onLoop(ended);
    this.timings.time("routines", () => this.routines.tick(now));
    this.timings.time("edits", () => {
      for (const [id, w] of this.watches) {
        if (w.pending !== null && now - w.pending.at >= EDIT_SETTLE_MS) {
          this.judgeEdit(w);
          w.pending = null;
        }
        if (w.pending === null && now > w.until) this.watches.delete(id);
      }
    });
    for (const [id, o] of this.offers) if (o.closedAt !== null && now - o.closedAt > OFFER_KEEP_MS) this.offers.delete(id);
  }

  /** A new reader numbers windows from scratch: every open bundle closes, and every offer is stale. */
  readerRestarted(): void {
    this.routines.flush();
    const loop = this.loops.active;
    if (loop !== null) this.loops.dismissed(loop.id);
    for (const o of this.offers.values()) if (o.state === "open") this.withdraw(o, "stale");
    this.watches.clear();
  }

  shutdown(): void {
    this.routines.flush();
  }

  /** Take, dismiss, or "Don't offer this here". Problems are published as errors. */
  async control(m: OfferControl): Promise<TaskResult | null> {
    const o = this.offers.get(m.offerId);
    if (o === undefined) return this.fail(`offer ${m.offerId}: no such offer, or it expired`);
    const { kind, bundleId } = o.msg;
    const memory = this.deps.memory;
    switch (m.action) {
      case "take": {
        if (o.state !== "open") return this.fail(`offer ${m.offerId}: already ${o.state === "taken" ? "taken" : "withdrawn"}`);
        if (this.deps.shadow()) return this.fail(`offer ${m.offerId}: the helper is in shadow mode and does not act`);
        o.state = "taken";
        this.withdraw(o, "taken");
        memory.recordReaction(kind, bundleId, "take", this.clock);
        let r: TaskResult;
        try {
          r = await this.deps.run(`offer-${o.msg.id}`, o.plan, o.slots);
        } catch (e) {
          return this.fail(`offer ${m.offerId}: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (r.outcome !== "done") return r;
        for (const c of o.cells) this.watch(c);
        if (o.loopId !== null) {
          const ev = this.loops.taken(o.loopId);
          if (ev !== null) this.onLoop(ev);
        }
        return r;
      }
      case "dismiss":
      case "dontOfferHere": {
        if (m.action === "dontOfferHere") {
          const w = this.deps.model.windows.get(o.msg.windowId);
          memory.upsert("preference", `dontOffer:${kind}:${bundleId}`, { rule: "dontOffer", offerKind: kind, bundleId, appName: w?.app.name ?? bundleId }, this.clock, w?.app.name ?? null);
        }
        memory.recordReaction(kind, bundleId, m.action === "dismiss" ? "dismiss" : "dontOfferHere", this.clock);
        if (o.state === "open") this.withdraw(o, "dismissed");
        if (o.loopId !== null) {
          const ev = this.loops.dismissed(o.loopId);
          if (ev !== null) this.onLoop(ev);
        }
        return null;
      }
    }
  }

  memoryRequest(m: MemoryRequest): MemoryReply {
    const memory = this.deps.memory;
    const reply = (entries: MemoryReply["entries"], error: string | null = null): MemoryReply => ({ type: "memoryReply", v: PROTOCOL_VERSION, requestId: m.requestId, error, entries });
    try {
      if (m.op === "list") return reply(memory.list(m.kind));
      if (m.id === undefined) throw new MemoryError(`${m.op} needs the entry's id`);
      const now = Math.max(this.clock, Date.now());
      switch (m.op) {
        case "edit":
          if (m.fields === undefined) throw new MemoryError("edit needs fields");
          return reply([memory.edit(m.id, m.fields, now)]);
        case "pause":
        case "resume": {
          const e = memory.setPaused(m.id, m.op === "pause");
          if (m.op === "pause") this.withdrawRoutine(m.id);
          return reply([e]);
        }
        case "forget":
          memory.forget(m.id, now);
          this.withdrawRoutine(m.id);
          return reply([]);
      }
    } catch (e) {
      if (e instanceof MemoryError) return reply([], e.message);
      throw e;
    }
  }

  // MARK: - recognizer results

  private onLoop(ev: LoopEvent): void {
    const loopOffers = [...this.offers.values()].filter((o) => o.loopId === ev.loop.id && o.state === "open");
    switch (ev.type) {
      case "predict":
        this.offer("loopNext", ev.loop.id, { loopId: ev.loop.id, routineId: null }, ev.cells, { hits: 1, misses: 0, paused: false, grounded: true });
        return;
      case "confirmed":
        for (const o of loopOffers) this.withdraw(o, "taken");
        if (ev.rest.length > 0) this.offer("loopFinish", ev.loop.id, { loopId: ev.loop.id, routineId: null }, ev.rest.flat(), { hits: 2, misses: 0, paused: false, grounded: true });
        return;
      case "ended":
        for (const o of loopOffers) {
          // An offer the user walked past without a word counts against its kind here today.
          if (ev.reason !== "dismissed") this.deps.memory.recordReaction(o.msg.kind, o.msg.bundleId, "ignored", this.clock);
          this.withdraw(o, ev.reason === "dismissed" ? "dismissed" : ev.reason);
        }
        return;
    }
  }

  /** Offers the best routine that may speak; every prediction's decision is logged. */
  private onPredictions(preds: SilentPrediction[]): void {
    const sorted = [...preds].sort((a, b) => b.routine.hits - a.routine.hits);
    let spoken = false;
    for (const p of sorted) {
      const cells = p.cells.filter((c): c is RoutineCell => c !== null);
      const input = { hits: p.routine.hits, misses: p.routine.misses, paused: p.routine.paused, grounded: p.grounded };
      spoken = this.offer("routine", p.routine.id, { loopId: null, routineId: p.routine.id }, cells, input, p.dstWindowId, spoken) !== null || spoken;
    }
  }

  // MARK: - offers

  private offer(
    kind: OfferKind,
    patternId: string,
    ids: { loopId: string | null; routineId: string | null },
    cells: Cell[],
    evidence: { hits: number; misses: number; paused: boolean; grounded: boolean },
    windowId = cells[0]?.dstWindowId,
    /** Another offer already spoke for this window. */
    outranked = false,
  ): OfferState | null {
    const model = this.deps.model;
    const w = windowId === undefined ? undefined : model.windows.get(windowId);
    if (w === undefined || windowId === undefined) return null;
    const memory = this.deps.memory;
    const bundleId = w.app.bundleId;
    // The gate's time covers reading its context from memory, deciding, and writing the decision log.
    const decision = this.timings.time("gate", (): Decision => {
      const decided = decide(
        { offerKind: kind, ...evidence, grounded: evidence.grounded && cells.length > 0 && cells.every((c) => model.windows.has(c.srcWindowId)) },
        {
          shadow: this.deps.shadow(),
          permission: memory.permission(model.focusedWindowId === windowId ? "writeHere" : "writeElsewhere"),
          dontOfferHere: memory.dontOffer(kind, bundleId),
          ignoredToday: memory.ignoredOn(kind, bundleId, this.clock),
          spokenLastHour: memory.spokenSince(this.clock - 60 * 60 * 1000),
        },
      );
      const d: Decision = outranked ? { speak: false, reasons: [...decided.reasons, "outranked"], showProbability: decided.showProbability } : decided;
      this.log(kind, patternId, windowId, d);
      return d;
    });
    if (!decision.speak) return null;

    const id = `offer-${++this.seq}`;
    const written = cells.map((c) => {
      const node = w.nodes.get(c.dstKey);
      const dstShapeHash = this.deps.hash(`dst\u0000${bundleId}\u0000${w.window.kind}\u0000${templateOf(c.dstKey, node?.role ?? c.dstRole)}`);
      const m = applyMemory(memory, this.deps.hash, c.value, c.kind, dstShapeHash);
      return { ...c, written: m.value, dstShapeHash, memory: m.used };
    });
    const { plan, slots } = this.plan(id, kind, w.window.title, bundleId, written);
    const msgCells: OfferCell[] = written.map((c) => {
      const src = model.windows.get(c.srcWindowId);
      return {
        windowId: c.dstWindowId,
        key: c.dstKey,
        frame: w.nodes.get(c.dstKey)?.frame ?? null,
        value: c.written,
        source: { windowId: c.srcWindowId, nodeKey: c.srcKey, appName: src?.app.name ?? "", windowTitle: src?.window.title ?? "" },
        memory: c.memory,
      };
    });
    const msg: PatternOffer = {
      type: "patternOffer",
      v: PROTOCOL_VERSION,
      id,
      at: this.clock,
      kind,
      patternId,
      says: this.says(kind, msgCells),
      windowId,
      bundleId,
      cells: msgCells,
      showProbability: decision.showProbability,
    };
    const o: OfferState = { msg, cells: written, plan, slots, ...ids, state: "open", closedAt: null };
    this.offers.set(id, o);
    this.deps.publish(msg);
    return o;
  }

  private says(kind: OfferKind, cells: OfferCell[]): string {
    const from = cells[0]?.source.appName ?? "";
    switch (kind) {
      case "loopNext":
        return `${cells.map((c) => c.value).join(", ")}, from ${from}`;
      case "loopFinish":
        return `Finish the rest: ${cells.length} more ${cells.length === 1 ? "value" : "values"} from ${from}`;
      case "routine":
        return `Fill ${cells.length} values from ${[...new Set(cells.map((c) => c.source.appName))].join(" and ")}`;
    }
  }

  /** One value end state per cell, with every screen string passed as a slot so none is read as a placeholder. */
  private plan(id: string, kind: OfferKind, title: string, bundleId: string, cells: (Cell & { written: string })[]): { plan: Plan; slots: Record<string, string> } {
    const slots: Record<string, string> = { title };
    const declared: Record<string, string> = { title: "the destination window's title" };
    const steps = cells.map((c, i) => {
      slots[`v${i}`] = c.written;
      declared[`v${i}`] = `value ${i + 1}`;
      const label = (c.dstLabel ?? "").replace(/[{}]/g, "");
      return {
        says: `${label === "" ? "The field" : label} holds {{v${i}}}`,
        end: {
          kind: "valueEquals" as const,
          window: { bundleId, title: "{{title}}" },
          target: { key: c.dstKey, role: c.dstRole, describe: label === "" ? "the field" : `the ${label} field` },
          value: `{{v${i}}}`,
        },
      };
    });
    return { plan: { id, title: kind === "loopFinish" ? "Finish the rest" : kind === "loopNext" ? "Fill the next row" : "Run the routine", slots: declared, steps }, slots };
  }

  private withdraw(o: OfferState, reason: OfferWithdrawn["reason"]): void {
    if (o.state === "open") o.state = "closed";
    o.closedAt = this.clock;
    this.deps.publish({ type: "offerWithdrawn", v: PROTOCOL_VERSION, at: this.clock, id: o.msg.id, reason });
  }

  private withdrawRoutine(routineId: string): void {
    for (const o of this.offers.values()) if (o.routineId === routineId && o.state === "open") this.withdraw(o, "stale");
  }

  private log(kind: OfferKind, pattern: string, windowId: string, d: Decision): void {
    const bundleId = this.deps.model.windows.get(windowId)?.app.bundleId ?? "";
    this.deps.memory.logDecision({ at: this.clock, offerKind: kind, pattern, bundleId, speak: d.speak, reasons: d.reasons, showProbability: d.showProbability });
  }

  // MARK: - edits to filled values

  private watch(c: Cell & { written: string; dstShapeHash: string }): void {
    const w = this.deps.model.windows.get(c.dstWindowId);
    this.watches.set(`${c.dstWindowId}\u0000${c.dstKey}`, {
      windowId: c.dstWindowId,
      key: c.dstKey,
      source: c.value,
      written: c.written,
      kind: c.kind,
      dstShapeHash: c.dstShapeHash,
      label: c.dstLabel ?? "Field",
      app: w?.app.name ?? "",
      until: this.clock + EDIT_WATCH_MS,
      pending: null,
    });
  }

  private judgeEdit(w: Watch): void {
    if (w.pending === null) return;
    captureEdit(this.deps.memory, this.deps.hash, { source: w.source, written: w.written, edited: w.pending.value, kind: w.kind, dstShapeHash: w.dstShapeHash, fieldLabel: w.label, app: w.app }, w.pending.at);
  }

  private fail(message: string): null {
    this.deps.publish({ type: "error", v: PROTOCOL_VERSION, at: this.clock, message });
    return null;
  }
}
