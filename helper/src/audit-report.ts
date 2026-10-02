// Markdown for the audit's two reports (src/audit.ts): pending markers on real windows, and fill
// readiness on real fields. Counts, rule ids, roles and bundle identifiers only.
import type { AuditSummary, DescriptorSource, FillAppCounts, MarkerAppCounts } from "./audit.ts";

export interface ProcessCpu {
  name: string;
  /** Mean CPU over the run: CPU seconds used divided by wall seconds. */
  meanPct: number;
  /** Highest of the `ps` samples, which are decaying averages. */
  peakPct: number;
  peakRssMb: number;
}

/** A gap longer than this between work finishing and the user coming back is what a watch saves (deep plan 6.4). */
export const SLOW_RETURN_MS = 60_000;

const hours = (s: AuditSummary): number => (s.updatedAt - s.startedAt) / 3_600_000;
const time = (at: number): string => new Date(at).toLocaleString("en-US", { timeZone: "America/Chicago", timeStyle: "short", dateStyle: "medium" });
const byCount = <T>(rows: Record<string, T>, n: (t: T) => number): string[] =>
  Object.keys(rows).sort((a, b) => n(rows[b] as T) - n(rows[a] as T) || a.localeCompare(b));

function quant(xs: readonly number[]): string {
  if (xs.length === 0) return "none";
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
  return `min ${s[0]}, median ${q(0.5)}, p90 ${q(0.9)}, max ${s.at(-1)}`;
}

function cpuLines(cpu: readonly ProcessCpu[]): string[] {
  if (cpu.length === 0) return [];
  return [
    "## CPU",
    "",
    "| Process | Mean CPU | Peak sample | Peak RSS |",
    "|---|---:|---:|---:|",
    ...cpu.map((c) => `| ${c.name} | ${c.meanPct.toFixed(1)}% | ${c.peakPct.toFixed(1)}% | ${c.peakRssMb.toFixed(0)} MB |`),
    "",
  ];
}

export function renderMarkerAudit(s: AuditSummary, cpu: readonly ProcessCpu[] = []): string {
  const h = hours(s);
  const m = s.markers;
  const apps = m.byApp;
  const sum = (f: (a: MarkerAppCounts) => number): number => Object.values(apps).reduce((n, a) => n + f(a), 0);
  const ended = (e: string): number => m.episodes.filter((x) => x.end === e).length;
  const returned = m.episodes.filter((e) => e.end === "returned");
  const slow = returned.filter((e) => (e.returnedAfterMs ?? 0) - (e.clearedAfterMs ?? 0) > SLOW_RETURN_MS);
  const out = [
    "# Pending markers on real windows",
    "",
    `A read-only audit instance (its own caret-screen and helper, Jev off) ran from ${time(s.startedAt)} to ${time(s.updatedAt)} (Chicago time), ${(h * 60).toFixed(0)} minutes. Each time the user left a window it applied B4's marker rules to the window's text and counted which fired. It held no watches of its own beyond asking its reader to re-read the windows B4 would have watched.`,
    "",
    "## Headline",
    "",
    `- Leaves checked: ${sum((a) => a.checks)}. With at least one marker: ${sum((a) => a.withMarkers)} (${(sum((a) => a.withMarkers) / h).toFixed(1)} per hour).`,
    `- Windows that would have become watches: ${m.watches.registered}; at most ${m.watches.maxConcurrent} at once; ${m.watches.overLimit} refused by the limit of 8. With Jev off, a watch here ends when its markers are gone, where B4's would end on Jev's answer.`,
    `- Watch outcomes: the user came back after the markers cleared ${ended("returned")}, the window closed first ${ended("closed")}, watched again for new work first ${ended("replaced")}, still open at the end ${ended("auditEnded")}. Returns while the markers still showed: ${m.episodes.reduce((n, e) => n + e.returnsWhileRunning, 0)}.`,
    `- Of the ${returned.length} returns after the work cleared, ${slow.length} came more than ${SLOW_RETURN_MS / 1000} s after the clear (deep plan 6.4 counts these). Watched windows are re-read every 10 s and on their app's notifications, so a clear is seen up to 10 s late.`,
    "",
    "## By app",
    "",
    "| App | Leaves | With markers | Marker hits per hour | Windows with markers | Watches |",
    "|---|---:|---:|---:|---:|---:|",
    ...byCount(apps, (a) => a.withMarkers * 1e6 + a.checks).map((k) => {
      const a = apps[k] as MarkerAppCounts;
      return `| ${k} | ${a.checks} | ${a.withMarkers} | ${(a.withMarkers / h).toFixed(1)} | ${a.windowsWithMarkers} | ${a.watches} |`;
    }),
    "",
    "## By rule",
    "",
    "A leave counts once per rule that fired on any of its lines. Distinct lines are counted by keyed hash.",
    "",
    "| Rule | Leaves it fired on | Lines | Distinct lines |",
    "|---|---:|---:|---:|",
    ...m.rules.map((r) => `| ${r} | ${sum((a) => a.checksByRule[r])} | ${sum((a) => a.linesByRule[r])} | ${m.distinctLines[r]} |`),
    "",
    "### Rule by app (leaves fired on)",
    "",
    `| App | ${m.rules.join(" | ")} |`,
    `|---|${m.rules.map(() => "---:").join("|")}|`,
    ...byCount(apps, (a) => a.withMarkers)
      .filter((k) => (apps[k] as MarkerAppCounts).withMarkers > 0)
      .map((k) => `| ${k} | ${m.rules.map((r) => (apps[k] as MarkerAppCounts).checksByRule[r]).join(" | ")} |`),
    "",
    "## Watch episodes",
    "",
    "Times are seconds from the leave that registered the watch.",
    "",
    "| App | First rule | End | Cleared after | Returned after | Returns while running |",
    "|---|---|---|---:|---:|---:|",
    ...m.episodes.map(
      (e) =>
        `| ${e.bundleId} | ${e.rule} | ${e.end} | ${e.clearedAfterMs === null ? "-" : (e.clearedAfterMs / 1000).toFixed(0)} | ${e.returnedAfterMs === null ? "-" : (e.returnedAfterMs / 1000).toFixed(0)} | ${e.returnsWhileRunning} |`,
    ),
    "",
    ...cpuLines(cpu),
  ];
  return `${out.join("\n").trimEnd()}\n`;
}

const SOURCES: DescriptorSource[] = ["label", "nearest", "placeholder", "sectionOnly", "none"];

export function renderFillReadiness(s: AuditSummary): string {
  const f = s.fill;
  const list = f.focusesList;
  const apps = f.byApp;
  const sum = (g: (a: FillAppCounts) => number): number => Object.values(apps).reduce((n, a) => n + g(a), 0);
  const derivable = sum((a) => a.derivable);
  const roles: Record<string, number> = {};
  for (const x of list) roles[x.role] = (roles[x.role] ?? 0) + 1;
  const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`);
  const out = [
    "# Fill readiness on real fields",
    "",
    `The same audit instance, ${time(s.startedAt)} to ${time(s.updatedAt)} (Chicago time). At each focus of an empty editable field it ran the descriptor code (deep plan section 6.1, experiment E3) and the candidate generator without a cap, and kept only counts. Whether a derived descriptor is the right label was not checked: that needs the text.`,
    "",
    "## Headline",
    "",
    `- Focus messages ${f.focuses}; on editable elements ${f.editableFocuses}; on empty editable fields ${f.emptyEditable}. Secure fields skipped ${f.secure}; fields missing from the model ${f.nodeMissing}.`,
    `- Measured: ${f.measured} focuses on ${f.distinctFields} distinct fields. Code derived a descriptor (own label, nearest text or placeholder) for ${derivable} (${pct(derivable, f.measured)}).`,
    `- Descriptor source, first that applies: ${SOURCES.map((k) => `${k} ${sum((a) => a.bySource[k])}`).join(", ")}.`,
    `- Field parts found, counted independently: label ${sum((a) => a.hasLabel)}, nearest text ${sum((a) => a.hasNearest)}, placeholder ${sum((a) => a.hasPlaceholder)}, named section ${sum((a) => a.hasSection)}.`,
    `- Candidate spans per focus: ${quant(list.map((x) => x.candidates))}. Over the generator's cap of ${f.candidateCap}: ${list.filter((x) => x.candidates > f.candidateCap).length} of ${list.length}.`,
    `- Typed-value candidates per focus: ${quant(list.map((x) => x.typedCandidates))}.`,
    `- Empty fields in the focused field's form: ${quant(list.map((x) => x.formFields))}.`,
    `- Generator time per focus (ms): ${quant(list.map((x) => x.generatorMs))}.`,
    "",
    "## By app",
    "",
    `| App | Focuses | Derivable | ${SOURCES.join(" | ")} |`,
    `|---|---:|---:|${SOURCES.map(() => "---:").join("|")}|`,
    ...byCount(apps, (a) => a.focuses).map((k) => {
      const a = apps[k] as FillAppCounts;
      return `| ${k} | ${a.focuses} | ${a.derivable} | ${SOURCES.map((x) => a.bySource[x]).join(" | ")} |`;
    }),
    "",
    "## By role",
    "",
    "| Role | Focuses |",
    "|---|---:|",
    ...byCount(roles, (n) => n).map((k) => `| ${k} | ${roles[k]} |`),
    "",
  ];
  return `${out.join("\n").trimEnd()}\n`;
}
