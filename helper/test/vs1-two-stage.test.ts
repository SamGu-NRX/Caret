// An Ask asks the base's value question first (fill on focus's shared candidate list, the B25 wording that quotes the
// request, FILL_CUTOFF on Jev's confidence), unchanged, and only a field it leaves unresolved (the wordings disagree, or
// agree under the cutoff) goes on to value settlement. So a field the base question settles is the base's, and a
// settlement request lists only the fields it did not settle. Fixture desks only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTestVerifier } from "../src/fill/contract.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { VALUE_TASK } from "../src/fill/fill.ts";
import { answerQuestion } from "../src/planner/ask.ts";
import { byOutput, proposedOf, runB31, valueQuestionFor, valueQuestions } from "./vs1-kit.ts";

// The verifier's requests go to the run's Jev, as live, not the suite's stand-in.
beforeEach(() => setTestVerifier(null));
afterEach(() => setTestVerifier(STAND_IN));

const settlementRequests = (r: Awaited<ReturnType<typeof runB31>>) => r.requests.filter((q) => q.purpose === "fill.values" && (q.state as { task?: string }).task === VALUE_TASK);

describe("the base's value question first", () => {
  it("asks it in the base's own wording, and sends no settlement request when it settles every field", async () => {
    const r = await runB31("b31-07", { values: true, firstPass: "oracle" });
    const first = r.requests.filter((q) => q.purpose === "fill.values");
    expect(first).toHaveLength(2);
    const ins = first.map((q) => String(Object.values(q.questions)[0]?.instructions));
    expect(ins[0]).toMatch(/^The user asked Caret: "fill the current residence section from my notes"\. /u);
    expect(ins[1]).toMatch(/^Instruction from the user: "fill the current residence section from my notes"\. /u);
    expect(String((first[0]?.state as { task?: string }).task)).toContain("Users most often copy from the window they were in just before the form.");
    expect(settlementRequests(r)).toHaveLength(0);
    expect(proposedOf(r, r.outcome)).toEqual({ "Moved in (MM/YYYY)": "08/2022" });
  });

  it("settles only the fields it left unresolved, in one pair that lists just those", async () => {
    // The base question splits on Monthly rent alone (its second wording answers none); settlement then agrees on 1,450.
    const split = await runB31("b31-07", {
      values: true,
      firstPass: "oracle",
      value: (label, _w, options) => (label === "Monthly rent ($)" ? byOutput(options, "1,450", 0.99) : undefined),
      firstAnswer: (label, w) => (label === "Monthly rent ($)" && w === 1 ? { choice: "none", confidence: 0.99 } : undefined),
    });
    const settle = settlementRequests(split);
    expect(settle).toHaveLength(2);
    for (const q of settle) expect(Object.keys(q.questions)).toEqual([valueQuestions(split, "Monthly rent ($)")[0]?.id]);
    expect(proposedOf(split, split.outcome)["Monthly rent ($)"]).toBe("1,450");
    expect(proposedOf(split, split.outcome)["Moved in (MM/YYYY)"]).toBe("08/2022");
  });

  // Live (vs1/abl/two-1, b31-13): the base filled Preferred time and the verifier refused it, exact twice under its cutoff.
  // Its options, stated only then, carried a part the verifier had minted as plan text, and the pick's fresh pair failed
  // its shape check (fill.values criteria allow no plan text).
  it("asks about a value the verifier refused at the base's fill, and a pick's fresh pair is sent", async () => {
    // Both base wordings choose the time code split from the email's date and time, as live; the verifier is unsure of it.
    const time = (criteria: Readonly<Record<string, string | null | undefined>>) => Object.entries(criteria).find(([, c]) => c?.startsWith('"08:45" (') === true)?.[0] ?? "none";
    const r = await runB31("b31-13", {
      values: true,
      firstPass: "oracle",
      firstAnswer: (label, _w, criteria) => (label === "Preferred time" ? { choice: time(criteria), confidence: 0.99 } : undefined),
      verify: (label) => (label === "Preferred time" ? { choice: "exact", confidence: 0.6 } : undefined),
    });
    const q = await valueQuestionFor(r, "Preferred time");
    expect(q, "a value question about Preferred time").not.toBeNull();
    const pick = q?.options.find((o) => o.option.kind === "value");
    const resume = q === null || pick === undefined ? "no value offered" : answerQuestion(q, [pick.option.id]);
    if (typeof resume === "string") throw new Error(resume);
    await r.resume(resume);
    expect(r.requests.filter((x) => x.purpose === "fill.values" && String(Object.values(x.questions)[0]?.instructions).includes("Explicit user selections: the value"))).toHaveLength(2);
  });

  // Sol review P2: a provider failure during settlement refused the whole Ask, so the base's own fills were lost too.
  it("keeps the base's fills when the provider fails value settlement, and leaves the unresolved field blank", async () => {
    const r = await runB31("b31-07", {
      values: true,
      firstPass: "oracle",
      firstAnswer: (label, w) => (label === "Monthly rent ($)" && w === 1 ? { choice: "none", confidence: 0.99 } : undefined),
      fail: (req) => req.purpose === "fill.values" && (req.state as { task?: string }).task === VALUE_TASK,
    });
    expect(settlementRequests(r)).toHaveLength(2);
    expect(proposedOf(r, r.outcome)).toEqual({ "Moved in (MM/YYYY)": "08/2022" });
  });
});
