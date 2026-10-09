// Value settlement lists, even to Jev, only what it could admit: a value the owner rule withholds (fill.ts ownerHold: for
// a field both whose answers say wants the user's details, a window value not agreed the user's) is never an option, so
// no answer or pick can bring it back. B31's clinic-intake desk (b31-08): Ines's office line for Theo's Home phone, whose
// owner the oracle calls unclear. Fixture data only.
import { describe, expect, it } from "vitest";
import { runB31, valueQuestions } from "./vs1-kit.ts";

describe("settlement's options follow the owner rule", () => {
  it("never lists Ines's office line or cell for Theo's phones, and records why", async () => {
    const r = await runB31("b31-08", { values: true });
    // With the output ledger, Ines's mail is a conversation, and HA2's rule (c) needs its whole text as owner evidence,
    // which a conversation's limit never lets go (OUTPUT-LEDGER-SPEC, "HA2 rule (c) and the conversation limit", Sam's
    // decision pending). So every value from the mail is vetoed for want of owner evidence, and no phone field reaches
    // value settlement. Neither of Ines's lines is offered for Theo's phones, which is what this case pins.
    for (const label of ["Home phone", "Mobile phone"]) {
      const outputs = valueQuestions(r, label).flatMap((q) => q.options.map((o) => o.output));
      expect(outputs.length, `${label}: not asked, its mail's values held for owner evidence (HA2 rule c)`).toBe(0);
      expect(outputs, label).not.toContain("(617) 555-0166");
      expect(outputs, label).not.toContain("(617) 555-0129");
    }
    const t = r.traces.at(-1);
    const home = t?.fields.find((f) => r.labelOf.get(f.key) === "Home phone");
    const office = [...(t?.options ?? new Map()).entries()].find(([, o]) => o.text === "(617) 555-0166")?.[0];
    expect(office, "the office line is a candidate").toBeDefined();
    // The office line is held by a cut rule (fill.ts fieldCut or pickCut) before either owner rule is reached.
    expect(t?.vetoed?.get(home?.id ?? "")?.get(office ?? ""), "held as a cut").toBe("sourceCut");
  });
});
