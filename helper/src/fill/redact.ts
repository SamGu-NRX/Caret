// G2 round 4: the one place that decides what of a source window fill may read. The candidate generator (candidates.ts:
// its passes, rankWindow, leftOut, windowValues, labelledLines) and fill's anchor read a window only through
// redactWindow, so no extraction path has a secret filter of its own and none can miss one. Per-path filters did not
// converge: each round of review found another path (a field's label, its nearest label, a block head, a cell) or
// another format (a marker after the label, "pin#", a quoted value). The rule is the marker word (memory/sensitive.ts
// markerWord) or a value Caret never types (valueKind); a request that still carries either is refused before it is
// sent (privacy.ts assertNoSecrets).
//
// What the view drops:
//   - every line that holds a marker word or such a value, anywhere in it, whatever follows; a marker split by a line
//     break ("API" then "key: …"); a private key's whole fenced block; and the value a dropped opener ("Password:", "PIN
//     is") takes, the next line that is not blank, which can open in turn;
//   - every node whose own label or placeholder (as attributes) holds a marker word, or whose nearest one-line label does
//     (descriptor.ts nodesLabelledBy, no shape filter), value and all, whatever its role, and that label's node; and
//     everything under a node it drops;
//   - every typed value of a dropped node, or that stands only on dropped lines;
//   - the whole window when its title holds a marker word: every candidate quotes its window's title.
// Cost on the corpora (fixtures/realfill/sources and F1's task notes, mails and memory: 276 non-blank lines,
// test/g2-ownership.test.ts "the redacted view's cost"; W4's note, 15 lines, outside the repository): 1 line, Ashby's
// "Incident question: use the token-leak story, write it fresh.", whose key is none: 0 right values lost.
import type { WindowState } from "../model.ts";
import type { Node, TypedValue } from "../protocol.ts";
import { markerAcross, markerEnds, PEM_BEGIN, PEM_END, secretText } from "../memory/sensitive.ts";
import { nodesLabelledBy } from "./descriptor.ts";

export { secretText };

/** A line that ends in a colon or a marker phrase ("Password:", "my private key", "PIN is"): its value may be on the next. */
function opensValue(line: string): boolean {
  // A fence's END line closes a block; it opens nothing (G2 round 7 review: it ate the next record).
  if (PEM_END.test(line)) return false;
  return line.trim().endsWith(":") || markerEnds(line);
}

/**
 * A text less the lines it must not give, and the indexes of the lines it dropped; the text unchanged when it gives all.
 * A line goes when it is secret (secretText), when a marker runs across its line break ("API" then "key: …"), or when an
 * opener above it takes it: an opener ("Password:", "my private key", "PIN is") takes the next line that is not blank,
 * the blank ones between with it, and a line it takes opens in turn ("Password:" then "PIN:" then "violet-orchard-seven").
 */
function droppedLines(lines: readonly string[], continues: readonly boolean[] = [], physicalLines: readonly number[] = []): Set<number> {
  const secret = lines.map((l) => secretText(l));
  for (let i = 1; i < lines.length; i++) {
    if (!secret[i - 1] && !secret[i] && markerAcross(lines[i - 1] as string, lines[i] as string)) secret[i - 1] = secret[i] = true;
  }
  // A BEGIN fence's block, through its END fence (or the end of the text), goes whole.
  for (let i = 0; i < lines.length; i++) {
    if (!PEM_BEGIN.test(lines[i] as string)) continue;
    let j = i;
    while (j < lines.length) {
      secret[j] = true;
      if (j > i && PEM_END.test(lines[j] as string)) break;
      j++;
    }
    i = j;
  }
  if (!secret.some((x) => x)) return new Set();
  const dropped = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!secret[i]) continue;
    dropped.add(i);
    // The opener reads the line as a whole, a marker that ran across from the line above included.
    let open = opensValue(lines[i] as string) || (i > 0 && secret[i - 1] === true && !PEM_END.test(lines[i] as string) && opensValue(`${lines[i - 1]} ${lines[i]}`));
    let j = i;
    while (open && j + 1 < lines.length && continues[j] !== false) {
      j++;
      dropped.add(j);
      let taken = lines[j] as string;
      // An opener consumes the whole following physical line, including any clause separators in its value.
      while (physicalLines[j] !== undefined && j + 1 < lines.length && physicalLines[j + 1] === physicalLines[j]) {
        j++;
        dropped.add(j);
        taken += ` ${lines[j]}`;
      }
      if (taken.trim() === "") continue;
      open = opensValue(taken);
    }
    i = Math.max(i, j);
  }
  return dropped;
}

function keptText(text: string): { kept: string; dropped: Set<number> } {
  const dropped = droppedLines(text.split(/\r?\n/u));
  if (dropped.size === 0) return { kept: text, dropped };
  const parts = text.split(/(\r?\n)/u);
  const out: string[] = [];
  for (let k = 0; k < parts.length; k += 2) if (!dropped.has(k / 2)) out.push(parts[k] as string, parts[k + 1] ?? "");
  return { kept: out.join("").replace(/\r?\n$/u, ""), dropped };
}

const WITHHELD_INSTRUCTION = "[a field Caret leaves to you]";

/** Instruction clauses are line units for the same drop rule as window text. Quoted values stay whole.
 * Retained spans remain separate so extraction cannot join text across a removed clause into a new literal.
 */
export function instructionView(text: string): { text: string; retained: string[] } {
  const units: { text: string; separator: string; line: number }[] = [];
  let start = 0;
  let line = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== null) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "“" || c === "‘" || (c === "'" && (i === 0 || /[\s(=:]/u.test(text[i - 1]!)))) {
      quote = c === "“" ? "”" : c === "‘" ? "’" : c;
      continue;
    }
    // Match the planner's assignment-clause heads, not every "and" inside an unquoted value.
    const separator = /^(?:\r?\n|;|\s+(?:and|then)\s+(?=(?:the|my|our|set|put|write|enter|type|change|make|fill|add|use|copy|paste|insert|attach|upload|send|submit|press|click|open)\b))/iu.exec(text.slice(i))?.[0];
    if (separator === undefined) continue;
    units.push({ text: text.slice(start, i), separator, line });
    if (/\r?\n/u.test(separator)) line++;
    i += separator.length - 1;
    start = i + 1;
  }
  units.push({ text: text.slice(start), separator: "", line });
  // A real line break lets an opener take its next value. An explicit new clause does not.
  const dropped = droppedLines(units.map((u) => u.text), units.map((u) => /\r?\n/u.test(u.separator)), units.map((u) => u.line));
  if (dropped.size === 0) return { text, retained: [text] };
  const retained: string[] = [];
  let span = "";
  for (const [i, unit] of units.entries()) {
    if (dropped.has(i)) continue;
    span += unit.text;
    if (!dropped.has(i + 1)) span += unit.separator;
    else { retained.push(span); span = ""; }
  }
  if (span !== "") retained.push(span);
  let shown = "";
  for (const [i, unit] of units.entries()) {
    if (!dropped.has(i)) shown += unit.text;
    else if (i === 0 || !dropped.has(i - 1)) shown += WITHHELD_INSTRUCTION;
    if (!dropped.has(i) || !dropped.has(i + 1)) shown += unit.separator;
  }
  return { text: shown, retained };
}

/** Model-facing instruction text; raw text remains local for refusal and provenance checks. */
export function instructionForModel(text: string): string {
  return instructionView(text).text;
}

/**
 * Whether a typed value goes with its node's dropped lines, judged per attribute (its label, its value), each by its
 * own line range (G2 round 7: a value whole in the label was dropped because the value had lost lines). It is kept when
 * some attribute holds it where none of that attribute's dropped lines are; it goes when every place it stands covers a
 * dropped line, or when it stands in no attribute and some attribute lost lines (where it stood cannot be shown kept).
 * Line endings are compared as "\n" (a reader's value can say "\r\n" where its node says "\n").
 */
function valueGoes(texts: readonly { text: string; dropped: ReadonlySet<number> }[], value: string): boolean {
  if (value === "" || texts.every((x) => x.dropped.size === 0)) return false;
  const v = value.replace(/\r\n/gu, "\n");
  let found = false;
  for (const x of texts) {
    const t = x.text.replace(/\r\n/gu, "\n");
    for (let at = t.indexOf(v); at >= 0; at = t.indexOf(v, at + 1)) {
      found = true;
      const first = t.slice(0, at).split("\n").length - 1;
      const last = first + v.split("\n").length - 1;
      let covered = false;
      for (let i = first; i <= last && !covered; i++) covered = x.dropped.has(i);
      if (!covered) return false;
    }
  }
  return found || texts.some((x) => x.dropped.size > 0);
}

/**
 * Built once per window state. Its cost (scripts/generator-bench.ts, 20 focuses a scene, evidence/screen/g2/whose/
 * genbench-*): generator p50 0.9-3.7 ms against 0ea0077's 0.8-2.1, and 1 focus of 20 over GENERATOR_BUDGET_MS on the
 * 5,500-span scene with every window new (0ea0077: 0); a focus over budget withholds, it never guesses. The marker
 * check is indexed by first word and memoized by text (memory/sensitive.ts) to get there.
 */
/** Roles whose label is their text (model.ts nodeText with no value): content, redacted by line, not a name. */
const TEXT_ROLES: ReadonlySet<string> = new Set(["AXStaticText", "AXCell", "AXHeading", "AXLink", "AXTextArea", "AXTextField"]);

const views = new WeakMap<WindowState, { at: number; view: WindowState }>();

/**
 * The window as fill may read it: a WindowState of its own, built once per window state the model holds (each snapshot
 * makes a new one) and again if that state's `updatedAt` moves, never cached per node, since a node can be kept from one
 * snapshot to the next while what labels it changes.
 */
export function redactWindow(w: WindowState): WindowState {
  const hit = views.get(w);
  if (hit !== undefined && hit.at === w.updatedAt) return hit.view;
  const view = build(w);
  views.set(w, { at: w.updatedAt, view });
  return view;
}

/** Marker halves can be separate AX text nodes. Join only consecutive document text with adjacent positions. */
function splitTextNodes(w: WindowState): Set<string> {
  const out = new Set<string>();
  let previous: Node | undefined;
  for (const n of w.nodes.values()) {
    if (!TEXT_ROLES.has(n.role) || (n.value ?? n.label ?? "").trim() === "") continue;
    if (previous !== undefined) {
      const a = previous.frame;
      const b = n.frame;
      const nearby = a === undefined || b === undefined || (
        // Use nearestLabel's existing 260/48-pixel neighborhood, not a new distance heuristic.
        // A following text on the same row, or on the next row in the same column.
        (Math.abs(a[1] + a[3] / 2 - (b[1] + b[3] / 2)) <= Math.max(a[3], b[3]) / 2 && b[0] >= a[0] && b[0] - (a[0] + a[2]) <= 260) ||
        (b[1] >= a[1] + a[3] && b[1] - (a[1] + a[3]) <= 48 && a[0] <= b[0] + b[2] && b[0] <= a[0] + a[2])
      );
      const first = (previous.value ?? previous.label ?? "").split(/\r?\n/u).at(-1)!;
      const second = (n.value ?? n.label ?? "").split(/\r?\n/u)[0]!;
      if (nearby && markerAcross(first, second)) { out.add(previous.key); out.add(n.key); }
    }
    previous = n;
  }
  return out;
}

function build(w: WindowState): WindowState {
  if (secretText(w.window.title)) return { ...w, window: { ...w.window, title: "" }, nodes: new Map(), values: [] };
  const split = splitTextNodes(w);
  const dropped = nodesLabelledBy(w, secretText, split);
  const nodes = new Map<string, Node>();
  /** Each kept node's texts, with the lines each lost, which no typed value of it may stand on. */
  const lost = new Map<string, { text: string; dropped: Set<number> }[]>();
  /** Nodes left out, so their descendants are too: a container labelled for a secret holds what it labels. */
  const gone = new Set<string>();
  /**
   * SCP1: headings redaction took, kept as headings with no text. A heading bounds the section before it, so a field
   * after "Password and security" is not placed under the heading before that one (re-review of 9939ac2).
   */
  const stubs = new Map<string, Node>();
  const heading = (n: Node): void => {
    if (n.role === "AXHeading") stubs.set(n.key, { key: n.key, parent: n.parent, role: "AXHeading" });
  };
  for (const n of w.nodes.values()) {
    // A node's own label or placeholder, as attributes, that names a secret takes the node and its value, whatever its
    // role (G2 round 6 review: a cell labelled "Password" holding an email). A static text whose only text is its label
    // has that label as its content, redacted line by line below, as any document's.
    // A text's label is its content; a container's (a group, a list) is its name, an attribute (G2 round 7 review).
    const labelIsContent = n.editable !== true && n.value === undefined && TEXT_ROLES.has(n.role);
    // AX can split a marker between its own attributes, such as label "API" and value "key: ...".
    const attrs = [n.label, n.placeholder, n.value].filter((t): t is string => t !== undefined && t.trim() !== "");
    const splitMarker = attrs.some((a, i) => attrs.some((b, j) => i !== j && markerAcross(a, b)));
    if (n.parent !== null && gone.has(n.parent)) {
      gone.add(n.key);
      continue;
    }
    if (dropped.has(n.key) || split.has(n.key) || splitMarker || secretText(n.placeholder) || (!labelIsContent && secretText(n.label))) {
      gone.add(n.key);
      heading(n);
      continue;
    }
    // The node with its texts' secret lines gone. A node that gives no text, and had some, is gone with them.
    const l = n.label === undefined ? undefined : keptText(n.label);
    const v = n.value === undefined ? undefined : keptText(n.value);
    const value = v?.kept;
    const label = l?.kept;
    const texts = [...(v === undefined || n.value === undefined ? [] : [{ text: n.value, dropped: v.dropped }]), ...(l === undefined || n.label === undefined ? [] : [{ text: n.label, dropped: l.dropped }])];
    if (texts.some((x) => x.dropped.size > 0)) lost.set(n.key, texts);
    const had = (n.value ?? "") !== "" || (n.label ?? "") !== "";
    if (had && (value ?? "") === "" && (label ?? "") === "" && n.editable !== true) {
      gone.add(n.key);
      heading(n);
      continue;
    }
    // SCP1: a page's heading or section text that names a secret is left out, as a label that names one is. A section
    // keeps its place in the outline without its text, so it still ends the section before it.
    const headings = n.headings?.filter((h) => !secretText(h));
    const outline = n.outline?.some((o) => o.text !== undefined && secretText(o.text)) === true ? n.outline.map((o) => (o.text !== undefined && secretText(o.text) ? { key: o.key, heading: o.heading } : o)) : n.outline;
    if (value === n.value && label === n.label && headings?.length === n.headings?.length && outline === n.outline) nodes.set(n.key, n);
    else {
      const m: Node = { ...n };
      if (value === undefined) delete m.value;
      else m.value = value;
      if (label === undefined) delete m.label;
      else m.label = label;
      if (headings === undefined || headings.length === 0) delete m.headings;
      else m.headings = headings;
      if (outline === undefined) delete m.outline;
      else m.outline = outline;
      nodes.set(n.key, m);
    }
  }
  // AX snapshots need not list parents before children. Close the removed set over the original tree.
  const children = new Map<string, string[]>();
  for (const n of w.nodes.values()) {
    if (n.parent === null) continue;
    const keys = children.get(n.parent) ?? [];
    keys.push(n.key);
    children.set(n.parent, keys);
  }
  const queue = [...gone];
  for (let i = 0; i < queue.length; i++) for (const key of children.get(queue[i]!) ?? []) {
    if (gone.has(key)) continue;
    gone.add(key);
    queue.push(key);
  }
  for (const key of gone) nodes.delete(key);
  // A text-less heading goes back in its place in document order, unless what holds it went too.
  if (stubs.size > 0) {
    const ordered = new Map<string, Node>();
    for (const [k, n] of w.nodes) {
      const stub = stubs.get(k);
      const kept = nodes.get(k) ?? (stub !== undefined && (n.parent === null || !gone.has(n.parent)) ? stub : undefined);
      if (kept !== undefined) ordered.set(k, kept);
    }
    nodes.clear();
    for (const [k, n] of ordered) nodes.set(k, n);
  }
  // The reader's typed values, less those of a dropped node, and those standing on a dropped line: a value over several
  // lines goes when any line it covers went ("4410 Speedway\napt 2, Austin" under a dropped "Password:" opener), judged
  // by the lines where it stands, never by a dropped line's text (G2 round 6: a dropped "Austin" took an address).
  const values: TypedValue[] = w.values.filter((v) => nodes.has(v.nodeKey) && !secretText(v.text) && !valueGoes(lost.get(v.nodeKey) ?? [], v.text));
  // A window that gives everything is read as it is: the same state, so every cache keyed by it (windowValues, the
  // ledger's budgets, descriptor.ts's label index) is shared with code that reads it raw.
  if (nodes.size === w.nodes.size && [...nodes].every(([k, n]) => w.nodes.get(k) === n) && values.length === w.values.length) return w;
  return { ...w, nodes, values };
}
