// Where an instruction says to copy from, read by code (B26). Two rules use it:
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
/** Nouns that name a source by what it is called on screen: an app or a site in a window's title. */
const NAMED_NOUNS = ["linkedin", "profile", "calendar", "terminal", "doc", "document", "file", "draft", "spreadsheet", "sheet", "resume", "cv", "letter", "invoice", "receipt", "confirmation"];
const NOUN = [...NOTE_NOUNS, ...MAIL_NOUNS, ...NAMED_NOUNS].join("|");
const NAME = "\\p{Lu}[\\p{L}'’-]*";
const OWNER = `(?:my|the|this|that|his|her|their|our|your|${NAME}['’]s)`;
/**
 * "in" names a source only before a possessive ("in my note", "in Bea's email"), and never as part of a verb ("fill in
 * my email"); "in the notes" is where a value goes.
 */
const POSSESSIVE = `(?:my|his|her|their|our|your|${NAME}['’]s)`;
/** "from my note", "off my LinkedIn", "per Bea's email", "in her latest email"; never "in the Notes field". */
const PREP_SOURCE = new RegExp(`\\b(?:from|off|out of|per|according to|based on|using|via|(?<!\\b(?:fill|put|type|write|enter|add|plug|pop|key|punch|pencil|jot|sign|log|check|turn|hand|send)\\s)in\\s+(?=${POSSESSIVE}\\s))\\s*(?:${OWNER}\\s+)?(?:[\\p{L}-]+\\s+){0,2}?(${NOUN})\\b(?!\\s+(?:field|box|line|section|part)\\b)`, "giu");
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
}

const PRONOUNS = new Set(["I", "you", "he", "she", "they", "we"]);
const kindOf = (noun: string): SourcePhrase["kind"] => (NOTE_NOUNS.includes(noun) ? "note" : MAIL_NOUNS.includes(noun) ? "mail" : "titled");

/** The phrases of an instruction that name where to copy from, in order, overlapping ones merged. */
export function sourcePhrases(instruction: string): SourcePhrase[] {
  const out: SourcePhrase[] = [];
  for (const m of instruction.matchAll(PREP_SOURCE)) {
    const noun = (m[1] as string).toLowerCase();
    const owner = new RegExp(`(${NAME})['’]s\\s`, "u").exec(m[0])?.[1] ?? null;
    out.push({ start: m.index, end: m.index + m[0].length, kind: kindOf(noun), noun: kindOf(noun) === "titled" ? noun : null, name: owner });
  }
  for (const m of instruction.matchAll(POSSESSIVE_SOURCE)) {
    const noun = (m[2] as string).toLowerCase();
    out.push({ start: m.index, end: m.index + m[0].length, kind: kindOf(noun), noun: kindOf(noun) === "titled" ? noun : null, name: m[1] as string });
  }
  for (const m of instruction.matchAll(CLAUSE_SOURCE)) {
    const who = m[1] as string;
    // A sentence's capitalized first word is not a name ("Fill what I jotted down" has no person called Fill).
    if (!PRONOUNS.has(who) && /^(?:Fill|Use|Put|Add|Make|Set|Do|Go|Grab|Copy|Enter|Type|Get|Pick|Book|Choose|Please|Just|Ok|Okay|Can|Could)$/u.test(who)) continue;
    const name = PRONOUNS.has(who) ? null : who;
    out.push({ start: m.index, end: m.index + m[0].length, kind: name !== null ? "person" : m[2] !== undefined ? "note" : "mail", noun: null, name });
  }
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SourcePhrase[] = [];
  for (const p of out) {
    const last = merged[merged.length - 1];
    if (last !== undefined && p.start < last.end) {
      last.end = Math.max(last.end, p.end);
      if (last.name === null) last.name = p.name;
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

/** Whether a person's name names a window: its sender (a word of the sender's name, or the start of the first one, "Bea" for "Beatrice"), or a word of a non-conversation's title. */
function namedBy(name: string, w: WindowState, conversation: boolean): boolean {
  const n = name.toLowerCase();
  if (conversation) {
    const sender = senderOf(w);
    if (sender === null) return false;
    const ws = wordsOf(sender);
    return ws.includes(n) || (n.length >= 3 && (ws[0] ?? "").startsWith(n));
  }
  return wordsOf(w.window.title).includes(n);
}

/** Whether a window is a note: not a conversation and not a browser page, or a page or file whose title says it is one. */
function isNote(w: WindowState): boolean {
  if (isConversation(w)) return false;
  return !BROWSER_BUNDLES.has(w.app.bundleId) || /\bnotes?\b|\.(?:txt|md|rtf)\b/iu.test(w.window.title);
}

/**
 * The windows an instruction names as its source, each once, among the model's windows other than the form: by a
 * person's name (a mail's sender, a note's title), by a noun of a kind (a note, a mail), or by a noun a title shows
 * ("LinkedIn"). When a kind's noun fits several windows, the one whose title shares the most of the instruction's
 * words is named, then the window the user just left; with neither, none is, and the windows keep their budgets.
 * `people` are the person spans the instruction names (intent.ts personSpans): a name names its mail too ("put Bea
 * down as my guest" names Bea's email), relations ("my wife") never do.
 */
export function namedSources(instruction: string, model: ScreenModel, form: WindowState, people: readonly string[]): NamedSource[] {
  const others = [...model.windows.values()].filter((w) => w !== form);
  const out = new Map<string, NamedSource>();
  const add = (w: WindowState, names: readonly string[]): void => {
    const sender = isConversation(w) ? senderOf(w) : null;
    const all = [...new Set([...names, ...(sender === null ? [] : [sender])])];
    const had = out.get(w.window.windowId);
    out.set(w.window.windowId, { windowId: w.window.windowId, names: had === undefined ? all : [...new Set([...had.names, ...all])] });
  };
  const phrases = sourcePhrases(instruction);
  const names = new Set([...people.filter((p) => /^\p{Lu}/u.test(p) && !/^(?:my|our)\s/iu.test(p)), ...phrases.flatMap((p) => (p.name === null ? [] : [p.name]))]);
  for (const name of names) for (const w of others) if (namedBy(name, w, isConversation(w))) add(w, [name]);
  const said = new Set(wordsOf(instruction).filter((x) => !STOP.has(x)));
  const just = model.windowBefore(form.window.windowId);
  for (const p of phrases) {
    if (p.name !== null) continue;
    const fits = others.filter((w) => (p.kind === "note" ? isNote(w) : p.kind === "mail" ? isConversation(w) : p.noun !== null && (wordsOf(w.window.title).includes(p.noun) || wordsOf(w.app.name).includes(p.noun))));
    if (fits.length === 0) continue;
    if (fits.length === 1) {
      add(fits[0] as WindowState, []);
      continue;
    }
    const nouns = new Set([...NOTE_NOUNS, ...MAIL_NOUNS, ...NAMED_NOUNS]);
    const score = (w: WindowState): number => new Set(wordsOf(w.window.title).filter((x) => !STOP.has(x) && !nouns.has(x) && said.has(x))).size;
    const best = Math.max(...fits.map(score));
    const top = fits.filter((w) => score(w) === best);
    if (best > 0 && top.length === 1) add(top[0] as WindowState, []);
    else {
      const left = top.find((w) => w.window.windowId === just);
      if (left !== undefined) add(left, []);
    }
  }
  return [...out.values()];
}
