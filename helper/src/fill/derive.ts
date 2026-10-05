// Values code derives from a span, deterministically, for fields that ask for part of it: the first, middle
// or last name of a full name, a full name from separate first and last names, and the street line, unit,
// city, state and ZIP code of an address (Q1 bugs 11 and 4; B24). Jev still chooses which value a field
// gets; code only offers the parts, and every part but a joined full name is a substring of the span it
// came from, so it traces to it. A name code cannot split without guessing (a single name, or four names
// with no particle to mark the surname) is not split: the field is left for the user, never guessed.
import { words } from "./kinds.ts";

export type NamePart = "first" | "middle" | "last" | "full";
export type AddressPart = "street" | "unit" | "city" | "state" | "zip";
export type FieldPart = NamePart | AddressPart;
/** A field's part as fill asks for it: fieldPart's parts, or (B27) a place's country, which only fill derives. */
export type FillPart = FieldPart | "country";

const FIRST = /\b(?:first|given|forename)\b/;
const MIDDLE = /\bmiddle\b/;
const LAST = /\b(?:last|surname|family)\b/;
/** A name field that names a company, a product or a thing, not a person. Written for common form labels, not measured. */
const NOT_PERSON = /\b(?:company|business|organi[sz]ation|employer|school|university|college|event|pet|user ?name|username|account|project|product|team|venue|brand|file|display|domain|site|website|street|city|hotel|bank)\b/;

/**
 * The part of a name or an address a field asks for, from its label words, or null when it asks for a
 * whole value or something else. `formHasCity`: a bare "Address" field beside a City field asks for the
 * street line, as checkout forms lay it out; without one it may want the whole address.
 */
export function fieldPart(label: string | null, formHasCity = false): FieldPart | null {
  if (label === null) return null;
  const s = label.toLowerCase();
  if (/\be-?mail\b|\bweb\b|\burl\b|\bip address\b/.test(s)) return null;
  if (/\bname\b/.test(s) || FIRST.test(s) || LAST.test(s) || MIDDLE.test(s)) {
    if (NOT_PERSON.test(s)) return null;
    if (FIRST.test(s)) return "first";
    if (MIDDLE.test(s)) return "middle";
    if (LAST.test(s)) return "last";
    return /\bname\b/.test(s) ? "full" : null;
  }
  if (/\b(?:apt|apartment|unit|suite)\b/.test(s)) return "unit";
  if (/\b(?:zip|postal|postcode)\b/.test(s)) return "zip";
  if (/\b(?:city|town)\b/.test(s)) return "city";
  if (/\b(?:state|province)\b/.test(s)) return "state";
  if (/\bstreet\b|\baddress line\b|\baddress 1\b/.test(s)) return "street";
  if (formHasCity && words(s).length === 1 && /\baddress\b/.test(s)) return "street";
  return null;
}

/** Words that open a surname: "Ana de la Cruz", "Ludwig van der Rohe". Compared without case. */
const PARTICLES = new Set(["van", "von", "der", "den", "de", "del", "della", "da", "di", "du", "la", "le", "bin", "ibn", "al", "st.", "ter", "ten", "dos", "das"]);
const HONORIFIC = /^(?:dr|mr|mrs|ms|mx|miss|prof|sir|dame|rev)\.?$/i;
const SUFFIX = /^(?:jr|sr|ii|iii|iv|v|phd|md|esq|dds|cpa)\.?$/i;

export type NameSplit = { kind: "split"; first: string; middle: string | null; last: string } | { kind: "ask"; reason: string };

/**
 * A person's full name split into first, middle and last, each a substring of `full` as written. An
 * honorific ("Dr.") and a suffix ("Jr.") are set aside. "Last, First" is read that way round. A surname
 * particle starts the last name ("de la Cruz"). One name, or four or more with no particle, is an ask:
 * which words are given names and which the surname is a guess there.
 */
export function splitName(full: string): NameSplit {
  const text = full.trim().replace(/\s+/g, " ");
  if (text === "" || /[\d@<>]/.test(text)) return { kind: "ask", reason: `'${text}' is not a person's name` };
  const comma = text.indexOf(",");
  if (comma > 0) {
    const last = text.slice(0, comma).trim();
    const given = text.slice(comma + 1).trim().split(" ").filter((w) => w !== "" && !SUFFIX.test(w) && !HONORIFIC.test(w));
    // Every word capitalized or a particle: "Okafor, my manager" is a name and a description, not "Last, First".
    const named = (w: string): boolean => /^\p{Lu}[\p{L}'’.-]*$/u.test(w) || PARTICLES.has(w.toLowerCase());
    if (last === "" || given.length === 0 || given.length > 3 || SUFFIX.test(last) || !last.split(" ").every(named) || !given.every(named)) return { kind: "ask", reason: `'${text}' does not say which name is the surname` };
    return { kind: "split", first: given[0] as string, middle: given.length > 1 ? given.slice(1).join(" ") : null, last };
  }
  let ws = text.split(" ");
  while (ws.length > 0 && HONORIFIC.test(ws[0] as string)) ws = ws.slice(1);
  while (ws.length > 0 && SUFFIX.test(ws[ws.length - 1] as string)) ws = ws.slice(0, -1);
  if (ws.length < 2) return { kind: "ask", reason: `'${text}' is a single name, so which field it goes in is the user's call` };
  if (!ws.every((w) => /^[\p{L}][\p{L}'’.-]*$/u.test(w))) return { kind: "ask", reason: `'${text}' is not a person's name` };
  const p = ws.findIndex((w, i) => i > 0 && PARTICLES.has(w.toLowerCase()));
  const lastStart = p > 0 ? p : ws.length - 1;
  if (p < 0 && ws.length >= 4) return { kind: "ask", reason: `'${text}' has ${ws.length} names and no particle, so the surname is a guess` };
  if (lastStart === ws.length - 1 && PARTICLES.has((ws[lastStart] as string).toLowerCase())) return { kind: "ask", reason: `'${text}' ends in a particle` };
  return { kind: "split", first: ws[0] as string, middle: lastStart > 1 ? ws.slice(1, lastStart).join(" ") : null, last: ws.slice(lastStart).join(" ") };
}

/** A full name from a first and a last name, as a form's single name field takes it. */
export function joinName(first: string, last: string): string {
  return `${first.trim()} ${last.trim()}`;
}

/** The part of a split name a field asks for, or null when the split has none (no middle name) or asked. */
export function namePart(split: NameSplit, part: NamePart): string | null {
  if (split.kind !== "split") return null;
  return part === "first" ? split.first : part === "middle" ? split.middle : part === "last" ? split.last : null;
}

const UNIT_AT_END = /^(.*?\S)\s+((?:apt|apartment|unit|suite|ste|#)\.?\s*[\w-]+)$/iu;
const UNIT_ALONE = /^(?:apt|apartment|unit|suite|ste|#)\.?\s*[\w-]+$/iu;
const ZIP = /^\d{5}(?:-\d{4})?$/u;
const US_STATES = new Set(
  "alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada ohio oklahoma oregon pennsylvania tennessee texas utah vermont virginia washington wisconsin wyoming"
    .split(" ")
    .concat(["new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "rhode island", "south carolina", "south dakota", "west virginia", "district of columbia"]),
);
const isState = (s: string): boolean => /^\p{Lu}{2}$/u.test(s) || US_STATES.has(s.toLowerCase());

/**
 * The parts of a comma-separated US-style address, each a substring of `text` as written: "4410 Speedway Apt 2,
 * Austin, Texas 78751" gives street "4410 Speedway", unit "Apt 2", city "Austin", state "Texas", zip "78751".
 * Null when the text is not such an address (no comma, or no house number first). A part the address does
 * not hold is absent.
 */
export function splitAddress(text: string): Partial<Record<AddressPart, string>> | null {
  const parts = text.split(",").map((p) => p.trim().replace(/\s+/g, " "));
  if (parts.length < 2 || !/^\d+[A-Za-z]?\s+\p{L}/u.test(parts[0] as string)) return null;
  const out: Partial<Record<AddressPart, string>> = {};
  const head = parts[0] as string;
  const u = UNIT_AT_END.exec(head);
  if (u !== null && u[1] !== undefined && u[2] !== undefined) {
    out.street = u[1];
    out.unit = u[2];
  } else out.street = head;
  let rest = parts.slice(1);
  if (rest[0] !== undefined && UNIT_ALONE.test(rest[0])) {
    if (out.unit !== undefined) return null;
    out.unit = rest[0];
    rest = rest.slice(1);
  }
  // The tail: "Texas 78751", "TX 78751", "TX", "78751", or "Texas" then "78751" as two parts.
  const tail = rest.at(-1);
  if (tail !== undefined) {
    const m = /^(.*?)\s*(\d{5}(?:-\d{4})?)$/u.exec(tail);
    if (m !== null && m[2] !== undefined && ZIP.test(m[2])) {
      out.zip = m[2];
      const st = (m[1] ?? "").trim();
      if (st !== "" && isState(st)) out.state = st;
      else if (st !== "") return null;
      rest = rest.slice(0, -1);
      if (out.state === undefined && rest.length > 0 && isState(rest.at(-1) as string)) {
        out.state = rest.at(-1) as string;
        rest = rest.slice(0, -1);
      }
    } else if (isState(tail)) {
      out.state = tail;
      rest = rest.slice(0, -1);
    }
  }
  // The city is the one plain-words part left before the state or ZIP code.
  if (rest.length === 1 && /^\p{L}[\p{L} .'’-]*$/u.test(rest[0] as string) && (out.state !== undefined || out.zip !== undefined)) out.city = rest[0] as string;
  else if (rest.length > 1) return null;
  return out;
}

/** Whether a field asks for a country ("Country", "Country of residence"), not a country code. Written for common form labels, not measured. */
export function asksCountry(label: string | null): boolean {
  if (label === null) return false;
  const s = label.toLowerCase();
  return /\bcountry\b/.test(s) && !/\b(?:code|calling|dial(?:ling)?)\b/.test(s);
}

const PLACE_WORDS = /^\p{L}[\p{L} .'’-]*$/u;

/**
 * The city, state and country of a place written "City, State" or "City, State, Country", as a note's "Location:
 * Oakland, California, United States (in the Bay Area)" says it (B27: Greenhouse's Country and City dropdowns). The
 * second part must be a US state, which is what tells a place from a list of names or a "Last, First" name; a remark in
 * parentheses closing the last part is left out. Each part is a substring of `text`. Null for anything else, or when
 * a part is not plain words.
 */
export function splitPlace(text: string): { city: string; state: string; country: string | null } | null {
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  parts[parts.length - 1] = (parts.at(-1) as string).replace(/\s*\([^()]*\)$/u, "");
  if (!parts.every((p) => PLACE_WORDS.test(p) && text.includes(p)) || !isState(parts[1] as string)) return null;
  return { city: parts[0] as string, state: parts[1] as string, country: parts[2] ?? null };
}

/**
 * Whether a value reads as the part of a name or an address a field asks for: a person's full name splits
 * (splitName), a first, middle or last name is words of letters, a ZIP code is five digits (or ZIP+4), a
 * state is letters, and a unit names one. Street and city are left to kinds.ts misfit, which already reads
 * them. A sentence in a name field ("Dr. Simone Achebe, my manager at Ridgeline") does not fit.
 */
export function partFits(part: FillPart, value: string): boolean {
  const v = value.trim();
  switch (part) {
    case "country":
      return PLACE_WORDS.test(v);
    case "full":
      return splitName(v).kind === "split";
    case "first":
    case "middle":
    case "last":
      return /^[\p{L}][\p{L}'’. -]*$/u.test(v) && v.split(" ").length <= 3;
    case "zip":
      return /^\d{5}(?:-\d{4})?$/u.test(v);
    case "state":
      return /^[\p{L}][\p{L} .]*$/u.test(v);
    case "unit":
      return UNIT_ALONE.test(v) || /^[\w-]{1,6}$/u.test(v);
    case "street":
    case "city":
      return true;
  }
}
