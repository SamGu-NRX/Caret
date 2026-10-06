// What the user told Caret about themselves, as fill candidates (B17). Onboarding asks for a name and an
// email, which the helper keeps as typed About entries (patterns/memory.ts addTyped). A form field that
// asks for exactly that can then be filled from the entry with no window open, and the offer says it
// came from "what you told Caret". C1 adds the other details application forms ask for: a phone, an address
// and its parts as separate entries (Street, City, State, ZIP code, Country), a school, a degree, a
// graduation date, LinkedIn, GitHub and website links, and whether the user may work there and needs visa
// sponsorship, said as yes or no. C2 adds a date of birth, a job title, a T-shirt size, dietary needs, a salary
// expectation, and how the user heard about a job (only that company's, when the entry names one). Each kind is read
// from the entry's label, with its value's shape checked. An
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
import { ADDRESS_LINE_2, splitAddress, splitDate } from "./derive.ts";
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
  | "sponsorship"
  | "birthDate"
  | "jobTitle"
  | "shirtSize"
  | "diet"
  | "salary"
  | "heard";

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

/** L1: whether a field's label asks a self-identification or consent question (NEVER's words), which is the user's to answer. */
export const isIdentityQuestion = (label: string): boolean => never(label);

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
  // C2 (lead decision 4): each new kind by a label of only its own few words, and the value's shape.
  const only = (allowed: ReadonlySet<string>): boolean => ws.every((w) => allowed.has(w));
  if (has(ws, "birth", "birthday", "birthdate", "dob")) return only(BIRTH_LABEL) && splitDate(v) !== null && /^\d{4}-\d{2}-\d{2}$|(?<!\d)\d{1,2}(?!\d)/u.test(v) ? "birthDate" : null;
  if (has(ws, "title")) {
    if (has(ws, "job", "position", "role", "current") && only(JOB_TITLE_LABEL)) return JOB_TITLE.test(v) && v.length <= 60 && v.split(/\s+/u).length <= 8 ? "jobTitle" : null;
  }
  if (has(ws, "shirt", "tshirt", "tee")) return only(SHIRT_LABEL) && SHIRT_SIZE.test(v) ? "shirtSize" : null;
  if (has(ws, "diet", "dietary")) return only(DIET_LABEL) && DIET.test(v) && v.length <= 40 && v.split(/\s+/u).length <= 5 ? "diet" : null;
  if (has(ws, "salary", "compensation", "pay")) return only(SALARY_LABEL) && has(ws, ...SALARY_EXPECTED) && MONEY.test(v) ? "salary" : null;
  if (has(ws, "heard", "hear")) return has(ws, "how", "where") && v.length <= 60 && v.split(/\s+/u).length <= 8 && !/[@\d]/u.test(v) ? "heard" : null;
  // A label with a word beyond its kind's few ("Sponsorship unnecessary") is no kind: which way it answers is a guess.
  if (has(ws, "sponsorship", "sponsor", "visa")) return YES_NO.test(v) && ws.every((w) => SPONSOR_LABEL.has(w)) ? "sponsorship" : null;
  if (has(ws, "authorization", "authorisation", "authorized", "authorised", "eligibility", "eligible")) return YES_NO.test(v) && ws.every((w) => AUTH_LABEL.has(w)) ? "workAuth" : null;
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

/**
 * C1 review: the only words a question about working somewhere may use, so the entry's yes or no answers exactly it:
 * "Are you legally authorized to work in your country of residence?". Any other word ("without", "Brazil", "have")
 * may change what yes means, so the field is the user's. A question that names a country must name it in words the
 * entry's label also has ("Authorized to work in the United States"). Written for common form questions, not measured.
 */
const WORK_WORDS = new Set(["are", "you", "legally", "currently", "authorized", "authorised", "eligible", "to", "work", "in", "the", "your", "country", "of", "residence", "for", "employment", "this", "role", "position", "job", "at", "any", "employer"]);
/** The same for sponsorship: "Will you now or in the future require sponsorship for employment visa status?". */
const SPONSOR_WORDS = new Set(["will", "you", "now", "or", "in", "the", "future", "require", "need", "sponsorship", "visa", "for", "employment", "status", "to", "work", "an", "a", "this", "role", "position", "job", "do", "would", "immigration", "eg", "h1b"]);
/**
 * The only words a work authorization or sponsorship entry's label may use, so its yes or no reads one way: "Work
 * authorization", "Authorized to work in the United States", "Needs visa sponsorship". A label with any other word
 * ("Sponsorship unnecessary", "not needed") may turn the answer around, so it is no kind (C1 review).
 */
const AUTH_LABEL = new Set(["work", "authorization", "authorisation", "authorized", "authorised", "eligibility", "eligible", "to", "in", "the", "legally", "status", "us", "usa", "united", "states", "america", "canada", "uk", "kingdom", "britain", "eu", "europe", "australia", "india", "germany", "france", "mexico", "ireland", "singapore", "japan"]);
const SPONSOR_LABEL = new Set(["needs", "need", "requires", "require", "required", "visa", "sponsorship", "sponsor", "for", "work", "employment", "in", "the", "us", "usa", "united", "states", "america", "canada", "uk", "kingdom", "britain", "eu", "europe", "australia", "india", "germany", "france", "mexico", "ireland", "singapore", "japan"]);

/**
 * C2 (lead decision 4): the only words a label of each new kind may use, so the entry is the user's own of that kind:
 * "Date of birth" but not "Spouse's date of birth", "Current job title" but not "Title", "Salary expectation" but not
 * "Current salary" or "Salary range". Written for common labels, not measured.
 */
const BIRTH_LABEL = new Set(["date", "birth", "birthday", "birthdate", "dob", "day"]);
const JOB_TITLE_LABEL = new Set(["job", "title", "current", "position", "role", "work", "present"]);
const SHIRT_LABEL = new Set(["shirt", "tshirt", "tee", "size"]);
const DIET_LABEL = new Set(["diet", "dietary", "needs", "need", "restrictions", "restriction", "requirements", "requirement", "preference", "preferences"]);
const SALARY_EXPECTED = ["expectation", "expectations", "expected", "desired", "requirement", "requirements", "target"];
const SALARY_LABEL = new Set(["salary", "compensation", "pay", "annual", "yearly", "base", ...SALARY_EXPECTED]);
/** The words of a question about how the user heard of a job that say nothing of which job (C2): the rest name it. */
const HEARD_WORDS = new Set(["how", "where", "did", "do", "hear", "heard", "about", "this", "job", "role", "position", "opportunity", "company", "posting", "us", "we", "learn", "learned", "find", "found", "out", "source", "first", "team"]);
/** A job title as written: letters first, at most eight words; no address, link or sentence. */
const JOB_TITLE = /^\p{L}[\p{L}\p{N} .,'’&/()+-]*$/u;
/** A T-shirt size as a size chart names it. */
const SHIRT_SIZE = /^(?:xxs|xs|s|m|l|xl|xxl|xxxl|[2-5]xl|x-?small|small|medium|large|x-?large|xx-?large|extra[- ]small|extra[- ]large)$/iu;
/** Dietary needs as named on a form: words only ("vegetarian", "gluten-free", "halal"). */
const DIET = /^\p{L}[\p{L} ,/'’-]*$/u;
/** An amount or a range of amounts, as a salary expectation is written ("$185,000", "$120k-$140k", "95000 USD"). */
const MONEY =
  /^(?:[$€£]\s?)?\d[\d,]*(?:\.\d{1,2})?\s?[kK]?(?:\s?(?:-|–|to)\s?(?:[$€£]\s?)?\d[\d,]*(?:\.\d{1,2})?\s?[kK]?)?(?:\s?(?:USD|EUR|GBP|CAD))?(?:\s?(?:per year|\/\s?(?:yr|year)|a year|annually|per annum))?$/iu;

/**
 * C2: for each new kind, the words one of which a field's name must hold (`asks`), one more of which it must also hold
 * (`also`, when given), and the other words it may hold beside the entry's own label words and PLAIN. "Job title" asks
 * for a job title; "Title" is a form of address as often, so it does not. "What are your salary expectations?" asks for
 * a salary expectation; "Salary range" states the job's. Written for common form labels, not measured.
 */
const C2_FIELDS: Partial<Record<AboutKind, { asks: string[]; also?: string[]; may: string[] }>> = {
  birthDate: { asks: ["birth", "birthday", "birthdate", "dob"], may: ["date", "day"] },
  jobTitle: { asks: ["title"], also: ["job", "position", "role", "current"], may: ["job", "position", "role", "current"] },
  shirtSize: { asks: ["shirt", "tshirt", "tee"], may: ["size"] },
  diet: { asks: ["diet", "dietary"], may: ["needs", "need", "restrictions", "restriction", "requirements", "requirement", "preferences", "preference", "any"] },
  salary: { asks: ["salary", "compensation", "pay"], also: SALARY_EXPECTED, may: ["what", "are", "annual", "yearly", "base", ...SALARY_EXPECTED] },
  heard: { asks: ["hear", "heard"], may: [...HEARD_WORDS] },
};

/**
 * C1: whether a yes-or-no question asks exactly what the entry answers: whether the user may work there, or needs
 * sponsorship. Every word of the question must be one such a question uses (WORK_WORDS, SPONSOR_WORDS) or one of the
 * entry's own label, and it must say "work" and "authorized" (or "eligible"), or "sponsorship" and "require" (or
 * "need"). Anything else is the user's to answer, since a yes there could mean the opposite.
 */
function questionAsks(a: AboutValue, ws: ReadonlySet<string>): boolean {
  const own = new Set(words(a.label));
  const allowed = a.kind === "sponsorship" ? SPONSOR_WORDS : WORK_WORDS;
  if (![...ws].every((w) => allowed.has(w) || own.has(w))) return false;
  return a.kind === "sponsorship"
    ? ws.has("sponsorship") && (ws.has("require") || ws.has("need"))
    : ws.has("work") && (ws.has("authorized") || ws.has("authorised") || ws.has("eligible"));
}

/**
 * Whether a field of this name asks for exactly what the entry holds. The name is the field's label, or
 * its nearest label or placeholder when it has none (fill.ts names fields the same way); the other two
 * are left out because a placeholder is often an example value ("you@example.com"). The name must say
 * the entry's kind ("name"; an email word; C1's FIELD_WORDS), and every other word in it must be in the
 * entry's label or say how the field is filled (PLAIN). A field about self-identification or consent never
 * asks for an entry (C1).
 */
export function fieldAsksFor(a: AboutValue, fieldName: string | null, formTitle: string | null = null): boolean {
  const ws = new Set(words(fieldName));
  if (ws.size === 0 || never(fieldName)) return false;
  if (a.kind === "workAuth" || a.kind === "sponsorship") return questionAsks(a, ws);
  const own = new Set(words(a.label));
  const c2 = C2_FIELDS[a.kind];
  if (c2 !== undefined) {
    if (!c2.asks.some((w) => ws.has(w)) || (c2.also !== undefined && !c2.also.some((w) => ws.has(w)))) return false;
    // How the user heard about one company ("how I heard about Kestrel Robotics") answers only that company's form: the
    // words naming it must be in the field's name or the form's window title (C2).
    if (a.kind === "heard") {
      const named = new Set([...ws, ...words(formTitle)]);
      if (![...own].every((w) => HEARD_WORDS.has(w) || named.has(w))) return false;
    }
    const allowed = new Set([...own, ...c2.asks, ...c2.may]);
    return [...ws].every((w) => allowed.has(w) || PLAIN.has(w));
  }
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
  // C2: a T-shirt size, dietary needs or how the user heard is an option's name as often as typed text.
  const choice = a.kind === "shirtSize" || a.kind === "diet" || a.kind === "heard";
  switch (control) {
    case "text":
      return !yesNo;
    case "combobox":
      return option || choice;
    case "select":
      return option || yesNo || choice;
    case "radio":
      return yesNo || choice;
    // C2: a date of birth or a graduation date, in the date or month input's own format (fill.ts controlValue).
    case "date":
      return a.kind === "birthDate" || a.kind === "gradDate";
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
  birthDate: "date of birth",
  jobTitle: "job title",
  shirtSize: "T-shirt size",
  diet: "dietary needs",
  salary: "salary expectation",
  heard: "how the user heard about the job",
};

/**
 * C2 (lead decision 5): the words that name each part of an address in a field's label ("Address line 1", "Apartment,
 * suite, etc.", "State / Province", "Postal code"). Written for common form labels, not measured.
 */
const ADDRESS_PART_WORDS: Record<"street" | "unit" | "city" | "state" | "zip", string[]> = {
  street: ["street", "address", "line"],
  unit: ["apt", "apartment", "unit", "suite", "etc", "floor", "address", "line"],
  city: ["city", "town"],
  state: ["state", "province", "region"],
  zip: ["zip", "postal", "postcode", "code"],
};

/**
 * C2 (lead decision 5): whether a field asks for one part of exactly the entry's address or date, so the part code
 * splits from it (fill.ts) is offered there. An address's part: the field's words are that part's and otherwise the
 * entry's own label's or PLAIN, so "City" and "ZIP code" get the user's Home address's parts and "Emergency contact
 * city" or "Billing ZIP code" none. A date's part: the field without its "month", "day" or "year" asks for the whole
 * entry (fieldAsksFor), so "Date of birth month" and "Birth year" get the user's Date of birth's, and a bare "Month"
 * nothing.
 */
export function fieldAsksForPart(a: AboutValue, fieldName: string | null, part: "street" | "unit" | "city" | "state" | "zip" | "month" | "day" | "year", formTitle: string | null = null): boolean {
  if (fieldName === null || never(fieldName)) return false;
  if (part === "month" || part === "day" || part === "year") {
    if (a.kind !== "birthDate" && a.kind !== "gradDate") return false;
    const all = words(fieldName);
    const rest = all.filter((w) => w !== part);
    return rest.length < all.length && fieldAsksFor(a, rest.join(" "), formTitle);
  }
  if (a.kind !== "address") return false;
  const ws = words(fieldName);
  const own = new Set(words(a.label));
  const named = ADDRESS_PART_WORDS[part];
  // The part's own word must be there: "address" or "line" alone names a street, never a unit; but the second address
  // line holds the unit (C2 review: "Address line 2" took the street).
  const line2 = ADDRESS_LINE_2.test(fieldName);
  if (part === "street" && line2) return false;
  const says = ws.some((w) => named.includes(w) && w !== "address" && w !== "line") || (part === "street" && ws.includes("address")) || (part === "unit" && line2);
  return says && ws.every((w) => named.includes(w) || own.has(w) || PLAIN.has(w));
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
