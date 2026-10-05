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

/** A section phrase, and which of the form's sections has its meaning. */
export interface SectionPhrase {
  /** The phrase as the lead decision lists it. */
  says: string;
  /** Where it occurs in an instruction, normalized: used to see that an instruction names a part of the form at all. */
  re: RegExp;
  /** The section it means, by the form's section names in form order and the section of the form's first field. */
  pick(sections: readonly string[], firstFieldSection: string | null): string[];
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
  { says: "contact info", re: /\bcontact\s+(?:info|information|details)\b/u, pick: (s) => headings(s, CONTACT_HEADING) },
  // "Up top" is the section the form starts with; a form whose first field sits under no heading has no such section.
  { says: "up top", re: /\bup\s+top\b/u, pick: (_, first) => (first === null ? [] : [first]) },
  { says: "my details", re: /\bmy\s+details\b/u, pick: (s) => headings(s, DETAILS_HEADING) },
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
 * more than one, or two phrases disagree: then Caret asks which fields.
 */
export function namedSection(instruction: string, sections: readonly string[], firstFieldSection: string | null): { phrases: string[]; section: string | null; why: string | null } {
  const s = normalizeInstruction(instruction);
  const phrases = SECTION_WORDS.filter((p) => p.re.test(s)).map((p) => p.says);
  if (phrases.length === 0) return { phrases, section: null, why: null };
  const parsed = parseSentence(s, SECTION);
  if (parsed === null) return { phrases, section: null, why: "it says more than which part of the form" };
  const used = SECTION_OBJECTS.get(parsed[SECTION.findIndex((x) => x.name === "object")] ?? "") ?? [];
  const picks = SECTION_WORDS.filter((p) => used.includes(p.says)).map((p) => p.pick(sections, firstFieldSection));
  const one = picks.length > 0 && picks.every((x) => x.length === 1) && new Set(picks.map((x) => x[0])).size === 1 ? (picks[0]?.[0] ?? null) : null;
  return { phrases, section: one, why: one === null ? "no one section of this form means that" : null };
}
