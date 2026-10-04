// The form controls fill reads besides text fields (Q1 bug 10): native selects, radio groups, checkboxes,
// and date and time inputs, found by the reader's Accessibility roles. Chrome exposes them as AXPopUpButton,
// AXRadioButton under an AXFieldset group, AXCheckBox, AXDateField and AXTimeField (B24 capture,
// evidence/screen/b24/capture-2). Caret does not write any of them: the executor writes text through the
// reader, and how Chrome applies an AX write to these controls is unverified. So a value proposed for one
// is a hand-off the user applies (FillField.handoff); the browser layer (plans/browser-layer.md) will
// take them over. Code checks every such value: an option must be one the control shows, exactly; a box is
// ticked only when the chosen source text names it; a date or time is read by the value resolver.
import type { Node } from "../protocol.ts";
import type { WindowState } from "../model.ts";
import { fieldLabelText } from "./descriptor.ts";

export type Control = "text" | "date" | "time" | "select" | "radio" | "checkbox" | "combobox";

export interface FormControl {
  /** The node the proposal names: the control itself, or a radio group's container. */
  node: Node;
  control: Exclude<Control, "text">;
  /** The control's own label without required markers. */
  label: string | null;
  /** The options code can see: a radio group's buttons, or a select's menu items when the app exposes them. Null when unknown. */
  options: string[] | null;
  /** A radio group's buttons, in document order. */
  members: Node[];
}

/**
 * Labels of boxes Caret never ticks: consent, certification, agreement to terms, and marketing or
 * notification sign-ups. Plan section 4: "never infer consent from a checkbox label". Written for common
 * form wording, not measured; a box that matches is left alone even when a source seems to say yes.
 */
const CONSENT = /\b(?:agree|consent|certif(?:y|ies)|acknowledge|confirm|accept|terms|privacy|policy|polic(?:ies)|authori[sz]e|newsletter|marketing|news|offers?|promotions?|specials|coupons|subscribe|sign me up|send me|email me|text me|notify|updates|remember me|save (?:this|my)|keep me|allow|opt)\b/i;
export function consentLike(label: string): boolean {
  return CONSENT.test(label);
}

/** A select's value that is a prompt, not a choice: nothing is picked yet. */
const PROMPT = /^(?:|select\b.*|choose\b.*|please (?:select|choose)\b.*|pick\b.*|-+.*-*|month|day|year|—)$/i;

const label = (n: Node): string | null => fieldLabelText(n.label);

/** The controls of a window that a fill may propose a value for, in document order. Only empty ones: no box ticked, no option picked, no date set. */
/** Whether a node sits inside a web page's area of the window (its AXWebArea), where a combobox is a custom widget. */
export function inWebArea(w: WindowState, n: Node): boolean {
  for (let k = n.parent; k !== null; ) {
    const p = w.nodes.get(k);
    if (p === undefined) return false;
    if (p.role === "AXWebArea") return true;
    k = p.parent;
  }
  return false;
}

export function formControls(w: WindowState): FormControl[] {
  const nodes = [...w.nodes.values()];
  // In a browser window, only the page's controls: the toolbar's popups and the tab strip's radio buttons are the browser's own.
  const web = nodes.find((n) => n.role === "AXWebArea");
  const inPage = new Set<string>();
  if (web !== undefined) {
    inPage.add(web.key);
    for (const n of nodes) if (n.parent !== null && inPage.has(n.parent)) inPage.add(n.key);
  }
  const ok = (n: Node): boolean => (web === undefined || inPage.has(n.key)) && n.subrole !== "AXTabButton" && !n.states?.includes("disabled");
  const out: FormControl[] = [];
  const radios = new Map<string, Node[]>();
  for (const n of nodes) {
    if (!ok(n) || n.role !== "AXRadioButton") continue;
    const k = n.parent ?? n.key;
    radios.set(k, [...(radios.get(k) ?? []), n]);
  }
  for (const n of nodes) {
    if (!ok(n)) continue;
    const parent = n.parent === null ? undefined : w.nodes.get(n.parent);
    if (n.role === "AXRadioButton") {
      // A group is one control, placed where its first button is, so the list stays in document order.
      const g = radios.get(n.parent ?? n.key) ?? [];
      if (g[0] !== n || g.length < 2 || g.some((m) => m.states?.includes("checked") === true)) continue;
      out.push({ node: parent ?? n, control: "radio", label: parent === undefined ? null : label(parent), options: g.map((m) => (m.label ?? "").trim()), members: g });
      continue;
    }
    if (n.role === "AXCheckBox") {
      // Consent, certification and sign-up boxes are never ticked, so they are not asked about (plan section 4).
      if (n.states?.includes("checked") === true || consentLike(fieldLabelText(n.label) ?? "")) continue;
      out.push({ node: n, control: "checkbox", label: label(n), options: null, members: [] });
      continue;
    }
    if (n.role === "AXDateField" || n.role === "AXTimeField") {
      if ((n.value ?? "") !== "") continue;
      out.push({ node: n, control: n.role === "AXDateField" ? "date" : "time", label: label(n), options: null, members: [] });
      continue;
    }
    // A date or time field's own picker button is part of that field.
    if (n.role === "AXPopUpButton" && parent?.role !== "AXDateField" && parent?.role !== "AXTimeField") {
      if (!PROMPT.test((n.value ?? "").trim())) continue;
      const items = nodes.filter((m) => m.parent === n.key && m.role === "AXMenuItem").map((m) => (m.label ?? m.value ?? "").trim()).filter((t) => t !== "");
      const options = [...new Set(items)];
      out.push({ node: n, control: "select", label: label(n), options: options.length >= 2 ? options : null, members: [] });
    }
  }
  return out;
}

const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const wordsOf = (s: string): string[] => norm(s).split(/[^\p{L}\p{N}]+/u).filter((x) => x !== "");

/** The one option equal to the value, ignoring case and spacing; null when none is, or more than one. */
export function matchOption(options: readonly string[], value: string): string | null {
  const hits = options.filter((o) => norm(o) === norm(value));
  return hits.length === 1 ? (hits[0] as string) : null;
}

/**
 * The one option the text names, as whole words in order ("Large, mushroom and onion" names "Large"; "no
 * pets" names "No"); null when it names none or more than one, so the choice is the user's. An exact
 * match wins first.
 */
export function optionInText(options: readonly string[], text: string): string | null {
  const exact = matchOption(options, text);
  if (exact !== null) return exact;
  const t = ` ${wordsOf(text).join(" ")} `;
  const hits = options.filter((o) => {
    const w = wordsOf(o);
    return w.length > 0 && t.includes(` ${w.join(" ")} `);
  });
  return hits.length === 1 ? (hits[0] as string) : null;
}

const ROLE_NAMES: Record<FormControl["control"], string> = {
  combobox: "Dropdown",
  select: "Pop-up menu",
  radio: "Radio buttons",
  checkbox: "Checkbox",
  date: "Date field",
  time: "Time field",
};

/** The descriptor a question carries for a control: what it is, its label, its section, and the options it shows. */
export function describeControl(c: FormControl, section: string | null, nearest: string | null): string {
  const parts = [`${ROLE_NAMES[c.control]}.`];
  if (c.label !== null) parts.push(`Label: '${c.label}'.`);
  else if (nearest !== null) parts.push(`Nearest label: '${nearest}'.`);
  if (c.options !== null) parts.push(`Options: ${c.options.map((o) => `'${o}'`).join(", ")}.`);
  if (section !== null && section !== c.label) parts.push(`Section: '${section}'.`);
  return parts.join(" ");
}
