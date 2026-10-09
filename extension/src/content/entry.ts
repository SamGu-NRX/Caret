// How the text in a text input or textarea got there (S1, saved answers). Caret keeps a prose answer as the user's own
// words only when the user typed it, so the content script notes each input event's kind, per element, in memory, and
// the walker reports one word for it (PageControl.entry). Nothing about the text or the keys leaves the frame, and a
// secret field's text is not kept at all: the walker reports no entry for it.
//
// "typed": every change since the field was last empty was the user's own typing: a trusted input event of a typing
// kind. "pasted": a trusted event put in text the user did not type here (a paste, a drop, an autofill, a spelling
// replacement, an undo that can bring back anything). "other": an untrusted event (the page's script, or Caret's own
// writes, content/dom.ts), or a value that changed with no input event this script saw: text already in the field
// before an edit that the last edit did not leave there (a page's prefill, a script's silent change). The worst kind
// seen sticks until the field is emptied by an edit.

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
  /**
   * `isSecret`: whether an element is a password, one-time-code or card field (walker.ts secretOf), asked at every event,
   * since a field can turn secret after its first edit. `seen` is passed in by tests only, to see what is kept.
   */
  private readonly isSecret: (el: object) => boolean;
  private readonly seen: WeakMap<object, { entry: Entry; value: string }>;

  constructor(isSecret: (el: object) => boolean = () => false, seen: WeakMap<object, { entry: Entry; value: string }> = new WeakMap()) {
    this.isSecret = isSecret;
    this.seen = seen;
  }

  /** Whether `el` is secret; anything kept for it from before it became secret is dropped. */
  private secret(el: object): boolean {
    if (!this.isSecret(el)) return false;
    this.seen.delete(el);
    return true;
  }

  /**
   * A beforeinput on `el`, with the value just before the edit. It must be what the last edit left, or empty when no
   * edit was seen: anything else got there unseen, and one keystroke after a script's prefill must not make it typed.
   */
  onBefore(el: object, value: string): void {
    if (this.secret(el)) return;
    const s = this.seen.get(el);
    if (value !== (s?.value ?? "")) this.seen.set(el, { entry: "other", value });
  }

  /**
   * One input event on `el`, with the value it left and the event's data (InputEvent.data). An emptied field starts over.
   * A typing edit may add at most what it typed: a field that grew by more took text from elsewhere between beforeinput
   * and input (a page script), and reads as other (fix-check finding 6).
   */
  onInput(el: object, isTrusted: boolean, inputType: string, value: string, data: string | null = null): void {
    if (this.secret(el)) return;
    if (value === "") {
      this.seen.delete(el);
      return;
    }
    let kind = entryKind(isTrusted, inputType);
    const grew = value.length - (this.seen.get(el)?.value.length ?? 0);
    if (kind === "typed" && grew > (inputType.startsWith("insert") ? (data?.length ?? 1) : 0)) kind = "other";
    const was = this.seen.get(el)?.entry;
    this.seen.set(el, { entry: was !== undefined && RANK[was] > RANK[kind] ? was : kind, value });
  }

  /** What the walker reports for `el` holding `value` now: undefined when no edit was seen, "other" when it changed unseen. */
  entryOf(el: object, value: string): Entry | undefined {
    if (this.secret(el)) return undefined;
    const s = this.seen.get(el);
    if (s === undefined) return undefined;
    if (s.value === value) return s.entry;
    // Changed with no event: kept as other, so the next keystroke cannot make it typed again.
    this.seen.set(el, { entry: "other", value });
    return "other";
  }
}
