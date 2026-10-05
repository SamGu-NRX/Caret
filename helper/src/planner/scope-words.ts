// Which part of a form an instruction asks for, in words code reads (B28 lead decision 1).
//
// A non-Jev intent maker's "whole form" used to stand on its word whenever no word of the instruction named a field.
// G1's blind held-out-2 run (heldout2-04, "just do my contact info up top") got "whole form" from the local maker,
// and Graduation Date and LinkedIn were filled. Now a whole form, or one section of it, stands without Jev only when
// the whole instruction, normalized, is a sentence of a small closed grammar (WHOLE_FORM, SECTION). Anything else
// goes to Jev's two asks (ask.ts confirmScope), or, beside a section phrase, to "Which fields do you mean?".
//
// Why a whole-sentence match: the first five versions searched an instruction for trusted phrases after removing
// where to copy from, the form's title and quoted text, then checked the words left over. Each removal rule was a
// new way to fail open, and each B28 review found another: a field hidden inside a source phrase ("fill.in my email
// on this form"), a restriction hidden inside the title ("fill out the email only" on a form titled "Email only"),
// quote characters the quote rule did not know. A sentence of the grammar holds no word the grammar does not list,
// so there is nothing to remove. The form's title is no longer read: "fill out the Northgate application" costs a
// Jev question, not a wrong fill.
//
// The grammar's word lists are written for the requests in the lead decision and B28's tests, not measured on a
// corpus. Every sentence they make is tested (test/scope-words.test.ts); adding a word needs a test for it.

import { fieldPart } from "../fill/derive.ts";
import { fieldKinds, words } from "../fill/kinds.ts";
import type { ValueKind } from "../protocol.ts";

/** One position in a sentence: the phrases that may stand there. */
export interface Slot {
  name: string;
  optional: boolean;
  phrases: readonly string[];
}

/** Every phrase "<prep> <owner> <noun>": where to copy from. */
const SOURCE_TAIL: readonly string[] = ["from", "using"].flatMap((prep) => ["my", "the"].flatMap((owner) => ["note", "notes", "email", "message", "document", "doc"].map((noun) => `${prep} ${owner} ${noun}`)));
const VERBS: readonly string[] = ["fill out", "fill in", "fill", "complete", "do"];

/** The sentences that ask for the whole form: "please fill out this form from my note". */
export const WHOLE_FORM: readonly Slot[] = [
  { name: "opener", optional: true, phrases: ["please", "can you"] },
  { name: "verb", optional: false, phrases: VERBS },
  {
    name: "object",
    optional: false,
    // "everything you can" is "everything" with "you can" after it: "fill in everything you can".
    phrases: ["this form", "the form", "this application", "the application", "this page", "the whole form", "the entire form", "everything", "everything you can", "all of it", "the rest", "what you can"],
  },
  { name: "for me", optional: true, phrases: ["for me"] },
  { name: "source", optional: true, phrases: SOURCE_TAIL },
];

/** A form field as a section phrase's meaning reads it: the label words fill reads (fill.ts proposeFill), and its name. */
export interface FieldWords {
  labelWords: readonly (string | null)[];
  name: string;
  /** Only a text field or a page's dropdown is read by its words; any other control fits no phrase. */
  typed: boolean;
}

/** A section phrase, and which of the form's sections has its meaning. */
export interface SectionPhrase {
  /** The phrase as the lead decision lists it. */
  says: string;
  /** Where it occurs in an instruction, normalized: used to see that an instruction names a part of the form at all. */
  re: RegExp;
  /** The section it means, by the form's section names in form order and the section of the form's first field. */
  pick(sections: readonly string[], firstFieldSection: string | null): string[];
  /**
   * The fields of that section the phrase itself asks for, or null when the phrase has no meaning of its own beyond
   * where the section is (B28b lead decision 2): the section's other fields go to Jev to confirm.
   */
  fits: ((f: FieldWords) => boolean) | null;
}

/** Value kinds (fill/kinds.ts) that are a way to reach someone: "contact info" asks for these. */
const CONTACT_KINDS: ReadonlySet<ValueKind> = new Set(["email", "phone", "url", "address"]);

/**
 * The words a plain contact field's name is made of (after kinds.ts words(), which drops "your", "my" and the like):
 * the words fieldKinds and fieldPart read a contact kind or part from, and words that only say which line or number.
 * A name with any other word is not plainly the user's contact detail: "Emergency contact phone" is someone else's,
 * and fieldPart reads "Family size" as a last name (B28b review). Written for those cases and common labels, not
 * measured; a word missing here costs that field a Jev question.
 */
const PLAIN_CONTACT_WORDS: ReadonlySet<string> = new Set([
  "first", "middle", "last", "given", "family", "surname", "forename", "full", "legal", "preferred", "name",
  "email", "mail", "address", "phone", "telephone", "tel", "mobile", "cell", "number",
  "url", "website", "web", "site", "homepage", "link",
  "street", "line", "city", "town", "state", "province", "zip", "postal", "postcode", "code", "apt", "apartment", "unit", "suite",
]);

/**
 * Whether a field is the user's contact information by fill's own readings of its label: a part of a name or an
 * address (fill/derive.ts fieldPart), or a kind of value (fill/kinds.ts fieldKinds) that is an email, a phone, a web
 * link or an address, and no kind that is not; and its name holds only PLAIN_CONTACT_WORDS. "Graduation Date" (a
 * date) is not; "LinkedIn Profile" names no kind fill knows (kinds.ts matches "link" only as a whole word), so it is
 * not either, and goes to Jev. An address part may also read as an ID, since kinds.ts takes "code" and "number" for
 * one: "ZIP code", "Unit number".
 */
export function isContactField(f: FieldWords): boolean {
  if (!f.typed || !words(f.name).every((w) => PLAIN_CONTACT_WORDS.has(w))) return false;
  const kinds = fieldKinds(f.labelWords);
  const part = fieldPart(f.name);
  if ([...kinds].some((k) => !CONTACT_KINDS.has(k) && !(k === "id" && part !== null))) return false;
  return kinds.size > 0 || part !== null;
}

/**
 * The section headings that are the user's own contact information or details, as a whole heading after
 * normalizeInstruction. A heading that only holds the word ("Emergency contact", "Reference details") is someone
 * else's: the sixth B28 review had "fill in my contact info only" fill an Emergency contact section without a question.
 */
const CONTACT_HEADING = /^(?:(?:your|my) )?contact(?: info| information| details)?$/u;
const DETAILS_HEADING = /^(?:(?:your|my) )?(?:personal )?details$|^personal info(?:rmation)?$|^about you$/u;
const headings = (sections: readonly string[], re: RegExp): string[] => sections.filter((n) => re.test(normalizeInstruction(n)));

/** Phrases that name a part of the form. None of them is a whole-form phrase. */
export const SECTION_WORDS: readonly SectionPhrase[] = [
  { says: "contact info", re: /\bcontact\s+(?:info|information|details)\b/u, pick: (s) => headings(s, CONTACT_HEADING), fits: isContactField },
  // "Up top" is the section the form starts with; a form whose first field sits under no heading has no such section.
  // It says where, not what: no field stands on it alone.
  { says: "up top", re: /\bup\s+top\b/u, pick: (_, first) => (first === null ? [] : [first]), fits: null },
  // "My details" has no kind set fill could read: a details section holds a birth date or a school as often as a name.
  { says: "my details", re: /\bmy\s+details\b/u, pick: (s) => headings(s, DETAILS_HEADING), fits: null },
];

const CONTACT_OBJECTS = ["my", "the"].flatMap((owner) => ["info", "information", "details"].map((noun) => `${owner} contact ${noun}`));
/** Each section object a SECTION sentence may hold, and the SECTION_WORDS phrases it uses. */
export const SECTION_OBJECTS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ...CONTACT_OBJECTS.map((o): [string, string[]] => [o, ["contact info"]]),
  ...CONTACT_OBJECTS.map((o): [string, string[]] => [`${o} up top`, ["contact info", "up top"]]),
  ["my details", ["my details"]],
  ["up top", ["up top"]],
]);

/** The sentences that ask for one section: "just do my contact info up top". */
export const SECTION: readonly Slot[] = [
  { name: "opener", optional: true, phrases: ["please", "can you", "just"] },
  { name: "verb", optional: false, phrases: VERBS },
  { name: "object", optional: false, phrases: [...SECTION_OBJECTS.keys()] },
  { name: "only", optional: true, phrases: ["only"] },
  { name: "for me", optional: true, phrases: ["for me"] },
  { name: "source", optional: true, phrases: SOURCE_TAIL },
];

// A phrase is lower-case letters separated by single spaces, so a sentence can only be matched word for word.
for (const slot of [...WHOLE_FORM, ...SECTION]) {
  for (const p of slot.phrases) if (!/^[a-z]+(?: [a-z]+)*$/u.test(p)) throw new Error(`scope-words: the '${slot.name}' phrase ${JSON.stringify(p)} is not lower-case words separated by single spaces`);
}

/**
 * The instruction as the grammar reads it: NFKC, lower case, every run of whitespace one space, trimmed, and one
 * trailing ".", "!" or "?" dropped. Nothing else is changed, so any other character keeps the instruction out of the
 * grammar. The original string is still what values and offsets come from.
 */
export function normalizeInstruction(instruction: string): string {
  return instruction.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim().replace(/[.!?]$/u, "");
}

/** The phrase each slot holds when all of `s` is a sentence of `grammar` ("" for a skipped optional slot), else null. */
export function parseSentence(s: string, grammar: readonly Slot[]): string[] | null {
  const from = (i: number, rest: string): string[] | null => {
    const slot = grammar[i];
    if (slot === undefined) return rest === "" ? [] : null;
    for (const p of slot.phrases) {
      // A phrase ends the sentence or is followed by one space and another phrase: "the form " is not a sentence.
      const left = rest === p ? "" : rest.startsWith(`${p} `) && rest.length > p.length + 1 ? rest.slice(p.length + 1) : null;
      if (left === null) continue;
      const tail = from(i + 1, left);
      if (tail !== null) return [p, ...tail];
    }
    if (!slot.optional) return null;
    const tail = from(i + 1, rest);
    return tail === null ? null : ["", ...tail];
  };
  return from(0, s);
}

/** Whether the whole instruction is a request for the whole form (WHOLE_FORM). */
export function asksForWholeForm(instruction: string): boolean {
  return parseSentence(normalizeInstruction(instruction), WHOLE_FORM) !== null;
}

/**
 * The part of the form the instruction names by a section phrase. `phrases` is empty when it uses none. `section`
 * is the one section every phrase it uses means. It is null, with `why`, when the instruction is not a SECTION
 * sentence ("skip my contact info", "only my email in contact info"), or a phrase means no section of this form, or
 * more than one, or two phrases disagree: then Caret asks which fields. `fits` holds for the fields of the section
 * a phrase the sentence uses asks for by its meaning ("contact info" and its contact fields); it holds for none when
 * no phrase used has a meaning of its own ("up top", "my details").
 */
export function namedSection(instruction: string, sections: readonly string[], firstFieldSection: string | null): { phrases: string[]; section: string | null; why: string | null; fits: (f: FieldWords) => boolean } {
  const none = (): boolean => false;
  const s = normalizeInstruction(instruction);
  const phrases = SECTION_WORDS.filter((p) => p.re.test(s)).map((p) => p.says);
  if (phrases.length === 0) return { phrases, section: null, why: null, fits: none };
  const parsed = parseSentence(s, SECTION);
  if (parsed === null) return { phrases, section: null, why: "it says more than which part of the form", fits: none };
  const used = SECTION_WORDS.filter((p) => (SECTION_OBJECTS.get(parsed[SECTION.findIndex((x) => x.name === "object")] ?? "") ?? []).includes(p.says));
  const picks = used.map((p) => p.pick(sections, firstFieldSection));
  const one = picks.length > 0 && picks.every((x) => x.length === 1) && new Set(picks.map((x) => x[0])).size === 1 ? (picks[0]?.[0] ?? null) : null;
  // "My contact info up top": "up top" says where, "contact info" says which fields.
  const meanings = used.flatMap((p) => (p.fits === null ? [] : [p.fits]));
  return { phrases, section: one, why: one === null ? "no one section of this form means that" : null, fits: one === null ? none : (f) => meanings.some((m) => m(f)) };
}

/**
 * Words that rule part of a request out (B28b lead decision 1). An instruction holding one ("fill out the email and
 * not phone", "do the contact section except phone") names fields or a section that it does not ask for, so naming
 * grants no trust: every field the maker chose needs Jev's two yeses (ask.ts confirmScope).
 *
 * The first twelve are the lead decision's list. The rest only add closure, each making a scope narrower: other
 * forms of the same words ("skipping", "leaving", "excluding"), negative contractions typed without the apostrophe
 * ("dont", "isnt"), and other words that rule something out ("omit", "ignore", "minus", "keep", "blank"). Written for
 * B28's probes, not measured on a corpus; a word here costs an instruction that holds it a Jev question per field.
 */
export const EXCLUSION_WORDS: readonly string[] = [
  "not", "n't", "except", "but", "without", "skip", "leave", "besides", "other than", "no", "don't", "instead",
  "skips", "skipped", "skipping", "leaves", "leaving", "left", "excepting", "exclude", "excludes", "excluded", "excluding",
  "omit", "omits", "omitted", "omitting", "ignore", "ignores", "ignored", "ignoring", "avoid", "avoids", "avoiding",
  "minus", "apart", "aside", "rather", "never", "nor", "neither", "none", "nothing", "keep", "keeps", "untouched",
  "unchanged", "blank", "empty", "alone", "save for",
  // B28b review: restrictions that put a field off or make it optional.
  "bar", "later", "optional", "unless", "less", "sans", "w/o", "wait", "hold",
  "dont", "doesnt", "didnt", "isnt", "arent", "wasnt", "werent", "cant", "cannot", "wont", "shouldnt", "wouldnt", "couldnt", "mustnt", "neednt", "aint", "havent", "hasnt",
];

/** Characters typed for an apostrophe; each is read as "'" before the words are looked for. */
const APOSTROPHES = /[‘’‚‛′‵ʹʻʼʽˈ`´＇՚Ꞌꞌ]/gu;
/** Symbols that rule a word out: "-phone", "!phone", "¬phone", "≠", a cross, a no-entry sign. */
const EXCLUSION_SIGNS = /(?:^|\s)[-–—!~]\p{L}|[¬≠✗✘✕✖❌❎🚫⛔]/u;

/**
 * The exclusion words, and signs, the instruction holds; empty when it holds none. The instruction is read as
 * normalizeInstruction reads it (NFKC, lower case), then with accents dropped and apostrophe look-alikes read as "'",
 * once with invisible format characters (a zero-width space, a soft hyphen) dropped and once with them read as a
 * space, so neither "n​ot" nor "email​not" hides a word. A letter outside a-z after that (another alphabet's
 * look-alike "о", a "ß") cannot be read for these words, so it counts as one.
 */
export function exclusionsIn(instruction: string): string[] {
  const base = normalizeInstruction(instruction).normalize("NFD").replace(/\p{M}/gu, "").replace(APOSTROPHES, "'");
  const found = new Set<string>();
  for (const s of [base.replace(/\p{Cf}/gu, ""), base.replace(/\p{Cf}/gu, " ")]) {
    for (const w of EXCLUSION_WORDS) {
      // "n't" closes a word, typed against it or apart ("isn't", "is n't", "do n 't"); every other entry stands as whole
      // words, with any run of non-letters between them.
      const body = w.split(" ").map((x) => x.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[^\\p{L}]+");
      const re = w === "n't" ? /n\s*'\s*t(?!\p{L})/u : new RegExp(`(?<!\\p{L})${body}(?!\\p{L})`, "u");
      if (re.test(s)) found.add(w);
    }
    if (EXCLUSION_SIGNS.test(s)) found.add("an exclusion sign");
    if (/[^\P{L}a-z]/u.test(s)) found.add("a letter outside a-z");
  }
  return [...found];
}
