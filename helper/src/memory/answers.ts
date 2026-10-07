// Saved answers (S1): the user's own answers to prose questions on forms ("Why do you want to work here?"), kept in
// answers.md with the question as that form asked it, where and when. Fill can offer one later, verbatim (fill/answers.ts).
//
// Two rules decide everything here:
//   - Only the user's own words. capture() saves only text the user typed into the field themselves, as the page's
//     content script saw it (Node.entry "typed"), and none of which Caret wrote. A paste is refused: Caret cannot tell
//     whose words were on the clipboard. The words are the user's only when the evidence says so; with no evidence the
//     answer is refused, never guessed.
//   - Only with consent. Leaving a field may produce an offer (answerSaveOffer); nothing is written until the user says
//     yes (answerSave), and the field is checked again then.
import { randomUUID } from "node:crypto";
import { MAX_ANSWER_CHARS, type AnswerFields, type AnswerRefusal } from "../protocol.ts";
import type { WindowState } from "../model.ts";
import type { Node } from "../protocol.ts";
import { fieldLabelText } from "../fill/descriptor.ts";
import { neverTypedNode } from "../fill/fill.ts";
import { siteKey } from "../fill/answers.ts";
import { words } from "../fill/kinds.ts";
import { MemoryDocumentError, type MemoryDocumentStore } from "./documents.ts";
import { encodeValue, MAX_LINE_CHARS, recordDigest, type MemoryRecord } from "./parse.ts";
import { refusal, sensitiveKind, statedSecret } from "./sensitive.ts";
import { WITHHELD, WITHHELD_SAYS } from "../privacy/exclude.ts";

/** The window kind of a browser tab the page engine reads (fill.ts PAGE_WINDOW_KIND; repeated to keep this module free of fill's). */
const PAGE = "page";
/**
 * A one-line text input counts as a prose field once it holds more than this many characters (lead decision, S1 brief:
 * "a text input over about 120 characters"). A textarea always does.
 */
const PROSE_INPUT_CHARS = 120;
/**
 * Leaving a field offers to save it only from this length up: "N/A" or "Yes" is not worth a question. Assumed, not
 * measured. A direct "remember this answer" has no minimum.
 */
export const OFFER_MIN_CHARS = 40;
/** The longest question kept, after spaces are collapsed. Matches AnswerFields.question. */
const MAX_QUESTION_CHARS = 300;
/**
 * A run this long shared with something Caret wrote into the field marks the text as Caret's. Caret's page writes also
 * show as entry "other" (untrusted input events); this is the second check, for writes the content script could not
 * see. Assumed, not measured: long enough that common phrases between two texts do not match by chance.
 */
const SHARED_RUN = 24;

export type SavedAnswer = { id: string; status: "active" | "paused"; fields: AnswerFields };

export class AnswerError extends Error {
  readonly why: AnswerRefusal;
  constructor(why: AnswerRefusal, message: string) {
    super(message);
    this.why = why;
  }
}

/** The question in a comparable form: lower case, its words only ("Why do you want to work here?" → "why do you want work here"). */
function normalQuestion(q: string): string {
  return words(q).join(" ");
}


/** Every usable answer in answers.md, active and paused, read fresh by stat. */
export function savedAnswers(store: MemoryDocumentStore): SavedAnswer[] {
  store.refresh("answer");
  return store.records("answer").flatMap((r) => (r.kind === "answer" ? [{ id: r.id, status: r.status === "paused" ? "paused" : "active", fields: r.fields }] : []));
}

/** The answer with this id as answers.md holds it now (checked by content, as before a write), or null when it is gone or broken. */
export function answerNow(store: MemoryDocumentStore, id: string): SavedAnswer | null {
  store.refresh("answer", true);
  const r = store.record(id);
  return r !== null && r.kind === "answer" ? { id: r.id, status: r.status === "paused" ? "paused" : "active", fields: r.fields } : null;
}

/** The saved answer a save of this question on this site would update: same question words, same site. Null for a new one. */
export function answerFor(store: MemoryDocumentStore, question: string, site: string | null): SavedAnswer | null {
  const q = normalQuestion(question);
  const s = siteKey(site);
  return savedAnswers(store).find((a) => normalQuestion(a.fields.question) === q && siteKey(a.fields.site) === s) ?? null;
}

/**
 * Writes an answer the user agreed to keep: a new record, or the one for the same question on the same site, updated.
 * Refuses, with the reason, an answer whose record line would be too long, or that holds what Caret never keeps
 * (documents.ts checks every write). Returns the answer's id.
 */
export function putAnswer(store: MemoryDocumentStore, fields: AnswerFields): string {
  if (fields.answer.length > MAX_ANSWER_CHARS) throw new AnswerError("tooLong", tooLongSays(fields.answer.length));
  // A JSON-quoted answer can grow past what a record line may hold (escapes), and the parser would then disable it.
  if (`- Answer: ${encodeValue(fields.answer)}`.length > MAX_LINE_CHARS) throw new AnswerError("tooLong", "This answer has too many special characters to keep in answers.md.");
  // documents.ts refuses a secret by its shape on every write; a stated one ("my password is …") is refused here.
  const stated = statedSecret(fields.answer);
  if (stated !== null) throw new AnswerError("secret", `${refusal(stated)}, and this answer has one.`);
  const was = answerFor(store, fields.question, fields.site);
  const r: MemoryRecord = { id: was?.id ?? `answer-${randomUUID().slice(0, 8)}`, kind: "answer", status: was?.status ?? "active", noticed: null, fields };
  try {
    store.put(r, was === null ? null : recordDigest({ id: was.id, kind: "answer", status: was.status, noticed: null, fields: was.fields }));
  } catch (e) {
    if (e instanceof MemoryDocumentError) throw new AnswerError(e.message.includes("doesn't keep") ? "secret" : "unavailable", e.message);
    throw e;
  }
  return r.id;
}

// MARK: - capture

/** What capture needs beyond the window: the page's address, and every value Caret wrote into this field. */
export interface CaptureContext {
  site: string | null;
  /** Values Caret wrote into this field (its executor's writes, or a host insert it was told of), newest last. */
  caretWrote: readonly string[];
}

export type CaptureResult = { ok: true; fields: Omit<AnswerFields, "savedOn"> } | { ok: false; why: AnswerRefusal; says: string };

const no = (why: AnswerRefusal, says: string): CaptureResult => ({ ok: false, why, says });

const tooLongSays = (n: number): string => `This answer is ${n.toLocaleString("en-US")} characters, and Caret keeps answers up to ${MAX_ANSWER_CHARS.toLocaleString("en-US")}.`;

/** Whether a node is a field for a written answer: a text area, or a one-line input holding more than PROSE_INPUT_CHARS. */
function isProseNode(n: Node, value = n.value ?? ""): boolean {
  if (n.editable !== true || n.states?.includes("secure") === true) return false;
  return n.role === "AXTextArea" || (n.role === "AXTextField" && value.length > PROSE_INPUT_CHARS);
}

/** The question a field asks, from its own label (uncut, unlike a Jev descriptor), one line, at most MAX_QUESTION_CHARS. */
function questionOf(n: Node): string | null {
  const t = fieldLabelText(n.label);
  if (t === null) return null;
  return t.length <= MAX_QUESTION_CHARS ? t : `${t.slice(0, MAX_QUESTION_CHARS - 1).trimEnd()}…`;
}

/** Whether `text` holds what Caret wrote: a write shorter than SHARED_RUN whole, a longer one by any run of SHARED_RUN characters. */
function holdsCaretText(text: string, wrote: string): boolean {
  const w = wrote.trim();
  if (w === "") return false;
  if (w.length <= SHARED_RUN) return text.includes(w);
  for (let i = 0; i + SHARED_RUN <= w.length; i++) if (text.includes(w.slice(i, i + SHARED_RUN))) return true;
  return false;
}

/**
 * Whether the text in `key` may be saved as the user's answer, and if so what would be saved. Every refusal says why,
 * in a sentence for the user. The checks, in order: a page form's prose field with a label, nothing Caret never keeps,
 * the user's own typing only, nothing Caret wrote, and a length Caret keeps.
 */
export function capture(w: WindowState, key: string, ctx: CaptureContext): CaptureResult {
  if (w.window.kind !== PAGE) return no("notPage", "Caret saves answers only from forms in your browser.");
  const n = w.nodes.get(key);
  if (n === undefined) return no("changed", "That field is no longer on the page.");
  const text = n.value ?? "";
  if (!isProseNode(n, text)) return no("notProse", "This field isn't for a written answer, so Caret won't save it.");
  const never = neverTypedNode(w, n);
  if (never !== null) return no("neverTyped", `${refusal(never)}.`);
  const question = questionOf(n);
  if (question === null) return no("noQuestion", "This field has no label, so Caret can't tell which question the answer is for.");
  if (text.trim() === "") return no("empty", "The field is empty, so there's nothing to save.");
  // SC1 2a: the model withheld a value in a secret format from this text when it read the window in.
  if (text.includes(WITHHELD)) return no("secret", `${WITHHELD_SAYS} in memory, and this answer had one.`);
  // A secret by its shape (a card number, a key), or one the text states ("my password is …"): review finding 6.
  const secret = sensitiveKind(question, text) ?? statedSecret(text);
  if (secret !== null) return no("secret", `${refusal(secret)}, and this answer has one.`);
  // The evidence for whose words these are comes from the page itself (PageEntry), checked before anything else Caret knows.
  if (n.entry === "pasted") return no("pasted", "You pasted some of this text, so Caret can't tell the words are yours.");
  if (n.entry === "other") return no("notTyped", "Something other than your typing changed this text, so Caret won't save it as yours.");
  if (n.entry !== "typed") return no("unseen", "Caret didn't see you type this, so it won't save it as yours.");
  if (ctx.caretWrote.some((v) => holdsCaretText(text, v))) return no("caretWrote", "Caret wrote some of this text, so it isn't yours to save.");
  if (text.length > MAX_ANSWER_CHARS) return no("tooLong", tooLongSays(text.length));
  return { ok: true, fields: { question, answer: text, site: ctx.site, form: w.window.title.trim() === "" ? null : w.window.title.trim().slice(0, 200) } };
}

/** The offer's sentence, and a saved answer's confirmation. */
export const OFFER_SAYS = "Save this answer for next time?";
export const savedSays = (question: string, updated: boolean): string => `${updated ? "Updated" : "Saved"} your answer to "${question}".`;
