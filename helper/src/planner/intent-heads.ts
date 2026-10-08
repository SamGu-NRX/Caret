import { instructionForModel } from "../fill/redact.ts";
import { assertNoSecrets } from "../privacy.ts";
// Ask's intent from Jev (P1, A3). Three requests, sent together:
//   - the heads, one request: route (fill, plan or refuse), why when it refuses, source and whose;
//   - the scope ask, in two wordings: one categorical question per field, showing the field's label, its heading, its
//     group, the kind of control it is and its neighbours' labels, with the options asks, not and unclear.
// Jev decides which fields an Ask means; code only vetoes. A field is in scope only when both wordings answer "asks" at
// SCOPE_CUTOFF or above. Any "unclear" in either wording asks the user which fields, offering the unclear and
// below-cutoff fields beside the ones Jev chose (choices.ts offers exactly these), when one question lists them all;
// otherwise the chosen fields are filled and the rest left to the user, each said (I3 lead ruling). No code path here adds a field Jev did not choose. The vetoes, each at
// its own site: a kind Caret never types (checkIntent: such fields are left to the user); one person per Ask (people.ts
// readWhose asks when the instruction names two); a literal value must be an exact span of the instruction and is only
// tied to a field Jev chose or offered (tieLiterals, checkIntent); a named source only narrows the windows read (the
// sources part below, checkIntent).
//
// A2 found that hand-written rules for reading a request (A1's scope-reading.ts, removed here) did not converge: twelve
// review rounds each found a new phrasing that widened the scope. A widening phrasing is answered by the vetoes or by
// "unclear", never by a new reading rule.
import { ownWording, sendable } from "../privacy.ts";
import { secretText } from "../memory/sensitive.ts";
import { readWhose } from "./people.ts";
import type { AskJev, JevRequest, JevResult } from "../fill/jev.ts";
import type { Control } from "../fill/controls.ts";
import type { IntentMaker, MakerUse } from "./intent-makers.ts";
import { ROUTE_CUTOFF } from "./intent-makers.ts";
import type { AskIntent, IntentField, IntentSnapshot } from "./intent.ts";
import { relevance } from "./planner.ts";
import { dateShaped, timeShaped } from "../fill/kinds.ts";
import { fieldWords, restrictsSources } from "./sources.ts";
import { PlannerError } from "./validate.ts";
import { jevFailedError, type AskPart } from "./says.ts";
import { MAX_ASK_OPTIONS } from "../protocol.ts";
import { sectionMembership, windowOutline } from "../fill/ask-scope.ts";

/** Lowest confidence for the route, why, source and whose heads: plan section 3's provisional router floor, not calibrated. */
export const HEAD_FLOOR = ROUTE_CUTOFF;
/**
 * Lowest confidence, the lower of the two wordings, at which an "asks" answer puts a field in scope. Calibrated on B24's
 * 20 asks and A3's 26 development asks, 589 fields labelled by hand (scripts/ask-scope-labels.json, scored by
 * scripts/ask-scope-eval.ts on jev-latest, evidence/screen/a3/cal-1). Extra fields in fills, against missed ones:
 *   0.4: 4 extra, 25 missed; 0.5: 3 extra, 30 missed; 0.7: 3, 35; 0.75: 2, 39; 0.9: 2, 44 (8 more asks asked back).
 * 0.5 is the lowest cutoff with 3 extra; the next extra field it removes costs 9 missed fields and 2 fills. The three
 * left are Jev answering "asks" at 0.72 to 1.00 in both wordings ("put my name, email and phone in" for Guest's full
 * name), which no cutoff short of 0.99 removes; ownership and the write contract still decide their values (AC1).
 * The old 0.95 floor missed 34 fields in fills and asked 17 of 46 back. B24 alone had no extra field at any cutoff.
 */
export const SCOPE_CUTOFF = 0.5;

// "all" and "some" both fill; which fields is the scope ask's. "all" also says the request narrows nothing, so fill may
// ask values as Fill all does (FillScope.wholeForm) when every empty field is in scope.
const ROUTE: Record<string, string> = {
  all: "Fill every empty field of the form Caret can: the whole form, or everything Caret knows, with nothing said about particular values.",
  some: "Fill some fields of this form: a part of it, particular fields, or particular values (Caret asks which fields separately).",
  plan: "More than filling fields with values that already exist: press a button, submit, send, add an event to the calendar, write a message, reply or description in new words, or a task of several steps.",
  refuse: "Something Caret must not or cannot do here: pay, give a card number, a password, a one-time code or a Social Security number, or fill a field this form does not have.",
};
const WHY: Record<string, string> = {
  neverTyped: "It asks for a card number, a password, a one-time code, or a Social Security or other government ID number.",
  payment: "It asks to pay.",
  pressOrSend: "It asks to submit, send or press something, and nothing else.",
  noSuchField: "It asks for a field this form does not have.",
  nothingToFill: "Something else Caret should not do.",
};

// G2 round 4: the route's refuse option names kinds of secret ("a card number, a password…") to say what Caret refuses.
ownWording(...Object.values(ROUTE), ...Object.values(WHY));

const TASK = "Caret reads the user's instruction about the form on screen: what to do, from where, and for whom. Answer from the instruction; Caret finds the values itself.";

/** The heads request: the form, sources and people as state, the heads as Choice questions. */
export function headsRequest(snap: IntentSnapshot): JevRequest {
  const declared = snap.ledger.declared();
  const sectionRef = new Map(snap.sections.map((s) => [s.name, s.ref]));
  const state = {
    instruction: instructionForModel(snap.instruction),
    form: {
      title: formTitle(snap),
      sections: snap.sections.map((s) => ({ id: s.ref, name: sendable(s.name, SECTION) })),
      fields: snap.fields.map((f) => ({ id: f.ref, name: sendable(f.modelName ?? f.name, FIELD), control: f.neverTyped === null ? f.control : "never typed by Caret", filled: f.filled, section: f.section === null ? null : (sectionRef.get(f.section) ?? null) })),
    },
    sources: snap.windows.map((w) => ({ id: w.ref, title: `${w.app}: ${sendable(w.title, "a window")}${w.from === null ? "" : ` (from ${w.from})`}` })),
    people: snap.persons.map((p) => ({ id: p.ref, span: p.span })),
    task: TASK,
  };
  const source: Record<string, string> = { any: "The instruction does not say where the values come from.", ...(snap.memory.length > 0 ? { memory: "What the user told Caret about themselves (their own name and email)." } : {}), instruction: "Only values the instruction itself spells out." };
  for (const w of snap.windows) source[w.ref] = `The ${w.app} window '${sendable(w.title, "a window")}'${w.from === null ? "" : `, from ${w.from}`}.`;
  const whose: Record<string, string> = { user: "The user's own details, or each field's own: the instruction names no one else whose details go in." };
  for (const p of snap.persons) whose[p.ref] = `The details of ${p.span}, whom the instruction names.`;
  whose.unclear = "Someone else's details, but the instruction does not say whose.";
  const questions: JevRequest["questions"] = {
    route: { type: "choice", instructions: "What does the instruction ask Caret to do with the form on screen?", criteria: ROUTE },
    why: { type: "choice", instructions: "If Caret should refuse the instruction, why?", criteria: WHY },
    source: { type: "choice", instructions: "Where does the instruction say the values come from?", criteria: source },
    whose: { type: "choice", instructions: "Whose details does the instruction ask Caret to put in the form?", criteria: whose },
  };
  return assertNoSecrets({ purpose: "ask.heads", state, questions, snippets: declared.snippets, charged: declared.charged });
}

// G2 round 4: a screen text that holds a secret marker word is sent as what it is, never as its words (privacy.ts
// sendable); assertNoSecrets stops any request that still carries one.
const FIELD = "a field Caret leaves to the user";
const SECTION = "a section";
const formTitle = (snap: IntentSnapshot): string => (snap.title === null || secretText(snap.title) ? `${snap.window.app.name} window` : `${snap.window.app.name} window '${snap.title}'`);

/** The scope ask's options. Every field gets all three; "unclear" always makes Caret ask. */
export const SCOPE_OPTIONS = {
  asks: "Yes: the request asks Caret to fill in or change this field, whether it names the field, the part of the form the field is in, or the whole form.",
  not: "No: the request does not ask for this field.",
  unclear: "Unclear: the request could mean this field or not, so Caret should ask the user.",
} as const;

const CONTROL_WORDS: Record<Control, string> = { text: "text field", date: "date field", time: "time field", select: "pop-up menu", radio: "set of radio buttons", checkbox: "checkbox", combobox: "combo box" };

/** What the scope ask shows of a field besides its label: its heading, its group, its kind and its neighbours. */
export interface FieldContext {
  label: string;
  heading: string | null;
  /** The group or fieldset label, when it is neither the label nor the heading. */
  group: string | null;
  role: string;
  before: string | null;
  after: string | null;
}

/** The fields and the upload fields the scope question asks about, in document order (I2 ruling B). */
export function scopeFields(snap: IntentSnapshot): IntentField[] {
  if (snap.uploads.length === 0) return snap.fields;
  const order = new Map([...snap.window.nodes.keys()].map((k, i) => [k, i]));
  return [...snap.fields, ...snap.uploads].sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
}

export function fieldContext(snap: IntentSnapshot, f: IntentField): FieldContext {
  const all = scopeFields(snap);
  const i = all.indexOf(f);
  const same = (a: string | null, b: string | null): boolean => a !== null && b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
  const group = f.section === null || same(f.section, f.name) || same(f.section, f.heading) ? null : f.section;
  const named = (x: string | null | undefined, instead: string): string | null => (x === null || x === undefined ? null : sendable(x, instead));
  return { label: sendable(f.modelName ?? f.name, FIELD), heading: named(f.heading, SECTION), group: named(group, SECTION), role: f.upload === true ? "file upload" : CONTROL_WORDS[f.control], before: named(all[i - 1]?.modelName ?? all[i - 1]?.name, FIELD), after: named(all[i + 1]?.modelName ?? all[i + 1]?.name, FIELD) };
}

/** The scope ask's two wordings. The first quotes the request first; the second describes the field first. */
const SCOPE_WORDINGS = [
  (instr: string, c: FieldContext): string => {
    const where = [c.heading === null ? null : `under the heading '${c.heading}'`, c.group === null ? null : `in the group '${c.group}'`].filter((x) => x !== null).join(", ");
    const beside = [c.before === null ? null : `after '${c.before}'`, c.after === null ? null : `before '${c.after}'`].filter((x) => x !== null).join(" and ");
    return `The user asked Caret: "${instr}". On the form, the field '${c.label}' is a ${c.role}${where === "" ? "" : `, ${where}`}${beside === "" ? "" : `, ${beside}`}. Does the request ask Caret to fill in or change this field?`;
  },
  (instr: string, c: FieldContext): string =>
    `The field '${c.label}'. Kind: ${c.role}. Heading: ${c.heading === null ? "none" : `'${c.heading}'`}. Group: ${c.group === null ? "none" : `'${c.group}'`}. The field before it: ${c.before === null ? "none" : `'${c.before}'`}; after it: ${c.after === null ? "none" : `'${c.after}'`}. The request: "${instr}". Is this field one the request asks Caret to fill in or change?`,
] as const;

export const scopeId = (ref: string): string => `s_${ref}`;

/**
 * SCP1: the section question's id in each scope-ask request, beside the field questions. Asked only when the window
 * shows a heading (IntentSnapshot.headings): with none, the request can name no section Caret could hold it to.
 */
export const SECTION_QUESTION = "section";

/**
 * SCP1: the section question's options besides one per shown heading (`sec1`, ...). A correct value for a field is no
 * authority to write it (b31-07: Jev answered "asks" for two fields under another heading, and exactness minted both),
 * so when the request names one section, a field Jev chose must also be seen in it (sectionVeto).
 */
export const SECTION_OPTIONS = {
  whole: "The whole form: everything Caret can fill, with no one part of it named.",
  fields: "Particular fields or values, or more than one part of the form: not exactly one section.",
  unlisted: "One section of the form that isn't in this list: the request names a section, and none listed is it.",
  unclear: "Unclear: Caret can't tell which of these the request means, or whether it names a section at all.",
} as const;
/** SCP1: what the section question says after its list when the window shows more sections than it lists. */
const SECTIONS_CUT = "The list may be incomplete: the form has more sections than these.";
ownWording(...Object.values(SECTION_OPTIONS));

const sectionOption = (name: string): string => `One section: the fields in the section '${name}', and no others.`;
const sectionList = (snap: IntentSnapshot): string => `${snap.headings.length === 0 ? "none listed" : snap.headings.map((h) => `'${sendable(h.name, SECTION)}'`).join(", ")}.${snap.sectionsCut ? ` ${SECTIONS_CUT}` : ""}`;

/** The section question's two wordings. The first quotes the request first; the second lists the sections first. */
const SECTION_WORDINGS = [
  (instr: string, list: string): string => `The user asked Caret: "${instr}". The form's sections: ${list} Does the request ask for exactly one section of the form, and if so which?`,
  (instr: string, list: string): string => `Sections of the form: ${list} The request: "${instr}". Is the request about one section of the form, the whole form, or particular fields?`,
] as const;

function sectionQuestion(snap: IntentSnapshot, wording: 0 | 1): JevRequest["questions"][string] {
  const criteria: Record<string, string> = { whole: SECTION_OPTIONS.whole, fields: SECTION_OPTIONS.fields };
  for (const h of snap.headings) criteria[h.ref] = sectionOption(sendable(h.name, SECTION));
  criteria.unlisted = SECTION_OPTIONS.unlisted;
  criteria.unclear = SECTION_OPTIONS.unclear;
  return { type: "choice", instructions: SECTION_WORDINGS[wording](instructionForModel(snap.instruction), sectionList(snap)), criteria };
}

/** The scope ask in one wording: one categorical question per field (or per field in `only`, by key), and the section question, in one request. */
export function scopeRequest(snap: IntentSnapshot, wording: 0 | 1, only?: ReadonlySet<string>): JevRequest {
  const declared = snap.ledger.declared();
  const questions: JevRequest["questions"] = {};
  for (const f of scopeFields(snap)) if (only === undefined || only.has(f.key)) questions[scopeId(f.ref)] = { type: "choice", instructions: SCOPE_WORDINGS[wording](instructionForModel(snap.instruction), fieldContext(snap, f)), criteria: { ...SCOPE_OPTIONS } };
  if (asksSection(snap)) questions[SECTION_QUESTION] = sectionQuestion(snap, wording);
  const state = { instruction: instructionForModel(snap.instruction), form: formTitle(snap), task: "Caret checks, field by field, which fields of the form the user's request asks it to fill in or change." };
  // Raw text, not JSON: a heading with a quote or a backslash is sent, so its snippet must be declared (A3 review 2).
  const sent = [state.instruction, state.form, ...Object.values(questions).flatMap((q) => [String(q.instructions), ...Object.values(q.criteria).map((c) => c ?? "")])].join("\n");
  return assertNoSecrets({ purpose: "ask.scope", state, questions, snippets: declared.snippets.filter((x) => sent.includes(x.text)), charged: declared.charged });
}

/**
 * SCP1: whether the scope ask carries the section question: when the window shows a section, or has sections it could
 * not list. With none at all, a request can name no section Caret could hold it to, and the question would only risk
 * an "isn't in this list" that withholds a request about particular fields.
 */
const asksSection = (snap: IntentSnapshot): boolean => snap.headings.length > 0 || snap.sectionsCut;

/** What both wordings of the section question settled on: one listed section by its text, or one the list lacks. */
export type SectionAnswer = { readonly kind: "section"; readonly name: string } | { readonly kind: "unlisted" };

/**
 * SCP1: what both wordings of the section question chose, at SCOPE_CUTOFF or above: one listed section, or "a section
 * this list lacks". Null when the question was not asked, or either wording chose the whole form, fields or unclear,
 * or they differ, or either is below the cutoff. Null never adds a field: the veto only removes. Throws when Jev left
 * the question unanswered or answered outside its options.
 */
export function sectionVerdict(snap: IntentSnapshot, scope: readonly [JevResult, JevResult], cutoff: number = SCOPE_CUTOFF): SectionAnswer | null {
  if (!asksSection(snap)) return null;
  const options = new Set([...Object.keys(SECTION_OPTIONS), ...snap.headings.map((h) => h.ref)]);
  const answers = scope.map((r) => {
    const a = r.answers[SECTION_QUESTION];
    if (a === undefined) throw new PlannerError("jevFailed", "Jev gave no answer to the section question");
    if (!options.has(a.choice)) throw new PlannerError("jevFailed", `Jev answered '${a.choice}' to the section question, which is not one of its options`);
    return a;
  });
  const [x, y] = answers as [{ choice: string; confidence: number }, { choice: string; confidence: number }];
  if (x.choice !== y.choice || x.confidence < cutoff || y.confidence < cutoff) return null;
  if (x.choice === "unlisted") return { kind: "unlisted" };
  const name = snap.headings.find((h) => h.ref === x.choice)?.name;
  return name === undefined ? null : { kind: "section", name };
}

/**
 * SCP1: what the section veto takes out of Jev's choices, by node key: the fields the window places in other sections
 * only (`outside`), and those whose section Caret couldn't tell (`unknown`: the window can't place them, or the named
 * text is no one section it shows), which are the user's, said. `section` is the section the request named; null on a
 * request that settled before (Settled) with no section named, whose fields that settlement left to the user are `unknown`.
 */
export interface SectionVeto {
  readonly section: string | null;
  /** The request named a section the question's list lacks: every field is withheld, said as SAYS.sectionNotFound. */
  readonly notFound: boolean;
  readonly outside: ReadonlySet<string>;
  readonly unknown: ReadonlySet<string>;
}

/**
 * The veto for a request whose section question settled on one section, else null: no field is taken out. `held` is the
 * section an earlier settlement of the same request named (AskScope.section): it stands whatever this answer says, so a
 * later settlement can't widen the request.
 */
export function sectionVeto(snap: IntentSnapshot, scope: readonly [JevResult, JevResult], held: string | null = null): SectionVeto | null {
  const answer: SectionAnswer | null = held !== null ? { kind: "section", name: held } : sectionVerdict(snap, scope);
  if (answer === null) return null;
  if (answer.kind === "unlisted") return { section: null, notFound: true, outside: new Set(), unknown: new Set(scopeFields(snap).map((f) => f.key)) };
  const section = answer.name;
  // SCP1: on the raw window, compared locally and sent nowhere. Redaction limits what is sent; a decision that can only
  // withhold reads every occurrence, so a second "Equipment details" inside a removed "Password and security" group
  // still makes the named text two sections (confirmation of 516ac15).
  const member = sectionMembership(windowOutline(snap.window), section);
  const outside = new Set<string>();
  const unknown = new Set<string>();
  for (const f of scopeFields(snap)) {
    const m = member(f.key);
    if (m === "outside") outside.add(f.key);
    else if (m === "unknown") unknown.add(f.key);
  }
  return { section, notFound: false, outside, unknown };
}

const vetoed = (veto: SectionVeto | null, f: IntentField): boolean => veto !== null && (veto.outside.has(f.key) || veto.unknown.has(f.key));

/** One field's scope: "asks" only when both wordings say so at SCOPE_CUTOFF; "unclear" when either says so. */
export type ScopeVerdict = "asks" | "not" | "unclear";

export function scopeVerdict(scope: readonly [JevResult, JevResult], ref: string, cutoff: number = SCOPE_CUTOFF): ScopeVerdict {
  const answers = scope.map((r) => {
    const a = r.answers[scopeId(ref)];
    if (a === undefined) throw new PlannerError("jevFailed", `Jev gave no scope answer for field ${ref}`);
    if (!(a.choice in SCOPE_OPTIONS)) throw new PlannerError("jevFailed", `Jev answered '${a.choice}' for field ${ref}, which is not a scope option`);
    return a;
  });
  if (answers.some((a) => a.choice === "unclear")) return "unclear";
  return answers.every((a) => a.choice === "asks" && a.confidence >= cutoff) ? "asks" : "not";
}

/**
 * I2: the scope ask alone, both wordings, for a form the Ask's own question never saw: the next page a goal carried to,
 * the fields its writes revealed, or the window a goal writes in when the Ask came from one with no field (a reply
 * window). `only` limits it to those fields, by key. The fields and upload fields Jev chose and the ones it left unclear,
 * in document order; Caret cannot ask the user mid-goal, so a goal's callers write only `asks`.
 */
export async function settleFields(snap: IntentSnapshot, askJev: AskJev, only?: ReadonlySet<string>, held: string | null = null): Promise<{ asks: IntentField[]; unclear: IntentField[]; sectionless: IntentField[]; section: string | null; notFound: boolean }> {
  const fields = scopeFields(snap).filter((f) => only === undefined || only.has(f.key));
  if (fields.length === 0) return { asks: [], unclear: [], sectionless: [], section: held, notFound: false };
  let rs: [JevResult, JevResult];
  try {
    rs = await Promise.all([askJev(scopeRequest(snap, 0, only)), askJev(scopeRequest(snap, 1, only))]);
  } catch (e) {
    throw jevFailedError(e);
  }
  const verdicts = fields.map((f) => ({ f, v: scopeVerdict(rs, f.ref) }));
  // SCP1: a request that names one section holds a later settlement to it too (a next page, revealed fields): a field
  // Jev chose that is not seen in that section is not chosen, and one whose section can't be told is the user's.
  const veto = sectionVeto(snap, rs, held);
  const chosen = verdicts.filter((x) => x.v === "asks").map((x) => x.f);
  return {
    section: veto?.section ?? null,
    notFound: veto?.notFound === true,
    asks: chosen.filter((f) => !vetoed(veto, f)),
    unclear: verdicts.filter((x) => x.v === "unclear" && !vetoed(veto, x.f)).map((x) => x.f),
    sectionless: veto === null ? [] : chosen.filter((f) => veto.unknown.has(f.key)),
  };
}

/** A head's answer when it clears the floor, else null. Throws when Jev left the question unanswered. */
function settled(r: JevResult, id: string): string | null {
  const a = r.answers[id];
  if (a === undefined) throw new PlannerError("jevFailed", `Jev gave no answer about the instruction's ${id}`);
  return a.confidence >= HEAD_FLOOR ? a.choice : null;
}

const CLAUSE = /\s*(?:;|\.(?=\s|$)|,|\s+and\s+)\s*/iu;

/**
 * Ties each value the instruction spells out to the field its clause names by its words: "make the delivery 8:15"
 * ties 8:15 to Preferred delivery time. The clause is the text around the value up to the nearest clause breaks, so a
 * quoted value may hold commas. The field must be among the fields of the whole form the clause names best, and the
 * only one of them in `scoped`: "set Full name to Alice and fill Company" ties Alice to nothing when only Company is
 * in scope (P1 review). A clause that names no field of the form ties a time or a date to the one time or date field
 * in scope ("saturday works, at 9:30"), else its value to the one field in scope when the instruction spells out one
 * value. A tie only offers the value in that field's fill question; Jev still chooses it there. It never puts a
 * field in scope: `scoped` are fields Jev chose or offered.
 */
export function tieLiterals(snap: IntentSnapshot, scoped: readonly IntentField[]): { field: string; text: string }[] {
  const out: { field: string; text: string }[] = [];
  const words = fieldWords(snap.instruction);
  for (const span of snap.literals) {
    const at = words.indexOf(span);
    // A value inside a source phrase ("from Dana's note") is not a value for a field.
    if (at < 0) continue;
    const said = `${words.slice(0, at).split(CLAUSE).at(-1) ?? ""} ${words.slice(at + span.length).split(CLAUSE)[0] ?? ""}`;
    const named = snap.fields.map((f) => ({ f, n: relevance(said, f.name) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    let field: IntentField | undefined;
    if (named.length > 0) {
      // The fields the clause names best; when several tie, Jev's scope may tell them apart ("make the delivery 8:15"
      // names Preferred delivery time and Delivery instructions alike, and only the time is in scope).
      const top = named.filter((x) => x.n === (named[0] as { n: number }).n).map((x) => x.f).filter((f) => scoped.includes(f));
      if (top.length === 1) field = top[0];
    } else {
      // A clause that names no field: a time or a date ties to the one time or date field in scope ("saturday works, at
      // 9:30"), else the one value to the one field in scope.
      const control = timeShaped(span) ? "time" : dateShaped(span) ? "date" : null;
      const ofKind = control === null ? [] : scoped.filter((f) => f.control === control);
      if (ofKind.length === 1) field = ofKind[0];
      else if (snap.literals.length === 1 && scoped.length === 1) field = scoped[0];
    }
    if (field !== undefined && !out.some((l) => l.field === field.ref)) out.push({ field: field.ref, text: span });
  }
  return out;
}

/** Jev as an intent maker: the heads and the scope ask's two wordings, sent together. */
export function headsIntentMaker(askJev: AskJev): IntentMaker {
  return {
    name: "heads",
    async make(snap, _signal, settled) {
      let rs: JevResult[];
      try {
        // A window with no field has nothing to ask the scope of; a request that already settled it asks it no more
        // (I2 ruling: one request, one settlement), and its verdicts stand in for both wordings.
        const asked = snap.fields.length > 0 && settled === undefined;
        rs = await Promise.all([askJev(headsRequest(snap)), ...(asked ? [askJev(scopeRequest(snap, 0)), askJev(scopeRequest(snap, 1))] : [])]);
        if (settled !== undefined && snap.fields.length > 0) {
          // SCP1: a field the section veto left to the user reads as Jev's choice, so readHeads takes it out again and says why.
          const verdict = (f: IntentField): string => (settled.asks.includes(f.key) || (settled.sectionless ?? []).includes(f.key) ? "asks" : settled.unclear.includes(f.key) ? "unclear" : "not");
          const given: JevResult = { model: "settled", inputTokens: 0, latencyMs: 0, costUsd: 0, answers: Object.fromEntries(scopeFields(snap).map((f) => [scopeId(f.ref), { choice: verdict(f), confidence: 1 }])) };
          rs.push(given, given);
        }
      } catch (e) {
        throw jevFailedError(e);
      }
      const [heads, a, b] = rs as [JevResult, JevResult?, JevResult?];
      const sent = rs.filter((r) => r.model !== "settled");
      const use: MakerUse = {
        maker: "heads",
        model: heads.model,
        calls: sent.length,
        inputTokens: sent.reduce((n, r) => n + r.inputTokens, 0),
        outputTokens: 0,
        costUsd: sent.reduce((n, r) => n + r.costUsd, 0),
        latencyMs: Math.max(...sent.map((r) => r.latencyMs)),
      };
      // SCP1: a settlement made before (helper.ts settleRequest) applied the section veto when it settled; what it left to
      // the user for that is said here too.
      const pair: [JevResult, JevResult] | null = a === undefined || b === undefined ? null : [a, b];
      const veto: SectionVeto | null = settled !== undefined ? ((settled.section ?? null) === null && settled.notFound !== true && (settled.sectionless ?? []).length === 0 ? null : { section: settled.section ?? null, notFound: settled.notFound === true, outside: new Set(), unknown: new Set(settled.sectionless) }) : pair === null ? null : sectionVeto(snap, pair);
      return { intent: readHeads(snap, heads, pair, veto), use };
    },
  };
}

const inOrder = (snap: IntentSnapshot, fs: Iterable<IntentField>): IntentField[] => [...new Set(fs)].sort((x, y) => snap.fields.indexOf(x) - snap.fields.indexOf(y));

/**
 * The intent the heads and the scope ask give. An unsettled part is asked about (B29), never read wider. `scope` is
 * null only for a window with no field.
 */
export function readHeads(snap: IntentSnapshot, heads: JevResult, scope: readonly [JevResult, JevResult] | null, veto: SectionVeto | null = scope === null ? null : sectionVeto(snap, scope)): AskIntent {
  // I2 ruling: what the scope question settled travels with every intent, refusals included, so no question an Ask then
  // saves is without it (planner/ask.ts settledKeys): the fields and upload fields Jev chose or left unclear.
  // A field Jev answered "asks" below the cutoff, or in one wording only, is offered for the user to pick (A3's
  // fallback, readHeadsIntent): it is settled as pickable, and only the user's pick puts it in the Ask's scope.
  // SCP1: a field the section veto took out is settled as nothing, so no later pick or question reaches it.
  const intent = { ...readHeadsIntent(snap, heads, scope, veto), ...(veto?.section == null ? {} : { namedSection: veto.section }) };
  const settledRefs = scope === null ? [] : scopeFields(snap).filter((f) => !vetoed(veto, f) && (scopeVerdict(scope, f.ref) !== "not" || (intent.options ?? []).includes(f.ref))).map((f) => f.ref);
  return { ...intent, settled: settledRefs };
}

function readHeadsIntent(snap: IntentSnapshot, heads: JevResult, scope: readonly [JevResult, JevResult] | null, veto: SectionVeto | null): AskIntent {
  const base: AskIntent = { route: "ask", why: "whichFields", scope: "all", section: "none", fields: [], sources: [], whose: "user", literals: [] };
  const route = settled(heads, "route");
  if (route === "refuse") {
    const why = settled(heads, "why");
    return { ...base, route: "refuse", why: why !== null && why in WHY ? (why as AskIntent["why"]) : "nothingToFill", scope: "none" };
  }

  // SCP1: the request named a section the question's list lacks. Every field is withheld, whatever Jev chose of them.
  if (veto?.notFound === true) {
    const chosenAll = scope === null ? [] : scopeFields(snap).filter((f) => scopeVerdict(scope, f.ref) === "asks");
    return { ...base, route: "refuse", why: "sectionNotFound", scope: "none", ...(chosenAll.length === 0 ? {} : { sectionless: chosenAll.map((f) => f.ref) }) };
  }
  // Which fields: Jev's, field by field. A fill route under its floor is no reason to ask; the fields decide.
  const open: AskPart[] = [];
  const verdicts = scope === null ? [] : snap.fields.map((f) => ({ f, v: scopeVerdict(scope, f.ref) }));
  // SCP1: when the request names one section, a field Jev chose must also be seen in it. One seen under another section
  // is not chosen, offered or asked about; one whose section can't be told is the user's, said (`sectionless`). The
  // veto only removes: a field Jev did not choose never gains anything from it.
  const sectionless = verdicts.filter((x) => x.v === "asks" && veto !== null && veto.unknown.has(x.f.key)).map((x) => x.f);
  // Upload fields too: one Jev chose whose section can't be told is the user's, said, as a field is.
  const sectionlessUploads = scope === null || veto === null ? [] : snap.uploads.filter((u) => scopeVerdict(scope, u.ref) === "asks" && veto.unknown.has(u.key));
  const chosen = verdicts.filter((x) => x.v === "asks" && !vetoed(veto, x.f)).map((x) => x.f);
  const unclear = verdicts.filter((x) => x.v === "unclear" && !vetoed(veto, x.f)).map((x) => x.f);
  let offered: IntentField[] = [];
  // A field either wording answered "asks" without the pair settling it (below the cutoff, or in one wording only): the
  // user may pick it, so it is offered whenever the fields are asked about; only a pick puts it in the scope.
  const pickable = scope === null ? [] : snap.fields.filter((f) => !chosen.includes(f) && !vetoed(veto, f) && scope.some((r) => r.answers[scopeId(f.ref)]?.choice === "asks"));
  // I3 lead ruling: an Ask is never refused whole because some fields are unclear or a question would be too long. The
  // fields Jev chose are filled. The unclear and below-cutoff ones are asked about, beside the chosen ones (`sure`), only
  // when one question lists them all; otherwise, or when none is unclear, each is left to the user (`unsure`), said.
  const uncertain = inOrder(snap, [...unclear, ...pickable]);
  let sure: IntentField[] = [];
  let unsure: IntentField[] = [];
  if (chosen.length > 0 && unclear.length > 0 && uncertain.length <= MAX_ASK_OPTIONS) {
    open.push("fields");
    offered = uncertain;
    sure = chosen;
  } else if (chosen.length > 0) unsure = uncertain;
  else if (unclear.length > 0) {
    open.push("fields");
    offered = uncertain;
  } else {
    // Nothing settled: offer any field either wording said the request asks for, below the cutoff or not agreed.
    offered = pickable;
    // SCP1: Jev chose fields of the one section the request named, and Caret couldn't tell which section any is in.
    if (offered.length === 0 && sectionless.length + sectionlessUploads.length > 0) return { ...base, route: "refuse", why: "sectionUnknown", scope: "none", sectionless: [...sectionless, ...sectionlessUploads].map((f) => f.ref) };
    // Every field "not" in both wordings, on a fill Jev settled: the form has no field the instruction asks for.
    if (offered.length === 0 && (route === "all" || route === "some") && scope !== null) return { ...base, route: "refuse", why: "noSuchField", scope: "none" };
    open.push("fields");
  }
  // Every empty field chosen, on a route Jev settled as the whole form: still a list of exactly those fields (a page
  // goal's "all" would take inputs past the snapshot, goals/page-planner.ts), whose values fill asks as Fill all does
  // (FillScope.wholeForm). Every field chosen alone is not enough: "use my work email" on a form with one Email field
  // must keep its words in the value question (A3 review 2).
  const empties = snap.fields.filter((f) => !f.filled);
  const wholeForm = route === "all" && chosen.length > 0 && chosen.length === empties.length && empties.every((f) => chosen.includes(f));
  const refs = (fs: readonly IntentField[]): string[] => fs.map((f) => f.ref);
  const jevFields = {
    scope: "list" as const,
    fields: open.includes("fields") ? [] : refs(chosen),
    ...(open.includes("fields")
      ? { options: refs(offered), ...(sure.length === 0 ? {} : { sure: refs(sure) }) }
      : { agreed: true as const, ...(wholeForm ? { wholeForm: true as const } : {}), ...(unsure.length === 0 ? {} : { unsure: refs(unsure) }) }),
  };
  // In scope for tying values: the chosen fields, or the offered ones and the sure ones when the fields are asked
  // (applyFixed keeps a literal only on a field that stays in scope after the pick).
  const typable = (open.includes("fields") ? inOrder(snap, [...sure, ...offered]) : chosen).filter((f) => f.neverTyped === null);
  const literals = tieLiterals(snap, typable);

  // Where from. The instruction's own words come first, whatever the head says, since checkIntent reads "any" as every
  // window but the excluded ones (P1 review: a settled "any" read Draft.txt for "my email from my rental notes"):
  //   - keeping Caret to some sources ("only what I typed", "don't read other windows"): only "instruction" stands, and
  //     anything else is asked;
  //   - naming windows: those windows as code resolved them (sources.ts), which only narrows what is read; one the
  //     request does not list is asked;
  //   - saying nothing: the head's answer, or every source, as an ambient fill reads them, when it is unsettled.
  const source = settled(heads, "source");
  const known = source !== null && (source === "any" || source === "memory" || source === "instruction" || snap.windows.some((w) => w.ref === source));
  let sources: string[] = known ? [source] : [];
  if (restrictsSources(snap.instruction)) {
    if (source === "instruction") sources = ["instruction"];
    else open.push("source");
  } else if (snap.named.length > 0) {
    const named = snap.named.map((n) => snap.windows.find((w) => w.windowId === n.windowId)?.ref);
    if (named.some((x) => x === undefined)) open.push("source");
    else sources = named as string[];
  }

  // Whose. Code's reading first (A1 decision 2, people.ts): the user, a person the instruction names, the one other person
  // in its sources or a relation's memory entry, or a question when it finds more than one. When code cannot tell, the
  // head: unsettled with a person named, or someone else unnamed, is a question; unsettled with no one named is the user.
  const code = readWhose(snap, snap.others, snap.memoryValues);
  const whose = settled(heads, "whose");
  let person: string | null = null;
  let named: string | undefined;
  let unnamed = false;
  if (code.kind === "user") person = null;
  else if (code.kind === "person") ((person = code.ref), (named = code.name ?? undefined));
  else if (code.kind === "ask") open.push("person");
  else {
    person = whose !== null && snap.persons.some((p) => p.ref === whose) ? whose : null;
    if (whose === "unclear" || (whose === null && snap.persons.length > 0)) open.push("person");
    unnamed = whose === "unclear";
  }

  // Upload fields Jev chose, asked in the same question as the fields (I2 ruling B); one left unclear is not chosen.
  const uploads = scope === null ? [] : snap.uploads.filter((u) => scopeVerdict(scope, u.ref) === "asks" && !vetoed(veto, u)).map((u) => u.ref);
  const parts = { ...jevFields, section: "none", sources, whose: person ?? "user", literals, ...(named === undefined ? {} : { person: named }), ...(uploads.length === 0 ? {} : { uploads }), ...(sectionless.length + sectionlessUploads.length === 0 ? {} : { sectionless: [...sectionless, ...sectionlessUploads].map((f) => f.ref) }) };
  // A plan carries Jev's fields and what was read of sources and whose, with the parts left open, so a page host that
  // fills a plan's form fills only those fields, from those sources, or asks first (ask.ts planAsAll).
  if (route === "plan") return { route: "plan", why: "none", ...parts, ...(open.length > 0 ? { pageOpen: open } : {}) };
  if (open.length > 0) {
    const first = open[0] as AskPart;
    const why = first === "fields" ? "whichFields" : first === "source" ? "whichSource" : unnamed ? "otherPersonUnnamed" : "whichPerson";
    return { route: "ask", why, ...parts, open };
  }
  return { route: "fill", why: "none", ...parts };
}
