// The opportunity report from the shadow logger's store (src/opportunity.ts), rerunnable daily.
//
//   node scripts/shadow-report.ts --data-dir DIR --start TIME --out FILE.md [--json FILE] [--end TIME]
//                                 [--pmset-log FILE | --no-activity]
//
// The live store is never opened: `sqlite3` makes a read-only backup into a private temp directory,
// which is read and then deleted. TIME is anything Date.parse accepts, or milliseconds. Active hours
// come from `pmset -g log` unless a saved log is given, or --no-activity.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { humanActiveSpans, opportunityReport, renderOpportunity } from "../src/opportunity.ts";
import { readShadowEpisodes, readTransfers } from "../src/store.ts";

const { values: a } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    out: { type: "string" },
    json: { type: "string" },
    "pmset-log": { type: "string" },
    "no-activity": { type: "boolean", default: false },
  },
});
const need = (k: "data-dir" | "start" | "out"): string => {
  const v = a[k];
  if (v === undefined) throw new Error(`--${k} is required`);
  return v;
};
const time = (s: string): number => {
  const t = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  if (!Number.isFinite(t)) throw new Error(`not a time: ${s}`);
  return t;
};

const live = join(resolve(need("data-dir")), "screen.sqlite");
if (!existsSync(live)) throw new Error(`no store at ${live}`);
const tmp = mkdtempSync(join(tmpdir(), "caret-shadow-report-"));
try {
  const copy = join(tmp, "copy.sqlite");
  execFileSync("sqlite3", [`file:${live}?mode=ro`, `.backup '${copy}'`], { stdio: ["ignore", "ignore", "inherit"] });
  const copiedAt = Date.now();
  const db = new DatabaseSync(copy, { readOnly: true });
  const episodes = readShadowEpisodes(db);
  const transfers = readTransfers(db);
  const coverage = { from: time(need("start")), to: a.end === undefined ? copiedAt : time(a.end) };
  // Counts are kept per local day, so every day the coverage touches is summed.
  const dayOf = (t: number): string => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const days = new Set<string>([dayOf(coverage.to)]);
  for (let t = coverage.from; t < coverage.to; t += 86_400_000) days.add(dayOf(t));
  const counts: Record<string, number> = {};
  for (const r of db.prepare("SELECT day, metric, n FROM counts").all() as { day: string; metric: string; n: number }[]) {
    if (days.has(r.day)) counts[r.metric] = (counts[r.metric] ?? 0) + Number(r.n);
  }
  db.close();

  let activeSpans = null;
  if (!a["no-activity"]) {
    const log =
      a["pmset-log"] === undefined
        ? execFileSync("pmset", ["-g", "log"], { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] })
        : readFileSync(a["pmset-log"], "utf8");
    activeSpans = humanActiveSpans(log, coverage.to);
  }
  const report = opportunityReport({ episodes, transfers, counts, coverage, activeSpans });
  writeFileSync(need("out"), renderOpportunity(report));
  if (a.json !== undefined) writeFileSync(a.json, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `entries ${report.all.entries}, findable ${report.all.findable}; active hours ${report.coverage.activeHours?.toFixed(2) ?? "unknown"}; per active hour ${report.perActiveHour?.toFixed(2) ?? "unknown"}\n`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
