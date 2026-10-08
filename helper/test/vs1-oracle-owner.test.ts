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
