// Review round 4, #4: an act's receipt is untrusted page text, so screening it must not put its values in the
// recognizers' caches, whose keys on this branch are the text itself. The cached recognizers are replaced here with
// ones that fail the test if screenReadings calls them.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/privacy/exclude.ts", async (orig) => ({
  ...(await orig<typeof import("../src/privacy/exclude.ts")>()),
  excludedValue: () => {
    throw new Error("screenReadings used the cached excludedValue");
  },
}));
vi.mock("../src/memory/sensitive.ts", async (orig) => ({
  ...(await orig<typeof import("../src/memory/sensitive.ts")>()),
  secretText: () => {
    throw new Error("screenReadings used the cached secretText");
  },
  markerWord: () => {
    throw new Error("screenReadings used the cached markerWord");
  },
}));

const { screenReadings } = await import("../src/engines/session.ts");

describe("screening an act's receipt", () => {
  it("recognizes values without the caches, and still drops readings that hold a value Caret never carries", () => {
    const r = (afterBlur: string) => screenReadings({ type: "pageResult", v: 1, id: "w", at: 0, outcome: "failed", detail: null, readings: { before: "", afterInput: afterBlur, afterBlur, invalid: false, error: "note" } });
    expect(r("4111 1111 1111 1111").readings).toBeUndefined();
    expect(r("My password is hunter2").readings).toBeUndefined();
    expect(r("Ines").readings).toEqual({ before: "", afterInput: "Ines", afterBlur: "Ines", invalid: false, error: null });
  });
});
