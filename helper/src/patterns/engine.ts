// The pattern engine: runs the loop and routine recognizers as transfers and changes arrive, turns
// what they find into offers through the gate, runs a taken offer's plan through the executor, and
// learns preferences from the user's edits to values it filled. No model is called anywhere here.
// An offer that speaks goes out as a patternOffer and, for the host, as one alternatives message per
// cell (loopNext) or one action line (loopFinish, routine) whose accept is the same take.
import { performance } from "node:perf_hooks";
import { nodeText, type Change, type ScreenModel } from "../model.ts";
import {
  PROTOCOL_VERSION,
  type HelperMessage,
  type MemoryReply,
  type MemoryRequest,
  type OfferCell,
  type OfferControl,
  type OfferAction,
  type OfferAlternatives,
  type OfferKind,
  type OfferWithdrawn,
  type PatternOffer,
  type ValueKind,
} from "../protocol.ts";
import type { PopupRef, PopupValue } from "../popup.ts";
import type { AcceptHandler, AcceptResult } from "../offers/registry.ts";
import { expired } from "../offers/lifetimes.ts";
import type { Transfer } from "../transfers.ts";
import type { RollingText } from "../rolling-text.ts";
import type { TaskResult } from "../executor/executor.ts";
import type { Plan } from "../executor/schema.ts";
import { decide, type Decision } from "./gate.ts";
import { LoopRecognizer, type LoopCell, type LoopEvent } from "./loops.ts";
import { MemoryError, dontOfferMatch, type MemoryStore } from "./memory.ts";
import { applyMemory, captureEdit } from "./preferences.ts";
import { RoutineRecognizer, type Hash, type RoutineCell, type SilentPrediction } from "./routines.ts";
import { describeTransfer, templateOf } from "./shape.ts";
import { normalizeValue } from "../normalize.ts";
import { offerField } from "../offers/field.ts";

/** How long after Caret fills a field an edit to it is read as a preference. Assumed. */
export const EDIT_WATCH_MS = 60_000;
/** How long an edit must be still before it is judged, as for transfers. Assumed. */
export const EDIT_SETTLE_MS = 1500;
/** Offers are kept this long after they close, so "Don't offer this here" can follow an undo. */
const OFFER_KEEP_MS = 10 * 60 * 1000;

export interface EngineDeps {
  model: ScreenModel;
  /** For every window that shows a transferred value, not only the one the transfer log credited. */
  text: RollingText;
  memory: MemoryStore;
  hash: Hash;
  /** `accept` is how an action this message offers the host is taken. */
  publish: (m: HelperMessage, accept?: AcceptHandler) => void;
  /** Runs a plan through the executor; `expect` holds field values, by window and key, that must still hold at its first read. */
  run: (taskId: string, plan: Plan, slots: Record<string, string>, expect?: Record<string, Record<string, string>>) => Promise<TaskResult>;
  shadow: () => boolean;
  /** A loopFinish or routine offer whose every value the user entered themselves, withdrawn as taken with no run to follow. */
  enteredByUser?: (offerId: string) => void;
}

type Cell = LoopCell | RoutineCell;

interface OfferState {
  msg: PatternOffer;
  cells: (Cell & { written: string; dstShapeHash: string; memory: string[] })[];
  plan: Plan;
  slots: Record<string, string>;
  loopId: string | null;
  routineId: string | null;
  state: "open" | "taken" | "closed";
  closedAt: number | null;
  /**
   * The alternatives messages published for a loopNext offer's cells, with every candidate's sources:
   * each window whose list predicts that value, the one its ref quotes first. A closed source leaves
   * each candidate it supports, which then quotes its next source or, with none left, goes; a changed
   * message is sent again, one left with no candidate is withdrawn, and the offer with the last of them.
   */
  alts: { cell: number; msg: OfferAlternatives; candidates: AltCandidate[] }[];
  /** Memory entries that only the alternatives read; the offer is withdrawn when one goes, as for its own cells. */
  altMemory: Set<string>;
  /**
   * A loopFinish or routine some of whose destinations the user is filling by hand: the time of the
   * latest change to them, or null. Judged once they have been still for EDIT_SETTLE_MS (handEntry).
   */
  handEditAt: number | null;
}

interface AltCandidate {
  written: string;
  memory: string[];
  sources: { srcWindowId: string; srcKey: string; value: string }[];
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

/**
 * Per-recognizer handling times, in milliseconds, for the 5 ms budget. Wall time includes any time the
 * process waited for a CPU; CPU time (process.cpuUsage, so it also counts V8's helper threads) is the
 * work itself. On a loaded Mac the two differ by an order of magnitude at the tail.
 */
export interface TimingSummary {
  n: number;
  wall: { p50: number; p99: number; max: number };
  cpu: { p50: number; p99: number; max: number };
}

export class Timings {
  private readonly wall = new Map<string, number[]>();
  private readonly cpu = new Map<string, number[]>();
  static readonly MAX = 200_000;

  time<T>(name: string, f: () => T): T {
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    try {
      return f();
    } finally {
      const wall = performance.now() - t0;
      const c = process.cpuUsage(c0);
      this.add(name, wall, (c.user + c.system) / 1000);
    }
  }

  add(name: string, wallMs: number, cpuMs: number): void {
    for (const [m, v] of [[this.wall, wallMs], [this.cpu, cpuMs]] as const) {
      let s = m.get(name);
      if (s === undefined) m.set(name, (s = []));
      if (s.length < Timings.MAX) s.push(v);
    }
  }

  summary(): Record<string, TimingSummary> {
    const q = (xs: number[]): { p50: number; p99: number; max: number } => {
      const v = [...xs].sort((a, b) => a - b);
      const at = (p: number): number => v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? 0;
      return { p50: at(0.5), p99: at(0.99), max: v[v.length - 1] ?? 0 };
    };
    const out: Record<string, TimingSummary> = {};
    for (const [name, w] of this.wall) out[name] = { n: w.length, wall: q(w), cpu: q(this.cpu.get(name) ?? []) };
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
      this.timings.time("routines.transfer", () => this.routines.onTransfer(p));
      for (const ev of events) this.onLoop(ev);
    }
  }

  onChanges(changes: readonly Change[]): void {
    for (const c of changes) {
      this.clock = Math.max(this.clock, c.at);
      if (c.kind === "windowOpened") {
        const preds = this.timings.time("routines.open", () => this.routines.onWindowOpened(c.windowId, c.at));
        if (preds.length > 0) this.onPredictions(preds);
      } else if (c.kind === "value" && c.key !== null) {
        const w = this.watches.get(`${c.windowId}\u0000${c.key}`);
        if (w !== undefined) w.pending = c.after === w.written ? null : { value: c.after ?? "", at: c.at };
      }
    }
    const touched = new Set(changes.filter((c) => c.kind === "value" || c.kind === "removed").map((c) => c.windowId));
    if (touched.size > 0) this.recheckOpen(touched);
  }

  /**
   * An open offer that a change in one of its windows made impossible to take as shown is withdrawn
   * now, rather than refused when the host accepts it. A loopFinish or routine is judged against what
   * the user entered by hand (handEntry). A loopNext is judged by what its alternatives show now
   * (recheckShown).
   */
  private recheckOpen(windowIds: ReadonlySet<string>): void {
    // A copy: a re-offer adds to the map.
    for (const o of [...this.offers.values()]) {
      if (o.state !== "open") continue;
      const sources = o.alts.length > 0 ? o.alts.flatMap((a) => a.candidates.map((x) => x.sources[0]?.srcWindowId)) : o.cells.map((c) => c.srcWindowId);
      if (!o.cells.some((c) => windowIds.has(c.dstWindowId)) && !sources.some((id) => id !== undefined && windowIds.has(id))) continue;
      if (o.msg.kind !== "loopNext") {
        this.handEntry(o, false);
        continue;
      }
      const live = o.loopId !== null && this.loops.active?.id === o.loopId;
      const verdict = o.alts.length > 0 ? this.recheckShown(o, live) : this.recheck(o) === null ? null : this.allEntered(o) ? "taken" : "stale";
      if (verdict === null) continue;
      this.withdraw(o, verdict);
      // A live loop's prediction is wrong now; its loop ends too, or the old value typed later would still confirm it.
      if (live && o.loopId !== null) {
        const ev = this.loops.invalidate(o.loopId);
        if (ev !== null) this.onLoop(ev);
      }
    }
  }

  /**
   * Judges a loopFinish or routine against what the user has entered by hand. A destination that is
   * gone, or an empty one whose source no longer shows its value, makes it `stale` now. Every
   * destination holding what the offer would write makes it `taken` now. Anything in between waits
   * until the destinations have been still for EDIT_SETTLE_MS, since a value typed by hand passes
   * through every prefix of itself: then a value other than the offer's is `stale`, and if some cells
   * hold the offer's values and the rest are empty, the empty ones are offered again (reoffer).
   */
  private handEntry(o: OfferState, settled: boolean): void {
    const model = this.deps.model;
    const empty: number[] = [];
    let typed = false;
    for (const [i, c] of o.cells.entries()) {
      const node = model.windows.get(c.dstWindowId)?.nodes.get(c.dstKey);
      if (node === undefined || node.editable !== true) return this.withdraw(o, "stale");
      const v = node.value ?? "";
      if (v === "") {
        if (!this.stillShows({ srcWindowId: c.srcWindowId, srcKey: c.srcKey, value: c.value })) return this.withdraw(o, "stale");
        empty.push(i);
      } else if (v !== c.written) typed = true;
    }
    if (empty.length === o.cells.length) {
      o.handEditAt = null;
      return;
    }
    if (!typed && empty.length === 0) {
      this.withdraw(o, "taken");
      // The user entered every value themselves: no run follows, so the prepared work is over.
      this.deps.enteredByUser?.(o.msg.id);
      return;
    }
    if (!settled) {
      o.handEditAt = this.clock;
      return;
    }
    if (typed) this.withdraw(o, "stale");
    else this.reoffer(o, empty);
  }

  /**
   * Offers the cells at `keep` again, under a new id, as the same kind of offer: the user entered the
   * others by hand. The old offer is withdrawn as `reoffered`, naming the new one. The gate is not asked
   * again, since this narrows an offer it already let speak. The new offer's lifetime starts now; that
   * is assumed, like the lifetimes themselves.
   */
  private reoffer(o: OfferState, keep: readonly number[]): void {
    const model = this.deps.model;
    const w = model.windows.get(o.msg.windowId);
    if (w === undefined) return this.withdraw(o, "stale");
    const id = `offer-${++this.seq}`;
    const cells = keep.map((i) => o.cells[i] as OfferState["cells"][number]);
    const msgCells = keep.map((i) => {
      const c = o.msg.cells[i] as OfferCell;
      return { ...c, frame: model.windows.get(c.windowId)?.nodes.get(c.key)?.frame ?? null };
    });
    const { plan, slots } = this.plan(id, o.msg.kind, w.window.title, o.msg.bundleId, cells);
    const msg: PatternOffer = { ...o.msg, id, at: this.clock, says: this.says(o.msg.kind, msgCells), cells: msgCells };
    const n: OfferState = { msg, cells, plan, slots, loopId: o.loopId, routineId: o.routineId, state: "open", closedAt: null, alts: [], altMemory: new Set(), handEditAt: null };
    this.withdraw(o, "reoffered", id);
    this.offers.set(id, n);
    this.deps.publish(msg);
    this.offerAction(n);
  }

  /** The source node still shows this text, whole or as one of its window's typed values, as recheck asks. */
  private stillShows(s: { srcWindowId: string; srcKey: string; value: string }): boolean {
    const sw = this.deps.model.windows.get(s.srcWindowId);
    const src = sw?.nodes.get(s.srcKey);
    return sw !== undefined && src !== undefined && (nodeText(src) === s.value || sw.values.some((v) => v.nodeKey === s.srcKey && v.text === s.value));
  }

  /** Every destination holds the value the offer would have written there. */
  private allEntered(o: OfferState): boolean {
    return o.cells.every((c) => {
      const v = this.deps.model.windows.get(c.dstWindowId)?.nodes.get(c.dstKey)?.value ?? "";
      return v !== "" && v === c.written;
    });
  }

  /**
   * A loopNext judged by what its alternatives show now, since partial withdrawal may have dropped its
   * own cells' list: null while it still holds; `stale` when a destination is gone or a shown candidate's
   * source no longer shows its text; once every destination is filled (only when the loop is not live,
   * which settles that itself), `taken` if each holds a value shown for it, `stale` if not.
   */
  private recheckShown(o: OfferState, live: boolean): "taken" | "stale" | null {
    const model = this.deps.model;
    for (const a of o.alts) {
      for (const x of a.candidates) {
        const s = x.sources[0];
        if (s === undefined || !this.stillShows(s)) return "stale";
      }
    }
    let filled = 0;
    let matched = 0;
    for (const [i, c] of o.cells.entries()) {
      const node = model.windows.get(c.dstWindowId)?.nodes.get(c.dstKey);
      if (node === undefined || node.editable !== true) return "stale";
      const v = node.value ?? "";
      if (v === "") continue;
      filled++;
      if (o.alts.find((a) => a.cell === i)?.candidates.some((x) => x.written === v) === true) matched++;
    }
    if (live || filled < o.cells.length) return null;
    return matched === o.cells.length ? "taken" : "stale";
  }

  /** Called before the window leaves the model. */
  onWindowClosed(windowId: string): void {
    this.timings.time("routines.close", () => this.routines.onWindowClosed(windowId));
    this.loops.sourceClosed(windowId);
    for (const [id, w] of this.watches) {
      if (w.windowId !== windowId) continue;
      this.judgeEdit(w);
      this.watches.delete(id);
    }
    for (const o of this.offers.values()) {
      if (o.state !== "open") continue;
      if (o.msg.windowId === windowId) this.withdraw(o, "stale");
      else if (o.alts.length > 0) this.dropSource(o, windowId);
      else if (o.cells.some((c) => c.srcWindowId === windowId)) this.withdraw(o, "stale");
    }
  }

  /**
   * A source window of a loopNext offer's alternatives closed. Each cell's message loses the candidates
   * read from it and is sent again under the same key; one left with none is withdrawn. The offer stays
   * while any message remains, though taking it through offerControl then fails its recheck if its own
   * source was the one that closed.
   */
  private dropSource(o: OfferState, windowId: string): void {
    const kept: OfferState["alts"] = [];
    for (const a of o.alts) {
      if (!a.candidates.some((x) => x.sources.some((s) => s.srcWindowId === windowId))) {
        kept.push(a);
        continue;
      }
      const candidates = a.candidates.flatMap((x): AltCandidate[] => {
        // Only lists that still show the value: a repeat's source may have changed since it was offered.
        const sources = x.sources.filter((s) => s.srcWindowId !== windowId && this.stillShows(s));
        const first = sources[0];
        if (first === undefined) return [];
        // With no memory rule behind it, the value is the text Caret copies, so it becomes the remaining list's own spelling.
        return [{ ...x, sources, written: x.memory.length === 0 ? first.value : x.written }];
      });
      if (candidates.length === 0) {
        this.deps.publish({ type: "offerWithdrawn", v: PROTOCOL_VERSION, at: this.clock, id: a.msg.offerKey, reason: "stale" });
        continue;
      }
      const msg: OfferAlternatives = { ...a.msg, at: this.clock, ...this.altValues(candidates) };
      kept.push({ cell: a.cell, msg, candidates });
      this.deps.publish(msg);
    }
    o.alts = kept;
    if (kept.length === 0) this.withdraw(o, "stale");
  }

  tick(now: number): void {
    this.clock = Math.max(this.clock, now);
    const ended = this.timings.time("loops", () => this.loops.tick(now));
    if (ended !== null) this.onLoop(ended);
    this.timings.time("routines.tick", () => this.routines.tick(now));
    this.timings.time("edits", () => {
      for (const [id, w] of this.watches) {
        if (w.pending !== null && now - w.pending.at >= EDIT_SETTLE_MS) {
          this.judgeEdit(w);
          w.pending = null;
        }
        if (w.pending === null && now > w.until) this.watches.delete(id);
      }
    });
    for (const o of [...this.offers.values()]) {
      if (o.state === "open" && o.handEditAt !== null && this.clock - o.handEditAt >= EDIT_SETTLE_MS) {
        o.handEditAt = null;
        this.handEntry(o, true);
      }
    }
    for (const o of this.offers.values()) {
      if (o.state !== "open" || !expired(o.msg.kind, o.msg.at, this.clock)) continue;
      // The user let a loop's offer run out; that counts against its kind here today, as walking past it did before lifetimes.
      if (o.msg.kind !== "routine") this.deps.memory.recordReaction(o.msg.kind, o.msg.bundleId, "ignored", this.clock);
      this.withdraw(o, "expired");
    }
    for (const [id, o] of this.offers) if (o.closedAt !== null && now - o.closedAt > OFFER_KEEP_MS) this.offers.delete(id);
    this.timings.time("decisionLog", () => this.deps.memory.flushDecisions());
  }

  /** A new reader numbers windows from scratch: every open bundle closes, and every offer is stale. */
  readerRestarted(): void {
    this.routines.flush();
    this.loops.reset();
    for (const o of this.offers.values()) if (o.state === "open") this.withdraw(o, "stale");
    this.watches.clear();
  }

  shutdown(): void {
    this.routines.flush();
  }

  /**
   * Runs an open offer's plan as the task with the offer's id: from offerControl take, and from the
   * host's offerAccept of the offer's action line. A refusal says why and has written nothing.
   */
  async take(offerId: string): Promise<AcceptResult> {
    const o = this.offers.get(offerId);
    if (o === undefined) return { refused: "no such offer, or it expired" };
    if (o.state !== "open") return { refused: `already ${o.state === "taken" ? "taken" : "withdrawn"}` };
    if (this.deps.shadow()) return { refused: "the helper is in shadow mode and does not act" };
    const stale = this.recheck(o);
    if (stale !== null) {
      this.withdraw(o, "stale");
      return { refused: `${stale}; nothing was written` };
    }
    o.state = "taken";
    this.withdraw(o, "taken");
    this.deps.memory.recordReaction(o.msg.kind, o.msg.bundleId, "take", this.clock);
    let r: TaskResult;
    try {
      // recheck found every destination empty; one the user fills before the run's first read stops it.
      const empty: Record<string, Record<string, string>> = {};
      for (const c of o.cells) (empty[c.dstWindowId] ??= {})[c.dstKey] = "";
      r = await this.deps.run(o.msg.id, o.plan, o.slots, empty);
    } catch (e) {
      return { refused: e instanceof Error ? e.message : String(e) };
    }
    if (r.outcome !== "done") return r;
    for (const c of o.cells) this.watch(c);
    // The round Caret wrote came from the offer's own list; if that list closed during the run and the
    // loop moved to another, the round does not confirm the other list's loop.
    if (o.loopId !== null && this.loops.active?.srcWindowId === o.cells[0]?.srcWindowId) {
      const ev = this.loops.taken(o.loopId);
      if (ev !== null) this.onLoop(ev);
    }
    return r;
  }

  /** Take, dismiss, or "Don't offer this here". Problems are published as errors. */
  async control(m: OfferControl): Promise<TaskResult | null> {
    const o = this.offers.get(m.offerId);
    if (o === undefined) return this.fail(`offer ${m.offerId}: no such offer, or it expired`);
    const { kind, bundleId } = o.msg;
    const memory = this.deps.memory;
    switch (m.action) {
      case "take": {
        const r = await this.take(m.offerId);
        return "refused" in r ? this.fail(`offer ${m.offerId}: ${r.refused}`) : r;
      }
      case "dismiss":
      case "dontOfferHere": {
        if (m.action === "dontOfferHere") {
          const w = this.deps.model.windows.get(o.msg.windowId);
          memory.upsert("preference", dontOfferMatch(kind, bundleId), { rule: "dontOffer", offerKind: kind, bundleId, appName: w?.app.name ?? bundleId }, this.clock, w?.app.name ?? null);
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
        case "edit": {
          if (m.fields === undefined) throw new MemoryError("edit needs fields");
          const e = memory.edit(m.id, m.fields, now);
          this.withdrawDependents(m.id);
          return reply([e]);
        }
        case "pause":
        case "resume": {
          const e = memory.setPaused(m.id, m.op === "pause");
          if (m.op === "pause") this.withdrawDependents(m.id);
          return reply([e]);
        }
        case "forget":
          memory.forget(m.id, now);
          this.withdrawDependents(m.id);
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
      case "predict": {
        const o = this.offer("loopNext", ev.loop.id, { loopId: ev.loop.id, routineId: null }, ev.cells, { hits: 1, misses: 0, paused: false, grounded: true });
        if (o !== null) this.offerAlternatives(o, ev.alternatives, ev.repeats);
        return;
      }
      case "confirmed":
        for (const o of loopOffers) this.withdraw(o, "taken");
        if (ev.rest.length > 0) this.offer("loopFinish", ev.loop.id, { loopId: ev.loop.id, routineId: null }, ev.rest.flat(), { hits: 2, misses: 0, paused: false, grounded: true });
        return;
      case "ended":
        // A loop that went quiet leaves its offers to their own lifetimes (OFFER_LIFETIMES), which end
        // them as expired; the loop's gap would otherwise cut a five-minute loopFinish to two.
        if (ev.reason === "idle") return;
        for (const o of loopOffers) {
          // An offer the user walked past without a word counts against its kind here today.
          if (ev.reason === "diverged") this.deps.memory.recordReaction(o.msg.kind, o.msg.bundleId, "ignored", this.clock);
          this.withdraw(o, ev.reason);
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
    // A memory rule may change what Caret writes; the loop must accept that value when it comes back as a transfer.
    if (ids.loopId !== null) for (const c of written) if (c.written !== c.value) this.loops.expect(ids.loopId, c.dstKey, c.written, c.kind);
    const o: OfferState = { msg, cells: written, plan, slots, ...ids, state: "open", closedAt: null, alts: [], altMemory: new Set(), handEditAt: null };
    this.offers.set(id, o);
    this.deps.publish(msg);
    if (kind !== "loopNext") this.offerAction(o);
    return o;
  }

  /** The value a cell would write, with its ref: the source node and the text quoted from it, or a memory rule over that. */
  private cellValue(srcWindowId: string, srcKey: string, source: string, written: string, memory: readonly string[]): PopupValue {
    const node: PopupRef = { node: `${srcWindowId}/${srcKey}`, quote: source };
    if (written === source) return { text: written, ref: node };
    return { text: written, ref: { rule: "memory", derived: [node, ...memory.map((id) => ({ memory: id }))] } };
  }

  /**
   * One alternatives message per cell of a loopNext offer that spoke: the main fit's value first, then
   * other source windows' values for the same cell. A value an alternative would write after memory
   * rules is expected by the loop too, under its own fit, so inserting it switches the loop there.
   */
  private offerAlternatives(o: OfferState, alternatives: readonly LoopCell[][], repeats: readonly LoopCell[][]): void {
    const model = this.deps.model;
    o.cells.forEach((c, i) => {
      const w = model.windows.get(c.dstWindowId);
      if (w === undefined) return;
      const source = (x: LoopCell | Cell) => ({ srcWindowId: x.srcWindowId, srcKey: x.srcKey, value: x.value });
      const candidates: (AltCandidate & { norm: string })[] = [{ written: c.written, memory: c.memory, sources: [source(c)], norm: normalizeValue(c.value, c.kind) }];
      for (const alt of alternatives[i] ?? []) {
        const m = applyMemory(this.deps.memory, this.deps.hash, alt.value, alt.kind, c.dstShapeHash);
        if (m.value !== alt.value && o.loopId !== null) this.loops.expect(o.loopId, alt.dstKey, m.value, alt.kind, alt.srcWindowId);
        for (const id of m.used) o.altMemory.add(id);
        candidates.push({ written: m.value, memory: m.used, sources: [source(alt)], norm: normalizeValue(alt.value, alt.kind) });
      }
      for (const r of repeats[i] ?? []) {
        const x = candidates.find((y) => y.norm === normalizeValue(r.value, r.kind));
        if (x === undefined) continue;
        x.sources.push(source(r));
        // What Caret would write for this value, memory rules applied, is accepted from this list too.
        if (o.loopId !== null && x.written !== r.value) this.loops.expect(o.loopId, r.dstKey, x.written, r.kind, r.srcWindowId);
      }
      const msg: OfferAlternatives = {
        type: "alternatives",
        v: PROTOCOL_VERSION,
        offerKey: `${o.msg.id}.${i}`,
        at: this.clock,
        field: offerField(w, c.dstKey),
        ...this.altValues(candidates),
      };
      o.alts.push({ cell: i, msg, candidates: candidates.map(({ norm: _, ...rest }) => rest) });
      this.deps.publish(msg);
    });
  }

  /** The candidates as the host shows them, each quoting its first source, and whether the top one is quoted as is. */
  private altValues(candidates: readonly AltCandidate[]): Pick<OfferAlternatives, "candidates" | "quoted"> {
    const values = candidates.map((x) => {
      const s = x.sources[0] as AltCandidate["sources"][number];
      return this.cellValue(s.srcWindowId, s.srcKey, s.value, x.written, x.memory);
    });
    const top = values[0] as PopupValue;
    return { candidates: values, quoted: "node" in top.ref && top.ref.quote === top.text };
  }

  /**
   * The action line of a loopFinish or routine offer, under the offer's own id, so accepting it runs as
   * the same task a take does. Its end state is the offer's sentence, derived from every cell's value.
   */
  private offerAction(o: OfferState): void {
    const first = o.cells[0];
    const w = first === undefined ? undefined : this.deps.model.windows.get(first.dstWindowId);
    if (first === undefined || w === undefined) return;
    const kind = o.msg.kind;
    const msg: OfferAction = {
      type: "action",
      v: PROTOCOL_VERSION,
      offerKey: o.msg.id,
      at: this.clock,
      field: offerField(w, first.dstKey),
      app: w.app.name,
      endState: { text: o.msg.says, ref: { rule: kind, derived: o.cells.map((c) => this.cellValue(c.srcWindowId, c.srcKey, c.value, c.written, c.memory).ref) } },
      actions: [kind === "loopFinish" ? { id: "finish", label: "Finish", key: "tab" } : { id: "run", label: "Fill", key: "tab" }],
    };
    this.deps.publish(msg, () => this.take(o.msg.id));
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
          // The exact key only: a key that has gone must stop the step, never fall back to another field with the same role.
          target: { key: c.dstKey, describe: label === "" ? "the field" : `the ${label} field` },
          value: `{{v${i}}}`,
        },
      };
    });
    return { plan: { id, title: kind === "loopFinish" ? "Finish the rest" : kind === "loopNext" ? "Fill the next row" : "Run the routine", slots: declared, steps }, slots };
  }

  /** `replacedBy` is the new offer's id, and only for `reoffered`. */
  private withdraw(o: OfferState, reason: OfferWithdrawn["reason"], replacedBy?: string): void {
    if (o.state === "open") o.state = "closed";
    o.closedAt = this.clock;
    o.handEditAt = null;
    // The cells' alternatives go first, so the offer's own withdrawal is the last word on it.
    for (const a of o.alts) this.deps.publish({ type: "offerWithdrawn", v: PROTOCOL_VERSION, at: this.clock, id: a.msg.offerKey, reason });
    o.alts = [];
    this.deps.publish({ type: "offerWithdrawn", v: PROTOCOL_VERSION, at: this.clock, id: o.msg.id, reason, ...(replacedBy === undefined ? {} : { replacedBy }) });
  }

  /** Withdraws every open offer built from this memory entry: its routine, or a value a memory rule changed. */
  private withdrawDependents(id: string): void {
    for (const o of this.offers.values()) {
      if (o.state === "open" && (o.routineId === id || o.cells.some((c) => c.memory.includes(id)) || o.altMemory.has(id))) this.withdraw(o, "stale");
    }
  }

  /**
   * Why an offer can no longer be taken as shown, or null. Every destination must still be there and
   * empty, and every source must still show the text the offer copied (plan section 4, "Grounded").
   */
  private recheck(o: OfferState): string | null {
    const model = this.deps.model;
    for (const c of o.cells) {
      const node = model.windows.get(c.dstWindowId)?.nodes.get(c.dstKey);
      if (node === undefined) return `the field ${c.dstKey} is gone`;
      if (node.editable !== true || (node.value ?? "") !== "") return `the field ${c.dstKey} is no longer empty`;
      const sw = model.windows.get(c.srcWindowId);
      const src = sw?.nodes.get(c.srcKey);
      if (sw === undefined || src === undefined) return `the source ${c.srcKey} is gone`;
      if (nodeText(src) !== c.value && !sw.values.some((v) => v.nodeKey === c.srcKey && v.text === c.value)) return `the source ${c.srcKey} changed`;
    }
    return null;
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
      label: (c.dstLabel ?? "").trim().slice(0, 80) || "Field",
      app: w?.app.name ?? "",
      until: this.clock + EDIT_WATCH_MS,
      pending: null,
    });
  }

  private judgeEdit(w: Watch): void {
    if (w.pending === null) return;
    try {
      captureEdit(this.deps.memory, this.deps.hash, { source: w.source, written: w.written, edited: w.pending.value, kind: w.kind, dstShapeHash: w.dstShapeHash, fieldLabel: w.label, app: w.app }, w.pending.at);
    } catch (e) {
      // An edit memory cannot hold (an over-long value) is not learned; it must not stop the tick.
      if (!(e instanceof MemoryError)) throw e;
    }
  }

  private fail(message: string): null {
    this.deps.publish({ type: "error", v: PROTOCOL_VERSION, at: this.clock, message });
    return null;
  }
}
