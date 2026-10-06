// H14: a file control's accept attribute, as the walker reports it (PageControl.accept). The host's attach row opens its
// chooser on these types. Extension tests run in Node without a DOM, so this checks the parse the walker applies to
// `input.accept`; the browser-run acceptance in fixtures/web-form covers the walk itself.
import { describe, expect, it } from "vitest";
import { acceptOf } from "../src/content/walker.ts";

describe("a file input's accepted types (H14)", () => {
  it("keeps extensions and MIME types, lowercased, and drops what is neither", () => {
    expect(acceptOf(".PDF, .doc,application/pdf, junk token,image/*")).toEqual([".pdf", ".doc", "application/pdf", "image/*"]);
  });

  it("gives no list when nothing is set or nothing survives, so the control carries no key", () => {
    expect(acceptOf("")).toBeUndefined();
    expect(acceptOf("  ,  ")).toBeUndefined();
    expect(acceptOf("pdf, */*, .")).toBeUndefined();
  });

  it("keeps each type once, in order, and at most 20", () => {
    expect(acceptOf(".pdf,.PDF, .doc ,.pdf")).toEqual([".pdf", ".doc"]);
    const many = Array.from({ length: 30 }, (_, i) => `.x${i}`).join(",");
    expect(acceptOf(many)).toEqual(Array.from({ length: 20 }, (_, i) => `.x${i}`));
  });

  it("drops an extension over 16 characters after its dot", () => {
    expect(acceptOf(".abcdefghijklmnop,.abcdefghijklmnopq")).toEqual([".abcdefghijklmnop"]);
  });
});
