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
import { PlanningSnapshotSchema, WorkerMessage, ZERO_STATS, type ChooseReply, type PlanningSnapshot, type RefusalKind, type SandboxOutcome, type WorkerInput } from "./types.ts";

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
}

const WORKER_URL = new URL("./worker.ts", import.meta.url);

/** One planning worker at a time (plan section 5). A second run while one is live is refused, not queued. */
let active = false;

const refuse = (kind: RefusalKind, detail: string, wallMs = 0): SandboxOutcome => ({ ok: false, kind, detail, stats: { ...ZERO_STATS, wallMs } });

/** Checks the host's own snapshots: schema, unique refs, and the size of each readWindow result. */
function checkSnapshots(raw: readonly unknown[], limits: SandboxLimits): PlanningSnapshot[] | string {
  if (raw.length === 0) return "no snapshot to plan against";
  const out: PlanningSnapshot[] = [];
  const seen = new Set<string>();
  const windows = new Set<string>();
  for (const r of raw) {
    const parsed = PlanningSnapshotSchema.safeParse(r);
    if (!parsed.success) return `snapshot does not match the schema: ${parsed.error.message.slice(0, 300)}`;
    const s = parsed.data;
    if (windows.has(s.window)) return `two snapshots for window ${s.window}`;
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
  return out;
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
  const snaps = checkSnapshots(snapshots, limits);
  if (typeof snaps === "string") return refuse("input", snaps);
  if (active) return refuse("busy", "another planning run is live");
  active = true;
  try {
    return await runWorker({ js, programDigest, snapshots: snaps, limits }, choose, opts.signal);
  } finally {
    active = false;
  }
}

function runWorker(input: WorkerInput, choose: ChooserPort, signal: AbortSignal | undefined): Promise<SandboxOutcome> {
  const { limits } = input;
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
    signal?.addEventListener("abort", onAbort, { once: true });

    worker.on("message", (raw: unknown) => {
      if (settled) return;
      const parsed = WorkerMessage.safeParse(raw);
      if (!parsed.success) return end(refuse("fault", `malformed worker message: ${parsed.error.message.slice(0, 200)}`));
      const m = parsed.data;
      if (m.type === "done") return end(m.outcome);
      // A reply already in flight means the worker will run again: pause only when it has seen them all.
      if (m.type === "waiting") return m.consumed === sent ? pause() : undefined;
      const remaining = limits.wallMs - elapsed();
      const budget = Math.max(0, Math.min(limits.callbackMs, remaining));
      const controller = new AbortController();
      callbacks.add(controller);
      const timer = setTimeout(() => {
        controller.abort(new Error("choose timed out"));
        end(refuse("deadline", `choose did not return within ${Math.round(budget)} ms`));
      }, budget);
      timers.add(timer);
      const reply = (r: ChooseReply) => {
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
