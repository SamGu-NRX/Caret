// P4 item 8: text at the caret of the field the user is typing in, for inline text the user accepted on a page.
//
// It goes in through document.execCommand("insertText"), the way the browser puts in the user's own typing: the page
// sees an ordinary insertText input event, and the field's own Undo takes the insert back in one step. Setting the value
// (the form write's way, content/actions.ts) would clear the field's undo history and move the caret to the end. Just
// before it, the caret is set where it already is, which ends the user's typing as an undo step (closeTyping).
//
// It goes only into the field that had focus when the offer was made: the verb names the element the walk at that
// moment kept, which must still be connected, still have focus, hold a single collapsed caret (an image selected in an
// editor reads as no text but is a selection), have no input method composition under way in the document, and still
// read exactly `expect` before its caret (the text the offer was made for, as content/field-text.ts reads it). This is
// checked before and after the grant wait. Anything else is stale, and nothing is touched.
//
// Afterwards the whole field is read again, uncapped, against a snapshot taken just before the insert (H13 review): the
// text before the caret must be the snapshot's plus the insert, the text after it unchanged, and the caret collapsed
// right after the insert. The snapshot stays in this function: it is never sent or logged. A field that reads as the
// snapshot did is `unchanged`; any other result is `unverified`, and is left as the page made it, never undone.
import type { ActAnswer } from "../shared/messages.ts";
import { BEFORE_MAX, fieldText, serialize } from "./field-text.ts";
import { deepActiveElement } from "./walker.ts";
import { settle } from "./dom.ts";

const answer = (outcome: ActAnswer["outcome"], detail: string | null): ActAnswer => ({ outcome, detail });

/** Whether an input method's composition is under way in this document (trackComposition). */
let composing = false;
let tracking = false;

/**
 * H13 review (P1): follows input method compositions in this document (Pinyin, Kotoeri), whose marked text is the
 * IME's until it commits, so an insert never lands inside one. Once per document; the content script calls it at start.
 */
export function trackComposition(): void {
  if (tracking) return;
  tracking = true;
  addEventListener("compositionstart", () => void (composing = true), { capture: true, passive: true });
  addEventListener("compositionend", () => void (composing = false), { capture: true, passive: true });
}

/**
 * Whether `el`, a control the walk kept, is where focus is now: the element itself, or an editor holding it, in a
 * document the user is looking at. A tab the user left keeps its focused element, so the document must have focus and
 * be visible too (H13 review question 1): a Tab pressed just after switching tabs never types into the tab left behind.
 */
function hasFocus(el: Element): boolean {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
  const active = deepActiveElement();
  if (active === null) return false;
  if (!(el instanceof HTMLElement) || !el.isContentEditable) return active === el;
  // H13 review: in an editor, focus and the selection must belong to the editor the walk kept, not to an editor nested
  // in it behind a non-editable boundary (its own editing host), nor to a form control inside it.
  if (active !== el && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement)) return false;
  const host = editingHost(el);
  const sel = selectionOf(el);
  const anchor = sel === null || sel.rangeCount === 0 ? null : sel.getRangeAt(0).startContainer;
  return editingHost(active) === host && anchor !== null && editingHost(anchor) === host;
}

/**
 * The field's whole text at its caret, uncapped, or null when it has no single collapsed caret: equal selection offsets
 * in a text control, one collapsed range inside an editor. Local only: never sent or logged.
 */
interface CaretState {
  before: string;
  after: string;
}

function caretState(el: Element): CaretState | null {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const s = el.selectionStart;
    const e = el.selectionEnd;
    if (s === null || e === null || s !== e) return null;
    return { before: el.value.slice(0, s), after: el.value.slice(s) };
  }
  const host = editingHost(el);
  const sel = selectionOf(el);
  if (host === null || sel === null || sel.rangeCount !== 1) return null;
  const r = sel.getRangeAt(0);
  if (!r.collapsed || !host.contains(r.startContainer)) return null;
  const before = host.ownerDocument.createRange();
  before.selectNodeContents(host);
  before.setEnd(r.startContainer, r.startOffset);
  const after = host.ownerDocument.createRange();
  after.selectNodeContents(host);
  after.setStart(r.startContainer, r.startOffset);
  return { before: serialize(before), after: serialize(after) };
}

/** The field's whole text, wherever its caret is. */
function wholeText(el: Element): string | null {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  const host = editingHost(el);
  if (host === null) return null;
  const all = host.ownerDocument.createRange();
  all.selectNodeContents(host);
  return serialize(all);
}

/**
 * Text compared as the field shows it: an editor's no-break spaces as spaces, since Chrome turns spaces at an edit's
 * edges into no-break spaces and back as it edits. A text control's value exactly.
 */
function shown(el: Element, text: string): string {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? text : text.replace(/\u00a0/g, " ");
}

/** Why nothing may go in now, or null: a composition, focus, no single caret, or other text before the caret. */
function refusal(el: Element, expect: string): ActAnswer | null {
  if (composing) return answer("stale", "an input method is composing text in the field");
  if (!hasFocus(el)) return answer("stale", "the field no longer has focus");
  const c = caretState(el);
  if (c === null) return answer("stale", "the field has no single caret: something is selected, or its caret cannot be read here");
  if (c.before.slice(Math.max(0, c.before.length - BEFORE_MAX)) !== expect) return answer("stale", "the text before the caret changed since the offer");
  return null;
}

/** The selection `el` is in: a shadow root keeps its own in Chrome, as field-text.ts reads it. */
function selectionOf(el: Element): Selection | null {
  const root = el.getRootNode();
  return root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && "getSelection" in root ? (root as ShadowRoot & { getSelection(): Selection | null }).getSelection() : el.ownerDocument.getSelection();
}

/**
 * Ends the typing the user's keys left open as an undo step, so the page's Undo takes the insert back alone. Chrome adds
 * an insertText to the typing step still open at the caret: on the test Mac (runs/20261006T151009Z-37788) one ⌘Z after
 * real typing and Tab in a contenteditable removed the typed sentence with the insert. A caret set by script closes
 * that step (fixtures/web-form tab-text.test.ts, for an input, a textarea and a contenteditable); it is set where it
 * already is, so nothing moves. A text control's caret is its own (setSelectionRange); an editor's is the selection's.
 */
function closeTyping(el: Element): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const at = el.selectionStart;
    if (at !== null) el.setSelectionRange(at, at);
    return;
  }
  const sel = selectionOf(el);
  if (sel === null || sel.rangeCount === 0) return;
  const r = sel.getRangeAt(0);
  sel.setBaseAndExtent(r.startContainer, r.startOffset, r.startContainer, r.startOffset);
}

/** The outermost element of the editable region `n` is in: up through editable parents, never past a non-editable one. */
function editingHost(n: Node): HTMLElement | null {
  const e = n instanceof HTMLElement ? n : n.parentElement;
  if (e === null || !e.isContentEditable) return null;
  let host = e;
  for (let p = e.parentElement; p !== null && p.isContentEditable; p = p.parentElement) host = p;
  return host;
}

export async function insertAtCaret(
  el: Element,
  verb: { expect: string; text: string },
  gate: (stage: string) => Promise<ActAnswer | null>,
): Promise<ActAnswer> {
  const first = refusal(el, verb.expect);
  if (first !== null) return first;
  const ready = await gate("before the text went in");
  if (ready !== null) return ready;
  // The gate awaited the worker; the user, the page or an input method may have typed, moved the caret, selected
  // something or started composing meanwhile, and execCommand would replace a selection (P4 review).
  const again = refusal(el, verb.expect);
  if (again !== null) return { ...again, detail: `${again.detail ?? again.outcome} (while Caret checked its grant)` };
  const was = caretState(el) as CaretState;
  closeTyping(el);
  const went = document.execCommand("insertText", false, verb.text);
  await settle();
  const now = caretState(el);
  if (now !== null && shown(el, now.before) === shown(el, `${was.before}${verb.text}`) && shown(el, now.after) === shown(el, was.after)) return answer("ok", null);
  if (wholeText(el) === `${was.before}${was.after}`) {
    return { outcome: "failed", detail: went ? "the field reads as it did before the insert" : "the page did not take the insert", insert: "unchanged" };
  }
  return { outcome: "failed", detail: "the field changed, but not to its text with the insert at the caret and the caret after it", insert: "unverified" };
}
