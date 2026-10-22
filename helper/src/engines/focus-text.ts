// The focused field's caret text, the one text of a web page's field that leaves the page (counsel 2026-10-09, "The
// focused field"): for the host's inline writing on this Mac only, never to a cloud model, never kept. Branded when a
// walk's snapshot arrives (engines/session.ts): a branded text throws on JSON.stringify, so no store, log or request can
// serialize it by accident, and engines/field-text.ts, which builds the host's pageField, is the one place it is unwrapped
// (forHost). A test asserts writer/chat.ts and the Jev client import neither this module nor its unwrap
// (test/page-values-boundary.test.ts); privacy/focus-tripwire.ts refuses a cloud request body that holds it.
import type { PageFocusText } from "../protocol.ts";
import { noteFocusedText } from "../privacy/focus-tripwire.ts";

declare const localOnly: unique symbol;

/** The text around the caret of the field the user is typing in, local to this Mac. */
export type FocusText = PageFocusText & { readonly [localOnly]: true };

/** Thrown by JSON.stringify of a FocusText. */
export class FocusTextSerialized extends Error {
  constructor() {
    super("the text of the field you are typing in is for inline writing on this Mac only, and is never serialized");
    this.name = "FocusTextSerialized";
  }
}

/** Brands one focused text: a copy whose JSON throws. Notes it for the cloud routes' tripwire. */
export function focusText(t: PageFocusText): FocusText {
  const copy = { ...t };
  Object.defineProperty(copy, "toJSON", {
    enumerable: false,
    value: () => {
      throw new FocusTextSerialized();
    },
  });
  noteFocusedText([t.before, t.selection, t.after]);
  return copy as FocusText;
}

/** The one unwrap: a plain copy of the text, for the host's pageField over the host's own socket. */
export function forHost(t: FocusText | PageFocusText): PageFocusText {
  return { before: t.before, after: t.after, selection: t.selection, ...(t.quietMs === undefined ? {} : { quietMs: t.quietMs }) };
}
