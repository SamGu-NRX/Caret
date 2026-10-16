// Issue #54: an undo of Caret's own combobox pick is judged by the pick's page-side record (revs.ts ChoiceRecords),
// as a text write's undo is judged by its before record (WriteRecords). The record holds what Caret chose and the
// trusted-event counts at that moment (the user's edits, and the trusted pointers and keys that touch the control
// without editing it, which a re-pick of the same option produces); the undo runs only while the record stands, the
// control still shows that choice, and neither count has moved. Plain objects stand for elements, as revs.test.ts
// does for Revs.
import { describe, expect, it } from "vitest";
import { ChoiceRecords, MAX_CHOICE_RECORDS, choiceCheck } from "../src/content/revs.ts";

const PICK = "Bluebell State";
const OTHER = "Redwood College";
const still = { shown: PICK, trusted: 0, touches: 0 };

describe("a combobox undo runs only while the pick's record stands", () => {
  it("lets an undo run on the control Caret picked, still showing that choice, with no trusted event since", () => {
    const el = {};
    const recs = new ChoiceRecords<object>();
    recs.begin("t1", el, PICK, 0, 0);
    expect(choiceCheck(recs.newest("t1", el), el, still, PICK)).toBeNull();
  });

  it("reads the choice by its name, folded as names fold (NFKC, case, spaces)", () => {
    const el = {};
    const recs = new ChoiceRecords<object>();
    recs.begin("t1", el, "Bluebell  State", 0, 0);
    expect(choiceCheck(recs.newest("t1", el), el, { shown: "bluebell state", trusted: 0, touches: 0 }, "Bluebell State")).toBeNull();
  });

  it("refuses an undo where this page keeps no record of Caret picking there: none was begun, or the element was never begun for this task", () => {
    const el = {};
    expect(choiceCheck(undefined, el, still, PICK)).toBe("noRecord");
    const recs = new ChoiceRecords<object>();
    expect(choiceCheck(recs.newest("t1", el), el, still, PICK)).toBe("noRecord");
  });

  it("refuses an undo that names another choice than the one the record holds", () => {
    const el = {};
    const recs = new ChoiceRecords<object>();
    recs.begin("t1", el, PICK, 0, 0);
    expect(choiceCheck(recs.newest("t1", el), el, still, OTHER)).toBe("noRecord");
  });

  it("refuses an undo of a record kept for another element (a replaced control keeps no undo)", () => {
    const el = {};
    const twin = {};
    const recs = new ChoiceRecords<object>();
    recs.begin("t1", el, PICK, 0, 0);
    expect(choiceCheck(recs.newest("t1", el), twin, still, PICK)).toBe("gone");
  });

  it("refuses an undo when the control shows another choice now than the one Caret picked", () => {
    const el = {};
    const recs = new ChoiceRecords<object>();
    recs.begin("t1", el, PICK, 0, 0);
    expect(choiceCheck(recs.newest("t1", el), el, { shown: OTHER, trusted: 0, touches: 0 }, PICK)).toBe("changed");
  });

  it("refuses an undo when the person's own editing reached the control after the pick", () => {
    const el = {};
    const recs = new ChoiceRecords<object>();
    recs.begin("t1", el, PICK, 0, 0);
    expect(choiceCheck(recs.newest("t1", el), el, { ...still, trusted: 2 }, PICK)).toBe("mayIncludeInput");
  });

  it("refuses an undo when a trusted pointer or key touched the control after the pick, even though the shown choice is still Caret's", () => {
    // The person re-picked the same option: clicking the control open is a trusted pointer, so the undo may not run.
    const el = {};
    const recs = new ChoiceRecords<object>();
    recs.begin("t1", el, PICK, 0, 0);
    expect(choiceCheck(recs.newest("t1", el), el, { ...still, touches: 3 }, PICK)).toBe("mayIncludeInput");
  });

  it("judges the counts Caret itself recorded, not the ones an earlier pick saw", () => {
    const el = {};
    const recs = new ChoiceRecords<object>();
    recs.begin("t1", el, PICK, 2, 4);
    expect(choiceCheck(recs.newest("t1", el), el, { shown: PICK, trusted: 2, touches: 4 }, PICK)).toBeNull();
    expect(choiceCheck(recs.newest("t1", el), el, { shown: PICK, trusted: 3, touches: 4 }, PICK)).toBe("mayIncludeInput");
    expect(choiceCheck(recs.newest("t1", el), el, { shown: PICK, trusted: 2, touches: 5 }, PICK)).toBe("mayIncludeInput");
  });
});

describe("the page's choice records, like the writes' before records", () => {
  it("keeps the newest record per task and element, and tasks never collide", () => {
    const el = {};
    const recs = new ChoiceRecords<object>();
    recs.begin("t1", el, "First Option", 0, 0);
    recs.begin("t2", el, "Second Option", 0, 0);
    recs.begin("t1", el, "Third Option", 0, 0);
    expect(recs.newest("t1", el)?.wrote).toBe("Third Option");
    expect(recs.newest("t2", el)?.wrote).toBe("Second Option");
    expect(recs.newest("t3", el)).toBeUndefined();
  });

  it("keeps different elements apart under one task", () => {
    const a = {};
    const b = {};
    const recs = new ChoiceRecords<object>();
    recs.begin("t1", a, "First Option", 0, 0);
    recs.begin("t1", b, "Second Option", 0, 0);
    expect(recs.newest("t1", a)?.wrote).toBe("First Option");
    expect(recs.newest("t1", b)?.wrote).toBe("Second Option");
  });

  it("takes the used record away on pop, so a second undo has nothing to stand on", () => {
    const el = {};
    const recs = new ChoiceRecords<object>();
    recs.begin("t1", el, PICK, 0, 0);
    recs.pop("t1", el);
    expect(recs.newest("t1", el)).toBeUndefined();
  });

  it("keeps a record only for a live element", () => {
    const el = {};
    const recs = new ChoiceRecords<object>();
    recs.begin("t1", el, PICK, 0, 0);
    expect(recs.newest("t1", el)?.el.deref()).toBe(el);
  });

  it(`holds at most ${MAX_CHOICE_RECORDS} records, and the oldest go first`, () => {
    const recs = new ChoiceRecords<object>();
    const first = {};
    for (let i = 0; i < MAX_CHOICE_RECORDS; i++) recs.begin("t1", i === 0 ? first : {}, `Option ${i}`, 0, 0);
    expect(recs.newest("t1", first)?.wrote).toBe("Option 0");
    recs.begin("t1", {}, "Option Over", 0, 0);
    expect(recs.newest("t1", first)).toBeUndefined();
  });
});
