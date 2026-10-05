// Dates and times for date and time fields (B24, Q1 bug 10), read by code from the span Jev picked. A date
// goes through the value resolver (values/resolve.ts), which asks rather than guesses: "03/04" with no known
// source locale, a relative day with no reference instant. A clock time is read here: an hour with am or pm,
// or a 24-hour time; "at 3" with neither could be morning or afternoon, so it is not read.
import { Temporal } from "@js-temporal/polyfill";
import { ValueResolver, type ResolveContext } from "../values/resolve.ts";
import { sayDate } from "../values/date-time.ts";

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

const MERIDIEM = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?\s*m\b\.?/giu;
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
