// Inputs that were ever password fields stay secret (content/secret.ts). A page's "show password" button changes the
// input's type attribute to text, often before the user focuses it or Caret walks the page, and some pages replace the
// input with a copy they turned into text while it was detached. So from document_start the content script watches,
// in the document and in every shadow root it meets: type attributes, with their old value; and added nodes, for
// password inputs (their id and name are remembered, so a replacement with either stays secret) and for new shadow
// roots, which are watched as they arrive. One observer; nothing else on the page is observed.
//
// History known: a root watched since before anything in it could change, which is the document when the script ran
// at document_start, and a shadow root seen as its host was added to a known root. Any other root (a document the
// script reached late, a shadow root a custom element attached after its host was added, or one first met in a walk or
// by focus) may already hold a revealed password Caret never saw as one, so its text inputs give no value and no caret
// text (valueWithheld).
import { notePassword, noteTypeChange, withheldForHistory } from "./secret.ts";
import { shadowRootOf } from "./shadow.ts";

/** What typeRecords reads of a MutationRecord. */
export interface TypeRecord {
  target: object & { getAttribute?(name: string): string | null };
  attributeName: string | null;
  oldValue: string | null;
}

/** An element's identity across a replacement: "id:<id>" and "name:<name>" for each it has. */
export function identityOf(el: { getAttribute?(name: string): string | null }): string[] {
  const out: string[] = [];
  const id = el.getAttribute?.("id")?.trim();
  const name = el.getAttribute?.("name")?.trim();
  if (id) out.push(`id:${id}`);
  if (name) out.push(`name:${name}`);
  return out;
}

/** Notes every input whose type attribute was or is now "password". */
export function typeRecords(records: Iterable<TypeRecord>): void {
  for (const r of records) if (r.attributeName === "type") noteTypeChange(r.target, r.oldValue, r.target.getAttribute?.("type") ?? null, identityOf(r.target));
}

const watched = new WeakSet<object>();
const known = new WeakSet<object>();
let observer: MutationObserver | null = null;

function onRecords(records: MutationRecord[]): void {
  typeRecords(records);
  for (const r of records) {
    if (r.type !== "childList") continue;
    const sure = known.has(r.target.getRootNode());
    for (const n of r.addedNodes) if (n instanceof Element) discover(n, sure);
  }
}

/** Elements attachShadow accepts (HTML's list), besides custom elements: no other element can hold a shadow root. */
const HOSTS = new Set(["article", "aside", "blockquote", "body", "div", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "main", "nav", "p", "section", "span"]);
const canHost = (el: Element): boolean => el.shadowRoot !== null || el.localName.includes("-") || HOSTS.has(el.localName);

/** Notes the password inputs in `root` and watches the shadow roots in it; `sure`: whether those roots' history is known. */
function discover(root: Element | Document | ShadowRoot, sure: boolean): void {
  const all = root instanceof Element ? [root, ...root.querySelectorAll("*")] : [...root.querySelectorAll("*")];
  for (const el of all) {
    if (el instanceof HTMLInputElement && el.type === "password") notePassword(el, identityOf(el));
    if (!canHost(el)) continue;
    const sr = shadowRootOf(el);
    if (sr !== null) watchPasswords(sr, sure);
  }
}

/**
 * Watches `root`'s type attributes and added nodes, once per root, and notes the password inputs already in it.
 * `fromStart`: Caret has watched it since before anything in it could change (see above); only a root's first watch
 * decides it.
 */
export function watchPasswords(root: Document | ShadowRoot, fromStart: boolean): void {
  if (watched.has(root) || typeof MutationObserver === "undefined") return;
  watched.add(root);
  if (fromStart) known.add(root);
  observer ??= new MutationObserver(onRecords);
  observer.observe(root, { attributes: true, attributeFilter: ["type"], attributeOldValue: true, childList: true, subtree: true });
  discover(root, fromStart);
}

/** Whether `el`'s value and caret text are withheld because its root's type history is not known (secret.ts). */
export function valueWithheld(el: Element): boolean {
  return withheldForHistory({ tag: el.localName, type: el instanceof HTMLInputElement ? el.type : "" }, known.has(el.getRootNode()));
}
