import { assertNoExcludedValue } from "../privacy.ts";
// The helper's side of apps/local-model (caret-local-model, G1): one child process that loaded a GGUF once and
// answers grammar-constrained completions, one JSON object per line each way (apps/local-model/README.md). Requests
// go one at a time; the answers come back in order. Nothing here retries: a failure is the caller's to report.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import * as z from "zod";

const Memory = z.object({ residentMB: z.number(), footprintMB: z.number(), peakFootprintMB: z.number(), peakResidentMB: z.number() }).strict();
export type LocalMemory = z.infer<typeof Memory>;

const Ready = z.object({ ready: z.literal(true), model: z.string(), loadMs: z.number(), nCtx: z.number().int(), memory: Memory }).strict();
const NotReady = z.object({ ready: z.literal(false), error: z.string() }).strict();
const Completion = z
  .object({
    id: z.string(),
    ok: z.literal(true),
    text: z.string(),
    stop: z.enum(["eog", "maxTokens"]),
    prefixTokens: z.number().int(),
    prefixCached: z.boolean(),
    promptTokens: z.number().int(),
    outputTokens: z.number().int(),
    ms: z.object({ prefix: z.number(), prompt: z.number(), decode: z.number(), total: z.number() }).strict(),
    memory: Memory,
  })
  .strict();
const Failure = z.object({ id: z.string().nullable(), ok: z.literal(false), error: z.string() }).strict();

export type LocalCompletion = z.infer<typeof Completion>;

export interface LocalRequest {
  /** Shared text whose decoded state the tool keeps between requests (the few-shot block). */
  prefix: string;
  prompt: string;
  /** GBNF with a `root` rule: the only language the text can be in. */
  grammar: string;
  maxTokens: number;
}

export interface LocalModelTool {
  /** The GGUF's file name, as the tool reported it. */
  readonly model: string;
  readonly loadMs: number;
  readonly memoryAtLoad: LocalMemory;
  complete(req: LocalRequest, signal?: AbortSignal): Promise<LocalCompletion>;
  /** Ends input, waits for the tool to exit (it frees the model first), and resolves with its exit code. */
  close(): Promise<number | null>;
  /**
   * The last 2,000 characters the tool wrote to stderr, for a debugger only: it may echo a prompt, so no error, warning,
   * log or store ever carries it (PV2, the lead's ruling).
   */
  stderrForDebugger(): string;
}

/** What went wrong with the tool, worked out inside this module; the only account of a failure that leaves it. */
export type LocalModelFailure = "crash" | "outOfMemory" | "modelMissing" | "timeout" | "refused" | "protocol" | "notRunnable";

const FAILURE_SAYS: Record<LocalModelFailure, string> = {
  crash: "the local model stopped",
  outOfMemory: "the local model ran out of memory",
  modelMissing: "the local model's file could not be loaded",
  timeout: "the local model did not answer in time",
  refused: "the local model refused the request",
  protocol: "the local model broke its protocol",
  notRunnable: "the local model could not be started",
};

/**
 * The tool failed, said no, or broke the protocol: `failure` says which, in Caret's words, with an exit status or a
 * request id at most. No text the tool wrote (its stderr, an error line, a model's text) is ever in it: a tool can echo a
 * prompt there.
 */
export class LocalModelError extends Error {
  readonly failure: LocalModelFailure;
  constructor(failure: LocalModelFailure, detail = "") {
    super(`${FAILURE_SAYS[failure]}${detail === "" ? "" : ` (${detail})`}`);
    this.name = "LocalModelError";
    this.failure = failure;
  }
}

/** A failure read from what the tool wrote, inside this module only: the words, never carried further. */
function classify(text: string): LocalModelFailure {
  if (/out of memory|\bOOM\b|failed to allocate|cannot allocate|ENOMEM/iu.test(text)) return "outOfMemory";
  if (/no such file|not found|ENOENT|failed to load model|unable to load model|invalid model/iu.test(text)) return "modelMissing";
  return "crash";
}

export interface LocalModelOptions {
  binary: string;
  modelPath: string;
  contextLength?: number;
  /** For tests: what to run instead of `binary --model PATH --ctx N`. */
  spawnFn?: () => ChildProcess;
  /** How long loading may take. A cold read of a 3.4 GB file took 10 s on the dev Mac (G1 smoke run). */
  loadTimeoutMs?: number;
}

/** Starts the tool and waits for its Ready line. */
export async function startLocalModel(o: LocalModelOptions): Promise<LocalModelTool> {
  const child = o.spawnFn?.() ?? spawn(o.binary, ["--model", o.modelPath, "--ctx", String(o.contextLength ?? 4096)], { stdio: ["pipe", "pipe", "pipe"] });
  const stdin = child.stdin;
  const stdout = child.stdout;
  if (stdin === null || stdout === null) throw new LocalModelError("notRunnable", "no pipes");
  // A write after the tool died raises EPIPE here; the exit handler below is what reports it.
  stdin.on("error", () => undefined);
  let stderrTail = "";
  child.stderr?.on("data", (b: Buffer) => {
    stderrTail = (stderrTail + b.toString("utf8")).slice(-2000);
  });
  const lines = createInterface({ input: stdout, crlfDelay: Infinity });
  const waiting: { resolve: (line: string) => void; reject: (e: Error) => void }[] = [];
  const early: string[] = [];
  let ended: Error | null = null;
  lines.on("line", (line) => {
    const w = waiting.shift();
    if (w === undefined) early.push(line);
    else w.resolve(line);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code, sig) => {
      ended = new LocalModelError(classify(stderrTail), sig ?? `exit code ${code}`);
      for (const w of waiting.splice(0)) w.reject(ended);
      resolve(code);
    });
    child.on("error", (e) => {
      ended = new LocalModelError("notRunnable", (e as NodeJS.ErrnoException).code ?? "");
      for (const w of waiting.splice(0)) w.reject(ended);
      resolve(null);
    });
  });
  const nextLine = (): Promise<string> => {
    const l = early.shift();
    if (l !== undefined) return Promise.resolve(l);
    if (ended !== null) return Promise.reject(ended);
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };
  const parse = (line: string): unknown => {
    try {
      return JSON.parse(line);
    } catch {
      throw new LocalModelError("protocol", `a line that is not JSON, ${line.length} chars`);
    }
  };

  const loadTimeout = o.loadTimeoutMs ?? 60_000;
  let timer: NodeJS.Timeout | undefined;
  const first = await Promise.race([
    nextLine(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LocalModelError("timeout", `loading, ${loadTimeout} ms`)), loadTimeout);
    }),
  ]).finally(() => clearTimeout(timer));
  const head = parse(first);
  const notReady = NotReady.safeParse(head);
  if (notReady.success) throw new LocalModelError(classify(notReady.data.error) === "crash" ? "modelMissing" : classify(notReady.data.error), "loading");
  const ready = Ready.safeParse(head);
  if (!ready.success) throw new LocalModelError("protocol", "no Ready line");

  let seq = 0;
  // One request at a time: each waits for the one before it, so answers pair with requests by order and id.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    model: ready.data.model,
    loadMs: ready.data.loadMs,
    memoryAtLoad: ready.data.memory,
    complete(req, signal) {
      assertNoExcludedValue({ input: { prefix: req.prefix, prompt: req.prompt } });
      const id = `r${++seq}`;
      const run = async (): Promise<LocalCompletion> => {
        signal?.throwIfAborted();
        if (ended !== null) throw ended;
        stdin.write(JSON.stringify({ id, prefix: req.prefix, prompt: req.prompt, grammar: req.grammar, maxTokens: req.maxTokens }) + "\n");
        // An abort cannot stop the tool mid-request; the answer is read and dropped so the next pairs correctly.
        const body = parse(await nextLine());
        const f = Failure.safeParse(body);
        if (f.success) throw new LocalModelError("refused", `request ${id}`);
        const c = Completion.safeParse(body);
        if (!c.success) throw new LocalModelError("protocol", `request ${id}: not a completion`);
        if (c.data.id !== id) throw new LocalModelError("protocol", `request ${id}: answered out of turn`);
        signal?.throwIfAborted();
        return c.data;
      };
      const p = queue.then(run, run);
      queue = p.catch(() => undefined);
      return p;
    },
    async close() {
      stdin.end();
      return exited;
    },
    stderrForDebugger: () => stderrTail,
  };
}
