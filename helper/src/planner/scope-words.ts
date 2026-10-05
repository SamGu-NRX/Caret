// Which part of a form an instruction asks for, in words code reads (B28 lead decision 1).
//
// A non-Jev intent maker's "whole form" used to stand on its word whenever no word of the instruction named a field.
// G1's blind held-out-2 run (heldout2-04, "just do my contact info up top") got "whole form" from the local maker,
// and Graduation Date and LinkedIn were filled. Now a whole form stands on the instruction's words only when they
// ask for it in a phrase on WHOLE_FORM_WORDS; otherwise Jev's two asks must confirm it (ask.ts confirmScope).
// A phrase that names a part of the form (SECTION_WORDS) is never the whole form: it maps to the form's section of
// that meaning, or Caret asks which fields.
//
// Beside either kind of phrase, only words on a short list of filler may stand (FILLER, SECTION_FILLER), and a phrase
// naming where to copy from may hold only source words (sourceOnly). Any other word, or any quoted text, may narrow
// the request, so the words alone do not settle it. The first version instead looked for the form's field labels in
// the rest of the instruction, and that failed open: "just fill my email on this form" named no label on a form whose
// field reads "E-mail address", and "only the second box in contact info" or "avoid my contact info" named none at
// all. The second let a source phrase hide words: "do everything in my details except email" read as a source
// ("in my ... email") around "details except" (B28 reviews).
//
// The lists are short on purpose and each entry has a test (test/scope-words.test.ts). None was measured on a corpus;
// adding a phrase or a filler word needs a test that shows the instruction it is for.
import { fieldWords, SOURCE_NOUNS, sourcePhrases } from "./sources.ts";

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
 * Words that may stand beside a whole-form phrase without narrowing it: courtesy, the verbs of filling, articles and
 * prepositions. Words a phrase consumes are left out ("it", "that", "what", "rest"), and so are words that point at
 * one thing: "put that in this form" asks for one value, not the form. "the rest of the address" still narrows:
 * "address" is not here.
 */
export const FILLER: ReadonlySet<string> = new Set([
  "please", "pls", "plz", "thanks", "thank", "ok", "okay", "hey", "can", "could", "would", "you", "just", "go", "ahead", "and", "then", "now",
  "fill", "out", "in", "up", "on", "complete", "finish", "do", "handle", "help", "with",
  "for", "of", "me", "my", "the", "this", "a", "all", "everything", "form", "application",
]);
/** Beside a section phrase, also "only": "my contact info only". "a bit of my details" and "part of" ask for less. */
export const SECTION_FILLER: ReadonlySet<string> = new Set([...FILLER, "only"]);

/**
 * Words a phrase naming where to copy from may hold besides its noun and the person sources.ts read in it: "from my
 * note", "in Bea's latest email", "what Dana sent me". Anything else in it ("in my details except email") may narrow.
 */
const SOURCE_WORDS: ReadonlySet<string> = new Set([
  "from", "off", "out", "of", "per", "according", "to", "based", "on", "using", "via", "in",
  "my", "the", "this", "that", "his", "her", "their", "our", "your", "latest", "last", "new", "recent", "s", "e",
  "what", "whatever", "everything", "anything", "all", "i", "you", "he", "she", "they", "we", "me", "down", "up",
  "jotted", "wrote", "noted", "put", "typed", "saved", "mentioned", "said", "sent", "offered", "suggested", "proposed", "gave", "told", "emailed", "texted", "asked", "for", "picked",
]);

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

/**
 * Quoted text: a value to write or a field's exact name, either of which narrows the request. Any double-quote, guillemet,
 * backtick or corner-bracket character counts, paired or not; a single quote counts when it opens and closes a span.
 */
const QUOTED = /["“”„‟«»‹›`「」『』]|(?<![\p{L}])'[^']*'(?![\p{L}])/u;
/**
 * How a source phrase must open to stand beside a scope phrase. A bare possessive or clause ("fill in Bea's linkedin on
 * this form", "fill in what I typed on this form") can be the value asked for rather than where it comes from.
 */
const SOURCE_OPENS = /^(?:from|off|out\s+of|per|according\s+to|based\s+on|using|via|in)\b/i;

const wordsOf = (s: string): string[] => s.toLowerCase().replace(/['’]s\b/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];
/** Every word of `s`, lower case, a possessive's "s" kept as its own word. */
const allWords = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * The instruction's words that may set the scope, lower case, with its source phrases blanked ("from my note" never
 * names a field); or why its words cannot settle the scope: it quotes something (a value or a field's exact name),
 * or a source phrase holds a word that is not a source word. Curly single quotes are made straight first.
 */
function scopeText(instruction: string): { s: string } | { why: string } {
  const raw = instruction.replace(/[’‘]/g, "'");
  if (QUOTED.test(raw)) return { why: "it quotes something" };
  for (const p of sourcePhrases(raw)) {
    const span = raw.slice(p.start, p.end).trim();
    if (!SOURCE_OPENS.test(span)) return { why: `'${span}' may be what it asks for, not where to copy from` };
    const own = new Set([...wordsOf(p.name ?? ""), ...allWords(p.noun ?? "")]);
    const odd = allWords(span).filter((w) => !SOURCE_WORDS.has(w) && !SOURCE_NOUNS.has(w) && !own.has(w));
    if (odd.length > 0) return { why: `where it says to copy from also says '${odd.join(" ")}'` };
  }
  return { s: fieldWords(raw).toLowerCase() };
}

/** `s` with the first match of `re` blanked. */
const without = (s: string, re: RegExp): string => s.replace(re, (m) => " ".repeat(m.length));

/** Whether every word of `s` is on `allowed`. */
const onlyFiller = (s: string, allowed: ReadonlySet<string>): boolean => wordsOf(s).every((w) => allowed.has(w));

/**
 * Whether "fill out the X" names the form. X, less a last "form" or "application", must be a run of the title's words
 * in order, and either end in that noun ("the Northgate application") or be a whole part of the title between its
 * separators ("the pizza order" for "Pizza order"). Words scattered through the title do not name it: "the email only"
 * is not "Email signup | Members only" (B28 review).
 */
export function namesTheForm(object: string, title: string): boolean {
  const obj = wordsOf(object).filter((w) => w !== "the");
  const named = FORM_NOUNS.has(obj.at(-1) ?? "") ? obj.slice(0, -1) : obj;
  if (named.length === 0) return false;
  const runIn = (hay: readonly string[]): boolean => hay.some((_, i) => named.every((w, j) => hay[i + j] === w));
  if (!runIn(wordsOf(title))) return false;
  if (named.length < obj.length) return true;
  return title.split(/\s+[|–—-]\s+|:\s+/).some((part) => {
    const ws = wordsOf(part);
    return ws.length === named.length && runIn(ws);
  });
}

/**
 * The whole-form phrase the instruction uses, or null when it uses none, quotes anything, names a part of the form
 * (SECTION_WORDS), or has a word beside the phrase that is not FILLER. `title` is the form window's title.
 */
export function wholeFormPhrase(instruction: string, title: string): string | null {
  // A section phrase is looked for in the whole instruction, a source phrase included.
  if (SECTION_WORDS.some((p) => p.re.test(instruction.toLowerCase()))) return null;
  const t = scopeText(instruction);
  if (!("s" in t)) return null;
  const s = t.s;
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
  // Looked for in the whole instruction: "do everything in my details except email" names a section inside what reads
  // as a source phrase.
  const used = SECTION_WORDS.filter((p) => p.re.test(instruction.toLowerCase()));
  const phrases = used.map((p) => p.says);
  if (used.length === 0) return { phrases, section: null, why: null };
  const t = scopeText(instruction);
  if (!("s" in t)) return { phrases, section: null, why: t.why };
  const rest = used.reduce((x, p) => without(x, p.re), t.s);
  if (!onlyFiller(rest, SECTION_FILLER)) return { phrases, section: null, why: `it also says '${wordsOf(rest).filter((w) => !SECTION_FILLER.has(w)).join(" ")}'` };
  const picks = used.map((p) => p.pick(sections, firstFieldSection));
  const one = picks.every((x) => x.length === 1) && new Set(picks.map((x) => x[0])).size === 1 ? (picks[0]?.[0] ?? null) : null;
  return { phrases, section: one, why: one === null ? "no one section of this form means that" : null };
}
