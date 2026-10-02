// Pending-state watch (deep plan section 6.4). When the user leaves a window that shows unfinished
// work, code (no model) finds the markers: a progress or busy indicator, an enabled Stop button by
// the window's message composer (how agent threads such as Codex, T3 Code and browser chats show a
// turn still running), or a status line such as "Running tests…" that is the window's own status
// rather than an item in a list or sidebar. The window then gets a watch: the reader re-reads that
// one window when its app posts a notification about it, and every 10 s. Whenever the window's text
// or markers change, ignoring digits so a counter or percentage does not count, Jev answers the two
// pending questions for it: has the work finished, and is the window waiting on the user. The answer
// becomes the watch's task state: needsYou, done, failed, or still running. Done and failed end the watch.
import { randomUUID } from "node:crypto";
import type { PendingInfo, ReaderVerb, TaskCause, TaskState, VerbResult } from "../protocol.ts";
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import type { AskJev, JevRequest, JevResult } from "../fill/jev.ts";
import { FINISHED, type TaskRegistry } from "./registry.ts";

/**
 * Verbs that, written as a status, mean work is under way. Loading, saving, syncing and updating are
 * left out on purpose: apps show them for seconds at a time or for ever, and a watch would fire on
 * every page load and autosave. No measurement behind the list; the false-watch count on real windows
 * is the number to check.
 */
export const STATUS_VERBS = [
  "running", "building", "compiling", "uploading", "downloading", "generating", "installing", "processing", "exporting",
  "rendering", "deploying", "thinking", "working", "analyzing", "analysing", "indexing", "testing", "copying",
  "transcribing", "importing", "converting",
] as const;
const VERBS = STATUS_VERBS.join("|");
const TEXT_RULES = [
  // The verb followed by an ellipsis: "Running tests…", "Uploading 3 files...".
  { id: "verbEllipsis", re: new RegExp(`\\b(?:${VERBS})\\b[^\\n]{0,60}(?:…|\\.\\.\\.)`, "i") },
  // The whole text is the status word: "Running", "● Building".
  { id: "statusWord", re: new RegExp(`^\\W{0,3}(?:${VERBS}|in progress|queued)\\W{0,3}$`, "i") },
  // The verb with a count or percentage: "Exporting 40%", "Testing 12 of 48".
  { id: "verbCount", re: new RegExp(`\\b(?:${VERBS})\\b.{0,40}?\\d+\\s*(?:%|of\\s+\\d+|/\\s*\\d+)`, "i") },
  // A labelled status: "Status: running".
  { id: "labelledStatus", re: new RegExp(`^(?:status|state)\\s*:\\s*(?:${VERBS}|in progress|queued|pending)\\b`, "i") },
] as const;
const INDICATORS: Record<string, string> = { AXProgressIndicator: "[progress bar]", AXBusyIndicator: "[busy indicator]" };
// A Map, not an object literal: a window line reading "constructor" must not find Object's own properties.
const INDICATOR_RULES = new Map<string, MarkerRule>([
  ["[progress bar]", "progressBar"],
  ["[busy indicator]", "busyIndicator"],
]);

/** Names for the marker rules, so a real-window audit can count which one fired without keeping the text. */
export type MarkerRule = (typeof TEXT_RULES)[number]["id"] | "progressBar" | "busyIndicator" | "stopButton";
export const MARKER_RULE_IDS: readonly MarkerRule[] = ["progressBar", "busyIndicator", "stopButton", ...TEXT_RULES.map((r) => r.id)];

/**
 * The rule that makes this line of text a marker by its words alone, the first in rule order, or null.
 * Button labels never are. This is B5's whole rule set; windowMarkers adds where a line sits.
 */
export function markerRule(line: string): MarkerRule | null {
  const indicator = INDICATOR_RULES.get(line);
  if (indicator !== undefined) return indicator;
  if (line.startsWith("[button] ")) return null;
  return TEXT_RULES.find((r) => r.re.test(line))?.id ?? null;
}

/** Concurrent watches. Assumed; a registration beyond it is skipped and counted. */
export const MAX_WATCHES = 8;
/**
 * Wait after a change before asking, restarted by each further change but never past ASK_MAX_WAIT_MS
 * from the first, so a status line and the indicator that disappears with it, which arrive in
 * separate snapshots, cost one question. Assumed.
 */
export const ASK_DEBOUNCE_MS = 150;
export const ASK_MAX_WAIT_MS = 400;
/**
 * After each answer that the work is still running, the next question waits longer: 1 s, doubling to
 * 20 s, until the answer changes. A window that streams text (a build log) would otherwise cost a
 * question every few hundred milliseconds. The price is that its end may be reported up to 20 s late.
 */
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 20_000;
/** Lines of window text sent to Jev, the "few dozen lines" rule of deep plan section 5. */
const MAX_NOW_LINES = 30;
const MAX_THEN_LINES = 20;
const MAX_LINE = 200;
/** Lines of one window kept for the signature and the question, so a huge window costs a bounded pass. */
const MAX_READ_LINES = 400;
/** Of those, the first lines; the rest are the window's last lines. */
const MAX_HEAD_LINES = 100;
/** A failed question is tried again this many times, a second apart; after that, only a new change asks again. */
const RETRIES = 2;
const RETRY_MS = 1000;

const clip = (s: string): string => (s.length <= MAX_LINE ? s : `${s.slice(0, MAX_LINE - 1)}…`);
/** Digits masked, so a counter or a percentage moving is not a change worth a question. */
export const mask = (s: string): string => s.replace(/\d+/g, "#");

/**
 * The window's text as lines, in document order: static text and headings, button labels marked
 * as buttons, and indicators by role. Editable fields are left out: what the user types is not the
 * window's status. Secure fields never carry a value.
 *
 * A window longer than MAX_READ_LINES keeps its first MAX_HEAD_LINES lines and its last ones. An agent
 * thread's news is at its end, under a long transcript; B5's version kept only the first lines, so a
 * finished turn changed nothing it read. `head` reproduces that version for the audit's comparison.
 */
export function watchLines(w: WindowState, mode: "headTail" | "head" = "headTail"): string[] {
  const out: string[] = [];
  for (const n of w.nodes.values()) {
    if (mode === "head" && out.length >= MAX_READ_LINES) break;
    if (n.editable === true || n.states?.includes("secure")) continue;
    const indicator = INDICATORS[n.role];
    if (indicator !== undefined) {
      out.push(indicator);
      continue;
    }
    if (n.role === "AXButton") {
      if (n.label !== undefined && n.label.trim() !== "") out.push(`[button] ${clip(n.label.trim())}`);
      continue;
    }
    for (const line of nodeText(n).split("\n")) {
      const t = line.trim();
      if (t !== "") out.push(clip(t));
    }
  }
  if (out.length <= MAX_READ_LINES) return out;
  return [...out.slice(0, MAX_HEAD_LINES), ...out.slice(out.length - (MAX_READ_LINES - MAX_HEAD_LINES))];
}

/** B5's markers: the lines whose words alone match a rule, first marker first. Kept for the audit's before column and for tests of the words. */
export function pendingMarkers(lines: readonly string[]): string[] {
  return lines.filter((l) => markerRule(l) !== null);
}

// MARK: - markers by structure

/** A marker found in a window: the rule and the line that showed it, as the watch's text holds it. */
export interface Marker {
  rule: MarkerRule;
  line: string;
}

/**
 * Roles that make a text an item's title or status, not the window's own: a text inside a button, link,
 * row or tab names one thing in a list. In the B6 census of Sam's windows, 1,454 of 1,463 status words in
 * T3 Code and 185 of 194 in Codex sat inside sidebar buttons, one per agent thread, and stayed for more
 * than ten minutes; those watches never cleared.
 */
const ITEM_ROLES = new Set([
  "AXLink", "AXButton", "AXRow", "AXCell", "AXOutline", "AXList", "AXTab", "AXRadioButton", "AXMenuButton", "AXPopUpButton", "AXMenuItem",
  "AXCheckBox", "AXDisclosureTriangle",
]);
/**
 * A text whose centre is in the left 30% of a window at least 700 points wide sits in a sidebar, the
 * list of a window's other threads, jobs or pages. The census found every remaining status word in
 * T3 Code and Codex there, and 138 of Helium's 154 counted statuses. The width keeps small job and
 * progress windows, whose status starts at the left margin, out of the rule. Both numbers are judgment,
 * not measurement.
 */
const SIDEBAR_FRACTION = 0.3;
const SIDEBAR_MIN_WIDTH = 700;
const BUTTON_ROLES = new Set(["AXButton", "AXMenuButton"]);
const STOP_WORDS = new Set(["stop", "interrupt", "abort", "cancel"]);
/** Second words that keep a stop button about the work: "Stop generating", not "Stop sharing" or "Stop recording". */
const STOP_OBJECTS = new Set([
  "generation", "generating", "streaming", "response", "responding", "run", "running", "task", "agent", "turn", "reply", "answer",
  "thinking", "query", "search", "request", "job", "build", "process",
]);

/**
 * A button label that stops running work: "Stop", "Interrupt" or "Abort" alone, or any of those or
 * "Cancel" followed by what it stops ("Stop generation" in T3 Code, "Stop" in Codex, "Stop streaming"
 * in ChatGPT, "Stop response" in Claude). "Cancel" alone is a dialog's button, so it does not count.
 */
export function isStopLabel(label: string | undefined): boolean {
  if (label === undefined) return false;
  const words = label.toLowerCase().replace(/[^\p{L}\s]/gu, " ").split(/\s+/).filter((x) => x.length > 0);
  const [first, second] = words;
  if (first === undefined || !STOP_WORDS.has(first)) return false;
  if (second === undefined) return first !== "cancel";
  return STOP_OBJECTS.has(second);
}

/**
 * Where the user writes to an agent: an editable text field or area, not secure, in the lower 40% of
 * the window and at least a quarter of its width. The census found one in 117 of 139 T3 Code snapshots
 * and 68 of 71 Codex ones.
 */
export function composers(w: WindowState): readonly [number, number, number, number][] {
  const win = w.window.frame;
  if (win === null || win[3] <= 0) return [];
  const out: [number, number, number, number][] = [];
  for (const n of w.nodes.values()) {
    if (n.editable !== true || n.frame === undefined || n.states?.includes("secure")) continue;
    if (n.role !== "AXTextArea" && n.role !== "AXTextField") continue;
    const [, y, wd, h] = n.frame;
    if ((y + h / 2 - win[1]) / win[3] >= 0.6 && wd >= win[2] * 0.25) out.push(n.frame);
  }
  return out;
}

/** Level with a composer or within 80 points above or below it, and over it horizontally within 40 points. */
export function nearComposer(f: readonly [number, number, number, number] | undefined, comps: readonly (readonly [number, number, number, number])[]): boolean {
  if (f === undefined) return false;
  const cy = f[1] + f[3] / 2;
  const cx = f[0] + f[2] / 2;
  return comps.some(([x, y, wd, h]) => cy >= y - 80 && cy <= y + h + 80 && cx >= x - 40 && cx <= x + wd + 40);
}

function inSidebar(w: WindowState, f: readonly [number, number, number, number] | undefined): boolean {
  const win = w.window.frame;
  if (f === undefined || win === null || win[2] < SIDEBAR_MIN_WIDTH) return false;
  return (f[0] + f[2] / 2 - win[0]) / win[2] < SIDEBAR_FRACTION;
}

function insideItem(w: WindowState, parent: string | null): boolean {
  for (let key = parent, hops = 0; key !== null && hops < 32; hops++) {
    const p = w.nodes.get(key);
    if (p === undefined) return false;
    if (ITEM_ROLES.has(p.role)) return true;
    key = p.parent;
  }
  return false;
}

/**
 * The window's markers in document order, read from its structure: indicators by role, an enabled
 * stop button by a composer, and text lines that match a text rule and are the window's own status,
 * neither inside a list item nor in a sidebar. Every node is read, since an agent's composer comes
 * last in a long transcript.
 */
export function windowMarkers(w: WindowState): Marker[] {
  const out: Marker[] = [];
  let comps: readonly [number, number, number, number][] | null = null;
  for (const n of w.nodes.values()) {
    if (n.editable === true || n.states?.includes("secure")) continue;
    const indicator = INDICATORS[n.role];
    if (indicator !== undefined) {
      out.push({ rule: INDICATOR_RULES.get(indicator) as MarkerRule, line: indicator });
      continue;
    }
    if (BUTTON_ROLES.has(n.role)) {
      if (!isStopLabel(n.label) || n.states?.includes("disabled")) continue;
      comps ??= composers(w);
      if (nearComposer(n.frame, comps)) out.push({ rule: "stopButton", line: `[button] ${clip((n.label as string).trim())}` });
      continue;
    }
    if (ITEM_ROLES.has(n.role)) continue;
    const text = nodeText(n);
    if (text === "") continue;
    let placed: boolean | null = null;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "") continue;
      const rule = TEXT_RULES.find((r) => r.re.test(line))?.id;
      if (rule === undefined) continue;
      placed ??= !inSidebar(w, n.frame) && !insideItem(w, n.parent);
      if (placed) out.push({ rule, line: clip(line) });
    }
  }
  return out;
}

/** What a question is about: the title, the lines and the markers, digits masked. A marker past the lines read still counts. */
export function signature(w: WindowState, lines: readonly string[], markers: readonly Marker[] = []): string {
  return mask([w.window.title, ...lines, "--markers--", ...markers.map((m) => m.line)].join("\n"));
}

// MARK: - the question

export type Finished = "yes" | "failed" | "no";
export type Waiting = "yes" | "no";

const FINISHED_CRITERIA: Record<Finished, string> = {
  yes: "Yes. It now shows the work completed or its result, for example done, finished, succeeded, passed, complete or uploaded.",
  failed: "It ended in an error or a failure, or it was cancelled.",
  no: "No. The work is still going, or it has stopped partway and is waiting for the user.",
};
const WAITING_CRITERIA: Record<Waiting, string> = {
  yes: "Yes. It asks the user to act before it continues.",
  no: "No. Nothing in the window needs the user to act now.",
};

/**
 * One request, two choice questions about one window. The window's text goes in the state as data:
 * what it showed when the user left, and what it shows now, with changed lines and markers kept
 * first when a large window has to be cut.
 */
export function buildPendingRequest(
  w: WindowState,
  then: readonly string[],
  now: readonly string[],
  thenMarkers: readonly Marker[] = [],
  nowMarkers: readonly Marker[] = [],
): JevRequest {
  const before = new Set(then.map(mask));
  const markerLines = new Set(nowMarkers.map((m) => m.line));
  const keep = new Set<string>([...now.slice(0, 3), ...now.filter((l) => !before.has(mask(l))), ...now.filter((l) => markerLines.has(l))]);
  for (const l of now) {
    if (keep.size >= MAX_NOW_LINES) break;
    keep.add(l);
  }
  // A long window's changed lines can all be in its tail; the last ones are where an agent thread's turn ends.
  const kept = now.filter((l) => keep.has(l));
  const nowText = kept.length <= MAX_NOW_LINES ? kept : [...kept.slice(0, 3), ...kept.slice(-(MAX_NOW_LINES - 3))];
  const thenText = then.length <= MAX_THEN_LINES ? then : [...then.slice(0, 3), ...then.slice(-(MAX_THEN_LINES - 3))];
  const list = (ms: readonly Marker[]): string => (ms.length === 0 ? "none" : [...new Set(ms.map((m) => m.line))].join("\n"));
  return {
    state: {
      window: `${w.app.name} window '${w.window.title}'`,
      situation: "The user left this window while it showed unfinished work. Caret watches it so it can tell the user when the work is done or needs them.",
      when_the_user_left: thenText.join("\n"),
      now: nowText.join("\n"),
      signs_of_running_work_when_the_user_left: list(thenMarkers),
      signs_of_running_work_now: list(nowMarkers),
    },
    questions: {
      finished: {
        type: "choice",
        instructions: "Look at what the window shows now. Has the work it was doing when the user left finished?",
        criteria: FINISHED_CRITERIA,
      },
      waiting: {
        type: "choice",
        instructions:
          "Is the window now waiting for the user to do something, such as approve, confirm, answer a question, choose an option or sign in, before the work can go on?",
        criteria: WAITING_CRITERIA,
      },
    },
  };
}

export class PendingAnswerError extends Error {}

export function readPendingAnswer(r: JevResult): { finished: { choice: Finished; confidence: number }; waiting: { choice: Waiting; confidence: number } } {
  const f = r.answers.finished;
  const wt = r.answers.waiting;
  if (f === undefined || wt === undefined) throw new PendingAnswerError("Jev did not answer both pending questions");
  if (!Object.hasOwn(FINISHED_CRITERIA, f.choice)) throw new PendingAnswerError(`Jev chose '${f.choice}' for finished`);
  if (!Object.hasOwn(WAITING_CRITERIA, wt.choice)) throw new PendingAnswerError(`Jev chose '${wt.choice}' for waiting`);
  return { finished: { choice: f.choice as Finished, confidence: f.confidence }, waiting: { choice: wt.choice as Waiting, confidence: wt.confidence } };
}

/** Waiting on the user wins: an approval prompt is not the end of the work even if Jev also calls it finished. */
export function stateFor(finished: Finished, waiting: Waiting): TaskState {
  if (waiting === "yes") return "needsYou";
  if (finished === "yes") return "done";
  if (finished === "failed") return "failed";
  return "running";
}

// MARK: - the watcher

interface Watch {
  id: string;
  windowId: string;
  pid: number;
  /** Lines and markers when the watch began; the "then" of every question. */
  then: string[];
  thenMarkers: Marker[];
  /** Signature of the latest snapshot, and of the last one Jev answered about. */
  sig: string;
  asked: string;
  timer: ReturnType<typeof setTimeout> | null;
  /** When the burst the timer is waiting out began. */
  burstAt: number;
  inflight: Promise<boolean> | null;
  /** Answers in a row that said the work is still running, and when the last question was asked. */
  runningStreak: number;
  lastAskAt: number;
  paused: boolean;
  /** Failed questions in a row for the current text; a retry waits RETRY_MS and stops after RETRIES. */
  tries: number;
  retry: ReturnType<typeof setTimeout> | null;
  info: PendingInfo;
}

export interface PendingDeps {
  model: ScreenModel;
  askJev: AskJev | null;
  tasks: TaskRegistry;
  /** Sends a verb to the reader: here, only watchWindows. */
  reader: (verb: ReaderVerb) => Promise<VerbResult>;
  /** False in shadow mode: no watches, no questions. */
  live: () => boolean;
  warn?: (line: string) => void;
  debounceMs?: number;
}

export interface PendingStats {
  /** Windows checked for markers when the user left them. */
  checked: number;
  registered: number;
  noMarkers: number;
  /** Left again with the same text Caret already resolved. */
  alreadyResolved: number;
  overLimit: number;
  asks: number;
  /** Answers dropped because the window changed while Jev was answering. */
  stale: number;
  errors: number;
}

export class PendingControlError extends Error {}

export class PendingWatcher {
  private readonly watches = new Map<string, Watch>();
  /** Signature each window had when its last watch resolved, so leaving it again unchanged registers nothing. */
  private readonly resolved = new Map<string, string>();
  readonly stats: PendingStats = { checked: 0, registered: 0, noMarkers: 0, alreadyResolved: 0, overLimit: 0, asks: 0, stale: 0, errors: 0 };
  /** Every question asked, with its latency, for evaluation. Holds no window text. */
  readonly asks: { watchId: string; at: number; latencyMs: number; finished: Finished; waiting: Waiting; state: TaskState; stale: boolean }[] = [];
  private readonly deps: PendingDeps;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;

  constructor(deps: PendingDeps) {
    this.deps = deps;
    this.debounceMs = deps.debounceMs ?? ASK_DEBOUNCE_MS;
    this.maxWaitMs = Math.max(this.debounceMs, ASK_MAX_WAIT_MS);
  }

  /** The id of the watch on a window, if any. */
  watchOf(windowId: string): string | null {
    return this.watches.get(windowId)?.id ?? null;
  }

  has(taskId: string): boolean {
    return this.byId(taskId) !== undefined;
  }

  /** The user left this window. Registers a watch when it shows unfinished work; returns the watch id. */
  left(windowId: string): string | null {
    if (!this.deps.live() || this.deps.askJev === null || this.watches.has(windowId)) return null;
    const w = this.deps.model.windows.get(windowId);
    if (w === undefined) return null;
    this.stats.checked++;
    const markers = windowMarkers(w);
    if (markers.length === 0) {
      this.stats.noMarkers++;
      return null;
    }
    const lines = watchLines(w);
    const sig = signature(w, lines, markers);
    if (this.resolved.get(windowId) === sig) {
      this.stats.alreadyResolved++;
      return null;
    }
    if (this.watches.size >= MAX_WATCHES) {
      this.stats.overLimit++;
      this.deps.warn?.(`pending: ${MAX_WATCHES} windows are already watched; '${w.window.title}' is not`);
      return null;
    }
    const watch: Watch = {
      id: `watch-${randomUUID()}`,
      windowId,
      pid: w.app.pid,
      then: lines,
      thenMarkers: markers,
      sig,
      asked: sig,
      timer: null,
      burstAt: 0,
      inflight: null,
      runningStreak: 0,
      lastAskAt: 0,
      paused: false,
      tries: 0,
      retry: null,
      info: { markedBy: markers[0]?.line ?? "", status: null, finished: null, waiting: null, asks: 0 },
    };
    this.watches.set(windowId, watch);
    this.stats.registered++;
    this.deps.tasks.create({
      id: watch.id,
      kind: "watch",
      state: "running",
      cause: null,
      says: `Watching '${w.window.title}' in ${w.app.name}`,
      app: w.app,
      windowId,
      windowTitle: w.window.title,
      step: null,
      steps: null,
      stepSays: null,
      remaining: [],
      detail: null,
      undoable: false,
      pending: { ...watch.info },
    });
    this.syncReader();
    return watch.id;
  }

  /** A snapshot of this window was applied to the model. A change in its text schedules a question. */
  onSnapshot(windowId: string): void {
    const watch = this.watches.get(windowId);
    const w = this.deps.model.windows.get(windowId);
    if (watch === undefined || w === undefined) return;
    const lines = watchLines(w);
    const sig = signature(w, lines, windowMarkers(w));
    if (sig === watch.sig) return;
    watch.sig = sig;
    // New text gets fresh retries.
    watch.tries = 0;
    const before = new Set(watch.then.map(mask));
    watch.info.status = lines.find((l) => !before.has(mask(l))) ?? null;
    if (!watch.paused) this.schedule(watch);
  }

  /** The window closed. A watch waiting on the user ends as done by the user; one still running fails. */
  onWindowClosed(windowId: string): void {
    const watch = this.watches.get(windowId);
    if (watch !== undefined) {
      if (this.deps.tasks.get(watch.id)?.state === "needsYou") this.end(watch, "done", "you", "you closed the window");
      else this.end(watch, "failed", "screen", "the window closed before Caret saw the work finish");
    }
    // Window ids are never reused, so nothing about this one needs remembering.
    this.resolved.delete(windowId);
  }

  /** A new reader numbers windows from scratch, so every watch has lost its window. */
  readerRestarted(): void {
    for (const watch of [...this.watches.values()]) this.end(watch, "failed", "screen", "Caret's reader restarted and lost track of the window");
    this.resolved.clear();
  }

  /** pause, resume and stop from a taskControl. Throws with the reason for anything else. */
  control(taskId: string, action: "pause" | "resume" | "stop" | "takeOver" | "undo"): void {
    const watch = this.byId(taskId);
    if (watch === undefined) throw new PendingControlError(`watch ${taskId} has ended`);
    switch (action) {
      case "pause":
        if (watch.paused) return;
        watch.paused = true;
        this.clearTimers(watch);
        this.deps.tasks.update(watch.id, { state: "paused", cause: "you", detail: "you paused this watch" });
        this.syncReader();
        return;
      case "resume":
        if (!watch.paused) throw new PendingControlError(`watch ${taskId} is not paused`);
        watch.paused = false;
        this.deps.tasks.update(watch.id, { state: "running", cause: "you", detail: null });
        this.syncReader();
        if (watch.sig !== watch.asked) this.schedule(watch);
        return;
      case "stop":
        this.end(watch, "failed", "you", "you stopped watching");
        return;
      default:
        throw new PendingControlError(`a watch takes pause, resume and stop, not ${action}`);
    }
  }

  /** Resolves when no question is scheduled or in flight. For tests and evaluations. */
  async whenIdle(): Promise<void> {
    for (;;) {
      const busy = [...this.watches.values()].filter((w) => w.timer !== null || w.inflight !== null || w.retry !== null);
      if (busy.length === 0) return;
      await Promise.all(busy.map((w) => w.inflight ?? new Promise((r) => setTimeout(r, this.debounceMs + 5))));
    }
  }

  shutdown(): void {
    for (const w of this.watches.values()) this.clearTimers(w);
    this.watches.clear();
  }

  private clearTimers(w: Watch): void {
    if (w.timer !== null) clearTimeout(w.timer);
    if (w.retry !== null) clearTimeout(w.retry);
    w.timer = null;
    w.retry = null;
  }

  private byId(taskId: string): Watch | undefined {
    for (const w of this.watches.values()) if (w.id === taskId) return w;
    return undefined;
  }

  private schedule(watch: Watch): void {
    const now = Date.now();
    if (watch.timer === null) watch.burstAt = now;
    else clearTimeout(watch.timer);
    const backoff = watch.runningStreak === 0 ? 0 : Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (watch.runningStreak - 1));
    const settle = Math.min(this.debounceMs, Math.max(0, watch.burstAt + this.maxWaitMs - now));
    const delay = Math.max(settle, watch.lastAskAt + backoff - now);
    watch.timer = setTimeout(() => {
      watch.timer = null;
      void this.ask(watch);
    }, delay);
  }

  private live(watch: Watch): boolean {
    return this.watches.get(watch.windowId) === watch;
  }

  private async ask(watch: Watch): Promise<void> {
    const askJev = this.deps.askJev;
    // One question at a time per window; a change meanwhile is asked about when this one returns.
    if (askJev === null || watch.paused || !this.live(watch) || watch.inflight !== null) return;
    const w = this.deps.model.windows.get(watch.windowId);
    if (w === undefined) return;
    const sig = watch.sig;
    const run = this.askOnce(askJev, watch, w, sig);
    watch.inflight = run;
    let failed: boolean;
    try {
      failed = await run;
    } finally {
      watch.inflight = null;
    }
    if (!this.live(watch) || watch.paused) return;
    // A failure is retried by its own timer, within budget; only an answer about older text asks again now.
    if (failed) {
      if (watch.sig !== sig) this.schedule(watch);
      else if (watch.tries <= RETRIES && watch.retry === null) {
        watch.retry = setTimeout(() => {
          watch.retry = null;
          if (this.live(watch) && !watch.paused) this.schedule(watch);
        }, RETRY_MS);
      }
      return;
    }
    if (watch.sig !== watch.asked) this.schedule(watch);
  }

  /** Asks once and applies the answer. Resolves true when the question failed. */
  private async askOnce(askJev: AskJev, watch: Watch, w: WindowState, sig: string): Promise<boolean> {
    const t0 = Date.now();
    watch.lastAskAt = t0;
    let answer: ReturnType<typeof readPendingAnswer>;
    let latencyMs: number;
    try {
      const r = await askJev(buildPendingRequest(w, watch.then, watchLines(w), watch.thenMarkers, windowMarkers(w)));
      latencyMs = r.latencyMs;
      answer = readPendingAnswer(r);
    } catch (e) {
      this.stats.errors++;
      watch.tries++;
      this.deps.warn?.(`pending: question for '${w.window.title}' failed (${watch.tries} in a row): ${e instanceof Error ? e.message : String(e)}`);
      return true;
    }
    this.stats.asks++;
    watch.tries = 0;
    watch.info.asks++;
    const state = stateFor(answer.finished.choice, answer.waiting.choice);
    // The window changed while Jev answered, or the watch ended or paused: the answer is about a screen that is gone.
    const stale = watch.sig !== sig || !this.live(watch) || watch.paused;
    this.asks.push({ watchId: watch.id, at: t0, latencyMs, finished: answer.finished.choice, waiting: answer.waiting.choice, state, stale });
    if (stale) {
      this.stats.stale++;
      return false;
    }
    watch.asked = sig;
    watch.runningStreak = state === "running" ? watch.runningStreak + 1 : 0;
    watch.info.finished = answer.finished;
    watch.info.waiting = answer.waiting;
    const detail = state === "needsYou" ? "the window is waiting for you" : state === "done" ? "the work finished" : state === "failed" ? "the work ended in an error" : null;
    if (FINISHED.has(state)) this.end(watch, state, "screen", detail);
    else this.deps.tasks.update(watch.id, { state, cause: state === "running" ? null : "screen", detail, pending: { ...watch.info } });
    return false;
  }

  private end(watch: Watch, state: TaskState, cause: TaskCause, detail: string | null): void {
    this.clearTimers(watch);
    this.watches.delete(watch.windowId);
    this.resolved.set(watch.windowId, watch.sig);
    this.deps.tasks.update(watch.id, { state, cause, detail, pending: { ...watch.info } });
    this.syncReader();
  }

  /** Tells the reader which windows to re-read: every watch that is not paused. */
  private syncReader(): void {
    const windows = [...this.watches.values()].filter((w) => !w.paused).map((w) => ({ pid: w.pid, windowId: w.windowId }));
    void this.deps.reader({ kind: "watchWindows", windows }).then((r) => {
      if (r.outcome !== "ok" || r.detail !== null) this.deps.warn?.(`pending: watchWindows answered ${r.outcome}${r.detail === null ? "" : ` (${r.detail})`}`);
    });
  }
}
