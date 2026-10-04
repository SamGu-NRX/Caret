// The two routers (D2-02, action engine v2 section 3). The coordinator's promises each have one right answer and are
// tested alone, with a scripted Jev and a manual clock: one Router 1 call per context, at most one in flight and one
// start per two seconds, stale replies dropped, a waiting context replaced rather than queued, no retry, no Router 2
// outside act, and every forged or weak answer abstaining. Then the helper end to end: routed fills and event cards
// make the same offers, with the same spans, as the producers make on their own. Everything is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { makeJevClient, type AskJev, type JevRequest, type JevResult } from "../src/fill/jev.ts";
import { RoutingCoordinator, ROUTER1_COOLDOWN_MS, type Decision } from "../src/routing/coordinator.ts";
import { ASK_ROUTES, freeze, HANDOFF_OVERFLOW, MAX_WORKFLOWS, type RouteCandidate } from "../src/routing/routes.ts";
import { boundary, breakpoint, contextNow } from "../src/routing/context.ts";
import { ROUTES } from "../src/planner/intent.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { MemoryStore } from "../src/patterns/memory.ts";
import { FakeCalendar } from "../src/executor/means.ts";
import { HelperMessage, PROTOCOL_VERSION, type AppRef, type FillProposal, type Node, type OfferAction, type OfferPopup, type ReaderMessage, type TypedValue } from "../src/protocol.ts";
import { field, focus, jevPickingText, MAIL_APP, snap, text } from "./builders.ts";

type Answer = { choice: string; confidence: number };
const result = (answers: Record<string, Answer>): JevResult => ({ model: "jev-test", answers, inputTokens: 120, latencyMs: 5, costUsd: 120 * 0.042e-6 });
const isRouter = (r: JevRequest): boolean => "outcome" in r.questions || "route" in r.questions;

/** Answers the routers by script and passes every other question to `other`; can hold router replies to test what arrives late. */
class RouterJev {
  readonly requests: JevRequest[] = [];
  /** null answers nothing for the question. */
  router1: (req: JevRequest) => Answer | Error | null = () => ({ choice: "abstain", confidence: 0.9 });
  router2: (req: JevRequest) => Answer | Error = () => ({ choice: "r1", confidence: 0.9 });
  other: AskJev | null = null;
  holding = false;
  readonly held: { req: JevRequest; go: () => void }[] = [];

  readonly ask: AskJev = (req) => {
    this.requests.push(req);
    const make = (): Promise<JevResult> => {
      const which = "outcome" in req.questions ? "outcome" : "route" in req.questions ? "route" : null;
      if (which === null) return this.other === null ? Promise.reject(new Error("an unexpected question")) : this.other(req);
      const a = which === "outcome" ? this.router1(req) : this.router2(req);
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(result(a === null ? {} : { [which]: a }));
    };
    if (!this.holding || !isRouter(req)) return make();
    return new Promise((res, rej) => this.held.push({ req, go: () => void make().then(res, rej) }));
  };

  routerCalls(q?: "outcome" | "route"): JevRequest[] {
    return this.requests.filter((r) => (q === undefined ? isRouter(r) : q in r.questions));
  }

  /** Lets the oldest held reply arrive. */
  release(): void {
    const h = this.held.shift();
    if (h === undefined) throw new Error("no held reply");
    h.go();
  }
}

class Clock {
  at = 1_000_000;
  private readonly due: { at: number; fn: () => void; live: boolean }[] = [];
  readonly setTimer = (fn: () => void, ms: number): (() => void) => {
    const t = { at: this.at + ms, fn, live: true };
    this.due.push(t);
    return () => {
      t.live = false;
    };
  };
  advance(ms: number): void {
    const end = this.at + ms;
    for (;;) {
      const next = this.due.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (next === undefined) break;
      this.at = Math.max(this.at, next.at);
      next.live = false;
      next.fn();
    }
    this.at = end;
  }
}

const NOTES: AppRef = { pid: 4242, bundleId: "dev.caret.notes", name: "Notes Fixture" };
const NOTE = "4242-1";
const BODY = (n: number): string => `dev.caret.notes/standard/textarea:body~${n}`;

type TestCandidate = RouteCandidate & { ran: number; dropped: number };
function candidate(id: string, extra: Partial<RouteCandidate> = {}): TestCandidate {
  const c: TestCandidate = {
    id,
    kind: "workflow",
    workflow: "event",
    says: `Do ${id}`,
    plain: `Do ${id}`,
    quotes: [],
    relevance: 0,
    ran: 0,
    dropped: 0,
    run: () => {
      c.ran++;
    },
    drop: () => {
      c.dropped++;
    },
    ...extra,
  };
  return c;
}

describe("the routing coordinator", () => {
  let model: ScreenModel;
  let clock: Clock;
  let jev: RouterJev;
  let coord: RoutingCoordinator;
  let cands: TestCandidate[];
  let hostWrites: boolean;
  let paused: boolean;
  let decisions: Decision[];

  /** The notes window with three body fields; the user is in `focused`, whose text is `value`. */
  const show = (value: string, focused = 0, extra: Partial<Node> = {}): void => {
    const nodes: Node[] = [0, 1, 2].map((n) => ({ key: BODY(n), parent: null, role: "AXTextArea", label: `Body ${n}`, editable: true, ...(n === focused && value !== "" ? { value } : {}), ...(n === focused ? extra : {}) }));
    model.apply(snap(nodes, { at: clock.at, windowId: NOTE, app: NOTES, focused: true, focusedKey: BODY(focused), title: "Notes" }));
    model.frontmostPid = NOTES.pid;
    coord.onFocus({ windowId: NOTE, key: BODY(focused), role: extra.role ?? "AXTextArea", editable: true });
    coord.observe();
  };

  beforeEach(() => {
    model = new ScreenModel();
    clock = new Clock();
    jev = new RouterJev();
    cands = [];
    hostWrites = true;
    paused = false;
    decisions = [];
    coord = new RoutingCoordinator({
      model,
      askJev: jev.ask,
      candidates: () => cands,
      hostWrites: () => hostWrites,
      wordsOn: () => true,
      paused: () => paused,
      live: () => true,
      readerSession: () => 1,
      now: () => clock.at,
      setTimer: clock.setTimer,
      onDecision: (d) => decisions.push(d),
    });
  });

  it("asks Router 1 once per context: typing inside a sentence keeps the context, finishing one opens a new decision", async () => {
    jev.router1 = () => ({ choice: "write", confidence: 0.9 });
    for (const v of ["D", "De", "Dear", "Dear Dana, the", "Dear Dana, the deck is"]) show(v);
    await coord.idle();
    expect(jev.routerCalls()).toHaveLength(1);
    expect(coord.stats.sameContext).toBe(4);
    expect(coord.writing).toEqual({ windowId: NOTE, key: BODY(0) });
    clock.advance(ROUTER1_COOLDOWN_MS);
    show("Dear Dana, the deck is ready. ");
    await coord.idle();
    expect(jev.routerCalls()).toHaveLength(2);
    expect(decisions.map((d) => [d.breakpoint, d.outcome, d.calls])).toEqual([
      ["reader", "write", 1],
      ["sentence", "write", 1],
    ]);
    // Every decision carries the text revision it was made on; typing changes the revision, not the context.
    expect(decisions[0]?.textRevision).not.toBe(decisions[1]?.textRevision);
  });

  it("drops a reply for a context that is no longer current, and replaces a waiting context instead of queueing it", async () => {
    jev.holding = true;
    jev.router1 = () => ({ choice: "write", confidence: 0.95 });
    show("A first note", 0);
    expect(jev.routerCalls()).toHaveLength(1);
    clock.advance(100);
    show("", 1);
    clock.advance(100);
    show("", 2);
    expect(jev.routerCalls()).toHaveLength(1);
    jev.release();
    await coord.idle();
    expect(coord.stats.staleDrops).toBe(1);
    expect(coord.stats.replaced).toBe(1);
    expect(coord.writing).toBeNull();
    // The newest context waits out the cooldown from the first call's start, then gets its own call.
    clock.advance(ROUTER1_COOLDOWN_MS - 201);
    expect(jev.routerCalls()).toHaveLength(1);
    clock.advance(1);
    expect(jev.routerCalls()).toHaveLength(2);
    jev.release();
    await coord.idle();
    expect(decisions.map((d) => [d.outcome, d.calls])).toEqual([["write", 1]]);
    expect(coord.writing).toEqual({ windowId: NOTE, key: BODY(2) });
  });

  it("starts Router 1 at most once per two seconds, however the context changes", async () => {
    show("One. ", 0);
    await coord.idle();
    clock.advance(500);
    show("Two. ", 1);
    await coord.idle();
    expect(jev.routerCalls()).toHaveLength(1);
    clock.advance(ROUTER1_COOLDOWN_MS - 501);
    expect(jev.routerCalls()).toHaveLength(1);
    clock.advance(1);
    await coord.idle();
    expect(jev.routerCalls()).toHaveLength(2);
  });

  it("calls Router 2 only after act, and skips it when one real route is listed", async () => {
    const a = candidate("a");
    const b = candidate("b", { kind: "fillAll", workflow: undefined });
    const q = candidate("q", { question: { fact: "eventStart", says: "which time" } });
    cands = [a, b, q];
    for (const [outcome, at] of [["abstain", 1], ["write", 2], ["ask", 0]] as const) {
      jev.router1 = () => ({ choice: outcome, confidence: 0.9 });
      clock.advance(ROUTER1_COOLDOWN_MS);
      show("", at);
      await coord.idle();
    }
    expect(jev.routerCalls("route")).toHaveLength(0);
    expect([a.ran, b.ran, q.ran]).toEqual([0, 0, 1]);
    // An asked question is not asked again in a later context.
    jev.router1 = (req) => {
      const crit = (req.questions.outcome as { criteria: Record<string, string> }).criteria;
      expect(Object.keys(crit)).toEqual(["abstain", "write", "act"]);
      return { choice: "act", confidence: 0.9 };
    };
    jev.router2 = () => ({ choice: "r2", confidence: 0.8 });
    clock.advance(ROUTER1_COOLDOWN_MS);
    show("", 1);
    await coord.idle();
    expect(jev.routerCalls("route")).toHaveLength(1);
    expect([a.ran, b.ran]).toEqual([0, 1]);
    // The candidate not chosen is let go; the chosen one is not.
    expect([a.dropped, b.dropped]).toEqual([4, 3]);
    // One real route: Router 1's act is enough.
    cands = [candidate("only")];
    clock.advance(ROUTER1_COOLDOWN_MS);
    show("", 2);
    await coord.idle();
    expect(jev.routerCalls("route")).toHaveLength(1);
    expect(cands[0]?.ran).toBe(1);
    expect(coord.stats.router2Skipped).toBe(1);
  });

  it("never retries: a failed request abstains after exactly one call, and the same context asks no more", async () => {
    cands = [candidate("a")];
    jev.router1 = () => new Error("Jev HTTP 503");
    show("Hello");
    await coord.idle();
    show("Hello there");
    clock.advance(10 * ROUTER1_COOLDOWN_MS);
    await coord.idle();
    expect(jev.routerCalls()).toHaveLength(1);
    expect(decisions.map((d) => [d.outcome, d.refused])).toEqual([["abstain", { router: 1, why: "failed" }]]);
    expect(cands[0]?.ran).toBe(0);
  });

  it("rejects forged, nonfinite, missing and weak answers from either router", async () => {
    const cases: { r1: Answer | null; r2?: Answer; why: string }[] = [
      { r1: { choice: "launch", confidence: 0.99 }, why: "router1_forged" },
      { r1: { choice: "act", confidence: Number.NaN }, why: "router1_nonfinite" },
      { r1: { choice: "act", confidence: 1.5 }, why: "router1_nonfinite" },
      { r1: { choice: "act", confidence: 0.74 }, why: "router1_lowConfidence" },
      { r1: null, why: "router1_missing" },
      { r1: { choice: "act", confidence: 0.9 }, r2: { choice: "r9", confidence: 0.99 }, why: "router2_forged" },
      { r1: { choice: "act", confidence: 0.9 }, r2: { choice: "handoff ", confidence: 0.99 }, why: "router2_forged" },
      { r1: { choice: "act", confidence: 0.9 }, r2: { choice: "r1", confidence: 0.5 }, why: "router2_lowConfidence" },
    ];
    const a = candidate("a");
    const b = candidate("b");
    cands = [a, b];
    let i = 0;
    for (const c of cases) {
      jev.router1 = () => c.r1;
      jev.router2 = () => c.r2 ?? { choice: "r1", confidence: 0.9 };
      clock.advance(ROUTER1_COOLDOWN_MS);
      show(`case ${i++}`, i % 3);
      await coord.idle();
    }
    expect(Object.entries(coord.stats.refused).sort()).toEqual(
      Object.entries({ router1_forged: 1, router1_nonfinite: 2, router1_lowConfidence: 1, router1_missing: 1, router2_forged: 2, router2_lowConfidence: 1 }).sort(),
    );
    expect(a.ran + b.ran).toBe(0);
    expect(decisions.every((d) => d.outcome === "abstain")).toBe(true);
    // An outcome that is a real word but not legal now is forged too: write with no host to take it.
    hostWrites = false;
    jev.router1 = () => ({ choice: "write", confidence: 0.99 });
    clock.advance(ROUTER1_COOLDOWN_MS);
    show("again", 0);
    await coord.idle();
    expect(decisions.at(-1)?.refused).toEqual({ router: 1, why: "forged" });
    expect(coord.writing).toBeNull();
  });

  it("abstains without a model call on each local rule", async () => {
    cands = [candidate("a")];
    const local = (): string | null => decisions.at(-1)?.local ?? null;
    paused = true;
    show("p", 0);
    expect(local()).toBe("paused");
    paused = false;
    show("", 1, { role: "AXSecureTextField" });
    expect(local()).toBe("secure");
    show("", 2, { states: ["secure"] });
    expect(local()).toBe("secure");
    show("", 0, { role: "AXSearchField" });
    expect(local()).toBe("deniedRole");
    coord.hostEditing({ windowId: NOTE, key: BODY(1), selection: "caret", composing: true });
    show("に", 1);
    expect(local()).toBe("composing");
    coord.hostEditing(null);
    // The reader reported focus in a field its last walk did not hold.
    coord.onFocus({ windowId: NOTE, key: "dev.caret.notes/standard/textarea:missing~0", role: "AXTextArea", editable: true });
    coord.observe();
    expect(local()).toBe("incomplete");
    cands = [];
    hostWrites = false;
    show("Nothing to do here.", 2);
    expect(local()).toBe("noCapability");
    expect(jev.requests).toHaveLength(0);
    expect(coord.stats.avoided).toBe(7);
  });

  it("refuses a request the privacy budget will not carry, before any call", async () => {
    // A conversation gives less than half its text; a field whose label is most of that text cannot go out.
    const chat: AppRef = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };
    model.apply(snap([{ key: "m/textarea:reply~0", parent: null, role: "AXTextArea", label: "Reply to Dana Whitfield about the Thursday offsite plan", editable: true }], { at: clock.at, windowId: "7373-1", app: chat, focused: true, focusedKey: "m/textarea:reply~0", title: "Dana" }));
    model.frontmostPid = chat.pid;
    cands = [candidate("a")];
    coord.onFocus({ windowId: "7373-1", key: "m/textarea:reply~0", role: "AXTextArea", editable: true });
    coord.observe();
    await coord.idle();
    expect(jev.requests).toHaveLength(0);
    expect(decisions.at(-1)?.local).toBe("privacy");
  });

  it("selection, settings, memory and candidates are breakpoints; the same text revision is not", () => {
    const base = { model, focus: null, host: null, readerSession: 1, memoryRevision: 0, settingsRevision: 0, candidates: [] };
    show("Hi. Then", 0);
    const a = contextNow(base);
    expect(a?.sentences).toBe(1);
    expect(breakpoint(a, contextNow(base) as NonNullable<typeof a>)).toBeNull();
    expect(breakpoint(a, contextNow({ ...base, host: { windowId: NOTE, key: BODY(0), selection: "range", composing: false } }) as NonNullable<typeof a>)).toBe("selection");
    expect(breakpoint(a, contextNow({ ...base, settingsRevision: 1 }) as NonNullable<typeof a>)).toBe("settings");
    expect(breakpoint(a, contextNow({ ...base, memoryRevision: 1 }) as NonNullable<typeof a>)).toBe("memory");
    expect(breakpoint(a, contextNow({ ...base, candidates: ["fillAll"] }) as NonNullable<typeof a>)).toBe("candidates");
    expect(boundary("One. Two! Three")).toEqual({ sentences: 2, paragraphs: 0 });
    expect(boundary("One.\n\nTwo.\n")).toEqual({ sentences: 2, paragraphs: 2 });
  });
});

describe("the route registry", () => {
  const c = (id: string, extra: Partial<RouteCandidate> = {}): RouteCandidate => candidate(id, extra);

  it("lists up to eight workflows by relevance, then fillAll, then handoff, with code-assigned option ids", () => {
    const ws = Array.from({ length: MAX_WORKFLOWS }, (_, i) => c(`w${i}`, { relevance: i }));
    const r = freeze(1, [...ws, c("fill", { kind: "fillAll", workflow: undefined })], new Set());
    expect(r.routes.map((x) => [x.option, x.candidate?.id ?? x.kind])).toEqual([...ws.map((_, i) => [`r${i + 1}`, `w${MAX_WORKFLOWS - 1 - i}`]), ["r9", "fill"], ["handoff", "handoff"]]);
    expect(r.routes.length).toBeLessThanOrEqual(11);
  });

  it("turns more workflows than it can list into a handoff that says so, never a silent cut", () => {
    const r = freeze(1, Array.from({ length: MAX_WORKFLOWS + 1 }, (_, i) => c(`w${i}`)), new Set());
    expect(r.overflow).toBe(1);
    expect(r.routes.map((x) => [x.kind, x.reason])).toEqual([["handoff", HANDOFF_OVERFLOW]]);
  });

  it("keeps a candidate that needs a fact out of the act routes, and asks each question once", () => {
    const q = c("q", { question: { fact: "eventStart", says: "which time" } });
    expect(freeze(1, [q], new Set()).question?.id).toBe("q");
    expect(freeze(1, [q], new Set()).routes).toEqual([]);
    expect(freeze(2, [q], new Set(["q"])).question).toBeNull();
  });

  it("maps every B25 Ask route onto Router 2's words", () => {
    expect(Object.keys(ASK_ROUTES).sort()).toEqual([...ROUTES].sort());
    expect(ROUTES.map((r) => ASK_ROUTES[r])).toEqual([{ outcome: "act", kind: "fillAll" }, { outcome: "act", kind: "goalPlan" }, { outcome: "ask" }, { outcome: "act", kind: "handoff" }]);
  });
});

describe("the Jev client's retry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("waits out one 429 by default and never when the request says no retry", async () => {
    const fetches: number[] = [];
    vi.stubGlobal("fetch", async () => {
      fetches.push(1);
      return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    });
    const client = makeJevClient(() => "test-key");
    const req: JevRequest = { state: "s", questions: { q: { type: "choice", instructions: "i", criteria: { a: "A" } } }, snippets: [], charged: {} };
    await expect(client({ ...req, retry429: false })).rejects.toThrow(/429/);
    expect(fetches).toHaveLength(1);
    await expect(client(req)).rejects.toThrow(/429/);
    expect(fetches).toHaveLength(3);
  });
});

// MARK: - the helper, routed

const SRC = "6160-1";
const FORM = "5150-1";
const EMAIL = "dev.caret.fixture/standard/textfield:email~0";
const VALUE = "dana.whitfield@example.com";
const T0 = Date.parse("2026-10-05T10:00:00-05:00");

describe("the helper with routing on", () => {
  let dir: string;
  let store: Store;
  let memory: MemoryStore;
  let sent: HelperMessage[];
  let clock: Clock;
  let jev: RouterJev;

  const make = (routed: boolean, hostWrites = false, extra: Partial<ConstructorParameters<typeof Helper>[0]> = {}): Helper =>
    new Helper({
      store,
      memory,
      askJev: jev.ask,
      shadow: false,
      allowBackgroundFocus: false,
      publish: (m) => sent.push(m),
      now: () => clock.at,
      newId: () => "fixed",
      routing: routed ? { setTimer: clock.setTimer, hostWrites: () => hostWrites } : null,
      readerLink: { run: async () => ({ type: "verbResult", v: PROTOCOL_VERSION, id: "x", at: clock.at, outcome: "ok", detail: null }) },
      ...extra,
    });
  const settle = async (h: Helper): Promise<void> => {
    await h.routing?.idle();
    await h.routedSettled;
    await h.eventsSettled;
  };

  let zone: string | undefined;
  beforeAll(() => {
    zone = process.env.TZ;
    process.env.TZ = "America/Chicago";
  });
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-routing-"));
    store = new Store(join(dir, "data"));
    memory = new MemoryStore(join(dir, "data"));
    sent = [];
    clock = new Clock();
    clock.at = T0;
    jev = new RouterJev();
  });
  afterEach(() => {
    for (const m of sent) HelperMessage.parse(m);
    memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A mail with Dana's address, then the claim form with focus in its empty Email field. */
  const formWithSource = async (h: Helper): Promise<void> => {
    void h.handleReader(snap([text("m/statictext:sig~0", `Dana Whitfield\n${VALUE}`)], { at: clock.at - 5000, windowId: SRC, app: MAIL_APP, title: "Signature" }));
    void h.handleReader(snap([field(EMAIL, "", { label: "Email", frame: [100, 40, 200, 24] })], { at: clock.at, windowId: FORM, title: "Claim form", focused: true, focusedKey: EMAIL }));
    await h.handleReader(focus(FORM, EMAIL, clock.at));
    await settle(h);
  };

  it("routes a focus in a form with its source open to fill with one Router 1 call, and offers exactly what fill offers on its own", async () => {
    jev.other = jevPickingText(() => VALUE);
    jev.router1 = () => ({ choice: "act", confidence: 0.9 });
    const direct = make(false);
    await formWithSource(direct);
    const unrouted = sent.filter((m) => m.type === "popup" || m.type === "fillProposal");
    expect(unrouted).toHaveLength(1);
    expect(jev.routerCalls()).toHaveLength(0);
    direct.memory.close();

    sent = [];
    memory = new MemoryStore(join(dir, "data2"));
    const routed = make(true);
    await formWithSource(routed);
    const offered = sent.filter((m) => m.type === "popup" || m.type === "fillProposal");
    // The same offer, value and source span, as the unrouted fill made.
    expect(offered).toEqual(unrouted);
    expect(JSON.stringify(offered)).toContain(VALUE);
    expect(jev.routerCalls("outcome")).toHaveLength(1);
    expect(jev.routerCalls("route")).toHaveLength(0);
    const crit = (jev.routerCalls("outcome")[0]?.questions.outcome as { criteria: Record<string, string> }).criteria;
    expect(Object.keys(crit)).toEqual(["abstain", "act"]);
    expect(routed.routing?.decisions.map((d) => [d.outcome, d.by, d.route])).toEqual([["act", "single", "fillAll"]]);
  });

  it("makes no fill and no further call when Router 1 abstains", async () => {
    jev.other = jevPickingText(() => VALUE);
    jev.router1 = () => ({ choice: "abstain", confidence: 0.9 });
    const h = make(true);
    await formWithSource(h);
    expect(sent.filter((m) => m.type === "popup" || m.type === "fillProposal")).toEqual([]);
    expect(jev.requests).toHaveLength(1);
  });

  const NOTES_DOC = "4242-1";
  const DOC = "dev.caret.notes/standard/textarea:body~0";
  const typeDoc = async (h: Helper, value: string, values: TypedValue[] = []): Promise<void> => {
    clock.advance(ROUTER1_COOLDOWN_MS);
    void h.handleReader(snap([{ key: DOC, parent: null, role: "AXTextArea", label: "Body", editable: true, ...(value === "" ? {} : { value }) }], { at: clock.at, windowId: NOTES_DOC, app: NOTES, title: "Plans", focused: true, focusedKey: DOC, values }));
    await settle(h);
  };

  it("asks nothing in a document while no host takes write decisions, and decides write once per context when one does", async () => {
    const quiet = make(true);
    void quiet.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: clock.at, from: null, to: NOTES });
    await typeDoc(quiet, "Notes for the review. We should");
    expect(jev.requests).toHaveLength(0);
    expect(quiet.routing?.decisions.at(-1)?.local).toBe("noCapability");
    quiet.memory.close();

    memory = new MemoryStore(join(dir, "data2"));
    jev.router1 = () => ({ choice: "write", confidence: 0.9 });
    const h = make(true, true);
    void h.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: clock.at, from: null, to: NOTES });
    await typeDoc(h, "Notes for the review. We should");
    await typeDoc(h, "Notes for the review. We should move");
    await typeDoc(h, "Notes for the review. We should move it");
    expect(jev.routerCalls()).toHaveLength(1);
    expect(h.routing?.writing).toEqual({ windowId: NOTES_DOC, key: DOC });
    await typeDoc(h, "Notes for the review. We should move it. ");
    expect(jev.routerCalls()).toHaveLength(2);
  });

  it("routes a finished sentence with a person and a time to the event card, which quotes the exact sentence", async () => {
    const sentence = "Lunch with Priya tomorrow at noon.";
    jev.router1 = () => ({ choice: "act", confidence: 0.9 });
    const attend: string[] = [];
    jev.other = async (req) => {
      attend.push((req.state as { sentence: string }).sentence);
      return result({ attend: { choice: "yes", confidence: 0.9 } });
    };
    const h = make(true, false, { calendar: new FakeCalendar() });
    void h.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: clock.at, from: null, to: NOTES });
    const prefix = "Plans for the week. ";
    await typeDoc(h, `${prefix}${sentence} Then`, [{ kind: "date", text: "tomorrow at noon", nodeKey: DOC }]);
    const cards = sent.filter((m): m is OfferAction => m.type === "action" && m.app === "Calendar");
    expect(cards).toHaveLength(1);
    expect(attend).toEqual([sentence, sentence]);
    // The span the card quotes is the exact slice of the field's text, unchanged by routing.
    const quote = JSON.stringify(cards[0]?.endState.ref);
    expect(quote).toContain(JSON.stringify(sentence));
    expect(`${prefix}${sentence} Then`.slice(prefix.length, prefix.length + sentence.length)).toBe(sentence);
    // Router 1 saw the sentence as a quoted, declared snippet.
    const r1 = jev.routerCalls("outcome").at(-1) as JevRequest;
    expect(r1.snippets.some((x) => x.windowId === NOTES_DOC && x.text === sentence)).toBe(true);
    expect(h.routing?.decisions.at(-1)).toMatchObject({ outcome: "act", route: "workflow:event" });
  });

  it("asks the event's start as the one question when the sentence leaves it open", async () => {
    // IST is India, Ireland or Israel: two starts, so the card asks which (event-time.ts).
    const sentence = "Call with Dana Friday 3pm to 4pm IST.";
    jev.router1 = (req) => {
      const crit = (req.questions.outcome as { criteria: Record<string, string> }).criteria;
      expect(Object.keys(crit)).toEqual(["abstain", "ask"]);
      return { choice: "ask", confidence: 0.9 };
    };
    jev.other = async () => result({ attend: { choice: "yes", confidence: 0.9 } });
    const h = make(true, false, { calendar: new FakeCalendar() });
    void h.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: clock.at, from: null, to: NOTES });
    await typeDoc(h, `${sentence} `, [{ kind: "date", text: "Friday 3pm to 4pm IST", nodeKey: DOC }]);
    const cards = sent.filter((m): m is OfferAction => m.type === "action" && m.app === "Calendar");
    expect(cards).toHaveLength(1);
    expect((cards[0]?.variants as OfferPopup["spec"] | undefined)?.figure).toBe("needsYou");
    expect(h.routing?.decisions.at(-1)).toMatchObject({ outcome: "ask" });
    // Asked once: the same sentence in a later context is not asked again.
    await typeDoc(h, `${sentence} Ok. `, [{ kind: "date", text: "Friday 3pm to 4pm IST", nodeKey: DOC }]);
    expect(jev.routerCalls("outcome")).toHaveLength(1);
  });

  it("holds a loop's offer until the router chooses it, and logs a held offer it did not choose", async () => {
    const { Desk, roster, grid, cellKey, PEOPLE } = await import("./scene.ts");
    for (const choose of [true, false]) {
      sent = [];
      jev = new RouterJev();
      jev.router1 = () => ({ choice: choose ? "act" : "abstain", confidence: 0.9 });
      const desk = new Desk();
      memory.close();
      memory = new MemoryStore(join(dir, `data-${String(choose)}`));
      const h = new Helper({ store, memory, askJev: jev.ask, shadow: false, allowBackgroundFocus: false, publish: (m) => sent.push(m), readerLink: desk, routing: { setTimer: clock.setTimer } });
      desk.attach(h);
      const dst = grid();
      const src = roster();
      desk.showList(src);
      desk.advance(1000);
      desk.showGrid(dst);
      desk.fill(dst, 0, 0, src.lines[0] as string);
      desk.fill(dst, 1, 0, src.lines[1] as string);
      await new Promise((r) => setImmediate(r));
      await h.routing?.idle();
      const offers = sent.filter((m) => m.type === "patternOffer");
      if (choose) {
        expect(offers.map((o) => o.type === "patternOffer" && o.cells.map((c) => [c.key, c.value]))).toEqual([[[cellKey(dst, 2, 0), PEOPLE[2]]]]);
        expect(h.routing?.decisions.at(-1)).toMatchObject({ outcome: "act", route: "workflow:loop" });
      } else {
        expect(offers).toEqual([]);
        expect(h.memory.decisions().some((d) => d.offerKind === "loopNext" && d.reasons.includes("routedOut"))).toBe(true);
      }
    }
  });
});
