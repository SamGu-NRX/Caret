// Which kind of custom listbox a combobox is, and the text it shows as its value. Kept apart from combobox.ts so the
// walker can report a react-select's chip as the control's value without importing the handler.
import { clean } from "./names.ts";
import { safeText } from "./secret-dom.ts";

export type Flavor = { kind: "reactSelect"; box: HTMLElement; container: HTMLElement } | { kind: "aria" };

/**
 * React-select when the control sits in react-select's control box (a class ending "-control" or "__control") whose
 * parent holds the select's hidden input or its value element; otherwise generic ARIA.
 */
export function flavorOf(el: Element): Flavor {
  let p: Element | null = el.parentElement;
  for (let i = 0; p !== null && i < 6; i++, p = p.parentElement) {
    if (!(p instanceof HTMLElement) || !/(^|[\s_-])control(\s|$)/.test(p.className)) continue;
    const container = p.parentElement;
    if (container instanceof HTMLElement && container.querySelector(':scope > input[type="hidden"], [class*="singleValue"], [class*="placeholder"]') !== null) return { kind: "reactSelect", box: p, container };
  }
  return { kind: "aria" };
}

/** The text the control shows as its value: react-select's chip (or chips), else an input's value, else its text. */
export function shownValue(el: Element, f: Flavor = flavorOf(el)): string {
  if (f.kind === "reactSelect") {
    const single = f.container.querySelector('[class*="singleValue"]');
    if (single !== null) return clean(safeText(single), 200);
    return [...f.container.querySelectorAll('[class*="multiValue"] [class*="label"], [class*="MultiValueLabel"]')].map((x) => clean(safeText(x), 120)).join(", ");
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  return clean(safeText(el), 200);
}
