// I2: an Ask's settled scope, enforced by the write contract (fill/contract.ts) rather than by each path that plans a
// write. Checking scope path by path did not converge: after A3 made Jev choose an Ask's fields, the review of the merge
// found the native planner, then the writer goal, the resumed native plan and a picked person each writing outside it
// (evidence/screen/i2). Every write is minted by checkValues or mintExempt, rechecked by validatePlan or the goal gate
// (goals/lower.ts), and rechecked again by the executor's guard (contract.ts guardFor), so the scope is checked there.
import type { Node } from "../protocol.ts";
import type { WindowState } from "../model.ts";
import type { Owner } from "./contract.ts";
import { describeField, fieldLabelText } from "./descriptor.ts";

/**
 * I2 ruling: one request, one settlement. What the per-field scope question settled for a request, kept so a later step
 * of the same request (the Ask after the direct attach rule fell through) uses it rather than asking again: the Ask's
 * id, the window and the document it was asked on, each field's fingerprint then, and the keys Jev chose or left unclear.
 */
export interface Settled {
  readonly askId: string;
  readonly windowId: string;
  readonly document: string | null;
  readonly seen: Readonly<Record<string, string>>;
  readonly asks: readonly string[];
  readonly unclear: readonly string[];
  /**
   * SCP1: fields Jev chose whose section Caret couldn't tell, when the request named one section (intent-heads.ts
   * sectionVeto): never in `asks`, each the user's, said.
   */
  readonly sectionless?: readonly string[];
  /** SCP1: the one section the request named (intent-heads.ts sectionVeto), held by every later settlement of it; null for none. */
  readonly section?: string | null;
}

/** Which page document a window shows now (the helper's page engine, helper.ts HelperOptions.pageDocument). */
export type DocumentReader = (windowId: string) => string | null;

/**
 * What an Ask settled, once, by the per-field scope question (planner/intent-heads.ts), and never changed after: the only
 * fields it may write, by node key in one window; the page document they were on; how each read when the question was
 * asked (fieldFingerprint); and the person the user picked, when they picked one, whose details alone may go in.
 * Anything that would change a scope is a new settle, for a new document or a new Ask (I2 lead ruling B).
 */
export interface AskScope {
  /**
   * I2 ruling: the Ask this scope is of, unique per Ask (planner/ask.ts). Authority identifies the request: a value
   * minted for one Ask ("use my work email") is not another's ("use my personal email"), however alike their fields.
   * A goal's later scopes (a carry, a reply window) keep their Ask's id.
   */
  readonly askId: string;
  readonly windowId: string;
  /**
   * The page document the question was asked on, read before any planning awaited (ask.ts) and kept in a continued
   * Ask's record; null for a native window or with no page engine. A page's element keys repeat across documents (P3's
   * next page had the same Full name key), so a key alone is no field. Plain data: a goal plan is cloned when offered.
   */
  readonly document: string | null;
  readonly fields: ReadonlySet<string>;
  /** By node key, each field's fingerprint when the question was asked (a continued Ask's first question's record). */
  readonly seen: Readonly<Record<string, string>>;
  /** The person the user picked; null when they picked none, or picked themselves. */
  readonly person: string | null;
  /**
   * The fields in `fields` that are there by the user's own pick in the Ask's question (a field Jev offered but did not
   * choose: "asks" below the cutoff, or in one wording only): user-authorized, recorded apart from Jev's choices.
   */
  readonly picked: ReadonlySet<string>;
  /**
   * SCP1: the one section of the form the Ask's request named, as its section question settled it (intent-heads.ts
   * sectionVeto), or null when it named none. Every later settlement of the same Ask holds to it (a next page, a reply
   * window), so no later section answer widens the Ask.
   */
  readonly section: string | null;
}

export function askScope(windowId: string, document: string | null, keys: Iterable<string>, seen: Readonly<Record<string, string>>, person: string | null, askId: string, picked: Iterable<string> = [], section: string | null = null): AskScope {
  const fields = new Set(keys);
  const own: Record<string, string> = {};
  for (const k of fields) {
    const s = seen[k];
    // A field with no record cannot be compared later, so it is no field of the scope: said, never assumed.
    if (s === undefined) throw new Error(`the Ask's scope names field ${k}, which its record of the form lacks`);
    own[k] = s;
  }
  const byUser = new Set([...picked].filter((k) => fields.has(k)));
  return Object.freeze({ askId, windowId, document, fields, seen: Object.freeze(own), person, picked: byUser, section });
}

/**
 * I2 lead ruling C: a goal's scopes, one per window and document it writes in, settled once each and kept across its
 * replans. A replan reuses them; a field that changed since is refused, never settled again. `ask` is false for a goal
 * no Ask made, which no scope holds.
 */
export interface ScopeSet {
  readonly ask: boolean;
  /** The Ask the goal is of (AskScope.askId): every scope settled for it carries this id. */
  readonly askId: string;
  readonly person: string | null;
  /** SCP1: the one section the Ask's request named (AskScope.section), which every scope settled for it holds to; null for none. */
  readonly section: string | null;
  readonly scopes: Readonly<Record<string, AskScope>>;
}
export const scopeKey = (windowId: string, document: string | null): string => `${windowId}\n${document ?? ""}`;
export function scopeSet(askId: string, person: string | null, scopes: readonly AskScope[] = [], section: string | null = null): ScopeSet {
  if (scopes.some((x) => x.askId !== askId)) throw new Error("a goal's scopes are all of its one Ask");
  if (scopes.some((x) => x.section !== section)) throw new Error("a goal's scopes all hold to the one section its Ask named");
  return Object.freeze({ ask: true, askId, person, section, scopes: Object.freeze(Object.fromEntries(scopes.map((x) => [scopeKey(x.windowId, x.document), x]))) });
}
/** The set with `x` added; a window and document it already holds keeps its first scope. */
export function withScope(set: ScopeSet, x: AskScope): ScopeSet {
  if (x.askId !== set.askId) throw new Error(`a scope of Ask ${x.askId} cannot join the goal of Ask ${set.askId}`);
  if (x.section !== set.section) throw new Error(`a scope held to section ${JSON.stringify(x.section)} cannot join a goal held to ${JSON.stringify(set.section)}`);
  const k = scopeKey(x.windowId, x.document);
  return set.scopes[k] !== undefined ? set : Object.freeze({ ...set, scopes: Object.freeze({ ...set.scopes, [k]: x }) });
}

/** A heading node's text: its label, else its first static text child's. */
function headingText(nodes: readonly Node[], h: Node): string | null {
  const own = fieldLabelText(h.label);
  if (own !== null) return own;
  const child = nodes.find((n) => n.parent === h.key && n.role === "AXStaticText");
  return fieldLabelText(child?.label ?? child?.value);
}

/** Each node's nearest heading before it in document order (the reader sends nodes in that order), by node key. */
export function headingsBefore(w: WindowState): Map<string, string | null> {
  const nodes = [...w.nodes.values()];
  const out = new Map<string, string | null>();
  let current: string | null = null;
  for (const n of nodes) {
    if (n.role === "AXHeading") current = headingText(nodes, n);
    else out.set(n.key, current);
  }
  return out;
}

/** How the section veto compares section names: case, Unicode width and runs of whitespace aside. */
export const sectionName = (s: string): string => s.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();

/**
 * SCP1: the section names a window shows, in document order, each once (`repeated` holds, by sectionName, those shown
 * more than once): its AXHeading nodes' text, and on a page each frame's heading list (PageFrame.headings, carried on
 * its web area node). These are the only sections an Ask's section question offers (intent-heads.ts).
 */
export function observedSections(w: WindowState): { names: string[]; repeated: Set<string> } {
  const nodes = [...w.nodes.values()];
  const all: string[] = [];
  for (const n of nodes) {
    if (n.role === "AXHeading") {
      const t = headingText(nodes, n);
      if (t !== null) all.push(t);
    }
    for (const h of n.headings ?? []) if (h.trim() !== "") all.push(h.trim());
  }
  const names: string[] = [];
  const repeated = new Set<string>();
  const seen = new Set<string>();
  for (const t of all) {
    const k = sectionName(t);
    if (seen.has(k)) {
      repeated.add(k);
      continue;
    }
    seen.add(k);
    names.push(t);
  }
  return { names, repeated };
}

/**
 * SCP1: what the window shows of which section each field is in, by node key: the nearest heading before it in
 * document order and its group or fieldset label (describeField's section). A page's frame heading list says nothing
 * about which control is under which heading, so on a page this is only a radio group's question.
 */
export function sectionEvidence(w: WindowState): (key: string) => string[] {
  const before = headingsBefore(w);
  return (key) => {
    const n = w.nodes.get(key);
    if (n === undefined) return [];
    return [before.get(key) ?? null, describeField(w, n).section].filter((x): x is string => x !== null && x.trim() !== "");
  };
}

/**
 * SCP1: whether a field is in section `section`, by what the window shows (sectionEvidence), against the sections it
 * shows (observedSections). Only evidence that names one of those sections counts: a group labelled "Address" says
 * nothing about which heading it sits under. "in": the evidence names `section` and no other shown section; "outside":
 * it names another shown section and not `section`; "unknown": it names none, names `section` beside another (they
 * conflict), or `section` is shown more than once, so which one is meant cannot be told.
 */
export type Membership = "in" | "outside" | "unknown";
export function membership(evidence: readonly string[], section: string, shown: { names: readonly string[]; repeated: ReadonlySet<string> }): Membership {
  const target = sectionName(section);
  const names = new Set(shown.names.map(sectionName));
  const named = new Set(evidence.map(sectionName).filter((x) => names.has(x)));
  if (named.size === 0) return "unknown";
  if (!named.has(target)) return "outside";
  if (named.size > 1 || shown.repeated.has(target)) return "unknown";
  return "in";
}

/**
 * What a field is, as a continued Ask and the Ask's scope compare it: what fill reads of it (its label, nearest text,
 * placeholder, group and heading, role and subrole), the page's input kind, autocomplete name and maxlength, its exact
 * value and states, and each child's role, label, value
 * and states (a select's options, a radio group's buttons). Focus is left out: the executor focuses a field to write it,
 * and the user moves focus between the question and the answer. "gone" for a field the window no longer has.
 */
export function fieldFingerprint(w: WindowState, key: string): string {
  const n = w.nodes.get(key);
  if (n === undefined) return "gone";
  const d = describeField(w, n);
  const states = (s: Node["states"]): string[] => (s ?? []).filter((x) => x !== "focused");
  const children = [...w.nodes.values()].filter((c) => c.parent === key).map((c) => [c.role, c.label ?? null, c.value ?? null, states(c.states)]);
  // The page's own input kind, autocomplete name and maxlength too (re-review): a field that now asks for a phone where it
  // asked for an email is not the field the Ask was about.
  return JSON.stringify([d.label, d.nearest, d.placeholder, d.section, headingsBefore(w).get(key) ?? null, n.role, n.subrole ?? null, n.inputKind ?? null, n.autocomplete ?? null, n.maxLength ?? null, n.value ?? "", states(n.states), children]);
}

/** What the scope check needs of a write: its target and fingerprint (FieldContract), and whose value it is. */
export interface ScopedWrite {
  readonly field: { readonly windowId: string; readonly key: string; readonly name: string; readonly fingerprint: string | null };
  readonly owner: Owner;
}

/**
 * Why `x` may not be written under `scope`, or null: its field is not one the Ask settled, the page is another document
 * than the one asked about (read through `documentOf`, the owning helper's reader; with none, a scope on a page refuses),
 * the field no longer reads as it did when the question was asked, or the user picked a person and the value is not
 * that person's. Null with no scope.
 */
export function scopeRefusal(x: ScopedWrite, scope: AskScope | undefined, documentOf: DocumentReader | null = null): string | null {
  if (scope === undefined) return null;
  const f = x.field;
  if (f.windowId !== scope.windowId || !scope.fields.has(f.key)) return `your request didn't ask Caret to fill '${f.name}'`;
  const doc = documentOf === null ? null : documentOf(f.windowId);
  if (documentOf === null ? scope.document !== null : doc !== scope.document) return `the page is no longer the one Caret asked about '${f.name}' on`;
  if (f.fingerprint === null) return `Caret has no record of how '${f.name}' read, so it can't tell the field is the one the Ask was about`;
  if (f.fingerprint !== scope.seen[f.key]) return `'${f.name}' changed since Caret asked about it`;
  if (scope.person !== null && x.owner !== "person") return `the value for '${f.name}' is not ${scope.person}'s, whom you picked`;
  return null;
}

/**
 * I2 lead ruling (re-review of ec4e4bb): who authorized a mint, explicit on every mint and never absent. Before it, a mint
 * with no scope read as "outside an Ask", so an unscoped mint passed validation and the guard. One kind per accepted path:
 *   - ask: an Ask, held to the scope its per-field question settled (every route an Ask plans, goals included);
 *   - fill: a fill proposal whose rows the user accepted (the popup, Fill all, first look), by its id;
 *   - goal: a goal a host requested directly, not an Ask, by its id;
 *   - plan: a plan request planned without an Ask (the native planner, the code-mode writer), by its offer key;
 *   - pattern: a pattern offer's transfer of what the user did, by its pattern.
 */
export type Authority =
  | { readonly kind: "ask"; readonly scope: AskScope }
  | { readonly kind: "fill"; readonly proposalId: string }
  | { readonly kind: "goal"; readonly goalId: string }
  | { readonly kind: "plan"; readonly offerKey: string }
  | { readonly kind: "pattern"; readonly patternId: string };

/**
 * What a plan's mints must carry, by where the plan started: one authority, or an Ask's goal, whose mints are each the
 * Ask's for the window they write in (its ScopeSet).
 */
export type Origin = Authority | { readonly kind: "askGoal"; readonly scopes: ScopeSet };

/** Whether two scopes are the same settled scope, by content: a goal plan is cloned when it is offered. */
export function sameScope(a: AskScope, b: AskScope): boolean {
  if (a === b) return true;
  if (a.askId !== b.askId || a.windowId !== b.windowId || a.document !== b.document || a.person !== b.person || a.section !== b.section || a.fields.size !== b.fields.size || a.picked.size !== b.picked.size) return false;
  for (const k of a.picked) if (!b.picked.has(k)) return false;
  for (const k of a.fields) if (!b.fields.has(k) || a.seen[k] !== b.seen[k]) return false;
  return true;
}

/** Why a mint's authority is not the plan's origin, or null: refused loudly at validation, the goal gate and the guard. */
export function authorityRefusal(a: Authority, origin: Origin): string | null {
  if (origin.kind === "askGoal") {
    if (a.kind !== "ask") return `the value was checked for a ${a.kind}, and this plan started from an Ask`;
    const held = origin.scopes.scopes[scopeKey(a.scope.windowId, a.scope.document)];
    return held !== undefined && sameScope(held, a.scope) ? null : "the value was checked under a scope this Ask's goal does not hold";
  }
  if (a.kind !== origin.kind) return `the value was checked for a ${a.kind}, and this plan started from ${origin.kind === "ask" ? "an Ask" : `a ${origin.kind}`}`;
  switch (origin.kind) {
    case "ask":
      return sameScope((a as Extract<Authority, { kind: "ask" }>).scope, origin.scope) ? null : "the value was checked under another Ask's scope";
    case "fill":
      return (a as Extract<Authority, { kind: "fill" }>).proposalId === origin.proposalId ? null : "the value was checked for another fill";
    case "goal":
      return (a as Extract<Authority, { kind: "goal" }>).goalId === origin.goalId ? null : "the value was checked for another goal";
    case "plan":
      return (a as Extract<Authority, { kind: "plan" }>).offerKey === origin.offerKey ? null : "the value was checked for another plan";
    case "pattern":
      return (a as Extract<Authority, { kind: "pattern" }>).patternId === origin.patternId ? null : "the value was checked for another pattern";
  }
}
