// A structure census for the read-only audit (brief B6). The pending watch needs markers that fit
// how agent-thread apps (Codex, T3 Code, browser chats) show running and finished work, and those
// have to come from the shape of their accessibility trees, not from transcript text. The census
// reads every complete snapshot and counts, per app: buttons whose label starts with a control
// word (stop, interrupt, cancel, send, approve...), whether they sit next to the window's composer,
// progress and busy indicators, and where each text-marker hit sits (role, parent role, part of the
// window). It also times how long each hit and each stop-like button stays on screen.
//
// Only counts leave this module. Words in the output come from the code's own lists (the control
// words, their qualifiers and the marker verbs), never from the window. Keys for timing are keyed
// hashes held in memory.
import { createHmac, randomBytes } from "node:crypto";
import type { Frame, Node } from "./protocol.ts";
import { nodeText, type WindowState } from "./model.ts";
import { markerRule, nearComposer, STATUS_VERBS, type MarkerRule } from "./tasks/pending.ts";
import { composers } from "./conversation.ts";

export const CONTROL_WORDS = [
  "stop", "interrupt", "cancel", "abort", "pause", "send", "submit", "approve", "allow", "accept", "deny", "reject", "decline",
  "retry", "regenerate", "resume", "continue", "run",
] as const;
export type ControlWord = (typeof CONTROL_WORDS)[number];
/** Second words worth telling apart; anything else counts as "(other)". */
const QUALIFIERS = new Set([
  "generating", "generation", "streaming", "response", "responding", "run", "running", "task", "agent", "turn", "reply", "answer",
  "thinking", "query", "search", "sharing", "recording", "video", "presenting", "message", "prompt", "all", "once", "always",
  "changes", "for", "and", "the", "this",
]);
const BUTTON_ROLES = new Set(["AXButton", "AXMenuButton", "AXPopUpButton"]);
const TEXT_RULE_IDS = ["verbEllipsis", "statusWord", "verbCount", "labelledStatus"] as const;
type TextRule = (typeof TEXT_RULE_IDS)[number];

/** Part of the window a node's centre falls in: the left 30% (a sidebar), the bottom quarter of the rest, or the rest. */
export type Zone = "left" | "bottom" | "main" | "noFrame";
/** How long an item stayed on screen, from the first to the last snapshot that showed it. */
export type Span = "once" | "under30s" | "under2m" | "under10m" | "over10m";
const SPANS: readonly Span[] = ["once", "under30s", "under2m", "under10m", "over10m"];

export interface ButtonCounts {
  /** Snapshots where at least one such button showed. */
  snapshots: number;
  buttons: number;
  disabled: number;
  /** Buttons within a composer's band: level with it or just below, horizontally overlapping it. */
  nearComposer: number;
  byQualifier: Record<string, number>;
  byWords: Record<"1" | "2" | "3+", number>;
  zone: Record<Zone, number>;
  spans: Record<Span, number>;
}

export interface TextHitCounts {
  lines: number;
  snapshots: number;
  byWord: Record<string, number>;
  byRole: Record<string, number>;
  byParentRole: Record<string, number>;
  zone: Record<Zone, number>;
  /** Hits inside a link, button, row, cell or list item, judged from kept ancestors. */
  inControlOrRow: number;
  /** Hits in a node with more than one line of text. */
  multiLineNode: number;
  spans: Record<Span, number>;
}

export interface CensusApp {
  snapshots: number;
  windows: number;
  withComposer: number;
  nodes: number;
  progress: number;
  busy: number;
  buttons: Partial<Record<ControlWord, ButtonCounts>>;
  textHits: Partial<Record<TextRule, TextHitCounts>>;
  /** Snapshots by which of a stop-like button (stop, interrupt, abort) and a statusWord hit showed. */
  stopVsStatusWord: { both: number; stopOnly: number; statusWordOnly: number; neither: number };
}

const zero = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const ZONES: readonly Zone[] = ["left", "bottom", "main", "noFrame"];
const STOPLIKE = new Set<ControlWord>(["stop", "interrupt", "abort"]);
const IN_CONTROL = new Set(["AXLink", "AXButton", "AXRow", "AXCell", "AXOutline", "AXList", "AXTab", "AXRadioButton", "AXMenuButton", "AXPopUpButton"]);

export function zoneOf(f: Frame | undefined, win: Frame | null): Zone {
  if (f === undefined || win === null || win[2] <= 0 || win[3] <= 0) return "noFrame";
  const cx = (f[0] + f[2] / 2 - win[0]) / win[2];
  const cy = (f[1] + f[3] / 2 - win[1]) / win[3];
  if (cx < 0.3) return "left";
  return cy > 0.75 ? "bottom" : "main";
}

/** The control word a button label starts with, its qualifier, and its word count; null for any other label. */
export function classifyButton(label: string | undefined): { word: ControlWord; qualifier: string; words: "1" | "2" | "3+" } | null {
  if (label === undefined) return null;
  const words = label.toLowerCase().replace(/[^\p{L}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 0);
  const first = words[0];
  if (first === undefined || !(CONTROL_WORDS as readonly string[]).includes(first)) return null;
  const second = words[1];
  return {
    word: first as ControlWord,
    qualifier: second === undefined ? "(none)" : QUALIFIERS.has(second) ? second : "(other)",
    words: words.length === 1 ? "1" : words.length === 2 ? "2" : "3+",
  };
}

/** The verb from the code's own list that a marker line contains, or "(phrase)" for "in progress" and "queued". */
function verbOf(line: string): string {
  const l = line.toLowerCase();
  return STATUS_VERBS.find((v) => new RegExp(`\\b${v}\\b`).test(l)) ?? "(phrase)";
}

function ancestorRoles(w: WindowState, n: Node, depth = 6): string[] {
  const out: string[] = [];
  let key = n.parent;
  while (key !== null && out.length < depth) {
    const p = w.nodes.get(key);
    if (p === undefined) break;
    out.push(p.role);
    key = p.parent;
  }
  return out;
}

export class Census {
  private readonly apps = new Map<string, CensusApp>();
  private readonly windows = new Map<string, Set<string>>();
  private readonly key = randomBytes(32);
  /** Keyed hash of (window, node, item) to the first and last time a snapshot showed it, and where it is counted. */
  private readonly seen = new Map<string, { first: number; last: number; bundle: string; kind: "button" | "text"; id: string }>();

  private hash(s: string): string {
    return createHmac("sha256", this.key).update(s).digest("hex").slice(0, 16);
  }

  /** One complete view of a window after a snapshot was applied. */
  observe(w: WindowState, at: number): void {
    const bundle = w.app.bundleId;
    const app = this.app(bundle);
    app.snapshots++;
    let wins = this.windows.get(bundle);
    if (wins === undefined) this.windows.set(bundle, (wins = new Set()));
    if (!wins.has(w.window.windowId)) {
      wins.add(w.window.windowId);
      app.windows++;
    }
    const comps = composers(w);
    if (comps.length > 0) app.withComposer++;
    app.nodes += w.nodes.size;
    let progress = false;
    let busy = false;
    let stop = false;
    let statusWord = false;
    const buttonWords = new Set<ControlWord>();
    const ruleSnaps = new Set<TextRule>();
    for (const n of w.nodes.values()) {
      if (n.role === "AXProgressIndicator") progress = true;
      if (n.role === "AXBusyIndicator") busy = true;
      if (BUTTON_ROLES.has(n.role)) {
        const c = classifyButton(n.label);
        if (c === null) continue;
        const b = (app.buttons[c.word] ??= {
          snapshots: 0, buttons: 0, disabled: 0, nearComposer: 0, byQualifier: {}, byWords: { "1": 0, "2": 0, "3+": 0 }, zone: zero(ZONES), spans: zero(SPANS),
        });
        buttonWords.add(c.word);
        if (STOPLIKE.has(c.word)) stop = true;
        b.buttons++;
        if (n.states?.includes("disabled")) b.disabled++;
        if (nearComposer(n.frame, comps)) b.nearComposer++;
        b.byQualifier[c.qualifier] = (b.byQualifier[c.qualifier] ?? 0) + 1;
        b.byWords[c.words]++;
        b.zone[zoneOf(n.frame, w.window.frame)]++;
        this.track(`${w.window.windowId}\u0000${n.key}`, at, bundle, "button", c.word);
        continue;
      }
      if (n.editable === true) continue;
      const lines = nodeText(n).split("\n").map((l) => l.trim()).filter((l) => l !== "");
      for (const line of lines) {
        const r: MarkerRule | null = markerRule(line);
        if (r === null || r === "progressBar" || r === "busyIndicator" || r === "stopButton") continue;
        const t = (app.textHits[r] ??= {
          lines: 0, snapshots: 0, byWord: {}, byRole: {}, byParentRole: {}, zone: zero(ZONES), inControlOrRow: 0, multiLineNode: 0, spans: zero(SPANS),
        });
        ruleSnaps.add(r);
        if (r === "statusWord") statusWord = true;
        t.lines++;
        const verb = verbOf(line);
        t.byWord[verb] = (t.byWord[verb] ?? 0) + 1;
        t.byRole[n.role] = (t.byRole[n.role] ?? 0) + 1;
        const anc = ancestorRoles(w, n);
        const parent = anc[0] ?? "(top)";
        t.byParentRole[parent] = (t.byParentRole[parent] ?? 0) + 1;
        t.zone[zoneOf(n.frame, w.window.frame)]++;
        if (anc.some((a) => IN_CONTROL.has(a))) t.inControlOrRow++;
        if (lines.length > 1) t.multiLineNode++;
        this.track(`${w.window.windowId}\u0000${n.key}\u0000${line.replace(/\d+/g, "#")}`, at, bundle, "text", r);
      }
    }
    for (const word of buttonWords) (app.buttons[word] as ButtonCounts).snapshots++;
    for (const r of ruleSnaps) (app.textHits[r] as TextHitCounts).snapshots++;
    if (progress) app.progress++;
    if (busy) app.busy++;
    const sv = app.stopVsStatusWord;
    if (stop && statusWord) sv.both++;
    else if (stop) sv.stopOnly++;
    else if (statusWord) sv.statusWordOnly++;
    else sv.neither++;
  }

  private track(item: string, at: number, bundle: string, kind: "button" | "text", id: string): void {
    const h = this.hash(item);
    const e = this.seen.get(h);
    if (e === undefined) this.seen.set(h, { first: at, last: at, bundle, kind, id });
    else e.last = Math.max(e.last, at);
  }

  summary(): Record<string, CensusApp> {
    const apps: Record<string, CensusApp> = structuredClone(Object.fromEntries(this.apps));
    for (const e of this.seen.values()) {
      const a = apps[e.bundle];
      if (a === undefined) continue;
      const d = e.last - e.first;
      const span: Span = d === 0 ? "once" : d < 30_000 ? "under30s" : d < 120_000 ? "under2m" : d < 600_000 ? "under10m" : "over10m";
      const target = e.kind === "button" ? a.buttons[e.id as ControlWord] : a.textHits[e.id as TextRule];
      if (target !== undefined) target.spans[span]++;
    }
    return apps;
  }

  private app(bundle: string): CensusApp {
    let a = this.apps.get(bundle);
    if (a === undefined) {
      a = {
        snapshots: 0, windows: 0, withComposer: 0, nodes: 0, progress: 0, busy: 0, buttons: {}, textHits: {},
        stopVsStatusWord: { both: 0, stopOnly: 0, statusWordOnly: 0, neither: 0 },
      };
      this.apps.set(bundle, a);
    }
    return a;
  }
}
