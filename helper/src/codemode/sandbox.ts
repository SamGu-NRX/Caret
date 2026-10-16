// Runs one writer program to a draft plan. The program is compiled outside the sandbox (compile.ts), then
// run in a fresh worker thread holding a fresh QuickJS/WASM module (worker.ts). This side owns the wall
// clock, the host callbacks and cancellation: when any of them ends the run, it aborts the callbacks and
// terminates the worker, which takes the WASM memory and every QuickJS handle with it.
//
// Plans stay disabled: nothing here or in the worker touches the executor or a window. The result is a
// DraftPlan of host-issued refs for a later stage to validate, preview and grant.
import { Worker } from "node:worker_threads";
import { compileProgram } from "./compile.ts";
import { DEFAULT_LIMITS, type SandboxLimits } from "./limits.ts";
import { NO_RECORD, PlanningSnapshotSchema, requestDigest, stepKey, WorkerMessage, ZERO_STATS, type HostReply, type PlanStep, type PlanningSnapshot, type Recorded, type RefusalKind, type SandboxOutcome, type WorkerInput } from "./types.ts";

/**
 * Asks Jev (or a test double) to pick one of a host-owned question's options. Returns an offered ref or
 * null for no confident pick. Must stop work when `signal` aborts; the run ends at the deadline whether
 * it does or not.
 */
export type ChooserPort = (req: {
  window: string;
  question: { ref: string; text: string };
  options: readonly { ref: string; label: string }[];
  signal: AbortSignal;
}) => Promise<string | null>;

export interface RunOptions {
  signal?: AbortSignal;
  limits?: Partial<SandboxLimits>;
  /**
   * D2-06: a goal plan's steps may target any window the program read; the host cuts them into segments, one
   * acceptance each (goals/lower.ts). Absent or false keeps D2-05's rule that every step targets the basedOn window.
   */
  multiWindow?: boolean;
  /**
   * B30: the program may write short texts with draft(), each a value ref its fills may name; goals/lower.ts checks
   * them. Absent or false makes draft() a violation, as for every single-window plan.
   */
  drafts?: boolean;
  /** Slice 2: the program may call navigate() and observe(). Absent or false makes both a violation. */
  navigation?: boolean;
  /**
   * Slice 2 (CU-COUNSEL-R2 D4): a replay of an earlier run of the same program. Recorded choices are answered from the
   * record when their request digest matches, recorded observations are served in order, and each step registered at a
   * prefix index must equal the recorded step. `mayObserve` false makes an observe past the record end the run as
   * observeBudget; true makes it end the run as pending.
   */
  replay?: Recorded & { mayObserve: boolean };
}

const WORKER_URL = new URL("./worker.ts", import.meta.url);

/** One planning worker at a time (plan section 5). A second run while one is live is refused, not queued. */
let active = false;

const refuse = (kind: RefusalKind, detail: string, wallMs = 0): SandboxOutcome => ({ ok: false, kind, detail, stats: { ...ZERO_STATS, wallMs } });

/**
 * Checks the host's own snapshots: schema, unique refs, and the size of each readWindow result. `observed`: recorded
 * observations, whose refs must be unique against the snapshots' and each other's, and which may show a window again.
 */
function checkSnapshots(raw: readonly unknown[], limits: SandboxLimits, observed: readonly unknown[] = []): { snapshots: PlanningSnapshot[]; observations: PlanningSnapshot[] } | string {
  if (raw.length === 0) return "no snapshot to plan against";
  const out: PlanningSnapshot[] = [];
  const seen = new Set<string>();
  const windows = new Set<string>();
  for (const [i, r] of [...raw, ...observed].entries()) {
    const parsed = PlanningSnapshotSchema.safeParse(r);
    if (!parsed.success) return `snapshot does not match the schema: ${parsed.error.message.slice(0, 300)}`;
    const s = parsed.data;
    if (i < raw.length && windows.has(s.window)) return `two snapshots for window ${s.window}`;
    windows.add(s.window);
    const refs = [s.snapshot, ...s.targets.map((t) => t.ref), ...s.values.map((v) => v.ref), ...s.questions.map((q) => q.ref), ...s.questions.flatMap((q) => q.options.map((o) => o.ref))];
    for (const ref of refs) {
      if (seen.has(ref)) return `ref ${ref} appears twice across the snapshots`;
      seen.add(ref);
    }
    const bytes = Buffer.byteLength(JSON.stringify(s), "utf8");
    if (bytes > limits.callbackResultBytes) return `snapshot ${s.snapshot} is ${bytes} bytes; a readWindow result is at most ${limits.callbackResultBytes}`;
    out.push(s);
  }
  return { snapshots: out.slice(0, raw.length), observations: out.slice(raw.length) };
}

export async function runCodePlan(source: string, snapshots: readonly unknown[], choose: ChooserPort, opts: RunOptions = {}): Promise<SandboxOutcome> {
  const compiled = compileProgram(source, { ...DEFAULT_LIMITS, ...opts.limits }.sourceBytes);
  if (!compiled.ok) return refuse("source", compiled.detail);
  return runProgramJs(compiled.js, compiled.digest, snapshots, choose, opts);
}

/**
 * Runs JavaScript that compileProgram produced. Exported so the boundary tests can hand QuickJS hostile
 * code the shape check would have refused: the sandbox has to hold without that check.
 */
export async function runProgramJs(js: string, programDigest: string, snapshots: readonly unknown[], choose: ChooserPort, opts: RunOptions = {}): Promise<SandboxOutcome> {
  const limits: SandboxLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  if (opts.signal?.aborted) return refuse("cancelled", "cancelled before the run started");
  if (Buffer.byteLength(js, "utf8") > limits.sourceBytes) return refuse("source", `program is over ${limits.sourceBytes} bytes`);
  const replay = opts.replay;
  const checked = checkSnapshots(snapshots, limits, replay?.observations ?? []);
  if (typeof checked === "string") return refuse("input", checked);
  if (active) return refuse("busy", "another planning run is live");
  active = true;
  try {
    const recorded: Recorded = replay === undefined ? NO_RECORD : { observations: checked.observations, choices: replay.choices, prefix: replay.prefix };
    return await runWorker({ js, programDigest, snapshots: checked.snapshots, limits, multiWindow: opts.multiWindow === true, drafts: opts.drafts === true, navigation: opts.navigation === true, recorded, mayObserve: replay?.mayObserve ?? true }, choose, opts.signal);
  } finally {
    active = false;
  }
}

/**
 * Why a finished run is not the run it replays, or null: its registered steps (the pending observe's included) must
 * start with the recorded prefix, and its choices with the recorded ones. The worker checks both as it goes; this is the
 * host's own check of what came back.
 */
function replayMismatch(o: Extract<SandboxOutcome, { ok: true }>, recorded: Recorded): string | null {
  const registered: PlanStep[] = o.pending === null ? o.plan.steps : [...o.plan.steps, { ref: o.pending.ref, kind: "observe", after: o.pending.after }];
  for (const [k, x] of recorded.prefix.entries()) {
    const got = registered[k];
    if (got === undefined || stepKey(got) !== stepKey(x)) return `step ${k + 1} of the result is not the recorded ${x.ref}`;
  }
  for (const [k, x] of recorded.choices.entries()) {
    const got = o.plan.choices[k];
    if (got === undefined || got.requestDigest !== x.requestDigest || got.chosen !== x.chosen) return `choice ${k + 1} of the result is not the recorded one`;
  }
  return null;
}

function runWorker(input: WorkerInput, choose: ChooserPort, signal: AbortSignal | undefined): Promise<SandboxOutcome> {
  const { limits, recorded } = input;
  /** choose and observe requests the host has answered or is answering, in the order the worker sent them. */
  let chooses = 0;
  let observes = 0;
  const t0 = performance.now();
  const elapsed = () => performance.now() - t0;
  const worker = new Worker(WORKER_URL, {
    workerData: input,
    env: {},
    stdout: true,
    stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: limits.workerHeapMb, maxYoungGenerationSizeMb: 8, stackSizeMb: limits.workerStackMb },
  });
  const callbacks = new Set<AbortController>();
  const timers = new Set<NodeJS.Timeout>();
  /** Replies posted to the worker; its "waiting" message says how many it had consumed. */
  let sent = 0;

  return new Promise<SandboxOutcome>((resolve) => {
    let settled = false;
    const end = (outcome: SandboxOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(wall);
      clearTimeout(watchdog);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      signal?.removeEventListener("abort", onAbort);
      for (const c of callbacks) c.abort(new Error(`run ended: ${outcome.ok ? "done" : outcome.kind}`));
      callbacks.clear();
      outcome.stats.wallMs = elapsed();
      // Terminating stops guest code mid-instruction and frees the thread's WASM memory and handles.
      void worker.terminate().finally(() => resolve(outcome));
    };
    const wall = setTimeout(() => end(refuse("deadline", `the run passed its ${limits.wallMs} ms wall clock`)), limits.wallMs);
    // Watchdog over the time the worker owns: running from spawn, paused while it waits on a reply.
    let ownedMs = 0;
    let ownedSince: number | null = performance.now();
    let watchdog: NodeJS.Timeout | undefined;
    const arm = () => {
      watchdog = setTimeout(() => end(refuse("cpu", `the worker ran ${limits.watchdogMs} ms without waiting; watchdog`)), Math.max(0, limits.watchdogMs - ownedMs));
    };
    const pause = () => {
      if (ownedSince === null) return;
      ownedMs += performance.now() - ownedSince;
      ownedSince = null;
      clearTimeout(watchdog);
    };
    const resume = () => {
      if (ownedSince !== null) return;
      ownedSince = performance.now();
      arm();
    };
    arm();
    const onAbort = () => end(refuse("cancelled", "cancelled by the caller"));
    /** A reply the host has at hand (a recorded choice or observation, or observeEnd), posted as a callback's would be. */
    const post = (r: HostReply): void => {
      if (settled) return;
      sent++;
      resume();
      worker.postMessage(r);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    worker.on("message", (raw: unknown) => {
      if (settled) return;
      const parsed = WorkerMessage.safeParse(raw);
      if (!parsed.success) return end(refuse("fault", `malformed worker message: ${parsed.error.message.slice(0, 200)}`));
      const m = parsed.data;
      if (m.type === "done") {
        const why = m.outcome.ok ? replayMismatch(m.outcome, recorded) : null;
        return end(why === null ? m.outcome : { ok: false, kind: "diverged", detail: why, stats: m.outcome.stats });
      }
      // A reply already in flight means the worker will run again: pause only when it has seen them all.
      if (m.type === "waiting") return m.consumed === sent ? pause() : undefined;
      if (m.type === "observe") {
        // CU-COUNSEL-R2 D4 rule 3: the worker numbers its observes; a recorded one is served, the next one ends the run as
        // pending, unless the goal has taken all it may.
        if (m.index !== observes++) return end(refuse("violation", `observe ${m.index + 1} arrived as the host's ${observes}th`));
        const snapshot = recorded.observations[m.index];
        if (snapshot !== undefined) return post({ type: "observeResult", callId: m.callId, snapshot });
        if (!input.mayObserve) return end(refuse("observeBudget", `the goal took all ${recorded.observations.length} observations it may; observe ${m.index + 1} is one more`));
        return post({ type: "observeEnd", callId: m.callId });
      }
      // CU-COUNSEL-R2 D4 rule 2: a recorded choice is answered from the record, never from Jev, and only for the very
      // request it was made for.
      const n = chooses++;
      const kept = recorded.choices[n];
      if (kept !== undefined) {
        if (requestDigest(m) !== kept.requestDigest) return end(refuse("diverged", `choice ${n + 1} asks another question than the run it replays`));
        return post({ type: "chooseResult", callId: m.callId, chosen: kept.chosen });
      }
      const remaining = limits.wallMs - elapsed();
      const budget = Math.max(0, Math.min(limits.callbackMs, remaining));
      const controller = new AbortController();
      callbacks.add(controller);
      const timer = setTimeout(() => {
        controller.abort(new Error("choose timed out"));
        end(refuse("deadline", `choose did not return within ${Math.round(budget)} ms`));
      }, budget);
      timers.add(timer);
      const reply = (r: HostReply) => {
        clearTimeout(timer);
        timers.delete(timer);
        callbacks.delete(controller);
        if (settled) return;
        sent++;
        resume();
        worker.postMessage(r);
      };
      // Called inside a promise so a chooser that throws synchronously takes the same error path.
      new Promise<unknown>((res) => res(choose({ window: m.window, question: m.question, options: m.options, signal: controller.signal }))).then(
        (chosen: unknown) =>
          reply(
            chosen === null || typeof chosen === "string"
              ? { type: "chooseResult", callId: m.callId, chosen }
              : { type: "chooseError", callId: m.callId, kind: "callbackError", message: "choose returned something other than a ref or null" },
          ),
        (e: unknown) => reply({ type: "chooseError", callId: m.callId, kind: "callbackError", message: `choose failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) }),
      );
    });
    worker.on("error", (e: Error & { code?: string }) => {
      if (e.code === "ERR_WORKER_OUT_OF_MEMORY") end(refuse("memory", `worker heap passed ${limits.workerHeapMb} MB`));
      else end(refuse("fault", `worker error: ${e.message}`.slice(0, 300)));
    });
    worker.on("exit", (code) => end(refuse("fault", `worker exited (${code}) without a result`)));
  });
}
