// W2 (AC1 step 7): the autocomplete field name the walker reads off a page's own control, the most reliable word a
// page gives for what a field takes. A read-only attribute: no user content.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTOCOMPLETE_TOKENS, autocompleteOf } from "../src/content/walker.ts";

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

// H1: the helper's zod enum refuses the whole snapshot for a token it does not list, so the walker's list and the
// helper's (protocol.ts AutocompleteToken, exported to the schema) must be the same list.
describe("AUTOCOMPLETE_TOKENS", () => {
  it("is the helper's AutocompleteToken, as its exported schema lists it", () => {
    const schema: unknown = JSON.parse(readFileSync(fileURLToPath(new URL("../../helper/schemas/screen-protocol.schema.json", import.meta.url)), "utf8"));
    const enums: unknown[][] = [];
    const walk = (v: unknown, key: string | null): void => {
      if (Array.isArray(v)) return v.forEach((x) => walk(x, null));
      if (v === null || typeof v !== "object") return;
      const o = v as Record<string, unknown>;
      if (key === "autocomplete" && Array.isArray(o.enum)) enums.push(o.enum);
      for (const [k, x] of Object.entries(o)) walk(x, k);
    };
    walk(schema, null);
    expect(enums.length).toBeGreaterThan(0);
    for (const e of enums) expect(e).toEqual([...AUTOCOMPLETE_TOKENS]);
  });
});
