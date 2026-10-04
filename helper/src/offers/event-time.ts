// When an event is, from the date and time spans the reader found in a sentence (TypedValues.swift
// reports them as typed values of kind date and time). The value resolver (values/) reads them; this file
// only turns its answer into what the event card shows and adds. Jev never reads a date.
//
// What the resolver cannot settle becomes a question on the card, never a guess:
//   - An hour with no AM or PM asks (the old rule that 1 to 7 meant afternoon had no evidence).
//   - A span with no end asks how long, offering DURATION_CHOICES; nothing is added until one is picked.
//     (The old card assumed 30 minutes, which had no evidence and could create the wrong meeting.)
//   - A choice already past is dropped; with none left, or more than the card's picker holds, no card.
// Text the user is typing is read in the Mac's zone and counted from now. A line in a conversation has no
// known send time or sender's zone on screen, so its relative days and unzoned times ask, and a question
// with no possible answers makes no card.
import { Temporal } from "@js-temporal/polyfill";
import { MAX_CHOICES } from "../popup.ts";
import { RESOLVER_VERSION, ValueResolver, type ResolveContext } from "../values/resolve.ts";
import type { Interval, Moment } from "../values/date-time.ts";
import { US_REGIONS } from "../values/zones.ts";

/**
 * Lengths the card offers when the text gives no end, as choices the user must pick between. Assumed, not
 * measured: they are only offered, never applied without a pick.
 */
export const DURATION_CHOICES = [30, 60] as const;

export interface EventTime {
  /** ISO 8601 in the destination zone, with its offset: "2026-10-20T17:00:00-05:00". */
  start: string;
  end: string;
  /** "Thu 3:00 to 3:30 PM" in the destination zone, for the offer line and the card. */
  says: string;
  /** Source zone, destination zone and both offsets: "3:00 PM PT (America/Los_Angeles, UTC-07:00) / 5:00 PM America/Chicago (UTC-05:00)". */
  zones: string;
  /** What the resolver assumed, and its version, kept with the derived value. */
  assumptions: string[];
  resolverVersion: string;
}

export type EventWhen = { kind: "resolved"; time: EventTime } | { kind: "ask"; question: string; choices: EventTime[] };

/** Who wrote the sentence: the user typing now, or someone in a conversation at a time not on screen. */
export type TimeSource = "typed" | "conversation";

export interface EventClock {
  now: Date;
  /** The Mac's IANA zone: where the event goes. */
  timeZone: string;
  /** The Mac's locale, the language typed text is read in. */
  locale: string;
}

export function macClock(now: Date): EventClock {
  const o = Intl.DateTimeFormat().resolvedOptions();
  return { now, timeZone: o.timeZone, locale: o.locale };
}

const resolver = new ValueResolver();
const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function iso(z: Temporal.ZonedDateTime): string {
  return `${z.toPlainDateTime().toString({ smallestUnit: "second" })}${z.offset}`;
}

function clock(z: { hour: number; minute: number }): { text: string; meridiem: string } {
  return { text: `${z.hour % 12 === 0 ? 12 : z.hour % 12}:${String(z.minute).padStart(2, "0")}`, meridiem: z.hour < 12 ? "AM" : "PM" };
}

function sayClock(z: { hour: number; minute: number }): string {
  const c = clock(z);
  return `${c.text} ${c.meridiem}`;
}

/** "Thu 3:00 to 3:30 PM" for a day within a week of now, "Oct 16 6:00 to 6:30 PM" beyond it. */
function sayWhen(start: Temporal.ZonedDateTime, end: Temporal.ZonedDateTime, now: Date): string {
  const days = (start.epochMilliseconds - now.getTime()) / 86_400_000;
  const day = days < 6.5 ? SHORT_DAYS[start.dayOfWeek - 1] : `${SHORT_MONTHS[start.month - 1]} ${start.day}`;
  const a = clock(start);
  const b = clock(end);
  const nextDay = !start.toPlainDate().equals(end.toPlainDate()) ? ` (${SHORT_DAYS[end.dayOfWeek - 1]})` : "";
  return a.meridiem === b.meridiem && nextDay === "" ? `${day} ${a.text} to ${b.text} ${b.meridiem}` : `${day} ${a.text} ${a.meridiem} to ${b.text} ${b.meridiem}${nextDay}`;
}

/** "PT (America/Los_Angeles, UTC-07:00)": the zone as written, what it was read as, and its offset. */
function zoneName(m: Moment): string {
  const region = US_REGIONS[m.label];
  if (region !== undefined) return `${m.label} (${region}, UTC${m.offset})`;
  if (m.label !== m.zone && m.zone.includes("/")) return `${m.label} (${m.zone}, UTC${m.offset})`;
  return m.label === m.zone && m.zone.includes("/") ? `${m.zone} (UTC${m.offset})` : `${m.label} (UTC${m.offset})`;
}

function eventTime(i: Interval & { end: Moment }, clockNow: EventClock, assumptions: string[], resolverVersion: string): EventTime {
  const dest = clockNow.timeZone;
  const start = Temporal.Instant.from(i.start.instant).toZonedDateTimeISO(dest);
  const end = Temporal.Instant.from(i.end.instant).toZonedDateTimeISO(dest);
  const src = Temporal.PlainDateTime.from(i.start.local);
  const srcDate = `${SHORT_MONTHS[src.month - 1]} ${src.day}`;
  const destDate = `${SHORT_MONTHS[start.month - 1]} ${start.day}`;
  const sameZone = i.start.zone === dest && i.end.zone === dest;
  const zones = sameZone
    ? `${srcDate}, ${sayClock(src)} ${dest} (UTC${start.offset}), your time zone`
    : `${srcDate}, ${sayClock(src)} ${zoneName(i.start)} / ${destDate === srcDate ? "" : `${destDate}, `}${sayClock(start)} ${dest} (UTC${start.offset})`;
  return { start: iso(start), end: iso(end), says: sayWhen(start, end, clockNow.now), zones, assumptions, resolverVersion };
}

/** The end each length gives, in the start's own zone, so a daylight-saving change in between is counted. */
function withLengths(i: Interval): (Interval & { end: Moment })[] {
  if (i.end !== null) return [i as Interval & { end: Moment }];
  return DURATION_CHOICES.map((minutes) => {
    const end = Temporal.Instant.from(i.start.instant).add({ minutes }).toZonedDateTimeISO(i.start.zone);
    return { start: i.start, end: { ...i.start, instant: end.toInstant().toString(), local: end.toPlainDateTime().toString({ smallestUnit: "minute" }), offset: end.offset } };
  });
}

/**
 * The event the spans name, read against `clockNow`. Null when they name no time, one the resolver
 * refuses, only moments already past, or more possibilities than the card can offer.
 */
export function resolveEventTime(spans: readonly string[], clockNow: EventClock, source: TimeSource = "typed"): EventWhen | null {
  const text = spans.join(" ").trim();
  if (text === "") return null;
  const ctx: ResolveContext =
    source === "typed"
      ? { locale: clockNow.locale, timeZone: clockNow.timeZone, referenceInstant: clockNow.now.toISOString(), sourceLocale: clockNow.locale }
      : { locale: clockNow.locale, timeZone: clockNow.timeZone, referenceInstant: null, sourceTimeZone: null };
  const r = resolver.interval(text, ctx, { openEnd: true });
  if (r.kind === "unsupported") return null;
  const intervals = r.kind === "resolved" ? [r.value] : r.alternatives;
  const assumptions = r.kind === "resolved" ? r.assumptions : [];
  const now = clockNow.now.getTime();
  const choices = intervals
    .flatMap(withLengths)
    .filter((i) => Date.parse(i.start.instant) > now)
    // Earliest start first, then shortest: an order with no opinion about which reading is likelier.
    .sort((a, b) => Date.parse(a.start.instant) - Date.parse(b.start.instant) || Date.parse(a.end.instant) - Date.parse(b.end.instant))
    .map((i) => eventTime(i, clockNow, assumptions, RESOLVER_VERSION));
  if (choices.length === 0) return null;
  const openEnd = intervals.some((i) => i.end === null);
  if (r.kind === "resolved" && !openEnd) return { kind: "resolved", time: choices[0] as EventTime };
  if (choices.length > MAX_CHOICES) return null;
  const questions = [r.kind === "ask" ? r.question : "", openEnd ? "How long is it? The text gives no end." : ""].filter((q) => q !== "");
  return { kind: "ask", question: questions.join(" "), choices };
}
