// The value resolver (action-engine plan section 4): code, never a model, turns a span of source text
// into a date, a moment, an event's interval, a number, an ID or a unit conversion. Jev only picks the
// span. Every answer is one of three kinds: resolved, with the span it came from and any assumption
// made; ask, with the real possibilities when there are some; or unsupported, with the reason. Nothing
// uncertain is filled in silently.
//
// Civil time goes through @js-temporal/polyfill 0.5.1, pinned exactly in package.json: it was the newest
// release on 2026-10-04, Node 26.5 has no global Temporal, and a probe of that version confirmed the
// behavior used here (disambiguation and offset "reject" throw for Los Angeles 2026-03-08 02:30,
// 2026-11-01 01:30 and a wrong offset; "earlier" and "later" return the two real instants).
import { parseClock, parseDate, parseInterval, parseMoment, type Interval, type Moment } from "./date-time.ts";
import { parseNumber, type Decimal } from "./decimal.ts";
import { convertQuantity, type Quantity } from "./units.ts";

/** Changes whenever a rule changes what a span resolves to; derived values carry it. */
export const RESOLVER_VERSION = "values/1";

/** The source text a value was derived from: the quote, and the screen node it was read in when known. */
export interface ValueRef {
  quote: string;
  node?: string;
}

export type Resolution<T> =
  | { kind: "resolved"; value: T; display: string; evidence: ValueRef[]; assumptions: string[]; resolverVersion: string }
  | { kind: "ask"; question: string; alternatives: T[] }
  | { kind: "unsupported"; reason: string };

export interface ResolveContext {
  /** The user's display locale (BCP 47). It never decides how source text is read. */
  locale: string;
  /** The user's own IANA zone, the destination zone; never a numeric offset. */
  timeZone: string;
  /**
   * When the source was sent or written, ISO 8601 with Z or an offset. Relative days count from it.
   * Null when it cannot be established: a relative day then asks. (Section 4 types this as a string; null
   * is how a caller says it does not know, rather than passing "now".)
   */
  referenceInstant: string | null;
  /** The locale the source text was written in. Absent: unknown, so locale-dependent forms ask or refuse. */
  sourceLocale?: string;
  /**
   * The zone the source's times are read in when the text names none, and the zone its relative days are
   * counted in: an IANA id or a fixed offset such as "+02:00". Absent: `timeZone` (text the user is
   * typing). Null: the source's zone cannot be established, so an unzoned time or a relative day asks.
   */
  sourceTimeZone?: string | null;
}

export function resolved<T>(value: T, display: string, evidence: ValueRef[], assumptions: string[] = []): Resolution<T> {
  return { kind: "resolved", value, display, evidence, assumptions, resolverVersion: RESOLVER_VERSION };
}

export function ask<T>(question: string, alternatives: T[] = []): Resolution<T> {
  return { kind: "ask", question, alternatives };
}

export function unsupported<T>(reason: string): Resolution<T> {
  return { kind: "unsupported", reason };
}

function ref(span: string | ValueRef): ValueRef {
  return typeof span === "string" ? { quote: span } : span;
}

/** The resolver's entry points, one per kind of value. Each takes the span Jev or the reader selected. */
export class ValueResolver {
  /** A civil date ("2026-10-20"). Never shifted across zones. */
  date(span: string | ValueRef, ctx: ResolveContext): Resolution<string> {
    return parseDate(ref(span), ctx);
  }

  /** A time of day for a time field: "15:30". A span that names a zone, or a source in another zone, is unsupported. */
  clock(span: string | ValueRef, ctx: ResolveContext): Resolution<string> {
    return parseClock(ref(span), ctx);
  }

  /** One date and time of day, read in the zone the text names or the source's zone. */
  moment(span: string | ValueRef, ctx: ResolveContext): Resolution<Moment> {
    return parseMoment(ref(span), ctx);
  }

  /**
   * An event's start and end. A span with no end asks, unless `openEnd`, where it resolves with a null
   * end and the caller asks how long, with choices of its own.
   */
  interval(span: string | ValueRef, ctx: ResolveContext, opts: { openEnd?: boolean } = {}): Resolution<Interval> {
    return parseInterval(ref(span), ctx, opts.openEnd === true);
  }

  /** A number written in the source's locale, exactly. */
  number(span: string | ValueRef, ctx: ResolveContext): Resolution<Decimal> {
    return parseNumber(ref(span), ctx.sourceLocale);
  }

  /** An ID: kept as the string it is, leading zeros and all. */
  identifier(span: string | ValueRef): Resolution<string> {
    const r = ref(span);
    const text = r.quote.trim();
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/.test(text)) return unsupported(`"${text}" is not an ID: letters and digits, joined only by - . _ or /`);
    return resolved(text, text, [r]);
  }

  /** A quantity converted to `to`, exactly, or rounded to `precision` places when that is given. */
  convert(span: string | ValueRef, to: string, ctx: ResolveContext, precision?: number): Resolution<Quantity> {
    return convertQuantity(ref(span), to, ctx.sourceLocale, precision);
  }
}
