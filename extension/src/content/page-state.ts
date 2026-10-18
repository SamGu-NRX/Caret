// The content script's one copy of what it keeps per text control (content/revs.ts), shared by the walk (content.ts)
// and the acts (actions.ts, combobox.ts): change counters and origins, the page-held `before` of Caret's writes, and
// the compare budget. Nothing here is ever sent; the walk and the receipts send only what these say about a field.
import type { PageControlKind, Withheld } from "../shared/messages.ts";
import { CompareBudget, ChoiceRecords, Revs, WriteRecords, presence, withheldFor, type Origin } from "./revs.ts";
import { isTyping } from "./entry.ts";
import { composedParent } from "./shadow.ts";
import { historyDoubt } from "./password-watch.ts";
import { controlName } from "./question.ts";
import { deepActiveElement, kindOf, secretOf, shadowRootOf, textOf, type TextReading } from "./walker.ts";

export const revs = new Revs<Element>();
export const records = new WriteRecords<Element>();
export const compareBudget = new CompareBudget();

/** Whether the element is an `<input>`, the one kind `prefilled` and `programmatic` apply to. */
export const isInput = (el: Element): boolean => el instanceof HTMLInputElement;

/** A number input, or a text input whose inputmode is numeric or decimal: the page compares its text as a number. */
export function numericOf(el: Element): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  return el.type === "number" || (el.type === "text" && /^(numeric|decimal)$/i.test(el.getAttribute("inputmode")?.trim() ?? ""));
}

/** Whether the element is a password, card or one-time-code field (walker.ts secretOf), whose text is never read. */
export function isSecret(el: Element): boolean {
  return secretOf(el, controlName(el, kindOf(el) ?? "")) !== null;
}

/**
 * Reads a text control now: its text (for this frame only), its rev, its origin, and why it is withheld, if it is. A
 * secret field (`secret`: the walker marked it; or it is one now) is never read: nothing of it is kept, and it reads
 * as withheld with no text.
 */
export function readNow(el: Element, kind: PageControlKind, secret: boolean): { text: string; rev: number; origin: Origin; withheld: Withheld | null } {
  if (secret || isSecret(el)) {
    revs.forget(el);
    return { text: "", rev: 0, origin: "clean", withheld: "secret" };
  }
  const text = textOf(el, kind);
  const r = revs.read(el, text, isInput(el));
  return { text, rev: r.rev, origin: r.origin, withheld: withheldFor(historyDoubt(el), r.origin) };
}

/** What a walk sends for a text control (walker.ts walkControls readText). */
export function walkReading(el: Element, kind: PageControlKind, secret: boolean): TextReading {
  const now = readNow(el, kind, secret);
  const p = presence(now.text === "", now.rev, now.withheld);
  return now.withheld === null ? p : { ...p, withheld: now.withheld };
}

/** The editing host of a node inside a contenteditable region: its outermost contenteditable ancestor, or the element itself. */
export function editingHostOf(el: Element): Element {
  if (!(el instanceof HTMLElement) || !el.isContentEditable) return el;
  let host: HTMLElement = el;
  for (let p = el.parentElement; p !== null && p.isContentEditable; p = p.parentElement) host = p;
  return host;
}

/** What a trusted input event says of the text it left: the user's typing (`value`, the text now, for an input or textarea), or text from elsewhere. */
function inputSays(e: Event, value: string | null): { typed?: string; foreign?: true } {
  const inputType = e instanceof InputEvent ? e.inputType : "";
  if (!isTyping(inputType)) return { foreign: true };
  return value === null ? {} : { typed: value };
}

/**
 * Listens, from document_start, for the user's own edits of text controls: a trusted beforeinput, input, change, paste
 * or compositionend marks the control edited (content/revs.ts). beforeinput and paste give the text the edit starts
 * from, so a page's own earlier text in a field is still seen as `prefilled`, and a script's text between keystrokes as
 * not typed. An input event gives the text the user's typing left, read at the event, or marks text that came from
 * elsewhere (a paste, a drop, autofill, whose trusted input events carry no inputType). Capture on the window, passive:
 * this runs before the page's own handlers on the field.
 */
export function trackTrustedEdits(): void {
  const opts = { capture: true, passive: true } as const;
  const on = (e: Event): void => {
    if (!e.isTrusted) return;
    const t = e.composedPath()[0];
    if (!(t instanceof Element)) {
      const parent = t instanceof Node ? t.parentElement : null;
      if (parent !== null) revs.trusted(editingHostOf(parent), e.type === "input" ? inputSays(e, null) : {}, false);
      return;
    }
    // Seen from outside a closed shadow root, the target is its host: the field the user edits is the focused one inside.
    const inner = shadowRootOf(t) !== null ? (deepActiveElement() ?? t) : t;
    const el = editingHostOf(inner);
    // A secret field's text is never read, and what was kept of it before it turned secret is dropped.
    if (isSecret(el)) {
      revs.forget(el);
      return;
    }
    const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : null;
    const says = e.type === "input" ? inputSays(e, value) : (e.type === "beforeinput" || e.type === "paste") && value !== null ? { before: value } : {};
    revs.trusted(el, says, isInput(el));
  };
  for (const type of ["beforeinput", "input", "change", "paste", "compositionend"]) addEventListener(type, on, opts);
}

/** The trusted pointers, keys and clicks that touched each control without editing it, counted for a choice record's undo check (revs.ts). */
const touches = new WeakMap<Element, number>();

/** How many trusted pointers, keys and clicks have touched the control since this page began keeping choice records (revs.ts choiceCheck). */
export function touchCount(el: Element): number {
  return touches.get(el) ?? 0;
}

/**
 * The elements a recorded control stands for: its labels (a label forwards its click to the control), its aria-controls
 * and aria-owns targets (the list an option's click lands in), and the nearest element that holds the control and one
 * of those targets together (the widget's container, a chevron button included). A person re-picking a combobox's
 * choice touches these and none of them is the control itself, and the page's own script copies what they chose, so a
 * touch on any of them is a touch on the control (issue #54, the review of PR #58).
 */
const standsFor = new WeakMap<Element, Set<Element>>();

/** The nearest element that holds `a` and `b` both in the light DOM, or null when they share none. */
function commonAncestor(a: Element, b: Element): Element | null {
  const up = new Set<Element>();
  for (let n: Element | null = a; n !== null; n = n.parentElement) up.add(n);
  for (let n: Element | null = b; n !== null; n = n.parentElement) if (up.has(n)) return n;
  return null;
}

/** Every element a touch on stands for a touch on the control `el` (standsFor), computed at the pick. */
function affiliated(el: Element): Element[] {
  const out = new Set<Element>();
  const labels = (el as HTMLInputElement).labels;
  if (labels !== null && labels !== undefined) for (const l of labels) out.add(l);
  else {
    if (el.id !== "") for (const l of (el.getRootNode() as Document | ShadowRoot).querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)) out.add(l);
    const wrap = el.closest("label");
    if (wrap !== null) out.add(wrap);
  }
  const root = el.getRootNode() as Document | ShadowRoot;
  for (const id of `${el.getAttribute("aria-controls") ?? ""} ${el.getAttribute("aria-owns") ?? ""}`.split(/\s+/).filter(Boolean)) {
    const t = root.getElementById(id) ?? document.getElementById(id);
    if (t === null) continue;
    out.add(t);
    const box = commonAncestor(el, t);
    if (box !== null) out.add(box);
  }
  return [...out];
}
/** Nothing is counted until a choice record exists for some control, so pages Caret only reads stay untouched by the listener's walk. */
let anyChoiceRecorded = false;

/** The page's record of Caret's combobox picks, by task and the element picked (revs.ts ChoiceRecords). */
export const choices = new ChoiceRecords<Element>();

/**
 * Listens, from document_start, for the trusted events that touch a control without editing it: a pointer going down, a
 * key going down, a click. A person re-picking Caret's own option leaves the text — and so the rev and the edit
 * counters — exactly as Caret's pick left them, so the pick's record counts these touches too: the click that opens the
 * control's list is itself a trusted pointer, and a touch on the control's label, its list or its container stands for
 * a touch on the control (standsFor), since the page's own script copies what the person chose (issue #54). Caret's own
 * acts dispatch untrusted events only, which never count.
 */
export function trackTrustedTouches(): void {
  const on = (e: Event): void => {
    if (!anyChoiceRecorded || !e.isTrusted) return;
    const t = e.composedPath()[0];
    if (!(t instanceof Element)) return;
    // A touch counts for every recorded choice it could undo: on the event's target or anything above it, and on a
    // recorded control the element stands for (standsFor) — the label, the list, the container holding both.
    for (let n: Element | null = t; n !== null; n = composedParent(n)) {
      if (touches.has(n)) touches.set(n, (touches.get(n) ?? 0) + 1);
      for (const c of standsFor.get(n) ?? []) if (touches.has(c)) touches.set(c, (touches.get(c) ?? 0) + 1);
    }
  };
  for (const type of ["pointerdown", "mousedown", "keydown", "touchstart", "click"]) addEventListener(type, on, { capture: true, passive: true });
}

/** Begins the page-side record of a pick Caret is about to make, anchoring the control's trusted-event counts at this
 * moment and taking its affiliates' watch up (standsFor): a touch on them counts for this record's undo check (revs.ts). */
export function beginChoice(taskId: string, el: Element, wrote: string): void {
  if (!touches.has(el)) touches.set(el, 0);
  anyChoiceRecorded = true;
  for (const a of affiliated(el)) {
    let set = standsFor.get(a);
    if (set === undefined) {
      set = new Set();
      standsFor.set(a, set);
    }
    set.add(el);
  }
  choices.begin(taskId, el, wrote, revs.trustedCount(el), touches.get(el) ?? 0);
}
