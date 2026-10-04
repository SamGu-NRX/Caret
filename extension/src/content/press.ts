// pageChooseOption on a press-group option (W4): answering a Yes/No question built from toggle buttons, as Ashby's are.
//
// This presses, which W1's rule otherwise forbids, so it is the second narrow exception beside the combobox handler,
// and it holds only when all of these do, read from the page at the moment of acting (question.ts pressGroup):
//   - the button is an option of one press group: 2 to 6 visible, enabled <button>s that are the element children of
//     one container holding no other visible control, each carrying aria-pressed "true" or "false";
//   - each option sends no form when pressed: type=button, or no type attribute and no form owner (Ashby's toggles
//     have no type attribute and no <form> around them, so the browser's own submit does nothing);
//   - the verb names the group's question (`question`, from the walk the plan was made on), and it is still the text
//     around the group, and it is not a self-identification or consent question (walker.exclusionOf);
//   - afterwards the page's own state says it took the answer: this button aria-pressed "true", every other "false".
// Only the named button is pressed, once, and its click's default action is cancelled (dom.ts pressToggle), so the
// browser itself submits nothing from it. What the page's own click handler does is the page's: this exception, like
// the combobox one, runs page script on the user's accepted plan (W4 review #1, a lead decision). A press that the
// page does not show as taken is `failed` with readings, which the helper treats as "may have landed".
import type { ActAnswer, ActVerb, Choice } from "../shared/messages.ts";
import { normalizeName } from "../shared/choose.ts";
import { clean } from "./names.ts";
import { pressToggle, settle, until } from "./dom.ts";
import { controlName, pressGroup, sendsNoForm, type PressGroup } from "./question.ts";

/** How long the page may take to show the press. Assumed: a toggle re-renders within the same second. */
const PRESS_WAIT_MS = 1000;

type ChooseVerb = Extract<ActVerb, { kind: "pageChooseOption" }>;

const pressed = (b: Element): boolean => b.getAttribute("aria-pressed") === "true";
/** What the group shows as its answer: the pressed options' names, comma-joined; "" when none is pressed. */
export function pressedValue(g: PressGroup): string {
  return g.options.filter(pressed).map((b) => controlName(b, "button")).join(", ");
}

export async function pressOption(el: Element, verb: ChooseVerb, check: () => ActAnswer | null, alive: () => Promise<boolean>): Promise<ActAnswer> {
  const answer = (outcome: ActAnswer["outcome"], detail: string | null, extra: Partial<ActAnswer> = {}): ActAnswer => ({ outcome, detail, ...extra });
  const choice = (matches: string[]): Choice => ({ flavor: "pressGroup", matches, expanded: null, hiddenInput: "none" });
  const g = pressGroup(el);
  if (g === null) return answer("unsupported", "this button is not an option of a Yes/No question whose answer the page shows; press it yourself");
  if (verb.question === undefined || verb.question !== g.question) return answer("stale", `the question here is '${clean(g.question, 80)}', not the one the plan names`);
  const mine = controlName(el, "button");
  if (normalizeName(mine) !== normalizeName(verb.value)) return answer("unsupported", `this option is '${clean(mine, 40)}', not '${clean(verb.value, 40)}'`);
  const before = pressedValue(g);
  if (pressed(el) && g.options.every((b) => b === el || !pressed(b))) return answer("alreadyTrue", null, { choice: choice([mine]) });
  if (before !== verb.expect) return answer("stale", `the question shows '${clean(before, 40)}' answered, not '${clean(verb.expect, 40)}'`);

  // The grant check awaits, so the group is read again after it: the same container, options and question.
  if (!(await alive())) return answer("notAllowed", "the task's grant ended (before the press)");
  const stop = check();
  if (stop !== null) return stop;
  const again = pressGroup(el);
  if (again === null || again.container !== g.container || again.question !== g.question || again.options.length !== g.options.length || again.options.some((b, i) => b !== g.options[i])) {
    return answer("stale", "the question changed before the press");
  }
  if (pressedValue(again) !== before) return answer("stale", "the answer changed before the press");
  // The page's handlers for pointerdown to mouseup run before the click: the button must still send no form, and still
  // be this question's option, when the click goes (W4 review #1).
  const same = (): boolean => {
    const g2 = pressGroup(el);
    return el instanceof HTMLButtonElement && sendsNoForm(el) && g2 !== null && g2.container === g.container && g2.question === g.question && check() === null;
  };
  if (!pressToggle(el, same)) return answer("failed", "the page changed the button while Caret pressed it, so Caret did not click", { choice: choice([mine]) });
  await until(() => (pressed(el) ? true : null), PRESS_WAIT_MS);
  await settle();
  // After the press: a stop leaves the page alone and is `failed` with no readings, which the helper reads as "may have landed".
  const end = check();
  if (end !== null) return answer("failed", `the press went in, then ${end.detail ?? end.outcome}; Caret stopped there`, { choice: choice([mine]) });
  const now = pressGroup(el);
  // A group the page no longer shows as one cannot be read: failed with no readings, "may have landed" (W4 review #5).
  if (now === null) return answer("failed", "after the press the page no longer shows a Yes/No question here, so Caret cannot read the answer", { choice: choice([mine]) });
  const after = pressedValue(now);
  const readings = { before, afterInput: after, afterBlur: after, invalid: false, error: null };
  const others = now.options.filter((b) => b !== el && pressed(b)).map((b) => controlName(b, "button"));
  if (!pressed(el)) return answer("failed", after === before ? "the page did not take the press" : `the page shows '${clean(after, 40)}'`, { readings, choice: choice([mine]) });
  if (others.length > 0) return answer("failed", `the page shows ${others.map((o) => `'${clean(o, 40)}'`).join(", ")} pressed too`, { readings, choice: choice([mine]) });
  return answer("ok", null, { readings, choice: choice([mine]) });
}
