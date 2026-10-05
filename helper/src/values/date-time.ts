// Dates, times and ranges in source text, read by a bounded tokenizer: ISO dates and date-times, locale
// numeric dates, English month and weekday forms, relative days, clock times, ranges and zones. Every
// token must be recognised, so text the parser does not understand is refused instead of half read.
// No Date.parse and no natural-language library: what is uncertain becomes a question.
//
// The rules section 4 leaves to the implementation, each recorded where it applies:
//   - A date with no year is the first one on or after the source's date, this year or next; the
//     assumption is returned with the value.
//   - A clock time with no AM or PM ("3", "3:00", "10:30") asks, unless written in 24-hour form ("15:00",
//     a leading zero as in "09:30", or 0:xx) or a word in the text says which half of the day ("tonight",
//     "morning", "afternoon", "evening"). "noon" is 12:00; "midnight" asks which day it ends.
//   - In a range, an end's AM or PM carries back to a start written without one ("3-4pm"), and when that
//     would put the start after the end, the start takes the other half ("11-1pm" is 11 AM to 1 PM).
//   - A range whose end is not after its start on the same written date is overnight, and asks.
//   - A bare weekday is its next occurrence after the source's date; on that same weekday it asks
//     (today or a week from today), and "next Friday" always asks.
import { Temporal } from "@js-temporal/polyfill";
import { ask, resolved, unsupported, type Resolution, type ResolveContext, type ValueRef } from "./resolve.ts";
import { contextZone, placeWall, US_REGIONS, ZONE_SOURCE, zoneToken, type Moment, type ZoneToken } from "./zones.ts";
import { languageRegion } from "./decimal.ts";

export type { Moment } from "./zones.ts";

export interface Interval {
  start: Moment;
  /** Null only when the caller allowed an open end and the text gives none. */
  end: Moment | null;
}

// MARK: - tokens

type DateTok =
  | { kind: "ymd"; y: number; m: number; d: number }
  | { kind: "numeric"; a: number; b: number; y: number | null; sep: "/" | "."; twoDigitYear: boolean }
  | { kind: "md"; m: number; d: number; y: number | null }
  | { kind: "weekday"; wd: number; mod: "this" | "next" | null }
  | { kind: "relative"; days: number; word: string };

interface TimeTok {
  h: number;
  m: number;
  s: number;
  /** "12h" carries a meridiem; "bare" is a 1-12 hour without one. */
  form: "24h" | "12h" | "bare" | "noon" | "midnight";
  meridiem: "am" | "pm" | null;
}

type DayPart = "morning" | "afternoon" | "evening";

type Tok =
  | { t: "date"; date: DateTok; text: string }
  | { t: "time"; time: TimeTok; text: string }
  | { t: "num"; n: number; text: string; afterAt: boolean }
  | { t: "zone"; zone: ZoneToken; text: string }
  | { t: "part"; part: DayPart; text: string }
  | { t: "sep"; text: string }
  | { t: "at" };

const MONTH_NAMES = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
const WEEKDAY_NAMES = "monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun";
const MERIDIEM = "([ap])\\.?\\s?m\\.?(?![a-z])";

const RX = {
  space: /[\s,()]+/y,
  isoDateTime: /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+\-\u2212]\d{2}:?\d{2})?(?:\[([^\]\s]+)\])?/y,
  isoDate: /(\d{4})-(\d{2})-(\d{2})(?!\d)/y,
  ymdSlash: /(\d{4})\/(\d{1,2})\/(\d{1,2})(?![\d/])/y,
  numeric: /(\d{1,2})([/.])(\d{1,2})(?:\2(\d{4}|\d{2}))?(?![\d/:]|\.\d)/y,
  monthDay: new RegExp(`(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:a-z])(?:,?\\s+(\\d{4})(?![\\d:]))?`, "iy"),
  dayMonth: new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAMES})\\.?(?![a-z])(?:,?\\s+(\\d{4})(?![\\d:]))?`, "iy"),
  weekday: new RegExp(`(?:(this|next|coming)\\s+)?(${WEEKDAY_NAMES})\\.?(?![a-z])`, "iy"),
  relative: /(today|tonight|tomorrow|yesterday)(?![a-z])/iy,
  thisPart: /this\s+(morning|afternoon|evening)(?![a-z])/iy,
  part: /(?:in\s+the\s+)?(morning|afternoon|evening)(?![a-z])/iy,
  noon: /(noon|midday)(?![a-z])/iy,
  midnight: /midnight(?![a-z])/iy,
  zone: new RegExp(ZONE_SOURCE, "y"),
  clock: new RegExp(`(\\d{1,2}):(\\d{2})(?!\\d)(?::(\\d{2})(?!\\d))?(?:\\s*${MERIDIEM})?`, "iy"),
  hourMeridiem: new RegExp(`(\\d{1,2})\\s*${MERIDIEM}`, "iy"),
  num: /(\d{1,2})(?![\d:/.])/y,
  sep: /(?:–|—|-|to|until|till|through|thru)(?![a-z])/iy,
  at: /(?:at|@)(?![a-z])/iy,
  filler: /(?:on|from|the|starting)(?![a-z])/iy,
};

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const WEEKDAYS: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

function month(name: string): number {
  return MONTHS[name.toLowerCase().slice(0, 3)] as number;
}

function meridiem(x: string | undefined): "am" | "pm" | null {
  if (x === undefined) return null;
  return x.toLowerCase() === "a" ? "am" : "pm";
}

/** A clock time's form: a meridiem makes it 12-hour; 13-23, 0, or a leading zero make it 24-hour. */
function clockTime(hText: string, m: number, mer: "am" | "pm" | null, s = 0): TimeTok | string {
  const h = Number(hText);
  if (m > 59 || s > 59) return `${hText}:${String(m).padStart(2, "0")}${s === 0 ? "" : `:${s}`} is not a time`;
  if (mer !== null) {
    if (h < 1 || h > 12) return `${h} ${mer.toUpperCase()} is not a time`;
    return { h, m, s, form: "12h", meridiem: mer };
  }
  if (h > 23) return `${hText}:${String(m).padStart(2, "0")} is not a time`;
  if (h === 0 || h >= 13 || (hText.length === 2 && hText.startsWith("0"))) return { h, m, s, form: "24h", meridiem: null };
  return { h, m, s, form: "bare", meridiem: null };
}

function tokenize(text: string): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  const at = (rx: RegExp): RegExpExecArray | null => {
    rx.lastIndex = i;
    return rx.exec(text);
  };
  let afterAt = false;
  while (i < text.length) {
    let m: RegExpExecArray | null;
    const push = (tok: Tok, len: number): void => {
      out.push(tok);
      i += len;
    };
    if ((m = at(RX.space)) !== null) {
      i += m[0].length;
      continue;
    }
    const wasAt = afterAt;
    afterAt = false;
    if ((m = at(RX.isoDateTime)) !== null) {
      const [, y, mo, d, h, mi, sec, off, bracket] = m;
      // An ISO time is 24-hour whatever its hour; each part must be in range, never wrapped.
      if (Number(h) > 23 || Number(mi) > 59 || Number(sec ?? "0") > 59) return `"${m[0]}" is not a time`;
      push({ t: "date", date: { kind: "ymd", y: Number(y), m: Number(mo), d: Number(d) }, text: m[0] }, 0);
      out.push({ t: "time", time: { h: Number(h), m: Number(mi), s: Number(sec ?? "0"), form: "24h", meridiem: null }, text: m[0] });
      if (off !== undefined) {
        const z = off === "Z" ? zoneToken("UTC") : zoneToken(off.replace("\u2212", "-"));
        if (z === null) return `"${off}" is not an offset`;
        out.push({ t: "zone", zone: z, text: off });
      }
      if (bracket !== undefined) {
        const z = zoneToken(bracket);
        if (z === null || z.kind !== "region") return `"${bracket}" is not a time zone`;
        out.push({ t: "zone", zone: z, text: bracket });
      }
      i += m[0].length;
      continue;
    }
    if ((m = at(RX.isoDate)) !== null) {
      push({ t: "date", date: { kind: "ymd", y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }, text: m[0] }, m[0].length);
      continue;
    }
    if ((m = at(RX.ymdSlash)) !== null) {
      push({ t: "date", date: { kind: "ymd", y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }, text: m[0] }, m[0].length);
      continue;
    }
    if ((m = at(RX.numeric)) !== null) {
      const y = m[4];
      push({ t: "date", date: { kind: "numeric", a: Number(m[1]), b: Number(m[3]), y: y === undefined ? null : Number(y), sep: m[2] as "/" | ".", twoDigitYear: y?.length === 2 }, text: m[0] }, m[0].length);
      continue;
    }
    if ((m = at(RX.monthDay)) !== null) {
      push({ t: "date", date: { kind: "md", m: month(m[1] as string), d: Number(m[2]), y: m[3] === undefined ? null : Number(m[3]) }, text: m[0] }, m[0].length);
      continue;
    }
    if ((m = at(RX.dayMonth)) !== null) {
      push({ t: "date", date: { kind: "md", m: month(m[2] as string), d: Number(m[1]), y: m[3] === undefined ? null : Number(m[3]) }, text: m[0] }, m[0].length);
      continue;
    }
    if ((m = at(RX.weekday)) !== null) {
      const mod = m[1]?.toLowerCase();
      push({ t: "date", date: { kind: "weekday", wd: WEEKDAYS[(m[2] as string).toLowerCase().slice(0, 3)] as number, mod: mod === undefined ? null : mod === "next" ? "next" : "this" }, text: m[0] }, m[0].length);
      continue;
    }
    if ((m = at(RX.relative)) !== null) {
      const word = (m[1] as string).toLowerCase();
      push({ t: "date", date: { kind: "relative", days: word === "tomorrow" ? 1 : word === "yesterday" ? -1 : 0, word }, text: m[0] }, m[0].length);
      if (word === "tonight") out.push({ t: "part", part: "evening", text: m[0] });
      continue;
    }
    if ((m = at(RX.thisPart)) !== null) {
      push({ t: "date", date: { kind: "relative", days: 0, word: "today" }, text: m[0] }, m[0].length);
      out.push({ t: "part", part: (m[1] as string).toLowerCase() as DayPart, text: m[0] });
      continue;
    }
    if ((m = at(RX.part)) !== null) {
      push({ t: "part", part: (m[1] as string).toLowerCase() as DayPart, text: m[0] }, m[0].length);
      continue;
    }
    if ((m = at(RX.noon)) !== null) {
      push({ t: "time", time: { h: 12, m: 0, s: 0, form: "noon", meridiem: "pm" }, text: m[0] }, m[0].length);
      continue;
    }
    if ((m = at(RX.midnight)) !== null) {
      push({ t: "time", time: { h: 0, m: 0, s: 0, form: "midnight", meridiem: null }, text: m[0] }, m[0].length);
      continue;
    }
    // A bare offset ("+02:00") counts only after a space, so the dash of "10:00-11:00" stays a range.
    if ((m = at(RX.zone)) !== null && !(/^[+\-\u2212]/.test(m[0]) && i > 0 && !/[\s(]/.test(text[i - 1] as string))) {
      const z = zoneToken(m[0].replace("\u2212", "-"));
      if (z === null) return `"${m[0]}" is not a time zone`;
      push({ t: "zone", zone: z, text: m[0] }, m[0].length);
      continue;
    }
    if ((m = at(RX.clock)) !== null) {
      const tok = clockTime(m[1] as string, Number(m[2]), meridiem(m[4]), Number(m[3] ?? "0"));
      if (typeof tok === "string") return tok;
      push({ t: "time", time: tok, text: m[0] }, m[0].length);
      continue;
    }
    if ((m = at(RX.hourMeridiem)) !== null) {
      const tok = clockTime(m[1] as string, 0, meridiem(m[2]));
      if (typeof tok === "string") return tok;
      push({ t: "time", time: tok, text: m[0] }, m[0].length);
      continue;
    }
    if ((m = at(RX.num)) !== null) {
      push({ t: "num", n: Number(m[1]), text: m[0], afterAt: wasAt }, m[0].length);
      continue;
    }
    if ((m = at(RX.sep)) !== null) {
      push({ t: "sep", text: m[0] }, m[0].length);
      continue;
    }
    if ((m = at(RX.at)) !== null) {
      push({ t: "at" }, m[0].length);
      afterAt = true;
      continue;
    }
    if ((m = at(RX.filler)) !== null) {
      i += m[0].length;
      continue;
    }
    return `cannot read "${text.slice(i, i + 20)}"`;
  }
  // A lone number is an hour only after "at" ("at 3") or beside a range's dash ("3-4pm").
  for (let k = 0; k < out.length; k++) {
    const tok = out[k] as Tok;
    if (tok.t !== "num") continue;
    const nearSep = out[k - 1]?.t === "sep" || out[k + 1]?.t === "sep";
    if (!tok.afterAt && !nearSep) return `"${tok.text}" is a number, not a time`;
    const time = clockTime(tok.text, 0, null);
    if (typeof time === "string") return time;
    out[k] = { t: "time", time, text: tok.text };
  }
  return out;
}

// MARK: - choices

/**
 * A value with its possibilities: one (with any assumptions made), several (a question), or none. Each
 * part of a date-time resolves to a Choice and they combine, so a question names every real reading.
 */
type Choice<T> = { kind: "one"; value: T; assumptions: string[] } | { kind: "many"; question: string; values: T[] } | { kind: "none"; reason: string };

const one = <T>(value: T, assumptions: string[] = []): Choice<T> => ({ kind: "one", value, assumptions });
const many = <T>(question: string, values: T[]): Choice<T> => ({ kind: "many", question, values });
const none = <T>(reason: string): Choice<T> => ({ kind: "none", reason });

function valuesOf<T>(c: Choice<T>): T[] {
  return c.kind === "one" ? [c.value] : c.kind === "many" ? c.values : [];
}

// MARK: - dates

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function sayDate(d: Temporal.PlainDate, withYear = true): string {
  return `${SHORT_DAYS[d.dayOfWeek - 1]}, ${SHORT_MONTHS[d.month - 1]} ${d.day}${withYear ? `, ${d.year}` : ""}`;
}

function plainDate(y: number, m: number, d: number): Temporal.PlainDate | null {
  try {
    return Temporal.PlainDate.from({ year: y, month: m, day: d }, { overflow: "reject" });
  } catch {
    return null;
  }
}

/** The source's own date, counted in its zone; a string says why it cannot be established. */
function referenceDate(ctx: ResolveContext): Temporal.PlainDate | string {
  if (ctx.referenceInstant === null) return "the source's send time is unknown";
  const zone = ctx.sourceTimeZone === undefined ? ctx.timeZone : ctx.sourceTimeZone;
  if (zone === null) return "the source's time zone is unknown";
  try {
    return Temporal.Instant.from(ctx.referenceInstant).toZonedDateTimeISO(zone).toPlainDate();
  } catch {
    return `cannot read the reference time ${ctx.referenceInstant} in ${zone}`;
  }
}

/**
 * Day-first, month-first, or unknown, for numeric dates in `locale`, by its canonical language and region
 * ("en-US-u-ca-gregory" is en-US). A tag with no region, or a region where both orders are common (Canada),
 * is unknown and asks.
 */
function dateOrder(locale: string | undefined): "dmy" | "mdy" | null {
  if (locale === undefined) return null;
  const key = languageRegion(locale);
  if (key === null) return null;
  if (["en-US", "en-PH", "en-AS", "en-GU", "en-MP", "en-PR", "en-UM", "en-VI", "es-US"].includes(key)) return "mdy";
  if (key === "en-CA" || key === "fr-CA") return null;
  const lang = key.split("-")[0] as string;
  if (["en", "de", "fr", "es", "it", "nl", "pt", "ru", "pl", "sv", "da", "nb", "fi", "cs", "uk", "tr", "id"].includes(lang)) return "dmy";
  return null;
}

/** A month and day with no year: this year's or next year's, whichever is the first on or after the reference. */
function yearless(m: number, d: number, ctx: ResolveContext, text: string): Choice<Temporal.PlainDate> {
  const ref = referenceDate(ctx);
  if (typeof ref === "string") return many(`Which year is "${text}"? It names none, and ${ref}.`, []);
  for (const y of [ref.year, ref.year + 1]) {
    const date = plainDate(y, m, d);
    if (date !== null && Temporal.PlainDate.compare(date, ref) >= 0) return one(date, [`year ${y}: the first ${SHORT_MONTHS[m - 1]} ${d} on or after the source's date`]);
  }
  return many(`Which year is "${text}"? There is no ${SHORT_MONTHS[m - 1]} ${d} in ${ref.year} or ${ref.year + 1}.`, []);
}

function resolveDateTok(tok: DateTok, text: string, ctx: ResolveContext): Choice<Temporal.PlainDate> {
  switch (tok.kind) {
    case "ymd": {
      const d = plainDate(tok.y, tok.m, tok.d);
      return d === null ? none(`there is no date ${text}`) : one(d);
    }
    case "md": {
      if (tok.y === null) {
        if (plainDate(2024, tok.m, tok.d) === null) return none(`there is no date ${text}`);
        return yearless(tok.m, tok.d, ctx, text);
      }
      const d = plainDate(tok.y, tok.m, tok.d);
      return d === null ? none(`there is no date ${text}`) : one(d);
    }
    case "numeric": {
      if (tok.twoDigitYear) return none(`"${text}" has a two-digit year`);
      if (tok.sep === "." && tok.y === null) return none(`"${text}" is not a date without a year`);
      const order = tok.sep === "." ? "dmy" : dateOrder(ctx.sourceLocale);
      const read = (mo: number, d: number): Choice<Temporal.PlainDate> => {
        if (tok.y !== null) {
          const date = plainDate(tok.y, mo, d);
          return date === null ? none(`there is no date ${text}`) : one(date);
        }
        if (plainDate(2024, mo, d) === null) return none(`there is no date ${text}`);
        return yearless(mo, d, ctx, text);
      };
      if (order === "mdy") return read(tok.a, tok.b);
      if (order === "dmy") return read(tok.b, tok.a);
      // Unknown source locale: both orders, as a question, unless they name the same day.
      const readings = [read(tok.a, tok.b), read(tok.b, tok.a)];
      const dates = readings.flatMap(valuesOf);
      const distinct = dates.filter((d, k) => dates.findIndex((e) => e.equals(d)) === k);
      if (distinct.length === 0) return none(readings.map((r) => (r.kind === "none" ? r.reason : "")).find((s) => s !== "") ?? `cannot read ${text}`);
      if (distinct.length === 1 && tok.a === tok.b) return readings[0] as Choice<Temporal.PlainDate>;
      return many(`Is "${text}" month first or day first? The source's locale is unknown.`, distinct);
    }
    case "relative": {
      const ref = referenceDate(ctx);
      if (typeof ref === "string") return many(`"${text}" counts from when the source was written, and ${ref}.`, []);
      return one(ref.add({ days: tok.days }), [`"${tok.word}" counted from the source's date, ${sayDate(ref)}`]);
    }
    case "weekday": {
      const ref = referenceDate(ctx);
      if (typeof ref === "string") return many(`"${text}" counts from when the source was written, and ${ref}.`, []);
      const ahead = (tok.wd - ref.dayOfWeek + 7) % 7 || 7;
      const coming = ref.add({ days: ahead });
      if (tok.mod === "next") return many(`Does "${text}" mean ${sayDate(coming)} or the week after?`, [coming, coming.add({ days: 7 })]);
      if (ahead === 7) return many(`"${text}" was written on that weekday: today or a week from today?`, [ref, coming]);
      return one(coming, [`the next ${SHORT_DAYS[tok.wd - 1]} after the source's date, ${sayDate(ref)}`]);
    }
  }
}

/** The one date a side's date tokens name; a weekday beside a full date must agree with it. */
function dateOf(toks: readonly Extract<Tok, { t: "date" }>[], ctx: ResolveContext): Choice<Temporal.PlainDate> | null {
  if (toks.length === 0) return null;
  const weekdays = toks.filter((t) => t.date.kind === "weekday");
  const others = toks.filter((t) => t.date.kind !== "weekday");
  if (others.length > 1 || weekdays.length > 1) return none(`names more than one date: ${toks.map((t) => t.text).join(", ")}`);
  const main = others[0] ?? (weekdays[0] as Extract<Tok, { t: "date" }>);
  const c = resolveDateTok(main.date, main.text, ctx);
  const wd = weekdays[0];
  if (others.length === 0 || wd === undefined || wd.date.kind !== "weekday") return c;
  const want = wd.date.wd;
  const fits = valuesOf(c).filter((d) => d.dayOfWeek === want);
  if (c.kind === "one" && fits.length === 1) return c;
  if (c.kind === "none") return c;
  return many(`"${wd.text}" and "${main.text}" disagree; which date is meant?`, valuesOf(c));
}

// MARK: - times

interface WallTime {
  time: Temporal.PlainTime;
  /** Days after the written date: 1 for midnight read as the end of that day. */
  dayShift: number;
}

const wall = (h: number, m: number, dayShift = 0, s = 0): WallTime => ({ time: Temporal.PlainTime.from({ hour: h, minute: m, second: s }, { overflow: "reject" }), dayShift });

function sayClock(t: Temporal.PlainTime): string {
  const h = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return `${h}:${String(t.minute).padStart(2, "0")}${t.second === 0 ? "" : `:${String(t.second).padStart(2, "0")}`} ${t.hour < 12 ? "AM" : "PM"}`;
}

/** Hours each day-part word allows; a written time outside them contradicts the text. */
const PART_HOURS: Record<DayPart, (h: number) => boolean> = {
  morning: (h) => h <= 11,
  afternoon: (h) => h >= 12 && h <= 17,
  evening: (h) => h >= 17,
};

/** The readings of one time token, with the day part a word in the text gives, if any. */
function timeChoices(tok: TimeTok, text: string, part: DayPart | null): Choice<WallTime> {
  const fits = (w: WallTime): Choice<WallTime> => (part === null || PART_HOURS[part](w.time.hour) ? one(w) : none(`"${text}" is not in the ${part}, as the text says`));
  switch (tok.form) {
    case "24h":
      return fits(wall(tok.h, tok.m, 0, tok.s));
    case "noon":
      return fits(wall(12, 0));
    case "12h":
      return fits(wall(tok.meridiem === "pm" ? (tok.h % 12) + 12 : tok.h % 12, tok.m, 0, tok.s));
    case "midnight":
      return many(`"${text}": the start of that day or its end?`, [wall(0, 0), wall(0, 0, 1)]);
    case "bare": {
      const am = wall(tok.h % 12, tok.m, 0, tok.s);
      const pm = wall((tok.h % 12) + 12, tok.m, 0, tok.s);
      // A word for the half of the day settles hours that fall in it; "tonight at 12" still asks.
      if (part === "morning" && tok.h >= 5 && tok.h <= 11) return one(am, [`AM: the text says morning`]);
      if (part === "afternoon" && (tok.h === 12 || tok.h <= 6)) return one(pm, [`PM: the text says afternoon`]);
      if (part === "evening" && tok.h >= 5 && tok.h <= 11) return one(pm, [`PM: the text says ${text.includes("night") ? "tonight" : "evening"}`]);
      return many(`Is "${text}" AM or PM?`, [am, pm]);
    }
  }
}

// MARK: - sides of a range

interface Side {
  dates: Extract<Tok, { t: "date" }>[];
  times: Extract<Tok, { t: "time" }>[];
  zones: ZoneToken[];
  part: DayPart | null;
}

function sides(toks: readonly Tok[]): Side[] | string {
  const out: Side[] = [{ dates: [], times: [], zones: [], part: null }];
  for (const tok of toks) {
    const s = out.at(-1) as Side;
    if (tok.t === "sep") {
      if (out.length === 2) return "more than one range separator";
      out.push({ dates: [], times: [], zones: [], part: null });
    } else if (tok.t === "date") s.dates.push(tok);
    else if (tok.t === "time") s.times.push(tok);
    else if (tok.t === "zone") s.zones.push(tok.zone);
    else if (tok.t === "part") {
      if (s.part !== null && s.part !== tok.part) return `"${tok.text}" disagrees with another part of the day`;
      s.part = tok.part;
    }
  }
  for (const s of out) if (s.times.length > 1) return `more than one time: ${s.times.map((t) => t.text).join(", ")}`;
  return out;
}

/** The zone for unzoned times: the source's, the user's when the source is the user, null when unknown. */
function sourceZone(ctx: ResolveContext): ZoneToken | null | string {
  const id = ctx.sourceTimeZone === undefined ? ctx.timeZone : ctx.sourceTimeZone;
  if (id === null) return null;
  return contextZone(id) ?? `"${id}" is not a time zone`;
}

function product<A, B, C>(a: Choice<A>, b: Choice<B>, f: (a: A, b: B) => C): Choice<C> {
  if (a.kind === "none") return a;
  if (b.kind === "none") return b;
  if (a.kind === "one" && b.kind === "one") return one(f(a.value, b.value), [...a.assumptions, ...b.assumptions]);
  const question = [a, b].filter((x) => x.kind === "many").map((x) => (x as { question: string }).question).join(" ");
  return many(question, valuesOf(a).flatMap((x) => valuesOf(b).map((y) => f(x, y))));
}

/** Every reading of a date and wall time in the stated zones, as moments. */
function place(dates: Choice<Temporal.PlainDate>, times: Choice<WallTime>, zones: readonly ZoneToken[], ctx: ResolveContext): Choice<Moment> {
  const source = sourceZone(ctx);
  if (typeof source === "string") return none(source);
  const walls = product(dates, times, (d, t) => d.add({ days: t.dayShift }).toPlainDateTime(t.time));
  if (walls.kind === "none") return walls;
  const placed = valuesOf(walls).map((w) => placeWall(w, zones, source, ctx.timeZone));
  const failed = placed.find((p) => p.kind === "unsupported");
  if (failed !== undefined && failed.kind === "unsupported") return none(failed.reason);
  const moments = placed.flatMap((p) => (p.kind === "ok" ? [p.moment] : p.kind === "ask" ? p.moments : []));
  const questions = placed.flatMap((p) => (p.kind === "ask" ? [p.question] : []));
  if (walls.kind === "one" && placed[0]?.kind === "ok") return one(placed[0].moment, [...walls.assumptions, ...(placed[0].assumption === undefined ? [] : [placed[0].assumption])]);
  const unique = moments.filter((m, k) => moments.findIndex((n) => n.instant === m.instant && n.zone === m.zone) === k);
  return many([walls.kind === "many" ? walls.question : "", ...new Set(questions)].filter((q) => q !== "").join(" "), unique);
}

// MARK: - display

/** "Oct 20, 2026, 3:00 PM PT (UTC-07:00)". */
export function sayMoment(m: Moment, withYear = true): string {
  const dt = Temporal.PlainDateTime.from(m.local);
  return `${sayDate(dt.toPlainDate(), withYear)}, ${sayClock(dt.toPlainTime())} ${m.label} (UTC${m.offset})`;
}

function sayInterval(i: Interval): string {
  if (i.end === null) return `${sayMoment(i.start)}, no end given`;
  const s = Temporal.PlainDateTime.from(i.start.local);
  const e = Temporal.PlainDateTime.from(i.end.local);
  const sameDay = s.toPlainDate().equals(e.toPlainDate()) && i.start.zone === i.end.zone;
  if (sameDay) return `${sayDate(s.toPlainDate())}, ${sayClock(s.toPlainTime())} to ${sayClock(e.toPlainTime())} ${i.start.label} (UTC${i.start.offset})`;
  return `${sayMoment(i.start)} to ${sayMoment(i.end)}`;
}

function finish<T>(c: Choice<T>, span: ValueRef, display: (v: T) => string): Resolution<T> {
  if (c.kind === "none") return unsupported(c.reason);
  if (c.kind === "many") return ask(c.question, c.values);
  return resolved(c.value, display(c.value), [span], c.assumptions);
}

// MARK: - entry points

function readTokens(span: ValueRef): Tok[] | string {
  return tokenize(span.quote.replace(/[\u00a0\u202f]/g, " ").trim());
}

export function parseDate(span: ValueRef, ctx: ResolveContext): Resolution<string> {
  const toks = readTokens(span);
  if (typeof toks === "string") return unsupported(toks);
  if (toks.some((t) => t.t !== "date")) return unsupported(`"${span.quote}" is more than a date`);
  const d = dateOf(toks as Extract<Tok, { t: "date" }>[], ctx);
  if (d === null) return unsupported("no date");
  const c: Choice<string> = d.kind === "one" ? one(d.value.toString(), d.assumptions) : d.kind === "many" ? many(d.question, d.values.map((x) => x.toString())) : d;
  return finish(c, span, (v) => sayDate(Temporal.PlainDate.from(v)));
}

/** The date a side names, or, with no date, the source's date and the next day as a question. */
function sideDate(s: Side, ctx: ResolveContext, timeText: string): Choice<Temporal.PlainDate> {
  const d = dateOf(s.dates, ctx);
  if (d !== null) return d;
  const ref = referenceDate(ctx);
  if (typeof ref === "string") return many(`Which day is "${timeText}"? The text names none, and ${ref}.`, []);
  return many(`Which day is "${timeText}"? The text names none.`, [ref, ref.add({ days: 1 })]);
}

export function parseMoment(span: ValueRef, ctx: ResolveContext): Resolution<Moment> {
  const toks = readTokens(span);
  if (typeof toks === "string") return unsupported(toks);
  const ss = sides(toks);
  if (typeof ss === "string") return unsupported(ss);
  if (ss.length !== 1) return unsupported(`"${span.quote}" is a range, not one time`);
  const s = ss[0] as Side;
  const t = s.times[0];
  if (t === undefined) return unsupported(`"${span.quote}" names no time of day`);
  const c = place(sideDate(s, ctx, t.text), timeChoices(t.time, t.text, s.part), s.zones, ctx);
  return finish(c, span, (m) => sayMoment(m));
}

/**
 * A time of day alone, for a time field (D2-04): "HH:MM", or "HH:MM:SS" when the text gives seconds. A span that names
 * the day too ("Saturday, October 17 at 8:45am") is read as the moment it names (parseMoment), so a wall time Daylight
 * Saving skips or repeats there asks, as it does for a date and time; only its time of day is kept. A time field holds a
 * wall time with no zone, and nothing says which zone the form means, so Caret converts none: a span that names a zone,
 * or a source whose zone is not the user's (ResolveContext.sourceTimeZone), is unsupported.
 */
export function parseClock(span: ValueRef, ctx: ResolveContext): Resolution<string> {
  const toks = readTokens(span);
  if (typeof toks === "string") return unsupported(toks);
  const ss = sides(toks);
  if (typeof ss === "string") return unsupported(ss);
  if (ss.length !== 1) return unsupported(`"${span.quote}" is a range, not one time`);
  const s = ss[0] as Side;
  const t = s.times[0];
  if (t === undefined) return unsupported(`"${span.quote}" names no time of day`);
  if (s.zones.length > 0) return unsupported(`"${span.quote}" names a time zone, and a time field holds a time with none`);
  const source = ctx.sourceTimeZone === undefined ? ctx.timeZone : ctx.sourceTimeZone;
  if (source !== ctx.timeZone) return unsupported(`"${span.quote}" is a time in the source's zone, which is not the user's`);
  const clock = (time: Temporal.PlainTime): string => time.toString({ smallestUnit: time.second === 0 ? "minute" : "second" });
  if (s.dates.length > 0) {
    const m = parseMoment(span, ctx);
    if (m.kind === "unsupported") return m;
    if (m.kind === "ask") return ask(m.question, []);
    const time = Temporal.PlainDateTime.from(m.value.local).toPlainTime();
    return resolved(clock(time), sayClock(time), [span], m.assumptions);
  }
  const c = timeChoices(t.time, t.text, s.part);
  if (c.kind === "one" && c.value.dayShift !== 0) return ask(`"${t.text}": the start of that day or its end?`, []);
  const shown: Choice<string> = c.kind === "one" ? one(clock(c.value.time), c.assumptions) : c.kind === "many" ? many(c.question, c.values.map((w) => clock(w.time))) : c;
  return finish(shown, span, (v) => sayClock(Temporal.PlainTime.from(v)));
}

/** Start and end wall times for a range, with an end's AM/PM carried back to a bare start. */
function rangeTimes(a: Extract<Tok, { t: "time" }>, b: Extract<Tok, { t: "time" }>, aPart: DayPart | null, bPart: DayPart | null): { start: Choice<WallTime>; end: Choice<WallTime> } {
  // The start's day-part word ("morning") helps read a bare end hour, but never contradicts an end whose
  // half of the day is written: "morning at 11am to 1pm" ends at 1 PM.
  const end = timeChoices(b.time, b.text, b.time.form === "bare" ? (bPart ?? aPart) : bPart);
  if (a.time.form === "bare" && b.time.form === "12h" && aPart === null && end.kind === "one") {
    const same = wall(b.time.meridiem === "pm" ? (a.time.h % 12) + 12 : a.time.h % 12, a.time.m, 0, a.time.s);
    const other = wall(b.time.meridiem === "pm" ? a.time.h % 12 : (a.time.h % 12) + 12, a.time.m, 0, a.time.s);
    if (Temporal.PlainTime.compare(same.time, end.value.time) < 0) return { start: one(same, [`${b.time.meridiem?.toUpperCase()} for the start, from the end "${b.text}"`]), end };
    if (Temporal.PlainTime.compare(other.time, end.value.time) < 0) return { start: one(other, [`${b.time.meridiem === "pm" ? "AM" : "PM"} for the start, so it comes before the end "${b.text}"`]), end };
  }
  return { start: timeChoices(a.time, a.text, aPart), end };
}

export function parseInterval(span: ValueRef, ctx: ResolveContext, openEnd: boolean): Resolution<Interval> {
  const toks = readTokens(span);
  if (typeof toks === "string") return unsupported(toks);
  const ss = sides(toks);
  if (typeof ss === "string") return unsupported(ss);
  const [left, right] = ss as [Side, Side | undefined];
  const st = left.times[0];
  if (st === undefined) return unsupported(`"${span.quote}" names no start time`);
  if (right === undefined) {
    const start = place(sideDate(left, ctx, st.text), timeChoices(st.time, st.text, left.part), left.zones, ctx);
    if (openEnd) return finish(product(start, one(null), (s, e: null) => ({ start: s, end: e })), span, sayInterval);
    if (start.kind === "none") return unsupported(start.reason);
    return ask(`How long is it? "${span.quote}" gives a start and no end.${start.kind === "many" ? ` ${start.question}` : ""}`);
  }
  const et = right.times[0];
  if (et === undefined) return unsupported(`"${span.quote}" names no end time`);
  if (left.dates.length === 0 && right.dates.length > 0) return unsupported(`"${span.quote}" gives the end's date and not the start's`);
  // A zone written once, on either side, is the whole range's.
  const leftZones = left.zones.length > 0 ? left.zones : right.zones;
  const rightZones = right.zones;
  const startDate = sideDate(left, ctx, st.text);
  const { start: startTimes, end: endTimes } = rangeTimes(st, et, left.part, right.part);
  const ownEndDate = right.dates.length > 0;
  const endDate = ownEndDate ? (dateOf(right.dates, ctx) as Choice<Temporal.PlainDate>) : startDate;
  // Every start reading with every end reading; an end not after its start on the start's own written
  // date is overnight and only offered as a question, never assumed.
  const starts = place(startDate, startTimes, leftZones, ctx);
  if (starts.kind === "none") return unsupported(starts.reason);
  const pairs: Interval[] = [];
  let overnight = false;
  /** Questions the end's own placement raised (a skipped or repeated hour, a zone conflict at the end). */
  const endQuestions = new Set<string>();
  const after = (e: Moment, s: Moment): boolean => Temporal.Instant.compare(Temporal.Instant.from(e.instant), Temporal.Instant.from(s.instant)) > 0;
  const placeEnd = (d: Choice<Temporal.PlainDate>, t: Choice<WallTime>, zones: readonly ZoneToken[]): Choice<Moment> => {
    const c = place(d, t, zones, ctx);
    if (c.kind === "many") endQuestions.add(c.question);
    return c;
  };
  const shared = right.zones.length === 0 || left.zones.length === 0;
  for (const s of valuesOf(starts)) {
    const sDate = Temporal.PlainDateTime.from(s.local).toPlainDate();
    // One zone written for the whole range is read at the end with every constraint it states, so a
    // conflict at the end asks. When the start itself is a question, each start reading pins the end to
    // its own zone, so an ambiguous "IST" cannot pair a Kolkata start with a Dublin end.
    const pinned: ZoneToken = s.zone.includes("/") ? { kind: "region", id: s.zone, label: s.label } : { kind: "offset", offset: s.zone, label: s.label };
    const endZones: readonly ZoneToken[] = !shared ? rightZones : starts.kind === "one" ? leftZones : [pinned];
    if (ownEndDate) {
      const ends = placeEnd(endDate, endTimes, endZones);
      if (ends.kind === "none") return unsupported(ends.reason);
      for (const e of valuesOf(ends)) if (after(e, s)) pairs.push({ start: s, end: e });
      continue;
    }
    // Each end reading on the start's date; only a reading that is not after the start moves to the next day.
    for (const t of valuesOf(endTimes)) {
      const same = placeEnd(one(sDate), one(t), endZones);
      if (same.kind === "none") return unsupported(same.reason);
      const sameEnds = valuesOf(same).filter((e) => after(e, s));
      if (sameEnds.length > 0) {
        for (const e of sameEnds) pairs.push({ start: s, end: e });
        continue;
      }
      const next = placeEnd(one(sDate.add({ days: 1 })), one(t), endZones);
      for (const n of valuesOf(next)) {
        if (after(n, s)) {
          pairs.push({ start: s, end: n });
          overnight = true;
        }
      }
    }
  }
  if (pairs.length === 0) return unsupported(`"${span.quote}" ends before it starts`);
  // Resolved only when nothing along the way was a question: a single surviving reading of an end the
  // clocks skip is still the answer to a question, not a fact the text states.
  const single = pairs.length === 1 && !overnight && endQuestions.size === 0 && starts.kind === "one" && endTimes.kind === "one" && endDate.kind === "one";
  if (single) return resolved(pairs[0] as Interval, sayInterval(pairs[0] as Interval), [span], [...starts.assumptions, ...endTimes.assumptions]);
  const questions = [starts.kind === "many" ? starts.question : "", endTimes.kind === "many" ? endTimes.question : "", ...endQuestions, overnight ? `Does "${span.quote}" end the next day? The text does not say.` : ""];
  return ask([...new Set(questions.filter((q) => q !== ""))].join(" ") || `Which time does "${span.quote}" mean?`, pairs);
}

/** The US regional names, for a preview that shows what PT, ET, CT or MT was read as. */
export function regionNote(label: string): string | null {
  const id = US_REGIONS[label];
  return id === undefined ? null : `${label} is ${id}`;
}
