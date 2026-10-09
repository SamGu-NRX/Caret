// The flat tree a page renders, for every reader that walks it: an element's shadow root, open or closed, and a node's
// parent through slots and shadow roots. Secret classification (secret-dom.ts), names (names.ts) and the walk all
// follow the same parents, so a light-DOM input slotted into a secret widget's shadow root is inside that widget.

/** Elements attachShadow accepts (HTML's list), besides custom elements: no other element can hold a shadow root. */
const HOSTS = new Set(["article", "aside", "blockquote", "body", "div", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "main", "nav", "p", "section", "span"]);

/** Whether `el` can hold a shadow root at all, so the closed-root lookup is skipped for every other element. */
export function canHost(el: Element): boolean {
  return el.shadowRoot !== null || el.localName.includes("-") || HOSTS.has(el.localName);
}

/** An element's shadow root, open or closed. chrome.dom takes HTML elements only and throws on others (SVG). */
export function shadowRootOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot !== null) return el.shadowRoot;
  if (!(el instanceof HTMLElement) || !canHost(el) || typeof chrome === "undefined" || chrome.dom?.openOrClosedShadowRoot === undefined) return null;
  try {
    return (chrome.dom.openOrClosedShadowRoot(el) as ShadowRoot | null) ?? null;
  } catch {
    return null;
  }
}

/** What flatParent reads of a node tree. A DOM node has all of it (DOM_FLAT below). */
export interface FlatReader<N> {
  parentNode(n: N): N | null;
  /** The host when `n` is a shadow root, else null. */
  hostOf(n: N): N | null;
  isElement(n: N): boolean;
  shadowRootOf(el: N): N | null;
  slotsIn(root: N): Iterable<N>;
  /** A slot's assigned nodes, not flattened: a slot assigned to another slot is walked through that one. */
  assigned(slot: N): readonly N[];
}

/**
 * `n`'s parent in the flat tree: the slot it is assigned to (in an open or a closed shadow root), else through a shadow
 * root to its host, else its parent element (W1 review, round 2, #6).
 */
export function flatParent<N>(n: N, r: FlatReader<N>): N | null {
  const p = r.parentNode(n);
  if (p === null) return null;
  if (r.isElement(p)) {
    const root = r.shadowRootOf(p);
    if (root !== null) for (const slot of r.slotsIn(root)) if (r.assigned(slot).includes(n)) return slot;
    return p;
  }
  return r.hostOf(p);
}

const DOM_FLAT: FlatReader<Node> = {
  parentNode: (n) => n.parentNode,
  hostOf: (n) => (n instanceof ShadowRoot ? n.host : null),
  isElement: (n) => n.nodeType === Node.ELEMENT_NODE,
  shadowRootOf: (el) => shadowRootOf(el as Element),
  slotsIn: (root) => (root as ShadowRoot).querySelectorAll("slot"),
  assigned: (slot) => (slot as HTMLSlotElement).assignedNodes(),
};

/** `n`'s parent element in the flat tree, or null at the top. */
export function composedParent(n: Node): Element | null {
  const p = flatParent(n, DOM_FLAT);
  return p !== null && p.nodeType === Node.ELEMENT_NODE ? (p as Element) : null;
}
