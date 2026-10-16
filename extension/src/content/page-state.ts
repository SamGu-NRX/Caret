// The content script's one copy of what it keeps per text control (content/revs.ts), shared by the walk (content.ts)
// and the acts (actions.ts, combobox.ts): change counters and origins, the page-held `before` of Caret's writes, and
// the compare budget. Nothing here is ever sent; the walk and the receipts send only what these say about a field.
import type { PageControlKind, Withheld } from "../shared/messages.ts";
import { CompareBudget, Revs, WriteRecords, presence, withheldFor } from "./revs.ts";
import { historyDoubt } from "./password-watch.ts";
import { textOf, type TextReading } from "./walker.ts";

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

/**
 * Reads a text control now: its text (for this frame only), its rev, and why it is withheld, if it is. `secret`: the
 * walker marked it (a password, card or one-time-code field), which withholds everything.
 */
export function readNow(el: Element, kind: PageControlKind, secret: boolean): { text: string; rev: number; withheld: Withheld | null } {
  const text = textOf(el, kind);
  const r = revs.read(el, text, isInput(el));
  const withheld: Withheld | null = secret ? "secret" : withheldFor(historyDoubt(el), r.origin);
  return { text, rev: r.rev, withheld };
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

/**
 * Listens, from document_start, for the user's own edits of text controls: a trusted beforeinput, input, change, paste
 * or compositionend bumps the control's rev (content/revs.ts). beforeinput first reads the text the edit starts from,
 * so a page's own earlier text in a field is still seen as `prefilled`. Capture on the window, passive.
 */
export function trackTrustedEdits(): void {
  const opts = { capture: true, passive: true } as const;
  const on = (e: Event): void => {
    if (!e.isTrusted) return;
    const t = e.composedPath()[0];
    if (!(t instanceof Element)) {
      const parent = t instanceof Node ? t.parentElement : null;
      if (parent !== null) revs.trusted(editingHostOf(parent), null, false);
      return;
    }
    const el = editingHostOf(t);
    const before = e.type === "beforeinput" && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ? el.value : null;
    revs.trusted(el, before, isInput(el));
  };
  for (const type of ["beforeinput", "input", "change", "paste", "compositionend"]) addEventListener(type, on, opts);
}
