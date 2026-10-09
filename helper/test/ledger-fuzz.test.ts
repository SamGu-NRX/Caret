// The output ledger's end-to-end consistency check (scripts/ledger-fuzz-cases.ts), a fixed-seed sample of it in the
// suite: every request a fill seals and sends, counted again by a counter that shares nothing with the ledger's measure,
// takes no conversation past its limit. scripts/ledger-fuzz.ts runs the full set (2,400 cases at seed 20261008).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTestVerifier } from "../src/fill/contract.ts";
import { readFileSync } from "node:fs";
import { normalize, runFuzz, type Desk } from "../scripts/ledger-fuzz-cases.ts";
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
    // Source-supported choices are sent, some naming a whole window in source_notes, and the answers take some of them.
    expect(run.summary.choiceWindowRequests).toBeGreaterThan(0);
    expect(run.summary.choicesChosen).toBeGreaterThan(0);
  }, 120_000);
});

describe("the counter's normalization, written again from section 2", () => {
  const n = (t: string): string => normalize(t).cps.join("");
  it("folds case fully and decomposes each scalar on its own: Straße is STRASSE, a composed café the decomposed one, ß is SS", () => {
    expect(n("Straße")).toBe(n("STRASSE"));
    expect(n("caf\u00e9")).toBe(n("cafe\u0301"));
    expect(n("\u00df")).toBe(n("SS"));
    // White space runs collapse to one space, and the ends are trimmed.
    expect(n("  a \t\n b  ")).toBe("a b");
  });
});

// Two desks the extended generator found and minimized (fixtures/ledger-fuzz): a chat whose line a note copies whole,
// closed before the first request; the note goes whole in source_notes, or in a choice's whole-window evidence.
describe("windows on screen when the operation starts", () => {
  it.each(["min-7-2371", "min-7-60"])("charges a chat that closed before the first request for what the request copies of it: %s", async (name) => {
    const desk = JSON.parse(readFileSync(new URL(`../fixtures/ledger-fuzz/${name}.desk.json`, import.meta.url), "utf8")) as Desk;
    const run = await runFuzz({ seed: 7, cases: [0], replay: desk });
    expect(run.summary.harnessErrors).toBe(0);
    expect(run.results.flatMap((r) => r.flagged), "requests the counter finds past a limit").toEqual([]);
  }, 60_000);
});
