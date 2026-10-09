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
import { requestDigest, stepKey, type ChooseRequest, type ChoiceRecord, type HostReply, type ObserveRequest, type PendingObserve, type PlanStep, type PlanningSnapshot, type ProgramDraft, type RefusalKind, type RunStats, type SandboxOutcome, type WorkerInput } from "./types.ts";

/** A step as an API call describes it, before the registry gives it a ref. */
type StepBody = { [K in PlanStep["kind"]]: Omit<Extract<PlanStep, { kind: K }>, "ref"> }[PlanStep["kind"]];

/** A rule the program broke. Recorded once; the run is refused even if the guest catches the error. */
class Violation extends Error {}

/** A replay that went another way than the run it replays (CU-COUNSEL-R2 D4). Latched like a violation. */
class Diverged extends Error {}

if (parentPort === null) throw new Error("codemode worker started outside a worker thread");
const port = parentPort;
const input = workerData as WorkerInput;
const limits = input.limits;
/** The steps a run before this one registered and the host then executed: each step registered here must match its own. */
const prefix = input.recorded.prefix;

// Replies from the parent, consumed in order by the pump loop. `consumed` lets the parent tell a
// "waiting" message from a worker that has not yet seen a reply already in flight.
const replies: HostReply[] = [];
let consumed = 0;
let wake: (() => void) | null = null;
port.on("message", (m: HostReply) => {
  replies.push(m);
  wake?.();
});

const stats: Omit<RunStats, "wallMs"> = { guestCpuMs: 0, readWindowCalls: 0, chooseCalls: 0, steps: 0 };
let sliceStart: number | null = null;
let cpuExceeded = false;
let violation: string | null = null;
/** A replayed step that differs from the recorded one (Diverged). */
let diverged: string | null = null;
/** A bug on the host side of an API call, as opposed to a rule the program broke. */
let hostFault: string | null = null;

const latched = (): boolean => hostFault !== null || violation !== null || diverged !== null || cpuExceeded;

function interrupt(): boolean {
  if (violation !== null || hostFault !== null || diverged !== null) return true;
  if (sliceStart !== null && stats.guestCpuMs + (performance.now() - sliceStart) > limits.guestCpuMs) cpuExceeded = true;
  return cpuExceeded;
}

/**
 * Runs anything that can execute guest code (a call, a job, a property read that may hit a getter) and
 * charges it to the compute budget. The interrupt hook only fires between bytecodes, so a native builtin
 * can finish past the budget; the total is checked again when the slice ends.
 */
function slice<T>(fn: () => T): T {
  sliceStart = performance.now();
  try {
    return fn();
  } finally {
    stats.guestCpuMs += performance.now() - sliceStart;
    sliceStart = null;
    if (stats.guestCpuMs > limits.guestCpuMs) cpuExceeded = true;
  }
}

/** Longest detail a refusal carries out of the worker. */
const DETAIL_CHARS = 500;
const cap = (s: string) => (s.length <= DETAIL_CHARS ? s : `${s.slice(0, DETAIL_CHARS - 1)}…`);

/** Classifies an error that came out of the guest or out of a QuickJS call. Our own flags win. */
function classify(name: string, message: string): [RefusalKind, string] {
  if (hostFault !== null) return ["fault", hostFault];
  if (diverged !== null) return ["diverged", diverged];
  if (violation !== null) return ["violation", violation];
  if (cpuExceeded) return ["cpu", `guest compute passed ${limits.guestCpuMs} ms`];
  if (/out of memory/i.test(message)) return ["memory", cap(`${name}: ${message}`)];
  // When the heap is too full to build the out-of-memory error itself, QuickJS raises an exception with
  // no value, which reads as a thrown null. A heap at its limit has grown the WASM memory past its
  // initial size, so the two together are reported as memory.
  if (name === "null" && qjs.getWasmMemory().buffer.byteLength > INITIAL_BYTES) return ["memory", "exception with no value after the heap grew; QuickJS ran out of memory building the error"];
  if (/stack overflow|maximum call stack/i.test(message)) return ["stack", cap(`${name}: ${message}`)];
  return ["guestError", cap(`${name}: ${message}`)];
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
const drafts: ProgramDraft[] = [];
let asks = 0;
let plan: { ref: string; basedOn: string; steps: PlanStep[] } | null = null;
/** Set while plan() reads its argument, whose getters can call back into the API. */
let planning = false;
/** Set while the host reads a thrown value; its getters must not start API work such as a Jev call. */
let readingError = false;

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

/**
 * Registers a step. A step at an index the recorded prefix covers must equal the recorded one, field for field, or the
 * run ends as diverged before it can ask Jev anything new (CU-COUNSEL-R2 D4). The per-run step budget counts only the
 * steps after the prefix.
 */
function addStep(step: StepBody): string {
  if (plan !== null || planning) throw new Violation("no steps can be added after plan()");
  const k = steps.size;
  if (k >= prefix.length && k - prefix.length >= limits.steps) throw new Violation(`a plan has at most ${limits.steps} steps`);
  const ref = `step:${k + 1}`;
  const made = { ...step, ref } as PlanStep;
  const recorded = prefix[k];
  if (recorded !== undefined && stepKey(made) !== stepKey(recorded)) throw new Diverged(`step ${k + 1} is ${stepKey(made)}, but the run it replays registered ${stepKey(recorded)}`);
  steps.set(ref, made);
  stats.steps = Math.max(0, steps.size - prefix.length);
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

// Helpers written by the host and bound before the program runs, so a program that replaces JSON.parse,
// Object.freeze or Promise.resolve only changes its own view. Clocks, randomness and eval are removed.
// This is host code, so it is not charged to the program's compute budget.
const prelude = (() =>
  vm.evalCode(
    `(() => {
      const parse = JSON.parse, freeze = Object.freeze, keys = Object.keys, resolve = Promise.resolve.bind(Promise);
      const deep = (v) => { if (v !== null && typeof v === "object") { for (const k of keys(v)) deep(v[k]); freeze(v); } return v; };
      for (const name of ["Date", "eval", "Atomics", "SharedArrayBuffer", "WeakRef", "FinalizationRegistry"]) delete globalThis[name];
      delete Math.random;
      return freeze({ view: (s) => resolve(deep(parse(s))) });
    })()`,
    "prelude.js",
  ))();
const helpers = vm.unwrapResult(prelude);
const viewFn = vm.getProp(helpers, "view");

type PendingCall = { kind: "choose"; deferred: QuickJSDeferredPromise; question: string; offered: string[]; digest: string } | { kind: "observe"; deferred: QuickJSDeferredPromise; ref: string; after: string; index: number };
const pending = new Map<number, PendingCall>();
let nextCallId = 0;
/** choose() calls made, recorded ones included: the first recorded.choices.length are answered from the record. */
let chooseIndex = 0;
/** observe() calls made. */
let observeIndex = 0;

/** An API body returns a handle, or a guest call's result whose error passes through to the guest. */
type Impl = (...args: QuickJSHandle[]) => QuickJSHandle | { error: QuickJSHandle };

/** Wraps an API function: a Violation is recorded and thrown into the guest, and the guest is interrupted. */
function api(name: string, impl: Impl): QuickJSHandle {
  return vm.newFunction(name, (...args) => {
    if (readingError) return { error: vm.newError(`${name}: the API is closed while the run is ending`) };
    try {
      return impl(...args);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof Violation) violation ??= `${name}: ${message}`;
      else if (e instanceof Diverged) diverged ??= `${name}: ${message}`;
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
      // An error here (out of memory, an interrupt) goes back to the guest as thrown, unread by the host.
      return r.error !== undefined ? { error: r.error } : r.value;
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
    "navigate",
    api("navigate", (t, e) => {
      if (!input.navigation) throw new Violation("this plan cannot navigate");
      const target = refArg(t, "target");
      const effect = refArg(e, "effect");
      const found = targets.get(target);
      if (found === undefined) throw new Violation(`unknown target ${target}`);
      if (!(found.target.allowedNavigateEffects ?? []).includes(effect)) throw new Violation(`target ${target} has no allowed navigate effect ${effect}`);
      return vm.newString(addStep({ kind: "navigate", target, effect }));
    }),
  ],
  [
    "observe",
    api("observe", (a) => {
      if (!input.navigation) throw new Violation("this plan cannot observe");
      if (plan !== null || planning) throw new Violation("no observe can be made after plan()");
      const after = refArg(a, "after");
      const last = [...steps.values()].at(-1);
      if (last === undefined || last.ref !== after || last.kind !== "navigate") throw new Violation(`observe takes the navigate step created just before it, not ${after}`);
      if ([...pending.values()].some((c) => c.kind === "observe")) throw new Violation("one observe at a time");
      const index = observeIndex++;
      const ref = addStep({ kind: "observe", after });
      const callId = nextCallId++;
      const request: ObserveRequest = { type: "observe", callId, after, index };
      const deferred = vm.newPromise();
      pending.set(callId, { kind: "observe", deferred, ref, after, index });
      port.postMessage(request);
      return deferred.handle.dup();
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
      // A recorded choice is answered from the record and counts toward no budget (CU-COUNSEL-R2 D4).
      const replayed = chooseIndex++ < input.recorded.choices.length;
      if (!replayed && ++stats.chooseCalls > limits.chooseCalls) throw new Violation(`at most ${limits.chooseCalls} choose calls`);
      const given = refArrayArg(o, "options", limits.optionsPerChoice);
      if (given.length === 0) throw new Violation("options is empty");
      if (new Set(given).size !== given.length) throw new Violation("options repeat a ref");
      // The options name one host-owned question group, and must be all of it: Jev gets that group's
      // question and every option in the host's order, so a program cannot narrow or reorder the choice.
      let group: { snapshot: PlanningSnapshot; question: PlanningSnapshot["questions"][number] } | undefined;
      for (const q of questions.values()) if (q.question.options.some((x) => x.ref === given[0])) group = q;
      if (group === undefined) throw new Violation(`unknown option ${given[0]}`);
      const all = group.question.options;
      for (const ref of given) if (!all.some((x) => x.ref === ref)) throw new Violation(`option ${ref} is not in question ${group.question.ref}`);
      if (given.length !== all.length) throw new Violation(`choose takes all ${all.length} options of question ${group.question.ref}, not ${given.length}`);
      const offered = all.map((x) => x.ref);
      const callId = nextCallId++;
      const request: ChooseRequest = {
        type: "choose",
        callId,
        window: group.snapshot.window,
        question: { ref: group.question.ref, text: group.question.text },
        options: all.map((x) => ({ ref: x.ref, label: x.label })),
      };
      const deferred = vm.newPromise();
      pending.set(callId, { kind: "choose", deferred, question: group.question.ref, offered, digest: requestDigest(request) });
      port.postMessage(request);
      return deferred.handle.dup();
    }),
  ],
  [
    "draft",
    api("draft", (t, f) => {
      if (!input.drafts) throw new Violation("this plan cannot draft text");
      if (plan !== null || planning) throw new Violation("no drafts can be added after plan()");
      if (drafts.length >= limits.drafts) throw new Violation(`a plan has at most ${limits.drafts} drafts`);
      if (t === undefined || vm.typeof(t) !== "string") throw new Violation("text must be a string");
      const len = stringLength(t);
      if (len > limits.draftCopyChars) throw new Violation(`text is ${len} characters long; a draft is far shorter`);
      const text = vm.getString(t);
      const from = refArrayArg(f, "from", limits.draftBasis);
      // The basis is what the program read: a window it called readWindow on, or a value one of those listed.
      const read = new Set([...issuedSnapshots.values()].map((x) => x.window));
      for (const ref of from) if (!read.has(ref) && !values.has(ref)) throw new Violation(`from names ${ref}, which is not a window or value this program read`);
      const ref = `d${drafts.length + 1}`;
      drafts.push({ ref, text, from });
      values.add(ref);
      return vm.newString(ref);
    }),
  ],
  [
    "plan",
    api("plan", (d) => {
      if (plan !== null) throw new Violation("plan was already called");
      if (planning) throw new Violation("plan was called again while reading its argument");
      if (d === undefined || vm.typeof(d) !== "object") throw new Violation("plan takes { basedOn, steps }");
      let basedOn: string;
      let order: string[];
      // Reading the argument can run guest getters, which could call the API; `planning` refuses that.
      planning = true;
      try {
        const b = vm.getProp(d, "basedOn");
        try {
          basedOn = refArg(b, "basedOn");
        } finally {
          b.dispose();
        }
        const s = vm.getProp(d, "steps");
        try {
          order = refArrayArg(s, "steps", limits.steps + prefix.length);
        } finally {
          s.dispose();
        }
      } finally {
        planning = false;
      }
      const snap = issuedSnapshots.get(basedOn);
      if (snap === undefined) throw new Violation(`basedOn ${basedOn} is not a snapshot this program read`);
      if (order.length === 0) throw new Violation("a plan needs at least one step");
      if (new Set(order).size !== order.length) throw new Violation("a step appears twice");
      // An observe step's ref is never handed to the program: each goes right after the navigate it reads after.
      const observes = [...steps.values()].filter((x): x is Extract<PlanStep, { kind: "observe" }> => x.kind === "observe");
      const ordered: PlanStep[] = [];
      for (const ref of order) {
        const step = steps.get(ref);
        if (step === undefined || step.kind === "observe") throw new Violation(`unknown step ${ref}`);
        ordered.push(step);
        const read = observes.find((x) => x.after === ref);
        if (read !== undefined) ordered.push(read);
      }
      if (ordered.length !== steps.size) throw new Violation(`the plan leaves out ${steps.size - ordered.length} registered step(s)`);
      // The executed prefix ran in the order it was registered; a plan that reorders it is not the run it replays.
      for (const [k, x] of prefix.entries()) if (ordered[k]?.ref !== x.ref) throw new Diverged(`the plan puts ${ordered[k]?.ref ?? "nothing"} at ${k + 1}, where the run it replays ran ${x.ref}`);
      // One accepted segment is one window: targets and effects must come from the basedOn snapshot. A goal plan
      // (multiWindow) may target any snapshot this program read; the host cuts its steps into segments.
      const readable = input.multiWindow ? [...issuedSnapshots.values()] : [snap];
      const own = new Set(readable.flatMap((x) => x.targets.map((t) => t.ref)));
      const effects = new Set(readable.flatMap((x) => x.targets.flatMap((t) => t.allowedPressEffects)));
      const where = input.multiWindow ? "the snapshots this program read" : `snapshot ${basedOn}`;
      for (const step of ordered) {
        if ((step.kind === "fill" || step.kind === "press" || step.kind === "navigate") && !own.has(step.target)) throw new Violation(`${step.ref} targets ${step.target}, outside ${where}`);
        if (step.kind === "waitFor" && !effects.has(step.effect)) throw new Violation(`${step.ref} waits for ${step.effect}, outside ${where}`);
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

/** Longest guest string copied out to describe an error; QuickJS's own messages are far shorter. */
const ERROR_TEXT_CHARS = 300;

/** A guest string, or a note of its length when it is too long to copy. */
function shortString(h: QuickJSHandle): string {
  const n = stringLength(h);
  return n <= ERROR_TEXT_CHARS ? vm.getString(h) : `(${n} characters, not copied)`;
}

/**
 * Name and message of a thrown value, read property by property with every string length checked first,
 * never serialized whole. Inside a slice, because a property read can run a guest getter.
 */
function errorOf(h: QuickJSHandle): [string, string] {
  readingError = true;
  return slice(() => {
    try {
      const t = vm.typeof(h);
      if (t === "undefined" || vm.sameValue(h, vm.null)) return [t === "undefined" ? "undefined" : "null", "the exception carried no value"];
      if (t === "string") return ["Error", shortString(h)];
      if (t !== "object" && t !== "function") return ["Error", `a thrown ${t}`];
      const read = (key: string): string => {
        const p = vm.getProp(h, key);
        try {
          return vm.typeof(p) === "string" ? shortString(p) : "";
        } finally {
          p.dispose();
        }
      };
      return [read("name") || "Error", read("message")];
    } catch {
      return ["Error", "(the error could not be read)"];
    } finally {
      readingError = false;
    }
  });
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
port.postMessage({ type: "done", outcome: outcome.ok ? outcome : { ...outcome, detail: cap(outcome.detail) } });

async function run(): Promise<SandboxOutcome> {
  /**
   * `pending`: the host asked the run to end at an observe it may not serve yet. The plan is then every step registered
   * before that observe, in registration order, which is the order they run in (CU-COUNSEL-R2 D4).
   */
  const done = (o: { ok: true; plan: NonNullable<typeof plan>; pending?: PendingObserve } | { ok: false; kind: RefusalKind; detail: string }): SandboxOutcome => {
    const s = { wallMs: 0, ...stats };
    if (!o.ok) return { ok: false, kind: o.kind, detail: cap(o.detail), stats: s };
    // Last check before success: every flag a slice or API call can latch, and the plan still covers
    // every registered step.
    if (latched()) {
      const [kind, detail] = classify("Error", "");
      return { ok: false, kind, detail: cap(detail), stats: s };
    }
    if (o.plan.steps.length !== steps.size - (o.pending === undefined ? 0 : 1)) return { ok: false, kind: "violation", detail: "steps were registered after plan()", stats: s };
    return { ok: true, plan: { basedOn: o.plan.basedOn, window: issuedSnapshots.get(o.plan.basedOn)!.window, steps: o.plan.steps, choices, drafts, programDigest: input.programDigest }, stats: s, pending: o.pending ?? null };
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
  mainFn = slice(() => vm.getProp(vm.global, "main"));
  if (latched()) return fail("Error", "");
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
    if (latched()) return fail("Error", "");

    const state = vm.getPromiseState(promise);
    if (state.type === "fulfilled") {
      const v = state.value;
      try {
        if (state.notAPromise === true) return done({ ok: false, kind: "violation", detail: "main must be async" });
        // The only acceptable result is the ref plan() returned; compare without copying anything large.
        const matches = plan !== null && vm.typeof(v) === "string" && stringLength(v) === plan.ref.length && vm.getString(v) === plan.ref;
        if (!matches) return done({ ok: false, kind: "violation", detail: "main must return the result of caret.plan(...)" });
        if (pending.size > 0) return done({ ok: false, kind: "violation", detail: "main returned while a choose or observe call was still unanswered" });
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
    if (replies.length === 0) port.postMessage({ type: "waiting", consumed });
    while (replies.length === 0) await new Promise<void>((r) => (wake = r));
    wake = null;
    const reply = replies.shift()!;
    consumed++;
    const call = pending.get(reply.callId);
    if (call === undefined) return done({ ok: false, kind: "fault", detail: `reply for unknown call ${reply.callId}` });
    pending.delete(reply.callId);
    if (call.kind === "observe") {
      if (reply.type === "observeEnd") {
        call.deferred.dispose();
        if (pending.size > 0) return done({ ok: false, kind: "violation", detail: "observe ended the run while a choose call was still unanswered" });
        const registered = [...steps.values()].filter((x) => x.ref !== call.ref);
        return done({ ok: true, plan: { ref: "plan:pending", basedOn: first.snapshot, steps: registered }, pending: { ref: call.ref, after: call.after, index: call.index } });
      }
      if (reply.type !== "observeResult") {
        call.deferred.dispose();
        return done({ ok: false, kind: "fault", detail: `observe call ${reply.callId} got a ${reply.type} reply` });
      }
      // A recorded observation: its refs are the guest's from now on, as a readWindow result's are.
      issue(reply.snapshot);
      const json = vm.newString(guestView(reply.snapshot));
      const view = slice(() => vm.callFunction(viewFn, vm.undefined, json));
      json.dispose();
      if (view.error !== undefined) {
        call.deferred.reject(view.error);
        view.error.dispose();
      } else {
        call.deferred.resolve(view.value);
        view.value.dispose();
      }
      call.deferred.dispose();
      continue;
    }
    if (reply.type !== "chooseResult" && reply.type !== "chooseError") {
      call.deferred.dispose();
      return done({ ok: false, kind: "fault", detail: `choose call ${reply.callId} got a ${reply.type} reply` });
    }
    if (reply.type === "chooseError") {
      call.deferred.dispose();
      return done({ ok: false, kind: reply.kind, detail: reply.message });
    }
    if (reply.chosen !== null && !call.offered.includes(reply.chosen)) {
      call.deferred.dispose();
      return done({ ok: false, kind: "callbackError", detail: `choose returned ${reply.chosen}, which was not offered` });
    }
    choices.push({ question: call.question, offered: call.offered, chosen: reply.chosen, requestDigest: call.digest });
    const value = reply.chosen === null ? vm.null : vm.newString(reply.chosen);
    call.deferred.resolve(value);
    if (reply.chosen !== null) value.dispose();
    call.deferred.dispose();
  }
}
