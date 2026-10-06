// B26 lead decision 3: every sentence an Ask says when it refuses or asks is in says.ts, names its reason in plain
// words, and never shows an id. These check the table itself; ask.test.ts checks which sentence each refusal says.
import { describe, expect, it } from "vitest";
import { PlanErrorCode } from "../src/protocol.ts";
import { SAYS, saysAmbiguous, saysFor, saysJevCap, saysLeftToYou, saysNeverTyped, saysNoValue, saysPress, saysPressAsked, saysUnsure } from "../src/planner/says.ts";
import { mentionedKind } from "../src/memory/sensitive.ts";

/** A sentence as the table must write it: one or two plain sentences, no developer punctuation, no ids. */
function plain(s: string): string[] {
  const out: string[] = [];
  if (!/^["\p{Lu}]/u.test(s)) out.push("does not start with a capital");
  if (!/[.?]$/u.test(s)) out.push("does not end a sentence");
  if (/[;—–]/u.test(s)) out.push("has a semicolon or a dash");
  if (/\d{3,}-\d{6,}|\b[fwps]\d+\b|undefined|null|\[object/u.test(s)) out.push("shows an id or a placeholder");
  if (/\bJev\b|\bintent\b|\bwriter\b|\bcandidate/u.test(s)) out.push("names Caret's insides");
  return out;
}

const generated = [
  ...Object.values(SAYS),
  ...PlanErrorCode.options.map(saysFor),
  saysJevCap(0.5, 0.5012),
  saysJevCap(0.002, 0.0021),
  saysNeverTyped("governmentId", true),
  saysNeverTyped("cardNumber", false),
  saysNeverTyped("oneTimeCode", false),
  saysPress("money", "Pay now"),
  saysPress("destructive", "Delete draft"),
  saysPress("outbound", "Send"),
  saysPress("outbound", "Submit application"),
  saysPress("unverifiable", "Next page"),
  saysNoValue(["Phone number", "Company name"]),
  saysNoValue(["Add a gift note (optional)"]),
  saysUnsure(["Your name", "Email address", "Phone", "City", "State", "ZIP code"]),
  saysAmbiguous("7:15", "time", "Approximate arrival time"),
  saysAmbiguous("next Friday", "date", "Date"),
  saysAmbiguous("medium", "select", "Size *"),
  saysAmbiguous("the usual", "text", "Notes"),
  saysLeftToYou([{ name: "Social Security number", kind: "governmentId" }]) as string,
  saysLeftToYou([{ name: "Card number", kind: "cardNumber" }, { name: "CVV", kind: "cardNumber" }]) as string,
];

describe("the sentences an Ask says", () => {
  it.each(generated.map((s) => [s]))("%s is plain", (s) => {
    expect(plain(s)).toEqual([]);
  });

  it("says each of the brief's examples word for word", () => {
    expect(saysNeverTyped("governmentId", true)).toBe("Caret doesn't type Social Security numbers. Type it yourself.");
    expect(SAYS.submit).toBe("Submitting is yours to do.");
    expect(SAYS.whichPerson).toBe("Which person do you mean? Say their name.");
  });

  it("has a sentence for every plan error code", () => {
    for (const c of PlanErrorCode.options) expect(saysFor(c).length).toBeGreaterThan(10);
  });

  it("names a field as its label reads, without its required or optional marks", () => {
    expect(saysNoValue(["Add a gift note (optional)", "Full name ✱"])).toBe("Caret found nothing to put in Add a gift note or Full name.");
    expect(saysUnsure(["A", "B", "C", "D", "E", "F"])).toBe("Caret wasn't sure what goes in A, B, C, D or 2 more. Say what goes there and ask again.");
  });

  it.each([
    ["ok that all looks right, hit submit", SAYS.submit],
    ["send it to Dana", SAYS.send],
    ["scrap this draft", SAYS.delete],
    ["go ahead and pay with the card I usually use", SAYS.payment],
  ])("says what pressing means for %s", (instruction, says) => {
    expect(saysPressAsked(instruction)).toBe(says);
  });
});

describe("mentionedKind", () => {
  it.each([
    ["my SSN goes in there too", { kind: "governmentId", ssn: true }],
    ["put my social security number in", { kind: "governmentId", ssn: true }],
    ["add my passport number", { kind: "governmentId", ssn: false }],
    ["type the verification code from my phone", { kind: "oneTimeCode", ssn: false }],
    ["use my credit card", { kind: "cardNumber", ssn: false }],
    ["my bank account number for the deposit", { kind: "accountNumber", ssn: false }],
    ["my password is in my notes", { kind: "password", ssn: false }],
  ])("finds the kind %s names", (s, want) => {
    expect(mentionedKind(s)).toEqual(want);
  });

  it.each(["pin the landlord's number to the top", "fill it in one time only", "add a token of thanks in the note", "the secret santa list", "go ahead and pay with the card I usually use", "fill out the Northgate application"])("finds no secret in %s", (s) => {
    expect(mentionedKind(s)).toBeNull();
  });
});
