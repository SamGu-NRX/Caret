// One disposable planning run: a fresh QuickJS/WASM module with a capped linear memory, one runtime and one
// context, the program, and the plan API. The parent (sandbox.ts) owns the wall clock, host callbacks and
// termination; this thread owns the guest's compute budget and the run's ref registry. It exits after
// one run, so nothing a program does can reach a later one.
//
// The guest gets standard ECMAScript built-ins minus clocks, randomness and eval, plus one argument: the
// `caret` API object. API functions only check refs and record steps; nothing here touches a window.
import { parentPort, workerData } from "node:worker_threads";
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle, QuickJSRuntime } from "quickjs-emscripten-core";
import { INITIAL_BYTES, newCappedModule } from "./quickjs.ts";
import type { ChooseReply, ChooseRequest, ChoiceRecord, PlanStep, PlanningSnapshot, RefusalKind, RunStats, SandboxOutcome, WorkerInput } from "./types.ts";

/** A step as an API call describes it, before the registry gives it a ref. */
type StepBody = { [K in PlanStep["kind"]]: Omit<Extract<PlanStep, { kind: K }>, "ref"> }[PlanStep["kind"]];

/** A rule the program broke. Recorded once; the run is refused even if the guest catches the error. */
class Violation extends Error {}

if (parentPort === null) throw new Error("codemode worker started outside a worker thread");
const port = parentPort;
const input = workerData as WorkerInput;
const limits = input.limits;

// Replies from the parent, consumed in order by the pump loop.
const replies: ChooseReply[] = [];
let wake: (() => void) | null = null;
port.on("message", (m: ChooseReply) => {
  replies.push(m);
  wake?.();
});

const stats: Omit<RunStats, "wallMs"> = { guestCpuMs: 0, readWindowCalls: 0, chooseCalls: 0, steps: 0 };
let sliceStart: number | null = null;
let cpuExceeded = false;
let violation: string | null = null;
/** A bug on the host side of an API call, as opposed to a rule the program broke. */
let hostFault: string | null = null;

function interrupt(): boolean {
  if (violation !== null || hostFault !== null) return true;
  if (sliceStart !== null && stats.guestCpuMs + (performance.now() - sliceStart) > limits.guestCpuMs) cpuExceeded = true;
  return cpuExceeded;
}

/** Runs guest code and charges the time to the compute budget. Host callbacks are not inside slices. */
function slice<T>(fn: () => T): T {
  sliceStart = performance.now();
  try {
    return fn();
  } finally {
    stats.guestCpuMs += performance.now() - sliceStart;
    sliceStart = null;
  }
}

/** Classifies an error that came out of the guest or out of a QuickJS call. Our own flags win. */
function classify(name: string, message: string): [RefusalKind, string] {
  if (hostFault !== null) return ["fault", hostFault];
  if (violation !== null) return ["violation", violation];
  if (cpuExceeded) return ["cpu", `guest compute passed ${limits.guestCpuMs} ms`];
  if (/out of memory/i.test(message)) return ["memory", `${name}: ${message}`];
  // When the heap is too full to build the out-of-memory error itself, QuickJS raises an exception with
  // no value, which reads as a thrown null. A heap at its limit has grown the WASM memory past its
  // initial size, so the two together are reported as memory.
  if (name === "null" && qjs.getWasmMemory().buffer.byteLength > INITIAL_BYTES) return ["memory", "exception with no value after the heap grew; QuickJS ran out of memory building the error"];
  if (/stack overflow|maximum call stack/i.test(message)) return ["stack", `${name}: ${message}`];
  return ["guestError", `${name}: ${message}`.slice(0, 500)];
}

// ---- Registry: what this run has issued to the guest -------------------------------------------------

const byWindow = new Map<string, PlanningSnapshot>();
for (const s of input.snapshots) byWindow.set(s.window, s);
const first = input.snapshots[0]!;

const issuedSnapshots = new Map<string, PlanningSnapshot>();
const targets = new Map<string, { snapshot: PlanningSnapshot; target: PlanningSnapshot["targets"][number] }>();
const values = new Set<string>();
const questions = new Map<string, { snapshot: PlanningSnapshot; question: PlanningSnapshot["questions"][number] }>();
const steps = new Map<string, PlanStep>();
const choices: ChoiceRecord[] = [];
let asks = 0;
let plan: { ref: string; basedOn: string; steps: PlanStep[] } | null = null;

function issue(s: PlanningSnapshot): void {
  issuedSnapshots.set(s.snapshot, s);
  for (const t of s.targets) targets.set(t.ref, { snapshot: s, target: t });
  for (const v of s.values) values.add(v.ref);
  for (const q of s.questions) questions.set(q.ref, { snapshot: s, question: q });
}

/** What readWindow hands the guest: the snapshot without anything only the host needs. */
function guestView(s: PlanningSnapshot): string {
  return JSON.stringify({
    snapshot: s.snapshot,
    window: s.window,
    revision: s.revision,
    title: s.title,
    targets: s.targets,
    values: s.values,
    questions: s.questions,
  });
}

function addStep(step: StepBody): string {
  if (steps.size >= limits.steps) throw new Violation(`a plan has at most ${limits.steps} steps`);
  const ref = `step:${steps.size + 1}`;
  steps.set(ref, { ...step, ref } as PlanStep);
  stats.steps = steps.size;
  return ref;
}

// ---- QuickJS setup ------------------------------------------------------------------------------------

const qjs = await newCappedModule(limits.wasmMemoryBytes);
const rt: QuickJSRuntime = qjs.newRuntime();
rt.setMemoryLimit(limits.heapBytes);
rt.setMaxStackSize(limits.stackBytes);
rt.setInterruptHandler(interrupt);
rt.removeModuleLoader();
const vm: QuickJSContext = rt.newContext();

/** Length of a guest string, read without copying the string out. */
function stringLength(h: QuickJSHandle): number {
  const lenHandle = vm.getProp(h, "length");
  const len = vm.getNumber(lenHandle);
  lenHandle.dispose();
  return len;
}

/** Reads a ref string argument, refusing a non-string or an oversize one before copying it out. */
function refArg(h: QuickJSHandle | undefined, what: string): string {
  if (h === undefined || vm.typeof(h) !== "string") throw new Violation(`${what} must be a ref string`);
  const len = stringLength(h);
  if (len > limits.refChars) throw new Violation(`${what} is ${len} characters long; a ref is at most ${limits.refChars}`);
  return vm.getString(h);
}

/** Reads an array of ref strings without trusting its size: length first, then each element. */
function refArrayArg(h: QuickJSHandle | undefined, what: string, max: number): string[] {
  if (h === undefined || vm.typeof(h) !== "object") throw new Violation(`${what} must be an array of refs`);
  const lenHandle = vm.getProp(h, "length");
  const lenType = vm.typeof(lenHandle);
  const len = lenType === "number" ? vm.getNumber(lenHandle) : -1;
  lenHandle.dispose();
  if (!Number.isInteger(len) || len < 0) throw new Violation(`${what} must be an array of refs`);
  if (len > max) throw new Violation(`${what} has ${len} entries; the limit is ${max}`);
  const out: string[] = [];
  for (let i = 0; i < len; i++) {
    const el = vm.getProp(h, String(i));
    try {
      out.push(refArg(el, `${what}[${i}]`));
    } finally {
      el.dispose();
    }
  }
  return out;
}

// Helpers written by the host and captured before the program runs, so a program that replaces
// JSON.parse or Promise only changes its own view. Clocks, randomness and eval are removed.
const prelude = slice(() =>
  vm.evalCode(
    `(() => {
      const parse = JSON.parse, freeze = Object.freeze, keys = Object.keys, P = Promise;
      const deep = (v) => { if (v !== null && typeof v === "object") { for (const k of keys(v)) deep(v[k]); freeze(v); } return v; };
      for (const name of ["Date", "eval", "Atomics", "SharedArrayBuffer", "WeakRef", "FinalizationRegistry"]) delete globalThis[name];
      delete Math.random;
      return freeze({ view: (s) => P.resolve(deep(parse(s))) });
    })()`,
    "prelude.js",
  ),
);
const helpers = vm.unwrapResult(prelude);
const viewFn = vm.getProp(helpers, "view");

const pending = new Map<number, { deferred: QuickJSDeferredPromise; question: string; offered: string[] }>();
let nextCallId = 0;

type Impl = (...args: QuickJSHandle[]) => QuickJSHandle;

/** Wraps an API function: a Violation is recorded and thrown into the guest, and the guest is interrupted. */
function api(name: string, impl: Impl): QuickJSHandle {
  return vm.newFunction(name, (...args) => {
    try {
      return impl(...args);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof Violation) violation ??= `${name}: ${message}`;
      else hostFault ??= `${name}: host error: ${message}`;
      return { error: vm.newError(`${name}: ${message}`) };
    }
  });
}

const caret = vm.newObject();
const fns: [string, QuickJSHandle][] = [
  [
    "readWindow",
    api("readWindow", (w) => {
      if (++stats.readWindowCalls > limits.readWindowCalls) throw new Violation(`at most ${limits.readWindowCalls} readWindow calls`);
      let s = first;
      if (w !== undefined && vm.typeof(w) !== "undefined") {
        const ref = refArg(w, "window");
        const found = byWindow.get(ref);
        if (found === undefined) throw new Violation(`unknown window ${ref}`);
        s = found;
      }
      issue(s);
      const json = vm.newString(guestView(s));
      const r = vm.callFunction(viewFn, vm.undefined, json);
      json.dispose();
      return vm.unwrapResult(r);
    }),
  ],
  [
    "fill",
    api("fill", (t, v) => {
      const target = refArg(t, "target");
      const value = refArg(v, "value");
      const found = targets.get(target);
      if (found === undefined) throw new Violation(`unknown target ${target}`);
      if (!found.target.canFill) throw new Violation(`target ${target} cannot be filled`);
      if (!values.has(value)) throw new Violation(`unknown value ${value}`);
      return vm.newString(addStep({ kind: "fill", target, value }));
    }),
  ],
  [
    "press",
    api("press", (t, e) => {
      const target = refArg(t, "target");
      const effect = refArg(e, "effect");
      const found = targets.get(target);
      if (found === undefined) throw new Violation(`unknown target ${target}`);
      if (!found.target.allowedPressEffects.includes(effect)) throw new Violation(`target ${target} has no allowed press effect ${effect}`);
      return vm.newString(addStep({ kind: "press", target, effect }));
    }),
  ],
  [
    "waitFor",
    api("waitFor", (e, ms) => {
      const effect = refArg(e, "effect");
      let known = false;
      for (const { target } of targets.values()) if (target.allowedPressEffects.includes(effect)) known = true;
      if (!known) throw new Violation(`unknown effect ${effect}`);
      const timeoutMs = ms !== undefined && vm.typeof(ms) === "number" ? vm.getNumber(ms) : Number.NaN;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > limits.waitForMs) throw new Violation(`timeoutMs must be a number in (0, ${limits.waitForMs}]`);
      return vm.newString(addStep({ kind: "waitFor", effect, timeoutMs }));
    }),
  ],
  [
    "ask",
    api("ask", (q) => {
      const question = refArg(q, "question");
      if (!questions.has(question)) throw new Violation(`unknown question ${question}`);
      if (++asks > limits.asks) throw new Violation(`a plan has at most ${limits.asks} ask`);
      return vm.newString(addStep({ kind: "ask", question }));
    }),
  ],
  [
    "choose",
    api("choose", (o) => {
      if (++stats.chooseCalls > limits.chooseCalls) throw new Violation(`at most ${limits.chooseCalls} choose calls`);
      const offered = refArrayArg(o, "options", limits.optionsPerChoice);
      if (offered.length === 0) throw new Violation("options is empty");
      if (new Set(offered).size !== offered.length) throw new Violation("options repeat a ref");
      // Every option must come from one host-owned question group; Jev gets that group's question.
      let group: { snapshot: PlanningSnapshot; question: PlanningSnapshot["questions"][number] } | undefined;
      for (const q of questions.values()) if (q.question.options.some((x) => x.ref === offered[0])) group = q;
      if (group === undefined) throw new Violation(`unknown option ${offered[0]}`);
      const labels = new Map(group.question.options.map((x) => [x.ref, x.label]));
      for (const ref of offered) if (!labels.has(ref)) throw new Violation(`option ${ref} is not in question ${group.question.ref}`);
      const callId = nextCallId++;
      const request: ChooseRequest = {
        type: "choose",
        callId,
        window: group.snapshot.window,
        question: { ref: group.question.ref, text: group.question.text },
        options: offered.map((ref) => ({ ref, label: labels.get(ref)! })),
      };
      const deferred = vm.newPromise();
      pending.set(callId, { deferred, question: group.question.ref, offered });
      port.postMessage(request);
      return deferred.handle.dup();
    }),
  ],
  [
    "plan",
    api("plan", (d) => {
      if (plan !== null) throw new Violation("plan was already called");
      if (d === undefined || vm.typeof(d) !== "object") throw new Violation("plan takes { basedOn, steps }");
      const b = vm.getProp(d, "basedOn");
      const s = vm.getProp(d, "steps");
      let basedOn: string;
      let order: string[];
      try {
        basedOn = refArg(b, "basedOn");
        order = refArrayArg(s, "steps", limits.steps);
      } finally {
        b.dispose();
        s.dispose();
      }
      const snap = issuedSnapshots.get(basedOn);
      if (snap === undefined) throw new Violation(`basedOn ${basedOn} is not a snapshot this program read`);
      if (order.length === 0) throw new Violation("a plan needs at least one step");
      if (new Set(order).size !== order.length) throw new Violation("a step appears twice");
      const ordered: PlanStep[] = [];
      for (const ref of order) {
        const step = steps.get(ref);
        if (step === undefined) throw new Violation(`unknown step ${ref}`);
        ordered.push(step);
      }
      if (ordered.length !== steps.size) throw new Violation(`the plan leaves out ${steps.size - ordered.length} registered step(s)`);
      // One accepted segment is one window: targets and effects must come from the basedOn snapshot.
      const own = new Set(snap.targets.map((t) => t.ref));
      const effects = new Set(snap.targets.flatMap((t) => t.allowedPressEffects));
      for (const step of ordered) {
        if ((step.kind === "fill" || step.kind === "press") && !own.has(step.target)) throw new Violation(`${step.ref} targets ${step.target}, outside snapshot ${basedOn}`);
        if (step.kind === "waitFor" && !effects.has(step.effect)) throw new Violation(`${step.ref} waits for ${step.effect}, outside snapshot ${basedOn}`);
      }
      plan = { ref: "plan:1", basedOn, steps: ordered };
      return vm.newString(plan.ref);
    }),
  ],
];
for (const [name, fn] of fns) {
  vm.setProp(caret, name, fn);
  fn.dispose();
}
const freezeObj = vm.getProp(vm.global, "Object");
const freezeFn = vm.getProp(freezeObj, "freeze");
vm.unwrapResult(vm.callFunction(freezeFn, freezeObj, caret)).dispose();
freezeFn.dispose();
freezeObj.dispose();

// ---- Run ------------------------------------------------------------------------------------------------

function errorOf(h: QuickJSHandle): [string, string] {
  try {
    const d = vm.dump(h) as { name?: unknown; message?: unknown } | string;
    if (typeof d === "object" && d !== null) return [String(d.name ?? "Error"), String(d.message ?? "")];
    if (d === null || d === undefined) return [String(d), "the exception carried no value"];
    return ["Error", String(d)];
  } catch (e) {
    return ["Error", `(error could not be read: ${(e as Error).message})`];
  }
}

function disposeAll(...hs: (QuickJSHandle | undefined)[]): void {
  for (const d of pending.values()) d.deferred.dispose();
  pending.clear();
  for (const h of hs) if (h?.alive) h.dispose();
  viewFn.dispose();
  helpers.dispose();
  caret.dispose();
  vm.dispose();
  rt.dispose();
}

let mainFn: QuickJSHandle | undefined;
let promise: QuickJSHandle | undefined;
let outcome: SandboxOutcome;
try {
  outcome = await run();
  try {
    disposeAll(mainFn, promise);
  } catch (e) {
    // Disposal asserts that no QuickJS object leaked. The outcome is settled; a success becomes a fault.
    if (outcome.ok) outcome = { ok: false, kind: "fault", detail: `runtime disposal failed: ${(e as Error).message}`, stats: outcome.stats };
  }
} catch (e) {
  // A host-level failure inside a QuickJS call, such as V8's own stack overflow in WASM frames or an
  // Emscripten abort. The module is unusable after this, so it is not disposed; the parent terminates
  // the thread, which releases the WASM memory with it.
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const [kind, detail] = classify("HostError", message);
  outcome = { ok: false, kind: kind === "guestError" ? "fault" : kind, detail, stats: { wallMs: 0, ...stats } };
}
// The parent terminates this thread when it receives "done".
port.postMessage({ type: "done", outcome });

async function run(): Promise<SandboxOutcome> {
  const done = (o: { ok: true; plan: NonNullable<typeof plan> } | { ok: false; kind: RefusalKind; detail: string }): SandboxOutcome => {
    const s = { wallMs: 0, ...stats };
    if (!o.ok) return { ok: false, kind: o.kind, detail: o.detail, stats: s };
    return { ok: true, plan: { basedOn: o.plan.basedOn, window: issuedSnapshots.get(o.plan.basedOn)!.window, steps: o.plan.steps, choices, programDigest: input.programDigest }, stats: s };
  };
  const fail = (name: string, message: string) => {
    const [kind, detail] = classify(name, message);
    return done({ ok: false, kind, detail });
  };

  const evaluated = slice(() => vm.evalCode(input.js, "program.js"));
  if (evaluated.error !== undefined) {
    const [n, m] = errorOf(evaluated.error);
    evaluated.error.dispose();
    return fail(n, m);
  }
  evaluated.value.dispose();
  mainFn = vm.getProp(vm.global, "main");
  if (vm.typeof(mainFn) !== "function") return done({ ok: false, kind: "violation", detail: "the program does not define main" });
  const called = slice(() => vm.callFunction(mainFn!, vm.undefined, caret));
  if (called.error !== undefined) {
    const [n, m] = errorOf(called.error);
    called.error.dispose();
    return fail(n, m);
  }
  promise = called.value;

  for (;;) {
    const jobs = slice(() => rt.executePendingJobs());
    if (jobs.error !== undefined) {
      const [n, m] = errorOf(jobs.error);
      jobs.error.dispose();
      return fail(n, m);
    }
    if (hostFault !== null || violation !== null || cpuExceeded) return fail("Error", "");

    const state = vm.getPromiseState(promise);
    if (state.type === "fulfilled") {
      const v = state.value;
      try {
        if (state.notAPromise === true) return done({ ok: false, kind: "violation", detail: "main must be async" });
        // The only acceptable result is the ref plan() returned; compare without copying anything large.
        const matches = plan !== null && vm.typeof(v) === "string" && stringLength(v) === plan.ref.length && vm.getString(v) === plan.ref;
        if (!matches) return done({ ok: false, kind: "violation", detail: "main must return the result of caret.plan(...)" });
        return done({ ok: true, plan: plan! });
      } finally {
        v.dispose();
      }
    }
    if (state.type === "rejected") {
      const [n, m] = errorOf(state.error);
      state.error.dispose();
      return fail(n, m);
    }
    if (pending.size === 0) return done({ ok: false, kind: "deadlock", detail: "main is waiting on a promise that nothing will settle" });

    // Wait for the parent to answer a choose call. The parent enforces the wall clock and terminates
    // this thread if no answer comes.
    if (replies.length === 0) port.postMessage({ type: "waiting" });
    while (replies.length === 0) await new Promise<void>((r) => (wake = r));
    wake = null;
    const reply = replies.shift()!;
    const call = pending.get(reply.callId);
    if (call === undefined) return done({ ok: false, kind: "fault", detail: `reply for unknown call ${reply.callId}` });
    pending.delete(reply.callId);
    if (reply.type === "chooseError") {
      call.deferred.dispose();
      return done({ ok: false, kind: reply.kind, detail: reply.message });
    }
    if (reply.chosen !== null && !call.offered.includes(reply.chosen)) {
      call.deferred.dispose();
      return done({ ok: false, kind: "callbackError", detail: `choose returned ${reply.chosen}, which was not offered` });
    }
    choices.push({ question: call.question, offered: call.offered, chosen: reply.chosen });
    const value = reply.chosen === null ? vm.null : vm.newString(reply.chosen);
    call.deferred.resolve(value);
    if (reply.chosen !== null) value.dispose();
    call.deferred.dispose();
  }
}
