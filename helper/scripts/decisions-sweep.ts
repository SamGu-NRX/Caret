import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { writeStore } from "../src/privacy/send.ts";
import type { LabelKind } from "./decisions-labels.ts";

export type Provider = "decisions" | "jev";
export type ScoredKind = Exclude<LabelKind, "other">;
export interface ScoredAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface ScoredQuestion {
  kind: LabelKind;
  right: string[] | null;
  options: string[];
  decisions: ScoredAnswer | null;
  jev: ScoredAnswer | null;
}
export interface ScoredRecord {
  set: string;
  ask: string;
  source: "live" | "frozen";
  servedBy: "org" | "personal" | "cache" | null;
  latencyMs: number;
  costUsd: number;
  questions: Record<string, ScoredQuestion>;
}
export interface SweepRow {
  threshold: number;
  n: number;
  accepted: number;
  coverage: number | null;
  acceptedWrong: number;
  fills: number | null;
  wrongFills: number | null;
}
export interface SweepResult {
  provider: Provider;
  kind: ScoredKind;
  paired: boolean;
  n: number;
  accuracy: number | null;
  meanSelectedProbability: number | null;
  meanApiConfidence: number | null;
  meanRunnerUpMargin: number | null;
  meanNoneProbability: number | null;
  rows: SweepRow[];
}

export const THRESHOLDS = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 0.99] as const;
const KINDS: readonly ScoredKind[] = ["value", "scope", "owner"];

function object(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function strings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function probability(v: unknown): v is number {
  return finite(v) && v >= 0 && v <= 1;
}

function validateRecord(v: unknown, where: string): asserts v is ScoredRecord {
  function fail(path: string, why: string): never {
    throw new Error(`Malformed scored record ${where}: ${path} ${why}`);
  }
  if (!object(v)) fail("record", "must be an object");
  for (const key of ["set", "ask"]) if (typeof v[key] !== "string" || v[key] === "") fail(key, "must be a nonempty string");
  if (v.source !== "live" && v.source !== "frozen") fail("source", "must be live or frozen");
  if (v.servedBy !== null && !["org", "personal", "cache"].includes(String(v.servedBy))) fail("servedBy", "must be org, personal, cache or null");
  for (const key of ["latencyMs", "costUsd"]) if (!finite(v[key]) || v[key] < 0) fail(key, "must be a finite nonnegative number");
  if (!object(v.questions)) fail("questions", "must be an object");
  for (const [qid, q] of Object.entries(v.questions)) {
    const path = `questions.${qid}`;
    if (!object(q)) fail(path, "must be an object");
    if (![...KINDS, "other"].includes(String(q.kind))) fail(`${path}.kind`, "must be value, scope, owner or other");
    if (!strings(q.options) || q.options.length === 0 || new Set(q.options).size !== q.options.length) fail(`${path}.options`, "must be a nonempty array of unique option ids");
    if (q.right !== null && (!strings(q.right) || q.right.length === 0 || q.right.some((id) => !(q.options as string[]).includes(id)))) fail(`${path}.right`, "must be null or a nonempty array of offered option ids");
    for (const provider of ["decisions", "jev"] as const) {
      const a = q[provider];
      const ap = `${path}.${provider}`;
      if (a === null) continue;
      if (!object(a)) fail(ap, "must be an answer object or null");
      if (typeof a.choice !== "string" || !q.options.includes(a.choice)) fail(`${ap}.choice`, "must be an offered option id");
      if (!probability(a.confidence)) fail(`${ap}.confidence`, "must be a finite number between 0 and 1");
      if (!object(a.probabilities)) fail(`${ap}.probabilities`, "must be an object");
      for (const [id, p] of Object.entries(a.probabilities)) {
        if (!q.options.includes(id)) fail(`${ap}.probabilities.${id}`, "is not an offered option id");
        if (!probability(p)) fail(`${ap}.probabilities.${id}`, "must be a finite number between 0 and 1");
      }
    }
  }
}

function answered(a: ScoredAnswer | null): a is ScoredAnswer {
  return a !== null && Object.hasOwn(a.probabilities, a.choice);
}
const mean = (xs: readonly number[]): number | null => xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

export function sweep(records: readonly unknown[], provider: Provider, kind: ScoredKind, thresholds: readonly number[], paired: boolean): SweepResult {
  if (provider !== "decisions" && provider !== "jev") throw new Error("Sweep provider must be decisions or jev");
  if (!KINDS.includes(kind)) throw new Error("Sweep kind must be value, scope or owner");
  if (!thresholds.every(probability)) throw new Error("Sweep thresholds must be finite numbers between 0 and 1");
  const samples: { answer: ScoredAnswer; right: string[]; p: number }[] = [];
  records.forEach((record, i) => {
    validateRecord(record, `#${i + 1}`);
    for (const q of Object.values(record.questions)) {
      if (q.kind !== kind || q.right === null || !answered(q[provider])) continue;
      if (paired && (!answered(q.decisions) || !answered(q.jev))) continue;
      const answer = q[provider];
      samples.push({ answer, right: q.right, p: answer.probabilities[answer.choice]! });
    }
  });
  const n = samples.length;
  const margins = samples.flatMap(({ answer, p }) => {
    const others = Object.entries(answer.probabilities).filter(([id]) => id !== answer.choice).map(([, v]) => v);
    return others.length === 0 ? [] : [p - Math.max(...others)];
  });
  const none = kind === "value" ? samples.flatMap(({ answer }) => Object.hasOwn(answer.probabilities, "none") ? [answer.probabilities.none!] : []) : [];
  return {
    provider, kind, paired, n,
    accuracy: mean(samples.map(({ answer, right }) => Number(right.includes(answer.choice)))),
    meanSelectedProbability: mean(samples.map(({ p }) => p)),
    meanApiConfidence: mean(samples.map(({ answer }) => answer.confidence)),
    meanRunnerUpMargin: mean(margins),
    meanNoneProbability: mean(none),
    rows: thresholds.map((threshold) => {
      const accepted = samples.filter(({ p }) => p >= threshold);
      const wrong = accepted.filter(({ answer, right }) => !right.includes(answer.choice));
      return {
        threshold, n, accepted: accepted.length, coverage: n === 0 ? null : accepted.length / n,
        acceptedWrong: wrong.length,
        fills: kind === "value" ? accepted.filter(({ answer }) => answer.choice !== "none").length : null,
        wrongFills: kind === "value" ? wrong.filter(({ answer }) => answer.choice !== "none").length : null,
      };
    }),
  };
}

const decimal = (v: number | null): string => v === null ? "n/a" : v.toFixed(3);
const percent = (v: number | null): string => v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;

export function renderSweep(records: readonly unknown[]): string {
  const lines = ["# Decision confidence sweep", "", "Diagnostic only. The shipped cutoff remains 0.75; this report does not change it.", "", "Coverage uses only labeled questions answered with a selected-option probability. n/a means no observations. Runner-up margin subtracts the highest probability of another option; answers with no other probability are omitted from that mean."];
  for (const paired of [true, false]) {
    lines.push("", `## ${paired ? "Paired set: both providers answered" : "All answered: each provider's own set"}`);
    for (const kind of KINDS) {
      const results = [sweep(records, "decisions", kind, THRESHOLDS, paired), sweep(records, "jev", kind, THRESHOLDS, paired)];
      lines.push("", `### ${kind}`, "");
      for (const r of results) lines.push(`${r.provider === "decisions" ? "Decisions" : "Jev"}: n=${r.n}; accuracy=${percent(r.accuracy)}; mean selected probability=${decimal(r.meanSelectedProbability)}; mean API confidence=${decimal(r.meanApiConfidence)}; mean runner-up margin=${decimal(r.meanRunnerUpMargin)}${kind === "value" ? `; mean none probability=${decimal(r.meanNoneProbability)}` : ""}.`);
      const columns = ["Threshold", ...["Decisions", "Jev"].flatMap((p) => [`${p} coverage`, `${p} accepted wrong`, ...(kind === "value" ? [`${p} wrong fills`] : [])])];
      lines.push("", `| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`);
      THRESHOLDS.forEach((t, i) => {
        const cells = [t === 0.75 ? "0.75 shipped cutoff" : t.toFixed(2), ...results.flatMap((r) => {
          const row = r.rows[i]!;
          return [percent(row.coverage), String(row.acceptedWrong), ...(kind === "value" ? [String(row.wrongFills)] : [])];
        })];
        lines.push(`| ${cells.join(" | ")} |`);
      });
    }
  }
  return `${lines.join("\n")}\n`;
}

function main(): void {
  const { values, positionals } = parseArgs({ options: { out: { type: "string" } }, allowPositionals: true });
  if (positionals.length === 0) throw new Error("Usage: node scripts/decisions-sweep.ts FILE... [--out report.md]");
  if (values.out === "") throw new Error("--out must name an output file");
  const records: ScoredRecord[] = [];
  for (const file of positionals) {
    // These inputs are scored records, never configuration or secrets.
    if (/^\.env(?:\.|$)/u.test(file.split(/[\\/]/u).at(-1) ?? "")) throw new Error("Scored input must not be an .env file");
    const lines = readFileSync(file, "utf8").split(/\r?\n/u);
    lines.forEach((line, i) => {
      if (i === lines.length - 1 && line === "") return;
      let record: unknown;
      try { record = JSON.parse(line); }
      catch { throw new Error(`Malformed scored record ${file}:${i + 1}: invalid JSON`); }
      validateRecord(record, `${file}:${i + 1}`);
      records.push(record);
    });
  }
  const report = renderSweep(records);
  if (values.out !== undefined) writeStore(values.out, report);
  else process.stdout.write(report);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
