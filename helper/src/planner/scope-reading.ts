// Code's reading of which fields an Ask means (A1 lead decision 1). Before A1 the intent maker settled scope alone,
// and on B24, B25 and B26 about 9 asks in 10 ended "Which fields do you mean?" even when the words named the fields
// ("name + email only pls"), named a part of the form ("the landlord bit") or plainly meant all of it ("fill out the
// pizza order"). Now code reads the instruction against the form first, and the model only confirms that reading as
// one option among alternatives (intent-heads.ts); agreement acts, disagreement asks with the reading's fields among
// the choices (choices.ts).
//
// A reading exists only when code accounts for every word of the instruction, after the words that say where to copy
// from (sources.ts fieldWords), the people it names and the values it spells out are set aside. Each word must be:
//   - a field kind from the lexicon (TERMS): name, email, phone or number, address, contact info, birthday, graduation,
//     a slot; the owner word before it ("my", "his", "the landlord's") picks the user's fields or someone else's;
//   - the page's own label words: a field whose every word is said, or a word only one field has;
//   - a part of the form: a heading, a fieldset legend or a shared role prefix ("Landlord ...") the words name, and
//     "up top" for the first heading;
//   - a whole-form object ("everything you can", "the rest", "the pizza order", "this enrollment form");
//   - a value word (a weekday, a month, a number) or a filler word (FILLER: verbs of filling, pronouns, politeness).
// Any other word leaves code with no reading, and the maker's heads decide as before A1. So does an instruction that
// rules something out (scope-words.ts exclusions), names a kind Caret never types, asks for a press, or asks for text.
//
// Field ownership: a field whose label, heading or legend holds a role word (ROLE_WORDS: landlord, reference,
// emergency, guest, ...) is someone else's. "My name" never reads it, and "his number" reads only those. When a kind's
// fields cannot be told apart ("phone" on a form with Mobile phone and Home phone), there is no reading.
//
// The word lists are written for common requests and B24's development asks, not measured beyond them. A word missing
// from FILLER or the lexicon costs a question, never a write; a word wrongly in ROLE_WORDS does the same.
import type { Node } from "../protocol.ts";
import { fieldLabelText } from "../fill/descriptor.ts";
import { fieldPart } from "../fill/derive.ts";
import { dateShaped, timeShaped } from "../fill/kinds.ts";
import { mentionedKind } from "../memory/sensitive.ts";
import { asksPress } from "./says.ts";
import { exclusionsIn } from "./scope-words.ts";
import { fieldWords } from "./sources.ts";
import type { IntentField, IntentSnapshot } from "./intent.ts";

export interface ScopeReading {
  /** "all": every empty field Caret may type; "fields": the fields listed. */
  kind: "all" | "fields";
  /** The fields in scope, in document order. */
  fields: IntentField[];
  /** Values the instruction spells out, each tied to a field in `fields` by ref. */
  literals: { field: string; text: string }[];
  /** The heading, legend or prefix a section phrase matched, for logs only (never sent to a model). */
  section: string | null;
  /** The reading in plain words, as the model's option says it: field names only, which the snapshot's ledger took. */
  says: string;
  /** What each part of the reading came from, for logs and tests. */
  because: string[];
}

export type ReadResult = { reading: ScopeReading; why: null } | { reading: null; why: string };

const none = (why: string): ReadResult => ({ reading: null, why });

/** Words that say a field is someone else's. Written for common forms, not measured; it errs wide, since a role word missing here could let "my X" read another person's field. */
export const ROLE_WORDS: readonly string[] = [
  "landlord", "landlady", "reference", "referee", "referrer", "emergency", "guest", "recruiter", "spouse", "partner", "parent",
  "guardian", "recipient", "beneficiary", "advisor", "adviser", "supervisor", "manager", "cosigner", "roommate", "physician",
  "doctor", "dentist", "sponsor", "relationship", "attendee", "companion", "child", "dependent", "witness", "agent",
];
const ROLE = new RegExp(`\\b(?:${ROLE_WORDS.join("|")})s?\\b|\\bplus[ -]one\\b`, "gu");

/** Words that carry no meaning of their own in a request: verbs of filling, pronouns, articles, politeness, hedges. */
const FILLER = new Set([
  "fill", "filled", "filling", "put", "add", "enter", "type", "copy", "set", "make", "use", "using", "change", "update", "pick", "choose",
  "select", "do", "go", "get", "grab", "sign", "register", "book", "complete", "finish", "handle", "include", "insert", "paste", "drop",
  "pop", "plug", "give", "take", "mark", "tick", "rsvp", "sort", "stick", "need", "needs", "want", "wanna", "let",
  "in", "out", "up", "down", "on", "into", "onto", "over", "off", "with", "for", "to", "of", "at", "as", "by", "about", "from", "per",
  "the", "a", "an", "this", "that", "these", "those", "my", "our", "me", "i", "i'm", "i'd", "i'll", "we", "we'll", "we're", "we'd", "us",
  "you", "your", "it", "its", "them", "they", "their", "his", "her", "him", "she", "he", "one", "ones", "there", "here", "is", "are", "be",
  "please", "pls", "plz", "just", "only", "also", "too", "now", "then", "again", "actually", "ok", "okay", "can", "could", "would", "will",
  "kindly", "quickly", "more", "like", "so", "yeah", "hey", "thanks", "thx", "ahead", "already", "right", "well", "both", "each", "and",
  "or", "plus", "but", "instead", "done", "same", "should", "what", "which", "where", "when", "how", "know", "have", "has", "got",
  "bit", "part", "section", "stuff", "info", "information", "details", "area", "block", "portion", "field", "fields", "box", "boxes",
  "form", "page", "thing", "things", "all", "every", "whole", "entire", "rest", "everything", "anything", "whatever", "around", "approx",
  "approximately", "roughly", "about", "say", "goes", "go", "there's", "here's", "that's", "what's", "it'll", "gonna", "fit", "fits",
  "suit", "suits", "works", "getting", "gets", "coming", "come", "arrive", "arriving", "being",
]);

/** Words that are values Jev chooses or the instruction spells out: weekdays, months, parts of a day, numbers. */
const VALUE_WORD = /^(?:mon|tues?|wednes|wed|thurs?|thu|fri|satur|sat|sun)(?:day)?s?$|^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$|^(?:am|pm|morning|afternoon|evening|night|noon|tonight|tomorrow|today|weekend)$|^\d+(?:st|nd|rd|th)?$/u;
const WEEKDAY_OR_MONTH = /^(?:mon|tues?|wednes|wed|thurs?|thu|fri|satur|sat|sun)(?:day)?s?$|^(?:january|february|march|april|june|july|august|september|october|november|december)$/u;

/** Nouns that make a phrase the whole form when they head it: "the pizza order", "this enrollment form". */
const FORM_NOUNS = new Set(["form", "application", "app", "order", "registration", "enrollment", "enrolment", "request", "ticket", "booking", "reservation", "rsvp", "signup", "survey", "questionnaire", "checkout", "paperwork"]);
/** Nouns that make a phrase a part of the form when they head it: "the landlord bit", "the checkout details". */
const PART_NOUNS = new Set(["bit", "part", "section", "stuff", "info", "information", "details", "area", "block", "portion", "fields"]);
/** Words that end a form noun's name on the left: "fill in my email on [the] application". */
const DETERMINERS = new Set(["the", "this", "that", "my", "our", "your", "a", "an", "these", "those"]);
/** Section-name and label words that say nothing of which part or field it is. */
const GENERIC = new Set(["current", "your", "my", "our", "the", "and", "or", "of", "a", "an", "to", "if", "in", "for", "professional", "information", "info", "details", "about", "more", "other", "additional", "optional", "required", "choose", "any", "select", "section", "step", "who", "what", "how", "you", "we", "us", "all", "please", "enter"]);

/** Words that say a field's kind, never which part of the form: a part is not named by one of them alone. */
const KIND_WORDS = new Set(["date", "time", "name", "email", "phone", "number", "address", "day", "month", "year"]);

/** A word as compared: lower case, a plural's "s" dropped from longer words. */
const stem = (w: string): string => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") ? w.slice(0, -1) : w);
/** Words of a text: lower case, apostrophes as "'", "e-mail" as "email", other hyphens as spaces. */
const wordsIn = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[’‘`´]/gu, "'")
    .replace(/\be-mail/gu, "email")
    .split(/[^a-z0-9']+/u)
    .map((w) => w.replace(/^'+|'+$/gu, ""))
    .filter((w) => w !== "");
/** Words a label may hold that say nothing of which field it is; a section's naming words ("section", "details") stay. */
const LABEL_GENERIC = new Set([...GENERIC].filter((w) => !["section", "information", "info", "details", "current", "professional", "additional", "other"].includes(w)));
/** A label's words that tell it from others: no "(optional)", no generic words, plurals as singular. */
const labelWords = (name: string): string[] => [...new Set(wordsIn(name.replace(/\((?:optional|required)\)/giu, " ")).map((w) => stem(w.replace(/'s$/u, ""))).filter((w) => !LABEL_GENERIC.has(w) && w !== "s"))];

interface Tok {
  w: string;
  /** The word was said with "'s": "Gary's", "the landlord's". */
  possessive: boolean;
  used: string | null;
}

/** A part of the form: a heading, a fieldset legend or a shared role prefix, with the words that name it. */
interface Sec {
  name: string;
  keys: string[];
  fields: IntentField[];
  from: "heading" | "legend" | "prefix";
}

/** The text of a heading node: its label, else its first static text child's. */
function headingText(nodes: readonly Node[], h: Node): string | null {
  const own = fieldLabelText(h.label);
  if (own !== null) return own;
  const child = nodes.find((n) => n.parent === h.key && n.role === "AXStaticText");
  return fieldLabelText(child?.label ?? child?.value);
}

/** Each field's heading: the nearest heading before it in document order (the reader sends nodes in that order). */
export function headingsOf(snap: IntentSnapshot): Map<string, string | null> {
  const nodes = [...snap.window.nodes.values()];
  const keys = new Set(snap.fields.map((f) => f.key));
  const out = new Map<string, string | null>();
  let current: string | null = null;
  for (const n of nodes) {
    if (n.role === "AXHeading") current = headingText(nodes, n);
    else if (keys.has(n.key)) out.set(n.key, current);
  }
  return out;
}

const keysOf = (name: string): string[] => [...new Set(wordsIn(name.replace(/\([^)]*\)/gu, " ")).map((w) => stem(w.replace(/'s$/u, ""))).filter((w) => !GENERIC.has(w) && w !== "s" && !/^\d+$/u.test(w)))];

/** The form's parts: headings, fieldset legends (not one that only repeats its one field's label) and role prefixes. */
function sectionsOf(snap: IntentSnapshot, heading: Map<string, string | null>): Sec[] {
  const out: Sec[] = [];
  const add = (name: string, fields: IntentField[], from: Sec["from"]): void => {
    if (fields.length > 0) out.push({ name, keys: keysOf(name), fields, from });
  };
  for (const h of new Set(heading.values())) if (h !== null) add(h, snap.fields.filter((f) => heading.get(f.key) === h), "heading");
  for (const s of snap.sections) {
    const fs = snap.fields.filter((f) => f.section === s.name);
    if (fs.length === 1 && wordsIn(fs[0]?.name ?? "").join(" ") === wordsIn(s.name).join(" ")) continue;
    add(s.name, fs, "legend");
  }
  const prefixes = new Map<string, IntentField[]>();
  for (const f of snap.fields) {
    const m = /^(?:the\s+)?(emergency contact|[a-z]+)(?:'s)?\b/u.exec(f.name.toLowerCase().replace(/’/gu, "'"));
    const p = m?.[1];
    if (p !== undefined && new RegExp(ROLE.source, "u").test(p)) prefixes.set(p, [...(prefixes.get(p) ?? []), f]);
  }
  for (const [p, fs] of prefixes) if (fs.length >= 2) add(p, fs, "prefix");
  return out;
}

/** Whose a field is: someone else's when its label, heading or legend holds a role word. */
function ownerOf(f: IntentField, heading: Map<string, string | null>): { other: boolean; role: string | null } {
  for (const s of [f.name, heading.get(f.key) ?? "", f.section ?? ""]) {
    const m = new RegExp(ROLE.source, "u").exec(s.toLowerCase());
    if (m !== null) return { other: true, role: stem(m[0]) };
  }
  return { other: false, role: null };
}

/**
 * Who a term's fields belong to, by its words: the user, anyone else, or a role ("the landlord's phone"). `said` is
 * false for the user by default, when no owner word is near the term.
 */
type Owner = { other: false; said: boolean } | { other: true; role: string | null };
const POSSESSIVE_OTHER = new Set(["his", "her", "their", "hers", "theirs", "him"]);
const OWNER_SKIP = new Set(["the", "a", "an", "first", "last", "middle", "full", "legal", "given", "family", "best", "contact", "phone", "cell", "mobile", "work", "personal", "home", "office", "school", "primary", "main"]);

/**
 * The owner a term's words give, read from its first word back: "my" or nothing is the user; "his", "Gary's",
 * "the landlord's" or "landlord" right before the kind is someone else.
 */
function ownerAt(toks: readonly Tok[], first: number, last: number): Owner {
  for (let j = last; j >= Math.max(0, first - 3); j--) {
    const t = toks[j] as Tok;
    if (j < first && !OWNER_SKIP.has(t.w) && t.w !== "my" && t.w !== "our" && !POSSESSIVE_OTHER.has(t.w) && t.w !== "\u0001" && new RegExp(ROLE.source, "u").exec(t.w) === null) break;
    if (t.w === "my" || t.w === "our" || t.w === "me") return { other: false, said: true };
    if (POSSESSIVE_OTHER.has(t.w) || (t.w === "\u0001" && t.possessive)) return { other: true, role: null };
    const r = new RegExp(ROLE.source, "u").exec(t.w);
    if (r !== null) return { other: true, role: stem(t.w) };
  }
  return { other: false, said: false };
}

const ownerFits = (o: Owner, f: { other: boolean; role: string | null }): boolean => (o.other ? f.other && (o.role === null || f.role === o.role) : !f.other);

interface Ctx {
  snap: IntentSnapshot;
  heading: Map<string, string | null>;
  sections: Sec[];
}

const labelOf = (f: IntentField): string => f.name.toLowerCase().replace(/’/gu, "'");
const isEmail = (f: IntentField): boolean => /\be-?mail\b/u.test(labelOf(f));
const isPhone = (f: IntentField): boolean => /\b(?:phone|telephone|tel|mobile|cell|cellphone)\b/u.test(labelOf(f)) && !isEmail(f);
const NAME_PARTS = new Set(["first", "middle", "last", "full"]);
const isNameField = (f: IntentField): boolean => NAME_PARTS.has(fieldPart(f.name) ?? "") && !/\b(?:preferred|nick ?name|maiden|user ?name|display|pet|maker)\b/u.test(labelOf(f));
const ADDRESS_PARTS = new Set(["street", "unit", "city", "state", "zip"]);
function isAddress(ctx: Ctx, f: IntentField): boolean {
  const l = labelOf(f);
  if (isEmail(f) || /\b(?:web|url|ip)\b/u.test(l)) return false;
  const formHasCity = ctx.snap.fields.some((g) => fieldPart(g.name) === "city");
  if (ADDRESS_PARTS.has(fieldPart(f.name, formHasCity) ?? "") || /\baddress\b/u.test(l)) return true;
  // A country or region beside a street line, under the same heading: the address's own.
  if (!/\b(?:country|region)\b/u.test(l)) return false;
  const street = ctx.snap.fields.find((g) => fieldPart(g.name, formHasCity) === "street" || /\baddress\b/u.test(labelOf(g)));
  return street !== undefined && ctx.heading.get(street.key) === ctx.heading.get(f.key);
}
const isBirth = (f: IntentField): boolean => /\b(?:birth|dob|birthday|born)\b/u.test(`${labelOf(f)} ${(f.section ?? "").toLowerCase()}`);
const isControl = (f: IntentField, c: "date" | "time"): boolean => f.control === c || (f.control === "text" && new RegExp(`\\b${c}\\b`, "u").test(labelOf(f)));

/** Qualifier words that tell one email or phone from another, by the word the instruction uses. */
const QUALIFIERS: Record<string, readonly string[]> = {
  work: ["work", "business", "office"],
  business: ["work", "business", "office"],
  office: ["office", "work"],
  personal: ["personal", "home", "private"],
  home: ["home", "landline", "personal"],
  landline: ["home", "landline"],
  mobile: ["mobile", "cell", "cellphone"],
  cell: ["mobile", "cell", "cellphone"],
  school: ["school", "student", "edu"],
  alternate: ["alternate", "alternative", "backup", "secondary", "other"],
  alternative: ["alternate", "alternative", "backup", "secondary", "other"],
  backup: ["alternate", "alternative", "backup", "secondary", "other"],
  secondary: ["alternate", "alternative", "backup", "secondary", "other"],
  primary: ["primary", "main"],
  main: ["primary", "main"],
};
const QUALIFIER_WORDS = new Set(Object.values(QUALIFIERS).flat());

/** One email or phone by its qualifier: the fields whose label holds it; with none, the unqualified ones, else the one. Null when several differ. */
function byQualifier(fields: IntentField[], q: string | undefined): IntentField[] | null {
  if (q !== undefined) {
    const words = QUALIFIERS[q] ?? [q];
    return fields.filter((f) => wordsIn(f.name).some((w) => words.includes(w)));
  }
  const plain = fields.filter((f) => !wordsIn(f.name).some((w) => QUALIFIER_WORDS.has(w)));
  if (plain.length > 0) return plain;
  return fields.length <= 1 ? fields : null;
}

/** A field kind the lexicon reads. */
interface Term {
  id: string;
  /** Matched against the instruction's unread words, joined by single spaces. */
  re: RegExp;
  /** Whether a field is of this kind. */
  is(ctx: Ctx, f: IntentField): boolean;
  /** The kind's fields the match means, among the owner's: null when they cannot be told apart. */
  narrow(ctx: Ctx, fs: IntentField[], m: RegExpExecArray): IntentField[] | null;
}

const QUAL = "(?:(work|business|office|personal|home|mobile|cell|school|alternate|alternative|backup|secondary|primary|main|landline)\\s+)?";

const TERMS: readonly Term[] = [
  { id: "email", re: new RegExp(`\\b${QUAL}emails?(?:\\s+address(?:es)?)?\\b`, "gu"), is: (_, f) => isEmail(f), narrow: (_, fs, m) => byQualifier(fs, m[1]) },
  {
    id: "phone",
    re: new RegExp(`\\b${QUAL}(?:phone|telephone|cellphone|cell|mobile)(?:\\s+(?:number|no))?s?\\b|\\b(?:my|his|her|their|your|our|contact|best)\\s+numbers?\\b`, "gu"),
    is: (_, f) => isPhone(f),
    narrow: (_, fs, m) => {
      const said = m[0].split(" ");
      return byQualifier(fs, m[1] ?? (said.some((w) => w === "cell" || w === "mobile" || w === "cellphone") ? "mobile" : undefined));
    },
  },
  {
    id: "name",
    re: /\b(?:(first|given|last|family|middle|full|legal)\s+)?names?\b|\bsurname\b/gu,
    is: (_, f) => isNameField(f),
    narrow: (_, fs, m) => {
      const part = m[0] === "surname" ? "last" : ({ first: "first", given: "first", last: "last", family: "last", middle: "middle" } as Record<string, string>)[m[1] ?? ""];
      return part === undefined ? fs : fs.filter((f) => fieldPart(f.name) === part);
    },
  },
  {
    id: "address",
    re: /\b(?:(shipping|billing|mailing|home|street|postal|delivery)\s+)?address(?:es)?\b/gu,
    is: isAddress,
    narrow: (ctx, fs, m) => {
      const q = m[1];
      if (q === undefined || q === "street" || q === "postal") return fs;
      // A qualifier narrows to the address under a heading or label that says it, when the form has one; a form with one
      // address is that address.
      const hit = fs.filter((f) => [labelOf(f), (ctx.heading.get(f.key) ?? "").toLowerCase(), (f.section ?? "").toLowerCase()].some((s) => s.includes(q)));
      return hit.length > 0 ? hit : fs;
    },
  },
  {
    id: "contact",
    re: /\bcontact(?:\s+(?:info|information|details|stuff))?\b/gu,
    is: (ctx, f) => isNameField(f) || isEmail(f) || isPhone(f) || isAddress(ctx, f),
    // Under the form's one contact heading when it has one; two different ones cannot be told apart.
    narrow: (ctx, fs) => {
      const heads = ctx.sections.filter((s) => s.keys.includes("contact") && s.fields.every((f) => !ownerOf(f, ctx.heading).other));
      if (new Set(heads.map((s) => s.fields.map((f) => f.key).join("|"))).size > 1) return null;
      const head = heads[0];
      return head === undefined ? fs : fs.filter((f) => head.fields.includes(f));
    },
  },
  { id: "birth", re: /\b(?:birthday|birthdate|birth date|date of birth|dob|when i was born)\b/gu, is: (_, f) => isBirth(f), narrow: (_, fs) => fs },
  { id: "graduation", re: /\b(?:when i graduate|graduation(?: date)?|grad date|graduating|graduate)\b/gu, is: (_, f) => /\bgraduat/u.test(labelOf(f)), narrow: (_, fs) => fs },
  {
    id: "slot",
    re: /\b(?:time slot|slot|appointment|date and time|day and time)\b/gu,
    is: (_, f) => !f.filled && f.neverTyped === null && (isControl(f, "date") || isControl(f, "time")),
    narrow: (_, fs) => {
      const dates = fs.filter((f) => isControl(f, "date"));
      const times = fs.filter((f) => isControl(f, "time") && !dates.includes(f));
      return dates.length === 1 && times.length === 1 ? [...dates, ...times] : null;
    },
  },
];

/** Press words, without "checkout" as a noun ("the checkout details" names the form; "check out" is still a press). */
const pressAsked = (instruction: string): boolean => asksPress(instruction.replace(/\bcheckout\b/giu, " "));
/** Requests for new text, which a fill does not write: they go to the plan route as before A1. */
const COMPOSE = /\bwrite\s+(?:up|a|an|some|something|out)\b|\b(?:draft|compose|summari[sz]e|describe|explain|reword|rephrase|translate|reply|respond)\b/iu;

/**
 * The exclusion words of an instruction that rule a field or part out. Two of scope-words.ts's words sometimes do not,
 * and are set aside only then: "instead" not followed by "of" replaces a value ("make it 8:15 instead"), and "but"
 * followed by a time or a new value ("the Saturday Chris mentioned, but at 9:30", "but make it 7"). Any other "but"
 * still rules something out: "fill all fields but my email" (A1 review: reading "but" as a contrast unless it followed
 * a whole-form word read that as Email alone).
 */
export function readingExclusions(instruction: string): string[] {
  const kept = instruction.replace(/\binstead\b(?!\s+of\b)/giu, " ").replace(/\bbut\s+(?=(?:at|around|by)\s+\d|make\s+it\b)/giu, " ");
  return exclusionsIn(kept);
}

/**
 * Code's reading of the fields an instruction asks for on this form, or why there is none. Pure: it reads the
 * snapshot's fields, the form window's headings and the instruction.
 */
export function readScope(snap: IntentSnapshot): ReadResult {
  const instruction = snap.instruction;
  if (mentionedKind(instruction) !== null) return none("it names a kind Caret never types");
  if (pressAsked(instruction)) return none("it asks for a press");
  if (COMPOSE.test(instruction)) return none("it asks for new text");
  const ex = readingExclusions(instruction);
  if (ex.length > 0) return none(`it rules something out (${ex.join(", ")})`);

  // The field words: source phrases blanked (sources.ts), then the people and spelled-out values marked.
  let text = fieldWords(instruction);
  const mark = (span: string, as: string): boolean => {
    let found = false;
    for (let i = text.indexOf(span); i >= 0; i = text.indexOf(span, i + 1)) {
      if (/[\p{L}\p{N}]/u.test(text.charAt(i - 1)) || /[\p{L}\p{N}]/u.test(text.charAt(i + span.length))) continue;
      text = `${text.slice(0, i)} ${as}${" ".repeat(Math.max(0, span.length - as.length - 1))}${text.slice(i + span.length)}`;
      found = true;
    }
    return found;
  };
  const said = snap.literals.filter((l) => mark(l, "\u0002"));
  // "my guest", "my reference": a relation that is also a role names that role's fields, so its words stay to be read.
  for (const p of snap.persons) if (!/^(?:my|our)\s+\S+$/iu.test(p.span) || !new RegExp(ROLE.source, "u").test(p.span.toLowerCase())) mark(p.span, "\u0001");
  const toks: Tok[] = [];
  for (const m of text.matchAll(/\u0001(?:\s*['’]s\b)?|\u0002|[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)) {
    if (m[0] === "\u0002") continue;
    if (m[0].startsWith("\u0001")) {
      toks.push({ w: "\u0001", possessive: /s$/u.test(m[0]), used: "person" });
      continue;
    }
    for (const w of wordsIn(m[0])) toks.push({ w: w.replace(/'s$/u, ""), possessive: /'s$/u.test(w), used: null });
  }

  const heading = headingsOf(snap);
  const sections = sectionsOf(snap, heading);
  const ctx: Ctx = { snap, heading, sections };
  const owners = new Map(snap.fields.map((f) => [f.key, ownerOf(f, heading)]));
  const ownerOfField = (f: IntentField): { other: boolean; role: string | null } => owners.get(f.key) ?? { other: false, role: null };
  const picked: IntentField[] = [];
  const because: string[] = [];
  /** The owners the terms were read for: someone else's beside a user's by default ("her email and phone") is not read. */
  const ownersSaid: Owner[] = [];
  const owned = (o: Owner): Owner => (ownersSaid.push(o), o);
  const pick = (fs: readonly IntentField[], why: string): void => {
    for (const f of fs) if (!picked.includes(f)) picked.push(f);
    because.push(why);
  };
  const use = (is: readonly number[], why: string): void => {
    for (const i of is) {
      const t = toks[i];
      if (t !== undefined) t.used = why;
    }
  };
  /** Unread tokens by stem. */
  const unread = (): Map<string, number[]> => {
    const out = new Map<string, number[]>();
    toks.forEach((t, i) => {
      if (t.used === null) out.set(stem(t.w), [...(out.get(stem(t.w)) ?? []), i]);
    });
    return out;
  };

  // 0. A form noun names the whole form, and the words between it and its determiner are its name ("the pizza order").
  let formNoun = false;
  toks.forEach((t, i) => {
    if (t.used !== null || !FORM_NOUNS.has(t.w)) return;
    formNoun = true;
    const is = [i];
    for (let j = i - 1; j >= Math.max(0, i - 3) && !DETERMINERS.has(toks[j]?.w ?? "") && toks[j]?.used === null && !FILLER.has(toks[j]?.w ?? ""); j--) is.push(j);
    use(is, "form");
  });

  const nameWords = new Map(snap.fields.map((f) => [f.key, labelWords(f.name)]));
  // 1. A field whose every word is said, two words or more ("Reference email", "Date of birth", "Phone number"). A
  // field named within a longer named field's words is that one: "work email" names Work email, not Email too.
  {
    const s = unread();
    // The words must be said together, small words between allowed: "my phone in the landlord section" says "phone"
    // and "landlord" for two different things (A1 review).
    const together = (is: readonly number[]): boolean => {
      const lo = Math.min(...is);
      const hi = Math.max(...is);
      for (let i = lo; i <= hi; i++) if (!is.includes(i) && !["the", "of", "or", "a", "an", "s"].includes(toks[i]?.w ?? "")) return false;
      return true;
    };
    const full = snap.fields.filter((f) => {
      const ws = nameWords.get(f.key) ?? [];
      return ws.length >= 2 && ws.every((w) => s.has(w)) && together(ws.map((w) => (s.get(w) ?? [])[0] as number));
    });
    const longest = full.filter((f) => {
      const mine = nameWords.get(f.key) ?? [];
      return !full.some((g) => g !== f && (nameWords.get(g.key) ?? []).length > mine.length && mine.every((w) => (nameWords.get(g.key) ?? []).includes(w)));
    });
    for (const f of longest) {
      const is = (nameWords.get(f.key) ?? []).flatMap((w) => s.get(w) ?? []);
      // The owner by the words said, the label's own role word among them ("the landlord's phone").
      const o = owned(ownerAt(toks, Math.min(...is), Math.max(...is)));
      if (!ownerFits(o, ownerOfField(f))) return none(`'${f.name}' is said as ${o.other ? "someone else's" : "the user's"}, and the field is not`);
      pick([f], `label '${f.name}'`);
      use(is, "label");
    }
  }

  // 2. The lexicon's kinds, each read for its owner, then told apart by its qualifier.
  for (const term of TERMS) {
    const at: number[] = [];
    let s = "";
    for (const t of toks) {
      at.push(s.length + (s === "" ? 0 : 1));
      s = `${s}${s === "" ? "" : " "}${t.used === null ? t.w : "\u0003"}`;
    }
    for (const m of s.matchAll(term.re)) {
      const is = at.flatMap((a, i) => (a >= m.index && a < m.index + m[0].length ? [i] : []));
      if (is.length === 0) continue;
      const first = is[0] as number;
      const before = toks[first - 1]?.w ?? "";
      // "emergency contact" is a part of the form, not the user's contact details.
      if (term.id === "contact" && before === "emergency") continue;
      // "company name", "school name": not a person's name.
      if (term.id === "name" && m[1] === undefined && /^(?:company|business|organi[sz]ation|school|file|user|pet|account|project|product|team|event|venue|brand|display|domain|street|city|hotel|bank|course|plan|model)$/u.test(before)) continue;
      const o = owned(ownerAt(toks, first, is[is.length - 1] as number));
      const kind = snap.fields.filter((f) => term.is(ctx, f) && ownerFits(o, ownerOfField(f)));
      if (kind.length === 0) return none(`'${m[0]}' means no ${o.other ? "other person's" : "user's"} field of this form`);
      const fs = term.narrow(ctx, kind, m as RegExpExecArray);
      if (fs === null || fs.length === 0) return none(`'${m[0]}' could mean more than one ${term.id} field of this form, or none`);
      pick(fs, `${term.id} '${m[0]}'${o.other ? " (someone else's)" : ""}`);
      use(is, term.id);
    }
  }

  // 3. A part of the form the words name, then "up top", the first heading of a form with two or more. A part whose
  // every naming word is said comes first, the widest of those that nest ("emergency contact": the heading's three
  // fields over the label prefix's two). Otherwise a part some of whose words are said ("the employment bit" for
  // "Employment and income"), the narrowest of those that nest; a kind word alone ("date") names no part.
  let section: string | null = null;
  {
    const s = unread();
    const said = (x: Sec): string[] => x.keys.filter((k) => s.has(k));
    const full = sections.filter((x) => x.keys.length > 0 && said(x).length === x.keys.length);
    const partial = full.length > 0 ? [] : sections.filter((x) => said(x).some((k) => !KIND_WORDS.has(k)));
    const hits = full.length > 0 ? full : partial;
    if (hits.length > 0) {
      const best = Math.max(...hits.map((x) => said(x).length));
      const top = hits.filter((x) => said(x).length === best);
      const nests = (x: Sec, y: Sec): boolean => y.fields.every((f) => x.fields.includes(f));
      const chosen = full.length > 0 ? top.find((x) => top.every((y) => nests(x, y))) : top.find((x) => top.every((y) => nests(y, x)));
      if (chosen === undefined) return none(`the words name ${top.map((x) => `'${x.name}'`).join(" and ")}, which are different parts of the form`);
      const at = said(chosen).flatMap((k) => s.get(k) ?? []);
      // "my email in the applicant section": a part said after "in" or "under", beside fields already read, only says
      // where those fields are (A1 review: reading it as the whole part filled First and Last name too). Fields read
      // inside the part beside "only" or "just" are not read either way.
      const before = (i: number): string => {
        let j = i - 1;
        while (j >= 0 && ["the", "this", "that", "my", "your"].includes(toks[j]?.w ?? "")) j--;
        return toks[j]?.w ?? "";
      };
      const qualifies = picked.length > 0 && at.some((i) => ["in", "under", "within", "inside", "on"].includes(before(i)));
      const inside = picked.length > 0 && picked.every((f) => chosen.fields.includes(f));
      if (qualifies) {
        const kept = picked.filter((f) => chosen.fields.includes(f));
        if (kept.length === 0) return none(`none of the fields the words name is under '${chosen.name}'`);
        picked.splice(0, picked.length, ...kept);
        because.push(`under ${chosen.from} '${chosen.name}'`);
      } else if (inside && toks.some((t) => t.w === "only" || t.w === "just")) {
        return none(`the words name fields under '${chosen.name}' and the part too, beside "only"`);
      } else {
        const empty = chosen.fields.filter((f) => !f.filled);
        if (empty.length === 0) return none(`'${chosen.name}' has no empty field`);
        pick(empty, `${chosen.from} '${chosen.name}'`);
      }
      section = chosen.name;
      use(at, "section");
    }
    const up = toks.findIndex((t, i) => t.w === "up" && toks[i + 1]?.w === "top" && t.used === null);
    if (up >= 0) {
      const tops = [...new Set(snap.fields.map((f) => heading.get(f.key) ?? null))];
      const inFirst = (f: IntentField): boolean => (heading.get(f.key) ?? null) === (tops[0] ?? null);
      if (tops.length >= 2) {
        if (picked.length === 0) pick(snap.fields.filter((f) => inFirst(f) && !f.filled), "up top");
        else {
          const kept = picked.filter(inFirst);
          if (kept.length === 0) return none("'up top' holds none of the fields the words name");
          picked.splice(0, picked.length, ...kept);
          because.push("up top");
        }
      } else if (picked.length === 0) return none("'up top' on a form with no headings to tell its top from the rest");
      use([up, up + 1], "up top");
    }
  }

  // 4. A word of the page's own labels that only one field has ("degree", "linkedin", "gender").
  {
    const counts = new Map<string, number>();
    for (const ws of nameWords.values()) for (const w of ws) counts.set(w, (counts.get(w) ?? 0) + 1);
    const s = unread();
    for (const f of snap.fields) {
      // A filler word ("section", "form") names a field only when it is the field's whole label and no part was named:
      // "the saturday section" on a form with a Section field.
      const words = nameWords.get(f.key) ?? [];
      const own = words.filter((w) => counts.get(w) === 1 && !VALUE_WORD.test(w) && (!FILLER.has(w) || (words.length === 1 && section === null)));
      const is = own.flatMap((w) => s.get(w) ?? []).filter((i) => toks[i]?.used === null);
      if (is.length === 0) continue;
      const o = owned(ownerAt(toks, Math.min(...is), Math.max(...is)));
      if (!ownerFits(o, ownerOfField(f))) return none(`'${f.name}' is said as ${o.other ? "someone else's" : "the user's"}, and the field is not`);
      pick([f], `label word of '${f.name}'`);
      use(is, "label");
    }
  }

  // 4b. A word several labels share, said with an owner that only one of them fits: "her meal" is Guest's meal choice
  // beside Your meal choice.
  {
    const s = unread();
    for (const [w, is] of s) {
      if (FILLER.has(w) || VALUE_WORD.test(w) || KIND_WORDS.has(w)) continue;
      const withWord = snap.fields.filter((f) => (nameWords.get(f.key) ?? []).includes(w));
      if (withWord.length < 2) continue;
      const o = owned(ownerAt(toks, Math.min(...is), Math.max(...is)));
      const fits = withWord.filter((f) => ownerFits(o, ownerOfField(f)));
      if (fits.length !== 1) continue;
      pick(fits, `label word '${w}' (${o.other ? "someone else's" : "the user's"})`);
      use(is, "label");
    }
  }

  // One Ask fills one person's details (FillScope.person): fields read as someone else's beside fields read as the
  // user's, said or by default ("her email and phone", "my name and Simone's email"), are not read (A1 review).
  if (ownersSaid.some((o) => o.other) && ownersSaid.some((o) => !o.other)) return none("the words read some fields as someone else's and others as the user's");

  // 5. The values the instruction spells out: a time or a date to the one such field read, else the form's one; any
  // other value to the one field read. A value that fits no one field leaves code with no reading.
  const literals: { field: string; text: string }[] = [];
  for (const span of said) {
    const kind = timeShaped(span) ? "time" : dateShaped(span) ? "date" : null;
    let target: IntentField | undefined;
    if (kind !== null) {
      const read = picked.filter((f) => isControl(f, kind));
      const onForm = snap.fields.filter((f) => isControl(f, kind) && f.neverTyped === null);
      target = read.length === 1 ? read[0] : read.length === 0 && onForm.length === 1 ? onForm[0] : undefined;
    } else if (picked.length === 1) target = picked[0];
    if (target === undefined) return none(`'${span}' fits no one field the words name`);
    if (!picked.includes(target)) pick([target], `value '${span}'`);
    if (!literals.some((l) => l.field === target.ref)) literals.push({ field: target.ref, text: span });
  }
  // A weekday or a month with no date field read yet means the form's one empty date field.
  if (toks.some((t) => t.used === null && WEEKDAY_OR_MONTH.test(t.w)) && !picked.some((f) => isControl(f, "date"))) {
    const dates = snap.fields.filter((f) => isControl(f, "date") && !f.filled && f.neverTyped === null);
    if (dates.length === 1) pick(dates, "a weekday or a month");
  }

  // 6. A whole-form request, when no field or part is read: a verb of filling and a whole-form object.
  let whole = false;
  if (picked.length === 0) {
    const titleWords = new Set(wordsIn(snap.title ?? "").map(stem));
    const free = toks.filter((t) => t.used === null);
    const ws = free.map((t) => t.w);
    const has = (...xs: string[]): boolean => xs.every((x) => ws.includes(x));
    const verb = toks.some((t) => ["fill", "complete", "finish", "do", "get", "handle", "register", "rsvp", "sort"].includes(t.w));
    const titledPart = free.findIndex((t, j) => PART_NOUNS.has(t.w) && j > 0 && titleWords.has(stem(free[j - 1]?.w ?? "")));
    const object = formNoun || ws.some((w) => ["everything", "anything", "whatever", "rest"].includes(w)) || (has("all") && (has("it") || has("of"))) || has("what", "can") || titledPart >= 0 || (verb && (has("this") || (has("it") && (has("out") || has("in")))));
    if (verb && object) {
      whole = true;
      because.push("a whole-form request");
      if (titledPart >= 0) (free[titledPart - 1] as Tok).used = "form";
    }
  }

  // 7. Every word must be read: one code does not read leaves it with no reading.
  const inReading = new Set(picked.flatMap((f) => nameWords.get(f.key) ?? []));
  const left = toks.filter((t) => t.used === null && !FILLER.has(t.w) && !VALUE_WORD.test(t.w) && !inReading.has(stem(t.w)));
  if (left.length > 0) return none(`code does not read ${left.map((t) => `'${t.w}'`).join(", ")}`);
  if (whole) {
    const fields = snap.fields.filter((f) => !f.filled && f.neverTyped === null);
    if (fields.length === 0) return none("the form has no empty field Caret may type");
    return { reading: { kind: "all", fields, literals: [], section: null, says: "Fill every empty field of the form that Caret can.", because }, why: null };
  }
  if (picked.length === 0) return none("the words name no field, part or whole of this form");
  const fields = [...picked].sort((a, b) => snap.fields.indexOf(a) - snap.fields.indexOf(b));
  return { reading: { kind: "fields", fields, literals, section, says: `Fill only ${fields.length === 1 ? "this field" : "these fields"}: ${fields.map((f) => f.name).join("; ")}.`, because }, why: null };
}
