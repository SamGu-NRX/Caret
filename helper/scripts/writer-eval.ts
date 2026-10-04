// Measures plan writers on the ten-case corpus (test/codemode/writer-corpus.ts): latency, tokens, cost,
// whether the program passes the sandbox, and whether the plan matches the expected steps.
//
//   CARET_ENV_FILE=/path/to/.env node scripts/writer-eval.ts --out DIR [--budget 0.45] [--models a,b]
//
// Keys are read at call time and never printed. Calls run one at a time, so latency is per request.
// Groq's on-demand tier allows 8,000 tokens a minute for gpt-oss and 1,000 output tokens a minute for
// qwen3.8 (its 429 messages, 2026-10-04), so calls are spaced by --gap seconds, and a 429 waits out the
// provider's Retry-After and retries once. Retries are counted in the report; WriterPort never retries.
// The run stops before a call that could take total spend past --budget (USD), estimated from the
// largest cost seen so far.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runCodePlan } from "../src/codemode/sandbox.ts";
import type { DraftPlan } from "../src/codemode/types.ts";
import { ChatHttpError, listModels, type ChatRoute } from "../src/writer/chat.ts";
import { CANDIDATES, GATEWAY_GPT_OSS_120B } from "../src/writer/config.ts";
import { readKey } from "../src/writer/env.ts";
import { makeWriterPort } from "../src/writer/port.ts";
import { WRITER_CORPUS, type WriterCase } from "../test/codemode/writer-corpus.ts";

const { values: args } = parseArgs({ options: { out: { type: "string" }, budget: { type: "string", default: "0.45" }, models: { type: "string" }, gap: { type: "string", default: "20" } } });
if (args.out === undefined) throw new Error("--out DIR is required");
const outDir = args.out;
const budget = Number(args.budget);
const gapMs = Number(args.gap) * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let retries = 0;
mkdirSync(outDir, { recursive: true });
const routes = args.models === undefined ? CANDIDATES : CANDIDATES.filter((r) => args.models!.split(",").includes(r.model));

interface Call {
  model: string;
  servedModel: string | null;
  case: string;
  latencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  valid: boolean;
  correct: boolean;
  failure: string | null;
  program: string | null;
}

function score(plan: DraftPlan, c: WriterCase): boolean {
  const key = (xs: string[][]) => xs.map((x) => x.join("=")).sort().join(";");
  const fills = plan.steps.flatMap((s) => (s.kind === "fill" ? [[s.target, s.value]] : []));
  const presses = plan.steps.flatMap((s) => (s.kind === "press" ? [[s.target, s.effect]] : []));
  const asks = plan.steps.flatMap((s) => (s.kind === "ask" ? [[s.question]] : []));
  return key(fills) === key(c.expected.fills) && key(presses) === key(c.expected.presses) && key(asks) === key(c.expected.asks.map((q) => [q]));
}

/** Nearest-rank percentile. With ten samples p95 is the largest one. */
function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? Number.NaN;
}

const log = (s: string) => process.stdout.write(`${s}\n`);

// 1. What each provider lists today.
const gatewayModels = await listModels(GATEWAY_GPT_OSS_120B, null);
const groqModels = await listModels(CANDIDATES[0]!, readKey("GROQ_API_KEY"));
log(`gateway lists ${gatewayModels.length} models; groq lists ${groqModels.length}: ${groqModels.join(", ")}`);

// 2. Whether the gateway serves completions for this key. A refusal costs nothing.
let gatewayStatus = "not tried";
try {
  const w = await makeWriterPort(GATEWAY_GPT_OSS_120B).write({ kind: "plan", disclosureId: "writer-eval", input: { goal: WRITER_CORPUS[0]!.goal, snapshots: WRITER_CORPUS[0]!.snapshots }, maxOutputTokens: 64, signal: AbortSignal.timeout(10_000) });
  gatewayStatus = `served by ${w.model}, ${Math.round(w.latencyMs)} ms, $${w.costUsd.toFixed(6)}`;
} catch (e) {
  gatewayStatus = e instanceof ChatHttpError ? `HTTP ${e.status} ${e.errorType ?? ""}: ${e.message.slice(0, 160)}` : String(e).slice(0, 200);
}
log(`gateway completion: ${gatewayStatus}`);

// 3. The corpus, model by model.
const calls: Call[] = [];
let spent = 0;
let worst = 0;
let stopped: string | null = null;
for (const route of routes) {
  const port = makeWriterPort(route);
  await listModels(route, readKey(route.keyName)); // opens the connection so the first call does not pay for TLS
  for (const c of WRITER_CORPUS) {
    if (spent + Math.max(worst, 0.01) > budget) {
      stopped = `stopped before ${route.model} / ${c.id}: $${spent.toFixed(4)} spent, budget $${budget}`;
      break;
    }
    const call: Call = { model: route.model, servedModel: null, case: c.id, latencyMs: null, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, valid: false, correct: false, failure: null, program: null };
    if (calls.length > 0) await sleep(gapMs);
    const write = () => port.write({ kind: "plan", disclosureId: "writer-eval", input: { goal: c.goal, snapshots: c.snapshots }, maxOutputTokens: 2000, signal: AbortSignal.timeout(15_000) });
    try {
      const w = await write().catch(async (e: unknown) => {
        if (!(e instanceof ChatHttpError) || e.status !== 429) throw e;
        retries++;
        await sleep(Math.min(90, e.retryAfterS ?? 30) * 1000 + 1000);
        return write();
      });
      Object.assign(call, { servedModel: w.model, latencyMs: w.latencyMs, inputTokens: w.inputTokens, outputTokens: w.outputTokens, reasoningTokens: w.reasoningTokens, costUsd: w.costUsd, program: w.output.program });
      spent += w.costUsd;
      worst = Math.max(worst, w.costUsd);
      if (w.output.program === null) call.failure = `no program in reply: ${w.output.reply.slice(0, 120)}`;
      else {
        const o = await runCodePlan(w.output.program, c.snapshots, async () => c.choose);
        if (o.ok) {
          call.valid = true;
          call.correct = score(o.plan, c);
          if (!call.correct) call.failure = `wrong plan: ${JSON.stringify(o.plan.steps.map((s) => Object.values(s).slice(1).join(" ")))}`;
        } else call.failure = `${o.kind}: ${o.detail}`;
      }
    } catch (e) {
      call.failure = String(e).slice(0, 200);
    }
    calls.push(call);
    log(`${route.model.padEnd(22)} ${c.id.padEnd(22)} ${call.latencyMs === null ? "   -  " : `${Math.round(call.latencyMs)} ms`.padStart(8)} in ${call.inputTokens} out ${call.outputTokens} $${call.costUsd.toFixed(5)} ${call.correct ? "correct" : call.valid ? "valid" : "FAIL"} ${call.failure ?? ""}`);
  }
  if (stopped !== null) break;
}

// 4. Summary.
const rows = routes.map((r: ChatRoute) => {
  const cs = calls.filter((c) => c.model === r.model);
  const lat = cs.flatMap((c) => (c.latencyMs === null ? [] : [c.latencyMs]));
  const mean = (f: (c: Call) => number) => (cs.length === 0 ? Number.NaN : cs.reduce((n, c) => n + f(c), 0) / cs.length);
  return {
    model: r.model,
    provider: r.provider,
    n: cs.length,
    valid: cs.filter((c) => c.valid).length,
    correct: cs.filter((c) => c.correct).length,
    p50Ms: pct(lat, 50),
    p95Ms: pct(lat, 95),
    meanIn: mean((c) => c.inputTokens),
    meanOut: mean((c) => c.outputTokens),
    meanReasoning: mean((c) => c.reasoningTokens),
    meanCostUsd: mean((c) => c.costUsd),
    totalCostUsd: cs.reduce((n, c) => n + c.costUsd, 0),
  };
});
const table = [
  "| model (provider) | n | valid | correct | p50 ms | p95 ms | mean in tok | mean out tok (reasoning) | mean $/plan | total $ |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.model} (${r.provider}) | ${r.n} | ${r.valid} | ${r.correct} | ${Math.round(r.p50Ms)} | ${Math.round(r.p95Ms)} | ${Math.round(r.meanIn)} | ${Math.round(r.meanOut)} (${Math.round(r.meanReasoning)}) | ${r.meanCostUsd.toFixed(5)} | ${r.totalCostUsd.toFixed(4)} |`),
].join("\n");
const report = `# Writer measurement, ${new Date().toISOString()}

Gateway: lists ${gatewayModels.length} models. Completion: ${gatewayStatus}
Groq lists: ${groqModels.join(", ")}

${table}

Total spend: $${spent.toFixed(4)} (budget $${budget}). Rate-limit retries: ${retries}.${stopped === null ? "" : ` ${stopped}`}
Latency is the client's wall time for one HTTP request, sequential, from this Mac. p95 of 10 samples is the slowest one.
`;
writeFileSync(join(outDir, "writer-eval.md"), report);
writeFileSync(join(outDir, "writer-eval.json"), JSON.stringify({ gatewayStatus, gatewayModelCount: gatewayModels.length, groqModels, rows, calls, spent, retries }, null, 1));
log(`\n${report}`);
