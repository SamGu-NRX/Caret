// What code reads inside one line of a source window, beyond the line itself (C1). The candidate generator offers a
// line of 80 characters or less whole, so a note that says "I graduate from UT Austin in May 2027 with a BS in
// Computer Science" or "Mobile 555-0164 (no landline anymore)." offered nothing a field could take. Here code finds:
//   - typed values, as the reader types them (apps/screen-reader TypedValues.swift): emails, web addresses, phone
//     numbers, dates, and a postal code where the line shows it as one (after a US state, or a Canadian code);
//   - free text, only where the line bounds it: the value of a "Label: value" line up to a remark in parentheses, a
//     comma part of such a value that is a whole name, and a US place written "City, State".
// Every value is a span of the line exactly as written, so it traces to it; nothing is reworded or joined. Free text
// stops there because those spans have edges punctuation or a closed list sets: a name run, a remark's bracket, a
// state's name. A phrase in a sentence ("Started at Tallgrass Mechatronics in August") has no such edge, and where it
// ends would be a guess. The patterns are written for common note and mail text, not measured on a corpus.
import type { ValueKind } from "../protocol.ts";
import { dateShaped, isNameLike, NAME_JOINERS, namesIn, ORG_SUFFIX, textKind, timeShaped } from "./kinds.ts";
import { splitName, splitPlace } from "./derive.ts";
import { labelKind, statedSecret, valueKind } from "../memory/sensitive.ts";

/** A typed value found in a line: its text as written and where it starts. */
export interface LineValue {
  text: string;
  kind: ValueKind;
  at: number;
}

const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
/** Dates with a year: "October 18, 2026", "18 October 2026", "May 2021", "2026-11-01", "11/01/2026". A bare year or month is not one. */
const DATE = new RegExp(
  [
    `\\b${MONTH}\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}\\b`,
    `\\b\\d{1,2}(?:st|nd|rd|th)? (?:of )?${MONTH}\\.?,? \\d{4}\\b`,
    `\\b${MONTH}\\.?,? \\d{4}\\b`,
    "(?<![\\d/.-])\\d{4}-\\d{2}-\\d{2}(?![\\d/.-])",
    "(?<![\\d/.-])\\d{1,2}/\\d{1,2}/\\d{4}(?![\\d/.-])",
  ].join("|"),
  "gu",
);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const URL = /\bhttps?:\/\/[^\s<>()"'`]+|\bwww\.[^\s<>()"'`]+|\b(?:linkedin|github)\.com\/[^\s<>()"'`]+/giu;
/**
 * Phone numbers: international with a "+", ten digits in the North American groups, and seven digits joined by a
 * hyphen ("555-0147"). Digits or a joining mark on either side refuse it, so a part of a card number, a ZIP+4, a date
 * or a year range ("2021-2022") is never one.
 */
const PHONE = new RegExp(
  [
    "(?<![\\w+])\\+\\d{1,3}(?:[ .-]?\\(?\\d{1,4}\\)?){2,4}(?![\\w-]|[ .-]\\d)",
    "(?<![\\w+(-]|\\d[ .-])(?:1[ .-])?(?:\\(\\d{3}\\) ?|\\d{3}[ .-])\\d{3}[ .-]\\d{4}(?![\\w-]|[ .-]\\d)",
    "(?<![\\w+(.-]|\\d[ .])\\d{3}-\\d{4}(?![\\w-]|[ .-]\\d)",
  ].join("|"),
  "gu",
);
const US_STATE_NAMES =
  "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia";
const US_STATE_CODES = "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
/** A ZIP code right after a US state ("Oregon 97214", "TX 78701"), or a Canadian postal code ("L8P 2K4"). */
const POSTAL = new RegExp(`(?<=\\b(?:${US_STATE_NAMES}|${US_STATE_CODES}),? )\\d{5}(?:-\\d{4})?(?![\\w-])|\\b[A-Z]\\d[A-Z] ?\\d[A-Z]\\d\\b`, "gu");
/**
 * "City, State": one to three capitalized words, a comma, a US state's name, and no capitalized word after it. A state's
 * two-letter code is left out: "Hi Jo, OK so" would read as a place.
 */
const PLACE = new RegExp(`\\b(\\p{Lu}[\\p{L}'’.-]*(?: \\p{Lu}[\\p{L}'’.-]*){0,2}), (${US_STATE_NAMES})\\b(?! \\p{Lu})`, "gu");
/** Words that start a sentence or a phrase and are capitalized for that alone; a place does not start with one. */
const LEADING = new Set(["I", "In", "To", "From", "At", "Moved", "Moving", "Live", "Living", "Based", "Near", "The", "My", "Our", "And", "But", "So", "We", "Home", "Mail", "Meet"]);

/** The leading list mark of a note's line ("- ", "* ", "• "), which is not part of what the line says. */
const BULLET = /^(?:[-*•·–—]|•)\s+/u;
/** A line with runs of white space made single and its ends and list mark trimmed: the line the generator reads. */
export function bareLine(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().replace(BULLET, "");
}

/** "Label: value", the label short and holding no colon. */
export const LABELLED = /^([^:]{1,32}):\s+(.+)$/;

/** Whether a line shows a value Caret never types (a card number, a key) or is labelled as one: nothing of it is offered. */
export function secretLine(line: string): boolean {
  const m = LABELLED.exec(line);
  return valueKind(line) !== null || (m?.[1] !== undefined && labelKind(m[1]) !== null);
}

/**
 * G2 review: whether a text code would send beside a span (a clause, a block's head, a section) holds a secret: a line
 * secretLine refuses, or a stated one ("password: hunter2", "my PIN is 7319", memory/sensitive.ts statedSecret). A
 * clause can reach past what a line offered whole: "Email: robin@example.test password: hunter2 for the staging …"
 * is too long to be a span, and its email's clause sent the password.
 */
export function holdsSecret(text: string | null | undefined): boolean {
  return text !== null && text !== undefined && (secretLine(text) || statedSecret(text) !== null);
}

/** Lower wins when two values overlap, as the reader decides (TypedValues.swift priority). */
const PRIORITY: Record<string, number> = { email: 0, url: 1, phone: 2, address: 3, date: 4 };
const TRAILING_MARKS = /[.,;:!?)\]'"]+$/u;

/**
 * The typed values a line shows, in order, each a span of it: emails, web addresses, phone numbers, dates, and postal
 * codes (typed "address", as the reader types a whole address). A line that shows or is labelled as a value Caret never
 * types gives none.
 */
export function lineValues(line: string): readonly LineValue[] {
  const hit = valuesMemo.get(line);
  if (hit !== undefined) return hit;
  const found = scanValues(line);
  if (valuesMemo.size >= MEMO_LINES) valuesMemo.clear();
  valuesMemo.set(line, found);
  return found;
}

/**
 * Lines whose values were read, so a line the generator, the label check and the clause all read is scanned once: the
 * generator runs on the helper's event loop within GENERATOR_BUDGET_MS, and rescanning cost the corpus desks a third
 * more time. Bounded; the number is assumed, well above the lines of a few source windows.
 */
const MEMO_LINES = 4000;
const valuesMemo = new Map<string, readonly LineValue[]>();

/** The memo's arrays and values are shared by every caller, so they are frozen. */
function scanValues(line: string): readonly LineValue[] {
  return Object.freeze(scan(line).map((v) => Object.freeze(v)));
}

function scan(line: string): LineValue[] {
  if (secretLine(line)) return [];
  const hits: { text: string; kind: ValueKind; at: number }[] = [];
  const scan = (re: RegExp, kind: ValueKind, trim = false): void => {
    for (const m of line.matchAll(re)) {
      let text = m[0];
      if (trim) text = text.replace(TRAILING_MARKS, "");
      if (text.length < 3) continue;
      hits.push({ text, kind, at: m.index ?? 0 });
    }
  };
  scan(EMAIL, "email", true);
  scan(URL, "url", true);
  scan(PHONE, "phone");
  scan(POSTAL, "address");
  scan(DATE, "date");
  hits.sort((a, b) => (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9) || b.text.length - a.text.length);
  const taken: LineValue[] = [];
  for (const h of hits) if (!taken.some((t) => h.at < t.at + t.text.length && t.at < h.at + h.text.length)) taken.push(h);
  return taken.filter((v) => valueKind(v.text) === null).sort((a, b) => a.at - b.at);
}

/** A span of free text a line bounds, and the label of its "Label: value" line when it has one. */
export interface LineText {
  text: string;
  label: string | null;
  /**
   * The text a request must quote beside the span, or the span is not offered (C1 review): a value cut from before its
   * remark goes with the remark ("Dima (legal name Dmitri Halvorsen)."), so Jev reads what the note said about it.
   */
  with?: string;
  /**
   * W1: the labelled value this span is a part of (valueParts). A part is offered beside its whole value, quoting it
   * (`with`), and only a field that takes one value may take it (fill.ts): it is no complete answer for a prose field.
   */
  partOf?: string;
}

/**
 * What may follow a value in its "Label: value" line and is a remark about it, not part of it: "Dima (legal name …)". A
 * remark holds a letter: W1's guard adversary found "(720) 555-0146" read as a remark "720", which cut "mileage is 59,870
 * and the best number for you is" from a mail's line and let it into Current mileage.
 */
const REMARK = /^(.+?)\s+\(([^()]*\p{L}[^()]*)\)[.!]?(?:\s.*)?$/u;
/**
 * Words that make a remark a warning about the value before it ("Alex (do not use this old name; use Robin instead)"):
 * then the value is not offered apart from its line at all (C1 review). Written for common note wording, not measured.
 */
export const WARNS = /\b(?:not|don'?t|doesn'?t|never|no longer|old|former|previous|outdated|instead|wrong|ignore|except|unless|but)\b/iu;
/**
 * A comma part that may continue the name before it rather than start another fact: one or two capitalized words
 * ("University of California, Berkeley"; "Stanford University, Palo Alto"). The first part is then not offered alone.
 */
const CONTINUES = /^\p{Lu}[\p{L}'’-]*(?: \p{Lu}[\p{L}'’-]*)?$/u;

/**
 * W1: a note line that tells the user what to do is no value: live Jev put "use the token-leak story, write it fresh."
 * from "Incident question: use the token-leak story, write it fresh." into the Ashby task page's incident question in
 * all 5 passes (evidence/screen/lv1/r1-jev; key none). Read here as a verb telling the user to act followed by what it
 * acts on ("use the", "ask someone"), or a to-do ("still need to"), so a name that starts like a verb ("Send Labs",
 * "Skip") is not one. Derived from the corpora's own lines (distinct lines and labelled values: 236 in the realfill notes
 * and mails and F1's task notes and mails, 28 in W4's note): it takes 2 ("use the token-leak story, write it fresh.",
 * "still need to ask someone.") and no value any answer key holds (0 wrongly dropped; test/w1-wrongs.test.ts counts the
 * repository's, and W4's note and key gave 0 and 0 by the same count). Checked
 * where a value is written (writable.ts), so no candidate is removed and a field that asks for instructions to someone
 * else ("Delivery instructions") still takes one.
 */
const INSTRUCTION = /^(?:(?:use|write|ask|mention|bring|attach|send|pick|choose|tell|say)\s+(?:the|a|an|it|my|this|that|them|someone|something|one|him|her)\b|(?:still\s+)?need\s+to\b|(?:remember|don'?t\s+forget)\s+to\b|to-?do\b)/iu;

/** Whether a value is an instruction to the user rather than a value (INSTRUCTION). */
export function instructionText(value: string): boolean {
  return INSTRUCTION.test(value.trim());
}

/**
 * Words that end a role, for roleAt: a role at an organization names one ("Junior Analyst", "lab technician"). Written
 * for common job titles. Of the corpora's lines (as INSTRUCTION counts them) it splits only "Junior Analyst at Ridgeline
 * Outdoor Co" (from "Currently: …"), and no answer-key value (0 wrongly split; test/w1-wrongs.test.ts).
 */
const ROLE_WORDS = new Set(["analyst", "engineer", "manager", "technician", "designer", "developer", "director", "lead", "intern", "assistant", "specialist", "coordinator", "consultant", "scientist", "officer", "associate", "representative", "administrator", "nurse", "teacher", "editor", "writer", "accountant", "architect", "advisor", "programmer", "researcher", "supervisor", "clerk", "cashier", "owner", "founder", "president", "partner", "vp", "ceo", "cto", "cfo", "coo", "head", "chef", "attorney", "paralegal", "recruiter", "therapist", "pharmacist", "physician", "librarian", "producer", "strategist", "operator", "mechanic", "electrician", "planner", "buyer", "agent", "student", "fellow", "professor", "lecturer"]);
const ORG_WORD = /^[\p{Lu}\p{N}][\p{L}\p{N}'’&.-]*$/u;

/**
 * An organization as a note writes it: two to eight capitalized words (or numbers), joining words between, and a legal
 * suffix after a comma ("Ridgeline Outdoor Co, Inc."). One word is not enough: "Editor at Large", "Software at Scale".
 */
function orgRun(t: string): boolean {
  const head = t.replace(/,\s*([^,]+)$/u, (m, suffix: string) => (ORG_SUFFIX.test(suffix.trim()) ? "" : m));
  if (head.includes(",")) return false;
  const ws = head.split(/\s+/u);
  return ws.length >= 2 && ws.length <= 8 && ORG_WORD.test(ws[0] ?? "") && ORG_WORD.test(ws[ws.length - 1] ?? "") && ws.every((w) => ORG_WORD.test(w) || NAME_JOINERS.has(w));
}

/**
 * A role and the organization it is at, when that is the whole text: "Junior Analyst at Ridgeline Outdoor Co" gives
 * "Junior Analyst" and "Ridgeline Outdoor Co". The role is up to six words of letters with a word of ROLE_WORDS in it;
 * the organization runs to the end (orgRun). "The University of Texas at Austin" and "Editor at Large" are one value.
 */
export function roleAt(text: string): { role: string; org: string } | null {
  const m = /^(.+?)\s+at\s+(.+)$/u.exec(text.trim());
  if (m?.[1] === undefined || m[2] === undefined) return null;
  const role = m[1].trim();
  const org = m[2].trim().replace(SENTENCE_STOP, "");
  const words = role.toLowerCase().split(/\s+/u);
  if (words.length > 6 || !/^\p{L}[\p{L}'’&./ -]*$/u.test(role) || !words.some((w) => ROLE_WORDS.has(w.replace(/[.,]$/u, "")))) return null;
  return orgRun(org) ? { role, org } : null;
}

/** A closing period, "!" or ";" ends the sentence, unless it ends an abbreviation ("Acme, Inc.", "Jr.", "J."). */
const SENTENCE_STOP = /(?<!\b(?:Inc|Co|Corp|Ltd|Jr|Sr|St|Ave|Dr|\p{Lu}))[.!;]+$/u;

/** Whether a part of a line reads as a role: a name's shape ("Junior Analyst"), or a few lowercase words ("lab technician"). */
function roleLike(t: string): boolean {
  return isNameLike(t, null) || (/^\p{Ll}[\p{Ll}'’ -]*$/u.test(t) && !/^(?:my|his|her|their|our|your|the|a|an)\b/iu.test(t) && t.split(/\s+/u).length <= 4);
}

/** An amount with its sign; a comma inside it is followed by three digits ("$5,200"), so "$5,200, lab technician" still splits. */
const AMOUNT = /[$€£¥]\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[$€£¥]\s?\d+(?:\.\d+)?/gu;
/** What may follow a comma and still be part of a person's name: "Jr.", "MD", "PhD". */
const NAME_SUFFIX = /^(?:jr|sr|ii|iii|iv|phd|md|esq|dds|cpa|rn)\.?$/iu;
/**
 * Words that make a name an organization's, after which a part that may continue a name continues it as a place or a
 * campus ("Stanford University, Palo Alto"; "University of California, Berkeley"). Two people's names are not merged so:
 * "Elena Varga, Marcus Cole" is two values.
 */
const ORG_NAME_WORDS = /\b(?:university|college|institute|school|academy|hospital|clinic|labs?|inc|co|corp|company|group|bank|center|centre|museum|library|foundation|studio|systems|technologies|robotics|partners|associates)\b\.?/iu;
/** A street line ("455 Congress Ave", "12B Elm St") or a post office box ("PO Box 12"), at the head of an address. */
const ADDRESS_HEAD = /^(?:\d+[A-Za-z]?\s+\p{L}|P\.?\s?O\.?\s+Box\s+\d)/iu;
const UNIT_PART = /^(?:suite|ste|apt|apartment|unit|floor|fl|room|rm|building|bldg|#)\s*#?[\w-]+$/iu;
/** What follows the head of an address: a unit, a place in capitals (with a ZIP), a state code with a ZIP, a ZIP, a Canadian postal code. */
const ADDRESS_TAIL = /^(?:\p{Lu}[\p{L}'’.-]*(?:\s+\p{Lu}[\p{L}'’.-]*)*(?:\s+\d{5}(?:-\d{4})?)?|\p{Lu}{2}\s+\d{5}(?:-\d{4})?|\d{5}(?:-\d{4})?|[A-Z]\d[A-Z] ?\d[A-Z]\d)$/u;
/** Whether a text is one whole address: a street line or a box, then only units and place parts ("12 Main St, lab technician" is not). */
function wholeAddress(v: string): boolean {
  const parts = v.split(/\s*,\s*/u);
  return parts.length >= 2 && ADDRESS_HEAD.test(parts[0] as string) && parts.slice(1).every((p) => UNIT_PART.test(p) || ADDRESS_TAIL.test(p));
}

/**
 * W1: the values a text holds side by side, when it holds more than one; null when it reads as one value. Live Jev put
 * "Brightline Dental Labs, lab technician, $5,200/mo gross" (an employer, a role and money) into Job title, and "Junior
 * Analyst at Ridgeline Outdoor Co" (a role and an employer) into Current company (evidence/screen/lv1). A text holds
 * several values when it is a role at an organization (roleAt), or its comma or semicolon parts are values of different
 * shapes (a name, a typed value or amount, other words) or are all names or typed values ("Gary Pruitt, (512) 555-0193,
 * gpruitt@example.net"; "Elena Varga, Marcus Cole"). Typed values keep their own commas ("Jan 4, 2027"); a whole address,
 * date, time or place, a name written last name first, a legal or name suffix ("Acme, Inc.", "Okafor, MD") and a place
 * after an organization's name ("University of California, Berkeley") read as one. A list of like words ("English,
 * Spanish", "side door, ring twice") is one answer. A remark in brackets at the end is about the value, not counted.
 */
export function severalValues(text: string): readonly string[] | null {
  // The generator reads every line within GENERATOR_BUDGET_MS, also on its first call in a fresh process, and a desk
  // that runs out withholds every name: this reading first made a cold job-application desk 11.9 to 14.5 ms of 15, and
  // a live Ask then withheld every name on it (evidence/screen/w1/live-held09). Most lines hold no comma, semicolon or
  // "at", and the readers below compile their patterns when this module loads (WARM), not inside a fill.
  if (!SPLITS.test(text)) return null;
  const hit = severalMemo.get(text);
  if (hit !== undefined) return hit;
  const found = readSeveral(text);
  if (severalMemo.size >= MEMO_LINES) severalMemo.clear();
  severalMemo.set(text, found === null ? null : Object.freeze(found));
  return found;
}
const SPLITS = /[,;]|\sat\s/u;
const severalMemo = new Map<string, readonly string[] | null>();

function readSeveral(text: string): string[] | null {
  let v = text.trim().replace(SENTENCE_STOP, "");
  const remark = /^(.+?)\s*\([^()]*\)$/u.exec(v);
  if (remark?.[1] !== undefined) v = remark[1].trim();
  if (v === "") return null;
  const at = /\sat\s/u.test(v) ? roleAt(v) : null;
  if (at !== null) return [at.role, at.org];
  if (wholeAddress(v) || dateShaped(v) || timeShaped(v) || splitPlace(v) !== null) return null;
  const kind = textKind(v);
  if (kind !== "text" && kind !== "address" && kind !== "street") return null;
  // Typed values and amounts masked, length for length, so their commas split nothing.
  let masked = v;
  const mask = (at0: number, len: number): void => {
    masked = masked.slice(0, at0) + "\u0001".repeat(len) + masked.slice(at0 + len);
  };
  for (const x of lineValues(v)) mask(x.at, x.text.length);
  for (const m of v.matchAll(AMOUNT)) mask(m.index ?? 0, m[0].length);
  const parts: string[] = [];
  let from = 0;
  for (const m of masked.matchAll(/\s*;\s*|,\s+/gu)) {
    parts.push(v.slice(from, m.index).trim());
    from = (m.index ?? 0) + m[0].length;
  }
  parts.push(v.slice(from).trim());
  const typedAt = (p: string): boolean => {
    const i = v.indexOf(p);
    return i >= 0 && masked.slice(i, i + p.length).includes("\u0001");
  };
  const kept: string[] = [];
  for (const p of parts.filter((x) => x !== "")) {
    const prev = kept[kept.length - 1];
    // Read without a remark in brackets: "University of California, Berkeley (UC Berkeley)" still continues the name.
    const bare = p.replace(/\s*\([^()]*\)/gu, "").trim();
    if (prev !== undefined && (ORG_SUFFIX.test(bare) || NAME_SUFFIX.test(bare) || (ORG_NAME_WORDS.test(prev) && CONTINUES.test(bare)))) kept[kept.length - 1] = `${prev}, ${p}`;
    else kept.push(p);
  }
  // A name written last name first ("Okafor, Riley Ade") is one value: a one-word surname, a comma, then the rest.
  if (kept.length < 2 || (kept.length === 2 && !/\s/u.test(kept[0] as string) && splitName(v).kind === "split")) return null;
  const shape = (p: string): "typed" | "name" | "words" => (typedAt(p) ? "typed" : isNameLike(p, null) ? "name" : "words");
  const shapes = kept.map(shape);
  return new Set(shapes).size > 1 || shapes.every((x) => x !== "words") ? kept : null;
}

/**
 * Lines that take each path of readSeveral once, read when this module loads so the patterns they use (kinds.ts
 * textKind and dateShaped, derive.ts splitPlace and splitName, roleAt, lineValues) are compiled before the first fill.
 * readSeveral itself keeps nothing; lineValues keeps these few lines in its memo.
 */
const WARM = ["Junior Analyst at Ridgeline Outdoor Co", "4410 Speedway Apt 2, Austin, Texas 78751", "Jan 4, 2027, 3:00 PM", "Austin, Texas", "Okafor, Riley Ade", "Gary Pruitt, (512) 555-0193, $5,200, gpruitt@example.net"];
for (const line of WARM) readSeveral(line);

/** Whether a text is a question and its answer on one line ("What are your salary expectations?: $185,000"): a label and its value, never one value. */
export function questionAnswer(text: string): boolean {
  return /^[^:?]{2,200}\?:\s+\S/u.test(text.trim());
}

/**
 * W1: the parts of a labelled value that holds several values (severalValues) a field that takes one value could take:
 * a role or an organization ("lab technician", "Ridgeline Outdoor Co"), each a span of the line. A part holding a typed
 * value or an amount is not one: that value is offered as the window's typed value.
 */
function valueParts(value: string): string[] {
  return (severalValues(value) ?? []).filter((p) => !typedPart(p) && p.split(/\s+/u).length <= 6 && (isNameLike(p, null) || roleLike(p)));
}
const typedPart = (p: string): boolean => lineValues(p).length > 0 || new RegExp(AMOUNT.source, "u").test(p) || /\d/u.test(p);
/** Labels that name an organization, though "name" is in them: "Company name", "Employer". */
const ORG_LABEL = /\b(?:company|employer|business|organi[sz]ation|school|university|college|firm)\b/iu;

/** Labels that say their value is a person: "Emergency contact", "Reference", "Landlord". Written for common note labels, not measured. */
const PERSON_LABEL = /\b(?:name|contact|reference|referee|landlord|manager|spouse|partner|husband|wife|parent|guardian|recruiter|advisor|supervisor)\b/iu;

/**
 * Free text a line bounds (see the file's head), each a span of the line other than the line or its labelled value
 * whole, which the generator already offers:
 *   - in a "Label: value" line, the value before a remark in parentheses ("Preferred first name: Dima (legal name
 *     Dmitri Halvorsen)." gives "Dima"); and the value's first comma part when it is a whole name ("School: Lakeshore
 *     Polytechnic Institute, B.S. …" gives "Lakeshore Polytechnic Institute"), or, under a label that says a person,
 *     the one name run that ends it ("Emergency contact: my husband Marcus Cole, 555-0171" gives "Marcus Cole"); each
 *     under the line's label. Only the first part: it is what the label names, and later parts are other facts;
 *   - W1: in a "Label: value" line whose value holds several values (severalValues) and no warning, under a label that
 *     says no person, each part that is a role or a name ("work: Brightline Dental Labs, lab technician, $5,200/mo gross"
 *     gives "lab technician"; "Currently: Junior Analyst at Ridgeline Outdoor Co (since 2024)" gives "Junior Analyst" and
 *     "Ridgeline Outdoor Co"), under the line's label, beside the whole value (candidates.ts spanOfLine) and quoting it;
 *   - anywhere, a US place written "City, State" ("Moving to San Diego, California in November"), with no label.
 * A one-word part ("Languages: English, Spanish") is no name, and a list of like words holds one value, so such a list is
 * never broken into items.
 */
export function lineTexts(line: string): LineText[] {
  // G2 review: a line that states a secret gives no free text: each bounded span could carry it.
  if (holdsSecret(line)) return [];
  const out: LineText[] = [];
  const add = (text: string, label: string | null, quote?: string, partOf?: string): void => {
    const t = text.trim().replace(/[.,;:!?]+$/u, "");
    if (t.length < 2 || !line.includes(t) || out.some((o) => o.text === t)) return;
    out.push({ text: t, label, ...(quote === undefined ? {} : { with: quote }), ...(partOf === undefined ? {} : { partOf }) });
  };
  const m = LABELLED.exec(line);
  const label = m?.[1]?.trim() ?? null;
  const value = m?.[2]?.trim() ?? null;
  // A labelled value its line warns about ("Legal name: Alex Smith (do not use this old name ...)") gives no piece of
  // itself: only the whole value, whose words Jev reads (C1 review).
  if (label !== null && value !== null && !WARNS.test(value)) {
    const r = REMARK.exec(value);
    if (r?.[1] !== undefined && !r[1].includes("(")) add(r[1], label, value);
    const parts = value.split(/\s*[,;]\s*/u);
    const first = (parts[0] ?? "").replace(/\s*\(.*$/u, "").replace(/[.!?]+$/u, "").trim();
    const next = (parts[1] ?? "").replace(/\s*\(.*$/u, "").replace(/[.!?]+$/u, "").trim();
    if (first !== "" && !/\d/u.test(first) && !CONTINUES.test(next)) {
      if (isNameLike(first, null)) add(first, label);
      else if (PERSON_LABEL.test(label)) {
        const names = namesIn(first);
        if (names.length === 1 && first.endsWith(names[0] as string)) add(names[0] as string, label);
      }
    }
    // Under a label that says a person, only the name above: a later part is another fact about them (their employer).
    // A label that names an organization is no person's, though it says "name" ("Company name").
    if (!PERSON_LABEL.test(label) || ORG_LABEL.test(label)) for (const p of valueParts(value)) add(p, label, value, value);
  }
  for (const p of line.matchAll(PLACE)) {
    const city = (p[1] ?? "").split(" ");
    // "In Austin, Texas" is capitalized from "In"; the place starts after the words a sentence capitalizes.
    while (city.length > 1 && LEADING.has(city[0] as string)) city.shift();
    if (LEADING.has(city[0] as string)) continue;
    add(`${city.join(" ")}, ${p[2] ?? ""}`, null);
  }
  return out.filter((o) => o.text !== value && o.text !== line);
}

/** How much of a long line a value's description quotes around it, at most. */
export const CLAUSE_MAX = 90;

/**
 * The clause of a line that holds a value at `at`: the sentence around it, cut at a sentence's end, a semicolon or a
 * bracket, and to CLAUSE_MAX characters around the value. Jev reads it to tell a value the line gives from one it warns
 * about ("Cell: 555-0147. Don't give out 555-0112, that's Mom and Dad's landline."). Null when the clause is the value.
 */
export function clauseAround(line: string, at: number, text: string): string | null {
  const end = at + text.length;
  let start = 0;
  for (const m of line.slice(0, at).matchAll(/[.!?;]\s+|[()]/gu)) start = (m.index ?? 0) + m[0].length;
  // A remark in brackets right after the value is part of what the line says about it: "555-0101 (my old number)".
  const remark = /^\s*\([^()]*\)/u.exec(line.slice(end));
  const from = remark === null ? end : end + remark[0].length;
  const after = /[.!?;]\s|[()]|[.!?;]$/u.exec(line.slice(from));
  let stop = after === null ? line.length : from + after.index + (after[0].startsWith(")") || after[0].startsWith("(") ? 0 : 1);
  if (stop - start > CLAUSE_MAX) {
    // Cut to whole words around the value, at most CLAUSE_MAX characters.
    const room = Math.max(0, CLAUSE_MAX - text.length);
    const from = Math.max(start, at - Math.floor(room / 2));
    const to = Math.min(stop, from + text.length + room);
    const head = line.slice(from, at);
    const tail = line.slice(end, to);
    start = from > start && /\s/u.test(head) ? from + head.search(/\s/u) + 1 : from;
    stop = to < stop && /\s/u.test(tail) ? end + tail.lastIndexOf(" ") : to;
  }
  const clause = line.slice(start, stop).trim();
  return clause === text || clause === "" ? null : clause;
}

/**
 * G2: the part of a value's clause (clauseAround) that says what the value is, for a date, an email or a phone number:
 * the comma or semicolon part that holds it, and when that part holds no word of its own beside typed values ("555-0139"
 * in "my cell, 555-0139, or this email"), the parts either side joined on. A whole sentence did not fit the window's
 * budget on F1's task notes after their spans (evidence/screen/g2/whose/probe-head.json: the School line's dates and the
 * reference's phone went out bare); "September 2016 to May 2020" costs four characters beyond its two dates. Null when
 * that part is the value alone.
 */
export function partAround(line: string, at: number, text: string): string | null {
  const clause = clauseAround(line, at, text);
  if (clause === null) return null;
  const from = clause.indexOf(text);
  if (from < 0) return clause;
  // Typed values and the value itself are masked, so their own commas ("October 18, 2026") split nothing.
  let masked = clause;
  const mask = (i: number, n: number): void => void (masked = masked.slice(0, i) + "\u0001".repeat(n) + masked.slice(i + n));
  for (const v of lineValues(clause)) mask(v.at, v.text.length);
  mask(from, text.length);
  const cuts: [number, number][] = [];
  let start = 0;
  for (const m of masked.matchAll(/\s*[,;]\s+/gu)) {
    cuts.push([start, m.index ?? 0]);
    start = (m.index ?? 0) + m[0].length;
  }
  cuts.push([start, masked.length]);
  const k = cuts.findIndex(([s, e]) => s <= from && from < e);
  if (k < 0) return clause;
  const word = (i: number): boolean => /\p{L}{2,}/u.test(masked.slice(cuts[i]?.[0] ?? 0, cuts[i]?.[1] ?? 0));
  let [a, b] = [k, k];
  if (!word(k)) [a, b] = [Math.max(0, k - 1), Math.min(cuts.length - 1, k + 1)];
  const part = clause.slice(cuts[a]?.[0] ?? 0, cuts[b]?.[1] ?? clause.length).trim().replace(/[.!?;,]+$/u, "");
  return part === text || part === "" ? null : part;
}

/**
 * Where a sentence ends: ". ", "! " or "? " after a lowercase word or a number and before a capital letter. A period
 * after a capital, a single letter or a lowercase abbreviation ("U.S.", "B.S.", "Corp.", "Dr. Lee", "e.g.", "vs.") ends
 * nothing, nor one before a quote or a bracket, so a
 * sentence is read too long rather than too short and its warning stays in (C1 review). "I live in Denver. Then" reads as
 * one sentence; that costs budget, never a warning.
 */
const SENTENCE_END = /(?<=(?:\b\p{Ll}[\p{Ll}'’-]+|\d|["'”’)\]]))(?<!\b(?:vs|etc|approx|incl|est|dept|misc|viz|cf|ca|al|ie|eg))[.!?]\s+(?=\p{Lu})/gu;

/**
 * The sentence of a line that holds a value at `at`, uncut: from the end of the sentence before (". ", "! ", "? ") to the
 * end of its own, a bracketed remark right after the value included. A warning in it may be about the value, so fill
 * sends it whole with the value, or not the value (candidates.ts lineFact).
 */
export function sentenceAround(line: string, at: number, text: string): string {
  let start = 0;
  for (const m of line.slice(0, at).matchAll(SENTENCE_END)) start = (m.index ?? 0) + m[0].length;
  const end = at + text.length;
  const remark = /^\s*(?:\([^()]*\)|\[[^[\]]*\])/u.exec(line.slice(end));
  const from = remark === null ? end : end + remark[0].length;
  // Searched in the whole line from the value on, so the lookbehind sees the word before a period.
  const ends = new RegExp(SENTENCE_END.source, "gu");
  ends.lastIndex = from;
  const stop = ends.exec(line);
  return line.slice(start, stop === null ? line.length : stop.index + 1).trim();
}
