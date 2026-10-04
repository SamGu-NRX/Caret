// The frame's element registry (memo section 1, identity layer 1). A registry id holds a WeakRef to the element the
// walk saw, so the page keeps no element alive for Caret's sake. Alive, connected and in this document means the
// same object. When React or another framework replaced the node, the strong key the walk recorded may rebind it,
// but only to exactly one connected control with the same strong key, kind and name whose value is still the one
// the helper expects (memo: "This is not fuzzy"). Without a strong key, a dead reference is simply gone.
import type { PageControlKind } from "../shared/messages.ts";
import { candidates, exclusionOf, formIdentity, valueOf, checkedOf, type Found } from "./walker.ts";
import { authorIdentifier, strongKey } from "../shared/ids.ts";

export interface Entry {
  ref: WeakRef<Element>;
  strongKey: string | null;
  kind: PageControlKind;
  name: string;
  /** location.href when a walk last saw it: an act from a later URL in this document is stale. */
  href: string;
  /**
   * history.length then. A pushState, even to the same URL, adds an entry the isolated world can see, so an act
   * that reaches the page after a history change the worker had not yet counted is still stale (W1 review #4).
   */
  histLen: number;
  form: string | null;
}

export class Registry {
  private readonly entries = new Map<string, Entry>();
  private readonly ids = new WeakMap<Element, string>();
  private next = 1;

  /** The element's id, the same across walks while the element lives. */
  idOf(el: Element): string {
    let id = this.ids.get(el);
    if (id === undefined) {
      id = `e${this.next++}`;
      this.ids.set(el, id);
    }
    return id;
  }

  remember(id: string, el: Element, e: Omit<Entry, "ref">): void {
    this.entries.set(id, { ref: new WeakRef(el), ...e });
  }

  /** Forgets everything: the document came back from the back-forward cache, so every earlier walk is stale. */
  clear(): void {
    this.entries.clear();
  }

  entry(id: string): Entry | undefined {
    return this.entries.get(id);
  }

  /**
   * The element for `id`: the retained one when it is still connected in this document, else the single strong-key
   * match holding `expect` (when given), else null with why.
   */
  resolve(id: string, expect: string | null): { el: Element; rebound: boolean } | { missing: string } {
    const e = this.entries.get(id);
    if (e === undefined) return { missing: `no element ${id} in this frame's walks` };
    const el = e.ref.deref();
    if (el !== undefined && el.isConnected && el.ownerDocument === document) return { el, rebound: false };
    if (e.strongKey === null) return { missing: "the element was replaced and has no author identifier to rebind by" };
    const matches: Found[] = [];
    for (const f of candidates()) {
      if (f.kind !== e.kind || f.name !== e.name) continue;
      const ident = authorIdentifier({ name: f.el.getAttribute("name"), id: f.el.getAttribute("id"), automationId: f.el.getAttribute("data-automation-id") });
      if (strongKey(location.origin, formIdentity(f.el), ident, f.kind) !== e.strongKey) continue;
      if (exclusionOf(f.el, f.name) !== null) continue;
      if (expect !== null && (valueOf(f.el) ?? String(checkedOf(f.el))) !== expect) continue;
      matches.push(f);
    }
    if (matches.length !== 1 || matches[0] === undefined) return { missing: `the element was replaced and ${matches.length} controls carry its strong key with the expected value` };
    const fresh = matches[0].el;
    this.ids.set(fresh, id);
    this.entries.set(id, { ...e, ref: new WeakRef(fresh) });
    return { el: fresh, rebound: true };
  }
}
