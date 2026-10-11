import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../src/codemode/limits.ts";
import { collectCandidates, GENERATOR_BUDGET_MS } from "../src/fill/candidates.ts";
import { REPLY_MARGIN_MS, WALK_MAX_MS, WALK_SHARE } from "../src/offers/first-look.ts";
import { largeScene } from "./large-scene.ts";

// Load-independent semantic tests must not buy their stability by relaxing product limits.
// These are the budgets at 20fec55, before the test-only clock and sandbox overrides.
describe("product budgets", () => {
  it("keeps the candidate, guest and first-look budgets unchanged", () => {
    expect(GENERATOR_BUDGET_MS).toBe(15);
    expect(DEFAULT_LIMITS).toMatchObject({ guestCpuMs: 250, watchdogMs: 1000, wallMs: 15_000, callbackMs: 10_000 });
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
    expect({ REPLY_MARGIN_MS, WALK_MAX_MS, WALK_SHARE }).toEqual({ REPLY_MARGIN_MS: 300, WALK_MAX_MS: 2000, WALK_SHARE: 0.25 });
  });

  it("still stops candidate generation at the default 15 ms with an injected clock", () => {
    const scene = largeScene();
    const run = (elapsed: number) => {
      let reads = 0;
      return collectCandidates(scene.model, scene.formWindowId, { now: 2_000_000, clock: () => reads++ === 0 ? 0 : elapsed });
    };
    const onTime = run(15);
    expect(onTime.stats.overBudget).toBe(false);
    const late = run(16);
    expect(late.stats.overBudget).toBe(true);
    // The generator checks every 64 items, so it keeps the values read before that check.
    expect(late.candidates.length).toBeLessThan(onTime.candidates.length);
    expect(late.stats.ms).toBe(16);
  });
});
