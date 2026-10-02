// The routine counter (plan section 4, "Routines, across days"). A bundle is the transfers into one
// destination window, from its first transfer until the window closes or goes idle. Its signature
// is the sorted set of its transfer shapes, as keyed hashes. Each completed bundle with at least two
// shapes counts one occurrence of its routine.
//
// When a window opens that holds every destination field of a known routine, still empty, Caret
// predicts silently: it reads each step's source from the live windows now, and when the bundle
// closes it scores the prediction against what the user did. Only the gate turns a prediction into
// an offer, and only once enough silent predictions have matched (gate.ts).
import { normalizeValue } from "../normalize.ts";
import type { ScreenModel, WindowState } from "../model.ts";
import type { ValueKind } from "../protocol.ts";
import type { MemoryStore, RoutineRecord, RoutineStep } from "./memory.ts";
import { locate, windowIndex, type Part, type PatternTransfer } from "./shape.ts";

/** A bundle with no transfer for this long is complete. Assumed, not measured. */
export const BUNDLE_IDLE_MS = 120_000;
/** Distinct shapes a bundle needs to count as a routine. One shape repeated is a loop, not a routine. */
export const MIN_ROUTINE_STEPS = 2;

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
}

export interface BundleClose {
  dstWindowId: string;
  /** Null for a bundle with fewer than MIN_ROUTINE_STEPS shapes. */
  sig: string | null;
  /** The routine this bundle counted for; null when it is too small or was forgotten recently. */
  recorded: RoutineRecord | null;
  scored: { routineId: string; hit: boolean }[];
}

interface Bundle {
  dstWindowId: string;
  lastAt: number;
  transfers: PatternTransfer[];
  predictions: SilentPrediction[];
}

export type Hash = (text: string) => string;

export class RoutineRecognizer {
  private readonly bundles = new Map<string, Bundle>();
  private readonly templateHashes = new Map<string, string>();
  private readonly model: ScreenModel;
  private readonly memory: MemoryStore;
  private readonly hash: Hash;

  constructor(model: ScreenModel, memory: MemoryStore, hash: Hash) {
    this.model = model;
    this.memory = memory;
    this.hash = hash;
  }

  /** A window appeared. Predicts every unpaused routine whose destination fields it holds, empty. */
  onWindowOpened(windowId: string, at: number): SilentPrediction[] {
    const w = this.model.windows.get(windowId);
    if (w === undefined) return [];
    const routines = this.memory.routinesInto(w.app.bundleId, w.window.kind).filter((r) => !r.paused);
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
      const p: SilentPrediction = { routine, dstWindowId: windowId, at, cells, grounded: cells.every((c) => c !== null) };
      this.bundle(windowId, at).predictions.push(p);
      out.push(p);
    }
    return out;
  }

  onTransfer(t: PatternTransfer): void {
    const b = this.bundle(t.dst.windowId, t.at);
    b.transfers.push(t);
    b.lastAt = t.at;
  }

  onWindowClosed(windowId: string): BundleClose | null {
    const b = this.bundles.get(windowId);
    if (b === undefined) return null;
    this.bundles.delete(windowId);
    return this.close(b);
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
    return out;
  }

  private bundle(windowId: string, at: number): Bundle {
    let b = this.bundles.get(windowId);
    if (b === undefined) this.bundles.set(windowId, (b = { dstWindowId: windowId, lastAt: at, transfers: [], predictions: [] }));
    return b;
  }

  private close(b: Bundle): BundleClose {
    const first = new Map<string, PatternTransfer>();
    for (const t of b.transfers) if (!first.has(t.shape)) first.set(t.shape, t);
    const steps = [...first.values()].map((t) => this.step(t));
    const doneByShape = new Map(steps.map((s, i) => [s.shapeHash, [...first.values()][i]!]));
    const sig = steps.length >= MIN_ROUTINE_STEPS ? this.hash(`routine\u0000${steps.map((s) => s.shapeHash).sort().join(",")}`) : null;

    const scored: BundleClose["scored"] = [];
    for (const p of b.predictions) {
      // A prediction with a step it could not read predicted nothing concrete, so it is not scored.
      if (!p.grounded) continue;
      const hit =
        sig === p.routine.sig &&
        p.cells.every((c) => {
          if (c === null) return false;
          const done = doneByShape.get(p.routine.steps[c.step]!.shapeHash);
          return done !== undefined && normalizeValue(done.value, c.kind) === normalizeValue(c.value, c.kind);
        });
      this.memory.scoreRoutine(p.routine.id, hit);
      scored.push({ routineId: p.routine.id, hit });
    }
    const recorded = sig === null ? null : this.memory.recordRoutine(sig, steps, b.lastAt);
    return { dstWindowId: b.dstWindowId, sig, recorded, scored };
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
