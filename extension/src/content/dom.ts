// Small DOM pieces every act uses: waiting a frame, the prototype value setter, what the page says about a field
// after an act, and synthetic pointer, mouse, key and drag events. Only the act modules dispatch events, and only on
// the elements their own rules allow (actions.ts, combobox.ts, attach.ts).
import { clean } from "./names.ts";
import { safeText } from "./secret-dom.ts";

/** The next animation frame, or 100 ms in a tab that paints no frames (background tabs pause rAF), then one task. */
export function settle(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const go = (): void => {
      if (done) return;
      done = true;
      setTimeout(resolve, 0);
    };
    requestAnimationFrame(go);
    setTimeout(go, 100);
  });
}

/** Polls `read` after each settle until it returns non-null or `ms` pass; the last reading (or null) either way. */
export async function until<T>(read: () => T | null, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== null || Date.now() >= end) return v;
    await settle();
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** What the page says about `el` after an act: its error message and description, without any secret field they hold. */
export function errorText(el: Element): string | null {
  const ids = [el.getAttribute("aria-errormessage"), el.getAttribute("aria-describedby")].filter((s): s is string => s !== null).join(" ");
  if (ids === "") return null;
  const root = el.getRootNode() as Document | ShadowRoot;
  const t = clean(ids.split(/\s+/).map((id) => safeText(root.getElementById(id))).join(" "), 200);
  return t === "" ? null : t;
}

export function invalidNow(el: Element): boolean {
  return el.getAttribute("aria-invalid") === "true" || ((el as HTMLInputElement).validity !== undefined && !(el as HTMLInputElement).validity.valid);
}

export function setterFor(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): (v: string) => void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (set === undefined) throw new Error("no value setter on the prototype");
  return (v) => set.call(el, v);
}

/** Sets a text field through the prototype setter and says so with one input event, the way typing would. */
export function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  setterFor(el)(value);
  el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: value }));
}

function centre(el: Element): { clientX: number; clientY: number } {
  const r = el.getBoundingClientRect();
  return { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
}

/**
 * A primary-button press as a page sees one: pointerdown, mousedown, pointerup, mouseup, click, at the element's
 * centre. React-select opens on mousedown and picks on click; Radix-style menus open on pointerdown.
 */
export function pressEvents(el: Element): void {
  const at = centre(el);
  const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, ...at };
  el.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
  el.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
  el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));
}

/**
 * pressEvents for a toggle (W4, press.ts): pointerdown, mousedown, pointerup, mouseup, then `beforeClick` is asked again
 * (a page handler on the earlier events may have turned the button into a submit button or moved it into a form) and
 * only on true the click goes, with its default action cancelled by a listener of Caret's own on the button, so the
 * browser itself neither submits a form nor follows a link from it whatever the page did meanwhile. The page's own
 * click listeners still run. Returns whether the click went.
 */
export function pressToggle(el: Element, beforeClick: () => boolean): boolean {
  const at = centre(el);
  const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, ...at };
  el.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
  el.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
  if (!beforeClick()) return false;
  const cancel = (e: Event): void => e.preventDefault();
  el.addEventListener("click", cancel);
  try {
    el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));
  } finally {
    el.removeEventListener("click", cancel);
  }
  return true;
}

const KEY_CODES = { Escape: 27, Enter: 13, Backspace: 8 } as const;

/** keydown then keyup of one named key. */
export function keyEvents(el: Element, key: keyof typeof KEY_CODES): void {
  const init = { key, code: key, keyCode: KEY_CODES[key], which: KEY_CODES[key], bubbles: true, cancelable: true, composed: true };
  el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
}

/** A drag of `data` onto `el` that ends in a drop: dragenter, dragover, drop, the order a dropzone listens for. */
export function dropEvents(el: Element, data: DataTransfer): void {
  const base = { bubbles: true, cancelable: true, composed: true, dataTransfer: data, ...centre(el) };
  el.dispatchEvent(new DragEvent("dragenter", base));
  el.dispatchEvent(new DragEvent("dragover", base));
  el.dispatchEvent(new DragEvent("drop", base));
}
