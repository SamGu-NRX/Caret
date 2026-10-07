// W2 (AC1 step 7): the autocomplete field name the walker reads off a page's own control, the most reliable word a
// page gives for what a field takes. A read-only attribute: no user content.
import { describe, expect, it } from "vitest";
import { autocompleteOf } from "../src/content/walker.ts";

describe("autocompleteOf", () => {
  it.each([
    ["given-name", "given-name"],
    ["section-work shipping Given-Name", "given-name"],
    ["  billing postal-code ", "postal-code"],
    ["organization-title", "organization-title"],
    ["email webauthn", "email"],
    ["off", undefined],
    ["on", undefined],
    ["cc-number", undefined],
    ["current-password", undefined],
    ["", undefined],
  ] as const)("'%s' -> %s", (raw, want) => {
    expect(autocompleteOf(raw)).toBe(want);
  });
});
