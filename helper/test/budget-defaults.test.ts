import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../src/codemode/limits.ts";
import { MAX_GENERATOR_VISITS } from "../src/fill/candidates.ts";
import { REPLY_MARGIN_MS, WALK_MAX_MS, WALK_SHARE } from "../src/offers/first-look.ts";

describe("product budgets", () => {
  it("sets the measured candidate visit cap and preserves guest and first-look budgets", () => {
    expect(MAX_GENERATOR_VISITS).toBe(600);
    expect(DEFAULT_LIMITS).toMatchObject({ guestCpuMs: 250, watchdogMs: 1000, wallMs: 15_000, callbackMs: 10_000 });
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
    expect({ REPLY_MARGIN_MS, WALK_MAX_MS, WALK_SHARE }).toEqual({ REPLY_MARGIN_MS: 300, WALK_MAX_MS: 2000, WALK_SHARE: 0.25 });
  });
});
