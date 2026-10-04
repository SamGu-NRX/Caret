// Time zones named in source text, and the instant a wall-clock time names in them. Section 4's rules:
//   - PT, ET, CT and MT are regions: America/Los_Angeles, America/New_York, America/Chicago and
//     America/Denver (MT is Denver's rules; Arizona's MST all year is the abbreviation MST, not MT).
//   - PST, PDT and the other single-meaning abbreviations are fixed offsets, not synonyms for a region.
//     One used on a date its region does not observe it ("PST" in July) conflicts, and asks.
//   - CST, IST and BST each name several zones; they resolve only when the source supplies a region.
//   - A region and an offset stated together must agree at that wall time, or the resolver asks.
//   - A wall time the clocks skip or repeat asks, with the real instants; it is never shifted.
import { Temporal } from "@js-temporal/polyfill";

export type ZoneToken =
  /** An IANA zone, or PT/ET/CT/MT mapped to one. `label` is the text as written. */
  | { kind: "region"; id: string; label: string }
  /** A fixed offset ("+02:00"). `region`: the zone whose rules the abbreviation belongs to, checked against the date. */
  | { kind: "offset"; offset: string; label: string; region?: string }
  /** An abbreviation with several meanings. */
  | { kind: "ambiguous"; label: string; candidates: readonly { region: string; offset: string }[] };

/** PT, ET, CT and MT, the US regional names section 4 maps, and the zones they are shown as. */
export const US_REGIONS: Readonly<Record<string, string>> = {
  PT: "America/Los_Angeles",
  ET: "America/New_York",
  CT: "America/Chicago",
  MT: "America/Denver",
};

/** Abbreviations with one meaning: their offset, and the region whose dates they must fit when one is listed. */
const FIXED: Readonly<Record<string, { offset: string; region?: string }>> = {
  PST: { offset: "-08:00", region: "America/Los_Angeles" },
  PDT: { offset: "-07:00", region: "America/Los_Angeles" },
  MST: { offset: "-07:00" }, // Arizona keeps MST all year, so July MST is not a conflict.
  MDT: { offset: "-06:00", region: "America/Denver" },
  CDT: { offset: "-05:00", region: "America/Chicago" },
  EST: { offset: "-05:00", region: "America/New_York" },
  EDT: { offset: "-04:00", region: "America/New_York" },
  AKST: { offset: "-09:00", region: "America/Anchorage" },
  AKDT: { offset: "-08:00", region: "America/Anchorage" },
  HST: { offset: "-10:00" },
  UTC: { offset: "+00:00" },
  GMT: { offset: "+00:00" },
  CET: { offset: "+01:00", region: "Europe/Berlin" },
  CEST: { offset: "+02:00", region: "Europe/Berlin" },
  EET: { offset: "+02:00", region: "Europe/Athens" },
  EEST: { offset: "+03:00", region: "Europe/Athens" },
  JST: { offset: "+09:00" },
  KST: { offset: "+09:00" },
  AEST: { offset: "+10:00" }, // Brisbane keeps AEST all year.
  AEDT: { offset: "+11:00", region: "Australia/Sydney" },
  NZST: { offset: "+12:00", region: "Pacific/Auckland" },
  NZDT: { offset: "+13:00", region: "Pacific/Auckland" },
};

/** Abbreviations with several meanings, each a region and the offset the abbreviation means there. */
const AMBIGUOUS: Readonly<Record<string, readonly { region: string; offset: string }[]>> = {
  CST: [
    { region: "America/Chicago", offset: "-06:00" },
    { region: "Asia/Shanghai", offset: "+08:00" },
    { region: "America/Havana", offset: "-05:00" },
  ],
  IST: [
    { region: "Asia/Kolkata", offset: "+05:30" },
    { region: "Europe/Dublin", offset: "+01:00" },
    { region: "Asia/Jerusalem", offset: "+02:00" },
  ],
  BST: [
    { region: "Europe/London", offset: "+01:00" },
    { region: "Asia/Dhaka", offset: "+06:00" },
  ],
};

const ABBREVIATIONS = [...Object.keys(US_REGIONS), ...Object.keys(FIXED), ...Object.keys(AMBIGUOUS)].sort((a, b) => b.length - a.length);
const IANA_AREAS = "Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc";

/**
 * One zone named in text, matched from the start of `text` (sticky). Abbreviations match in capitals only,
 * so "et" or "Best" are not read as zones. Order: an IANA id, a UTC/GMT offset, a bare offset, an
 * abbreviation.
 */
export const ZONE_SOURCE = `(?:${IANA_AREAS})\\/[A-Za-z_]+(?:\\/[A-Za-z_]+)?|(?:UTC|GMT)\\s*[+\\-\\u2212]\\s*\\d{1,2}(?::?\\d{2})?(?![\\d:])|[+\\-\\u2212]\\d{2}:?\\d{2}(?![\\d:])|(?:${ABBREVIATIONS.join("|")})(?![A-Za-z])`;

function isZoneId(id: string): boolean {
  try {
    Temporal.ZonedDateTime.from({ year: 2026, month: 1, day: 1, timeZone: id });
    return true;
  } catch {
    return false;
  }
}

/** "+2", "+02", "+0200" or "+02:00" as "+02:00"; null when it is not a real offset. */
function normalOffset(sign: string, hours: string, minutes: string | undefined): string | null {
  const h = Number(hours);
  const m = Number(minutes ?? "0");
  if (h > 14 || m > 59) return null;
  const s = sign === "+" ? "+" : "-";
  return `${s}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** The zone `text` names as a whole, or null when it names none Caret knows. */
export function zoneToken(text: string): ZoneToken | null {
  const t = text.trim();
  const region = US_REGIONS[t];
  if (region !== undefined) return { kind: "region", id: region, label: t };
  const fixed = FIXED[t];
  if (fixed !== undefined) return { kind: "offset", offset: fixed.offset, label: t, ...(fixed.region === undefined ? {} : { region: fixed.region }) };
  const amb = AMBIGUOUS[t];
  if (amb !== undefined) return { kind: "ambiguous", label: t, candidates: amb };
  const utc = /^(?:UTC|GMT)\s*([+\-−])\s*(\d{1,2})(?::?(\d{2}))?$/.exec(t) ?? /^([+\-−])(\d{2}):?(\d{2})$/.exec(t);
  if (utc !== null) {
    const offset = normalOffset(utc[1] as string, utc[2] as string, utc[3]);
    return offset === null ? null : { kind: "offset", offset, label: t };
  }
  if (new RegExp(`^(?:${IANA_AREAS})/`).test(t) && isZoneId(t)) return { kind: "region", id: t, label: t };
  return null;
}

/** A zone as `ResolveContext` gives one, an IANA id or a fixed offset, as a token. */
export function contextZone(id: string): ZoneToken | null {
  const offset = /^([+-])(\d{2}):(\d{2})$/.exec(id);
  if (offset !== null) {
    const o = normalOffset(offset[1] as string, offset[2] as string, offset[3]);
    return o === null ? null : { kind: "offset", offset: o, label: o };
  }
  return isZoneId(id) ? { kind: "region", id, label: id } : null;
}

/** An instant and how it reads in the zone it was read in. */
export interface Moment {
  /** UTC, "2026-10-20T22:00:00Z". */
  instant: string;
  /** The zone the text was read in: an IANA id, or "+02:00" for a fixed offset. */
  zone: string;
  /** The zone as the text named it ("PT", "UTC+2"), or the zone id when the text named none. */
  label: string;
  /** Wall-clock time in `zone`, "2026-10-20T15:00". */
  local: string;
  /** Offset from UTC at that instant in `zone`, "-07:00". */
  offset: string;
}

function moment(z: Temporal.ZonedDateTime, zone: string, label: string): Moment {
  return { instant: z.toInstant().toString(), zone, label, local: z.toPlainDateTime().toString({ smallestUnit: z.second === 0 ? "minute" : "second" }), offset: z.offset };
}

/** The wall time in a region: one moment, or the two real readings of a skipped or repeated time. */
function inRegion(wall: Temporal.PlainDateTime, id: string, label: string): { one: Moment } | { two: [Moment, Moment]; gap: boolean } {
  try {
    return { one: moment(wall.toZonedDateTime(id, { disambiguation: "reject" }), id, label) };
  } catch {
    const earlier = wall.toZonedDateTime(id, { disambiguation: "earlier" });
    const later = wall.toZonedDateTime(id, { disambiguation: "later" });
    // In a gap the two readings move the clock off the written time; in a repeat both keep it.
    const gap = !earlier.toPlainDateTime().equals(wall);
    return { two: [moment(earlier, id, label), moment(later, id, label)], gap };
  }
}

function atOffset(wall: Temporal.PlainDateTime, offset: string, label: string): Moment {
  return moment(wall.toZonedDateTime(offset), offset, label);
}

/** The offsets a region has at a wall time: one, two in a repeat, or none in a gap. */
function offsetsAt(wall: Temporal.PlainDateTime, id: string): string[] {
  const r = inRegion(wall, id, id);
  if ("one" in r) return [r.one.offset];
  return r.gap ? [] : r.two.map((m) => m.offset);
}

function readings(wall: Temporal.PlainDateTime, id: string, label: string): Moment[] {
  const r = inRegion(wall, id, label);
  return "one" in r ? [r.one] : r.two;
}

export type ZoneResult = { kind: "ok"; moment: Moment; assumption?: string } | { kind: "ask"; question: string; moments: Moment[] } | { kind: "unsupported"; reason: string };

/**
 * The instant a wall time names, given the zones the text states and, when it states none, the source's
 * zone (`source`, null when it cannot be established). `fallback` is the user's own zone, offered as the
 * one choice when the source's zone is unknown.
 */
export function placeWall(wall: Temporal.PlainDateTime, stated: readonly ZoneToken[], source: ZoneToken | null, fallback: string): ZoneResult {
  const when = wall.toString({ smallestUnit: "minute" }).replace("T", " ");
  let tokens = [...stated];
  if (tokens.length === 0) {
    if (source === null) {
      return { kind: "ask", question: `Which time zone is ${when} in? The source names none.`, moments: readings(wall, fallback, fallback) };
    }
    tokens = [source];
  }
  // An abbreviation with several meanings takes the one the source's region, or a region stated beside it, supplies.
  const supplied = [...tokens.filter((t) => t.kind === "region"), ...(source === null ? [] : [source])];
  const settled: ZoneToken[] = [];
  for (const t of tokens) {
    if (t.kind !== "ambiguous") {
      settled.push(t);
      continue;
    }
    const match = t.candidates.find((c) => supplied.some((s) => (s.kind === "region" ? s.id === c.region : s.kind === "offset" && s.offset === c.offset)));
    if (match === undefined) {
      // Only the regions on that offset at that wall time: Israel is on IDT, not IST, in early October.
      const live = t.candidates.filter((c) => offsetsAt(wall, c.region).includes(c.offset));
      const offered = live.length > 0 ? live : t.candidates;
      return { kind: "ask", question: `${t.label} names several zones (${offered.map((c) => c.region).join(", ")}); which one is ${when} in?`, moments: offered.map((c) => atOffset(wall, c.offset, `${t.label} (${c.region})`)) };
    }
    settled.push({ kind: "offset", offset: match.offset, label: t.label, region: match.region });
  }
  const regions = [...new Map(settled.filter((t) => t.kind === "region").map((t) => [t.id, t])).values()];
  const offsets = [...new Map(settled.filter((t) => t.kind === "offset").map((t) => [t.offset, t])).values()];
  if (regions.length > 1 || offsets.length > 1) {
    const all = [...regions.flatMap((r) => readings(wall, r.id, r.label)), ...offsets.map((o) => atOffset(wall, o.offset, o.label))];
    return { kind: "ask", question: `The text names more than one zone (${settled.map((t) => t.label).join(", ")}); which is meant?`, moments: all };
  }
  const region = regions[0];
  const offset = offsets[0];
  if (offset !== undefined) {
    const check = region?.id ?? offset.region;
    if (check !== undefined && !offsetsAt(wall, check).includes(offset.offset)) {
      const regionLabel = region?.label ?? check;
      return {
        kind: "ask",
        question: `${offset.label} is UTC${offset.offset}, but ${check} is not on that offset at ${when}; which is meant?`,
        moments: [atOffset(wall, offset.offset, offset.label), ...readings(wall, check, regionLabel)],
      };
    }
    // A region and its offset together pin one instant; the region stays the zone it is shown in.
    if (region !== undefined) return { kind: "ok", moment: { ...atOffset(wall, offset.offset, region.label), zone: region.id } };
    return { kind: "ok", moment: atOffset(wall, offset.offset, offset.label) };
  }
  if (region === undefined) return { kind: "unsupported", reason: "no zone" };
  const r = inRegion(wall, region.id, region.label);
  if ("one" in r) return { kind: "ok", moment: r.one };
  const [a, b] = r.two;
  return {
    kind: "ask",
    question: r.gap
      ? `${when} does not happen in ${region.id}: the clocks skip it. Did you mean ${clock(a)} or ${clock(b)}?`
      : `${when} happens twice in ${region.id}: the clocks repeat it. The first (UTC${a.offset}) or the second (UTC${b.offset})?`,
    moments: [a, b],
  };
}

function clock(m: Moment): string {
  return `${m.local.slice(11)} (UTC${m.offset})`;
}
