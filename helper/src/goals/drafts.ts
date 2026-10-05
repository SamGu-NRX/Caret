// Text a goal plan writes in Caret's own words (B30): a short reply, message or description. The writer composes it;
// code decides whether it may be offered. A draft must add no fact: every number, date, time, money amount, email
// address, phone, URL, code and name in it must be one the instruction, a window the plan names as the draft's
// basis, or a memory value the plan uses already states. Code reads facts as typed things, not as loose tokens, so a
// draft cannot recombine allowed pieces into a new fact: "October 3" is not covered by "October 8 at 3:00 PM", and
// "3 friends" is not covered by "3:00 PM". Anything else refuses the draft and names the word.
//
// Beyond facts, in code: at most DRAFT_MAX_CHARS characters of plain sentences; no negation the instruction does not
// contain; no claim to have copied someone in or attached something; money only as a window or memory shows it; and
// no time, date or amount at all when the instruction states one that the windows contradict ("tell her 4" when the
// invite says 3). Commitments and promises are not code-decidable, so every sentence that is not a bare greeting,
// thanks or sign-off goes to Jev as a yes/no question (confirmClaims), asked twice, and a sentence both asks do not
// confirm at NOUL_FLOOR refuses the draft. With no Jev, such a draft is refused.
//
// Known gaps, all on the fail-open side and backed only by the Jev check: a name written in lower case is not read as
// a name; a commitment with no fact in it ("I'll handle it") is Jev's alone to judge.
import type { AskJev, JevRequest } from "../fill/jev.ts";
import { NOUL_FLOOR } from "../planner/intent-makers.ts";
import type { Snippet } from "../privacy.ts";

/** Longest draft, in characters (code points). The brief's limit (B30). */
export const DRAFT_MAX_CHARS = 600;
/** Line breaks a draft may have: a greeting, a few short paragraphs and a sign-off. Assumed, not measured. */
const MAX_LINE_BREAKS = 6;

export type DraftWhy = "empty" | "tooLong" | "notProse" | "field" | "newFact" | "money" | "conflict" | "negation" | "recipientClaim" | "claim" | "unchecked";

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

export type Fact =
  | { kind: "email" | "url" | "phone" | "code"; text: string; norm: string }
  | { kind: "money"; text: string; amount: number; currency: string | null }
  | { kind: "time"; text: string; h: number; m: number; mer: "am" | "pm" | null }
  | { kind: "date"; text: string; weekday: number | null; month: number | null; day: number | null; year: number | null; rel: string | null }
  | { kind: "number"; text: string; value: number }
  | { kind: "name"; text: string; norm: string };

const MONTHS: Record<string, number> = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
const WEEKDAYS: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const UNITS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, dozen: 12, twice: 2 };
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };
const NUMBER_WORD = [...Object.keys(UNITS), ...Object.keys(ORDINALS), ...Object.keys(SCALES)].join("|");
const HOUR_WORD = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";
const CURRENCY: Record<string, string> = { $: "usd", dollar: "usd", dollars: "usd", usd: "usd", bucks: "usd", "€": "eur", euro: "eur", euros: "eur", eur: "eur", "£": "gbp", pound: "gbp", pounds: "gbp", gbp: "gbp", "¥": "jpy", yen: "jpy" };
const MULT: Record<string, number> = { k: 1000, thousand: 1000, m: 1_000_000, million: 1_000_000 };

const MONTH_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const WEEKDAY_RE = "sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?";

const wordValue = (phrase: string): number => {
  let total = 0;
  let cur = 0;
  for (const w of phrase.toLowerCase().split(/[\s-]+/u).filter((x) => x !== "" && x !== "and" && x !== "a")) {
    if (w in SCALES) cur = (cur === 0 ? 1 : cur) * (SCALES[w] as number);
    else cur += UNITS[w] ?? ORDINALS[w] ?? 0;
    if (w === "thousand" || w === "million") {
      total += cur;
      cur = 0;
    }
  }
  return total + cur;
};
const hourOf = (s: string): number => (/^\d+$/u.test(s) ? Number(s) : wordValue(s));
const merOf = (s: string | undefined): "am" | "pm" | null => (s === undefined ? null : /^a/iu.test(s) ? "am" : "pm");
/** A time as a 12-hour clock reads it: 15:00 is 3:00 pm. */
function clock(h: number, m: number, mer: "am" | "pm" | null): { h: number; m: number; mer: "am" | "pm" | null } {
  if (mer === null && h >= 13 && h <= 23) return { h: h - 12, m, mer: "pm" };
  if (mer === null && h === 0) return { h: 12, m, mer: "am" };
  return { h, m, mer };
}
const digitsOf = (s: string): string => s.replace(/\D/gu, "");
function dateWord(m: RegExpExecArray): Fact {
  const w = (m[1] ?? "").toLowerCase().replace(/\.$/u, "");
  return { kind: "date", text: m[0], weekday: WEEKDAYS[w] ?? null, month: WEEKDAYS[w] === undefined ? (MONTHS[w] ?? null) : null, day: null, year: null, rel: null };
}
/** A sentence's period after "PM" is the sentence's, not the time's ("p.m." keeps its own). */
const timeText = (t: string): string => (/[ap]m\.$/iu.test(t) && !/[ap]\.m\.$/iu.test(t) ? t.slice(0, -1) : t);
const urlNorm = (s: string): string => s.toLowerCase().replace(/^https?:\/\//u, "").replace(/^www\./u, "").replace(/[/.,;:!?)]+$/u, "");

interface Rule {
  re: RegExp;
  make: (m: RegExpExecArray) => Fact | Fact[] | null;
}

const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
/** Rules in the order they claim text: a span one rule claims is not read again by a later one. */
const RULES: readonly Rule[] = [
  { re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, make: (m) => ({ kind: "email", text: m[0], norm: m[0].toLowerCase() }) },
  { re: /\bhttps?:\/\/[^\s<>()"]+|\bwww\.[^\s<>()"]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|co|edu|gov|example|ai|us|uk|ly|me)\b(?:\/[^\s<>()"]*)?/giu, make: (m) => ({ kind: "url", text: m[0].replace(/[.,;:!?)]+$/u, ""), norm: urlNorm(m[0]) }) },
  // Dates: a weekday, a month and a day, and a year, each when written; then numeric dates.
  {
    re: new RegExp(`${B}(?:(${WEEKDAY_RE})\\.?,?\\s+)?(?:the\\s+)?(?:(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?|(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\.?)(?:,?\\s+(\\d{4}))?${E}`, "giu"),
    make: (m) => ({ kind: "date", text: m[0], weekday: m[1] === undefined ? null : (WEEKDAYS[m[1].toLowerCase()] ?? null), month: MONTHS[(m[2] ?? m[5] ?? "").toLowerCase()] ?? null, day: Number(m[3] ?? m[4]), year: m[6] === undefined ? null : Number(m[6]), rel: null }),
  },
  { re: new RegExp(`${B}(\\d{4})-(\\d{1,2})-(\\d{1,2})${E}`, "gu"), make: (m) => ({ kind: "date", text: m[0], weekday: null, month: Number(m[2]), day: Number(m[3]), year: Number(m[1]), rel: null }) },
  { re: new RegExp(`${B}(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?${E}`, "gu"), make: (m) => ({ kind: "date", text: m[0], weekday: null, month: Number(m[1]), day: Number(m[2]), year: m[3] === undefined ? null : Number(m[3].length === 2 ? `20${m[3]}` : m[3]), rel: null }) },
  // Money: a currency sign or word with an amount.
  {
    re: new RegExp(`([$€£¥])\\s?(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?(?:\\s?(k|m|thousand|million)${E})?`, "giu"),
    make: (m) => ({ kind: "money", text: m[0], amount: (Number((m[2] ?? "").replace(/,/gu, "")) + Number(`0.${m[3] ?? "0"}`)) * (MULT[(m[4] ?? "").toLowerCase()] ?? 1), currency: CURRENCY[m[1] ?? ""] ?? null }),
  },
  {
    re: new RegExp(`${B}(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?\\s?(k|thousand|million)?\\s?(dollars?|usd|bucks|euros?|eur|pounds?|gbp|yen)${E}`, "giu"),
    make: (m) => ({ kind: "money", text: m[0], amount: (Number((m[1] ?? "").replace(/,/gu, "")) + Number(`0.${m[2] ?? "0"}`)) * (MULT[(m[3] ?? "").toLowerCase()] ?? 1), currency: CURRENCY[(m[4] ?? "").toLowerCase()] ?? null }),
  },
  {
    re: new RegExp(`${B}((?:(?:${NUMBER_WORD})[\\s-]+(?:and\\s+)?)*(?:${NUMBER_WORD}))\\s+(dollars?|bucks|euros?|pounds?)${E}`, "giu"),
    make: (m) => ({ kind: "money", text: m[0], amount: wordValue(m[1] ?? ""), currency: CURRENCY[(m[2] ?? "").toLowerCase()] ?? null }),
  },
  // Times: with am or pm, with minutes, or an hour after a word that sets a time ("at 4", "by five").
  { re: new RegExp(`${B}(\\d{1,2}|${HOUR_WORD})(?::(\\d{2}))?\\s?(a\\.?m\\.?|p\\.?m\\.?)(?![\\p{L}])`, "giu"), make: (m) => ({ kind: "time", text: timeText(m[0]), ...clock(hourOf((m[1] ?? "").toLowerCase()), Number(m[2] ?? 0), merOf(m[3])) }) },
  { re: new RegExp(`${B}(\\d{1,2}):(\\d{2})${E}`, "gu"), make: (m) => ({ kind: "time", text: m[0], ...clock(Number(m[1]), Number(m[2]), null) }) },
  { re: new RegExp(`${B}(\\d{1,2}|${HOUR_WORD})\\s*o['’]?clock${E}`, "giu"), make: (m) => ({ kind: "time", text: m[0], ...clock(hourOf((m[1] ?? "").toLowerCase()), 0, null) }) },
  { re: new RegExp(`${B}(?:at|by|around|until|till|til|from|before|after|past)\\s+(\\d{1,2}|${HOUR_WORD})(?![\\p{L}\\p{N}:/]|[.,]\\d|\\s*(?:%|percent|people|guests|of|more|minutes?|hours?|days?|weeks?))`, "giu"), make: (m) => ({ kind: "time", text: m[0], ...clock(hourOf((m[1] ?? "").toLowerCase()), 0, null) }) },
  { re: /\b(noon|midday|midnight)\b/giu, make: (m) => ({ kind: "time", text: m[0], h: 12, m: 0, mer: /night/iu.test(m[0]) ? "am" : "pm" }) },
  // Phones: seven or more digits with separators, not inside a code.
  { re: /(?<![\p{L}\p{N}-])\+?\(?\d[\d\s().-]{5,}\d(?![\p{L}\p{N}-])/gu, make: (m) => (digitsOf(m[0]).length >= 7 && /[\s().-]/u.test(m[0].trim()) ? { kind: "phone", text: m[0].trim(), norm: digitsOf(m[0]) } : null) },
  // Ordinals and codes: "8th", "ORD-2026-48213", "A12".
  { re: /\b(\d{1,3})(?:st|nd|rd|th)\b/giu, make: (m) => ({ kind: "number", text: m[0], value: Number(m[1]) }) },
  { re: /#?(?<![\p{L}\p{N}])(?=[\p{L}\p{N}_./-]*\p{N})[\p{L}\p{N}]+(?:[-_./][\p{L}\p{N}]+)+(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?=\p{L}*\p{N})(?=\p{N}*\p{L})[\p{L}\p{N}]{2,}(?![\p{L}\p{N}])/gu, make: (m) => ({ kind: "code", text: m[0], norm: m[0].toLowerCase().replace(/^#/u, "") }) },
  // Every other run of digits is a number.
  { re: /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/gu, make: (m) => ({ kind: "number", text: m[0], value: Number(m[0].replace(/,/gu, "")) }) },
  { re: new RegExp(`${B}((?:(?:${NUMBER_WORD})[\\s-]+(?:and\\s+)?)*(?:${NUMBER_WORD}))${E}`, "giu"), make: (m) => ({ kind: "number", text: m[0], value: wordValue(m[0]) }) },
  // Dates in words: weekdays and months alone, in any case; "May", "March" and the short forms only capitalized.
  { re: /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|january|february|april|june|july|august|september|october|november|december)\b/giu, make: (m) => dateWord(m) },
  { re: new RegExp(`${B}(May|March|(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?)${E}`, "gu"), make: (m) => dateWord(m) },
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
  "a about absolutely after again agreed all also although an and any anything apologies appreciate are as ask at awesome back because before best both but by call can cheers could count dear feel give keep reach tell definitely did do does done each either even every everything excellent for from glad good got great had happy has have hello here hey hi how however i if in is it it's its just kind let let's looking many more most much my no noted now of oh ok okay on or our perfect please quick really received regards see should since so some sorry sounds still sure talk thank thanks that that's the their then there these they this those though to totally understood until very we we'll we're well were what when where which while who why with wonderful would yes yeah yep you you're your".split(" "),
);
const FIRST_PERSON = /^I(?:['’](?:m|ll|d|ve))?$/u;

/** Every fact `text` states, in order. */
export function factsIn(text: string): Fact[] {
  const taken = new Array<boolean>(text.length).fill(false);
  const found: { at: number; fact: Fact }[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (m[0] === "" || taken.slice(start, end).some(Boolean)) continue;
      const made = rule.make(m as RegExpExecArray);
      if (made === null) continue;
      for (const f of Array.isArray(made) ? made : [made]) found.push({ at: start, fact: f });
      taken.fill(true, start, end);
    }
  }
  // Names: runs of capitalized words, one space apart, in what no rule claimed. A STARTERS word, "I" and "OK" are
  // not names, wherever they stand.
  let run: { at: number; words: string[]; end: number } | null = null;
  const flush = (): void => {
    if (run === null) return;
    const phrase = run.words.join(" ").replace(/['’]s$/u, "");
    found.push({ at: run.at, fact: { kind: "name", text: phrase, norm: wordsOf(phrase) } });
    run = null;
  };
  for (const m of text.matchAll(/[\p{Lu}][\p{L}'’-]*/gu)) {
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
  s
    .toLowerCase()
    .replace(/['’]s\b/gu, "")
    .replace(/[^\p{L}\p{N}'’]+/gu, " ")
    .trim();

/** Whether corpus fact `c` states everything fact `f` states. */
export function covers(c: Fact, f: Fact): boolean {
  if (c.kind !== f.kind) return false;
  switch (f.kind) {
    case "email":
    case "url":
    case "phone":
    case "code":
      return (c as typeof f).norm === f.norm;
    case "name":
      return (c as typeof f).norm === f.norm;
    case "number":
      return (c as typeof f).value === f.value;
    case "money": {
      const x = c as typeof f;
      return Math.abs(x.amount - f.amount) < 0.005 && (f.currency === null || x.currency === null || x.currency === f.currency);
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

/** What a draft may take facts from: the instruction, each window the plan names as its basis, and memory it uses. */
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
  const all = [b.instruction, ...b.windows.flatMap((w) => [w.title, w.text]), ...b.memory].map((t) => ` ${wordsOf(t)} `);
  return all.some((t) => t.includes(` ${norm} `));
}

// MARK: - the checks code can decide

const NEGATION = /\b(?:not|no|never|none|nobody|nothing|nowhere|neither|nor|cannot|unable|decline|declining|unfortunately|without)\b|\b\p{L}+n['’]t\b/iu;
/** Words that claim Caret added someone or something to the message, which a draft never does. */
const RECIPIENT_CLAIM = /\b(?:b?cc(?:['’]?(?:d|ed|ing))?|copying in|copied in|looping in|looped in|fwd|forward(?:ed|ing)?\s+(?:it|this|that|the|your|these|them|him|her)|attach(?:ed|ing|ment|ments)?|enclosed)\b/iu;
/** Markup and placeholders: a draft is plain sentences. */
const NOT_PROSE: readonly [RegExp, string][] = [
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
}

/**
 * The checks code decides. Throws DraftRefused naming the first word that fails; returns the facts it read, by kind,
 * for the record.
 */
export function checkDraftText(text: string, basis: DraftBasis): Fact[] {
  shape(text);
  const claim = RECIPIENT_CLAIM.exec(text);
  if (claim !== null) throw new DraftRefused("recipientClaim", `the draft says ${q(claim[0])}, and Caret doesn't add people or files to a message`, claim[0]);
  const neg = NEGATION.exec(text);
  if (neg !== null && !NEGATION.test(basis.instruction)) throw new DraftRefused("negation", `the draft says ${q(neg[0])}, and your instruction doesn't say no to anything`, neg[0]);
  const facts = factsIn(text);
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

const labelWords = (label: string): string => label.toLowerCase().replace(/[*:✱∗]/gu, " ").replace(/\s+/gu, " ").trim();

/**
 * Whether a field says who a message goes to: "to" (To, Recipients, Send to, Reply-To) or "copy" (Cc, Bcc), by its
 * label. Closed lists; anything else is not a recipient field. Every goal write, drafted or copied, is checked.
 */
export function recipientField(label: string): "to" | "copy" | null {
  const l = labelWords(label);
  if (/\bb?cc\b|\bcc\s*\/\s*bcc\b|^copy to$/u.test(l)) return "copy";
  if (["to", "send to", "reply to", "reply-to", "recipient", "recipients", "add recipients", "mail to", "email to"].includes(l) || /\brecipients?\b/u.test(l)) return "to";
  return null;
}

/** A subject line, which a draft never writes. */
export const subjectField = (label: string): boolean => /^(?:subject|subject line|re|title of (?:the )?(?:email|message))$/u.test(labelWords(label));

/**
 * An instruction that asks Caret to add someone to a message: cc, bcc, loop in, copy in, forward, add to the thread.
 * An open list, so the field rule (recipientField) is what holds: a goal never writes a Cc field, and a To field only
 * with the sender's address. This catches the request before any plan is made, so nothing else is done halfway.
 */
const ADDS_RECIPIENT = /\b(?:b?cc(?:['’]?(?:d|ing))?|carbon[- ]copy)\b|\b(?:loop|copy|looping|copying)\s+(?:\S+\s+){0,3}?in\b|\bforward(?:ing)?\s+(?:it|this|that|the\s+\w+)\s+to\b|\badd(?:ing)?\s+(?:\S+\s+){1,4}?(?:to|on)\s+(?:the|this|my)\s+(?:thread|email|mail|reply|chain|message|conversation)\b|\binclude\s+(?:\S+\s+){1,4}?(?:on|in)\s+(?:the|this|my)\s+(?:thread|email|reply|chain|message)\b/iu;
export const addsRecipient = (instruction: string): boolean => ADDS_RECIPIENT.test(instruction);

// MARK: - the claims Jev checks

/** The draft's sentences, split at sentence ends and line breaks. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

const NAME_WORDS = "(?:[\\p{Lu}][\\p{L}'’-]*(?:\\s+[\\p{Lu}][\\p{L}'’-]*){0,2})";
const GREETING = new RegExp(`^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))(?:\\s+${NAME_WORDS})?[,.!]*$`, "iu");
const THANKS = new RegExp(`^(?:thanks|thank you|thanks so much|thank you so much|many thanks|thanks again)(?:,?\\s+${NAME_WORDS})?[,.!]*$`, "iu");
const SIGN_OFF = new RegExp(`^(?:best|best regards|regards|kind regards|cheers|warmly|sincerely|talk soon)[,.!]*(?:\\s+${NAME_WORDS})?[,.!]*$`, "iu");
const NAME_ONLY = new RegExp(`^${NAME_WORDS}[,.!]?$`, "u");

/**
 * A sentence with nothing to confirm: a greeting, thanks, a sign-off, or a name alone (not a STARTERS word such as
 * "Yes"). The fact check has already read its names.
 */
export function noClaim(s: string): boolean {
  if (GREETING.test(s) || THANKS.test(s) || SIGN_OFF.test(s)) return true;
  return NAME_ONLY.test(s) && !STARTERS.has((s.split(/[\s,.!]/u)[0] ?? "").toLowerCase());
}

const CONFIRM_WORDS = [
  (instr: string, s: string): string => `The user asked: "${instr}". Caret drafted this sentence for the user to send: "${s}". Does the sentence say only what the user asked to say, with no promise, commitment, refusal, apology, date or condition the user did not ask for?`,
  (instr: string, s: string): string => `Sentence Caret drafted: "${s}". The user's request: "${instr}". Is every promise, commitment, refusal, date and condition in this sentence one the user asked for?`,
] as const;

/**
 * Asks Jev, twice in different words, whether each sentence of each draft that is not a bare greeting, thanks or
 * sign-off says only what the instruction asks. Throws DraftRefused naming the first sentence both asks do not
 * confirm at NOUL_FLOOR, or when Jev is not there or fails (refused on doubt). `snippets` are the ledger's
 * declarations; a request carries those its text holds.
 */
export async function confirmClaims(instruction: string, drafts: readonly string[], askJev: AskJev | null, snippets: readonly Snippet[]): Promise<{ calls: number; costUsd: number }> {
  const claims = [...new Set(drafts.flatMap(sentencesOf).filter((s) => !noClaim(s)))];
  if (claims.length === 0) return { calls: 0, costUsd: 0 };
  if (askJev === null) throw new DraftRefused("unchecked", `Caret can't check the draft's sentence ${q(claims[0] as string)} right now`, claims[0] as string);
  const req = (wording: 0 | 1): JevRequest => {
    const nouls = Object.fromEntries(claims.map((s, i) => [`c${i + 1}`, { type: "noul" as const, instructions: CONFIRM_WORDS[wording](instruction, s) }]));
    const sent = JSON.stringify([instruction, nouls]);
    const carried = snippets.filter((x) => sent.includes(x.text));
    const charged: Record<string, number> = {};
    for (const x of carried) charged[x.windowId] = (charged[x.windowId] ?? 0) + x.text.length;
    return { state: { instruction, task: "Caret checks that a short text it drafted for the user adds nothing the user did not ask to say." }, questions: {}, nouls, snippets: carried, charged };
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
