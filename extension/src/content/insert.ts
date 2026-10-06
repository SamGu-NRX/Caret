// P4 item 8: text at the caret of the field the user is typing in, for inline text the user accepted on a page.
//
// It goes in through document.execCommand("insertText"), the way the browser puts in the user's own typing: the page
// sees an ordinary insertText input event, and the field's own Undo takes the insert back in one step. Setting the value
// (the form write's way, content/actions.ts) would clear the field's undo history and move the caret to the end.
//
// It goes only into the field that had focus when the offer was made: the verb names the element the walk at that
// moment kept, which must still be connected, still have focus, still hold no selection, and still read exactly
// `expect` before its caret (the text the offer was made for, as content/field-text.ts reads it). Anything else is
// stale and nothing is touched. The text before the caret is read again afterwards and must be `expect` and the text.
import type { ActAnswer } from "../shared/messages.ts";
import { BEFORE_MAX, fieldText } from "./field-text.ts";
import { deepActiveElement } from "./walker.ts";
import { settle } from "./dom.ts";

const answer = (outcome: ActAnswer["outcome"], detail: string | null): ActAnswer => ({ outcome, detail });

/**
 * Whether `el`, a control the walk kept, is where focus is now: the element itself, or an editor holding it, in a
 * document the user is looking at. A tab the user left keeps its focused element, so the document must have focus and
 * be visible too (H13 review question 1): a Tab pressed just after switching tabs never types into the tab left behind.
 */
function hasFocus(el: Element): boolean {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
  const active = deepActiveElement();
  return active !== null && (active === el || (el instanceof HTMLElement && el.isContentEditable && el.contains(active)));
}

export async function insertAtCaret(
  el: Element,
  verb: { expect: string; text: string },
  gate: (stage: string) => Promise<ActAnswer | null>,
): Promise<ActAnswer> {
  if (!hasFocus(el)) return answer("stale", "the field no longer has focus");
  const now = fieldText(el);
  if (now === null) return answer("unsupported", "the field's caret cannot be read here");
  if (now.selection !== "") return answer("stale", "text is selected in the field; Caret inserts only at a caret");
  if (now.before !== verb.expect) return answer("stale", "the text before the caret changed since the offer");
  const ready = await gate("before the text went in");
  if (ready !== null) return ready;
  // The gate awaited the worker; the user or the page may have typed, moved the caret or selected text meanwhile, and
  // execCommand would replace a selection (P4 review).
  const again = hasFocus(el) ? fieldText(el) : null;
  if (again === null || again.before !== verb.expect || again.selection !== "") return answer("stale", "the field changed while Caret checked its grant");
  const went = document.execCommand("insertText", false, verb.text);
  await settle();
  const after = fieldText(el);
  if (after?.before === `${verb.expect}${verb.text}`.slice(-BEFORE_MAX)) return answer("ok", null);
  return answer("failed", went ? "the field holds other text before the caret than Caret inserted" : "the page did not take the insert");
}
