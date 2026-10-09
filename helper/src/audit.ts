// The read-only audit (briefs B5 and B6). It rides on a helper in shadow mode with Jev off and counts,
// on real windows, what the pending watch and the grounded-fill generator would have done:
//   - each time the user leaves a window, which marker rules fire, per app, and whether the window
//     would have become a watch; for those windows, when the markers cleared and when the user next
//     came back after that, the code-only proxy for deep plan section 6.4's kill experiment. With Jev
//     off, markers clearing stands in for Jev answering that the work finished, so a simulated watch
//     ends there, where the product's would end on Jev's answer. Two rule sets run side by side on the
//     same leaves: B5's (the words of the first 400 lines) and B6's (windowMarkers, by structure);
//   - at every focus of an empty editable field, whether code derives a field descriptor and from
//     what, and how many candidate spans the generator collects (section 6.1, experiment E3).
// It keeps counts, bundle identifiers and keyed hashes. The only text it holds is the screen
// model's, in memory, as the helper already does. Its one message to the reader is watchWindows,
// which only reads.
import { createHmac, randomBytes } from "node:crypto";
import type { ScreenModel, WindowState } from "./model.ts";
import type { Focus, ReaderVerb, Snapshot, VerbResult } from "./protocol.ts";
import { MARKER_RULE_IDS, MAX_WATCHES, markerRule, watchLines, windowMarkers, type Marker, type MarkerRule } from "./tasks/pending.ts";
import { describeField } from "./fill/descriptor.ts";
import { collectCandidates, countSpans, MAX_CANDIDATES, type GeneratorProfile } from "./fill/candidates.ts";
import { formFields } from "./fill/fill.ts";
import { SeenSet } from "./leak-check.ts";
import { Census, type CensusApp } from "./audit-census.ts";

type RuleCounts = Record<MarkerRule, number>;
const zeroRules = (): RuleCounts => Object.fromEntries(MARKER_RULE_IDS.map((r) => [r, 0])) as RuleCounts;

export interface MarkerAppCounts {
  /** Times the user left a window of this app and code looked for markers. */
  checks: number;
  /** Checks where at least one marker fired. */
  withMarkers: number;
  /** Checks where each rule fired on at least one line. */
  checksByRule: RuleCounts;
  /** Lines each rule fired on, over all checks. */
  linesByRule: RuleCounts;
  /** Distinct windows that showed markers on some leave. */
  windowsWithMarkers: number;
  /** Watches B4 would have registered. */
  watches: number;
}

/** One simulated watch, from the leave that registered it until the user came back after its markers cleared. */
export interface WatchEpisode {
  bundleId: string;
  rule: MarkerRule;
  /**
   * returned: the user came back after the markers cleared. closed: the window closed first.
   * replaced: the window was watched again for new work before the user came back. auditEnded: still open at the end.
   */
  end: "returned" | "closed" | "replaced" | "auditEnded";
  /** Milliseconds from the registering leave to the first complete read with no marker, or null if markers never cleared. */
  clearedAfterMs: number | null;
  /** Milliseconds from the registering leave to the first return after the markers cleared. */
  returnedAfterMs: number | null;
  /** Times the user came back while the markers still showed. */
  returnsWhileRunning: number;
}

export type DescriptorSource = "label" | "nearest" | "placeholder" | "sectionOnly" | "none";

export interface FillAppCounts {
  focuses: number;
  /** Code derived a descriptor from the field's own label, its placeholder or the nearest text. */
  derivable: number;
  bySource: Record<DescriptorSource, number>;
  /** Each field part code found, counted independently. */
  hasLabel: number;
  hasPlaceholder: number;
  hasNearest: number;
  hasSection: number;
}

export interface FillFocus {
  bundleId: string;
  role: string;
  source: DescriptorSource;
  /** Distinct spans available with no cap (countSpans), typed values among them, and empty fields in the form. */
  candidates: number;
  typedCandidates: number;
  formFields: number;
  /** Time of the capped generator the product runs, and whether it stopped on its budget. Before B6 this was the uncapped generator's time. */
  generatorMs: number;
  /** CPU time of the same call, user and system, all threads. Absent before B6's final run. */
  generatorCpuMs?: number;
  /** CPU time of the event-loop thread alone (process.threadCpuUsage): the generator's own work, without V8's GC and compiler threads. From B8. */
  generatorThreadCpuMs?: number;
  overBudget?: boolean;
}

export interface MarkerSummary {
  rules: readonly MarkerRule[];
  byApp: Record<string, MarkerAppCounts>;
  /** Distinct marker lines per rule, counted by hash. */
  distinctLines: RuleCounts;
  watches: { registered: number; overLimit: number; maxConcurrent: number };
  episodes: WatchEpisode[];
}

/** The rule sets the audit compares: B5's words-only rules and B6's structure rules. */
export type RuleSet = "b5" | "b6";
export const RULE_SETS: Record<RuleSet, (w: WindowState) => Marker[]> = {
  b5: (w) =>
    watchLines(w, "head").flatMap((line) => {
      const rule = markerRule(line);
      return rule === null ? [] : [{ rule, line }];
    }),
  b6: windowMarkers,
};

export interface AuditSummary {
  startedAt: number;
  updatedAt: number;
  markers: Record<RuleSet, MarkerSummary>;
  fill: {
    /** Every focus message, editable ones, and empty editable ones. */
    focuses: number;
    editableFocuses: number;
    emptyEditable: number;
    /** Empty editable focuses skipped: the field was not in the model, or it is a secure field. */
    nodeMissing: number;
    secure: number;
    /** Empty editable fields measured, and how many distinct fields they were. */
    measured: number;
    distinctFields: number;
    byApp: Record<string, FillAppCounts>;
    focusesList: FillFocus[];
    candidateCap: number;
  };
  probes: GeneratorProbe[];
  seen: { units: number };
  /** Structure counts per app from every complete snapshot (src/audit-census.ts). */
  census: Record<string, CensusApp>;
}

/** One departure from a window: the helper may report it up to three times (app switch, leave walk, focus elsewhere). */
interface Departure {
  marked: boolean;
  skipCounted: boolean;
}

interface OpenEpisode {
  bundleId: string;
  rule: MarkerRule;
  at: number;
  clearedAt: number | null;
  returnsWhileRunning: number;
}

/**
 * The watches one rule set would hold: registered on a leave with markers, ended when the markers
 * clear or the window closes, with the counts and episodes the report needs.
 */
class MarkerTrack {
  private readonly find: (w: WindowState) => Marker[];
  private readonly hash: (s: string) => string;
  private readonly apps = new Map<string, MarkerAppCounts>();
  private readonly markerWindows = new Map<string, Set<string>>();
  private readonly markerLines = new Map<MarkerRule, Set<string>>();
  /** Watched window id to its app's pid. */
  readonly watches = new Map<string, number>();
  private readonly open = new Map<string, OpenEpisode>();
  private readonly departed = new Map<string, Departure>();
  private readonly watchStats = { registered: 0, overLimit: 0, maxConcurrent: 0 };
  private readonly episodes: WatchEpisode[] = [];

  constructor(find: (w: WindowState) => Marker[], hash: (s: string) => string) {
    this.find = find;
    this.hash = hash;
  }

  /** Returns true when the set of watched windows changed. */
  onSnapshot(m: Snapshot, w: WindowState | undefined): boolean {
    const id = m.window.windowId;
    let changed = false;
    // A truncated walk may have missed the indicator, so it is no evidence that the markers cleared.
    if (this.watches.has(id) && w !== undefined && !m.stats.truncated && this.find(w).length === 0) {
      const ep = this.open.get(id);
      if (ep !== undefined && ep.clearedAt === null) ep.clearedAt = m.at;
      this.watches.delete(id);
      changed = true;
    }
    // The user is back in a window they left: its focused walk, after any check above.
    if (m.focused && this.departed.delete(id)) {
      const ep = this.open.get(id);
      if (ep !== undefined) {
        if (ep.clearedAt === null) ep.returnsWhileRunning++;
        else this.finish(id, ep, "returned", m.at);
      }
    }
    return changed;
  }

  /** The user left this window: the moments PendingWatcher.left is called. Returns true when a watch was added. */
  left(windowId: string, w: WindowState, at: number): boolean {
    const bundle = w.app.bundleId;
    const app = this.app(bundle);
    let dep = this.departed.get(windowId);
    if (dep === undefined) {
      this.departed.set(windowId, (dep = { marked: false, skipCounted: false }));
      app.checks++;
    }
    const markers = this.find(w);
    const first = markers[0]?.rule;
    for (const mk of markers) {
      let set = this.markerLines.get(mk.rule);
      if (set === undefined) this.markerLines.set(mk.rule, (set = new Set()));
      set.add(this.hash(mk.line));
    }
    if (first === undefined) return false;
    // A departure counts once; a later report of it (a fresher leave walk) may be the one that shows markers.
    if (!dep.marked) {
      dep.marked = true;
      app.withMarkers++;
      for (const r of new Set(markers.map((mk) => mk.rule))) app.checksByRule[r]++;
      for (const mk of markers) app.linesByRule[mk.rule]++;
      let wins = this.markerWindows.get(bundle);
      if (wins === undefined) this.markerWindows.set(bundle, (wins = new Set()));
      if (!wins.has(windowId)) {
        wins.add(windowId);
        app.windowsWithMarkers++;
      }
    }

    // The watcher's registration rules, applied on every report as it does: one watch per window, at
    // most MAX_WATCHES. It also skips a window left again with the text Jev called finished; here a
    // watch ends only when its markers are gone, so that text never carries markers and the rule never applies.
    if (this.watches.has(windowId)) return false;
    if (this.watches.size >= MAX_WATCHES) {
      if (!dep.skipCounted) {
        dep.skipCounted = true;
        this.watchStats.overLimit++;
      }
      return false;
    }
    const prior = this.open.get(windowId);
    if (prior !== undefined) this.finish(windowId, prior, "replaced", at);
    this.watches.set(windowId, w.app.pid);
    this.open.set(windowId, { bundleId: bundle, rule: first, at, clearedAt: null, returnsWhileRunning: 0 });
    this.watchStats.registered++;
    this.watchStats.maxConcurrent = Math.max(this.watchStats.maxConcurrent, this.watches.size);
    app.watches++;
    return true;
  }

  /** Returns true when a watched window closed. */
  onWindowClosed(windowId: string, at: number): boolean {
    const ep = this.open.get(windowId);
    if (ep !== undefined) this.finish(windowId, ep, "closed", at);
    this.departed.delete(windowId);
    return this.watches.delete(windowId);
  }

  readerRestarted(at: number): void {
    this.stop(at);
    this.watches.clear();
    this.departed.clear();
  }

  stop(at: number): void {
    for (const [id, ep] of [...this.open]) this.finish(id, ep, "auditEnded", at);
  }

  summary(): MarkerSummary {
    const distinctLines = zeroRules();
    for (const [r, set] of this.markerLines) distinctLines[r] = set.size;
    return {
      rules: MARKER_RULE_IDS,
      byApp: structuredClone(Object.fromEntries(this.apps)),
      distinctLines,
      watches: { ...this.watchStats },
      episodes: [...this.episodes],
    };
  }

  private finish(windowId: string, ep: OpenEpisode, end: WatchEpisode["end"], at: number): void {
    this.open.delete(windowId);
    this.episodes.push({
      bundleId: ep.bundleId,
      rule: ep.rule,
      end,
      clearedAfterMs: ep.clearedAt === null ? null : ep.clearedAt - ep.at,
      returnedAfterMs: end === "returned" ? at - ep.at : null,
      returnsWhileRunning: ep.returnsWhileRunning,
    });
  }

  private app(bundle: string): MarkerAppCounts {
    let a = this.apps.get(bundle);
    if (a === undefined) {
      a = { checks: 0, withMarkers: 0, checksByRule: zeroRules(), linesByRule: zeroRules(), windowsWithMarkers: 0, watches: 0 };
      this.apps.set(bundle, a);
    }
    return a;
  }
}

export interface AuditOptions {
  model: ScreenModel;
  /** Sends watchWindows to the audit's own reader, so watched windows are re-read as the watcher would have them. */
  reader?: (verb: ReaderVerb) => Promise<VerbResult>;
  salt?: Buffer;
  now?: () => number;
  /**
   * How often tick() times the generator against the real windows as a focus in the frontmost window
   * would run it, whether or not the user focuses anything; 0 or absent for never.
   */
  probeEveryMs?: number;
}

/**
 * One probe: the generator run twice back to back for the frontmost window, as a focus there would run
 * it. The first call pays for any per-window indexes the snapshots since the last call made stale; the
 * second finds them built. Counts and times only.
 */
export interface GeneratorProbe {
  at: number;
  bundleId: string;
  windows: number;
  nodes: number;
  /** `cpuMs` counts every thread of the process; `threadCpuMs` the event-loop thread alone. */
  first: { wallMs: number; cpuMs: number; threadCpuMs: number; overBudget: boolean; values: number; nodesRead: number; profile: GeneratorProfile };
  second: { wallMs: number; cpuMs: number; threadCpuMs: number };
}

/** Probes kept in the summary; at one every 30 s this is over eight hours. */
const MAX_PROBES = 1000;

export class Audit {
  private readonly model: ScreenModel;
  private readonly opts: AuditOptions;
  /** In-memory key for hashing marker lines and field ids; never written anywhere. */
  private readonly key = randomBytes(32);
  readonly seen: SeenSet;
  private readonly census = new Census();
  private readonly tracks: Record<RuleSet, MarkerTrack>;
  private readonly fill = { focuses: 0, editableFocuses: 0, emptyEditable: 0, nodeMissing: 0, secure: 0, measured: 0 };
  private readonly fields = new Set<string>();
  private readonly fillApps = new Map<string, FillAppCounts>();
  private readonly focusesList: FillFocus[] = [];
  private readonly probes: GeneratorProbe[] = [];
  private lastProbe = 0;
  private readonly startedAt: number;

  constructor(opts: AuditOptions) {
    this.model = opts.model;
    this.opts = opts;
    this.seen = new SeenSet(opts.salt);
    this.startedAt = this.now();
    const hash = (t: string): string => this.hash(t);
    this.tracks = { b5: new MarkerTrack(RULE_SETS.b5, hash), b6: new MarkerTrack(RULE_SETS.b6, hash) };
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private hash(s: string): string {
    return createHmac("sha256", this.key).update(s).digest("hex").slice(0, 16);
  }

  /**
   * A snapshot was applied. Records what it showed (hashes only), counts its structure, checks
   * whether a watched window's markers cleared, and notes the user's return to a watched window.
   */
  onSnapshot(m: Snapshot): void {
    const bundle = m.app.bundleId;
    this.seen.add(m.window.title, bundle);
    for (const n of m.nodes) {
      if (n.label !== undefined) this.seen.add(n.label, bundle);
      if (n.value !== undefined) this.seen.add(n.value, bundle);
      if (n.placeholder !== undefined) this.seen.add(n.placeholder, bundle);
    }
    for (const v of m.values) this.seen.add(v.text, bundle);

    const w = this.model.windows.get(m.window.windowId);
    if (w !== undefined && !m.stats.truncated) this.census.observe(w, m.at);
    let changed = false;
    for (const t of Object.values(this.tracks)) changed = t.onSnapshot(m, w) || changed;
    if (changed) this.syncReader();
  }

  /** The user left this window: the same moments PendingWatcher.left is called. */
  left(windowId: string, at: number): void {
    const w = this.model.windows.get(windowId);
    if (w === undefined) return;
    let added = false;
    for (const t of Object.values(this.tracks)) added = t.left(windowId, w, at) || added;
    if (added) this.syncReader();
  }

  onWindowClosed(windowId: string, at: number): void {
    let changed = false;
    for (const t of Object.values(this.tracks)) changed = t.onWindowClosed(windowId, at) || changed;
    if (changed) this.syncReader();
  }

  /** A new reader numbers windows from scratch; open episodes end as if the audit stopped. */
  readerRestarted(at: number): void {
    for (const t of Object.values(this.tracks)) t.readerRestarted(at);
  }

  onFocus(m: Focus): void {
    this.fill.focuses++;
    if (!m.editable) return;
    this.fill.editableFocuses++;
    if (!m.empty || m.key === null) return;
    this.fill.emptyEditable++;
    const w = this.model.windows.get(m.windowId);
    const node = w?.nodes.get(m.key);
    if (w === undefined || node === undefined) {
      this.fill.nodeMissing++;
      return;
    }
    if (node.states?.includes("secure")) {
      this.fill.secure++;
      return;
    }
    this.fill.measured++;
    this.fields.add(this.hash(`${m.windowId}\u0000${m.key}`));
    const d = describeField(w, node);
    const source: DescriptorSource =
      d.label !== null ? "label" : d.nearest !== null ? "nearest" : d.placeholder !== null ? "placeholder" : d.section !== null ? "sectionOnly" : "none";
    const app = this.fillApp(w.app.bundleId);
    app.focuses++;
    app.bySource[source]++;
    if (source === "label" || source === "nearest" || source === "placeholder") app.derivable++;
    if (d.label !== null) app.hasLabel++;
    if (d.placeholder !== null) app.hasPlaceholder++;
    if (d.nearest !== null) app.hasNearest++;
    if (d.section !== null) app.hasSection++;
    // The product's generator, capped and on its budget, as a live helper would run it on this focus.
    // CPU time beside wall time: on a loaded Mac, or with this audit's own hashing behind a GC pause, wall time alone cannot say what the generator cost.
    const c0 = process.cpuUsage();
    const t0 = process.threadCpuUsage();
    const { stats } = collectCandidates(this.model, m.windowId, { now: m.at });
    const thread = process.threadCpuUsage(t0);
    const cpu = process.cpuUsage(c0);
    const all = countSpans(this.model, m.windowId);
    this.focusesList.push({
      bundleId: w.app.bundleId,
      role: node.role,
      source,
      candidates: all.spans,
      typedCandidates: all.typed,
      formFields: formFields(w, m.key).length,
      generatorMs: Math.round(stats.ms * 10) / 10,
      generatorCpuMs: Math.round((cpu.user + cpu.system) / 100) / 10,
      generatorThreadCpuMs: Math.round((thread.user + thread.system) / 100) / 10,
      overBudget: stats.overBudget,
    });
  }

  /** Runs a probe when one is due. */
  tick(now = this.now()): void {
    const every = this.opts.probeEveryMs ?? 0;
    if (every <= 0 || now - this.lastProbe < every || this.probes.length >= MAX_PROBES) return;
    this.lastProbe = now;
    // The frontmost app's focused window. Only before any app switch or focus has said which app that
    // is, the window focused last; a frontmost app with no window in the model yet is skipped.
    const all = [...this.model.windows.values()];
    const front = this.model.frontmostPid;
    const target = front !== null ? all.find((w) => w.focused && w.app.pid === front) : all.filter((w) => w.focused).sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)[0];
    if (target === undefined) return;
    const time = (profile?: GeneratorProfile): { wallMs: number; cpuMs: number; threadCpuMs: number; stats: ReturnType<typeof collectCandidates>["stats"] } => {
      const c0 = process.cpuUsage();
      const t0c = process.threadCpuUsage();
      const t0 = performance.now();
      const { stats } = collectCandidates(this.model, target.window.windowId, { now, ...(profile === undefined ? {} : { profile }) });
      const wallMs = performance.now() - t0;
      const tc = process.threadCpuUsage(t0c);
      const c = process.cpuUsage(c0);
      return { wallMs, cpuMs: (c.user + c.system) / 1000, threadCpuMs: (tc.user + tc.system) / 1000, stats };
    };
    const profile: GeneratorProfile = { split: 0, context: 0, section: 0, blockHead: 0 };
    const first = time(profile);
    const second = time();
    const r = (x: number): number => Math.round(x * 100) / 100;
    let nodes = 0;
    for (const w of this.model.windows.values()) nodes += w.nodes.size;
    this.probes.push({
      at: now,
      bundleId: target.app.bundleId,
      windows: this.model.windows.size,
      nodes,
      first: {
        wallMs: r(first.wallMs),
        cpuMs: r(first.cpuMs),
        threadCpuMs: r(first.threadCpuMs),
        overBudget: first.stats.overBudget,
        values: first.stats.values,
        nodesRead: first.stats.nodes,
        profile: { split: r(profile.split), context: r(profile.context), section: r(profile.section), blockHead: r(profile.blockHead) },
      },
      second: { wallMs: r(second.wallMs), cpuMs: r(second.cpuMs), threadCpuMs: r(second.threadCpuMs) },
    });
  }

  /** Ends every open episode; call once when the audit stops. */
  stop(at = this.now()): void {
    for (const t of Object.values(this.tracks)) t.stop(at);
  }

  summary(): AuditSummary {
    return {
      startedAt: this.startedAt,
      updatedAt: this.now(),
      markers: { b5: this.tracks.b5.summary(), b6: this.tracks.b6.summary() },
      fill: { ...this.fill, distinctFields: this.fields.size, byApp: Object.fromEntries(this.fillApps), focusesList: [...this.focusesList], candidateCap: MAX_CANDIDATES },
      seen: { units: this.seen.size },
      census: this.census.summary(),
      probes: [...this.probes],
    };
  }

  /** Asks the reader to re-read every window either rule set watches. */
  private syncReader(): void {
    const send = this.opts.reader;
    if (send === undefined) return;
    const windows = new Map<string, number>();
    for (const t of Object.values(this.tracks)) for (const [id, pid] of t.watches) windows.set(id, pid);
    void send({ kind: "watchWindows", windows: [...windows].map(([windowId, pid]) => ({ pid, windowId })) }).catch(() => undefined);
  }

  private fillApp(bundle: string): FillAppCounts {
    let a = this.fillApps.get(bundle);
    if (a === undefined) {
      a = {
        focuses: 0,
        derivable: 0,
        bySource: { label: 0, nearest: 0, placeholder: 0, sectionOnly: 0, none: 0 },
        hasLabel: 0,
        hasPlaceholder: 0,
        hasNearest: 0,
        hasSection: 0,
      };
      this.fillApps.set(bundle, a);
    }
    return a;
  }
}
