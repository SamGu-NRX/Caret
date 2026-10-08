// Where a window's text is, as the output ledger counts it (OUTPUT-LEDGER-SPEC sections 1 and 4). One reader serves the
// window's inventory, mint membership (disclosure.ts viewHolds) and every recorded source range, so a text a builder may
// mint is always text the inventory counts, at the positions the inventory gives it.
//
// A window's text comes in parts: its title, and each node's label, value, placeholder and section texts. A part is
// split into lines at CR, LF and CRLF; each line has its whitespace collapsed to one space and trimmed; empty lines are
// dropped; an exact repeat of a line is one line. A part's raw UTF-16 offsets map to the inventory's positions: a
// collapsed run of whitespace maps every raw unit in it to its one space, and a line break or trimmed space maps to none.
import type { WindowState } from "../../model.ts";
import type { Node } from "../../protocol.ts";

/** The line breaks every reader splits at: CRLF, a bare CR and LF. */
export const LINE_BREAK = /\r\n|\r|\n/u;

/** A line as the inventory holds it: whitespace collapsed to one space, trimmed. */
export const sourceLine = (s: string): string => s.replace(/\s+/gu, " ").trim();

/**
 * sourceLine(raw), with the offset in `raw` each of its characters came from: a collapsed run of whitespace gives its
 * first. A text read from `raw` at [a, b) of the result came from raw's [from[a], from[b - 1] + 1). The one map from
 * collapsed text back to raw positions: producers that collapse whitespace before they cut a text (the fill candidate
 * generator, describeField) read their source ranges through it.
 */
export function collapsedMap(raw: string): { text: string; from: number[] } {
  const hit = COLLAPSED.get(raw);
  if (hit !== undefined) return hit;
  const out = readCollapsed(raw);
  // A producer reads the same few lines for many spans; the memo is bounded, as line-values.ts severalMemo is.
  if (COLLAPSED.size >= 4096) COLLAPSED.clear();
  COLLAPSED.set(raw, out);
  return out;
}
const COLLAPSED = new Map<string, { text: string; from: number[] }>();

function readCollapsed(raw: string): { text: string; from: number[] } {
  let text = "";
  const from: number[] = [];
  for (let i = 0; i < raw.length; ) {
    if (/\s/u.test(raw[i]!)) {
      let j = i;
      while (j < raw.length && /\s/u.test(raw[j]!)) j++;
      if (text !== "" && j < raw.length) {
        text += " ";
        from.push(i);
      }
      i = j;
    } else {
      text += raw[i];
      from.push(i);
      i++;
    }
  }
  return { text, from };
}

/**
 * The source range of `text` in part `part` (raw text `raw`), where `text`, less an ellipsis Caret added at its end,
 * stands at `at` of collapsedMap(raw).text (its start when not given). Null when it does not stand there.
 */
export function collapsedRange(part: PartId, raw: string, text: string, at = 0): SourceAt | null {
  const { text: c, from } = collapsedMap(raw);
  // The text as it stands, a literal ellipsis included; else less the one Caret added.
  const t = c.slice(at, at + text.length) === text ? text : text.endsWith("\u2026") ? text.slice(0, -1).trimEnd() : null;
  if (t === null || t === "" || c.slice(at, at + t.length) !== t) return null;
  return { part, start: from[at]!, end: from[at + t.length - 1]! + 1 };
}

/**
 * The one line splitter for screen text (LINE_BREAK: CRLF, a bare CR or LF): the inventory, membership, conversation
 * detection, redaction and the candidate generator all read lines through these, so no reader sees one line where
 * another sees two. A mail whose headers a bare CR separated was read as one line by conversation detection and classed
 * as a page.
 */
export function splitLines(text: string): string[] {
  return text.split(LINE_BREAK);
}

/** Whether `c` is a line break character (CR or LF). */
const isBreak = (c: string | undefined): boolean => c === "\n" || c === "\r";

/** Where the line holding offset `at` of `text` starts: just after the line break before it, or 0. */
export function lineStartAt(text: string, at: number): number {
  for (let i = Math.min(at, text.length) - 1; i >= 0; i--) if (isBreak(text[i])) return i + 1;
  return 0;
}

/** Where the line holding offset `at` of `text` ends: at the next line break from `at`, or the text's end. */
export function lineEndAt(text: string, at: number): number {
  for (let i = Math.max(at, 0); i < text.length; i++) if (isBreak(text[i])) return i;
  return text.length;
}

/** Where the line after the break at `end` starts (a CRLF is one break), or -1 when `end` is the text's end. */
export function nextLineStart(text: string, end: number): number {
  if (end >= text.length) return -1;
  return text[end] === "\r" && text[end + 1] === "\n" ? end + 2 : end + 1;
}

/** Each line of `text` (splitLines) with where it starts in the text. */
export function linesWithStarts(text: string): { raw: string; start: number }[] {
  const out: { raw: string; start: number }[] = [];
  for (let start = 0; ; ) {
    const end = lineEndAt(text, start);
    out.push({ raw: text.slice(start, end), start });
    const next = nextLineStart(text, end);
    if (next < 0) return out;
    start = next;
  }
}

/** A text's lines as the inventory reads them: split at line breaks, collapsed, trimmed, empty ones dropped. */
export function sourceLines(text: string): string[] {
  return splitLines(text).map(sourceLine).filter((l) => l !== "");
}

/**
 * The pieces a text is looked for by, in the inventory and in a view's typed values: its lines as sourceLines reads them,
 * each with a cut's ellipsis taken off either end, empty ones dropped. The one normalization for membership
 * (disclosure.ts viewHolds), attribution (textSpans) and the fallback's placement (measure.ts spanPositions): a typed
 * value compared as the reader spelled it ("Oct   16, 2026") matched no collapsed piece, and its node was charged nothing.
 */
export function sourcePieces(text: string): string[] {
  return sourceLines(text).map((l) => sourceLine(l.replace(/^\u2026|\u2026$/gu, ""))).filter((l) => l !== "");
}

/**
 * SCP1: a page web area's heading list and section texts (Node.headings, Node.outline), which a section question sends:
 * lines of the window like its labels, so they count toward its limit and the ledger charges them.
 */
export function sectionTexts(n: Node): string[] {
  if (n.headings === undefined && n.outline === undefined) return [];
  return [...(n.headings ?? []), ...(n.outline ?? []).flatMap((o) => (o.text === undefined ? [] : [o.text]))];
}

/** A part of a window's text, by id: "title", or a node's key with "label", "value", "placeholder" or "section:<i>". */
export type PartId = string;

export const TITLE: PartId = "title";
export const nodePart = (key: string, part: "label" | "value" | "placeholder"): PartId => `node\u0000${key}\u0000${part}`;
export const sectionPart = (key: string, i: number): PartId => `node\u0000${key}\u0000section:${i}`;

/** Every part of a window's text with its id, in reading order: the title, then each node's label, value, placeholder and section texts. */
export function partsOf(view: WindowState): { id: PartId; raw: string }[] {
  const out: { id: PartId; raw: string }[] = [];
  const add = (id: PartId, raw: string | undefined): void => {
    if (raw !== undefined && raw !== "") out.push({ id, raw });
  };
  add(TITLE, view.window.title);
  for (const n of view.nodes.values()) {
    add(nodePart(n.key, "label"), n.label);
    add(nodePart(n.key, "value"), n.value);
    add(nodePart(n.key, "placeholder"), n.placeholder);
    sectionTexts(n).forEach((t, i) => add(sectionPart(n.key, i), t));
  }
  return out;
}

/**
 * Where a minted text was read: a part of the view's text, and the UTF-16 range [start, end) of that part's raw text.
 * The range covers the source characters themselves; a mark Caret adds (a cut's ellipsis) is outside it.
 */
export interface SourceAt {
  readonly part: PartId;
  readonly start: number;
  readonly end: number;
}

/** A source range covering all of a part. */
export const wholePart = (part: PartId, raw: string): SourceAt => ({ part, start: 0, end: raw.length });

/** A part's raw text and, for each raw UTF-16 unit, its position in the window's inventory, or -1 for none. */
export interface PartMap {
  readonly raw: string;
  readonly pos: Int32Array;
}

/** The lines of some parts, distinct and in first-seen order, and each part's map into them. */
export function readParts(parts: readonly { id: PartId; raw: string }[]): { lines: string[]; maps: Map<PartId, PartMap>; malformed: boolean } {
  const index = new Map<string, number>();
  const lines: string[] = [];
  const starts: number[] = [];
  let total = 0;
  let malformed = false;
  const maps = new Map<PartId, PartMap>();
  for (const { id, raw } of parts) {
    const pos = new Int32Array(raw.length).fill(-1);
    // Each raw line between breaks, with its offset in the part.
    const re = new RegExp(LINE_BREAK.source, "gu");
    let from = 0;
    const pieces: [number, number][] = [];
    for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
      pieces.push([from, m.index]);
      from = m.index + m[0].length;
    }
    pieces.push([from, raw.length]);
    for (const [a, b] of pieces) {
      const piece = raw.slice(a, b);
      const line = sourceLine(piece);
      if (line === "") continue;
      // A line holding an unpaired surrogate cannot be measured: it is left out and the window marked (section 3).
      if (!line.isWellFormed()) {
        malformed = true;
        continue;
      }
      let li = index.get(line);
      if (li === undefined) {
        li = lines.length;
        index.set(line, li);
        lines.push(line);
        starts.push(total);
        total += line.length;
      }
      // Walk the raw piece beside its collapsed line: leading space maps to none, a run of space to its one space.
      let k = 0;
      let i = a;
      while (i < b && /\s/u.test(raw[i]!)) i++;
      while (i < b && k < line.length) {
        if (/\s/u.test(raw[i]!)) {
          let j = i;
          while (j < b && /\s/u.test(raw[j]!)) j++;
          if (j === b) break; // trailing space: trimmed
          for (let x = i; x < j; x++) pos[x] = starts[li]! + k;
          k++;
          i = j;
        } else {
          pos[i] = starts[li]! + k;
          k++;
          i++;
        }
      }
      if (k !== line.length) throw new Error("readParts: a line's raw text does not collapse to the line");
    }
    const had = maps.get(id);
    if (had !== undefined) throw new Error(`readParts: part ${id} twice`);
    maps.set(id, { raw, pos });
  }
  return { lines, maps, malformed };
}
