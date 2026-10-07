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
export const LABEL_PHRASES: readonly (readonly [SensitiveKind, readonly (readonly string[])[]])[] = [
  ["oneTimeCode", [["otp"], ["one", "time"], ["verification", "code"], ["2fa"], ["mfa"], ["auth", "code"], ["authentication", "code"], ["login", "code"], ["sms", "code"], ["security", "code", "sent"]]],
  ["cardNumber", [["card", "number"], ["card", "no"], ["credit", "card"], ["debit", "card"], ["cvv"], ["cvc"], ["cvv2"], ["csc"], ["security", "code"], ["card", "verification"]]],
  ["password", [["password"], ["passwd"], ["passcode"], ["passphrase"], ["pin"], ["pin", "code"]]],
  ["accountNumber", [["account", "number"], ["account", "no"], ["acct"], ["routing", "number"], ["routing"], ["iban"], ["swift"], ["bic"], ["sort", "code"], ["bank", "account"], ["aba"]]],
  ["governmentId", [["ssn"], ["social", "security"], ["sin"], ["passport"], ["driver", "license"], ["drivers", "license"], ["driving", "licence"], ["license", "number"], ["licence", "number"], ["tax", "id"], ["tin"], ["ein"], ["itin"], ["national", "id"], ["national", "insurance"], ["government", "id"]]],
  ["apiKey", [["api", "key"], ["apikey"], ["api", "token"], ["access", "token"], ["access", "key"], ["secret"], ["private", "key"], ["token"], ["client", "secret"], ["bearer"]]],
];

/** Value shapes that are refused whatever the label says (privacy/exclude.ts withholds them when a window is read in). */
export const API_KEY_SHAPES: readonly RegExp[] = [
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

/**
 * Phrases of LABEL_PHRASES that ordinary sentences use for other things ("pin it", "one time", "a token of thanks",
 * "the routing"), so a sentence naming them does not name a secret. Written for B26's instructions, not measured.
 */
const COMMON_IN_SENTENCES = new Set(["pin", "sin", "tin", "swift", "routing", "token", "secret", "bic", "aba", "csc", "bearer", "acct", "one time"]);

/**
 * The kind a sentence names anywhere in it ("my SSN goes in there too"), or null, and whether it named a Social
 * Security number in those words. A label names its kind at its end (labelKind); an instruction can name it anywhere.
 */
export function mentionedKind(text: string): { kind: SensitiveKind; ssn: boolean } | null {
  const ws = words(text);
  for (const [kind, phrases] of LABEL_PHRASES) {
    for (const p of phrases) {
      if (COMMON_IN_SENTENCES.has(p.join(" "))) continue;
      for (let i = 0; i + p.length <= ws.length; i++) {
        if (p.every((w, j) => ws[i + j] === w)) return { kind, ssn: p[0] === "ssn" || p[0] === "social" };
      }
    }
  }
  return null;
}

/**
 * The kind of secret a text states: "My password is violet-orchard-seven", "my password for the demo is …", "Password:
 * …", "my PIN is 7319". A label phrase, owned ("my", "our", "the") and followed by "is", "was", ":" or "=", or bare and
 * followed by ":" or "=", then a value. A phrase ordinary sentences use for other things ("pin", "secret", "token") counts
 * only owned by "my" or "our" and with a digit in its value: "the secret is consistency" is no secret. S1 checks a saved
 * answer with it, on capture, on Caret's write and on the user's own edit of answers.md (parse.ts): prose that only
 * mentions a kind ("I built a password reset flow") is not one. Written for answers, not measured.
 */
export function statedSecret(text: string): SensitiveKind | null {
  const t = text.toLowerCase();
  for (const [kind, phrases] of LABEL_PHRASES) {
    for (const p of phrases) {
      const common = COMMON_IN_SENTENCES.has(p.join(" "));
      const phrase = p.map((w) => w.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[\\s-]+");
      // "Passport number", "password for the demo": a trailing kind word, and a short phrase saying what it is for.
      const tail = "s?(?:\\s+(?:number|no|num|nr|code|id))?(?:\\s+(?:for|of|to|on|at)(?:\\s+[\\w'-]+){1,3})?";
      const value = common ? "\\S*\\d" : "\\S";
      const owned = new RegExp(`\\b(?:my|our${common ? "" : "|the"})\\s+(?:[\\w'-]+\\s+)?${phrase}${tail}\\s*(?:is|was|:|=)\\s*${value}`, "u");
      const bare = new RegExp(`(?:^|[\\n.;!?(]\\s*|\\s)${phrase}${tail}\\s*[:=]\\s*${value}`, "u");
      if (owned.test(t) || (!common && bare.test(t))) return kind;
    }
  }
  return null;
}

/** The refusal's wording: "Caret doesn't keep card numbers in memory". */
export const refusal = (kind: SensitiveKind): string => `Caret doesn't keep ${SENSITIVE_SAYS[kind]} in memory`;

function endsWith(ws: readonly string[], p: readonly string[]): boolean {
  if (p.length > ws.length) return false;
  const at = ws.length - p.length;
  return p.every((w, j) => ws[at + j] === w);
}

export function luhn(digits: string): boolean {
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

/**
 * G2 round 4: whether a text holds a secret marker word: any phrase of LABEL_PHRASES ("password", "PIN", "token",
 * "security code", "API key", "SSN", "routing", …) as whole words, a plural "s" allowed, case-insensitive, anywhere,
 * whatever follows it (a separator, a quote, a bracket, or nothing at all). The one rule for what may reach Jev: the
 * redacted view (fill/redact.ts) drops a line or a node that holds one, and a request that still carries one is refused
 * (privacy.ts assertNoSecrets). It drops some innocent lines ("Pin it to the board", "routing the call"); the lead
 * accepted that cost (G2 round 4), counted in fill/redact.ts.
 */
export function markerWord(text: string | null | undefined): boolean {
  return markerAt(text, false);
}

/**
 * G2 round 4: whether a text ends in a marker phrase, maybe followed by "is", "was", "are" or a separator ("my private
 * key", "Password:", "PIN is"): its value may be on the next line (fill/redact.ts).
 */
export function markerEnds(text: string | null | undefined): boolean {
  return markerAt(text?.replace(/(?:\s*(?:\bis\b|\bwas\b|\bare\b|[:=\-–—>]))+\s*$/iu, ""), true);
}

function markerAt(text: string | null | undefined, atEnd: boolean): boolean {
  if (text === null || text === undefined || text === "") return false;
  const memo = atEnd ? ENDS_MEMO : WORD_MEMO;
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  const found = scanMarker(text, atEnd);
  if (memo.size >= MARKER_MEMO) memo.clear();
  memo.set(text, found);
  return found;
}

function scanMarker(text: string, atEnd: boolean): boolean {
  const ws = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "");
  for (let i = 0; i < ws.length; i++) {
    const first = ws[i] as string;
    const ps = BY_FIRST.get(first) ?? (first.endsWith("s") ? BY_FIRST.get(first.slice(0, -1)) : undefined);
    if (ps === undefined) continue;
    for (const p of ps) {
      if (i + p.length > ws.length) continue;
      let ok = true;
      for (let j = 0; j < p.length && ok; j++) {
        const w = ws[i + j] as string;
        const want = p[j] as string;
        ok = w === want || (j === p.length - 1 && w === `${want}s`);
      }
      if (ok && (!atEnd || i + p.length === ws.length)) return true;
    }
  }
  return false;
}
/** The marker phrases by their first word: a line is read once, each word looked up, not every phrase tried at it. */
const BY_FIRST = new Map<string, (readonly string[])[]>();
for (const [, phrases] of LABEL_PHRASES) for (const p of phrases) BY_FIRST.set(p[0] as string, [...(BY_FIRST.get(p[0] as string) ?? []), p]);
/** markerWord's and markerEnds's answers by text: the redacted view reads every line of a window it builds. Bounded. */
const MARKER_MEMO = 8000;
const WORD_MEMO = new Map<string, boolean>();
const ENDS_MEMO = new Map<string, boolean>();

/** G2 round 4: whether a text is one fill must never send: it holds a marker word or a value Caret never types. */
export function secretText(text: string | null | undefined): boolean {
  if (text === null || text === undefined || text === "") return false;
  const hit = SECRET_MEMO.get(text);
  if (hit !== undefined) return hit;
  const found = markerWord(text) || valueKind(text) !== null;
  if (SECRET_MEMO.size >= MARKER_MEMO) SECRET_MEMO.clear();
  SECRET_MEMO.set(text, found);
  return found;
}
const SECRET_MEMO = new Map<string, boolean>();

/**
 * G2: whether two consecutive lines carry a marker phrase split by their line break ("API" then "key: …"): the first line
 * ends with the phrase's first word(s), and the second starts with the rest, followed by nothing, a separator or a value.
 * A heading never joins a labelled record: "Card" then "Number of attendees: 4" names no card number, since the second
 * line's label is more than the phrase's rest (G2 round 7 review).
 */
export function markerAcross(first: string, second: string): boolean {
  const a = first.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "");
  const b = second.toLowerCase();
  if (a.length === 0) return false;
  for (const [, phrases] of LABEL_PHRASES) {
    for (const p of phrases) {
      for (let k = 1; k < p.length; k++) {
        const head = p.slice(0, k);
        if (a.length < k || !head.every((w, j) => a[a.length - k + j] === w)) continue;
        const rest = p.slice(k).map((w) => w.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[\\s_-]+");
        const label = /^\s*([^:]{1,32}):\s*\S/u.exec(second)?.[1]?.trim().toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "");
        if (label !== undefined && label.join(" ") !== p.slice(k).join(" ") && label.join(" ") !== `${p.slice(k).join(" ")}s`) continue;
        if (new RegExp(`^\\s*${rest}s?(?![\\p{L}\\p{N}])\\s*(?:$|[:=\\-–—>]|\\bis\\b|\\bwas\\b|[\\p{L}\\p{N}"'(\\[<\`])`, "u").test(b)) return true;
      }
    }
  }
  return false;
}

/** G2: a PEM fence line: "-----BEGIN … PRIVATE KEY-----" opens a block that runs to its "-----END … PRIVATE KEY-----". */
export const PEM_BEGIN = /^\s*-{3,}\s*BEGIN\b[^-]*PRIVATE KEY\s*-{3,}\s*$/iu;
export const PEM_END = /^\s*-{3,}\s*END\b[^-]*PRIVATE KEY\s*-{3,}\s*$/iu;
