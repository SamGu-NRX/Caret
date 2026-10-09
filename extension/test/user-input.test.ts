// Issue #26: which page events count as the user's own input on a field, and the time the walk reports for a control.
// One right answer per case, so each is pinned here on its own.
import { describe, expect, it } from "vitest";
import { USER_INPUT_RECENT_MS, UserInputs, isUserInput } from "../src/content/user-input.ts";

describe("isUserInput", () => {
  it("counts trusted typing, pasting and keys, and never Esc, which stops Caret", () => {
    expect(isUserInput({ isTrusted: true, type: "keydown", key: "D" })).toBe(true);
    expect(isUserInput({ isTrusted: true, type: "keydown", key: "Tab" })).toBe(true);
    expect(isUserInput({ isTrusted: true, type: "beforeinput" })).toBe(true);
    expect(isUserInput({ isTrusted: true, type: "input" })).toBe(true);
    expect(isUserInput({ isTrusted: true, type: "keydown", key: "Escape" })).toBe(false);
  });

  it("never counts an untrusted event, as Caret's own writes and a page's scripts make", () => {
    for (const type of ["keydown", "beforeinput", "input"]) expect(isUserInput({ isTrusted: false, type, key: "D" })).toBe(false);
  });

  it("does not count a click or a focus change: they change no text", () => {
    for (const type of ["pointerdown", "click", "focusin", "change"]) expect(isUserInput({ isTrusted: true, type })).toBe(false);
  });
});

describe("UserInputs", () => {
  // A tree of plain objects stands in for elements: `parent` links each to the one it sits in.
  const parent = new Map<object, object>();
  const within = (inner: object, outer: object): boolean => {
    for (let n: object | undefined = inner; n !== undefined; n = parent.get(n)) if (n === outer) return true;
    return false;
  };
  const form = {}, field = {}, inner = {}, other = {};
  parent.set(field, form).set(inner, field).set(other, form);
  const armedInputs = (): UserInputs<object> => {
    const t = new UserInputs<object>(within);
    t.armed(100_000, 0);
    return t;
  };

  it("keeps nothing in a frame no grant has covered", () => {
    const t = new UserInputs<object>(within);
    t.noted(field, 1000);
    expect(t.at(field, 1000)).toBeUndefined();
  });

  it("keeps input for USER_INPUT_RECENT_MS after the grants end, as Stop ends them, and none after that", () => {
    const t = new UserInputs<object>(within);
    t.armed(60_000, 1000);
    t.armed(0, 5000);
    t.noted(field, 5000 + USER_INPUT_RECENT_MS - 1);
    expect(t.at(field, 5000 + USER_INPUT_RECENT_MS)).toBe(5000 + USER_INPUT_RECENT_MS - 1);
    t.noted(other, 5000 + USER_INPUT_RECENT_MS);
    expect(t.at(other, 5000 + USER_INPUT_RECENT_MS)).toBeUndefined();
  });

  it("reports the latest input on the control or inside it, and none on a sibling or the form around it", () => {
    const t = armedInputs();
    t.noted(field, 1000);
    t.noted(inner, 1500);
    expect(t.at(field, 2000)).toBe(1500);
    expect(t.at(inner, 2000)).toBe(1500);
    expect(t.at(other, 2000)).toBeUndefined();
    // The form holds the field, so a walk of a control that is the whole form would see it; the field never sees the form's.
    t.noted(form, 1800);
    expect(t.at(field, 2000)).toBe(1500);
  });

  it("forgets input older than USER_INPUT_RECENT_MS", () => {
    const t = armedInputs();
    t.noted(field, 1000);
    expect(t.at(field, 1000 + USER_INPUT_RECENT_MS - 1)).toBe(1000);
    expect(t.at(field, 1000 + USER_INPUT_RECENT_MS)).toBeUndefined();
  });

  it("keeps the newest time when the same element is noted again", () => {
    const t = armedInputs();
    t.noted(field, 1000);
    t.noted(other, 1100);
    t.noted(field, 1200);
    expect(t.at(field, 1300)).toBe(1200);
    expect(t.at(other, 1300)).toBe(1100);
  });

  it("keeps at most 64 elements, dropping the oldest", () => {
    const t = armedInputs();
    const many = Array.from({ length: 70 }, () => ({}));
    many.forEach((el, i) => t.noted(el, 1000 + i));
    expect(t.at(many[0] as object, 2000)).toBeUndefined();
    expect(t.at(many[69] as object, 2000)).toBe(1069);
    expect(t.at(many[6] as object, 2000)).toBe(1006);
  });
});
