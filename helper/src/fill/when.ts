// Dates and times for date and time fields (B24, Q1 bug 10), read by code from the span Jev picked. A date
// goes through the value resolver (values/resolve.ts), which asks rather than guesses: "03/04" with no known
// source locale, a relative day with no reference instant. What a Fill all writes (D2-04) is read only by the
// resolver, in the field's own format: readDate, readClock, readDateTime. clockTime is B24's looser reading of a time
// inside prose ("Deliver around 7:45 pm"), kept only for a value handed to the user, who sees it before setting it.
import { Temporal } from "@js-temporal/polyfill";
import { ValueResolver, type ResolveContext } from "../values/resolve.ts";
import { sayDate, sayMoment } from "../values/date-time.ts";
import { dateParts, monthYear, numericDate, type DateOrder } from "./derive.ts";

const resolver = new ValueResolver();

/**
 * The one civil date a span names, as YYYY-MM-DD with how the host says it; null when it names none or several. V3 review
 * B9: a date written only in numbers is read in the order `order` (derive.ts dateOrderHint) or its own numbers settle
 * (derive.ts dateParts), never in a locale's or a convention's: the resolver read every dotted date day-first.
 */
export function readDate(text: string, ctx: ResolveContext, order: DateOrder | null = null): { value: string; display: string } | null {
  const numeric = numericDate(splitMoment(text)?.date ?? text) ? (splitMoment(text)?.date ?? text).trim().replace(/\.$/u, "") : null;
  if (numeric !== null) {
    const p = dateParts(numeric, order);
    if (p === null || p.month === null || p.day === null) return null;
    const day = Temporal.PlainDate.from({ year: Number(p.year), month: Number(p.month), day: Number(p.day) });
    return { value: day.toString(), display: sayDate(day) };
  }
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
/** A line that starts an earlier message quoted inside this one. */
const QUOTED = /wrote:\s*$|original message|forwarded message|^\s*>|^\s*-{2,}/iu;

/** The send line of the message a span sits in (sentLineFor), as read before the asks. */
export interface SentLine {
  /** The node that shows it, and that node's whole text then. */
  nodeKey: string;
  text: string;
  /** What follows "Date:" or "Sent:". */
  value: string;
  /** The day it names, YYYY-MM-DD, as written (no zone is read). */
  day: string;
}

/**
 * V3 review A7: the send line of the one message that holds `span` (in node `spanKey`), from a window's nodes in reading
 * order. Shown only when the window reads as one message: exactly one "From:" line and one "Date:" or "Sent:" line, that
 * line above the span, nothing between them that starts a quoted or forwarded message ("Original message", "… wrote:",
 * "> …"), and a whole date with its year in it. Null otherwise.
 */
export function sentLineFor(nodes: readonly { key: string; text: string }[], spanKey: string, span: string): SentLine | null {
  const lines = nodes.flatMap((n) => n.text.split(/\r?\n/u).map((line) => ({ key: n.key, text: n.text, line })));
  if (lines.filter((l) => FROM_LINE.test(l.line)).length !== 1) return null;
  const sent = lines.flatMap((l, i) => {
    const v = SENT_LINE.exec(l.line)?.[1];
    return v === undefined ? [] : [{ ...l, i, value: v }];
  });
  if (sent.length !== 1) return null;
  const s = sent[0]!;
  const at = lines.findIndex((l) => l.key === spanKey && l.line.includes(span));
  if (at <= s.i || lines.slice(s.i + 1, at + 1).some((l) => QUOTED.test(l.line))) return null;
  const d = resolver.date(splitMoment(s.value)?.date ?? s.value, { locale: "en-US", timeZone: "UTC", referenceInstant: null });
  return d.kind === "resolved" ? { nodeKey: s.key, text: s.text, value: s.value, day: d.value } : null;
}

/** A span that names its month and its day of the month, by name or number, and nothing relative ("tomorrow", "next Friday"). */
const MONTH_AND_DAY = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/iu;
const RELATIVE = /\b(?:today|tonight|tomorrow|yesterday|next|this|last|coming|ago|week|weekend)\b/iu;

/**
 * V3 (B24 ask-19): the date a span that names a month and day but no year ("Saturday, October 17 at 8:45am") names, with
 * its year assumed from when its message was sent (sentLineFor): the first such day on or after the send day, the
 * resolver's rule, which also checks a weekday against it. This is code's choice, so the caller sends the value to the
 * verifier with `says`, never mints it as a plain conversion. Null when the caller knows a reference already, the source's
 * zone is unknown (review A8: `sourceTimeZone` null), the span is relative or has a year, or a send day one day either
 * side gives another date: the zone the send line was shown in is not known, and it can move the send day by one (review
 * A8: a Tokyo send at 11:30 PM on December 31 read as Denver's gave the next year).
 */
export function datedBySent(text: string, sent: SentLine, ctx: ResolveContext): { value: string; display: string; ctx: ResolveContext; says: string } | null {
  if (ctx.referenceInstant !== null || ctx.sourceTimeZone === null) return null;
  const date = splitMoment(text)?.date ?? text;
  if (!MONTH_AND_DAY.test(date) || RELATIVE.test(text) || /(?<!\d)\d{4}(?!\d)/u.test(date)) return null;
  const zone = ctx.sourceTimeZone ?? ctx.timeZone;
  const sentDay = Temporal.PlainDate.from(sent.day);
  const read = [-1, 0, 1].map((k) => {
    const c: ResolveContext = { ...ctx, referenceInstant: sentDay.add({ days: k }).toZonedDateTime({ timeZone: zone, plainTime: "12:00" }).toInstant().toString() };
    const r = resolver.date(date, c);
    return r.kind === "resolved" ? { c, value: r.value, display: r.display } : null;
  });
  if (read.some((r) => r === null) || new Set(read.map((r) => r?.value)).size !== 1) return null;
  const r = read[1]!;
  return { value: r.value, display: r.display, ctx: r.c, says: `the year ${r.value.slice(0, 4)} is assumed: Caret took the first ${sayDate(Temporal.PlainDate.from(r.value)).replace(/, \d{4}$/u, "")} on or after ${sent.day}, the day the message was sent` };
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
  // datedBySent.
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
