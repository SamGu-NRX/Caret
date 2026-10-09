// Which page fields hold a secret: a password, a one-time code or a card's details. Such a field's value, text and
// typing history never leave the content script (walker.ts sends it marked, without its value; content/entry.ts keeps
// nothing for it). When in doubt a field counts as secret: a missed fill costs the user a few keystrokes, a secret
// sent to the app cannot be taken back. Pure, over the facts walker.ts reads off the element, so it is tested without
// a DOM (test/secret.test.ts).

export type SecretKind = "password" | "payment" | "oneTimeCode";

/** What the walker reads off one element to judge it. */
export interface FieldFacts {
  /** "field": an input that holds typed text, a textarea or a select; "other": any other control (a button, a link). */
  role: "field" | "other";
  /** The input's type attribute, lowercased; "" for anything but an input. */
  type: string;
  autocomplete: string;
  /** The element's name and id attributes. */
  nameAndId: string;
  /** What the walker calls the field: its label, aria-label or question (question.ts controlName). */
  label: string;
}

/** Card fields by name or id, which a page keeps stable across languages. */
const PAYMENT_NAME = /\b(card.?number|cc.?(num|number|csc|cvc|cvv|exp\w*)|cvc|cvv|cvn|csc|security.?code)\b/i;
/** Card fields by what the person reads. Expiry counts though some forms ask a passport's: treated as secret anyway. */
const PAYMENT_LABEL = /\b(card ?(number|no)|credit card|debit card|cvc|cvv|cvn|csc|security code|expiry|expiration|exp\.? date|valid (thru|through)|mm ?\/ ?yy)\b/i;
/** One-time codes by name, id or label. */
const ONE_TIME_CODE = /\b(otp|one[- ]?time|passcode|pass code|verification code|verify code|confirmation code|2fa|two[- ]factor|mfa|totp|auth(entication)? code)\b/i;
/** Passwords by name, id or label, for a field shown as text. */
const PASSWORD = /\b(password|passwd|pwd|passphrase)\b/i;

/** "otpCode" and "one_time_code" read as "otp Code" and "one time code", so the patterns' word boundaries hold. */
function words(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.[\]-]+/g, " ");
}

/**
 * Inputs this document has shown as type=password. A "show password" toggle makes the field type=text, and it still
 * holds the password, so the field stays secret for as long as it lives. Filled by secretKind and by the content
 * script's focusin and beforeinput listeners (notePassword), which see a password field before any toggle.
 */
const wasPassword = new WeakSet<object>();

/** Notes `el` as a password field: it stays one whatever its type becomes. */
export function notePassword(el: object): void {
  wasPassword.add(el);
}

/** Why the field `el` holds a secret, or null. */
export function secretKind(el: object, f: FieldFacts): SecretKind | null {
  if (f.type === "password") {
    wasPassword.add(el);
    return "password";
  }
  if (wasPassword.has(el)) return "password";
  // Autocomplete tokens count on any control: a <select autocomplete="cc-exp-month"> is a card field too (W1 review #5).
  const ac = f.autocomplete.toLowerCase();
  if (/(^|\s)cc-/.test(ac)) return "payment";
  if (/(^|\s)one-time-code(\s|$)/.test(ac)) return "oneTimeCode";
  if (/(^|\s)(current|new)-password(\s|$)/.test(ac)) return "password";
  // Names and labels count on fields only: a "Forgot password?" link or a "Resend code" button holds no secret.
  if (f.role !== "field") return null;
  const name = words(f.nameAndId);
  if (PASSWORD.test(name) || PASSWORD.test(f.label)) return "password";
  if (PAYMENT_NAME.test(f.nameAndId) || PAYMENT_NAME.test(name) || PAYMENT_LABEL.test(f.label)) return "payment";
  if (ONE_TIME_CODE.test(name) || ONE_TIME_CODE.test(f.label)) return "oneTimeCode";
  return null;
}
