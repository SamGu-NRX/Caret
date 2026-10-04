// Accessible names, the way a person reads the control: aria-labelledby, aria-label, the <label>, title, then
// placeholder for fields and text for buttons and links. ID references resolve in the element's own tree (document
// or shadow root). Text is whitespace-collapsed and clipped; nothing here reads body prose beyond a label.

const MAX_NAME = 200;

export function clean(s: string | null | undefined, max = MAX_NAME): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function byIds(el: Element, ids: string): Element[] {
  const root = el.getRootNode() as Document | ShadowRoot;
  return ids.split(/\s+/).filter(Boolean).map((id) => root.getElementById(id)).filter((e): e is HTMLElement => e !== null);
}

/** A label's text without the text of the control inside it (a select's options, a field's own value). */
function labelText(label: Element, control: Element): string {
  if (!label.contains(control)) return label.textContent ?? "";
  const clone = label.cloneNode(true) as Element;
  for (const c of clone.querySelectorAll("input, select, textarea, button")) c.remove();
  return clone.textContent ?? "";
}

export function accessibleName(el: Element): string {
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby !== null) {
    const t = clean(byIds(el, labelledby).map((e) => e.textContent ?? "").join(" "));
    if (t !== "") return t;
  }
  const aria = clean(el.getAttribute("aria-label"));
  if (aria !== "") return aria;
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el instanceof HTMLButtonElement) {
    const labels = el.labels;
    if (labels !== null && labels.length > 0) {
      const t = clean([...labels].map((l) => labelText(l, el)).join(" "));
      if (t !== "") return t;
    }
  }
  if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button" || el.type === "reset")) {
    const t = clean(el.value || (el.type === "submit" ? "Submit" : ""));
    if (t !== "") return t;
  }
  const title = clean(el.getAttribute("title"));
  if (title !== "") return title;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const ph = clean(el.placeholder);
    if (ph !== "") return ph;
  }
  const role = el.getAttribute("role");
  if (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement || role === "button" || role === "link" || role === "checkbox" || role === "radio" || role === "switch" || role === "option") {
    return clean(el.textContent);
  }
  return "";
}

/** The name of the group the control sits in: a fieldset's legend or an ARIA group's name. Empty when none. */
export function groupName(el: Element): string {
  for (let p: Element | null = el.parentElement; p !== null; p = p.parentElement) {
    if (p instanceof HTMLFieldSetElement) {
      const legend = p.querySelector(":scope > legend");
      if (legend !== null) return clean(legend.textContent);
    }
    const role = p.getAttribute("role");
    if (role === "group" || role === "radiogroup") {
      const n = accessibleName(p);
      if (n !== "") return n;
    }
  }
  return "";
}
