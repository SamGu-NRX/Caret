// The text around the caret in the field the user is typing in (P4, brief item 7), for the host's inline text, which
// otherwise has no context in any web page: Chrome shows Accessibility no web content (H10), and the walk reported a
// focused field's selection offsets only, never its text, and nothing at all for a contenteditable (GD1 finding 4).
//
// The walk calls it only for the focused control it kept, so every control the walker excludes (password, card and
// one-time-code fields, hidden inputs, self-identification and consent groups) and every frame on a site Caret is off
// for never reaches here. Input and textarea read their value around selectionStart and selectionEnd. A contenteditable
// reads the document's Selection inside it, with a line break for each line break and block, as a person sees it. A
// field inside a secret one, an editor whose host is secret, and any secret field inside an editor give no text
// (secret-dom.ts): the walker's own check covers only the element it kept.
import type { FieldText } from "../shared/messages.ts";
import { docsParagraphs, docsTextbox, type DocsKind } from "./text.ts";
import { inSecret, secretOfElement } from "./secret-dom.ts";

/** Characters before the caret the host gets: a few sentences, enough to continue the one being typed. Brief item 7. */
export const BEFORE_MAX = 2000;
/** Characters after the caret: enough to see the rest of the line and paragraph. Brief item 7. */
export const AFTER_MAX = 500;
/** Characters of a selection, the same bound as before the caret. */
export const SELECTION_MAX = 2000;

/** Inputs whose selection offsets Chrome exposes (selectionStart is null on email and number inputs). */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel"]);

/** Block elements a person sees on a line of their own inside an editor. */
const BLOCK_TAGS = new Set(["DIV", "P", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "TR", "TABLE", "SECTION", "ARTICLE", "HEADER", "FOOTER"]);

export function around(value: string, start: number, end: number): FieldText {
  return {
    before: value.slice(Math.max(0, start - BEFORE_MAX), start),
    after: value.slice(end, end + AFTER_MAX),
    selection: value.slice(start, Math.min(end, start + SELECTION_MAX)),
  };
}

/**
 * An editor's text between two points, as a person reads it: text nodes as they are, a line break for <br> and around
 * each block. Hidden subtrees (display none, aria-hidden) are left out, as the walker leaves them out of a control.
 */
export function serialize(range: Range): string {
  const root = range.commonAncestorContainer;
  // The walker below never filters its own root: a range wholly inside a secret field reads as nothing.
  if (inSecret(root)) return "";
  const doc = root.ownerDocument ?? document;
  let out = "";
  // By nodeType, not instanceof: a Docs editor lives in a same-origin iframe, another realm (text.ts isHtml).
  const view = doc.defaultView ?? window;
  const walker = doc.createTreeWalker(root.nodeType === Node.ELEMENT_NODE ? root : (root.parentNode ?? root), NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as Element;
        if (el.getAttribute("aria-hidden") === "true" || view.getComputedStyle(el).display === "none" || secretOfElement(el) !== null) return NodeFilter.FILTER_REJECT;
      }
      return range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n as Text;
      const s = range.startContainer === t ? range.startOffset : 0;
      const e = range.endContainer === t ? range.endOffset : t.data.length;
      out += t.data.slice(s, e);
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const tag = (n as Element).tagName;
      if (tag === "BR" || (BLOCK_TAGS.has(tag) && out !== "" && !out.endsWith("\n"))) out += "\n";
    }
  }
  return out;
}

/** The text before, inside and after the selection of a contenteditable editor `host`, or null when its selection is elsewhere. */
export function editorText(host: HTMLElement): FieldText | null {
  if (inSecret(host)) return null;
  const doc = host.ownerDocument;
  // A shadow root has its own selection in Chrome; the document's selection is the editor's otherwise.
  const root = host.getRootNode();
  const inShadow = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && "getSelection" in root;
  const sel = inShadow ? (root as ShadowRoot & { getSelection(): Selection | null }).getSelection() : doc.getSelection();
  if (sel === null || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!host.contains(r.startContainer) || !host.contains(r.endContainer)) return null;
  const before = doc.createRange();
  before.selectNodeContents(host);
  before.setEnd(r.startContainer, r.startOffset);
  const after = doc.createRange();
  after.selectNodeContents(host);
  after.setStart(r.endContainer, r.endOffset);
  const b = serialize(before);
  const a = serialize(after);
  const s = r.collapsed ? "" : serialize(r);
  return { before: b.slice(Math.max(0, b.length - BEFORE_MAX)), after: a.slice(0, AFTER_MAX), selection: s.slice(0, SELECTION_MAX) };
}

/** The editing host a focused element belongs to: the outermost contenteditable ancestor in its tree. */
function editingHost(el: HTMLElement): HTMLElement {
  let host = el;
  for (let p = el.parentElement; p !== null && p.isContentEditable; p = p.parentElement) host = p;
  return host;
}

/**
 * The text around the caret of `el`, a control the walk kept and found focused; null for a control that holds no
 * text the user types (a checkbox, a select, a button) or whose caret Chrome does not expose.
 */
export function fieldText(el: Element): FieldText | null {
  if (inSecret(el)) return null;
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type))) {
    const s = el.selectionStart;
    const e = el.selectionEnd;
    if (typeof s !== "number" || typeof e !== "number") return null;
    return around(el.value, s, e);
  }
  if (el instanceof HTMLElement && el.isContentEditable) return editorText(editingHost(el));
  return null;
}

/**
 * A Docs or Sheets editor's state for the walk (brief items 6 and 7): whether its text for assistive technology is
 * there, and when the user is typing in it, the text around their caret there. The caret lives in that off-screen
 * textbox (GD1: Docs puts focus in the text-event iframe), so it is the one place the sentence being typed can be read.
 * Not yet checked in an editable Doc: that needs a signed-in Google account (brief addendum).
 */
export function docsFocus(doc: Document, kind: DocsKind): { kind: DocsKind; text: "on" | "off"; field: FieldText | null } {
  const box = docsTextbox(doc, kind);
  const on = box !== null && docsParagraphs(box.innerText, kind).length > 0;
  if (box === null || !on) return { kind, text: "off", field: null };
  const focused = box.ownerDocument.activeElement;
  return { kind, text: "on", field: focused !== null && box.contains(focused) ? editorText(box) : null };
}
