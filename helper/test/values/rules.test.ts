// The rules section 4 leaves to the resolver (date-time.ts, zones.ts, decimal.ts, units.ts headers), each
// with its one right answer. The independent corpus leaves these out on purpose, so they are pinned here.
import { describe, expect, it } from "vitest";
import { ValueResolver, type Resolution, type ResolveContext } from "../../src/values/resolve.ts";
import type { Interval, Moment } from "../../src/values/date-time.ts";
import { decimalString } from "../../src/values/decimal.ts";

const r = new ValueResolver();
// Monday 2026-10-05, 10:00 in Chicago.
const CTX: ResolveContext = { locale: "en-US", timeZone: "America/Chicago", referenceInstant: "2026-10-05T15:00:00Z", sourceLocale: "en-US" };

const instants = (x: Resolution<Moment>): string[] => (x.kind === "resolved" ? [x.value.instant] : x.kind === "ask" ? x.alternatives.map((m) => m.instant) : []);
const spans = (x: Resolution<Interval>): string[] => (x.kind === "resolved" ? [x.value] : x.kind === "ask" ? x.alternatives : []).map((i) => `${i.start.local}/${i.end?.local ?? "open"}`);

describe("dates with something left out", () => {
  it("reads a date without a year as the first one on or after the source's date, and says so", () => {
    const d = r.date("Oct 16", CTX);
    expect(d).toMatchObject({ kind: "resolved", value: "2026-10-16" });
    expect(d.kind === "resolved" && d.assumptions[0]).toMatch(/year 2026/);
    expect(r.date("Mar 4", CTX)).toMatchObject({ kind: "resolved", value: "2027-03-04" });
    expect(r.date("Oct 5", CTX)).toMatchObject({ kind: "resolved", value: "2026-10-05" });
    expect(r.date("Feb 29", CTX)).toMatchObject({ kind: "ask", alternatives: [] });
    expect(r.date("Oct 16", { ...CTX, referenceInstant: null })).toMatchObject({ kind: "ask" });
  });

  it("reads a bare weekday as its next one, and asks on that same weekday or for 'next'", () => {
    expect(r.date("Friday", CTX)).toMatchObject({ kind: "resolved", value: "2026-10-09" });
    expect(r.date("this Friday", CTX)).toMatchObject({ kind: "resolved", value: "2026-10-09" });
    expect(r.date("Monday", CTX)).toMatchObject({ kind: "ask", alternatives: ["2026-10-05", "2026-10-12"] });
    expect(r.date("next Friday", CTX)).toMatchObject({ kind: "ask", alternatives: ["2026-10-09", "2026-10-16"] });
  });

  it("asks when a weekday and a date disagree, and refuses two-digit years and impossible dates", () => {
    expect(r.date("Friday, October 22, 2026", CTX)).toMatchObject({ kind: "ask", alternatives: ["2026-10-22"] });
    expect(r.date("03/04/26", CTX).kind).toBe("unsupported");
    expect(r.date("Feb 30", CTX).kind).toBe("unsupported");
    expect(r.date("13/04/2026", { ...CTX, sourceLocale: undefined })).toMatchObject({ kind: "ask", alternatives: ["2026-04-13"] });
    expect(r.date("04/04/2026", { ...CTX, sourceLocale: undefined })).toMatchObject({ kind: "resolved", value: "2026-04-04" });
  });
});

describe("times of day", () => {
  it("asks AM or PM for a bare hour, and takes 24-hour forms and day-part words as given", () => {
    expect(instants(r.moment("Oct 20, 2026 at 3", CTX))).toEqual(["2026-10-20T08:00:00Z", "2026-10-20T20:00:00Z"]);
    expect(instants(r.moment("Oct 20, 2026 10:30", CTX))).toEqual(["2026-10-20T15:30:00Z", "2026-10-21T03:30:00Z"]);
    expect(r.moment("Oct 20, 2026 09:30", CTX)).toMatchObject({ kind: "resolved", value: { instant: "2026-10-20T14:30:00Z" } });
    expect(r.moment("Oct 20, 2026 15:00", CTX)).toMatchObject({ kind: "resolved", value: { instant: "2026-10-20T20:00:00Z" } });
    expect(r.moment("tonight at 8", CTX)).toMatchObject({ kind: "resolved", value: { local: "2026-10-05T20:00" } });
    expect(r.moment("tomorrow morning at 9", CTX)).toMatchObject({ kind: "resolved", value: { local: "2026-10-06T09:00" } });
    expect(r.moment("tonight at 12", CTX).kind).toBe("ask");
    expect(r.moment("tomorrow at noon", CTX)).toMatchObject({ kind: "resolved", value: { local: "2026-10-06T12:00" } });
    expect(r.moment("Oct 20, 2026 at midnight", CTX)).toMatchObject({ kind: "ask", alternatives: [{ local: "2026-10-20T00:00" }, { local: "2026-10-21T00:00" }] });
  });

  it("asks which day a time with no date is, offering the source's day and the next", () => {
    expect(r.moment("4:30 PM", CTX)).toMatchObject({ kind: "ask", alternatives: [{ local: "2026-10-05T16:30" }, { local: "2026-10-06T16:30" }] });
  });

  it("refuses times that cannot be and text it cannot read", () => {
    for (const t of ["Oct 20, 2026 13pm", "Oct 20, 2026 3:99", "Oct 20, 2026 3:5pm", "Oct 20, 2026 0pm", "Oct 20, 2026 24:10", "Oct 20, 2026 3pm in room 2", "Oct 20, 2026 3"]) {
      expect(r.moment(t, CTX).kind, t).toBe("unsupported");
    }
  });
});

describe("ranges", () => {
  it("carries an end's AM or PM back to a bare start, switching halves when the start would come after the end", () => {
    expect(spans(r.interval("Oct 20, 2026 3-4pm", CTX))).toEqual(["2026-10-20T15:00/2026-10-20T16:00"]);
    expect(spans(r.interval("Oct 20, 2026 11-1pm", CTX))).toEqual(["2026-10-20T11:00/2026-10-20T13:00"]);
    expect(spans(r.interval("Oct 20, 2026 3:00 to 4:30 PM", CTX))).toEqual(["2026-10-20T15:00/2026-10-20T16:30"]);
  });

  it("asks for every reading when the end's half of the day is not written, overnight ones included", () => {
    const x = r.interval("Oct 20, 2026 10am-2", CTX);
    expect(x.kind).toBe("ask");
    expect(spans(x).sort()).toEqual(["2026-10-20T10:00/2026-10-20T14:00", "2026-10-20T10:00/2026-10-21T02:00"]);
  });

  it("asks before reading a range as overnight, even in 24-hour form", () => {
    expect(r.interval("Oct 20, 2026 22:00-02:00", CTX)).toMatchObject({ kind: "ask", alternatives: [{ end: { local: "2026-10-21T02:00" } }] });
  });

  it("asks how long when there is no end, unless the caller takes an open end", () => {
    expect(r.interval("Oct 20, 2026 3:00 PM", CTX)).toMatchObject({ kind: "ask", alternatives: [] });
    expect(r.interval("Oct 20, 2026 3:00 PM", CTX, { openEnd: true })).toMatchObject({ kind: "resolved", value: { start: { local: "2026-10-20T15:00" }, end: null } });
    expect(spans(r.interval("Oct 20, 2026 at 3", CTX, { openEnd: true }))).toEqual(["2026-10-20T03:00/open", "2026-10-20T15:00/open"]);
  });
});

describe("zones", () => {
  it("asks when a fixed-offset abbreviation does not fit its region on that date", () => {
    expect(instants(r.moment("Jul 15, 2026 3:00 PM PST", CTX))).toEqual(["2026-07-15T23:00:00Z", "2026-07-15T22:00:00Z"]);
    expect(r.moment("Jan 15, 2026 3:00 PM PDT", CTX).kind).toBe("ask");
    expect(r.moment("Jul 15, 2026 3:00 PM CST", CTX).kind).toBe("ask");
    expect(r.moment("Jul 15, 2026 3:00 PM MST", CTX)).toMatchObject({ kind: "resolved", value: { instant: "2026-07-15T22:00:00Z", zone: "-07:00" } });
  });

  it("lets a stated offset settle a repeated hour in its region, and asks when it does not fit", () => {
    expect(r.moment("2026-11-01T01:30:00-08:00[America/Los_Angeles]", CTX)).toMatchObject({ kind: "resolved", value: { instant: "2026-11-01T09:30:00Z", zone: "America/Los_Angeles" } });
    expect(r.moment("Oct 20, 2026 3:00 PM PT UTC-8", CTX).kind).toBe("ask");
  });

  it("offers the user's own zone as the one choice when the source's zone is unknown", () => {
    expect(r.moment("Oct 20, 2026 3:00 PM", { ...CTX, sourceTimeZone: null })).toMatchObject({ kind: "ask", alternatives: [{ zone: "America/Chicago", instant: "2026-10-20T20:00:00Z" }] });
  });

  it("reads one zone written for a whole range the same way at both ends", () => {
    const x = r.interval("Oct 9, 2026 3pm to 4pm IST", CTX);
    expect(x.kind).toBe("ask");
    const pairs = x.kind === "ask" ? x.alternatives.map((i) => [i.start.offset, i.end?.offset]) : [];
    expect(pairs).toEqual([["+05:30", "+05:30"], ["+01:00", "+01:00"]]);
  });

  it("offers an ambiguous abbreviation only in regions that use it on that date", () => {
    // Israel is on IDT on Oct 9 and Ireland on GMT on Jan 15.
    expect(instants(r.moment("Oct 9, 2026 3:00 PM IST", CTX))).toEqual(["2026-10-09T09:30:00Z", "2026-10-09T14:00:00Z"]);
    expect(instants(r.moment("Jan 15, 2026 3:00 PM IST", CTX))).toEqual(["2026-01-15T09:30:00Z", "2026-01-15T13:00:00Z"]);
  });

  it("asks when the text names two different zones", () => {
    expect(r.moment("Oct 20, 2026 3:00 PM PT ET", CTX).kind).toBe("ask");
  });
});

describe("numbers and units", () => {
  const n = (text: string, sourceLocale?: string) => {
    const x = r.number(text, { ...CTX, sourceLocale });
    return x.kind === "resolved" ? decimalString(x.value) : x.kind;
  };

  it("keeps every digit and the written scale, and refuses what is not a plain number", () => {
    expect(n("12345678901234567890.123", "en-US")).toBe("12345678901234567890.123");
    expect(n("−1.234,50", "de-DE")).toBe("-1234.50");
    expect(n("1’234.5", "de-CH")).toBe("1234.5");
    expect(n("42")).toBe("42");
    for (const t of ["007", "1e5", "$5", "50%", "1,,234", "1.2.3", ""]) expect(n(t, "en-US"), t).toBe("unsupported");
    expect(n("1,5", "xx-YY")).toBe("unsupported");
  });

  it("rounds half away from zero only to a stated precision, and pads to it", () => {
    const c = (q: string, to: string, p?: number) => {
      const x = r.convert(q, to, CTX, p);
      return x.kind === "resolved" ? `${decimalString(x.value.value)}${x.value.rounded ? " rounded" : ""}` : x.kind;
    };
    expect(c("1 m", "in")).toBe("unsupported");
    expect(c("1 m", "in", 3)).toBe("39.370 rounded");
    expect(c("0.125 m", "cm", 1)).toBe("12.5");
    expect(c("1.5 ft", "in", 0)).toBe("18");
    expect(c("2.5 mm", "cm", 0)).toBe("0 rounded");
    expect(c("25 mm", "cm", 0)).toBe("3 rounded");
    expect(c("-25 mm", "cm", 0)).toBe("-3 rounded");
    expect(c("1 h", "min")).toBe("60");
    expect(c("1 km", "mi", 2)).toBe("0.62 rounded");
    expect(c("5 m", "min")).toBe("unsupported");
    expect(c("5 km", "mi", 13)).toBe("unsupported");
  });

  it("shows a rounded result as rounded, with its precision", () => {
    const x = r.convert("70 °F", "°C", CTX, 1);
    expect(x.kind === "resolved" && x.display).toBe("≈ 21.1 °C, rounded to 1 place");
  });

  it("keeps an ID as written", () => {
    expect(r.identifier(" 007341 ")).toMatchObject({ kind: "resolved", value: "007341" });
    expect(r.identifier("12 34").kind).toBe("unsupported");
  });
});

describe("review findings (D2-03 review)", () => {
  it("asks when a range's end falls in a skipped hour, even when only one reading is after the start", () => {
    const x = r.interval("2026-03-08 01:45 to 02:30 PT", CTX);
    expect(x.kind).toBe("ask");
    expect(x.kind === "ask" && x.question).toMatch(/skip/);
  });

  it("applies every zone a range states at its end, so a conflict there asks", () => {
    expect(r.interval("2026-03-08 01:30 to 03:30 PT UTC-8", CTX).kind).toBe("ask");
    expect(r.interval("2026-10-20 13:00 to 14:00 PT UTC-7", CTX)).toMatchObject({ kind: "resolved", value: { start: { instant: "2026-10-20T20:00:00Z" }, end: { instant: "2026-10-20T21:00:00Z" } } });
  });

  it("refuses an ISO time out of range instead of wrapping it, and keeps seconds", () => {
    expect(r.moment("2026-10-20T25:99Z", CTX).kind).toBe("unsupported");
    expect(r.moment("2026-10-20T15:00:45Z", CTX)).toMatchObject({ kind: "resolved", value: { instant: "2026-10-20T15:00:45Z", local: "2026-10-20T15:00:45" } });
    expect(r.moment("Oct 20, 2026 15:00:99 UTC", CTX).kind).toBe("unsupported");
    expect(r.moment("Oct 20, 2026 3:00:30 PM UTC", CTX)).toMatchObject({ kind: "resolved", value: { instant: "2026-10-20T15:00:30Z" } });
  });

  it("refuses a written time that contradicts a day-part word", () => {
    expect(r.moment("2026-10-20 15:00 morning", CTX).kind).toBe("unsupported");
    expect(r.moment("tonight at 9:00 AM", CTX).kind).toBe("unsupported");
    expect(r.moment("tomorrow afternoon at 2:00 PM", CTX)).toMatchObject({ kind: "resolved", value: { local: "2026-10-06T14:00" } });
    // A start's day part does not contradict an end whose half of the day is written.
    expect(r.interval("tomorrow morning at 11am to 1pm", CTX)).toMatchObject({ kind: "resolved", value: { start: { local: "2026-10-06T11:00" }, end: { local: "2026-10-06T13:00" } } });
    expect(r.interval("2026-10-21 morning at 09:00 to 2026-10-22 at 15:00", CTX)).toMatchObject({ kind: "resolved", value: { end: { local: "2026-10-22T15:00" } } });
  });

  it("reads numbers and dates by canonical language and region, and refuses a region it has no rules for", () => {
    const num = (t: string, l: string) => {
      const x = r.number(t, { ...CTX, sourceLocale: l });
      return x.kind === "resolved" ? decimalString(x.value) : x.kind;
    };
    expect(num("1,234", "es-MX")).toBe("1234");
    expect(num("1,234", "es-ES")).toBe("1.234");
    expect(num("1,234", "es")).toBe("unsupported");
    expect(num("1 234,5", "en-ZA")).toBe("unsupported");
    expect(num("1,234.5", "en-US-u-nu-latn")).toBe("1234.5");
    expect(num("2'345.6", "it-CH")).toBe("2345.6");
    expect(r.date("03/04/2026", { ...CTX, sourceLocale: "en-US-u-ca-gregory" })).toMatchObject({ kind: "resolved", value: "2026-03-04" });
    expect(r.date("03/04/2026", { ...CTX, sourceLocale: "en-Latn-US" })).toMatchObject({ kind: "resolved", value: "2026-03-04" });
    expect(r.date("03/04/2026", { ...CTX, sourceLocale: "en" }).kind).toBe("ask");
  });

  it("matches unit symbols by case, so a megalitre is never read as a millilitre", () => {
    expect(r.convert("1 ML", "L", CTX).kind).toBe("unsupported");
    expect(r.convert("1 mL", "L", CTX)).toMatchObject({ kind: "resolved", value: { unit: "L" } });
    expect(r.convert("1 Kilometre", "m", CTX)).toMatchObject({ kind: "resolved", value: { unit: "m" } });
    expect(r.convert("1 KM", "m", CTX).kind).toBe("unsupported");
  });
});

describe("provenance", () => {
  it("keeps the span it read and the resolver version on every resolved value", () => {
    const x = r.moment({ quote: "Oct 20, 2026 3:00 PM PT", node: "w1/k" }, CTX);
    expect(x).toMatchObject({ kind: "resolved", evidence: [{ quote: "Oct 20, 2026 3:00 PM PT", node: "w1/k" }], resolverVersion: "values/1" });
    expect(x.kind === "resolved" && x.display).toBe("Tue, Oct 20, 2026, 3:00 PM PT (UTC-07:00)");
  });
});
