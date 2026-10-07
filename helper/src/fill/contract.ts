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
import type { FillMemory, FillWithheld, Node, ValueKind } from "../protocol.ts";
import type { WindowState } from "../model.ts";
import { describeControl, type Control, type FormControl } from "./controls.ts";
import { asksCountry, datePart, fieldPart, partFits, type FillPart } from "./derive.ts";
import { describeField } from "./descriptor.ts";
import { CURRENCY_SHOWN, DATE_FORMAT, fieldKinds, misfit, textKind } from "./kinds.ts";
import { takesOneValue, writeMisfit } from "./writable.ts";
import { labelKind, SENSITIVE_SAYS } from "../memory/sensitive.ts";
import { secretIn } from "../planner/trace.ts";
import type { AskJev, JevRequest } from "./jev.ts";
import { SnippetLedger } from "../privacy.ts";

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
}

export type DeriveHow = "namePart" | "addressPart" | "placePart" | "datePart" | "placeWithCountry" | "optionFromPart";

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
    }
  | { kind: "memory"; id: string; label: string; part: FillMemory["part"] | null; whose: "user" | "other" | null }
  | { kind: "instruction"; span: string }
  | { kind: "answer"; id: string; question: string }
  | { kind: "derived"; how: DeriveHow; base: Provenance; also: Provenance | null }
  | { kind: "transfer"; srcWindowId: string; srcKey: string; rounds: number; reshaped: "memory" | null };

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
  | "derivedEvent"; // G3: a calendar event the inventory derived, eventAsAsked holds

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
  readonly jev: VerifyUse;
}

export interface CheckOptions {
  /** Jev, for the verifier; null verifies nothing, so every value the shape checks pass is refused as unverified. */
  askJev: AskJev | null;
  /** The ledger the caller's asks took screen text through: the verifier quotes only what it admits (privacy.ts). */
  ledger: SnippetLedger | null;
  /** The user's instruction when an Ask or goal scoped the write: quoted in the request's state, and a value it labels as a secret is never typed (trace.ts secretIn). */
  instruction?: string;
  now: number;
  /** An abort counts as the verifier being unavailable. */
  signal?: AbortSignal;
  cutoff?: number;
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
  readonly code: "unchecked" | "textMismatch" | "targetMismatch" | "shape" | "neverTyped";
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

function mint(p: Proposed, verdict: Verdict, now: number): CheckedValue {
  const c = Object.freeze({ field: p.field, text: p.text, display: p.display, provenance: p.provenance, owner: p.owner, verdict, at: now }) as unknown as CheckedValue;
  mints.add(c);
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
}): FieldContract {
  const words = x.labelWords.filter((w): w is string => typeof w === "string").join(" ");
  const inputKind = (x.node.inputKind ?? null) as InputKind;
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
    kinds: x.kinds,
    part: x.part,
    dateFormat: DATE_FORMAT.exec(words.toLowerCase())?.[0]?.toUpperCase() ?? null,
    currencyShown: CURRENCY_SHOWN.test(words),
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
  const part = typed ? (datePart(name) ?? fieldPart(name, formHasCity) ?? (asksCountry(name) ? "country" : null)) : null;
  // fill.ts describeInput, which the helper compares again before a proposal is shown.
  const descriptor = form === null ? d.text : describeControl(form, d.section, form.label === null ? d.nearest : null);
  return makeFieldContract({ windowId: w.window.windowId, node, descriptor, name: name ?? "unnamed field", labelWords, control, kinds, part });
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
export function shapeRefusal(p: Proposed): string | null {
  const v = p.text.trim();
  const secret = secretIn(v, "");
  if (secret !== null) return `Caret never types ${SENSITIVE_SAYS[secret]}; that is yours to enter`;
  const input = inputKindRefusal(p.field.inputKind, v);
  if (input !== null) return input;
  const kind = misfit(v, p.field.labelWords);
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
  if (p.provenance.kind === "window" && p.provenance.partOf !== null && !takesOneValue(p.field.labelWords)) return `'${clip(p.text)}' is part of '${clip(p.provenance.partOf)}', and the field asks for more than one value`;
  return writeMisfit(p.text, { labelWords: p.field.labelWords, part: p.field.part }, { label: sourceLabel(p) });
}

/** The never-typed check every mint meets, exemptions included: a value Caret never types, by its shape or by the instruction's label for it. */
export function neverTypedRefusal(p: Proposed, instruction = ""): string | null {
  const secret = secretIn(p.text.trim(), instruction);
  return secret === null ? null : `Caret never types ${SENSITIVE_SAYS[secret]}; that is yours to enter`;
}

/** Questions one verifier request asks at most: fill's MAX_FIELDS, so a request is no bigger than a fill's. */
export const VERIFY_BATCH = 20;

const OWNER_SAYS: Record<Exclude<Owner, null | "unclear">, string> = { user: "the user's", other: "someone else's", person: "the person the user named" };

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
  switch (pr.kind) {
    case "window": {
      const at = where(pr.app, pr.title, admitted);
      const base =
        pr.line !== null && admitted(pr.line) ? `the line "${pr.line}" in ${at}`
        : pr.label !== null && admitted(pr.label) ? `"${pr.span}" labelled '${pr.label}' in ${at}`
        : `"${pr.span}" in ${at}`;
      return pr.partOf !== null && pr.partOf !== pr.line && admitted(pr.partOf) ? `${base}, which is part of "${pr.partOf}"` : base;
    }
    case "memory":
      return pr.part === null ? `what the user told Caret as '${pr.label}'` : `the ${pr.part} part of what the user told Caret as '${pr.label}'`;
    case "instruction":
      return "the user's instruction";
    case "answer":
      return `the user's saved answer to '${pr.question}'`;
    case "transfer":
      return "a value the user copied there before";
    case "derived": {
      const how: Record<DeriveHow, string> = { namePart: "a part of the name", addressPart: "a part of the address", placePart: "a part of the place", datePart: "a part of the date", placeWithCountry: "the place with its country", optionFromPart: "the option for a part" };
      return `${how[pr.how]} in ${provenanceSays(pr.base, admitted)}`;
    }
  }
}

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
 * the input's kind, a spelled date format, a shown currency. Empty when code read none of these. W2 dev-set evidence: the
 * verifier called "455 Congress Ave, Austin, TX 78701" exact for an Address beside a City field when told only the label
 * (evidence/screen/w2/verify-eval-1).
 */
export function takesSays(f: FieldContract): string {
  const takes = [f.part === null ? null : PART_TAKES[f.part], f.inputKind === null ? null : (INPUT_TAKES[f.inputKind] ?? null), f.dateFormat === null ? null : `a date written as ${f.dateFormat}`, f.currencyShown ? "the number alone, since the field shows its currency" : null].filter((t): t is string => t !== null);
  return takes.length === 0 ? "" : ` The field takes ${takes.join("; ")}.`;
}

const WORDINGS = [
  (p: Proposed, from: string, owner: string): string =>
    `Field: ${p.field.descriptor}${takesSays(p.field)} Caret proposes to type this into it, with nothing added or removed: "${p.text}". It was read from ${from}${owner}. What is the proposed text, for this field?`,
  (p: Proposed, from: string, owner: string): string =>
    `Proposed text for the field '${p.field.name}': "${p.text}". Read from ${from}${owner}. The field: ${p.field.descriptor}${takesSays(p.field)} If Caret typed exactly this text into the field, what would it have typed?`,
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
  if (process.env.VITEST === undefined) throw new Error("setTestVerifier is for vitest only");
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
  const ledger = o.ledger ?? new SnippetLedger([]);
  // What the ledger admits: a text the request may quote. `plan` declares it, charging each window whose lines it
  // holds; text already taken for the value asks costs nothing more.
  const admittedCache = new Map<string, boolean>();
  const admitted = (t: string): boolean => {
    let ok = admittedCache.get(t);
    if (ok === undefined) admittedCache.set(t, (ok = ledger.plan([t])));
    return ok;
  };
  if (o.instruction !== undefined && o.instruction !== "" && !admitted(o.instruction)) throw new VerifierUnavailable("the instruction quotes more of an open window than the verifier may carry");
  const questions = proposed.map((p) => {
    // The field's descriptor and the text itself must go; a value whose own text the ledger refuses is not verified.
    if (!admitted(p.field.descriptor) || !admitted(p.text) || !admitted(p.field.name)) return null;
    for (const t of provenanceTexts(p.provenance)) admitted(t);
    const from = provenanceSays(p.provenance, admitted);
    const owner = p.owner === null || p.owner === "unclear" ? "" : `; the screen says it is ${OWNER_SAYS[p.owner]}`;
    return [WORDINGS[0](p, from, owner), WORDINGS[1](p, from, owner)] as const;
  });
  const declared = ledger.declared();
  const state: Record<string, unknown> = { task: "Caret checks that each value it is about to type is exactly what its field asks for.", ...(o.instruction === undefined || o.instruction === "" ? {} : { instruction: o.instruction }) };
  const batches: number[][] = [];
  const asked = proposed.flatMap((_, i) => (questions[i] === null ? [] : [i]));
  for (let i = 0; i < asked.length; i += VERIFY_BATCH) batches.push(asked.slice(i, i + VERIFY_BATCH));
  const request = (batch: readonly number[], wording: 0 | 1): JevRequest => {
    // The second wording asks in reverse order, so neither order nor wording alone decides.
    const order = wording === 0 ? batch : [...batch].reverse();
    const qs: JevRequest["questions"] = Object.fromEntries(order.map((i) => [`x${i + 1}`, { type: "choice" as const, instructions: (questions[i] as readonly [string, string])[wording], criteria: { ...VERDICTS } }]));
    const sent = sentStrings([state, qs]);
    return { purpose: "fill.verify", state, questions: qs, snippets: declared.snippets.filter((x) => sent.some((t) => t.includes(x.text))), charged: declared.charged };
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
  const ok: CheckedValue[] = [];
  const refused: Refused[] = [];
  const survivors: Proposed[] = [];
  for (const p of proposed) {
    const why = neverTypedRefusal(p, o.instruction ?? "") ?? shapeRefusal(p) ?? textShapeRefusal(p);
    observer?.(p, why);
    if (why !== null) refused.push({ proposed: p, why: "wrongKind", says: why });
    else survivors.push(p);
  }
  const v = await verifyProposed(survivors, o);
  survivors.forEach((p, i) => {
    const asks = v.asks[i] ?? null;
    if (asks === null) return void refused.push({ proposed: p, why: "unverified", says: `Caret couldn't check '${clip(p.text)}' without sending more of its window than it may` });
    const confidence = Math.min(asks[0].confidence, asks[1].confidence);
    if (asks[0].choice === "exact" && asks[1].choice === "exact" && confidence >= cutoff) ok.push(mint(p, { by: "verifier", asks, confidence }, o.now));
    else refused.push({ proposed: p, why: "notExact", says: refusalSays(p, asks, cutoff), asks });
  });
  return { ok, refused, jev: v.jev };
}

/**
 * Exemptions whose written text is copied text in a text field, so the deterministic shape checks still apply: a reply's
 * To takes the answered message's sender, which a "To phone number" field must refuse as an email (goal-derived.test.ts).
 * Every other exemption's text is the page's own option, the resolver's format, the user's saved answer, a draft its
 * own rules check, or the user's demonstrated transfer: only the never-typed check runs on it.
 */
const SHAPED: ReadonlySet<ExemptRule> = new Set(["recipientFromFrom"]);

/** Why a value may not be minted under `rule`, or null: the never-typed check, and for SHAPED rules shapeRefusal. */
export function exemptRefusal(p: Proposed, rule: ExemptRule, instruction = ""): string | null {
  return neverTypedRefusal(p, instruction) ?? (SHAPED.has(rule) ? shapeRefusal(p) : null);
}

/**
 * Mints without the verifier for a value whose exactness code settles (ExemptRule). Throws ContractError on a value
 * exemptRefusal refuses: a caller that may meet one asks exemptRefusal first; one that reaches here with it has a bug.
 */
export function mintExempt(p: Proposed, rule: ExemptRule, now: number, instruction = ""): CheckedValue {
  const why = exemptRefusal(p, rule, instruction);
  if (why !== null) throw new ContractError(neverTypedRefusal(p, instruction) === null ? "shape" : "neverTyped", why);
  return mint(p, { by: "exempt", rule }, now);
}

/**
 * The mint a compiler needs for one write: `c` must be a CheckedValue (isChecked), for exactly this text and this
 * field. Throws ContractError naming what failed; `at` names the step for the message.
 */
export function requireChecked(c: unknown, text: string, key: string, at: string): CheckedValue {
  if (!isChecked(c)) throw new ContractError("unchecked", `${at}: the value has no check from the write contract`);
  if (c.text !== text) throw new ContractError("textMismatch", `${at}: the value checked was '${clip(c.text)}', not '${clip(text)}'`);
  if (c.field.key !== key) throw new ContractError("targetMismatch", `${at}: the value was checked for another field`);
  return c;
}
