// What Caret never types, from any source (B25 lead decision 2): a Social Security number, a full card number,
// a password or a one-time code. Fill leaves such a field out of a proposal the way it leaves out a secure
// (password) field, the candidate generator never offers such a value, and the planner refuses both, so a
// fill, an Ask and a checked plan agree. The user types them; Caret's offer names the field as theirs.
//
// Fields are read by their label words, values by their shape or by the label beside them. The word lists are
// written for common form labels, not measured on real forms; they err toward leaving a field to the user.
import { words } from "./kinds.ts";

export type NeverTyped = "ssn" | "card" | "password" | "code";

/** How a hand-off names each kind to the user. */
export const NEVER_TYPED_SAYS: Record<NeverTyped, string> = {
  ssn: "a Social Security number",
  card: "a card number",
  password: "a password",
  code: "a one-time code",
};

/**
 * Label phrases, matched on the lowercase words of a label joined by single spaces. A card's security code
 * (CVV) counts as the card: it is the other half of what a card payment needs. "Confirmation code" and
 * "promo code" are not here: a booking or discount code is no secret.
 */
const LABELS: readonly (readonly [NeverTyped, RegExp])[] = [
  ["ssn", /\b(?:ssn|social security(?: number| no)?|social insurance number|national insurance number|itin)\b/],
  ["card", /\b(?:card number|card no|credit card|debit card|cc number|cvv|cvc|cvv2|csc|card security code|card verification)\b/],
  ["password", /\b(?:password|passcode|passphrase|pin)\b/],
  ["code", /\b(?:one time (?:code|password|passcode|pin)|otp|verification code|authentication code|authenticator code|2fa|two factor|security code|login code|sms code)\b/],
];

/** The kind a field with these label words asks for, when it is one Caret never types; null otherwise. */
export function neverTypedField(labelWords: readonly (string | null | undefined)[]): NeverTyped | null {
  const s = labelWords
    .filter((w): w is string => typeof w === "string")
    .flatMap((w) => words(w.replace(/[-‐‑]/g, " ")))
    .join(" ");
  if (s === "") return null;
  // "Security code" beside a card's words is the card's; alone it is a one-time code. Either is never typed.
  for (const [kind, re] of LABELS) if (re.test(s)) return kind;
  return null;
}

/** "123-45-6789" or "123 45 6789" inside a text: the shape a Social Security number is written in. Nine bare digits are an ID of any kind, so they count only beside an SSN label. */
const SSN_SHAPE = /(?<![\d-])\d{3}[- ]\d{2}[- ]\d{4}(?![\d-])/u;
/** Runs of 13 to 19 digits, single spaces or hyphens allowed between them: the lengths card numbers have. */
const CARD_RUN = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/gu;

/** Whether a run of digits passes the Luhn check every payment card number passes. */
export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/**
 * The kind of value a text is or holds, when it is one Caret never types: by shape anywhere in it (an SSN's
 * 3-2-4 digits, a card number that passes Luhn; "card 4242 4242 4242 4242" holds one), or by the label it sits
 * beside on screen ("Password: …", "Your code: …"). Null otherwise. A shape alone is not read for a password or
 * a one-time code: six digits are as often a ZIP code or an order number.
 */
export function neverTypedValue(text: string, label: string | null = null): NeverTyped | null {
  if (SSN_SHAPE.test(text)) return "ssn";
  for (const m of text.matchAll(CARD_RUN)) {
    const digits = m[0].replace(/\D/g, "");
    // A 13- to 15-digit run of a longer one is not tried: a card is the whole run, as a person writes it.
    if (luhn(digits)) return "card";
  }
  return label === null ? null : neverTypedField([label]);
}
