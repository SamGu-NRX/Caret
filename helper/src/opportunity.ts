// The opportunity report (deep plan section 10, brief B5 part 1). It reads a copy of the shadow
// logger's store: one row per entry of 6 or more characters, saying whether the entered value
// existed in another readable window during the ten minutes before the field was focused. It
// reports how many entries were findable, per active hour, by value kind and by app pair, and how
// long before the focus the source appeared. Everything it reads and writes is counts, kinds,
// bundle identifiers and timings; the store holds no plain text.
import type { ShadowRow, TransferRow } from "./store.ts";

export interface Span {
  from: number;
  to: number;
}

/**
 * Spans in which a person used the keyboard or trackpad, from `pmset -g log`. powerd raises the
 * UserIsActive assertion "com.apple.powermanagement.kernel.useractive" on input from a hardware
 * device and lets it time out ten minutes after the last input, so one assertion's life is a span
 * with no idle gap of ten minutes or more. Each log line carries the time since the assertion's last
 * update, which dates the last input on Summary and TimedOut lines; a span runs from Created to the
 * last input. Events that agents and fixtures post (CGEventPost) raise WindowServer's own
 * per-process assertions on this Mac and not powerd's (checked against the 2026-10-02 log), so they
 * are not counted. WindowServer's per-device assertions are not used: they can stay raised for days.
 * An assertion still raised when the log ends had input within ten minutes of the log's last line,
 * so its span runs at least that far.
 */
export function humanActiveSpans(log: string): Span[] {
  const line = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4})\s+Assertions\s+PID \d+\(powerd\) (Created|TurnedOn|Summary|TimedOut|Released) UserIsActive "com\.apple\.powermanagement\.kernel\.useractive[^"]*" (\d+):(\d\d):(\d\d)/;
  const stampAt = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4})/;
  let open: Span | null = null;
  let lastStamp = -Infinity;
  const spans: Span[] = [];
  for (const raw of log.split("\n")) {
    const st = stampAt.exec(raw);
    if (st !== null) lastStamp = Math.max(lastStamp, parseStamp(st[1] as string));
    const m = line.exec(raw);
    if (m === null) continue;
    const [, stamp, event, hh, mm, ss] = m as unknown as [string, string, string, string, string, string];
    const at = parseStamp(stamp);
    const lastInput = at - (Number(hh) * 3600 + Number(mm) * 60 + Number(ss)) * 1000;
    if (event === "Created" || event === "TurnedOn") {
      if (open !== null) spans.push(open);
      open = { from: at, to: at };
      continue;
    }
    const span: Span = open ?? { from: lastInput, to: lastInput };
    span.to = Math.max(span.to, lastInput);
    if (event === "Summary") open = span;
    else {
      spans.push(span);
      open = null;
    }
  }
  if (open !== null) spans.push({ from: open.from, to: Math.max(open.to, lastStamp - 10 * 60 * 1000) });
  return mergeSpans(spans);
}

function parseStamp(s: string): number {
  const [date, time, zone] = s.split(" ") as [string, string, string];
  return Date.parse(`${date}T${time}${zone.slice(0, 3)}:${zone.slice(3)}`);
}

export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].filter((s) => s.to >= s.from).sort((a, b) => a.from - b.from);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last !== undefined && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

export function clip(spans: readonly Span[], within: Span): Span[] {
  return spans.map((s) => ({ from: Math.max(s.from, within.from), to: Math.min(s.to, within.to) })).filter((s) => s.to > s.from);
}

const total = (spans: readonly Span[]): number => spans.reduce((n, s) => n + (s.to - s.from), 0);
const inside = (spans: readonly Span[], at: number): boolean => spans.some((s) => at >= s.from && at <= s.to);

export interface Share {
  entries: number;
  findable: number;
  exact: number;
  normalized: number;
}

export interface Gap {
  n: number;
  minMs: number;
  medianMs: number;
  maxMs: number;
}

export interface OpportunityReport {
  coverage: Span & { wallHours: number; activeHours: number | null; activeSpans: number | null };
  counts: { fieldFocuses: number; appSwitches: number; shortEntries: number };
  all: Share;
  /** Entries made while a person was using the keyboard or trackpad; null without activity spans. */
  active: Share | null;
  perActiveHour: number | null;
  perWallHour: number;
  byKind: Record<string, Share>;
  byDestination: Record<string, Share>;
  /** Findable entries by source and destination app. */
  byPair: Record<string, number>;
  gap: Gap | null;
  transfers: { n: number; byKind: Record<string, number>; byPair: Record<string, number>; byAttribution: Record<string, number>; gap: Gap | null };
}

const emptyShare = (): Share => ({ entries: 0, findable: 0, exact: 0, normalized: 0 });
function addTo(s: Share, r: ShadowRow): void {
  s.entries++;
  if (r.existed !== "no") s.findable++;
  if (r.existed === "exact") s.exact++;
  if (r.existed === "normalized") s.normalized++;
}

function gapOf(ms: readonly number[]): Gap | null {
  if (ms.length === 0) return null;
  const s = [...ms].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
  return { n: s.length, minMs: s[0] as number, medianMs: median, maxMs: s.at(-1) as number };
}

const bump = (m: Record<string, number>, k: string): void => {
  m[k] = (m[k] ?? 0) + 1;
};

export interface ReportInput {
  episodes: readonly ShadowRow[];
  transfers: readonly TransferRow[];
  counts: Readonly<Record<string, number>>;
  coverage: Span;
  /** Human activity spans, or null when they are not known. */
  activeSpans: readonly Span[] | null;
}

export function opportunityReport(input: ReportInput): OpportunityReport {
  const { coverage } = input;
  const eps = input.episodes.filter((e) => e.at >= coverage.from && e.at <= coverage.to);
  const active = input.activeSpans === null ? null : clip(mergeSpans(input.activeSpans), coverage);
  const activeMs = active === null ? null : total(active);
  const all = emptyShare();
  const activeShare = active === null ? null : emptyShare();
  const byKind: Record<string, Share> = {};
  const byDestination: Record<string, Share> = {};
  const byPair: Record<string, number> = {};
  const gaps: number[] = [];
  for (const e of eps) {
    addTo(all, e);
    if (active !== null && activeShare !== null && inside(active, e.at)) addTo(activeShare, e);
    addTo((byKind[e.kind ?? "text"] ??= emptyShare()), e);
    addTo((byDestination[e.dstBundle] ??= emptyShare()), e);
    if (e.existed !== "no") {
      bump(byPair, `${e.srcBundle ?? "?"} -> ${e.dstBundle}`);
      if (e.srcAgeMs !== null) gaps.push(e.srcAgeMs);
    }
  }
  const ts = input.transfers.filter((t) => t.at >= coverage.from && t.at <= coverage.to);
  const tKind: Record<string, number> = {};
  const tPair: Record<string, number> = {};
  const tAttr: Record<string, number> = {};
  for (const t of ts) {
    bump(tKind, t.kind ?? "text");
    bump(tPair, `${t.srcBundle} -> ${t.dstBundle}`);
    bump(tAttr, t.attribution);
  }
  const wallMs = coverage.to - coverage.from;
  const hours = (ms: number): number => ms / 3_600_000;
  // Opportunities per active hour count only entries made inside the activity spans.
  const activeFindable = activeShare?.findable ?? null;
  return {
    coverage: { ...coverage, wallHours: hours(wallMs), activeHours: activeMs === null ? null : hours(activeMs), activeSpans: active?.length ?? null },
    counts: {
      fieldFocuses: input.counts["shadow.field_focus"] ?? 0,
      appSwitches: input.counts["shadow.app_switch"] ?? 0,
      shortEntries: input.counts["shadow.entry_short"] ?? 0,
    },
    all,
    active: activeShare,
    perActiveHour: activeMs === null || activeMs === 0 || activeFindable === null ? null : activeFindable / hours(activeMs),
    perWallHour: wallMs === 0 ? 0 : all.findable / hours(wallMs),
    byKind,
    byDestination,
    byPair,
    gap: gapOf(gaps),
    transfers: { n: ts.length, byKind: tKind, byPair: tPair, byAttribution: tAttr, gap: gapOf(ts.map((t) => t.ageMs)) },
  };
}

const pct = (s: Share): string => (s.entries === 0 ? "n/a" : `${Math.round((100 * s.findable) / s.entries)}%`);
const secs = (ms: number): string => (ms < 60_000 ? `${(ms / 1000).toFixed(0)} s` : `${(ms / 60_000).toFixed(1)} min`);
const time = (at: number): string => new Date(at).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });

function shareTable(title: string, rows: Record<string, Share>): string[] {
  const keys = Object.keys(rows).sort((a, b) => (rows[b]?.entries ?? 0) - (rows[a]?.entries ?? 0) || a.localeCompare(b));
  if (keys.length === 0) return [`${title}: none.`, ""];
  return [
    `| ${title} | Entries | Findable | Exact | Normalized | Share |`,
    "|---|---:|---:|---:|---:|---:|",
    ...keys.map((k) => {
      const s = rows[k] as Share;
      return `| ${k} | ${s.entries} | ${s.findable} | ${s.exact} | ${s.normalized} | ${pct(s)} |`;
    }),
    "",
  ];
}

function countTable(title: string, rows: Record<string, number>): string[] {
  const keys = Object.keys(rows).sort((a, b) => (rows[b] ?? 0) - (rows[a] ?? 0) || a.localeCompare(b));
  if (keys.length === 0) return [`${title}: none.`, ""];
  return [`| ${title} | Count |`, "|---|---:|", ...keys.map((k) => `| ${k} | ${rows[k]} |`), ""];
}

const gapLine = (g: Gap | null): string => (g === null ? "none" : `${g.n} values; min ${secs(g.minMs)}, median ${secs(g.medianMs)}, max ${secs(g.maxMs)}`);

/** Markdown for the report. Counts, bundle identifiers and timings only. */
export function renderOpportunity(r: OpportunityReport): string {
  const c = r.coverage;
  const out = [
    "# Shadow log: opportunity report",
    "",
    "Regenerate with `node scripts/shadow-report.ts` in the helper. An entry is a value of 6 or more characters the user entered into a field; it is findable when the same value, exactly or after normalization, was on screen in another readable window during the ten minutes before the field was focused.",
    "",
    "## Coverage",
    "",
    `- From ${time(c.from)} to ${time(c.to)} (Chicago time): ${c.wallHours.toFixed(2)} wall-clock hours.`,
    c.activeHours === null
      ? "- Active hours: unknown (no activity spans given)."
      : `- Active hours: ${c.activeHours.toFixed(2)}, in ${c.activeSpans} span${c.activeSpans === 1 ? "" : "s"} of keyboard or trackpad input from \`pmset -g log\`. Input posted by agents and test fixtures is excluded.`,
    `- Field focuses ${r.counts.fieldFocuses}, app switches ${r.counts.appSwitches}, entries under 6 characters ${r.counts.shortEntries} (whole days from the store's daily counts, so they can include time outside the window above).`,
    "",
    "## Headline",
    "",
    `- Entries of 6 or more characters: ${r.all.entries}. Findable: ${r.all.findable} (${pct(r.all)}); exact ${r.all.exact}, normalized ${r.all.normalized}.`,
    r.active === null
      ? "- Entries during active spans: unknown."
      : `- Entries during active spans: ${r.active.entries}, findable ${r.active.findable} (${pct(r.active)}). The rest were made while no hardware input was recorded, so agents or fixtures may have made them.`,
    `- Opportunities per active hour: ${r.perActiveHour === null ? "unknown" : r.perActiveHour.toFixed(2)}. Per wall-clock hour: ${r.perWallHour.toFixed(2)}.`,
    `- Time from the source appearing to the field focus: ${gapLine(r.gap)}.`,
    "",
    "## By value kind",
    "",
    "`text` is an entry with no detected kind.",
    "",
    ...shareTable("Kind", r.byKind),
    "## By destination app",
    "",
    ...shareTable("Destination", r.byDestination),
    "## Findable entries by app pair",
    "",
    ...countTable("Source -> destination", r.byPair),
    "## Transfers",
    "",
    "The transfer log is the same question asked of every settled field edit, not only focused entries, with the source allowed to appear any time before the edit settled.",
    "",
    `- Transfers: ${r.transfers.n}. Time from the source appearing to the edit: ${gapLine(r.transfers.gap)}.`,
    "",
    ...countTable("Kind", r.transfers.byKind),
    ...countTable("Source -> destination", r.transfers.byPair),
    ...countTable("Attribution", r.transfers.byAttribution),
  ];
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
