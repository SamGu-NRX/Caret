// When an event is, from the date and time spans the reader found in a sentence (TypedValues.swift
// reports them as typed values of kind date and time). Code parses them; Jev never reads a date. The
// rules, each assumed rather than measured:
//   - A time is required: a day alone ("Friday") makes no offer, since all-day events are out of scope.
//   - A weekday is its next occurrence: today if the time is still ahead, otherwise a week on. "next"
//     and "this" before a weekday change nothing, since people use them both ways.
//   - No day: today if the time is still ahead, otherwise tomorrow.
//   - "yesterday", "last" or a day already past is not an event to add: null.
//   - An hour with no AM or PM: 1 to 7 is afternoon, 8 to 11 morning, 12 noon, and in "tonight" every
//     hour is evening.
//   - A month and day with no year: this year, or next year once it has passed. A stated year is kept, and
//     a stated date already past makes no event.
//   - A time zone or offset ("UTC", "PST", "-07:00") anywhere in the sentence makes no event: times are
//     read only in the Mac's zone.
//   - A time that cannot be ("3:99", "0pm", "13pm"), or that the clocks skip that day, makes no event.
//   - The event lasts DEFAULT_MINUTES unless the span gives an end ("3:00 to 3:45", "3-4pm").
// Times are wall-clock times in the process's time zone, written as ISO 8601 with that zone's offset on
// the event's own date, so a daylight-saving change between now and then is handled by the Date object.

/** The plan's default length for an event with no end (Fable plan section 2, assumed). */
export const DEFAULT_MINUTES = 30;

export interface EventTime {
  /** ISO 8601 with offset. */
  start: string;
  end: string;
  /** "Thu 3:00 to 3:30 PM", for the offer line. */
  says: string;
}

const WEEKDAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const TIME = /\b(noon|midnight|(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?)(?:\s*(?:-|–|to|until)\s*(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?)?\b/i;
const WEEKDAY = /\b(sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)[a-z]*\b/i;
const MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?|\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\b(?:,?\s+(\d{4})\b)?/i;
const NUMERIC_DATE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/;
/**
 * A time zone named by its usual abbreviation, a UTC or GMT offset, or a bare offset ("-07:00"). The
 * abbreviations are matched in capitals only, so a name like "Best" is not read as one.
 */
export const ZONE = /\b(?:UTC|GMT|Z|[PMCE][SD]T|AK[SD]T|HST|BST|CES?T|EES?T|WES?T|IST|JST|KST|AE[SD]T|ACST|AWST|NZ[SD]T|PT|MT|CT|ET)\b|\b(?:utc|gmt)\s*[+-]\s*\d|(?:^|\s)[+-]\d{2}:?\d{2}\b/;
/** A clock time whose minutes are not two digits ("3:5pm", "3:000pm"). */
const BAD_CLOCK = /\d:(?:\d(?!\d)|\d{3,})/;
const CLOCK = /(\d{1,2}):(\d{2})/g;

/** 24-hour hour from an hour, its AM/PM if any, and whether the sentence says tonight. */
function hour24(h: number, meridiem: string | undefined, tonight: boolean): number | null {
  const m = meridiem?.toLowerCase().replace(/\./g, "");
  if ((m === "am" || m === "pm") && (h < 1 || h > 12)) return null;
  if (m === "am") return h === 12 ? 0 : h;
  if (m === "pm") return h === 12 ? 12 : h + 12;
  if (h >= 13 && h <= 23) return h;
  if (h === 0 || h > 23) return null;
  if (tonight) return h === 12 ? 0 : h + 12;
  if (h === 12) return 12;
  return h <= 7 ? h + 12 : h;
}

/** The time a span text names, with any end it gives; null when it names none. */
function parseTime(text: string, tonight: boolean): { h: number; m: number; end: { h: number; m: number } | null } | null {
  // A numeric date ("10/12") holds digits a bare hour would read; it is taken out first.
  const t = text.replace(NUMERIC_DATE, " ").replace(MONTH_DAY, " ");
  const x = TIME.exec(t);
  if (x === null) return null;
  const word = x[1]?.toLowerCase();
  if (word === "noon") return { h: 12, m: 0, end: null };
  if (word === "midnight") return { h: 0, m: 0, end: null };
  // A bare number is a time only with minutes, AM or PM, an "at" before it ("at 3"), or a day in the same
  // span ("4 today"): the reader's detector reported that span as a date and time.
  const bare = x[3] === undefined && x[4] === undefined;
  const day = /\b(today|tonight|tomorrow|sun|mon|tue|wed|thu|fri|sat)/i.test(t);
  if (bare && x[5] === undefined && !day && !new RegExp(`\\bat\\s+${x[2]}\\b`, "i").test(t)) return null;
  // In a range, the end's AM or PM also applies to a start that has none: "3-4pm".
  const startMeridiem = x[4] ?? (x[5] !== undefined ? x[7] : undefined);
  const h = hour24(Number(x[2]), startMeridiem, tonight);
  if (h === null) return null;
  const m = Number(x[3] ?? "0");
  if (x[5] === undefined) return { h, m, end: null };
  let eh = hour24(Number(x[5]), x[7] ?? startMeridiem, tonight);
  if (eh === null) return null;
  // "11 to 12:30" without AM or PM: an end before the start is read twelve hours on.
  if (eh * 60 + Number(x[6] ?? "0") <= h * 60 + m && eh + 12 < 24 && x[7] === undefined) eh += 12;
  return { h, m, end: { h: eh, m: Number(x[6] ?? "0") } };
}

/** ISO 8601 with the local offset that applies on that date. */
export function localIso(d: Date): string {
  const p = (n: number, w = 2): string => String(Math.abs(n)).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00${off >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

function clock(d: Date): { text: string; meridiem: string } {
  const h = d.getHours();
  return { text: `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, "0")}`, meridiem: h < 12 ? "AM" : "PM" };
}

/** "Thu 3:00 to 3:30 PM" for a day within a week of now, "Oct 16 6:00 to 6:30 PM" beyond it. */
export function sayWhen(start: Date, end: Date, now: Date): string {
  const days = (start.getTime() - now.getTime()) / 86_400_000;
  const day = days < 6.5 ? SHORT_DAYS[start.getDay()] : `${SHORT_MONTHS[start.getMonth()]} ${start.getDate()}`;
  const a = clock(start);
  const b = clock(end);
  return a.meridiem === b.meridiem ? `${day} ${a.text} to ${b.text} ${b.meridiem}` : `${day} ${a.text} ${a.meridiem} to ${b.text} ${b.meridiem}`;
}

/**
 * The event's start and end from the sentence's date and time spans, read against `now`. Null when the
 * spans name no time, a time that cannot be, or a moment already past.
 */
export function resolveEventTime(spans: readonly string[], now: Date): EventTime | null {
  const all = spans.join(" ");
  const lower = all.toLowerCase();
  if (/\b(yesterday|last)\b/.test(lower)) return null;
  if (ZONE.test(all) || BAD_CLOCK.test(all)) return null;
  for (const c of all.matchAll(CLOCK)) if (Number(c[1]) > 23 || Number(c[2]) > 59) return null;
  const tonight = /\btonight\b/.test(lower);
  const time = parseTime(all, tonight);
  if (time === null) return null;

  let start: Date;
  const at = (y: number, mo: number, d: number): Date => new Date(y, mo, d, time.h, time.m, 0, 0);
  const today = (): Date => at(now.getFullYear(), now.getMonth(), now.getDate());
  const md = MONTH_DAY.exec(all);
  const numeric = NUMERIC_DATE.exec(all);
  const wd = WEEKDAY.exec(all);
  if (md !== null || numeric !== null) {
    const month = md !== null ? MONTHS[(md[1] ?? md[5] ?? "").toLowerCase().slice(0, 3)] : Number(numeric?.[1]) - 1;
    const date = md !== null ? Number(md[2] ?? md[4]) : Number(numeric?.[2]);
    const yearText = md !== null ? (md[3] ?? md[6]) : numeric?.[3];
    if (month === undefined || month < 0 || month > 11 || date < 1 || date > 31) return null;
    const year = yearText === undefined ? now.getFullYear() : Number(yearText);
    start = at(year, month, date);
    if (start.getMonth() !== month) return null;
    // No stated year: a date already past is next year's. A stated one is kept, and the check below refuses it if past.
    if (yearText === undefined && start.getTime() < now.getTime() - 86_400_000) start = at(now.getFullYear() + 1, month, date);
  } else if (/\btomorrow\b/.test(lower)) {
    start = at(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  } else if (/\b(today|tonight)\b/.test(lower)) {
    start = today();
  } else if (wd !== null) {
    const want = WEEKDAYS[(wd[1] ?? "").toLowerCase()];
    if (want === undefined) return null;
    let ahead = (want - now.getDay() + 7) % 7;
    if (ahead === 0 && today().getTime() <= now.getTime()) ahead = 7;
    start = at(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
  } else {
    start = today();
    if (start.getTime() <= now.getTime()) start = at(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  }
  if (start.getTime() <= now.getTime()) return null;
  // A wall-clock time the clocks skip that day (a daylight-saving gap) comes back shifted by Date: none such is offered.
  if (start.getHours() !== time.h || start.getMinutes() !== time.m) return null;
  const end = time.end === null ? new Date(start.getTime() + DEFAULT_MINUTES * 60_000) : new Date(start.getFullYear(), start.getMonth(), start.getDate(), time.end.h, time.end.m, 0, 0);
  if (time.end !== null && (end.getHours() !== time.end.h || end.getMinutes() !== time.end.m)) return null;
  if (end.getTime() <= start.getTime()) return null;
  return { start: localIso(start), end: localIso(end), says: sayWhen(start, end, now) };
}
