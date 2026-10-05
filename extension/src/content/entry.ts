// How the text in a text input or textarea got there (S1, saved answers). Caret keeps a prose answer as the user's own
// words only when the user typed it, so the content script notes each input event's kind, per element, in memory, and
// the walker reports one word for it (PageControl.entry). Nothing about the text or the keys leaves the frame.
//
// "typed": every change since the field was last empty was the user's own typing: a trusted input event of a typing
// kind. "pasted": a trusted event put in text the user did not type here (a paste, a drop, an autofill, a spelling
// replacement, an undo that can bring back anything). "other": an untrusted event (the page's script, or Caret's own
// writes, content/dom.ts), or a value that changed with no input event this script saw. The worst kind seen sticks
// until the field is emptied.

export type Entry = "typed" | "pasted" | "other";

/** Trusted inputTypes that are the user typing or deleting in this field (Input Events Level 2). */
const TYPING: ReadonlySet<string> = new Set([
  "insertText",
  "insertLineBreak",
  "insertParagraph",
  "insertCompositionText",
  "insertTranspose",
  "deleteContentBackward",
  "deleteContentForward",
  "deleteWordBackward",
  "deleteWordForward",
  "deleteSoftLineBackward",
  "deleteSoftLineForward",
  "deleteEntireSoftLine",
  "deleteHardLineBackward",
  "deleteHardLineForward",
  "deleteByCut",
  "deleteByDrag",
  "deleteContent",
]);

const RANK: Record<Entry, number> = { typed: 0, pasted: 1, other: 2 };

/** The kind of one input event: typing, text from elsewhere, or not the user's. */
export function entryKind(isTrusted: boolean, inputType: string): Entry {
  if (!isTrusted) return "other";
  return TYPING.has(inputType) ? "typed" : "pasted";
}

export class EntryTracker {
  private readonly seen = new WeakMap<object, { entry: Entry; value: string }>();

  /** One input event on `el`, with the value it left. An emptied field starts over. */
  onInput(el: object, isTrusted: boolean, inputType: string, value: string): void {
    if (value === "") {
      this.seen.delete(el);
      return;
    }
    const kind = entryKind(isTrusted, inputType);
    const was = this.seen.get(el)?.entry;
    this.seen.set(el, { entry: was !== undefined && RANK[was] > RANK[kind] ? was : kind, value });
  }

  /** What the walker reports for `el` holding `value` now: undefined when no edit was seen, "other" when it changed unseen. */
  entryOf(el: object, value: string): Entry | undefined {
    const s = this.seen.get(el);
    if (s === undefined) return undefined;
    return s.value === value ? s.entry : "other";
  }
}
