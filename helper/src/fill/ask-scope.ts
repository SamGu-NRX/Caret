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
 * What an Ask settled, recorded once (planner/ask.ts): the only fields it may write, by node key in one window; how
 * each read when the user's question was asked (fieldFingerprint); and the person the user picked, when they picked
 * one, whose details alone may go in.
 */
export interface AskScope {
  readonly windowId: string;
  /**
   * The page document the Ask was asked on (the page engine's generation, read through documentNow); null for a native
   * window or with no page engine. A page's element keys repeat across documents (P3's next page had the same Full name
   * key), so a key alone is no field. Plain data: a goal plan is cloned when it is offered (runs.ts propose).
   */
  readonly document: string | null;
  readonly fields: ReadonlySet<string>;
  /** By node key, each field's fingerprint when the Ask was asked (a continued Ask's first question's record). */
  readonly seen: Readonly<Record<string, string>>;
  /** The person the user picked; null when they picked none, or picked themselves. */
  readonly person: string | null;
}

/**
 * The page engine's document for a window now (helper.ts HelperOptions.pageDocument), installed by the helper that owns
 * the screen model (one per process); none outside a helper, as in tests that plan without one.
 */
let documents: ((windowId: string) => string | null) | null = null;
export function readDocumentsWith(f: ((windowId: string) => string | null) | null): void {
  documents = f;
}
export function documentNow(windowId: string): string | null {
  return documents === null ? null : documents(windowId);
}

export function askScope(windowId: string, keys: Iterable<string>, seen: Readonly<Record<string, string>>, person: string | null): AskScope {
  const fields = new Set(keys);
  const own: Record<string, string> = {};
  for (const k of fields) {
    const s = seen[k];
    // A field with no record cannot be compared later, so it is no field of the scope: said, never assumed.
    if (s === undefined) throw new Error(`the Ask's scope names field ${k}, which its record of the form lacks`);
    own[k] = s;
  }
  return Object.freeze({ windowId, document: documentNow(windowId), fields, seen: Object.freeze(own), person });
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
 * Why `x` may not be written under `scope`, or null: its field is not one the Ask settled, the field no longer reads as
 * it did when the Ask was asked, or the user picked a person and the value is not that person's. Null with no scope.
 */
export function scopeRefusal(x: ScopedWrite, scope: AskScope | undefined): string | null {
  if (scope === undefined) return null;
  const f = x.field;
  if (f.windowId !== scope.windowId || !scope.fields.has(f.key)) return `the Ask did not ask Caret to fill '${f.name}'`;
  if (documentNow(f.windowId) !== scope.document) return `the page is no longer the one Caret asked about '${f.name}' on`;
  if (f.fingerprint === null) return `Caret has no record of how '${f.name}' read, so it can't tell the field is the one the Ask was about`;
  if (f.fingerprint !== scope.seen[f.key]) return `'${f.name}' changed since Caret asked about it`;
  if (scope.person !== null && x.owner !== "person") return `the value for '${f.name}' is not ${scope.person}'s, whom you picked`;
  return null;
}
