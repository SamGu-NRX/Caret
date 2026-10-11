// The generator's cost on real windows, from one or more audits' counts (audit-counts.json), as a
// markdown table: per-focus records and the audit's probes, wall time and CPU at p50, p95 and max.
// Reads counts and times only; the files hold no screen text.
//
//   node scripts/generator-cost.ts NAME=FILE [NAME=FILE ...]
import { readFileSync } from "node:fs";
import type { AuditSummary } from "../src/audit.ts";

const runs = process.argv.slice(2).map((a) => {
  const i = a.indexOf("=");
  if (i <= 0) throw new Error(`expected NAME=FILE, got ${a}`);
  return { name: a.slice(0, i), s: JSON.parse(readFileSync(a.slice(i + 1), "utf8")) as AuditSummary };
});
if (runs.length === 0) throw new Error("usage: generator-cost.ts NAME=FILE [NAME=FILE ...]");

/** Quantiles of the values present; a run from before a field existed has none of it. */
const q = (raw: readonly (number | undefined)[]): string => {
  const xs = raw.filter((x): x is number => typeof x === "number");
  if (xs.length === 0) return "none";
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
  return `${at(0.5).toFixed(2)} / ${at(0.95).toFixed(2)} / ${(s.at(-1) as number).toFixed(2)}`;
};

const rows: string[] = [];
for (const { name, s } of runs) {
  const f = s.fill.focusesList;
  rows.push(`| ${name} | focus | ${f.length} | ${q(f.map((x) => x.generatorMs))} | ${q(f.map((x) => x.generatorThreadCpuMs))} | ${q(f.map((x) => x.generatorCpuMs))} |`);
  const p = s.probes ?? [];
  rows.push(`| ${name} | probe, first call | ${p.length} | ${q(p.map((x) => x.first.wallMs))} | ${q(p.map((x) => x.first.threadCpuMs))} | ${q(p.map((x) => x.first.cpuMs))} |`);
  rows.push(`| ${name} | probe, second call | ${p.length} | ${q(p.map((x) => x.second.wallMs))} | ${q(p.map((x) => x.second.threadCpuMs))} | ${q(p.map((x) => x.second.cpuMs))} |`);
}
const parts: string[] = [];
for (const { name, s } of runs) {
  const p = s.probes ?? [];
  if (p.length === 0) continue;
  const part = (k: "split" | "context" | "section" | "blockHead"): string => q(p.map((x) => x.first.profile[k]));
  parts.push(`| ${name} | ${part("split")} | ${part("context")} | ${part("section")} | ${part("blockHead")} |`);
}

console.log(
  [
    "Milliseconds, p50 / p95 / max. Event-loop CPU is process.threadCpuUsage, the generator's own work; all-thread CPU (process.cpuUsage) adds V8's GC and compiler threads.",
    "",
    "| Run | Sample | n | Wall | Event-loop CPU | All-thread CPU |",
    "|---|---|---:|---:|---:|---:|",
    ...rows,
    "",
    "Wall time of the first probe call by part, p50 / p95 / max ms:",
    "",
    "| Run | Split lines | Labels | Sections | Block heads |",
    "|---|---:|---:|---:|---:|",
    ...parts,
  ].join("\n"),
);
