// Accessible names, the way a person reads the control: aria-labelledby, aria-label, the <label>, title, then
// placeholder for fields and text for buttons and links. ID references resolve in the element's own tree (document
// or shadow root). Text is whitespace-collapsed and clipped; nothing here reads body prose beyond a label. Every text is
// read without the secret fields inside it (secret-dom.ts safeText), so a label wrapped around a one-time-code box
// doesn't carry its code.
import { safeText } from "./secret-dom.ts";

const MAX_NAME = 200;

export function clean(s: string | null | undefined, max = MAX_NAME): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** The elements an aria-labelledby value names, in `el`'s own tree (document or shadow root). */
export function labelledBy(el: Element, ids: string): Element[] {
  return byIds(el, ids);
}

function byIds(el: Element, ids: string): Element[] {
  const root = el.getRootNode() as Document | ShadowRoot;
  return ids.split(/\s+/).filter(Boolean).map((id) => root.getElementById(id)).filter((e): e is HTMLElement => e !== null);
}

/** A label's text without the text of the control inside it (a select's options, a field's own value). */
function labelText(label: Element, control: Element): string {
  if (!label.contains(control)) return safeText(label);
  const clone = label.cloneNode(true) as Element;
  // `control` may be an element around the control (W4: an upload widget inside its label): its text goes too. Found
  // in the clone by its path of child indices, taken before anything is removed.
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement || control instanceof HTMLButtonElement)) {
    const path: number[] = [];
    for (let n: Element = control; n !== label && n.parentElement !== null; n = n.parentElement) path.unshift([...n.parentElement.children].indexOf(n));
    let at: Element | undefined = clone;
    for (const i of path) at = at?.children[i];
    if (at !== clone) at?.remove();
  }
  for (const c of clone.querySelectorAll("input, select, textarea, button")) c.remove();
  return safeText(clone);
}

export function accessibleName(el: Element): string {
  return named(el).name;
}

/** Where an accessible name came from: "placeholder" or "none" are the ones a field's question may stand in for (W4). */
export type NameSource = "labelledby" | "label" | "labels" | "value" | "title" | "placeholder" | "text" | "none";

/** The accessible name and which source gave it. */
export function named(el: Element): { name: string; from: NameSource } {
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby !== null) {
    const t = clean(byIds(el, labelledby).map((e) => safeText(e)).join(" "));
    if (t !== "") return { name: t, from: "labelledby" };
  }
  const aria = clean(el.getAttribute("aria-label"));
  if (aria !== "") return { name: aria, from: "label" };
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el instanceof HTMLButtonElement) {
    const labels = el.labels;
    if (labels !== null && labels.length > 0) {
      const t = clean([...labels].map((l) => labelText(l, el)).join(" "));
      if (t !== "") return { name: t, from: "labels" };
    }
  }
  if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button" || el.type === "reset")) {
    const t = clean(el.value || (el.type === "submit" ? "Submit" : ""));
    if (t !== "") return { name: t, from: "value" };
  }
  const title = clean(el.getAttribute("title"));
  if (title !== "") return { name: title, from: "title" };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const ph = clean(el.placeholder);
    if (ph !== "") return { name: ph, from: "placeholder" };
  }
  const role = el.getAttribute("role");
  if (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement || role === "button" || role === "link" || role === "checkbox" || role === "radio" || role === "switch" || role === "option") {
    return { name: clean(safeText(el)), from: "text" };
  }
  return { name: "", from: "none" };
}

/** A label's text without the control's own text, for a label the caller already holds. */
export function textOfLabel(label: Element, control: Element): string {
  return clean(labelText(label, control));
}

/**
 * The node's parent in the flat tree, the tree that is rendered: a slotted light-DOM node's slot (in an open or a
 * closed shadow root), else through a shadow root to its host, else its parent element (W1 review, round 2, #6).
 */
export function composedParent(n: Node): Element | null {
  const p = n.parentNode;
  if (p instanceof Element) {
    const root = p.shadowRoot ?? closedRootOf(p);
    if (root !== null) {
      for (const slot of root.querySelectorAll("slot")) if (slot.assignedNodes().includes(n as ChildNode)) return slot;
    }
    return p;
  }
  if (p instanceof ShadowRoot) return p.host;
  return null;
}

function closedRootOf(el: Element): ShadowRoot | null {
  if (!(el instanceof HTMLElement) || typeof chrome === "undefined" || chrome.dom?.openOrClosedShadowRoot === undefined) return null;
  try {
    return (chrome.dom.openOrClosedShadowRoot(el) as ShadowRoot | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * The names of every group the control sits in, nearest first: fieldset legends and ARIA groups, through shadow
 * roots to their hosts. All of them, since a nested group with a plain name must not hide a sensitive outer one
 * (W1 review #6).
 */
export function groupNames(el: Element): string[] {
  const out: string[] = [];
  for (let p = composedParent(el); p !== null; p = composedParent(p)) {
    if (p instanceof HTMLFieldSetElement) {
      const legend = p.querySelector(":scope > legend");
      if (legend !== null) out.push(clean(safeText(legend)));
    }
    const role = p.getAttribute("role");
    if (role === "group" || role === "radiogroup") {
      const n = accessibleName(p);
      if (n !== "") out.push(n);
    }
  }
  return out;
}
