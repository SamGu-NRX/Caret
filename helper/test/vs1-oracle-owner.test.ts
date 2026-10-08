// The scripted oracle's owner rule, which stands in for a correct Jev: a value the corpus key expects in another person's
// field on any Ask of the form (an Emergency contact phone) is that person's, unless the key expects it in one of the
// user's fields on the current Ask; any other value the form's key holds is the user's. Fixture asks only.
import { describe, expect, it } from "vitest";
import type { JevRequest } from "../src/fill/jev.ts";
import { OWNER_CRITERIA } from "../src/fill/fill.ts";
import { realfillOracle } from "../scripts/realfill-oracle.ts";
import { B31, corpus } from "./vs1-kit.ts";

/** The oracle's answer to one owner question about `text`, asked during Ask `ask`, with no fill trace. */
async function owner(ask: string, text: string): Promise<string | undefined> {
  const oracle = realfillOracle({ asks: B31, corpus, current: () => ask, traces: () => [], corpusLabel: () => new Map() });
  const req = { purpose: "fill.whose", state: {}, questions: { c1_owner: { type: "choice", instructions: `A value on the user's screen: "${text}" Whose details is it?`, criteria: { ...OWNER_CRITERIA } } }, snippets: [], charged: {} } as unknown as JevRequest;
  return (await oracle(req)).answers.c1_owner?.choice;
}

describe("the oracle's owner answers", () => {
  it("calls Ines's cell hers on b31-08, where the key expects it only in another Ask's Emergency contact phone", async () => {
    expect(await owner("b31-08", "(617) 555-0129")).toBe("other");
  });

  it("still calls the user's own values the user's", async () => {
    expect(await owner("b31-08", "(617) 555-0141")).toBe("user");
    expect(await owner("b31-08", "27 Linden Terrace")).toBe("user");
  });

  it("calls a value no key holds unclear", async () => {
    expect(await owner("b31-08", "(617) 555-0166")).toBe("unclear");
  });
});

describe("the oracle's value answers", () => {
  // Value settlement keeps one option per output and basis, so two options can state the key's value. A consistent judge
  // takes the same one in both wordings, whose ids and orders differ, with no fill trace (the scoreboard seals requests).
  it("takes the same option in both wordings when two state the key's value", async () => {
    const oracle = realfillOracle({ asks: B31, corpus, current: () => "b31-08", traces: () => [], corpusLabel: () => new Map() });
    const mail = 'Proposed value: "Text message". Source: Google Chrome window \'Harbor Family Clinic new-patient form\'.';
    const request = 'Proposed value: "Text message". Source: the user\'s request.';
    const ask = async (criteria: Record<string, string>): Promise<string | undefined> => {
      const req = { purpose: "fill.values", state: {}, questions: { f1: { type: "choice", instructions: "Field: Radio buttons. Label: 'How should we contact you?'. Which listed proposed value can fill this field?", criteria: { ...criteria, none: "No listed proposed value." } } }, snippets: [], charged: {} } as unknown as JevRequest;
      return (await oracle(req)).answers.f1?.choice;
    };
    expect([await ask({ d1: request, d2: mail }), await ask({ e1: mail, e2: request })]).toEqual(["d2", "e1"]);
  });
});
