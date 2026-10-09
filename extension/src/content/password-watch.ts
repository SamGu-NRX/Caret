// Inputs that were ever password fields stay secret (content/secret.ts). A page's "show password" button changes the
// input's type attribute to text, often before the user focuses it or Caret walks the page, so the content script
// watches type attributes from document_start: the document, and each shadow root it meets (a walk's, focus's or the
// scan at load). One observer, attribute "type" only, with its old value; nothing else on the page is observed.
//
// Not covered: a page that replaces the password input with a new text input holding the value, inside a shadow root
// Caret has not met yet. secret.ts's label and autocomplete rules are the only guard there.
import { notePassword, noteTypeChange } from "./secret.ts";

/** What typeRecords reads of a MutationRecord. */
export interface TypeRecord {
  target: object & { getAttribute?(name: string): string | null };
  attributeName: string | null;
  oldValue: string | null;
}

/** Notes every input whose type attribute was or is now "password". */
export function typeRecords(records: Iterable<TypeRecord>): void {
  for (const r of records) if (r.attributeName === "type") noteTypeChange(r.target, r.oldValue, r.target.getAttribute?.("type") ?? null);
}

const watched = new WeakSet<object>();
let observer: MutationObserver | null = null;

/** Watches `root`'s type attributes, once per root, and notes the password inputs already in it. */
export function watchPasswords(root: Document | ShadowRoot): void {
  if (watched.has(root) || typeof MutationObserver === "undefined") return;
  watched.add(root);
  observer ??= new MutationObserver((records) => typeRecords(records));
  observer.observe(root, { attributes: true, attributeFilter: ["type"], attributeOldValue: true, subtree: true });
  for (const el of root.querySelectorAll('input[type="password" i]')) notePassword(el);
}
