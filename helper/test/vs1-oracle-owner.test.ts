// The scripted oracle's owner rule, which stands in for a correct Jev: a value the corpus key expects in another person's
// field on any Ask of the form (an Emergency contact phone) is that person's, unless the key expects it in one of the
// user's fields on the current Ask; any other value the form's key holds is the user's. The owner questions are the ones
// fill sent on b31-08's desk, sealed by its own Disclosure. Fixture asks only.
import { describe, expect, it } from "vitest";
import { realfillOracle } from "../scripts/realfill-oracle.ts";
import type { CorpusAsk } from "../scripts/realfill-corpus.ts";
import { B31, corpus, runB31 } from "./vs1-kit.ts";

/** The oracle's owner answer on b31-08 for each candidate text fill asked about, with the corpus's asks as `asks`. */
async function ownerAnswers(asks: readonly CorpusAsk[]): Promise<Map<string, string>> {
  const r = await runB31("b31-08", { values: true, firstPass: "oracle" });
  const req = r.requests.find((x) => x.purpose === "fill.whose");
  const t = req === undefined ? undefined : r.traces.find((x) => x.owns(req));
  if (req === undefined || t === undefined) throw new Error("b31-08 sent no owner questions");
  const oracle = realfillOracle({ asks, corpus, current: () => "b31-08", traces: () => r.traces, corpusLabel: () => r.labelOf });
  const answers = (await oracle(req)).answers;
  return new Map(Object.keys(req.questions).flatMap((id) => {
    const text = id.endsWith("_owner") ? t.options.get(id.replace(/_owner$/u, ""))?.text : undefined;
    const choice = answers[id]?.choice;
    return text === undefined || choice === undefined ? [] : [[text, choice] as const];
  }));
}

describe("the oracle's owner answers", () => {
  it("calls Ines's cell hers on b31-08, where the key expects it only in another Ask's Emergency contact phone", async () => {
    expect((await ownerAnswers(B31)).get("(617) 555-0129")).toBe("other");
  });

  it("still calls the user's own values the user's, and a value no key holds unclear", async () => {
    const got = await ownerAnswers(B31);
    expect(got.get("(617) 555-0141")).toBe("user");
    expect(got.get("(617) 555-0166")).toBe("unclear");
  });

  // Sol review P3: the exception for the current Ask's own user fields, pinned with an overlap. An Ask elsewhere that
  // expects Theo's cell as an emergency contact does not make it someone else's on b31-08, which expects it in Mobile phone.
  it("keeps a value the current Ask expects in a user field the user's, though another Ask expects it as an emergency contact", async () => {
    const b16 = B31.find((x) => x.id === "b31-16");
    if (b16 === undefined) throw new Error("no b31-16");
    const overlap: CorpusAsk = { ...b16, id: "overlap-01", expected: { "Emergency contact phone": "(617) 555-0141" } };
    expect((await ownerAnswers([...B31, overlap])).get("(617) 555-0141")).toBe("user");
  });
});
