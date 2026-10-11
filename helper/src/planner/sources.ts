// Where an instruction says to copy from, read by code (B26). Two rules use it. Blanking a phrase only leaves fewer
// words to name a field, so it can send more of a scope to Jev, never less; B28's whole-form and section scopes
// match the whole instruction (scope-words.ts) and never read the blanked text.
//   - A word that names the source never names a field. "do the checkout details from my note" asks for the
//     checkout fields, not the form's "Add a gift note"; B25 scoped that Ask to the gift note alone (held-08).
//     So the words that name fields are the instruction with its source phrases blanked (fieldWords).
//   - Naming a window is consent to read it for that request (B26 lead decision 1, privacy.ts consented). The
//     window an instruction names ("from my note", "Bea's email", "the Saturday Chris mentioned") is resolved here,
//     by code, from the instruction and the windows' titles and senders, never by a model's choice.
//
// The phrase lists are written for B24's and B25's instructions and the common ways people name a note or a mail;
// they are not measured on anything wider.
import type { ScreenModel, WindowState } from "../model.ts";
import { BROWSER_BUNDLES, isConversation } from "../conversation.ts";
import { labelledLines } from "../fill/candidates.ts";

/** Nouns that name a source, by the kind of window they mean. */
const NOTE_NOUNS = ["note", "notes", "notepad", "memo", "jottings"];
const MAIL_NOUNS = ["email", "e-mail", "mail", "message", "messages", "text", "texts", "thread", "reply", "chat", "dm"];
/** Apps and sites a source can be named by; only these can be "not open" (namedSources missing). */
const APP_NOUNS = ["linkedin", "terminal", "slack", "notion", "excel", "github", "jira", "trello", "figma"];
/** Nouns that name a source by what it is called on screen: an app or a site in a window's title, or a document. */
const NAMED_NOUNS = [...APP_NOUNS, "profile", "calendar", "doc", "document", "file", "draft", "spreadsheet", "sheet", "resume", "cv", "letter", "invoice", "receipt", "confirmation"];
const NOUN = [...NOTE_NOUNS, ...MAIL_NOUNS, ...NAMED_NOUNS].join("|");
const NAME = "\\p{Lu}[\\p{L}'’-]*";
const OWNER = `(?:my|the|this|that|his|her|their|our|your|${NAME}['’]s)`;
/**
 * "in" names a source only before a possessive ("in my note", "in Bea's email"), and only when no verb that places a
 * value comes before it in its clause: "fill in my email" and "put it in my notes" name where a value goes.
 */
const POSSESSIVE = `(?:my|his|her|their|our|your|${NAME}['’]s)`;
const PLACING = /\b(?:fill|put|type|write|enter|add|paste|drop|save|jot|record|stick|place|insert|log|note|plug|pop|key|punch|pencil|sign|check|send)\b/iu;
/** "from my note", "off my LinkedIn", "per Bea's email", "in her latest email"; never "in the Notes field". */
const PREP_SOURCE = new RegExp(`\\b(?:from|off|out of|per|according to|based on|using|via|in\\s+(?=${POSSESSIVE}\\s))\\s*(?:${OWNER}\\s+)?(?:(?!(?:into|in|to|for|as|on|at|onto|and|then)\\b)[\\p{L}-]+\\s+){0,2}?(${NOUN})\\b(?!\\s+(?:field|box|line|section|part)\\b)`, "giu");
/** Words that rule a source out when they come shortly before its phrase: "without using Dana's email", "not from my note". */
const NEGATION = /(?:\b(?:without|not|never|except|instead of|rather than|other than|ignore|ignoring|skip|skipping|no)\b|n['’]t)(?:\s+[\p{L}'’]+){0,3}\s*$/iu;
/** An instruction that keeps Caret to what it says ("only use what I typed", "don't read other windows"). */
const RESTRICTS = /\b(?:only|just)\b[^.;]*\b(?:instruction|what i (?:typed|wrote|said)|these words)\b|\b(?:do not|don['’]t|dont|never|without)\s+(?:read|reading|look|looking|use|using|open|opening|check|checking|touch|touching)\b/iu;
/**
 * "Chris's last message", "Dana's note". Without a preposition, "Bea's email" or "her mail" can be the address itself
 * ("put Bea's email in the guest email field"), so a bare possessive names a source only by these nouns; "in Bea's
 * email" is PREP_SOURCE's.
 */
const BARE_NOUN = ["note", "notes", "memo", "message", "messages", "text", "texts", "thread", "reply", "chat", "dm", ...NAMED_NOUNS].join("|");
const POSSESSIVE_SOURCE = new RegExp(`(?<![\\p{L}])(${NAME})['’]s\\s+(?:latest\\s+|last\\s+|new\\s+|recent\\s+)?(${BARE_NOUN})\\b(?!\\s+(?:field|box|line|section|part)\\b)`, "gu");
/** Verbs by which someone gave the values: a note's or a mail's. */
const NOTE_VERBS = "jotted(?:\\s+down)?|wrote(?:\\s+down)?|noted(?:\\s+down)?|put\\s+down|typed(?:\\s+up)?|saved";
const MAIL_VERBS = "mentioned|said|sent(?:\\s+me)?|offered|suggested|proposed|gave(?:\\s+me)?|told\\s+me|emailed(?:\\s+me)?|texted(?:\\s+me)?|wrote\\s+me|asked\\s+for|picked";
/** "what I jotted down", "the Saturday Chris mentioned", "whatever Dana sent me". */
const CLAUSE_SOURCE = new RegExp(`(?:\\b(?:from|off)\\s+)?(?:\\b(?:what|whatever|everything|anything|all)\\s+)?(?<![\\p{L}])(I|you|he|she|they|we|${NAME})\\s+(?:(${NOTE_VERBS})|(${MAIL_VERBS}))\\b`, "gu");

export interface SourcePhrase {
  start: number;
  end: number;
  /** The kind of window the phrase means: a note, a mail or chat, one named by its title, or one a name decides. */
  kind: "note" | "mail" | "titled" | "person";
  /** The noun that names a titled source ("LinkedIn"), lower case; null otherwise. */
  noun: string | null;
  /** A person's name in the phrase ("Bea" in "Bea's email", "Chris" in "Chris mentioned"); null otherwise. */
  name: string | null;
  /** The instruction rules this source out ("without using Dana's email"): its window is excluded, never consented. */
  negated: boolean;
}

const PRONOUNS = new Set(["I", "you", "he", "she", "they", "we"]);
const kindOf = (noun: string): SourcePhrase["kind"] => (NOTE_NOUNS.includes(noun) ? "note" : MAIL_NOUNS.includes(noun) ? "mail" : "titled");

/** The phrases of an instruction that name where to copy from, in order, overlapping ones merged. */
export function sourcePhrases(instruction: string): SourcePhrase[] {
  const out: SourcePhrase[] = [];
  const negated = (start: number): boolean => NEGATION.test(instruction.slice(Math.max(0, start - 40), start));
  for (const m of instruction.matchAll(PREP_SOURCE)) {
    if (/^in\b/iu.test(m[0])) {
      const clause = instruction.slice(0, m.index).split(/[.;,!?]|\band\b|\bthen\b/iu).at(-1) ?? "";
      if (PLACING.test(clause)) continue;
    }
    const noun = (m[1] as string).toLowerCase();
    const owner = new RegExp(`(${NAME})['’]s\\s`, "u").exec(m[0])?.[1] ?? null;
    out.push({ start: m.index, end: m.index + m[0].length, kind: kindOf(noun), noun: kindOf(noun) === "titled" ? noun : null, name: owner, negated: negated(m.index) });
  }
  for (const m of instruction.matchAll(POSSESSIVE_SOURCE)) {
    const noun = (m[2] as string).toLowerCase();
    out.push({ start: m.index, end: m.index + m[0].length, kind: kindOf(noun), noun: kindOf(noun) === "titled" ? noun : null, name: m[1] as string, negated: negated(m.index) });
  }
  for (const m of instruction.matchAll(CLAUSE_SOURCE)) {
    const who = m[1] as string;
    // A sentence's capitalized first word is not a name ("Fill what I jotted down" has no person called Fill).
    if (!PRONOUNS.has(who) && /^(?:Fill|Use|Put|Add|Make|Set|Do|Go|Grab|Copy|Enter|Type|Get|Pick|Book|Choose|Please|Just|Ok|Okay|Can|Could)$/u.test(who)) continue;
    // "what I mentioned", "the address I gave you": the user's own words to Caret, not a mail (memory, or nothing).
    if ((who === "I" || who === "we" || who === "you") && m[3] !== undefined) continue;
    const name = PRONOUNS.has(who) ? null : who;
    out.push({ start: m.index, end: m.index + m[0].length, kind: name !== null ? "person" : m[2] !== undefined ? "note" : "mail", noun: null, name, negated: negated(m.index) });
  }
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SourcePhrase[] = [];
  for (const p of out) {
    const last = merged[merged.length - 1];
    if (last !== undefined && p.start < last.end) {
      last.end = Math.max(last.end, p.end);
      if (last.name === null) last.name = p.name;
      last.negated ||= p.negated;
      if (last.kind === "titled" || (last.kind !== "person" && p.kind === "person")) last.kind = p.kind;
      continue;
    }
    merged.push({ ...p });
  }
  return merged;
}

/** The instruction with its source phrases blanked: the words that may name fields or a person whose details go in. */
export function fieldWords(instruction: string): string {
  let s = instruction;
  for (const p of sourcePhrases(instruction)) s = `${s.slice(0, p.start)}${" ".repeat(p.end - p.start)}${s.slice(p.end)}`;
  return s;
}

/**
 * Common words that are also first names ("will", "may", "mark"): typed in lower case they are not taken for a sender's
 * name. Written for this rule, not measured.
 */
const COMMON_NAMES = new Set(["will", "may", "mark", "bill", "rose", "art", "grace", "hope", "joy", "june", "april", "august", "sue", "pat", "max", "ray", "rob", "jack", "frank", "drew", "chase", "dawn", "faith", "summer", "page", "lane", "dean", "guy", "don", "jean", "carol", "bob", "ben", "al", "an", "eve"]);

/**
 * The words of an instruction that name a mail's sender, however they are typed: a word of a conversation's sender
 * name ("ines", "chris"), or, capitalized, the start of the sender's first name when exactly one sender starts with it
 * ("Bea" for "Beatrice"). Each is an exact span of the instruction. B25 and B26's held-out sets type names in lower
 * case ("emergency contact is ines"), which the capitalized-name rule (intent.ts personSpans) does not see. A word in
 * lower case never matches by its start: "can" named Candace's mail in B26's second review.
 */
export function senderNames(instruction: string, model: ScreenModel, form: WindowState): string[] {
  const senders = [...model.windows.values()].filter((w) => w !== form && isConversation(w)).map((w) => wordsOf(senderOf(w) ?? ""));
  const out: string[] = [];
  for (const m of instruction.matchAll(/(?<![\p{L}'’])\p{L}[\p{L}'’-]*/gu)) {
    const word = m[0].replace(/['’]s$/u, "");
    const n = word.toLowerCase();
    if (n.length < 3 || COMMON_NAMES.has(n) || STOP.has(n) || out.includes(word)) continue;
    const exact = senders.filter((ws) => ws.includes(n)).length;
    const prefix = /^\p{Lu}/u.test(word) ? senders.filter((ws) => (ws[0] ?? "").startsWith(n)).length : 0;
    if (exact > 0 || prefix === 1) out.push(word);
  }
  return out;
}

/** Whether the instruction keeps Caret to its own words or rules out reading other windows. */
export const restrictsSources = (instruction: string): boolean => RESTRICTS.test(instruction);

/** Whether `span` (a person the instruction names) occurs only inside its source phrases. */
export function onlyInSources(instruction: string, span: string): boolean {
  const phrases = sourcePhrases(instruction);
  let found = false;
  const re = new RegExp(`(?<![\\p{L}])${span.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\p{L}])`, "gu");
  for (const m of instruction.matchAll(re)) {
    found = true;
    if (!phrases.some((p) => m.index >= p.start && m.index + m[0].length <= p.end)) return false;
  }
  return found;
}

/** A mail's sender as its "From" line shows it ("Beatrice Sutherland <bea@…>" gives "Beatrice Sutherland"), or null. */
export function senderOf(w: WindowState): string | null {
  const fromLine = labelledLines(w).find((l) => /^from$/i.test(l.label));
  if (fromLine === undefined) return null;
  return /^\s*"?([^"<>]+?)"?\s*(?:<[^>]*>)?\s*$/u.exec(fromLine.value)?.[1]?.trim() ?? null;
}

export interface NamedSource {
  windowId: string;
  /** People whose lines go first in this window: the name that resolved it and the sender's name. */
  names: string[];
}

const wordsOf = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 2);
const STOP = new Set(["the", "my", "this", "that", "from", "for", "and", "with", "txt", "md", "google", "chrome", "re", "fwd", "of", "to", "in", "on", "your", "me"]);

/**
 * The windows a person's name names: conversations whose sender has that name as a word, and with `titles`, notes whose
 * title has it. A name that is only the start of a sender's first name ("Bea" for "Beatrice") counts when no window has
 * the name as a word and exactly one sender starts with it (B26 review: "Dan" named both Dan Wilson's and Dana
 * Whitfield's mail).
 */
function byName(name: string, windows: readonly WindowState[], titles: boolean): WindowState[] {
  const n = name.toLowerCase();
  const exact = windows.filter((w) => (isConversation(w) ? wordsOf(senderOf(w) ?? "").includes(n) : titles && wordsOf(w.window.title).includes(n)));
  if (exact.length > 0 || n.length < 3) return exact;
  const prefix = windows.filter((w) => isConversation(w) && (wordsOf(senderOf(w) ?? "")[0] ?? "").startsWith(n));
  return prefix.length === 1 ? prefix : [];
}

/** Whether a window is a note: not a conversation and not a browser page, or a page or file whose title says it is one. */
function isNote(w: WindowState): boolean {
  if (isConversation(w)) return false;
  return !BROWSER_BUNDLES.has(w.app.bundleId) || /\bnotes?\b|\.(?:txt|md|rtf)\b/iu.test(w.window.title);
}

/**
 * The windows an instruction names as its source, each once, among the model's windows other than the form, and the
 * ones it rules out. A source phrase names a window by a person's name in it (a mail's sender, a note's title), by a
 * kind of window (a note, a mail), or by a noun a title shows ("LinkedIn"). When a kind's noun fits several windows,
 * the one whose title shares the most of the instruction's words is named, then the window the user just left; with
 * neither, none is, and the windows keep their budgets. `people` are the person spans the instruction names (intent.ts
 * personSpans): a name outside any phrase names a mail by its sender ("put Bea down as my guest" names Bea's email),
 * never a title, and relations ("my wife") name nothing. A phrase the instruction negates ("without using Dana's
 * email") names no window: what it resolves to is excluded.
 */
export function namedSources(instruction: string, model: ScreenModel, form: WindowState, people: readonly string[]): { named: NamedSource[]; excluded: string[]; missing: boolean } {
  const others = [...model.windows.values()].filter((w) => w !== form);
  const phrases = sourcePhrases(instruction);
  const said = new Set(wordsOf(instruction).filter((x) => !STOP.has(x)));
  const just = model.windowBefore(form.window.windowId);
  const nouns = new Set([...NOTE_NOUNS, ...MAIL_NOUNS, ...NAMED_NOUNS]);
  const score = (w: WindowState): number => new Set(wordsOf(w.window.title).filter((x) => !STOP.has(x) && !nouns.has(x) && said.has(x))).size;
  /** The windows a phrase's kind or noun could mean. */
  const resolveFits = (p: SourcePhrase): WindowState[] => others.filter((w) => (p.kind === "note" ? isNote(w) : p.kind === "mail" ? isConversation(w) : p.noun !== null && (wordsOf(w.window.title).includes(p.noun) || wordsOf(w.app.name).includes(p.noun))));
  /** The windows one phrase names. */
  const resolve = (p: SourcePhrase): WindowState[] => {
    if (p.name !== null) return byName(p.name, others, true);
    const fits = resolveFits(p);
    if (fits.length <= 1) return fits;
    const best = Math.max(...fits.map(score));
    const top = fits.filter((w) => score(w) === best);
    if (best > 0 && top.length === 1) return top;
    return top.filter((w) => w.window.windowId === just);
  };
  const excluded = new Set(phrases.filter((p) => p.negated).flatMap((p) => resolve(p).map((w) => w.window.windowId)));
  const out = new Map<string, NamedSource>();
  const add = (w: WindowState, names: readonly string[]): void => {
    if (excluded.has(w.window.windowId)) return;
    const sender = isConversation(w) ? senderOf(w) : null;
    const all = [...new Set([...names, ...(sender === null ? [] : [sender])])];
    const had = out.get(w.window.windowId);
    out.set(w.window.windowId, { windowId: w.window.windowId, names: had === undefined ? all : [...new Set([...had.names, ...all])] });
  };
  for (const p of phrases) if (!p.negated) for (const w of resolve(p)) add(w, p.name === null ? [] : [p.name]);
  // A source the instruction names that no open window could be ("off my LinkedIn" with no LinkedIn open). Several
  // that fit, none picked, is not missing.
  // Missing only for an app or a site no window's title or app shows ("off my LinkedIn"). A note, a mail, a document
  // or a person's message can sit inside another window (an inbox's order confirmation, a thread in a fixture), so
  // naming one that no window resolves to is no reason to refuse: B26's planner sets were refused "from the order
  // confirmation" and "from my calendar" when the first version of this rule counted those.
  const missing = phrases.some((p) => !p.negated && p.kind === "titled" && p.noun !== null && APP_NOUNS.includes(p.noun) && resolveFits(p).length === 0);
  const negatedNames = new Set(phrases.filter((p) => p.negated && p.name !== null).map((p) => p.name as string));
  for (const person of people) {
    if (/^(?:my|our)\s/iu.test(person) || negatedNames.has(person) || phrases.some((p) => p.name === person)) continue;
    for (const w of byName(person, others, false)) add(w, [person]);
  }
  return { named: [...out.values()], excluded: [...excluded], missing };
}
