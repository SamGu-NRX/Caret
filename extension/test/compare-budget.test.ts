// pageCompare's per-origin hourly budget (worker/compare-budget.ts): kept in session storage, so a stopped and
// restarted worker spends from what was spent before it (audit of PR #52, LOW 9).
import { describe, expect, it } from "vitest";
import { COMPARE_PER_ORIGIN, COMPARE_WINDOW_MS, CompareSpend, type BudgetStore } from "../src/worker/compare-budget.ts";

function store(): BudgetStore & { kept: Map<string, unknown> } {
  const kept = new Map<string, unknown>();
  return {
    kept,
    get: async (key) => (kept.has(key) ? { [key]: structuredClone(kept.get(key)) } : {}),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) kept.set(k, structuredClone(v));
    },
  };
}

describe("the per-origin compare budget", () => {
  it("survives a worker restart: a new worker on the same session storage allows none past the bound", async () => {
    const s = store();
    const now = 1_000_000;
    expect(await new CompareSpend(s).allowance("https://a.example", COMPARE_PER_ORIGIN, now)).toBe(COMPARE_PER_ORIGIN);
    // The worker stops; the next one starts with nothing in memory.
    const restarted = new CompareSpend(s);
    expect(await restarted.allowance("https://a.example", 8, now + 1)).toBe(0);
    expect(await restarted.allowance("https://b.example", 8, now + 1)).toBe(8);
    // An hour after the spend, it is allowed again.
    expect(await restarted.allowance("https://a.example", 8, now + COMPARE_WINDOW_MS)).toBe(8);
  });

  it("spends compares that arrive together one after another, so they never share a balance", async () => {
    const spend = new CompareSpend(store());
    const got = await Promise.all(Array.from({ length: 40 }, () => spend.allowance("https://a.example", 8, 5)));
    expect(got.reduce((a, b) => a + b, 0)).toBe(COMPARE_PER_ORIGIN);
  });

  it("allows nothing, and says why, when the storage fails", async () => {
    const why: string[] = [];
    const broken: BudgetStore = { get: async () => Promise.reject(new Error("no session storage")), set: async () => {} };
    expect(await new CompareSpend(broken, (w) => why.push(w)).allowance("https://a.example", 3)).toBe(0);
    expect(why).toEqual(["the compare budget for https://a.example could not be read or kept (no session storage), so its candidates answer unknown"]);
  });
});
