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
export const NAME_JOINERS: ReadonlySet<string> = new Set(["of", "and", "&", "the", "for", "de", "del", "della", "da", "di", "du", "la", "le", "van", "von", "der", "den", "y", "bin", "al"]);
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
/**
 * A whole date or time that starts with a number is not a street: "8 October 2026", "8 Oct", "3 PM".
 * Only the whole shape counts, so "12 October St" and "12 Janeway Dr" are still street lines.
 */
const NOT_STREET = /^\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?(?:\s+\d{4})?$|^\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?$/iu;
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
/** Fields that ask for one part of a date, by their whole label, and the values that part can be. */
const DATE_PART: ReadonlyMap<string, RegExp> = new Map([
  // A day of the month, or a weekday: a scheduling form's Day can take "Monday" (fix-check review).
  ["day", /^(?:0?[1-9]|[12]\d|3[01]|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)$/iu],
  ["month", /^(?:0?[1-9]|1[0-2]|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/iu],
  ["year", /^\d{4}$/u],
]);
const ORGANIZATION = /\b(?:company|employer|organi[sz]ation)\b/;
/** A label that spells out a date's format: "Moved in (MM/YYYY)", "Start date (DD.MM.YYYY)". */
const DATE_FORMAT = /\b(?:mm|dd|yyyy|yy)(?:\s*[/.-]\s*(?:mm|dd|yyyy|yy))+\b/iu;
/** A label that shows the currency beside the field, so the field takes the number alone: "Monthly rent ($)". */
export const CURRENCY_SHOWN = /\(\s*(?:\$|€|£|¥|usd|eur|gbp)\s*\)/iu;
/** A company's name: up to eight words with no brackets, @ or sentence punctuation ("Ridgeline Outdoor Co", "Acme, Inc.", "3M"). */
const ORG_NAME = /^(?=(?:\S+\s*){1,8}$)[^()[\]{}@<>;:!?$€£¥]+$/u;
/**
 * What may follow a comma in a company's name: a legal suffix ("Acme, Inc.", "Ridgeline Outdoor, LLC"). Anything
 * else after a comma is a list: B25's larger note budget offered "Brightline Dental Labs, lab technician, $5,200/mo
 * gross", and live Jev put it in Current employer (evidence/screen/b25/fill-dev-1; a rule tuned on the B24 corpus).
 */
export const ORG_SUFFIX = /^(?:inc|llc|ltd|limited|co|corp|corporation|company|gmbh|plc|llp|lp|pllc|pc|sa|s\.a|ag|bv|nv|pty(?: ltd)?|srl|oy|ab|as|kk)\.?$/iu;
const orgName = (v: string): boolean => ORG_NAME.test(v) && v.split(",").slice(1).every((p) => ORG_SUFFIX.test(p.trim()));
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
  // Plain text in an address field holds a number ("PO Box 12"): "in my note" from "her address is in my note"
  // went into Address (B24 Ask scoreboard, asks-dev-3).
  address: (k, v) => k === "address" || k === "street" || (k === "text" && /\d/.test(v)),
  name: (k) => !SHAPED.has(k),
  // A date or time field takes a value code reads as one (B24, Q1 bug 4: a plan wrote "Seattle on 11/12/2026 on
  // this Alaska Airlines page in Chrome" into two date fields). "10-08-2026" reads as a phone number by its
  // characters, so it is checked by shape, not kind.
  date: (_k, v) => dateShaped(v),
  time: (_k, v) => timeShaped(v),
  amount: (k) => k === "amount" || k === "text",
};

const MONTH_OR_DAY_NAME = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|today|tomorrow|yesterday)\.?,?$/iu;
/** Words that join a date's parts but say nothing by themselves ("the 3rd of May at 3 PM"). */
const DATE_JOINER = /^(?:next|last|this|of|the|at|on|st|nd|rd|th)\.?,?$/iu;
/**
 * Whether a whole value reads as a date or a part of one: digits and date separators ("11/12/2026", "05/2027",
 * "12", "1990"), or words that are only month and day names among numbers ("March 3, 1991", "Thu Oct 8").
 * Anything else, a place or a sentence, is not a date.
 */
export function dateShaped(value: string): boolean {
  const v = value.trim();
  if (v === "") return false;
  const numeric = /^(\d{1,4})(?:[/.\-](\d{1,4}))?(?:[/.\-](\d{1,4}))?$/u.exec(v);
  if (numeric !== null) return numericDate(numeric.slice(1).filter((x): x is string => x !== undefined).map(Number));
  const ws = v.split(/[\s,]+/u).filter((w) => w !== "");
  if (ws.length > 8) return false;
  // Each word read as what it is: a month or day name, a year, a day of the month, a clock time, or a joiner.
  // Joiners say nothing alone ("at" is not a date), and the parts must make a real day: "2026-02-31", "99 May
  // 2026" and "at 99:99 PM" are not dates (fix-check review).
  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;
  let evidence = false;
  for (const w of ws) {
    const m = MONTH_INDEX.findIndex((re) => re.test(w));
    if (m >= 0) {
      if (month !== null) return false;
      month = m + 1;
      evidence = true;
    } else if (MONTH_OR_DAY_NAME.test(w)) evidence = true;
    else if (/^\d{4}[.,]?$/u.test(w)) {
      if (year !== null) return false;
      year = Number.parseInt(w, 10);
      evidence = true;
    } else if (/^\d{1,2}(?:st|nd|rd|th)?[.,]?$/iu.test(w)) {
      const n = Number.parseInt(w, 10);
      if (day !== null || n < 1 || n > 31) return false;
      day = n;
      evidence = true;
    } else if (/^\d{1,2}:\d{2}(?:[ap]\.?m\.?)?$/iu.test(w) || /^[ap]\.?m\.?$/iu.test(w)) {
      if (/\d/.test(w) && !timeShaped(w.replace(/([ap])/iu, " $1"))) return false;
    } else if (!DATE_JOINER.test(w)) return false;
  }
  return evidence && (month === null || day === null || day <= daysIn(month, year));
}

const MONTH_INDEX: readonly RegExp[] = ["jan(?:uary)?", "feb(?:ruary)?", "mar(?:ch)?", "apr(?:il)?", "may", "june?", "july?", "aug(?:ust)?", "sep(?:t(?:ember)?)?", "oct(?:ober)?", "nov(?:ember)?", "dec(?:ember)?"].map((x) => new RegExp(`^${x}\\.?,?$`, "iu"));

/** Days in a month; February has 29 when the year is unknown or a leap year. */
function daysIn(month: number, year: number | null): number {
  if (month === 2) return year === null || (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Whether numbers joined by date separators can be a date or a part of one: a day (1-31) or a year (four
 * digits) alone; month and year ("05/2027"); or three parts with a four-digit year first or last and the other
 * two a month and a day in either order ("2026-10-08", "10/08/2026", "08.10.2026"). "9999-99-99" is not.
 */
function numericDate(ns: readonly number[]): boolean {
  const year = (n: number): boolean => n >= 1000 && n <= 9999;
  const md = (a: number, b: number): boolean => (a >= 1 && a <= 12 && b >= 1 && b <= 31) || (b >= 1 && b <= 12 && a >= 1 && a <= 31);
  if (ns.length === 1) return year(ns[0] as number) || ((ns[0] as number) >= 1 && (ns[0] as number) <= 31);
  if (ns.length === 2) return (year(ns[1] as number) && (ns[0] as number) >= 1 && (ns[0] as number) <= 12) || md(ns[0] as number, ns[1] as number);
  const [a, b, c] = ns as [number, number, number];
  // Month and day in either order, and the day within that month: "2026-02-31" is no date.
  const real = (m: number, d: number, y: number | null): boolean => m >= 1 && m <= 12 && d >= 1 && d <= daysIn(m, y);
  const either = (x: number, y2: number, yr: number | null): boolean => real(x, y2, yr) || real(y2, x, yr);
  return (year(a) && real(b, c, a)) || (year(c) && either(a, b, c)) || (c >= 0 && c <= 99 && either(a, b, null));
}

/** Whether a whole value reads as a clock time: "3:00 PM", "15:00", "3pm", "noon"; an hour with am or pm is 1 to 12 ("23pm" is not a time). */
export function timeShaped(value: string): boolean {
  return /^(?:(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*[ap]\.?\s*m\.?|(?:[01]?\d|2[0-3])(?::[0-5]\d)?|noon|midnight)$/iu.test(value.trim());
}

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
  const v = value.trim();
  // A label that spells out a numeric date format takes a value in that format only (B25: an Ask's scoped fill wrote
  // "moved in Aug 2022, rent $1,450/mo" into "Moved in (MM/YYYY)", evidence/screen/b25/asks-dev-1-gpt-oss-120b; tuned
  // on the B24 corpus). Converting "Aug 2022" to it is the value resolver's work, which plans do not do yet.
  const format = DATE_FORMAT.exec(s)?.[0];
  if (format !== undefined) {
    const shape = new RegExp(`^${format.replace(/\s+/g, "").replace(/yyyy/giu, "\\d{4}").replace(/yy/giu, "\\d{2}").replace(/mm|dd/giu, "\\d{1,2}").replace(/[/.]/g, (c) => `\\${c}`)}$`, "u");
    if (!shape.test(v)) return `'${v.length <= 60 ? v : `${v.slice(0, 59)}…`}' is not written as ${format.toUpperCase()}, the format the field asks for`;
  }
  // A field that shows its currency takes the number alone; the same scoreboard wrote "$1,450" into "Monthly rent ($)".
  if (CURRENCY_SHOWN.test(s) && /[$€£¥]/u.test(v)) return `'${v.length <= 60 ? v : `${v.slice(0, 59)}…`}' carries a currency sign, and the field shows its currency itself`;
  // A field for one part of a date takes only that part: the B24 corpus's "Day" (under Date of birth) took a
  // whole "04/12/1990" (evidence/screen/b24/after).
  // The field's own label decides (a placeholder "DD" beside "Day" must not hide it; fix-check review).
  const own = words(labelWords.find((w): w is string => typeof w === "string" && w.trim() !== "") ?? "").join(" ");
  const part = DATE_PART.get(own);
  if (part !== undefined && !part.test(v)) return `'${v.length <= 60 ? v : `${v.slice(0, 59)}…`}' is not one ${own}, and the field takes only that part of a date`;
  // A company or employer field takes a name, not a sentence about one: the B24 corpus's "Current company" took
  // "Junior Analyst at Ridgeline Outdoor Co (since 2024)" from a note's line (evidence/screen/b24/dev-4).
  // Only a field for the organization's name: "Company email" or "Employer phone" takes an email or a phone,
  // checked below (review). Digits are allowed: "3M", "Studio 54".
  if (ORGANIZATION.test(s) && [...fits].every((f) => f === "name") && !orgName(v)) return `'${v.length <= 60 ? v : `${v.slice(0, 59)}…`}' is more than a name, and the field takes a company or organization name`;
  // A bare clock time goes only in a field that takes a time: the B24 Ask scoreboard's planner wrote "8:15" into
  // Delivery instructions for "actually make the delivery 8:15 instead", whose time field is a control Caret
  // does not write (asks-dev-1).
  const number = numberFieldMisfit(v, labelWords);
  if (number !== null) return number;
  if (fits.size === 0) return timeShaped(v) && /:\d{2}|\d\s*[ap]\.?\s*m\b/iu.test(v) ? `'${v}' is a time, and the field does not take one` : null;
  const k = textKind(value);
  if ([...fits].some((f) => TAKES[f](k, v))) return null;
  const said = k === "text" && fits.has("city") && /\d/.test(v) ? "text with digits" : KIND_SAYS[k];
  return `'${v.length <= 60 ? v : `${v.slice(0, 59)}…`}' is ${said}, and the field takes ${[...fits].map((f) => FIT_SAYS[f]).join(" or ")}`;
}

/**
 * A label that asks for a number or code by name ("Order number", "Invoice no.", "Ticket #", "Confirmation code").
 * "Reference" alone is not one: B16 and B17 put links and order numbers in one Reference field.
 */
export const NUMBER_FIELD = /\b(?:number|no|num|nr|code)\b|#/u;
/**
 * A phone number by what only a phone carries: a leading +, an area code in brackets, or an extension. Digit groups
 * alone ("512-555-0142") can be an order number, and are left to Jev (G3 review).
 */
const PHONE_SHAPE = /^\+|\(\d{2,4}\)/u;
/** A whole date with its year: three numeric parts with a four-digit year first or last ("2026-10-08", "10/08/2026"). "1.2.3" and "10.06.30" are versions and codes. */
const NUMERIC_DATE = /^(?:\d{4}[/.-]\d{1,2}[/.-]\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4})$/u;
const MONTH_WORD = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/iu;

/**
 * Why a value does not fit a field that names a number or code and no other kind, or null: an email address, a web
 * link, a phone number or a date is never one (G2 for goals, G3 for every fill). misfit leaves ID fields unchecked
 * otherwise. Only a clear shape counts, since an order number can be any run of digits: a phone needs phone
 * punctuation ("5125550142" and "512-555-0142" stay order numbers), and a date needs its parts ("MAY" stays a promo code). Written for
 * M2's scene 1 ("Order number" took priya.raman@northwind.example), not measured on real forms.
 */
export function numberFieldMisfit(value: string, labelWords: readonly (string | null | undefined)[]): string | null {
  const s = labelWords.filter((w): w is string => typeof w === "string").join(" ").toLowerCase();
  // The ID word must be there too ("Notes #" and "(yes/no)" name no number), and no other kind: "Phone number" is misfit's.
  const kinds = fieldKinds(labelWords);
  if (!NUMBER_FIELD.test(s) || kinds.size === 0 || ![...kinds].every((k) => k === "id")) return null;
  const v = value.trim().replace(/\s+/gu, " ");
  const k = textKind(v);
  const said =
    k === "email" ? "an email address"
    : k === "url" ? "a web link"
    : k === "phone" && (PHONE_SHAPE.test(v) || PHONE_EXT.test(v)) ? "a phone number"
    : dateShaped(v) && (NUMERIC_DATE.test(v) || (MONTH_WORD.test(v) && /\d/u.test(v))) ? "a date"
    : null;
  return said === null ? null : `'${v.length <= 60 ? v : `${v.slice(0, 59)}…`}' is ${said}, and the field takes a number or code`;
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
