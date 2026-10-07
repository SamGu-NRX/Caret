// G2 round 4: the one place that decides what of a source window fill may read. The candidate generator (candidates.ts:
// its passes, rankWindow, leftOut, windowValues, labelledLines) and fill's anchor read a window only through
// redactWindow, so no extraction path has a secret filter of its own and none can miss one. Per-path filters did not
// converge: each round of review found another path (a field's label, its nearest label, a block head, a cell) or
// another format (a marker after the label, "pin#", a quoted value). The rule is the marker word (memory/sensitive.ts
// markerWord) or a value Caret never types (valueKind); a request that still carries either is refused before it is
// sent (privacy.ts assertNoSecrets).
//
// What the view drops:
//   - every line that holds a marker word or such a value, anywhere in it, whatever follows; a line that ends in its
//     marker or a colon ("Password:", "PIN") takes the next line with it, which can hold its value;
//   - every node whose own label, placeholder or nearest label (descriptor.ts nearestLabel, no shape filter) holds a
//     marker word, value and all, whatever its role, and the node of that nearest label;
//   - every typed value of a dropped node or line;
//   - the whole window when its title holds a marker word: every candidate quotes its window's title.
// Cost on the corpora (fixtures/realfill/sources and F1's task notes, mails and memory: 276 non-blank lines,
// test/g2-ownership.test.ts "the redacted view's cost"; W4's note, 15 lines, outside the repository): 1 line, Ashby's
// "Incident question: use the token-leak story, write it fresh.", whose key is none: 0 right values lost.
import type { WindowState } from "../model.ts";
import type { Node, TypedValue } from "../protocol.ts";
import { markerEnds, secretText } from "../memory/sensitive.ts";
import { nodesLabelledBy } from "./descriptor.ts";

export { secretText };

/** A line that ends in a colon or a marker phrase ("Password:", "my private key", "PIN is"): its value may be on the next. */
function opensValue(line: string): boolean {
  return line.trim().endsWith(":") || markerEnds(line);
}

/**
 * A text less the lines it must not give (secretText, and a line a marked opener above it opens), and the indexes of the
 * lines it dropped; the text unchanged when it gives all.
 */
function keptText(text: string): { kept: string; dropped: Set<number> } {
  if (!text.split(/\r?\n/u).some((l) => secretText(l))) return { kept: text, dropped: new Set() };
  const parts = text.split(/(\r?\n)/u);
  const out: string[] = [];
  const dropped = new Set<number>();
  for (let i = 0; i < parts.length; i += 2) {
    const l = parts[i] as string;
    if (!secretText(l)) {
      out.push(l, parts[i + 1] ?? "");
      continue;
    }
    dropped.add(i / 2);
    // G2 round 5: an opener takes the next line, and a line it takes opens in turn ("Password:" then "PIN:" then
    // "violet-orchard-seven"): each value-opening line drops the one after it.
    for (let open = opensValue(l); open && i + 2 < parts.length; ) {
      i += 2;
      dropped.add(i / 2);
      open = opensValue(parts[i] as string);
    }
  }
  return { kept: out.join("").replace(/\r?\n$/u, ""), dropped };
}

/** Whether a place where `value` stands in `text` covers one of the line indexes `dropped` (G2 round 6: by line, not text). */
function coversDropped(text: string, value: string, dropped: ReadonlySet<number>): boolean {
  if (dropped.size === 0 || value === "") return false;
  for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) {
    const first = text.slice(0, at).split(/\r?\n/u).length - 1;
    const last = first + value.split(/\r?\n/u).length - 1;
    for (let i = first; i <= last; i++) if (dropped.has(i)) return true;
  }
  return false;
}

/**
 * Built once per window state. Its cost (scripts/generator-bench.ts, 20 focuses a scene, evidence/screen/g2/whose/
 * genbench-*): generator p50 0.9-3.7 ms against 0ea0077's 0.8-2.1, and 1 focus of 20 over GENERATOR_BUDGET_MS on the
 * 5,500-span scene with every window new (0ea0077: 0); a focus over budget withholds, it never guesses. The marker
 * check is indexed by first word and memoized by text (memory/sensitive.ts) to get there.
 */
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

function build(w: WindowState): WindowState {
  if (secretText(w.window.title)) return { ...w, nodes: new Map(), values: [] };
  const dropped = nodesLabelledBy(w, secretText);
  const nodes = new Map<string, Node>();
  /** Each kept node's texts, with the lines each lost, which no typed value of it may stand on. */
  const lost = new Map<string, { text: string; dropped: Set<number> }[]>();
  for (const n of w.nodes.values()) {
    // A field's own label or placeholder that names a secret takes the field and its value; any other node's label is
    // its content, redacted line by line below (G2 round 6).
    if (dropped.has(n.key) || (n.editable === true && (secretText(n.label) || secretText(n.placeholder)))) continue;
    // The node with its texts' secret lines gone. A node that gives no text, and had some, is gone with them.
    const v = n.value === undefined ? undefined : keptText(n.value);
    const l = n.label === undefined ? undefined : keptText(n.label);
    const value = v?.kept;
    const label = l?.kept;
    const gone = [...(v === undefined || n.value === undefined ? [] : [{ text: n.value, dropped: v.dropped }]), ...(l === undefined || n.label === undefined ? [] : [{ text: n.label, dropped: l.dropped }])].filter((x) => x.dropped.size > 0);
    if (gone.length > 0) lost.set(n.key, gone);
    const had = (n.value ?? "") !== "" || (n.label ?? "") !== "";
    if (had && (value ?? "") === "" && (label ?? "") === "" && n.editable !== true) continue;
    if (value === n.value && label === n.label) nodes.set(n.key, n);
    else {
      const m: Node = { ...n };
      if (value === undefined) delete m.value;
      else m.value = value;
      if (label === undefined) delete m.label;
      else m.label = label;
      nodes.set(n.key, m);
    }
  }
  // The reader's typed values, less those of a dropped node, and those standing on a dropped line: a value over several
  // lines goes when any line it covers went ("4410 Speedway\napt 2, Austin" under a dropped "Password:" opener), judged
  // by the lines where it stands, never by a dropped line's text (G2 round 6: a dropped "Austin" took an address).
  const values: TypedValue[] = w.values.filter((v) => nodes.has(v.nodeKey) && !secretText(v.text) && !(lost.get(v.nodeKey) ?? []).some((x) => coversDropped(x.text, v.text, x.dropped)));
  // A window that gives everything is read as it is: the same state, so every cache keyed by it (windowValues, the
  // ledger's budgets, descriptor.ts's label index) is shared with code that reads it raw.
  if (nodes.size === w.nodes.size && [...nodes].every(([k, n]) => w.nodes.get(k) === n) && values.length === w.values.length) return w;
  return { ...w, nodes, values };
}
