// Dates and times for date and time fields (B24, Q1 bug 10), read by code from the span Jev picked. A date
// goes through the value resolver (values/resolve.ts), which asks rather than guesses: "03/04" with no known
// source locale, a relative day with no reference instant. What a Fill all writes (D2-04) is read only by the
// resolver, in the field's own format: readDate, readClock, readDateTime. clockTime is B24's looser reading of a time
// inside prose ("Deliver around 7:45 pm"), kept only for a value handed to the user, who sees it before setting it.
import { Temporal } from "@js-temporal/polyfill";
import { ValueResolver, type ResolveContext } from "../values/resolve.ts";
import { sayDate, sayMoment } from "../values/date-time.ts";
import { monthYear } from "./derive.ts";

const resolver = new ValueResolver();

/** The one civil date a span names, as YYYY-MM-DD with how the host says it; null when it names none or several. */
export function readDate(text: string, ctx: ResolveContext): { value: string; display: string } | null {
  const d = resolver.date(text, ctx);
  if (d.kind === "resolved") return { value: d.value, display: d.display };
  if (d.kind === "ask") return null;
  // A span with a time as well ("Saturday, October 17 at 8:45am") names its date through the moment it names.
  const m = resolver.moment(text, ctx);
  if (m.kind === "resolved") {
    const day = Temporal.PlainDate.from(m.value.local.slice(0, 10));
    return { value: day.toString(), display: sayDate(day) };
  }
  // V3 (B24 ask-19): or through its date part alone, read as any date is, so a time the moment cannot settle ("at 8:45",
  // no am or pm) does not take the date with it. A weekday that is not that date's still asks.
  const split = splitMoment(text);
  const part = split === null ? null : resolver.date(split.date, ctx);
  return part?.kind === "resolved" ? { value: part.value, display: part.display } : null;
}

const TIME_AT_END = /^(.*?\S)(?:,?\s+at\s+|,\s*|\s+@\s*|\s+)((?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*[ap]\.?\s*m\.?|(?:[01]?\d|2[0-3]):[0-5]\d)$/iu;

/**
 * V3 (B24 ask-19): a span that names a date and then a clock time ("Saturday, October 17 at 8:45am"), as its date part
 * and its time part, each a substring of it. Null when it ends in no time, or nothing before the time names a month or a
 * weekday. Whether either part reads as a value is the resolver's: this only cuts the span.
 */
export function splitMoment(text: string): { date: string; time: string } | null {
  const m = TIME_AT_END.exec(text.trim());
  if (m === null) return null;
  const date = (m[1] as string).replace(/,$/u, "");
  if (!/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}/iu.test(date)) return null;
  return { date, time: m[2] as string };
}

/** A line that heads a message with when it was sent ("Date: Thu, Oct 15, 2026, 10:22 AM", "Sent: …"). */
const SENT_LINE = /^\s*(?:date|sent):\s*(.+?)\s*$/iu;
/** A line that heads a message with its sender. */
const FROM_LINE = /^\s*from:\s*\S/iu;

/**
 * V3 (B24 ask-19): when the message a window shows was sent, as an instant, for reading a date that gives no year
 * ("Saturday, October 17") against it. Only a window that reads as one message: a "From:" line and exactly one
 * "Date:" or "Sent:" line, whose text names a whole date with its year and a time. A mail app shows that time in the
 * user's own zone, so it is read in `ctx.timeZone`. Null otherwise: a thread with several dates, a note's "Date:" line
 * with no sender, a header with no year.
 */
export function sentInstant(lines: readonly string[], ctx: ResolveContext): string | null {
  if (!lines.some((l) => FROM_LINE.test(l))) return null;
  const sent = lines.map((l) => SENT_LINE.exec(l)?.[1]).filter((x): x is string => x !== undefined);
  if (sent.length !== 1 || !/(?<!\d)(?:1[89]|2\d)\d{2}(?!\d)/u.test(sent[0] as string)) return null;
  const m = resolver.moment(sent[0] as string, { ...ctx, referenceInstant: null, sourceTimeZone: ctx.timeZone });
  return m.kind === "resolved" ? m.value.instant : null;
}

/** A span that names its month and its day of the month, by name or number, and nothing relative ("tomorrow", "next Friday"). */
const MONTH_AND_DAY = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/iu;
const RELATIVE = /\b(?:today|tonight|tomorrow|yesterday|next|this|last|coming|ago|week|weekend)\b/iu;

/**
 * V3: the context to read a picked span's date in. When the caller knows no reference instant, and the span names its
 * month and day but no year ("Saturday, October 17"), the message it came from gives one (sentInstant): the resolver
 * then takes the first such day on or after the send and checks the weekday against it. A span with a relative word
 * gets none, so a "Date:" line never decides what "tomorrow" means.
 */
export function readingContext(span: string, ctx: ResolveContext, sourceLines: () => readonly string[]): ResolveContext {
  if (ctx.referenceInstant !== null || !MONTH_AND_DAY.test(span) || RELATIVE.test(span)) return ctx;
  const sent = sentInstant(sourceLines(), ctx);
  return sent === null ? ctx : { ...ctx, referenceInstant: sent };
}

const MONTH_SAYS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * C2 (lead decision 1): the one month and year a span names (derive.ts monthYear), as an HTML month input holds it
 * (YYYY-MM) with how the host says it ("August 2022"); null when it names none or could name two.
 */
export function readMonth(text: string, refYear?: number): { value: string; display: string } | null {
  const m = monthYear(text, refYear);
  return m === null ? null : { value: `${m.year}-${String(m.month).padStart(2, "0")}`, display: `${MONTH_SAYS[m.month - 1]} ${m.year}` };
}

const MERIDIEM =/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?\s*m\b\.?/giu;
const H24 = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])(?!\s*[ap]\.?\s*m\b)/giu;

/** The one clock time a span names, as HH:MM (24-hour) with how the host says it; null when it names none, several, or no am/pm for an hour under 13. */
export function clockTime(text: string): { value: string; display: string } | null {
  const found = new Set<string>();
  for (const m of text.matchAll(MERIDIEM)) {
    const h = Number(m[1]) % 12 + (m[3]?.toLowerCase() === "p" ? 12 : 0);
    found.add(`${String(h).padStart(2, "0")}:${m[2] ?? "00"}`);
  }
  for (const m of text.replace(MERIDIEM, " ").matchAll(H24)) {
    const h = Number(m[1]);
    // "7:30" with no am or pm could be either; only a 24-hour hour (0, or 13 and up) says which.
    if (h >= 1 && h <= 12) return null;
    found.add(`${String(h).padStart(2, "0")}:${m[2]}`);
  }
  if (found.size !== 1) return null;
  const value = [...found][0] as string;
  const [h, mm] = value.split(":").map(Number) as [number, number];
  return { value, display: `${h % 12 === 0 ? 12 : h % 12}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}` };
}

/** The one time of day a span names, as HH:MM (HH:MM:SS with seconds), read by the resolver; null when it asks or cannot read it, or the span or its source is in another zone. */
export function readClock(text: string, ctx: ResolveContext): { value: string; display: string } | null {
  // A span that names its day gives its time only once that day is known: Daylight Saving can skip or repeat the time on
  // that day (D2-04). So a date with a time is not split here, as readDate splits it (V3); its day is placed through
  // readingContext.
  const t = resolver.clock(text, ctx);
  return t.kind === "resolved" ? { value: t.value, display: t.display } : null;
}

/**
 * The one date and time a span names, as an HTML datetime-local holds it (YYYY-MM-DDTHH:MM, no zone), when it is a wall
 * time in the user's own zone: the span names none, or names that zone ("3pm PT" for a user in Los Angeles). A time
 * in another zone is null: the field holds no zone and the form does not say which it means, so Caret converts none.
 */
export function readDateTime(text: string, ctx: ResolveContext): { value: string; display: string } | null {
  const m = resolver.moment(text, ctx);
  if (m.kind !== "resolved" || m.value.zone !== ctx.timeZone) return null;
  return { value: m.value.local, display: sayMoment(m.value) };
}
