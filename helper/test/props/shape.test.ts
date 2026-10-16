// P2 - Shape properties (G3): how the fill contract reads a value's shape.
//
// The contract's own order of checks (helper/src/fill/contract.ts, shapeRefusal, lines 507-524):
// a value Caret never types (trace.ts secretIn) -> the input kind's own rule (inputKindRefusal) -> the
// label's kinds (kinds.ts misfit) -> marks around the value (kinds.ts wrappedValue) -> the part of a
// name or address (derive.ts partFits) -> maxlength. Each property below is tied to one of those stages;
// where several stages can refuse the same text, the property asserts the refusal, not its stage.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { makeFieldContract, shapeRefusal, type FieldContract } from "../../src/fill/contract.ts";
import { fieldKinds, numberFieldMisfit } from "../../src/fill/kinds.ts";
import { arbEmail, arbId, arbPair, arbPerson, arbPhone, arbPlainValue, arbSpaces, arbTrailing, arbUrl, runs } from "./gens.ts";

const fieldOf = (label: string): FieldContract =>
  makeFieldContract({ windowId: "win:0", node: { key: "k:1", parent: null, role: "AXTextField", label }, descriptor: label, name: label, labelWords: [label], control: "text", kinds: fieldKinds([label]), part: null, fingerprint: "fp" });

const prop = (label: string, value: string) => shapeRefusal({ field: fieldOf(label), text: value, display: value, provenance: { kind: "instruction", span: value }, owner: null });

describe("a whole value fully wrapped in a quote, angle or bracket pair is refused; the field takes the value alone (kinds.ts PAIRS, wrappedValue: contract.ts:521-522)", () => {
  const cases: readonly [string, fc.Arbitrary<string>, string | null][] = [
    ["Email", arbEmail, "marks around the value"],
    ["Website", arbUrl, null],
    ["Phone", arbPhone, null],
    ["Order number", arbId, "marks around the value"],
  ];
  for (const [label, values, wording] of cases) {
    it(label, () => {
      fc.assert(
        fc.property(values, arbPair, (value, { open, close }) => {
          const refusal = prop(label, `${open}${value}${close}`);
          // The refusal's stage varies with the kind: a quoted email or ID reaches wrappedValue ("marks"),
          // a quoted phone or angle-wrapped link is already plain text to the label's kinds (misfit).
          if (wording === null) expect(refusal).not.toBeNull();
          else expect(refusal ?? "").toContain(wording);
        }),
        runs(300),
      );
    });
  }
});

describe("a value ending in sentence punctuation the value lacks is refused (kinds.ts TRAILING)", () => {
  const cases: readonly [string, fc.Arbitrary<string>, fc.Arbitrary<string>][] = [
    ["Email", arbEmail, arbTrailing],
    ["Phone", arbPhone, arbTrailing],
    ["Order number", arbId, arbTrailing],
    // A link's own last character may be "!" or "?" inside the query, so after a link only
    // sentence punctuation is a mark (kinds.ts:68-71, the LINK_TRAILING carve-out).
    ["Website", arbUrl, fc.constantFrom(".", ",", ";", ":")],
  ];
  for (const [label, values, trails] of cases) {
    it(label, () => {
      fc.assert(
        fc.property(values, trails, (value, tail) => {
          expect(prop(label, value + tail)).not.toBeNull();
        }),
        runs(300),
      );
    });
  }
});

describe("whitespace around a value is not a wrong value (shapeRefusal trims; contract.ts:507)", () => {
  it("email, phone, link and order number survive leading and trailing whitespace", () => {
    fc.assert(
      fc.property(arbPerson, arbSpaces, arbSpaces, ({ email, phone }, lead, tail) => {
        expect(prop("Email", lead + email + tail)).toBeNull();
        expect(prop("Phone", lead + phone + tail)).toBeNull();
      }),
      runs(150),
    );
    fc.assert(
      fc.property(arbUrl, arbSpaces, arbSpaces, (url, lead, tail) => {
        expect(prop("Website", lead + url + tail)).toBeNull();
      }),
      runs(150),
    );
    fc.assert(
      fc.property(arbId, arbSpaces, arbSpaces, (id, lead, tail) => {
        expect(prop("Order number", lead + id + tail)).toBeNull();
      }),
      runs(150),
    );
  });
});

describe("an input's own kind takes one value shape, whatever the label says (contract.ts:459-475, inputKindRefusal)", () => {
  const inputKind = (kind: FieldContract["inputKind"], value: string) =>
    shapeRefusal({ field: { ...fieldOf("Field"), inputKind: kind }, text: value, display: value, provenance: { kind: "instruction", span: value }, owner: null });

  it("a number input takes one plain number, without commas, units or currency", () => {
    fc.assert(
      fc.property(fc.nat({ max: 999999999 }), fc.nat({ max: 999 }), fc.constantFrom("", "+", "-"), (whole, frac, sign) => {
        expect(inputKind("number", `${sign}${whole}.${frac}`)).toBeNull();
        expect(inputKind("number", `${sign}${whole}`)).toBeNull();
      }),
      runs(250),
    );
    fc.assert(
      fc.property(fc.array(fc.constantFrom(..."0123456789,$€letters".split("")), { minLength: 1, maxLength: 24 }), (chars) => {
        const v = chars.join("");
        if (!/^[-+]?\d+(?:\.\d+)?$/u.test(v)) expect(inputKind("number", v) ?? "").toContain("plain number");
      }),
      runs(250),
    );
  });

  it("a phone input takes digits and phone punctuation, with an extension mark, and no letters", () => {
    fc.assert(
      fc.property(arbPhone, (phone) => {
        expect(inputKind("tel", phone)).toBeNull();
        expect(inputKind("tel", "(720) 555-0146")).toBeNull();
        expect(inputKind("tel", "720 555 0146 ext. 9")).toBeNull();
      }),
      runs(100),
    );
    fc.assert(
      fc.property(fc.array(fc.constantFrom(..."abcdefghij0123456789 ".split("")), { minLength: 1, maxLength: 20 }), (chars) => {
        const v = chars.join("").replace(/\s+/gu, " ");
        if (!/[a-z]/iu.test(v)) return;
        expect(inputKind("tel", v) ?? "").toContain("phone input");
      }),
      runs(250),
    );
  });

  it("a URL input takes one address with no spaces, and an email input one address", () => {
    fc.assert(
      fc.property(arbUrl, (url) => {
        expect(inputKind("url", url)).toBeNull();
        expect(inputKind("email", "dana@lumen.example")).toBeNull();
      }),
      runs(150),
    );
    fc.assert(
      fc.property(arbUrl, arbUrl, (a, b) => {
        expect(inputKind("url", `${a} ${b}`) ?? "").toContain("spaces");
        expect(inputKind("email", `${a}, ${b}`) ?? "").toContain("one email address");
      }),
      runs(150),
    );
  });

  it("a date input takes only a value code resolved into its own format; typed text is refused", () => {
    fc.assert(
      fc.property(arbPlainValue, (v) => {
        expect(inputKind("date", v) ?? "").toContain("which takes only a value Caret resolved");
      }),
      runs(150),
    );
  });
});

describe("a label's kinds hold: the wrong kind of value is refused, the right one taken (kinds.ts misfit, numberFieldMisfit)", () => {
  it("an email is never an order number, and a phone with phone punctuation is never one either", () => {
    fc.assert(
      fc.property(arbEmail, (email) => {
        expect(numberFieldMisfit(email, ["Order number"]) ?? "").toContain("an email address");
        expect(prop("Order number", email)).not.toBeNull();
      }),
      runs(200),
    );
    fc.assert(
      fc.property(fc.constantFrom("(720) 555-0146", "+1 720 555 0146", "720 555 0146 ext. 9", "720 555 0146 x12"), (phone) => {
        expect(numberFieldMisfit(phone, ["Order number"]) ?? "").toContain("a phone number");
      }),
      runs(50),
    );
    // Digit groups alone can be an order number and are left to the verifier (kinds.ts:547-550).
    fc.assert(
      fc.property(arbId, fc.constantFrom("", "-"), (id, sep) => {
        expect(numberFieldMisfit(`5125550142${sep}`, ["Order number"])).toBeNull();
        expect(numberFieldMisfit(id, ["Order number"])).toBeNull();
      }),
      runs(200),
    );
  });

  it("an email is not a phone, and a name field takes prose (kinds.ts TAKES.name: no shape contrast for names)", () => {
    fc.assert(
      fc.property(arbEmail, (email) => {
        expect(prop("Phone", email) ?? "").toContain("email address");
      }),
      runs(200),
    );
    // A name field has no contrasting shape: a date is prose to it (misfit refuses wrong kinds only where a
    // shape contrast exists - a phone, a street, a company).
    fc.assert(
      fc.property(fc.constantFrom("1990-04-12", "04/12/1990", "Dana Whitfield", "Junior Analyst at Ridgeline Outdoor Co since 2024"), (prose) => {
        expect(prop("Full name", prose)).toBeNull();
      }),
      runs(20),
    );
  });

  it("a part of a date takes only that part, a currency-shown field takes the number alone, and a company field takes a name", () => {
    expect(prop("Day", "17")).toBeNull();
    expect(prop("Day", "Monday")).toBeNull();
    expect(prop("Day", "04/12/1990") ?? "").toContain("only that part of a date");
    expect(prop("Month", "3")).toBeNull();
    expect(prop("Year", "2026")).toBeNull();
    expect(prop("Monthly rent ($)", "$1,450") ?? "").toContain("currency sign");
    expect(prop("Monthly rent ($)", "1,450")).toBeNull();
    // The B24 corpus's firing case: a note's sentence with a parenthetical is more than a name (ORG_NAME refuses
    // brackets, marks and more than eight words); a plain name, even a person's, is a company name (digits too: "3M").
    expect(prop("Company name", "Junior Analyst at Ridgeline Outdoor Co (since 2024)") ?? "").toContain("company or organization name");
    expect(prop("Company name", "Ridgeline Outdoor Co")).toBeNull();
    expect(prop("Company name", "3M")).toBeNull();
    fc.assert(
      fc.property(arbPerson.map((p) => p.name), (name) => {
        expect(prop("Company name", name)).toBeNull();
        expect(prop("Company name", `${name} (since 2024)`) ?? "").toContain("company or organization name");
      }),
      runs(60),
    );
  });
});
