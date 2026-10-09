// The sandbox boundary. Each hostile program must end in a refusal of the named kind, inside its limit.
// Tests marked "raw" skip the compile-time shape check and hand QuickJS the JavaScript directly, because
// the shape check is not the isolation boundary.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCodePlan, runProgramJs, type ChooserPort } from "../../src/codemode/sandbox.ts";
import type { SandboxOutcome } from "../../src/codemode/types.ts";
import { CANNED_PROGRAM, FORM, MAIL } from "./fixtures.ts";

const SNAPS = [FORM, MAIL];
const pickFirst: ChooserPort = async ({ options }) => options[0]!.ref;
const raw = (body: string, opts: Parameters<typeof runProgramJs>[4] = {}, choose: ChooserPort = pickFirst) =>
  runProgramJs(`async function main(caret) {\n${body}\n}`, "raw", SNAPS, choose, opts);
const ts = (body: string, opts: Parameters<typeof runCodePlan>[3] = {}, choose: ChooserPort = pickFirst) =>
  runCodePlan(`async function main(caret: CaretPlanAPI): Promise<DraftPlan> {\n${body}\n}`, SNAPS, choose, opts);

/** A program body that builds a one-step plan after `before`. */
const plain = (before = "") => `${before}
  const pw = await caret.readWindow();
  return caret.plan({ basedOn: pw.snapshot, steps: [caret.press("t:next", "e:next-page")] });`;

function refusal(o: SandboxOutcome): { kind: string; detail: string } {
  if (o.ok) throw new Error(`expected a refusal, got a plan: ${JSON.stringify(o.plan)}`);
  return { kind: o.kind, detail: o.detail };
}

describe("a valid program", () => {
  test("the canned writer output builds the expected draft plan", async () => {
    const seen: string[] = [];
    const o = await runCodePlan(CANNED_PROGRAM, SNAPS, async ({ question, options }) => {
      seen.push(question.text, ...options.map((x) => x.label));
      return "o:wed";
    });
    if (!o.ok) throw new Error(`${o.kind}: ${o.detail}`);
    expect(o.plan.basedOn).toBe("snap:form:1");
    expect(o.plan.window).toBe("win:form");
    expect(o.plan.steps).toEqual([
      { ref: "step:1", kind: "fill", target: "t:name", value: "v:name" },
      { ref: "step:2", kind: "fill", target: "t:email", value: "v:email" },
      { ref: "step:3", kind: "fill", target: "t:session", value: "v:wed" },
      { ref: "step:4", kind: "press", target: "t:next", effect: "e:next-page" },
      { ref: "step:5", kind: "waitFor", effect: "e:next-page", timeoutMs: 2000 },
    ]);
    expect(o.plan.choices).toEqual([{ question: "q:session", offered: ["o:tue", "o:wed"], chosen: "o:wed", requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(o.plan.programDigest).toMatch(/^[0-9a-f]{64}$/);
    // Jev got the host's question text and labels, not anything the program wrote.
    expect(seen).toEqual([FORM.questions[0]!.text, "Tue Oct 20, 3:00 PM", "Wed Oct 21, 10:00 AM"]);
    expect(o.stats.readWindowCalls).toBe(2);
    expect(o.stats.chooseCalls).toBe(1);
  });

  test("a null choice lets the program ask instead", async () => {
    const o = await runCodePlan(CANNED_PROGRAM, SNAPS, async () => null);
    if (!o.ok) throw new Error(`${o.kind}: ${o.detail}`);
    expect(o.plan.steps.map((s) => s.kind)).toEqual(["fill", "fill", "ask", "press", "waitFor"]);
  });

  test("standard built-ins work, and clocks, randomness, eval and host objects are absent", async () => {
    const o = await raw(`
      const present = ["Date", "eval", "fetch", "require", "process", "XMLHttpRequest", "WebSocket", "setTimeout",
        "setInterval", "queueMicrotask", "console", "Buffer", "WebAssembly", "Atomics", "SharedArrayBuffer", "performance"]
        .filter((n) => typeof globalThis[n] !== "undefined");
      if (typeof Math.random !== "undefined") present.push("Math.random");
      if (present.length > 0) throw new Error("present: " + present.join(","));
      if ([3, 1, 2].sort().join() !== "1,2,3" || JSON.stringify({ a: [1] }) !== '{"a":[1]}') throw new Error("built-ins broken");
      ${plain()}`);
    if (!o.ok) throw new Error(`${o.kind}: ${o.detail}`);
  });
});

describe("compute, memory and stack", () => {
  test("an infinite loop stops at the compute budget", async () => {
    const o = await ts("while (true) {}");
    expect(refusal(o).kind).toBe("cpu");
    expect(o.stats.guestCpuMs).toBeGreaterThanOrEqual(250);
    expect(o.stats.wallMs).toBeLessThan(3000);
  });

  test("an infinite loop after a host callback stops too: the budget spans slices", async () => {
    const o = await ts(`const w = await caret.readWindow(); await caret.choose(w.questions[0]!.options.map((o) => o.ref)); for (;;) {}`);
    expect(refusal(o).kind).toBe("cpu");
  });

  test("heap growth stops at the QuickJS heap limit", async () => {
    const o = await ts("const a: number[][] = []; for (;;) a.push(Array(100000).fill(1));", { limits: { guestCpuMs: 10_000, watchdogMs: 10_000 } });
    expect(refusal(o)).toMatchObject({ kind: "memory" });
  });

  test("small-object growth stops at the heap limit too", async () => {
    // Here the heap is too full for QuickJS to build its own out-of-memory error.
    // Compute limits are lifted so a loaded test machine cannot turn this into a cpu refusal.
    const o = await ts("const a: object[] = []; for (;;) a.push({ x: a.length });", { limits: { guestCpuMs: 10_000, watchdogMs: 10_000 } });
    expect(refusal(o).kind).toBe("memory");
  });

  test("a string doubling loop ends at QuickJS's string length limit (raw)", async () => {
    // QuickJS concatenates into ropes, so doubling reaches the length cap before it allocates the heap.
    const o = await raw(`let s = "x"; for (;;) s = s + s;`);
    expect(refusal(o)).toMatchObject({ kind: "guestError", detail: expect.stringContaining("string too long") });
  });

  test("the WASM memory cap holds when the heap limit is set above it", async () => {
    const o = await raw(`const a = []; for (;;) a.push(new Array(100000).fill(1));`, { limits: { heapBytes: 512 * 1024 * 1024, guestCpuMs: 10_000, watchdogMs: 10_000 } });
    expect(refusal(o).kind).toBe("memory");
  });

  test("deep recursion stops at the stack limit", async () => {
    const o = await ts("const f = (n: number): number => f(n + 1) + 1; f(0);");
    expect(refusal(o).kind).toBe("stack");
  });

  test("recursion inside builtins and the parser stops at the stack limit (raw)", async () => {
    const parse = await raw(`(0, Function)("return " + "[".repeat(100000) + "]".repeat(100000))();`);
    expect(refusal(parse).kind).toBe("stack");
    const json = await raw(`JSON.parse("[".repeat(100000));`);
    expect(refusal(json).kind).toBe("stack");
  });

  test("the watchdog stops a native builtin the interrupt hook cannot reach (raw)", async () => {
    // JSON.stringify runs in C without checking the interrupt; 50,000 levels took 2.7 s in the probe.
    const o = await raw(`let o = {}; for (let i = 0; i < 5e4; i++) o = { o }; JSON.stringify(o);`);
    expect(refusal(o)).toMatchObject({ kind: "cpu", detail: expect.stringContaining("watchdog") });
    expect(o.stats.wallMs).toBeLessThan(2500);
  });
});

describe("host callbacks", () => {
  test("a hanging choose callback is aborted and the run ends at the callback deadline", async () => {
    let signal: AbortSignal | undefined;
    const hang: ChooserPort = (req) => {
      signal = req.signal;
      return new Promise(() => {}); // never settles and ignores the signal
    };
    const t0 = performance.now();
    const o = await ts(`const w = await caret.readWindow(); await caret.choose(w.questions[0]!.options.map((o) => o.ref)); ${plain()}`, { limits: { callbackMs: 300 } }, hang);
    expect(refusal(o).kind).toBe("deadline");
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(signal?.aborted).toBe(true);
  });

  test("the wall clock ends a run whose callback outlives it", async () => {
    const o = await ts(`const w = await caret.readWindow(); await caret.choose(w.questions[0]!.options.map((o) => o.ref)); ${plain()}`, { limits: { wallMs: 400 } }, () => new Promise(() => {}));
    expect(refusal(o).kind).toBe("deadline");
  });

  test("a caller's abort cancels a run waiting on a callback", async () => {
    const ac = new AbortController();
    let signal: AbortSignal | undefined;
    const run = ts(`const w = await caret.readWindow(); await caret.choose(w.questions[0]!.options.map((o) => o.ref)); ${plain()}`, { signal: ac.signal }, (req) => {
      signal = req.signal;
      setTimeout(() => ac.abort(), 20);
      return new Promise(() => {});
    });
    expect(refusal(await run).kind).toBe("cancelled");
    expect(signal?.aborted).toBe(true);
  });

  test("a promise nothing will settle is a deadlock, not a hang (raw)", async () => {
    const o = await raw(`await new Promise(() => {}); ${plain()}`);
    expect(refusal(o).kind).toBe("deadlock");
  });

  test("a failing callback refuses the run", async () => {
    const o = await ts(`const w = await caret.readWindow(); await caret.choose(w.questions[0]!.options.map((o) => o.ref)); ${plain()}`, {}, async () => {
      throw new Error("Jev HTTP 500");
    });
    expect(refusal(o)).toMatchObject({ kind: "callbackError", detail: expect.stringContaining("Jev HTTP 500") });
  });

  test("a callback answer outside the offered options is refused", async () => {
    const o = await ts(`const w = await caret.readWindow(); await caret.choose(w.questions[0]!.options.map((o) => o.ref)); ${plain()}`, {}, async () => "o:other");
    expect(refusal(o).kind).toBe("callbackError");
  });

  test("only one planning run is live at a time", async () => {
    let release: (v: string | null) => void = () => {};
    let waiting: () => void = () => {};
    const called = new Promise<void>((r) => (waiting = r));
    const slow = ts(`const w = await caret.readWindow(); await caret.choose(w.questions[0]!.options.map((o) => o.ref)); ${plain()}`, {}, () =>
      new Promise((r) => {
        release = r;
        waiting();
      }),
    );
    await called;
    const second = await ts(plain());
    expect(refusal(second).kind).toBe("busy");
    release("o:tue");
    expect((await slow).ok).toBe(true);
  });
});

describe("huge and over-budget host calls", () => {
  test("a ref argument millions of characters long is refused before it is copied", async () => {
    const o = await ts(`const w = await caret.readWindow(); caret.fill("t:name".padEnd(5000000, "x"), "v:name"); ${plain()}`);
    expect(refusal(o)).toMatchObject({ kind: "violation", detail: expect.stringContaining("5000000 characters") });
  });

  test("choose with more than 64 options is refused by its length alone", async () => {
    const o = await ts(`await caret.readWindow(); await caret.choose(Array(1000000).fill("o:tue")); ${plain()}`);
    expect(refusal(o)).toMatchObject({ kind: "violation", detail: expect.stringContaining("1000000 entries") });
  });

  test("call and step budgets", async () => {
    expect(refusal(await ts(`for (let i = 0; i < 5; i++) await caret.readWindow(); ${plain()}`)).detail).toContain("readWindow calls");
    expect(refusal(await ts(`const w = await caret.readWindow(); for (let i = 0; i < 25; i++) caret.press("t:next", "e:next-page"); ${plain()}`)).detail).toContain("at most 24 steps");
    expect(refusal(await ts(`const w = await caret.readWindow(); caret.ask("q:session"); caret.ask("q:session"); ${plain()}`)).detail).toContain("at most 1 ask");
    expect(
      refusal(await ts(`const w = await caret.readWindow(); for (let i = 0; i < 5; i++) await caret.choose(["o:tue", "o:wed"]); ${plain()}`)).detail,
    ).toContain("choose calls");
    expect(refusal(await ts(`const w = await caret.readWindow(); caret.waitFor("e:next-page", 1e9); ${plain()}`)).detail).toContain("timeoutMs");
  });

  test("an oversize program is refused before parsing", async () => {
    const o = await ts(`const pad = "${"x".repeat(17 * 1024)}"; ${plain()}`);
    expect(refusal(o).kind).toBe("source");
  });

  test("an oversize host snapshot is refused before the worker starts", async () => {
    const big = { ...FORM, values: Array.from({ length: 200 }, (_, i) => ({ ref: `v:big${i}`, display: "y".repeat(400), origin: { kind: "memory" as const, entryId: "e", fileRevision: "r", digest: "d" } })) };
    const o = await runCodePlan(CANNED_PROGRAM, [big, MAIL], pickFirst);
    expect(refusal(o).kind).toBe("input");
  });
});

describe("refs", () => {
  test("an unknown target ref is refused", async () => {
    expect(refusal(await ts(`const w = await caret.readWindow(); caret.fill("t:password", "v:name"); ${plain()}`))).toMatchObject({ kind: "violation", detail: expect.stringContaining("unknown target t:password") });
  });

  test("a cast does not mint a ref: a real ref is unknown until readWindow issued it", async () => {
    const o = await ts(`caret.fill("t:name" as TargetRef, "v:name" as ValueRef); ${plain()}`);
    expect(refusal(o).detail).toContain("unknown target t:name");
    const unread = await ts(`const w = await caret.readWindow(); caret.fill("t:name", "v:name"); ${plain()}`);
    expect(refusal(unread).detail).toContain("unknown value v:name"); // MAIL was never read
  });

  test("a refusal stands even when the program catches the error", async () => {
    const o = await ts(`const w = await caret.readWindow(); try { caret.fill("t:nope", "v:nope"); } catch {} ${plain()}`);
    expect(refusal(o).kind).toBe("violation");
  });

  test("forged steps, foreign targets, unknown windows and mixed option groups are refused", async () => {
    expect(refusal(await ts(`const w = await caret.readWindow(); return caret.plan({ basedOn: w.snapshot, steps: ["step:9" as StepRef] });`)).detail).toContain("unknown step step:9");
    expect(
      refusal(await ts(`const w = await caret.readWindow(); const m = await caret.readWindow("win:mail"); return caret.plan({ basedOn: w.snapshot, steps: [caret.press("t:reply", "e:compose")] });`)).detail,
    ).toContain("outside snapshot snap:form:1");
    expect(refusal(await ts(`await caret.readWindow("win:bank"); ${plain()}`)).detail).toContain("unknown window win:bank");
    expect(refusal(await ts(`const w = await caret.readWindow(); caret.press("t:next", "e:delete-all"); ${plain()}`)).detail).toContain("no allowed press effect");
    expect(refusal(await ts(`const w = await caret.readWindow(); await caret.choose(["o:tue", "t:name"]); ${plain()}`)).detail).toContain("not in question q:session");
    expect(refusal(await ts(`const w = await caret.readWindow(); return caret.plan({ basedOn: "snap:mail:1", steps: [caret.press("t:next", "e:next-page")] });`)).detail).toContain("not a snapshot this program read");
  });

  test("main must return what plan() returned, and every registered step must be in it", async () => {
    expect(refusal(await ts(`const w = await caret.readWindow(); return { basedOn: w.snapshot, steps: [caret.press("t:next", "e:next-page")] } as any;`)).detail).toContain("must return the result of caret.plan");
    expect(
      refusal(await ts(`const w = await caret.readWindow(); const a = caret.press("t:next", "e:next-page"); caret.fill("t:name", "v:name" as ValueRef); return caret.plan({ basedOn: w.snapshot, steps: [a] });`)).kind,
    ).toBe("violation");
  });
});

describe("imports and network", () => {
  test("static import, dynamic import and import.meta are refused at compile time", async () => {
    expect(refusal(await runCodePlan(`import fs from "node:fs";\nasync function main(caret: any) {}`, SNAPS, pickFirst))).toMatchObject({ kind: "source", detail: expect.stringContaining("import") });
    expect(refusal(await ts(`await import("node:fs"); ${plain()}`))).toMatchObject({ kind: "source", detail: expect.stringContaining("dynamic import") });
    expect(refusal(await ts(`const u = import.meta.url; ${plain()}`)).kind).toBe("source");
    expect(refusal(await ts(`const r = require("node:fs"); ${plain()}`)).detail).toContain("require is not available");
  });

  test("dynamic import fails inside QuickJS itself: there is no module loader (raw)", async () => {
    const direct = await raw(`await import("node:fs"); ${plain()}`);
    expect(refusal(direct).kind).toBe("guestError");
    const hidden = await raw(`await (0, Function)("return import('node:child_process')")(); ${plain()}`);
    expect(refusal(hidden).kind).toBe("guestError");
  });

  describe("network probe", () => {
    let server: Server;
    let hits = 0;
    let url = "";
    beforeAll(async () => {
      server = createServer((_req, res) => {
        hits++;
        res.end("reached");
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    test("fetch, XMLHttpRequest, require and a hidden import cannot reach a local server (raw)", async () => {
      const probes = [
        `await fetch("${url}");`,
        `new XMLHttpRequest().open("GET", "${url}");`,
        `require("node:http").get("${url}");`,
        `await (0, Function)("return import('node:http')")();`,
        `new WebSocket("${url.replace("http", "ws")}");`,
      ];
      for (const p of probes) {
        const o = await raw(`${p} ${plain()}`);
        expect(refusal(o).kind).toBe("guestError");
      }
      expect(hits).toBe(0);
    });

    test("the same probes are refused by the shape check before they run", async () => {
      expect(refusal(await ts(`await fetch("${url}"); ${plain()}`)).kind).toBe("source");
      expect(refusal(await ts(`new XMLHttpRequest(); ${plain()}`)).kind).toBe("source");
      expect(hits).toBe(0);
    });
  });
});

// Regressions for the boundary review of 2026-10-04 (theo-astra-reviewer, findings 1-7).
describe("review regressions", () => {
  test("a huge error message or thrown string is not copied out of the guest", async () => {
    const big = await raw(`throw new Error("out of memory " + "x".repeat(1000000));`);
    expect(refusal(big).detail.length).toBeLessThanOrEqual(500);
    expect(refusal(big).detail).toContain("not copied");
    const str = await raw(`throw "y".repeat(1000000);`);
    expect(refusal(str).detail.length).toBeLessThanOrEqual(500);
  });

  test("replacing Promise.resolve or JSON.parse does not break or reach readWindow", async () => {
    const o = await raw(`Promise.resolve = () => { throw "z".repeat(1000000); }; JSON.parse = () => ({}); ${plain()}`);
    if (!o.ok) throw new Error(`${o.kind}: ${o.detail}`);
  });

  test("an immediate choose reply does not leave the watchdog paused", async () => {
    const o = await raw(
      `const w = await caret.readWindow(); const opts = w.questions[0].options.map((o) => o.ref);
       await Promise.all([caret.choose(opts), caret.choose(opts), caret.choose(opts)]);
       let o = {}; for (let i = 0; i < 5e4; i++) o = { o }; JSON.stringify(o); ${plain()}`,
    );
    expect(refusal(o).kind).toBe("cpu");
    expect(o.stats.wallMs).toBeLessThan(2500);
  });

  test("a native call that finishes past the compute budget is refused, not accepted", async () => {
    const o = await raw(`JSON.stringify(Array(300000).fill("abc")); ${plain()}`, { limits: { guestCpuMs: 1, watchdogMs: 10_000 } });
    expect(refusal(o).kind).toBe("cpu");
  });

  test("returning while a choose is unanswered is refused, and the callback is aborted", async () => {
    let signal: AbortSignal | undefined;
    const o = await raw(`const w = await caret.readWindow(); caret.choose(w.questions[0].options.map((o) => o.ref)); ${plain()}`, {}, (req) => {
      signal = req.signal;
      return new Promise(() => {});
    });
    expect(refusal(o).detail).toContain("still unanswered");
    expect(signal?.aborted).toBe(true);
  });

  test("choose must offer the whole question, in the host's order", async () => {
    let offered: string[] = [];
    expect(refusal(await raw(`const w = await caret.readWindow(); await caret.choose(["o:wed"]); ${plain()}`)).detail).toContain("choose takes all 2 options");
    const o = await raw(`const w = await caret.readWindow(); await caret.choose(["o:wed", "o:tue"]); ${plain()}`, {}, async ({ options }) => {
      offered = options.map((x) => x.ref);
      return null;
    });
    expect(o.ok).toBe(true);
    expect(offered).toEqual(["o:tue", "o:wed"]);
  });

  test("a chooser that throws synchronously is a callback error, not an uncaught exception", async () => {
    const o = await raw(`const w = await caret.readWindow(); await caret.choose(w.questions[0].options.map((o) => o.ref)); ${plain()}`, {}, () => {
      throw new Error("sync boom");
    });
    expect(refusal(o)).toMatchObject({ kind: "callbackError", detail: expect.stringContaining("sync boom") });
  });

  test("plan() is not reentrant through getters, and no step can follow it", async () => {
    const reentrant = await raw(`const w = await caret.readWindow(); const s = caret.press("t:next", "e:next-page");
      const draft = { basedOn: w.snapshot, get steps() { caret.plan({ basedOn: w.snapshot, steps: [s] }); return [s]; } };
      return caret.plan(draft);`);
    expect(refusal(reentrant).detail).toContain("plan was called again");
    const after = await raw(`const w = await caret.readWindow(); const s = caret.press("t:next", "e:next-page");
      const p = caret.plan({ basedOn: w.snapshot, steps: [s] }); try { caret.press("t:next", "e:next-page"); } catch {} return p;`);
    expect(refusal(after).detail).toContain("after plan()");
  });

  test("a getter on main cannot run outside the compute budget", async () => {
    const o = await runProgramJs(`Object.defineProperty(globalThis, "main", { get() { for (;;) {} } });`, "raw", SNAPS, pickFirst);
    expect(refusal(o).kind).toBe("cpu");
    expect(o.stats.wallMs).toBeLessThan(1500);
  });

  test("a getter on a thrown value cannot start a Jev call while the run is ending", async () => {
    let calls = 0;
    const o = await raw(`await caret.readWindow(); throw { get name() { caret.choose(["o:tue", "o:wed"]); return "Error"; }, message: "failed" };`, {}, async () => {
      calls++;
      return null;
    });
    expect(refusal(o).kind).toBe("guestError");
    expect(calls).toBe(0);
  });

  test("replies answered out of order still resume the watchdog", async () => {
    // The second choose is answered first; the worker then runs native code past the watchdog.
    const resolvers: ((v: string | null) => void)[] = [];
    const o = await raw(
      `const w = await caret.readWindow(); const opts = w.questions[0].options.map((o) => o.ref);
       await Promise.all([caret.choose(opts), caret.choose(opts)]);
       let o = {}; for (let i = 0; i < 5e4; i++) o = { o }; JSON.stringify(o); ${plain()}`,
      {},
      () =>
        new Promise<string | null>((r) => {
          resolvers.push(r);
          if (resolvers.length === 2) {
            resolvers[1]!(null);
            setTimeout(() => resolvers[0]!(null), 50);
          }
        }),
    );
    expect(refusal(o).kind).toBe("cpu");
    expect(o.stats.wallMs).toBeLessThan(2500);
  });
});
