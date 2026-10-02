// Pending-state watch (deep plan section 6.4). When the user leaves a window that shows unfinished
// work, code (no model) finds the markers: a progress or busy indicator, or a status line such as
// "Running tests…". The window then gets a watch: the reader re-reads that one window when its app
// posts a notification about it, and every 10 s. Whenever the window's text changes, ignoring digits
// so a counter or percentage does not count, Jev answers the two pending questions for it: has the
// work finished, and is the window waiting on the user. The answer becomes the watch's task state:
// needsYou, done, failed, or still running. Done and failed end the watch.
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
const VERBS = [
  "running", "building", "compiling", "uploading", "downloading", "generating", "installing", "processing", "exporting",
  "rendering", "deploying", "thinking", "working", "analyzing", "analysing", "indexing", "testing", "copying",
  "transcribing", "importing", "converting",
].join("|");
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
export type MarkerRule = (typeof TEXT_RULES)[number]["id"] | "progressBar" | "busyIndicator";
export const MARKER_RULE_IDS: readonly MarkerRule[] = ["progressBar", "busyIndicator", ...TEXT_RULES.map((r) => r.id)];

/** The rule that makes this watch line a marker, the first in rule order, or null. Button labels never are. */
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
/** Lines read from one window for markers and the signature, so a huge window costs a bounded pass. */
const MAX_READ_LINES = 400;
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
 */
export function watchLines(w: WindowState): string[] {
  const out: string[] = [];
  for (const n of w.nodes.values()) {
    if (out.length >= MAX_READ_LINES) break;
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
  return out;
}

/** The lines that mark the window as showing unfinished work, first marker first. Empty means no watch. */
export function pendingMarkers(lines: readonly string[]): string[] {
  return lines.filter((l) => markerRule(l) !== null);
}

export function signature(w: WindowState, lines: readonly string[]): string {
  return mask([w.window.title, ...lines].join("\n"));
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
export function buildPendingRequest(w: WindowState, then: readonly string[], now: readonly string[]): JevRequest {
  const before = new Set(then.map(mask));
  const keep = new Set<string>([...now.slice(0, 3), ...now.filter((l) => !before.has(mask(l))), ...pendingMarkers(now)]);
  for (const l of now) {
    if (keep.size >= MAX_NOW_LINES) break;
    keep.add(l);
  }
  return {
    state: {
      window: `${w.app.name} window '${w.window.title}'`,
      situation: "The user left this window while it showed unfinished work. Caret watches it so it can tell the user when the work is done or needs them.",
      when_the_user_left: then.slice(0, MAX_THEN_LINES).join("\n"),
      now: now.filter((l) => keep.has(l)).slice(0, MAX_NOW_LINES).join("\n"),
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
  /** Lines when the watch began; the "then" of every question. */
  then: string[];
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
    const lines = watchLines(w);
    const markers = pendingMarkers(lines);
    if (markers.length === 0) {
      this.stats.noMarkers++;
      return null;
    }
    const sig = signature(w, lines);
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
      info: { markedBy: markers[0] ?? "", status: null, finished: null, waiting: null, asks: 0 },
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
    const sig = signature(w, lines);
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
      const r = await askJev(buildPendingRequest(w, watch.then, watchLines(w)));
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
