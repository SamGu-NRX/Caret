// Grounded fill: one Jev request per form, one Choice question per empty field, each offering
// the same candidate spans plus "none" (deep plan section 5, "Fill"). Jev picks a candidate id;
// code copies that candidate's text verbatim into the proposal. Nothing here writes to any app.
//
// Every form is asked twice in parallel. The second ask shuffles the candidates, renumbers them and
// rewords each field's question. A value is proposed only when both asks pick the same candidate
// and the lower confidence clears the cutoff. With a second person's details on screen, a single
// ask filled 12 of 60 fields wrongly at confidences up to 0.90
// (~/.caret-run/evidence/screen/fill-distractors/fill-eval.md), so agreement and the cutoff exist
// to turn those into blanks.
import { randomInt, randomUUID } from "node:crypto";
import { PAGE_CHECKED, PAGE_SUBROLE, PROTOCOL_VERSION, type FillAsk, type FillField, type FillHandoff, type FillMemory, type FillProposal, type FillSource, type FillWithheld, type Node, type ValueKind } from "../protocol.ts";
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import { candidateKinds, candidateTexts, collectCandidates, cutKinds, describeCandidate, labelledCandidate, labelledLines, type Candidate } from "./candidates.ts";
import { CURRENCY_SHOWN, fieldKinds, fieldTerms, isKindTerm, isNameLike, kindTerm, misfit, NAME_TERM, overlap, textKind, words } from "./kinds.ts";
import { SnippetLedger, type Declared } from "../privacy.ts";
import { describeField, fieldLabelText } from "./descriptor.ts";
import { ABOUT_KIND_SAYS, ABOUT_SAYS, aboutFits, fieldAsksFor, fieldAsksForNamePart, type AboutKind, type AboutValue } from "./about.ts";
import type { AskJev, JevRequest, JevResult } from "./jev.ts";
import { boxKind, boxNeverTicked, consentLike, describeControl, formControls, inWebArea, matchOption, namedInList, optionInText, statesFact, type Control, type FormControl } from "./controls.ts";
import { asksCountry, datePart, fieldPart, joinName, namePart, partFits, splitAddress, splitDate, splitName, splitPlace, type FillPart } from "./derive.ts";
import { clockTime, readClock, readDate, readDateTime } from "./when.ts";
import { labelKind, type SensitiveKind } from "../memory/sensitive.ts";
import type { ResolveContext } from "../values/resolve.ts";
import type { SavedAnswer } from "../memory/answers.ts";
import { ANSWER_NONE, ANSWER_SAYS, ANSWER_WORDINGS, answerQuestionId, describeSaved, answerExcerpt, questionExcerpt, fillAnswer, guardAnswer, isAnswerField, MAX_ANSWERS_ASKED, pageText, type PageContext } from "./answers.ts";

export const NONE = "none";
/** The proposal's model name when a cut withheld every field and Jev was not asked. */
export const NOT_ASKED = "not asked";
export const FILLABLE_ROLES: ReadonlySet<string> = new Set(["AXTextField", "AXTextArea", "AXComboBox"]);
/**
 * A form question beyond this many inputs is cut, keeping the trigger, then the inputs whose labels share the most words
 * with the other windows, then the nearest (formInputs). A run of CHECKBOX_RUN or more sibling boxes counts as one.
 * Assumed.
 */
export const MAX_FIELDS = 20;
/**
 * Sibling checkboxes at least this many in a row count as one input against MAX_FIELDS. W4's Lever replay
 * (evidence/browser/w4/replay/final): 33 language boxes came before four radio questions in page order, and the
 * nearest-first cap of 20 left all four out. Assumed: five boxes is already a list of options, not separate questions.
 */
export const CHECKBOX_RUN = 5;
/** Roles of the inputs a form shows, asked or not: what ends a run of sibling checkboxes. */
const INPUT_ROLES: ReadonlySet<string> = new Set(["AXTextField", "AXTextArea", "AXComboBox", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXDateField", "AXTimeField"]);
/**
 * The window kind the page engine gives a browser tab it reads (v2/screen engines/page-link.ts toWindowSnapshot). A
 * write to a web dropdown there becomes the engine's pageChooseOption: open the list, type the value as its filter,
 * pick only when exactly one option's name equals it, and verify the control's shown text, react-select's hidden input
 * and aria-expanded. A dropdown read through Accessibility has no such handler, so its value is a hand-off.
 *
 * D2-04: there the engine also writes a native select (by option label, verified by selectedOptions), a radio group
 * and a checkbox (by checked state) and a date, time or date-and-time input (by value), so a Fill all writes those too
 * (FillHandoff.writes). Through Accessibility they stay hand-offs.
 */
export const PAGE_WINDOW_KIND = "page";

/**
 * Whether a value reads as one option's name, as a dropdown would list it: one line of at most six words and 60
 * characters, with no remark in parentheses, no link, no sentence's closing punctuation, and no comma unless it is a
 * place ("Oakland, CA, USA"). "United States" and "Oakland" do; "Oakland, California, United States (in the Bay
 * Area)", "authorized to work in the United States." and "yes, US citizen" do not (the last went to a Yes/No dropdown
 * on the B24 corpus's Greenhouse form, evidence/screen/b27/fill-final). Written for common option names, not
 * measured; the engine's exact-match pick is the check.
 */
export function optionName(value: string): boolean {
  const v = value.trim();
  if (v === "" || v.length > 60 || /[\r\n()]|:\/\//u.test(v) || /[.!?;:]$/u.test(v) || v.split(/\s+/u).length > 6) return false;
  return !v.includes(",") || splitPlace(v) !== null;
}
/**
 * Lowest confidence, taken as the lower of the two asks, at which an agreed choice is proposed.
 * It is the lowest cutoff at which none of the five calibration sets (900 field judgments over four
 * prompt versions, ~/.caret-run/evidence/screen/fill-distractors-v2/calibration.md) has a wrong
 * agreed fill; the highest wrong agreed confidence seen was 0.70. On the final prompt it gives up
 * 2 of 156 answerable fields. One synthetic fixture is thin evidence; recheck on real windows.
 */
export const FILL_CUTOFF = 0.75;

/**
 * A value the user told Caret (about.ts) is filled on different evidence from a window's. Beside the
 * value question, each field offered one is asked whose details it wants: the user's, someone else's, or
 * unclear (WHOSE_CRITERIA). The value is proposed when both asks agree on it at MEMORY_CUTOFF or above and
 * both whose answers say the user's at WHOSE_CUTOFF or above. B17 found live Jev choosing the user's value
 * on the right fields at 0.23 to 0.88, under FILL_CUTOFF, so 1 to 3 of 17 were filled.
 *
 * Chosen on B18's dev half (evidence/screen/b18/mem-dev, 18 forms, 55 fields, two live passes per option):
 * - A memory cutoff alone needed 0.6 for no wrong fill in both passes, which filled 4 and 7 of 20 own values;
 *   ambiguous fields ("Primary contact" Name) drew the user's value at up to 0.61.
 * - The whose question answered "user" at 0.58 or more (lower of the two asks) on every own field the value
 *   asks agreed on, and at 0.36 or less on every ambiguous one; never on a field for someone else. At these
 *   cutoffs both passes filled 12 of 20 with no wrong fill. 14 of 20 is the most the code rules offer.
 * WHOSE_CUTOFF sits between 0.36 and 0.58; MEMORY_CUTOFF is a floor that cost nothing on dev. Both rest on
 * one synthetic dev set; recheck on real forms.
 *
 * A part of the user's Name (B24, derived from memory) meets both cutoffs the same way (memoryOf). B26's two "wrong"
 * m21 fills were "Sam" and "Rivera" under "Your details", the user's own: the held-out sets were labelled when fill
 * copied a value only whole. B27 relabelled them and wrote 14 blind forms that put First/Last name in other people's
 * sections (evidence/screen/b27/mem-a, three live passes each of B17, B18 and those forms): 0 wrong fills. On 60
 * judgments of another person's name part, both whose asks never said the user's. On 21 of an unclear field's,
 * they did at 0.33 to 0.57, twice at or over WHOSE_CUTOFF (a bare "Application form", Last name); the value question
 * kept both blank. So the 0.36 ceiling above does not hold on unclear fields, and there the value pick is the only
 * guard left. No wrong fill came of it; not tuned.
 */
export const MEMORY_CUTOFF = 0.3;
export const WHOSE_CUTOFF = 0.5;

/**
 * Why a fill could not be asked or read (B27). planner/says.ts turns each into the sentence the user reads (fillSays);
 * the message keeps the window and field ids, for logs.
 */
export type FillErrorWhy = "noWindow" | "noField" | "instructionTooLong" | "labelTooLong" | "nothingToCopy" | "badAnswer";
export class FillError extends Error {
  readonly why: FillErrorWhy;
  constructor(why: FillErrorWhy, message: string) {
    super(message);
    this.why = why;
  }
}

/**
 * The kind of a field Caret never types (B25 lead decision 2), read from its label, nearest label and placeholder
 * as describeField finds them, by the classifier memory uses for what it never keeps (memory/sensitive.ts, M1), so
 * the two never disagree; null for any other field. Fill and the planner both leave such a field to the user, as
 * they leave a secure field.
 */
export function neverTypedNode(w: WindowState, n: Node): SensitiveKind | null {
  const d = describeField(w, n);
  return labelKind(d.label ?? d.nearest) ?? labelKind(d.placeholder);
}

/** The empty fillable fields of the trigger's window, nearest the trigger first. The trigger is always included. */
export function formFields(w: WindowState, triggerKey: string, max = MAX_FIELDS): Node[] {
  const trigger = w.nodes.get(triggerKey);
  if (trigger === undefined) throw new FillError("noField", `field ${triggerKey} is not in window ${w.window.windowId}`);
  if (trigger.editable !== true) throw new FillError("noField", `field ${triggerKey} is not editable`);
  const fields = [...w.nodes.values()].filter(
    (n) => n.key === triggerKey || (n.editable === true && FILLABLE_ROLES.has(n.role) && (n.value ?? "") === "" && !n.states?.includes("secure") && neverTypedNode(w, n) === null),
  );
  const center = (n: Node): [number, number] => (n.frame === undefined ? [0, 0] : [n.frame[0] + n.frame[2] / 2, n.frame[1] + n.frame[3] / 2]);
  const [tx, ty] = center(trigger);
  const dist = (n: Node): number => (n.key === triggerKey ? -1 : Math.hypot(center(n)[0] - tx, center(n)[1] - ty));
  return fields.sort((a, b) => dist(a) - dist(b)).slice(0, max);
}

/**
 * Whether any field of the form around `triggerKey` asks for one of `about`, by the name proposeFill offers
 * memory by (the field's label, else its nearest label, else its placeholder; about.ts fieldAsksFor).
 */
export function formAsksFor(w: WindowState, triggerKey: string, about: readonly AboutValue[]): boolean {
  if (about.length === 0) return false;
  return formFields(w, triggerKey).some((n) => {
    const d = describeField(w, n);
    const name = d.label ?? d.nearest ?? d.placeholder;
    return about.some((a) => fieldAsksFor(a, name));
  });
}

/** The descriptor a question carries for a form input; the helper compares it again before showing a proposal. */
export function describeInput(w: WindowState, x: FormInput): string {
  const d = describeField(w, x.node);
  return x.form === null ? d.text : describeControl(x.form, d.section, x.form.label === null ? d.nearest : null);
}

/**
 * A proposal's field as the form shows it now: its input, read the way proposeFill read it, when it is still
 * empty (no value typed, no box ticked, no option picked), or null. The helper revalidates with this, so a
 * control is judged by the same rules that proposed it (review: a checkbox's descriptor read as "Field." and
 * every control was dropped before it was shown).
 */
export function emptyInput(w: WindowState, key: string): FormInput | null {
  const n = w.nodes.get(key);
  if (n === undefined) return null;
  if (FILLABLE_ROLES.has(n.role) && n.editable === true) {
    if ((n.value ?? "") !== "" || n.states?.includes("secure") || neverTypedNode(w, n) !== null) return null;
    return n.role === "AXComboBox" && inWebArea(w, n) ? { node: n, control: "combobox", form: { node: n, control: "combobox", label: fieldLabelText(n.label), options: null, members: [] } } : { node: n, control: "text", form: null };
  }
  const c = formControls(w).find((x) => x.node.key === key);
  return c === undefined ? null : { node: c.node, control: c.control, form: c };
}

/** A field of the form as fill asks about it: a text field, or (B24) one of controls.ts's controls. */
export interface FormInput {
  node: Node;
  control: Control;
  /** The control's model from controls.ts; null for a text field. */
  form: FormControl | null;
}

/**
 * The empty fields of the trigger's form: text fields as formFields finds them, then, unless `controls` is false, its
 * empty selects, radio groups, unticked boxes and date and time fields (controls.ts), so a form's every input is in one
 * proposal (Q1 bug 10), nearest the trigger first. The trigger is always included. A run of CHECKBOX_RUN sibling boxes
 * counts as one input against `max` and is kept or cut whole (B27). Past `max`, the trigger comes first, then the inputs
 * whose label, nearest label or placeholder shows the most of `source()`, the words (kinds.ts words) of the windows fill
 * reads, ties nearest first; they come back in that order, so the most relevant claim the form window's share of a
 * question first. A form within `max` keeps nearest-first order and never reads `source`.
 */
export function formInputs(w: WindowState, triggerKey: string, max = MAX_FIELDS, controls = true, source: () => ReadonlySet<string> = () => new Set()): FormInput[] {
  // A web page's combobox (react-select, an airport picker) takes a pick from its list, not typed text, so it
  // is a named hand-off (Q1: Caret was about to type a school name into one).
  const text = formFields(w, triggerKey, Number.MAX_SAFE_INTEGER).map((node): FormInput =>
    controls && node.role === "AXComboBox" && inWebArea(w, node)
      ? { node, control: "combobox", form: { node, control: "combobox", label: fieldLabelText(node.label), options: null, members: [] } }
      : { node, control: "text", form: null },
  );
  const other = controls ? formControls(w).map((c): FormInput => ({ node: c.node, control: c.control, form: c })) : [];
  const trigger = w.nodes.get(triggerKey) as Node;
  const center = (n: Node): [number, number] => (n.frame === undefined ? [0, 0] : [n.frame[0] + n.frame[2] / 2, n.frame[1] + n.frame[3] / 2]);
  const [tx, ty] = center(trigger);
  const dist = (n: Node): number => (n.key === triggerKey ? -1 : Math.hypot(center(n)[0] - tx, center(n)[1] - ty));
  const all = [...text, ...other.filter((o) => !text.some((t) => t.node.key === o.node.key))].sort((a, b) => dist(a.node) - dist(b.node));
  // Runs of sibling boxes, in page order with no other input between.
  const byKey = new Map(all.map((x) => [x.node.key, x]));
  const runOf = new Map<FormInput, FormInput[]>();
  let run: FormInput[] = [];
  const close = (): void => {
    if (run.length >= CHECKBOX_RUN) for (const x of run) runOf.set(x, run);
    run = [];
  };
  for (const n of w.nodes.values()) {
    const x = byKey.get(n.key);
    const box = n.role === "AXCheckBox" && (run.length === 0 || run[0]?.node.parent === n.parent);
    // Any other input closes a run, asked or not (a filled field between two lists of boxes; B27 review). A ticked
    // box of the same list does not.
    if (x === undefined) {
      if (INPUT_ROLES.has(n.role) && !box) close();
      continue;
    }
    if (!box || x.control !== "checkbox") close();
    if (x.control === "checkbox") run.push(x);
  }
  close();
  const units: FormInput[][] = [];
  const placed = new Set<FormInput>();
  for (const x of all) {
    if (placed.has(x)) continue;
    const unit = runOf.get(x) ?? [x];
    for (const u of unit) placed.add(u);
    units.push(unit);
  }
  if (units.length <= max) return all;
  const seen = source();
  const shown = (x: FormInput): number => {
    const d = describeField(w, x.node);
    const said = [x.form?.label ?? d.label, d.nearest, d.placeholder].filter((t): t is string => typeof t === "string");
    return new Set(words(said.join(" ")).filter((t) => seen.has(t))).size;
  };
  const rank = (u: FormInput[]): number => (u.some((x) => x.node.key === triggerKey) ? Number.MAX_SAFE_INTEGER : Math.max(...u.map(shown)));
  return units
    .map((u, i) => ({ u, i, r: rank(u) }))
    .sort((a, b) => b.r - a.r || a.i - b.i)
    .slice(0, max)
    .flatMap((x) => x.u);
}

export interface AskField {
  id: string;
  descriptor: string;
  /** A short name for the field, used to list the form's other fields. */
  name: string;
}

/**
 * Ask 1 and ask 2 word the same question differently, so a choice that rests on wording alone is
 * less likely to repeat. The second wording is a plain paraphrase: an earlier one that added "for the
 * same person, order or event the form is about" made the second ask wrong on 43 of the 180 judgments
 * where the first was right (wording1-cal-* in the evidence folder).
 */
const WORDINGS = [
  (where: string, d: string): string =>
    `A form in the ${where} has this field: ${d} Which candidate is the value the user should enter in this field? The user usually copies from the window they just left. Choose none if no candidate fits.`,
  (where: string, d: string): string =>
    `Field to fill: ${d} It is in a form in the ${where}. Which value below should the user type into this field? Values usually come from the window the user just left. Answer none if no value below belongs in it.`,
] as const;

/**
 * An Ask's value questions (B25) lead with the user's instruction and leave out where users usually copy from:
 * with an Ask's source narrowed to memory, the copying wording drew agreed picks of the user's own name and email
 * at confidence 0.08 to 0.27 (evidence/screen/b25/asks-smoke-w, ask-12).
 */
const ASK_WORDINGS = [
  (instr: string, where: string, d: string): string => `The user asked Caret: "${instr}". A form in the ${where} has this field: ${d} Which candidate should go in this field for that instruction? Choose none if no candidate fits.`,
  (instr: string, where: string, d: string): string => `Instruction from the user: "${instr}". Field to fill: ${d} It is in a form in the ${where}. Which value below belongs in this field? Answer none if no value below does.`,
] as const;

/** A value the user told Caret, under this ask's id for it (m1, m2... in the first ask, n1... in the second). */
export interface AskAbout {
  id: string;
  about: AboutValue;
}

/** The answers to a question about whose details a field asks for (see WHOSE_WORDINGS). */
export const WHOSE_CRITERIA = {
  user: "The user's own details: the field asks about the person filling in the form.",
  other: "Someone else's details: a contact, guest, recipient, attendee, family member, colleague or another person the form or the screen names.",
  unclear: "The form does not make clear whose details this field asks for.",
} as const;
export type Whose = keyof typeof WHOSE_CRITERIA;
const WHOSE_WORDINGS = [
  (where: string, d: string): string => `A form in the ${where} has this field: ${d} Whose name or email does this field ask for?`,
  (where: string, d: string): string => `Field: ${d} It is in a form in the ${where}. Is it for the details of the user filling in the form, of someone else, or can you not tell?`,
] as const;
/** The id of a field's whose-details question. */
export const whoseId = (fieldId: string): string => `${fieldId}_whose`;

/** The criterion for a value the user told Caret: what it is, and that it is the user's own. */
export function describeAbout(a: AboutValue): string {
  return `"${a.value}" (${ABOUT_KIND_SAYS[a.kind]}; the user's own ${a.label}, which the user told Caret)`;
}

/** Values code derived for one field, or candidates whose owner is asked, under one ask's ids. */
export interface AskExtra {
  id: string;
  describe: string;
}

/** What one ask carries beyond the shared candidates and memory (B24). */
export interface RequestMore {
  /** Values code derived for a field (derive.ts), offered only in that field's question. */
  derived?: ReadonlyMap<string, readonly AskExtra[]>;
  /** Fields that ask for a person's details, so whose details they want is asked beside them. */
  personal?: ReadonlySet<string>;
  /** Candidates whose owner is asked, by this ask's candidate id. */
  owners?: readonly AskExtra[];
  /** Each field's control, which words its question. Text when absent. */
  controls?: ReadonlyMap<string, Control>;
  /**
   * "whose": only the questions of whose details fields want and values are (the first stage); "values": only
   * the value questions (the second). Absent: both in one request.
   */
  stage?: "whose" | "values";
  /** Candidates, by this ask's id, not offered to a field (by field id): another person's for a field that wants the user's, or the reverse. */
  exclude?: ReadonlyMap<string, ReadonlySet<string>>;
  /** The user's instruction when an Ask scoped the fill (B25): every question's state quotes it. */
  instruction?: string;
  /** A person the instruction names (FillScope.person): the owner questions ask whether a value is theirs. */
  person?: string | null;
  /** S1: fields asked which saved answer answers them, each with its own answers under this ask's ids (fill/answers.ts). */
  answers?: readonly { id: string; descriptor: string; criteria: Readonly<Record<string, string>> }[];
}

/** The owner question's answers when an Ask names a person: theirs, the user's, someone else's, or unclear. */
export function personOwnerCriteria(person: string): Record<string, string> {
  return {
    person: `The details of ${person}, the person the user's instruction names.`,
    user: OWNER_CRITERIA.user,
    other: `Someone else's: anyone but the user and ${person}.`,
    unclear: OWNER_CRITERIA.unclear,
  };
}

/** A checkbox or a choice of options is asked which candidate says what to set, not which value to type. */
const CONTROL_WORDINGS: Partial<Record<Control, readonly [(where: string, d: string) => string, (where: string, d: string) => string]>> = {
  checkbox: [
    (where, d) => `A form in the ${where} has this checkbox: ${d} Which candidate says the user wants this box ticked? The user usually copies from the window they just left. Choose none if no candidate says so.`,
    (where, d) => `Checkbox: ${d} It is in a form in the ${where}. Which value below says this box should be ticked? Answer none if no value below says so.`,
  ],
  radio: [
    (where, d) => `A form in the ${where} has this choice: ${d} Which candidate says which option the user should pick? The user usually copies from the window they just left. Choose none if no candidate says.`,
    (where, d) => `Choice to make: ${d} It is in a form in the ${where}. Which value below names the option to pick? Answer none if no value below does.`,
  ],
  select: [
    (where, d) => `A form in the ${where} has this menu: ${d} Which candidate says which option the user should pick? The user usually copies from the window they just left. Choose none if no candidate says.`,
    (where, d) => `Menu to set: ${d} It is in a form in the ${where}. Which value below names the option to pick? Answer none if no value below does.`,
  ],
  // B27: its options are not shown, so the value must be the option's own name.
  combobox: [
    (where, d) => `A form in the ${where} has this dropdown: ${d} Its options are not shown. Which candidate is the name of the option the user should pick? The user usually copies from the window they just left. Choose none if no candidate is an option's name.`,
    (where, d) => `Dropdown to set: ${d} It is in a form in the ${where}, and its list is closed. Which value below is the option to pick, as the list would name it? Answer none if no value below is.`,
  ],
};

/** The answers to a question about whose details a value on screen is. */
export const OWNER_CRITERIA = {
  user: "The user's own: the person using this Mac, who is filling in the form.",
  other: "Someone else's: a sender, colleague, contact, family member, landlord, reference or any other person.",
  unclear: "The screen does not make clear whose it is.",
} as const;
const OWNER_WORDINGS = [
  (d: string): string => `A value on the user's screen: ${d} Whose details is it?`,
  (d: string): string => `Whose details is this value, the user's or someone else's? ${d}`,
] as const;
/** The id of a candidate's whose-value question. */
export const ownerId = (candidateId: string): string => `${candidateId}_owner`;

/**
 * One ask. `declared` holds the screen text in it and what each window was charged (privacy.ts); `title` is the form window's title as
 * declared there, or null when it did not fit the window's budget and the question names the app alone. `about` lists, by field id,
 * the values the user told Caret that the field asks for (about.ts); only that field's question offers them. `more` adds B24's
 * derived values, controls and the questions about whose details a field wants and a value is.
 */
export function buildFillRequest(
  w: WindowState,
  fields: AskField[],
  candidates: Candidate[],
  wording: 0 | 1 = 0,
  declared: Declared = { snippets: [], charged: {} },
  title: string | null = w.window.title,
  about: ReadonlyMap<string, readonly AskAbout[]> = new Map(),
  whose = false,
  more: RequestMore = {},
): JevRequest {
  const shared: Record<string, string> = {};
  for (const c of candidates) shared[c.id] = describeCandidate(c);
  const where = title === null ? `${w.app.name} window` : `${w.app.name} window '${title}'`;
  const questions: JevRequest["questions"] = {};
  for (const f of fields) {
    if (more.stage !== "whose") {
      const excluded = more.exclude?.get(f.id);
      const criteria: Record<string, string> = excluded === undefined ? { ...shared } : Object.fromEntries(Object.entries(shared).filter(([id]) => !excluded.has(id)));
      for (const a of about.get(f.id) ?? []) criteria[a.id] = describeAbout(a.about);
      for (const d of more.derived?.get(f.id) ?? []) criteria[d.id] = d.describe;
      criteria[NONE] = "No candidate is the value this field asks for.";
      const control = more.controls?.get(f.id) ?? "text";
      const words = CONTROL_WORDINGS[control]?.[wording];
      const instr = more.instruction;
      const asked =
        instr === undefined ? (words ?? WORDINGS[wording])(where, f.descriptor) : words === undefined ? ASK_WORDINGS[wording](instr, where, f.descriptor) : `The user asked Caret: "${instr}". ${words(where, f.descriptor)}`;
      questions[f.id] = { type: "choice", instructions: asked, criteria };
    }
    if (more.stage !== "values" && whose && ((about.get(f.id)?.length ?? 0) > 0 || more.personal?.has(f.id) === true)) {
      questions[whoseId(f.id)] = { type: "choice", instructions: WHOSE_WORDINGS[wording](where, f.descriptor), criteria: { ...WHOSE_CRITERIA } };
    }
  }
  if (more.stage !== "whose") {
    for (const a of more.answers ?? []) questions[answerQuestionId(a.id)] = { type: "choice", instructions: ANSWER_WORDINGS[wording](where, a.descriptor), criteria: { ...a.criteria, [NONE]: ANSWER_NONE } };
  }
  const ownerCriteria = more.person === null || more.person === undefined ? { ...OWNER_CRITERIA } : personOwnerCriteria(more.person);
  if (more.stage !== "values") for (const o of more.owners ?? []) questions[ownerId(o.id)] = { type: "choice", instructions: OWNER_WORDINGS[wording](o.describe), criteria: { ...ownerCriteria } };
  const anyAbout = fields.some((f) => (about.get(f.id)?.length ?? 0) > 0);
  const anyDerived = fields.some((f) => (more.derived?.get(f.id)?.length ?? 0) > 0);
  const req: JevRequest = {
    state: {
      ...(more.instruction === undefined ? {} : { instruction: more.instruction }),
      destination_window: where,
      form_fields: [...fields.map((f) => f.name), ...(more.answers ?? []).map((a) => a.descriptor)].join("; "),
      task:
        "The user is filling in this form. The candidates are values visible in the user's other open windows. " +
        "Users most often copy from the window they were in just before the form." +
        (anyAbout ? " A few candidates are the user's own details, which the user told Caret; one fits a field only when the form asks for the user's own details there." : "") +
        (anyDerived ? " Some candidates are a part of another, which Caret split out: a first or last name, or a street, city, state, ZIP code or country of an address or place." : "") +
        (more.instruction === undefined ? "" : " The user asked Caret for this in the instruction above: a field gets a value only when the instruction asks for it, from where the instruction says.") +
        (more.person === null || more.person === undefined ? "" : ` The instruction asks for ${more.person}'s details.`) +
        ((more.answers?.length ?? 0) > 0 ? " Some fields ask for a written answer; for those, the candidates are answers the user saved on earlier forms." : ""),
    },
    questions,
    snippets: declared.snippets,
    charged: declared.charged,
    ...(declared.consented === undefined ? {} : { consented: declared.consented }),
  };
  // A staged request (B24) carries only some of the asked text: it declares only the snippets it sends, as the
  // planner's requests do (privacy.test.ts fails a request that declares text it does not send). The ledger
  // still charged their windows for all of them, which errs on the side of saying less.
  if (more.stage === undefined && more.exclude === undefined && more.instruction === undefined) return req;
  const strings = sent(req);
  return { ...req, snippets: req.snippets.filter((x) => strings.some((t) => t.includes(x.text))) };
}

/** Every string a request carries in its state and questions. */
function sent(req: JevRequest): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
  };
  walk([req.state, req.questions]);
  return out;
}

/** Fisher-Yates with an injectable source of randomness, so tests can fix the order. */
export function shuffled<T>(xs: readonly T[], rand: (n: number) => number = randomInt): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Shuffles candidates within each source window, keeping the windows in their original order. */
export function shuffledWithinWindows(cands: readonly Candidate[], rand?: (n: number) => number): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  for (const c of cands) {
    const g = groups.get(c.source.windowId);
    if (g === undefined) groups.set(c.source.windowId, [c]);
    else g.push(c);
  }
  const windowOrder = [...new Set(cands.map((c) => c.source.windowId))];
  return windowOrder.flatMap((id) => shuffled(groups.get(id) ?? [], rand));
}

export interface FillOptions {
  cutoff?: number;
  rand?: (n: number) => number;
  /** Makes the proposal id; tests pass a counter. */
  newId?: () => string;
  /** Windows that give no candidates. */
  exclude?: ReadonlySet<string>;
  /**
   * False turns off the source-cut rule, for the live replay's measure of what it costs and saves
   * (scripts/live-replay.ts). The helper never sets it.
   */
  cutRule?: boolean;
  /** False spends a conversation's budget in screen order, as before B12, for the same replay. The helper never sets it. */
  relevance?: boolean;
  /** False asks a field whose label names no kind despite a cut, as B12 did, for the same replay. The helper never sets it. */
  unknownKindRule?: boolean;
  /** False takes a conversation's kinds in the order the fields want them, as B12 did (candidates.ts kindsByCost). The helper never sets it. */
  kindsByCost?: boolean;
  /** False leaves a conversation's names ungrouped and their cut unchecked, as B13 did (candidates.ts nameGroup). The helper never sets it. */
  nameGroup?: boolean;
  /**
   * Values the user told Caret (typed About entries, about.ts), each offered only to the fields that ask
   * for it. A form can then be filled with no other window open. Without it, nothing from memory is offered.
   */
  about?: readonly AboutValue[];
  /** Lowest agreed confidence for a value from memory: MEMORY_CUTOFF, or FILL_CUTOFF with `whose` false. */
  memoryCutoff?: number;
  /**
   * False skips the whose-details question and holds a value from memory to the memory cutoff alone, for
   * the eval's measure of that option (scripts/about-fill-eval.ts). The helper never sets it.
   */
  whose?: boolean;
  /** Lowest confidence, the lower of the two asks, at which "the user's" counts as the whose answer: WHOSE_CUTOFF. */
  whoseCutoff?: number;
  /**
   * B24's changes, each on by default; false turns one off for the real-form scoreboard's comparison
   * (scripts/realfill-eval.ts). The helper never sets them. `controls`: selects, radios, boxes, dates and times
   * (Q1 bug 10). `anchor`: a cut elsewhere does not withhold a field the window the user just left answers
   * whole. `derive`: name and address parts (bug 11). `owner`: the whose-value veto.
   */
  controls?: boolean;
  anchor?: boolean;
  derive?: boolean;
  owner?: boolean;
  /** How dates and times are read for date and time fields; the Mac's locale and zone, with no reference instant, by default. */
  resolve?: ResolveContext;
  /** What an Ask narrows the fill to (B25); absent for a fill on focus. */
  scope?: FillScope;
  /**
   * S1: the user's active saved answers, offered to a page form's empty fields that take a written answer (fill/answers.ts
   * isAnswerField). Absent or empty: no field is asked about them. Only the helper's host-capability check sets it.
   */
  answers?: readonly SavedAnswer[];
  /** S1: the page's address and headings, which the organization guard reads beside the window's own text. */
  page?: PageContext;
}

/**
 * What an Ask narrows a fill to (B25, planner/intent.ts checks it): which fields are asked about, which sources
 * give candidates, whose details personal fields take, and values the instruction spells out. Every other rule
 * of the fill stands: both asks must agree above the cutoff, the cut rules, kinds, the owner veto and the ledger.
 */
export interface FillScope {
  /** The fields to ask about, by node key, in document order. A text field among them that holds a value may be changed. */
  fields: readonly string[];
  /** Windows that give candidates; null for every window, as fill reads them on focus. */
  windows: ReadonlySet<string> | null;
  /** Whether what the user told Caret is offered. */
  memory: boolean;
  /** The user's instruction, which every question's state quotes. */
  instruction: string;
  /**
   * A person the instruction names ("Gary", "my sister"). A field in scope that takes a person's details takes
   * only a value both asks say is that person's; the user's own values are not offered to it.
   */
  person: string | null;
  /** Exact spans of the instruction tied to fields, by node key; each is offered only in its field's question. */
  literals: ReadonlyMap<string, string>;
  /** Windows the instruction names, which this fill may read up to WINDOW_CHARS (privacy.ts CONSENTED); none when absent. */
  consented?: ReadonlySet<string>;
  /** People whose lines go first in the windows the instruction names: the name that named one, and its sender. */
  first?: readonly string[];
}

/** The inputs a scope names, in its order: text fields (filled or not, never one Caret never types) and empty controls. */
function scopedInputs(w: WindowState, keys: readonly string[]): FormInput[] {
  const controls = formControls(w);
  const out: FormInput[] = [];
  for (const k of keys) {
    const n = w.nodes.get(k);
    if (n === undefined) continue;
    if (FILLABLE_ROLES.has(n.role) && n.editable === true) {
      if (n.states?.includes("secure") || neverTypedNode(w, n) !== null) continue;
      out.push(n.role === "AXComboBox" && inWebArea(w, n) ? { node: n, control: "combobox", form: { node: n, control: "combobox", label: fieldLabelText(n.label), options: null, members: [] } } : { node: n, control: "text", form: null });
      continue;
    }
    const c = controls.find((x) => x.node.key === k);
    if (c !== undefined) out.push({ node: c.node, control: c.control, form: c });
  }
  return out.slice(0, MAX_FIELDS);
}

/** What a field's answer came from: a window's candidate, a value the user told Caret, or a part code derived from either. */
type Pick =
  | { from: "window"; c: Candidate }
  | { from: "memory"; a: AboutValue }
  | { from: "instruction"; text: string }
  | { from: "derived"; text: string; base: { from: "window"; c: Candidate } | { from: "memory"; a: AboutValue } | { from: "instruction"; text: string }; also: Candidate | null };

/** Words of a label that say its value is a person's: "Name:", "Traveler:", "To:", "Emergency contact:". Written for common labels, not measured. */
const PERSON_LABEL = /\b(?:name|traveler|traveller|passenger|patient|guest|applicant|student|attendee|from|to|cc|reference|landlord|contact|recipient|sender|tenant|driver|member|employee|candidate|spouse|partner|roommate|manager|advisor)\b/i;
/** "Avery Kim <avery.kim@example.com>": a display name before an address. */
const DISPLAY_NAME = /^\s*"?([^"<>@]+?)"?\s*<[^<>\s@]+@[^<>\s]+>\s*$/u;
const PART_SAYS: Record<FillPart, string> = {
  first: "first name",
  middle: "middle name",
  last: "last name",
  full: "name",
  street: "street line",
  unit: "apartment or unit",
  city: "city",
  state: "state",
  zip: "ZIP code",
  country: "country",
  month: "month",
  year: "year",
};
const ADDRESS_PARTS: ReadonlySet<FillPart> = new Set(["street", "unit", "city", "state", "zip"]);
/** Parts a place written "City, State, Country" gives (derive.ts splitPlace). */
const PLACE_PARTS: ReadonlySet<FillPart> = new Set(["city", "state", "country"]);
/** C1: parts of a date, for a field or a menu that asks only for its month or year (derive.ts splitDate). */
const DATE_PARTS: ReadonlySet<FillPart> = new Set(["month", "year"]);
/** C1: the part a menu asks for, if any: a date's month or year, a state, or a country. */
function menuPart(name: string | null): FillPart | null {
  const d = datePart(name);
  if (d !== null) return d;
  if (asksCountry(name)) return "country";
  return fieldPart(name) === "state" ? "state" : null;
}
/**
 * C1: the part `part` of a whole date, address or place `text`, as code splits it (derive.ts), or null. A menu's pick
 * that is a whole date ("May 2021") or address names its option only through this part ("May"), which the menu then
 * matches exactly, as a part fill offered on its own would be.
 */
function partOf(part: FillPart, text: string): string | null {
  if (part === "month" || part === "year") {
    const d = splitDate(text);
    return d === null ? null : part === "month" ? d.month : d.year;
  }
  if (part === "state") return splitAddress(text)?.state ?? splitPlace(text)?.state ?? null;
  if (part === "country") return splitPlace(text)?.country ?? null;
  return null;
}
/** Label words that say only a field's kind, so they cannot tie one of a person's phones or emails to the field. */
const KIND_ONLY_WORDS: ReadonlySet<string> = new Set(["phone", "telephone", "tel", "mobile", "cell", "number", "email", "mail", "address", "contact"]);
/** Label words that say a value is a link, or nothing about what it is for. */
const LINK_WORDS: ReadonlySet<string> = new Set(["url", "website", "web", "site", "link", "homepage", "page", "profile", "other"]);
/** What a label says a value is for: its words less those naming a kind or a link ("Portfolio" from "Portfolio URL"). */
const purposeOf = (labels: readonly (string | null)[]): Set<string> =>
  new Set([...fieldTerms(labels)].filter((t) => !isKindTerm(t) && t !== NAME_TERM && !KIND_ONLY_WORDS.has(t) && !LINK_WORDS.has(t)));
/**
 * C1: words that say the same purpose of a second email, phone or link: a note's "Backup email" is a form's "Alternate
 * email". Written for common labels, not measured.
 */
const SECOND = new Set(["alternate", "alternative", "backup", "secondary", "additional", "second"]);
const samePurpose = (w: string): string => (SECOND.has(w) ? "alternate" : w);
/** Kinds of which a screen often shows several, each labelled for what it is for. */
const LABELLED_KINDS: ReadonlySet<string> = new Set(["email", "phone", "url"]);
/** Kinds whose values are someone's: whose they are is asked before one fills a field that wants someone's (B24 owner veto). */
const PERSONAL_KINDS: ReadonlySet<ValueKind> = new Set(["email", "phone", "address"]);
/**
 * C1: the kind of screen value an About entry stands beside, so a cut that took a window's value of that kind withholds
 * the entry too, as it does an email (pickCut). Kinds with no typed screen value (a school, a yes or no) have none.
 */
const ABOUT_VALUE_KIND: Partial<Record<AboutKind, ValueKind>> = { email: "email", phone: "phone", address: "address", street: "address", gradDate: "date", linkedin: "url", github: "url", website: "url" };
/** Labels of a message header's sender. */
const SENDER = /^(?:from|sender|reply-to)$/i;
/** Owner questions one ask carries at most. Assumed: well above the personal values a few source windows hold. */
const MAX_OWNERS = 40;

/** The person's name a candidate holds, when it is a person's: the display name of "Name <email>", the head of "Name, more", or the whole span. */
function personName(c: Candidate): string | null {
  const shown = DISPLAY_NAME.exec(c.text)?.[1]?.trim();
  if (shown !== undefined && isNameLike(shown, null)) return shown;
  if (c.context === null || !PERSON_LABEL.test(c.context)) return null;
  const head = c.text.split(/\s*(?:,|\(| - | – )\s*/u)[0]?.trim() ?? "";
  if (head !== c.text && isNameLike(head, null)) return head;
  return isNameLike(c.text, null) ? c.text : null;
}

export async function proposeFill(
  model: ScreenModel,
  askJev: AskJev,
  windowId: string,
  triggerKey: string,
  now = Date.now(),
  opts: FillOptions = {},
): Promise<FillProposal> {
  const cutoff = opts.cutoff ?? FILL_CUTOFF;
  const whose = opts.whose !== false;
  const memoryCutoff = opts.memoryCutoff ?? (whose ? MEMORY_CUTOFF : cutoff);
  const whoseCutoff = opts.whoseCutoff ?? WHOSE_CUTOFF;
  const derive = opts.derive !== false;
  const owners = opts.owner !== false && whose;
  const resolveCtx: ResolveContext = opts.resolve ?? { locale: Intl.DateTimeFormat().resolvedOptions().locale, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, referenceInstant: null };
  const w = model.windows.get(windowId);
  if (w === undefined) throw new FillError("noWindow", `unknown window ${windowId}`);
  const pageOwned = w.window.kind === PAGE_WINDOW_KIND;
  // Every piece of screen text the asks carry goes through one ledger, which holds each window to its
  // budget (privacy.ts): the form's title and each field's descriptor, nearest field first, then the
  // candidates. A field whose descriptor does not fit is left out of the question; the trigger must fit.
  const scope = opts.scope;
  const ledger = new SnippetLedger(model.windows.values(), scope?.consented === undefined ? {} : { consented: scope.consented });
  // An Ask's instruction is in every question; it may quote a window, which pays for what it quotes.
  if (scope !== undefined && !ledger.plan([scope.instruction])) throw new FillError("instructionTooLong", "the instruction quotes more of an open window than one question to Jev may carry");
  const title = ledger.take(w, "descriptor", [w.window.title]) ? w.window.title : null;
  type Field = {
    id: string;
    node: Node;
    descriptor: string;
    name: string;
    kinds: Set<ValueKind>;
    terms: Set<string>;
    texts: (string | null)[];
    about: AboutValue[];
    control: Control;
    form: FormControl | null;
    part: FillPart | null;
    labelWords: (string | null)[];
    personal: boolean;
  };
  const fields: Field[] = [];
  // The words of the windows fill reads, for formInputs to keep the inputs a long form's cap would cut by what they show.
  const sourceWords = (): ReadonlySet<string> =>
    new Set([...model.windows.values()].filter((x) => x.window.windowId !== windowId && opts.exclude?.has(x.window.windowId) !== true).flatMap((x) => [...x.nodes.values()].flatMap((n) => words(nodeText(n)))));
  const inputs = scope === undefined ? formInputs(w, triggerKey, MAX_FIELDS, opts.controls !== false, sourceWords) : scopedInputs(w, scope.fields);
  const formHasCity = inputs.some((x) => x.control === "text" && fieldPart(describeField(w, x.node).label, false) === "city");
  for (const x of inputs) {
    const n = x.node;
    // formFields keeps the trigger whatever it is; one Caret never types (an SSN, a card number) is left to the user.
    if (x.control === "text" && neverTypedNode(w, n) !== null) continue;
    const d = describeField(w, n);
    // A box whose own label is a consent or sign-up is never asked about (formControls); nor is one whose section or
    // nearest text is ("Yes" under "Marketing emails"), D2-04: a Fill all may tick a box, so its context counts too.
    if (x.control === "checkbox" && (boxNeverTicked(d.section ?? "") || boxNeverTicked(d.nearest ?? ""))) continue;
    const c = x.form;
    const label = c === null ? d.label : c.label;
    const texts = c === null ? [d.label, d.nearest, d.placeholder, d.section] : [c.label, label === null ? d.nearest : null, d.section, ...(c.options ?? [])];
    if (!ledger.take(w, "descriptor", texts)) {
      if (n.key === triggerKey && scope === undefined) throw new FillError("labelTooLong", `the descriptor of the focused field in window ${windowId} is longer than the window's share of a question`);
      continue;
    }
    const labelWords = c === null ? [d.label, d.nearest, d.placeholder] : [label, label === null ? d.nearest : null];
    const name = (c === null ? (d.label ?? d.nearest ?? d.placeholder) : (label ?? d.nearest)) ?? null;
    // A web page's dropdown (B27) takes a value the way a text field does, read by the same kinds and parts.
    const typed = x.control === "text" || x.control === "combobox";
    const kinds = x.control === "date" ? new Set<ValueKind>(["date"]) : x.control === "time" ? new Set<ValueKind>(["time"]) : typed ? fieldKinds(labelWords) : new Set<ValueKind>();
    const terms = fieldTerms(labelWords);
    for (const k of kinds) terms.add(kindTerm(k));
    // C1: a field or a menu that asks for a date's month or year takes that part of a date (derive.ts datePart).
    // A menu that asks for a date's month or year, a state or a country takes that part of a date, an address or a place:
    // its options are names, which a whole date or address is not (C1, MENU_PARTS).
    const part = !derive ? null : typed ? (datePart(name) ?? fieldPart(name, formHasCity) ?? (asksCountry(name) ? "country" : null)) : x.control === "select" ? menuPart(name) : null;
    // A country is no one's detail, so it asks no whose question. A dropdown that takes a person's details meets the owner
    // veto and the whose gate as a text field does (B27 review: "Your full name" took another person's name otherwise).
    // So does a list of options, read by its label alone: a "Your full name" pop-up menu listing two people was handed
    // the other one's name (B27 second review).
    const listed = x.control === "select" || x.control === "radio";
    const personKinds = typed ? kinds : listed ? fieldKinds(labelWords) : new Set<ValueKind>();
    const personal =
      (typed || listed) &&
      ((part !== null && part !== "country" && !DATE_PARTS.has(part)) || [...personKinds].some((k) => PERSONAL_KINDS.has(k)) || (terms.has(NAME_TERM) && /\bname\b/i.test(name ?? "")));
    // An Ask that names no memory, or names another person for a personal field, is not offered the user's own.
    const memoryOk = scope === undefined || (scope.memory && (scope.person === null || !personal));
    const about = memoryOk ? (opts.about ?? []).filter((a) => aboutFits(a, x.control) && fieldAsksFor(a, name)) : [];
    const descriptor = describeInput(w, x);
    fields.push({ id: `f${fields.length + 1}`, node: n, descriptor, name: name ?? "unnamed field", kinds, terms, texts, about, control: x.control, form: c, part, labelWords, personal });
  }
  // S1: a page form's empty field that takes a written answer is asked which saved answer answers it, and nothing else:
  // no window span is the user's prose (prose fields hand off in v1, plans/fast-browser.md). Each field offers the
  // answers whose questions share the most words with its label, at most MAX_ANSWERS_ASKED.
  const answerOk = pageOwned && (opts.answers?.length ?? 0) > 0 && (scope === undefined || scope.memory);
  const answersFor = new Map<string, SavedAnswer[]>();
  if (answerOk) {
    for (const f of fields) {
      if (f.control !== "text" || !isAnswerField(f.node)) continue;
      const label = new Set(words(f.name));
      const shared = (a: SavedAnswer): number => words(a.fields.question).filter((t) => label.has(t)).length;
      answersFor.set(f.id, [...(opts.answers ?? [])].sort((a, b) => shared(b) - shared(a)).slice(0, MAX_ANSWERS_ASKED));
    }
  }
  // An Ask that names its sources reads only those windows.
  const sourcesOnly = scope?.windows ?? null;
  const unread = sourcesOnly === null ? opts.exclude : new Set([...(opts.exclude ?? []), ...[...model.windows.keys()].filter((id) => id !== windowId && !sourcesOnly.has(id))]);
  const { candidates, cut, cutTerms, cutAll, namesCut, clauses } = collectCandidates(model, windowId, {
    now,
    ledger,
    deferClauses: true,
    ...(unread === undefined ? {} : { exclude: unread }),
    ...(opts.relevance === false ? {} : { fields: fields.map((f) => f.terms) }),
    ...(opts.kindsByCost === false ? { kindsByCost: false } : {}),
    ...(opts.nameGroup === false ? { nameGroup: false } : {}),
    ...(scope?.consented !== undefined && scope.consented.size > 0 && (scope.first?.length ?? 0) > 0 ? { first: { windows: scope.consented, names: scope.first ?? [] } } : {}),
  });
  // A value a window shows is offered as that window's candidate, which names where it is; the same text
  // from memory would only repeat it.
  for (const f of fields) f.about = f.about.filter((a) => !candidates.some((c) => c.text === a.value));

  // A window's budget can cut the value a field wants and keep another of the same kind: with the
  // calibration sources as Messages windows, the cap cut the meeting block and Jev filled Meeting date
  // with the order's Placed date (~/.caret-run/evidence/screen/b11/live/live-replay.md). So a field
  // whose kind lost a value to a cut is not asked, since its candidates of that kind are a partial set,
  // and an asked field's pick of such a kind is not proposed. A blank costs the user a paste; a wrong
  // fill costs their trust.
  const removed = opts.cutRule === false ? new Set<ValueKind>() : cutKinds(model, cut, candidates);
  const isCut = (kinds: ReadonlySet<ValueKind>): boolean => [...kinds].some((k) => removed.has(k));
  // The anchor (B24). The cut rules guard against a partial set: the right value cut by a window's budget, a
  // decoy kept. Any window that did not fit (an unrelated draft, a chat) withheld every name and every field
  // whose label names no kind, so on Q1's real forms nothing was offered although the user had just left a
  // short note of labelled values (Q1 bug 1; 44 of 131 fields on the B24 corpus, evidence/screen/b24/before).
  // When the window the user just left went into the question whole, a field is asked whatever was cut
  // elsewhere, unless a cut took a value of its own kind, and a pick from that window is judged on its own when
  // something ties it to a field: a "Label:" line, a typed kind the reader found, a name for a field that takes
  // one, or an option or box code matches (controls.ts). A pick of a kind a cut took is still withheld: a
  // labelled "Date:" in the window just left says nothing about a date a chat's budget cut (test/review-b13
  // F1, F3). An untyped plain line is not enough, since a cut can hold the line the field wanted (B13 F4). A
  // pick from any other window meets every cut rule.
  const justLeft = model.windowBefore(windowId);
  // A window the generator did not read (excluded, or outside an Ask's named sources) is no anchor: it would move a
  // value's description there and send its title and label (B25 review).
  const anchorWindow = opts.anchor !== false && opts.cutRule !== false && justLeft !== null && !cut.includes(justLeft) && unread?.has(justLeft) !== true ? (model.windows.get(justLeft) ?? null) : null;
  const anchorLines = anchorWindow === null ? [] : labelledLines(anchorWindow);
  const anchored = (f: Field): boolean => anchorWindow !== null && !isCut(f.kinds) && candidates.some((c) => c.source.windowId === anchorWindow.window.windowId);
  const fromAnchor = (f: Field, p: Pick): boolean => {
    const c = p.from === "window" ? p.c : p.from === "derived" && p.base.from === "window" ? p.base.c : null;
    if (anchorWindow === null || c === null || c.source.windowId !== anchorWindow.window.windowId) return false;
    if (p.from === "derived" && p.also !== null && p.also.source.windowId !== anchorWindow.window.windowId) return false;
    // A control's pick is tied by code matching its options or label; a dropdown shows none (B27), so it is tied like text.
    return c.labelled === true || candidateKinds(model, c).size > 0 || (f.control !== "text" && f.control !== "combobox") || (f.terms.has(NAME_TERM) && isNameLike(c.text, c.context));
  };
  // The generator offers each text once, from the first window it reads it in, and reads a conversation's
  // names before any other window's lines: a mail's "To: Jordan Reyes" took the text, and the question said
  // nothing of the note the user just left, where "Name: Jordan Reyes" names it (Jev then answered none,
  // B24 dev runs). A text the window just left labels is described there instead, when its label and title fit
  // that window's budget; the value is the same text, so no fill changes but the description.
  if (anchorWindow !== null) {
    for (const l of anchorLines) {
      const i = candidates.findIndex((c) => c.text === l.value && c.source.windowId !== anchorWindow.window.windowId);
      const c = candidates[i];
      if (c === undefined) continue;
      const moved = labelledCandidate(anchorWindow, l.node, l.value, l.label, c.id, c.kind, "justLeft");
      if (ledger.take(anchorWindow, "candidate", candidateTexts(moved))) candidates[i] = moved;
    }
  }
  // Values code derives for one field (derive.ts): a name's first, middle or last part for a field that asks
  // for it, a full name joined from labelled first and last names, and an address's parts. Each is offered only
  // in its field's question, beside the shared candidates, and keeps the candidate or memory entry it came from.
  type Derived = { key: string; text: string; describe: string; base: Extract<Pick, { from: "derived" }>["base"]; also: Candidate | null };
  const derived = new Map<string, Derived[]>();
  const memoryNames = scope !== undefined && !scope.memory ? [] : (opts.about ?? []).filter((a) => a.kind === "name");
  if (derive) {
    for (const f of fields) {
      if (f.part === null) continue;
      const list: Derived[] = [];
      const add = (text: string | null, describe: string, base: Derived["base"], also: Candidate | null = null): void => {
        if (text === null || text === "" || candidates.some((c) => c.text === text) || list.some((x) => x.text === text)) return;
        list.push({ key: `${f.id}:${list.length}`, text, describe, base, also });
      };
      const part = f.part;
      if (part === "first" || part === "middle" || part === "last" || part === "full") {
        for (const c of candidates) {
          const person = personName(c);
          if (person === null) continue;
          if (part === "full") add(person === c.text ? null : person, `"${person}" (the ${PART_SAYS.full} in ${describeCandidate(c)})`, { from: "window", c });
          else add(namePart(splitName(person), part), `"${namePart(splitName(person), part) ?? ""}" (the ${PART_SAYS[part]} in ${describeCandidate(c)})`, { from: "window", c });
        }
        if (part !== "full" && (scope?.person ?? null) === null) {
          for (const a of memoryNames) {
            if (!fieldAsksForNamePart(a, f.name)) continue;
            const v = namePart(splitName(a.value), part);
            add(v, `"${v ?? ""}" (the ${PART_SAYS[part]} in ${describeAbout(a)})`, { from: "memory", a });
          }
        } else {
          // A full name joined from labelled first and last names on two lines next to each other in one node and
          // section ("First name: Kenji" then "Last name: Watanabe"). Two blocks can be two people, even in one
          // text area (reviews: "Your details / First name: Jordan" and "Landlord / Last name: Singh"), so nothing
          // else is joined; and the joined value meets every check through both candidates (`also`).
          const byNode = new Map<string, Candidate[]>();
          for (const c of candidates) if (c.labelled === true) byNode.set(`${c.source.windowId}\u0000${c.source.nodeKey}\u0000${c.section ?? ""}`, [...(byNode.get(`${c.source.windowId}\u0000${c.source.nodeKey}\u0000${c.section ?? ""}`) ?? []), c]);
          for (const cs of byNode.values()) {
            const first = cs.filter((c) => fieldPart(c.context, false) === "first");
            const last = cs.filter((c) => fieldPart(c.context, false) === "last");
            if (first.length === 1 && last.length === 1 && adjacentLines(model, first[0] as Candidate, last[0] as Candidate)) {
              const [a, b] = [first[0] as Candidate, last[0] as Candidate];
              add(joinName(a.text, b.text), `"${joinName(a.text, b.text)}" (the first name ${describeCandidate(a)} and the last name ${describeCandidate(b)}, joined)`, { from: "window", c: a }, b);
            }
          }
        }
      } else if (ADDRESS_PARTS.has(part) || PLACE_PARTS.has(part)) {
        for (const c of candidates) {
          const parts = part === "country" ? null : splitAddress(c.text);
          const place = PLACE_PARTS.has(part) ? splitPlace(c.text) : null;
          const v = parts?.[part as "street" | "unit" | "city" | "state" | "zip"] ?? place?.[part as "city" | "state" | "country"] ?? undefined;
          if (v !== undefined && v !== null) add(v, `"${v}" (the ${PART_SAYS[part]} of ${describeCandidate(c)})`, { from: "window", c });
        }
      } else if (DATE_PARTS.has(part)) {
        for (const c of candidates) {
          if (!candidateKinds(model, c).has("date")) continue;
          const d = splitDate(c.text);
          const v = d === null ? null : part === "month" ? d.month : d.year;
          if (v !== null) add(v, `"${v}" (the ${PART_SAYS[part]} of ${describeCandidate(c)})`, { from: "window", c });
        }
      }
      if (list.length > 0) derived.set(f.id, list);
    }
  }
  // A field that shows its currency ("Monthly rent ($)") is offered each amount's number without its sign, a span
  // of the amount, so it traces to it (B25; misfit refuses the amount with its sign there).
  if (derive) {
    for (const f of fields) {
      if (f.control !== "text" || !CURRENCY_SHOWN.test(f.labelWords.filter((x) => x !== null).join(" "))) continue;
      const list = derived.get(f.id) ?? [];
      for (const c of candidates) {
        const m = /^[$€£¥]\s?(\d[\d,]*(?:\.\d{1,2})?)(?![\d,.])/u.exec(c.text);
        const n = m?.[1];
        if (n === undefined || candidates.some((x) => x.text === n) || list.some((x) => x.text === n)) continue;
        list.push({ key: `${f.id}:${list.length}`, text: n, describe: `"${n}" (the number of ${describeCandidate(c)})`, base: { from: "window", c }, also: null });
      }
      if (list.length > 0) derived.set(f.id, list);
    }
  }
  // A value the instruction spells out for a field (FillScope.literals) is offered in that field's question, as
  // what the user wrote; Jev still chooses it, and a date or time is read by the value resolver like any other.
  const literalOf = (f: { node: Node }): string | undefined => scope?.literals.get(f.node.key);
  for (const f of fields) {
    const lit = literalOf(f);
    if (lit === undefined || candidates.some((c) => c.text === lit)) continue;
    derived.set(f.id, [{ key: `${f.id}:said`, text: lit, describe: `"${lit}" (written in the user's instruction for this field)`, base: { from: "instruction", text: lit }, also: null }, ...(derived.get(f.id) ?? [])]);
  }
  if (candidates.length === 0 && cut.length === 0 && answersFor.size === 0 && fields.every((f) => f.about.length === 0 && (derived.get(f.id)?.length ?? 0) === 0)) throw new FillError("nothingToCopy", `no candidate values in any window other than ${windowId}`);

  // A field whose label names no kind (kinds.ts) could want a value of any kind or plain text. It is not
  // asked when a cut took a value of any kind: a "When" field was asked after a cut took the dates, and
  // filled with a note's untyped "Design review". Nor when a cut conversation left out a line sharing a
  // word with the field's label: a "Name" field was asked after a cut took a chat's only line, "Name: Dana
  // Whitfield", and filled with another window's name (B13 reviews). Withholding it on any cut instead
  // blanked Name on the fill desk, where an unrelated team chat is cut, and lost the desk's first-look
  // offer (~/.caret-run/evidence/screen/b13/live-final). A bare cut name ("Dana Whitfield") shares no
  // word with "Name", so names are handled as a kind (kinds.ts NAME_TERM): a conversation's name-like
  // lines go in whole or not at all, and namesCut says whether a name may have been kept out (candidates.ts).
  // Then a field that takes a name is not asked, and no field's name-like pick is proposed, as with a cut
  // kind (test/name-decoy.test.ts). Like a field of a kind, a field that takes a name is not withheld for
  // another kind's cut: withholding it then spent the chat's budget on names no field could be asked
  // about (the calibration chat's links gave way to its names and Attendee job title was still blanked).
  const nameCut = opts.cutRule !== false && opts.nameGroup !== false && namesCut;
  const takesName = (f: { terms: ReadonlySet<string> }): boolean => opts.nameGroup !== false && f.terms.has(NAME_TERM);
  const unknownCut = (f: { terms: ReadonlySet<string> }): boolean => (removed.size > 0 && !takesName(f)) || (nameCut && takesName(f)) || cutAll || overlap(f.terms, cutTerms) > 0;
  const fieldCut = (f: { kinds: ReadonlySet<ValueKind>; terms: ReadonlySet<string> }): boolean => (f.kinds.size === 0 && opts.unknownKindRule !== false ? unknownCut(f) : isCut(f.kinds));
  // A select whose options the app does not show cannot be matched to a value, so it is named and left (controls.ts).
  // A web dropdown's options are hidden too, but the page engine's handler picks the one option named exactly the
  // value and verifies it, so it is asked (B27).
  const askable = (f: Field): boolean => f.control !== "select" || f.form?.options !== null;
  // A field is asked when a window gave candidates, or when something the user told Caret fits it; with
  // every window candidate cut away and nothing from memory, there is nothing to ask about. Values from
  // memory go through the ledger too (privacy.ts memory), and when one cannot, none is offered.
  // A field the instruction gives a value for is asked whatever was cut: the cut rules guard window values, and its
  // window picks still meet them (pickCut).
  const uncut = fields.filter((f) => !answersFor.has(f.id) && askable(f) && (literalOf(f) !== undefined || !fieldCut(f) || anchored(f)));
  const aboutWanted = [...new Map(uncut.flatMap((f) => [...f.about, ...(derived.get(f.id) ?? []).flatMap((d) => (d.base.from === "memory" ? [d.base.a] : []))]).map((a) => [a.id, a])).values()];
  // Both the value and its label go into the question (describeAbout), so both are declared and priced. C1: each entry on
  // its own, so one that shares text with a window over its budget does not keep the rest out (a LinkedIn link whose
  // handle a note's file names repeat withheld every entry on F1's Greenhouse page).
  const aboutIn = new Set(aboutWanted.filter((a) => ledger.memory([a.value, a.label])).map((a) => a.id));
  const aboutSent = aboutWanted.filter((a) => aboutIn.has(a.id));
  if (aboutSent.length < aboutWanted.length) {
    for (const f of fields) f.about = f.about.filter((a) => aboutIn.has(a.id));
    for (const [id, list] of derived) derived.set(id, list.filter((d) => d.base.from !== "memory" || aboutIn.has(d.base.a.id)));
  }
  // C1: each candidate's clause (candidates.ts Candidate.line) only now, when every span and memory value is in, and
  // only where its window's budget still has room.
  for (const [c, clause] of clauses) {
    const sw = model.windows.get(c.source.windowId);
    // A candidate the anchor replaced (labelledCandidate above) is not sent, so neither is its clause.
    if (sw !== undefined && candidates.includes(c) && ledger.take(sw, "candidate", [clause])) c.line = clause;
  }
  // S1: a saved answer is the user's memory, not screen text, and is declared and charged as memory, as an About value
  // is (lead decision 4). The question it was saved for and its first ANSWER_CRITERION_CHARS characters are what a match
  // question carries; an answer a window on screen also shows is charged to that window, and one that would put a window
  // over its budget is not offered.
  const sendable = new Map<string, boolean>();
  for (const list of answersFor.values()) for (const a of list) if (!sendable.has(a.id)) sendable.set(a.id, ledger.memory([questionExcerpt(a.fields.question), answerExcerpt(a.fields.answer)]));
  for (const [id, list] of answersFor) {
    const kept = list.filter((a) => sendable.get(a.id) === true);
    if (kept.length === 0) answersFor.delete(id);
    else answersFor.set(id, kept);
  }
  const answerAsked = fields.filter((f) => answersFor.has(f.id));
  const asked = uncut.filter((f) => candidates.length > 0 || f.about.length > 0 || (derived.get(f.id)?.length ?? 0) > 0);
  // The asks carry only the asked fields' descriptors, so a withheld field's are not declared; its
  // window was still charged for them, which errs on the side of saying less.
  const sent = new Set([...asked, ...answerAsked].flatMap((f) => f.texts));
  const unsent = new Set(fields.filter((f) => !asked.includes(f) && !answerAsked.includes(f)).flatMap((f) => f.texts).filter((t) => t !== null && !sent.has(t) && t !== title));
  const declared: Declared = { ...ledger.declared(), snippets: ledger.snippets.filter((x) => !(x.kind === "descriptor" && x.windowId === windowId && unsent.has(x.text))), charged: ledger.charges() };

  // The second ask sees the same candidates in another order under other ids, so neither position
  // nor id can carry a choice from one ask to the other. Windows keep their recency order and only
  // the candidates inside each window are shuffled: with a full shuffle the second ask was wrong on
  // 30 of 180 judgments the first ask got right, mostly picking the other person's details or none
  // (wording2-cal-* in the evidence folder), so window order is context worth keeping, not noise.
  const order = shuffledWithinWindows(candidates, opts.rand);
  const second = order.map((c, i) => ({ ...c, id: `v${i + 1}` }));
  const back = new Map(second.map((c, i) => [c.id, order[i]?.id ?? ""]));
  // Values from memory are numbered m1... in the first ask and n1..., shuffled, in the second, the same way.
  const aboutIds = new Map(aboutSent.map((a, i) => [a.id, `m${i + 1}`]));
  const aboutOrder = shuffled(aboutSent, opts.rand);
  const aboutSecond = new Map(aboutOrder.map((a, i) => [a.id, `n${i + 1}`]));
  for (const [aid, nid] of aboutSecond) back.set(nid, aboutIds.get(aid) ?? "");
  // Saved answers are s1... in the first ask and t1..., shuffled, in the second (S1).
  const savedAll = [...new Map([...answersFor.values()].flat().map((a) => [a.id, a])).values()];
  const savedIds = new Map(savedAll.map((a, i) => [a.id, `s${i + 1}`]));
  const savedSecond = new Map(shuffled(savedAll, opts.rand).map((a, i) => [a.id, `t${i + 1}`]));
  const savedBy = new Map(savedAll.map((a) => [savedIds.get(a.id) as string, a]));
  const savedBack = new Map([...savedSecond].map(([aid, tid]) => [tid, savedIds.get(aid) as string]));
  const askAnswers = (ids: ReadonlyMap<string, string>): RequestMore["answers"] =>
    answerAsked.map((f) => ({
      id: f.id,
      descriptor: f.descriptor,
      criteria: Object.fromEntries((answersFor.get(f.id) ?? []).map((a) => [ids.get(a.id) as string, describeSaved(a)] as const).sort(([x], [y]) => x.localeCompare(y, "en", { numeric: true }))),
    }));
  // Derived values are d1... in the first ask and e1..., shuffled, in the second.
  const allDerived = asked.flatMap((f) => derived.get(f.id) ?? []);
  const derivedIds = new Map(allDerived.map((d, i) => [d.key, `d${i + 1}`]));
  const derivedSecond = new Map(shuffled(allDerived, opts.rand).map((d, i) => [d.key, `e${i + 1}`]));
  for (const [k, eid] of derivedSecond) back.set(eid, derivedIds.get(k) ?? "");
  const askAbout = (ids: ReadonlyMap<string, string>): Map<string, AskAbout[]> =>
    new Map(asked.map((f) => [f.id, f.about.map((a) => ({ id: ids.get(a.id) ?? "", about: a })).sort((x, y) => x.id.localeCompare(y.id, "en", { numeric: true }))]));
  const askDerived = (ids: ReadonlyMap<string, string>): Map<string, AskExtra[]> =>
    new Map(asked.map((f) => [f.id, (derived.get(f.id) ?? []).map((d) => ({ id: ids.get(d.key) ?? "", describe: d.describe })).sort((x, y) => x.id.localeCompare(y.id, "en", { numeric: true }))]));
  // Whose details a value is, asked for each candidate that is a person's (a typed email, phone or address,
  // or a name), when some asked field wants a person's details (the owner veto below).
  const personal = new Set(asked.filter((f) => f.personal).map((f) => f.id));
  const personalCand = (c: Candidate): boolean => [...candidateKinds(model, c)].some((k) => PERSONAL_KINDS.has(k)) || personName(c) !== null || isNameLike(c.text, c.context);
  const ownerCands = owners && personal.size > 0 ? candidates.filter(personalCand).slice(0, MAX_OWNERS) : [];
  const secondId = new Map(order.map((c, i) => [c.id, `v${i + 1}`]));
  const more = (dIds: ReadonlyMap<string, string>, first: boolean): RequestMore => ({
    ...(scope === undefined ? {} : { instruction: scope.instruction, person: scope.person }),
    derived: askDerived(dIds),
    personal: whose ? personal : new Set(),
    owners: ownerCands.map((c) => ({ id: first ? c.id : (secondId.get(c.id) ?? ""), describe: describeCandidate({ ...c, id: "" }) })),
    controls: new Map(asked.map((f) => [f.id, f.control])),
  });
  // Two stages when some field wants a person's details (B24). First, both asks say whose details each such
  // field wants and whose each person's value is. Then the value questions, where a field that wants the user's
  // details is not offered a value both asks say is someone else's, and the reverse. In one stage, live Jev
  // filled the user's First name and Email on a contact form from a colleague's mail that was open, though
  // the user's own name and email from memory were offered beside it (evidence/screen/b24/dev-7: 0 of 12 memory
  // values on the corpus's four memory forms).
  const staged = whose && personal.size > 0;
  const [w1, w2] =
    asked.length === 0 || !staged
      ? [null, null]
      : await Promise.all([
          askJev(buildFillRequest(w, asked, candidates, 0, declared, title, askAbout(aboutIds), whose, { ...more(derivedIds, true), stage: "whose" })),
          askJev(buildFillRequest(w, asked, second, 1, declared, title, askAbout(aboutSecond), whose, { ...more(derivedSecond, false), stage: "whose" })),
        ]);
  /** Both stage-one asks' answer to a whose or owner question, agreed at the whose cutoff, or null. */
  const stageOne = (q: string, q2: string = q): string | null => {
    const a1 = w1?.answers[q];
    const a2 = w2?.answers[q2];
    if (a1 === undefined || a2 === undefined || a1.choice !== a2.choice || !(a1.choice in WHOSE_CRITERIA)) return null;
    return Math.min(a1.confidence, a2.confidence) >= whoseCutoff ? a1.choice : null;
  };
  const namedPerson = scope?.person ?? null;
  /** Both asks' answer to whose a candidate is, agreed at the whose cutoff ("person" too when an Ask names one), or null. */
  const ownerAgreed = (c: Candidate): string | null => {
    const [x1, x2] = staged ? [w1, w2] : [r1, r2];
    const a1 = x1?.answers[ownerId(c.id)];
    const a2 = x2?.answers[ownerId(secondId.get(c.id) ?? "")];
    if (a1 === undefined || a2 === undefined || a1.choice !== a2.choice) return null;
    return Math.min(a1.confidence, a2.confidence) >= whoseCutoff ? a1.choice : null;
  };
  /** Whether both stage-one answers put the field and the candidate on different people (one the user's, the other someone else's). */
  const opposed = (f: Field, c: Candidate): boolean => {
    if (!owners || !f.personal) return false;
    // A person's value past the owner questions' cap was never asked about, so it is not offered to a field
    // that wants a person's details (review: the 41st email was proposed unchecked).
    if (!ownerCands.some((x) => x.id === c.id)) return personalCand(c);
    // An Ask that names a person offers its personal fields only that person's values, as both asks say (FillScope.person).
    if (namedPerson !== null) return personalCand(c) && ownerAgreed(c) !== "person";
    const wants = stageOne(whoseId(f.id));
    const is = stageOne(ownerId(c.id), ownerId(secondId.get(c.id) ?? ""));
    return wants !== null && is !== null && wants !== "unclear" && is !== "unclear" && wants !== is;
  };
  const exclude = (first: boolean): Map<string, Set<string>> =>
    new Map(asked.map((f) => [f.id, new Set(candidates.filter((c) => opposed(f, c)).map((c) => (first ? c.id : (secondId.get(c.id) ?? ""))))]));
  // Derived values of an excluded candidate go with it.
  if (staged) for (const f of asked) derived.set(f.id, (derived.get(f.id) ?? []).filter((d) => (d.base.from !== "window" || !opposed(f, d.base.c)) && (d.also === null || !opposed(f, d.also))));
  const valuesMore = (dIds: ReadonlyMap<string, string>, first: boolean): RequestMore => ({ ...more(dIds, first), stage: staged ? "values" : undefined, exclude: staged ? exclude(first) : new Map(), answers: askAnswers(first ? savedIds : savedSecond) });
  const [r1, r2] =
    asked.length === 0 && answerAsked.length === 0
      ? [null, null]
      : await Promise.all([
          askJev(buildFillRequest(w, asked, candidates, 0, declared, title, askAbout(aboutIds), whose, valuesMore(derivedIds, true))),
          askJev(buildFillRequest(w, asked, second, 1, declared, title, askAbout(aboutSecond), whose, valuesMore(derivedSecond, false))),
        ]);
  const byId = new Map<string, Pick>([
    ...candidates.map((c): [string, Pick] => [c.id, { from: "window", c }]),
    ...aboutSent.map((a): [string, Pick] => [aboutIds.get(a.id) ?? "", { from: "memory", a }]),
    ...allDerived.map((d): [string, Pick] => [derivedIds.get(d.key) ?? "", { from: "derived", text: d.text, base: d.base, also: d.also }]),
  ]);
  const pickText = (p: Pick): string => (p.from === "window" ? p.c.text : p.from === "memory" ? p.a.value : p.text);
  const readAsk = (r: JevResult, f: Field, mapId: (id: string) => string | undefined): FillAsk => {
    const a = r.answers[f.id];
    if (a === undefined) throw new FillError("badAnswer", `Jev returned no answer for ${f.id}`);
    if (a.choice === NONE) return { choice: NONE, confidence: a.confidence, value: null };
    const id = mapId(a.choice);
    const p = id === undefined ? undefined : byId.get(id);
    // A value from memory, or one code derived, is a choice only in the questions of the fields it was offered to.
    const offered = p === undefined ? false : p.from === "window" ? true : p.from === "memory" ? f.about.includes(p.a) : (derived.get(f.id) ?? []).some((d) => derivedIds.get(d.key) === id);
    if (p === undefined || !offered) throw new FillError("badAnswer", `Jev chose ${a.choice}, which is not a candidate id for ${f.id}`);
    return { choice: id as string, confidence: a.confidence, value: pickText(p) };
  };

  /** Whether a cut took a window's value of the kind an About entry stands beside (ABOUT_VALUE_KIND). */
  const aboutCut = (a: AboutValue): boolean => {
    const k = ABOUT_VALUE_KIND[a.kind];
    return k !== undefined && isCut(new Set([k]));
  };
  // Picks of a kind a cut took are withheld (see above); a value from memory is of its own kind; a derived
  // value meets its source's rules.
  const pickCut = (p: Pick): boolean =>
    p.from === "instruction"
      ? false
      : p.from === "derived"
      ? pickCut(p.base) || (p.also !== null && pickCut({ from: "window", c: p.also }))
      : p.from === "window"
        ? isCut(candidateKinds(model, p.c)) || (nameCut && isNameLike(p.c.text, p.c.context))
        : p.a.kind === "name"
          ? nameCut
          : aboutCut(p.a);
  /** A pick of a kind a cut took, whatever window it came from. */
  const kindCut = (p: Pick): boolean =>
    p.from === "instruction" ? false : p.from === "derived" ? kindCut(p.base) || (p.also !== null && kindCut({ from: "window", c: p.also })) : p.from === "window" ? isCut(candidateKinds(model, p.c)) : aboutCut(p.a);
  /**
   * What still withholds a pick from the window the user just left: a cut of its own kind, and the name cut for
   * a name (review: a cut chat's "Name: Dana Whitfield" beside the note's "Name: Alex Raman"; nothing says the
   * kept name is the one the form wants). The anchor lifts only the cut of fields whose label names no kind.
   */
  const nameish = (p: Pick): boolean =>
    p.from === "instruction" ? false : p.from === "window" ? isNameLike(p.c.text, p.c.context) : p.from === "memory" ? p.a.kind === "name" : nameish(p.base) || (p.also !== null && nameish({ from: "window", c: p.also }));
  const anchoredCut = (p: Pick): boolean => kindCut(p) || (nameCut && nameish(p));
  const memoryOf = (p: Pick): AboutValue | null => (p.from === "memory" ? p.a : p.from === "derived" && p.base.from === "memory" ? p.base.a : null);
  const windowOf = (p: Pick): Candidate | null => (p.from === "window" ? p.c : p.from === "derived" && p.base.from === "window" ? p.base.c : null);
  /** Both asks' answer to a question with fixed options when they give the same one, at any confidence, or null. */
  const sameChoice = (q: string, q2: string = q): string | null => {
    const [x1, x2] = staged ? [w1, w2] : [r1, r2];
    const a1 = x1?.answers[q];
    const a2 = x2?.answers[q2];
    return a1 !== undefined && a2 !== undefined && a1.choice === a2.choice && a1.choice in WHOSE_CRITERIA ? a1.choice : null;
  };
  /** Both asks' answer to a question with fixed options (whose, owner), agreed at the whose cutoff, or null. */
  const agreedChoice = (q: string, q2: string = q): string | null => {
    const [x1, x2] = staged ? [w1, w2] : [r1, r2];
    if (x1 === null || x2 === null) return null;
    const a1 = x1.answers[q];
    const a2 = x2.answers[q2];
    if (a1 === undefined || a2 === undefined || a1.choice !== a2.choice || !(a1.choice in WHOSE_CRITERIA)) return null;
    return Math.min(a1.confidence, a2.confidence) >= whoseCutoff ? a1.choice : null;
  };
  /**
   * Whether both asks said the field wants the user's own details, at the whose cutoff or above. A value
   * from memory that fails this is withheld as lowConfidence: Jev was not sure enough the details are the
   * user's, and the protocol's reasons stay the three a host already reads.
   */
  const theUsers = (f: { id: string }): boolean => {
    const [x1, x2] = staged ? [w1, w2] : [r1, r2];
    if (!whose || x1 === null || x2 === null) return true;
    const a1 = x1.answers[whoseId(f.id)];
    const a2 = x2.answers[whoseId(f.id)];
    if (a1 === undefined || a2 === undefined) throw new FillError("badAnswer", `Jev returned no answer about whose details ${f.id} asks for`);
    return a1.choice === "user" && a2.choice === "user" && Math.min(a1.confidence, a2.confidence) >= whoseCutoff;
  };
  /**
   * The owner veto (B24). With nothing from memory to offer, live Jev filled a demo request's Work email and
   * Phone with a colleague's signature details from an open mail, both asks agreeing at 0.86 to 0.98
   * (evidence/screen/b24/before). So for a field that wants a person's details, both asks also say whose
   * details the field wants (WHOSE_CRITERIA) and whose the value is (OWNER_CRITERIA). When both questions
   * agree, at the whose cutoff, and the two answers are the user and someone else, the value is withheld; for a
   * field that wants the user's, so is a value the asks do not both call the user's (see below).
   */
  const otherPerson = (f: Field, p: Pick): boolean => {
    // A value the instruction spells out is the user's own choice for the field.
    if (p.from === "instruction" || (p.from === "derived" && p.base.from === "instruction")) return false;
    // An Ask that names a person: a personal field takes only a window value both asks say is theirs.
    if (namedPerson !== null && owners && f.personal) {
      const base = windowOf(p);
      const second = p.from === "derived" ? p.also : null;
      return base === null || ownerAgreed(base) !== "person" || (second !== null && ownerAgreed(second) !== "person");
    }
    const also = p.from === "derived" ? p.also : null;
    if (also !== null && otherPerson(f, { from: "window", c: also })) return true;
    const c = windowOf(p);
    if (!owners || !f.personal || c === null) return false;
    if (!ownerCands.some((x) => x.id === c.id)) return personalCand(c);
    const wants = agreedChoice(whoseId(f.id));
    const is = agreedChoice(ownerId(c.id), ownerId(secondId.get(c.id) ?? ""));
    if (wants !== null && is !== null && wants !== "unclear" && is !== "unclear") return wants !== is;
    // A veto only withholds, so both asks calling the value someone else's is enough at any confidence when the field
    // wants the user's. B27's corpus run put a colleague's signature phone in a demo request's Phone number: in five
    // reruns all ten owner answers said "other", at 0.47 to 0.67, and the one under WHOSE_CUTOFF let it through
    // (evidence/screen/b27/b2b-probe, seed 24). The field's whose answers count at any confidence too: with both at
    // 0.49 "user", the settled `wants` was null and the colleague's phone went in (B27 second review).
    if (sameChoice(whoseId(f.id)) === "user" && sameChoice(ownerId(c.id), ownerId(secondId.get(c.id) ?? "")) === "other") return true;
    // Someone else's value goes only in a field both asks say wants someone else's: an RSVP's Phone, its whose
    // answer split at 0.48 and 0.60, took the sender's signature phone, which both asks called hers (dev-10).
    if (is === "other") return true;
    // Unsettled, for a field that wants the user's details, when the user's own value of that kind is in memory:
    // a window's value goes in only when both asks also say it is the user's, or when the window the user just
    // left labels it for the field ("Email: …" in their own note; a mail's "From:" names the sender, dev-9). Live,
    // a contact form's Email took a colleague's address from an open mail beside the user's own from memory, the
    // owner question split (dev-8). Without such a memory value, Jev cannot know who the user is, and requiring
    // the owner to be settled blanked B13's fill desk, an order confirmation's details on a checkout form (final
    // live replay, evidence/screen/b24/adv-live-replay-final): there the unsettled owner vetoes nothing.
    const labelsField = c.labelled === true && c.recency === "justLeft" && c.context !== null && overlap(fieldTerms([c.context]), f.terms) > 0;
    // C1: a phone the user told Caret counts as their own value of that kind, as an email does.
    const ck = candidateKinds(model, c);
    const kind = ck.has("email") ? "email" : ck.has("phone") ? "phone" : personName(c) !== null || isNameLike(c.text, c.context) ? "name" : null;
    if (wants === "user" && is !== "user" && kind !== null && memoryKinds.has(kind) && !labelsField) return true;
    // An Ask that names no source reads every window, as fill on focus does, but its questions quote the
    // instruction instead of where users copy from, and Jev picks more boldly: "fill in whatever you know about me"
    // took a colleague's signature phone for a demo request's Phone number at 0.87 and 0.92, the owner asks
    // calling it someone else's at 0.37 and 0.44 (evidence/screen/b25/asks-dev-1-jev, ask-20; tuned on the B24
    // corpus). So there a window value goes in a field that wants the user's details only when both asks say it is
    // the user's, or the window the user just left labels it for the field.
    if (scope !== undefined && scope.windows === null && wants === "user" && is !== "user" && !labelsField) return true;
    // A message header's sender is the one who wrote to the user: "From: Bea <bea@…>" is not the user's email
    // though the owner question split on it (an RSVP's Email, final scoreboard; a rule tuned on the B24 corpus).
    return wants === "user" && is !== "user" && c.labelled === true && c.context !== null && SENDER.test(c.context.trim());
  };
  /** Whether the named person has several values of the pick's kind and nothing on the pick's line names the field. */
  const personHasSeveral = (f: Field, p: Pick): boolean => {
    const c = windowOf(p);
    if (c === null) return false;
    const kinds = [...candidateKinds(model, c)].filter((k) => PERSONAL_KINDS.has(k));
    if (kinds.length === 0) return false;
    const theirs = ownerCands.filter((x) => ownerAgreed(x) === "person" && [...candidateKinds(model, x)].some((k) => kinds.includes(k)));
    if (theirs.length < 2) return false;
    const node = model.windows.get(c.source.windowId)?.nodes.get(c.source.nodeKey);
    const line = node === undefined ? "" : (nodeText(node).split(/\r?\n/).find((l) => l.includes(c.text)) ?? "");
    const said = new Set(fieldTerms([line, c.context]));
    const named = [...fieldTerms(f.labelWords)].filter((t) => !isKindTerm(t) && t !== NAME_TERM && !KIND_ONLY_WORDS.has(t));
    return !named.some((t) => said.has(t));
  };
  /**
   * Whether a window's value is one of several of its kind (an email, phone or link) on screen, labelled for a purpose
   * the field's label does not name, so which of them the field wants is a guess. W4's real-site replay offered
   * HubSpot's company "Website URL" the user's LinkedIn, GitHub and Portfolio links, the company's own not being a
   * candidate, and both asks took Portfolio at 0.82 to 0.86 in 3 of 6 runs (evidence/browser/w4 run1;
   * evidence/screen/b27/w4-replay-1 and -3). The same rule blanks Figma's "Other Website", whose answer key accepts
   * either Portfolio or GitHub.
   */
  const oneOfSeveral = (f: Field, p: Pick): boolean => {
    // A value the user's instruction spells out for this field is their choice among them (B27 review).
    if (p.from !== "window" || p.c.labelled !== true || p.c.context === null || literalOf(f) === p.c.text) return false;
    const kind = textKind(p.c.text);
    if (!LABELLED_KINDS.has(kind)) return false;
    const purpose = new Set([...purposeOf([p.c.context])].map(samePurpose));
    const named = new Set([...purposeOf(f.labelWords)].map(samePurpose));
    if (purpose.size === 0 || [...purpose].some((t) => named.has(t))) return false;
    return candidates.some((c) => c.text !== p.c.text && textKind(c.text) === kind);
  };
  /** Whether a pick is tied to a field by more than Jev's choice (the untied rule above). */
  const tiedPick = (f: Field, p: Pick): boolean => {
    if (p.from === "instruction" || p.from === "memory") return true;
    if (p.from === "derived") return p.base.from !== "window" || f.part !== null || tiedPick(f, p.base);
    const c = p.c;
    return c.labelled === true || candidateKinds(model, c).size > 0 || (f.terms.has(NAME_TERM) && isNameLike(c.text, c.context));
  };
  /** Kinds of the user's own values in memory ("email", "name"). */
  const memoryKinds = new Set<string>((opts.about ?? []).map((a) => a.kind));

  /**
   * The value a control takes from a pick (the option it names, PAGE_CHECKED, or the input's own date or time format),
   * whether a Fill all may write it there (D2-04), or why it cannot be read. Only a page window's controls are ever
   * written, each on a stricter rule than a hand-off, which the user sees and sets themselves:
   * - a select or radio group: an option whose name equals the span exactly (matchOption), not one the span merely
   *   names among other words (optionInText, the hand-off's rule);
   * - a box: the span states the fact the box asks (controls.ts statesFact) or lists the box's label among others
   *   (namedInList). A box the user speaks in gets no value (boxKind). Written only for a box that asks the user a fact,
   *   from the yes of a "Label: yes" line in the window the user just left, and never an ARIA switch;
   * - a date, time or date and time: read by the value resolver in that format (when.ts); a month or week is the user's.
   * A control whose label, nearest label or section reads as consent, certification or a sign-up gets no value at all.
   * A Yes/No question built from toggle buttons (W4) is never written: its press cannot be undone with the rest.
   */
  const controlValue = (f: Field, p: Pick): { value: string; display: string; writes: boolean } | { why: FillWithheld } => {
    const text = pickText(p);
    const page = pageOwned;
    // The control's label, else its nearest label, and its section (Field.texts for a control).
    const around = [f.form?.label ?? null, f.texts[1] ?? null, f.texts[2] ?? null].filter((t): t is string => t !== null);
    if (f.control !== "text" && around.some((t) => (f.control === "checkbox" ? boxNeverTicked(t) : consentLike(t)))) return { why: "ambiguous" };
    switch (f.control) {
      case "radio":
      case "select": {
        const options = f.form?.options ?? null;
        if (options === null) return { why: "ambiguous" };
        const press = f.node.subrole === PAGE_SUBROLE.pressGroup;
        // C1: a whole date, address or place picked for a menu that asks for one part of it names the option that part
        // is exactly (partOf).
        const whole = matchOption(options, text);
        const piece = whole === null && f.part !== null ? partOf(f.part, text) : null;
        const exact = whole ?? (piece === null ? null : matchOption(options, piece));
        if (exact !== null) return { value: exact, display: exact, writes: page && !press };
        const o = optionInText(options, text);
        return o === null ? { why: "ambiguous" } : { value: o, display: o, writes: false };
      }
      case "checkbox": {
        const label = f.form?.label ?? null;
        // A box the user speaks in ("I have read …", "I verify …") reads like a consent or certification: never a value.
        const kind = label === null ? "statement" : boxKind(label);
        if (label === null || kind === "statement") return { why: "ambiguous" };
        const c = windowOf(p);
        // The label of the "Label: value" line the span came from; a value from memory is never offered to a box.
        const context = p.from === "window" && c?.labelled === true ? c.context : null;
        const fromLine = context !== null && statesFact(label, text, context) && !/^(?:i|i'm|i've)\b/iu.test(text.trim());
        const stated = (p.from === "window" || p.from === "instruction") && statesFact(label, text, context);
        const listed = (p.from === "window" || p.from === "instruction") && namedInList(label, text, context);
        if (!stated && !listed) return { why: "ambiguous" };
        // Written only as the yes of a "Label: yes" line in the window the user just left, for a box that asks the user a
        // fact, and never an ARIA switch: the recheck before the run asks the source for that very line. Anything else
        // that states the tick is handed to the user (D2-04 second review).
        const own = c !== null && anchorWindow !== null && c.source.windowId === anchorWindow.window.windowId;
        return { value: PAGE_CHECKED, display: "Ticked", writes: page && own && fromLine && kind === "question" && f.node.subrole !== PAGE_SUBROLE.switch };
      }
      case "date": {
        const format = f.form?.format ?? "date";
        if (format === "datetime") {
          const dt = readDateTime(text, resolveCtx);
          return dt === null ? { why: "ambiguous" } : { ...dt, writes: page };
        }
        const d = readDate(text, resolveCtx);
        return d === null ? { why: "ambiguous" } : { ...d, writes: page && format === "date" };
      }
      case "time": {
        const t = page ? readClock(text, resolveCtx) : null;
        if (t !== null) return { ...t, writes: true };
        const loose = clockTime(text);
        return loose === null ? { why: "ambiguous" } : { ...loose, writes: false };
      }
      case "combobox":
        // Read as a text field is, then as one option's name: the page engine types it as the list's filter and picks
        // only an option named exactly that (B27).
        if (misfit(text, f.labelWords) !== null || (f.part !== null && !partFits(f.part, text))) return { why: "wrongKind" };
        return optionName(text) ? { value: text, display: text, writes: page } : { why: "ambiguous" };
      case "text":
        return misfit(text, f.labelWords) === null && (f.part === null || partFits(f.part, text)) ? { value: text, display: text, writes: true } : { why: "wrongKind" };
    }
  };
  const sourceOf = (p: Pick): FillSource | null => windowOf(p)?.source ?? null;
  const memoryRef = (p: Pick, f: Field): FillMemory | null => {
    const a = memoryOf(p);
    if (a === null) return null;
    const part = p.from === "derived" && (f.part === "first" || f.part === "middle" || f.part === "last") ? f.part : null;
    return { id: a.id, label: a.label, says: ABOUT_SAYS, ...(part === null ? {} : { part }) };
  };
  // A saved answer's pick (S1): both asks the same answer at the cutoff, then the code guards (fill/answers.ts).
  const page = answerAsked.length === 0 ? null : pageText(w, opts.page ?? { site: null, headings: [] });
  const readAnswer = (r: JevResult, f: Field, mapId: (id: string) => string | undefined): FillAsk => {
    const a = r.answers[answerQuestionId(f.id)];
    if (a === undefined) throw new FillError("badAnswer", `Jev returned no answer for ${answerQuestionId(f.id)}`);
    if (a.choice === NONE) return { choice: NONE, confidence: a.confidence, value: null };
    const id = mapId(a.choice);
    const saved = id === undefined ? undefined : savedBy.get(id);
    if (saved === undefined || !(answersFor.get(f.id) ?? []).includes(saved)) throw new FillError("badAnswer", `Jev chose ${a.choice}, which is not a saved answer offered for ${f.id}`);
    // The answer's text never rides in an ask: a disagreeing or unsure pick carries no `answer` for the server's gate to
    // find, and would otherwise reach a host that never said it shows answers whole (review finding 4).
    return { choice: id as string, confidence: a.confidence, value: null };
  };
  const answerField = (f: Field, empty: Omit<FillField, "withheld" | "asks">): FillField => {
    if (r1 === null || r2 === null) return { ...empty, withheld: null, asks: [] };
    const a1 = readAnswer(r1, f, (id) => id);
    const a2 = readAnswer(r2, f, (id) => savedBack.get(id));
    const agree = a1.choice === a2.choice;
    const confidence = agree ? Math.min(a1.confidence, a2.confidence) : 0;
    const asks: [FillAsk, FillAsk] = [a1, a2];
    if (a1.choice === NONE && a2.choice === NONE) return { ...empty, withheld: null, asks };
    if (!agree) return { ...empty, withheld: "disagree", asks };
    if (confidence < cutoff) return { ...empty, confidence, withheld: "lowConfidence", asks };
    const saved = savedBy.get(a1.choice) as SavedAnswer;
    const held = guardAnswer(saved, page as NonNullable<typeof page>, f.node.maxLength);
    // A host before S1 reads only FillWithheld's six reasons; the nearest stands in, and `answer.withheld` says the real one.
    if (held !== null) return { ...empty, confidence, withheld: held.why === "tooLong" ? "wrongKind" : "otherPerson", asks, answer: fillAnswer(saved, held) };
    return { ...empty, choice: a1.choice, confidence, value: saved.fields.answer, memory: { id: saved.id, label: saved.fields.question, says: ANSWER_SAYS }, withheld: null, asks, answer: fillAnswer(saved, null) };
  };
  const out: FillField[] = fields.map((f) => {
    const empty = { key: f.node.key, control: f.control, handoff: null, frame: f.node.frame ?? null, descriptor: f.descriptor, choice: NONE, confidence: 0, value: null, source: null, memory: null };
    if (answersFor.has(f.id)) return answerField(f, empty);
    if (r1 === null || r2 === null || !asked.includes(f)) {
      // Not asked: a cut took its kind (or every candidate); a select shows no options; or, with no cut,
      // nothing could be offered for it.
      const nothing = !askable(f) || (!fieldCut(f) && candidates.length === 0 && cut.length === 0);
      return { ...empty, withheld: nothing ? null : "sourceCut", asks: [] };
    }
    const a1 = readAsk(r1, f, (id) => id);
    const a2 = readAsk(r2, f, (id) => back.get(id));
    const agree = a1.choice === a2.choice;
    const confidence = agree ? Math.min(a1.confidence, a2.confidence) : 0;
    const picked = agree && a1.choice !== NONE ? byId.get(a1.choice) : undefined;
    const fromMemory = picked !== undefined && memoryOf(picked) !== null;
    // An anchored field's pick from the anchor window is judged on its own; any other pick meets the cut rules.
    const anchoredPick = picked !== undefined && anchored(f) && fromAnchor(f, picked);
    const cutOut = picked !== undefined && (anchoredPick ? anchoredCut(picked) : fieldCut(f) || pickCut(picked));
    const read = picked === undefined ? null : controlValue(f, picked);
    // An Ask's scoped fill reads only the sources it names, so the cuts that keep a field whose label names no kind
    // from guessing elsewhere seldom happen there. Such a field takes a window value only when something ties the
    // value to a field, as the anchor requires (fromAnchor): a "Label:" line, a typed kind, a name for a field that
    // takes one, or a part code derived for it. Untied, live Jev put a note's whole sentence in "Reason for moving"
    // (evidence/screen/b25/asks-dev-1-gpt-oss-120b, a rule tuned on the B24 corpus).
    const untied = scope !== undefined && picked !== undefined && (f.control === "text" || f.control === "combobox") && f.kinds.size === 0 && !tiedPick(f, picked);
    // A named person with more than one value of the field's kind on screen (a cell and an office phone): the screen
    // must say which is for this field, on the pick's own line. Live, "use Ines for the emergency contact" put her
    // signature's office phone in Emergency contact phone, where her mail says "my cell is …" beside "emergency
    // contact" (evidence/screen/b25/asks-dev-3-gpt-oss-20b, ask-10; a rule tuned on the B24 corpus).
    const whichOfTheirs = namedPerson !== null && picked !== undefined && f.personal && personHasSeveral(f, picked);
    const withheld: FillWithheld | null =
      a1.choice === NONE && a2.choice === NONE
        ? null
        : !agree
          ? "disagree"
          : picked !== undefined && cutOut
            ? "sourceCut"
            : confidence < (fromMemory ? memoryCutoff : cutoff) || (fromMemory && !theUsers(f))
              ? "lowConfidence"
              : read !== null && "why" in read
                ? read.why
                : untied || whichOfTheirs || (picked !== undefined && oneOfSeveral(f, picked))
                  ? "ambiguous"
                  : picked !== undefined && otherPerson(f, picked)
                  ? "otherPerson"
                  : null;
    const p = withheld === null ? picked : undefined;
    const got = p === undefined || read === null || "why" in read ? null : read;
    // A text field's value is `value`, which Caret writes. Any other control's is a hand-off, which a Fill all writes
    // when the page engine owns the window and controlValue allows it (D2-04: FillHandoff.writes); the user sets the rest.
    // A control's value read from a "Label: value" line names that label (FillHandoff.context), so a recheck can ask the
    // source for the same line, not just the same word: "yes" is in many lines (D2-04 review). A part code derived from
    // one such line ("United States" from "Location: Oakland, California, United States") names it too (P2: without it,
    // the recheck wanted a line equal to the part and refused W4's Greenhouse fills whole); one joined from two lines does not.
    const line = p === undefined ? null : windowOf(p);
    const context = line !== null && line.labelled === true && line.context !== null && (p?.from === "window" || (p?.from === "derived" && p.base.from === "window" && p.also === null)) ? line.context : null;
    const handoff: FillHandoff | null =
      f.control === "text" || p === undefined || got === null
        ? null
        : { value: got.value, display: got.display, source: sourceOf(p), memory: memoryRef(p, f), ...(context === null ? {} : { context }), ...(got.writes ? { writes: true as const } : {}) };
    const text = f.control === "text" && p !== undefined && got !== null;
    return {
      ...empty,
      handoff,
      choice: p === undefined ? NONE : a1.choice,
      confidence,
      value: text ? got.value : null,
      source: text ? sourceOf(p) : null,
      memory: text ? memoryRef(p, f) : null,
      withheld,
      asks: [a1, a2],
    };
  });

  return {
    type: "fillProposal",
    v: PROTOCOL_VERSION,
    id: opts.newId?.() ?? randomUUID(),
    at: now,
    pid: w.app.pid,
    windowId,
    bundleId: w.app.bundleId,
    triggerKey,
    fields: out,
    candidates: candidates.length,
    jev:
      r1 === null || r2 === null
        ? { model: NOT_ASKED, latencyMs: 0, inputTokens: 0, costUsd: 0 }
        : {
            model: r1.model,
            // The stages run one after the other.
            latencyMs: Math.max(r1.latencyMs, r2.latencyMs) + (w1 === null || w2 === null ? 0 : Math.max(w1.latencyMs, w2.latencyMs)),
            inputTokens: r1.inputTokens + r2.inputTokens + (w1?.inputTokens ?? 0) + (w2?.inputTokens ?? 0),
            costUsd: r1.costUsd + r2.costUsd + (w1?.costUsd ?? 0) + (w2?.costUsd ?? 0),
          },
    cutoff,
  };
}

/** What a memory entry gives a field now: the whole value, or the part of the name the proposal took (FillMemory.part). */
export function memoryValue(value: string, part: FillMemory["part"]): string | null {
  return part === undefined ? value : namePart(splitName(value), part);
}

/** Whether two candidates' "Label: value" lines are next to each other in their node, with no line between. */
function adjacentLines(model: ScreenModel, a: Candidate, b: Candidate): boolean {
  const node = model.windows.get(a.source.windowId)?.nodes.get(a.source.nodeKey);
  if (node === undefined || a.context === null || b.context === null) return false;
  const lines = nodeText(node).split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim());
  const at = (c: Candidate): number => lines.findIndex((l) => l.startsWith(`${c.context}:`) && l.includes(c.text));
  const i = at(a);
  const j = at(b);
  return i >= 0 && j >= 0 && Math.abs(i - j) === 1;
}

/** A step's memory reference (executor Step.memory): the entry's id, and "#part" for a part of a remembered name. */
export function memoryRefOf(m: { id: string; part?: FillMemory["part"] }): string {
  return m.part === undefined ? m.id : `${m.id}#${m.part}`;
}

/** The entry id and the part a step's memory reference names (memoryRefOf). */
export function parseMemoryRef(ref: string): { id: string; part: FillMemory["part"] } {
  const at = ref.lastIndexOf("#");
  const part = at < 0 ? "" : ref.slice(at + 1);
  return part === "first" || part === "middle" || part === "last" ? { id: ref.slice(0, at), part } : { id: ref, part: undefined };
}
