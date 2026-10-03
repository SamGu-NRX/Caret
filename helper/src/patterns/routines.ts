// The routine counter (plan section 4, "Routines, across days"). A bundle is the transfers into one
// destination window, from its first transfer until the window closes or goes idle. Its signature
// is the sorted set of its transfer shapes, as keyed hashes. Each completed bundle with at least two
// shapes counts one occurrence of its routine.
//
// The press an occurrence ends with (B19's finish, "Send") is learned from the user's own click on it when
// the reader saw one in the destination window (B20, protocol.ts UserPress), and otherwise guessed from the
// window's buttons when it closes.
//
// When a window opens that holds every destination field of a known routine, still empty, Caret
// predicts silently: it reads each step's source from the live windows now, and when the bundle
// closes it scores the prediction against what the user did. Only the gate turns a prediction into
// an offer, and only once enough silent predictions have matched (gate.ts).
import { normalizeValue } from "../normalize.ts";
import type { ScreenModel, WindowState } from "../model.ts";
import type { ValueKind } from "../protocol.ts";
import { classifyLabel } from "../executor/risk.ts";
import type { MemoryStore, RoutineFinish, RoutineRecord, RoutineStep } from "./memory.ts";
import { locate, windowIndex, type Part, type PatternTransfer } from "./shape.ts";

/** A bundle with no transfer for this long is complete. Assumed, not measured. */
export const BUNDLE_IDLE_MS = 120_000;
/** Distinct shapes a bundle needs to count as a routine. One shape repeated is a loop, not a routine. */
export const MIN_ROUTINE_STEPS = 2;
/** Values kept per routine for the naming check (naming.ts), in memory only. Bounded; no measurement behind either number. */
const VALUES_PER_ROUTINE = 64;
const ROUTINES_WITH_VALUES = 500;

export interface RoutineCell {
  step: number;
  dstWindowId: string;
  dstKey: string;
  dstRole: string;
  dstLabel: string | null;
  srcWindowId: string;
  srcKey: string;
  value: string;
  kind: ValueKind | null;
}

export interface SilentPrediction {
  routine: RoutineRecord;
  dstWindowId: string;
  at: number;
  /** One per step; null where the step's source is not on screen now. */
  cells: (RoutineCell | null)[];
  grounded: boolean;
  /** The routine's finish press (RoutineRecord.finish) found in this window now, or null. */
  finish: { key: string; label: string; why: RoutineFinish["why"] } | null;
}

export interface BundleClose {
  dstWindowId: string;
  /** Null for a bundle with fewer than MIN_ROUTINE_STEPS shapes. */
  sig: string | null;
  /** The routine this bundle counted for; null when it is too small or was forgotten recently. */
  recorded: RoutineRecord | null;
  /** Each silent prediction scored, with the cells it predicted, which name the fields and sources. */
  scored: { routineId: string; hit: boolean; cells: RoutineCell[] }[];
}

/** A press the user made in a destination window, as the reader observed it (protocol.ts UserPress). */
export interface ObservedPress {
  at: number;
  /** The element's key in the window's latest walk; null when the walk did not keep it. */
  key: string | null;
  role: string;
  label: string;
}

/** Presses kept per window; only the last one is ever read. */
const PRESSES_PER_WINDOW = 4;
/** Windows whose presses are kept at once; the oldest goes first. Bounded; no measurement behind either number. */
const PRESS_WINDOWS = 50;
/**
 * How soon after a press that does not read as outbound, destructive or money the window must close for that
 * press to count as how the occurrence ended. A safe press followed by more work (a checkbox, then a keyboard
 * Send) says nothing about the finish. Assumed.
 */
export const PRESS_ENDS_MS = 3000;

interface Bundle {
  dstWindowId: string;
  lastAt: number;
  transfers: PatternTransfer[];
  predictions: SilentPrediction[];
}

export type Hash = (text: string) => string;

export class RoutineRecognizer {
  private readonly bundles = new Map<string, Bundle>();
  /**
   * The user's presses by window, kept whether or not an occurrence is known to be under way there yet: its
   * transfers are judged only once the edits settle, which can be after the user has already clicked Send.
   */
  private readonly presses = new Map<string, ObservedPress[]>();
  private readonly templateHashes = new Map<string, string>();
  /** Values each routine (by signature) was seen copying in this session, for the naming check. Never persisted. */
  private readonly seenValues = new Map<string, Set<string>>();
  private readonly model: ScreenModel;
  private readonly memory: MemoryStore;
  private readonly hash: Hash;

  constructor(model: ScreenModel, memory: MemoryStore, hash: Hash) {
    this.model = model;
    this.memory = memory;
    this.hash = hash;
  }

  /** A window appeared. Predicts every unpaused routine whose destination fields it holds, empty, and keeps each prediction to score when its bundle closes. */
  onWindowOpened(windowId: string, at: number): SilentPrediction[] {
    const out = this.predict(windowId, at);
    for (const p of out) this.bundle(windowId, at).predictions.push(p);
    return out;
  }

  /** The predictions onWindowOpened makes for this window now, without keeping them: the first look asks this of windows already open. */
  predict(windowId: string, at: number): SilentPrediction[] {
    const w = this.model.windows.get(windowId);
    if (w === undefined) return [];
    const routines = this.memory.routinesInto(w.app.bundleId, w.window.kind).filter((r) => !r.paused && !r.skillPaused);
    if (routines.length === 0) return [];
    const templates = this.templatesOf(w);
    const out: SilentPrediction[] = [];
    for (const routine of routines) {
      const cells: (RoutineCell | null)[] = [];
      let applies = true;
      for (let i = 0; i < routine.steps.length && applies; i++) {
        const step = routine.steps[i]!;
        const dstTemplate = templates.get(step.dstTemplateHash);
        const dst = dstTemplate === undefined ? null : locate(this.model, windowId, dstTemplate, step.dstPos, "whole");
        if (dst === null || dst.node.editable !== true || (dst.node.value ?? "") !== "") {
          applies = false;
          break;
        }
        const src = this.source(step, windowId);
        cells.push(
          src === null
            ? null
            : {
                step: i,
                dstWindowId: windowId,
                dstKey: dst.key,
                dstRole: dst.node.role,
                dstLabel: dst.node.label ?? null,
                srcWindowId: src.windowId,
                srcKey: src.key,
                value: src.text,
                kind: step.part === "whole" ? null : (step.part as ValueKind),
              },
        );
      }
      if (!applies) continue;
      const f = routine.finish?.ambiguous === true ? null : routine.finish;
      const button = f === null ? undefined : templates.get(f.templateHash);
      const hit = button === undefined || f === null ? null : locate(this.model, windowId, button, f.pos, "whole");
      // The press must still read as it did, or the plan would name a control the risk table sees otherwise.
      const finish = hit === null || f === null || (hit.node.label ?? "").trim() !== f.label ? null : { key: hit.key, label: f.label, why: f.why };
      out.push({ routine, dstWindowId: windowId, at, cells, grounded: cells.every((c) => c !== null), finish });
    }
    return out;
  }

  onTransfer(t: PatternTransfer): void {
    const b = this.bundle(t.dst.windowId, t.at);
    b.transfers.push(t);
    b.lastAt = t.at;
  }

  /** The user pressed something in a window under the press watch; read when an occurrence there ends. */
  onPress(windowId: string, press: ObservedPress): void {
    let ps = this.presses.get(windowId);
    if (ps === undefined) {
      if (this.presses.size >= PRESS_WINDOWS) this.presses.delete(this.presses.keys().next().value as string);
      this.presses.set(windowId, (ps = []));
    }
    ps.push(press);
    if (ps.length > PRESSES_PER_WINDOW) ps.shift();
  }

  /** Whether an occurrence is under way in this window: predicted when it opened, or with a transfer into it. */
  underWay(windowId: string): boolean {
    return this.bundles.has(windowId);
  }

  /** The windows with an occurrence under way: where a press may end one, so the reader is asked to report presses there. */
  openWindows(): string[] {
    return [...this.bundles.keys()];
  }

  /** `at`: when the window closed, which tells whether a safe press just before ended the occurrence. */
  onWindowClosed(windowId: string, at: number): BundleClose | null {
    const b = this.bundles.get(windowId);
    try {
      if (b === undefined) return null;
      this.bundles.delete(windowId);
      return this.close(b, at);
    } finally {
      this.presses.delete(windowId);
    }
  }

  /** Values the routine with this signature was seen copying in this session, for the naming check. */
  valuesOf(sig: string): string[] {
    return [...(this.seenValues.get(sig) ?? [])];
  }

  tick(now: number): BundleClose[] {
    const out: BundleClose[] = [];
    for (const [id, b] of this.bundles) {
      if (now - b.lastAt < BUNDLE_IDLE_MS) continue;
      this.bundles.delete(id);
      out.push(this.close(b));
    }
    return out;
  }

  /** Every open bundle, as at shutdown. */
  flush(): BundleClose[] {
    const out = [...this.bundles.values()].map((b) => this.close(b));
    this.bundles.clear();
    this.presses.clear();
    return out;
  }

  private bundle(windowId: string, at: number): Bundle {
    let b = this.bundles.get(windowId);
    if (b === undefined) this.bundles.set(windowId, (b = { dstWindowId: windowId, lastAt: at, transfers: [], predictions: [] }));
    return b;
  }

  /** Scores and counts in one transaction: a bundle closes on the event path. `closedAt`: when its window closed, null when it went idle. */
  private close(b: Bundle, closedAt: number | null = null): BundleClose {
    const presses = this.presses.get(b.dstWindowId) ?? [];
    // The next occurrence in a window that stays open starts with none of this one's presses.
    this.presses.delete(b.dstWindowId);
    return this.memory.batch(() => this.closeNow(b, presses, closedAt));
  }

  private closeNow(b: Bundle, presses: readonly ObservedPress[], closedAt: number | null): BundleClose {
    // The last transfer of each shape counts: a value copied and then replaced from another row is the replacement.
    const last = new Map<string, PatternTransfer>();
    for (const t of b.transfers) {
      last.delete(t.shape);
      last.set(t.shape, t);
    }
    const done = [...last.values()];
    const steps = done.map((t) => this.step(t));
    const sig = steps.length >= MIN_ROUTINE_STEPS ? this.hash(`routine\u0000${steps.map((s) => s.shapeHash).sort().join(",")}`) : null;
    const dst = this.model.windows.get(b.dstWindowId);

    const scored: BundleClose["scored"] = [];
    for (const p of b.predictions) {
      // A prediction with a step it could not read predicted nothing concrete, so it is not scored.
      if (!p.grounded) continue;
      const hit =
        sig === p.routine.sig &&
        p.cells.every((c) => {
          if (c === null) return false;
          // What the field holds now is what the user ended with, including any edit made after the copy.
          // The model still has the window here: close runs before a closed window leaves it.
          const final = dst?.nodes.get(c.dstKey);
          if (final !== undefined) return normalizeValue(final.value ?? "", c.kind) === normalizeValue(c.value, c.kind);
          const t = last.get([...last.keys()].find((k) => this.hash(k) === p.routine.steps[c.step]!.shapeHash) ?? "");
          return t !== undefined && normalizeValue(t.value, c.kind) === normalizeValue(c.value, c.kind);
        });
      this.memory.scoreRoutine(p.routine.id, hit);
      scored.push({ routineId: p.routine.id, hit, cells: p.cells.filter((c): c is RoutineCell => c !== null) });
    }
    if (sig !== null) this.keepValues(sig, [...done.map((t) => t.value), ...b.predictions.flatMap((p) => p.cells.flatMap((c) => (c === null ? [] : [c.value])))]);
    // Read from the destination whether it closed or went idle; a press once learned is never forgotten, so a
    // routine that has ended in a risky press stays one that never runs on its own. The user's own last press
    // decides when the reader saw one; the window's buttons are the guess only when it saw none.
    const pressed = dst === undefined ? undefined : this.finishPressed(dst, presses, closedAt);
    const finish = dst === undefined ? undefined : pressed !== undefined ? (pressed ?? undefined) : (this.finishOf(dst) ?? undefined);
    const recorded = sig === null ? null : this.memory.recordRoutine(sig, steps, b.lastAt, finish);
    return { dstWindowId: b.dstWindowId, sig, recorded, scored };
  }

  private keepValues(sig: string, values: readonly string[]): void {
    let s = this.seenValues.get(sig);
    if (s === undefined) {
      if (this.seenValues.size >= ROUTINES_WITH_VALUES) this.seenValues.delete(this.seenValues.keys().next().value as string);
      this.seenValues.set(sig, (s = new Set()));
    }
    for (const v of values) {
      if (s.has(v)) continue;
      if (s.size >= VALUES_PER_ROUTINE) s.delete(s.values().next().value as string);
      s.add(v);
    }
  }

  /**
   * The press an occurrence may end with, read from its destination window when its bundle closes: the
   * window's one button whose label reads as outbound, or failing that its one button that reads as
   * destructive or money (executor/risk.ts). Several of them with none to pick come back `ambiguous`,
   * naming them all. Null when the window has none. The guess only ever adds a hand-off or holds a skill on
   * Tab: Caret never presses it.
   */
  private finishOf(w: WindowState): RoutineFinish | null {
    const risky: { key: string; label: string; why: RoutineFinish["why"] }[] = [];
    for (const n of w.nodes.values()) {
      if (n.role !== "AXButton") continue;
      const label = (n.label ?? "").trim();
      const why = label === "" ? "safe" : classifyLabel(label);
      if (why !== "safe") risky.push({ key: n.key, label, why });
    }
    const first = risky[0];
    if (first === undefined) return null;
    const outbound = risky.filter((r) => r.why === "outbound");
    const pick = outbound.length === 1 ? outbound[0] : risky.length === 1 ? first : undefined;
    const at = pick ?? outbound[0] ?? first;
    const slot = windowIndex(w).slots.get(at.key);
    if (slot === undefined) return null;
    const base = { why: at.why, templateHash: this.templateHash(slot.template), pos: slot.pos, by: "buttons" as const };
    if (pick !== undefined) return { ...base, label: pick.label };
    return { ...base, label: [...new Set(risky.map((r) => r.label))].join(" or "), ambiguous: true };
  }

  /**
   * The finish the user's own last press in this occurrence names (B20): a press that reads as outbound,
   * destructive or money is the finish, found by template and position like a step's field. Any other press
   * that closed the window (within PRESS_ENDS_MS) means the occurrence ended without one, so null, and no
   * button is guessed. Undefined when the reader saw no press here, when a safe press did not end it, or when
   * the pressed element is no longer in the window as the model has it: then the window's buttons are the
   * guess. A press with no key is placed by its label when exactly one control of its role has it.
   */
  private finishPressed(w: WindowState, presses: readonly ObservedPress[], closedAt: number | null): RoutineFinish | null | undefined {
    const p = presses.at(-1);
    if (p === undefined) return undefined;
    const label = p.label.trim();
    let key = p.key;
    if (key === null) {
      const same = [...w.nodes.values()].filter((n) => n.role === p.role && (n.label ?? "").trim() === label);
      key = same.length === 1 ? (same[0]?.key ?? null) : null;
    }
    const node = key === null ? undefined : w.nodes.get(key);
    if (key === null || node === undefined) return undefined;
    const why = label === "" ? "safe" : classifyLabel(label);
    if (why === "safe") return closedAt !== null && closedAt >= p.at && closedAt - p.at <= PRESS_ENDS_MS ? null : undefined;
    const slot = windowIndex(w).slots.get(key);
    if (slot === undefined) return undefined;
    return { label, why, templateHash: this.templateHash(slot.template), pos: slot.pos, by: "click" };
  }

  private step(t: PatternTransfer): RoutineStep {
    return {
      shapeHash: this.hash(t.shape),
      srcBundle: t.src.bundleId,
      srcApp: t.src.appName,
      srcWindowKind: t.src.windowKind,
      srcTemplateHash: this.templateHash(t.src.template),
      srcPos: t.src.pos,
      part: t.part,
      dstBundle: t.dst.bundleId,
      dstApp: t.dst.appName,
      dstWindowKind: t.dst.windowKind,
      dstTemplateHash: this.templateHash(t.dst.template),
      dstPos: t.dst.pos,
    };
  }

  /** The step's source, read now from the most recently focused window of the source app and kind that has it. */
  private source(step: RoutineStep, dstWindowId: string): { windowId: string; key: string; text: string } | null {
    const ws = [...this.model.windows.values()]
      .filter((w) => w.window.windowId !== dstWindowId && w.app.bundleId === step.srcBundle && w.window.kind === step.srcWindowKind)
      .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt || b.updatedAt - a.updatedAt);
    for (const w of ws) {
      const template = this.templatesOf(w).get(step.srcTemplateHash);
      if (template === undefined) continue;
      const hit = locate(this.model, w.window.windowId, template, step.srcPos, step.part as Part);
      if (hit !== null && hit.text !== null) return { windowId: w.window.windowId, key: hit.key, text: hit.text };
    }
    return null;
  }

  /** The window's templates by keyed hash. */
  private templatesOf(w: WindowState): Map<string, string> {
    const out = new Map<string, string>();
    for (const t of windowIndex(w).byTemplate.keys()) out.set(this.templateHash(t), t);
    return out;
  }

  private templateHash(t: string): string {
    let h = this.templateHashes.get(t);
    if (h === undefined) {
      // Bounded: templates repeat across windows, but a long session can still see many.
      if (this.templateHashes.size > 50_000) this.templateHashes.clear();
      this.templateHashes.set(t, (h = this.hash(`template\u0000${t}`)));
    }
    return h;
  }
}
