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

export interface LocalModelPort {
  /** The GGUF's file name, as the tool reported it. */
  readonly model: string;
  readonly loadMs: number;
  readonly memoryAtLoad: LocalMemory;
  complete(req: LocalRequest, signal?: AbortSignal): Promise<LocalCompletion>;
  /** Ends input, waits for the tool to exit (it frees the model first), and resolves with its exit code. */
  close(): Promise<number | null>;
}

/** The tool failed, said no, or broke the protocol. The message says which; a model's text is never in it. */
export class LocalModelError extends Error {}

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
export async function startLocalModel(o: LocalModelOptions): Promise<LocalModelPort> {
  const child = o.spawnFn?.() ?? spawn(o.binary, ["--model", o.modelPath, "--ctx", String(o.contextLength ?? 4096)], { stdio: ["pipe", "pipe", "pipe"] });
  const stdin = child.stdin;
  const stdout = child.stdout;
  if (stdin === null || stdout === null) throw new LocalModelError("the local model's stdin or stdout is not a pipe");
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
      ended = new LocalModelError(`the local model exited (${sig ?? `code ${code}`})${stderrTail.trim() === "" ? "" : `: ${stderrTail.trim().split("\n").at(-1)}`}`);
      for (const w of waiting.splice(0)) w.reject(ended);
      resolve(code);
    });
    child.on("error", (e) => {
      ended = new LocalModelError(`the local model could not run: ${e.message}`);
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
      throw new LocalModelError(`the local model wrote a line that is not JSON (${line.length} chars)`);
    }
  };

  const loadTimeout = o.loadTimeoutMs ?? 60_000;
  let timer: NodeJS.Timeout | undefined;
  const first = await Promise.race([
    nextLine(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LocalModelError(`the local model did not load within ${loadTimeout} ms`)), loadTimeout);
    }),
  ]).finally(() => clearTimeout(timer));
  const head = parse(first);
  const notReady = NotReady.safeParse(head);
  if (notReady.success) throw new LocalModelError(`the local model did not load: ${notReady.data.error}`);
  const ready = Ready.safeParse(head);
  if (!ready.success) throw new LocalModelError(`the local model's first line is not Ready: ${ready.error.issues[0]?.message ?? "invalid"}`);

  let seq = 0;
  // One request at a time: each waits for the one before it, so answers pair with requests by order and id.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    model: ready.data.model,
    loadMs: ready.data.loadMs,
    memoryAtLoad: ready.data.memory,
    complete(req, signal) {
      const id = `r${++seq}`;
      const run = async (): Promise<LocalCompletion> => {
        signal?.throwIfAborted();
        if (ended !== null) throw ended;
        stdin.write(JSON.stringify({ id, prefix: req.prefix, prompt: req.prompt, grammar: req.grammar, maxTokens: req.maxTokens }) + "\n");
        // An abort cannot stop the tool mid-request; the answer is read and dropped so the next pairs correctly.
        const body = parse(await nextLine());
        const f = Failure.safeParse(body);
        if (f.success) throw new LocalModelError(`the local model refused request ${f.data.id ?? "(no id)"}: ${f.data.error}`);
        const c = Completion.safeParse(body);
        if (!c.success) throw new LocalModelError(`the local model's answer is not a completion: ${c.error.issues[0]?.message ?? "invalid"}`);
        if (c.data.id !== id) throw new LocalModelError(`the local model answered ${c.data.id} when ${id} was next`);
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
  };
}
