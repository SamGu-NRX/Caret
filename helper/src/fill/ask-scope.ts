// I2: an Ask's settled scope, enforced by the write contract (fill/contract.ts) rather than by each path that plans a
// write. Checking scope path by path did not converge: after A3 made Jev choose an Ask's fields, the review of the merge
// found the native planner, then the writer goal, the resumed native plan and a picked person each writing outside it
// (evidence/screen/i2). Every write is minted by checkValues or mintExempt, rechecked by validatePlan or the goal gate
// (goals/lower.ts), and rechecked again by the executor's guard (contract.ts guardFor), so the scope is checked there.
import type { Node } from "../protocol.ts";
import type { WindowState } from "../model.ts";
import type { Owner } from "./contract.ts";
import { describeField, fieldLabelText } from "./descriptor.ts";
import { redactWindow, SECTION_BOUNDARY_ROLES } from "./redact.ts";
import { sectionName } from "../engines/page-exclusions.ts";

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
  /** SCP1: the request named a section the question's list lacked: every field is withheld, said as SAYS.sectionNotFound. */
  readonly notFound?: boolean;
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

export { sectionName } from "../engines/page-exclusions.ts";

/**
 * SCP1: one section-defining element a window shows, by a key unique in the window: a heading, or a labelled group
 * (a fieldset's legend, a labelled region). Its text is null when an exclusion or redaction took it; it still bounds the
 * section before it.
 */
export interface SectionOccurrence {
  readonly key: string;
  readonly heading: boolean;
  readonly text: string | null;
  /** A page walk's flag: an excluded occurrence has this name too, so the name is two sections (PageFrame.sections). */
  readonly sharesExcludedName?: true;
}

/**
 * SCP1: a window's sections as occurrences, and which of them contain each field. `chainOf` gives a field's occurrence
 * keys, outermost first, or "unknown" when the window can't say (a page walk from an extension before SCP1, or a field
 * after a group that closed on the heading before it). `fallback` is the heading text a window shows with no
 * occurrence (such a page's frame heading list): offered as sections, never a field's.
 */
export interface WindowOutline {
  readonly occurrences: readonly SectionOccurrence[];
  chainOf(key: string): readonly string[] | "unknown";
  readonly fallback: readonly string[];
}

/** Roles that group what they hold on the Accessibility path: a heading in one ends with it. */
const AX_CONTAINERS = SECTION_BOUNDARY_ROLES;

const outlines = new WeakMap<WindowState, WindowOutline>();

/**
 * SCP1: the window's outline, once per window state. A page walk's (Node.outline on its web areas, Node.sections on its
 * controls) as the walk found it (extension content/sections.ts); otherwise read from the Accessibility tree in
 * document order:
 *   - each AXHeading is an occurrence, and each group (AX_CONTAINERS) below the web area with a label is one;
 *   - a heading's scope is its nearest group, from the heading to the next heading in that group, or the group's end;
 *     the tree gives no heading levels, so a heading in an inner group replaces every heading it inherits;
 *   - a field after a group that closed on the heading before it is "unknown": a heading met in a group that ended
 *     tells nothing of the fields after it, and the heading before that one may not be theirs either.
 */
export function windowOutline(w: WindowState): WindowOutline {
  const hit = outlines.get(w);
  if (hit !== undefined) return hit;
  const nodes = [...w.nodes.values()];
  const areas = nodes.filter((n) => n.role === "AXWebArea");
  let o: WindowOutline;
  if (areas.some((a) => a.outline !== undefined)) {
    const occurrences = areas.flatMap((a) => (a.outline ?? []).map((x) => ({ key: x.key, heading: x.heading, text: x.text ?? null, ...(x.sharesExcludedName === true ? { sharesExcludedName: true as const } : {}) })));
    o = { occurrences, chainOf: (key) => w.nodes.get(key)?.sections ?? [], fallback: [] };
  } else if (areas.some((a) => a.headings !== undefined)) {
    o = { occurrences: [], chainOf: () => "unknown", fallback: areas.flatMap((a) => a.headings ?? []) };
  } else o = axOutline(w, nodes);
  outlines.set(w, o);
  return o;
}

function axOutline(w: WindowState, nodes: readonly Node[]): WindowOutline {
  const occurrences: SectionOccurrence[] = [];
  const chains = new Map<string, readonly string[] | "unknown">();
  /** A node's groups, outermost first, up to and including its web area: what bounds a heading's scope. */
  const groupsOf = (n: Node): Node[] => {
    const out: Node[] = [];
    for (let key = n.parent; key !== null; ) {
      const p = w.nodes.get(key);
      if (p === undefined) break;
      if (AX_CONTAINERS.has(p.role)) out.unshift(p);
      if (p.role === "AXWebArea") break;
      key = p.parent;
    }
    return out;
  };
  type Frame = { key: string; label: string | null; heading: string | null };
  // The window itself is the outermost frame, never closed.
  const stack: Frame[] = [{ key: "", label: null, heading: null }];
  /** The frame the latest heading was met in, and whether that frame has closed since. */
  let latest: Frame | null = null;
  let stale = false;
  for (const n of nodes) {
    const groups = groupsOf(n);
    let keep = 0;
    while (keep < stack.length - 1 && keep < groups.length && stack[keep + 1]?.key === groups[keep]?.key) keep++;
    while (stack.length > keep + 1) if (stack.pop() === latest) stale = true;
    for (const g of groups.slice(keep)) {
      const t = g.role === "AXWebArea" ? null : fieldLabelText(g.label);
      if (t !== null) occurrences.push({ key: g.key, heading: false, text: t });
      stack.push({ key: g.key, label: t === null ? null : g.key, heading: null });
    }
    if (n.role === "AXHeading") {
      occurrences.push({ key: n.key, heading: true, text: headingText(nodes, n) });
      const top = stack.at(-1) as Frame;
      top.heading = n.key;
      latest = top;
      stale = false;
      continue;
    }
    if (stale) {
      chains.set(n.key, "unknown");
      continue;
    }
    // The innermost heading only: with no levels, a heading in an inner group replaces the ones it inherits.
    const inner = [...stack].reverse().find((f) => f.heading !== null)?.heading ?? null;
    chains.set(n.key, [...stack.flatMap((f) => (f.label === null ? [] : [f.label])), ...(inner === null ? [] : [inner])]);
  }
  return { occurrences, chainOf: (key) => chains.get(key) ?? [], fallback: [] };
}

/**
 * SCP1: the section texts a window offers, each once: every occurrence that can be a section (a heading, a fieldset's
 * legend, a labelled group or region), else its fallback heading list. Those containing one of `fields` come first, in
 * document order, then the rest: a list cut to a limit then drops sections no field is in before any a field is in,
 * and drops nothing silently (the question says when it is cut).
 */
export function shownSections(o: WindowOutline, fields: readonly string[] = []): string[] {
  const texts = o.occurrences.length > 0 ? o.occurrences.flatMap((x) => (x.text !== null ? [x.text] : [])) : [...o.fallback];
  const placed = new Set<string>();
  for (const k of fields) {
    const chain = o.chainOf(k);
    if (chain === "unknown") continue;
    for (const c of chain) {
      const t = o.occurrences.find((x) => x.key === c)?.text ?? null;
      if (t !== null) placed.add(sectionName(t));
    }
  }
  const out: string[] = [];
  for (const t of texts) if (!out.some((x) => sectionName(x) === sectionName(t))) out.push(t);
  return [...out.filter((t) => placed.has(sectionName(t))), ...out.filter((t) => !placed.has(sectionName(t)))];
}

/** SCP1: the text of the innermost heading in a field's chain, or null: the heading a page field is shown under. */
export function chainHeading(o: WindowOutline, key: string): string | null {
  const chain = o.chainOf(key);
  if (chain === "unknown") return null;
  const byKey = new Map(o.occurrences.map((x) => [x.key, x]));
  for (let i = chain.length - 1; i >= 0; i--) {
    const x = byKey.get(chain[i] as string);
    if (x?.heading === true) return x.text;
  }
  return null;
}

/**
 * SCP1: whether a field is in the section a request named by heading text. The text must name exactly one occurrence
 * the window shows; naming none or several, no field can be placed ("unknown" for every field). Otherwise a field is
 * "in" when that occurrence contains it; "outside" when the window places it in other sections only; "unknown" when the
 * window can't say or places it in none.
 */
export type Membership = "in" | "outside" | "unknown";
export function sectionMembership(o: WindowOutline, section: string): (key: string) => Membership {
  const named = o.occurrences.filter((x) => x.text !== null && sectionName(x.text) === sectionName(section));
  if (named.length !== 1) return () => "unknown";
  const target = (named[0] as SectionOccurrence).key;
  return (key) => {
    const chain = o.chainOf(key);
    if (chain === "unknown" || chain.length === 0) return "unknown";
    return chain.includes(target) ? "in" : "outside";
  };
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
  // SCP1: the sections the field sits in, by their text, so a field moved to another section is another field.
  const outline = windowOutline(w);
  const chain = outline.chainOf(key);
  const sections = chain === "unknown" ? chain : chain.map((k) => outline.occurrences.find((x) => x.key === k)?.text ?? null);
  return JSON.stringify([d.label, d.nearest, d.placeholder, d.section, headingsBefore(w).get(key) ?? null, sections, n.role, n.subrole ?? null, n.inputKind ?? null, n.autocomplete ?? null, n.maxLength ?? null, n.value ?? "", states(n.states), children]);
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
 *
 * SCP1: with `window`, the window as it reads now, an Ask that named one section also needs the field still in it:
 * the fingerprint records section text, not which occurrence, so a page that now shows the section twice, no longer
 * shows it, or moved the field out of it would pass the fingerprint alone (re-review of 9939ac2).
 */
export function scopeRefusal(x: ScopedWrite, scope: AskScope | undefined, documentOf: DocumentReader | null = null, window?: WindowState): string | null {
  if (scope === undefined) return null;
  const f = x.field;
  if (f.windowId !== scope.windowId || !scope.fields.has(f.key)) return `your request didn't ask Caret to fill '${f.name}'`;
  const doc = documentOf === null ? null : documentOf(f.windowId);
  if (documentOf === null ? scope.document !== null : doc !== scope.document) return `the page is no longer the one Caret asked about '${f.name}' on`;
  if (f.fingerprint === null) return `Caret has no record of how '${f.name}' read, so it can't tell the field is the one the Ask was about`;
  if (f.fingerprint !== scope.seen[f.key]) return `'${f.name}' changed since Caret asked about it`;
  if (scope.person !== null && x.owner !== "person") return `the value for '${f.name}' is not ${scope.person}'s, whom you picked`;
  return window === undefined ? null : sectionRefusal(f, scope, window);
}

/** SCP1: why a field is no longer in the one section its Ask named, by the window as it reads now, or null. */
export function sectionRefusal(f: { readonly key: string; readonly name: string }, scope: AskScope, window: WindowState): string | null {
  if (scope.section === null) return null;
  const p = sectionPlacement(window, scope.section);
  if (p.withhold === "missing") return `the section you named is no longer on the form, so Caret can't tell '${f.name}' is in it`;
  if (p.withhold === "duplicate") return `the form now shows the section you named more than once, so Caret can't tell '${f.name}' is in it`;
  return p.member(f.key) === "in" ? null : `'${f.name}' is no longer in the section you named`;
}

/**
 * SCP1: where a window places fields in the section a request named, for the veto at settlement and the recheck at
 * acceptance and dispatch. The section is the occurrence the redacted view names, since that is what Jev chose from; the
 * raw window, read locally and sent nowhere, can only take away (final check of 4f644e3):
 *   - "missing": the redacted view names no occurrence by that text;
 *   - "duplicate": it names more than one, or one flagged as sharing an excluded name, or the raw window names by that
 *     text more than one occurrence, a flagged one, or another occurrence than the redacted view's (a heading whose own
 *     label redaction cut to that text, beside one whose placeholder redaction removed);
 *   - otherwise a field is "in" only when both outlines place it in that occurrence, so the fields admitted are a subset
 *     of what either outline alone admits.
 */
export interface SectionPlacement {
  readonly withhold: "missing" | "duplicate" | null;
  member(key: string): Membership;
}
export function sectionPlacement(window: WindowState, section: string): SectionPlacement {
  const unknown = (withhold: "missing" | "duplicate"): SectionPlacement => ({ withhold, member: () => "unknown" });
  const name = sectionName(section);
  const named = (o: WindowOutline): readonly SectionOccurrence[] => o.occurrences.filter((x) => x.text !== null && sectionName(x.text) === name);
  const red = windowOutline(redactWindow(window));
  const raw = windowOutline(window);
  const shown = named(red);
  if (shown.length === 0) return unknown("missing");
  const chosen = shown[0] as SectionOccurrence;
  const local = named(raw);
  if (shown.length > 1 || chosen.sharesExcludedName === true || local.length !== 1 || local[0]?.key !== chosen.key || local[0].sharesExcludedName === true) return unknown("duplicate");
  const inRed = sectionMembership(red, section);
  const inRaw = sectionMembership(raw, section);
  return {
    withhold: null,
    member: (key) => {
      const a = inRed(key);
      const b = inRaw(key);
      return a === "in" && b === "in" ? "in" : a === "unknown" || b === "unknown" ? "unknown" : "outside";
    },
  };
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
