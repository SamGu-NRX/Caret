// What the user told Caret about themselves, as fill candidates (B17). Onboarding asks for a name and an
// email, which the helper keeps as typed About entries (patterns/memory.ts addTyped). A form field that
// asks for exactly that can then be filled from the entry with no window open, and the offer says it
// came from "what you told Caret". C1 adds the other details application forms ask for: a phone, an address
// and its parts as separate entries (Street, City, State, ZIP code, Country), a school, a degree, a
// graduation date, LinkedIn, GitHub and website links, and whether the user may work there and needs visa
// sponsorship, said as yes or no. Each kind is read from the entry's label, with its value's shape checked. An
// entry or a field about self-identification (gender, race, ethnicity, veteran status, disability), consent, or a
// value Caret never types (memory/sensitive.ts) is never matched.
//
// Code decides which fields an entry is offered to; Jev still chooses, and both asks must agree, as for
// any candidate (fill.ts). An entry is offered only to a field whose label words name nothing beyond
// the entry's own label and its kind: "Full name" and "Email address" get the user's Name and Email,
// while "First name", "Guest name", "Company name" and "Recipient email" never see them. The word lists
// below are written for common form labels, not measured on real forms. The section a field sits in
// ("Guest details") is left to Jev, which reads it in the field's descriptor.
import type { AboutFields } from "../patterns/memory.ts";
import { fieldKinds, textKind, words } from "./kinds.ts";
import { splitAddress, splitDate } from "./derive.ts";
import { labelKind, valueKind } from "../memory/sensitive.ts";

/** The source line of a value filled from memory; the host writes it after "from". */
export const ABOUT_SAYS = "what you told Caret";

export type AboutKind =
  | "name"
  | "email"
  | "phone"
  | "address"
  | "street"
  | "city"
  | "state"
  | "zip"
  | "country"
  | "school"
  | "degree"
  | "gradDate"
  | "linkedin"
  | "github"
  | "website"
  | "workAuth"
  | "sponsorship";

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

/**
 * Words of a label that say it is about self-identification or consent, which Caret never fills from memory (C1 brief):
 * an EEO question's answer is the user's to give each time, and a consent is never Caret's.
 */
const NEVER = new Set(["gender", "sex", "race", "racial", "ethnicity", "ethnic", "hispanic", "latino", "latina", "latinx", "veteran", "veterans", "military", "disability", "disabilities", "disabled", "transgender", "orientation", "pronouns", "pronoun", "consent", "agree", "terms", "privacy", "subscribe", "marketing", "newsletter", "certify", "acknowledge"]);
const never = (label: string | null): boolean => words(label).some((w) => NEVER.has(w));

/** A yes or no, as an entry says whether the user may work somewhere or needs sponsorship. */
const YES_NO = /^(?:yes|no)$/iu;
const URLISH = /^(?:https?:\/\/|www\.)\S+$|^(?:[\w-]+\.)*(?:linkedin|github)\.com\/\S+$/iu;
const PLACE_TEXT = /^\p{L}[\p{L} .'’-]*$/u;
const has = (ws: readonly string[], ...xs: string[]): boolean => xs.some((x) => ws.includes(x));

/**
 * What an entry can fill, or null. An email by the value's shape; every other kind by the label's words and the value's
 * shape: a name when the label says Name and the value reads as one (B17); C1's kinds as the table below reads them.
 * The more specific label wins: "School name" is a school, not a name. Self-identification, consent and a value Caret
 * never types are never a kind.
 */
export function aboutKind(label: string, value: string): AboutKind | null {
  const v = value.trim();
  if (never(label) || labelKind(label) !== null || valueKind(v) !== null) return null;
  if (EMAIL.test(v)) return "email";
  const ws = words(label);
  const url = URLISH.test(v);
  if (has(ws, "linkedin")) return url && /linkedin\.com\//iu.test(v) ? "linkedin" : null;
  if (has(ws, "github")) return url && /github\.com\//iu.test(v) ? "github" : null;
  if (has(ws, "website", "portfolio", "homepage", "blog", "site")) return url && !/(?:linkedin|github)\.com\//iu.test(v) ? "website" : null;
  if (url) return null;
  if (has(ws, "sponsorship", "sponsor", "visa")) return YES_NO.test(v) ? "sponsorship" : null;
  if (has(ws, "authorization", "authorisation", "authorized", "authorised", "eligibility", "eligible")) return YES_NO.test(v) ? "workAuth" : null;
  if (has(ws, "phone", "mobile", "cell", "telephone", "tel")) return textKind(v) === "phone" ? "phone" : null;
  if (has(ws, "graduation", "graduate", "grad")) return splitDate(v) !== null ? "gradDate" : null;
  if (has(ws, "school", "university", "college")) return v.length <= 80 && !/[\d@]/u.test(v) ? "school" : null;
  if (has(ws, "degree")) return v.length <= 60 && !/@/u.test(v) ? "degree" : null;
  if (has(ws, "zip", "postal", "postcode")) return /^(?:\d{5}(?:-\d{4})?|[A-Z]\d[A-Z] ?\d[A-Z]\d)$/u.test(v) ? "zip" : null;
  if (has(ws, "street")) return textKind(v) === "street" ? "street" : null;
  if (has(ws, "address")) return splitAddress(v) !== null || textKind(v) === "address" ? "address" : null;
  if (has(ws, "city", "town")) return PLACE_TEXT.test(v) && v.length <= 60 ? "city" : null;
  if (has(ws, "state", "province")) return PLACE_TEXT.test(v) && v.length <= 40 ? "state" : null;
  if (has(ws, "country")) return PLACE_TEXT.test(v) && v.length <= 60 ? "country" : null;
  if (ws.includes(NAME_WORD) && NAME.test(v) && v.length <= 60) return "name";
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
 * C1: for each kind beyond a name and an email, the words one of which a field's name must hold (`asks`), and the other
 * words it may hold (`may`) beside the entry's own label words, PLAIN and an unused qualifier. "Mobile phone" asks for a
 * phone; "Emergency contact phone" holds "emergency" and "contact", which no phone entry's label has, so it never sees
 * the user's phone. Written for common form labels, not measured.
 */
const FIELD_WORDS: Partial<Record<AboutKind, { asks: string[]; may: string[] }>> = {
  phone: { asks: ["phone", "telephone", "tel", "mobile", "cell"], may: ["number", "no", "mobile", "cell"] },
  address: { asks: ["address"], may: ["home", "current", "residential", "street", "permanent"] },
  street: { asks: ["street"], may: ["address", "line"] },
  city: { asks: ["city", "town"], may: [] },
  state: { asks: ["state", "province", "region"], may: [] },
  zip: { asks: ["zip", "postal", "postcode"], may: ["code"] },
  country: { asks: ["country"], may: ["residence"] },
  school: { asks: ["school", "university", "college", "institution"], may: ["name", "attended"] },
  degree: { asks: ["degree"], may: ["type", "level"] },
  gradDate: { asks: ["graduation", "grad"], may: ["date", "expected", "anticipated"] },
  linkedin: { asks: ["linkedin"], may: ["profile", "url", "link", "page"] },
  github: { asks: ["github"], may: ["profile", "url", "link", "page"] },
  website: { asks: ["portfolio", "personal"], may: ["website", "site", "web", "url", "link", "page"] },
};

/** Words a question about working somewhere or sponsorship uses that name a country. Written for common form questions, not measured. */
const COUNTRY_WORDS = new Set(["united", "states", "us", "usa", "america", "canada", "canadian", "uk", "kingdom", "britain", "eu", "europe", "european", "australia", "india", "germany", "france", "mexico", "ireland", "singapore", "japan"]);

/**
 * C1: whether a yes-or-no question asks what the entry answers: whether the user may work there ("Are you legally
 * authorized to work in the United States?") or needs sponsorship ("Will you now or in the future require
 * sponsorship…?"). The country a question names must be one the entry's label names: an entry "Work authorization: Yes"
 * that names none answers a question that names none ("…in your country of residence?"), never one about a named
 * country, which may not be the user's.
 */
function questionAsks(a: AboutValue, ws: ReadonlySet<string>): boolean {
  const sponsor = ws.has("sponsorship") || ws.has("sponsor") || ws.has("visa");
  const work = (ws.has("authorized") || ws.has("authorised") || ws.has("eligible") || ws.has("legally")) && ws.has("work");
  if (a.kind === "sponsorship" ? !sponsor : !work || sponsor) return false;
  const own = new Set(words(a.label));
  return [...ws].every((w) => !COUNTRY_WORDS.has(w) || own.has(w));
}

/**
 * Whether a field of this name asks for exactly what the entry holds. The name is the field's label, or
 * its nearest label or placeholder when it has none (fill.ts names fields the same way); the other two
 * are left out because a placeholder is often an example value ("you@example.com"). The name must say
 * the entry's kind ("name"; an email word; C1's FIELD_WORDS), and every other word in it must be in the
 * entry's label or say how the field is filled (PLAIN). A field about self-identification or consent never
 * asks for an entry (C1).
 */
export function fieldAsksFor(a: AboutValue, fieldName: string | null): boolean {
  const ws = new Set(words(fieldName));
  if (ws.size === 0 || never(fieldName)) return false;
  if (a.kind === "workAuth" || a.kind === "sponsorship") return questionAsks(a, ws);
  const own = new Set(words(a.label));
  const table = FIELD_WORDS[a.kind];
  if (table !== undefined) {
    if (!table.asks.some((w) => ws.has(w))) return false;
    for (const w of [...table.asks, ...table.may]) own.add(w);
  } else if (a.kind === "email") {
    if (!fieldKinds([fieldName]).has("email")) return false;
    // "E-mail" splits into "e" and "mail", and words() drops the one-letter part.
    own.add("email");
    own.add("mail");
  } else {
    if (!ws.has(NAME_WORD)) return false;
    own.add(NAME_WORD);
  }
  const qualified = [...own].some((w) => QUALIFIERS.has(w));
  // A phone a form calls work or business is not the phone a user gives as theirs unless the entry says so.
  const qualifier = (w: string): boolean => QUALIFIERS.has(w) && !(a.kind === "phone" && (w === "work" || w === "business"));
  for (const w of ws) if (!own.has(w) && !PLAIN.has(w) && !(qualifier(w) && !qualified)) return false;
  return true;
}

/**
 * C1: the controls an entry of each kind may fill. A text field takes any kind but a yes or no; a web dropdown takes a
 * school, a degree or a place, as an option's name; a menu takes those and a yes or no; a choice of options takes only
 * a yes or no. A box never takes a value from memory (fill.ts controlValue).
 */
export function aboutFits(a: AboutValue, control: string): boolean {
  const yesNo = a.kind === "workAuth" || a.kind === "sponsorship";
  const option = a.kind === "school" || a.kind === "degree" || a.kind === "city" || a.kind === "state" || a.kind === "country";
  switch (control) {
    case "text":
      return !yesNo;
    case "combobox":
      return option;
    case "select":
      return option || yesNo;
    case "radio":
      return yesNo;
    default:
      return false;
  }
}

/** How a request names an entry's kind (fill.ts describeAbout). */
export const ABOUT_KIND_SAYS: Record<AboutKind, string> = {
  name: "a name",
  email: "email",
  phone: "phone number",
  address: "address",
  street: "street address",
  city: "city",
  state: "state or province",
  zip: "ZIP or postal code",
  country: "country",
  school: "school",
  degree: "degree",
  gradDate: "graduation date",
  linkedin: "LinkedIn profile",
  github: "GitHub profile",
  website: "website",
  workAuth: "whether the user may work there, yes or no",
  sponsorship: "whether the user needs visa sponsorship, yes or no",
};

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
