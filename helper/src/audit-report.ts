// Markdown for the audit's two reports (src/audit.ts): pending markers on real windows, and fill
// readiness on real fields. Counts, rule ids, roles and bundle identifiers only.
import type { AuditSummary, DescriptorSource, FillAppCounts, MarkerAppCounts, MarkerSummary, RuleSet } from "./audit.ts";
import { MAX_WATCHES } from "./tasks/pending.ts";
import type { CensusApp } from "./audit-census.ts";
import { GENERATOR_BUDGET_MS } from "./fill/candidates.ts";

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

/** Minutes of input during the run, two ways: HID idle samples, which count agents' posted events too, and powerd's hardware-input spans. */
export interface Activity {
  hidMinutes: number | null;
  powerdMinutes: number | null;
}

interface SetNumbers {
  leavesWithMarkers: number;
  watches: number;
  cleared: number;
  returnedAfterClear: number;
  slowReturns: number;
  neverCleared: number;
  closedFirst: number;
  returnsWhileMarked: number;
}

function setNumbers(m: MarkerSummary): SetNumbers {
  const ep = m.episodes;
  return {
    leavesWithMarkers: Object.values(m.byApp).reduce((n, a) => n + a.withMarkers, 0),
    watches: m.watches.registered,
    cleared: ep.filter((e) => e.clearedAfterMs !== null).length,
    returnedAfterClear: ep.filter((e) => e.end === "returned").length,
    slowReturns: ep.filter((e) => e.end === "returned" && (e.returnedAfterMs ?? 0) - (e.clearedAfterMs ?? 0) > SLOW_RETURN_MS).length,
    neverCleared: ep.filter((e) => e.clearedAfterMs === null && e.end !== "closed").length,
    closedFirst: ep.filter((e) => e.end === "closed").length,
    returnsWhileMarked: ep.reduce((n, e) => n + e.returnsWhileRunning, 0),
  };
}

const SET_NAMES: Record<RuleSet, string> = { b5: "B5 rules", b6: "B6 rules" };

function ruleSetSection(set: RuleSet, m: MarkerSummary, h: number): string[] {
  const apps = m.byApp;
  const sum = (f: (a: MarkerAppCounts) => number): number => Object.values(apps).reduce((n, a) => n + f(a), 0);
  const fired = m.rules.filter((r) => sum((a) => a.checksByRule[r]) > 0);
  return [
    `## ${SET_NAMES[set]} in detail`,
    "",
    "A leave counts once per rule that fired on any of its markers. Distinct lines are counted by keyed hash.",
    "",
    "| Rule | Leaves it fired on | Lines | Distinct lines |",
    "|---|---:|---:|---:|",
    ...m.rules.map((r) => `| ${r} | ${sum((a) => a.checksByRule[r])} | ${sum((a) => a.linesByRule[r])} | ${m.distinctLines[r]} |`),
    "",
    ...(fired.length === 0
      ? []
      : [
          `| App | Leaves with markers | Per hour | ${fired.join(" | ")} |`,
          `|---|---:|---:|${fired.map(() => "---:").join("|")}|`,
          ...byCount(apps, (a) => a.withMarkers)
            .filter((k) => (apps[k] as MarkerAppCounts).withMarkers > 0)
            .map((k) => {
              const a = apps[k] as MarkerAppCounts;
              return `| ${k} | ${a.withMarkers} | ${(a.withMarkers / h).toFixed(1)} | ${fired.map((r) => a.checksByRule[r]).join(" | ")} |`;
            }),
          "",
        ]),
    "Watch episodes, in seconds from the leave that registered the watch:",
    "",
    "| App | First rule | End | Cleared after | Returned after | Returns while marked |",
    "|---|---|---|---:|---:|---:|",
    ...m.episodes.map(
      (e) =>
        `| ${e.bundleId} | ${e.rule} | ${e.end} | ${e.clearedAfterMs === null ? "-" : (e.clearedAfterMs / 1000).toFixed(0)} | ${e.returnedAfterMs === null ? "-" : (e.returnedAfterMs / 1000).toFixed(0)} | ${e.returnsWhileRunning} |`,
    ),
    "",
  ];
}

export function renderMarkerAudit(s: AuditSummary, cpu: readonly ProcessCpu[] = [], activity: Activity = { hidMinutes: null, powerdMinutes: null }): string {
  const h = hours(s);
  const b5 = setNumbers(s.markers.b5);
  const b6 = setNumbers(s.markers.b6);
  const row = (label: string, f: (n: SetNumbers) => number | string): string => `| ${label} | ${f(b5)} | ${f(b6)} |`;
  const appKeys = [...new Set([...Object.keys(s.markers.b5.byApp), ...Object.keys(s.markers.b6.byApp)])];
  const app = (set: RuleSet, k: string): MarkerAppCounts | undefined => s.markers[set].byApp[k];
  const cleared = (set: RuleSet, k: string): number => s.markers[set].episodes.filter((e) => e.bundleId === k && e.clearedAfterMs !== null).length;
  const active = [
    activity.hidMinutes === null ? null : `${activity.hidMinutes.toFixed(0)} minutes by the HID idle timer, which also counts events that agents post`,
    activity.powerdMinutes === null ? null : `${activity.powerdMinutes.toFixed(0)} minutes of hardware input by powerd's spans`,
  ].filter((x) => x !== null);
  const out = [
    "# Pending markers on real windows: B5 rules and B6 rules",
    "",
    `A read-only audit instance (its own caret-screen and helper, Jev off) ran from ${time(s.startedAt)} to ${time(s.updatedAt)} (Chicago time), ${(h * 60).toFixed(0)} minutes${active.length === 0 ? "" : `, with ${active.join(" and ")}`}. Each time the user left a window it applied both rule sets to the same window and counted which rules fired. Each set holds its own simulated watches: one per window, at most ${MAX_WATCHES}, ended when that set's markers are gone. The audit asked its reader to re-read every window either set watched. Rates are per wall-clock hour.`,
    "",
    "- *B5 rules*: the words of the window's first 400 lines (B4's markers, as B5 audited them).",
    "- *B6 rules*: windowMarkers in helper/src/tasks/pending.ts. Indicators by role; an enabled Stop button by the message composer; and a text status only when it is the window's own, neither inside a list item (button, link, row, tab) nor in a sidebar.",
    "",
    "## Before and after",
    "",
    "| | B5 rules | B6 rules |",
    "|---|---:|---:|",
    row("Leaves with markers", (n) => n.leavesWithMarkers),
    row("Leaves with markers per hour", (n) => (n.leavesWithMarkers / h).toFixed(1)),
    row("Watches registered", (n) => n.watches),
    row("Watches whose markers cleared", (n) => n.cleared),
    row("Watches never cleared (open at the end or replaced)", (n) => n.neverCleared),
    row("Window closed first", (n) => n.closedFirst),
    row("User came back after the clear", (n) => n.returnedAfterClear),
    row(`Of those, more than ${SLOW_RETURN_MS / 1000} s after the clear`, (n) => n.slowReturns),
    row("Returns while the markers still showed", (n) => n.returnsWhileMarked),
    "",
    "## By app",
    "",
    "| App | Leaves | With markers, B5 | With markers, B6 | Watches, B5 | Watches, B6 | Cleared, B5 | Cleared, B6 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...appKeys
      .sort((x, y) => (app("b5", y)?.withMarkers ?? 0) + (app("b6", y)?.withMarkers ?? 0) - (app("b5", x)?.withMarkers ?? 0) - (app("b6", x)?.withMarkers ?? 0) || (app("b5", y)?.checks ?? 0) - (app("b5", x)?.checks ?? 0))
      .map(
        (k) =>
          `| ${k} | ${app("b5", k)?.checks ?? 0} | ${app("b5", k)?.withMarkers ?? 0} | ${app("b6", k)?.withMarkers ?? 0} | ${app("b5", k)?.watches ?? 0} | ${app("b6", k)?.watches ?? 0} | ${cleared("b5", k)} | ${cleared("b6", k)} |`,
      ),
    "",
    ...ruleSetSection("b5", s.markers.b5, h),
    ...ruleSetSection("b6", s.markers.b6, h),
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
    `The same audit instance, ${time(s.startedAt)} to ${time(s.updatedAt)} (Chicago time). At each focus of an empty editable field it ran the descriptor code (deep plan section 6.1, experiment E3), counted the spans the candidate generator could offer with no cap, timed the capped generator the product runs, and kept only counts. Whether a derived descriptor is the right label was not checked: that needs the text.`,
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
    `- Capped generator time per focus (ms): ${quant(list.map((x) => x.generatorMs))}; stopped on its ${GENERATOR_BUDGET_MS} ms budget ${list.filter((x) => x.overBudget === true).length} of ${list.length}.`,
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

/** The structure census (src/audit-census.ts): where control buttons and text-marker hits sit, per app. Words come from the code's own lists. */
export function renderCensus(s: Pick<AuditSummary, "startedAt" | "updatedAt" | "census">): string {
  const c = s.census;
  const apps = Object.keys(c).filter((k) => {
    const a = c[k] as CensusApp;
    return Object.keys(a.buttons).some((w) => ["stop", "interrupt", "abort", "cancel", "send"].includes(w)) || Object.keys(a.textHits).length > 0;
  });
  const order = apps.sort((x, y) => (c[y] as CensusApp).snapshots - (c[x] as CensusApp).snapshots);
  const words = (r: Record<string, number>): string =>
    Object.entries(r)
      .sort((x, y) => y[1] - x[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
  const buttonRows: string[] = [];
  for (const k of order) {
    const a = c[k] as CensusApp;
    for (const w of ["stop", "interrupt", "abort", "cancel", "send"] as const) {
      const b = a.buttons[w];
      if (b === undefined) continue;
      buttonRows.push(
        `| ${k} | ${w} | ${b.snapshots} of ${a.snapshots} | ${b.buttons} | ${b.nearComposer} | ${b.disabled} | ${b.zone.left} | ${words(b.byQualifier)} | ${b.spans.over10m} of ${Object.values(b.spans).reduce((n, x) => n + x, 0)} |`,
      );
    }
  }
  const textRows: string[] = [];
  for (const k of order) {
    const a = c[k] as CensusApp;
    for (const [r, t] of Object.entries(a.textHits)) {
      if (t === undefined) continue;
      textRows.push(
        `| ${k} | ${r} | ${t.lines} | ${t.inControlOrRow} | ${t.zone.left} | ${t.zone.main + t.zone.bottom} | ${words(t.byParentRole)} | ${words(t.byWord)} | ${t.spans.over10m} of ${Object.values(t.spans).reduce((n, x) => n + x, 0)} |`,
      );
    }
  }
  const out = [
    "# Structure census of real windows",
    "",
    `The audit instance counted the structure of every complete snapshot from ${time(s.startedAt)} to ${time(s.updatedAt)} (Chicago time). A composer is an editable text field or area in the lower 40% of its window and at least a quarter of its width. The sidebar zone is the left 30% of the window. Words in the tables are the code's own lists (control words and their second words, marker verbs), never window text; "(other)" is any second word not on the list. "Lasted over 10 min" counts distinct buttons or lines, by keyed hash, from the first to the last snapshot that showed them.`,
    "",
    "## Control buttons",
    "",
    "| App | First word | Snapshots with one | Buttons | By the composer | Disabled | In the sidebar zone | Second word | Lasted over 10 min |",
    "|---|---|---:|---:|---:|---:|---:|---|---:|",
    ...buttonRows,
    "",
    "## Text-marker hits by place",
    "",
    "| App | Rule | Lines | Inside a button, link, row or tab | In the sidebar zone | Elsewhere | Parent role | Verb | Lasted over 10 min |",
    "|---|---|---:|---:|---:|---:|---|---|---:|",
    ...textRows,
    "",
    "## Snapshots by stop button and status word",
    "",
    "| App | Snapshots | Composers seen | Both | Stop only | Status word only | Neither |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...order.map((k) => {
      const a = c[k] as CensusApp;
      const v = a.stopVsStatusWord;
      return `| ${k} | ${a.snapshots} | ${a.withComposer} | ${v.both} | ${v.stopOnly} | ${v.statusWordOnly} | ${v.neither} |`;
    }),
    "",
  ];
  return `${out.join("\n").trimEnd()}\n`;
}
