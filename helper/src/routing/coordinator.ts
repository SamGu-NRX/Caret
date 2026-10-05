// The RoutingCoordinator (action engine v2, section 3): the one place that decides, once per moment, whether Caret
// stays quiet, helps the user write, asks one thing, or acts. Producers list candidates (routes.ts) and make an offer
// only when the decision chose them; none of them publishes an ambient offer on its own while routing is on.
//
// Per context (context.ts), in order:
//   1. Local rules, no model call: paused, secure field, denied role or window, incomplete snapshot, input-method
//      composition, nothing legal to do, or a request the privacy budgets refuse.
//   2. Router 1: one Jev Choice over the outcomes legal now. At most one request in flight and one Router 1 start per
//      ROUTER1_COOLDOWN_MS; a context that changes meanwhile replaces the one waiting (it is not queued), and a reply
//      for a context that is no longer current is dropped. No retry. A low-confidence answer abstains; a call that
//      failed or timed out, an answer that cannot be read (missing, forged, nonfinite) and a stale reply decide `error`
//      (R2 lead decision 1), so the host can tell "the router said no" from "the router did not answer" and fall back.
//   3. Router 2, only after act: one Choice over the registry frozen for the same context, skipped when it lists one
//      real route.
// Two things never wait for a router (R2 lead decisions 2 and 3):
//   - An offer the user already consented to, by a record the helper itself wrote (consent.ts), goes out as soon as
//     it is listed, unless a local rule holds the moment. It is not part of any routing context, so its arrival
//     neither opens a decision nor ends a write session. Its decision is logged with the code-written reason and is
//     not sent to the host: it arrives as the producer's own offer.
//   - A write session lives through a sentence or paragraph end in its own field: that context is decided `write` at
//     once, with no model call, and only its act candidates (an event card, say) go to Router 1, whose answer is never
//     sent as the context's decision: a chosen task is offered beside the writing help. A change of field, selection,
//     composition, candidates without a sentence end, memory or settings decides again.
// A decision grants nothing. The chosen producer runs its own checks and makes an offer the user still has to accept;
// skills keep only the autonomy the user already gave them (patterns/skills.ts), which this file never reads.
import type { AskJev } from "../fill/jev.ts";
import type { ScreenModel } from "../model.ts";
import type { RouteFailure } from "../protocol.ts";
import { breakpoint, contextNow, sentenceOnly, type Breakpoint, type FocusSeen, type HostEditing, type RoutingContext } from "./context.ts";
import type { Consent } from "./consent.ts";
import { PrivacyRefusal, ROUTER1_FLOOR, ROUTER2_FLOOR, router1Request, router2Request, sendRouter, type Read, type Refusal } from "./judge.ts";
import { freeze, realRoutes, type Outcome, type Registry, type Route, type RouteCandidate } from "./routes.ts";

/** Router 1 starts at most once in this long. From plan section 3 (the two-second rule); not measured here. */
export const ROUTER1_COOLDOWN_MS = 2000;
/** Fields Caret never routes for: a search box takes queries, not values or prose. Written, not measured. */
export const DENIED_ROLES: ReadonlySet<string> = new Set(["AXSearchField"]);
/** Window kinds Caret never routes in: a system prompt (B22: never acted in). */
export const DENIED_WINDOW_KINDS: ReadonlySet<string> = new Set(["systemdialog"]);
/** Questions remembered as asked, so a dismissed one is not asked again in the same moment. Bound, not measured. */
const ASKED_KEEP = 500;
/** Decisions and latencies kept in memory for evaluations, newest last; counts go to the store. A bound, not measured. */
const DECISIONS_KEEP = 2000;

/** The route a chosen candidate logs as: its kind, or "workflow:<producer>". */
const routeOf = (c: RouteCandidate): string => (c.workflow === undefined ? c.kind : `workflow:${c.workflow}`);

/** Appends to a bounded record, dropping the oldest. */
function keep<T>(xs: T[], x: T): void {
  if (xs.length >= DECISIONS_KEEP) xs.shift();
  xs.push(x);
}

export type LocalReason = "paused" | "secure" | "deniedRole" | "incomplete" | "composing" | "noCapability" | "privacy";

export interface Decision {
  gen: number;
  at: number;
  /** The window and field the context was about (key null when focus is on no field). */
  windowId: string;
  key: string | null;
  breakpoint: Breakpoint;
  /** The outcomes code made legal, abstain first. */
  legal: readonly Outcome[];
  /** `error`: the router did not decide (`failure` says why); the host falls back for this context. */
  outcome: Outcome | "error";
  failure: RouteFailure | null;
  /**
   * Which step decided: local rules, Router 1, or Router 2 (or code, when Router 2 had one route); `consent`, an offer
   * the user consented to (consent.ts); `session`, a write session kept across a sentence end.
   */
  by: "local" | "router1" | "router2" | "single" | "consent" | "session";
  /** For `consent`: which record, and the reason code wrote. */
  consent: Consent | null;
  /**
   * Whether this is the context's decision, sent to the host. False for a consented offer and for the act check
   * beside a kept write session: those arrive as the producer's own offer.
   */
  published: boolean;
  local: LocalReason | null;
  refused: { router: 1 | 2; why: Refusal } | null;
  /** The route that ran for act, the workflow name for a workflow, "handoff" for a handoff, the question's candidate for ask. */
  route: string | null;
  /** Router calls this context made (Router 1 and 2). */
  calls: number;
  /** From the breakpoint to this decision. */
  latencyMs: number;
  /** Confidence of the deciding router answer, refused or not; null when no router answered. */
  confidence: number | null;
  /** The last router answer's choice as Jev gave it, refused or not, for evaluations of the floor; null when none. */
  answered: string | null;
  textRevision: string;
}

export interface RoutingStats {
  contexts: number;
  /** Observations that kept the same context (ordinary typing): no decision opened. */
  sameContext: number;
  router1Calls: number;
  router2Calls: number;
  /** Router 2 calls not made because the registry listed one real route. */
  router2Skipped: number;
  /** Contexts decided without a model call. */
  avoided: number;
  staleDrops: number;
  /** Contexts that waited for a slot and were replaced by a newer one before their call. */
  replaced: number;
  byBreakpoint: Record<string, number>;
  byLocal: Record<string, number>;
  byOutcome: Record<string, number>;
  /** Outcomes of the act checks made beside a kept write session (not the contexts' decisions). */
  besideOutcome: Record<string, number>;
  /** Offers passed on consent, by record kind. */
  consented: Record<string, number>;
  /** Consented offers a local rule held at the moment they were listed. */
  consentHeld: number;
  /** Sentence ends that kept a write session. */
  sessionKept: number;
  byRoute: Record<string, number>;
  refused: Record<string, number>;
  /** Router call latencies, ms, the latest DECISIONS_KEEP. */
  callMs: number[];
  /** Breakpoint to decision, ms, for decisions a router made, the latest DECISIONS_KEEP. */
  entryMs: number[];
}

export interface RoutingDeps {
  model: ScreenModel;
  /** The routers' transport. The coordinator sends each request once (JevRequest.retry429 false). */
  askJev: AskJev;
  /** The candidates for this context, listed by code. Called when the context may have changed. */
  candidates: (ctx: RoutingContext) => RouteCandidate[];
  /**
   * The offers the user consented to now, each built by the helper around the record it rests on (Helper
   * consentedCandidates, ConsentLedger.verify). The only way a candidate passes without Router 1: nothing a candidate
   * from `candidates` carries is read for consent. A listed candidate with the same id is not routed. Absent: none.
   */
  consented?: (ctx: RoutingContext) => { cand: RouteCandidate; consent: Consent }[];
  /** A connected host consumes write decisions; until one does, write is not a legal outcome. */
  hostWrites: () => boolean;
  /** The settings' words role (the host's writing help) is on. */
  wordsOn: () => boolean;
  paused: () => boolean;
  /** False in shadow mode: nothing is routed. */
  live: () => boolean;
  readerSession: () => number;
  now: () => number;
  /** Runs `fn` after `ms`; returns how to cancel. setTimeout by default. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  count?: (metric: string, n?: number) => void;
  onDecision?: (d: Decision) => void;
  /**
   * A write decision stopped holding (a breakpoint, a new reader, no window): the host stops its writing help there.
   * `gen` is the context now being decided, whose decision follows.
   */
  onWriteEnded?: (w: { gen: number; windowId: string; key: string; textRevision: string; why: string }) => void;
  warn?: (line: string) => void;
}

interface Current {
  gen: number;
  ctx: RoutingContext;
  reg: Registry;
  legal: Outcome[];
  candidates: RouteCandidate[];
  breakpoint: Breakpoint;
  at: number;
  calls: number;
  decided: boolean;
  /** The act check beside a kept write session: its answer is logged, not published. */
  beside: boolean;
}

const bump = (m: Record<string, number>, k: string, n = 1): void => {
  m[k] = (m[k] ?? 0) + n;
};

export class RoutingCoordinator {
  private readonly deps: RoutingDeps;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private gen = 0;
  private prev: RoutingContext | null = null;
  private cur: Current | null = null;
  private candidatesDirty = true;
  private lastCandidates: RouteCandidate[] = [];
  /** The context waiting for the request slot or the cooldown; always the newest. */
  private waiting = false;
  private inflight: Promise<void> | null = null;
  private lastRouter1At = Number.NEGATIVE_INFINITY;
  private cancelTimer: (() => void) | null = null;
  private focus: FocusSeen | null = null;
  private host: HostEditing | null = null;
  private memoryRevision = 0;
  private settingsRevision = 0;
  private readonly asked = new Set<string>();
  private writeSession: { gen: number; windowId: string; key: string; at: number; textRevision: string } | null = null;
  private hostBreaks = 0;
  private stoppedAt: number | null = null;
  readonly decisions: Decision[] = [];
  readonly stats: RoutingStats = {
    contexts: 0,
    sameContext: 0,
    router1Calls: 0,
    router2Calls: 0,
    router2Skipped: 0,
    avoided: 0,
    staleDrops: 0,
    replaced: 0,
    byBreakpoint: {},
    byLocal: {},
    byOutcome: {},
    besideOutcome: {},
    consented: {},
    consentHeld: 0,
    sessionKept: 0,
    byRoute: {},
    refused: {},
    callMs: [],
    entryMs: [],
  };

  constructor(deps: RoutingDeps) {
    this.deps = deps;
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return () => clearTimeout(t);
      });
  }

  /** The reader's last focus in the app the user is in. */
  onFocus(f: FocusSeen): void {
    this.focus = f;
  }

  /**
   * What the host reports about the field the user is in (selection, input method, its text revision). `breakpoint`:
   * the host saw a sentence or paragraph end there, which opens a new decision even before the reader's walk shows it.
   */
  hostEditing(h: HostEditing | null, breakpoint = false): void {
    this.host = h;
    if (breakpoint) this.hostBreaks++;
    // The host checks a decision about its field against the revision it last sent, so the session's end must carry
    // that one even when the end comes from a reader restart, after the host's report is gone.
    const w = this.writeSession;
    if (w !== null && h?.textRevision !== undefined && h.windowId === w.windowId && h.key === w.key) w.textRevision = h.textRevision;
  }

  /**
   * Ends the write session. `now`: the context that ended it. In the session's own field its text revision is the
   * host's latest, which the host checks the end against; in another field the session's last one is all there is.
   */
  private endWrite(why: string, now: RoutingContext | null = null): void {
    const w = this.writeSession;
    if (w === null) return;
    this.writeSession = null;
    const here = now !== null && now.windowId === w.windowId && now.field?.key === w.key;
    this.deps.count?.(`route.write_closed_${why}`);
    this.deps.onWriteEnded?.({ gen: this.gen, windowId: w.windowId, key: w.key, textRevision: here ? now.textRevision : w.textRevision, why });
  }

  /** A producer's candidates changed outside the user's own field (a conversation line, a held pattern offer, a watch). */
  candidatesChanged(): void {
    this.candidatesDirty = true;
  }

  memoryChanged(): void {
    this.memoryRevision++;
  }

  settingsChanged(): void {
    this.settingsRevision++;
  }

  /** A new reader numbers windows from scratch: whatever was being decided is about windows that are gone. */
  readerRestarted(): void {
    this.focus = null;
    this.host = null;
    this.invalidate("reader");
  }

  /**
   * No context holds any more (a new reader, or no window the user is in): a reply still on its way is stale when it
   * arrives, a waiting context is dropped, and the write session ends. The next observation opens a new context.
   */
  private invalidate(why: "reader" | "none"): void {
    if (this.stoppedAt !== null) return;
    this.gen++;
    this.cur = null;
    this.prev = null;
    this.candidatesDirty = true;
    this.waiting = false;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.endWrite(why);
  }

  /**
   * Stops routing for good (Helper.shutdown, R2 lead decision 4): the cooldown timer is cancelled, a waiting context is
   * dropped, and nothing that arrives later (a reply on its way, an observe from a producer's late answer) decides,
   * counts, publishes or runs a candidate, since the stores behind those may already be closed. `idle()` still resolves
   * once the call in flight returns.
   */
  stop(): void {
    if (this.stoppedAt !== null) return;
    this.stoppedAt = this.deps.now();
    this.waiting = false;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.cur = null;
  }

  get stopped(): boolean {
    return this.stoppedAt !== null;
  }

  /** The write session open now, for the host's decision message and tests. */
  get writing(): { windowId: string; key: string } | null {
    return this.writeSession === null ? null : { windowId: this.writeSession.windowId, key: this.writeSession.key };
  }

  /** The current context, for tests and evaluations. */
  get context(): RoutingContext | null {
    return this.cur?.ctx ?? null;
  }

  /** Resolves when no router request is in flight and none is waiting. Timers do not advance by themselves in tests. */
  async idle(): Promise<void> {
    while (this.inflight !== null) await this.inflight;
  }

  /**
   * Reads the moment again after anything that may have changed it. Ordinary typing keeps the context, so this is
   * cheap then: candidates are listed again only at a breakpoint or when a producer said they changed.
   */
  observe(): void {
    if (this.stoppedAt !== null || !this.deps.live()) return;
    const inputs = { model: this.deps.model, focus: this.focus, host: this.host, readerSession: this.deps.readerSession(), memoryRevision: this.memoryRevision, settingsRevision: this.settingsRevision, hostBreaks: this.hostBreaks };
    const base = contextNow({ ...inputs, candidates: this.lastCandidates.map((c) => c.id) });
    if (base === null) {
      if (this.prev !== null || this.cur !== null) this.invalidate("none");
      return;
    }
    let ctx = base;
    let bp = breakpoint(this.prev, base);
    let consented: { cand: RouteCandidate; consent: Consent }[] = [];
    if (bp !== null || this.candidatesDirty) {
      this.candidatesDirty = false;
      consented = this.deps.consented?.(base) ?? [];
      const passing = new Set(consented.map((x) => x.cand.id));
      this.lastCandidates = this.deps.candidates(base).filter((c) => !passing.has(c.id));
      ctx = { ...base, candidates: this.lastCandidates.map((c) => c.id).sort().join("\u0000") };
      bp = breakpoint(this.prev, ctx);
    }
    const prev = this.prev;
    this.prev = ctx;
    if (bp === null) {
      this.stats.sameContext++;
      if (this.cur !== null) this.cur.ctx = ctx;
    } else this.open(ctx, bp, this.lastCandidates, prev);
    if (consented.length > 0) this.passThrough(ctx, consented);
  }

  /**
   * Offers the user consented to go out now, with no router question. A local rule that holds the moment (paused, a
   * secure or denied field, an unread focus, a composition) holds them too: they stay with their producers and are
   * listed again at the next breakpoint.
   */
  private passThrough(ctx: RoutingContext, list: readonly { cand: RouteCandidate; consent: Consent }[]): void {
    const held = this.holds(ctx);
    if (held !== null) {
      this.stats.consentHeld += list.length;
      this.deps.count?.(`route.consent_held_${held}`, list.length);
      return;
    }
    const now = this.deps.now();
    for (const { cand, consent } of list) {
      const decision: Decision = {
        gen: this.gen,
        at: now,
        windowId: ctx.windowId,
        key: ctx.field?.key ?? null,
        breakpoint: "candidates",
        legal: ["act"],
        outcome: "act",
        failure: null,
        by: "consent",
        local: null,
        refused: null,
        route: routeOf(cand),
        consent,
        published: false,
        calls: 0,
        latencyMs: 0,
        confidence: null,
        answered: null,
        textRevision: ctx.textRevision,
      };
      keep(this.decisions, decision);
      bump(this.stats.consented, consent.kind);
      this.deps.count?.(`route.consent_${consent.kind}`);
      this.deps.onDecision?.(decision);
      this.run(cand);
    }
  }

  private open(ctx: RoutingContext, bp: Breakpoint, candidates: RouteCandidate[], prev: RoutingContext | null): void {
    const now = this.deps.now();
    if (this.waiting && this.cur !== null && !this.cur.decided) {
      this.stats.replaced++;
      this.deps.count?.("route.replaced");
    }
    const gen = ++this.gen;
    const w = this.writeSession;
    const kept = w !== null && prev !== null && ctx.field !== null && w.windowId === ctx.windowId && w.key === ctx.field.key && sentenceOnly(prev, ctx) && this.holds(ctx) === null;
    if (!kept) this.endWrite(bp, ctx);
    const reg = freeze(gen, candidates, this.asked);
    const legal: Outcome[] = ["abstain"];
    if (!kept && ctx.field?.prose === true && this.deps.hostWrites() && this.deps.wordsOn()) legal.push("write");
    // Beside a kept write session only tasks are checked: a question waits for the next decision.
    if (!kept && reg.question !== null) legal.push("ask");
    if (reg.routes.length > 0) legal.push("act");
    const c: Current = { gen, ctx, reg, legal, candidates, breakpoint: bp, at: now, calls: 0, decided: false, beside: kept };
    this.cur = c;
    this.stats.contexts++;
    bump(this.stats.byBreakpoint, bp);
    this.deps.count?.("route.context");
    if (kept) {
      this.keepWriting(c);
      // Nothing to check beside it: the context is decided.
      this.waiting = legal.includes("act");
      if (!this.waiting) {
        c.decided = true;
        this.cancelTimer?.();
        this.cancelTimer = null;
        return;
      }
      this.pump();
      return;
    }
    const local = this.localRule(ctx, legal);
    if (local !== null) {
      this.waiting = false;
      this.cancelTimer?.();
      this.cancelTimer = null;
      this.finish(c, { outcome: "abstain", by: "local", local, refused: null, route: null, confidence: null, answered: null });
      return;
    }
    this.waiting = true;
    this.pump();
  }

  /** The local rules, in order; null when Router 1 should decide. Privacy is checked when the request is built. */
  private localRule(ctx: RoutingContext, legal: readonly Outcome[]): LocalReason | null {
    const held = this.holds(ctx);
    if (held !== null) return held;
    if (legal.length === 1) return "noCapability";
    return null;
  }

  /** The local rules about the moment itself, whatever is legal in it. */
  private holds(ctx: RoutingContext): Exclude<LocalReason, "noCapability" | "privacy"> | null {
    if (this.deps.paused()) return "paused";
    if (ctx.field?.secure === true) return "secure";
    if ((ctx.field !== null && DENIED_ROLES.has(ctx.field.role)) || DENIED_WINDOW_KINDS.has(ctx.windowKind)) return "deniedRole";
    if (ctx.incomplete) return "incomplete";
    if (ctx.composing) return "composing";
    return null;
  }

  /**
   * A sentence end in the write session's field: the session goes on under the new context, decided `write` now with
   * no model call, so the host's writing help does not wait on a router at the end of every sentence.
   */
  private keepWriting(c: Current): void {
    const w = this.writeSession as NonNullable<typeof this.writeSession>;
    const now = this.deps.now();
    this.writeSession = { ...w, gen: c.gen, at: now, textRevision: c.ctx.textRevision };
    const decision: Decision = {
      gen: c.gen,
      at: now,
      windowId: c.ctx.windowId,
      key: w.key,
      breakpoint: c.breakpoint,
      legal: ["write"],
      outcome: "write",
      failure: null,
      by: "session",
      local: null,
      refused: null,
      route: null,
      consent: null,
      published: true,
      calls: 0,
      latencyMs: now - c.at,
      confidence: null,
      answered: null,
      textRevision: c.ctx.textRevision,
    };
    keep(this.decisions, decision);
    this.stats.sessionKept++;
    bump(this.stats.byOutcome, "write");
    this.deps.count?.("route.session_kept");
    this.deps.onDecision?.(decision);
  }

  /** Starts the waiting context's Router 1 call when the slot is free and the cooldown has passed. */
  private pump(): void {
    const c = this.cur;
    if (this.stoppedAt !== null || c === null || !this.waiting || this.inflight !== null) return;
    const wait = this.lastRouter1At + ROUTER1_COOLDOWN_MS - this.deps.now();
    if (wait > 0) {
      if (this.cancelTimer === null) {
        this.deps.count?.("route.cooldown_wait");
        this.cancelTimer = this.setTimer(() => {
          this.cancelTimer = null;
          this.pump();
        }, wait);
      }
      return;
    }
    this.waiting = false;
    const run = this.decide(c)
      .catch((e: unknown) => {
        if (this.stoppedAt !== null) return;
        this.deps.warn?.(`routing: deciding context ${c.gen} failed: ${e instanceof Error ? e.message : String(e)}`);
        // The host is told, rather than left waiting for a decision that will not come.
        if (!c.decided && c.gen === this.gen) this.finish(c, { outcome: "error", failure: "failed", by: "router1", local: null, refused: null, route: null, confidence: null, answered: null });
      })
      .finally(() => {
        this.inflight = null;
        this.pump();
      });
    this.inflight = run;
  }

  /**
   * Whether `c` is no longer the current context. Its reply is not used, and the context is published as a failed
   * decision (R2 lead decision 1): a host still waiting on it falls back instead of hearing nothing or an abstain.
   */
  private stale(c: Current, by: "router1" | "router2", read: Read<string>): boolean {
    if (c.gen === this.gen) return false;
    this.stats.staleDrops++;
    this.deps.count?.("route.stale_drop");
    this.finish(c, { outcome: "error", failure: "stale", by, local: null, refused: null, route: null, confidence: read.confidence, answered: read.choice }, null, false);
    return true;
  }

  /** A router's answer that was not taken: weak but readable abstains; anything else is a failed decision. */
  private refused(c: Current, router: 1 | 2, read: Read<string> & { ok: false }): void {
    const failure: RouteFailure | null = read.why === "lowConfidence" ? null : read.why;
    this.finish(c, { outcome: failure === null ? "abstain" : "error", failure, by: router === 1 ? "router1" : "router2", local: null, refused: { router, why: read.why }, route: null, confidence: read.confidence, answered: read.choice });
  }

  private async decide(c: Current): Promise<void> {
    let built;
    try {
      built = router1Request(this.deps.model, c.ctx, c.legal, c.reg);
    } catch (e) {
      if (!(e instanceof PrivacyRefusal)) throw e;
      return this.finish(c, { outcome: "abstain", by: "local", local: "privacy", refused: null, route: null, confidence: null, answered: null });
    }
    this.lastRouter1At = this.deps.now();
    c.calls++;
    this.stats.router1Calls++;
    this.deps.count?.("route.router1_call");
    const t0 = this.deps.now();
    const r1 = await sendRouter(this.deps.askJev, built, "outcome", ROUTER1_FLOOR);
    if (this.stoppedAt !== null) return;
    keep(this.stats.callMs, this.deps.now() - t0);
    if (this.stale(c, "router1", r1.read)) return;
    if (!r1.read.ok) return this.refused(c, 1, r1.read);
    const outcome = r1.read.choice;
    const confidence = r1.read.confidence;
    const answered = outcome;
    switch (outcome) {
      case "abstain":
        return this.finish(c, { outcome, by: "router1", local: null, refused: null, route: null, confidence, answered });
      case "write": {
        const f = c.ctx.field;
        if (f !== null) this.writeSession = { gen: c.gen, windowId: c.ctx.windowId, key: f.key, at: this.deps.now(), textRevision: c.ctx.textRevision };
        return this.finish(c, { outcome, by: "router1", local: null, refused: null, route: null, confidence, answered });
      }
      case "ask": {
        const q = c.reg.question as RouteCandidate;
        this.remember(q.id);
        this.finish(c, { outcome, by: "router1", local: null, refused: null, route: q.id, confidence, answered }, q);
        return this.run(q);
      }
      case "act":
        return this.route2(c, confidence);
    }
  }

  private async route2(c: Current, r1Confidence: number): Promise<void> {
    const real = realRoutes(c.reg);
    if (real.length === 0) {
      const h = c.reg.routes[0] as Route;
      return this.finish(c, { outcome: "act", by: "single", local: null, refused: null, route: `handoff: ${h.reason ?? ""}`, confidence: r1Confidence, answered: "act" });
    }
    if (real.length === 1) {
      this.stats.router2Skipped++;
      this.deps.count?.("route.router2_skipped");
      return this.choose(c, real[0] as Route, "single", r1Confidence);
    }
    let built;
    try {
      built = router2Request(this.deps.model, c.ctx, c.reg);
    } catch (e) {
      if (!(e instanceof PrivacyRefusal)) throw e;
      return this.finish(c, { outcome: "abstain", by: "local", local: "privacy", refused: null, route: null, confidence: null, answered: null });
    }
    c.calls++;
    this.stats.router2Calls++;
    this.deps.count?.("route.router2_call");
    const t0 = this.deps.now();
    const r2 = await sendRouter(this.deps.askJev, built, "route", ROUTER2_FLOOR);
    if (this.stoppedAt !== null) return;
    keep(this.stats.callMs, this.deps.now() - t0);
    if (this.stale(c, "router2", r2.read)) return;
    if (!r2.read.ok) return this.refused(c, 2, r2.read);
    const route = c.reg.routes.find((r) => r.option === r2.read.choice) as Route;
    return this.choose(c, route, "router2", r2.read.confidence);
  }

  private choose(c: Current, route: Route, by: "router2" | "single", confidence: number): void {
    if (route.candidate === null) return this.finish(c, { outcome: "act", by, local: null, refused: null, route: `handoff: ${route.reason ?? ""}`, confidence, answered: route.option });
    const cand = route.candidate;
    this.finish(c, { outcome: "act", by, local: null, refused: null, route: routeOf(cand), confidence, answered: by === "single" ? "act" : route.option }, cand);
    this.run(cand);
  }

  private run(cand: RouteCandidate): void {
    try {
      cand.run();
    } catch (e) {
      this.deps.warn?.(`routing: the ${cand.id} route failed to start: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private remember(questionId: string): void {
    if (this.asked.size >= ASKED_KEEP) this.asked.clear();
    this.asked.add(questionId);
  }

  /**
   * Records and publishes `c`'s decision. `release`: held offers the decision did not choose are let go. A stale
   * context's are not: the context that replaced it lists the same held offers and may still choose them.
   */
  private finish(c: Current, d: Pick<Decision, "outcome" | "by" | "local" | "refused" | "route" | "confidence" | "answered"> & { failure?: RouteFailure | null }, chosen: RouteCandidate | null = null, release = true): void {
    c.decided = true;
    const now = this.deps.now();
    const decision: Decision = { gen: c.gen, at: now, windowId: c.ctx.windowId, key: c.ctx.field?.key ?? null, breakpoint: c.breakpoint, legal: c.legal, ...d, failure: d.failure ?? null, consent: null, published: !c.beside, calls: c.calls, latencyMs: now - c.at, textRevision: c.ctx.textRevision };
    keep(this.decisions, decision);
    const s = this.stats;
    bump(c.beside ? s.besideOutcome : s.byOutcome, d.outcome);
    this.deps.count?.(`route.outcome_${d.outcome}`);
    if (d.by === "local") {
      s.avoided++;
      bump(s.byLocal, d.local ?? "?");
      this.deps.count?.(`route.local_${d.local ?? "?"}`);
    } else if (d.failure !== "stale") keep(s.entryMs, decision.latencyMs);
    if (d.refused !== null) {
      bump(s.refused, `router${d.refused.router}_${d.refused.why}`);
      this.deps.count?.(`route.refused${d.refused.router}_${d.refused.why}`);
    }
    if (d.route !== null) {
      const k = d.route.startsWith("handoff") ? "handoff" : d.outcome === "ask" ? "ask" : d.route;
      bump(s.byRoute, k);
      this.deps.count?.(`route.route_${k}`);
    }
    // Held offers this decision did not choose are let go now; another context lists its own.
    if (release) for (const x of c.candidates) if (x !== chosen && x.drop !== undefined) x.drop();
    this.deps.onDecision?.(decision);
  }
}
