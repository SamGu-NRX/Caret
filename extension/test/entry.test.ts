// S1: how a text field's text was entered, as the walker reports it (content/entry.ts). Only the user's own typing
// reads as "typed"; Caret's writes are untrusted events and read as "other", like any page script's.
import { describe, expect, it } from "vitest";
import { EntryTracker, entryKind } from "../src/content/entry.ts";

describe("entry", () => {
  it("reads trusted typing as typed, a trusted paste, drop or replacement as pasted, and any untrusted event as other", () => {
    expect(entryKind(true, "insertText")).toBe("typed");
    expect(entryKind(true, "deleteContentBackward")).toBe("typed");
    expect(entryKind(true, "insertFromPaste")).toBe("pasted");
    expect(entryKind(true, "insertFromDrop")).toBe("pasted");
    expect(entryKind(true, "insertReplacementText")).toBe("pasted");
    expect(entryKind(true, "historyUndo")).toBe("pasted");
    expect(entryKind(true, "")).toBe("pasted");
    // Caret's own write (content/dom.ts) dispatches an untrusted insertReplacementText.
    expect(entryKind(false, "insertReplacementText")).toBe("other");
    expect(entryKind(false, "insertText")).toBe("other");
  });

  it("keeps the worst kind seen until the field is emptied, and reports a value changed with no event as other", () => {
    const t = new EntryTracker();
    const el = {};
    expect(t.entryOf(el, "")).toBeUndefined();
    t.onInput(el, true, "insertText", "I");
    t.onInput(el, true, "insertText", "I l");
    expect(t.entryOf(el, "I l")).toBe("typed");
    t.onInput(el, false, "insertReplacementText", "I led the migration.");
    t.onInput(el, true, "insertText", "I led the migration. It");
    expect(t.entryOf(el, "I led the migration. It")).toBe("other");
    // Emptied by the user: what comes next is judged afresh.
    t.onInput(el, true, "deleteContentBackward", "");
    t.onInput(el, true, "insertFromPaste", "Pasted words");
    t.onInput(el, true, "insertText", "Pasted words and mine");
    expect(t.entryOf(el, "Pasted words and mine")).toBe("pasted");
    // A page script set the value without an input event.
    expect(t.entryOf(el, "Pasted words and something else")).toBe("other");
    // A field nobody edited while this script watched reports nothing.
    expect(t.entryOf({}, "Prefilled by the page")).toBeUndefined();
  });
});
