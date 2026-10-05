// Which part of a form an instruction asks for, in words code reads (B28 lead decision 1).
//
// A non-Jev intent maker's "whole form" used to stand on its word whenever no word of the instruction named a field.
// G1's blind held-out-2 run (heldout2-04, "just do my contact info up top") got "whole form" from the local maker,
// and Graduation Date and LinkedIn were filled. Now a whole form stands on the instruction's words only when they
// ask for it in a phrase on WHOLE_FORM_WORDS; otherwise Jev's two asks must confirm it (ask.ts confirmScope).
// A phrase that names a part of the form (SECTION_WORDS) is never the whole form: it maps to the form's section of
// that meaning, or Caret asks which fields.
//
// Both lists are short on purpose and each entry has its own test (test/scope-words.test.ts). Neither was measured
// on a corpus; adding a phrase needs a test that shows the instruction it is for.
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
 * Words that narrow or negate what a whole-form phrase would ask: "just my email, leave the rest", "everything
 * but the phone". With one of them, the whole form is not taken from the words, and Jev's two asks decide.
 */
const NARROWS = /\b(?:only|except|not|never|leave|skip|without|but)\b|n't\b/;

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

/** The instruction's words that may set the scope: its source phrases blanked, its quoted values dropped, lower case. */
function scopeText(instruction: string): string {
  return fieldWords(instruction)
    .replace(/"[^"]*"|“[^”]*”|(?<![\p{L}])'[^']*'(?![\p{L}])/gu, " ")
    .replace(/[’‘]/g, "'")
    .toLowerCase();
}

const wordsOf = (s: string): string[] => s.toLowerCase().replace(/['’]s\b/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];

/** Whether "fill out the X" names the form: every word of X but "form" and "application" is a word of its title. */
export function namesTheForm(object: string, title: string): boolean {
  const titled = new Set(wordsOf(title));
  const own = wordsOf(object).filter((w) => !FORM_NOUNS.has(w) && w !== "the");
  return own.length > 0 && own.every((w) => titled.has(w));
}

/**
 * The whole-form phrase the instruction uses, or null when it uses none, uses a word that narrows it (NARROWS),
 * or names a part of the form (SECTION_WORDS). `title` is the form window's title.
 */
export function wholeFormPhrase(instruction: string, title: string): string | null {
  const s = scopeText(instruction);
  if (NARROWS.test(s) || SECTION_WORDS.some((p) => p.re.test(s))) return null;
  for (const p of WHOLE_FORM_WORDS) if (p.re.test(s)) return p.says;
  const obj = FILL_OUT_THE.exec(s)?.[1];
  return obj !== undefined && namesTheForm(obj, title) ? "fill out the <form name>" : null;
}

/**
 * The part of the form the instruction names by a section phrase. `phrases` is empty when it uses none. `section`
 * is the one section every phrase it uses means, or null when a phrase means no section of this form, or more than
 * one, or two phrases disagree: then Caret asks which fields.
 */
export function namedSection(instruction: string, sections: readonly string[], firstFieldSection: string | null): { phrases: string[]; section: string | null } {
  const s = scopeText(instruction);
  const used = SECTION_WORDS.filter((p) => p.re.test(s));
  if (used.length === 0) return { phrases: [], section: null };
  const picks = used.map((p) => p.pick(sections, firstFieldSection));
  const one = picks.every((x) => x.length === 1) && new Set(picks.map((x) => x[0])).size === 1 ? (picks[0]?.[0] ?? null) : null;
  return { phrases: used.map((p) => p.says), section: one };
}
