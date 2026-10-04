// The controls-only walk (memo section 1, read path). It visits every element of the frame's document in order,
// descending into open shadow roots and closed ones through chrome.dom.openOrClosedShadowRoot, and keeps each
// visible interactive control with its name, kind, value, options, form and rect. Exclusions are decided here, by
// code, before anything leaves the frame: such controls are counted by reason and never named or read.
import type { PageControl, PageControlKind, PageExclusion, Rect } from "../shared/messages.ts";
import { authorIdentifier, isGeneratedId, strongKey } from "../shared/ids.ts";
import { accessibleName, clean, composedParent, groupNames } from "./names.ts";
import { flavorOf, shownValue } from "./flavor.ts";

export const MAX_CONTROLS = 1000;
const MAX_VALUE = 2000;
const MAX_OPTIONS = 200;

const CANDIDATE = "input, select, textarea, button, a[href], [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=combobox], [role=textbox], [contenteditable='' i], [contenteditable='true' i]";

/**
 * Self-identification and consent groups (memo: "consent and self-identification groups by label pattern"). These
 * are the user's to answer: demographic questions on job applications, and agreements.
 */
const SELF_IDENTIFICATION = /\b(self[- ]identif\w*|gender|sex|race|racial|ethnicity|hispanic|latin[oax]|veteran|disabilit(y|ies)|disabled|pronouns?|sexual orientation|transgender|consent|i agree|i accept|i acknowledge|i certify|terms (of|and) (service|use|conditions)|privacy policy|signature|e-?sign)\b/i;

/** Field names and ids that mark a card number or code even without autocomplete. */
const PAYMENT_NAME = /\b(card.?number|cc.?(num|number|csc|cvc|cvv)|cvc|cvv|csc|security.?code)\b/i;

/** An element's shadow root, open or closed. chrome.dom takes HTML elements only and throws on others (SVG). */
export function shadowRootOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot !== null) return el.shadowRoot;
  if (!(el instanceof HTMLElement) || typeof chrome === "undefined" || chrome.dom?.openOrClosedShadowRoot === undefined) return null;
  try {
    return (chrome.dom.openOrClosedShadowRoot(el) as ShadowRoot | null) ?? null;
  } catch {
    return null;
  }
}

/** The control kind of an element, or null when it is not one Caret reads. */
export function kindOf(el: Element): PageControlKind | null {
  const role = el.getAttribute("role");
  if (el instanceof HTMLInputElement) {
    switch (el.type) {
      case "text": return role === "combobox" ? "combobox" : "text";
      case "email": case "tel": case "url": case "number": case "search": case "date": case "time": case "month": case "week": case "range": case "color": case "file": case "checkbox": case "radio":
        return el.type;
      case "datetime-local": return "datetime";
      case "submit": case "button": case "reset": case "image": return "button";
      case "password": case "hidden": return "text"; // excluded before use; the kind only keeps the switch total
      default: return "text";
    }
  }
  if (el instanceof HTMLSelectElement) return "select";
  if (el instanceof HTMLTextAreaElement) return "textarea";
  if (el instanceof HTMLButtonElement) return "button";
  if (el instanceof HTMLAnchorElement && el.hasAttribute("href")) return role === "button" ? "button" : "link";
  switch (role) {
    case "button": return "button";
    case "link": return "link";
    case "checkbox": case "switch": return "checkbox";
    case "radio": return "radio";
    case "combobox": return "combobox";
    case "textbox": return "contenteditable";
  }
  if (el instanceof HTMLElement && el.isContentEditable) return "contenteditable";
  return null;
}

const IMPLIED_ROLE: Record<PageControlKind, string> = {
  text: "textbox", email: "textbox", tel: "textbox", url: "textbox", number: "spinbutton", search: "searchbox", date: "textbox", time: "textbox",
  datetime: "textbox", month: "textbox", week: "textbox", textarea: "textbox", select: "combobox", checkbox: "checkbox", radio: "radio",
  combobox: "combobox", button: "button", link: "link", file: "button", contenteditable: "textbox", range: "slider", color: "button",
};

function ariaHidden(el: Element): boolean {
  for (let n: Element | null = el; n !== null; n = composedParent(n)) {
    if (n.getAttribute("aria-hidden") === "true" || n.hasAttribute("inert")) return true;
  }
  return false;
}

/** Sensitive autocomplete tokens, on any control: a <select autocomplete="cc-exp-month"> is a card field too (W1 review #5). */
function autocompleteExclusion(el: Element): PageExclusion | null {
  const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  if (/(^|\s)cc-/.test(ac)) return "payment";
  if (/(^|\s)one-time-code(\s|$)/.test(ac)) return "oneTimeCode";
  return null;
}

/** Why a control must not leave the frame, or null. */
export function exclusionOf(el: Element, name: string): PageExclusion | null {
  if (el instanceof HTMLInputElement) {
    if (el.type === "hidden") return "hidden";
    if (el.type === "password") return "password";
  }
  const ac = autocompleteExclusion(el);
  if (ac !== null) return ac;
  if ((el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) && PAYMENT_NAME.test(`${el.name} ${el.id}`)) return "payment";
  if (ariaHidden(el)) return "ariaHidden";
  if (!visible(el) && !visibleReactSelect(el)) return "invisible";
  if (SELF_IDENTIFICATION.test(name) || groupNames(el).some((g) => SELF_IDENTIFICATION.test(g))) return "selfIdentification";
  return null;
}

/**
 * React-select makes its input transparent while the chip shows the chosen value; the control box, which holds both,
 * is what the user sees. So a react-select input counts as visible when its box does and the input itself is still
 * rendered with a size. Only the opacity rule is waived, and only inside a visible react-select box (W2).
 */
function visibleReactSelect(el: Element): boolean {
  if (el.getAttribute("role") !== "combobox" || !(el instanceof HTMLInputElement)) return false;
  const f = flavorOf(el);
  if (f.kind !== "reactSelect" || !visible(f.box)) return false;
  const r = el.getBoundingClientRect();
  return el.checkVisibility({ checkVisibilityCSS: true }) && r.width > 0 && r.height > 0;
}

/** A length in px or % of `size`, or null when it is neither. */
function length(v: string, size: number): number | null {
  const m = /^(-?[\d.]+)(px|%)?$/.exec(v.trim());
  if (m === null) return null;
  const n = Number(m[1]);
  return m[2] === "%" ? (n / 100) * size : n;
}

/**
 * A clip or clip-path that leaves nothing of a box `w` by `h`: clip: rect() with no area, clip-path: inset() whose
 * opposite sides meet (all four sides read, so inset(50% 0 0 0) keeps its lower half), a circle of radius 0, or a
 * polygon whose points are all one point.
 */
function clipsToNothing(cs: CSSStyleDeclaration, w: number, h: number): boolean {
  const rect = /rect\(\s*(-?[\d.]+)px[ ,]+(-?[\d.]+)px[ ,]+(-?[\d.]+)px[ ,]+(-?[\d.]+)px\s*\)/.exec(cs.clip);
  if (rect !== null) {
    const [top, right, bottom, left] = rect.slice(1, 5).map(Number) as [number, number, number, number];
    if (right - left <= 1 || bottom - top <= 1) return true;
  }
  const cp = cs.clipPath.trim();
  const inset = /^inset\(([^)]*?)(\s+round\b[^)]*)?\)$/.exec(cp);
  if (inset !== null) {
    const parts = (inset[1] ?? "").trim().split(/\s+/);
    const [t, r = t, b = t, l = r] = parts as [string, string?, string?, string?];
    const [tt, rr, bb, ll] = [length(t, h), length(r, w), length(b, h), length(l, w)];
    if (tt !== null && rr !== null && bb !== null && ll !== null && (tt + bb >= h - 1 || ll + rr >= w - 1)) return true;
  }
  if (/^circle\(\s*0(px|%)?(\s|\))/.test(cp)) return true;
  const poly = /^polygon\((.*)\)$/.exec(cp);
  if (poly !== null) {
    // Shoelace area of the points resolved against the box; a polygon of a pixel or less hides the element.
    const pts = (poly[1] ?? "").split(",").map((x) => x.trim().replace(/^(nonzero|evenodd)\s*/, "").split(/\s+/)).filter((x) => x.length === 2);
    const xy = pts.map(([x, y]) => [length(x ?? "", w), length(y ?? "", h)] as const);
    if (xy.length > 0 && xy.every(([x, y]) => x !== null && y !== null)) {
      let twice = 0;
      for (let i = 0; i < xy.length; i++) {
        const [x0, y0] = xy[i] as readonly [number, number];
        const [x1, y1] = xy[(i + 1) % xy.length] as readonly [number, number];
        twice += x0 * y1 - x1 * y0;
      }
      if (Math.abs(twice) / 2 <= 1) return true;
    }
  }
  return false;
}

/** The box clip-path and clip resolve against: the layout box before transforms, where the element has one. */
function clipBox(el: Element): [number, number] {
  if (el instanceof HTMLElement) return [el.offsetWidth, el.offsetHeight];
  const r = el.getBoundingClientRect();
  return [r.width, r.height];
}

/**
 * Something a person could see: rendered and not transparent (opacity counts: a field at opacity 0 is the hidden
 * field the memo forbids filling, W1 review #5), not clipped to nothing by its own clip or clip-path, not placed
 * outside everything the document can scroll to, and with more than one pixel each way left once every ancestor
 * with overflow hidden or clip has cut it (the visually-hidden pattern: a 1 px box, or a 1 px wrapper). A scrolling
 * ancestor (overflow auto or scroll) does not hide what it holds; the user can scroll to it.
 */
export function visible(el: Element): boolean {
  if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  const r = el.getBoundingClientRect();
  if (clipsToNothing(getComputedStyle(el), ...clipBox(el))) return false;
  const doc = document.documentElement;
  const left = r.left + window.scrollX;
  const top = r.top + window.scrollY;
  if (left + r.width <= 0 || top + r.height <= 0) return false;
  if (left >= Math.max(doc.scrollWidth, window.innerWidth) || top >= Math.max(doc.scrollHeight, window.innerHeight)) return false;
  let [x0, y0, x1, y1] = [r.left, r.top, r.right, r.bottom];
  for (let p = composedParent(el); p !== null && p !== doc; p = composedParent(p)) {
    const cs = getComputedStyle(p);
    const pb = p.getBoundingClientRect();
    if (clipsToNothing(cs, ...clipBox(p))) return false;
    const clips = (v: string): boolean => v === "hidden" || v === "clip";
    if (!clips(cs.overflowX) && !clips(cs.overflowY)) continue;
    if (clips(cs.overflowX)) [x0, x1] = [Math.max(x0, pb.left), Math.min(x1, pb.right)];
    if (clips(cs.overflowY)) [y0, y1] = [Math.max(y0, pb.top), Math.min(y1, pb.bottom)];
  }
  return x1 - x0 > 1 && y1 - y0 > 1;
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  const k = (n: number): number => Math.round(n * 10) / 10;
  return [k(r.x), k(r.y), k(r.width), k(r.height)];
}

/** The form identity a strong key uses: its author id or name, else its ordinal among the frame's forms. */
export function formIdentity(el: Element, forms: HTMLFormElement[] = [...document.forms]): string | null {
  const f = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el instanceof HTMLButtonElement ? el.form : el.closest("form");
  if (f === null) return null;
  for (const attr of ["id", "name"]) {
    const v = f.getAttribute(attr);
    if (v !== null && !isGeneratedId(v)) return `form#${v}`;
  }
  const i = forms.indexOf(f);
  return `form@${i < 0 ? "?" : i}`;
}

/** What the control holds as its value. A combobox's is the text it shows: react-select's chip, not its filter box. */
export function valueOf(el: Element): string | undefined {
  if (el.getAttribute("role") === "combobox" && !(el instanceof HTMLSelectElement)) return shownValue(el).slice(0, MAX_VALUE);
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio" || el.type === "file" || el.type === "submit" || el.type === "button" || el.type === "reset" || el.type === "image") return undefined;
    return el.value.slice(0, MAX_VALUE);
  }
  if (el instanceof HTMLTextAreaElement) return el.value.slice(0, MAX_VALUE);
  if (el instanceof HTMLSelectElement) return el.value;
  return undefined;
}

export function checkedOf(el: Element): boolean | undefined {
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return el.checked;
  const role = el.getAttribute("role");
  if (role === "checkbox" || role === "radio" || role === "switch") return el.getAttribute("aria-checked") === "true";
  return undefined;
}

export interface Found {
  el: Element;
  kind: PageControlKind;
  name: string;
  shadow: "open" | "closed" | undefined;
}

/** Every control of the document, shadow roots included, in document order, with its kind, name and shadow kind. */
export function* candidates(root: Document | ShadowRoot = document, shadow: "open" | "closed" | undefined = undefined): Generator<Found> {
  for (const el of root.querySelectorAll("*")) {
    if (el.matches(CANDIDATE)) {
      const kind = kindOf(el);
      if (kind !== null) yield { el, kind, name: accessibleName(el), shadow };
    }
    const sr = shadowRootOf(el);
    if (sr !== null) yield* candidates(sr, sr.mode);
  }
}

export interface WalkOutput {
  controls: PageControl[];
  excluded: Partial<Record<PageExclusion, number>>;
  truncated: boolean;
}

/**
 * Walks the document. `idOf` gives each kept element its registry id (the same element keeps its id across walks);
 * `onKept` sees each kept element with the control it became.
 */
export function walkControls(idOf: (el: Element) => string, onKept: (el: Element, c: PageControl) => void): WalkOutput {
  const origin = location.origin;
  const forms = [...document.forms];
  const controls: PageControl[] = [];
  const excluded: Partial<Record<PageExclusion, number>> = {};
  const ordinals = new Map<string, number>();
  let truncated = false;
  for (const f of candidates()) {
    const why = exclusionOf(f.el, f.name);
    if (why !== null) {
      excluded[why] = (excluded[why] ?? 0) + 1;
      continue;
    }
    if (controls.length >= MAX_CONTROLS) {
      truncated = true;
      break;
    }
    const role = f.el.getAttribute("role") ?? IMPLIED_ROLE[f.kind];
    const form = formIdentity(f.el, forms);
    const host = f.shadow === undefined ? null : (f.el.getRootNode() as ShadowRoot).host.localName;
    const scope = host ?? (form === null ? "" : form.startsWith("form#") ? `form[${form.slice(5)}]` : form);
    const base = `${scope === "" ? "" : `${scope}/`}${role}:${clean(f.name, 60).toLowerCase()}`;
    const ordinal = ordinals.get(base) ?? 0;
    ordinals.set(base, ordinal + 1);
    const ident = authorIdentifier({ name: f.el.getAttribute("name"), id: f.el.getAttribute("id"), automationId: f.el.getAttribute("data-automation-id") });
    const value = valueOf(f.el);
    const checked = checkedOf(f.el);
    const c: PageControl = {
      id: idOf(f.el),
      key: `${base}~${ordinal}`,
      strongKey: strongKey(origin, form, ident, f.kind),
      kind: f.kind,
      role,
      name: f.name,
      ...(value === undefined ? {} : { value }),
      ...(checked === undefined ? {} : { checked }),
      form,
      rect: rectOf(f.el),
    };
    if (f.el instanceof HTMLSelectElement) c.options = [...f.el.options].slice(0, MAX_OPTIONS).map((o) => ({ value: o.value, label: clean(o.label || o.text, 120), selected: o.selected }));
    if ((f.el as HTMLInputElement).required === true || f.el.getAttribute("aria-required") === "true") c.required = true;
    if ((f.el as HTMLInputElement).disabled === true || f.el.getAttribute("aria-disabled") === "true") c.disabled = true;
    if (f.el.getAttribute("aria-invalid") === "true") c.invalid = true;
    if (f.shadow !== undefined) c.shadow = f.shadow;
    controls.push(c);
    onKept(f.el, c);
  }
  return { controls, excluded, truncated };
}

/** The element with focus, looking through shadow roots, open or closed. */
export function deepActiveElement(): Element | null {
  let el: Element | null = document.activeElement;
  for (let i = 0; el !== null && i < 32; i++) {
    const sr = shadowRootOf(el);
    if (sr === null || sr.activeElement === null) break;
    el = sr.activeElement;
  }
  return el === document.body ? null : el;
}
