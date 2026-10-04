// The content script's acts (memo section 1, write path), each run only after the worker's grant check and only
// before the deadline the worker passed (the command's expiry or the grant's, whichever is first).
//
// One eligibility check guards every act: the element is still the walked one (or strongly rebound) and connected,
// not excluded, the same kind and name, the page has not moved in history since the walk, and the deadline has not
// passed. It runs before anything is touched, again after focus (focus runs page handlers synchronously, which can
// change the field: W1 review #3), and again before each later stage. The page can still change the field between
// the last check and the setter's own line; nothing in a single-threaded page runs there.
//
// Text goes in through the prototype's value setter, which bypasses React's per-instance value tracker so its
// delegated input listener sees a real change, then input, change and blur. It is read twice: on the next frame after
// input, and on the next frame after blur, because React puts a controlled input back on its next render when its
// state did not take the value, and blur is the render most form libraries force. A value back at `before` is
// "the page kept the old value".
//
// Presses are hand-offs in v1, whatever the control is called: a page button runs the page's own script, so a safe
// name ("Next", or an aria-label over destructive text) is no evidence it sends nothing (W1 review #2; memo lead
// decision on buttons that send data).
import type { ActAnswer, ActVerb, WriteReadings } from "../shared/messages.ts";
import { classifyPress } from "../shared/risk.ts";
import type { Entry, Registry } from "./registry.ts";
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

type Mutating = Exclude<ActVerb, { kind: "pageChooseOption" | "pageAttachFile" | "pagePress" }>;

/** Why the act must not go on now, or null. */
function ineligible(el: Element, verb: ActVerb, entry: Entry | undefined, deadline: number): ActAnswer | null {
  if (!el.isConnected || el.ownerDocument !== document) return answer("stale", "the element left the document");
  if (entry !== undefined && entry.href !== location.href) return answer("stale", "the page's address changed since the walk");
  if (entry !== undefined && entry.histLen !== history.length) return answer("stale", "the page moved in history since the walk");
  const name = accessibleName(el);
  const excluded = exclusionOf(el, name);
  if (excluded !== null) return answer("excluded", `the control is one Caret never touches (${excluded})`);
  if (kindOf(el) !== verb.control) return answer("stale", `the element is now a ${String(kindOf(el))}, not a ${verb.control}`);
  if (name !== verb.name) return answer("stale", `the element is now named '${clean(name, 60)}', not '${clean(verb.name, 60)}'`);
  if (Date.now() >= deadline) return answer("notAllowed", "the grant or command expired");
  return null;
}

export async function act(reg: Registry, verb: ActVerb, deadline: number): Promise<ActAnswer> {
  if (verb.kind === "pageChooseOption" || verb.kind === "pageAttachFile") return answer("unsupported", `${verb.kind} arrives in batch 2`);
  if (verb.kind === "pagePress") {
    const risk = classifyPress(verb.name);
    return answer("handoff", `'${clean(verb.name, 60)}' runs the page's own script, so you press it`, { risk: risk === "safe" || risk === "unclassified" ? "pageScript" : risk });
  }
  const expect = verb.kind === "pageWrite" || verb.kind === "pageSelect" ? verb.expect : null;
  const r = reg.resolve(verb.id, expect);
  if ("missing" in r) return answer("noElement", r.missing);
  const entry = reg.entry(verb.id);
  const check = (): ActAnswer | null => ineligible(r.el, verb, entry, deadline);
  const first = check();
  if (first !== null) return first;
  const a = await actOn(r.el, verb, check);
  // A rebind is the one way an act reaches an element other than the walked object; the receipt says so.
  return r.rebound && (a.outcome === "ok" || a.outcome === "alreadyTrue") ? { ...a, detail: a.detail === null ? "rebound by its strong key" : `${a.detail}; rebound by its strong key` } : a;
}

async function actOn(el: Element, verb: Mutating, check: () => ActAnswer | null): Promise<ActAnswer> {
  const disabled = (el as HTMLInputElement).disabled === true || el.getAttribute("aria-disabled") === "true" || (el as HTMLInputElement).readOnly === true;
  switch (verb.kind) {
    case "pageWrite": {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return answer("unsupported", "only text inputs and text areas take a pageWrite in v1");
      const before = el.value;
      if (before === verb.value) return answer("alreadyTrue", null);
      if (before !== verb.expect) return answer("stale", "the field holds other text than when it was walked");
      if (disabled) return answer("failed", "the field is disabled or read-only");
      return writeValue(el, verb.value, before, verb.expect, check);
    }
    case "pageSelect": {
      if (!(el instanceof HTMLSelectElement)) return answer("unsupported", "only a native select takes a pageSelect; a custom listbox is pageChooseOption");
      const before = el.value;
      if (before === verb.value) return answer("alreadyTrue", null);
      if (before !== verb.expect) return answer("stale", "the select shows another option than when it was walked");
      if (![...el.options].some((o) => o.value === verb.value)) return answer("failed", "the select has no option with that value");
      if (disabled) return answer("failed", "the select is disabled");
      return writeValue(el, verb.value, before, verb.expect, check);
    }
    case "pageSetChecked": {
      const now = checkedOf(el);
      if (now === undefined) return answer("unsupported", "the element is not a checkbox or radio");
      if (now === verb.checked) return answer("alreadyTrue", null);
      if (!verb.checked && verb.control === "radio") return answer("unsupported", "a radio is cleared by choosing another one");
      if (disabled) return answer("failed", "the control is disabled");
      (el as HTMLElement).click();
      await settle();
      const after = checkedOf(el);
      return after === verb.checked ? answer("ok", null) : answer("failed", "the page kept the old state");
    }
  }
}

function setterFor(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): (v: string) => void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (set === undefined) throw new Error("no value setter on the prototype");
  return (v) => set.call(el, v);
}

const current = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string => (el instanceof HTMLSelectElement ? (el.selectedOptions[0]?.value ?? "") : el.value);

/**
 * Focus, recheck, set, input; read; recheck, change, blur; read. A recheck that fails after the value went in stops
 * there and reports `failed` with what the field holds, so the helper re-reads it rather than assuming nothing landed.
 */
async function writeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string, before: string, expect: string, check: () => ActAnswer | null): Promise<ActAnswer> {
  el.focus();
  const afterFocus = check();
  if (afterFocus !== null) return afterFocus;
  if (current(el) !== expect) return answer("stale", "the page changed the field when it took focus");
  setterFor(el)(value);
  el.dispatchEvent(el instanceof HTMLSelectElement ? new Event("input", { bubbles: true, composed: true }) : new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: value }));
  await settle();
  const afterInput = current(el);
  const midway = check();
  if (midway !== null) return answer("failed", `the write went in, then ${midway.detail ?? midway.outcome}; Caret stopped before change and blur`, { readings: { before, afterInput, afterBlur: afterInput, invalid: invalidNow(el), error: errorText(el) } });
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.blur();
  await settle();
  return judge({ before, afterInput, afterBlur: current(el), invalid: invalidNow(el), error: errorText(el) }, value);
}

/** The value must hold after blur, the reading that counts; the first reading is kept so a receipt can show a flicker. */
function judge(readings: WriteReadings, value: string): ActAnswer {
  if (readings.afterBlur === value) return answer("ok", null, { readings });
  if (readings.afterBlur === readings.before) return answer("failed", "the page kept the old value", { readings });
  return answer("failed", "the page holds another value than Caret wrote", { readings });
}
