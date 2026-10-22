// S2: what a page insert may do with the field when its read-back did not confirm it. The lead's ruling for the helper's
// writes (S1), extended to inserts at the caret, and the same rule the host applies to its own inserts
// (apps/caret/Sources/CaretHostCore/UnconfirmedInsert.swift; both run the table in
// apps/caret/Tests/CaretHostCoreTests/Fixtures/unconfirmed-inserts.json).
//
// insert.ts records the field's whole text and its caret before the insert. A read afterwards is in exactly one state:
// - original: nothing landed;
// - whole: the whole text went in at the recorded caret (the caret just isn't after it): the page's Undo takes it back;
// - partial: a non-empty proper prefix of the text went in at the recorded caret and nothing else changed (a maxlength
//   cut, or a page handler that dropped the rest). Those characters are provably Caret's, so Caret takes them out
//   again, under the act's grant, by a delete the page's undo stack keeps;
// - unrecognized: anything else. Caret leaves the field as the page made it.
//
// A page insert has no Caret undo after the act ends (no mark, no ledger), so a recognized partial is taken out here
// rather than left for a later Undo. The field's text never goes into an answer (insert.ts keeps its snapshot local,
// H13 review): the details below give counts only, where the helper's S1 wording quotes the field.
import type { ActAnswer } from "../shared/messages.ts";

export interface InsertIntent {
  /** The field's whole text before the insert, as compared. */
  before: string;
  /** The replaced range of `before`, in UTF-16 code units; start equals end for an insert at the caret. */
  start: number;
  end: number;
  text: string;
}

export type InsertState = { kind: "original" } | { kind: "whole" } | { kind: "partial"; inserted: number } | { kind: "unrecognized" };

/**
 * The ruling's four states. The original wins over a prefix; an empty prefix over a non-empty range is unrecognized, as
 * S1 does not recognize an emptied field (the user's Delete leaves the same text).
 */
export function classifyInsert(i: InsertIntent, held: string): InsertState {
  if (held === i.before) return { kind: "original" };
  if (i.start < 0 || i.start > i.end || i.end > i.before.length) return { kind: "unrecognized" };
  const head = i.before.slice(0, i.start);
  const tail = i.before.slice(i.end);
  if (held.length < head.length + tail.length || !held.startsWith(head) || !held.endsWith(tail)) return { kind: "unrecognized" };
  const middle = held.slice(head.length, held.length - tail.length);
  if (middle === i.text) return { kind: "whole" };
  if (middle.length > 0 && middle.length < i.text.length && i.text.startsWith(middle)) return { kind: "partial", inserted: middle.length };
  return { kind: "unrecognized" };
}

/** The field as recovery touches it. insert.ts implements it on the DOM; tests implement it on a string. */
export interface InsertedField {
  /** The whole text as compared, or null when it cannot be read. */
  read(): string | null;
  /** Why Caret may not edit the field now (focus gone, a composition), or null. */
  blocked(): string | null;
  /** Selects exactly [start, end) of the text; false when it cannot. */
  select(start: number, end: number): boolean;
  /** The selected text as compared, or null. */
  selected(): string | null;
  /** Deletes the selection the way the user's Delete key would, so the page's undo stack keeps it. */
  deleteSelection(): void;
  /** Waits for the page to apply an edit. */
  settle(): Promise<void>;
  /** Saves the selection as it is now; the function puts exactly that back, without needing a collapsed caret. */
  saveSelection(): () => void;
}

/** An input or a textarea, as far as recovery touches it. */
export interface TextControl {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
}

/**
 * The adapter for a text control, whose offsets are its value's: insert.ts uses it for an input or a textarea. A control
 * with no selection API (an email input) throws on setSelectionRange; that is a selection Caret cannot make.
 */
export function textControlField(c: TextControl, env: Pick<InsertedField, "blocked" | "deleteSelection" | "settle">): InsertedField {
  const set = (start: number, end: number): boolean => {
    try {
      c.setSelectionRange(start, end);
    } catch {
      return false;
    }
    return c.selectionStart === start && c.selectionEnd === end;
  };
  return {
    read: () => c.value,
    blocked: env.blocked,
    select: set,
    selected: () => (c.selectionStart === null || c.selectionEnd === null ? null : c.value.slice(c.selectionStart, c.selectionEnd)),
    deleteSelection: env.deleteSelection,
    settle: env.settle,
    saveSelection: () => {
      const start = c.selectionStart;
      const end = c.selectionEnd;
      return () => {
        if (start !== null && end !== null) set(start, end);
      };
    },
  };
}

const failed = (detail: string, insert: "unchanged" | "unverified"): ActAnswer => ({ outcome: "failed", detail, insert });

/**
 * The answer for an insert whose read-back failed: classify the field, and take a recognized partial insert back out.
 * `gate` is the act's own (grant, then eligibility); a stop there leaves the characters, which the page's Undo still
 * takes back. Every write is preceded by a read that must equal the classified one, so nothing typed since is touched.
 */
export async function recoverInsert(field: InsertedField, intent: InsertIntent, gate: (stage: string) => Promise<ActAnswer | null>): Promise<ActAnswer> {
  const held = field.read();
  const state: InsertState = held === null ? { kind: "unrecognized" } : classifyInsert(intent, held);
  const n = intent.text.length;
  switch (state.kind) {
    case "original":
      return failed("the field reads as it did before the insert", "unchanged");
    case "whole":
      return failed("the text went in whole, but the caret is not right after it; the page's Undo takes it back", "unverified");
    case "unrecognized":
      return failed(
        held === null ? "Caret could not read the field after the insert, so it left it as it is" : "the field changed, but not to its text with the insert at the caret, nor to part of the insert; Caret left it as it is",
        "unverified",
      );
    case "partial":
      break;
  }
  const k = state.inserted;
  const part = `only ${k} of ${n} characters of the insert went in`;
  // A page insert goes in at a collapsed caret, so taking Caret's characters out is the whole undo. A replaced range
  // would need its text put back too, which this does not do: it leaves such a field rather than half-restore it.
  if (intent.start !== intent.end) return failed(`${part} over other text, which Caret does not put back here, so it left them`, "unverified");
  const stop = await gate("before Caret took out the part of its text that went in");
  if (stop !== null) return failed(`${part}, and Caret could not take them out: ${stop.detail ?? stop.outcome}; the page's Undo takes them back`, "unverified");
  const blocked = field.blocked();
  if (blocked !== null) return failed(`${part}, and Caret could not take them out: ${blocked}; the page's Undo takes them back`, "unverified");
  if (field.read() !== held) return failed(`${part}, and the field changed while Caret checked its grant; Caret left it as it is`, "unverified");
  const at = intent.start;
  const back = field.saveSelection();
  if (!field.select(at, at + k) || field.selected() !== intent.text.slice(0, k) || field.read() !== held) {
    // Only the selection moved: it goes back exactly as it was, wherever the page or the user had put it.
    back();
    return failed(`${part}, and Caret could not select only those characters, so it left them; the page's Undo takes them back`, "unverified");
  }
  field.deleteSelection();
  await field.settle();
  if (field.read() === intent.before) return failed(`${part}, so Caret took them out; the field reads as it did before the insert`, "unchanged");
  return failed(`${part}; Caret took them out, but the field then read otherwise, so Caret left it as it is`, "unverified");
}
