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
function keptText(text: string): { kept: string; dropped: Set<number> } {
  const lines = text.split(/\r?\n/u);
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
  if (!secret.some((x) => x)) return { kept: text, dropped: new Set() };
  const dropped = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!secret[i]) continue;
    dropped.add(i);
    // The opener reads the line as a whole, a marker that ran across from the line above included.
    let open = opensValue(lines[i] as string) || (i > 0 && secret[i - 1] === true && !PEM_END.test(lines[i] as string) && opensValue(`${lines[i - 1]} ${lines[i]}`));
    let j = i;
    while (open && j + 1 < lines.length) {
      j++;
      dropped.add(j);
      if ((lines[j] as string).trim() === "") continue;
      open = opensValue(lines[j] as string);
    }
    i = Math.max(i, j);
  }
  const parts = text.split(/(\r?\n)/u);
  const out: string[] = [];
  for (let k = 0; k < parts.length; k += 2) if (!dropped.has(k / 2)) out.push(parts[k] as string, parts[k + 1] ?? "");
  return { kept: out.join("").replace(/\r?\n$/u, ""), dropped };
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

function build(w: WindowState): WindowState {
  if (secretText(w.window.title)) return { ...w, nodes: new Map(), values: [] };
  const dropped = nodesLabelledBy(w, secretText);
  const nodes = new Map<string, Node>();
  /** Each kept node's texts, with the lines each lost, which no typed value of it may stand on. */
  const lost = new Map<string, { text: string; dropped: Set<number> }[]>();
  /** Nodes left out, so their descendants are too: a container labelled for a secret holds what it labels. */
  const gone = new Set<string>();
  for (const n of w.nodes.values()) {
    // A node's own label or placeholder, as attributes, that names a secret takes the node and its value, whatever its
    // role (G2 round 6 review: a cell labelled "Password" holding an email). A static text whose only text is its label
    // has that label as its content, redacted line by line below, as any document's.
    // A text's label is its content; a container's (a group, a list) is its name, an attribute (G2 round 7 review).
    const labelIsContent = n.editable !== true && n.value === undefined && TEXT_ROLES.has(n.role);
    if ((n.parent !== null && gone.has(n.parent)) || dropped.has(n.key) || secretText(n.placeholder) || (!labelIsContent && secretText(n.label))) {
      gone.add(n.key);
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
  const values: TypedValue[] = w.values.filter((v) => nodes.has(v.nodeKey) && !secretText(v.text) && !valueGoes(lost.get(v.nodeKey) ?? [], v.text));
  // A window that gives everything is read as it is: the same state, so every cache keyed by it (windowValues, the
  // ledger's budgets, descriptor.ts's label index) is shared with code that reads it raw.
  if (nodes.size === w.nodes.size && [...nodes].every(([k, n]) => w.nodes.get(k) === n) && values.length === w.values.length) return w;
  return { ...w, nodes, values };
}
