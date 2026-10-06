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
  if (m.kind !== "resolved") return null;
  const day = Temporal.PlainDate.from(m.value.local.slice(0, 10));
  return { value: day.toString(), display: sayDate(day) };
}

const MONTH_SAYS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * C2 (lead decision 1): the one month and year a span names (derive.ts monthYear), as an HTML month input holds it
 * (YYYY-MM) with how the host says it ("August 2022"); null when it names none or could name two.
 */
export function readMonth(text: string): { value: string; display: string } | null {
  const m = monthYear(text);
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
