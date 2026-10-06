// R1: the slow Laya runner. The layer in each eval process (engines/decide/slow.ts) and the runner's loop
// (scripts/slow-eval-core.ts), on a fake clock: pacing and backoff, resume after a kill without a repeated request,
// the stops (cost, auth, HOLD, disk), and the heavy lease released through every wait.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harnessEngine } from "../src/engines/decide/harness.ts";
import { cachedAsk, CacheRefused } from "../src/engines/decide/cache.ts";
import { JevCapError } from "../src/engines/decide/daily-cap.ts";
import { fileFailures, holdReason, slowAsk, type PassEnd, type SlowClock, type SlowEvent, type SlowOptions } from "../src/engines/decide/slow.ts";
import { JevGatewayPolicyError, JevHttpError, JevNetworkError, type AskJev, type JevRequest, type JevResult } from "../src/fill/jev.ts";
import { backoffMs, LEASE_GAP_MS, newStatus, Runner, type EvalSet, type Held, type PassHandle, type RunnerDeps, type RunnerStatus } from "../scripts/slow-eval-core.ts";
import { scoreAsks, scorePages, scoreWizardMd } from "../scripts/slow-eval-score.ts";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "r1-"))));
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

/** Time moves only when something sleeps. */
function fakeClock(start = 1_000_000): SlowClock & { sleeps: number[] } {
  let now = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

const req = (q: string): JevRequest => ({ state: { form: "fixture" }, questions: { [q]: { type: "choice", instructions: `Pick for ${q}`, criteria: { a: "A", b: "B" } } }, snippets: [], charged: {} });
const answer = (q: string, costUsd = 0): JevResult => ({ model: "convaiinnovations/laya-free", answers: { [q]: { choice: "a", confidence: 0.9 } }, inputTokens: 10, latencyMs: 400, costUsd });
const qOf = (r: JevRequest): string => Object.keys(r.questions)[0] as string;

interface Layer {
  ask: AskJev;
  events: SlowEvent[];
  ends: PassEnd[];
  clock: ReturnType<typeof fakeClock>;
}
function layer(inner: AskJev, over: Partial<SlowOptions> = {}): Layer {
  const clock = fakeClock();
  const events: SlowEvent[] = [];
  const ends: PassEnd[] = [];
  const failures = new Map<string, string>();
  let shared: number | null = null;
  const ask = slowAsk(inner, {
    clock,
    paceMs: 3000,
    pace: { read: () => shared, write: (at) => void (shared = at) },
    failures: { get: (k) => failures.get(k), put: (k, e) => void failures.set(k, e) },
    keyOf: qOf,
    stopCheck: () => null,
    log: (e) => void events.push(e),
    endPass: (r) => void ends.push(r),
    ...over,
  });
  return { ask, events, ends, clock };
}
/** Settles within a few turns of the event loop, or reports that it never settled. */
async function settled<T>(p: Promise<T>): Promise<{ value?: T; error?: unknown; pending?: true }> {
  const none = Symbol("pending");
  const r = await Promise.race([p.then((value) => ({ value }), (error: unknown) => ({ error })), new Promise<typeof none>((res) => setTimeout(() => res(none), 20))]);
  return r === none ? { pending: true } : r;
}

describe("slow layer: pacing", () => {
  it("spaces requests 3 s apart, in order, and sends with the client's own 429 retry off", async () => {
    const at: number[] = [];
    const retries: (boolean | undefined)[] = [];
    let clock: SlowClock | null = null;
    const l = layer(async (r) => (at.push((clock as SlowClock).now()), retries.push(r.retry429), answer(qOf(r))));
    clock = l.clock;
    const t0 = l.clock.now();
    await Promise.all(["a", "b", "c"].map((q) => l.ask(req(q))));
    expect(at.map((t) => t - t0)).toEqual([0, 3000, 6000]);
    expect(retries).toEqual([false, false, false]);
    // Each request's wait is counted from its own turn, so the waits add up to the time spent pacing, counted once.
    expect(l.events.filter((e) => e.t === "sent").map((e) => (e as { paceWaitMs: number }).paceWaitMs)).toEqual([0, 3000, 3000]);
  });

  it("waits out the pace another process left in the shared file", async () => {
    const l0 = fakeClock();
    let shared: number | null = l0.now() - 1000;
    const sent: number[] = [];
    const ask = slowAsk(async (r) => (sent.push(l0.now()), answer(qOf(r))), { clock: l0, paceMs: 3000, pace: { read: () => shared, write: (at) => void (shared = at) }, failures: { get: () => undefined, put: () => {} }, keyOf: qOf, stopCheck: () => null, log: () => {}, endPass: () => {} });
    const t0 = l0.now();
    await ask(req("a"));
    expect(sent[0]! - t0).toBe(2000);
    expect(shared).toBe(sent[0]);
  });
});

describe("slow layer: limits end the pass, they never answer", () => {
  it("a 429 ends the pass, leaves the ask unanswered and sends nothing after it", async () => {
    let calls = 0;
    const l = layer(async (r) => {
      calls++;
      if (qOf(r) === "b") throw new JevHttpError(429, "slow down", "gateway");
      return answer(qOf(r));
    });
    expect((await settled(l.ask(req("a")))).value?.answers.a?.choice).toBe("a");
    expect((await settled(l.ask(req("b")))).pending).toBe(true);
    expect((await settled(l.ask(req("c")))).pending).toBe(true);
    expect(calls).toBe(2);
    expect(l.ends).toEqual(["rate"]);
    expect(l.events.map((e) => e.t)).toEqual(["sent", "rate", "end"]);
  });

  it("a network failure or a 5xx ends the pass as transient", async () => {
    for (const e of [new JevNetworkError("no route", null), new JevHttpError(503, "busy", "gateway")]) {
      const l = layer(async () => {
        throw e;
      });
      expect((await settled(l.ask(req("a")))).pending).toBe(true);
      expect(l.ends).toEqual(["transient"]);
    }
  });
});

describe("slow layer: stops", () => {
  const cases: [string, () => never | Promise<JevResult>, PassEnd][] = [
    ["a refused answer with a cost", () => { throw new JevGatewayPolicyError("Laya requires an explicit zero gateway cost; this model is blocked", "convaiinnovations/laya-free", { inputTokens: 5, costUsd: 0.001 }); }, "cost"],
    ["an answer that reports a cost", async () => answer("a", 0.0001), "cost"],
    ["a 401", () => { throw new JevHttpError(401, "bad key", "gateway"); }, "auth"],
    ["a plain 403", () => { throw new JevHttpError(403, "forbidden", "gateway"); }, "auth"],
    ["a 402", () => { throw new JevHttpError(402, "no credits", "gateway"); }, "billing"],
    ["the daily cap", () => { throw new JevCapError(0.5, 0.5, "2026-10-06"); }, "cap"],
  ];
  for (const [name, inner, reason] of cases) {
    it(`stops on ${name}`, async () => {
      const l = layer(async () => inner());
      expect((await settled(l.ask(req("a")))).pending).toBe(true);
      expect(l.ends).toEqual([reason]);
    });
  }

  it("stops on HOLD or low disk before sending", async () => {
    for (const reason of ["hold", "disk"] as const) {
      let calls = 0;
      const l = layer(async (r) => (calls++, answer(qOf(r))), { stopCheck: () => ({ reason, detail: "test" }) });
      expect((await settled(l.ask(req("a")))).pending).toBe(true);
      expect(calls).toBe(0);
      expect(l.ends).toEqual([reason]);
    }
  });

  it("reads HOLD as lead-hold does", () => {
    const f = join(dir, "HOLD");
    const now = 1_700_000_000_000;
    expect(holdReason(f, now)).toBeNull();
    writeFileSync(f, `${now / 1000 + 600} lead is merging\n`);
    expect(holdReason(f, now)).toMatch(/^lead is merging \(until /);
    writeFileSync(f, `${now / 1000 - 1} old\n`);
    expect(holdReason(f, now)).toBeNull();
    writeFileSync(f, "tomorrow\n");
    expect(holdReason(f, now)).toMatch(/unreadable hold marker/);
  });
});

describe("slow layer: answers the client could not use", () => {
  it("are recorded and replayed without sending again; a fixture refusal is not recorded", async () => {
    const store = fileFailures(join(dir, "failures"));
    let calls = 0;
    const bad: AskJev = async () => {
      calls++;
      throw new Error("Jev answered q with a yes/no, which was asked as a choice");
    };
    await expect(layer(bad, { failures: store }).ask(req("a"))).rejects.toThrow(/yes\/no/);
    await expect(layer(bad, { failures: store }).ask(req("a"))).rejects.toThrow(/yes\/no/);
    expect(calls).toBe(1);
    const refused = layer(async () => {
      throw new CacheRefused("window w1 is not a fixture's");
    }, { failures: store });
    await expect(refused.ask(req("b"))).rejects.toThrow(CacheRefused);
    expect(store.get("b")).toBeUndefined();
  });
});

describe("resume after a kill", () => {
  const fixture = { windows: () => true, memory: true, plan: true };
  it("a rerun on the same cache sends no answered request again: only the one the limit met, then the rest", async () => {
    const sent: string[] = [];
    let limited = true;
    const laya: AskJev = async (r) => {
      sent.push(qOf(r));
      if (qOf(r) === "c" && limited) throw new JevHttpError(429, "slow down", "gateway");
      return answer(qOf(r));
    };
    const run = (): Layer & { cached: AskJev } => {
      const l = layer(laya);
      return { ...l, cached: cachedAsk(l.ask, { dir: join(dir, "cache"), mode: "replay-or-record", engine: "gateway:convaiinnovations/laya-free", model: "convaiinnovations/laya-free", fixture, env: {} }) };
    };
    const first = run();
    for (const q of ["a", "b"]) await first.cached(req(q));
    expect((await settled(first.cached(req("c")))).pending).toBe(true);
    // The process is killed here; a new one starts the set again.
    limited = false;
    const second = run();
    for (const q of ["a", "b", "c", "d"]) expect((await second.cached(req(q))).answers[q]?.choice).toBe("a");
    expect(sent).toEqual(["a", "b", "c", "c", "d"]);
    // Laya's answers are keyed to Laya: the same request for Jev is not answered from them.
    let jevCalls = 0;
    const jev = cachedAsk(async (r) => (jevCalls++, { ...answer(qOf(r)), model: "jev-latest" }), { dir: join(dir, "cache"), mode: "replay-or-record", engine: "jev", model: "jev-latest", fixture, env: {} });
    expect((await jev(req("a"))).model).toBe("jev-latest");
    expect(jevCalls).toBe(1);
  });
});

// ---- the runner ----
interface PassPlan {
  events: SlowEvent[];
  reported: boolean;
  /** Runs until killed. */
  hangs?: boolean;
}
interface Harness {
  runner: Runner;
  status: RunnerStatus;
  clock: ReturnType<typeof fakeClock>;
  log: string[];
  passes: string[];
  stopped: string[];
  finished: string[];
}
const set = (id: string, browser: boolean): EvalSet => ({ id, title: id, kind: browser ? "tasks" : "asks", browser, timeoutMs: 55 * 60_000 });
const ok = (n: number): SlowEvent[] => Array.from({ length: n }, (_, i) => ({ t: "sent" as const, at: i, key: `k${i}`, paceWaitMs: 3000, latencyMs: 400 }));
const ended = (reason: PassEnd, okBefore = 0): SlowEvent[] => [...ok(okBefore), { t: "end", at: 0, reason, detail: reason }];

function harness(sets: EvalSet[], plans: Record<string, PassPlan[]>, opts: { status?: RunnerStatus; lockBusy?: boolean; stopAfterPolls?: { n: number; reason: "hold" | "disk" } } = {}): Harness {
  const clock = fakeClock();
  const log: string[] = [];
  const passes: string[] = [];
  const stopped: string[] = [];
  const finished: string[] = [];
  let leaseHeld = false;
  let lockHeld = false;
  let polls = 0;
  const events = new Map<string, SlowEvent[]>();
  const reported = new Map<string, boolean>();
  const deps: RunnerDeps = {
    clock: {
      now: clock.now,
      sleep: async (ms) => {
        // Every wait that is not a running pass's poll must hold no lease.
        if (!/^running /.test(status.phase)) {
          if (leaseHeld) log.push(`LEASE HELD while '${status.phase}'`);
          log.push(`wait ${ms} (${status.phase})`);
        } else polls++;
        await clock.sleep(ms);
      },
    },
    stopCheck: () => (opts.stopAfterPolls !== undefined && polls >= opts.stopAfterPolls.n ? { reason: opts.stopAfterPolls.reason, detail: "test" } : null),
    lease: async () => {
      expect(leaseHeld).toBe(false);
      leaseHeld = true;
      log.push(`lease at ${clock.now()}`);
      return { release: async () => void ((leaseHeld = false), log.push(`release at ${clock.now()}`)) };
    },
    tryLock: async () => {
      if (opts.lockBusy === true && log.every((l) => !l.startsWith("lock waited"))) return null;
      lockHeld = true;
      return { release: async () => void (lockHeld = false) };
    },
    lock: async (): Promise<Held> => {
      log.push(`lock waited, lease ${leaseHeld ? "HELD" : "free"}`);
      lockHeld = true;
      return { release: async () => void (lockHeld = false) };
    },
    runPass: (s, pass, heavy): PassHandle => {
      const plan = plans[s.id]?.shift();
      if (plan === undefined) throw new Error(`no plan for ${s.id} pass ${pass}`);
      expect(lockHeld).toBe(true);
      expect(heavy).toBe(s.browser);
      passes.push(`${s.id}#${pass}`);
      events.set(`${s.id}#${pass}`, plan.events);
      reported.set(`${s.id}#${pass}`, plan.reported);
      let kill = (): void => {};
      const done = plan.hangs === true ? new Promise<{ code: number | null; signal: string | null }>((r) => (kill = () => r({ code: null, signal: "SIGTERM" }))) : Promise.resolve({ code: 0, signal: null });
      return { done, kill: () => kill() };
    },
    events: (s, pass) => events.get(`${s.id}#${pass}`) ?? [],
    reported: (s, pass) => reported.get(`${s.id}#${pass}`) ?? false,
    score: () => ({ unit: "fields", right: 1, wrong: 0, abstained: 0, written: 1, eligible: 1, decisions: 1, latencies: [400], extra: "" }),
    save: () => {},
    say: (l) => void log.push(l),
    finished: (s, st) => void finished.push(`${s.id}:${st.state}:${st.scoredPass ?? "-"}`),
    markStopped: (r) => void stopped.push(r),
  };
  const status = newStatus(1, clock.now(), sets, opts.status ?? null);
  return { runner: new Runner(sets, deps, status), status, clock, log, passes, stopped, finished };
}

describe("runner: backoff and settling", () => {
  it("backs off 30 s doubling to a 10 min cap, reruns the same set, and scores a pass that sent nothing", async () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
    const h = harness([set("b24", false)], {
      b24: [
        { events: ended("rate"), reported: false },
        { events: ended("rate"), reported: false },
        { events: ended("transient", 2), reported: false },
        { events: ok(5), reported: true },
        { events: [], reported: true },
      ],
    });
    expect(await h.runner.run()).toBe("done");
    const waits = h.log.flatMap((l) => /waiting (\d+) s, then the same request/.exec(l)?.slice(1).map((x) => Number(x) * 1000) ?? []);
    // 30 s, 60 s, then answers came back: the step started over at 30 s.
    expect(waits).toEqual([30_000, 60_000, 30_000]);
    expect(h.passes).toEqual(["b24#1", "b24#2", "b24#3", "b24#4", "b24#5"]);
    expect(h.status.sets.b24).toMatchObject({ state: "done", scoredPass: 5, settled: true, backoffMs: 120_000 });
    expect(h.finished).toEqual(["b24:done:5"]);
  });

  it("releases the heavy lease for every wait and takes the next one 60 s after the last", async () => {
    const h = harness([set("tasks", true), set("labelled", true)], {
      tasks: [{ events: ended("rate", 3), reported: false }, { events: [], reported: true }],
      labelled: [{ events: [], reported: true }],
    });
    expect(await h.runner.run()).toBe("done");
    expect(h.log.filter((l) => l.startsWith("LEASE HELD"))).toEqual([]);
    const leases = h.log.filter((l) => l.startsWith("lease at")).map((l) => Number(l.split(" ")[2]));
    const releases = h.log.filter((l) => l.startsWith("release at")).map((l) => Number(l.split(" ")[2]));
    expect(leases).toHaveLength(3);
    expect(releases).toHaveLength(3);
    for (let i = 1; i < leases.length; i++) expect(leases[i]! - releases[i - 1]!).toBeGreaterThanOrEqual(LEASE_GAP_MS);
    // The 429's wait came between the first release and the second lease.
    expect(leases[1]! - releases[0]!).toBeGreaterThanOrEqual(30_000);
  });

  it("waits for a busy Laya lock without holding a lease", async () => {
    const h = harness([set("tasks", true)], { tasks: [{ events: [], reported: true }] }, { lockBusy: true });
    expect(await h.runner.run()).toBe("done");
    expect(h.log).toContain("lock waited, lease free");
  });
});

describe("runner: stops", () => {
  it("stops the run on a cost, marks it for a person, and runs nothing after", async () => {
    const h = harness([set("tasks", true), set("b24", false)], { tasks: [{ events: ended("cost", 1), reported: false }], b24: [{ events: [], reported: true }] });
    expect(await h.runner.run()).toBe("stopped");
    expect(h.stopped).toEqual(["cost"]);
    expect(h.passes).toEqual(["tasks#1"]);
    expect(h.status.stopReason).toMatch(/^cost/);
    expect(h.log.filter((l) => l.startsWith("release at"))).toHaveLength(1);
  });

  it("stops a running pass on HOLD, without marking it for a person", async () => {
    const h = harness([set("tasks", true)], { tasks: [{ events: [], reported: false, hangs: true }] }, { stopAfterPolls: { n: 2, reason: "hold" } });
    expect(await h.runner.run()).toBe("stopped");
    expect(h.stopped).toEqual([]);
    expect(h.status.stopReason).toMatch(/^hold/);
    expect(h.log.filter((l) => l.startsWith("release at"))).toHaveLength(1);
  });

  it("stops on low disk the same way", async () => {
    const h = harness([set("b24", false)], { b24: [{ events: [], reported: false, hangs: true }] }, { stopAfterPolls: { n: 1, reason: "disk" } });
    expect(await h.runner.run()).toBe("stopped");
    expect(h.status.stopReason).toMatch(/^disk/);
  });
});

describe("runner: resume and crashes", () => {
  it("skips finished sets and continues a set a killed runner left running", async () => {
    const first = harness([set("b24", false), set("b25", false)], { b24: [{ events: [], reported: true }], b25: [{ events: [], reported: false, hangs: true }] }, { stopAfterPolls: { n: 2, reason: "hold" } });
    expect(await first.runner.run()).toBe("stopped");
    const saved = structuredClone(first.status);
    expect(saved.sets.b25?.state).toBe("running");
    const second = harness([set("b24", false), set("b25", false)], { b25: [{ events: [], reported: true }] }, { status: saved });
    expect(await second.runner.run()).toBe("done");
    expect(second.passes).toEqual(["b25#2"]);
  });

  it("marks a set failed after three crashes and goes on", async () => {
    const crash = { events: [], reported: false };
    const h = harness([set("b24", false), set("b25", false)], { b24: [crash, crash, crash], b25: [{ events: [], reported: true }] });
    expect(await h.runner.run()).toBe("done");
    expect(h.finished).toEqual(["b24:failed:-", "b25:done:1"]);
  });
});

describe("scores", () => {
  it("count task fields, corpus goals with a fallback eligible count, and Fill all writes", () => {
    const task = (right: number, eligible: number, wrong: number) => ({ id: "p", wrong: Array(wrong).fill("w"), written: 0, goal: null, task: { right, eligible, wrong: Array(wrong).fill("w") } });
    expect(scorePages("tasks", { rows: [task(3, 6, 0), task(2, 9, 1)], calls: [{ latencyMs: 1 }, { latencyMs: 2 }] })).toMatchObject({ right: 5, eligible: 15, wrong: 1, written: 6, abstained: 9, decisions: 2 });
    const corpus = scorePages("corpus", { rows: [{ id: "a", wrong: ["x"], written: 0, goal: { eligible: 10, eligibleWritten: 6 } }, { id: "b", wrong: [], written: 0, goal: null }] }, new Map([["b", 4]]));
    expect(corpus).toMatchObject({ right: 5, wrong: 1, written: 6, eligible: 14, abstained: 8 });
    expect(scorePages("fill", { rows: [{ id: "a", wrong: [], written: 4, goal: null }, { id: "b", wrong: ["x"], written: 2, goal: null }] })).toMatchObject({ right: 5, wrong: 1, written: 6, eligible: null });
  });

  it("count Asks as J1's bake-off does, and read C2's wizard tables", () => {
    const row = (verdict: string, cont: string | null = null) => ({ verdict, continued: cont === null ? null : { verdict: cont }, maker: { latencyMs: 100 } });
    const s = scoreAsks({ requestMs: [1, 2, 3], rows: [row("right"), row("partial"), row("asked", "wrong"), row("refused"), row("wrong")] as never });
    expect(s).toMatchObject({ unit: "asks", right: 1, wrong: 2, written: 3, eligible: 5, abstained: 2, decisions: 3 });
    const md = [
      "| page | arrived | preview ms | steps | outcome | right / eligible | wrong | missed | attach | note |",
      "| wizard-1 | navigated | 62 | 6 | done | 5 / 6 | 0 | state | - | - |",
      "| wizard-2 | harness Next | 21 | 8 | done | 7 / 9 | a: 'x' (expected y); b: 'z' (expected w) | - | - | - |",
      "- wizard-3 resume_drop reads: ines-vandermeer-resume-2026.pdf; the other file field: (empty)",
    ].join("\n");
    expect(scoreWizardMd(md)).toMatchObject({ right: 12, eligible: 15, wrong: 2, extra: "resume attached" });
  });
});

describe("harness wiring", () => {
  const fixture = { windows: () => true, memory: true, plan: true };
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    CARET_JEV_GATEWAY_KEY: "test-key",
    CARET_JEV_SPEND_DIR: join(dir, "spend"),
    CARET_JEV_CACHE: join(dir, "cache"),
    CARET_SLOW_EVAL_EVENTS: join(dir, "events.ndjson"),
    CARET_SLOW_EVAL_PACE_FILE: join(dir, "laya.last"),
    CARET_SLOW_EVAL_HOLD: join(dir, "HOLD"),
    CARET_SLOW_EVAL_DISK_GIB: "0",
    CARET_SLOW_EVAL_PACE_MS: "0",
    ...extra,
  });
  it("puts the slow layer under the cache: a repeated request replays and is sent once", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ model: "convaiinnovations/laya-free", answers: { a: { choice: "a", confidence: 0.8 } }, usage: { input_tokens: 12 }, provider_metadata: { gateway: { cost: 0 } } })));
    vi.stubGlobal("fetch", fetch);
    const h = harnessEngine({ name: "gateway:convaiinnovations/laya-free", canned: null, fixture, env: env() });
    expect((await h.ask(req("a"))).answers.a?.choice).toBe("a");
    expect((await h.ask(req("a"))).answers.a?.choice).toBe("a");
    expect(fetch).toHaveBeenCalledTimes(1);
    // Laya takes the state as JSON text only (layaState).
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string).state).toBe(JSON.stringify(req("a").state));
    const events = readFileSync(join(dir, "events.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as SlowEvent);
    expect(events.map((e) => e.t)).toEqual(["sent"]);
  });
  it("refuses the slow layer with the cache off", () => {
    expect(() => harnessEngine({ name: "gateway:convaiinnovations/laya-free", canned: null, fixture, env: env({ CARET_JEV_CACHE: "off" }) })).toThrow(/needs the replay cache/);
  });
});
