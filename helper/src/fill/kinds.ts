// What kind of value a form field asks for, read from its label words, and how many of a field's words
// a candidate's surroundings share. Fill uses the kinds to keep a privacy cut from leaving a decoy: when
// a window's budget cuts a date, no date field is asked with the dates that survived (fill.ts). The
// candidate generator uses the word overlap to spend a conversation's budget on the lines nearest each
// field's label first (candidates.ts).
import type { ValueKind } from "../protocol.ts";

/**
 * Label words that say a field takes a value of a kind; the reader's typed values use the same kinds
 * (apps/screen-reader TypedValues.swift). Written for the calibration forms' labels and common form
 * words, not measured on real forms: a field whose words are not here has no kind, and only the check
 * on the chosen value (fill.ts) guards it.
 */
const KIND_WORDS: readonly (readonly [ValueKind, RegExp])[] = [
  ["email", /\be-?mail\b/],
  ["url", /\b(?:url|website|web ?site|web address|homepage|link)\b/],
  ["phone", /\b(?:phone|telephone|tel|mobile|cell|fax)\b/],
  ["date", /\b(?:date|day|birthday|dob|deadline|due)\b/],
  ["time", /\b(?:time|hour)\b/],
  ["amount", /\b(?:amount|total|subtotal|price|cost|fee|balance|payment)\b/],
  ["address", /\b(?:address|street)\b/],
  ["id", /\b(?:id|number|ref|reference|tracking|invoice|ticket|confirmation|code)\b/],
];

/** A clock time inside a value: "3:00 PM", "15:00", "3 PM". */
const CLOCK = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b(?:1[0-2]|0?[1-9])\s?[ap]\.?m\b\.?/iu;

/**
 * The kinds a typed value holds: its own, and a time when it is a date that carries a clock time. The
 * reader types "October 8, 2026 at 3:00 PM" as one date (TypedValues.swift), so a cut that keeps it out
 * keeps a time out too, and a Start time field must not be asked with only the times that survived (B13
 * review).
 */
export function valueKinds(v: { kind: ValueKind; text: string }): ValueKind[] {
  return v.kind === "date" && CLOCK.test(v.text) ? ["date", "time"] : [v.kind];
}

/**
 * The kinds of value a field with these label words takes. An email or web address is not a postal
 * address, and a phone number is not an ID.
 */
export function fieldKinds(words: readonly (string | null | undefined)[]): Set<ValueKind> {
  const s = words.filter((w): w is string => typeof w === "string").join(" ").toLowerCase();
  const out = new Set<ValueKind>();
  for (const [kind, re] of KIND_WORDS) if (re.test(s)) out.add(kind);
  if (out.has("email") || out.has("url")) out.delete("address");
  if (out.has("phone")) out.delete("id");
  return out;
}

const STOP = new Set(["the", "an", "of", "to", "for", "and", "or", "in", "on", "at", "your", "you", "my", "our", "is", "with", "by", "from"]);

/** Lowercase words of two or more characters holding a letter, minus a few function words. */
export function words(s: string | null | undefined): string[] {
  if (s === null || s === undefined) return [];
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && /\p{L}/u.test(w) && !STOP.has(w));
}

/** A kind as a term, so a field and a candidate of the same kind share a term whatever their words. */
export const kindTerm = (k: ValueKind): string => `#${k}`;
export const isKindTerm = (t: string): boolean => t.startsWith("#");

/** A field's terms: its label words and the kinds they name. */
export function fieldTerms(labelWords: readonly (string | null | undefined)[]): Set<string> {
  const out = new Set(labelWords.flatMap(words));
  for (const k of fieldKinds(labelWords)) out.add(kindTerm(k));
  return out;
}

/** How many of a field's terms a candidate's terms hold. */
export function overlap(field: ReadonlySet<string>, cand: ReadonlySet<string>): number {
  let n = 0;
  for (const t of field) if (cand.has(t)) n++;
  return n;
}
