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
import { PROTOCOL_VERSION, type FillAsk, type FillField, type FillHandoff, type FillMemory, type FillProposal, type FillSource, type FillWithheld, type Node, type ValueKind } from "../protocol.ts";
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import { candidateKinds, candidateTexts, collectCandidates, cutKinds, describeCandidate, labelledCandidate, labelledLines, type Candidate } from "./candidates.ts";
import { CURRENCY_SHOWN, fieldKinds, fieldTerms, isKindTerm, isNameLike, kindTerm, misfit, NAME_TERM, overlap } from "./kinds.ts";
import { SnippetLedger, type Declared } from "../privacy.ts";
import { describeField, fieldLabelText } from "./descriptor.ts";
import { ABOUT_SAYS, fieldAsksFor, fieldAsksForNamePart, type AboutValue } from "./about.ts";
import type { AskJev, JevRequest, JevResult } from "./jev.ts";
import { consentLike, describeControl, formControls, inWebArea, optionInText, type Control, type FormControl } from "./controls.ts";
import { fieldPart, joinName, namePart, partFits, splitAddress, splitName, type FieldPart } from "./derive.ts";
import { clockTime, readDate } from "./when.ts";
import { labelKind, type SensitiveKind } from "../memory/sensitive.ts";
import type { ResolveContext } from "../values/resolve.ts";

export const NONE = "none";
/** The proposal's model name when a cut withheld every field and Jev was not asked. */
export const NOT_ASKED = "not asked";
export const FILLABLE_ROLES: ReadonlySet<string> = new Set(["AXTextField", "AXTextArea", "AXComboBox"]);
/** A form question beyond this many fields is cut to the fields nearest the trigger. Assumed. */
export const MAX_FIELDS = 20;
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
 */
export const MEMORY_CUTOFF = 0.3;
export const WHOSE_CUTOFF = 0.5;

export class FillError extends Error {}

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
  if (trigger === undefined) throw new FillError(`field ${triggerKey} is not in window ${w.window.windowId}`);
  if (trigger.editable !== true) throw new FillError(`field ${triggerKey} is not editable`);
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
 * The empty fields of the trigger's form, nearest the trigger first: text fields as formFields finds them,
 * then, unless `controls` is false, its empty selects, radio groups, unticked boxes and date and time fields
 * (controls.ts), so a form's every input is in one proposal (Q1 bug 10). The trigger is always included.
 */
export function formInputs(w: WindowState, triggerKey: string, max = MAX_FIELDS, controls = true): FormInput[] {
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
  return [...text, ...other.filter((o) => !text.some((t) => t.node.key === o.node.key))].sort((a, b) => dist(a.node) - dist(b.node)).slice(0, max);
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
  return `"${a.value}" (${a.kind === "email" ? "email" : "a name"}; the user's own ${a.label}, which the user told Caret)`;
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
  const ownerCriteria = more.person === null || more.person === undefined ? { ...OWNER_CRITERIA } : personOwnerCriteria(more.person);
  if (more.stage !== "values") for (const o of more.owners ?? []) questions[ownerId(o.id)] = { type: "choice", instructions: OWNER_WORDINGS[wording](o.describe), criteria: { ...ownerCriteria } };
  const anyAbout = fields.some((f) => (about.get(f.id)?.length ?? 0) > 0);
  const anyDerived = fields.some((f) => (more.derived?.get(f.id)?.length ?? 0) > 0);
  const req: JevRequest = {
    state: {
      ...(more.instruction === undefined ? {} : { instruction: more.instruction }),
      destination_window: where,
      form_fields: fields.map((f) => f.name).join("; "),
      task:
        "The user is filling in this form. The candidates are values visible in the user's other open windows. " +
        "Users most often copy from the window they were in just before the form." +
        (anyAbout ? " A few candidates are the user's own details, which the user told Caret; one fits a field only when the form asks for the user's own details there." : "") +
        (anyDerived ? " Some candidates are a part of another, which Caret split out: a first or last name, or a street, city, state or ZIP code of an address." : "") +
        (more.instruction === undefined ? "" : " The user asked Caret for this in the instruction above: a field gets a value only when the instruction asks for it, from where the instruction says.") +
        (more.person === null || more.person === undefined ? "" : ` The instruction asks for ${more.person}'s details.`),
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
const PART_SAYS: Record<FieldPart, string> = {
  first: "first name",
  middle: "middle name",
  last: "last name",
  full: "name",
  street: "street line",
  unit: "apartment or unit",
  city: "city",
  state: "state",
  zip: "ZIP code",
};
const ADDRESS_PARTS: ReadonlySet<FieldPart> = new Set(["street", "unit", "city", "state", "zip"]);
/** Label words that say only a field's kind, so they cannot tie one of a person's phones or emails to the field. */
const KIND_ONLY_WORDS: ReadonlySet<string> = new Set(["phone", "telephone", "tel", "mobile", "cell", "number", "email", "mail", "address", "contact"]);
/** Kinds whose values are someone's: whose they are is asked before one fills a field that wants someone's (B24 owner veto). */
const PERSONAL_KINDS: ReadonlySet<ValueKind> = new Set(["email", "phone", "address"]);
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
  if (w === undefined) throw new FillError(`unknown window ${windowId}`);
  // Every piece of screen text the asks carry goes through one ledger, which holds each window to its
  // budget (privacy.ts): the form's title and each field's descriptor, nearest field first, then the
  // candidates. A field whose descriptor does not fit is left out of the question; the trigger must fit.
  const scope = opts.scope;
  const ledger = new SnippetLedger(model.windows.values(), scope?.consented === undefined ? {} : { consented: scope.consented });
  // An Ask's instruction is in every question; it may quote a window, which pays for what it quotes.
  if (scope !== undefined && !ledger.plan([scope.instruction])) throw new FillError("the instruction quotes more of an open window than one question to Jev may carry");
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
    part: FieldPart | null;
    labelWords: (string | null)[];
    personal: boolean;
  };
  const fields: Field[] = [];
  const inputs = scope === undefined ? formInputs(w, triggerKey, MAX_FIELDS, opts.controls !== false) : scopedInputs(w, scope.fields);
  const formHasCity = inputs.some((x) => x.control === "text" && fieldPart(describeField(w, x.node).label, false) === "city");
  for (const x of inputs) {
    const n = x.node;
    // formFields keeps the trigger whatever it is; one Caret never types (an SSN, a card number) is left to the user.
    if (x.control === "text" && neverTypedNode(w, n) !== null) continue;
    const d = describeField(w, n);
    const c = x.form;
    const label = c === null ? d.label : c.label;
    const texts = c === null ? [d.label, d.nearest, d.placeholder, d.section] : [c.label, label === null ? d.nearest : null, d.section, ...(c.options ?? [])];
    if (!ledger.take(w, "descriptor", texts)) {
      if (n.key === triggerKey && scope === undefined) throw new FillError(`the descriptor of the focused field in window ${windowId} is longer than the window's share of a question`);
      continue;
    }
    const labelWords = c === null ? [d.label, d.nearest, d.placeholder] : [label, label === null ? d.nearest : null];
    const name = (c === null ? (d.label ?? d.nearest ?? d.placeholder) : (label ?? d.nearest)) ?? null;
    const kinds = x.control === "date" ? new Set<ValueKind>(["date"]) : x.control === "time" ? new Set<ValueKind>(["time"]) : x.control === "text" ? fieldKinds(labelWords) : new Set<ValueKind>();
    const terms = fieldTerms(labelWords);
    for (const k of kinds) terms.add(kindTerm(k));
    const part = x.control === "text" && derive ? fieldPart(name, formHasCity) : null;
    const personal = x.control === "text" && (part !== null || [...kinds].some((k) => PERSONAL_KINDS.has(k)) || (terms.has(NAME_TERM) && /\bname\b/i.test(name ?? "")));
    // An Ask that names no memory, or names another person for a personal field, is not offered the user's own.
    const memoryOk = scope === undefined || (scope.memory && (scope.person === null || !personal));
    const about = x.control === "text" && memoryOk ? (opts.about ?? []).filter((a) => fieldAsksFor(a, name)) : [];
    const descriptor = describeInput(w, x);
    fields.push({ id: `f${fields.length + 1}`, node: n, descriptor, name: name ?? "unnamed field", kinds, terms, texts, about, control: x.control, form: c, part, labelWords, personal });
  }
  // An Ask that names its sources reads only those windows.
  const sourcesOnly = scope?.windows ?? null;
  const unread = sourcesOnly === null ? opts.exclude : new Set([...(opts.exclude ?? []), ...[...model.windows.keys()].filter((id) => id !== windowId && !sourcesOnly.has(id))]);
  const { candidates, cut, cutTerms, cutAll, namesCut } = collectCandidates(model, windowId, {
    now,
    ledger,
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
    return c.labelled === true || candidateKinds(model, c).size > 0 || f.control !== "text" || (f.terms.has(NAME_TERM) && isNameLike(c.text, c.context));
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
      } else if (ADDRESS_PARTS.has(part)) {
        for (const c of candidates) {
          const parts = splitAddress(c.text);
          const v = parts?.[part as "street" | "unit" | "city" | "state" | "zip"];
          if (v !== undefined) add(v, `"${v}" (the ${PART_SAYS[part]} of ${describeCandidate(c)})`, { from: "window", c });
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
  if (candidates.length === 0 && cut.length === 0 && fields.every((f) => f.about.length === 0 && (derived.get(f.id)?.length ?? 0) === 0)) throw new FillError(`no candidate values in any window other than ${windowId}`);

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
  const askable = (f: Field): boolean => f.control !== "combobox" && (f.control !== "select" || f.form?.options !== null);
  // A field is asked when a window gave candidates, or when something the user told Caret fits it; with
  // every window candidate cut away and nothing from memory, there is nothing to ask about. Values from
  // memory go through the ledger too (privacy.ts memory), and when one cannot, none is offered.
  // A field the instruction gives a value for is asked whatever was cut: the cut rules guard window values, and its
  // window picks still meet them (pickCut).
  const uncut = fields.filter((f) => askable(f) && (literalOf(f) !== undefined || !fieldCut(f) || anchored(f)));
  const aboutSent = [...new Map(uncut.flatMap((f) => [...f.about, ...(derived.get(f.id) ?? []).flatMap((d) => (d.base.from === "memory" ? [d.base.a] : []))]).map((a) => [a.id, a])).values()];
  // Both the value and its label go into the question (describeAbout), so both are declared and priced.
  if (aboutSent.length > 0 && !ledger.memory(aboutSent.flatMap((a) => [a.value, a.label]))) {
    for (const f of fields) f.about = [];
    for (const [id, list] of derived) derived.set(id, list.filter((d) => d.base.from !== "memory"));
  }
  const asked = uncut.filter((f) => candidates.length > 0 || f.about.length > 0 || (derived.get(f.id)?.length ?? 0) > 0);
  // The asks carry only the asked fields' descriptors, so a withheld field's are not declared; its
  // window was still charged for them, which errs on the side of saying less.
  const sent = new Set(asked.flatMap((f) => f.texts));
  const unsent = new Set(fields.filter((f) => !asked.includes(f)).flatMap((f) => f.texts).filter((t) => t !== null && !sent.has(t) && t !== title));
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
  const valuesMore = (dIds: ReadonlyMap<string, string>, first: boolean): RequestMore => ({ ...more(dIds, first), stage: staged ? "values" : undefined, exclude: staged ? exclude(first) : new Map() });
  const [r1, r2] =
    asked.length === 0
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
    if (a === undefined) throw new FillError(`Jev returned no answer for ${f.id}`);
    if (a.choice === NONE) return { choice: NONE, confidence: a.confidence, value: null };
    const id = mapId(a.choice);
    const p = id === undefined ? undefined : byId.get(id);
    // A value from memory, or one code derived, is a choice only in the questions of the fields it was offered to.
    const offered = p === undefined ? false : p.from === "window" ? true : p.from === "memory" ? f.about.includes(p.a) : (derived.get(f.id) ?? []).some((d) => derivedIds.get(d.key) === id);
    if (p === undefined || !offered) throw new FillError(`Jev chose ${a.choice}, which is not a candidate id for ${f.id}`);
    return { choice: id as string, confidence: a.confidence, value: pickText(p) };
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
        : p.a.kind === "email"
          ? isCut(new Set(["email"]))
          : nameCut;
  /** A pick of a kind a cut took, whatever window it came from. */
  const kindCut = (p: Pick): boolean =>
    p.from === "instruction" ? false : p.from === "derived" ? kindCut(p.base) || (p.also !== null && kindCut({ from: "window", c: p.also })) : p.from === "window" ? isCut(candidateKinds(model, p.c)) : p.a.kind === "email" && isCut(new Set(["email"]));
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
    if (a1 === undefined || a2 === undefined) throw new FillError(`Jev returned no answer about whose details ${f.id} asks for`);
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
    const kind = candidateKinds(model, c).has("email") ? "email" : personName(c) !== null || isNameLike(c.text, c.context) ? "name" : null;
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
  /** Whether a pick is tied to a field by more than Jev's choice (the untied rule above). */
  const tiedPick = (f: Field, p: Pick): boolean => {
    if (p.from === "instruction" || p.from === "memory") return true;
    if (p.from === "derived") return p.base.from !== "window" || f.part !== null || tiedPick(f, p.base);
    const c = p.c;
    return c.labelled === true || candidateKinds(model, c).size > 0 || (f.terms.has(NAME_TERM) && isNameLike(c.text, c.context));
  };
  /** Kinds of the user's own values in memory ("email", "name"). */
  const memoryKinds = new Set<string>((opts.about ?? []).map((a) => a.kind));

  /** The value a control takes from a pick: the option it names, "checked", or an ISO date or time; or why it cannot be read. */
  const controlValue = (f: Field, p: Pick): { value: string; display: string } | { why: FillWithheld } => {
    const text = pickText(p);
    switch (f.control) {
      case "radio":
      case "select": {
        const o = f.form?.options === null || f.form?.options === undefined ? null : optionInText(f.form.options, text);
        return o === null ? { why: "ambiguous" } : { value: o, display: o };
      }
      case "checkbox":
        // A consent, certification or sign-up box is never ticked (controls.ts consentLike); formControls already leaves it out.
        if (f.form?.label === null || f.form?.label === undefined || consentLike(f.form.label)) return { why: "ambiguous" };
        return optionInText([f.form.label], text) !== null ? { value: "checked", display: "Ticked" } : { why: "ambiguous" };
      case "date": {
        const d = readDate(text, resolveCtx);
        return d === null ? { why: "ambiguous" } : d;
      }
      case "time": {
        const t = clockTime(text);
        return t === null ? { why: "ambiguous" } : t;
      }
      case "combobox":
        return { why: "ambiguous" };
      case "text":
        return misfit(text, f.labelWords) === null && (f.part === null || partFits(f.part, text)) ? { value: text, display: text } : { why: "wrongKind" };
    }
  };
  const sourceOf = (p: Pick): FillSource | null => windowOf(p)?.source ?? null;
  const memoryRef = (p: Pick, f: Field): FillMemory | null => {
    const a = memoryOf(p);
    if (a === null) return null;
    const part = p.from === "derived" && (f.part === "first" || f.part === "middle" || f.part === "last") ? f.part : null;
    return { id: a.id, label: a.label, says: ABOUT_SAYS, ...(part === null ? {} : { part }) };
  };
  const out: FillField[] = fields.map((f) => {
    const empty = { key: f.node.key, control: f.control, handoff: null, frame: f.node.frame ?? null, descriptor: f.descriptor, choice: NONE, confidence: 0, value: null, source: null, memory: null };
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
    const untied = scope !== undefined && picked !== undefined && f.control === "text" && f.kinds.size === 0 && !tiedPick(f, picked);
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
                : untied || whichOfTheirs
                  ? "ambiguous"
                  : picked !== undefined && otherPerson(f, picked)
                  ? "otherPerson"
                  : null;
    const p = withheld === null ? picked : undefined;
    const got = p === undefined || read === null || "why" in read ? null : read;
    const handoff: FillHandoff | null = f.control === "text" || p === undefined || got === null ? null : { value: got.value, display: got.display, source: sourceOf(p), memory: memoryRef(p, f) };
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
