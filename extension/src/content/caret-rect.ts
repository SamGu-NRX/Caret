// H13: where the caret is in the field the user is typing in, so the host draws Caret's inline text right after it.
// The host cannot ask: Chrome shows Accessibility no web content (H10). The walk reports this rect beside the field's
// text (field-text.ts), in the frame's viewport CSS pixels, as control rects are; the helper turns a top frame's rect
// into screen points (page-link.ts screenRect).
//
// Each kind needs its own way:
// - contenteditable: the document's Selection, collapsed at the caret, gives its own client rect;
// - a one-line input: the text before the caret measured in the field's own font on a canvas, from the text's start;
// - a textarea: a copy of the field's box and wrapping with the text before the caret, measured where the caret's
//   marker lands. The copy is added to the document only for that measurement and taken out in the same task.
// Null when the caret cannot be placed: right-to-left or centred text, a caret scrolled out of the field, a field with
// no box. The host then shows no inline text there.

export type Rect = [number, number, number, number];

/** Properties the textarea copy takes from the field so its text wraps exactly as the field's does. */
const MIRRORED = [
  "boxSizing", "width", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderStyle",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontStyle", "fontVariant", "fontWeight", "fontStretch",
  "fontSize", "fontFamily", "lineHeight", "letterSpacing", "wordSpacing", "textIndent", "textTransform", "tabSize",
  "whiteSpace", "wordBreak", "overflowWrap",
] as const;

const px = (v: string): number => Number.parseFloat(v) || 0;

/** A line's height in CSS pixels: the computed line-height, or 1.2 times the font size for "normal". */
function lineHeight(cs: CSSStyleDeclaration): number {
  const lh = px(cs.lineHeight);
  return lh > 0 ? lh : px(cs.fontSize) * 1.2;
}

/** The caret of a collapsed Selection inside a contenteditable, or null. */
function editorCaret(host: HTMLElement): Rect | null {
  const root = host.getRootNode();
  const sel = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && "getSelection" in root ? (root as ShadowRoot & { getSelection(): Selection | null }).getSelection() : host.ownerDocument.getSelection();
  if (sel === null || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  if (!host.contains(r.startContainer)) return null;
  const rects = r.getClientRects();
  const last = rects.length > 0 ? rects[rects.length - 1] : undefined;
  if (last !== undefined && last.height > 0) return [last.left, last.top, 1, last.height];
  // An empty line or an empty editor has no text to give a rect: its block's content box start stands in.
  const at = r.startContainer.nodeType === Node.ELEMENT_NODE ? (r.startContainer as Element) : r.startContainer.parentElement;
  if (at === null) return null;
  const view = host.ownerDocument.defaultView ?? window;
  const cs = view.getComputedStyle(at);
  if (cs.direction === "rtl" || cs.textAlign === "center" || cs.textAlign === "right" || cs.textAlign === "end") return null;
  const b = at.getBoundingClientRect();
  if (b.width <= 0 || b.height <= 0) return null;
  const h = lineHeight(cs);
  return [b.left + px(cs.borderLeftWidth) + px(cs.paddingLeft), b.top + px(cs.borderTopWidth) + px(cs.paddingTop), 1, h];
}

let canvas: HTMLCanvasElement | null = null;

/** The caret of a one-line input, from its text start plus the width of the text before the caret in its own font. */
function inputCaret(el: HTMLInputElement, cs: CSSStyleDeclaration): Rect | null {
  const at = el.selectionStart;
  if (typeof at !== "number" || el.selectionEnd !== at) return null;
  canvas ??= document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.font = cs.font;
  ctx.letterSpacing = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing;
  const width = ctx.measureText(el.value.slice(0, at)).width;
  const b = el.getBoundingClientRect();
  const left = b.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
  const x = left + width - el.scrollLeft;
  if (x < left - 1 || x > b.right - px(cs.borderRightWidth)) return null;
  const h = lineHeight(cs);
  return [x, b.top + (b.height - h) / 2, 1, h];
}

/** The caret of a textarea: a copy of its box with the text before the caret, then a marker, measured in place. */
function textareaCaret(el: HTMLTextAreaElement, cs: CSSStyleDeclaration): Rect | null {
  const at = el.selectionStart;
  if (typeof at !== "number" || el.selectionEnd !== at) return null;
  const doc = el.ownerDocument;
  const copy = doc.createElement("div");
  const s = copy.style;
  for (const p of MIRRORED) s[p] = cs[p];
  s.position = "absolute";
  s.visibility = "hidden";
  s.top = "0";
  s.left = "-10000px";
  s.overflow = "hidden";
  s.height = "auto";
  if (cs.whiteSpace === "normal") s.whiteSpace = "pre-wrap";
  copy.textContent = el.value.slice(0, at);
  const marker = doc.createElement("span");
  // Not empty, or it has no box: a zero-width space keeps the marker on the caret's line.
  marker.textContent = "​";
  copy.appendChild(marker);
  doc.documentElement.appendChild(copy);
  const top = marker.offsetTop;
  const left = marker.offsetLeft;
  copy.remove();
  const b = el.getBoundingClientRect();
  const h = lineHeight(cs);
  const x = b.left + px(cs.borderLeftWidth) + left - el.scrollLeft;
  const y = b.top + px(cs.borderTopWidth) + top - el.scrollTop;
  // Scrolled out of the field's visible box: there is nowhere to draw.
  if (y < b.top - 1 || y + h > b.bottom + 1) return null;
  return [x, y, 1, h];
}

/** The caret of `el`, a control the walk kept and found focused, in its frame's viewport CSS pixels; null when unknown. */
export function caretRect(el: Element): Rect | null {
  const r = measure(el);
  return r === null ? null : (r.map((v) => Math.round(v * 10) / 10) as Rect);
}

function measure(el: Element): Rect | null {
  const view = el.ownerDocument.defaultView ?? window;
  if (el instanceof HTMLElement && el.isContentEditable) {
    let host = el;
    for (let p = el.parentElement; p !== null && p.isContentEditable; p = p.parentElement) host = p;
    return editorCaret(host);
  }
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return null;
  const cs = view.getComputedStyle(el);
  if (cs.direction === "rtl" || cs.textAlign === "center" || cs.textAlign === "right" || cs.textAlign === "end") return null;
  return el instanceof HTMLTextAreaElement ? textareaCaret(el, cs) : inputCaret(el, cs);
}
