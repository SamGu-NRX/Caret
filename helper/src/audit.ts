// The read-only audit (brief B5). It rides on a helper in shadow mode with Jev off and counts, on
// real windows, what B4's pending watch and the grounded-fill generator would have done:
//   - each time the user leaves a window, which marker rules fire, per app, and whether the window
//     would have become a watch; for those windows, when the markers cleared and when the user next
//     came back after that, the code-only proxy for deep plan section 6.4's kill experiment. With Jev
//     off, markers clearing stands in for Jev answering that the work finished, so a simulated watch
//     ends there, where B4's would end on Jev's answer;
//   - at every focus of an empty editable field, whether code derives a field descriptor and from
//     what, and how many candidate spans the generator collects (section 6.1, experiment E3).
// It keeps counts, bundle identifiers and keyed hashes. The only text it holds is the screen
// model's, in memory, as the helper already does. Its one message to the reader is watchWindows,
// which only reads.
import { createHmac, randomBytes } from "node:crypto";
import type { ScreenModel } from "./model.ts";
import type { Focus, ReaderVerb, Snapshot, VerbResult } from "./protocol.ts";
import { MARKER_RULE_IDS, MAX_WATCHES, markerRule, watchLines, type MarkerRule } from "./tasks/pending.ts";
import { describeField } from "./fill/descriptor.ts";
import { generateCandidates, MAX_CANDIDATES } from "./fill/candidates.ts";
import { formFields } from "./fill/fill.ts";
import { SeenSet } from "./leak-check.ts";

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
  /** Candidate spans before the generator's cap, typed values among them, and empty fields in the form. */
  candidates: number;
  typedCandidates: number;
  formFields: number;
  generatorMs: number;
}

export interface AuditSummary {
  startedAt: number;
  updatedAt: number;
  markers: {
    rules: readonly MarkerRule[];
    byApp: Record<string, MarkerAppCounts>;
    /** Distinct marker lines per rule, counted by hash. */
    distinctLines: RuleCounts;
    watches: { registered: number; overLimit: number; maxConcurrent: number };
    episodes: WatchEpisode[];
  };
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
  seen: { units: number };
}

/** A watch B4 would hold: registered on a leave with markers, ended when the markers clear or the window closes. */
interface SimWatch {
  pid: number;
}

interface OpenEpisode {
  bundleId: string;
  rule: MarkerRule;
  at: number;
  clearedAt: number | null;
  returnsWhileRunning: number;
}

/** One departure from a window: the helper may report it up to three times (app switch, leave walk, focus elsewhere). */
interface Departure {
  marked: boolean;
  skipCounted: boolean;
}

export interface AuditOptions {
  model: ScreenModel;
  /** Sends watchWindows to the audit's own reader, so watched windows are re-read as B4 would have them. */
  reader?: (verb: ReaderVerb) => Promise<VerbResult>;
  salt?: Buffer;
  now?: () => number;
}

export class Audit {
  private readonly model: ScreenModel;
  private readonly opts: AuditOptions;
  /** In-memory key for hashing marker lines and field ids; never written anywhere. */
  private readonly key = randomBytes(32);
  readonly seen: SeenSet;
  private readonly markerApps = new Map<string, MarkerAppCounts>();
  private readonly markerWindows = new Map<string, Set<string>>();
  private readonly markerLines = new Map<MarkerRule, Set<string>>();
  private readonly watches = new Map<string, SimWatch>();
  private readonly open = new Map<string, OpenEpisode>();
  private readonly departed = new Map<string, Departure>();
  private readonly watchStats = { registered: 0, overLimit: 0, maxConcurrent: 0 };
  private readonly episodes: WatchEpisode[] = [];
  private readonly fill = { focuses: 0, editableFocuses: 0, emptyEditable: 0, nodeMissing: 0, secure: 0, measured: 0 };
  private readonly fields = new Set<string>();
  private readonly fillApps = new Map<string, FillAppCounts>();
  private readonly focusesList: FillFocus[] = [];
  private readonly startedAt: number;

  constructor(opts: AuditOptions) {
    this.model = opts.model;
    this.opts = opts;
    this.seen = new SeenSet(opts.salt);
    this.startedAt = this.now();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private hash(s: string): string {
    return createHmac("sha256", this.key).update(s).digest("hex").slice(0, 16);
  }

  /**
   * A snapshot was applied. Records what it showed (hashes only), checks whether a watched window's
   * markers cleared, and notes the user's return to a watched window.
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

    const id = m.window.windowId;
    const w = this.model.windows.get(id);
    // A truncated walk may have missed the indicator, so it is no evidence that the markers cleared.
    if (this.watches.has(id) && w !== undefined && !m.stats.truncated) {
      const lines = watchLines(w);
      if (!lines.some((l) => markerRule(l) !== null)) {
        const ep = this.open.get(id);
        if (ep !== undefined && ep.clearedAt === null) ep.clearedAt = m.at;
        this.watches.delete(id);
        this.syncReader();
      }
    }
    // The user is back in a window they left: its focused walk, after any check above.
    if (m.focused && this.departed.delete(id)) {
      const ep = this.open.get(id);
      if (ep !== undefined) {
        if (ep.clearedAt === null) ep.returnsWhileRunning++;
        else this.finish(id, ep, "returned", m.at);
      }
    }
  }

  /** The user left this window: the same moments B4's PendingWatcher.left is called. */
  left(windowId: string, at: number): void {
    const w = this.model.windows.get(windowId);
    if (w === undefined) return;
    const bundle = w.app.bundleId;
    const app = this.markerApp(bundle);
    let dep = this.departed.get(windowId);
    if (dep === undefined) {
      this.departed.set(windowId, (dep = { marked: false, skipCounted: false }));
      app.checks++;
    }
    const lines = watchLines(w);
    const rules = lines.map((l) => markerRule(l));
    let first: MarkerRule | null = null;
    for (const [i, r] of rules.entries()) {
      if (r === null) continue;
      first ??= r;
      let set = this.markerLines.get(r);
      if (set === undefined) this.markerLines.set(r, (set = new Set()));
      set.add(this.hash(lines[i] as string));
    }
    if (first === null) return;
    // A departure counts once; a later report of it (a fresher leave walk) may be the one that shows markers.
    if (!dep.marked) {
      dep.marked = true;
      app.withMarkers++;
      for (const r of new Set(rules)) if (r !== null) app.checksByRule[r]++;
      for (const r of rules) if (r !== null) app.linesByRule[r]++;
      let wins = this.markerWindows.get(bundle);
      if (wins === undefined) this.markerWindows.set(bundle, (wins = new Set()));
      if (!wins.has(windowId)) {
        wins.add(windowId);
        app.windowsWithMarkers++;
      }
    }

    // B4's registration rules, applied on every report as B4 does: one watch per window, at most
    // MAX_WATCHES. B4 also skips a window left again with the text Jev called finished; here a watch
    // ends only when its markers are gone, so that text never carries markers and the rule never applies.
    if (this.watches.has(windowId)) return;
    if (this.watches.size >= MAX_WATCHES) {
      if (!dep.skipCounted) {
        dep.skipCounted = true;
        this.watchStats.overLimit++;
      }
      return;
    }
    const prior = this.open.get(windowId);
    if (prior !== undefined) this.finish(windowId, prior, "replaced", at);
    this.watches.set(windowId, { pid: w.app.pid });
    this.open.set(windowId, { bundleId: bundle, rule: first, at, clearedAt: null, returnsWhileRunning: 0 });
    this.watchStats.registered++;
    this.watchStats.maxConcurrent = Math.max(this.watchStats.maxConcurrent, this.watches.size);
    app.watches++;
    this.syncReader();
  }

  onWindowClosed(windowId: string, at: number): void {
    const ep = this.open.get(windowId);
    if (ep !== undefined) this.finish(windowId, ep, "closed", at);
    if (this.watches.delete(windowId)) this.syncReader();
    this.departed.delete(windowId);
  }

  /** A new reader numbers windows from scratch; open episodes end as if the audit stopped. */
  readerRestarted(at: number): void {
    this.stop(at);
    this.watches.clear();
    this.departed.clear();
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
    const t0 = performance.now();
    const candidates = generateCandidates(this.model, m.windowId, Number.POSITIVE_INFINITY, m.at);
    const generatorMs = performance.now() - t0;
    this.focusesList.push({
      bundleId: w.app.bundleId,
      role: node.role,
      source,
      candidates: candidates.length,
      typedCandidates: candidates.filter((c) => c.kind !== null).length,
      formFields: formFields(w, m.key).length,
      generatorMs: Math.round(generatorMs * 10) / 10,
    });
  }

  /** Ends every open episode; call once when the audit stops. */
  stop(at = this.now()): void {
    for (const [id, ep] of [...this.open]) this.finish(id, ep, "auditEnded", at);
  }

  summary(): AuditSummary {
    const distinctLines = zeroRules();
    for (const [r, s] of this.markerLines) distinctLines[r] = s.size;
    return {
      startedAt: this.startedAt,
      updatedAt: this.now(),
      markers: {
        rules: MARKER_RULE_IDS,
        byApp: Object.fromEntries(this.markerApps),
        distinctLines,
        watches: { ...this.watchStats },
        episodes: [...this.episodes],
      },
      fill: { ...this.fill, distinctFields: this.fields.size, byApp: Object.fromEntries(this.fillApps), focusesList: [...this.focusesList], candidateCap: MAX_CANDIDATES },
      seen: { units: this.seen.size },
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

  private syncReader(): void {
    const send = this.opts.reader;
    if (send === undefined) return;
    void send({ kind: "watchWindows", windows: [...this.watches.entries()].map(([windowId, w]) => ({ pid: w.pid, windowId })) }).catch(() => undefined);
  }

  private markerApp(bundle: string): MarkerAppCounts {
    let a = this.markerApps.get(bundle);
    if (a === undefined) {
      a = { checks: 0, withMarkers: 0, checksByRule: zeroRules(), linesByRule: zeroRules(), windowsWithMarkers: 0, watches: 0 };
      this.markerApps.set(bundle, a);
    }
    return a;
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
