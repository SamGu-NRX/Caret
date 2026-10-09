// Which fields hold a secret (content/secret.ts): a password, a one-time code or card details. The walker sends such a
// field marked and without its value, and EntryTracker keeps nothing for it. Plain objects stand in for elements; the
// facts are what walker.ts secretOf reads off a real one. Every label and name is invented.
import { describe, expect, it } from "vitest";
import { notePassword, secretKind, type FieldFacts } from "../src/content/secret.ts";
import { EntryTracker, type Entry } from "../src/content/entry.ts";

const field = (over: Partial<FieldFacts>): FieldFacts => ({ role: "field", type: "text", autocomplete: "", nameAndId: " ", label: "", ...over });

describe("secretKind", () => {
  it("keeps a revealed password secret: a field once type=password stays one after a show-password toggle", () => {
    const el = {};
    expect(secretKind(el, field({ type: "password", label: "Password" }))).toBe("password");
    // The toggle: same element, now type=text, with no name, autocomplete or label that says password.
    expect(secretKind(el, field({ type: "text", nameAndId: "f1 ", label: "Enter it here" }))).toBe("password");
  });

  it("keeps a field the content script saw as a password secret though the walk first meets it as text", () => {
    const el = {};
    notePassword(el);
    expect(secretKind(el, field({ nameAndId: "f2 ", label: "Your secret" }))).toBe("password");
  });

  it("marks an unmarked 'Verification code' field as a one-time code", () => {
    expect(secretKind({}, field({ nameAndId: "field_7 q3", label: "Verification code" }))).toBe("oneTimeCode");
  });

  it.each([
    ["autocomplete current-password", field({ autocomplete: "current-password" }), "password"],
    ["autocomplete new-password", field({ autocomplete: "section-signup new-password" }), "password"],
    ["a text field labelled Password", field({ label: "Password" }), "password"],
    ["name userPassword", field({ nameAndId: "userPassword " }), "password"],
    ["autocomplete one-time-code", field({ autocomplete: "one-time-code" }), "oneTimeCode"],
    ["name otp", field({ nameAndId: "otp " }), "oneTimeCode"],
    ["id otpCode", field({ nameAndId: " otpCode" }), "oneTimeCode"],
    ["name one_time_code", field({ nameAndId: "one_time_code " }), "oneTimeCode"],
    ["label Passcode", field({ label: "Passcode" }), "oneTimeCode"],
    ["label One-time code", field({ label: "One-time code" }), "oneTimeCode"],
    ["label 2FA code", field({ label: "Enter your 2FA code" }), "oneTimeCode"],
    ["autocomplete cc-number", field({ autocomplete: "cc-number" }), "payment"],
    ["a select autocomplete cc-exp-month", field({ autocomplete: "cc-exp-month" }), "payment"],
    ["name cardNumber", field({ nameAndId: "cardNumber " }), "payment"],
    ["label Card number", field({ nameAndId: "field_17 ", label: "Card number" }), "payment"],
    ["label CVC", field({ label: "CVC" }), "payment"],
    ["label CVV", field({ label: "CVV" }), "payment"],
    ["label Expiry", field({ label: "Expiry (MM/YY)" }), "payment"],
    ["label Expiration date", field({ label: "Expiration date" }), "payment"],
    ["label Security code", field({ label: "Security code" }), "payment"],
  ] as const)("%s is secret", (_what, facts, want) => {
    expect(secretKind({}, facts)).toBe(want);
  });

  it.each([
    ["First name", field({ nameAndId: "first_name ", label: "First name" })],
    ["Email", field({ type: "email", autocomplete: "email", nameAndId: "email ", label: "Email" })],
    ["Zip code", field({ nameAndId: "zip ", label: "Zip code" })],
    ["Promo code", field({ nameAndId: "promo ", label: "Promo code" })],
    ["a 'Forgot password?' link", field({ role: "other", type: "", label: "Forgot password?" })],
    ["a 'Resend verification code' button", field({ role: "other", type: "", label: "Resend verification code" })],
  ] as const)("%s is not secret", (_what, facts) => {
    expect(secretKind({}, facts)).toBeNull();
  });
});

describe("EntryTracker and secret fields", () => {
  it("never keeps a secret field's value: nothing enters the tracker for it", () => {
    const seen = new WeakMap<object, { entry: Entry; value: string }>();
    const pw = {};
    const t = new EntryTracker((el) => el === pw, seen);
    t.onBefore(pw, "");
    t.onInput(pw, true, "insertText", "h", "h");
    t.onInput(pw, true, "insertText", "hu", "u");
    expect(seen.has(pw)).toBe(false);
    expect(t.entryOf(pw, "hu")).toBeUndefined();
    expect(seen.has(pw)).toBe(false);
  });

  it("drops what it kept for a field that turned secret, as a revealed password field's type changes back", () => {
    const seen = new WeakMap<object, { entry: Entry; value: string }>();
    const el = {};
    let facts = field({ label: "Nickname" });
    const t = new EntryTracker((x) => secretKind(x, facts) !== null, seen);
    t.onInput(el, true, "insertText", "s", "s");
    expect(seen.has(el)).toBe(true);
    facts = field({ type: "password", label: "Nickname" });
    t.onInput(el, true, "insertText", "se", "e");
    expect(seen.has(el)).toBe(false);
    // Shown as text again: still a password field, still nothing kept.
    facts = field({ type: "text", label: "Nickname" });
    t.onInput(el, true, "insertText", "sec", "c");
    expect(seen.has(el)).toBe(false);
  });
});
