// pageChooseOption: the combobox handler (memo section 2, "Custom listbox and portals"), for the generic ARIA
// flavor and react-select.
//
// It presses, which W1's rule otherwise forbids (every page press is a hand-off). This is the one exception, and it
// is narrow: the handler dispatches pointer, mouse and key events only on the control the verb names (for
// react-select also its control box, the element that holds the input and owns its mousedown handler) and on that
// control's own listbox options; `assertOwned` refuses anything else, and every pick is verified afterwards. Each
// stage first asks the worker whether the task's grant is still alive and rechecks the element, so a revoke or a
// page change between stages stops it there.
//
// The stages: open with a press on the control; find the listbox by aria-controls or aria-owns, else the newest
// visible [role=listbox] anywhere in the document, portals and shadow roots included, waiting up to 1.5 s; type the
// value as the filter through the native setter; read the visible [role=option] names; pick only when exactly one
// normalized name equals the value (shared/choose.ts); click it; then verify the control's shown text, react-select's
// hidden input, and aria-expanded=false, before and after blur. A stop puts the filter text back and closes the list.
import type { ActAnswer, ActVerb, Choice } from "../shared/messages.ts";
import { matchOptions, normalizeName, whyNoPick } from "../shared/choose.ts";
import { accessibleName, clean, composedParent } from "./names.ts";
import { flavorOf, shownValue, type Flavor } from "./flavor.ts";
import { errorText, invalidNow, keyEvents, pressEvents, settle, typeInto, until } from "./dom.ts";
import { deepActiveElement, shadowRootOf, visible } from "./walker.ts";

/** How long the listbox may take to appear, and the options to settle after the filter. From the memo: 1.5 s. */
const LIST_WAIT_MS = 1500;
/** How long the pick may take to show in the control. Assumed: react-select shows it in the same task. */
const PICK_WAIT_MS = 1000;

type ChooseVerb = Extract<ActVerb, { kind: "pageChooseOption" }>;

/** React-select's hidden form input, read only inside the frame; null when the control has none. */
function hiddenValue(f: Flavor): string | null {
  if (f.kind !== "reactSelect") return null;
  const h = f.container.querySelector(':scope > input[type="hidden"], :scope > div > input[type="hidden"]');
  return h instanceof HTMLInputElement ? h.value : null;
}

function expandedOf(el: Element): boolean | null {
  const a = el.getAttribute("aria-expanded");
  return a === null ? null : a === "true";
}

/** Every element matching `selector` in the document and in every shadow root under it, open or closed, in tree order. */
function* deepAll(selector: string, root: Document | ShadowRoot | Element = document): Generator<Element> {
  for (const el of root.querySelectorAll("*")) {
    if (el.matches(selector)) yield el;
    const sr = shadowRootOf(el);
    if (sr !== null) yield* deepAll(selector, sr);
  }
}

/** Whether `inner` is `outer` or sits under it in the flat tree (through shadow roots and slots). */
function within(inner: Element, outer: Element): boolean {
  for (let n: Element | null = inner; n !== null; n = composedParent(n)) if (n === outer) return true;
  return false;
}

/** The listbox aria-controls or aria-owns names, resolved in the control's own tree and then the document. */
function namedListbox(el: Element): Element | null {
  const ids = `${el.getAttribute("aria-controls") ?? ""} ${el.getAttribute("aria-owns") ?? ""}`.split(/\s+/).filter(Boolean);
  const root = el.getRootNode() as Document | ShadowRoot;
  for (const id of ids) {
    const lb = root.getElementById(id) ?? document.getElementById(id);
    if (lb !== null && lb.getAttribute("role") === "listbox" && visible(lb)) return lb;
  }
  return null;
}

/** The newest visible listbox: the last in tree order of those that were not visible before the control opened. */
function newestListbox(before: ReadonlySet<Element>): Element | null {
  let found: Element | null = null;
  for (const lb of deepAll('[role="listbox"]')) if (!before.has(lb) && visible(lb)) found = lb;
  return found;
}

interface Opt {
  el: Element;
  name: string;
}

function optionsOf(listbox: Element): Opt[] {
  return [...deepAll('[role="option"]', listbox)].filter((o) => visible(o) && o.getAttribute("aria-disabled") !== "true").map((el) => ({ el, name: accessibleName(el) }));
}

/** Reads the options until two readings a settle apart agree and are not empty, or the wait ends. */
async function settledOptions(listbox: () => Element | null): Promise<Opt[]> {
  let last = "";
  const got = await until(() => {
    const lb = listbox();
    if (lb === null) return null;
    const opts = optionsOf(lb);
    const sig = opts.map((o) => o.name).join("\u0000");
    const same = opts.length > 0 && sig === last;
    last = sig;
    return same ? opts : null;
  }, LIST_WAIT_MS);
  if (got !== null) return got;
  const lb = listbox();
  return lb === null ? [] : optionsOf(lb);
}

export async function chooseOption(el: Element, verb: ChooseVerb, check: () => ActAnswer | null, alive: () => Promise<boolean>): Promise<ActAnswer> {
  const f = flavorOf(el);
  const choice = (matches: string[], extra: Partial<Choice> = {}): Choice => ({ flavor: f.kind, matches: matches.slice(0, 20), expanded: expandedOf(el), hiddenInput: hiddenValue(f) === null ? "none" : "unchanged", ...extra });
  const answer = (outcome: ActAnswer["outcome"], detail: string | null, extra: Partial<ActAnswer> = {}): ActAnswer => ({ outcome, detail, ...extra });
  const before = shownValue(el, f);
  if (before !== "" && normalizeName(before) === normalizeName(verb.value)) return answer("alreadyTrue", null, { choice: choice([before]) });
  if (before !== verb.expect) return answer("stale", "the control shows other text than when it was walked");
  if ((el as HTMLInputElement).disabled === true || el.getAttribute("aria-disabled") === "true" || el.getAttribute("aria-readonly") === "true") return answer("failed", "the control is disabled or read-only");
  const hiddenBefore = hiddenValue(f);
  const textField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
  const filterBefore = textField?.value ?? null;
  const owned = f.kind === "reactSelect" ? [el, f.box] : [el];
  let listbox: Element | null = null;
  /** Refuses any event target that is not the control, its box, or an option of the listbox this control opened. */
  const assertOwned = (target: Element): void => {
    if (owned.includes(target)) return;
    if (listbox !== null && target.getAttribute("role") === "option" && within(target, listbox)) return;
    throw new Error("the combobox handler refused to press an element it does not own");
  };
  const press = (target: Element): void => {
    assertOwned(target);
    pressEvents(target);
  };

  /** Puts the filter text back, closes the list with Escape on the control, and blurs it. */
  const restore = async (): Promise<void> => {
    if (textField !== null && filterBefore !== null && textField.value !== filterBefore) typeInto(textField, filterBefore);
    if (expandedOf(el) === true) {
      assertOwned(el);
      keyEvents(el, "Escape");
    }
    (el as HTMLElement).blur();
    await settle();
  };
  /**
   * Stops after something was done (the list opened, a filter typed): puts the control back and says what it shows
   * now, so a stop that left the old value reads as "nothing landed" and any other as "may have landed".
   */
  const stopped = async (why: ActAnswer, stage: string, matches: string[] = []): Promise<ActAnswer> => {
    // A grant that ended means no further touch at all, not even to tidy up: the list is left as it is.
    const revoked = why.outcome === "notAllowed";
    if (!revoked) await restore();
    const outcome = revoked ? "notAllowed" : "failed";
    const detail = `${why.detail ?? why.outcome} (${stage}); ${revoked ? "Caret stopped without touching the control again" : "Caret put the control back and stopped"}`;
    // No reading of a control that is no longer one Caret may read (it left, or turned into an excluded field): W1 review round 2, #3.
    if (check() !== null) return answer(outcome, detail, { choice: choice(matches) });
    const now = shownValue(el, f);
    return answer(outcome, detail, { readings: { before, afterInput: now, afterBlur: now, invalid: invalidNow(el), error: errorText(el) }, choice: choice(matches) });
  };
  const gate = async (stage: string): Promise<ActAnswer | null> => {
    if (!(await alive())) return answer("notAllowed", `the task's grant ended (before ${stage})`);
    return check();
  };

  // Stage 1: open.
  const g1 = await gate("opening the list");
  if (g1 !== null) return g1;
  const listsBefore = new Set([...deepAll('[role="listbox"]')].filter((lb) => visible(lb)));
  if (expandedOf(el) !== true) {
    press(f.kind === "reactSelect" ? f.box : el);
    // A real press focuses the control; a generic combobox often opens on focus alone.
    if (deepActiveElement() !== el && el instanceof HTMLElement) el.focus();
  }
  listbox = await until(() => namedListbox(el) ?? newestListbox(listsBefore), LIST_WAIT_MS);
  if (listbox === null) return stopped(answer("failed", `no list opened within ${LIST_WAIT_MS} ms`), "opening");
  const afterOpen = check();
  if (afterOpen !== null) return stopped(afterOpen, "after opening");

  // Stage 2: filter.
  const g2 = await gate("typing the filter");
  if (g2 !== null) return stopped(g2, "filtering");
  if (textField !== null && el.getAttribute("aria-autocomplete") !== "none") typeInto(textField, verb.value);
  const current = (): Element | null => {
    const named = namedListbox(el);
    if (named !== null) return (listbox = named);
    return listbox !== null && listbox.isConnected && visible(listbox) ? listbox : (listbox = newestListbox(listsBefore));
  };
  const options = await settledOptions(current);
  const m = matchOptions(options, verb.value);
  const why = whyNoPick(m, verb.value);
  const named = (m.exact.length > 1 ? m.exact : m.partial).map((o) => o.name);
  if (why !== null) return stopped(answer("failed", why), "matching", named);
  const pick = m.exact[0] as Opt;

  // Stage 3: pick.
  const g3 = await gate("picking the option");
  if (g3 !== null) return stopped(g3, "picking", [pick.name]);
  if (!pick.el.isConnected) return stopped(answer("failed", "the option left the list before the pick"), "picking", [pick.name]);
  press(pick.el);
  const want = normalizeName(pick.name);
  await until(() => (normalizeName(shownValue(el, f)) === want ? true : null), PICK_WAIT_MS);
  // A list that stays open after a pick (a multi-select, or closeMenuOnSelect off) is closed with Escape on the control.
  if (expandedOf(el) === true) {
    assertOwned(el);
    keyEvents(el, "Escape");
    await settle();
  }
  const afterPick = shownValue(el, f);
  const midway = check();
  if (midway !== null) return answer("failed", `the pick went in, then ${midway.detail ?? midway.outcome}; Caret stopped there`, { choice: choice([pick.name]) });

  // Stage 4: blur, then verify the shown text, the hidden input and aria-expanded.
  (el as HTMLElement).blur();
  await settle();
  const end = check();
  if (end !== null) return answer("failed", `the pick went in, then ${end.detail ?? end.outcome} (after blur); Caret stopped there`, { choice: choice([pick.name]) });
  const afterBlur = shownValue(el, f);
  const hiddenAfter = hiddenValue(f);
  const hiddenInput: Choice["hiddenInput"] = hiddenAfter === null ? "none" : hiddenAfter !== "" && hiddenAfter !== hiddenBefore ? "set" : "unchanged";
  const expanded = expandedOf(el);
  const readings = { before, afterInput: afterPick, afterBlur, invalid: invalidNow(el), error: errorText(el) };
  const result = { readings, choice: choice([pick.name], { expanded, hiddenInput }) };
  const problems: string[] = [];
  if (normalizeName(afterBlur) !== want) problems.push(afterBlur === before ? "the control kept its old value" : `the control shows '${clean(afterBlur, 60)}'`);
  if (hiddenInput === "unchanged") problems.push("react-select's form value did not change");
  if (expanded === true) problems.push("the list is still open");
  if (problems.length > 0) return answer("failed", problems.join("; "), result);
  return answer("ok", null, result);
}
