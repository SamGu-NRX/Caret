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
import type { AskJev } from "./jev.ts";
import type { SnippetLedger } from "../privacy.ts";

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
 * How a value was judged. "code" (W2 migration step 2 only): the deterministic checks and W1's text-shape gate passed,
 * with no model asked; step 3 replaces it with the verifier's verdict.
 */
export type Verdict = { by: "code" } | { by: "exempt"; rule: ExemptRule };

declare const minted: unique symbol;
/** Only checkValues and mintExempt create one. Identity is the proof: a structuredClone, JSON copy or look-alike is not checked (isChecked). */
export interface CheckedValue extends Proposed {
  readonly [minted]: true;
  readonly verdict: Verdict;
  readonly at: number;
}

export interface Refused {
  readonly proposed: Proposed;
  /** "wrongKind" for a shape refusal. */
  readonly why: FillWithheld;
  /** One sentence for the preview and the log. */
  readonly says: string;
}

export interface Checked {
  readonly ok: readonly CheckedValue[];
  readonly refused: readonly Refused[];
}

export interface CheckOptions {
  askJev: AskJev | null;
  ledger: SnippetLedger | null;
  /** The user's instruction when an Ask or goal scoped the write: a value it labels as a secret is never typed (trace.ts secretIn). */
  instruction?: string;
  now: number;
  signal?: AbortSignal;
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

/**
 * A stand-in for the verifier the guard adversary (scripts/guard-adversary.ts --verifier refuse|accept) installs while
 * W2's step 2 has no model call: "more" refuses every value that would otherwise be minted. Null in the product.
 */
let standIn: ((p: Proposed) => "exact" | "more") | null = null;
export function setVerifierStandIn(f: ((p: Proposed) => "exact" | "more") | null): void {
  standIn = f;
}

/**
 * The one gate for copied text. Runs the never-typed check with the instruction, shapeRefusal and W1's text-shape gate
 * on each value, then mints the survivors.
 */
export async function checkValues(proposed: readonly Proposed[], o: CheckOptions): Promise<Checked> {
  const ok: CheckedValue[] = [];
  const refused: Refused[] = [];
  for (const p of proposed) {
    const why = neverTypedRefusal(p, o.instruction ?? "") ?? shapeRefusal(p) ?? textShapeRefusal(p);
    if (why !== null) {
      refused.push({ proposed: p, why: "wrongKind", says: why });
      continue;
    }
    if (standIn !== null && standIn(p) !== "exact") {
      refused.push({ proposed: p, why: "wrongKind", says: `'${clip(p.text)}' holds more than the field asks for` });
      continue;
    }
    ok.push(mint(p, { by: "code" }, o.now));
  }
  return { ok, refused };
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
