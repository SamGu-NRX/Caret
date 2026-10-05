// What Caret never writes into memory (lead decision 1, 2026-10-04): passwords, card or account numbers,
// government IDs, one-time codes and API keys. Memory is plaintext markdown that editors, Spotlight and
// backups can read, so these are refused by kind wherever a value would enter it: a learned fact, a typed
// "remember this", an edit, a "Not right" correction, and a document the host saves.
//
// Fill has no kind classifier to reuse: it skips fields the reader marks `secure` (fill.ts, candidates.ts),
// and B25's branch adds none. So the kinds are decided here, from the label's words and the value's shape.
// The word lists are written for common form labels, not measured on real forms; a false refusal costs one
// fact Caret does not keep, a miss costs a secret on disk, so they lean towards refusing.
import { words } from "../fill/kinds.ts";

export type SensitiveKind = "password" | "cardNumber" | "accountNumber" | "governmentId" | "oneTimeCode" | "apiKey";

/** How a refusal names each kind, after "Caret doesn't keep". */
export const SENSITIVE_SAYS: Record<SensitiveKind, string> = {
  password: "passwords",
  cardNumber: "card numbers",
  accountNumber: "account numbers",
  governmentId: "government ID numbers",
  oneTimeCode: "one-time codes",
  apiKey: "API keys or tokens",
};

/** Label phrases, as consecutive words of words(). Checked in this order; the first match names the kind. */
const LABEL_PHRASES: [SensitiveKind, string[][]][] = [
  ["oneTimeCode", [["otp"], ["one", "time"], ["verification", "code"], ["2fa"], ["mfa"], ["auth", "code"], ["authentication", "code"], ["login", "code"], ["sms", "code"], ["security", "code", "sent"]]],
  ["cardNumber", [["card", "number"], ["card", "no"], ["credit", "card"], ["debit", "card"], ["cvv"], ["cvc"], ["cvv2"], ["csc"], ["security", "code"], ["card", "verification"]]],
  ["password", [["password"], ["passwd"], ["passcode"], ["passphrase"], ["pin"], ["pin", "code"]]],
  ["accountNumber", [["account", "number"], ["account", "no"], ["acct"], ["routing", "number"], ["routing"], ["iban"], ["swift"], ["bic"], ["sort", "code"], ["bank", "account"], ["aba"]]],
  ["governmentId", [["ssn"], ["social", "security"], ["sin"], ["passport"], ["driver", "license"], ["drivers", "license"], ["driving", "licence"], ["license", "number"], ["licence", "number"], ["tax", "id"], ["tin"], ["ein"], ["itin"], ["national", "id"], ["national", "insurance"], ["government", "id"]]],
  ["apiKey", [["api", "key"], ["apikey"], ["api", "token"], ["access", "token"], ["access", "key"], ["secret"], ["private", "key"], ["token"], ["client", "secret"], ["bearer"]]],
];

/** Value shapes that are refused whatever the label says. */
const API_KEY_SHAPES: RegExp[] = [
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)[-_][A-Za-z0-9_-]{12,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bgsk_[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
];
/** US social security number written with its dashes. */
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
/** An IBAN: country, check digits, then 11 to 30 letters and digits, spaces allowed every four. */
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/;
/** Runs of digits with spaces or dashes between, as a card number is written. */
const DIGIT_RUN = /\d(?:[ -]?\d){12,18}/g;

/** Words a label may end with after the thing it names: "Passport no.", "Bank account number", "One-time code". */
const TRAILING = new Set(["no", "number", "num", "nr", "code", "id"]);

/**
 * The kind a label names, or null. The phrase must be what the label is about, its last words, or followed only by
 * one of TRAILING: "Bank password" and "Passport no." name a secret, "PIN code reminder" and "Password hint" do not.
 */
export function labelKind(label: string | null | undefined): SensitiveKind | null {
  const ws = words(label);
  if (ws.length === 0) return null;
  const heads = TRAILING.has(ws[ws.length - 1] as string) && ws.length > 1 ? [ws, ws.slice(0, -1)] : [ws];
  for (const [kind, phrases] of LABEL_PHRASES) {
    for (const p of phrases) if (heads.some((h) => endsWith(h, p))) return kind;
  }
  return null;
}

/**
 * The kind a value's shape gives away, or null: a Luhn-valid run of 13 to 19 digits, a dashed SSN, an IBAN, or a
 * known API key or private key format. A phone number, a date or an order number does not match.
 */
export function valueKind(value: string): SensitiveKind | null {
  for (const re of API_KEY_SHAPES) if (re.test(value)) return "apiKey";
  if (SSN.test(value)) return "governmentId";
  if (IBAN.test(value)) return "accountNumber";
  for (const m of value.matchAll(DIGIT_RUN)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return "cardNumber";
  }
  return null;
}

/** Whether a labelled value is one Caret never keeps. A label alone decides only when the value is not empty. */
export function sensitiveKind(label: string | null | undefined, value: string): SensitiveKind | null {
  if (value.trim() === "") return null;
  return labelKind(label) ?? valueKind(value);
}

/** The refusal's wording: "Caret doesn't keep card numbers in memory". */
export const refusal = (kind: SensitiveKind): string => `Caret doesn't keep ${SENSITIVE_SAYS[kind]} in memory`;

function endsWith(ws: readonly string[], p: readonly string[]): boolean {
  if (p.length > ws.length) return false;
  const at = ws.length - p.length;
  return p.every((w, j) => ws[at + j] === w);
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
