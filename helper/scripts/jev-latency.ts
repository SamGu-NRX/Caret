// GW1: bounded, fixture-only System One timings. TTFB is the first response body byte, not just HTTP headers.
// Usage: CARET_ENV_FILE=/path/to/.env node scripts/jev-latency.ts [--n 30] [--provider typesafe|gateway|both]
//        [--gateway-model typesafe-ai/jev] [--small-only] [--record /path/to/goal-live-3-jev.ndjson]
// No response text or credentials are printed. Each provider sends at most 30 requests per shape, without retries.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as z from "zod";
import { DailySpend, JevCapError } from "../src/engines/decide/daily-cap.ts";
import { CacheRefused } from "../src/engines/decide/cache.ts";
import { JevGatewayPolicyError, JEV_GATEWAY_MODEL, LAYA_FREE_MODEL, jevFailureKind, jevSettings, loadJevKey, makeJevClient, type JevProvider, type JevRequest } from "../src/fill/jev.ts";

export const SMALL_REQUEST: JevRequest = {
  state: "The fixture asks for an email address.",
  questions: { q: { type: "choice", instructions: "Choose the email address.", criteria: { email: "alex@example.test", none: "No email address." } } },
  snippets: [], charged: {}, retry429: false,
};
const fixtureRequests = new Set([JSON.stringify(SMALL_REQUEST)]);
const FIXTURES = fileURLToPath(new URL("../../fixtures/realfill/", import.meta.url));
const Recorded = z.object({ page: z.string(), questions: z.record(z.string(), z.object({ ins: z.string(), criteria: z.record(z.string(), z.string().nullable()) })) });
const Corpus = z.object({ forms: z.array(z.object({ id: z.string(), fields: z.array(z.object({ label: z.string(), control: z.string(), options: z.array(z.string()).optional() })) })) });

/** The log lacks state. Rebuild it from the pizza fixture; use the record only to select fields and candidate ids. */
export function fixtureFillRequest(recordText: string): JevRequest {
  const record = recordText.split(/\r?\n/).filter(Boolean).map((line) => Recorded.parse(JSON.parse(line))).find((r) => r.page === "httpbin-pizza" && r.questions.f1 !== undefined);
  if (record === undefined) throw new Error("the recorded requests have no httpbin-pizza fill fixture");
  const corpus = Corpus.parse(JSON.parse(readFileSync(join(FIXTURES, "corpus.json"), "utf8")));
  const form = corpus.forms.find((f) => f.id === "httpbin-pizza");
  if (form === undefined) throw new Error("the pizza fixture has no fields");
  const windows = [
    { title: "Order note.txt", text: readFileSync(join(FIXTURES, "sources/order-note.txt"), "utf8") },
    { title: "Draft.txt", text: readFileSync(join(FIXTURES, "sources/draft.txt"), "utf8") },
    { title: "Venue deposit and Thursday review", text: JSON.stringify(JSON.parse(readFileSync(join(FIXTURES, "sources/colleague-thread.mail.json"), "utf8"))) },
  ];
  const questions: JevRequest["questions"] = {};
  for (const [id, q] of Object.entries(record.questions)) {
    if (!/^f\d+$/.test(id)) throw new Error("the recorded fixture has an unexpected question id");
    const label = /Label: '([^']+)'/.exec(q.ins)?.[1];
    const field = form.fields.find((f) => f.label === label);
    if (field === undefined) throw new Error("the recorded field is not in the pizza fixture");
    const criteria: Record<string, string> = {};
    for (const [candidate, description] of Object.entries(q.criteria)) {
      if (candidate === "none") { criteria.none = "No candidate is the value this field asks for."; continue; }
      if (!/^c\d+$/.test(candidate)) throw new Error("the recorded fixture has an unexpected candidate id");
      const value = /^"([^"]+)"/.exec(description ?? "")?.[1];
      // The recorded browser address is not source context. It was local fixture plumbing, so drop that option.
      if (value !== undefined && /^127\.0\.0\.1:\d+\/mail\/colleague-thread$/.test(value)) continue;
      const source = value === undefined ? undefined : windows.find((w) => w.text.includes(value) || w.title === value);
      if (source === undefined) throw new Error("the recorded candidate is not in the synthetic fixture context");
      criteria[candidate] = `"${value}" (in fixture window '${source.title}')`;
    }
    questions[id] = { type: "choice", instructions: `The user asked "fill out this form". Which candidate belongs in the ${field.control} field '${field.label}'? Choose none if no candidate fits.`, criteria };
  }
  const req: JevRequest = { state: { form: form.fields, windows }, questions, snippets: [], charged: {}, retry429: false };
  fixtureRequests.add(JSON.stringify(req));
  return req;
}

export function probeCount(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 30) throw new Error("--n must be an integer from 1 to 30");
  return n;
}
export function summarize(values: readonly number[]): { p50: number; p95: number; max: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // SAFETY: values is nonempty, and nearest-rank indices are inside the sorted array.
  const at = (p: number): number => sorted[Math.ceil(sorted.length * p) - 1] as number;
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] as number };
}
export interface ProbeSample {
  provider: JevProvider;
  model: string;
  shape: string;
  bodyBytes: number;
  status: number | null;
  failure: string | null;
  ttfbMs: number | null;
  totalMs: number;
  costUsd: number;
}
interface ProbeOptions {
  count: number;
  providers: readonly JevProvider[];
  requests: Readonly<Partial<Record<"small" | "fill", JevRequest>>>;
  spend: DailySpend;
  env: NodeJS.ProcessEnv;
  gatewayModel?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export async function runProbe(o: ProbeOptions): Promise<ProbeSample[]> {
  probeCount(String(o.count));
  if (new Set(o.providers).size !== o.providers.length || o.providers.length > 2 || o.providers.some((p) => p !== "typesafe" && p !== "gateway")) throw new Error("probe providers must be typesafe, gateway, or both, without duplicates");
  const now = o.now ?? (() => performance.now());
  const rows: ProbeSample[] = [];
  for (const provider of o.providers) {
    const env = { ...o.env, CARET_JEV_PROVIDER: provider, CARET_JEV_MODEL: provider === "gateway" ? o.gatewayModel ?? JEV_GATEWAY_MODEL : "jev-latest" };
    const settings = jevSettings(env);
    for (const [shape, req] of Object.entries(o.requests)) {
      if (req === undefined) continue;
      // Keep the approved text private: a caller can mutate its request while earlier samples await a response.
      const sampleReq = structuredClone(req);
      if (settings.model === LAYA_FREE_MODEL && !fixtureRequests.has(JSON.stringify(sampleReq))) throw new JevGatewayPolicyError("Laya probe requests must be built from the synthetic fixtures", settings.model);
      for (let i = 0; i < o.count; i++) {
        let start = now();
        const row: ProbeSample = { provider, model: settings.model, shape, bodyBytes: 0, status: null, failure: null, ttfbMs: null, totalMs: 0, costUsd: 0 };
        const timedFetch: typeof fetch = async (input, init) => {
          start = now();
          row.bodyBytes = Buffer.byteLength(String(init?.body ?? ""));
          const res = await (o.fetchFn ?? fetch)(input, init);
          row.status = res.status;
          if (res.body === null) { row.totalMs = now() - start; return res; }
          const reader = res.body.getReader();
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const chunk = await reader.read();
                if (chunk.done) { row.totalMs = now() - start; controller.close(); reader.releaseLock(); }
                else { if (chunk.value.byteLength > 0 && row.ttfbMs === null) row.ttfbMs = now() - start; controller.enqueue(chunk.value); }
              } catch (e) { row.totalMs = now() - start; controller.error(e); reader.releaseLock(); }
            },
            async cancel(reason) { await reader.cancel(reason); reader.releaseLock(); },
          }, { highWaterMark: 0 });
          return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
        };
        const ask = makeJevClient((provider) => loadJevKey(env, provider), 10_000, o.spend, settings, timedFetch, (usage) => { row.costUsd += usage.costUsd; }, { fixture: { windows: () => false, memory: false, plan: false }, env });
        try {
          await ask({ ...sampleReq, retry429: false });
        } catch (e) {
          // These failures stop the probe, not merely one sample. Never continue after a charged/free-model refusal.
          if (e instanceof JevCapError || e instanceof JevGatewayPolicyError || e instanceof CacheRefused) throw e;
          row.failure = jevFailureKind(e) ?? "invalidAnswer";
          if (row.totalMs === 0) row.totalMs = now() - start;
        }
        rows.push(row);
      }
    }
  }
  return rows;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, options: { n: { type: "string", default: "30" }, provider: { type: "string", default: "both" }, "gateway-model": { type: "string", default: JEV_GATEWAY_MODEL }, "small-only": { type: "boolean", default: false }, record: { type: "string", default: join(homedir(), ".caret-run/evidence/screen/p2/goal-live-3-jev.ndjson") } } });
  if (values.provider !== "both" && values.provider !== "typesafe" && values.provider !== "gateway") throw new Error("--provider must be typesafe, gateway, or both");
  const requests = values["small-only"] ? { small: SMALL_REQUEST } : { small: SMALL_REQUEST, fill: fixtureFillRequest(readFileSync(values.record, "utf8")) };
  const rows = await runProbe({ count: probeCount(values.n), providers: values.provider === "both" ? ["typesafe", "gateway"] : [values.provider], gatewayModel: values["gateway-model"], requests, spend: DailySpend.fromEnv(), env: process.env });
  console.log(JSON.stringify({ samples: rows, summaries: [...new Set(rows.map((r) => `${r.provider}:${r.shape}`))].map((group) => {
    const samples = rows.filter((r) => `${r.provider}:${r.shape}` === group);
    return { group, count: samples.length, statuses: samples.map((r) => r.status), ttfbMs: summarize(samples.flatMap((r) => r.ttfbMs === null ? [] : [r.ttfbMs])), totalMs: summarize(samples.map((r) => r.totalMs)), costUsd: samples.reduce((n, r) => n + r.costUsd, 0) };
  }) }, null, 2));
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : "latency probe failed"); process.exitCode = 1; });
}
