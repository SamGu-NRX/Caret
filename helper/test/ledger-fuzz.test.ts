// The output ledger's end-to-end consistency check (scripts/ledger-fuzz-cases.ts), a fixed-seed sample of it in the
// suite: every request a fill seals and sends, counted again by a counter that shares nothing with the ledger's measure,
// takes no conversation past its limit. scripts/ledger-fuzz.ts runs the full set (2,400 cases at seed 20261008).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTestVerifier } from "../src/fill/contract.ts";
import { runFuzz } from "../scripts/ledger-fuzz-cases.ts";
import { STAND_IN } from "./setup/verifier.ts";

// The cases' scripted Jev answers the verifier too, through the same seal; the suite's stand-in would skip it.
beforeAll(() => setTestVerifier(null));
afterAll(() => setTestVerifier(STAND_IN));

describe("the ledger against an independent count, seed 20261008", () => {
  // About 6 s alone; the full suite at the default worker count runs it slower, so it has 120.
  it("sends nothing past a conversation's limit in 200 cases, and reads every window as the counter does", async () => {
    const run = await runFuzz({ seed: 20261008, cases: Array.from({ length: 200 }, (_, i) => i) });
    const flagged = run.results.filter((r) => r.flagged.length > 0).map((r) => ({ case: r.case, mode: r.mode, event: r.event, flagged: r.flagged }));
    expect(flagged, "requests the counter finds past a limit").toEqual([]);
    expect(run.summary.harnessErrors).toBe(0);
    expect(run.results.filter((r) => r.inventoryMismatch.length > 0).map((r) => r.case), "inventories the counter reads otherwise").toEqual([]);
    // Not vacuous: most cases send requests, and some are refused.
    expect(run.summary.requestsSent).toBeGreaterThan(500);
    expect(run.summary.requestsRefused).toBeGreaterThan(0);
  }, 120_000);
});
