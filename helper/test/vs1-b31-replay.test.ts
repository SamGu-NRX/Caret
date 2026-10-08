// The 26 B31 value losses and 5 verifier losses (live B31 at v2/g35 c213ae2c; fixtures/vs1/b31-value-losses.json), replayed
// on their corpus desks with every downstream veto active. A recorded answer is mapped onto the new options by the
// output or the candidate it named; one that names no option now is answered none, never renormalized or summed. Each
// recorded pair stays unadmitted; the four wrong agreements are never written, automatically or after the user picks
// one; explicit negatives stay unoffered or unwritten. Fresh model runs are the live comparison's to measure.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { checkValues, makeFieldContract, setTestVerifier } from "../src/fill/contract.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { AskAsks, answerQuestion } from "../src/planner/ask.ts";
import { B31, byOutput, byRecorded, corpus, proposedOf, runB31, valueQuestionFor, valueQuestions, type Answer, type Run } from "./vs1-kit.ts";

// The verifier answers as each test says (the kit's oracle calls every value exact), not as the suite's stand-in.
beforeEach(() => {
  setGeneratorClock(() => 0);
  setTestVerifier(null);
});
afterEach(() => {
  setGeneratorClock(null);
  setTestVerifier(STAND_IN);
});

interface Recorded {
  ask: string;
  field: string;
  kind: "disagree" | "low" | "wrong";
  a: { text: string | null; confidence: number };
  b: { text: string | null; confidence: number };
  key: string;
}
interface Verified {
  ask: string;
  field: string;
  a: { choice: string; confidence: number };
  b: { choice: string; confidence: number };
  key: string;
}
const LOSSES = JSON.parse(readFileSync(new URL("../fixtures/vs1/b31-value-losses.json", import.meta.url), "utf8")) as { values: Recorded[]; verifier: Verified[] };
const WRONG = LOSSES.values.filter((c) => c.kind === "wrong");

const replayed = (c: Recorded) => (label: string, wording: 0 | 1, options: Parameters<typeof byRecorded>[0]): Answer | undefined => {
  if (label !== c.field) return undefined;
  const r = wording === 0 ? c.a : c.b;
  return byRecorded(options, r.text, r.confidence);
};

describe("the recorded value pairs write nothing the key calls wrong", () => {
  it("covers 8 disagreements and 18 low agreements, four of them wrong", () => {
    expect([LOSSES.values.filter((c) => c.kind === "disagree").length, LOSSES.values.filter((c) => c.kind !== "disagree").length, WRONG.length]).toEqual([8, 18, 4]);
  });

  // Under the probability bar (fill.ts topProbability) a recorded pair may now admit its value; only the key's own value may
  // be written, and a pair whose value the key calls wrong never is.
  it.each(LOSSES.values.map((c) => [`${c.ask} ${c.field}`, c] as const))("%s", async (_, c) => {
    for (const window of ["page", "reader"] as const) {
      const r = await runB31(c.ask, { window, values: true, value: replayed(c) });
      const written = proposedOf(r, r.outcome)[c.field];
      const form = corpus.forms.find((f) => f.id === B31.find((x) => x.id === c.ask)?.form);
      const accepted = [c.key, ...(form?.fields.find((f) => f.label === c.field)?.accept ?? [])];
      if (written !== undefined) expect(accepted, `${window}: wrote '${written}'`).toContain(written);
    }
  });
});

describe("the four wrong agreements are never written", () => {
  // Where each wrong value stops, stated, so no case passes because a question or an option happened to be missing.
  // Ines's cell and office are someone else's for Theo's fields and Dana's email is not Kenji's: the owner exclusion keeps
  // all three out of the value questions. Wren's phone is offered to Jev but not to the user: a rule relating it to the
  // field (relationalHold) holds it, so no click can pick it.
  const OFFERED_TO_JEV: Record<string, boolean> = { "b31-08 Mobile phone": false, "b31-08 Home phone": false, "b31-09 Reference phone": true, "b31-14 Email address": false };
  it.each(WRONG.map((c) => [`${c.ask} ${c.field}`, c] as const))("%s: stopped where expected, and never written", async (name, c) => {
    const wrong = c.a.text as string;
    const r = await runB31(c.ask, { values: true, value: replayed(c) });
    expect(Object.values(proposedOf(r, r.outcome))).not.toContain(wrong);
    expect(valueQuestions(r, c.field).some((q) => q.options.some((o) => o.output === wrong)), "offered to Jev").toBe(OFFERED_TO_JEV[name]);
    const q = await valueQuestionFor(r, c.field);
    expect(q?.options.some((o) => o.option.kind === "value" && o.option.value === wrong) ?? false, "offered to the user").toBe(false);
  });

  // Hostile continuations that do run: every value b31-09's Reference phone question offers is picked in turn, and both fresh
  // wordings then choose Wren's phone, or the pick, at 0.99. Neither writes Wren's phone.
  it("b31-09: a pick of any offered value, then fresh votes for Wren's phone or for the pick, never writes Wren's phone", async () => {
    const c = WRONG.find((x) => x.ask === "b31-09") as Recorded;
    const wrong = c.a.text as string;
    for (const fresh of ["wrong", "pick"] as const) {
      let picked = "";
      const r = await runB31("b31-09", {
        values: true,
        value: (label, w, options, req) => {
          if (label !== c.field) return undefined;
          if (!/Explicit user selections: (?!none)/u.test(String(Object.values(req.questions).find((q) => String(q.instructions).includes(c.field))?.instructions))) return replayed(c)(label, w, options);
          return byOutput(options, fresh === "wrong" ? wrong : picked, 0.99);
        },
      });
      const q = await valueQuestionFor(r, c.field);
      expect(q).not.toBeNull();
      const values = (q as NonNullable<typeof q>).options.filter((o) => o.option.kind === "value");
      expect(values.length).toBeGreaterThan(0);
      for (const o of values) {
        picked = o.option.kind === "value" ? o.option.value : "";
        const resume = answerQuestion(q as NonNullable<typeof q>, [o.option.id]);
        if (typeof resume === "string") throw new Error(resume);
        const after = proposedOf(r, await r.resume(resume));
        expect(Object.values(after), `${fresh} after picking ${picked}`).not.toContain(wrong);
        if (fresh === "wrong") expect(after[c.field], `a vote for another value admits nothing after picking ${picked}`).toBeUndefined();
      }
    }
  });
});

describe("the recorded verifier pairs still fail", () => {
  // Isolated: the write contract alone, each recorded pair as the verifier's answer to the key's own value.
  it.each(LOSSES.verifier.map((c) => [`${c.ask} ${c.field}`, c] as const))("%s: refused by checkValues", async (_, c) => {
    const field = makeFieldContract({ windowId: "form", node: { key: "f", parent: null, role: "AXTextField", label: c.field }, descriptor: `Text field. Label: '${c.field}'.`, name: c.field, labelWords: [c.field], control: "text", kinds: new Set(), part: null });
    const pair: AskJev = async (req) => ({ model: "recorded", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, String(req.questions[id]?.instructions).startsWith("Exact output:") ? c.b : c.a])), inputTokens: 0, latencyMs: 0, costUsd: 0 });
    const r = await checkValues([{ field, text: c.key, display: c.key, provenance: { kind: "instruction", span: c.key }, owner: null }], { askJev: pair, ledger: null, now: 0, authority: { kind: "plan", offerKey: "vs1" } });
    expect(r.ok).toHaveLength(0);
    expect(r.refused[0]?.why).toBe("notExact");
  });

  // On the B31 desks, where the scripted run reaches the verifier with the field's value: refused, and a pick of the
  // refused value runs the verifier again, which says the same. b31-07's address parts never reach it there (the oracle's
  // owner answers withhold them), and b31-04's School dropdown has more eligible values than one question lists.
  it.each(LOSSES.verifier.map((c) => [`${c.ask} ${c.field}`, c] as const))("%s: on its desk", async (_, c) => {
    const verify = (label: string, wording: 0 | 1): Answer | undefined => (label === c.field ? (wording === 0 ? c.a : c.b) : undefined);
    const r = await runB31(c.ask, { values: true, verify });
    expect(proposedOf(r, r.outcome)[c.field]).toBeUndefined();
    const q = await valueQuestionFor(r, c.field);
    if (q === null) return;
    const pick = q.options.find((o) => o.option.kind === "value" && o.option.value === c.key);
    expect(pick, "the refused value is among the options").toBeDefined();
    const resume = answerQuestion(q, [pick?.option.id ?? ""]);
    if (typeof resume === "string") throw new Error(resume);
    expect(proposedOf(r, await r.resume(resume))[c.field]).toBeUndefined();
  });

  it("offers the exact-but-low fields whose values fit one question", async () => {
    const offered: string[] = [];
    for (const c of LOSSES.verifier) {
      const verify = (label: string, wording: 0 | 1): Answer | undefined => (label === c.field ? (wording === 0 ? c.a : c.b) : undefined);
      if ((await valueQuestionFor(await runB31(c.ask, { values: true, verify }), c.field)) !== null) offered.push(`${c.ask} ${c.field}`);
    }
    expect(offered).toEqual(["b31-01 First name", "b31-01 Last name", "b31-09 Reference relationship"]);
  });
});

describe("explicit negatives", () => {
  const outputs = (r: Run, label: string): (string | null)[] => valueQuestions(r, label).flatMap((q) => q.options.map((o) => o.output));

  it("an absent mileage, a ZIP inside a place and a whole birthday are no options", async () => {
    expect(outputs(await runB31("b31-13"), "Current mileage")).not.toContain("59,870");
    expect(outputs(await runB31("b31-11"), "ZIP code")).not.toContain("Redwood City CA 94061");
    const birthday = await runB31("b31-02");
    for (const label of ["Day", "Year"]) expect(outputs(birthday, label)).not.toContain("04/12/1990");
  });

  it("a date read without a stated year says the year Caret assumed", async () => {
    const r = await runB31("b31-13");
    const [q] = valueQuestions(r, "Preferred date");
    const iso = q?.options.find((o) => o.output === "2026-10-17");
    expect(iso?.criterion).toMatch(/Derivation: the date, split from a date and time; the year 2026 is assumed: /u);
  });

  it("an unspecified 9:30 is neither written nor offered to the user", async () => {
    const r = await runB31("b31-20", { values: true });
    expect(proposedOf(r, r.outcome)["Preferred time"]).toBeUndefined();
    expect(await valueQuestionFor(r, "Preferred time")).toBeNull();
  });

  it("the office phone never goes in a cell field, even when both wordings choose it", async () => {
    const office = "(617) 555-0166";
    const r = await runB31("b31-16", { values: true, value: (label, _w, options) => (label === "Emergency contact phone" ? byOutput(options, office, 0.99) : undefined) });
    expect(Object.values(proposedOf(r, r.outcome))).not.toContain(office);
    const q = await valueQuestionFor(r, "Emergency contact phone");
    expect(q?.options.some((o) => o.option.kind === "value" && o.option.value === office) ?? false).toBe(false);
  });

  it("an unoffered VIN, service or topping has no option to choose", async () => {
    const car = await runB31("b31-13");
    expect(outputs(car, "VIN (optional)").filter((x) => x !== null)).toEqual([]);
    const pizza = await runB31("b31-15");
    expect(outputs(pizza, "Bacon").filter((x) => x !== null)).toEqual([]);
  });
});
