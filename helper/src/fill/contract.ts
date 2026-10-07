// W2 (AC1, ~/.caret-run/design/arch/AC1-zero-wrong.md): the one contract every copied value meets before it is written.
//
// Why: before W2 five call sites each ran writable.ts writeMisfit on different inputs (fill passed the field's label,
// part and the source's label; validation dropped the source label; goal lowering and code plans passed the label
// alone; routines passed nothing), so "Mary Ann" passed fill and failed validation, and a writer goal wrote what fill
// refused (REVIEW-R2). Here a value's field and provenance are read once, where the value is chosen, and travel with
// it. A write is allowed only by a CheckedValue: an object only checkValues and mintExempt create, recorded by
// identity, so neither a copy (structuredClone, JSON) nor a look-alike passes isChecked. Each place that compiles page
// steps (fill-popup.ts fillPlan, planner/validate.ts validatePlan, goals/lower.ts and goals/runs.ts propose,
// patterns/engine.ts plan) asks for the mint of each value it writes and throws ContractError without one.
//
// What checks a value: the deterministic checks with one correct answer (shapeRefusal), then W1's text-shape gate
// (writeMisfit with the carried provenance) until the verifier replaces it family by family (AC1 section 6). Values
// whose exactness code settles (an option's own label, a resolved date, the user's saved answer, a user transfer, a
// draft) are minted under a named exemption instead (ExemptRule); only the never-typed check runs on them.
import { Disclosure, type ModelText, type ModelValue } from "../privacy/disclosure.ts";
import type { AutocompleteToken, FillMemory, FillWithheld, Node, ValueKind } from "../protocol.ts";
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import { createHash } from "node:crypto";
import { bareLine, LABELLED, lineDigests, logicalLines, sentenceAround } from "./line-values.ts";
import { spanContexts } from "./candidates.ts";
import { redactWindow } from "./redact.ts";
import { describeControl, type Control, type FormControl } from "./controls.ts";
import { asksCountry, datePart, fieldPart, partFits, type FillPart } from "./derive.ts";
import { describeField } from "./descriptor.ts";
import { authorityRefusal, fieldFingerprint, scopeRefusal, type Authority, type DocumentReader, type Origin } from "./ask-scope.ts";
import { sentLineFor } from "./when.ts";
import { CURRENCY_SHOWN, DATE_FORMAT, fieldKinds, misfit, textKind } from "./kinds.ts";
import { writeMisfit, type ShapeSource } from "./writable.ts";
import { labelKind, secretText, SENSITIVE_SAYS } from "../memory/sensitive.ts";
import { secretIn } from "../planner/trace.ts";
import type { AskJev, JevRequest } from "./jev.ts";
import { WITHHELD } from "../privacy/exclude.ts";

/** The page walk's text input kind (protocol.ts PageControlKind), projected into Node by toWindowSnapshot; null through Accessibility. */
export type InputKind = "text" | "email" | "tel" | "url" | "number" | "search" | "date" | "time" | "datetime" | "month" | "week" | "textarea" | null;

/**
 * What a field takes, read once from the window and frozen. Sources, in order of trust: the page walk's input kind,
 * the label words (own label, nearest label, placeholder; descriptor.ts describeField), the form around it (an Address
 * beside a City field is the street line; derive.ts fieldPart), and maxlength. The autocomplete attribute is not
 * walked yet (AC1 open question 8).
 */
export interface FieldContract {
  readonly windowId: string;
  readonly key: string;
  /** What fill's questions carry for the field (fill.ts describeInput); a text field's is describeField(w, node).text. */
  readonly descriptor: string;
  /** The short name questions use (fill.ts Field.name). */
  readonly name: string;
  readonly labelWords: readonly (string | null)[];
  readonly control: Control;
  readonly inputKind: InputKind;
  readonly numeric: boolean;
  readonly maxLength: number | null;
  /** kinds.ts fieldKinds(labelWords). */
  readonly kinds: ReadonlySet<ValueKind>;
  readonly part: FillPart | null;
  /** "MM/YYYY" when the label spells a format (kinds.ts DATE_FORMAT); null otherwise. */
  readonly dateFormat: string | null;
  readonly currencyShown: boolean;
  /** W2 step 7: the page's own autocomplete field name for the control (Node.autocomplete); null when it gives none. */
  readonly autocomplete: AutocompleteToken | null;
  /** I2: how the field read when its contract was made (ask-scope.ts fieldFingerprint); null when made without its window. */
  readonly fingerprint: string | null;
}

/** The part of a name, an address or a date an autocomplete field name asks for (HTML autofill), or none. */
const AUTOCOMPLETE_PART: Partial<Record<AutocompleteToken, FillPart>> = {
  name: "full",
  "given-name": "first",
  "additional-name": "middle",
  "family-name": "last",
  "street-address": "street",
  "address-line1": "street",
  "address-line2": "unit",
  "address-level1": "state",
  "address-level2": "city",
  "postal-code": "zip",
  country: "country",
  "country-name": "country",
  "bday-day": "day",
  "bday-month": "month",
  "bday-year": "year",
};
/** The input kind whose shape an autocomplete field name asks for, checked as the input's own kind is (shapeRefusal). */
const AUTOCOMPLETE_INPUT: Partial<Record<AutocompleteToken, InputKind>> = { email: "email", tel: "tel", "tel-national": "tel", url: "url" };
/** The kind of value an autocomplete field name asks for, beside the label's kinds (kinds.ts fieldKinds). */
const AUTOCOMPLETE_KIND: Partial<Record<AutocompleteToken, ValueKind>> = { email: "email", tel: "phone", "tel-national": "phone", url: "url", bday: "date" };

/**
 * The part of a value a field takes by its page's autocomplete field name, or null. The page's own word for what the
 * control holds outranks Caret's reading of its label: a "Name" field marked given-name takes the first name. Fill
 * reads it too (fill.ts), so a part code derives for the field is the one the page asks for.
 */
export function autocompletePart(token: AutocompleteToken | null | undefined): FillPart | null {
  return token == null ? null : (AUTOCOMPLETE_PART[token] ?? null);
}

/**
 * V3: "timePart" is the time of a span that names a date and a time; "resolved" is a whole date, time or date and time
 * written in its input's own format (when.ts), no part taken.
 */
/** V4: "optionNamed" is a menu option code found a value to name (controls.ts optionLink), said as such to the verifier. */
export type DeriveHow = "namePart" | "addressPart" | "placePart" | "datePart" | "timePart" | "resolved" | "placeWithCountry" | "optionFromPart" | "optionNamed";

/** Where a value came from, carried unchanged from the moment it was read to the step that writes it. */
export type Provenance =
  | {
      kind: "window";
      windowId: string;
      nodeKey: string;
      app: string;
      title: string;
      /** The exact span read, verbatim. */
      span: string;
      /** The "Label: value" label when the span sits in one (Candidate.labelled), else null. */
      label: string | null;
      /** The whole line, when the ledger admitted it (Candidate.line); null otherwise. */
      line: string | null;
      /** The labelled value this span was cut from (Candidate.partOf), or null. */
      partOf: string | null;
      /**
       * The label the candidate was read beside (Candidate.context): a line's own label, or an editable source field's
       * label ("Mobile" for "555-0164"). The recheck before a write requires the source to give it still (provenanceStale).
       */
      context: string | null;
      /**
       * G2's digests of each source line that held the span when Jev judged it, with the line before and after it
       * (line-values.ts lineDigests, on the source as written). Any edit there refuses the value (provenanceStale): a
       * changed line around a value that stayed ("Do not use: 555-0164"), a line added beside it. Empty when none could
       * be found, and such a value is never held. Digests, not lines, so no more screen text travels with the value.
       * I1: these replace G2's FillField.basis.lines, read by the same one recheck as `sentences`.
       */
      lines: readonly string[];
      /**
       * Digests of each sentence that held the span, read across the lines of its "Label: value" record
       * (sentenceDigests). Kept beside `lines` (I1 review): a wrapped sentence changes two lines below its value, outside
       * `lines`'s neighbourhood ("Phone: 555-0142 / and this is my current / number, safe to use." whose last line
       * becomes "number, do not use it.").
       */
      sentences: readonly string[];
    }
  | { kind: "memory"; id: string; label: string; part: FillMemory["part"] | null; whose: "user" | "other" | null }
  | { kind: "instruction"; span: string }
  | { kind: "answer"; id: string; question: string }
  | {
      kind: "derived";
      how: DeriveHow;
      base: Provenance;
      also: Provenance | null;
      /**
       * V3: a choice code made in deriving the value, said plainly for the verifier ("the year 2026 is assumed: …", "read
       * month first, as …"). Such a value is never minted under an exemption: the verifier judges it with this sentence.
       */
      says?: string;
      /**
       * V3 review: "sentLine" when `also` is the send line of the message `base` sits in (when.ts sentLineFor), a pairing
       * provenanceStale makes again on the window as it is now.
       */
      via?: "sentLine";
    }
  | { kind: "transfer"; srcWindowId: string; srcKey: string; rounds: number; reshaped: "memory" | null; /** The source element's whole value when read. */ value?: string };

/** G2's slot. The contract never computes it; it only reads it into the verifier's description. */
export type Owner = "user" | "other" | "person" | "unclear" | null;

/** A write one path wants to make: everything the deterministic checks and the verifier need, nothing they infer. */
export interface Proposed {
  readonly field: FieldContract;
  /** Exactly what the control will hold: the typed text, an option's label, PAGE_CHECKED, a resolved date. */
  readonly text: string;
  readonly display: string;
  readonly provenance: Provenance;
  readonly owner: Owner;
}

export type ExemptRule =
  | "optionLabel" // select/radio/combobox: text equals one option's label (controls.ts matchOption, exact)
  | "boxFromLabelledLine" // checkbox: controls.ts statesFact on a "Label: yes" line of the window just left
  | "resolverFormat" // date/time/month: when.ts parsed the span; the written text is its wire format
  | "savedAnswerShown" // S1: fill/answers.ts guardAnswer passed and the whole answer is in the preview row
  | "draft" // B30: goals/drafts.ts draftCheck owns the facts; the field is a prose field (and H9: the user's words over a draft)
  | "userTransfer" // patterns: the user copied this whole element value in earlier rounds (shape.ts refuses fragments)
  | "recipientFromFrom" // B30: lower.ts recipientCheck read the answered message's From
  | "derivedEvent" // G3: a calendar event the inventory derived, eventAsAsked holds
  // W2, not in AC1's list (flagged for the lead): the user's own words typed over a draft in the preview (H9, runs.ts
  // edit). They are typed, not copied, so no source can be exact against them; the draft's field rule (codeGate) and the
  // never-typed check still run, and its fact check does not (the words are the user's).
  | "userTyped"
  // I2 lead ruling A: a file into a page's file control. Its exactness is the user's confirmation of the file at Tab
  // (runs.ts), a second gate; the mint carries only the Ask's scope check, which every attachment meets as a write does.
  | "attachment";

/**
 * The verifier's categories (AC1 section 4). A yes/no "is this right for the field?" invites a yes to a note about the
 * field (LV1: the instruction text won the value question at 0.77 and 0.96); offering the failure categories as options
 * asks the model to classify instead of endorse. Only "exact" from both wordings mints.
 */
export const VERDICTS = {
  exact: "Exactly this field's value: all of it and nothing else.",
  more: "More than this field asks for: another value, an amount, a date, a label, a remark or extra words beside the value.",
  part: "Too little: the field wants a longer value, and this text is only a piece of it.",
  note: "A note, reminder or instruction to the user about what to write, not a value.",
  other: "Not this field's value: the value of another field, of a different person or thing than the field names, or unrelated.",
} as const;
export type VerdictChoice = keyof typeof VERDICTS;

export interface VerifyAsk {
  choice: VerdictChoice;
  confidence: number;
}

/**
 * Lowest confidence, the lower of two wordings, at which "exact" mints. 0.75 is FILL_CUTOFF's value, inherited because it
 * is the only calibrated floor the helper has; no run has calibrated this question. The dev set
 * (fixtures/verify/dev.json, scripts/verifier-eval.ts) is its first evidence.
 */
export const VERIFY_CUTOFF = 0.75;

/** How a value was judged: both verifier wordings, or a named exemption. */
export type Verdict = { by: "verifier"; asks: readonly [VerifyAsk, VerifyAsk]; confidence: number } | { by: "exempt"; rule: ExemptRule };

declare const minted: unique symbol;
/** Only checkValues and mintExempt create one. Identity is the proof: a structuredClone, JSON copy or look-alike is not checked (isChecked). */
export interface CheckedValue extends Proposed {
  readonly [minted]: true;
  readonly verdict: Verdict;
  readonly at: number;
  /** I2: who authorized the value (ask-scope.ts Authority), never absent; an Ask's carries its scope, which the guard rechecks. */
  readonly authority: Authority;
}

export interface Refused {
  readonly proposed: Proposed;
  /** "wrongKind" for a shape refusal, "notExact" for the verifier's. */
  readonly why: FillWithheld;
  /** One sentence for the preview and the log. */
  readonly says: string;
  readonly asks?: readonly [VerifyAsk, VerifyAsk];
}

/** What the verifier's requests cost, for the proposal's log and the scoreboard. Zero when nothing was asked. */
export interface VerifyUse {
  requests: number;
  model: string | null;
  latencyMs: number;
  inputTokens: number;
  costUsd: number;
}

export interface Checked {
  readonly ok: readonly CheckedValue[];
  readonly refused: readonly Refused[];
  /** Each proposed value's outcome, in the order proposed: its mint, or its refusal (whose `proposed` is the caller's object). */
  readonly results: readonly (CheckedValue | Refused)[];
  readonly jev: VerifyUse;
}

export interface CheckOptions {
  /** Jev, for the verifier; null verifies nothing, so every value the shape checks pass is refused as unverified. */
  askJev: AskJev | null;
  /** The ledger the caller's asks took screen text through: the verifier quotes only what it admits (privacy.ts). */
  ledger: Disclosure | null;
  /** The user's instruction when an Ask or goal scoped the write: quoted in the request's state, and a value it labels as a secret is never typed (trace.ts secretIn). */
  instruction?: string;
  now: number;
  /** An abort counts as the verifier being unavailable. */
  signal?: AbortSignal;
  cutoff?: number;
  /** I2: who authorizes the values (ask-scope.ts Authority): an Ask's scope refuses a value outside it, for a field that changed since, or not the picked person's. */
  authority: Authority;
  /** Which page document a window shows now (the owning helper's page engine): an Ask's scope on a page holds nothing without it. */
  documentOf?: DocumentReader | null;
}

/** The scope check an authority asks for: an Ask's only. */
function authorityScopeRefusal(p: Proposed, authority: Authority | undefined, documentOf: DocumentReader | null): string | null {
  return authority?.kind === "ask" ? scopeRefusal(p, authority.scope, documentOf) : null;
}

/**
 * Jev could not answer the verifier: an HTTP, network or cap error, an abort, or an answer missing a question's id.
 * Callers withhold every proposed text write as "unverified" and never guess.
 */
export class VerifierUnavailable extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "VerifierUnavailable";
  }
}

export class ContractError extends Error {
  /** V3: "chosen" when a value whose provenance states a choice code made (Provenance.says) reaches an exemption. */
  readonly code: "unchecked" | "textMismatch" | "targetMismatch" | "shape" | "neverTyped" | "outOfScope" | "chosen";
  constructor(code: ContractError["code"], message: string) {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

/** Every CheckedValue minted in this process. A WeakSet: the mint is the object, and nothing can add one from outside. */
const mints = new WeakSet<object>();

export function isChecked(x: unknown): x is CheckedValue {
  return typeof x === "object" && x !== null && mints.has(x);
}

/** Tests only (I2's authority property, test/i2-authority.test.ts): called with every mint as it is made. Null in the product. */
let mintObserver: ((c: CheckedValue) => void) | null = null;
export function setMintObserver(f: ((c: CheckedValue) => void) | null): void {
  mintObserver = f;
}

function mint(p: Proposed, verdict: Verdict, now: number, authority: Authority): CheckedValue {
  // Loud, whatever a caller's types say: a mint with no authority would read as authorized by nothing in particular.
  if (authority === undefined || authority === null) throw new ContractError("unchecked", "a value was minted with no authority");
  const c = Object.freeze({ field: p.field, text: p.text, display: p.display, provenance: p.provenance, owner: p.owner, verdict, at: now, authority }) as unknown as CheckedValue;
  mints.add(c);
  mintObserver?.(c);
  return c;
}

const clip = (v: string): string => {
  const t = v.replace(/\s+/gu, " ").trim();
  return t.length <= 60 ? t : `${t.slice(0, 59)}…`;
};

/**
 * The parts of a FieldContract fill already read for its own questions (fill.ts Field), frozen as one. Every other
 * path reads them with fieldContract, which reads them the way fill does.
 */
export function makeFieldContract(x: {
  windowId: string;
  node: Node;
  descriptor: string;
  name: string;
  labelWords: readonly (string | null)[];
  control: Control;
  kinds: ReadonlySet<ValueKind>;
  part: FillPart | null;
  /** fieldFingerprint(w, node.key) by the caller that has the window; absent, null, and an Ask's scope refuses the field. */
  fingerprint?: string | null;
}): FieldContract {
  const words = x.labelWords.filter((w): w is string => typeof w === "string").join(" ");
  const inputKind = (x.node.inputKind ?? null) as InputKind;
  const autocomplete = x.node.autocomplete ?? null;
  const acKind = autocomplete === null ? undefined : AUTOCOMPLETE_KIND[autocomplete];
  return Object.freeze({
    windowId: x.windowId,
    key: x.node.key,
    descriptor: x.descriptor,
    name: x.name,
    labelWords: Object.freeze([...x.labelWords]),
    control: x.control,
    inputKind,
    numeric: inputKind === "number",
    maxLength: x.node.maxLength ?? null,
    kinds: acKind === undefined || x.kinds.has(acKind) ? x.kinds : new Set([...x.kinds, acKind]),
    part: autocompletePart(autocomplete) ?? x.part,
    dateFormat: DATE_FORMAT.exec(words.toLowerCase())?.[0]?.toUpperCase() ?? null,
    currencyShown: CURRENCY_SHOWN.test(words),
    autocomplete,
    fingerprint: x.fingerprint ?? null,
  });
}

/**
 * A field's contract, read as fill reads its fields (fill.ts proposeFill): the label words of a text field are its own
 * label, nearest label and placeholder; a control's are its form label, or its nearest label when it has none. Throws
 * ContractError("neverTyped") for a secure field or one Caret never types (memory/sensitive.ts labelKind): such a
 * field has no contract.
 */
export function fieldContract(w: WindowState, node: Node, form: FormControl | null = null): FieldContract {
  const d = describeField(w, node);
  const never = labelKind(d.label ?? d.nearest) ?? labelKind(d.placeholder);
  if (node.states?.includes("secure") === true || never !== null) throw new ContractError("neverTyped", `Caret never types into '${clip(d.label ?? d.nearest ?? d.placeholder ?? "this field")}'`);
  const control: Control = form?.control ?? "text";
  const label = form === null ? d.label : form.label;
  const labelWords = form === null ? [d.label, d.nearest, d.placeholder] : [label, label === null ? d.nearest : null];
  const name = (form === null ? (d.label ?? d.nearest ?? d.placeholder) : (label ?? d.nearest)) ?? null;
  const typed = control === "text" || control === "combobox";
  const kinds = control === "date" ? new Set<ValueKind>(["date"]) : control === "time" ? new Set<ValueKind>(["time"]) : typed ? fieldKinds(labelWords) : new Set<ValueKind>();
  const formHasCity = [...w.nodes.values()].some((n) => n.editable === true && (n.role === "AXTextField" || n.role === "AXComboBox") && fieldPart(describeField(w, n).label, false) === "city");
  const part = typed ? (autocompletePart(node.autocomplete) ?? datePart(name) ?? fieldPart(name, formHasCity) ?? (asksCountry(name) ? "country" : null)) : null;
  // fill.ts describeInput, which the helper compares again before a proposal is shown.
  const descriptor = form === null ? d.text : describeControl(form, d.section, form.label === null ? d.nearest : null);
  return makeFieldContract({ windowId: w.window.windowId, node, descriptor, name: name ?? "unnamed field", labelWords, control, kinds, part, fingerprint: fieldFingerprint(w, node.key) });
}

/**
 * What the input's own kind takes, by the browser's rules for typed text: an email input one address, a number input a
 * plain number, a telephone input no letters but an extension mark, a URL input no spaces. Each has one correct answer
 * and its own isolated test (test/contract.test.ts). Date and time inputs take only the value resolver's wire format,
 * which an exemption mints (resolverFormat); typed text there is refused.
 */
function inputKindRefusal(kind: InputKind, v: string): string | null {
  switch (kind) {
    case "email":
      return textKind(v) === "email" ? null : `'${clip(v)}' is not one email address, and the field is an email input`;
    case "number":
      return /^[-+]?\d+(?:\.\d+)?$/u.test(v) ? null : `'${clip(v)}' is not a plain number, and the field is a number input`;
    case "tel":
      return /^[+\d\s().\-/]*(?:\s*(?:x|ext\.?)\s*\d+)?$/iu.test(v) && /\d/u.test(v) ? null : `'${clip(v)}' is not a phone number, and the field is a phone input`;
    case "url":
      return /\s/u.test(v) ? `'${clip(v)}' has spaces, and the field is a web address input` : null;
    case "date":
    case "time":
    case "datetime":
    case "month":
    case "week":
      return `'${clip(v)}' is typed text, and the field is a ${kind} input, which takes only a value Caret resolved`;
    default:
      return null;
  }
}

/**
 * The deterministic checks, in order: a value Caret never types (trace.ts secretIn by its shape), the input kind's
 * shape, the label's kinds and formats (kinds.ts misfit: TAKES, a spelled date format, a shown currency, a date part, a
 * number field), the part of a name or an address the field takes (derive.ts partFits), and maxlength. Nothing here
 * reads commas, "at", capitals or verbs: those are W1's text-shape families (textShapeRefusal).
 */
/** V3: the value a date-like input holds, in its own format (controls.ts DateFormat), as the resolver writes it. */
const WIRE_FORMAT: Partial<Record<NonNullable<InputKind>, RegExp>> = {
  date: /^\d{4}-\d{2}-\d{2}$/u,
  time: /^\d{2}:\d{2}(?::\d{2})?$/u,
  datetime: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u,
  month: /^\d{4}-\d{2}$/u,
};

/** V3: a value code resolved into a date-like input's own format, saying the choice it made (Provenance.says). */
function chosenWire(p: Proposed): boolean {
  return p.provenance.kind === "derived" && p.provenance.says !== undefined && p.field.inputKind !== null && WIRE_FORMAT[p.field.inputKind]?.test(p.text.trim()) === true;
}

export function shapeRefusal(p: Proposed): string | null {
  const v = p.text.trim();
  const secret = secretIn(v, "");
  if (secret !== null) return `Caret never types ${SENSITIVE_SAYS[secret]}; that is yours to enter`;
  // SC1 2a: a text the model withheld a secret-format value from is never written, whatever else it holds.
  if (v.includes(WITHHELD)) return "Caret never reads part of this value; that is yours to enter";
  // V3: a date or time input takes a value through the verifier only when code resolved it into the input's own format and
  // said the choice it made doing so (Provenance.says: an assumed year, an order a format hint gave); every other value
  // there is still an exemption's (resolverFormat) or refused.
  const chosen = chosenWire(p);
  const input = chosen ? null : (inputKindRefusal(p.field.inputKind, v) ?? (p.field.autocomplete === null ? null : inputKindRefusal(AUTOCOMPLETE_INPUT[p.field.autocomplete] ?? null, v)));
  if (input !== null) return input;
  // I3: such a value is in the input's own format, which the label's kinds cannot judge (kinds.ts reads "2022-08" and
  // "08:45" as plain text): c2-page's month from "Aug '22" was refused here once V3 sent it to the verifier.
  const kind = chosen ? null : misfit(v, p.field.labelWords);
  if (kind !== null) return kind;
  if (p.field.part !== null && !partFits(p.field.part, v)) return `'${clip(v)}' is not the ${p.field.part} the field takes`;
  if (p.field.maxLength !== null && p.text.length > p.field.maxLength) return `'${clip(v)}' is longer than the ${p.field.maxLength} characters the field takes`;
  return null;
}

/**
 * The label that says what a value is, as W1's gate reads it (fill.ts writeRefused before W2): its "Label: value" line,
 * its memory entry's label, the field itself for a value the instruction spells out, the part code derived it as.
 */
export function sourceLabel(p: Proposed): string | null {
  const pr = p.provenance;
  switch (pr.kind) {
    case "window":
      return pr.label;
    case "memory":
      return pr.label;
    case "instruction":
      return p.field.name;
    case "derived": {
      if (pr.base.kind === "instruction") return p.field.name;
      const part = p.field.part;
      if (part === "first" || part === "middle" || part === "last") return `${part} name`;
      return pr.base.kind === "window" ? pr.base.label : null;
    }
    default:
      return null;
  }
}

/**
 * W1's text-shape gate (writable.ts writeMisfit), with the provenance the value carries, and its rule that a part of a
 * labelled value (Candidate.partOf) goes only in a field that takes one value. AC1 retires these families one at a
 * time, each only on verifier evidence (migration step 4).
 */
export function textShapeRefusal(p: Proposed): string | null {
  // I3: W1's families read copied text; a value in a date-like input's own format that code resolved is the verifier's.
  if (chosenWire(p)) return null;
  return writeMisfit(p.text, { labelWords: p.field.labelWords, part: p.field.part }, shapeSource(p));
}

/** What labels a proposed value, for W1's families: its source label (sourceLabel) and, for a window's part, the value it was cut from. */
export function shapeSource(p: Proposed): ShapeSource {
  return { label: sourceLabel(p), partOf: p.provenance.kind === "window" ? p.provenance.partOf : null };
}

/** The never-typed check every mint meets, exemptions included: a value Caret never types, by its shape or by the instruction's label for it. */
export function neverTypedRefusal(p: Proposed, instruction = ""): string | null {
  const secret = secretIn(p.text.trim(), instruction);
  return secret === null ? null : `Caret never types ${SENSITIVE_SAYS[secret]}; that is yours to enter`;
}

/** Questions one verifier request asks at most: fill's MAX_FIELDS, so a request is no bigger than a fill's. */
export const VERIFY_BATCH = 20;

const OWNER_SAYS = { user: "the user's", other: "someone else's", person: "the person the user named" } as const satisfies Record<Exclude<Owner, null | "unclear">, string>;

/** The source window's own words for a window provenance: its app and title, quoted only when the ledger admitted them. */
function where(app: string, title: string, admitted: (t: string) => boolean): string {
  const t = title.trim();
  return t !== "" && admitted(t) ? `${app === "" ? "a window" : app} '${t}'` : app === "" ? "another window" : app;
}

/**
 * Where a value was read, as one phrase (AC1 section 4). A window's line is quoted when the ledger admitted it, else its
 * span with its label, else the span alone; a part names the value it was cut from when that was admitted.
 */
export function provenanceSays(pr: Provenance, admitted: (t: string) => boolean): string {
  // The verifier's own phrase (mintProvenanceSays), over a ledger of no windows: nothing to charge, so every admitted
  // text mints and the rest are named, not quoted.
  const d = new Disclosure([]);
  return mintProvenanceSays(d, pr, (t) => (admitted(t) ? d.planText(t) : null));
}

/**
 * provenanceSays's phrase, minted by the verifier's Disclosure: every quoted text as plan text (Disclosure.planText, which
 * refuses a text that shows a line redaction removed), Caret's words around them. A text that does not mint is named,
 * not quoted, as one the ledger refused always was.
 */
function mintProvenanceSays(d: Disclosure, pr: Provenance, m: (t: string) => ModelText | null): ModelText {
  switch (pr.kind) {
    case "window": {
      const t = pr.title.trim();
      // The app is reader metadata, named as it always was; a window of it is open, or the app's name is plan text.
      const app = pr.app === "" ? null : (d.appNamed(pr.app) ?? d.planText(pr.app));
      const title = t === "" ? null : m(t);
      const at = title !== null ? d.t`${app ?? d.own("a window")} '${title}'` : (app ?? d.own("another window"));
      const span = m(pr.span);
      const line = pr.line === null ? null : m(pr.line);
      const label = pr.label === null ? null : m(pr.label);
      const base =
        line !== null ? d.t`the line "${line}" in ${at}`
        : span !== null && label !== null ? d.t`"${span}" labelled '${label}' in ${at}`
        : span !== null ? d.t`"${span}" in ${at}`
        : d.t`a value in ${at}`;
      const whole = pr.partOf !== null && pr.partOf !== pr.line ? m(pr.partOf) : null;
      return whole !== null ? d.t`${base}, which is part of "${whole}"` : base;
    }
    case "memory": {
      const label = m(pr.label);
      const as = label === null ? d.own("") : d.t` as '${label}'`;
      return pr.part === null || pr.part === undefined ? d.t`what the user told Caret${as}` : d.t`the ${d.id(pr.part)} part of what the user told Caret${as}`;
    }
    case "instruction":
      return d.own("the user's instruction");
    case "answer": {
      const q = m(pr.question);
      return q !== null ? d.t`the user's saved answer to '${q}'` : d.own("one of the user's saved answers");
    }
    case "transfer":
      return d.own("a value the user copied there before");
    case "derived": {
      const plain = d.t`${d.own(DERIVE_SAYS[pr.how])} in ${mintProvenanceSays(d, pr.base, m)}`;
      if (pr.says === undefined) return plain;
      const says = m(pr.says);
      const also = pr.also === null ? d.own("") : d.t`, and ${mintProvenanceSays(d, pr.also, m)}`;
      return says === null ? d.t`${plain}${also}` : d.t`${plain}${also}; ${says}`;
    }
  }
}

const DERIVE_SAYS = { namePart: "a part of the name", addressPart: "a part of the address", placePart: "a part of the place", datePart: "a part of the date", timePart: "the time", resolved: "the date or time, in the field's own format,", placeWithCountry: "the place with its country", optionFromPart: "the option for a part", optionNamed: "the menu option named" } as const satisfies Record<DeriveHow, string>;

/** The texts of a provenance a question may quote, for the ledger: its window's title, line, label, span and whole value. */
function provenanceTexts(pr: Provenance): string[] {
  switch (pr.kind) {
    case "window":
      return [pr.title, pr.line, pr.label, pr.span, pr.partOf].filter((t): t is string => t !== null && t.trim() !== "");
    case "memory":
      return [pr.label];
    case "answer":
      return [pr.question];
    case "derived":
      return [...provenanceTexts(pr.base), ...(pr.also === null ? [] : provenanceTexts(pr.also))];
    default:
      return [];
  }
}

const PART_TAKES: Record<FillPart, string> = {
  first: "only a person's first name",
  middle: "only a person's middle name",
  last: "only a person's last name",
  full: "a person's name",
  street: "only the street line of an address; the form has other fields for the rest",
  unit: "only the apartment, suite or unit",
  city: "only the city",
  state: "only the state or province",
  zip: "only the postal code",
  country: "only the country",
  month: "only the month of a date",
  day: "only the day of a date",
  year: "only the year of a date",
};
const INPUT_TAKES: Partial<Record<NonNullable<InputKind>, string>> = { email: "one email address", tel: "one phone number", url: "one web address", number: "a number" };

/**
 * What the field takes, in words, from what code read of it (FieldContract): the part of a name, an address or a date,
 * what the page's autocomplete field name says, the input's kind, a spelled date format, a shown currency. Empty when code read none of these. W2 dev-set evidence: the
 * verifier called "455 Congress Ave, Austin, TX 78701" exact for an Address beside a City field when told only the label
 * (evidence/screen/w2/verify-eval-1).
 */
/** What a page's autocomplete field name says a field takes, beyond a part (AUTOCOMPLETE_PART) or a kind the input states. */
const AUTOCOMPLETE_TAKES: Partial<Record<AutocompleteToken, string>> = { organization: "an organization's name", "organization-title": "a job title", nickname: "the name a person goes by", bday: "a date of birth", email: "one email address", tel: "one phone number", "tel-national": "one phone number", url: "one web address" };

export function takesSays(f: FieldContract): string {
  const fromPage = f.autocomplete === null ? null : (AUTOCOMPLETE_TAKES[f.autocomplete] ?? null);
  const takes = [f.part === null ? null : PART_TAKES[f.part], fromPage !== null && !(f.inputKind !== null && INPUT_TAKES[f.inputKind] === fromPage) ? fromPage : null, f.inputKind === null ? null : (INPUT_TAKES[f.inputKind] ?? null), f.dateFormat === null ? null : `a date written as ${f.dateFormat}`, f.currencyShown ? "the number alone, since the field shows its currency" : null].filter((t): t is string => t !== null);
  return takes.length === 0 ? "" : ` The field takes ${takes.join("; ")}.`;
}

/** A question's minted parts: the field's descriptor and name, the proposed text, what the field takes, where it was read. */
interface VerifyParts {
  descriptor: ModelText;
  name: ModelText;
  text: ModelText;
  takes: ModelText;
  from: ModelText;
  owner: ModelText;
}
const WORDINGS = [
  (d: Disclosure, p: VerifyParts): ModelText =>
    d.t`Field: ${p.descriptor}${p.takes} Caret proposes to type this into it, with nothing added or removed: "${p.text}". It was read from ${p.from}${p.owner}. What is the proposed text, for this field?`,
  (d: Disclosure, p: VerifyParts): ModelText =>
    d.t`Proposed text for the field '${p.name}': "${p.text}". Read from ${p.from}${p.owner}. The field: ${p.descriptor}${p.takes} If Caret typed exactly this text into the field, what would it have typed?`,
] as const;

/** Every string a request carries in its state and questions. */
function sentStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) sentStrings(x, out);
  return out;
}

/** The refusal's sentence: the category both wordings agreed on, or that they disagreed. */
function refusalSays(p: Proposed, asks: readonly [VerifyAsk, VerifyAsk], cutoff: number): string {
  const [a, b] = asks;
  const what = `'${clip(p.text)}'`;
  if (a.choice !== b.choice) return `Caret's two checks disagreed about ${what}`;
  switch (a.choice) {
    case "exact":
      return `Caret wasn't sure enough that ${what} is exactly what the field asks for (${Math.min(a.confidence, b.confidence).toFixed(2)} under ${cutoff})`;
    case "more":
      return `${what} holds more than the field asks for`;
    case "part":
      return `${what} is only part of what the field asks for`;
    case "note":
      return `${what} is a note to you, not a value`;
    case "other":
      return `${what} isn't this field's value`;
  }
}

/**
 * Tests only: a verifier that answers in Jev's place in every vitest process (test/setup/verifier.ts installs one that
 * says "exact"), so the many tests written before W2 with stand-in Jevs that know only fill's questions keep testing
 * what they test; test/contract.test.ts and the guard adversary (its own process) meet the real request path. Refused
 * outside vitest, so the product can never skip the verifier through it.
 */
let testVerifier: AskJev | null = null;
export function setTestVerifier(f: AskJev | null): void {
  // Vitest's own worker state, which only a vitest worker has, as well as its environment flag (W2 review: the flag alone
  // can be set by anyone).
  const worker = (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__;
  if (process.env.VITEST !== "true" || typeof worker !== "object" || worker === null) throw new Error("setTestVerifier is for vitest only");
  testVerifier = f;
}

/**
 * The verifier alone (AC1 section 4), without the shape checks: for each proposed value, both wordings' verdicts, one
 * request per wording per batch of VERIFY_BATCH, all in parallel. Quotes only text the ledger admits (ledger.plan),
 * and declares only what each request sends. Throws VerifierUnavailable on any Jev failure, an abort, or a missing
 * answer. scripts/verifier-eval.ts calls this on its labelled set.
 */
export async function verifyProposed(proposed: readonly Proposed[], o: CheckOptions): Promise<{ asks: (readonly [VerifyAsk, VerifyAsk] | null)[]; jev: VerifyUse }> {
  const jev: VerifyUse = { requests: 0, model: null, latencyMs: 0, inputTokens: 0, costUsd: 0 };
  if (proposed.length === 0) return { asks: [], jev };
  if (o.askJev === null) throw new VerifierUnavailable("no Jev to verify values with");
  const ask = testVerifier ?? o.askJev;
  const ledger = o.ledger ?? new Disclosure([]);
  const d = ledger;
  // What the ledger admits: a text the request may quote, minted as plan text (Disclosure.planText), which declares it,
  // charging each window whose lines it holds; text already taken for the value asks costs nothing more.
  const mintedCache = new Map<string, ModelText | null>();
  const admit = (t: string): ModelText | null => {
    if (!mintedCache.has(t)) mintedCache.set(t, d.planText(t));
    return mintedCache.get(t) ?? null;
  };
  // I1: an instruction that names a secret ("Put my password 'hunter2' in Plan") is not sent: no Jev request may carry a
  // secret marker (privacy.ts assertNoSecrets, G2), and the verifier judges a value against its field and where it was
  // read without it. Its values Caret never types were refused before this (neverTypedRefusal, with the instruction).
  const raw = o.instruction === undefined || o.instruction === "" || secretText(o.instruction) ? undefined : o.instruction;
  if (raw !== undefined && !ledger.plan([raw])) throw new VerifierUnavailable("the instruction quotes more of an open window than the verifier may carry");
  const instruction = raw === undefined ? undefined : d.instruction(raw);
  const questions = proposed.map((p) => {
    // The field's descriptor and the text itself must go; a value whose own text the ledger refuses is not verified.
    const descriptor = admit(p.field.descriptor);
    const text = admit(p.text);
    const name = admit(p.field.name);
    if (descriptor === null || text === null || name === null) return null;
    for (const t of provenanceTexts(p.provenance)) admit(t);
    const takes = takesSays(p.field);
    const parts: VerifyParts = {
      descriptor,
      name,
      text,
      takes: takes === "" ? d.own("") : (admit(takes) ?? d.own("")),
      from: mintProvenanceSays(d, p.provenance, admit),
      owner: p.owner === null || p.owner === "unclear" ? d.own("") : d.t`; the screen says it is ${d.own(OWNER_SAYS[p.owner])}`,
    };
    return [WORDINGS[0](d, parts), WORDINGS[1](d, parts)] as const;
  });
  const declared = ledger.declared();
  const state: Record<string, ModelValue> = { task: d.own("Caret checks that each value it is about to type is exactly what its field asks for."), ...(instruction === undefined ? {} : { instruction }) };
  const batches: number[][] = [];
  const asked = proposed.flatMap((_, i) => (questions[i] === null ? [] : [i]));
  for (let i = 0; i < asked.length; i += VERIFY_BATCH) batches.push(asked.slice(i, i + VERIFY_BATCH));
  const request = (batch: readonly number[], wording: 0 | 1): JevRequest => {
    // The second wording asks in reverse order, so neither order nor wording alone decides.
    const order = wording === 0 ? batch : [...batch].reverse();
    const qs: JevRequest["questions"] = Object.fromEntries(order.map((i) => [`x${i + 1}`, { type: "choice" as const, instructions: (questions[i] ?? [d.own(""), d.own("")])[wording], criteria: d.ownRecord(VERDICTS) }]));
    const sent = sentStrings([state, qs]);
    const req: JevRequest = d.seal({ purpose: "fill.verify", state, questions: qs, snippets: declared.snippets.filter((x) => sent.some((t) => t.includes(x.text))), charged: declared.charged });
    // I1: the disclosure rule every Jev request meets at build (privacy.ts assertNoSecrets, G2), the verifier's included:
    // its provenance sentences quote only redacted, ledger-admitted text, and this is the guarantee behind that. A throw
    // here makes the verifier unavailable (below), so every value it would have checked is withheld, nothing is sent.
    return req;
  };
  const out: (readonly [VerifyAsk, VerifyAsk] | null)[] = proposed.map(() => null);
  try {
    await Promise.all(
      batches.map(async (batch) => {
        if (o.signal?.aborted === true) throw new VerifierUnavailable("the verifier was cancelled");
        const [r0, r1] = await Promise.all([ask(request(batch, 0)), ask(request(batch, 1))]);
        jev.requests += 2;
        jev.model = r0.model;
        jev.latencyMs = Math.max(jev.latencyMs, r0.latencyMs, r1.latencyMs);
        jev.inputTokens += r0.inputTokens + r1.inputTokens;
        jev.costUsd += r0.costUsd + r1.costUsd;
        for (const i of batch) {
          const [a, b] = [r0.answers[`x${i + 1}`], r1.answers[`x${i + 1}`]];
          if (a === undefined || b === undefined || !(a.choice in VERDICTS) || !(b.choice in VERDICTS)) throw new VerifierUnavailable(`Jev gave no verdict for x${i + 1}`);
          out[i] = [{ choice: a.choice as VerdictChoice, confidence: a.confidence }, { choice: b.choice as VerdictChoice, confidence: b.confidence }];
        }
      }),
    );
  } catch (e) {
    if (e instanceof VerifierUnavailable) throw e;
    throw new VerifierUnavailable(`the verifier failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`, e);
  }
  if (o.signal?.aborted === true) throw new VerifierUnavailable("the verifier was cancelled");
  // Null for a value whose own text the ledger refused: no question was asked about it.
  return { asks: out, jev };
}

/**
 * Harness only (scripts/guard-adversary.ts --dump-proposed, which seeds the verifier's dev set): called with each value
 * checkValues is asked about and why the code checks refuse it, before the verifier. Null in the product.
 */
let observer: ((p: Proposed, codeRefusal: string | null) => void) | null = null;
export function setCheckObserver(f: ((p: Proposed, codeRefusal: string | null) => void) | null): void {
  observer = f;
}

/**
 * The one gate for copied text. Runs the never-typed check with the instruction, shapeRefusal and W1's text-shape gate
 * on each value, then the verifier (verifyProposed) on the survivors, and mints a value only when both wordings answer
 * "exact" at the cutoff or above. Throws VerifierUnavailable when the verifier cannot answer: the caller withholds every
 * proposed text write and never guesses.
 */
export async function checkValues(proposed: readonly Proposed[], o: CheckOptions): Promise<Checked> {
  const cutoff = o.cutoff ?? VERIFY_CUTOFF;
  const results: (CheckedValue | Refused)[] = [];
  // Each value as it is now, frozen, before anything is awaited: what the verifier is asked about is what is minted,
  // whatever a caller does with its own object meanwhile (W2 review).
  const snaps = proposed.map(snapshot);
  const survivors: number[] = [];
  snaps.forEach((p, i) => {
    // I2: outside the Ask's scope first: such a value is refused whatever it is, and never reaches the verifier.
    const out = authorityScopeRefusal(p, o.authority, o.documentOf ?? null);
    if (out !== null) return void (results[i] = { proposed: proposed[i] as Proposed, why: "outOfScope", says: out });
    const why = neverTypedRefusal(p, o.instruction ?? "") ?? shapeRefusal(p) ?? textShapeRefusal(p);
    observer?.(p, why);
    if (why !== null) results[i] = { proposed: proposed[i] as Proposed, why: "wrongKind", says: why };
    else survivors.push(i);
  });
  const v = await verifyProposed(survivors.map((i) => snaps[i] as Proposed), o);
  survivors.forEach((i, k) => {
    const p = snaps[i] as Proposed;
    const original = proposed[i] as Proposed;
    const asks = v.asks[k] ?? null;
    if (asks === null) return void (results[i] = { proposed: original, why: "unverified", says: `Caret couldn't check '${clip(p.text)}' without sending more of its window than it may` });
    const confidence = Math.min(asks[0].confidence, asks[1].confidence);
    results[i] = asks[0].choice === "exact" && asks[1].choice === "exact" && confidence >= cutoff ? mint(p, { by: "verifier", asks, confidence }, o.now, o.authority) : { proposed: original, why: "notExact", says: refusalSays(p, asks, cutoff), asks };
  });
  return { ok: results.filter(isChecked), refused: results.filter((r): r is Refused => !isChecked(r)), results, jev: v.jev };
}

/** A deep copy of a value with everything frozen; a field contract already frozen (makeFieldContract) is kept as it is. */
function snapshot(p: Proposed): Proposed {
  const field = Object.isFrozen(p.field) && Object.isFrozen(p.field.labelWords) ? p.field : Object.freeze({ ...p.field, labelWords: Object.freeze([...p.field.labelWords]), kinds: new Set(p.field.kinds) });
  return Object.freeze({ field, text: p.text, display: p.display, provenance: deepFrozen(structuredClone(p.provenance)), owner: p.owner });
}
function deepFrozen<T>(x: T): T {
  if (typeof x === "object" && x !== null) {
    for (const v of Object.values(x)) deepFrozen(v);
    Object.freeze(x);
  }
  return x;
}

/**
 * Exemptions whose written text is copied text in a text field, so the deterministic shape checks still apply: a reply's
 * To takes the answered message's sender, which a "To phone number" field must refuse as an email (goal-derived.test.ts).
 * Every other exemption's text is the page's own option, the resolver's format, the user's saved answer, a draft its
 * own rules check, or the user's demonstrated transfer: only the never-typed check runs on it.
 */
const SHAPED: ReadonlySet<ExemptRule> = new Set(["recipientFromFrom"]);

/** Why a value may not be minted under `rule`, or null: the Ask's scope (I2), the never-typed check, and for SHAPED rules shapeRefusal. */
export function exemptRefusal(p: Proposed, rule: ExemptRule, instruction = "", authority?: Authority, documentOf: DocumentReader | null = null): string | null {
  return authorityScopeRefusal(p, authority, documentOf) ?? (rule === "attachment" ? null : (neverTypedRefusal(p, instruction) ?? (SHAPED.has(rule) ? shapeRefusal(p) : null)));
}

/**
 * Mints without the verifier for a value whose exactness code settles (ExemptRule). Throws ContractError on a value
 * exemptRefusal refuses: a caller that may meet one asks exemptRefusal first; one that reaches here with it has a bug.
 */
/** V3: the first choice a provenance states (Provenance.says), in it or in any source it was derived from; null when none. */
export function statedChoice(pr: Provenance): string | null {
  if (pr.kind !== "derived") return null;
  return pr.says ?? statedChoice(pr.base) ?? (pr.also === null ? null : statedChoice(pr.also));
}

export function mintExempt(proposed: Proposed, rule: ExemptRule, now: number, instruction: string, authority: Authority, documentOf: DocumentReader | null = null): CheckedValue {
  // Frozen before it is judged, as checkValues does: what is judged is what is minted (W2 review).
  const p = snapshot(proposed);
  const out = authorityScopeRefusal(p, authority, documentOf);
  if (out !== null) throw new ContractError("outOfScope", out);
  // V3 (lead): a value code derived by a choice (an assumed year, an order a hint gave, an option a word names) is judged by
  // the verifier, never minted as a plain conversion; reaching here is a bug in the caller.
  const chose = statedChoice(p.provenance);
  if (chose !== null) throw new ContractError("chosen", `'${clip(p.text)}' was derived by a choice code made (${clip(chose)}), so only the verifier may check it, not the ${rule} exemption`);
  const why = exemptRefusal(p, rule, instruction);
  if (why !== null) throw new ContractError(neverTypedRefusal(p, instruction) === null ? "shape" : "neverTyped", why);
  return mint(p, { by: "exempt", rule }, now, authority);
}

/**
 * The mint a compiler needs for one write: `c` must be a CheckedValue (isChecked), for exactly this text and this
 * field. Throws ContractError naming what failed; `at` names the step for the message.
 */
export function requireChecked(c: unknown, text: string, key: string, windowId: string, at: string): CheckedValue {
  if (!isChecked(c)) throw new ContractError("unchecked", `${at}: the value has no check from the write contract`);
  if (c.text !== text) throw new ContractError("textMismatch", `${at}: the value checked was '${clip(c.text)}', not '${clip(text)}'`);
  if (c.field.key !== key || c.field.windowId !== windowId) throw new ContractError("targetMismatch", `${at}: the value was checked for another field`);
  return c;
}

/**
 * W2 review: why a field no longer takes what its contract said when its value was checked, or null: the page walk's
 * input kind or autocomplete field name changed on the same descriptor, or a lowered maxlength no longer fits `text`.
 * A changed contract needs a fresh check.
 */
export function contractStale(node: Node, f: FieldContract, text: string): string | null {
  if ((node.inputKind ?? null) !== f.inputKind || (node.autocomplete ?? null) !== f.autocomplete) return "the field now asks for something else than when its value was checked";
  // A maxlength that changed matters only when the value no longer fits it.
  if (node.maxLength !== undefined && text.length > node.maxLength) return `the field now takes at most ${node.maxLength} characters`;
  return null;
}

/**
 * A window value's provenance (fill, the planner and code plans build theirs with this): its candidate's facts, and the
 * digests of the lines around it in `text`, its source node's text as Jev was shown it (fill passes the text it took
 * before its asks, G2's `judged`); by default the node's text in `w` now.
 */
export function windowProvenance(w: WindowState | undefined, c: { text: string; context: string | null; labelled?: boolean; line?: string | null; partOf?: string; source: { windowId: string; nodeKey: string; appName: string; windowTitle: string } }, text?: string): Provenance {
  w = w === undefined ? undefined : redactWindow(w);
  const node = w?.nodes.get(c.source.nodeKey);
  const read = text ?? (node === undefined ? undefined : nodeText(node));
  return { kind: "window", windowId: c.source.windowId, nodeKey: c.source.nodeKey, app: c.source.appName, title: c.source.windowTitle, span: c.text, label: c.labelled === true ? c.context : null, line: c.line ?? null, partOf: c.partOf ?? null, context: c.context, lines: read === undefined ? [] : lineDigests(read, c.text), sentences: read === undefined ? [] : sentenceDigests(read, c.text) };
}

/**
 * Digests of each sentence of `text` that holds `span`. The text is read as records: a "Label: value" line starts one
 * (line-values.ts LABELLED, any capitalization), and every other line, blank lines aside, goes on with the record above
 * it, however it starts; each record's lines are joined (bareLine) and read for sentences as line-values.ts
 * sentenceAround reads them. A span no record holds whole (a multi-line span across a labelled line) is read in all the
 * lines joined, W2's rule.
 * Why records: W2 joined every line, so a note of unpunctuated "Label: value" lines read as one sentence and any edit
 * anywhere refused every value in it (test/g2-ownership.test.ts, recheck by neighbourhood); reading wraps only where a
 * line starts in lowercase (logicalLines) missed "Phone: 555-0142 / And this is my current / number, safe to use." whose
 * last line changes (I1 re-review).
 */
export function sentenceDigests(text: string, span: string): string[] {
  const flat = (t: string): string => t.replace(/\s+/gu, " ").trim();
  const want = flat(span);
  if (want === "") return [];
  const lines = text.split(/\r?\n/u).map(bareLine).filter((l) => l !== "");
  const records: string[] = [];
  for (const l of lines) {
    if (records.length === 0 || LABELLED.test(l)) records.push(l);
    else records[records.length - 1] += ` ${l}`;
  }
  const digests = (joined: string): string[] => {
    const out: string[] = [];
    for (let at = joined.indexOf(want); at >= 0; at = joined.indexOf(want, at + 1)) out.push(createHash("sha256").update(sentenceAround(joined, at, want)).digest("hex").slice(0, 16));
    return out;
  };
  const held = records.flatMap((r) => digests(flat(r)));
  return held.length > 0 ? held : digests(flat(lines.join(" ")));
}

/** Whether two digest lists hold the same digests. */
const sameDigests = (a: readonly string[], b: readonly string[]): boolean => a.every((d) => b.includes(d)) && b.every((d) => a.includes(d));

const norm = (t: string): string => t.replace(/\s+/gu, " ").trim();

/**
 * Why a value no longer rests on what it was read from, or null: the one recheck of a value's source, which runs at a
 * preview's acceptance, at plan validation and right before each write (guardFor). I1 merged G2's
 * offers/fill-popup.ts sourceHolds into it, and deleted that: both held the same value to its source, by different
 * records. For a window's value:
 *   - the window and node are still there, and the window's redacted view (fill/redact.ts) still admits the node and
 *     shows the span (G2 round 5: a source whose placeholder became "Password", or a marker line put in above it, gives
 *     nothing);
 *   - its lines were recorded, and the lines that hold the span now, each with the line before and after it, are
 *     exactly those (G2's neighbourhood digests): a changed line, a line added beside it, or a new line that holds it
 *     refuses it; and so are the sentences that hold it, however many lines they wrap over (W2's sentence digests);
 *   - the label it was read beside is still one the source gives it (W2: an editable source field relabelled "Do not
 *     use").
 * A derived value meets each of its sources' checks. G2 also derived the value again from its source texts; with each
 * source's lines unchanged, the same code gives the same value, so that check is gone with sourceHolds. A memory entry
 * is checked by the executor's memoryHolds, and an identity, a saved answer and a memory value by the preview's own
 * recheck (fill-popup.ts valueStale); an instruction has no screen source.
 */
export function provenanceStale(model: ScreenModel, pr: Provenance): string | null {
  switch (pr.kind) {
    case "window": {
      const sw = model.windows.get(pr.windowId);
      if (sw === undefined) return "the window it was read from closed";
      const node = sw.nodes.get(pr.nodeKey);
      if (node === undefined) return "what it was read from is gone";
      const view = redactWindow(sw);
      const seen = view.nodes.get(pr.nodeKey);
      const shown = seen === undefined ? "" : nodeText(seen);
      const shows = seen !== undefined && (norm(logicalLines(shown).join("\n")).includes(norm(pr.span)) || norm(shown).includes(norm(pr.span)) || view.values.some((v) => v.nodeKey === pr.nodeKey && norm(v.text) === norm(pr.span)));
      if (!shows) return "Caret may no longer read it where it was read";
      if (pr.lines.length === 0) return "Caret has no record of the lines it was read from";
      // Compare the same redacted evidence used at request construction, not discarded secret lines.
      const now = lineDigests(shown, pr.span);
      if (now.length === 0) return "its source no longer shows it";
      if (!sameDigests(now, pr.lines) || !sameDigests(sentenceDigests(shown, pr.span), pr.sentences)) return "what its source says around it changed";
      if (pr.context !== null && !spanContexts(view, seen as Node, pr.span).includes(pr.context)) return "the label it was read beside changed";
      return null;
    }
    case "derived": {
      const stale = provenanceStale(model, pr.base) ?? (pr.also === null ? null : provenanceStale(model, pr.also));
      if (stale !== null || pr.via !== "sentLine" || pr.base.kind !== "window" || pr.also?.kind !== "window") return stale;
      // V3 review: the send line must still be the one of the message the value sits in, on the window as it is now (a
      // quoted "Original message" put in between, or a second sender, unpairs them).
      const w = model.windows.get(pr.base.windowId);
      const now = w === undefined ? null : sentLineFor([...w.nodes.values()].map((n) => ({ key: n.key, text: nodeText(n) })), pr.base.nodeKey, pr.base.span);
      return now !== null && now.nodeKey === pr.also.nodeKey && now.value === pr.also.span ? null : "the message its date's year was read from no longer reads as one";
    }
    case "transfer": {
      // A routine's cell: the element it copies must still be there, and still hold the value unless a memory rule
      // reshaped it (W2 review: patterns runs recheck their sources at dispatch too).
      const node = model.windows.get(pr.srcWindowId)?.nodes.get(pr.srcKey);
      if (node === undefined) return "what it was copied from is gone";
      return pr.reshaped === null && pr.value !== undefined && nodeText(node).trim() !== pr.value.trim() ? "what it was copied from changed" : null;
    }
    default:
      return null;
  }
}

/**
 * The executor's guard for a run whose copied values the write contract checked (RunOptions.guard): by the step's index
 * in the run's plan, its mint. Right before each dispatch the value must be the mint's text, and its source must still
 * say what it said (provenanceStale, read from `model()`); a value step with no mint is refused.
 */
export function guardFor(model: () => ScreenModel, mints: ReadonlyMap<number, CheckedValue>, origin: Origin, documentOf: DocumentReader | null): (step: number, value: string, target?: { windowId: string; node: Node; window?: WindowState }) => string | null {
  return (step, value, target) => {
    const m = mints.get(step);
    if (!isChecked(m)) return "the value has no check from the write contract";
    if (m.text !== value) return "the value is not the one Caret checked";
    // I2: the mint's authority must be the run's origin (an Ask's scope for an Ask's plan), never assumed.
    const foreign = authorityRefusal(m.authority, origin);
    if (foreign !== null) return foreign;
    // At dispatch the executor names the element it resolved: it must be the field checked, still asking the same (W2 review).
    if (target !== undefined && (target.node.key !== m.field.key || target.windowId !== m.field.windowId)) return "the field is not the one Caret checked the value for";
    if (target !== undefined && contractStale(target.node, m.field, value) !== null) return "the field now asks for something else than when its value was checked";
    // I2: a value minted under an Ask's scope is written only into a field that still reads as when the Ask was asked,
    // read from the window the executor resolved, right before the dispatch.
    if (m.authority.kind === "ask" && target !== undefined) {
      if (target.window === undefined) return "Caret can't see the field to check it is still the one the Ask was about";
      const out = scopeRefusal({ field: { ...m.field, fingerprint: fieldFingerprint(target.window, m.field.key) }, owner: m.owner }, m.authority.scope, documentOf);
      if (out !== null) return out;
    }
    const stale = provenanceStale(model(), m.provenance);
    return stale === null ? null : `the source of '${clip(m.text)}' changed (${stale})`;
  };
}
