// The form controls fill reads besides text fields (Q1 bug 10): native selects, radio groups, checkboxes,
// and date and time inputs, found by the reader's Accessibility roles. Chrome exposes them as AXPopUpButton,
// AXRadioButton under an AXFieldset group, AXCheckBox, AXDateField and AXTimeField (B24 capture,
// evidence/screen/b24/capture-2). Through Accessibility Caret writes none of them: how Chrome applies an AX write to
// these controls is unverified, so a value proposed for one is a hand-off the user applies (FillField.handoff). In a
// window the page engine owns, Caret writes them itself in a Fill all (D2-04), through the engine's verified handlers
// (engines/page-link.ts), on stricter rules (fill.ts controlValue). Code checks every value: an option must be one the
// control shows; a box is ticked only when the chosen source text says so; a date or time is read by the value
// resolver.
import { PAGE_SUBROLE, type Node } from "../protocol.ts";
import type { WindowState } from "../model.ts";
import { fieldLabelText } from "./descriptor.ts";

export type Control = "text" | "date" | "time" | "select" | "radio" | "checkbox" | "combobox";

/**
 * The value a date-like field holds, in its own wire format (D2-04): "date" YYYY-MM-DD, "datetime" YYYY-MM-DDTHH:MM (an
 * HTML datetime-local, with no zone), "month" YYYY-MM, "week" YYYY-Www. Read from the page engine's subrole
 * (PAGE_SUBROLE); a date field read through Accessibility is "date".
 */
export type DateFormat = "date" | "datetime" | "month" | "week";

export interface FormControl {
  /** The node the proposal names: the control itself, or a radio group's container. */
  node: Node;
  control: Exclude<Control, "text">;
  /** The control's own label without required markers. */
  label: string | null;
  /** The options code can see: a radio group's buttons, or a select's menu items when the app exposes them. Null when unknown. */
  options: string[] | null;
  /** A radio group's buttons, in document order. */
  members: Node[];
  /** A date field's value format; absent for every other control. */
  format?: DateFormat;
}

/** A date field's value format, from the page engine's subrole; "date" for anything else (an Accessibility date field). */
export function dateFormat(n: Node): DateFormat {
  return n.subrole === PAGE_SUBROLE.datetime ? "datetime" : n.subrole === PAGE_SUBROLE.month ? "month" : n.subrole === PAGE_SUBROLE.week ? "week" : "date";
}

/**
 * Labels of controls Caret never sets: consent, certification, agreement to terms, and marketing or notification
 * sign-ups. Plan section 4: "never infer consent from a checkbox label". Written for common form wording, not
 * measured; a control that matches gets no value, written or handed off, even when a source seems to say yes. D2-04's
 * review found certification wording the first list missed ("All information is accurate"), so it names legal and
 * certification phrasing too. A word list stays incomplete, so a box gets a tick only by its label's kind as well
 * (boxKind: a box the user speaks in never does) and a fact the source states (statesFact).
 */
const CONSENT = /\b(?:agree|consent|certif(?:y|ies)|acknowledge|confirm|accept|terms|privacy|policy|polic(?:ies)|authori[sz]e|authori[sz]ation|newsletter|marketing|news|offers?|promotions?|specials|coupons|subscribe|sign me up|send me|email me|text me|notify|updates|remember me|save (?:this|my)|keep me|allow|opt|accurate|true and correct|attest|declare|swear|pledge|signature|e-?sign\w*|electronic(?:ally)?|waive[rs]?|waiver|liabilit(?:y|ies)|release|disclos\w*|permission|code of conduct|have read|understand)\b/i;
export function consentLike(label: string): boolean {
  return CONSENT.test(label);
}

/**
 * Labels of boxes that sign the user up to hear from someone or share their data, beyond CONSENT's words: never
 * ticked or offered (D2-04 review: "Receive product announcements" was written). Boxes only: a menu labelled
 * "Preferred contact method" is a plain choice.
 */
const SIGN_UP = /\b(?:receive|announcements?|communications?|contact(?:ed)?|call me|calls|sms|texts?|messages|alerts|reminders|digest|mailing|partners?|third[- ]part(?:y|ies)|shar(?:e|ing)|sell|ads|advertis\w*|personali[sz]\w*|tracking|cookies?|surveys?|research|feedback|deals|discounts|hear (?:about|from)|interested in|learn (?:about|more)|verif(?:y|ies|ied|ication))\b/i;
/** Whether a box is one Caret never ticks or offers: a consent or a sign-up. */
export function boxNeverTicked(label: string): boolean {
  return CONSENT.test(label) || SIGN_UP.test(label);
}

/** A select's value that is a prompt, not a choice: nothing is picked yet. */
const PROMPT = /^(?:|select\b.*|choose\b.*|please (?:select|choose)\b.*|pick\b.*|-+.*-*|month|day|year|—)$/i;

const label = (n: Node): string | null => fieldLabelText(n.label);

/** The controls of a window that a fill may propose a value for, in document order. Only empty ones: no box ticked, no option picked, no date set. */
/** Whether a node sits inside a web page's area of the window (its AXWebArea), where a combobox is a custom widget. */
export function inWebArea(w: WindowState, n: Node): boolean {
  for (let k = n.parent; k !== null; ) {
    const p = w.nodes.get(k);
    if (p === undefined) return false;
    if (p.role === "AXWebArea") return true;
    k = p.parent;
  }
  return false;
}

export function formControls(w: WindowState): FormControl[] {
  const nodes = [...w.nodes.values()];
  // In a browser window, only the page's controls: the toolbar's popups and the tab strip's radio buttons are the browser's own.
  const web = nodes.find((n) => n.role === "AXWebArea");
  const inPage = new Set<string>();
  if (web !== undefined) {
    inPage.add(web.key);
    for (const n of nodes) if (n.parent !== null && inPage.has(n.parent)) inPage.add(n.key);
  }
  const ok = (n: Node): boolean => (web === undefined || inPage.has(n.key)) && n.subrole !== "AXTabButton" && !n.states?.includes("disabled");
  const out: FormControl[] = [];
  const radios = new Map<string, Node[]>();
  for (const n of nodes) {
    if (!ok(n) || n.role !== "AXRadioButton") continue;
    const k = n.parent ?? n.key;
    radios.set(k, [...(radios.get(k) ?? []), n]);
  }
  for (const n of nodes) {
    if (!ok(n)) continue;
    const parent = n.parent === null ? undefined : w.nodes.get(n.parent);
    if (n.role === "AXRadioButton") {
      // A group is one control, placed where its first button is, so the list stays in document order.
      const g = radios.get(n.parent ?? n.key) ?? [];
      if (g[0] !== n || g.length < 2 || g.some((m) => m.states?.includes("checked") === true)) continue;
      out.push({ node: parent ?? n, control: "radio", label: parent === undefined ? null : label(parent), options: g.map((m) => (m.label ?? "").trim()), members: g });
      continue;
    }
    if (n.role === "AXCheckBox") {
      // Consent, certification and sign-up boxes are never ticked, so they are not asked about (plan section 4).
      if (n.states?.includes("checked") === true || boxNeverTicked(fieldLabelText(n.label) ?? "")) continue;
      out.push({ node: n, control: "checkbox", label: label(n), options: null, members: [] });
      continue;
    }
    if (n.role === "AXDateField" || n.role === "AXTimeField") {
      if ((n.value ?? "") !== "") continue;
      out.push({ node: n, control: n.role === "AXDateField" ? "date" : "time", label: label(n), options: null, members: [], ...(n.role === "AXDateField" ? { format: dateFormat(n) } : {}) });
      continue;
    }
    // A date or time field's own picker button is part of that field.
    if (n.role === "AXPopUpButton" && parent?.role !== "AXDateField" && parent?.role !== "AXTimeField") {
      if (!PROMPT.test((n.value ?? "").trim())) continue;
      const items = nodes.filter((m) => m.parent === n.key && m.role === "AXMenuItem").map((m) => (m.label ?? m.value ?? "").trim()).filter((t) => t !== "");
      const options = [...new Set(items)];
      out.push({ node: n, control: "select", label: label(n), options: options.length >= 2 ? options : null, members: [] });
    }
  }
  return out;
}

const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const wordsOf = (s: string): string[] => norm(s).split(/[^\p{L}\p{N}]+/u).filter((x) => x !== "");

/** The one option equal to the value, ignoring case and spacing; null when none is, or more than one. */
export function matchOption(options: readonly string[], value: string): string | null {
  const hits = options.filter((o) => norm(o) === norm(value));
  return hits.length === 1 ? (hits[0] as string) : null;
}

/**
 * The one option the text names, as whole words in order ("Large, mushroom and onion" names "Large"; "no
 * pets" names "No"); null when it names none or more than one, so the choice is the user's. An exact
 * match wins first.
 */
export function optionInText(options: readonly string[], text: string): string | null {
  const exact = matchOption(options, text);
  if (exact !== null) return exact;
  const t = ` ${wordsOf(text).join(" ")} `;
  const hits = options.filter((o) => {
    const w = wordsOf(o);
    return w.length > 0 && t.includes(` ${w.join(" ")} `);
  });
  return hits.length === 1 ? (hits[0] as string) : null;
}

/** A weekday's full name, then the abbreviations an option's label may write it as. */
const WEEKDAYS: readonly (readonly string[])[] = [
  ["monday", "mon"],
  ["tuesday", "tue", "tues"],
  ["wednesday", "wed", "weds"],
  ["thursday", "thu", "thur", "thurs"],
  ["friday", "fri"],
  ["saturday", "sat"],
  ["sunday", "sun"],
];
/** Short words that name no option on their own. */
const NAMES_NOTHING: ReadonlySet<string> = new Set(["the", "and", "for", "with", "any", "all", "none", "other", "yes", "not", "one", "per", "from", "into", "only", "each", "some", "more", "less", "than", "then", "also", "your", "you", "our", "this", "that", "these", "those", "are", "was", "has", "have", "will", "can", "but", "nor", "its", "his", "her", "their", "them", "they", "she", "him", "who", "what", "when", "where", "which", "how", "why", "please", "put", "sign", "use", "fill", "pick", "choose", "select", "want", "like"]);

/**
 * The weekday (0 for Monday) a word of a label or a text names, or null. A full name in any case counts. An abbreviation
 * counts only written as a name is ("Sat", "Sat."): lowercase "sat" is the verb, and "SAT" the test.
 */
function weekdayOf(word: string): number | null {
  const lw = word.toLowerCase().replace(/\.$/u, "");
  const i = WEEKDAYS.findIndex((d) => d.includes(lw));
  if (i < 0) return null;
  return lw === WEEKDAYS[i]![0] || /^\p{Lu}\p{Ll}+\.?$/u.test(word) ? i : null;
}

/**
 * V3 (B24 ask-17): the one option of a select or radio group that a word of `text` names: a word of three or more letters
 * that is the first word of that option's label, compared without case ("saturday" names "Saturday 9–11am"), or the full
 * name of a weekday the label opens with abbreviated ("saturday" names "Sat 9:00 AM-12:30 PM"). Only the first word, so
 * "Lee" of "Bruce Lee" does not name "Jordan Lee". An option written in comma-separated parts names a place or a "Last,
 * First" name, which one shared word does not pick (C2: "Toronto, ON" is not "Toronto, Ontario, Canada"), so a word
 * names none of those. A word that opens every option names none; "several" when the words name two or more options,
 * so the choice is the user's; null when they name none, or the text holds a negating word ("not saturday"). A word of
 * `asked` (the field's own label and heading) names nothing: it repeats the question, as "job" in "How did you hear about
 * this job?" does for a note that opens "Job search" (V3 adversary: it offered "Job board").
 */
export function optionNamedBy(options: readonly string[], text: string, asked: readonly (string | null)[] = []): { option: string; word: string } | "several" | null {
  if (negates("", text)) return null;
  const question = new Set(asked.flatMap((t) => (t === null ? [] : wordsOf(t))));
  const optionWords = options.map((o) => (o.includes(",") ? [] : o.normalize("NFKC").split(/[^\p{L}\p{N}.]+/u).map((w) => w.replace(/\.$/u, "")).filter((w) => w !== "").slice(0, 1)));
  const hits = new Map<string, string>();
  for (const w of text.normalize("NFKC").split(/[^\p{L}\p{N}']+/u)) {
    const lw = w.toLowerCase();
    if (lw.length < 3 || !/^\p{L}+$/u.test(lw) || NAMES_NOTHING.has(lw) || question.has(lw)) continue;
    const day = weekdayOf(w);
    // A text's abbreviation that is not written as a name (the verb "sat") names nothing, even an option's "Sat".
    if (day === null && WEEKDAYS.some((d) => d.includes(lw))) continue;
    const named = options.filter((_o, i) => optionWords[i]!.some((t) => t.toLowerCase() === lw || (day !== null && weekdayOf(t) === day)));
    if (named.length === 0 || named.length === options.length) continue;
    for (const o of named) if (!hits.has(o)) hits.set(o, w);
  }
  if (hits.size === 0) return null;
  if (hits.size > 1) return "several";
  const [option, word] = [...hits][0] as [string, string];
  return { option, word };
}

/** Words that turn a statement into its opposite; a box is never ticked from text that holds one its label lacks. Any word ending in n't is one too. */
const NEGATION = new Set(["no", "not", "never", "none", "without", "nor", "neither", "cannot", "dont", "doesnt", "isnt", "arent", "wont", "cant"]);
/**
 * The words a box's label or a source may open with that only say who is asked or who speaks: "Are you", "Do you have",
 * "I have", "I'm". Only these opening words are set aside, and only once; a modal or a tense further in stays, so "I
 * will have a valid driving license" is not "I have a valid driving license" (D2-04 review).
 */
const OPENING = /^(?:are you|do you have|do you|have you|can you|is your|are your|i am|i'm|i have|i've|i hold|i|my)\s+/u;
/** A span that opens like a question asks; it states nothing, with a question mark or without one ("Are you a US citizen"). */
const ASKS = /^(?:(?:are|do|does|did|have|has|can|could|will|would|is|was|were|should|shall|may|might)\s+(?:you|your|they|we|he|she|it|this|there|i)\b|(?:what|which|when|where|who|whom|whose|why|how)\b)/u;
/** Answers that say yes to a "Label: answer" line. */
const AFFIRMATIVE = /^(?:yes|y|true|✓|✔)$/i;
/** Words of a list's label or line that make its items no plain choice: "Do not include: bacon", "If available: bacon". */
const NOT_A_CHOICE = new Set(["if", "unless", "except", "excluding", "exclude", "avoid", "optional", "maybe", "possibly", "perhaps", "allergic", "allergy", "allergies", "instead"]);

/** Lower-case words with their apostrophes kept, so "don't" stays one word. */
const tokens = (s: string): string[] => norm(s.replace(/[’‘]/g, "'")).split(/[^\p{L}\p{N}']+/u).filter((w) => w !== "");

/** The words of a box's label or a source line that state its fact: lower case, the opening words (OPENING) and articles set aside. */
function factWords(s: string): string {
  const t = tokens(s).join(" ").replace(/[?.!]+$/u, "");
  return t
    .replace(OPENING, "")
    .split(" ")
    .filter((w) => w !== "" && w !== "a" && w !== "an" && w !== "the")
    .join(" ");
}

/** Whether the text holds a negating word the label does not. */
export function negates(label: string, text: string): boolean {
  const own = new Set(tokens(label));
  return tokens(text).some((w) => (NEGATION.has(w) || w.endsWith("n't")) && !own.has(w));
}

/** Whether a span asks rather than states: it ends with a question mark or opens like a question. */
function asks(span: string): boolean {
  return /\?\s*$/u.test(span) || ASKS.test(tokens(span).join(" "));
}

/**
 * What a box's label is, which decides whether Caret proposes a tick for it at all (D2-04, after two reviews found
 * consent and certification wording no word list catches):
 * - "question": it asks the user a fact ("Are you over 18?", "Do you have a valid driving license?"). A tick a source
 *   states may be written. An opt-in asked as a question ("Would you like to receive …", "Do you want …", "Can we …")
 *   is no fact; it is "statement".
 * - "statement": the user speaks ("I have read …", "I want to hear …", "I verify …", "My answers are correct"). That is
 *   how consents, certifications and sign-ups read, so such a box never gets a value, written or handed off.
 * - "other": a bare phrase ("Valid driving license", "Bacon"). A tick may only be handed to the user, never written.
 */
export function boxKind(label: string): "question" | "statement" | "other" {
  const t = tokens(label).join(" ");
  if (/^(?:would you like|would you be|do you want|do you wish|do you agree|do you consent|can we|may we|shall we|should we|could we|is it ok)\b/u.test(t)) return "statement";
  if (/^(?:are you|do you have|do you|have you|can you|is your|are your|will you be|did you|were you)\b/u.test(t)) return "question";
  if (/^(?:i|i'm|i've|i'd|i'll|me|my|we|we're|our|us)\b/u.test(t)) return "statement";
  return "other";
}

/**
 * Whether a source states the fact a box asks (D2-04): the picked span is the user's own statement of the box's fact
 * ("I have a valid driving license" for "Do you have a valid driving license?"), or it is the yes of a "Label: answer"
 * line whose label is that fact ("Valid driving license: yes"). Only the opening words that say who is asked or speaks,
 * and articles, are set aside (factWords); every other word must match, in order, so a modal, a tense or a condition
 * makes it no match. A bare phrase ("Valid driving license") states nothing by itself: under "Requirements:" it is the
 * job's, not the user's, so the direct match needs a first-person span. Nothing is inferred from a related fact ("Age:
 * 34" for "Are you over 18?"), a question, or text or a context with a negating word the label lacks. Which boxes may
 * take such a tick at all is boxKind's and boxNeverTicked's.
 */
export function statesFact(label: string, span: string, context: string | null): boolean {
  const want = factWords(label);
  if (want === "" || negates(label, span) || asks(span) || (context !== null && negates(label, context))) return false;
  if (/^(?:i|i'm|i've)\b/u.test(tokens(span).join(" ")) && factWords(span) === want) return true;
  return context !== null && factWords(context) === want && AFFIRMATIVE.test(span.trim().replace(/[.!]+$/u, ""));
}

/**
 * Whether a span lists the box's label as one of two or more items ("Toppings: bacon, extra cheese" for "Bacon"): a
 * choice the source states, as an option of a list. The item must be the label exactly (its words, in order). A span
 * or its line's label with "or", a question, a negating word or a condition ("Do not include:", "If available:")
 * states no choice (D2-04 second review).
 */
export function namedInList(label: string, span: string, context: string | null = null): boolean {
  if (asks(span) || negates(label, span) || /\bor\b/iu.test(span)) return false;
  if (context !== null && (negates(label, context) || asks(context) || tokens(context).some((w) => NOT_A_CHOICE.has(w)))) return false;
  if (tokens(span).some((w) => NOT_A_CHOICE.has(w))) return false;
  const items = span.split(/\s*(?:,|;|\/|&|\band\b|\bplus\b)\s*/iu).map((x) => x.trim()).filter((x) => x !== "");
  const want = wordsOf(label).join(" ");
  return items.length >= 2 && want !== "" && items.some((x) => wordsOf(x).join(" ") === want);
}

const ROLE_NAMES: Record<FormControl["control"], string> = {
  combobox: "Dropdown",
  select: "Pop-up menu",
  radio: "Radio buttons",
  checkbox: "Checkbox",
  date: "Date field",
  time: "Time field",
};

/** The descriptor a question carries for a control: what it is, its label, its section, and the options it shows. */
export function describeControl(c: FormControl, section: string | null, nearest: string | null): string {
  const parts = [`${c.format === "datetime" ? "Date and time field" : ROLE_NAMES[c.control]}.`];
  if (c.label !== null) parts.push(`Label: '${c.label}'.`);
  else if (nearest !== null) parts.push(`Nearest label: '${nearest}'.`);
  if (c.options !== null) parts.push(`Options: ${c.options.map((o) => `'${o}'`).join(", ")}.`);
  if (section !== null && section !== c.label) parts.push(`Section: '${section}'.`);
  return parts.join(" ");
}
