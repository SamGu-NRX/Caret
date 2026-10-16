// What the content script keeps so that a text control's text never leaves the page (content/revs.ts): change
// counters, where the text came from, the page-held `before` of Caret's writes, and the compare budget. Plain objects
// stand in for elements; page-state.ts and walker.ts read the same rules off the DOM.
import { describe, expect, it } from "vitest";
import { COMPARE_PER_CONTROL, COMPARE_PER_TASK, CompareBudget, MAX_RECORDS, Revs, WriteRecords, compareAnswers, presence, restoreCheck, withheldFor } from "../src/content/revs.ts";

describe("rev", () => {
  it("bumps on a trusted event, on a reading that sees other text, and on Caret's write, and not otherwise", () => {
    const revs = new Revs<object>();
    const el = {};
    expect(revs.read(el, "", true).rev).toBe(0);
    expect(revs.read(el, "", true).rev).toBe(0);
    revs.trusted(el, "", true);
    expect(revs.read(el, "a", true).rev).toBe(2);
    expect(revs.caretWrote(el, "Robin", false)).toBe(3);
    expect(revs.read(el, "Robin", true).rev).toBe(3);
    // A page script's change, seen by the next reading.
    expect(revs.read(el, "Robin V", true).rev).toBe(4);
  });
});

describe("where an input's text came from", () => {
  it("is prefilled when first seen holding text, and stays so until it is seen empty", () => {
    const revs = new Revs<object>();
    const copy = {};
    expect(revs.read(copy, "Tr0mbone-Lattice-91", true).origin).toBe("prefilled");
    // The user typing into it does not make the text theirs: the page's text is still in it.
    revs.trusted(copy, null, true);
    expect(revs.read(copy, "Tr0mbone-Lattice-91x", true).origin).toBe("prefilled");
    expect(revs.read(copy, "", true).origin).toBe("clean");
    revs.trusted(copy, null, true);
    expect(revs.read(copy, "mine", true).origin).toBe("clean");
  });

  it("reads the text an edit starts from before the user's first keystroke counts", () => {
    const revs = new Revs<object>();
    const el = {};
    // beforeinput is the first contact: the field already held text the page put there.
    revs.trusted(el, "482913", true);
    expect(revs.read(el, "4829131", true).origin).toBe("prefilled");
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
    revs.trusted(el, "", true);
    expect(revs.read(el, "AB", true).origin).toBe("clean");
  });

  it("is Caret's after Caret's write, until anyone else changes it", () => {
    const revs = new Revs<object>();
    const el = {};
    revs.read(el, "", true);
    revs.caretWrote(el, "Robin Vale", false);
    expect(revs.read(el, "Robin Vale", true).origin).toBe("caret");
    expect(revs.read(el, "Robin Vale!", true).origin).toBe("programmatic");
    const typed = {};
    revs.read(typed, "", true);
    revs.caretWrote(typed, "Robin", false);
    revs.trusted(typed, null, true);
    expect(revs.read(typed, "Robin V", true).origin).toBe("clean");
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
    const rec = recs.begin("t", "e1", el, "", "1", 0, 0);
    rec.revAfter = 1;
    expect(restoreCheck(recs.newest("t", "e1"), el, { rev: 1, trusted: 0, text: "1", numeric: false })).toBeNull();
    // B29: a number field shows Caret's 1 as 1.00.
    expect(restoreCheck(recs.newest("t", "e1"), el, { rev: 1, trusted: 0, text: "1.00", numeric: true })).toBeNull();
    expect(restoreCheck(recs.newest("t", "e1"), el, { rev: 1, trusted: 0, text: "1.00", numeric: false })).toBe("changed");
    expect(restoreCheck(recs.newest("t", "e1"), el, { rev: 2, trusted: 0, text: "1", numeric: false })).toBe("changed");
    expect(restoreCheck(recs.newest("t", "e1"), el, { rev: 2, trusted: 1, text: "1", numeric: false })).toBe("mayIncludeInput");
    expect(restoreCheck(recs.newest("t", "e1"), {}, { rev: 1, trusted: 0, text: "1", numeric: false })).toBe("gone");
    expect(restoreCheck(recs.newest("t", "e2"), el, { rev: 1, trusted: 0, text: "1", numeric: false })).toBe("noRecord");
    expect(restoreCheck(recs.newest("other", "e1"), el, { rev: 1, trusted: 0, text: "1", numeric: false })).toBe("noRecord");
  });

  it("goes back newest first, write by write, and forgets the oldest past its bound", () => {
    const recs = new WriteRecords<object>();
    recs.begin("t", "e1", el, "", "Robin", 0, 0);
    recs.begin("t", "e1", el, "Robin", "Robin Vale", 1, 0);
    expect(recs.newest("t", "e1")?.before).toBe("Robin");
    recs.pop("t", "e1");
    expect(recs.newest("t", "e1")?.before).toBe("");
    recs.pop("t", "e1");
    expect(recs.newest("t", "e1")).toBeUndefined();
    for (let i = 0; i <= MAX_RECORDS; i++) recs.begin("t", `e${i}`, el, "", "x", 0, 0);
    expect(recs.newest("t", "e0")).toBeUndefined();
    expect(recs.newest("t", `e${MAX_RECORDS}`)).toBeDefined();
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
