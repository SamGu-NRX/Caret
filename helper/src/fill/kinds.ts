// What kind of value a form field asks for, read from its label words, and how many of a field's words
// a candidate's surroundings share. Fill uses the kinds to keep a privacy cut from leaving a decoy: when
// a window's budget cuts a date, no date field is asked with the dates that survived (fill.ts). The
// candidate generator uses the word overlap to spend a conversation's budget on the lines nearest each
// field's label first (candidates.ts). Names are grouped the same way under NAME_TERM, read from the
// line's shape since the reader types no names.
import type { ValueKind } from "../protocol.ts";

/**
 * Label words that say a field takes a value of a kind; the reader's typed values use the same kinds
 * (apps/screen-reader TypedValues.swift). Written for the calibration forms' labels and common form
 * words, not measured on real forms: a field whose words are not here has no kind, and only the check
 * on the chosen value (fill.ts) guards it.
 */
const KIND_WORDS: readonly (readonly [ValueKind, RegExp])[] = [
  ["email", /\be-?mail\b/],
  ["url", /\b(?:url|website|web ?site|web address|homepage|link)\b/],
  ["phone", /\b(?:phone|telephone|tel|mobile|cell|fax)\b/],
  ["date", /\b(?:date|day|birthday|dob|deadline|due)\b/],
  ["time", /\b(?:time|hour)\b/],
  ["amount", /\b(?:amount|total|subtotal|price|cost|fee|balance|payment)\b/],
  ["address", /\b(?:address|street)\b/],
  ["id", /\b(?:id|number|ref|reference|tracking|invoice|ticket|confirmation|code)\b/],
];

/** A clock time inside a value: "3:00 PM", "15:00", "3 PM". */
const CLOCK = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b(?:1[0-2]|0?[1-9])\s?[ap]\.?m\b\.?/iu;

/**
 * The kinds a typed value holds: its own, and a time when it is a date that carries a clock time. The
 * reader types "October 8, 2026 at 3:00 PM" as one date (TypedValues.swift), so a cut that keeps it out
 * keeps a time out too, and a Start time field must not be asked with only the times that survived (B13
 * review).
 */
export function valueKinds(v: { kind: ValueKind; text: string }): ValueKind[] {
  return v.kind === "date" && CLOCK.test(v.text) ? ["date", "time"] : [v.kind];
}

/**
 * The kinds of value a field with these label words takes. An email or web address is not a postal
 * address, and a phone number is not an ID.
 */
export function fieldKinds(words: readonly (string | null | undefined)[]): Set<ValueKind> {
  const s = words.filter((w): w is string => typeof w === "string").join(" ").toLowerCase();
  const out = new Set<ValueKind>();
  for (const [kind, re] of KIND_WORDS) if (re.test(s)) out.add(kind);
  if (out.has("email") || out.has("url")) out.delete("address");
  if (out.has("phone")) out.delete("id");
  return out;
}

const STOP = new Set(["the", "an", "of", "to", "for", "and", "or", "in", "on", "at", "your", "you", "my", "our", "is", "with", "by", "from"]);

/** Lowercase words of two or more characters holding a letter, minus a few function words. */
export function words(s: string | null | undefined): string[] {
  if (s === null || s === undefined) return [];
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && /\p{L}/u.test(w) && !STOP.has(w));
}

/** A kind as a term, so a field and a candidate of the same kind share a term whatever their words. */
export const kindTerm = (k: ValueKind): string => `#${k}`;
export const isKindTerm = (t: string): boolean => t.startsWith("#");

/**
 * The term of a field that takes a name (a person, a company, a title) and of a line that looks like
 * one. The reader types no names, so a conversation's name-like lines are grouped by this term and go
 * into a request whole or not at all, as a kind's typed values do (candidates.ts): B13 left a cut chat's
 * plain "Dana Whitfield" beside another window's plain name, with nothing to say a name had been cut.
 */
export const NAME_TERM = "#name";

/** Label words that say a field takes a name. Written for common form labels, not measured on real forms. */
const NAME_WORDS = /\b(?:name|company|organi[sz]ation|employer|business|firm|title|position|role)\b/;

/** Lowercase words that can sit inside a name: "Head of Operations", "Acme & Sons", "Ana de la Cruz". */
const NAME_JOINERS = new Set(["of", "and", "&", "the", "for", "de", "del", "della", "da", "di", "du", "la", "le", "van", "von", "der", "den", "y", "bin", "al"]);
/** A capitalized word of a name: letters, with apostrophes, hyphens and a closing period ("O'Neil", "Mary-Jane", "Ltd."). */
const NAME_WORD = /^\p{Lu}[\p{L}'’-]*\.?$/u;
/** Assumed bounds on a name's words and length; a longer line is a sentence or a heading. */
const NAME_MAX_WORDS = 6;
const NAME_MAX_CHARS = 60;

/**
 * Whether a span may be a name. A span labelled with a name word is one whatever its shape ("dana w."
 * labelled Name). Otherwise its shape decides: two to six words, each capitalized or a joining word,
 * starting with a capital, with no digit or other punctuation. "Lumen Labs" and "Senior Product
 * Designer" are names; "Design review", "Thanks" and "Room 4B" are not. A chat's "Hi Dana" passes too,
 * which errs toward withholding a name field rather than offering a partial set of names.
 */
export function isNameLike(text: string, label: string | null): boolean {
  if (label !== null && NAME_WORDS.test(label.toLowerCase())) return true;
  const t = text.trim();
  if (t.length > NAME_MAX_CHARS) return false;
  const ws = t.split(/\s+/);
  if (ws.length < 2 || ws.length > NAME_MAX_WORDS || !NAME_WORD.test(ws[0] ?? "")) return false;
  return ws.every((w) => NAME_WORD.test(w) || NAME_JOINERS.has(w));
}

/** Punctuation that can wrap a word of a name in a line: "(Dana", "Whitfield,", "<dana@…>". */
const WRAP = /^[("'“‘<[]+|[)"'”’>\],;:!?]+$/gu;

/**
 * The names a line holds: each run of two or more capitalized words, joining words allowed between them
 * ("Dana Whitfield <dana@example.com>" holds "Dana Whitfield"; "Design review with Priya Raman" holds
 * "Priya Raman"). The generator counts the names of a cut line that holds a typed value as kept out
 * unless offered elsewhere (candidates.ts): B14's review cut the first line, whose email was typed and
 * whose name was not, and the form's Name took another window's name. "Thanks Dana" and "I Will" count
 * too, which errs toward withholding.
 */
export function namesIn(line: string): string[] {
  const out: string[] = [];
  let run: string[] = [];
  let names = 0;
  const end = (): void => {
    while (run.length > 0 && NAME_JOINERS.has(run[run.length - 1] as string)) run.pop();
    if (names >= 2) out.push(run.join(" "));
    run = [];
    names = 0;
  };
  for (const raw of line.split(/\s+/)) {
    const w = raw.replace(WRAP, "");
    if (!/\p{N}/u.test(w) && NAME_WORD.test(w)) {
      run.push(w);
      names++;
    } else if (names > 0 && NAME_JOINERS.has(w) && !(run.length >= 2 && NAME_JOINERS.has(run[run.length - 1] as string) && NAME_JOINERS.has(run[run.length - 2] as string))) run.push(w);
    else end();
    // Punctuation after a word ends the run: "Whitfield, see" is not one name with what follows.
    if (names > 0 && raw !== w && /[,;:!?)>\]"”’]$/u.test(raw)) end();
  }
  end();
  return out;
}

/** A field's terms: its label words, the kinds they name, and NAME_TERM when they ask for a name. */
export function fieldTerms(labelWords: readonly (string | null | undefined)[]): Set<string> {
  const out = new Set(labelWords.flatMap(words));
  for (const k of fieldKinds(labelWords)) out.add(kindTerm(k));
  const s = labelWords.filter((w): w is string => typeof w === "string").join(" ").toLowerCase();
  if (NAME_WORDS.test(s)) out.add(NAME_TERM);
  return out;
}

/** How many of a field's terms a candidate's terms hold. */
export function overlap(field: ReadonlySet<string>, cand: ReadonlySet<string>): number {
  let n = 0;
  for (const t of field) if (cand.has(t)) n++;
  return n;
}

/**
 * What a value Caret would write reads as, judged on the whole value (B18). The planner writes text from
 * an instruction or memory as well as from windows, and that text has no reader kind, so the check reads
 * the value itself. A value that only mentions an email or a link ("Reach me at sam@…") is text.
 *   street   a street line: a house number, then words ("455 Congress Ave").
 *   address  a street line followed by more after a comma ("455 Congress Ave, Austin, TX 78701").
 */
export type TextKind = "email" | "url" | "phone" | "amount" | "address" | "street" | "text";

const WHOLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const WHOLE_URL = /^(?:https?:\/\/|www\.)\S+$/iu;
/** Digits with phone punctuation only, 7 to 15 digits; an ISO date ("2026-10-08") is not one. */
const PHONE_CHARS = /^\+?[\d\s().-]+$/u;
/** An extension after a phone number ("ext. 9", "x204"), set aside before the phone's characters are read. */
const PHONE_EXT = /\s*(?:ext\.?|extension|x)\s*\d{1,6}$/iu;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const WHOLE_AMOUNT = /^[$€£¥]\s?\d[\d,]*(?:\.\d{1,2})?$/u;
const STREET_LINE = /^\d+[A-Za-z]?\s+\p{L}[\p{L}\p{N}.'’-]*(?:\s+[\p{L}\p{N}.'’-]+)*$/u;
/** A number then a month or a clock mark reads as a date or a time, not a street: "8 October 2026", "3 PM". */
const NOT_STREET = /^\d+\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s|$)|^\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?$/iu;
/** A postal code at the end of a line, alone or after a two-letter state: "TX 78701", "78701-1234". */
const POSTCODE_TAIL = /(?:\b\p{Lu}{2}\s+)?\b\d{5}(?:-\d{4})?$/u;

export function textKind(value: string): TextKind {
  const v = value.trim().replace(/\s+/g, " ");
  if (WHOLE_EMAIL.test(v)) return "email";
  if (WHOLE_URL.test(v)) return "url";
  if (WHOLE_AMOUNT.test(v)) return "amount";
  const number = v.replace(PHONE_EXT, "");
  const digits = number.replace(/\D/g, "").length;
  if (PHONE_CHARS.test(number) && !ISO_DATE.test(number) && digits >= 7 && digits <= 15) return "phone";
  const [head, ...rest] = v.split(",");
  const h = (head ?? "").trim();
  if (!STREET_LINE.test(h) || NOT_STREET.test(h)) return "text";
  // A line with a postal code at its end is a whole address with its commas left out: "455 Congress Ave Austin TX 78701".
  return rest.length > 0 || POSTCODE_TAIL.test(h) ? "address" : "street";
}

/** Shapes a field's label can ask for that code can check a value against. */
type Fit = "email" | "phone" | "url" | "city" | "street" | "address" | "name" | "date" | "time" | "amount";
const CITY = /\b(?:city|town)\b/;
const STREET = /\bstreet\b|\baddress line\b/;
const PERSON_NAME = /\bname\b/;
/** Kinds of value that have their own shape: none of them is a city, a street line or a name. */
const SHAPED: ReadonlySet<TextKind> = new Set(["email", "url", "phone", "amount", "address", "street"]);

/** For each checkable shape, the value kinds it takes. A field that names none (Notes, Reference, Message) takes anything. */
const TAKES: Record<Fit, (k: TextKind, value: string) => boolean> = {
  email: (k) => k === "email",
  phone: (k) => k === "phone",
  url: (k) => k === "url",
  // A city has no digits: "Austin" fits, "Austin, TX 78701" and a whole address do not.
  city: (k, v) => k === "text" && !/\d/.test(v),
  street: (k) => k === "street" || k === "text",
  address: (k) => k === "address" || k === "street" || k === "text",
  name: (k) => !SHAPED.has(k),
  // "10-08-2026" reads as a phone number by its characters, so a date field takes those too.
  date: (k) => !SHAPED.has(k) || k === "phone",
  time: (k) => !SHAPED.has(k),
  amount: (k) => k === "amount" || k === "text",
};

const KIND_SAYS: Record<TextKind, string> = {
  email: "an email address",
  url: "a web link",
  phone: "a phone number",
  amount: "an amount",
  address: "a whole address",
  street: "a street line",
  text: "plain text",
};
const FIT_SAYS: Record<Fit, string> = {
  email: "an email address",
  phone: "a phone number",
  url: "a web link",
  city: "a city",
  street: "a street line",
  address: "an address",
  name: "a name",
  date: "a date",
  time: "a time",
  amount: "an amount",
};

/**
 * Why a value does not fit a field with these label words, or null when it fits or the field names no
 * shape code can check. A field that names several (an "Email or phone" field) takes a value that fits
 * any of them. "Street" outranks "address": a Street field takes a street line, not a whole address. Read
 * from label words the way fieldKinds reads them, so "Email address" is an email field and not a postal
 * one. The rules are written for common form labels, not measured on real forms; "Reference" and other
 * ID words are left unchecked because B16 and B17 put links and order numbers in the same Reference field.
 */
export function misfit(value: string, labelWords: readonly (string | null | undefined)[]): string | null {
  const s = labelWords.filter((w): w is string => typeof w === "string").join(" ").toLowerCase();
  const fits = new Set<Fit>();
  for (const k of fieldKinds(labelWords)) if (k !== "id") fits.add(k);
  if (CITY.test(s)) fits.add("city");
  if (STREET.test(s)) {
    fits.add("street");
    fits.delete("address");
  }
  if (PERSON_NAME.test(s)) fits.add("name");
  if (fits.size === 0) return null;
  const k = textKind(value);
  const v = value.trim();
  if ([...fits].some((f) => TAKES[f](k, v))) return null;
  const said = k === "text" && fits.has("city") && /\d/.test(v) ? "text with digits" : KIND_SAYS[k];
  return `'${v.length <= 60 ? v : `${v.slice(0, 59)}…`}' is ${said}, and the field takes ${[...fits].map((f) => FIT_SAYS[f]).join(" or ")}`;
}

/** A part of an address that names a unit or a building, not a city: "Suite B", "Apt 4", "Floor 2". */
const UNIT = /^(?:suite|ste|apt|apartment|unit|floor|fl|room|rm|building|bldg|#)\b/iu;
const PLAIN_WORDS = /^\p{L}[\p{L} .'’-]*$/u;
/** A state, a postal code or both: what follows the city in an address ("TX 78701", "TX", "78701"). */
const STATE_OR_POSTCODE = /^(?:\p{Lu}{2}(?:\s+\d{5}(?:-\d{4})?)?|\d{5}(?:-\d{4})?)$/u;

/**
 * The street line and the city of a comma-separated whole address, each verbatim as the address shows
 * them ("455 Congress Ave, Suite B, Austin, TX 78701" gives "455 Congress Ave" and "Austin"), so a Street
 * or City field can be offered the part that fits it. The city is the plain-words part right before a
 * state or postal code, or the second of exactly two parts ("1 Main St, Springfield"); it is null when
 * the address does not say which part is the city. Null for any text that is not a comma-separated whole address.
 */
export function addressParts(value: string): { street: string; city: string | null } | null {
  if (textKind(value) !== "address" || !value.includes(",")) return null;
  const parts = value.split(",").map((p) => p.trim().replace(/\s+/g, " "));
  const street = parts[0] as string;
  const isCity = (i: number): boolean => {
    const p = parts[i] as string;
    if (!PLAIN_WORDS.test(p) || UNIT.test(p)) return false;
    const next = parts[i + 1];
    return next === undefined ? parts.length === 2 : STATE_OR_POSTCODE.test(next);
  };
  const at = parts.findIndex((_, i) => i > 0 && isCity(i));
  return { street, city: at > 0 ? (parts[at] as string) : null };
}
