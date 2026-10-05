// What the user told Caret about themselves, as fill candidates (B17). Onboarding asks for a name and an
// email, which the helper keeps as typed About entries (patterns/memory.ts addTyped). A form field that
// asks for exactly that can then be filled from the entry with no window open, and the offer says it
// came from "what you told Caret".
//
// Code decides which fields an entry is offered to; Jev still chooses, and both asks must agree, as for
// any candidate (fill.ts). An entry is offered only to a field whose label words name nothing beyond
// the entry's own label and its kind: "Full name" and "Email address" get the user's Name and Email,
// while "First name", "Guest name", "Company name" and "Recipient email" never see them. The word lists
// below are written for common form labels, not measured on real forms. The section a field sits in
// ("Guest details") is left to Jev, which reads it in the field's descriptor.
import type { AboutFields } from "../patterns/memory.ts";
import { fieldKinds, words } from "./kinds.ts";

/** The source line of a value filled from memory; the host writes it after "from". */
export const ABOUT_SAYS = "what you told Caret";

export type AboutKind = "name" | "email";

/** A typed About entry that can fill a field. */
export interface AboutValue {
  id: string;
  /** The entry's label as the user typed it ("Name", "Work email"). */
  label: string;
  value: string;
  kind: AboutKind;
}

/** One address: no spaces, one @, a dot in the domain (as memory.ts checks a typed email). */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
/** A typed name: one to six words of letters, with apostrophes, hyphens and periods; no digits or @. */
const NAME = /^[\p{L}][\p{L}'’.-]*(?: [\p{L}][\p{L}'’.-]*){0,5}$/u;
const NAME_WORD = "name";
/**
 * Words that say how a field is filled, not what it holds: "Full name (required)", "Email address". B24 added
 * the words that say which of the user's own addresses a form wants ("Work email", "Primary email"): on the
 * real-form corpus a demo request's "Work email" was offered no memory and took a colleague's address from
 * an open mail instead (evidence/screen/b24/before).
 */
const PLAIN = new Set(["full", "legal", "address", "required", "optional", "enter", "here", "please"]);
/**
 * Words that say which of the user's own emails or names a field wants. A field may use one when the entry's
 * label has none (the user gave one email) or has the same one: an entry labelled "Work email" never fills
 * "Personal email".
 */
const QUALIFIERS = new Set(["work", "business", "personal", "primary", "preferred", "best"]);
/** Words of a field that asks for one part of the user's name (B24, fill/derive.ts): "First name", "Last name / Surname". */
const NAME_PART_WORDS = new Set(["first", "given", "middle", "last", "surname", "family", "forename"]);

/** What an entry can fill, or null: an email when the value is one address, a name when the label says Name and the value reads as one. */
export function aboutKind(label: string, value: string): AboutKind | null {
  const v = value.trim();
  if (EMAIL.test(v)) return "email";
  if (words(label).includes(NAME_WORD) && NAME.test(v) && v.length <= 60) return "name";
  return null;
}

/** The typed, active About entries that can fill a field, each with its kind. Entries of any other source are use-instead values (preferences.ts). */
export function aboutValues(entries: readonly { id: string; fields: AboutFields }[]): AboutValue[] {
  const out: AboutValue[] = [];
  for (const e of entries) {
    if (e.fields.source !== "typed") continue;
    const kind = aboutKind(e.fields.label, e.fields.value);
    if (kind !== null) out.push({ id: e.id, label: e.fields.label, value: e.fields.value.trim(), kind });
  }
  return out;
}

/**
 * Whether a field of this name asks for exactly what the entry holds. The name is the field's label, or
 * its nearest label or placeholder when it has none (fill.ts names fields the same way); the other two
 * are left out because a placeholder is often an example value ("you@example.com"). The name must say
 * the entry's kind ("name"; an email word), and every other word in it must be in the entry's label or
 * say how the field is filled (PLAIN).
 */
export function fieldAsksFor(a: AboutValue, fieldName: string | null): boolean {
  const ws = new Set(words(fieldName));
  if (ws.size === 0) return false;
  const own = new Set(words(a.label));
  if (a.kind === "email") {
    if (!fieldKinds([fieldName]).has("email")) return false;
    // "E-mail" splits into "e" and "mail", and words() drops the one-letter part.
    own.add("email");
    own.add("mail");
  } else {
    if (!ws.has(NAME_WORD)) return false;
    own.add(NAME_WORD);
  }
  const qualified = [...own].some((w) => QUALIFIERS.has(w));
  for (const w of ws) if (!own.has(w) && !PLAIN.has(w) && !(QUALIFIERS.has(w) && !qualified)) return false;
  return true;
}

/**
 * Whether a field asks for one part of the user's name (B24): its words are a name part's ("First name",
 * "Last name / Surname") and otherwise what fieldAsksFor allows, so "Guest first name" and "Emergency contact
 * last name" never see the user's name. Fill offers the part code split from a Name entry (derive.ts).
 */
export function fieldAsksForNamePart(a: AboutValue, fieldName: string | null): boolean {
  if (a.kind !== "name") return false;
  const ws = new Set(words(fieldName));
  if (![...ws].some((w) => NAME_PART_WORDS.has(w))) return false;
  const own = new Set(words(a.label));
  const qualified = [...own].some((w) => QUALIFIERS.has(w));
  for (const w of ws) if (!own.has(w) && !PLAIN.has(w) && !NAME_PART_WORDS.has(w) && w !== NAME_WORD && !(QUALIFIERS.has(w) && !qualified)) return false;
  return true;
}
