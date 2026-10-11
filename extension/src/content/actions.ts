// The content script's acts (memo section 1, write path), each run only after the worker's grant check and only
// before the deadline the worker passed (the command's expiry or the grant's, whichever is first).
//
// One eligibility check guards every act: the element is still the walked one (or strongly rebound) and connected,
// not excluded, the same kind and name, the page has not moved in history since the walk, and the deadline has not
// passed. It runs before anything is touched, again after focus (focus runs page handlers synchronously, which can
// change the field: W1 review #3), and again before each later stage. The page can still change the field between
// the last check and the setter's own line; nothing in a single-threaded page runs there.
//
// Every stage boundary of a text, select or checkbox write also asks the worker whether the task's grant still
// covers this frame (W3), as the combobox handler does: after focus and before the value goes in, before change,
// and before blur. A page handler that runs long on focus or input is where a revoke can land mid-write. A grant
// that ended before the value went in stops the write untouched (notAllowed); after it went in, the write stops
// there and reports `failed` with no readings, which the helper treats as "may have landed" and records for undo.
//
// Text goes in through the prototype's value setter, which bypasses React's per-instance value tracker so its
// delegated input listener sees a real change, then input, change and blur. It is read twice: on the next frame after
// input, and on the next frame after blur, because React puts a controlled input back on its next render when its
// state did not take the value, and blur is the render most form libraries force. A value back at `before` is
// "the page kept the old value".
//
// Presses are hand-offs in v1, whatever the control is called: a page button runs the page's own script, so a safe
// name ("Next", or an aria-label over destructive text) is no evidence it sends nothing (W1 review #2; memo lead
// decision on buttons that send data). The exceptions are the combobox handler (combobox.ts), which presses only
// the control it was given and that control's own listbox options, and verifies the pick; and (W4) one option of a
// Yes/No question built from toggle buttons (press.ts), which the page must show pressed afterwards.
import type { ActAnswer, ActVerb, WriteReadings } from "../shared/messages.ts";
import { classifyPress } from "../shared/risk.ts";
import { navigationEntry, type Entry, type Registry } from "./registry.ts";
import { clean } from "./names.ts";
import { controlName } from "./question.ts";
import { checkedOf, exclusionOf, kindOf } from "./walker.ts";
import { errorText, invalidNow, setterFor, settle } from "./dom.ts";
import { chooseOption } from "./combobox.ts";
import { pressOption } from "./press.ts";
import { attachFile } from "./attach.ts";
import { insertAtCaret } from "./insert.ts";

const answer = (outcome: ActAnswer["outcome"], detail: string | null, extra: Partial<ActAnswer> = {}): ActAnswer => ({ outcome, detail, ...extra });

type Mutating = Exclude<ActVerb, { kind: "pageChooseOption" | "pageAttachFile" | "pagePress" | "pageInsertText" }>;

/** Why the act must not go on now, or null. */
function ineligible(el: Element, verb: ActVerb, entry: Entry | undefined, deadline: number, opts: { name: boolean } = { name: true }): ActAnswer | null {
  if (!el.isConnected || el.ownerDocument !== document) return answer("stale", "the element left the document");
  if (entry !== undefined && entry.href !== location.href) return answer("stale", "the page's address changed since the walk");
  if (entry !== undefined && entry.nav !== navigationEntry()) return answer("stale", "the page moved in history since the walk");
  const name = controlName(el, kindOf(el) ?? "");
  const excluded = exclusionOf(el, name);
  if (excluded !== null) return answer("excluded", `the control is one Caret never touches (${excluded})`);
  if (kindOf(el) !== verb.control) return answer("stale", `the element is now a ${String(kindOf(el))}, not a ${verb.control}`);
  if (opts.name && name !== verb.name) return answer("stale", `the element is now named '${clean(name, 60)}', not '${clean(verb.name, 60)}'`);
  if (Date.now() >= deadline) return answer("notAllowed", "the grant or command expired");
  return null;
}

/**
 * Runs one verb the worker has checked. `alive` asks the worker whether the task's grant for this frame still holds;
 * the multi-stage acts (combobox, attach) ask it before each stage (memo section 2).
 */
export async function act(reg: Registry, verb: ActVerb, deadline: number, alive: () => Promise<boolean>): Promise<ActAnswer> {
  if (verb.kind === "pagePress") {
    const risk = classifyPress(verb.name);
    return answer("handoff", `'${clean(verb.name, 60)}' runs the page's own script, so you press it`, { risk: risk === "safe" || risk === "unclassified" ? "pageScript" : risk });
  }
  const expect = verb.kind === "pageWrite" || verb.kind === "pageSelect" || verb.kind === "pageChooseOption" ? verb.expect : null;
  // P4: an insert goes only to the element the walk kept when the offer was made, never to one rebound by its strong key.
  const r = reg.resolve(verb.id, expect, verb.rebind !== false && verb.kind !== "pageInsertText");
  if ("missing" in r) return answer(r.replaced && verb.rebind === false ? "notSameElement" : "noElement", r.missing);
  // An undo reaches only the object its write reached: the one kept under its mark, alive in this document (W3 review #2).
  if (verb.sameAs !== undefined && reg.marked(verb.sameAs) !== r.el) {
    return answer("notSameElement", reg.marked(verb.sameAs) === null ? "this page keeps no element under the undo's mark (it was replaced, or the page reloaded)" : "the element at this place is not the one Caret wrote");
  }
  const entry = reg.entry(verb.id);
  const check = (): ActAnswer | null => ineligible(r.el, verb, entry, deadline);
  const first = check();
  if (first !== null) return first;
  // Kept before anything is touched, so an act that stops midway ("may have landed") can still be undone on it.
  if (verb.mark !== undefined) reg.mark(verb.mark, r.el);
  let a: ActAnswer;
  if (verb.kind === "pageChooseOption") {
    a = verb.control === "combobox" ? await chooseOption(r.el, verb, check, alive) : verb.control === "button" ? await pressOption(r.el, verb, check, alive) : answer("unsupported", `a ${verb.control} is not a custom listbox; a native select takes pageSelect`);
  } else if (verb.kind === "pageInsertText") {
    a = await insertAtCaret(r.el, verb, gateWith(alive, check));
  } else if (verb.kind === "pageAttachFile") {
    // Once the file is in, an upload widget often writes its name or a status line into the field's label (Lever,
    // Ashby): after that point the name may change and the element is still the one Caret wrote (W4 review #6).
    a = await attachFile(r.el, verb, check, alive, () => ineligible(r.el, verb, entry, deadline, { name: false }));
  } else {
    a = await actOn(r.el, verb, check, alive);
  }
  // A rebind is the one way an act reaches an element other than the walked object; the receipt says so.
  return r.rebound && (a.outcome === "ok" || a.outcome === "alreadyTrue") ? { ...a, detail: a.detail === null ? "rebound by its strong key" : `${a.detail}; rebound by its strong key` } : a;
}

/** A stage boundary: the task's grant still covers the frame (asked of the worker), then the element is still eligible. */
type Gate = (stage: string) => Promise<ActAnswer | null>;

/** The stop, if any, with the stage it came at in its detail. */
function gateWith(alive: () => Promise<boolean>, check: () => ActAnswer | null): Gate {
  return async (stage) => {
    const stop = (await alive()) ? check() : answer("notAllowed", "the task's grant ended");
    return stop === null ? null : { ...stop, detail: `${stop.detail ?? stop.outcome} (${stage})` };
  };
}

async function actOn(el: Element, verb: Mutating, check: () => ActAnswer | null, alive: () => Promise<boolean>): Promise<ActAnswer> {
  // :disabled also covers a control in a disabled <fieldset> and an option in a disabled <optgroup> (W3 second review #4).
  const locked = (): boolean => el.matches(":disabled") || el.getAttribute("aria-disabled") === "true" || (el as HTMLInputElement).readOnly === true;
  const disabled = locked();
  // Every gate also asks again whether the field still takes the value: a focus handler, or page code running while a
  // gate awaits the worker, can disable it, make a select take several choices, or remove or disable the option (W3 review #9).
  const optionOk = (): boolean => verb.kind !== "pageSelect" || !(el instanceof HTMLSelectElement) || [...el.options].some((o) => o.value === verb.value && !o.matches(":disabled"));
  const multiple = (): boolean => el instanceof HTMLSelectElement && el.multiple;
  const checkWrite = (): ActAnswer | null =>
    check() ?? (locked() ? answer("failed", "the field became disabled or read-only") : multiple() ? answer("unsupported", "the select now takes several choices") : !optionOk() ? answer("failed", "the option is gone or disabled") : null);
  const gate = gateWith(alive, checkWrite);
  switch (verb.kind) {
    case "pageWrite": {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return answer("unsupported", "only text inputs and text areas take a pageWrite in v1");
      const before = el.value;
      if (before === verb.value) return answer("alreadyTrue", null);
      if (before !== verb.expect) return answer("stale", "the field holds other text than when it was walked");
      if (disabled) return answer("failed", "the field is disabled or read-only");
      return writeValue(el, verb.value, before, verb.expect, check, gate);
    }
    case "pageSelect": {
      if (!(el instanceof HTMLSelectElement)) return answer("unsupported", "only a native select takes a pageSelect; a custom listbox is pageChooseOption");
      // One value cannot say which of several selections to keep, and undo could not put them all back (W3 review #7).
      if (multiple()) return answer("unsupported", "a list that holds several choices is yours to set; Caret writes one value");
      const before = el.value;
      if (before === verb.value) return answer("alreadyTrue", null);
      if (before !== verb.expect) return answer("stale", "the select shows another option than when it was walked");
      if (!optionOk()) return answer("failed", "the select has no enabled option with that value");
      if (disabled) return answer("failed", "the select is disabled");
      return writeValue(el, verb.value, before, verb.expect, check, gate);
    }
    case "pageSetChecked": {
      const now = checkedOf(el);
      if (now === undefined) return answer("unsupported", "the element is not a checkbox or radio");
      if (now === verb.checked) return answer("alreadyTrue", null);
      if (!verb.checked && verb.control === "radio") {
        // D2-04: a click never clears a radio, so the one way back to no choice is the undo of Caret's own pick, on the
        // very button it checked (sameAs, already required above), and only for a native radio: an ARIA radio's checked
        // state is the page's own script's to change.
        if (verb.sameAs === undefined) return answer("unsupported", "a radio is cleared by choosing another one");
        if (!(el instanceof HTMLInputElement) || el.type !== "radio") return answer("unsupported", "Caret clears only a native radio button it checked itself");
        if (disabled) return answer("failed", "the control is disabled");
        return clearRadio(el, gate);
      }
      if (disabled) return answer("failed", "the control is disabled");
      // D2-04 review: Caret checks a radio only in a choice that is still unanswered, read at each stage; the user's own
      // answer made since the walk is never overwritten.
      const answered = (): boolean => verb.control === "radio" && verb.checked && otherChecked(el);
      if (answered()) return answer("stale", "another answer of this choice is checked now");
      // Focus first, as a real click does, so a page that reacts to focus does so before the grant is asked again.
      (el as HTMLElement).focus();
      const ready = await gate("after focus, before the click");
      if (ready !== null) return ready;
      if (checkedOf(el) === verb.checked) return answer("alreadyTrue", null);
      if (answered()) return answer("stale", "another answer of this choice was checked when it took focus");
      (el as HTMLElement).click();
      await settle();
      const after = checkedOf(el);
      return after === verb.checked ? answer("ok", null) : answer("failed", "the page kept the old state");
    }
  }
}


/**
 * Whether another button of the radio's own choice is checked: a native radio's same-named buttons in its form (or its
 * root, outside one), or an ARIA radio's siblings in its radiogroup.
 */
function otherChecked(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type === "radio") {
    if (el.name === "") return false;
    // The whole tree, filtered by form owner: a peer outside the form element can belong to it by its form attribute
    // (D2-04 second review), and one in another form is another choice.
    const root = el.getRootNode() as Document | ShadowRoot;
    const peers = [...root.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)].filter((x) => x !== el && (x as HTMLInputElement).form === el.form);
    return peers.some((x) => (x as HTMLInputElement).checked);
  }
  const group = el.closest('[role="radiogroup"]');
  return group !== null && [...group.querySelectorAll('[role="radio"]')].some((x) => x !== el && x.getAttribute("aria-checked") === "true");
}

/**
 * The undo of a radio pick (D2-04): the checked setter, then input and change, as a framework's listeners expect after
 * a change; read on the next frame. A page whose own state put the button back (a controlled React radio) reads as
 * "the page kept the old state", which the helper reports as not restored.
 */
async function clearRadio(el: HTMLInputElement, gate: Gate): Promise<ActAnswer> {
  const ready = await gate("before the radio was cleared");
  if (ready !== null) return ready;
  if (!el.checked) return answer("alreadyTrue", null);
  (Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set as (this: HTMLInputElement, v: boolean) => void).call(el, false);
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  return checkedOf(el) === false ? answer("ok", null) : answer("failed", "the page kept the old state");
}

const current = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string => (el instanceof HTMLSelectElement ? (el.selectedOptions[0]?.value ?? "") : el.value);

/**
 * Focus, gate, set, input; read; gate, change, gate, blur; recheck, read. A gate or recheck that fails after the value
 * went in stops there and reports `failed` without readings: the field may now be one Caret never reads (a handler
 * can turn it into a password field), so no value of it leaves the frame, and the helper re-reads the page instead
 * of assuming nothing landed (W1 review, round 2, #3). A grant that ended is one such stop (W3).
 */
async function writeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string, before: string, expect: string, check: () => ActAnswer | null, gate: Gate): Promise<ActAnswer> {
  el.focus();
  const afterFocus = await gate("after focus, before the value went in");
  if (afterFocus !== null) return afterFocus;
  if (current(el) !== expect) return answer("stale", "the page changed the field when it took focus");
  setterFor(el)(value);
  el.dispatchEvent(el instanceof HTMLSelectElement ? new Event("input", { bubbles: true, composed: true }) : new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: value }));
  await settle();
  const stopped = (why: ActAnswer): ActAnswer => answer("failed", `the write went in, then ${why.detail ?? why.outcome}; Caret stopped there`);
  const midway = await gate("after input, before change");
  if (midway !== null) return stopped(midway);
  const afterInput = current(el);
  el.dispatchEvent(new Event("change", { bubbles: true }));
  const afterChange = await gate("after change, before blur");
  if (afterChange !== null) return stopped(afterChange);
  el.blur();
  await settle();
  const end = check();
  if (end !== null) return stopped({ ...end, detail: `${end.detail ?? end.outcome} (after blur)` });
  return judge({ before, afterInput, afterBlur: current(el), invalid: invalidNow(el), error: errorText(el) }, value);
}

/** The value must hold after blur, the reading that counts; the first reading is kept so a receipt can show a flicker. */
function judge(readings: WriteReadings, value: string): ActAnswer {
  if (readings.afterBlur === value) return answer("ok", null, { readings });
  if (readings.afterBlur === readings.before) return answer("failed", "the page kept the old value", { readings });
  return answer("failed", "the page holds another value than Caret wrote", { readings });
}
