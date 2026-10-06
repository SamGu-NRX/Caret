// Ready on load (P3, plans/fast-browser.md "Ambient: ready on load"): the producer that offers Fill all on focus also
// runs when the active tab's document changes, once per document, with no focus. This file is the check code makes
// before any Jev request.
//
// Lead decision (P3 brief): it fires only on pages worth it. A page needs at least two empty fields Caret supports, each
// with a candidate value from what the user told Caret or from the window the user just left. Sam loads many pages with
// a search box, and each firing sends source text to Jev with no sign the user wants a fill; so a search box never
// counts, a page with a login form counts none of its credential fields, and a page with a payment form never fires.
// Nothing here calls a model or reads a window other than the page and the one the user left.
import type { ScreenModel, WindowState } from "../model.ts";
import type { Node, PageExclusion } from "../protocol.ts";
import type { AboutValue } from "../fill/about.ts";
import { fieldAsksFor } from "../fill/about.ts";
import { labelledLines } from "../fill/candidates.ts";
import { describeField } from "../fill/descriptor.ts";
import { FILLABLE_ROLES } from "../fill/fill.ts";
import { fieldKinds, valueKinds, words } from "../fill/kinds.ts";
import { labelKind } from "../memory/sensitive.ts";
import { pageInputNodes } from "../goals/page-planner.ts";

/** Fields with a candidate a page needs before it is worth a Jev request (lead decision: two). */
export const LOAD_MIN_FIELDS = 2;

export type LoadVerdict =
  | { fires: true; trigger: string; fields: string[] }
  | { fires: false; why: "payment" | "noFields" | "fewCandidates"; fields: string[] };

/** What the page engine left out of a walk, by count (protocol PageFrame.excluded): a password field, a card field. */
export type Excluded = Partial<Record<PageExclusion, number>>;

/** A search box: one the page or app marks as search, or one whose name says search or find. */
const SEARCH = /\b(?:search|find|look\s*up|query)\b/iu;
/** What a login form asks besides the password: who you are. */
const CREDENTIAL = /\b(?:user\s*name|username|user\s*id|login|log\s*in|sign\s*in|e-?mail|email|phone|account)\b/iu;
/** A field of a payment form whose own kind Caret types (the card number itself is never typed: sensitive.ts). */
const PAYMENT = /\b(?:card|cardholder|billing|expir(?:y|ation|es)|exp\.?\s*date|cvv|cvc|security\s+code|iban|routing|payment)\b/iu;

const nameOf = (w: WindowState, n: Node): string | null => {
  const d = describeField(w, n);
  return d.label ?? d.nearest ?? d.placeholder;
};

function isSearch(w: WindowState, n: Node): boolean {
  if (n.role === "AXSearchField" || n.subrole === "AXSearchField") return true;
  const d = describeField(w, n);
  return [d.label, d.nearest, d.placeholder].some((t) => t !== null && SEARCH.test(t));
}

/**
 * Whether the page holds a login form: a password field (the page engine never walks one, and says how many it left
 * out; Accessibility shows a native one as secure).
 */
function hasPassword(w: WindowState, excluded: Excluded): boolean {
  return (excluded.password ?? 0) > 0 || [...w.nodes.values()].some((n) => n.role === "AXSecureTextField" || n.states?.includes("secure") === true);
}

/** Whether the page holds a payment form: a card field the page engine left out, or one whose label reads as a card's. */
function hasPayment(w: WindowState, excluded: Excluded): boolean {
  if ((excluded.payment ?? 0) > 0) return true;
  for (const n of w.nodes.values()) {
    if (n.editable !== true) continue;
    const d = describeField(w, n);
    const k = labelKind(d.label ?? d.nearest) ?? labelKind(d.placeholder);
    if (k === "cardNumber") return true;
  }
  return false;
}

/**
 * Whether a value for this field is in what the user told Caret or in the window the user left: an About entry that
 * asks for it (about.ts fieldAsksFor), a typed value of a kind its name asks for, or a "Label: value" line whose label
 * shares a word with its name. The fill on focus's own evidence (helper.ts fillEvidence), held to those two sources.
 */
function hasCandidate(w: WindowState, n: Node, about: readonly AboutValue[], left: WindowState | null): boolean {
  const name = nameOf(w, n);
  if (about.some((a) => fieldAsksFor(a, name))) return true;
  if (left === null) return false;
  const d = describeField(w, n);
  const asked = fieldKinds([d.label, d.nearest, d.placeholder]);
  if (left.values.some((v) => valueKinds(v).some((k) => asked.has(k)))) return true;
  const own = new Set([d.label, d.nearest, d.placeholder].flatMap(words));
  return labelledLines(left).some((l) => words(l.label).some((t) => own.has(t)));
}

/**
 * The check before a page load's Fill all asks Jev: the empty supported fields (page-planner.ts pageInputNodes, which
 * already leaves out every field of a kind Caret never types) that are not a search box and, on a page with a login
 * form, not a credential, each with a candidate value. Fires on LOAD_MIN_FIELDS or more, from the first in document
 * order. A page with a payment form never fires.
 */
export function readyOnLoad(model: ScreenModel, w: WindowState, about: readonly AboutValue[], o: { excluded: Excluded }): LoadVerdict {
  if (hasPayment(w, o.excluded)) return { fires: false, why: "payment", fields: [] };
  const login = hasPassword(w, o.excluded);
  const leftId = model.windowBefore(w.window.windowId);
  const left = leftId === null ? null : (model.windows.get(leftId) ?? null);
  const supported = pageInputNodes(w).filter((n) => {
    if (isSearch(w, n)) return false;
    const name = nameOf(w, n);
    if (name !== null && PAYMENT.test(name)) return false;
    return !(login && name !== null && CREDENTIAL.test(name));
  });
  if (supported.length === 0) return { fires: false, why: "noFields", fields: [] };
  const fit = supported.filter((n) => hasCandidate(w, n, about, left));
  const fields = fit.map((n) => n.key);
  // Fill starts from a text field (the field a focus would be in); a page whose fitting fields are all choices has none.
  const trigger = fit.find((n) => FILLABLE_ROLES.has(n.role))?.key;
  if (fields.length < LOAD_MIN_FIELDS || trigger === undefined) return { fires: false, why: "fewCandidates", fields };
  return { fires: true, trigger, fields };
}
