// The loop recognizer (plan section 4, "Loops, within one sitting"): Flash Fill's idea applied to
// transfers. Two rounds in a row of the same transfers, each round one row further down the
// destination and a fixed step further down the source, make a loop. After round two the next
// round is predicted from what is on screen now; once the user takes it, or types the same values,
// every remaining round is offered as one plan.
//
// A round is 1 to 3 transfers (one per column), so a two-column table filled cell by cell is found
// too. All state is in memory: a loop belongs to one sitting.
import { normalizeValue } from "../normalize.ts";
import type { ScreenModel } from "../model.ts";
import type { ValueKind } from "../protocol.ts";
import { locate, shapeOf, type Part, type PatternTransfer, type SrcOption } from "./shape.ts";

/** Largest number of transfers in one round. Three covers a name, an email and a phone per row. */
export const MAX_PERIOD = 3;
/**
 * Largest step between consecutive source items. A list whose items each take two or three lines
 * (name, then email) has a step of 2 or 3. Larger steps are more likely chance than a pattern. Assumed.
 */
export const MAX_SRC_STRIDE = 3;
/** Longest pause between two transfers of one loop. Assumed, not measured. */
export const LOOP_GAP_MS = 120_000;
/** Cap on the rounds one "Finish the rest" plan writes. Assumed. */
export const MAX_FINISH_ROUNDS = 50;

export interface LoopColumn {
  shape: string;
  /** Every value in this column looked like this (valueClass); a source item that does not is not predicted. */
  valueClass: string;
  part: Part;
  kind: ValueKind | null;
  srcTemplate: string;
  dstTemplate: string;
  srcStride: number;
}

/** One predicted write: a destination element and the source text to copy into it, read from the screen now. */
export interface LoopCell {
  column: number;
  dstWindowId: string;
  dstKey: string;
  dstRole: string;
  dstLabel: string | null;
  srcWindowId: string;
  srcKey: string;
  value: string;
  kind: ValueKind | null;
}

export interface Loop {
  id: string;
  srcWindowId: string;
  dstWindowId: string;
  columns: LoopColumn[];
  /** Rounds seen or written so far, counting the two that founded the loop. */
  rounds: number;
  /** Source and destination positions of the last round, per column. */
  srcPos: number[];
  dstPos: number[];
  /** The round predicted and not yet confirmed; null once confirmed or when nothing more can be predicted. */
  prediction: LoopCell[] | null;
  /** Every cell this loop predicted or will write, by destination key, with the normalized values it may take. */
  expected: Map<string, Set<string>>;
  /** Cells of the current prediction the user has already filled with the predicted value. */
  filled: Set<string>;
  confirmed: boolean;
  lastAt: number;
}

export type LoopEvent =
  /** Round two matched round one: here is round three. */
  | { type: "predict"; loop: Loop; cells: LoopCell[] }
  /** The predicted round was taken or typed; `rest` is every round after it that can be read from the screen. */
  | { type: "confirmed"; loop: Loop; rest: LoopCell[][] }
  | { type: "ended"; loop: Loop; reason: "diverged" | "idle" | "dismissed" };

export class LoopRecognizer {
  private history: PatternTransfer[] = [];
  private loop: Loop | null = null;
  private seq = 0;
  private readonly model: ScreenModel;

  constructor(model: ScreenModel) {
    this.model = model;
  }

  get active(): Loop | null {
    return this.loop;
  }

  onTransfer(t: PatternTransfer): LoopEvent[] {
    const out: LoopEvent[] = [];
    const loop = this.loop;
    if (loop !== null) {
      if (t.at - loop.lastAt > LOOP_GAP_MS) out.push(this.end("idle"));
      else {
        if (t.dst.windowId === loop.dstWindowId && loop.expected.get(t.dst.key)?.has(normalizeValue(t.value, t.kind)) === true) {
          loop.lastAt = t.at;
          const ev = this.absorb(loop, t.dst.key);
          if (ev !== null) out.push(ev);
          return out;
        }
        out.push(this.end("diverged"));
      }
    }
    const last = this.history[this.history.length - 1];
    if (last !== undefined && t.at - last.at > LOOP_GAP_MS) this.history = [];
    this.history.push(t);
    if (this.history.length > 2 * MAX_PERIOD) this.history.shift();
    const found = this.detect();
    if (found !== null) out.push(found);
    return out;
  }

  /**
   * A transfer the recognizers cannot describe, such as a copy whose source line has since scrolled
   * away. It still breaks "in a row", unless it is a cell the active loop expected.
   */
  onOpaque(at: number, dstWindowId: string, dstKey: string, value: string, kind: ValueKind | null): LoopEvent[] {
    const loop = this.loop;
    if (loop !== null && dstWindowId === loop.dstWindowId && loop.expected.get(dstKey)?.has(normalizeValue(value, kind)) === true) {
      loop.lastAt = at;
      const ev = this.absorb(loop, dstKey);
      return ev === null ? [] : [ev];
    }
    this.history = [];
    return loop === null ? [] : [this.end("diverged")];
  }

  /** Also accepts `value` in this cell: what Caret will write there after memory rules changed the source text. */
  expect(loopId: string, dstKey: string, value: string, kind: ValueKind | null): void {
    if (this.loop?.id === loopId) addExpected(this.loop, dstKey, value, kind);
  }

  /** Forgets the active loop and the rounds that might found one, as when a new reader renumbers windows. */
  reset(): void {
    this.loop = null;
    this.history = [];
  }

  /** Caret wrote the predicted round. */
  taken(loopId: string): LoopEvent | null {
    const loop = this.loop;
    if (loop === null || loop.id !== loopId || loop.prediction === null) return null;
    return this.confirm(loop);
  }

  /** The user dismissed an offer from this loop; it stops offering but keeps absorbing its cells. */
  dismissed(loopId: string): LoopEvent | null {
    if (this.loop?.id !== loopId) return null;
    return this.end("dismissed");
  }

  /** Ends a loop whose last transfer is older than the gap. */
  tick(now: number): LoopEvent | null {
    if (this.loop !== null && now - this.loop.lastAt > LOOP_GAP_MS) return this.end("idle");
    return null;
  }

  private end(reason: "diverged" | "idle" | "dismissed"): LoopEvent {
    const loop = this.loop as Loop;
    this.loop = null;
    this.history = [];
    return { type: "ended", loop, reason };
  }

  /** A transfer into a cell the loop expected. Confirms the prediction when it completes the predicted round. */
  private absorb(loop: Loop, dstKey: string): LoopEvent | null {
    const p = loop.prediction;
    if (p === null || !p.some((c) => c.dstKey === dstKey)) return null;
    loop.filled.add(dstKey);
    if (!p.every((c) => loop.filled.has(c.dstKey))) return null;
    return this.confirm(loop);
  }

  private confirm(loop: Loop): LoopEvent {
    loop.prediction = null;
    loop.filled.clear();
    loop.confirmed = true;
    loop.rounds++;
    loop.srcPos = loop.columns.map((_, i) => loop.srcPos[i]! + loop.columns[i]!.srcStride);
    loop.dstPos = loop.dstPos.map((d) => d + 1);
    const rest: LoopCell[][] = [];
    let src = loop.srcPos;
    let dst = loop.dstPos;
    for (let r = 0; r < MAX_FINISH_ROUNDS; r++) {
      const cells = this.predict(loop, src, dst);
      if (cells === null) break;
      rest.push(cells);
      for (const c of cells) addExpected(loop, c.dstKey, c.value, c.kind);
      src = src.map((s, i) => s + loop.columns[i]!.srcStride);
      dst = dst.map((d) => d + 1);
    }
    return { type: "confirmed", loop, rest };
  }

  private detect(): LoopEvent | null {
    const h = this.history;
    for (let k = 1; k <= MAX_PERIOD; k++) {
      if (h.length < 2 * k) break;
      const a = h.slice(h.length - 2 * k, h.length - k);
      const b = h.slice(h.length - k);
      const fit = this.fit(a, b);
      if (fit === null) continue;
      const { columns, srcWindowId, srcPos } = fit;
      const first = a[0] as PatternTransfer;
      const loop: Loop = {
        id: `loop-${++this.seq}`,
        srcWindowId,
        dstWindowId: first.dst.windowId,
        columns,
        rounds: 2,
        srcPos,
        dstPos: b.map((t) => t.dst.pos),
        prediction: null,
        expected: new Map(),
        filled: new Set(),
        confirmed: false,
        lastAt: (b[k - 1] as PatternTransfer).at,
      };
      const next = this.predict(loop, loop.srcPos, loop.dstPos);
      // Nothing left to predict (the table or the list ended): the loop is real but has nothing to offer.
      if (next === null) return null;
      loop.prediction = next;
      for (const c of next) addExpected(loop, c.dstKey, c.value, c.kind);
      this.loop = loop;
      this.history = [];
      return { type: "predict", loop, cells: next };
    }
    return null;
  }

  /**
   * Whether round `b` repeats round `a` one row down, reading every transfer from one source window.
   * Windows are tried in the order the first transfer offers them, credited source first.
   */
  private fit(a: PatternTransfer[], b: PatternTransfer[]): { columns: LoopColumn[]; srcWindowId: string; srcPos: number[] } | null {
    const all = [...a, ...b];
    const dstWindowId = all[0]!.dst.windowId;
    if (all.some((t) => t.dst.windowId !== dstWindowId)) return null;
    for (const first of all[0]!.srcOptions) {
      const w = first.side.windowId;
      const pick = (t: PatternTransfer): SrcOption | undefined => t.srcOptions.find((o) => o.side.windowId === w);
      const columns: LoopColumn[] = [];
      const srcPos: number[] = [];
      for (let i = 0; i < a.length; i++) {
        const x = a[i]!;
        const y = b[i]!;
        const sx = pick(x);
        const sy = pick(y);
        if (sx === undefined || sy === undefined) break;
        const shape = shapeOf(sx.side, sx.part, x.dst);
        const stride = sy.side.pos - sx.side.pos;
        const cls = valueClass(x.value);
        if (shape !== shapeOf(sy.side, sy.part, y.dst) || cls !== valueClass(y.value) || y.dst.pos - x.dst.pos !== 1 || stride < 1 || stride > MAX_SRC_STRIDE) break;
        columns.push({ shape, valueClass: cls, part: sx.part, kind: x.kind, srcTemplate: sx.side.template, dstTemplate: x.dst.template, srcStride: stride });
        srcPos.push(sy.side.pos);
      }
      if (columns.length === a.length) return { columns, srcWindowId: w, srcPos };
    }
    return null;
  }

  /**
   * The round after the one at `srcPos`/`dstPos`, read from the screen now. Null when any column's
   * next destination is missing, not editable or already filled, or its next source has no such part.
   */
  private predict(loop: Loop, srcPos: number[], dstPos: number[]): LoopCell[] | null {
    const cells: LoopCell[] = [];
    for (let i = 0; i < loop.columns.length; i++) {
      const col = loop.columns[i]!;
      const dst = locate(this.model, loop.dstWindowId, col.dstTemplate, dstPos[i]! + 1, "whole");
      if (dst === null || dst.node.editable !== true || (dst.node.value ?? "") !== "") return null;
      const src = locate(this.model, loop.srcWindowId, col.srcTemplate, srcPos[i]! + col.srcStride, col.part);
      if (src === null || src.text === null || valueClass(src.text) !== col.valueClass) return null;
      cells.push({
        column: i,
        dstWindowId: loop.dstWindowId,
        dstKey: dst.key,
        dstRole: dst.node.role,
        dstLabel: dst.node.label ?? null,
        srcWindowId: loop.srcWindowId,
        srcKey: src.key,
        value: src.text,
        kind: col.part === "whole" ? col.kind : col.part,
      });
    }
    return cells;
  }
}

/**
 * A coarse kind for any value, typed or not: a list of names followed by a list of emails shares one
 * element template, and only this tells the two apart.
 */
export function valueClass(v: string): "email" | "url" | "number" | "text" {
  const t = v.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return "email";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return "url";
  const compact = t.replace(/\s/g, "");
  const digits = compact.replace(/\D/g, "").length;
  return digits > 0 && digits * 2 >= compact.length ? "number" : "text";
}

function addExpected(loop: Loop, dstKey: string, value: string, kind: ValueKind | null): void {
  let set = loop.expected.get(dstKey);
  if (set === undefined) loop.expected.set(dstKey, (set = new Set()));
  set.add(normalizeValue(value, kind));
}
