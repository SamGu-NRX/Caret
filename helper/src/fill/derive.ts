// Values code derives from a span, deterministically, for fields that ask for part of it: the first, middle
// or last name of a full name, a full name from separate first and last names, and the street line, unit,
// city, state and ZIP code of an address (Q1 bugs 11 and 4; B24). Jev still chooses which value a field
// gets; code only offers the parts, and every part but a joined full name is a substring of the span it
// came from, so it traces to it. A name code cannot split without guessing (a single name, or four names
// with no particle to mark the surname) is not split: the field is left for the user, never guessed.
import { words } from "./kinds.ts";

export type NamePart = "first" | "middle" | "last" | "full";
export type AddressPart = "street" | "unit" | "city" | "state" | "zip";
export type FieldPart = NamePart | AddressPart;
/** A date's month or year, for a field that asks only for that (C1): "Graduation date month", "Start date year"; C2 adds its day ("Date of birth day"). */
export type DatePart = "month" | "day" | "year";
/** A field's part as fill asks for it: fieldPart's parts, (B27) a place's country, which only fill derives, or (C1) a date's month or year. */
export type FillPart = FieldPart | "country" | DatePart;

const FIRST = /\b(?:first|given|forename)\b/;
const MIDDLE = /\bmiddle\b/;
const LAST = /\b(?:last|surname|family)\b/;
/** A name field that names a company, a product or a thing, not a person. Written for common form labels, not measured. */
const NOT_PERSON = /\b(?:company|business|organi[sz]ation|employer|school|university|college|event|pet|user ?name|username|account|project|product|team|venue|brand|file|display|domain|site|website|street|city|hotel|bank)\b/;

/**
 * The part of a name or an address a field asks for, from its label words, or null when it asks for a
 * whole value or something else. `formHasCity`: a bare "Address" field beside a City field asks for the
 * street line, as checkout forms lay it out; without one it may want the whole address.
 */
export function fieldPart(label: string | null, formHasCity = false): FieldPart | null {
  if (label === null) return null;
  const s = label.toLowerCase();
  if (/\be-?mail\b|\bweb\b|\burl\b|\bip address\b/.test(s)) return null;
  if (/\bname\b/.test(s) || FIRST.test(s) || LAST.test(s) || MIDDLE.test(s)) {
    if (NOT_PERSON.test(s)) return null;
    if (FIRST.test(s)) return "first";
    if (MIDDLE.test(s)) return "middle";
    if (LAST.test(s)) return "last";
    return /\bname\b/.test(s) ? "full" : null;
  }
  if (/\b(?:apt|apartment|unit|suite)\b/.test(s)) return "unit";
  // C2 review: the second address line holds the unit; "address line" alone below would read it as the street.
  if (ADDRESS_LINE_2.test(s)) return "unit";
  if (/\b(?:zip|postal|postcode)\b/.test(s)) return "zip";
  if (/\b(?:city|town)\b/.test(s)) return "city";
  if (/\b(?:state|province)\b/.test(s)) return "state";
  if (/\bstreet\b|\baddress line\b|\baddress 1\b/.test(s)) return "street";
  if (formHasCity && words(s).length === 1 && /\baddress\b/.test(s)) return "street";
  return null;
}

/** C2 review: a label naming an address's second line ("Address line 2", "Address 2", "Line 2"). */
export const ADDRESS_LINE_2 = /\b(?:address\s*)?line\s*#?\s*2\b|\baddress\s*#?\s*2\b/iu;

/** Words that open a surname: "Ana de la Cruz", "Ludwig van der Rohe". Compared without case. */
const PARTICLES = new Set(["van", "von", "der", "den", "de", "del", "della", "da", "di", "du", "la", "le", "bin", "ibn", "al", "st.", "ter", "ten", "dos", "das"]);
const HONORIFIC = /^(?:dr|mr|mrs|ms|mx|miss|prof|sir|dame|rev)\.?$/i;
const SUFFIX = /^(?:jr|sr|ii|iii|iv|v|phd|md|esq|dds|cpa)\.?$/i;

export type NameSplit = { kind: "split"; first: string; middle: string | null; last: string } | { kind: "ask"; reason: string };

/**
 * A person's full name split into first, middle and last, each a substring of `full` as written. An
 * honorific ("Dr.") and a suffix ("Jr.") are set aside. "Last, First" is read that way round. A surname
 * particle starts the last name ("de la Cruz"). One name, or four or more with no particle, is an ask:
 * which words are given names and which the surname is a guess there.
 */
export function splitName(full: string): NameSplit {
  const text = full.trim().replace(/\s+/g, " ");
  if (text === "" || /[\d@<>]/.test(text)) return { kind: "ask", reason: `'${text}' is not a person's name` };
  const comma = text.indexOf(",");
  if (comma > 0) {
    const last = text.slice(0, comma).trim();
    const given = text.slice(comma + 1).trim().split(" ").filter((w) => w !== "" && !SUFFIX.test(w) && !HONORIFIC.test(w));
    // Every word capitalized or a particle: "Okafor, my manager" is a name and a description, not "Last, First".
    const named = (w: string): boolean => /^\p{Lu}[\p{L}'’.-]*$/u.test(w) || PARTICLES.has(w.toLowerCase());
    if (last === "" || given.length === 0 || given.length > 3 || SUFFIX.test(last) || !last.split(" ").every(named) || !given.every(named)) return { kind: "ask", reason: `'${text}' does not say which name is the surname` };
    return { kind: "split", first: given[0] as string, middle: given.length > 1 ? given.slice(1).join(" ") : null, last };
  }
  let ws = text.split(" ");
  while (ws.length > 0 && HONORIFIC.test(ws[0] as string)) ws = ws.slice(1);
  while (ws.length > 0 && SUFFIX.test(ws[ws.length - 1] as string)) ws = ws.slice(0, -1);
  if (ws.length < 2) return { kind: "ask", reason: `'${text}' is a single name, so which field it goes in is the user's call` };
  if (!ws.every((w) => /^[\p{L}][\p{L}'’.-]*$/u.test(w))) return { kind: "ask", reason: `'${text}' is not a person's name` };
  const p = ws.findIndex((w, i) => i > 0 && PARTICLES.has(w.toLowerCase()));
  const lastStart = p > 0 ? p : ws.length - 1;
  if (p < 0 && ws.length >= 4) return { kind: "ask", reason: `'${text}' has ${ws.length} names and no particle, so the surname is a guess` };
  if (lastStart === ws.length - 1 && PARTICLES.has((ws[lastStart] as string).toLowerCase())) return { kind: "ask", reason: `'${text}' ends in a particle` };
  return { kind: "split", first: ws[0] as string, middle: lastStart > 1 ? ws.slice(1, lastStart).join(" ") : null, last: ws.slice(lastStart).join(" ") };
}

/** A full name from a first and a last name, as a form's single name field takes it. */
export function joinName(first: string, last: string): string {
  return `${first.trim()} ${last.trim()}`;
}

/** The part of a split name a field asks for, or null when the split has none (no middle name) or asked. */
export function namePart(split: NameSplit, part: NamePart): string | null {
  if (split.kind !== "split") return null;
  return part === "first" ? split.first : part === "middle" ? split.middle : part === "last" ? split.last : null;
}

const UNIT_AT_END = /^(.*?\S)\s+((?:apt|apartment|unit|suite|ste|#)\.?\s*[\w-]+)$/iu;
const UNIT_ALONE = /^(?:apt|apartment|unit|suite|ste|#)\.?\s*[\w-]+$/iu;
const ZIP = /^\d{5}(?:-\d{4})?$/u;
const US_STATES = new Set(
  "alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada ohio oklahoma oregon pennsylvania tennessee texas utah vermont virginia washington wisconsin wyoming"
    .split(" ")
    .concat(["new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "rhode island", "south carolina", "south dakota", "west virginia", "district of columbia"]),
);
/**
 * C1: Canada's provinces and territories, so "48 Larchmere Avenue, Toronto, Ontario" splits as a US address does. Only
 * the names: a two-letter code is already any two capitals.
 */
const PROVINCES = new Set(["alberta", "british columbia", "manitoba", "new brunswick", "newfoundland and labrador", "nova scotia", "ontario", "prince edward island", "quebec", "québec", "saskatchewan", "northwest territories", "nunavut", "yukon"]);
const isState = (s: string): boolean => /^\p{Lu}{2}$/u.test(s) || US_STATES.has(s.toLowerCase()) || PROVINCES.has(s.toLowerCase());

/**
 * The parts of a comma-separated US-style address, each a substring of `text` as written: "4410 Speedway Apt 2,
 * Austin, Texas 78751" gives street "4410 Speedway", unit "Apt 2", city "Austin", state "Texas", zip "78751".
 * Null when the text is not such an address (no comma, or no house number first). A part the address does
 * not hold is absent.
 */
export function splitAddress(text: string): Partial<Record<AddressPart, string>> | null {
  const parts = text.split(",").map((p) => p.trim().replace(/\s+/g, " "));
  if (parts.length < 2 || !/^\d+[A-Za-z]?\s+\p{L}/u.test(parts[0] as string)) return null;
  const out: Partial<Record<AddressPart, string>> = {};
  const head = parts[0] as string;
  const u = UNIT_AT_END.exec(head);
  if (u !== null && u[1] !== undefined && u[2] !== undefined) {
    out.street = u[1];
    out.unit = u[2];
  } else out.street = head;
  let rest = parts.slice(1);
  if (rest[0] !== undefined && UNIT_ALONE.test(rest[0])) {
    if (out.unit !== undefined) return null;
    out.unit = rest[0];
    rest = rest.slice(1);
  }
  // The tail: "Texas 78751", "TX 78751", "TX", "78751", or "Texas" then "78751" as two parts.
  const tail = rest.at(-1);
  if (tail !== undefined) {
    const m = /^(.*?)\s*(\d{5}(?:-\d{4})?)$/u.exec(tail);
    if (m !== null && m[2] !== undefined && ZIP.test(m[2])) {
      out.zip = m[2];
      const st = (m[1] ?? "").trim();
      if (st !== "" && isState(st)) out.state = st;
      else if (st !== "") return null;
      rest = rest.slice(0, -1);
      if (out.state === undefined && rest.length > 0 && isState(rest.at(-1) as string)) {
        out.state = rest.at(-1) as string;
        rest = rest.slice(0, -1);
      }
    } else if (isState(tail)) {
      out.state = tail;
      rest = rest.slice(0, -1);
    }
  }
  // The city is the one plain-words part left before the state or ZIP code.
  if (rest.length === 1 && /^\p{L}[\p{L} .'’-]*$/u.test(rest[0] as string) && (out.state !== undefined || out.zip !== undefined)) out.city = rest[0] as string;
  else if (rest.length > 1) return null;
  return out;
}

/**
 * C1: the part of a date a field asks for, by its whole label's words: "month" or "year" as a word of the label, beside
 * a word that says a date ("Graduation date month", "Start date year", "Year of graduation", "Graduation month"). A
 * label with both, or with neither, asks for no part. Written for common form labels, not measured.
 */
export function datePart(label: string | null, section: string | null = null): DatePart | null {
  if (label === null) return null;
  const ws = new Set(words(label));
  // C2: a day too ("Date of birth day"); exactly one of the three.
  const named = (["month", "day", "year"] as const).filter((p) => ws.has(p));
  if (named.length !== 1) return null;
  const dated = ["date", "graduation", "start", "end", "began", "started", "ended", "birth", "from", "to", "completion", "expected"].some((w) => ws.has(w));
  if (dated) return named[0] as DatePart;
  // V3 (B24 ask-04): a label that is only the part's word ("Day") inside a group whose heading names a date (the "Date of
  // birth" fieldset around Month, Day and Year). Narrower words than the label's: "Delivery to" heads no date.
  const headed = section !== null && words(section).some((w) => SECTION_DATED.has(w));
  return ws.size === 1 && headed ? (named[0] as DatePart) : null;
}

/** Words of a group's heading that say its Month, Day and Year fields are one date's. Written for common form headings, not measured. */
const SECTION_DATED: ReadonlySet<string> = new Set(["date", "birth", "birthday", "dob", "graduation", "completion"]);

/** V3: the order of a numeric date's first two numbers: month then day ("md") or day then month ("dm"). */
export type DateOrder = "md" | "dm";

/**
 * V3: the order a format written beside a date states ("DOB (MM/DD/YYYY)", "dd.mm.yyyy"), or null when none is. Read from
 * the source's own text (a value's label), which says how that source writes its dates. A destination field's format
 * hint is not read here: it says how the form writes a date, not how the source did.
 */
export function dateOrderHint(text: string | null): DateOrder | null {
  if (text === null) return null;
  const md = /\bm{1,2}\s*[/.-]\s*d{1,2}\s*[/.-]\s*y{2,4}\b/iu.test(text);
  const dm = /\bd{1,2}\s*[/.-]\s*m{1,2}\s*[/.-]\s*y{2,4}\b/iu.test(text);
  // V3 review A5: a hint that names both orders, or sits beside a negation, alternative or condition ("DD/MM/YYYY, not
  // MM/DD/YYYY", "… or …"), says nothing about which one this date uses.
  if (md === dm || /\b(?:not|never|no|or|unless|except|if|maybe|either)\b/iu.test(text)) return null;
  return md ? "md" : "dm";
}

/**
 * V3: whether a span is a date written only in numbers ("04/12/1990", "4.12.", "04-12-90"), whose month and day order the
 * resolver would otherwise take from a locale or a convention. readDate gives such a date only in the order dateParts
 * settles from evidence (V3 review B9: the resolver read every dotted date day-first).
 */
export function numericDate(text: string): boolean {
  return /^\d{1,2}[/.-]\d{1,2}(?:[/.-](?:\d{2}|\d{4}))?\.?$/u.test(text.trim());
}

const NUMERIC_DATE = /^(\d{1,2})([/.-])(\d{1,2})\2((?:1[89]|2\d)\d{2})$/u;

/** Whether month `m` of `year` has a day `d`. */
function dayExists(year: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

/**
 * V3 (B24 ask-04): a numeric date with a four-digit year ("04/22/1990", "22.04.1990"). Which number is the month comes
 * only from evidence: one of them over 12, both the same, or `order` (dateOrderHint). Without it the month and day are
 * null and the year alone is given, since the year does not depend on the order. Evidence that contradicts the date, or
 * a day the month does not have, gives null.
 */
function numericDateParts(text: string, order: DateOrder | null): { month: string | null; day: string | null; year: string } | null {
  const m = NUMERIC_DATE.exec(text);
  if (m === null) return null;
  const [a, b, year] = [m[1] as string, m[3] as string, m[4] as string];
  const [na, nb] = [Number(a), Number(b)];
  const shown: DateOrder | null = na > 12 ? "dm" : nb > 12 ? "md" : na === nb ? "md" : null;
  if (shown !== null && order !== null && shown !== order && na !== nb) return null;
  const settled = shown ?? order;
  if (settled === null) return dayExists(Number(year), na, nb) || dayExists(Number(year), nb, na) ? { month: null, day: null, year } : null;
  const [month, day] = settled === "md" ? [a, b] : [b, a];
  return dayExists(Number(year), Number(month), Number(day)) ? { month, day, year } : null;
}

const NAMED_DAY_FIRST = /^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([A-Za-z]+)\.?,? (\d{4})$/u;
const NAMED_MONTH_FIRST = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? )?([A-Za-z]+)\.?(?: (\d{1,2})(?:st|nd|rd|th)?)?,? (\d{4})$/u;

/**
 * C2 (lead decision 5): a date's month, day and year as the date writes them, each a substring of it, for the fields of a
 * date split over several ("Date of birth month", "... day", "... year"): "March 14, 1990" gives "March", "14" and
 * "1990"; "1990-03-14" gives "03", "14" and "1990" (an ISO date's order is fixed); "March 1990" has no day. Null when
 * the text is not one date splitDate reads. V3: a numeric date too, ordered only on evidence (numericDateParts).
 */
export function dateParts(text: string, order: DateOrder | null = null): { month: string | null; day: string | null; year: string } | null {
  const t = text.trim();
  const numeric = numericDateParts(t, order);
  if (numeric !== null || NUMERIC_DATE.test(t)) return numeric;
  const d = splitDate(t);
  if (d === null) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(t);
  if (iso !== null) return { month: iso[2] as string, day: iso[3] as string, year: iso[1] as string };
  const dayFirst = NAMED_DAY_FIRST.exec(t);
  if (dayFirst !== null && monthIndex(dayFirst[2] as string) !== null) return { month: d.month, day: dayFirst[1] as string, year: d.year };
  const monthFirst = NAMED_MONTH_FIRST.exec(t);
  if (monthFirst !== null && monthIndex(monthFirst[1] as string) !== null) return { month: d.month, day: monthFirst[2] ?? null, year: d.year };
  return null;
}

/**
 * V3: the part `part` of a whole date as a field takes it: a named date's month as written and its year (splitDate), else
 * dateParts' part, a numeric date's ordered only on evidence (`order`). Null when the date does not settle that part.
 */
export function datePartOf(part: DatePart, text: string, order: DateOrder | null = null): string | null {
  const named = splitDate(text);
  if (named !== null && part !== "day") return part === "month" ? named.month : named.year;
  return dateParts(text, order)?.[part] ?? null;
}

const MONTH_NAME = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/u;
const YEAR = /(?<!\d)(1[89]\d{2}|2\d{3})(?!\d)/u;
const DATE_SHAPE = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? )?(?:[A-Z][a-z]+\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}|\d{1,2}(?:st|nd|rd|th)? (?:of )?[A-Z][a-z]+\.?,? \d{4}|[A-Z][a-z]+\.?,? \d{4}|\d{4}-\d{2}-\d{2})$/u;

/**
 * C1: a date's month, as its name is written, and its four-digit year, each a substring of `text`: "May 2021" gives
 * "May" and "2021", "October 18, 2026" "October" and "2026", "2026-11-01" only "2026" (a month number is no option's
 * name, and its order is the locale's). Null when the text is not one date with a year.
 */
export function splitDate(text: string): { month: string | null; year: string } | null {
  const t = text.trim();
  if (!DATE_SHAPE.test(t)) return null;
  const year = YEAR.exec(t)?.[1];
  if (year === undefined) return null;
  return { month: MONTH_NAME.exec(t)?.[1] ?? null, year };
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"] as const;

/** C2: the month (1 to 12) a month's name or its abbreviation names ("Aug", "Sept.", "August"), compared without case; null for anything else. */
export function monthIndex(word: string): number | null {
  const w = word.trim().toLowerCase().replace(/\.$/u, "");
  const i = MONTH_NAMES.findIndex((m) => m === w || (m.startsWith(w) && (w.length === 3 || w === "sept")));
  return i < 0 ? null : i + 1;
}

const MONTH_WORD = String.raw`(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?`;
const NAMED_MONTH_YEAR = new RegExp(`^${MONTH_WORD},?\\s+((?:1[89]|2\\d)\\d{2})$`, "iu");
const NAMED_MONTH_SHORT_YEAR = new RegExp(`^${MONTH_WORD}\\s+['’](\\d{2})$`, "iu");
const NUMBER_MONTH_YEAR = /^(0?[1-9]|1[0-2])\s*\/\s*((?:1[89]|2\d)\d{2})$/u;
const ISO_MONTH = /^((?:1[89]|2\d)\d{2})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/u;

/**
 * C2 (lead decision 1): the one month and year a span names as the user wrote it: "August 2022", "Aug. 2022", "Aug
 * '22", "08/2022", "2022-08", or a whole date that names its month ("October 18, 2026", "2026-11-01"). Read only
 * from the whole span, so "Started in August 2022" or "August 2022 to May 2023" is null. A year after an apostrophe
 * reads as the one year with those last two digits from 50 years before `refYear` to 10 years after it (the dates a
 * job or school form asks for): around 2026, '00 to '36 and '76 to '99; '37 to '75 is null (C2 review: a fixed century
 * split read "Aug '30" as 2030 whatever the date was). Null too for a season, a bare year, and "08/22" (a month and a
 * day, or a month and a year).
 */
export function monthYear(text: string, refYear: number = new Date().getUTCFullYear()): { month: number; year: number } | null {
  const t = text.trim().replace(/\s+/gu, " ");
  const named = NAMED_MONTH_YEAR.exec(t);
  if (named !== null) {
    const month = monthIndex(named[1] as string);
    return month === null ? null : { month, year: Number(named[2]) };
  }
  const short = NAMED_MONTH_SHORT_YEAR.exec(t);
  if (short !== null) {
    const month = monthIndex(short[1] as string);
    const yy = Number(short[2]);
    const years = [1900 + yy, 2000 + yy, 2100 + yy].filter((y) => y >= refYear - 50 && y <= refYear + 10);
    const year = years.length === 1 ? (years[0] as number) : null;
    return month === null || year === null ? null : { month, year };
  }
  const num = NUMBER_MONTH_YEAR.exec(t);
  if (num !== null) return { month: Number(num[1]), year: Number(num[2]) };
  const iso = ISO_MONTH.exec(t);
  if (iso !== null) return { month: Number(iso[2]), year: Number(iso[1]) };
  // A whole date with its month named, as splitDate reads one ("October 18, 2026").
  const d = splitDate(t);
  const month = d?.month === null || d?.month === undefined ? null : monthIndex(d.month);
  return d === null || month === null ? null : { month, year: Number(d.year) };
}

/**
 * C2: the one option of a month menu that names month `month` (1 to 12): its name or three-letter abbreviation, with
 * or without a period, or its number with or without a leading zero. Null when none does, or more than one ("Aug" and
 * "August" both listed).
 */
export function monthOption(options: readonly string[], month: number): string | null {
  const hits = options.filter((o) => {
    const t = o.trim();
    if (/^\d{1,2}$/u.test(t)) return Number(t) === month;
    return monthIndex(t) === month;
  });
  return hits.length === 1 ? (hits[0] as string) : null;
}

/** Whether a field asks for a country ("Country", "Country of residence"), not a country code. Written for common form labels, not measured. */
export function asksCountry(label: string | null): boolean {
  if (label === null) return false;
  const s = label.toLowerCase();
  return /\bcountry\b/.test(s) && !/\b(?:code|calling|dial(?:ling)?)\b/.test(s);
}

const PLACE_WORDS = /^\p{L}[\p{L} .'’-]*$/u;
/** USPS codes of the states and DC. isState takes any two capitals, which would read "London, UK" as a US place (B27 review). */
const STATE_CODES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));
const usState = (s: string): boolean => STATE_CODES.has(s) || US_STATES.has(s.toLowerCase());
const US_NAME = /^(?:US|USA|U\.S\.|U\.S\.A\.|United States(?: of America)?)$/iu;

/**
 * The city, state and country of a place written "City, State" or "City, State, Country", as a note's "Location:
 * Oakland, California, United States (in the Bay Area)" says it (B27: Greenhouse's Country and City dropdowns). The
 * second part must be a US state, which is what tells a place from a list of names or a "Last, First" name; a remark in
 * parentheses closing the last part is left out. Each part is a substring of `text`. Null for anything else, or when
 * a part is not plain words.
 */
export function splitPlace(text: string): { city: string; state: string; country: string | null } | null {
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  parts[parts.length - 1] = (parts.at(-1) as string).replace(/\s*\([^()]*\)$/u, "");
  if (!parts.every((p) => PLACE_WORDS.test(p) && text.includes(p)) || !usState(parts[1] as string)) return null;
  // Georgia is a state and a country, so "Tbilisi, Georgia" took State "Georgia" (B27 second review). It is the state
  // only when the place also says the United States; "Atlanta, GA" is unaffected.
  if ((parts[1] as string).toLowerCase() === "georgia" && !US_NAME.test(parts[2] ?? "")) return null;
  return { city: parts[0] as string, state: parts[1] as string, country: parts[2] ?? null };
}

/** Words a statement opens with, never part of a place's name (second fix-check: "My Toronto, Ontario"). */
const NOT_PLACE_WORDS = new Set(["i", "me", "my", "we", "our", "us", "in", "at", "from", "to", "near", "moving", "moved", "living", "live", "lived", "based", "currently", "now", "love", "work", "working", "not", "no", "never", "except", "but", "or", "and"]);
/** Lowercase words a place's name may hold between capitalized ones. */
const PLACE_JOINERS = new Set(["de", "del", "la", "le", "du", "des", "of", "on", "upon", "the", "sur", "en"]);
/** C2: Canada's province and territory codes, as Canada Post writes them. */
const PROVINCE_CODES = new Set("AB BC MB NB NL NS NT NU ON PE QC SK YT".split(" "));

/**
 * C2 (lead decision 2): the user's place "City, Region" with its country added, as a location list names it: "San Diego,
 * California" gives "San Diego, California, United States". The country follows from the region by a closed list: a
 * US state or its USPS code, the United States; a Canadian province or territory or its code, Canada. Georgia, a state
 * and a country, is neither. Null for anything else: a bare city ("Portland" is many places, so it never becomes one
 * of them), a place that already names a country, a remark, or more than two parts. The decision also allows the
 * user's About country; it is not used (C2 review): the written value would then depend on an About entry the
 * proposal cannot name beside its source, so an edit of that entry after the preview would go unchecked. Fill offers
 * this only for a field whose label asks where (asksPlace), to a dropdown or menu, which the page engine sets only to
 * an option named exactly this (fill.ts controlValue).
 */
export function placeWithCountry(text: string): string | null {
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length !== 2 || !parts.every((p) => PLACE_WORDS.test(p) && p.length <= 40)) return null;
  // A place's name, not a sentence that ends in one (fix-check: "I used to live in Toronto, Ontario"): at most four
  // words, each capitalized or a joiner place names use ("Sault Ste. Marie", "Stratford upon Avon").
  // Each word capitalized as a name is, not in capitals ("I LOVE TORONTO"), and none a word a statement opens with.
  const city = (parts[0] as string).split(/\s+/u);
  const named = (w: string): boolean => /^(?:d['’])?\p{Lu}[\p{Ll}'’.-]*(?:[-’'][\p{Lu}][\p{Ll}'’.-]*)*$/u.test(w) && !NOT_PLACE_WORDS.has(w.toLowerCase());
  if (city.length > 4 || !city.every((w) => named(w) || PLACE_JOINERS.has(w))) return null;
  const region = parts[1] as string;
  if (region.toLowerCase() === "georgia") return null;
  const country = usState(region) ? "United States" : PROVINCE_CODES.has(region) || PROVINCES.has(region.toLowerCase()) ? "Canada" : null;
  return country === null ? null : `${parts[0]}, ${region}, ${country}`;
}

/**
 * C2 review: whether a field's label asks where the user is or will work ("Location", "Location (City)", "Where are you
 * based?", "City"), so a place may be given its country (placeWithCountry). A field about a person ("Full name") never
 * is: "Smith, Virginia" read as a place became "Smith, Virginia, United States". Written for common form labels, not
 * measured.
 */
export function asksPlace(label: string | null): boolean {
  if (label === null || asksCountry(label) || /\b(?:name|school|college|university|degree|phone|code|number|e-?mail|company|employer)\b/iu.test(label)) return false;
  // "Where" only with a word that says where the user is or works (fix-check: "Where did you go to school?").
  // Not "relocate" or a bare "based" (second fix-check: "Relocation bonus", "Cloud-based platform").
  return /\b(?:location|city|town|hometown)\b/iu.test(label) || /\bwhere\b.*\b(?:live|living|based|located|work|working|reside|from)\b/iu.test(label);
}

/**
 * Whether a value reads as the part of a name or an address a field asks for: a person's full name splits
 * (splitName), a first, middle or last name is words of letters, a ZIP code is five digits (or ZIP+4), a
 * state is letters, and a unit names one. Street and city are left to kinds.ts misfit, which already reads
 * them. A sentence in a name field ("Dr. Simone Achebe, my manager at Ridgeline") does not fit.
 */
export function partFits(part: FillPart, value: string): boolean {
  const v = value.trim();
  switch (part) {
    case "country":
      return PLACE_WORDS.test(v);
    case "full":
      return splitName(v).kind === "split";
    case "first":
    case "middle":
    case "last":
      return /^[\p{L}][\p{L}'’. -]*$/u.test(v) && v.split(" ").length <= 3;
    case "zip":
      return /^\d{5}(?:-\d{4})?$/u.test(v);
    case "state":
      return /^[\p{L}][\p{L} .]*$/u.test(v);
    case "unit":
      return UNIT_ALONE.test(v) || /^[\w-]{1,6}$/u.test(v);
    case "street":
    case "city":
      return true;
    case "month":
      // V3: or its number, as a numeric date gives it ("04" of "04/22/1990").
      return (MONTH_NAME.test(v) && v.split(" ").length === 1) || /^(?:0?[1-9]|1[0-2])$/u.test(v);
    case "day":
      return /^(?:0?[1-9]|[12]\d|3[01])$/u.test(v);
    case "year":
      return /^(?:1[89]|2\d)\d{2}$/u.test(v);
  }
}
