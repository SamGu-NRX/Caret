// Measures plan writers on the ten-case corpus (test/codemode/writer-corpus.ts): latency, tokens, cost,
// whether the program passes the sandbox, and whether the plan matches the expected steps.
//
//   CARET_ENV_FILE=/path/to/.env node scripts/writer-eval.ts --out DIR --models provider:model[,provider:model] [--budget 0.45]
//
// L1: the routes are only those --models names (writer/routes.ts devWriterRoute); none is a default.
//
// Keys are read at call time and never printed. Calls run one at a time, so latency is per request.
// Groq's on-demand tier allows 8,000 tokens a minute for gpt-oss and 1,000 output tokens a minute for
// qwen3.8 (its 429 messages, 2026-10-04), so calls are spaced by --gap seconds, and a 429 waits out the
// provider's Retry-After and retries once. Retries are counted in the report; WriterPort never retries.
// The run stops before a call that could take total spend past --budget (USD), estimated from the
// sealed body's UTF-8 byte count and the full output cap.
import { writeStore, writeStoreJson } from "../src/privacy/send.ts";
import { minted } from "../test/minted.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runCodePlan } from "../src/codemode/sandbox.ts";
import type { DraftPlan } from "../src/codemode/types.ts";
import { ChatHttpError, listModels, type ChatRoute } from "../src/writer/chat.ts";
import { devWriterRoute } from "../src/writer/routes.ts";
import { readKey } from "../src/writer/env.ts";
import { makeWriterPort, writerEstimateUsd } from "../src/writer/port.ts";
import { chatSink } from "../src/writer/chat.ts";
import { seal, sendable } from "../src/privacy/send.ts";
import { PLAN_SYSTEM, PLAN_WORDING, planUserMessage, PlanInputSchema } from "../src/writer/plan-prompt.ts";
import { WRITER_CORPUS, type WriterCase } from "../test/codemode/writer-corpus.ts";

const { values: args } = parseArgs({ options: { out: { type: "string" }, budget: { type: "string", default: "0.45" }, models: { type: "string" }, gap: { type: "string", default: "20" } } });
if (args.out === undefined) throw new Error("--out DIR is required");
const outDir = args.out;
const budget = Number(args.budget);
if (!Number.isFinite(budget) || budget < 0) throw new Error("--budget must be a finite dollar amount at or above zero");
const gapMs = Number(args.gap) * 1000;
// Run 2 refused two qwen3.8 calls as "Request too large" against its 1,000 output-tokens-a-minute limit
// with a 2,000-token cap. The longest reply across runs 1 and 2 was 809 tokens, so 1,000 fits all three.
const MAX_OUTPUT = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let retries = 0;
mkdirSync(outDir, { recursive: true });
if (args.models === undefined) throw new Error("--models provider:model[,...] is required: no writer route is a default (L1)");
const routes = args.models.split(",").map(devWriterRoute);

interface Call {
  model: string;
  route: string;
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

let spent = 0;
let stopped: string | null = null;
function request(c: WriterCase, maxOutputTokens: number) {
  // The plan request shape uses span origins, as codeplan does for memory. Origins never enter the user message.
  const snapshots = c.snapshots.map((s) => ({ ...s, values: s.values.map((v) => v.origin.kind !== "memory" ? v : {
    ...v, origin: { kind: "span" as const, snapshot: s.snapshot, source: "fixture-memory", startUTF16: 0, endUTF16: v.display.length, digest: v.origin.digest },
  }) }));
  return minted({ kind: "plan" as const, disclosureId: "writer-eval", input: { goal: c.goal, snapshots }, maxOutputTokens, signal: AbortSignal.timeout(15_000) });
}
function affordable(route: ChatRoute, c: WriterCase, maxOutputTokens: number): boolean {
  const req = request(c, maxOutputTokens);
  const body = sendable(seal({ writer: req }, chatSink(route, (wire) => [{ role: "system", content: PLAN_SYSTEM }, { role: "user", content: planUserMessage(PlanInputSchema.parse(wire)) }], [PLAN_SYSTEM, ...PLAN_WORDING], maxOutputTokens)));
  return spent + writerEstimateUsd(route, body, maxOutputTokens) <= budget;
}
const gatewayRoute = routes.find((r) => r.provider === "gateway");
const gatewayModels = gatewayRoute === undefined ? [] : await listModels(gatewayRoute, null);
const groqRoute = routes.find((r) => r.provider === "groq");
const groqModels = groqRoute === undefined ? [] : await listModels(groqRoute, readKey(groqRoute.keyName));
log(`gateway lists ${gatewayModels.length} models; groq lists ${groqModels.length}: ${groqModels.join(", ")}`);
let gatewayStatus = "not tried";
if (gatewayRoute !== undefined) {
  if (!affordable(gatewayRoute, WRITER_CORPUS[0]!, 64)) gatewayStatus = "skipped: over --budget";
  else try {
    const w = await makeWriterPort(gatewayRoute).write(request(WRITER_CORPUS[0]!, 64));
    spent += w.costUsd;
    gatewayStatus = `served by ${w.model}, ${Math.round(w.latencyMs)} ms, $${w.costUsd.toFixed(6)}`;
  } catch (e) {
    gatewayStatus = e instanceof ChatHttpError ? `HTTP ${e.status} ${e.errorType ?? ""}: ${e.message.slice(0, 160)}` : String(e).slice(0, 200);
  }
}
log(`gateway completion: ${gatewayStatus}`);

const calls: Call[] = [];
for (const route of routes) {
  const port = makeWriterPort(route, { evaluation: route.provider === "openai" });
  await listModels(route, readKey(route.keyName)); // opens the connection so the first call does not pay for TLS
  for (const c of WRITER_CORPUS) {
    if (!affordable(route, c, MAX_OUTPUT)) {
      stopped = `stopped before ${route.model} / ${c.id}: $${spent.toFixed(4)} spent, budget $${budget}`;
      break;
    }
    const call: Call = { route: JSON.stringify(route), model: route.model, servedModel: null, case: c.id, latencyMs: null, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, valid: false, correct: false, failure: null, program: null };
    if (calls.length > 0) await sleep(gapMs);
    const write = () => {
      if (!affordable(route, c, MAX_OUTPUT)) throw new Error("call refused before send: over --budget");
      return port.write(request(c, MAX_OUTPUT));
    };
    try {
      const w = await write().catch(async (e: unknown) => {
        if (route.provider !== "groq" || !(e instanceof ChatHttpError) || e.status !== 429) throw e;
        retries++;
        await sleep(Math.min(90, e.retryAfterS ?? 30) * 1000 + 1000);
        return write();
      });
      Object.assign(call, { servedModel: w.model, latencyMs: w.latencyMs, inputTokens: w.inputTokens, outputTokens: w.outputTokens, reasoningTokens: w.reasoningTokens, costUsd: w.costUsd, program: w.output.program });
      spent += w.costUsd;
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
  const cs = calls.filter((c) => c.route === JSON.stringify(r));
  const lat = cs.flatMap((c) => (c.latencyMs === null ? [] : [c.latencyMs]));
  const mean = (f: (c: Call) => number) => (cs.length === 0 ? Number.NaN : cs.reduce((n, c) => n + f(c), 0) / cs.length);
  return {
    model: `${r.model}${r.provider === "openai" ? `@${(r.extraBody.reasoning as { effort: string }).effort}` : ""}`,
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
writeStore(join(outDir, "writer-eval.md"), report);
writeStoreJson(join(outDir, "writer-eval.json"), { gatewayStatus, gatewayModelCount: gatewayModels.length, groqModels, rows, calls, spent, retries }, 1);
log(`\n${report}`);
