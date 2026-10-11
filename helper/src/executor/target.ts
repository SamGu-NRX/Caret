import { Disclosure, type ModelText, type ScreenRegistry } from "../privacy/disclosure.ts";
import { redactWindow } from "../fill/redact.ts";
// Finding the element a step names. An exact key wins. Otherwise role and label filter the window;
// one match is used as is. Several matches go to Jev as the executor-step question (deep plan
// section 5): the goal as an end-state sentence, at most 40 candidate elements one line each, asked
// twice with the candidates shuffled and the goal reworded. Code acts only when both asks agree.
import type { Node } from "../protocol.ts";
import { nodeText, type WindowState } from "../model.ts";
import type { AskJev, JevRequest } from "../fill/jev.ts";
import { cut } from "../privacy.ts";
import { shuffled } from "../fill/fill.ts";
import type { Target } from "./schema.ts";

export const MAX_TARGET_CANDIDATES = 40;
/**
 * Lowest agreed confidence for a target choice. Agreement is the main guard. On the fixture's
 * two-way ambiguity (Billing and Shipping fields sharing a label), 78 of 78 questions agreed on the
 * right field, at lower confidences from 0.62 to 0.93
 * (~/.caret-run/evidence/screen/executor/target-calibration/). 0.6 sits just under all of them. No
 * wrong agreed pick was seen, so this data cannot say how confident a wrong pick can be; recheck
 * on real apps with more candidates.
 */
export const TARGET_CUTOFF = 0.6;
const NONE = "none";

export type Resolution =
  | { ok: true; node: Node; how: "key" | "unique" | "jev"; jev: JevTrace | null }
  | { ok: false; reason: string; jev: JevTrace | null };

export interface JevTrace {
  candidates: number;
  asks: [{ key: string | null; confidence: number }, { key: string | null; confidence: number }];
  latencyMs: number;
  costUsd: number;
}

export const norm = (s: string | undefined): string => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Nodes of the window that match the target's role and label, in document order. */
export function matches(w: WindowState, t: Target): Node[] {
  const out: Node[] = [];
  for (const n of w.nodes.values()) {
    if (t.role !== undefined && n.role !== t.role) continue;
    if (t.label !== undefined && norm(n.label) !== norm(t.label)) continue;
    out.push(n);
  }
  return out;
}

/** Resolution without Jev: the exact key, else a unique role and label match. Several matches return them for a Jev question. */
export function resolveLocally(w: WindowState, t: Target): { node: Node; how: "key" | "unique" } | { ambiguous: Node[] } | { missing: string } {
  // An exact target (D2-06) is the element at its key with its role and label, or nothing: no fallback to a match.
  if (t.exact === true) {
    const n = t.key === undefined ? undefined : w.nodes.get(t.key);
    if (n === undefined) return { missing: `no element with key ${t.key ?? "(none)"}` };
    if (n.role !== t.role) return { missing: `the element at ${t.key} is now a ${n.role}, not a ${t.role}` };
    if (t.label !== undefined && norm(n.label) !== norm(t.label)) return { missing: `the element at ${t.key} is now labelled '${n.label ?? ""}', not '${t.label}'` };
    return { node: n, how: "key" };
  }
  if (t.key !== undefined) {
    const n = w.nodes.get(t.key);
    if (n !== undefined) return { node: n, how: "key" };
    if (t.label === undefined && t.role === undefined) return { missing: `no element with key ${t.key}` };
  }
  const m = matches(w, t);
  if (m.length === 1 && m[0] !== undefined) return { node: m[0], how: "unique" };
  if (m.length === 0) return { missing: `no ${t.role ?? "element"}${t.label === undefined ? "" : ` labelled '${t.label}'`} in window '${w.window.title}'` };
  return { ambiguous: m.slice(0, MAX_TARGET_CANDIDATES) };
}

/** The screen text an element's line (mintElement) quotes: its label, value, container and placeholder, each clipped. */
function elementTexts(w: WindowState, n: Node): { label: string | null; value: string | null; inside: string | null; placeholder: string | null } {
  w = redactWindow(w);
  const kept = w.nodes.get(n.key);
  if (kept === undefined) return { label: null, value: null, inside: null, placeholder: null };
  n = kept;
  const v = nodeText(n);
  let inside: string | null = null;
  for (let p = n.parent; p !== null; ) {
    const a = w.nodes.get(p);
    if (a === undefined) break;
    if (a.label !== undefined && a.role !== "AXWebArea") {
      inside = clip(a.label);
      break;
    }
    p = a.parent;
  }
  return {
    label: n.label === undefined ? null : clip(n.label),
    value: n.editable === true && v !== "" ? clip(v) : null,
    inside,
    placeholder: n.placeholder === undefined ? null : clip(n.placeholder),
  };
}

/** A slot value a plan copied from a window, with that window as it is now or as the task found it; undefined when no state of it is known. */
export interface SourcedValue {
  text: string;
  window: WindowState | undefined;
}

/**
 * How much of `value` a sent text shows: all of it, or, when the text was cut (privacy.ts cut) partway
 * through the value, the start of it before the ellipsis, however short. Null when it shows none. B12
 * ignored a start under 3 characters, which a conversation with a budget of one or two then gave
 * uncharged (B13 review).
 */
export function quotedPart(sent: string, value: string): string | null {
  if (value === "") return null;
  if (sent.includes(value)) return value;
  if (!sent.endsWith("…")) return null;
  const kept = sent.slice(0, -1);
  for (let k = Math.min(value.length - 1, kept.length); k >= 1; k--) if (kept.endsWith(value.slice(0, k))) return value.slice(0, k);
  return null;
}

/**
 * The screen text of a target question, minted: the window's title and every candidate element, held to the window's
 * budget (privacy.ts), and the step's goal and target, which the plan wrote (Disclosure.planText), each cut to
 * SNIPPET_CHARS since a plan's values were copied from windows the question does not name. A value the plan says it
 * copied from a window (Plan.sources), and that the cut goal or target quotes, is charged to that window first, as it is
 * now or as the task found it; plan text also pays for any window line it holds. Null when a quoted value's window is
 * unknown, or a quoted value or the candidates do not all fit: the question is then not asked, since leaving one out
 * could leave out the right one.
 */
export function targetSnippets(w: WindowState, screen: ScreenRegistry, goal: string, t: Target, cands: readonly { node: Node }[], sourced: readonly SourcedValue[] = []): TargetText | null {
  w = redactWindow(w);
  const d = new Disclosure(screen);
  const sent = [cut(goal), cut(t.describe)];
  for (const v of sourced) {
    const shown = sent.map((s) => quotedPart(s, v.text)).filter((p): p is string => p !== null);
    if (shown.length === 0) continue;
    // A value whose window is not known cannot be held to that window's budget, so it is not sent.
    if (v.window === undefined || !d.take(v.window, "candidate", shown)) return null;
  }
  const goalText = d.planText(sent[0] as string);
  const what = d.planText(sent[1] as string);
  if (goalText === null || what === null) return null;
  const title = d.descriptor(w, w.window.title);
  if (title === null) return null;
  const elements = new Map<string, ModelText>();
  for (const c of cands) {
    const e = elementTexts(w, c.node);
    if (!d.take(w, "candidate", [e.label, e.value, e.inside, e.placeholder])) return null;
    const m = mintElement(d, w, c.node, e);
    if (m === null) return null;
    elements.set(c.node.key, m);
  }
  return { d, goal: goalText, what, title, elements };
}

/** A target question's text, minted by one Disclosure: the plan's goal and target, the window's title, each element. */
export interface TargetText {
  d: Disclosure;
  goal: ModelText;
  what: ModelText;
  title: ModelText;
  /** Each candidate's line, by node key: its label, role, value, the named container it sits in, and its placeholder. */
  elements: ReadonlyMap<string, ModelText>;
}

/** One candidate element's line, minted from the redacted view: the role in the reader's words, each text as the view shows it. */
function mintElement(d: Disclosure, w: WindowState, n: Node, t: ReturnType<typeof elementTexts>): ModelText | null {
  const facts: ModelText[] = [d.id(n.role.replace(/^AX/, ""))];
  const value = t.value === null ? null : d.candidate(w, t.value);
  const inside = t.inside === null ? null : d.descriptor(w, t.inside);
  const placeholder = t.placeholder === null ? null : d.descriptor(w, t.placeholder);
  const label = t.label === null ? null : d.descriptor(w, t.label);
  if ((t.value !== null && value === null) || (t.inside !== null && inside === null) || (t.placeholder !== null && placeholder === null) || (t.label !== null && label === null)) return null;
  if (n.editable === true) facts.push(value === null ? d.own("empty") : d.t`holds '${value}'`);
  if (inside !== null) facts.push(d.t`inside '${inside}'`);
  if (placeholder !== null) facts.push(d.t`placeholder '${placeholder}'`);
  return d.t`${label === null ? d.own("(no label)") : d.t`'${label}'`} (${d.join(facts, "; ")})`;
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= 60 ? t : `${t.slice(0, 59)}…`;
}

const WORDINGS = [
  (d: Disclosure, goal: ModelText, what: ModelText) => d.t`Goal: ${goal} Which element is ${what}? Choose none if no element is.`,
  (d: Disclosure, goal: ModelText, what: ModelText) => d.t`To reach this end state: ${goal} the executor must act on ${what}. Pick that element, or none if it is not listed.`,
] as const;

export function buildTargetRequest(w: WindowState, text: TargetText, cands: { id: string; node: Node }[], wording: 0 | 1): JevRequest {
  w = redactWindow(w);
  const d = text.d;
  const criteria: Record<string, ModelText> = {};
  for (const c of cands) {
    const e = text.elements.get(c.node.key);
    if (e === undefined) throw new Error(`target question: element ${c.node.key} was not minted`);
    criteria[c.id] = e;
  }
  criteria[NONE] = d.own("None of these elements.");
  return d.seal({
    purpose: "executor.target",
    state: { window: d.t`${d.app(w)} window '${text.title}'`, task: d.own("Choose the element an automated step should act on.") },
    // The goal and target are plan text, which can quote a value copied from any window: each goes out cut to SNIPPET_CHARS.
    questions: { target: { type: "choice", instructions: WORDINGS[wording](d, text.goal, text.what), criteria } },
    ...d.declared(),
  });
}

/** Resolves a target, asking Jev twice when the locator is ambiguous. */
export async function resolveTarget(
  w: WindowState,
  screen: ScreenRegistry,
  t: Target,
  goal: string,
  askJev: AskJev | null,
  rand?: (n: number) => number,
  cutoff = TARGET_CUTOFF,
  sourced: readonly SourcedValue[] = [],
): Promise<Resolution> {
  const local = resolveLocally(w, t);
  if ("node" in local) return { ok: true, node: local.node, how: local.how, jev: null };
  if ("missing" in local) return { ok: false, reason: local.missing, jev: null };
  if (askJev === null) return { ok: false, reason: `${local.ambiguous.length} elements match and Jev is off`, jev: null };

  const first = local.ambiguous.map((node, i) => ({ id: `e${i + 1}`, node }));
  const text = targetSnippets(w, screen, goal, t, first, sourced);
  if (text === null) return { ok: false, reason: `${first.length} elements match, and asking would take more of a window than one question may`, jev: null };
  const second = shuffled(first, rand).map((c, i) => ({ id: `k${i + 1}`, node: c.node }));
  const [r1, r2] = await Promise.all([askJev(buildTargetRequest(w, text, first, 0)), askJev(buildTargetRequest(w, text, second, 1))]);
  const pick = (r: typeof r1, list: typeof first): { key: string | null; confidence: number } => {
    const a = r.answers.target;
    if (a === undefined) throw new Error("Jev returned no answer for the target question");
    if (a.choice === NONE) return { key: null, confidence: a.confidence };
    const c = list.find((x) => x.id === a.choice);
    if (c === undefined) throw new Error(`Jev chose ${a.choice}, which is not a candidate id`);
    return { key: c.node.key, confidence: a.confidence };
  };
  const a1 = pick(r1, first);
  const a2 = pick(r2, second);
  const jev: JevTrace = {
    candidates: first.length,
    asks: [a1, a2],
    latencyMs: Math.max(r1.latencyMs, r2.latencyMs),
    costUsd: r1.costUsd + r2.costUsd,
  };
  if (a1.key === null || a1.key !== a2.key) return { ok: false, reason: `${first.length} elements match and the two asks did not agree on one`, jev };
  const conf = Math.min(a1.confidence, a2.confidence);
  if (conf < cutoff) return { ok: false, reason: `the asks agreed at confidence ${conf.toFixed(2)}, under ${cutoff}`, jev };
  const node = w.nodes.get(a1.key);
  if (node === undefined) return { ok: false, reason: "the chosen element left the window", jev };
  return { ok: true, node, how: "jev", jev };
}
