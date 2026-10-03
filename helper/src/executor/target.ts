// Finding the element a step names. An exact key wins. Otherwise role and label filter the window;
// one match is used as is. Several matches go to Jev as the executor-step question (deep plan
// section 5): the goal as an end-state sentence, at most 40 candidate elements one line each, asked
// twice with the candidates shuffled and the goal reworded. Code acts only when both asks agree.
import type { Node } from "../protocol.ts";
import { nodeText, type WindowState } from "../model.ts";
import type { AskJev, JevRequest } from "../fill/jev.ts";
import { SnippetLedger, type Snippet } from "../privacy.ts";
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

/** The screen text describeElement quotes for an element: its label, value, container and placeholder, each clipped. */
function elementTexts(w: WindowState, n: Node): { label: string | null; value: string | null; inside: string | null; placeholder: string | null } {
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

/** One line per candidate element: label, role, value, the named container it sits in, and the nearest text. */
export function describeElement(w: WindowState, n: Node): string {
  const t = elementTexts(w, n);
  const facts: string[] = [n.role.replace(/^AX/, "")];
  if (n.editable === true) facts.push(t.value === null ? "empty" : `holds '${t.value}'`);
  if (t.inside !== null) facts.push(`inside '${t.inside}'`);
  if (t.placeholder !== null) facts.push(`placeholder '${t.placeholder}'`);
  return `${t.label === null ? "(no label)" : `'${t.label}'`} (${facts.join("; ")})`;
}

/**
 * The screen text of a target question: the window's title and every candidate element, held to the
 * window's budget (privacy.ts), and the step's goal and target, which the plan wrote (SnippetLedger.plan). Null
 * when the candidates do not all fit: the question is then not asked, since leaving one out could leave
 * out the right one.
 */
export function targetSnippets(w: WindowState, goal: string, t: Target, cands: readonly { node: Node }[]): Snippet[] | null {
  const ledger = new SnippetLedger();
  ledger.plan([goal, t.describe]);
  if (!ledger.take(w, "descriptor", [w.window.title])) return null;
  for (const c of cands) {
    const e = elementTexts(w, c.node);
    if (!ledger.take(w, "candidate", [e.label, e.value, e.inside, e.placeholder])) return null;
  }
  return ledger.snippets;
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= 60 ? t : `${t.slice(0, 59)}…`;
}

const WORDINGS = [
  (goal: string, what: string) => `Goal: ${goal} Which element is ${what}? Choose none if no element is.`,
  (goal: string, what: string) => `To reach this end state: ${goal} the executor must act on ${what}. Pick that element, or none if it is not listed.`,
] as const;

export function buildTargetRequest(w: WindowState, goal: string, t: Target, cands: { id: string; node: Node }[], wording: 0 | 1, snippets: readonly Snippet[] = []): JevRequest {
  const criteria: Record<string, string> = {};
  for (const c of cands) criteria[c.id] = describeElement(w, c.node);
  criteria[NONE] = "None of these elements.";
  return {
    state: { window: `${w.app.name} window '${w.window.title}'`, task: "Choose the element an automated step should act on." },
    questions: { target: { type: "choice", instructions: WORDINGS[wording](goal, t.describe), criteria } },
    snippets,
  };
}

/** Resolves a target, asking Jev twice when the locator is ambiguous. */
export async function resolveTarget(
  w: WindowState,
  t: Target,
  goal: string,
  askJev: AskJev | null,
  rand?: (n: number) => number,
  cutoff = TARGET_CUTOFF,
): Promise<Resolution> {
  const local = resolveLocally(w, t);
  if ("node" in local) return { ok: true, node: local.node, how: local.how, jev: null };
  if ("missing" in local) return { ok: false, reason: local.missing, jev: null };
  if (askJev === null) return { ok: false, reason: `${local.ambiguous.length} elements match and Jev is off`, jev: null };

  const first = local.ambiguous.map((node, i) => ({ id: `e${i + 1}`, node }));
  const snippets = targetSnippets(w, goal, t, first);
  if (snippets === null) return { ok: false, reason: `${first.length} elements match, more than one question may describe from this window`, jev: null };
  const second = shuffled(first, rand).map((c, i) => ({ id: `k${i + 1}`, node: c.node }));
  const [r1, r2] = await Promise.all([askJev(buildTargetRequest(w, goal, t, first, 0, snippets)), askJev(buildTargetRequest(w, goal, t, second, 1, snippets))]);
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
