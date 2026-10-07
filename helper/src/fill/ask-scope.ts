// I2: an Ask's settled scope, enforced by the write contract (fill/contract.ts) rather than by each path that plans a
// write. Checking scope path by path did not converge: after A3 made Jev choose an Ask's fields, the review of the merge
// found the native planner, then the writer goal, the resumed native plan and a picked person each writing outside it
// (evidence/screen/i2). Every write is minted by checkValues or mintExempt, rechecked by validatePlan or the goal gate
// (goals/lower.ts), and rechecked again by the executor's guard (contract.ts guardFor), so the scope is checked there.
import type { Node } from "../protocol.ts";
import type { WindowState } from "../model.ts";
import type { Owner } from "./contract.ts";
import { describeField, fieldLabelText } from "./descriptor.ts";

/** Which page document a window shows now (the helper's page engine, helper.ts HelperOptions.pageDocument). */
export type DocumentReader = (windowId: string) => string | null;

/**
 * What an Ask settled, once, by the per-field scope question (planner/intent-heads.ts), and never changed after: the only
 * fields it may write, by node key in one window; the page document they were on; how each read when the question was
 * asked (fieldFingerprint); and the person the user picked, when they picked one, whose details alone may go in.
 * Anything that would change a scope is a new settle, for a new document or a new Ask (I2 lead ruling B).
 */
export interface AskScope {
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
}

export function askScope(windowId: string, document: string | null, keys: Iterable<string>, seen: Readonly<Record<string, string>>, person: string | null): AskScope {
  const fields = new Set(keys);
  const own: Record<string, string> = {};
  for (const k of fields) {
    const s = seen[k];
    // A field with no record cannot be compared later, so it is no field of the scope: said, never assumed.
    if (s === undefined) throw new Error(`the Ask's scope names field ${k}, which its record of the form lacks`);
    own[k] = s;
  }
  return Object.freeze({ windowId, document, fields, seen: Object.freeze(own), person });
}

/**
 * I2 lead ruling C: a goal's scopes, one per window and document it writes in, settled once each and kept across its
 * replans. A replan reuses them; a field that changed since is refused, never settled again. `ask` is false for a goal
 * no Ask made, which no scope holds.
 */
export interface ScopeSet {
  readonly ask: boolean;
  readonly person: string | null;
  readonly scopes: Readonly<Record<string, AskScope>>;
}
export const scopeKey = (windowId: string, document: string | null): string => `${windowId}\n${document ?? ""}`;
export function scopeSet(person: string | null, scopes: readonly AskScope[] = []): ScopeSet {
  return Object.freeze({ ask: true, person, scopes: Object.freeze(Object.fromEntries(scopes.map((x) => [scopeKey(x.windowId, x.document), x]))) });
}
/** The set with `x` added; a window and document it already holds keeps its first scope. */
export function withScope(set: ScopeSet, x: AskScope): ScopeSet {
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
  if (f.windowId !== scope.windowId || !scope.fields.has(f.key)) return `the Ask did not ask Caret to fill '${f.name}'`;
  const doc = documentOf === null ? null : documentOf(f.windowId);
  if (documentOf === null ? scope.document !== null : doc !== scope.document) return `the page is no longer the one Caret asked about '${f.name}' on`;
  if (f.fingerprint === null) return `Caret has no record of how '${f.name}' read, so it can't tell the field is the one the Ask was about`;
  if (f.fingerprint !== scope.seen[f.key]) return `'${f.name}' changed since Caret asked about it`;
  if (scope.person !== null && x.owner !== "person") return `the value for '${f.name}' is not ${scope.person}'s, whom you picked`;
  return null;
}
