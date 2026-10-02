import { describe, expect, it } from "vitest";
import { containsBounded, EditSpan, normalizeValue } from "../src/normalize.ts";

describe("normalizeValue", () => {
  it("compares phones by their last ten digits", () => {
    expect(normalizeValue("+1 (512) 555-0142", "phone")).toBe("5125550142");
    expect(normalizeValue("512.555.0142", "phone")).toBe("5125550142");
  });
  it("lowercases emails and drops mailto", () => {
    expect(normalizeValue("mailto:Dana.W@Example.com", "email")).toBe("dana.w@example.com");
  });
  it("drops scheme, www and trailing slash from URLs", () => {
    expect(normalizeValue("https://www.Example.org/a/", "url")).toBe("example.org/a");
  });
  it("keeps only digits and the decimal point of amounts", () => {
    expect(normalizeValue("$1,315.50", "amount")).toBe("1315.50");
    expect(normalizeValue("USD 48.00", "amount")).toBe("48");
  });
  it("folds case, whitespace, outer quotes and spacing around separators for other text", () => {
    expect(normalizeValue("  “Austin ,  TX” ", null)).toBe("austin,tx");
  });
});

describe("containsBounded", () => {
  it("requires a non-alphanumeric boundary on both sides", () => {
    expect(containsBounded("Order ORD-48213 placed", "ORD-48213")).toBe(true);
    expect(containsBounded("Dana Whitfield", "Dana W")).toBe(false);
    expect(containsBounded("xORD-48213", "ORD-48213")).toBe(false);
    expect(containsBounded("ORD-48213", "ORD-48213")).toBe(true);
  });
  it("finds a later bounded occurrence after an unbounded one", () => {
    expect(containsBounded("abc12 abc", "abc")).toBe(true);
  });
  it("never matches an empty needle", () => {
    expect(containsBounded("anything", "")).toBe(false);
  });
});

describe("EditSpan", () => {
  const run = (initial: string, ...values: string[]): string => {
    const e = new EditSpan(initial);
    for (const v of values) e.observe(v);
    return e.entered();
  };
  it("returns the whole value typed into an empty field", () => {
    expect(run("", "h", "he", "hello")).toBe("hello");
  });
  it("returns only the appended part of an edit", () => {
    expect(run("Dear ,", "Dear D,", "Dear Dana,")).toBe("Dana");
  });
  it("returns the whole new text when old text was selected and retyped, even if the ends coincide", () => {
    expect(run("Dana Whitfield", "W", "Weekly sync notes", "Weekly sync notes 3 field")).toBe("Weekly sync notes 3 field");
  });
  it("returns nothing when the value did not change", () => {
    expect(run("abc")).toBe("");
    expect(run("abc", "abc")).toBe("");
  });
});
