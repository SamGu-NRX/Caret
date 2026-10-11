// Dates and times for date and time fields (B24, Q1 bug 10), read by code from the span Jev picked. A date
// goes through the value resolver (values/resolve.ts), which asks rather than guesses: "03/04" with no known
// source locale, a relative day with no reference instant. What a Fill all writes (D2-04) is read only by the
// resolver, in the field's own format: readDate, readClock, readDateTime. clockTime is B24's looser reading of a time
// inside prose ("Deliver around 7:45 pm"), kept only for a value handed to the user, who sees it before setting it.
import { Temporal } from "@js-temporal/polyfill";
import { ValueResolver, type ResolveContext } from "../values/resolve.ts";
import { dateOrder, sayDate, sayMoment } from "../values/date-time.ts";
import { monthYear, type DateOrder } from "./derive.ts";
import { splitLines } from "../privacy/ledger/source.ts";

const resolver = new ValueResolver();

/**
 * V3 review: a value read from a span, with every assumption the reading made (values/date-time.ts: a year counted from a
 * reference, a month and day order from a stated format or a locale, AM or PM from a word; when.ts: a century, a send
 * line). An empty list is a plain conversion of what the span says; any other is code's choice, which the verifier must
 * judge with the list said (contract.ts Provenance.says), never an exemption.
 */
export interface Reading {
  value: string;
  display: string;
  assumptions: readonly string[];
}

const NUMERIC = /^(\d{1,2})([/.-])(\d{1,2})\2((?:1[89]|2\d)\d{2})\.?$/u;

/**
 * V3: a span that is one numeric date with a four-digit year, in any of the separators people write ("04/22/1990",
 * "04-22-1990", "22.04.1990."), read as the brief's evidence allows: the numbers settle the order (one over 12, or both
 * the same) with no assumption; else a format the source states (`order`) or its locale gives it, said as an assumption.
 * A stated format and a locale that disagree, or either one the numbers contradict, read nothing. Undefined when the
 * span is not such a date (the resolver reads it).
 */
function numericReading(text: string, ctx: ResolveContext, order: DateOrder | null): Reading | null | undefined {
  const m = NUMERIC.exec(text.trim());
  if (m === null) return undefined;
  const [a, b, year] = [Number(m[1]), Number(m[3]), Number(m[4])];
  const intrinsic: DateOrder | null = a > 12 ? "dm" : b > 12 ? "md" : a === b ? "md" : null;
  const locale = dateOrder(ctx.sourceLocale);
  const byLocale: DateOrder | null = locale === null ? null : locale === "mdy" ? "md" : "dm";
  if (order !== null && byLocale !== null && order !== byLocale) return null;
  if (intrinsic !== null && a !== b && ((order !== null && order !== intrinsic) || (byLocale !== null && byLocale !== intrinsic))) return null;
  const settled = intrinsic ?? order ?? byLocale;
  if (settled === null) return null;
  const [month, day] = settled === "md" ? [a, b] : [b, a];
  let date: Temporal.PlainDate;
  try {
    date = Temporal.PlainDate.from({ year, month, day }, { overflow: "reject" });
  } catch {
    return null;
  }
  const first = settled === "md" ? "month first" : "day first";
  const assumptions = intrinsic !== null ? [] : [order !== null ? `${first}: the format the source states beside "${text.trim()}"` : `${first}: the source's locale, ${ctx.sourceLocale}`];
  return { value: date.toString(), display: sayDate(date), assumptions };
}

/** The resolver context with a format the source states beside a numeric date (derive.ts dateOrderHint). */
function withOrder(ctx: ResolveContext, order: DateOrder | null): ResolveContext {
  return order === null ? ctx : { ...ctx, sourceDateOrder: order === "md" ? "mdy" : "dmy" };
}

/**
 * The one civil date a span names, as YYYY-MM-DD with how the host says it, and what the reading assumed; null when it
 * names none or several. `order` is a format the source states beside it; a numeric date with no order evidence asks
 * (values/date-time.ts, V3 review B9: dotted dates were read day first by convention).
 */
export function readDate(text: string, ctx0: ResolveContext, order: DateOrder | null = null): Reading | null {
  const numeric = numericReading(text, ctx0, order);
  if (numeric !== undefined) return numeric;
  const ctx = withOrder(ctx0, order);
  const d = resolver.date(text, ctx);
  if (d.kind === "resolved") return { value: d.value, display: d.display, assumptions: d.assumptions };
  if (d.kind === "ask") return null;
  // A span with a time as well ("Saturday, October 17 at 8:45am") names its date through the moment it names.
  const m = resolver.moment(text, ctx);
  if (m.kind === "resolved") {
    const day = Temporal.PlainDate.from(m.value.local.slice(0, 10));
    return { value: day.toString(), display: sayDate(day), assumptions: m.assumptions };
  }
  // V3 (B24 ask-19): or through its date part alone, read as any date is, so a time the moment cannot settle ("at 8:45",
  // no am or pm) does not take the date with it. A weekday that is not that date's still asks.
  const split = splitMoment(text);
  const part = split === null ? null : resolver.date(split.date, ctx);
  return part?.kind === "resolved" ? { value: part.value, display: part.display, assumptions: part.assumptions } : null;
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
  const lines = nodes.flatMap((n) => splitLines(n.text).map((line) => ({ key: n.key, text: n.text, line })));
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
export function datedBySent(text: string, sent: SentLine, ctx: ResolveContext): { value: string; display: string; ctx: ResolveContext; says: string; assumptions: readonly string[] } | null {
  if (ctx.referenceInstant !== null || ctx.sourceTimeZone === null) return null;
  const date = splitMoment(text)?.date ?? text;
  if (!MONTH_AND_DAY.test(date) || RELATIVE.test(text) || /(?<!\d)\d{4}(?!\d)/u.test(date)) return null;
  const zone = ctx.sourceTimeZone ?? ctx.timeZone;
  const sentDay = Temporal.PlainDate.from(sent.day);
  const read = [-1, 0, 1].map((k) => {
    const c: ResolveContext = { ...ctx, referenceInstant: sentDay.add({ days: k }).toZonedDateTime({ timeZone: zone, plainTime: "12:00" }).toInstant().toString() };
    const r = resolver.date(date, c);
    return r.kind === "resolved" ? { c, value: r.value, display: r.display, assumptions: r.assumptions } : null;
  });
  if (read.some((r) => r === null) || new Set(read.map((r) => r?.value)).size !== 1) return null;
  const r = read[1]!;
  return { value: r.value, display: r.display, ctx: r.c, assumptions: r.assumptions, says: `the year ${r.value.slice(0, 4)} is assumed: Caret took the first ${sayDate(Temporal.PlainDate.from(r.value)).replace(/, \d{4}$/u, "")} on or after ${sent.day}, the day the message was sent` };
}

const MONTH_SAYS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * C2 (lead decision 1): the one month and year a span names (derive.ts monthYear), as an HTML month input holds it
 * (YYYY-MM) with how the host says it ("August 2022"); null when it names none or could name two.
 */
export function readMonth(text: string, refYear: number = new Date().getUTCFullYear()): Reading | null {
  const m = monthYear(text, refYear);
  if (m === null) return null;
  // V3 review: a two-digit year ("Aug '30") is read in a window of years around now, which is code's choice.
  const short = /['’](\d{2})\s*$/u.exec(text.trim());
  const assumptions = short === null ? [] : [`year ${m.year}: '${short[1]} read as the one year ending in ${short[1]} from ${refYear - 50} to ${refYear + 10}`];
  return { value: `${m.year}-${String(m.month).padStart(2, "0")}`, display: `${MONTH_SAYS[m.month - 1]} ${m.year}`, assumptions };
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
export function readClock(text: string, ctx0: ResolveContext, order: DateOrder | null = null): Reading | null {
  const ctx = withOrder(ctx0, order);
  // A span that names its day gives its time only once that day is known: Daylight Saving can skip or repeat the time on
  // that day (D2-04). So a date with a time is not split here, as readDate splits it (V3); its day is placed through
  // datedBySent.
  const t = resolver.clock(text, ctx);
  return t.kind === "resolved" ? { value: t.value, display: t.display, assumptions: t.assumptions } : null;
}

/**
 * The one date and time a span names, as an HTML datetime-local holds it (YYYY-MM-DDTHH:MM, no zone), when it is a wall
 * time in the user's own zone: the span names none, or names that zone ("3pm PT" for a user in Los Angeles). A time
 * in another zone is null: the field holds no zone and the form does not say which it means, so Caret converts none.
 */
export function readDateTime(text: string, ctx0: ResolveContext, order: DateOrder | null = null): Reading | null {
  const ctx = withOrder(ctx0, order);
  const m = resolver.moment(text, ctx);
  if (m.kind !== "resolved" || m.value.zone !== ctx.timeZone) return null;
  return { value: m.value.local, display: sayMoment(m.value), assumptions: m.assumptions };
}
