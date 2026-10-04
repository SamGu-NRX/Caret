// The frame's element registry (memo section 1, identity layer 1). A registry id holds a WeakRef to the element the
// walk saw, so the page keeps no element alive for Caret's sake. Alive, connected and in this document means the
// same object. When React or another framework replaced the node, the strong key the walk recorded may rebind it,
// but only to exactly one connected control with the same strong key, kind and name whose value is still the one
// the helper expects (memo: "This is not fuzzy"). Without a strong key, a dead reference is simply gone.
//
// An id names one element object for good (W3): a rebind acts on the replacement but never moves the old id to it,
// and the replacement keeps (or gets) an id of its own. So the helper's undo mark, which holds the id it wrote, no
// longer matches once the element was replaced, and an undo that reaches the frame anyway (`rebind: false`) refuses
// a dead reference as notSameElement instead of rebinding.
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
   * The history entry then (navigationEntry()). A pushState or replaceState, even to the same URL, makes a new entry
   * id the isolated world can read, so an act that reaches the page after a history change the worker had not yet
   * counted is still stale (W1 review #4 and round 2).
   */
  nav: string;
  form: string | null;
}

/** The current history entry's id from the Navigation API, or history.length where the API is missing. */
export function navigationEntry(): string {
  const nav = (globalThis as { navigation?: { currentEntry?: { id: string } | null } }).navigation;
  const id = nav?.currentEntry?.id;
  return id === undefined ? `length:${history.length}` : `entry:${id}`;
}

/** Undo marks one frame keeps; past this the oldest is forgotten and its undo refused. As the helper's MAX_MARKS. */
const MAX_MARKS = 512;

export class Registry {
  private readonly entries = new Map<string, Entry>();
  private readonly ids = new WeakMap<Element, string>();
  /** The element each marked write reached (W3 review #2), held weakly like every other registry reference. */
  private readonly marks = new Map<string, WeakRef<Element>>();
  private next = 1;

  /** Keeps `el` under `mark`: the element a forward write is about to change. */
  mark(mark: string, el: Element): void {
    this.marks.delete(mark);
    this.marks.set(mark, new WeakRef(el));
    while (this.marks.size > MAX_MARKS) this.marks.delete(this.marks.keys().next().value as string);
  }

  /** The element kept under `mark`, if it is still alive in this document. */
  marked(mark: string): Element | null {
    const el = this.marks.get(mark)?.deref();
    return el !== undefined && el.isConnected && el.ownerDocument === document ? el : null;
  }

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
    this.marks.clear();
  }

  entry(id: string): Entry | undefined {
    return this.entries.get(id);
  }

  /**
   * The element for `id`: the retained one when it is still connected in this document, else (when `rebind`) the
   * single strong-key match holding `expect` (when given), else why not. `replaced` says the walked element is gone:
   * with `rebind` false that is the whole answer.
   */
  resolve(id: string, expect: string | null, rebind = true): { el: Element; rebound: boolean } | { missing: string; replaced: boolean } {
    const e = this.entries.get(id);
    if (e === undefined) return { missing: `no element ${id} in this frame's walks`, replaced: false };
    const el = e.ref.deref();
    if (el !== undefined && el.isConnected && el.ownerDocument === document) return { el, rebound: false };
    if (!rebind) return { missing: "the element Caret wrote was replaced, and an undo never rebinds to its replacement", replaced: true };
    if (e.strongKey === null) return { missing: "the element was replaced and has no author identifier to rebind by", replaced: true };
    const matches: Found[] = [];
    for (const f of candidates()) {
      if (f.kind !== e.kind || f.name !== e.name) continue;
      const ident = authorIdentifier({ name: f.el.getAttribute("name"), id: f.el.getAttribute("id"), automationId: f.el.getAttribute("data-automation-id") });
      if (strongKey(location.origin, formIdentity(f.el), ident, f.kind) !== e.strongKey) continue;
      if (exclusionOf(f.el, f.name) !== null) continue;
      if (expect !== null && (valueOf(f.el) ?? String(checkedOf(f.el))) !== expect) continue;
      matches.push(f);
    }
    if (matches.length !== 1 || matches[0] === undefined) return { missing: `the element was replaced and ${matches.length} controls carry its strong key with the expected value`, replaced: true };
    const fresh = matches[0].el;
    // The replacement is another object: it keeps the id a later walk gave it, or takes a new one there; `id` stays the old element's.
    return { el: fresh, rebound: true };
  }
}
