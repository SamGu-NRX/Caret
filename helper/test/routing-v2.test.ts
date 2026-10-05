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
import { ConsentLedger, type ConsentClaim } from "../src/routing/consent.ts";
import { ROUTES } from "../src/planner/intent.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { MemoryStore } from "../src/patterns/memory.ts";
import { FakeCalendar } from "../src/executor/means.ts";
import { HelperMessage, PROTOCOL_VERSION, type AppRef, type FillProposal, type Node, type OfferAction, type OfferPopup, type ReaderMessage, type TypedValue } from "../src/protocol.ts";
import { field, focus, jevPickingText, MAIL_APP, snap, text, value } from "./builders.ts";

type Answer = { choice: string; confidence: number };
const result = (answers: Record<string, Answer>): JevResult => ({ model: "jev-test", answers, inputTokens: 120, latencyMs: 5, costUsd: 120 * 0.042e-6 });
const isRouter = (r: JevRequest): boolean => "outcome" in r.questions || "task" in r.questions || "route" in r.questions;

/** Answers the routers by script and passes every other question to `other`; can hold router replies to test what arrives late. */
class RouterJev {
  readonly requests: JevRequest[] = [];
  /** null answers nothing for the question. */
  router1: (req: JevRequest) => Answer | Error | null = () => ({ choice: "abstain", confidence: 0.9 });
  /** Router 1's task question, asked beside or instead of its outcome question. */
  task: (req: JevRequest) => Answer | Error | null = () => ({ choice: "abstain", confidence: 0.9 });
  router2: (req: JevRequest) => Answer | Error = () => ({ choice: "r1", confidence: 0.9 });
  other: AskJev | null = null;
  holding = false;
  readonly held: { req: JevRequest; go: () => void }[] = [];

  readonly ask: AskJev = (req) => {
    this.requests.push(req);
    const make = (): Promise<JevResult> => {
      if (!isRouter(req)) return this.other === null ? Promise.reject(new Error("an unexpected question")) : this.other(req);
      const answers: Record<string, Answer> = {};
      for (const q of ["outcome", "task", "route"] as const) {
        if (!(q in req.questions)) continue;
        const a = q === "outcome" ? this.router1(req) : q === "task" ? this.task(req) : this.router2(req);
        if (a instanceof Error) return Promise.reject(a);
        if (a !== null) answers[q] = a;
      }
      return Promise.resolve(result(answers));
    };
    if (!this.holding || !isRouter(req)) return make();
    return new Promise((res, rej) => this.held.push({ req, go: () => void make().then(res, rej) }));
  };

  routerCalls(q?: "outcome" | "task" | "route"): JevRequest[] {
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
  /** Held offers the "helper" builds with the record each rests on, as Helper.consentedCandidates does. */
  let bound: { cand: TestCandidate; claim: ConsentClaim }[];
  /** Write sessions the coordinator ended, as onWriteEnded reports them to the host. */
  let ended: { key: string; textRevision: string; why: string }[];

  /** The notes window with three body fields; the user is in `focused`, whose text is `value`. */
  const show = (value: string, focused = 0, extra: Partial<Node> = {}): void => {
    const nodes: Node[] = [0, 1, 2].map((n) => ({ key: BODY(n), parent: null, role: "AXTextArea", label: `Body ${n}`, editable: true, ...(n === focused && value !== "" ? { value } : {}), ...(n === focused ? extra : {}) }));
    model.apply(snap(nodes, { at: clock.at, windowId: NOTE, app: NOTES, focused: true, focusedKey: BODY(focused), title: "Notes" }));
    model.frontmostPid = NOTES.pid;
    coord.onFocus({ windowId: NOTE, key: BODY(focused), role: extra.role ?? "AXTextArea", editable: true });
    coord.observe();
  };

  /** A coordinator over this test's state; `consent` is the ledger it asks, as the helper wires ConsentLedger.verify. */
  const makeCoord = (ledger?: ConsentLedger): RoutingCoordinator =>
    new RoutingCoordinator({
      model,
      askJev: jev.ask,
      candidates: () => cands,
      ...(ledger === undefined
        ? {}
        : {
            consented: () =>
              bound.flatMap((b) => {
                const consent = ledger.verify(b.claim);
                return consent === null ? [] : [{ cand: b.cand, consent }];
              }),
          }),
      onWriteEnded: (w) => ended.push({ key: w.key, textRevision: w.textRevision, why: w.why }),
      hostWrites: () => hostWrites,
      wordsOn: () => true,
      paused: () => paused,
      live: () => true,
      readerSession: () => 1,
      now: () => clock.at,
      setTimer: clock.setTimer,
      onDecision: (d) => decisions.push(d),
    });

  beforeEach(() => {
    model = new ScreenModel();
    clock = new Clock();
    jev = new RouterJev();
    cands = [];
    hostWrites = true;
    paused = false;
    decisions = [];
    bound = [];
    ended = [];
    coord = makeCoord();
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
    // The sentence end opens a context, which the write session decides with no call (R2 decision 3).
    expect(jev.routerCalls()).toHaveLength(1);
    expect(decisions.map((d) => [d.breakpoint, d.outcome, d.by, d.calls])).toEqual([
      ["reader", "write", "router1", 1],
      ["sentence", "write", "session", 0],
    ]);
    // Every decision carries the text revision it was made on; typing changes the revision, not the context.
    expect(decisions[0]?.textRevision).not.toBe(decisions[1]?.textRevision);
  });

  describe("a write session across sentence ends (R2 decision 3)", () => {
    const event = (): TestCandidate => candidate("event:1", { says: "Add to Calendar the lunch with Priya" });
    const writing = async (): Promise<void> => {
      jev.router1 = () => ({ choice: "write", confidence: 0.9 });
      show("Dear Dana, the deck");
      await coord.idle();
      expect(coord.writing).toEqual({ windowId: NOTE, key: BODY(0) });
      decisions.length = 0;
      jev.requests.length = 0;
    };

    it("decides write at once at a sentence end in the same field, before any router answers, and checks only tasks beside it", async () => {
      await writing();
      const ev = event();
      cands = [ev];
      jev.holding = true;
      jev.router1 = () => ({ choice: "act", confidence: 0.8 });
      clock.advance(ROUTER1_COOLDOWN_MS);
      show("Dear Dana, the deck is ready. Lunch with Priya tomorrow at noon. ");
      // The write decision is already out, with no call answered and no time passed.
      expect(decisions.map((d) => [d.outcome, d.by, d.published, d.latencyMs])).toEqual([["write", "session", true, 0]]);
      expect(coord.writing).toEqual({ windowId: NOTE, key: BODY(0) });
      // The one call is about tasks only: no write, no ask.
      expect(jev.routerCalls()).toHaveLength(1);
      expect(Object.keys((jev.routerCalls()[0]?.questions.outcome as { criteria: Record<string, string> }).criteria)).toEqual(["abstain", "act"]);
      jev.release();
      await coord.idle();
      expect(ev.ran).toBe(1);
      // The task is offered beside the writing help: its decision is logged, not sent as the context's.
      expect(decisions.map((d) => [d.outcome, d.by, d.published])).toEqual([
        ["write", "session", true],
        ["act", "single", false],
      ]);
      expect(coord.writing).toEqual({ windowId: NOTE, key: BODY(0) });
      expect(coord.stats.besideOutcome).toEqual({ act: 1 });
    });

    it("ends a session in its own field under the host's latest text revision, so the host takes the end (review)", async () => {
      coord.hostEditing({ windowId: NOTE, key: BODY(0), selection: "caret", composing: false, textRevision: "r52" });
      await writing();
      clock.advance(ROUTER1_COOLDOWN_MS);
      coord.hostEditing({ windowId: NOTE, key: BODY(0), selection: "range", composing: false, textRevision: "r57" });
      coord.observe();
      expect(ended).toEqual([{ key: BODY(0), textRevision: "r57", why: "selection" }]);
      // Focus that moved to another field ends the old field's session under the revision it had.
      ended.length = 0;
      coord.hostEditing({ windowId: NOTE, key: BODY(0), selection: "caret", composing: false, textRevision: "r58" });
      jev.router1 = () => ({ choice: "write", confidence: 0.9 });
      clock.advance(ROUTER1_COOLDOWN_MS);
      coord.observe();
      await coord.idle();
      expect(coord.writing).toEqual({ windowId: NOTE, key: BODY(0) });
      clock.advance(ROUTER1_COOLDOWN_MS);
      show("", 1);
      expect(ended).toEqual([{ key: BODY(0), textRevision: "r58", why: "focus" }]);
    });

    it("ends a session at a reader restart under the latest revision the host reported for its field (verification review)", async () => {
      coord.hostEditing({ windowId: NOTE, key: BODY(0), selection: "caret", composing: false, textRevision: "r52" });
      await writing();
      // The host reports a newer revision with nothing else changed: the same context, no decision.
      coord.hostEditing({ windowId: NOTE, key: BODY(0), selection: "caret", composing: false, textRevision: "r57" });
      coord.observe();
      expect(decisions).toEqual([]);
      coord.readerRestarted();
      expect(ended).toEqual([{ key: BODY(0), textRevision: "r57", why: "reader" }]);
    });

    it("makes no call at a sentence end with no task, and a failed task check leaves the session and publishes nothing", async () => {
      await writing();
      clock.advance(ROUTER1_COOLDOWN_MS);
      show("Dear Dana, the deck is ready. ");
      await coord.idle();
      expect(jev.routerCalls()).toHaveLength(0);
      cands = [event()];
      jev.router1 = () => new Error("Jev HTTP 503");
      clock.advance(ROUTER1_COOLDOWN_MS);
      show("Dear Dana, the deck is ready. See you then. ");
      await coord.idle();
      expect(jev.routerCalls()).toHaveLength(1);
      expect(decisions.map((d) => [d.outcome, d.by, d.published])).toEqual([
        ["write", "session", true],
        ["write", "session", true],
        ["error", "router1", false],
      ]);
      expect(coord.writing).toEqual({ windowId: NOTE, key: BODY(0) });
    });

    it("decides again, ending the session, on a new field, a selection, a composition, candidates without a sentence end, memory or settings", async () => {
      const cases: [string, () => void][] = [
        ["focus", () => show("", 1)],
        ["selection", () => {
          coord.hostEditing({ windowId: NOTE, key: BODY(0), selection: "range", composing: false });
          coord.observe();
        }],
        ["composing", () => {
          coord.hostEditing({ windowId: NOTE, key: BODY(0), selection: "caret", composing: true });
          coord.observe();
        }],
        ["candidates", () => {
          cands = [event()];
          coord.candidatesChanged();
          coord.observe();
        }],
        ["memory", () => {
          coord.memoryChanged();
          coord.observe();
        }],
        // A settings change that lands with a sentence end: the sentence is the first difference, and still not enough.
        ["sentence", () => {
          coord.settingsChanged();
          show("Dear Dana, the deck is ready. ");
        }],
      ];
      for (const [bp, change] of cases) {
        model = new ScreenModel();
        jev = new RouterJev();
        coord = makeCoord();
        cands = [];
        // The host has reported the field, so each case changes one thing from a known selection and composition.
        coord.hostEditing({ windowId: NOTE, key: BODY(0), selection: "caret", composing: false });
        await writing();
        clock.advance(ROUTER1_COOLDOWN_MS);
        change();
        await coord.idle();
        expect(decisions[0], bp).toMatchObject({ breakpoint: bp });
        expect(decisions[0]?.by, bp).not.toBe("session");
        expect(coord.stats.sessionKept, bp).toBe(0);
      }
    });
  });

  describe("a task code checked, asked on its own (R3)", () => {
    /** An event card's candidate as the helper lists it: the facts its code found go to Router 1 as its own question. */
    const checked = (id = "event:1"): TestCandidate =>
      candidate(id, {
        says: 'Add to Calendar "Lunch with Priya tomorrow at noon."',
        evidence: {
          task: "Add an event to the user's calendar",
          sentence: "Lunch with Priya tomorrow at noon.",
          found: 'Code found in it the person "Priya" and the time Tue Oct 6, 12:00 to 1:00 PM; the user typed it in this field.',
          plain: "Code found in it a person and the time Tue Oct 6, 12:00 to 1:00 PM; the user typed it in this field.",
          offerWhen: "Offer it when the user is arranging something they will attend.",
        },
      });
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    };
    const writing = async (): Promise<void> => {
      jev.router1 = () => ({ choice: "write", confidence: 0.9 });
      show("Dear Dana, the deck");
      await coord.idle();
      expect(coord.writing).toEqual({ windowId: NOTE, key: BODY(0) });
      decisions.length = 0;
      jev.requests.length = 0;
    };

    it("asks it beside the outcome in the same call, so writing help and the task can both be chosen", async () => {
      const ev = checked();
      cands = [ev];
      jev.router1 = () => ({ choice: "write", confidence: 0.9 });
      jev.task = () => ({ choice: "act", confidence: 0.8 });
      show("Dear Dana. Lunch with Priya tomorrow at noon. ");
      await coord.idle();
      expect(jev.routerCalls()).toHaveLength(1);
      const r = jev.routerCalls()[0] as JevRequest;
      const q = r.questions as Record<string, { instructions: string; criteria: Record<string, string> }>;
      // The outcome question no longer offers the checked task; the task question is about it alone: the task, its
      // sentence and code's facts in the state, and the producer's rule for when to offer it in the instructions.
      expect(Object.keys(q.outcome?.criteria ?? {})).toEqual(["abstain", "write"]);
      expect(Object.keys(q.task?.criteria ?? {})).toEqual(["abstain", "act"]);
      expect((r.state as Record<string, unknown>).offer).toEqual({ task: "Add an event to the user's calendar", sentence: "Lunch with Priya tomorrow at noon.", found: 'Code found in it the person "Priya" and the time Tue Oct 6, 12:00 to 1:00 PM; the user typed it in this field.' });
      expect(q.task?.instructions).toContain("Offer it when the user is arranging something they will attend.");
      expect(decisions.map((d) => [d.outcome, d.by, d.published, d.route])).toEqual([
        ["write", "router1", true, null],
        ["act", "router1", false, "workflow:event"],
      ]);
      expect(ev.ran).toBe(1);
      expect(ev.dropped).toBe(0);
      expect(coord.writing).toEqual({ windowId: NOTE, key: BODY(0) });
    });

    it("decides act on the task alone when nothing else is legal, and a weak task answer offers nothing", async () => {
      hostWrites = false;
      const ev = checked();
      cands = [ev];
      jev.task = () => ({ choice: "act", confidence: 0.8 });
      show("Lunch with Priya tomorrow at noon. ");
      await coord.idle();
      expect(Object.keys(jev.routerCalls()[0]?.questions ?? {})).toEqual(["task"]);
      expect(decisions.map((d) => [d.outcome, d.by, d.published, d.route])).toEqual([["act", "router1", true, "workflow:event"]]);
      expect(ev.ran).toBe(1);
      const weak = checked("event:2");
      cands = [weak];
      jev.task = () => ({ choice: "act", confidence: 0.3 });
      clock.advance(ROUTER1_COOLDOWN_MS);
      show("", 1);
      await coord.idle();
      expect(decisions.at(-1)).toMatchObject({ outcome: "abstain", by: "router1", published: true, refused: { router: 1, why: "lowConfidence" } });
      expect([weak.ran, weak.dropped]).toEqual([0, 1]);
    });

    it("asks only the task question beside a kept write session", async () => {
      await writing();
      const ev = checked();
      cands = [ev];
      jev.task = () => ({ choice: "act", confidence: 0.8 });
      clock.advance(ROUTER1_COOLDOWN_MS);
      show("Dear Dana, the deck is ready. Lunch with Priya tomorrow at noon. ");
      await coord.idle();
      expect(Object.keys(jev.routerCalls()[0]?.questions ?? {})).toEqual(["task"]);
      expect(decisions.map((d) => [d.outcome, d.by, d.published])).toEqual([
        ["write", "session", true],
        ["act", "router1", false],
      ]);
      expect(ev.ran).toBe(1);
      expect(coord.stats.besideOutcome).toEqual({ act: 1 });
    });

    it("keeps a task answer through the host's report of the same sentence end, and drops it once the sentence is not the last", async () => {
      await writing();
      const ev = checked();
      cands = [ev];
      jev.holding = true;
      jev.task = () => ({ choice: "act", confidence: 0.8 });
      clock.advance(ROUTER1_COOLDOWN_MS);
      // The reader walks the period first; the host's breakpoint for the same sentence end follows.
      show("Dear Dana, the deck is ready. Lunch with Priya tomorrow at noon.");
      coord.hostEditing({ windowId: NOTE, key: BODY(0), selection: "caret", composing: false, textRevision: "h2" }, true);
      coord.observe();
      expect(jev.routerCalls()).toHaveLength(1);
      jev.release();
      await coord.idle();
      expect(ev.ran).toBe(1);
      expect(coord.stats.staleDrops).toBe(0);
      expect(decisions.map((d) => [d.breakpoint, d.outcome, d.by, d.published])).toEqual([
        ["sentence", "write", "session", true],
        ["sentence", "write", "session", true],
        ["sentence", "act", "router1", false],
      ]);
      // A sentence the user finished after it: the task is no longer listed, so its late answer is dropped.
      const later = checked("event:3");
      cands = [later];
      clock.advance(ROUTER1_COOLDOWN_MS);
      show("Dear Dana, the deck is ready. Lunch with Priya tomorrow at noon. Coffee with Ana on Friday at 9am.");
      cands = [];
      show("Dear Dana, the deck is ready. Lunch with Priya tomorrow at noon. Coffee with Ana on Friday at 9am. Bye.");
      jev.release();
      await coord.idle();
      expect(later.ran).toBe(0);
      expect(coord.stats.staleDrops).toBe(1);
    });

    it("leaves the sentence and the person out of the task question when their window's budget will not take them", async () => {
      hostWrites = false;
      // A conversation gives Jev less than half its text: its one line cannot be quoted whole.
      const chat: AppRef = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };
      const line = "Coffee with Dana on Friday at 3pm, see you there.";
      model.apply(snap([text("c/statictext:line~0", line)], { at: clock.at, windowId: "7373-1", app: chat, title: "Chat" }));
      const w = model.windows.get("7373-1");
      if (w === undefined) throw new Error("the chat window is not in the model");
      const ev = checked();
      ev.quotes = [{ window: w, kind: "candidate", texts: [line, "Dana"] }];
      ev.evidence = { task: "Add an event to the user's calendar", sentence: line, found: 'Code found in it the person "Dana" and the time Fri 3:00 PM; it is a new line in a Messages conversation.', plain: "Code found in it a person and the time Fri 3:00 PM; it is a new line in a Messages conversation.", offerWhen: "Offer it." };
      cands = [ev];
      show("Notes so far. ");
      await coord.idle();
      const r = jev.routerCalls()[0] as JevRequest;
      expect((r.state as Record<string, unknown>).offer).toEqual({ task: "Add an event to the user's calendar", found: "Code found in it a person and the time Fri 3:00 PM; it is a new line in a Messages conversation." });
      expect(JSON.stringify(r.state)).not.toContain("Dana");
      expect(r.snippets.some((x) => x.text === line || x.text === "Dana")).toBe(false);
    });

    it("lets a forged task answer fail the decision when the task was the only question", async () => {
      hostWrites = false;
      cands = [checked()];
      jev.task = () => ({ choice: "write", confidence: 0.9 });
      show("Lunch with Priya tomorrow at noon. ");
      await coord.idle();
      expect(decisions.at(-1)).toMatchObject({ outcome: "error", failure: "forged", published: true });
      expect(cands[0]?.ran).toBe(0);
    });
  });

  describe("entering a field (R3)", () => {
    it("treats the host's first report of a plain caret as no breakpoint, so its first sentence end keeps the write session", async () => {
      jev.router1 = () => ({ choice: "write", confidence: 0.9 });
      show("Dear Dana, the deck");
      await coord.idle();
      expect(coord.writing).toEqual({ windowId: NOTE, key: BODY(0) });
      clock.advance(ROUTER1_COOLDOWN_MS);
      // RouteFollower sends nothing after binding while the selection is a plain caret: its first context is this one.
      coord.hostEditing({ windowId: NOTE, key: BODY(0), selection: "caret", composing: false, textRevision: "h1" }, true);
      show("Dear Dana, the deck is ready. ");
      await coord.idle();
      expect(jev.routerCalls()).toHaveLength(1);
      expect(decisions.slice(1).map((d) => [d.breakpoint, d.outcome, d.by])).toEqual([["sentence", "write", "session"]]);
      expect(decisions.at(-1)?.textRevision).toBe("h1");
      expect(ended).toEqual([]);
      // A range is still a new decision.
      coord.hostEditing({ windowId: NOTE, key: BODY(0), selection: "range", composing: false, textRevision: "h2" });
      coord.observe();
      await coord.idle();
      expect(decisions.at(-1)?.breakpoint).toBe("selection");
    });

    it("starts a newly focused field's decision at once; repeats in one field still wait out the cooldown", async () => {
      jev.router1 = () => ({ choice: "write", confidence: 0.9 });
      show("One. ", 0);
      await coord.idle();
      clock.advance(500);
      show("Two. ", 1);
      await coord.idle();
      expect(jev.routerCalls()).toHaveLength(2);
      expect(decisions.at(-1)).toMatchObject({ key: BODY(1), outcome: "write", latencyMs: 0 });
      // Inside the field, a memory change is a repeat: it waits two seconds from that field's call.
      clock.advance(300);
      coord.memoryChanged();
      coord.observe();
      expect(jev.routerCalls()).toHaveLength(2);
      clock.advance(ROUTER1_COOLDOWN_MS - 301);
      expect(jev.routerCalls()).toHaveLength(2);
      clock.advance(1);
      await coord.idle();
      expect(jev.routerCalls()).toHaveLength(3);
    });
  });

  describe("offers the user consented to (R2 decision 2)", () => {
    /** The helper's records, faked: one kept skill, one paused, one resolved watch, one still running. */
    const skills = new Map([["kept-1", { paused: false, keep: "kept" }], ["paused-1", { paused: true, keep: "kept" }], ["offered-1", { paused: false, keep: "offered" }]]);
    const tasks = new Map([["watch-done", { kind: "watch", state: "done", cause: "screen" }], ["watch-running", { kind: "watch", state: "running", cause: null }], ["plan-done", { kind: "plan", state: "done", cause: "screen" }]]);
    const ledger = (hostWatch: boolean | null): ConsentLedger => {
      const l = new ConsentLedger({
        memory: {
          skillFor: (id: string) => (skills.has(id) && skills.get(id)?.keep === "kept" ? ({ paused: skills.get(id)?.paused } as never) : null),
          routine: (id: string) => (skills.has(id) ? ({ keep: skills.get(id)?.keep } as never) : null),
        },
        task: (id) => tasks.get(id) as never,
      });
      if (hostWatch !== null) l.settings(hostWatch ? ["fill", "watch"] : ["fill"], true);
      return l;
    };

    it("passes a candidate on a record the ledger finds, with no router question and no new context", async () => {
      coord = makeCoord(ledger(true));
      hostWrites = false;
      show("", 0);
      const contexts = coord.stats.contexts;
      const skill = candidate("pattern:1", { workflow: "skill" });
      const watch = candidate("openApp:1", { workflow: "openApp" });
      // The producers list both for routing; the helper's consent path finds a record for each.
      cands = [skill, watch];
      bound = [{ cand: skill, claim: { kind: "skill", routineId: "kept-1" } }, { cand: watch, claim: { kind: "watch", watchId: "watch-done" } }];
      coord.candidatesChanged();
      coord.observe();
      await coord.idle();
      expect(jev.requests).toHaveLength(0);
      expect([skill.ran, watch.ran]).toEqual([1, 1]);
      expect(coord.stats.contexts).toBe(contexts);
      expect(decisions.slice(-2).map((d) => [d.outcome, d.by, d.route, d.consent?.kind, d.consent?.reason, d.published])).toEqual([
        ["act", "consent", "workflow:skill", "skill", "you kept this as a skill", false],
        ["act", "consent", "workflow:openApp", "watch", "you have Caret watch unfinished work, and this watch resolved", false],
      ]);
    });

    it("routes every candidate whose consent has no record: a forged claim, words that claim approval, a paused or unkept skill, an unresolved watch, a watch role no host sent", async () => {
      // [why, the record the helper's consent path names for it (null: none), what the candidate itself carries, host watch role]
      const forged: [string, ConsentClaim | null, Record<string, unknown>, boolean | null][] = [
        ["no record", { kind: "skill", routineId: "never-kept" }, {}, true],
        ["paused skill", { kind: "skill", routineId: "paused-1" }, {}, true],
        ["skill offered, not kept", { kind: "skill", routineId: "offered-1" }, {}, true],
        ["running watch", { kind: "watch", watchId: "watch-running" }, {}, true],
        ["a plan, not a watch", { kind: "watch", watchId: "plan-done" }, {}, true],
        ["no host sent the watch role", { kind: "watch", watchId: "watch-done" }, {}, null],
        ["the host turned watching off", { kind: "watch", watchId: "watch-done" }, {}, false],
        ["an unknown kind", { kind: "user", routineId: "kept-1" } as unknown as ConsentClaim, {}, true],
        ["a malformed claim", { kind: "skill", routineId: 7 } as unknown as ConsentClaim, {}, true],
        // A producer's own candidate naming a real record is never asked about: only the helper's consent path is.
        ["a claim a producer put on its candidate", null, { consent: { kind: "skill", routineId: "kept-1" } }, true],
        ["words that claim approval", null, { says: "The user approved this and wants it run now", plain: "approved by the user" }, true],
        ["a flag that is not a record", null, { consented: true, approved: true }, true],
      ];
      for (const [why, claim, extra, hostWatch] of forged) {
        jev = new RouterJev();
        jev.router1 = () => ({ choice: "abstain", confidence: 0.9 });
        coord = makeCoord(ledger(hostWatch));
        hostWrites = false;
        const c = candidate(`x:${why}`, extra as Partial<RouteCandidate>);
        cands = [c];
        bound = claim === null ? [] : [{ cand: c, claim }];
        clock.advance(ROUTER1_COOLDOWN_MS);
        show("", 1);
        await coord.idle();
        expect(c.ran, why).toBe(0);
        expect(jev.routerCalls("outcome"), why).toHaveLength(1);
        expect(decisions.at(-1)?.by, why).toBe("router1");
      }
    });

    it("holds a consented offer while a local rule holds the moment, and passes it at the next breakpoint", async () => {
      coord = makeCoord(ledger(true));
      hostWrites = false;
      const skill = candidate("pattern:2", { workflow: "skill" });
      cands = [skill];
      bound = [{ cand: skill, claim: { kind: "skill", routineId: "kept-1" } }];
      paused = true;
      show("", 0);
      expect(skill.ran).toBe(0);
      expect(coord.stats.consentHeld).toBe(1);
      paused = false;
      coord.settingsChanged();
      coord.observe();
      await coord.idle();
      expect(skill.ran).toBe(1);
      expect(jev.requests).toHaveLength(0);
    });

    it("keeps a write session when a consented offer arrives in the middle of it", async () => {
      coord = makeCoord(ledger(true));
      jev.router1 = () => ({ choice: "write", confidence: 0.9 });
      show("Dear Dana, the deck");
      await coord.idle();
      const watch = candidate("openApp:2", { workflow: "openApp" });
      cands = [watch];
      bound = [{ cand: watch, claim: { kind: "watch", watchId: "watch-done" } }];
      coord.candidatesChanged();
      coord.observe();
      await coord.idle();
      expect(watch.ran).toBe(1);
      expect(coord.writing).toEqual({ windowId: NOTE, key: BODY(0) });
      expect(jev.routerCalls()).toHaveLength(1);
    });
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
    // The newest context is a field no answer has decided yet: it gets its call as soon as the slot is free (R3).
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(coord.stats.staleDrops).toBe(1);
    expect(coord.stats.replaced).toBe(1);
    expect(coord.writing).toBeNull();
    expect(jev.routerCalls()).toHaveLength(2);
    jev.release();
    await coord.idle();
    // The first context's late reply is a failed decision about that context, never its answer.
    expect(decisions.map((d) => [d.outcome, d.failure, d.key, d.calls])).toEqual([
      ["error", "stale", BODY(0), 1],
      ["write", null, BODY(2), 1],
    ]);
    expect(coord.writing).toEqual({ windowId: NOTE, key: BODY(2) });
  });

  it("starts Router 1 at most once per two seconds in one field, however its context changes", async () => {
    show("One. ", 0);
    await coord.idle();
    clock.advance(500);
    show("One. Two. ", 0);
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

  it("never retries: a failed request is a failed decision after exactly one call, and the same context asks no more", async () => {
    cands = [candidate("a")];
    jev.router1 = () => new Error("Jev HTTP 503");
    show("Hello");
    await coord.idle();
    show("Hello there");
    clock.advance(10 * ROUTER1_COOLDOWN_MS);
    await coord.idle();
    expect(jev.routerCalls()).toHaveLength(1);
    expect(decisions.map((d) => [d.outcome, d.failure, d.refused])).toEqual([["error", "failed", { router: 1, why: "failed" }]]);
    expect(cands[0]?.ran).toBe(0);
  });

  it("decides error, never abstain, when a router fails, times out, or answers what cannot be read; a weak answer still abstains (R2 decision 1)", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const cases: { r1: Answer | Error | null; r2?: Answer | Error; outcome: string; failure: string | null }[] = [
      { r1: new Error("Jev HTTP 503"), outcome: "error", failure: "failed" },
      { r1: timeout, outcome: "error", failure: "timeout" },
      { r1: { choice: "act", confidence: Number.NaN }, outcome: "error", failure: "nonfinite" },
      { r1: { choice: "launch", confidence: 0.99 }, outcome: "error", failure: "forged" },
      { r1: null, outcome: "error", failure: "missing" },
      { r1: { choice: "act", confidence: 0.9 }, r2: timeout, outcome: "error", failure: "timeout" },
      { r1: { choice: "act", confidence: 0.49 }, outcome: "abstain", failure: null },
      { r1: { choice: "act", confidence: 0.9 }, r2: { choice: "r1", confidence: 0.6 }, outcome: "abstain", failure: null },
    ];
    cands = [candidate("a"), candidate("b")];
    let i = 0;
    for (const c of cases) {
      jev.router1 = () => c.r1;
      jev.router2 = () => c.r2 ?? { choice: "r1", confidence: 0.9 };
      clock.advance(ROUTER1_COOLDOWN_MS);
      show(`case ${i++}`, i % 3);
      await coord.idle();
    }
    expect(decisions.map((d) => [d.outcome, d.failure])).toEqual(cases.map((c) => [c.outcome, c.failure]));
    expect(coord.writing).toBeNull();
    expect(coord.stats.byOutcome.error).toBe(6);
  });

  it("rejects forged, nonfinite, missing and weak answers from either router", async () => {
    const cases: { r1: Answer | null; r2?: Answer; why: string }[] = [
      { r1: { choice: "launch", confidence: 0.99 }, why: "router1_forged" },
      { r1: { choice: "act", confidence: Number.NaN }, why: "router1_nonfinite" },
      { r1: { choice: "act", confidence: 1.5 }, why: "router1_nonfinite" },
      { r1: { choice: "act", confidence: 0.49 }, why: "router1_lowConfidence" },
      // Router 1 takes 0.5 and above; Router 2 keeps 0.75 (judge.ts).
      { r1: { choice: "act", confidence: 0.5 }, r2: { choice: "r1", confidence: 0.74 }, why: "router2_lowConfidence" },
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
      Object.entries({ router1_forged: 1, router1_nonfinite: 2, router1_lowConfidence: 1, router1_missing: 1, router2_forged: 2, router2_lowConfidence: 2 }).sort(),
    );
    expect(a.ran + b.ran).toBe(0);
    // Only a weak answer abstains; one that cannot be read is a failed decision (R2 decision 1).
    expect(decisions.map((d) => (d.refused?.why === "lowConfidence" ? d.outcome === "abstain" : d.outcome === "error"))).toEqual(cases.map(() => true));
    // An outcome that is a real word but not legal now is forged too: write with no host to take it.
    hostWrites = false;
    jev.router1 = () => ({ choice: "write", confidence: 0.99 });
    clock.advance(ROUTER1_COOLDOWN_MS);
    show("again", (i + 1) % 3);
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

  it("drops a reply that arrives after a reader restart or after the user left every known window (review)", async () => {
    jev.holding = true;
    jev.router1 = () => ({ choice: "write", confidence: 0.95 });
    show("Draft", 0);
    expect(jev.routerCalls()).toHaveLength(1);
    coord.readerRestarted();
    jev.release();
    await coord.idle();
    expect(coord.stats.staleDrops).toBe(1);
    expect(coord.writing).toBeNull();
    // The stale context is published as failed, so a host waiting on it falls back rather than reading abstain (R2 decision 1).
    expect(decisions.map((d) => [d.outcome, d.failure, d.answered])).toEqual([["error", "stale", "write"]]);
    decisions.length = 0;
    // The same with no context at all: the user went to an app whose windows the model does not hold.
    clock.advance(ROUTER1_COOLDOWN_MS);
    show("Draft two", 1);
    expect(jev.routerCalls()).toHaveLength(2);
    model.frontmostPid = 9999;
    coord.observe();
    jev.release();
    await coord.idle();
    expect(coord.stats.staleDrops).toBe(2);
    expect(coord.writing).toBeNull();
    expect(decisions.map((d) => [d.outcome, d.failure])).toEqual([["error", "stale"]]);
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
    const base = { model, focus: null, host: null, readerSession: 1, memoryRevision: 0, settingsRevision: 0, hostBreaks: 0, candidates: [] };
    show("Hi. Then", 0);
    const a = contextNow(base);
    expect(a?.sentences).toBe(1);
    expect(breakpoint(a, contextNow(base) as NonNullable<typeof a>)).toBeNull();
    expect(breakpoint(a, contextNow({ ...base, host: { windowId: NOTE, key: BODY(0), selection: "range", composing: false } }) as NonNullable<typeof a>)).toBe("selection");
    // The host reports nothing while the selection is a plain caret (RouteFollower), so "unknown" already means one.
    expect(breakpoint(a, contextNow({ ...base, host: { windowId: NOTE, key: BODY(0), selection: "caret", composing: false } }) as NonNullable<typeof a>)).toBeNull();
    expect(breakpoint(a, contextNow({ ...base, host: { windowId: NOTE, key: BODY(0), selection: "none", composing: false } }) as NonNullable<typeof a>)).toBe("selection");
    expect(breakpoint(a, contextNow({ ...base, settingsRevision: 1 }) as NonNullable<typeof a>)).toBe("settings");
    expect(breakpoint(a, contextNow({ ...base, memoryRevision: 1 }) as NonNullable<typeof a>)).toBe("memory");
    expect(breakpoint(a, contextNow({ ...base, candidates: ["fillAll"] }) as NonNullable<typeof a>)).toBe("candidates");
    // A sentence end the host saw before the reader walked it opens a decision too.
    expect(breakpoint(a, contextNow({ ...base, hostBreaks: 1 }) as NonNullable<typeof a>)).toBe("sentence");
    // The host's text revision is what decisions carry for its field, and changing it alone is ordinary typing.
    const hosted = contextNow({ ...base, host: { windowId: NOTE, key: BODY(0), selection: "caret", composing: false, textRevision: "host-42" } });
    expect(hosted?.textRevision).toBe("host-42");
    expect(breakpoint(hosted, contextNow({ ...base, host: { windowId: NOTE, key: BODY(0), selection: "caret", composing: false, textRevision: "host-43" } }) as NonNullable<typeof a>)).toBeNull();
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
    // With the email the reader types in it: the router lists fill when a field visibly fits a value on screen.
    void h.handleReader(snap([text("m/statictext:sig~0", `Dana Whitfield\n${VALUE}`)], { at: clock.at - 5000, windowId: SRC, app: MAIL_APP, title: "Signature", values: [value("email", VALUE, "m/statictext:sig~0")] }));
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

  it("stops the router on shutdown: a reply still on its way, a cooldown timer and a late observe do nothing (R2 decision 4)", async () => {
    jev.other = jevPickingText(() => VALUE);
    jev.holding = true;
    jev.router1 = () => ({ choice: "act", confidence: 0.9 });
    const h = make(true);
    void h.handleReader(snap([text("m/statictext:sig~0", `Dana Whitfield\n${VALUE}`)], { at: clock.at - 5000, windowId: SRC, app: MAIL_APP, title: "Signature", values: [value("email", VALUE, "m/statictext:sig~0")] }));
    void h.handleReader(snap([field(EMAIL, "", { label: "Email", frame: [100, 40, 200, 24] })], { at: clock.at, windowId: FORM, title: "Claim form", focused: true, focusedKey: EMAIL }));
    await h.handleReader(focus(FORM, EMAIL, clock.at));
    expect(jev.routerCalls()).toHaveLength(1);
    // A second context waits out the cooldown on a timer.
    clock.advance(100);
    void h.handleReader(snap([field(EMAIL, "", { label: "Email", frame: [100, 40, 200, 24] })], { at: clock.at, windowId: FORM, title: "Claim form 2", focused: true, focusedKey: EMAIL }));
    const decided = h.routing?.decisions.length;
    const counted = vi.spyOn(store, "count");
    const before = sent.length;
    h.shutdown();
    jev.release();
    await h.routing?.idle();
    clock.advance(10 * ROUTER1_COOLDOWN_MS);
    h.routing?.observe();
    h.routing?.candidatesChanged();
    h.routing?.observe();
    h.routing?.readerRestarted();
    await h.routing?.idle();
    expect(jev.routerCalls()).toHaveLength(1);
    expect(h.routing?.decisions.length).toBe(decided);
    expect(sent.slice(before)).toEqual([]);
    expect(counted.mock.calls.filter(([m]) => String(m).startsWith("route."))).toEqual([]);
    expect(h.routing?.stopped).toBe(true);
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
    // A finished sentence keeps the session: write again at once, with no second call (R2 decision 3).
    await typeDoc(h, "Notes for the review. We should move it. ");
    expect(jev.routerCalls()).toHaveLength(1);
    expect(h.routing?.decisions.at(-1)).toMatchObject({ breakpoint: "sentence", outcome: "write", by: "session" });
    // The host never hears the session end: no null decision, and the last one it got is write.
    const published = sent.flatMap((m) => (m.type === "routeDecision" ? [m.outcome] : []));
    expect(published).not.toContain(null);
    expect(published.at(-1)).toBe("write");
  });

  it("lists no fill for a lone document body with nothing on screen that fits it", async () => {
    jev.router1 = () => ({ choice: "act", confidence: 0.9 });
    const h = make(true);
    void h.handleReader(snap([text("m/statictext:note~0", "Groceries and the plan for Saturday")], { at: clock.at - 5000, windowId: SRC, app: MAIL_APP, title: "Note" }));
    void h.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: clock.at, from: null, to: NOTES });
    await typeDoc(h, "");
    expect(jev.requests).toHaveLength(0);
    expect(h.routing?.decisions.at(-1)?.local).toBe("noCapability");
  });

  it("counts no value the form already holds as fitting another of its empty fields (corpus m18)", async () => {
    const NOTE_LINE = "m/statictext:portfolio~0";
    const URL = "https://harperq.example.com";
    const PORTFOLIO = "dev.caret.fixture/standard/textfield:portfolio~0";
    const LINKEDIN = "dev.caret.fixture/standard/textfield:linkedin~0";
    const COVER = "dev.caret.fixture/standard/textarea:cover~0";
    const fillSays = async (portfolio: string, data: string): Promise<string | undefined> => {
      memory.close();
      memory = new MemoryStore(join(dir, data));
      jev.requests.length = 0;
      jev.router1 = () => ({ choice: "abstain", confidence: 0.9 });
      const h = make(true);
      void h.handleReader(snap([text(NOTE_LINE, `portfolio: ${URL}`)], { at: clock.at - 5000, windowId: SRC, app: MAIL_APP, title: "Application notes", focused: true, values: [value("url", URL, NOTE_LINE)] }));
      const form = [
        field(PORTFOLIO, portfolio, { label: "Portfolio or website", frame: [100, 40, 300, 24] }),
        field(LINKEDIN, "", { label: "LinkedIn URL", frame: [100, 80, 300, 24] }),
        field(COVER, "", { label: "Cover letter", role: "AXTextArea", frame: [100, 120, 300, 120] }),
      ];
      void h.handleReader(snap(form, { at: clock.at, windowId: FORM, title: "Apply", focused: true, focusedKey: COVER }));
      await h.handleReader(focus(FORM, COVER, clock.at));
      await settle(h);
      expect(jev.routerCalls("outcome")).toHaveLength(1);
      return (jev.routerCalls("outcome")[0]?.questions.outcome as { criteria: Record<string, string> }).criteria.act;
    };
    // The note's address is not in the form yet: it fits the empty LinkedIn URL by kind.
    expect(await fillSays("https://elsewhere.example.org", "data-a")).toContain("values that fit 1 of its 2 empty fields are on screen in");
    // The form already holds it in Portfolio, so nothing on screen fits what is left.
    expect(await fillSays(URL, "data-b")).toContain("Fill this form's 2 empty fields, though no open window shows a value that clearly fits them");
  });

  it("lists no event for a sentence its window's privacy budget will not carry", async () => {
    // A short conversation gives Jev less than half its text: the attend asks could not quote the sentence, so code
    // does not list a card it could never make.
    jev.router1 = () => ({ choice: "act", confidence: 0.9 });
    const chat: AppRef = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };
    const h = make(true);
    void h.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: clock.at, from: null, to: chat });
    const reply = "m/textarea:reply~0";
    void h.handleReader(snap([{ key: reply, parent: null, role: "AXTextArea", label: "Message", editable: true, value: "Lunch with Priya tomorrow at noon. " }], { at: clock.at, windowId: "7373-1", app: chat, title: "Priya", focused: true, focusedKey: reply, values: [{ kind: "date", text: "tomorrow at noon", nodeKey: reply }] }));
    await settle(h);
    expect(jev.requests).toHaveLength(0);
    expect(h.routing?.decisions.at(-1)?.local).toBe("noCapability");
  });

  it("routes a finished sentence with a person and a time to the event card, which quotes the exact sentence", async () => {
    const sentence = "Lunch with Priya tomorrow at noon.";
    jev.task = () => ({ choice: "act", confidence: 0.9 });
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
    // Router 1 saw the sentence and the person code found in it as quoted, declared snippets, in its own task question
    // with the time code resolved and where the sentence came from (R3).
    const r1 = jev.routerCalls("task").at(-1) as JevRequest;
    expect(Object.keys(r1.questions)).toEqual(["task"]);
    expect(r1.snippets.some((x) => x.windowId === NOTES_DOC && x.text === sentence)).toBe(true);
    expect(r1.snippets.some((x) => x.windowId === NOTES_DOC && x.text === "Priya")).toBe(true);
    const offer = (r1.state as { offer: { task: string; sentence: string; found: string } }).offer;
    expect(offer.sentence).toBe(sentence);
    expect((r1.questions.task as { instructions: string }).instructions).toContain("Do not offer it for something over, cancelled, declined");
    const act = offer.found;
    // Noon with no end: the card asks how long, and Router 1 is told both times it could add.
    const times = (cards[0]?.variants as OfferPopup["spec"]).blocks.flatMap((b) => (b.type === "choices" ? b.rows.map((r) => r.label.text) : []));
    expect(times).toHaveLength(2);
    expect(act).toContain(`the person "Priya"`);
    expect(act).toContain(`the time ${times.join(" or ")}, the sentence giving no end`);
    expect(act).toContain("the user typed it in this field");
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

  it("lists fill once a source window arrives while the user waits in an empty field (review)", async () => {
    jev.other = jevPickingText(() => VALUE);
    jev.router1 = () => ({ choice: "act", confidence: 0.9 });
    const h = make(true);
    void h.handleReader(snap([field(EMAIL, "", { label: "Email", frame: [100, 40, 200, 24] })], { at: clock.at, windowId: FORM, title: "Claim form", focused: true, focusedKey: EMAIL }));
    await h.handleReader(focus(FORM, EMAIL, clock.at));
    await settle(h);
    expect(h.routing?.decisions.at(-1)?.local).toBe("noCapability");
    clock.advance(1000);
    void h.handleReader(snap([text("m/statictext:sig~0", `Dana Whitfield\n${VALUE}`)], { at: clock.at, windowId: SRC, app: MAIL_APP, title: "Signature", values: [value("email", VALUE, "m/statictext:sig~0")] }));
    await settle(h);
    expect(jev.routerCalls("outcome")).toHaveLength(1);
    expect(h.routing?.decisions.at(-1)).toMatchObject({ breakpoint: "candidates", outcome: "act", route: "fillAll" });
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

  /** A loop on the desk whose next row is held for the router, with Router 1's reply held too; the desk's clock drives the helper. */
  const heldLoop = async (): Promise<{ h: Helper; desk: InstanceType<typeof import("./scene.ts").Desk>; fire: () => void; next: string }> => {
    const { Desk, roster, grid, PEOPLE } = await import("./scene.ts");
    const desk = new Desk();
    const due: { at: number; fn: () => void }[] = [];
    memory.close();
    memory = new MemoryStore(join(dir, `data-${Math.random().toString(36).slice(2)}`));
    const h = new Helper({ store, memory, askJev: jev.ask, shadow: false, allowBackgroundFocus: false, publish: (m) => sent.push(m), readerLink: desk, now: () => desk.at, routing: { setTimer: (fn, ms) => (due.push({ at: desk.at + ms, fn }), () => undefined) } });
    desk.attach(h);
    const dst = grid();
    const src = roster();
    desk.showList(src);
    desk.advance(1000);
    desk.showGrid(dst);
    desk.fill(dst, 0, 0, src.lines[0] as string);
    desk.fill(dst, 1, 0, src.lines[1] as string);
    await new Promise((r) => setImmediate(r));
    const fire = (): void => {
      for (const t of due.splice(0)) if (t.at <= desk.at) t.fn();
    };
    return { h, desk, fire, next: PEOPLE[2] as string };
  };
  const shown = (): number => sent.filter((m) => m.type === "patternOffer").length;

  it("lets a held offer go when its family is turned off while the router decides (review)", async () => {
    jev = new RouterJev();
    jev.holding = true;
    jev.router1 = () => ({ choice: "act", confidence: 0.9 });
    sent = [];
    const { h } = await heldLoop();
    expect(h.patterns.heldIds()).toHaveLength(1);
    h.handleSettings({ type: "settings", v: PROTOCOL_VERSION, at: Date.now(), roles: ["fill", "watch", "calendar", "words"], level: "balanced", paused: false });
    expect(h.patterns.heldIds()).toEqual([]);
    jev.release();
    await h.routing?.idle();
    expect(shown()).toBe(0);
    expect(h.memory.decisions().some((d) => d.offerKind === "loopNext" && d.reasons.includes("roleOff"))).toBe(true);
  });

  it("asks the speak-now gate again on release: a budget spent meanwhile holds the offer (review)", async () => {
    jev = new RouterJev();
    jev.holding = true;
    jev.router1 = () => ({ choice: "act", confidence: 0.9 });
    sent = [];
    const { h, desk } = await heldLoop();
    for (let i = 0; i < 4; i++) h.gate.spoke(desk.at);
    jev.release();
    await h.routing?.idle();
    expect(shown()).toBe(0);
    expect(h.memory.decisions().some((d) => d.offerKind === "loopNext" && !d.speak && d.reasons.includes("hourlyBudget"))).toBe(true);
  });

  it("does not show a held offer whose value a memory entry added meanwhile would change (review)", async () => {
    jev = new RouterJev();
    jev.holding = true;
    jev.router1 = () => ({ choice: "act", confidence: 0.9 });
    sent = [];
    const { h, desk, fire, next } = await heldLoop();
    // A person whose alias is the next row's value: applyMemory now writes the full name instead.
    const r = h.handleMemory({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "p", op: "add", kind: "people", fields: { alias: next, name: `${next} Junior` } });
    expect(r.error).toBeNull();
    jev.release();
    // The memory change's context has had no answer used in its field, so its call starts as soon as the slot is free.
    await new Promise((res) => setImmediate(res));
    if (jev.held.length > 0) jev.release();
    await h.routing?.idle();
    desk.advance(ROUTER1_COOLDOWN_MS);
    fire();
    await new Promise((res) => setImmediate(res));
    if (jev.held.length > 0) jev.release();
    await h.routing?.idle();
    expect(shown()).toBe(0);
    expect(h.patterns.heldIds()).toEqual([]);
    expect(h.routing?.decisions.at(-1)).toMatchObject({ outcome: "act", route: "workflow:loop" });
    expect(h.memory.decisions().some((d) => d.offerKind === "loopNext" && !d.speak && d.reasons.includes("ungrounded"))).toBe(true);
  });
});
