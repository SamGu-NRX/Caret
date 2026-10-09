// Which page fields hold a secret: a password, a one-time code or a card's details. Such a field's value, text and
// typing history never leave the content script (walker.ts sends it marked, without its value; content/entry.ts keeps
// nothing for it). When in doubt a field counts as secret: a missed fill costs the user a few keystrokes, a secret
// sent to the app cannot be taken back. Pure, over the facts secret-dom.ts reads off the element, so it is tested
// without a DOM (test/secret.test.ts).
//
// A secret field's text must not reach Caret by another road either: a heading, label, description or error message
// that holds the field (or that an aria reference points at) is read without it (textWithoutSecrets).

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
  /** Its identity across a replacement: "id:<id>" and "name:<name>" for each it has (identityOf in password-watch.ts). */
  identity: readonly string[];
  /**
   * Every text the page gives as the field's label, each tested on its own whatever the accessible name chose: the
   * walker's name for it, aria-label, aria-labelledby, each <label>, placeholder and title. A generic aria-label must
   * not hide a visible "Password" label.
   */
  labels: readonly string[];
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
 * holds the password, so the field stays secret for as long as it lives. Filled by secretKind and by password-watch.ts
 * (type changes, inputs added, focus and the first keystroke), which see a password field before any toggle.
 */
const wasPassword = new WeakSet<object>();
/**
 * The ids and names of every input this document has shown as type=password. A page may replace the input with a copy
 * it turned into a text input while detached: the copy is a new object with no type history, but the same id or name.
 */
const passwordIdentities = new Set<string>();

/** Notes `el` as a password field: it, and any input with one of its ids or names, stays one whatever its type becomes. */
export function notePassword(el: object, identity: readonly string[] = []): void {
  wasPassword.add(el);
  for (const k of identity) passwordIdentities.add(k);
}

/** Whether `el` was ever noted as a password field. */
export function notedPassword(el: object): boolean {
  return wasPassword.has(el);
}

/** An input's type attribute changed from `from` to `to` (a MutationObserver record): a password once stays one. */
export function noteTypeChange(el: object, from: string | null, to: string | null, identity: readonly string[] = []): void {
  if (from?.trim().toLowerCase() === "password" || to?.trim().toLowerCase() === "password") notePassword(el, identity);
}

/** Why the field `el` holds a secret, or null. */
export function secretKind(el: object, f: FieldFacts): SecretKind | null {
  if (f.type === "password") {
    notePassword(el, f.identity);
    return "password";
  }
  if (wasPassword.has(el) || f.identity.some((k) => passwordIdentities.has(k))) return "password";
  // Autocomplete tokens count on any control: a <select autocomplete="cc-exp-month"> is a card field too (W1 review #5).
  const ac = f.autocomplete.toLowerCase();
  if (/(^|\s)cc-/.test(ac)) return "payment";
  if (/(^|\s)one-time-code(\s|$)/.test(ac)) return "oneTimeCode";
  if (/(^|\s)(current|new)-password(\s|$)/.test(ac)) return "password";
  // Names and labels count on fields only: a "Forgot password?" link or a "Resend code" button holds no secret.
  if (f.role !== "field") return null;
  const name = words(f.nameAndId);
  const said = (re: RegExp): boolean => f.labels.some((l) => re.test(l));
  if (PASSWORD.test(name) || said(PASSWORD)) return "password";
  if (PAYMENT_NAME.test(f.nameAndId) || PAYMENT_NAME.test(name) || said(PAYMENT_LABEL)) return "payment";
  if (ONE_TIME_CODE.test(name) || said(ONE_TIME_CODE)) return "oneTimeCode";
  return null;
}

/** A node tree walked upward, through shadow roots to their hosts: what secretWithin and readableFrom read. */
export interface UpTree<N> {
  parent(n: N): N | null;
  /** Whether the node is a secret field by its own facts. */
  secret(n: N): boolean;
  /** Whether the node holds what someone types or picks (a field by its own markup, or inside an editable region). */
  field(n: N): boolean;
}

/**
 * Whether `n` is a secret field or sits inside one: a widget that is secret makes every control in it secret, so the
 * six digit boxes of a role=textbox "Verification code" are excluded with it.
 */
export function secretWithin<N>(n: N, t: UpTree<N>): boolean {
  for (let p: N | null = n; p !== null; p = t.parent(p)) if (t.secret(p)) return true;
  return false;
}

/**
 * Whether text may be read from `n` (a label, a description, an error an aria reference names): `n` is no secret field,
 * and nothing above it is a field of any kind. A span inside a password editor is the password, whatever points at it.
 */
export function readableFrom<N>(n: N, t: UpTree<N>): boolean {
  if (t.secret(n)) return false;
  for (let p = t.parent(n); p !== null; p = t.parent(p)) if (t.secret(p) || t.field(p)) return false;
  return true;
}

/** Input types a "show password" button can turn a password into, and that hold any text. */
const REVEALED_TYPES = new Set(["text", "search", "tel", "url", "email"]);

/**
 * Whether a field's value and caret text are withheld because Caret could not watch its type attribute from the start:
 * a text input in a document the script reached late, or in a shadow root met only after it could have changed.
 */
export function withheldForHistory(f: { tag: string; type: string }, known: boolean): boolean {
  return !known && f.tag === "input" && REVEALED_TYPES.has(f.type);
}

/** Whether an input of this type could be a revealed password: it holds any text. */
export function revealable(type: string): boolean {
  return REVEALED_TYPES.has(type);
}

/** What textWithoutSecrets reads of a node tree. A DOM node has all of it (secret-dom.ts). */
export interface TextTree<N> {
  /** A text node's characters, or null for any other node. */
  text(n: N): string | null;
  childNodes(n: N): ArrayLike<N>;
  /** Whether the node is a secret field, whose own text and everything under it never count. */
  secret(n: N): boolean;
}

/** The text under `root`, as textContent gives it, with every secret field and its contents left out; "" for a secret root. */
export function textWithoutSecrets<N>(root: N, t: TextTree<N>): string {
  const own = t.text(root);
  if (own !== null) return own;
  if (t.secret(root)) return "";
  let out = "";
  for (const c of Array.from(t.childNodes(root))) out += textWithoutSecrets(c, t);
  return out;
}
