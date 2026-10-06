// C1 item 3: the combobox handler's decisions that need no DOM (shared/choose.ts). The DOM side (typing before a list
// shows, waiting out a loading list, the pick itself) is checked against F1's own pages in a browser
// (fixtures/web-form/accept.ts, "C1" checks), by the page's state, not by Caret's reading.
import { describe, expect, it } from "vitest";
import { hiddenAfterStop, pickProblems, settles, typesToOpen, type PickState } from "../src/shared/choose.ts";

describe("a list that opens only once the control has text (F1's School picker, Ashby's location)", () => {
  it("types the filter first into a text field that filters as you type", () => {
    expect(typesToOpen(true, "list")).toBe(true);
    expect(typesToOpen(true, "both")).toBe(true);
    expect(typesToOpen(true, null)).toBe(true);
  });
  it("never types into a field that says it does not filter, or a control with no text field", () => {
    expect(typesToOpen(true, "none")).toBe(false);
    expect(typesToOpen(false, "list")).toBe(false);
  });
});

describe("a filtered list that queries as you type waits for its results", () => {
  const r = (names: string[], busy = false) => ({ names, busy });
  it("does not settle while the page says the results are loading, even on two equal readings", () => {
    // React-select async keeps an older query's options on screen while it loads the next one.
    expect(settles(r(["Northfield College"], true), r(["Northfield College"], true))).toBe(false);
    expect(settles(r(["Northfield College"], true), r(["Northfield College"], false))).toBe(false);
  });
  it("settles on two equal, non-empty readings taken after loading ended", () => {
    expect(settles(r(["Northfield State University"]), r(["Northfield State University"]))).toBe(true);
  });
  it("does not settle on an empty list, a first reading, or a list still changing", () => {
    expect(settles(null, r(["Northfield State University"]))).toBe(false);
    expect(settles(r([]), r([]))).toBe(false);
    expect(settles(r(["Northfield State University"]), r(["Northfield State University", "Northfield College"]))).toBe(false);
  });
});

describe("a pick is verified by the page's own state", () => {
  const ok: PickState = { flavor: "aria", value: "Northfield State University", before: "", afterBlur: "Northfield State University", hiddenInput: "none", expanded: false, typedText: true, closedOnPick: true };
  it("accepts a pick the list closed on, that the control shows", () => {
    expect(pickProblems(ok)).toEqual([]);
  });
  it("refuses an ARIA text combobox whose list stayed open on the press: its text may be only the filter Caret typed", () => {
    expect(pickProblems({ ...ok, closedOnPick: false })).toEqual(["the list stayed open after the option was pressed, so the text the control shows may be only the filter Caret typed"]);
  });
  it("needs no closing for a control whose shown value only a pick sets (react-select's chip, untyped text)", () => {
    expect(pickProblems({ ...ok, flavor: "reactSelect", hiddenInput: "none", typedText: true, closedOnPick: false })).toEqual([]);
    expect(pickProblems({ ...ok, typedText: false, closedOnPick: false })).toEqual([]);
  });
  it("keeps the checks it had: shown text, react-select's form value, and the list closed", () => {
    expect(pickProblems({ ...ok, afterBlur: "" })).toEqual(["the control kept its old value"]);
    expect(pickProblems({ ...ok, afterBlur: "Northfield College" })).toEqual(["the control shows 'Northfield College'"]);
    expect(pickProblems({ ...ok, flavor: "reactSelect", hiddenInput: "unchanged" })).toEqual(["react-select's form value did not change"]);
    expect(pickProblems({ ...ok, expanded: true })).toEqual(["the list is still open"]);
  });
});

describe("a stop says whether react-select's form value moved", () => {
  it("reports any change of the hidden input as set, so a stop that changed it never reads as put back", () => {
    expect(hiddenAfterStop(null, null)).toBe("none");
    expect(hiddenAfterStop("", "")).toBe("unchanged");
    expect(hiddenAfterStop("us", "us")).toBe("unchanged");
    expect(hiddenAfterStop("", "ca")).toBe("set");
    expect(hiddenAfterStop("us", "")).toBe("set");
  });
});
