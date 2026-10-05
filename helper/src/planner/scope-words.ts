// Which part of a form an instruction asks for, in words code reads (B28 lead decision 1).
//
// A non-Jev intent maker's "whole form" used to stand on its word whenever no word of the instruction named a field.
// G1's blind held-out-2 run (heldout2-04, "just do my contact info up top") got "whole form" from the local maker,
// and Graduation Date and LinkedIn were filled. Now a whole form stands on the instruction's words only when they
// ask for it in a phrase on WHOLE_FORM_WORDS; otherwise Jev's two asks must confirm it (ask.ts confirmScope).
// A phrase that names a part of the form (SECTION_WORDS) is never the whole form: it maps to the form's section of
// that meaning, or Caret asks which fields.
//
// Beside either kind of phrase, only words on a short list of filler may stand (FILLER, SECTION_FILLER). Any other
// word, or any quoted text, may narrow the request, so the words alone do not settle it. The first version instead
// looked for the form's field labels in the rest of the instruction, and that failed open: "just fill my email on
// this form" named no label on a form whose field reads "E-mail address", and "only the second box in contact info"
// or "avoid my contact info" named none at all (B28 reviews).
//
// The lists are short on purpose and each entry has a test (test/scope-words.test.ts). None was measured on a corpus;
// adding a phrase or a filler word needs a test that shows the instruction it is for.
import { fieldWords } from "./sources.ts";

export interface ScopePhrase {
  /** The phrase as the lead decision lists it. */
  says: string;
  re: RegExp;
}

// What may follow "fill out" when its object is the form: the end, punctuation, or where the values come from.
const OBJECT_END = String.raw`(?=\s*(?:$|[,.;:!?]|(?:from|with|using|for|please|pls)\b))`;

/** The phrases that ask for the whole form. */
export const WHOLE_FORM_WORDS: readonly ScopePhrase[] = [
  // "fill out" with no object, a pronoun, or the form itself ("fill out from my note", "fill it out", "fill out the
  // form"). "fill out my email" names a field, so "fill out" with any other object is not this phrase; "fill out
  // the <form's title>" is FILL_OUT_THE below.
  { says: "fill out", re: new RegExp(String.raw`\bfill\s+(?:(?:it|this|that)\s+out|out(?:\s+(?:the|this|that)\s+(?:form|application))?)${OBJECT_END}`) },
  { says: "fill in everything", re: /\bfill\s+in\s+everything\b/ },
  { says: "everything", re: /\beverything\b/ },
  { says: "the whole form", re: /\bthe\s+whole\s+form\b/ },
  { says: "all of it", re: /\ball\s+of\s+it\b/ },
  { says: "the rest", re: /\bthe\s+rest\b/ },
  { says: "what you can", re: /\bwhat(?:ever)?\s+you\s+can\b/ },
  { says: "this form", re: /\bthis\s+form\b/ },
  { says: "this application", re: /\bthis\s+application\b/ },
];

/** "fill out the <form name>": the object is matched against the form window's title (namesTheForm). */
const FILL_OUT_THE = new RegExp(String.raw`\bfill\s+out\s+(?:the|this|my|our)\s+(.+?)${OBJECT_END}`);
/** Nouns a user adds to a form's name that its title often leaves out ("the Northgate application"). */
const FORM_NOUNS = new Set(["form", "application"]);

/**
 * Words that may stand beside a whole-form phrase without narrowing it: courtesy, the verbs of filling, pronouns,
 * articles and prepositions, and the phrases' own words. "the rest of the address" still narrows: "address" is not here.
 */
export const FILLER: ReadonlySet<string> = new Set([
  "please", "pls", "plz", "thanks", "thank", "ok", "okay", "hey", "can", "could", "would", "you", "just", "go", "ahead", "and", "then", "now",
  "fill", "out", "in", "up", "on", "complete", "finish", "do", "handle", "help", "with", "put",
  "for", "of", "me", "my", "the", "this", "that", "it", "a", "all", "everything", "rest", "what", "whatever", "form", "application",
]);
/** Beside a section phrase, also "only" and the words people use for a part ("the bit up top"). */
export const SECTION_FILLER: ReadonlySet<string> = new Set([...FILLER, "only", "bit", "part", "section", "stuff"]);

/** A section phrase, and which of the form's sections has its meaning. */
export interface SectionPhrase extends ScopePhrase {
  /** The section it means, by the form's section names in form order and the section of the form's first field. */
  pick(sections: readonly string[], firstFieldSection: string | null): string[];
}

/** Phrases that name a part of the form. None of them is a whole-form phrase. */
export const SECTION_WORDS: readonly SectionPhrase[] = [
  { says: "contact info", re: /\bcontact\s+(?:info|information|details)\b/, pick: (s) => s.filter((n) => /\bcontact\b/i.test(n)) },
  // "Up top" is the section the form starts with; a form whose first field sits under no heading has no such section.
  { says: "up top", re: /\bup\s+top\b/, pick: (_, first) => (first === null ? [] : [first]) },
  { says: "my details", re: /\bmy\s+details\b/, pick: (s) => s.filter((n) => /\b(?:details|personal|about\s+you)\b/i.test(n)) },
];

/** Quoted text: a value to write or a field's exact name, either of which narrows the request. */
const QUOTED = /"[^"]*"|“[^”]*”|(?<![\p{L}])'[^']*'(?![\p{L}])/u;

/**
 * The instruction's words that may set the scope, lower case, with its source phrases blanked ("from my note" never
 * names a field), or null when it quotes anything. Curly single quotes are made straight first.
 */
function scopeText(instruction: string): string | null {
  const s = fieldWords(instruction).replace(/[’‘]/g, "'");
  return QUOTED.test(s) ? null : s.toLowerCase();
}

/** `s` with the first match of `re` blanked. */
const without = (s: string, re: RegExp): string => s.replace(re, (m) => " ".repeat(m.length));

const wordsOf = (s: string): string[] => s.toLowerCase().replace(/['’]s\b/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];

/** Whether every word of `s` is on `allowed`. */
const onlyFiller = (s: string, allowed: ReadonlySet<string>): boolean => wordsOf(s).every((w) => allowed.has(w));

/** Whether "fill out the X" names the form: every word of X but "form" and "application" is a word of its title. */
export function namesTheForm(object: string, title: string): boolean {
  const titled = new Set(wordsOf(title));
  const own = wordsOf(object).filter((w) => !FORM_NOUNS.has(w) && w !== "the");
  return own.length > 0 && own.every((w) => titled.has(w));
}

/**
 * The whole-form phrase the instruction uses, or null when it uses none, quotes anything, names a part of the form
 * (SECTION_WORDS), or has a word beside the phrase that is not FILLER. `title` is the form window's title.
 */
export function wholeFormPhrase(instruction: string, title: string): string | null {
  const s = scopeText(instruction);
  if (s === null || SECTION_WORDS.some((p) => p.re.test(s))) return null;
  for (const p of WHOLE_FORM_WORDS) if (p.re.test(s)) return onlyFiller(without(s, p.re), FILLER) ? p.says : null;
  const m = FILL_OUT_THE.exec(s);
  if (m?.[1] === undefined || !namesTheForm(m[1], title)) return null;
  // The form's own name may share a word with a field ("the pizza order", "Pizza Size"); it is taken out with the phrase.
  return onlyFiller(without(s, FILL_OUT_THE), FILLER) ? "fill out the <form name>" : null;
}

/**
 * The part of the form the instruction names by a section phrase. `phrases` is empty when it uses none. `section`
 * is the one section every phrase it uses means; it is null, with `why`, when the instruction quotes anything or
 * has a word beside the phrases that is not SECTION_FILLER ("skip my contact info", "only my email in contact info"),
 * or a phrase means no section of this form, or more than one, or two phrases disagree: then Caret asks which fields.
 */
export function namedSection(instruction: string, sections: readonly string[], firstFieldSection: string | null): { phrases: string[]; section: string | null; why: string | null } {
  const raw = fieldWords(instruction).replace(/[’‘]/g, "'").toLowerCase();
  const used = SECTION_WORDS.filter((p) => p.re.test(raw));
  const phrases = used.map((p) => p.says);
  if (used.length === 0) return { phrases, section: null, why: null };
  const s = scopeText(instruction);
  if (s === null) return { phrases, section: null, why: "it quotes something too" };
  const rest = used.reduce((t, p) => without(t, p.re), s);
  if (!onlyFiller(rest, SECTION_FILLER)) return { phrases, section: null, why: `it also says '${wordsOf(rest).filter((w) => !SECTION_FILLER.has(w)).join(" ")}'` };
  const picks = used.map((p) => p.pick(sections, firstFieldSection));
  const one = picks.every((x) => x.length === 1) && new Set(picks.map((x) => x[0])).size === 1 ? (picks[0]?.[0] ?? null) : null;
  return { phrases, section: one, why: one === null ? "no one section of this form means that" : null };
}
