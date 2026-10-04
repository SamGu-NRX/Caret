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
// The stages: open with a press on the control; find the listbox by aria-controls or aria-owns, else the one newly
// visible [role=listbox] anywhere in the document (portals and shadow roots included) that is shown to belong to the
// control, waiting up to 1.5 s; type the value as the filter through the native setter; read the visible
// [role=option] names; pick only when exactly one normalized name equals the value (shared/choose.ts), read again
// right before the click; then verify the control's shown text, react-select's hidden input, and
// aria-expanded=false, before and after blur. A stop puts the filter text back and closes the list, but only while
// the grant is alive and the control still eligible.
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

/** The elements that name a control: itself, its <label>s, and what its aria-labelledby resolves to in its own tree. */
function namingElements(el: Element): Set<Element> {
  const out = new Set<Element>([el]);
  const labels = (el as HTMLInputElement).labels;
  if (labels !== undefined && labels !== null) for (const l of labels) out.add(l);
  const root = el.getRootNode() as Document | ShadowRoot;
  for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/)) {
    const n = id === "" ? null : root.getElementById(id);
    if (n !== null) out.add(n);
  }
  return out;
}

/** The elements a listbox's aria-labelledby resolves to, in the listbox's own tree (ids are per tree, W2 review 2 #1). */
function labelledBy(lb: Element): Element[] {
  const root = lb.getRootNode() as Document | ShadowRoot;
  return (lb.getAttribute("aria-labelledby") ?? "").split(/\s+/).flatMap((id) => {
    const n = id === "" ? null : root.getElementById(id);
    return n === null ? [] : [n];
  });
}

/**
 * A listbox that became visible after the control opened and is shown to belong to it, when aria-controls and
 * aria-owns name none: it sits inside react-select's own container, its aria-labelledby resolves to the control or an
 * element that names the control, or the control's aria-activedescendant is one of its options. Exactly one such
 * listbox, or null: a list another widget opened is never taken for this control's (W2 review #1).
 */
function associatedNewListbox(el: Element, f: Flavor, before: ReadonlySet<Element>): Element | null {
  const names = namingElements(el);
  const active = el.getAttribute("aria-activedescendant");
  const activeEl = active === null || active === "" ? null : (el.getRootNode() as Document | ShadowRoot).getElementById(active);
  const found: Element[] = [];
  for (const lb of deepAll('[role="listbox"]')) {
    if (before.has(lb) || !visible(lb)) continue;
    const inside = f.kind === "reactSelect" && within(lb, f.container);
    const labelled = labelledBy(lb).some((n) => names.has(n));
    const holdsActive = activeEl !== null && within(activeEl, lb);
    if (inside || labelled || holdsActive) found.push(lb);
  }
  return found.length === 1 ? (found[0] as Element) : null;
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

  /**
   * Puts the filter text back, closes the list with Escape on the control, and blurs it, rechecking the control after
   * each step: a handler that makes it ineligible (a password field, gone, renamed) ends the tidying there (W2 review 2 #3).
   */
  const restore = async (): Promise<void> => {
    if (textField !== null && filterBefore !== null && textField.value !== filterBefore) {
      typeInto(textField, filterBefore);
      if (check() !== null) return;
    }
    if (expandedOf(el) === true) {
      assertOwned(el);
      keyEvents(el, "Escape");
      if (check() !== null) return;
    }
    (el as HTMLElement).blur();
    await settle();
  };
  /**
   * Stops after something was done (the list opened, a filter typed). The control is put back only while the grant
   * is alive and the control is still eligible; a revoked grant, an expiry, or a control that left or became one Caret
   * never touches is left exactly as it is (W2 review #3). Says what the control shows now, so a stop that left the
   * old value reads as "nothing landed" and any other as "may have landed".
   */
  const stopped = async (why: ActAnswer, stage: string, matches: string[] = []): Promise<ActAnswer> => {
    const tidy = why.outcome !== "notAllowed" && why.outcome !== "excluded" && (await alive()) && check() === null;
    if (tidy) await restore();
    const outcome = why.outcome === "notAllowed" ? "notAllowed" : "failed";
    const detail = `${why.detail ?? why.outcome} (${stage}); ${tidy ? "Caret put the control back and stopped" : "Caret stopped without touching the control again"}`;
    // No reading of a control that is no longer one Caret may read (it left, or turned into an excluded field): W1 review round 2, #3.
    if (check() !== null) return answer(outcome, detail, { choice: choice(matches) });
    const now = shownValue(el, f);
    return answer(outcome, detail, { readings: { before, afterInput: now, afterBlur: now, invalid: invalidNow(el), error: errorText(el) }, choice: choice(matches) });
  };
  const gate = async (stage: string): Promise<ActAnswer | null> => {
    if (!(await alive())) return answer("notAllowed", `the task's grant ended (before ${stage})`);
    return check();
  };
  /** After the pick went in: a stop leaves the control alone and reports no readings unless it is still eligible. */
  const afterPickStop = (why: ActAnswer, stage: string, pickName: string): ActAnswer =>
    answer(why.outcome === "notAllowed" ? "notAllowed" : "failed", `the pick went in, then ${why.detail ?? why.outcome} (${stage}); Caret stopped without touching the control again`, { choice: choice([pickName]) });

  // Stage 1: open.
  const g1 = await gate("opening the list");
  if (g1 !== null) return g1;
  const listsBefore = new Set([...deepAll('[role="listbox"]')].filter((lb) => visible(lb)));
  if (expandedOf(el) !== true) {
    press(f.kind === "reactSelect" ? f.box : el);
    // A real press focuses the control; a generic combobox often opens on focus alone.
    if (deepActiveElement() !== el && el instanceof HTMLElement) el.focus();
  }
  const findList = (): Element | null => namedListbox(el) ?? associatedNewListbox(el, f, listsBefore);
  listbox = await until(findList, LIST_WAIT_MS);
  if (listbox === null) return stopped(answer("failed", `no list that belongs to this control opened within ${LIST_WAIT_MS} ms`), "opening");
  const afterOpen = check();
  if (afterOpen !== null) return stopped(afterOpen, "after opening");

  // Stage 2: filter.
  const g2 = await gate("typing the filter");
  if (g2 !== null) return stopped(g2, "filtering");
  if (textField !== null && el.getAttribute("aria-autocomplete") !== "none") typeInto(textField, verb.value);
  const current = (): Element | null => (listbox = findList());
  const options = await settledOptions(current);
  const m = matchOptions(options, verb.value);
  const why = whyNoPick(m, verb.value);
  const named = (m.exact.length > 1 ? m.exact : m.partial).map((o) => o.name);
  if (why !== null) return stopped(answer("failed", why), "matching", named);
  const pick = m.exact[0] as Opt;

  // Stage 3: pick. The grant check awaits, so the list is read again after it: the same node must still be the one
  // visible, enabled option named the value (W2 review #5).
  const g3 = await gate("picking the option");
  if (g3 !== null) return stopped(g3, "picking", [pick.name]);
  const lbNow = current();
  const again = lbNow === null ? { exact: [], partial: [] } : matchOptions(optionsOf(lbNow), verb.value);
  if (again.exact.length !== 1 || again.exact[0]?.el !== pick.el) return stopped(answer("failed", "the list changed before the pick"), "picking", again.exact.map((o) => o.name));
  press(pick.el);
  const want = normalizeName(pick.name);
  await until(() => (normalizeName(shownValue(el, f)) === want ? true : null), PICK_WAIT_MS);
  // A list that stays open after a pick (a multi-select, or closeMenuOnSelect off) is closed with Escape on the control.
  if (expandedOf(el) === true) {
    const g4 = await gate("closing the list");
    if (g4 !== null) return afterPickStop(g4, "closing the list", pick.name);
    assertOwned(el);
    keyEvents(el, "Escape");
    await settle();
  }
  const afterPick = shownValue(el, f);

  // Stage 4: blur, then verify the shown text, the hidden input and aria-expanded.
  const g5 = await gate("blurring the control");
  if (g5 !== null) return afterPickStop(g5, "before blur", pick.name);
  (el as HTMLElement).blur();
  await settle();
  const end = check();
  if (end !== null) return afterPickStop(end, "after blur", pick.name);
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
