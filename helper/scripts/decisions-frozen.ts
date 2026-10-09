// Decisions against Jev on identical frozen requests: every Jev request the replay cache recorded for an ask set is sent,
// unchanged, to Decisions, and both answers are written beside the fixture label of each question (decisions-labels.ts)
// for decisions-sweep.ts. The live Ask run (realfill-asks.ts) cannot give this comparison at the current head: its
// requests are not the ones Jev answered on 2026-10-07, so its Jev replay lookups miss.
//
//   node scripts/decisions-frozen.ts --set B24 --max-usd USD --out DIR [--recorded-at PREFIX] [--no-cache] [--dry-run]
// --jev-requests is the original Jev harness request log. Canonical cache entries cannot recover wire order.
// --dry-run lists the matched requests by recording hour with their size, and sends nothing.
//
// Every cache entry is fixture text (cache.ts records only fixture requests). Keys come from OPENAI_API_KEY,
// OPENAI_API_KEY_PERSONAL or CARET_ENV_FILE and are never printed.
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { harnessEngine, HARNESS_CACHE_DIR } from "../src/engines/decide/harness.ts";
import { cacheFromEnv } from "../src/engines/decide/cache.ts";
import { DecisionsAttemptError, type DecisionsResult } from "../src/engines/decide/decisions.ts";
import { processEnv } from "../src/host-env.ts";
import { appendStoreJson, writeStore } from "../src/privacy/send.ts";
import type { JevRequest } from "../src/fill/jev.ts";
import { frozenRequestOf, originalRequests, type FrozenEntry } from "./decisions-frozen-input.ts";
import { loadAsks, loadCorpus, type CorpusAsk } from "./realfill-corpus.ts";
import { labelQuestion } from "./decisions-labels.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({
  options: {
    set: { type: "string" },
    out: { type: "string" },
    "max-usd": { type: "string" },
    "jev-requests": { type: "string" },
    "recorded-at": { type: "string", default: "" },
    "no-cache": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    corpus: { type: "string", default: join(here, "../../fixtures/realfill") },
  },
});
const FILES: Record<string, string> = { B24: "asks.json", B25: "asks-heldout.json", B26: "asks-heldout-2.json", B31: "asks-b31.json" };
const file = FILES[a.set ?? ""];
if (file === undefined) throw new Error(`--set is one of ${Object.keys(FILES).join(", ")}`);
if (a.out === undefined) throw new Error("--out is required");
const MAX_USD = Number(a["max-usd"]);
if (!(MAX_USD > 0)) throw new Error("--max-usd is required: this run's spend ceiling in dollars, above 0");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const corpus = loadCorpus(resolve(a.corpus));
const asks = loadAsks(resolve(a.corpus), corpus, file);

/** The ask a recorded request belongs to: the longest instruction it quotes, narrowed by the form's window title. */
function askOf(text: string): CorpusAsk | null {
  const quoted = asks.filter((x) => text.includes(JSON.stringify(x.instruction).slice(1, -1)));
  const longest = Math.max(0, ...quoted.map((x) => x.instruction.length));
  let hits = quoted.filter((x) => x.instruction.length === longest);
  if (hits.length > 1) hits = hits.filter((x) => { const f = corpus.forms.find((g) => g.id === x.form); return f !== undefined && text.includes(JSON.stringify(f.title).slice(1, -1)); });
  return hits.length === 1 ? (hits[0] as CorpusAsk) : null;
}

const cacheDir = cacheFromEnv(processEnv(), HARNESS_CACHE_DIR)?.dir ?? HARNESS_CACHE_DIR;
const frozen: { ask: CorpusAsk; entry: FrozenEntry }[] = [];
let unmatched = 0;
for (const sub of readdirSync(cacheDir).filter((d) => /^[0-9a-f]{2}$/u.test(d)).sort()) {
  for (const name of readdirSync(join(cacheDir, sub)).filter((f) => f.endsWith(".json")).sort()) {
    const entry = JSON.parse(readFileSync(join(cacheDir, sub, name), "utf8")) as FrozenEntry;
    if (entry.engine !== "jev" || !entry.recordedAt.startsWith(a["recorded-at"])) continue;
    // Only exact entries keep the request's own question and option ids, which Jev's answers name.
    if (!entry.canonical.exact) { unmatched++; continue; }
    const ask = askOf(JSON.stringify(entry.canonical));
    if (ask === null) { if (asks.some((x) => JSON.stringify(entry.canonical).includes(JSON.stringify(x.instruction).slice(1, -1)))) unmatched++; continue; }
    frozen.push({ ask, entry });
  }
}
frozen.sort((x, y) => (x.entry.recordedAt < y.entry.recordedAt ? -1 : x.entry.recordedAt > y.entry.recordedAt ? 1 : 0));

if (a["dry-run"]) {
  const by = new Map<string, { n: number; asks: Set<string>; bytes: number; questions: number }>();
  for (const { ask, entry } of frozen) {
    const k = entry.recordedAt.slice(0, 13);
    const x = by.get(k) ?? { n: 0, asks: new Set<string>(), bytes: 0, questions: 0 };
    x.n++; x.asks.add(ask.id); x.bytes += Buffer.byteLength(JSON.stringify(entry.canonical), "utf8"); x.questions += entry.canonical.questions.length;
    by.set(k, x);
  }
  for (const [k, x] of by) process.stdout.write(`${k}: ${x.n} requests, ${x.asks.size} asks, ${x.questions} questions, ${x.bytes} bytes\n`);
  process.stdout.write(`${frozen.length} matched, ${unmatched} skipped; nothing sent\n`);
  process.exit(0);
}

// Validate the entire input before any paid call. Never guess missing or ambiguous original order.
if (a["jev-requests"] === undefined) throw new Error("--jev-requests is required: supply the original order-preserving Jev request log; canonical cache entries cannot recover the original wire");
const originals = originalRequests(readFileSync(resolve(a["jev-requests"]), "utf8"));
const requests = frozen.map(({ ask, entry }) => ({ ask, entry, req: frozenRequestOf(entry, originals) }));

const decide = harnessEngine({ name: "decisions", canned: null, fixture: { windows: () => false, memory: false, plan: false }, logRequests: join(OUT, "requests.ndjson"), decisionsMaxUsd: MAX_USD, noCache: a["no-cache"] });
const scored = join(OUT, "scored.ndjson");
// This file describes the current run; retaining earlier samples would weight reruns more heavily in the sweep.
writeStore(scored, "");
const liveMs: number[] = [];
const served = new Map<string, number>();
const errors: string[] = [];
let stop: string | null = null;
for (const { ask, entry, req } of requests) {
  let r: Awaited<ReturnType<typeof decide.ask>>;
  try { r = await decide.ask(req); }
  catch (e) {
    const d = e instanceof DecisionsAttemptError ? e : null;
    errors.push(`${ask.id} ${d?.kind ?? (e instanceof Error ? e.name : "error")}${d?.status == null ? "" : ` ${d.status}`}${d?.code == null ? "" : ` ${d.code}`}`);
    if (d !== null && (d.kind === "stop" || d.kind === "cap")) { stop = `${d.kind}: ${d.message}`; break; }
    continue;
  }
  const by = "servedBy" in r ? (r as DecisionsResult).servedBy : "cache";
  served.set(by, (served.get(by) ?? 0) + 1);
  if (by !== "cache") liveMs.push(r.latencyMs);
  const form = corpus.forms.find((f) => f.id === ask.form);
  if (form === undefined) throw new Error(`no form ${ask.form}`);
  const ids = entry.canonical.questions.map((q) => q.id as string);
  const questions: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(req.questions)) {
    const pos = String(ids.indexOf(id));
    const jc = entry.answers[pos]; const jp = entry.probabilities[pos];
    const dc = r.answers[id]; const dp = r.probabilities?.[id];
    const label = labelQuestion(ask, form, id, { instructions: String(q.instructions), criteria: Object.fromEntries(Object.entries(q.criteria).map(([k, v]) => [k, v === null ? null : String(v)])) });
    questions[id] = {
      kind: label.kind, right: label.right, options: Object.keys(q.criteria),
      decisions: dc === undefined || dp === undefined ? null : { choice: dc.choice, confidence: dc.confidence, probabilities: dp },
      jev: jc === undefined || jp === undefined ? null : { choice: jc.choice, confidence: jc.confidence, probabilities: jp },
    };
  }
  appendStoreJson(scored, { set: a.set, ask: ask.id, source: "frozen", recordedAt: entry.recordedAt, servedBy: by, latencyMs: r.latencyMs, costUsd: r.costUsd, questions });
}
const run = decide.decisionsSpend?.run();
const ms = [...liveMs].sort((x, y) => x - y);
const pct = (p: number): number => (ms.length === 0 ? 0 : Math.round(ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] as number));
const summary = [
  `# Decisions on Jev's frozen ${a.set} requests${a["recorded-at"] === "" ? "" : ` recorded at ${a["recorded-at"]}*`}`,
  "",
  `${frozen.length} recorded Jev requests matched to an ask (${unmatched} skipped: no single ask or not exact). Billed $${(run?.billedUsd ?? 0).toFixed(5)}, unsettled holds $${(run?.unsettledUsd ?? 0).toFixed(5)} (cap $${MAX_USD}), ${run?.holds ?? 0} holds.`,
  `Served by ${[...served].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; live latency p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms (${ms.length} live). Failed requests ${errors.length}${errors.length === 0 ? "" : `: ${errors.join("; ")}`}.`,
  ...(stop === null ? [] : [`**Stopped early: ${stop}.**`]),
];
writeStore(join(OUT, "frozen.md"), `${summary.join("\n")}\n`);
process.stderr.write(`${summary.slice(2).join("\n")}\n`);
decide.engine.close?.();
if (stop !== null || errors.length > 0) process.exitCode = 1;
