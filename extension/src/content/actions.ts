// The content script's acts (memo section 1, write path), each run only after the worker's grant check and only
// before the deadline the worker passed (the command's expiry or the grant's, whichever is first). Before touching
// the element the script rechecks it itself: alive or strongly rebound, still visible and not excluded, the same
// kind and name, the same URL as when walked, and holding the value the helper expects.
//
// Text goes in through the prototype's value setter, which bypasses React's per-instance value tracker so its
// delegated input listener sees a real change, then input, change and blur. It is read twice: on the next frame after
// input, and on the next frame after blur, because React puts a controlled input back on its next render when its
// state did not take the value, and blur is the render most form libraries force. A value back at `before` is
// "the page kept the old value".
import type { ActAnswer, ActVerb, WriteReadings } from "../shared/messages.ts";
import { classifyPress } from "../shared/risk.ts";
import type { Registry } from "./registry.ts";
import { accessibleName, clean } from "./names.ts";
import { checkedOf, exclusionOf, kindOf } from "./walker.ts";

const answer = (outcome: ActAnswer["outcome"], detail: string | null, extra: Partial<ActAnswer> = {}): ActAnswer => ({ outcome, detail, ...extra });

/** The next animation frame, or 100 ms in a tab that paints no frames (background tabs pause rAF), then one task. */
function settle(): Promise<void> {
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

function errorText(el: Element): string | null {
  const ids = [el.getAttribute("aria-errormessage"), el.getAttribute("aria-describedby")].filter((s): s is string => s !== null).join(" ");
  if (ids === "") return null;
  const root = el.getRootNode() as Document | ShadowRoot;
  const t = clean(ids.split(/\s+/).map((id) => root.getElementById(id)?.textContent ?? "").join(" "), 200);
  return t === "" ? null : t;
}

function invalidNow(el: Element): boolean {
  return el.getAttribute("aria-invalid") === "true" || ((el as HTMLInputElement).validity !== undefined && !(el as HTMLInputElement).validity.valid);
}

/** Does pressing it send the form? A submit button, an image input, or a button with no type inside a form. */
export function submitsForm(el: Element): boolean {
  if (el instanceof HTMLInputElement) return (el.type === "submit" || el.type === "image") && el.form !== null;
  if (el instanceof HTMLButtonElement) return el.type === "submit" && el.form !== null;
  return false;
}

export async function act(reg: Registry, verb: ActVerb, deadline: number): Promise<ActAnswer> {
  if (verb.kind === "pageChooseOption" || verb.kind === "pageAttachFile") return answer("unsupported", `${verb.kind} arrives in batch 2`);
  const expect = verb.kind === "pageWrite" || verb.kind === "pageSelect" ? verb.expect : null;
  const r = reg.resolve(verb.id, expect);
  if ("missing" in r) return answer("noElement", r.missing);
  const el = r.el;
  const entry = reg.entry(verb.id);
  if (entry !== undefined && entry.href !== location.href) return answer("stale", "the page's address changed since the walk");
  const name = accessibleName(el);
  const excluded = exclusionOf(el, name);
  if (excluded !== null) return answer("excluded", `the control is one Caret never touches (${excluded})`);
  if (kindOf(el) !== verb.control) return answer("stale", `the element is now a ${String(kindOf(el))}, not a ${verb.control}`);
  if (name !== verb.name) return answer("stale", `the element is now named '${clean(name, 60)}', not '${clean(verb.name, 60)}'`);
  const disabled = (el as HTMLInputElement).disabled === true || el.getAttribute("aria-disabled") === "true" || (el as HTMLInputElement).readOnly === true;

  switch (verb.kind) {
    case "pageWrite": {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return answer("unsupported", "only text inputs and text areas take a pageWrite in v1");
      const before = el.value;
      if (before === verb.value) return answer("alreadyTrue", null);
      if (before !== verb.expect) return answer("stale", "the field holds other text than when it was walked");
      if (disabled) return answer("failed", "the field is disabled or read-only");
      if (Date.now() >= deadline) return answer("notAllowed", "the grant or command expired before the write");
      return writeText(el, verb.value, before);
    }
    case "pageSelect": {
      if (!(el instanceof HTMLSelectElement)) return answer("unsupported", "only a native select takes a pageSelect; a custom listbox is pageChooseOption");
      const before = el.value;
      if (before === verb.value) return answer("alreadyTrue", null);
      if (before !== verb.expect) return answer("stale", "the select shows another option than when it was walked");
      if (![...el.options].some((o) => o.value === verb.value)) return answer("failed", "the select has no option with that value");
      if (disabled) return answer("failed", "the select is disabled");
      if (Date.now() >= deadline) return answer("notAllowed", "the grant or command expired before the write");
      return writeSelect(el, verb.value, before);
    }
    case "pageSetChecked": {
      const now = checkedOf(el);
      if (now === undefined) return answer("unsupported", "the element is not a checkbox or radio");
      if (now === verb.checked) return answer("alreadyTrue", null);
      if (!verb.checked && verb.control === "radio") return answer("unsupported", "a radio is cleared by choosing another one");
      if (disabled) return answer("failed", "the control is disabled");
      if (Date.now() >= deadline) return answer("notAllowed", "the grant or command expired before the click");
      (el as HTMLElement).click();
      await settle();
      const after = checkedOf(el);
      return after === verb.checked ? answer("ok", null) : answer("failed", "the page kept the old state");
    }
    case "pagePress": {
      const risk = classifyPress(name);
      if (risk !== "safe") return answer("handoff", `'${clean(name, 60)}' is left to you`, { risk });
      if (submitsForm(el)) return answer("handoff", `'${clean(name, 60)}' sends the form; you press it`, { risk: "submitsForm" });
      if (disabled) return answer("failed", "the control is disabled");
      if (Date.now() >= deadline) return answer("notAllowed", "the grant or command expired before the press");
      (el as HTMLElement).click();
      return answer("ok", "pressed");
    }
  }
}

function setterFor(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): (v: string) => void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (set === undefined) throw new Error("no value setter on the prototype");
  return (v) => set.call(el, v);
}

async function writeText(el: HTMLInputElement | HTMLTextAreaElement, value: string, before: string): Promise<ActAnswer> {
  el.focus();
  setterFor(el)(value);
  el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: value }));
  await settle();
  const afterInput = el.value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.blur();
  await settle();
  return judge({ before, afterInput, afterBlur: el.value, invalid: invalidNow(el), error: errorText(el) }, value);
}

async function writeSelect(el: HTMLSelectElement, value: string, before: string): Promise<ActAnswer> {
  el.focus();
  setterFor(el)(value);
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  const afterInput = el.selectedOptions[0]?.value ?? "";
  el.blur();
  await settle();
  return judge({ before, afterInput, afterBlur: el.selectedOptions[0]?.value ?? "", invalid: invalidNow(el), error: errorText(el) }, value);
}

/** The value must hold after blur, the reading that counts; the first reading is kept so a receipt can show a flicker. */
function judge(readings: WriteReadings, value: string): ActAnswer {
  if (readings.afterBlur === value) return answer("ok", null, { readings });
  if (readings.afterBlur === readings.before) return answer("failed", "the page kept the old value", { readings });
  return answer("failed", "the page holds another value than Caret wrote", { readings });
}
