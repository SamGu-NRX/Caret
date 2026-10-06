// What an Ask says to the user when it refuses or asks a question (B26 lead decision 3), all in this file. Each
// sentence names its reason in plain words. None shows a window id, a field or window ref, or a model's or
// provider's error text: those go in the error's detail, for logs and the scoreboard (SaidError.detail).
//
// Before B26 the user read what the failing check wrote for a developer: "Caret stops before payment" for an SSN,
// nothing for "hit submit", and "no candidate values in any window other than 92930-…" (B25's held-out run).
import type { PlanErrorCode } from "../protocol.ts";
import { SENSITIVE_SAYS, type SensitiveKind } from "../memory/sensitive.ts";
import { PlannerError, type HandoffWhy } from "./validate.ts";
import type { FillErrorWhy } from "../fill/fill.ts";

/** A PlannerError whose message is a sentence from this file, with what the check found kept apart. */
export class SaidError extends PlannerError {
  readonly detail: string;
  constructor(code: PlanErrorCode, says: string, detail: string = says) {
    super(code, says);
    this.detail = detail;
  }
}

/**
 * The part of an Ask a refusal leaves unclear (B29): which fields, where to copy from, or whose details. An Unclear
 * refusal may become a question with choices (planner/choices.ts) when code can list that part's real candidates;
 * otherwise the user reads its sentence, as before.
 */
export type AskPart = "fields" | "source" | "person";

export class Unclear extends SaidError {
  readonly part: AskPart;
  constructor(part: AskPart, says: string, detail: string = says) {
    super("unsure", says, detail);
    this.part = part;
  }
}

/** The question an Ask asks with choices, by part (B29). Short, and in the user's terms. */
export const ASKS: Record<AskPart, string> = {
  fields: "Which fields should Caret fill?",
  source: "Where should Caret copy from?",
  person: "Whose details go in?",
};

export const SAYS = {
  payment: "Paying is yours to do. Caret stops before payment.",
  submit: "Submitting is yours to do.",
  send: "Sending is yours to do.",
  delete: "Deleting is yours to do.",
  whichPerson: "Which person do you mean? Say their name.",
  noSuchField: "This form has no field for that.",
  notOnScreen: "Caret can't see what you want copied. Open it and ask again.",
  cannot: "Caret can't do that on this form.",
  whichFields: "Which fields do you mean? Name one.",
  whichSource: "Where should Caret copy from? Name the note or the email.",
  whichWindow: "Which window do you mean? Say its name.",
  whichField: "Which field do you mean? Say its label.",
  nothingOnScreen: "Caret found nothing on screen to copy into those fields.",
  nothingToDo: "Caret found nothing to do for that here.",
  unsure: "Caret wasn't sure what you meant. Say which fields and what goes in them.",
  notEditable: "Caret can't type in that field.",
  untraced: "Caret couldn't find that value on screen, in memory or in what you wrote.",
  wrongKind: "That value doesn't fit the field.",
  privacy: "Your instruction quotes more of an open window than Caret may send. Shorten it and ask again.",
  unreachable: "Caret couldn't reach its model just now. Try again.",
  misread: "Caret couldn't work out what you meant. Say it another way.",
  windowClosed: "That window isn't open anymore.",
  windowChanged: "The form changed while Caret worked on it. Ask again.",
  noPlan: "Caret couldn't make a plan for that.",
  onlyFills: "Caret only fills in fields. Pressing buttons and opening things is yours to do.",
  fillNothing: "Caret found nothing on screen to fill this form with.",
  fillLabelTooLong: "This field's label is too long for Caret to ask about. Fill it yourself.",
  fillFailed: "Caret couldn't fill this form just now. Try again.",
  paused: "Caret is paused. Turn it back on and ask again.",
  fileNoPlan: "That plan doesn't attach a file anymore. Ask again.",
  fileUnreadable: "Caret couldn't read that file, so it attached nothing. Choose another one.",
  fileTooBig: "That file is over 10 MB, more than Caret attaches. Choose a smaller one.",
  noReader: "Caret can't read the screen right now, so it can't plan that.",
  // H10: the browser is in front, its page engine is connected, and the tab the user is in could not be read.
  pageUnread: "Caret can't read this page. Reload it and ask again.",
  questionGone: "That question has expired. Ask again.",
  /** L1: a goal needs a program writer, and none is configured until the browser loop replaces it. */
  noPlanWriter: "Caret can't plan tasks like this yet. Do this one yourself for now.",
} as const;

/**
 * What the user reads when a fill on focus fails (B27): a sentence for each FillError reason, and for any other error
 * (a network failure, a timeout). B26 found the helper's error still read "fill: no candidate values in any window
 * other than 92930-…"; that text, ids and all, now goes only to the log.
 */
export function fillSays(why: FillErrorWhy | null): string {
  switch (why) {
    case "noWindow":
      return SAYS.windowClosed;
    case "noField":
      return SAYS.notEditable;
    case "instructionTooLong":
      return SAYS.privacy;
    case "labelTooLong":
      return SAYS.fillLabelTooLong;
    case "nothingToCopy":
      return SAYS.fillNothing;
    case "badAnswer":
    case null:
      return SAYS.fillFailed;
  }
}

/** The sentence for an error code when no check gave a more specific one. */
export function saysFor(code: PlanErrorCode): string {
  switch (code) {
    case "schema":
    case "internal":
      return SAYS.misread;
    case "noWindow":
      return SAYS.notOnScreen;
    case "unsure":
      return SAYS.unsure;
    case "nothingToDo":
      return SAYS.nothingToDo;
    case "unsupportedStep":
      return SAYS.onlyFills;
    case "multipleWindows":
    case "ambiguousWindow":
      return SAYS.whichWindow;
    case "unknownWindow":
      return SAYS.windowChanged;
    case "unseenWindow":
      return SAYS.windowClosed;
    case "unknownTarget":
      return SAYS.noSuchField;
    case "ambiguousTarget":
      return SAYS.whichField;
    case "notEditable":
      return SAYS.notEditable;
    case "untracedValue":
      return SAYS.untraced;
    case "wrongKind":
      return SAYS.wrongKind;
    case "stepAfterHandoff":
    case "riskMismatch":
      return SAYS.noPlan;
    case "unavailable":
    case "jevFailed":
      return SAYS.unreachable;
    case "privacy":
      return SAYS.privacy;
    case "questionGone":
      return SAYS.questionGone;
  }
}

/** "Caret doesn't type Social Security numbers. Type it yourself." */
export function saysNeverTyped(kind: SensitiveKind, ssn: boolean): string {
  return `Caret doesn't type ${ssn ? "Social Security numbers" : SENSITIVE_SAYS[kind]}. Type it yourself.`;
}

/** Whether a label or an instruction calls a government ID a Social Security number. */
export const saysSsn = (text: string): boolean => /\b(?:ssn|social\s+security)\b/iu.test(text);

const SEND_WORDS = /\b(?:send|reply|email it|mail it)\b/iu;
const DELETE_WORDS = /\b(?:delete|remove|scrap|discard|trash)\b/iu;
const PAY_WORDS = /\b(?:pay|purchase|buy|checkout|check out|place the order)\b/iu;
const SUBMIT_WORDS = /\b(?:submit|press|click|hit)\b/iu;

/** The press an instruction asks for, by the words it uses: send, delete, pay, or submit for anything else. */
export function saysPressAsked(instruction: string): string {
  if (SEND_WORDS.test(instruction)) return SAYS.send;
  if (DELETE_WORDS.test(instruction)) return SAYS.delete;
  if (PAY_WORDS.test(instruction)) return SAYS.payment;
  return SAYS.submit;
}

/**
 * Whether an instruction uses any word saysPressAsked reads as a press, or a plain submit, press, click or hit (B29:
 * such an Ask is never asked about with choices). One list for both, since B29's first review found "email it" in
 * saysPressAsked and missing from a second copy.
 */
export const asksPress = (instruction: string): boolean => [SEND_WORDS, DELETE_WORDS, PAY_WORDS, SUBMIT_WORDS].some((re) => re.test(instruction));

/** A plan whose only step hands the user a press: what pressing it is, by the risk table's reason and its label. */
export function saysPress(why: HandoffWhy, label: string): string {
  switch (why) {
    case "money":
      return SAYS.payment;
    case "destructive":
      return SAYS.delete;
    case "outbound":
      return /\bsend\b/iu.test(label) ? SAYS.send : SAYS.submit;
    default:
      return `Pressing ${quoted(label)} is yours to do.`;
  }
}

/** "Caret found nothing to put in Phone or Company name." */
export const saysNoValue = (names: readonly string[]): string => `Caret found nothing to put in ${list(names, "or")}.`;

/** "Caret wasn't sure what goes in Your name or Email address. Say what goes there and ask again." */
export const saysUnsure = (names: readonly string[]): string => `Caret wasn't sure what goes in ${list(names, "or")}. Say what goes there and ask again.`;

/** A value the user spelled out that reads more than one way, asked about by the field's kind of control. */
export function saysAmbiguous(said: string, control: string | undefined, name: string | undefined): string {
  const q = quoted(said);
  switch (control) {
    case "time":
      return `Is ${q} in the morning or the evening? Say it with am or pm.`;
    case "date":
      return `Which date is ${q}? Say the day, the month and the year.`;
    case "select":
    case "radio":
      return `${capital(q)} doesn't match one option of ${name === undefined ? "that field" : field(name)}. Which option do you mean?`;
    default:
      return `${capital(q)} can be read more than one way. Say it in full.`;
  }
}

/** Fields an Ask left to the user because Caret never types them: "Social Security number is yours to type. Caret doesn't type Social Security numbers." */
export function saysLeftToYou(fields: readonly { name: string; kind: SensitiveKind }[]): string | null {
  if (fields.length === 0) return null;
  const kinds = [...new Set(fields.map((f) => (saysSsn(f.name) ? "Social Security numbers" : SENSITIVE_SAYS[f.kind])))];
  return `${capital(list(fields.map((f) => f.name), "and"))} ${fields.length === 1 ? "is" : "are"} yours to type. Caret doesn't type ${list(kinds, "or")}.`;
}

/** A field's label as a sentence says it: no "(optional)", required marks or trailing colon. */
export function field(name: string): string {
  return name.replace(/\((?:required|optional)\)/giu, "").replace(/[*:✱∗]/gu, "").replace(/\s+/gu, " ").trim() || "that field";
}

/** Names joined as a sentence lists them, four at most: "A", "A or B", "A, B or C", "A, B, C, D or 2 more". */
function list(names: readonly string[], conj: "or" | "and"): string {
  const xs = [...new Set(names.map(field))];
  if (xs.length <= 1) return xs[0] ?? "those fields";
  const shown = xs.length > 4 ? [...xs.slice(0, 4), `${xs.length - 4} more`] : xs;
  return `${shown.slice(0, -1).join(", ")} ${conj} ${shown[shown.length - 1] as string}`;
}

const quoted = (s: string): string => `"${s.replace(/\s+/gu, " ").trim().slice(0, 60)}"`;
const capital = (s: string): string => (s === "" ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`);
