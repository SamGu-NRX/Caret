import { Disclosure, type ModelText } from "../privacy/disclosure.ts";
// Text a goal plan writes in Caret's own words (B30): a short reply, message or description. The writer composes it;
// code decides whether it may be offered. A draft must add no fact: every number, date, time, money amount, email
// address, phone, URL, code and name in it must be one the instruction, a window the plan names as the draft's
// basis, or a memory value the plan uses already states. Code reads facts as whole typed expressions, not loose
// tokens, so a draft cannot recombine allowed pieces into a new fact: "October 3" or "October third" is not covered
// by "October 8 at 3:00 PM", "half past three" is not "3:00", and "3 friends" is not covered by "3:00 PM". Every digit
// must belong to a fact code read, and text code cannot read as a fact (digits in another script, invisible
// characters) refuses the draft. Anything else refuses the draft and names the word.
//
// Beyond facts, in code: at most DRAFT_MAX_CHARS characters of plain sentences; no negation the instruction does not
// contain; no claim to have copied someone in or attached something; money only as a window or memory shows it; and
// no time, date or amount at all when the instruction states one that the windows contradict ("tell her 4" when the
// invite says 3). Commitments and promises are not code-decidable, so every sentence that is not a bare greeting,
// thanks or sign-off with a name the basis shows goes to Jev as a yes/no question (confirmClaims), asked twice, and a
// sentence both asks do not confirm at NOUL_FLOOR refuses the draft. With no Jev, such a draft is refused.
//
// Known gaps, on the fail-open side and backed only by the Jev check: a lower-case name is read as a name only right
// after a greeting or thanks; a lower-case Roman numeral only after a word like "chapter"; an amount with no currency
// only beside a word like "quote" or "price"; a commitment with no fact in it ("I'll handle it") is Jev's to judge.
import type { AskJev, JevRequest } from "../fill/jev.ts";
import { NOUL_FLOOR } from "../planner/intent-makers.ts";
import type { Snippet } from "../privacy.ts";

/** Longest draft, in characters (code points). The brief's limit (B30). */
export const DRAFT_MAX_CHARS = 600;
/** Line breaks a draft may have: a greeting, a few short paragraphs and a sign-off. Assumed, not measured. */
const MAX_LINE_BREAKS = 6;

export type DraftWhy = "empty" | "tooLong" | "notProse" | "unreadable" | "newFact" | "money" | "conflict" | "negation" | "recipientClaim" | "claim" | "unchecked";

/** Why code will not offer a draft. `says` is what the user reads; `word` is the draft's text that failed. */
export class DraftRefused extends Error {
  readonly why: DraftWhy;
  readonly says: string;
  readonly word: string | null;
  constructor(why: DraftWhy, says: string, word: string | null = null) {
    super(says);
    this.why = why;
    this.says = says;
    this.word = word;
  }
}

// MARK: - facts

/** Numbers and amounts compare as canonical decimal strings, so 9007199254740993 is not 9007199254740992. */
export type Fact =
  | { kind: "email" | "url" | "phone" | "code"; text: string; norm: string }
  | { kind: "money"; text: string; amount: string; currency: string | null }
  | { kind: "time"; text: string; h: number; m: number; mer: "am" | "pm" | null }
  | { kind: "date"; text: string; weekday: number | null; month: number | null; day: number | null; year: number | null; rel: string | null }
  | { kind: "number"; text: string; value: string }
  | { kind: "name"; text: string; norm: string };

const MONTHS: Record<string, number> = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
const WEEKDAYS: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const UNITS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, dozen: 12, twice: 2 };
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90, hundredth: 100, thousandth: 1000,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000, billion: 1_000_000_000 };
const NUMBER_WORD = [...Object.keys(ORDINALS), ...Object.keys(UNITS), ...Object.keys(SCALES)].sort((x, y) => y.length - x.length).join("|");
/** A run of number words: "twenty-five", "five hundred", "thirty first". */
const WORDS = `(?:(?:${NUMBER_WORD})[\\s-]+(?:and\\s+)?)*(?:${NUMBER_WORD})`;
const HOUR_WORD = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";
const H = `\\d{1,2}|${HOUR_WORD}`;
const CURRENCY: Record<string, string> = { $: "usd", dollar: "usd", dollars: "usd", usd: "usd", bucks: "usd", "€": "eur", euro: "eur", euros: "eur", eur: "eur", "£": "gbp", pound: "gbp", pounds: "gbp", gbp: "gbp", "¥": "jpy", yen: "jpy", jpy: "jpy", cad: "cad", aud: "aud" };
const MULT: Record<string, number> = { k: 1000, thousand: 1000, m: 1_000_000, million: 1_000_000, bn: 1_000_000_000, billion: 1_000_000_000 };
/** An amount in digits, ending where the digits end ("$45.009" is not "$45.00" and a stray 9). */
const NUM = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?![\\d.,]*\\d)";
const MONTH_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const WEEKDAY_RE = "sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?";
const DAY = `\\d{1,2}(?:st|nd|rd|th)?|${WORDS}`;
/** Words that make the number beside them an amount of money even with no currency ("the 500 quote"). */
const MONEY_NOUN = "quote|price|cost|total|fee|fees|invoice|charge|budget|deposit|rate|bill|amount|balance|payment|refund|estimate|salary|rent";
/** Count nouns: "total of 5 participants" is a count, not money. A number followed by one is never read as an amount. */
const COUNT = "(?!\\s+(?:people|persons?|participants?|guests?|attendees?|members?|items?|units?|pieces?|seats?|tickets?|rooms?|nights?|days?|hours?|minutes?|weeks?|months?|years?|times?|pages?|copies|boxes|orders?|students?|kids?|children|adults?|employees?|users?|spots?|slots?)\\b)";
/** Nouns whose lower-case Roman numeral is a number ("chapter xvi"). */
const NUMBERED = "chapter|part|section|volume|vol\\.?|act|phase|stage|grade|level|book|round|step|unit|room|suite|floor|apt\\.?|apartment|appendix|article";

/** "45", "1,200.50" and "007" as one canonical decimal string each: "45", "1200.5", "7". */
export function decimal(s: string): string {
  const [int = "", frac = ""] = s.replace(/,/gu, "").split(".");
  const i = int.replace(/^0+(?=\d)/u, "");
  const f = frac.replace(/0+$/u, "");
  return f === "" ? i : `${i}.${f}`;
}
/** A decimal string times a whole multiplier, exactly: "1.5" times 1000 is "1500". */
function times(d: string, mult: number): string {
  if (mult === 1) return d;
  const [i = "0", f = ""] = d.split(".");
  const zeros = String(mult).length - 1;
  const digits = `${i}${f.padEnd(zeros, "0")}`;
  return decimal(`${digits.slice(0, i.length + zeros)}.${digits.slice(i.length + zeros)}`);
}
function wordValue(phrase: string): number {
  let total = 0;
  let cur = 0;
  for (const w of phrase.toLowerCase().split(/[\s-]+/u).filter((x) => x !== "" && x !== "and" && x !== "a")) {
    if (w in SCALES) {
      cur = (cur === 0 ? 1 : cur) * (SCALES[w] as number);
      if (w !== "hundred") (total += cur), (cur = 0);
    } else cur += UNITS[w] ?? ORDINALS[w] ?? 0;
  }
  return total + cur;
}
const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
function romanValue(s: string): number {
  let n = 0;
  const t = s.toLowerCase();
  for (let i = 0; i < t.length; i++) {
    const v = ROMAN[t[i] as string] ?? 0;
    n += v < (ROMAN[t[i + 1] as string] ?? 0) ? -v : v;
  }
  return n;
}
const hourOf = (s: string): number => (/^\d+$/u.test(s) ? Number(s) : wordValue(s));
const dayOf = (s: string): number => (/^\d/u.test(s) ? Number(s.replace(/\D/gu, "")) : wordValue(s));
const merOf = (s: string | undefined): "am" | "pm" | null => (s === undefined ? null : /^a/iu.test(s) ? "am" : "pm");
/** A time as a 12-hour clock reads it: 15:00 is 3:00 pm. */
function clock(h: number, m: number, mer: "am" | "pm" | null): { h: number; m: number; mer: "am" | "pm" | null } {
  if (mer === null && h >= 13 && h <= 23) return { h: h - 12, m, mer: "pm" };
  if (mer === null && h === 0) return { h: 12, m, mer: "am" };
  return { h, m, mer };
}
const digitsOf = (s: string): string => s.replace(/\D/gu, "");
const MINUTE_WORDS: Record<string, number> = { "o'clock": 0, "o’clock": 0, oclock: 0, fifteen: 15, thirty: 30, "forty-five": 45, "forty five": 45 };
function dateWord(m: RegExpExecArray): Fact {
  const w = (m[2] ?? "").toLowerCase().replace(/\.$/u, "");
  return { kind: "date", text: m[0], weekday: WEEKDAYS[w] ?? null, month: WEEKDAYS[w] === undefined ? (MONTHS[w] ?? null) : null, day: null, year: null, rel: m[1] === undefined || m[1] === "" ? null : m[1].toLowerCase().replace(/\s+/gu, " ") };
}
/** A sentence's period after "PM" is the sentence's, not the time's ("p.m." keeps its own). */
const timeText = (t: string): string => (/[ap]m\.$/iu.test(t) && !/[ap]\.m\.$/iu.test(t) ? t.slice(0, -1) : t);
/** A link's host in lower case without scheme or "www."; its path and query keep their case, which servers may read. */
function urlNorm(s: string): string {
  const t = s.replace(/^https?:\/\//iu, "").replace(/^www\./iu, "").replace(/[/.,;:!?)]+$/u, "");
  const cut = t.search(/[/?#]/u);
  return cut < 0 ? t.toLowerCase() : `${t.slice(0, cut).toLowerCase()}${t.slice(cut)}`;
}
const money = (text: string, amount: string, mult: string | undefined, currency: string | undefined): Fact => ({ kind: "money", text, amount: times(decimal(amount), MULT[(mult ?? "").toLowerCase()] ?? 1), currency: currency === undefined ? null : (CURRENCY[currency.toLowerCase()] ?? null) });

interface Rule {
  re: RegExp;
  make: (m: RegExpExecArray) => Fact | null;
}

const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
/** Rules in the order they claim text: a span one rule claims is not read again by a later one. */
const RULES: readonly Rule[] = [
  // Addresses: an email as written or spelled out ("dana at example dot com"), then links with or without a scheme.
  { re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, make: (m) => ({ kind: "email", text: m[0], norm: m[0].toLowerCase() }) },
  {
    re: /(?<![\p{L}\p{N}])([\p{L}\p{N}._%+-]+)\s+(?:at|\(at\)|\[at\])\s+([\p{L}\p{N}-]+(?:\s+(?:dot|\(dot\)|\[dot\])\s+[\p{L}\p{N}-]+)+)(?![\p{L}\p{N}])/giu,
    make: (m) => ({ kind: "email", text: m[0], norm: `${m[1]}@${(m[2] ?? "").replace(/\s+(?:dot|\(dot\)|\[dot\])\s+/giu, ".")}`.toLowerCase() }),
  },
  { re: /\bhttps?:\/\/[^\s<>()"]+|\bwww\.[^\s<>()"]+|(?<![\p{L}\p{N}@.-])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}-])(?:\/[^\s<>()"]*)?/gu, make: (m) => ({ kind: "url", text: m[0].replace(/[.,;:!?)]+$/u, ""), norm: urlNorm(m[0]) }) },
  // Dates: an optional this/next/last, weekday, a month and a day (in digits or words), and a year, read as one; then
  // numeric dates; then a weekday with this, next or last.
  {
    re: new RegExp(`${B}(?:(this|next|last|coming)\\s+)?(?:(${WEEKDAY_RE})\\.?,?\\s+)?(?:the\\s+)?(?:(${MONTH_RE})\\.?\\s+(?:the\\s+)?(${DAY})|(${DAY})\\s+(?:of\\s+)?(${MONTH_RE})\\.?)(?:,?\\s+(\\d{4}))?${E}`, "giu"),
    make: (m) => ({ kind: "date", text: /\p{L}{4,}\.$/u.test(m[0]) ? m[0].slice(0, -1) : m[0], weekday: m[2] === undefined ? null : (WEEKDAYS[m[2].toLowerCase()] ?? null), month: MONTHS[(m[3] ?? m[6] ?? "").toLowerCase()] ?? null, day: dayOf(m[4] ?? m[5] ?? ""), year: m[7] === undefined ? null : Number(m[7]), rel: m[1] === undefined ? null : m[1].toLowerCase() }),
  },
  { re: new RegExp(`${B}(\\d{4})-(\\d{1,2})-(\\d{1,2})${E}`, "gu"), make: (m) => ({ kind: "date", text: m[0], weekday: null, month: Number(m[2]), day: Number(m[3]), year: Number(m[1]), rel: null }) },
  { re: new RegExp(`${B}(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?${E}`, "gu"), make: (m) => ({ kind: "date", text: m[0], weekday: null, month: Number(m[1]), day: Number(m[2]), year: m[3] === undefined ? null : Number(m[3].length === 2 ? `20${m[3]}` : m[3]), rel: null }) },
  // A weekday or month with what places it: "next Friday", "this coming October", "Friday after next", "early November".
  { re: new RegExp(`${B}((?:this\\s+)?(?:next|last|coming|this|early|late|mid|end of|beginning of|start of))[\\s-]+(${WEEKDAY_RE}|${MONTH_RE})${E}`, "giu"), make: dateWord },
  { re: new RegExp(`${B}()(${WEEKDAY_RE}|${MONTH_RE}|week|month|weekend)\\s+(?:after|before)\\s+(?:next|last|that)${E}`, "giu"), make: (m) => ({ ...dateWord(m), rel: m[0].toLowerCase().replace(/\s+/gu, " ") }) },
  // Money: a currency sign, code or word with an amount, and an amount beside a word such as "quote".
  { re: new RegExp(`([$€£¥])\\s?(${NUM})(?:\\s?(k|m|bn|thousand|million|billion)${E})?`, "giu"), make: (m) => money(m[0], m[2] ?? "", m[3], m[1]) },
  { re: new RegExp(`${B}(usd|eur|gbp|jpy|cad|aud)\\s?(${NUM})(?:\\s?(k|m|bn|thousand|million|billion)${E})?`, "giu"), make: (m) => money(m[0], m[2] ?? "", m[3], m[1]) },
  { re: new RegExp(`${B}(${NUM})\\s?(k|thousand|million|billion)?\\s?(dollars?|usd|bucks|euros?|eur|pounds?|gbp|yen|jpy|cad|aud)${E}`, "giu"), make: (m) => money(m[0], m[1] ?? "", m[2], m[3]) },
  { re: new RegExp(`${B}(${WORDS})\\s+(dollars?|bucks|euros?|pounds?)${E}`, "giu"), make: (m) => money(m[0], String(wordValue(m[1] ?? "")), undefined, m[2]) },
  { re: new RegExp(`${B}(?:${MONEY_NOUN})\\s+(?:of|is|was|at|for|comes to|will be|would be)?\\s*(${NUM})${E}${COUNT}`, "giu"), make: (m) => money(m[0], m[1] ?? "", undefined, undefined) },
  { re: new RegExp(`${B}(${NUM})\\s+(?:${MONEY_NOUN})${E}`, "giu"), make: (m) => money(m[0], m[1] ?? "", undefined, undefined) },
  { re: new RegExp(`${B}(?:${MONEY_NOUN})\\s+(?:of|is|was|at|for|comes to|will be|would be)?\\s*(${WORDS})${E}${COUNT}`, "giu"), make: (m) => money(m[0], String(wordValue(m[1] ?? "")), undefined, undefined) },
  // Times, each read whole: "half past three", "quarter to 4", "3:30 pm", "three thirty", "4 o'clock", "at 4", noon.
  {
    re: new RegExp(`${B}(half|quarter)\\s+(past|after|to|before|till|til)\\s+(${H})(?:\\s?(a\\.?m\\.?|p\\.?m\\.?))?(?![\\p{L}\\p{N}])`, "giu"),
    make: (m) => {
      const h = hourOf((m[3] ?? "").toLowerCase());
      const back = /^(to|before|till|til)$/iu.test(m[2] ?? "");
      const mins = (m[1] ?? "").toLowerCase() === "half" ? 30 : 15;
      return { kind: "time", text: timeText(m[0]), ...clock(back ? (h === 1 ? 12 : h - 1) : h, back ? 60 - mins : mins, merOf(m[4])) };
    },
  },
  { re: new RegExp(`${B}(${H})(?::(\\d{2}))?\\s?(a\\.?m\\.?|p\\.?m\\.?)(?![\\p{L}])`, "giu"), make: (m) => ({ kind: "time", text: timeText(m[0]), ...clock(hourOf((m[1] ?? "").toLowerCase()), Number(m[2] ?? 0), merOf(m[3])) }) },
  { re: new RegExp(`${B}(\\d{1,2}):(\\d{2})(?!\\d)`, "gu"), make: (m) => ({ kind: "time", text: m[0], ...clock(Number(m[1]), Number(m[2]), null) }) },
  {
    re: new RegExp(`${B}(${H})\\s*(o['’]?clock|fifteen|thirty|forty[- ]five)(?:\\s?(a\\.?m\\.?|p\\.?m\\.?))?(?![\\p{L}\\p{N}])`, "giu"),
    make: (m) => ({ kind: "time", text: timeText(m[0]), ...clock(hourOf((m[1] ?? "").toLowerCase()), MINUTE_WORDS[(m[2] ?? "").toLowerCase().replace(/’/gu, "'")] ?? 0, merOf(m[3])) }),
  },
  { re: new RegExp(`${B}(?:at|by|around|until|till|til|from|before|after|past)\\s+(${H})(?![\\p{L}\\p{N}:/]|[.,]\\d|\\s*(?:%|percent|people|guests|of|more|minutes?|hours?|days?|weeks?))`, "giu"), make: (m) => ({ kind: "time", text: m[0], ...clock(hourOf((m[1] ?? "").toLowerCase()), 0, null) }) },
  { re: /\b(noon|midday|midnight)\b/giu, make: (m) => ({ kind: "time", text: m[0], h: 12, m: 0, mer: /night/iu.test(m[0]) ? "am" : "pm" }) },
  // Phones: seven or more digits with separators, not inside a code.
  { re: /(?<![\p{L}\p{N}-])\+?\(?\d[\d\s().-]{5,}\d(?![\p{L}\p{N}-])/gu, make: (m) => (digitsOf(m[0]).length >= 7 && /[\s().-]/u.test(m[0].trim()) ? { kind: "phone", text: m[0].trim(), norm: digitsOf(m[0]) } : null) },
  // Ordinals, codes and Roman numerals: "8th", "ORD-2026-48213", "A12", "XVI", "chapter xvi".
  { re: /\b(\d{1,3})(?:st|nd|rd|th)\b/giu, make: (m) => ({ kind: "number", text: m[0], value: decimal(m[1] ?? "") }) },
  { re: /#?(?<![\p{L}\p{N}])(?=[\p{L}\p{N}_./-]*\p{N})[\p{L}\p{N}]+(?:[-_./][\p{L}\p{N}]+)+(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?=\p{L}*\p{N})(?=\p{N}*\p{L})[\p{L}\p{N}]{2,}(?![\p{L}\p{N}])/gu, make: (m) => ({ kind: "code", text: m[0], norm: m[0].toLowerCase().replace(/^#/u, "") }) },
  { re: /\b(?=[MDCLXVI]{2,}\b)M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})\b/gu, make: (m) => (m[0] === "" ? null : { kind: "number", text: m[0], value: String(romanValue(m[0])) }) },
  { re: new RegExp(`(?<=\\b(?:${NUMBERED})\\s+)(?=[ivxlcdm]+\\b)m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})\\b`, "giu"), make: (m) => (m[0] === "" ? null : { kind: "number", text: m[0], value: String(romanValue(m[0])) }) },
  // Numbers in words.
  { re: new RegExp(`${B}(${WORDS})${E}`, "giu"), make: (m) => ({ kind: "number", text: m[0], value: String(wordValue(m[0])) }) },
  // Dates in words: weekdays and months alone, in any case; "May", "March" and the short forms only capitalized.
  { re: /\b()(sunday|monday|tuesday|wednesday|thursday|friday|saturday|january|february|april|june|july|august|september|october|november|december)\b/giu, make: dateWord },
  { re: new RegExp(`${B}()(May|March|(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?)${E}`, "gu"), make: dateWord },
  {
    re: /\b(?:today|tonight|tomorrow|yesterday|(?:this|next|last)\s+(?:week|weekend|month|year|morning|afternoon|evening|night)|weekend|end of (?:the )?(?:day|week|month)|eod|eow|asap|(?<!good\s)(?:morning|afternoon|evening))\b/giu,
    make: (m) => ({ kind: "date", text: m[0], weekday: null, month: null, day: null, year: null, rel: m[0].toLowerCase().replace(/\s+/gu, " ") }),
  },
];

/**
 * Capitalized words a sentence may start with that are not names. Closed on purpose: a capitalized word outside it
 * must appear in the draft's basis, so an unknown word fails closed. Words that are also common first names (Will,
 * May, Hope, Grace, Mark, Bill) are left out.
 */
const STARTERS = new Set(
  "a about absolutely after again agreed all also although an and any anything apologies appreciate are as ask at awesome back because before best both but by call can cheers could count dear definitely did do does done each either even every everybody everyone everything excellent feel folks for from give glad good got great guys had happy has have hello here hey hi how however i if in is it it's its just keep kind let let's looking many more most much my no noted now of oh ok okay on or our perfect please quick reach really received regards see should since so some sorry sounds still sure talk team tell thank thanks that that's the their then there these they this those though to totally understood until very we we'll we're well were what when where which while who why with wonderful would yes yeah yep you you're your".split(" "),
);
const FIRST_PERSON = /^I(?:['’](?:m|ll|d|ve))?$/u;
/** A greeting or thanks, after which a word is a name whatever its case ("thanks mallory"). */
const ADDRESSED = /(?<![\p{L}\p{N}])(?:hi|hello|hey|dear|thanks|thank you)[,]?\s+([\p{L}][\p{L}'’-]*)(?=\s*(?:[,.!?]|$))/giu;

/** Text as the checks read it: compatibility forms folded (full-width digits are digits), invisible format characters gone. */
const folded = (t: string): string => t.normalize("NFKC").replace(/\p{Cf}/gu, "");

/** Every fact `text` states, in order. Every digit of it ends up in some fact. */
export function factsIn(raw: string): Fact[] {
  const text = folded(raw);
  const taken = new Array<boolean>(text.length).fill(false);
  const found: { at: number; fact: Fact }[] = [];
  const claim = (start: number, end: number, fact: Fact): void => {
    found.push({ at: start, fact });
    taken.fill(true, start, end);
  };
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (m[0] === "" || taken.slice(start, end).some(Boolean)) continue;
      const made = rule.make(m as RegExpExecArray);
      if (made !== null) claim(start, end, made);
    }
  }
  // Every digit no rule claimed is a number, read from the untaken run it sits in, so no digit goes unread when a
  // rule above stopped short of it or overlapped it.
  for (let i = 0; i < text.length; ) {
    if (taken[i] || !/\d/u.test(text[i] as string)) {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && !taken[j] && (/\d/u.test(text[j] as string) || (/[.,]/u.test(text[j] as string) && /\d/u.test(text[j + 1] ?? "") && !taken[j + 1]))) j++;
    // A sign that stands before the digits is the number's: "-5" is not 5.
    const signed = i > 0 && !taken[i - 1] && /[-+−]/u.test(text[i - 1] as string) && !/[\p{L}\p{N}]/u.test(text[i - 2] ?? "");
    const from = signed ? i - 1 : i;
    claim(from, j, { kind: "number", text: text.slice(from, j), value: `${signed && text[i - 1] !== "+" ? "-" : ""}${decimal(text.slice(i, j))}` });
    i = j;
  }
  // A word right after a greeting or thanks is someone's name, whatever its case.
  for (const m of text.matchAll(ADDRESSED)) {
    const word = m[1] ?? "";
    const start = m.index + m[0].length - word.length;
    if (taken.slice(start, start + word.length).some(Boolean) || STARTERS.has(word.toLowerCase().replace(/’/gu, "'")) || FIRST_PERSON.test(word)) continue;
    claim(start, start + word.length, { kind: "name", text: word, norm: wordsOf(word) });
  }
  // Names: runs of capitalized words, one space apart, and runs of letters from scripts without case ("李雷"), in what
  // no rule claimed. A STARTERS word, "I" and "OK" are not names, wherever they stand.
  let run: { at: number; words: string[]; end: number } | null = null;
  const flush = (): void => {
    if (run === null) return;
    const phrase = run.words.join(" ").replace(/['’]s$/u, "");
    found.push({ at: run.at, fact: { kind: "name", text: phrase, norm: wordsOf(phrase) } });
    run = null;
  };
  for (const m of text.matchAll(/\p{Lu}[\p{L}\p{M}'’-]*|\p{Lo}[\p{Lo}\p{M}]*/gu)) {
    const end = m.index + m[0].length;
    const word = m[0].replace(/[-'’]+$/u, "");
    const notName = taken.slice(m.index, end).some(Boolean) || FIRST_PERSON.test(word) || word === "OK" || STARTERS.has(word.toLowerCase().replace(/’/gu, "'")) || (m.index > 0 && /[\p{L}\p{N}]/u.test(text[m.index - 1] ?? ""));
    if (notName) {
      flush();
      continue;
    }
    if (run !== null && text.slice(run.end, m.index) === " ") {
      run.words.push(word);
      run.end = end;
    } else {
      flush();
      run = { at: m.index, words: [word], end };
    }
  }
  flush();
  return found.sort((a, b) => a.at - b.at).map((x) => x.fact);
}

/** Lower-case words with possessives dropped, joined by single spaces, as names are compared. */
const wordsOf = (s: string): string =>
  folded(s)
    .toLowerCase()
    .replace(/['’]s\b/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}'’]+/gu, " ")
    .trim();

/** Whether corpus fact `c` states everything fact `f` states. */
export function covers(c: Fact, f: Fact): boolean {
  if (c.kind !== f.kind) return false;
  switch (f.kind) {
    case "email":
    case "url":
    case "phone":
    case "code":
    case "name":
      return (c as typeof f).norm === f.norm;
    case "number":
      return (c as typeof f).value === f.value;
    case "money": {
      const x = c as typeof f;
      // A draft that names a currency needs a source that names the same one.
      return x.amount === f.amount && (f.currency === null || x.currency === f.currency);
    }
    case "time": {
      const x = c as typeof f;
      return x.h === f.h && x.m === f.m && (f.mer === null || x.mer === f.mer);
    }
    case "date": {
      const x = c as typeof f;
      return (["weekday", "month", "day", "year", "rel"] as const).every((k) => f[k] === null || x[k] === f[k]);
    }
  }
}

// MARK: - the draft's basis

/**
 * What a draft may take facts from: the instruction, each window the plan names as its basis (by its text as it reads
 * now, or as frozen), and the memory values it uses. A value the program names in its basis stands for its source: a
 * window's value brings its window, an instruction's span is the instruction's, and a memory value is memory.
 */
export interface DraftBasis {
  instruction: string;
  windows: readonly { title: string; text: string }[];
  memory: readonly string[];
}

interface Sourced {
  fact: Fact;
  from: "instruction" | "window" | "memory";
  title: string | null;
}

function basisFacts(b: DraftBasis): Sourced[] {
  return [
    ...factsIn(b.instruction).map((fact) => ({ fact, from: "instruction" as const, title: null })),
    ...b.windows.flatMap((w) => [w.title, ...w.text.split("\n")].flatMap((line) => factsIn(line).map((fact) => ({ fact, from: "window" as const, title: w.title })))),
    ...b.memory.flatMap((t) => factsIn(t).map((fact) => ({ fact, from: "memory" as const, title: null }))),
  ];
}

/** Whether `name` appears as a run of whole words in the basis's text, case and possessives aside. */
function nameIn(b: DraftBasis, norm: string): boolean {
  if (norm === "") return false;
  const all = [b.instruction, ...b.windows.flatMap((w) => [w.title, w.text]), ...b.memory].map((t) => ` ${wordsOf(t)} `);
  return all.some((t) => t.includes(` ${norm} `));
}

// MARK: - the checks code can decide

const NEGATION = /\b(?:not|no|never|none|nobody|nothing|nowhere|neither|nor|cannot|unable|decline|declining|unfortunately|without|refuse|refusing)\b|\b\p{L}+n['’]t\b/iu;
/** Words that claim Caret added someone or something to the message, which a draft never does. */
const RECIPIENT_CLAIM = /\b(?:b?cc(?:['’]?(?:d|ed|ing))?|copying in|copied in|looping in|looped in|fwd|forward(?:ed|ing)?\s+(?:it|this|that|the|your|these|them|him|her)|attach(?:ed|ing|ment|ments)?|enclosed)\b/iu;
/** Markup and placeholders: a draft is plain sentences. */
const NOT_PROSE: readonly [RegExp, string][] = [
  [/\p{Cf}/u, "invisible characters"],
  [/[<>]/u, "angle brackets"],
  [/[[\]{}]/u, "brackets"],
  [/[*_`#|~]/u, "formatting marks"],
  [/^\s*(?:[-•–]|\d+[.)])\s/mu, "a list"],
  [/^\s*(?:to|cc|bcc|from|subject|re|date)\s*:/imu, "a header line"],
  [/[\t\u0000-\u0009\u000b-\u001f\u007f]/u, "control characters"],
  [/\b(?:TBD|TODO|XXX|lorem ipsum)\b/iu, "a placeholder"],
];

const q = (s: string): string => `"${s.replace(/\s+/gu, " ").trim().slice(0, 60)}"`;

/** What the draft's text alone makes refusable, before its facts are read. */
function shape(text: string): void {
  const t = text.trim();
  if (t === "") throw new DraftRefused("empty", "the draft is empty");
  const n = [...t].length;
  if (n > DRAFT_MAX_CHARS) throw new DraftRefused("tooLong", `the draft has ${n} characters, and a draft has at most ${DRAFT_MAX_CHARS}`);
  for (const [re, what] of NOT_PROSE) if (re.test(t)) throw new DraftRefused("notProse", `the draft has ${what}, and a draft is plain sentences`);
  if ((t.match(/\n/gu) ?? []).length > MAX_LINE_BREAKS) throw new DraftRefused("notProse", `the draft has more than ${MAX_LINE_BREAKS} line breaks, and a draft is a few short sentences`);
  // What is checked must be what is written: a character that compatibility folding would change ("½", "¹²", "ｆ")
  // is refused, not folded, as is any digit outside 0-9. Spaces of other widths and the ellipsis are the exceptions.
  const plain = t.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu, " ").replace(/…/gu, "...");
  const changed = [...plain].find((c) => c.normalize("NFKC") !== c);
  if (changed !== undefined) throw new DraftRefused("unreadable", `the draft writes ${q(changed)}, which Caret can't check as written`, changed);
  const odd = /[^\P{N}0-9]/u.exec(plain);
  if (odd !== null) throw new DraftRefused("unreadable", `the draft writes a number as ${q(odd[0])}, which Caret can't check`, odd[0]);
}

/**
 * The checks code decides. Throws DraftRefused naming the first word that fails; returns the facts it read, for the
 * record.
 */
export function checkDraftText(text: string, basis: DraftBasis): Fact[] {
  shape(text);
  const t = folded(text);
  const claim = RECIPIENT_CLAIM.exec(t);
  if (claim !== null) throw new DraftRefused("recipientClaim", `the draft says ${q(claim[0])}, and Caret doesn't add people or files to a message`, claim[0]);
  const neg = NEGATION.exec(t);
  if (neg !== null && !NEGATION.test(folded(basis.instruction))) throw new DraftRefused("negation", `the draft says ${q(neg[0])}, and your instruction doesn't say no to anything`, neg[0]);
  const facts = factsIn(t);
  const known = basisFacts(basis);
  for (const f of facts) {
    const ok = f.kind === "name" ? nameIn(basis, f.norm) : known.some((k) => covers(k.fact, f));
    if (!ok) throw new DraftRefused("newFact", `the draft says ${q(f.text)}, which isn't in your instruction or the windows Caret read`, f.text);
    // An amount is a fact about something on screen: the user's word alone does not put it in a message.
    if (f.kind === "money" && !known.some((k) => k.from !== "instruction" && covers(k.fact, f))) throw new DraftRefused("money", `the draft says ${q(f.text)}, and no window Caret read shows that amount`, f.text);
  }
  // A time, date or amount the instruction states that the windows contradict: Caret does not pick one for the user.
  for (const kind of ["time", "date", "money"] as const) {
    if (!facts.some((f) => f.kind === kind)) continue;
    const said = known.filter((k) => k.from === "instruction" && k.fact.kind === kind);
    const shown = known.filter((k) => k.from === "window" && k.fact.kind === kind);
    const odd = said.find((s) => !shown.some((w) => covers(w.fact, s.fact)));
    const other = shown[0];
    if (odd !== undefined && other !== undefined) {
      throw new DraftRefused("conflict", `you said ${q(odd.fact.text)} and '${other.title ?? "the window"}' says ${q(other.fact.text)}, so Caret didn't write that part. Write it yourself`, odd.fact.text);
    }
  }
  return facts;
}

// MARK: - fields

/**
 * A label as the field rules read it: lower case, marks and separators as spaces. Words in parentheses stay, so
 * "Recipients (Bcc)" still says Bcc; "(optional)" and "(required)" are read as such by the rules below.
 */
const labelWords = (label: string): string =>
  folded(label)
    .toLowerCase()
    .replace(/[()[\]*:✱∗_\-–—/.,]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

/**
 * Whether a field says who a message goes to, by its label: "copy" (Cc, Bcc, carbon copy, copy to) or "to" (a label
 * that starts with "to", or names recipients, an addressee, send to, reply-to, forward to). Every goal write, drafted
 * or copied, is checked; lowering also reads an email field in a window with a Send button as "to".
 */
export function recipientField(label: string): "to" | "copy" | null {
  const l = labelWords(label);
  if (/\bb?cc\b|\b(?:carbon|blind)(?: carbon)? ?copy\b|\bcopy to\b/u.test(l)) return "copy";
  if (l === "to" || l.startsWith("to ") || /\b(?:recipients?|addressees?|send to|reply to|forward to|mail to|email to|deliver to)\b/u.test(l)) return "to";
  return null;
}

/** A subject line, which a goal never writes. */
export const subjectField = (label: string): boolean => /^(?:(?:(?:email|message|mail) )?subject(?: line)?|re|title of (?:the )?(?:email|message|mail))(?: (?:optional|required))?$/u.test(labelWords(label));

/** A message title with its "Re:", "Fwd:" and kin taken off, for matching a reply to the message it answers. */
export const baseSubject = (title: string): string => {
  let t = folded(title).trim();
  for (let prev = ""; prev !== t; ) (prev = t), (t = t.replace(/^(?:re|aw|sv|fwd?|fw)\s*:\s*/iu, ""));
  return t.toLowerCase();
};

const HEADER_LINE = /^\s*(from|to|cc|bcc|subject|date|sent|reply-to)\s*:\s*(.*)$/iu;

/** A message's header block: its leading header lines only, up to the first line that is not one. */
export function messageHeader(text: string): { from: string[]; subject: string | null } {
  const from: string[] = [];
  let subject: string | null = null;
  for (const line of text.split("\n")) {
    const m = HEADER_LINE.exec(folded(line));
    if (m === null) break;
    const name = (m[1] ?? "").toLowerCase();
    if (name === "from") from.push(m[2] ?? "");
    else if (name === "subject" && subject === null) subject = m[2] ?? "";
  }
  return { from, subject };
}

/**
 * Whether `address` is the sender of the message the window titled `reply` answers: the reply's title is "Re: " and
 * the message's title or its header's subject, and the address is on the header's From line. `message` is the
 * window's static text alone (inventory.ts basisText), so a toolbar's buttons before the header do not hide it. Reply-To, Sender and a
 * subject or From line in the body do not count. A To field takes only this address, checked again before writing.
 */
export function senderOf(reply: string, source: { title: string; message: string }, address: string): boolean {
  if (!/^\s*re\s*:/iu.test(folded(reply)) || !address.includes("@")) return false;
  const base = baseSubject(reply);
  const header = messageHeader(source.message);
  if (base === "" || !(baseSubject(source.title) === base || (header.subject !== null && baseSubject(header.subject) === base))) return false;
  const want = address.trim().toLowerCase();
  return header.from.some((l) => (l.match(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu) ?? []).some((a) => a.toLowerCase() === want));
}

/**
 * An instruction that asks Caret to add someone to a message: cc, bcc, loop in, copy in, forward, add to the thread.
 * An open list, so the field rule (recipientField) is what holds: a goal never writes a Cc field, and a To field only
 * with the sender's address. This catches the request before any plan is made, so nothing else is done halfway.
 */
const ADDS_RECIPIENT = /\b(?:b?cc(?:['’]?(?:d|ing))?|carbon[- ]copy)\b|\b(?:loop|copy|looping|copying)\s+(?:\S+\s+){0,3}?in\b|\bforward(?:ing)?\s+(?:it|this|that|the\s+\w+)\s+to\b|\badd(?:ing)?\s+(?:\S+\s+){1,4}?(?:to|on)\s+(?:the|this|my)\s+(?:thread|email|mail|reply|chain|message|conversation)\b|\binclude\s+(?:\S+\s+){1,4}?(?:on|in)\s+(?:the|this|my)\s+(?:thread|email|reply|chain|message)\b/iu;
export const addsRecipient = (instruction: string): boolean => ADDS_RECIPIENT.test(folded(instruction));

// MARK: - the claims Jev checks

/** The draft's sentences, split at sentence ends and line breaks. */
export function sentencesOf(text: string): string[] {
  return folded(text)
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Bare greetings, thanks and sign-offs, matched as whole phrases at a sentence's start. */
const OPENER = /^(?:good (?:morning|afternoon|evening)|thank you so much|thanks so much|thank you|many thanks|thanks again|best regards|kind regards|talk soon|thanks|hello|hey|dear|hi|best|regards|cheers|warmly|sincerely)(?![\p{L}\p{N}'’])/iu;
/** A name as a greeting or sign-off holds it: up to three capitalized words, case-sensitive. */
const NAME_ONLY = /^\p{Lu}[\p{L}\p{M}'’-]*(?: \p{Lu}[\p{L}\p{M}'’-]*){0,2}$/u;

/**
 * A sentence with nothing to confirm: a bare greeting, thanks or sign-off, optionally with a name; or a name alone. The
 * name must be capitalized words the basis shows and not a STARTERS word ("Yes"); anything else after the opener
 * ("Thanks, I'll pay") is a claim.
 */
export function noClaim(s: string, basis: DraftBasis): boolean {
  const t = folded(s).trim();
  const opener = OPENER.exec(t);
  const rest = (opener === null ? t : t.slice(opener[0].length)).replace(/^[\s,.!]+|[\s,.!]+$/gu, "");
  if (rest === "") return opener !== null;
  const first = (rest.split(" ")[0] ?? "").toLowerCase();
  return NAME_ONLY.test(rest) && !STARTERS.has(first) && nameIn(basis, wordsOf(rest));
}

// MARK: - restatements

/** Contractions written out, so "I'm" is "i am" and "can't" holds "not" on both sides. */
const CONTRACTIONS: readonly [RegExp, string][] = [
  [/\bwon't\b/gu, "will not"],
  [/\bshan't\b/gu, "shall not"],
  [/\bcan't\b|\bcannot\b/gu, "can not"],
  [/n't\b/gu, " not"],
  [/'m\b/gu, " am"],
  [/'re\b/gu, " are"],
  [/'ll\b/gu, " will"],
  [/'ve\b/gu, " have"],
  [/'d\b/gu, " would"],
  [/'s\b/gu, ""],
];
/** Words a restatement may add or leave out: articles and "please". Pronouns, prepositions and "not" are content. */
const FILLER = new Set(["a", "an", "the", "please"]);
/**
 * Words that change what a clause of the instruction means: a negation, a condition or a turn ("do not send", "if it
 * works", "in or out"). A sentence of the instruction with one of these in any other clause than the restated words'
 * gives no restatement. An open list, on the fail-open side; FRAME below is the closed rule that does the work.
 */
const TURNS = new Set(["not", "no", "never", "nor", "neither", "without", "unless", "if", "except", "only", "when", "whenever", "once", "until", "after", "before", "instead", "rather", "whether", "or", "but", "maybe", "might", "probably", "avoid", "stop", "refuse", "dont", "cant", "wont", "didnt", "doesnt", "isnt"]);

/**
 * Words that open what the user asks Caret to say ("saying I'm in", "tell her I'll be there", "a reply that I paid").
 * Closed on purpose: restated words after anything else are left to Jev.
 */
const SAYING = new Set(["say", "saying", "tell", "telling", "reply", "replying", "respond", "responding", "answer", "answering", "write", "writing", "with", "that"]);
/** Whom a saying word may name before what is said: "tell her I'm in" (a name the instruction gives, too). */
const ADDRESSEE = new Set(["her", "him", "them", "me", "us", "you", "everyone", "everybody", "all"]);
/**
 * The only words that may stand before restated words in their clause, besides names: asking for a message and whom
 * it goes to ("draft a reply to Priya saying", "write her a short note that"). Closed on purpose: "avoid saying",
 * "I deny that" and "never make this promise" are not a request to say what follows, so they go to Jev.
 */
const FRAME = new Set([...SAYING, ...ADDRESSEE, "draft", "compose", "send", "rsvp", "response", "message", "email", "mail", "note", "text", "short", "quick", "brief", "back", "to", "for", "confirmation"]);
/**
 * Words another clause of the restated words' sentence may open with: a request for another step of the goal ("copy
 * her address into To and draft ..."). Closed on purpose: a clause that opens any other way ("provided you refund me",
 * "assuming it works") may qualify what is said, so the sentence goes to Jev.
 */
const STEP_VERBS = new Set(["copy", "add", "put", "fill", "paste", "enter", "type", "insert", "use", "take", "draft", "write", "compose", "reply", "answer", "respond", "tell", "say", "address", "schedule", "create", "book", "set", "leave", "open"]);
/** Words that make a request conditional wherever they stand in the instruction: none of its sentences restates then. */
const CONDITIONS = new Set(["if", "unless", "provided", "providing", "assuming", "only", "when", "whenever", "once", "until", "otherwise", "except", "suppose", "supposing", "whether", "after", "before", "later"]);

/** A text's content words in order: folded, contractions written out, filler dropped; `w` lower case, `cased` as written. */
function contentWords(t: string): { w: string; cased: string }[] {
  let s = folded(t).replace(/[’‘]/gu, "'");
  for (const [re, to] of CONTRACTIONS) s = s.replace(new RegExp(re.source, "giu"), to);
  return (s.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? []).map((x) => ({ w: x.toLowerCase(), cased: x })).filter((x) => !FILLER.has(x.w));
}

/**
 * The instruction's sentences, each cut into clauses at commas and at "and", "then" and "also". Neither cut is made
 * inside double quotes, so a quoted reply stays whole with what asks for it; with unbalanced quotes the whole
 * instruction is one clause.
 */
function clausesOf(instruction: string): string[][] {
  const t = folded(instruction).replace(/[“”]/gu, '"');
  if ((t.match(/"/gu) ?? []).length % 2 !== 0) return [[t.replace(/"/gu, " ")]];
  const sentences: string[][] = [];
  let clause = "";
  let clauses: string[] = [];
  let quoted = false;
  const endClause = (): void => {
    if (clause.trim() !== "") clauses.push(clause);
    clause = "";
  };
  for (let i = 0; i < t.length; i++) {
    const c = t[i] as string;
    if (c === '"') {
      quoted = !quoted;
      clause += " ";
      continue;
    }
    if (!quoted && /[.!?;\n]/u.test(c)) {
      endClause();
      if (clauses.length > 0) sentences.push(clauses);
      clauses = [];
      continue;
    }
    if (!quoted && c === ",") {
      endClause();
      continue;
    }
    const joiner = quoted ? null : /^\s(?:and|then|also)\s/iu.exec(t.slice(i));
    if (joiner !== null) {
      endClause();
      i += joiner[0].length - 2;
      continue;
    }
    clause += c;
  }
  endClause();
  if (clauses.length > 0) sentences.push(clauses);
  return sentences;
}

/**
 * Whether a draft sentence only restates the user's instruction (G2 lead decision 3). After a greeting and a name the
 * basis shows are set aside, its content words must be the last words of one clause of the instruction, in the same
 * order with nothing between them. Before them in that clause stand only FRAME words and names the instruction gives
 * (never its clause's first word), with a SAYING word, or one and an addressee, right before them. No other clause of
 * that sentence holds a TURNS word. Such a sentence says what the user asked Caret to say, so Jev is not asked to
 * confirm it; drafts.ts's fact checks still run.
 *
 * Order, the clause's end and the closed FRAME are the rule because a set of the instruction's words can recombine
 * into a claim the user did not make ("Friday works" from "I can't do Friday but Monday works"), and B30's reviews
 * found every token allowlist of this kind failing open. G2's review found suffixes after "Avoid saying", "I deny
 * that" and a quoted example passing an earlier version that allowed any words before a saying word.
 */
export function restates(sentence: string, instruction: string, basis: DraftBasis): boolean {
  let t = folded(sentence).trim();
  const opener = OPENER.exec(t);
  if (opener !== null) t = t.slice(opener[0].length);
  // A name the basis shows, as the person addressed: "Priya, I'm in." and "I'm in, Priya!"
  const vocative = (name: string): boolean => NAME_ONLY.test(name) && !STARTERS.has((name.split(" ")[0] ?? "").toLowerCase()) && nameIn(basis, wordsOf(name));
  t = t.replace(/^[\s,.!]+/u, "");
  const lead = /^([^,]+),\s*/u.exec(t);
  if (lead !== null && vocative((lead[1] ?? "").trim())) t = t.slice(lead[0].length);
  const tail = /,\s*([^,]+?)[\s.!?]*$/u.exec(t);
  if (tail !== null && vocative((tail[1] ?? "").trim())) t = t.slice(0, tail.index);
  const said = contentWords(t).map((x) => x.w);
  if (said.length === 0) return false;
  // Inside quotes the user wrote the reply itself: only the whole quote is a restatement of it. Its own first words
  // are what is asked to be said ('saying "Tell her I'll pay"' asks to say all of that, not "I'll pay").
  for (const q of folded(instruction).replace(/[“”]/gu, '"').match(/"[^"]*"/gu) ?? []) {
    const quoted = contentWords(q).map((x) => x.w);
    const inside = quoted.some((_, i) => said.every((w, j) => quoted[i + j] === w));
    if (inside && quoted.length !== said.length) return false;
  }
  const sentences = clausesOf(instruction);
  if (sentences.some((clauses) => clauses.some((c) => contentWords(c).some((x) => CONDITIONS.has(x.w))))) return false;
  for (const clauses of sentences) {
    const words = clauses.map(contentWords);
    for (const [k, clause] of words.entries()) {
      const at = clause.length - said.length;
      if (at < 1 || said.some((w, i) => clause[at + i]?.w !== w)) continue;
      // Every other clause of the sentence asks for another step and turns nothing.
      if (words.some((other, j) => j !== k && (!STEP_VERBS.has(other[0]?.w ?? "") || other.some((x) => TURNS.has(x.w))))) continue;
      const before = clause.slice(0, at);
      if (before.some((x) => TURNS.has(x.w))) continue;
      // A name: a capitalized word, not all capitals, that is not the first of its clause ("Avoid saying ..." and
      // "NOT saying ..." name no one).
      const name = (x: { cased: string }, i: number): boolean => i > 0 && /^\p{Lu}\p{Ll}/u.test(x.cased);
      if (!before.every((x, i) => FRAME.has(x.w) || name(x, i))) continue;
      const last = before[at - 1] as { w: string; cased: string };
      const addressee = ADDRESSEE.has(last.w) || name(last, at - 1);
      if (SAYING.has(last.w) || (addressee && SAYING.has(before[at - 2]?.w ?? ""))) return true;
    }
  }
  return false;
}

/** Verbs that put something on a calendar. */
const EVENT_VERBS = new Set(["add", "put", "schedule", "book", "create", "set", "block", "save", "make", "note"]);
/** Words for what such a verb puts there: each singular one an event, a plural or "both" at least two. */
const EVENT_ONE = new Set(["meeting", "event", "appointment", "call", "session", "invite", "invitation"]);
const EVENT_MANY = new Set(["meetings", "events", "appointments", "calls", "sessions", "invites", "invitations", "both"]);
/** Negations that cancel a clause's request ("do not put it on my calendar"). */
const NEGATIONS = new Set(["not", "no", "never", "nor", "neither", "without", "dont", "avoid", "stop", "refuse", "skip"]);
/** Conditions that make a sentence's request wait on something; "after" and "before" may only say when an event is. */
const EVENT_CONDITIONS = new Set([...CONDITIONS].filter((w) => w !== "after" && w !== "before" && w !== "later"));

/**
 * How many calendar events the instruction asks for, at least (G2); 0 when it asks for none. A sentence asks when a
 * clause of it holds a verb that puts something on a calendar, its clauses without a negation are read together
 * ("add the Priya meeting and the Morgan meeting to my calendar"), and it has no condition. It asks for as many
 * events as it names singly, at least two for a plural or "both", and one when it names only the calendar. A goal
 * whose plan adds fewer is not done (lower.ts, runs.ts). Word lists, not measured: a request they miss leaves the goal
 * as it was before G2, and one they misread makes it partial, never done.
 */
export function eventsAsked(instruction: string): number {
  let n = 0;
  for (const clauses of clausesOf(instruction)) {
    const words = clauses.map(contentWords);
    if (words.some((c) => c.some((x) => EVENT_CONDITIONS.has(x.w)))) continue;
    const positive = words.filter((c) => !c.some((x) => NEGATIONS.has(x.w)));
    if (!positive.some((c) => c.some((x) => EVENT_VERBS.has(x.w)))) continue;
    const all = positive.flat();
    const one = all.filter((x) => EVENT_ONE.has(x.w)).length;
    const many = all.some((x) => EVENT_MANY.has(x.w)) ? 2 : 0;
    const calendar = all.some((x) => x.w === "calendar") ? 1 : 0;
    n += Math.max(one, many, calendar);
  }
  return n;
}

const CONFIRM_WORDS = [
  (d: Disclosure, instr: ModelText, s: ModelText): ModelText => d.t`The user asked: "${instr}". Caret drafted this sentence for the user to send: "${s}". Does the sentence say only what the user asked to say, with no promise, commitment, refusal, apology, date or condition the user did not ask for?`,
  (d: Disclosure, instr: ModelText, s: ModelText): ModelText => d.t`Sentence Caret drafted: "${s}". The user's request: "${instr}". Is every promise, commitment, refusal, date and condition in this sentence one the user asked for?`,
] as const;

/**
 * Asks Jev, twice in different words, whether each sentence of each draft that is not a bare greeting, thanks or
 * sign-off says only what the instruction asks. Throws DraftRefused naming the first sentence both asks do not
 * confirm at NOUL_FLOOR, or when Jev is not there or fails (refused on doubt). `snippets` are the ledger's
 * declarations; a request carries those its text holds.
 */
export async function confirmClaims(instruction: string, drafts: readonly { text: string; basis: DraftBasis }[], askJev: AskJev | null, snippets: readonly Snippet[]): Promise<{ calls: number; costUsd: number }> {
  const claims = [...new Set(drafts.flatMap((d) => sentencesOf(d.text).filter((s) => !noClaim(s, d.basis) && !restates(s, instruction, d.basis))))];
  if (claims.length === 0) return { calls: 0, costUsd: 0 };
  if (askJev === null) throw new DraftRefused("unchecked", `Caret can't check the draft's sentence ${q(claims[0] as string)} right now`, claims[0] as string);
  // The claims are the local model's draft (MintReason drafted); what they carry of windows is declared by `snippets`.
  const d = new Disclosure([]);
  const safeInstruction = d.instruction(instruction);
  const minted: ModelText[] = [];
  for (const s of claims) {
    const m = d.draftedText(s);
    if (m === null) throw new DraftRefused("unchecked", `Caret can't check the draft's sentence ${q(s)} within what one request may carry`, s);
    minted.push(m);
  }
  const req = (wording: 0 | 1): JevRequest => {
    const nouls = Object.fromEntries(minted.map((s, i) => [`c${i + 1}`, { type: "noul" as const, instructions: CONFIRM_WORDS[wording](d, safeInstruction, s) }]));
    const sent = JSON.stringify([safeInstruction, nouls]);
    const carried = snippets.filter((x) => sent.includes(x.text));
    const charged: Record<string, number> = {};
    for (const x of carried) charged[x.windowId] = (charged[x.windowId] ?? 0) + x.text.length;
    return d.seal({ purpose: "draft.check", state: { instruction: safeInstruction, task: d.own("Caret checks that a short text it drafted for the user adds nothing the user did not ask to say.") }, questions: {}, nouls, snippets: carried, charged });
  };
  let r: Awaited<ReturnType<AskJev>>[];
  try {
    r = await Promise.all([askJev(req(0)), askJev(req(1))]);
  } catch (e) {
    throw new DraftRefused("unchecked", `Caret couldn't check the draft just now`, e instanceof Error ? e.message.slice(0, 200) : String(e));
  }
  claims.forEach((s, i) => {
    const yes = Math.min(r[0]?.nouls?.[`c${i + 1}`] ?? 0, r[1]?.nouls?.[`c${i + 1}`] ?? 0);
    if (!(yes >= NOUL_FLOOR)) throw new DraftRefused("claim", `Caret couldn't confirm you asked to say ${q(s)}`, s);
  });
  return { calls: 2, costUsd: (r[0]?.costUsd ?? 0) + (r[1]?.costUsd ?? 0) };
}
