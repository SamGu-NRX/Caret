// What the content script keeps so that a text control's text never leaves the page (content/revs.ts): change
// counters, where the text came from, the page-held `before` of Caret's writes, and the compare budget. Plain objects
// stand in for elements; page-state.ts and walker.ts read the same rules off the DOM.
import { describe, expect, it } from "vitest";
import { COMPARE_PER_CONTROL, COMPARE_PER_TASK, CompareBudget, MAX_RECORDS, Revs, WriteRecords, compareAnswers, presence, restoreCheck, withheldFor } from "../src/content/revs.ts";

/** One keystroke of the user's, as the page's tracker reports it: beforeinput with the text it starts from, then input with the text it left. */
function keystroke(revs: Revs<object>, el: object, from: string, to: string): void {
  revs.trusted(el, { before: from }, true);
  revs.trusted(el, { typed: to }, true);
}

/** A paste of the user's: the paste and beforeinput events with the text it starts from, then an input event that is no typing. */
function paste(revs: Revs<object>, el: object, from: string): void {
  revs.trusted(el, { before: from }, true);
  revs.trusted(el, { before: from }, true);
  revs.trusted(el, { foreign: true }, true);
}

describe("rev", () => {
  it("bumps on a reading that sees other text and on Caret's write, and not on a trusted event or otherwise", () => {
    const revs = new Revs<object>();
    const el = {};
    expect(revs.read(el, "", true).rev).toBe(0);
    expect(revs.read(el, "", true).rev).toBe(0);
    keystroke(revs, el, "", "a");
    expect(revs.read(el, "a", true).rev).toBe(1);
    expect(revs.caretWrote(el, "Robin", false, true)).toBe(2);
    expect(revs.read(el, "Robin", true).rev).toBe(2);
    // A page script's change, seen by the next reading.
    expect(revs.read(el, "Robin V", true).rev).toBe(3);
    // A trusted event that leaves the text as it was read bumps nothing.
    revs.trusted(el, {}, true);
    expect(revs.read(el, "Robin V", true).rev).toBe(3);
  });

  it("changes as much for eight typed characters as for one, so it never tells how much was typed (audit MED 4)", () => {
    const revs = new Revs<object>();
    const one = {};
    const eight = {};
    const r1 = revs.read(one, "", true).rev;
    const r8 = revs.read(eight, "", true).rev;
    keystroke(revs, one, "", "x");
    const word = "Quarters";
    for (let i = 0; i < word.length; i++) keystroke(revs, eight, word.slice(0, i), word.slice(0, i + 1));
    expect(revs.read(one, "x", true).rev - r1).toBe(1);
    expect(revs.read(eight, word, true).rev - r8).toBe(1);
  });
});

describe("where an input's text came from", () => {
  it("is prefilled when first seen holding text, and stays so until it is seen empty", () => {
    const revs = new Revs<object>();
    const copy = {};
    expect(revs.read(copy, "Tr0mbone-Lattice-91", true).origin).toBe("prefilled");
    // The user typing into it does not make the text theirs: the page's text is still in it.
    keystroke(revs, copy, "Tr0mbone-Lattice-91", "Tr0mbone-Lattice-91x");
    expect(revs.read(copy, "Tr0mbone-Lattice-91x", true).origin).toBe("prefilled");
    expect(revs.read(copy, "", true).origin).toBe("clean");
    keystroke(revs, copy, "", "mine");
    expect(revs.read(copy, "mine", true).origin).toBe("clean");
  });

  it("reads the text an edit starts from before the user's first keystroke counts", () => {
    const revs = new Revs<object>();
    const el = {};
    // beforeinput is the first contact: the field already held text the page put there.
    keystroke(revs, el, "482913", "4829131");
    expect(revs.read(el, "4829131", true).origin).toBe("prefilled");
  });

  it("is withheld after a paste before the first reading: the paste reads the text it starts from (audit MED 3)", () => {
    const revs = new Revs<object>();
    const el = {};
    paste(revs, el, "Tr0mbone-Lattice-91");
    // First seen holding the page's text (prefilled), then changed by no typing: the page's text, and the paste's.
    const { origin } = revs.read(el, "Tr0mbone-Lattice-91 and more", true);
    expect(origin).toBe("programmatic");
    expect(withheldFor(null, origin)).toBe("programmatic");
  });

  it("is prefilled when a trusted event with nothing read before it came first, as autofill's input and change do (audit MED 3)", () => {
    const revs = new Revs<object>();
    const el = {};
    // Chrome's autofill: a trusted input event with no inputType and no beforeinput, then change.
    revs.trusted(el, { foreign: true }, true);
    revs.trusted(el, {}, true);
    expect(revs.read(el, "robin@example.test", true).origin).toBe("prefilled");
  });

  it("is programmatic after the user's paste into an empty field: only typing is the user's own (audit MED 3)", () => {
    const revs = new Revs<object>();
    const el = {};
    revs.read(el, "", true);
    paste(revs, el, "");
    expect(revs.read(el, "pasted-from-elsewhere", true).origin).toBe("programmatic");
  });

  it("is programmatic when a script fills the field after the user's keystroke and before the next reading (audit LOW 8)", () => {
    const revs = new Revs<object>();
    const el = {};
    revs.read(el, "", true);
    keystroke(revs, el, "", "a");
    expect(revs.read(el, "filled-by-a-script", true).origin).toBe("programmatic");
  });

  it("stays programmatic when a script's text is followed by the user's keystroke before the next reading", () => {
    const revs = new Revs<object>();
    const el = {};
    revs.read(el, "", true);
    // A script fills the field; the user's next keystroke starts from that text (beforeinput), then a walk reads it.
    keystroke(revs, el, "filled-by-a-script", "filled-by-a-scriptx");
    expect(revs.read(el, "filled-by-a-scriptx", true).origin).toBe("programmatic");
  });

  it("keeps a digest of the text, never the text, and forgets a field that turned secret", () => {
    const kept: string[] = [];
    const revs = new Revs<object>((t) => {
      kept.push(t);
      return `d${t.length}`;
    });
    const el = {};
    revs.read(el, "Robin", true);
    expect(kept).toEqual(["Robin"]);
    // Same digest, same rev: what is compared is the digest the page keeps.
    expect(revs.read(el, "Dana!", true).rev).toBe(0);
    revs.forget(el);
    expect(revs.read(el, "", true)).toEqual({ rev: 0, origin: "clean" });
  });

  it("is programmatic when the text changed between two readings with no trusted event", () => {
    const revs = new Revs<object>();
    const el = {};
    revs.read(el, "", true);
    expect(revs.read(el, "filled-by-a-script", true).origin).toBe("programmatic");
  });

  it("stays clean when a controlled input re-sets the text after the user's keystroke", () => {
    const revs = new Revs<object>();
    const el = {};
    revs.read(el, "", true);
    keystroke(revs, el, "", "A");
    keystroke(revs, el, "A", "AB");
    // The page's own handler sets the same text again after the event: the reading sees what the keystroke left.
    expect(revs.read(el, "AB", true).origin).toBe("clean");
  });

  it("is Caret's after Caret's write, until anyone else changes it", () => {
    const revs = new Revs<object>();
    const el = {};
    revs.read(el, "", true);
    revs.caretWrote(el, "Robin Vale", false, true);
    expect(revs.read(el, "Robin Vale", true).origin).toBe("caret");
    expect(revs.read(el, "Robin Vale!", true).origin).toBe("programmatic");
    const typed = {};
    revs.read(typed, "", true);
    revs.caretWrote(typed, "Robin", false, true);
    keystroke(revs, typed, "Robin", "Robin V");
    expect(revs.read(typed, "Robin V", true).origin).toBe("clean");
  });

  it("is programmatic, not Caret's, when Caret's write did not land as written (audit LOW 7)", () => {
    const revs = new Revs<object>();
    const el = {};
    revs.read(el, "", true);
    // The page kept part of the value, or merged it with its own text.
    revs.caretWrote(el, "Robin Va", false, false);
    const { origin } = revs.read(el, "Robin Va", true);
    expect(origin).toBe("programmatic");
    expect(withheldFor(null, origin)).toBe("programmatic");
    // Emptied by the write: nothing to withhold.
    revs.caretWrote(el, "", false, false);
    expect(revs.read(el, "", true).origin).toBe("clean");
  });

  it("never applies prefilled or programmatic to a textarea or an editor", () => {
    const revs = new Revs<object>();
    const draft = {};
    expect(revs.read(draft, "A reopened draft", false).origin).toBe("clean");
    expect(revs.read(draft, "A reopened draft, edited by the page", false).origin).toBe("clean");
  });
});

describe("what a walk sends for a text control", () => {
  it("withholds hasValue and rev while a withheld field holds text, and always for a secret one", () => {
    expect(presence(false, 4, null)).toEqual({ hasValue: true, rev: 4 });
    expect(presence(true, 4, null)).toEqual({ hasValue: false, rev: 4 });
    expect(presence(false, 4, "prefilled")).toEqual({ hasValue: null, rev: null });
    expect(presence(true, 4, "unknownHistory")).toEqual({ hasValue: false, rev: 4 });
    expect(presence(true, 4, "secret")).toEqual({ hasValue: null, rev: null });
    expect(presence(false, 4, "secret")).toEqual({ hasValue: null, rev: null });
  });

  it("withholds for a doubtful history or replacement, or a prefilled or programmatic origin, but not Caret's own text", () => {
    expect(withheldFor("unknownHistory", "clean")).toBe("unknownHistory");
    expect(withheldFor("replacement", "clean")).toBe("replacement");
    expect(withheldFor(null, "prefilled")).toBe("prefilled");
    expect(withheldFor(null, "programmatic")).toBe("programmatic");
    expect(withheldFor(null, "clean")).toBeNull();
    expect(withheldFor("unknownHistory", "caret")).toBeNull();
  });
});

describe("the page-held before of Caret's writes", () => {
  const el = {};
  it("restores only the element Caret wrote, unchanged since, with no input of the user's, equivalent to what Caret wrote", () => {
    const recs = new WriteRecords<object>();
    const rec = recs.begin("t", el, "", "1", 0, 0);
    rec.revAfter = 1;
    expect(restoreCheck(recs.newest("t", el), el, { rev: 1, trusted: 0, text: "1", numeric: false })).toBeNull();
    // B29: a number field shows Caret's 1 as 1.00.
    expect(restoreCheck(recs.newest("t", el), el, { rev: 1, trusted: 0, text: "1.00", numeric: true })).toBeNull();
    expect(restoreCheck(recs.newest("t", el), el, { rev: 1, trusted: 0, text: "1.00", numeric: false })).toBe("changed");
    expect(restoreCheck(recs.newest("t", el), el, { rev: 2, trusted: 0, text: "1", numeric: false })).toBe("changed");
    expect(restoreCheck(recs.newest("t", el), el, { rev: 2, trusted: 1, text: "1", numeric: false })).toBe("mayIncludeInput");
    // Another element, or another task, has no record of this write.
    expect(restoreCheck(recs.newest("t", {}), el, { rev: 1, trusted: 0, text: "1", numeric: false })).toBe("noRecord");
    expect(restoreCheck(recs.newest("other", el), el, { rev: 1, trusted: 0, text: "1", numeric: false })).toBe("noRecord");
    // A record of an element now gone is refused as such.
    expect(restoreCheck(recs.newest("t", el), {}, { rev: 1, trusted: 0, text: "1", numeric: false })).toBe("gone");
  });

  it("goes back newest first, write by write, and forgets the oldest past its bound", () => {
    const recs = new WriteRecords<object>();
    recs.begin("t", el, "", "Robin", 0, 0);
    recs.begin("t", el, "Robin", "Robin Vale", 1, 0);
    expect(recs.newest("t", el)?.before).toBe("Robin");
    recs.pop("t", el);
    expect(recs.newest("t", el)?.before).toBe("");
    recs.pop("t", el);
    expect(recs.newest("t", el)).toBeUndefined();
    const els = Array.from({ length: MAX_RECORDS + 1 }, () => ({}));
    for (const x of els) recs.begin("t", x, "", "x", 0, 0);
    expect(recs.newest("t", els[0] as object)).toBeUndefined();
    expect(recs.newest("t", els[MAX_RECORDS] as object)).toBeDefined();
  });
});

describe("pageCompare", () => {
  it("answers whole-value equality or equivalence under the element's kind, and unknown for short, withheld or over-budget candidates", () => {
    const budget = new CompareBudget();
    const take = (): boolean => budget.take("t", "e1");
    expect(compareAnswers("robin@example.test", false, ["robin@example.test", "robin@example", "ro"], take)).toEqual(["equal", "different", "unknown"]);
    expect(compareAnswers("1.00", true, ["1.0", "1.5"], take)).toEqual(["equivalent", "different"]);
    expect(compareAnswers("1.00", false, ["1.0"], take)).toEqual(["different"]);
    expect(compareAnswers(null, false, ["robin@example.test"], take)).toEqual(["unknown"]);
    // Seven spent; the eighth is answered, the ninth is not.
    expect(compareAnswers("abc", false, ["abc", "abc"], take)).toEqual(["equal", "unknown"]);
  });

  it("bounds every control and every task", () => {
    const budget = new CompareBudget();
    for (let i = 0; i < COMPARE_PER_CONTROL; i++) expect(budget.take("t", "e1")).toBe(true);
    expect(budget.take("t", "e1")).toBe(false);
    const wide = new CompareBudget();
    for (let i = 0; i < COMPARE_PER_TASK; i++) expect(wide.take("t", `e${i}`)).toBe(true);
    expect(wide.take("t", "fresh")).toBe(false);
    expect(wide.take("other task", "fresh")).toBe(true);
  });
});
