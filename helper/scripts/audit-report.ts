// Writes marker-audit.md and fill-readiness.md from an audit's --audit-out file (src/audit-report.ts).
//
//   node scripts/audit-report.ts --audit FILE --out-dir DIR [--cpu FILE --name PID=LABEL ...]
//
// The CPU file holds `ps` samples, one per line: "<epoch s> <pid> <%cpu> <rss KB> <cpu time>", with
// cpu time as [[h:]m]m:ss.cc. Mean CPU per process is the change in cpu time over the change in wall time.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { AuditSummary } from "../src/audit.ts";
import { renderFillReadiness, renderMarkerAudit, type ProcessCpu } from "../src/audit-report.ts";

const { values: a } = parseArgs({
  options: { audit: { type: "string" }, "out-dir": { type: "string" }, cpu: { type: "string" }, name: { type: "string", multiple: true } },
});
if (a.audit === undefined || a["out-dir"] === undefined) throw new Error("--audit and --out-dir are required");
const summary = JSON.parse(readFileSync(a.audit, "utf8")) as AuditSummary;

const cpuSeconds = (t: string): number => t.split(":").reduce((n, part) => n * 60 + Number(part), 0);
const cpu: ProcessCpu[] = [];
if (a.cpu !== undefined) {
  const names = new Map((a.name ?? []).map((n) => n.split("=") as [string, string]));
  const samples = new Map<string, { at: number; pct: number; rssKb: number; cpuS: number }[]>();
  for (const line of readFileSync(a.cpu, "utf8").split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length !== 5 || !/^\d+$/.test(f[0] as string)) continue;
    const [at, pid, pct, rss, t] = f as [string, string, string, string, string];
    if (!names.has(pid)) continue;
    const list = samples.get(pid) ?? [];
    list.push({ at: Number(at), pct: Number(pct), rssKb: Number(rss), cpuS: cpuSeconds(t) });
    samples.set(pid, list);
  }
  for (const [pid, list] of samples) {
    const first = list[0];
    const last = list.at(-1);
    if (first === undefined || last === undefined || last.at === first.at) continue;
    cpu.push({
      name: `${names.get(pid)} (pid ${pid})`,
      meanPct: (100 * (last.cpuS - first.cpuS)) / (last.at - first.at),
      peakPct: Math.max(...list.map((x) => x.pct)),
      peakRssMb: Math.max(...list.map((x) => x.rssKb)) / 1024,
    });
  }
}

writeFileSync(join(a["out-dir"], "marker-audit.md"), renderMarkerAudit(summary, cpu));
writeFileSync(join(a["out-dir"], "fill-readiness.md"), renderFillReadiness(summary));
