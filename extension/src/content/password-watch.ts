// Inputs that were ever password fields stay secret (content/secret.ts), and a text input Caret can't show was never
// one gives no value. A page's "show password" button changes the input's type attribute to text, often before the
// user focuses it or Caret walks the page; some pages replace the input with a copy turned into text while detached,
// with or without its id and name. So from document_start the content script watches, in the document and in every
// shadow root it meets: type attributes, with their old value; added nodes, for password inputs (their ids and names
// are remembered) and new shadow roots; and removed password inputs, whose replacements are withheld.
//
// History known: only the document, and only when this script ran at document_start, so every type change in it was
// seen. A shadow root never is: its type changes before Caret's observer reached it (even within the same task that
// added its host) were not seen. A late document is not either. A text input in a root whose history is not known, or
// one that may replace a removed password input (Replacements), gives no value, no caret text and no readings
// (valueWithheld).
import { notePassword, noteTypeChange, notedPassword, revealable, withheldForHistory } from "./secret.ts";
import { canHost, shadowRootOf } from "./shadow.ts";

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

/** Whether a root's type history is known: a document watched from document_start, never a shadow root (see above). */
export function historyKnownFor(r: { shadow: boolean; fromStart: boolean }): boolean {
  return !r.shadow && r.fromStart;
}

/**
 * How long around a password input's removal a text input added to the same root may be its replacement. Assumed, not
 * measured: a page swaps the copy in within the same task or the next few, far inside it.
 */
export const REPLACE_MS = 2000;

/**
 * Text inputs that may replace a removed password input: any added to the same root (the document or a shadow root,
 * which holds the same parent and form) within REPLACE_MS before or after the removal, with an id, a name or neither.
 * Once withheld, always: the value it holds may still be the password. Pure; `now` is for tests.
 */
export class Replacements<R extends object, E extends object> {
  private readonly now: () => number;
  private removals: { root: R; at: number }[] = [];
  private recent: { el: WeakRef<E>; root: R; at: number }[] = [];
  private readonly withheld = new WeakSet<E>();

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private prune(now: number): void {
    this.removals = this.removals.filter((x) => now - x.at <= REPLACE_MS);
    this.recent = this.recent.filter((x) => now - x.at <= REPLACE_MS && x.el.deref() !== undefined);
  }

  /** A password input was removed from `root`: text inputs added there shortly before are withheld. */
  removedPassword(root: R): void {
    const now = this.now();
    this.prune(now);
    for (const a of this.recent) {
      const el = a.el.deref();
      if (el !== undefined && a.root === root) this.withheld.add(el);
    }
    this.removals.push({ root, at: now });
  }

  /** A text input was added to `root`: withheld when a password input left it shortly before. */
  added(el: E, root: R): void {
    const now = this.now();
    this.prune(now);
    if (this.removals.some((x) => x.root === root)) this.withheld.add(el);
    this.recent.push({ el: new WeakRef(el), root, at: now });
  }

  ambiguous(el: E): boolean {
    return this.withheld.has(el);
  }
}

const watched = new WeakSet<object>();
const known = new WeakSet<object>();
const replacements = new Replacements<Node, Element>();
let observer: MutationObserver | null = null;

/** Every element of `n`'s subtree, `n` included when it is one. */
function subtree(n: Node): Element[] {
  if (n instanceof Element) return [n, ...n.querySelectorAll("*")];
  if (n instanceof Document || n instanceof ShadowRoot || n instanceof DocumentFragment) return [...n.querySelectorAll("*")];
  return [];
}

function onRecords(records: MutationRecord[]): void {
  typeRecords(records);
  for (const r of records) {
    if (r.type !== "childList") continue;
    const root = r.target.getRootNode();
    for (const n of r.removedNodes) {
      for (const el of subtree(n)) if (el instanceof HTMLInputElement && (el.type === "password" || notedPassword(el))) replacements.removedPassword(root);
    }
    for (const n of r.addedNodes) {
      for (const el of subtree(n)) if (el instanceof HTMLInputElement && revealable(el.type)) replacements.added(el, root);
      discover(n);
    }
  }
}

/** Notes the password inputs under `n` and watches the shadow roots there; every such root's history is unknown. */
function discover(n: Node): void {
  for (const el of subtree(n)) {
    if (el instanceof HTMLInputElement && el.type === "password") notePassword(el, identityOf(el));
    if (!canHost(el)) continue;
    const sr = shadowRootOf(el);
    if (sr !== null) watchPasswords(sr, false);
  }
}

/**
 * Watches `root`'s type attributes and added and removed nodes, once per root, and notes the password inputs already in
 * it. `fromStart`: this script reached `root` before anything in it could change; it counts only for a document.
 */
export function watchPasswords(root: Document | ShadowRoot, fromStart: boolean): void {
  if (watched.has(root) || typeof MutationObserver === "undefined") return;
  watched.add(root);
  if (historyKnownFor({ shadow: root instanceof ShadowRoot, fromStart })) known.add(root);
  observer ??= new MutationObserver(onRecords);
  observer.observe(root, { attributes: true, attributeFilter: ["type"], attributeOldValue: true, childList: true, subtree: true });
  discover(root);
}

/**
 * Whether `el`'s value, caret text and act readings are withheld: a text input in a root whose type history is not
 * known, or one that may have replaced a removed password input.
 */
export function valueWithheld(el: Element): boolean {
  const input = { tag: el.localName, type: el instanceof HTMLInputElement ? el.type : "" };
  return withheldForHistory(input, known.has(el.getRootNode())) || (el instanceof HTMLInputElement && replacements.ambiguous(el));
}
