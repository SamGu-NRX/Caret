// Ask's intent from Jev (P1, A3). Three requests, sent together:
//   - the heads, one request: route (fill, plan or refuse), why when it refuses, source and whose;
//   - the scope ask, in two wordings: one categorical question per field, showing the field's label, its heading, its
//     group, the kind of control it is and its neighbours' labels, with the options asks, not and unclear.
// Jev decides which fields an Ask means; code only vetoes. A field is in scope only when both wordings answer "asks" at
// SCOPE_CUTOFF or above. Any "unclear" in either wording asks the user which fields, offering those fields with the ones
// Jev chose (choices.ts offers exactly these). No code path here adds a field Jev did not choose. The vetoes, each at
// its own site: a kind Caret never types (checkIntent: such fields are left to the user); one person per Ask (people.ts
// readWhose asks when the instruction names two); a literal value must be an exact span of the instruction and is only
// tied to a field Jev chose or offered (tieLiterals, checkIntent); a named source only narrows the windows read (the
// sources part below, checkIntent).
//
// A2 found that hand-written rules for reading a request (A1's scope-reading.ts, removed here) did not converge: twelve
// review rounds each found a new phrasing that widened the scope. A widening phrasing is answered by the vetoes or by
// "unclear", never by a new reading rule.
import { readWhose } from "./people.ts";
import type { AskJev, JevRequest, JevResult } from "../fill/jev.ts";
import type { Control } from "../fill/controls.ts";
import type { IntentMaker, MakerUse } from "./intent-makers.ts";
import { ROUTE_CUTOFF } from "./intent-makers.ts";
import type { AskIntent, IntentField, IntentSnapshot } from "./intent.ts";
import { relevance } from "./planner.ts";
import { fieldWords, restrictsSources } from "./sources.ts";
import { PlannerError } from "./validate.ts";
import { jevFailedError, type AskPart } from "./says.ts";

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

const ROUTE: Record<string, string> = {
  fill: "Put values into fields of this form: the whole form, a part of it, or particular fields (Caret asks which fields separately).",
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

const TASK = "Caret reads the user's instruction about the form on screen: what to do, from where, and for whom. Answer from the instruction; Caret finds the values itself.";

/** The heads request: the form, sources and people as state, the heads as Choice questions. */
export function headsRequest(snap: IntentSnapshot): JevRequest {
  const declared = snap.ledger.declared();
  const sectionRef = new Map(snap.sections.map((s) => [s.name, s.ref]));
  const state = {
    instruction: snap.instruction,
    form: {
      title: formTitle(snap),
      sections: snap.sections.map((s) => ({ id: s.ref, name: s.name })),
      fields: snap.fields.map((f) => ({ id: f.ref, name: f.name, control: f.neverTyped === null ? f.control : "never typed by Caret", filled: f.filled, section: f.section === null ? null : (sectionRef.get(f.section) ?? null) })),
    },
    sources: snap.windows.map((w) => ({ id: w.ref, title: `${w.app}: ${w.title}${w.from === null ? "" : ` (from ${w.from})`}` })),
    people: snap.persons.map((p) => ({ id: p.ref, span: p.span })),
    task: TASK,
  };
  const source: Record<string, string> = { any: "The instruction does not say where the values come from.", ...(snap.memory.length > 0 ? { memory: "What the user told Caret about themselves (their own name and email)." } : {}), instruction: "Only values the instruction itself spells out." };
  for (const w of snap.windows) source[w.ref] = `The ${w.app} window '${w.title}'${w.from === null ? "" : `, from ${w.from}`}.`;
  const whose: Record<string, string> = { user: "The user's own details, or each field's own: the instruction names no one else whose details go in." };
  for (const p of snap.persons) whose[p.ref] = `The details of ${p.span}, whom the instruction names.`;
  whose.unclear = "Someone else's details, but the instruction does not say whose.";
  const questions: JevRequest["questions"] = {
    route: { type: "choice", instructions: "What does the instruction ask Caret to do with the form on screen?", criteria: ROUTE },
    why: { type: "choice", instructions: "If Caret should refuse the instruction, why?", criteria: WHY },
    source: { type: "choice", instructions: "Where does the instruction say the values come from?", criteria: source },
    whose: { type: "choice", instructions: "Whose details does the instruction ask Caret to put in the form?", criteria: whose },
  };
  return { state, questions, snippets: declared.snippets, charged: declared.charged };
}

const formTitle = (snap: IntentSnapshot): string => (snap.title === null ? `${snap.window.app.name} window` : `${snap.window.app.name} window '${snap.title}'`);

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

export function fieldContext(snap: IntentSnapshot, f: IntentField): FieldContext {
  const i = snap.fields.indexOf(f);
  const same = (a: string | null, b: string | null): boolean => a !== null && b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
  const group = f.section === null || same(f.section, f.name) || same(f.section, f.heading) ? null : f.section;
  return { label: f.name, heading: f.heading, group, role: CONTROL_WORDS[f.control], before: snap.fields[i - 1]?.name ?? null, after: snap.fields[i + 1]?.name ?? null };
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

/** The scope ask in one wording: one categorical question per field, in one request. */
export function scopeRequest(snap: IntentSnapshot, wording: 0 | 1): JevRequest {
  const declared = snap.ledger.declared();
  const questions: JevRequest["questions"] = {};
  for (const f of snap.fields) questions[scopeId(f.ref)] = { type: "choice", instructions: SCOPE_WORDINGS[wording](snap.instruction, fieldContext(snap, f)), criteria: { ...SCOPE_OPTIONS } };
  const state = { instruction: snap.instruction, form: formTitle(snap), task: "Caret checks, field by field, which fields of the form the user's request asks it to fill in or change." };
  const sent = JSON.stringify([state, questions]);
  return { state, questions, snippets: declared.snippets.filter((x) => sent.includes(x.text)), charged: declared.charged };
}

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
 * in scope (P1 review).
 * A clause that names no field of the form ties its value to the one field in scope, when the instruction spells out
 * one value. A tie only offers the value in that field's fill question; Jev still chooses it there. It never puts a
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
    } else if (snap.literals.length === 1 && scoped.length === 1) field = scoped[0];
    if (field !== undefined && !out.some((l) => l.field === field.ref)) out.push({ field: field.ref, text: span });
  }
  return out;
}

/** Jev as an intent maker: the heads and the scope ask's two wordings, sent together. */
export function headsIntentMaker(askJev: AskJev): IntentMaker {
  return {
    name: "heads",
    async make(snap) {
      let rs: JevResult[];
      try {
        // A window with no field has nothing to ask the scope of.
        rs = await Promise.all([askJev(headsRequest(snap)), ...(snap.fields.length === 0 ? [] : [askJev(scopeRequest(snap, 0)), askJev(scopeRequest(snap, 1))])]);
      } catch (e) {
        throw jevFailedError(e);
      }
      const [heads, a, b] = rs as [JevResult, JevResult?, JevResult?];
      const use: MakerUse = {
        maker: "heads",
        model: heads.model,
        calls: rs.length,
        inputTokens: rs.reduce((n, r) => n + r.inputTokens, 0),
        outputTokens: 0,
        costUsd: rs.reduce((n, r) => n + r.costUsd, 0),
        latencyMs: Math.max(...rs.map((r) => r.latencyMs)),
      };
      return { intent: readHeads(snap, heads, a === undefined || b === undefined ? null : [a, b]), use };
    },
  };
}

const inOrder = (snap: IntentSnapshot, fs: Iterable<IntentField>): IntentField[] => [...new Set(fs)].sort((x, y) => snap.fields.indexOf(x) - snap.fields.indexOf(y));

/**
 * The intent the heads and the scope ask give. An unsettled part is asked about (B29), never read wider. `scope` is
 * null only for a window with no field.
 */
export function readHeads(snap: IntentSnapshot, heads: JevResult, scope: readonly [JevResult, JevResult] | null): AskIntent {
  const base: AskIntent = { route: "ask", why: "whichFields", scope: "all", section: "none", fields: [], sources: [], whose: "user", literals: [] };
  const route = settled(heads, "route");
  if (route === "refuse") {
    const why = settled(heads, "why");
    return { ...base, route: "refuse", why: why !== null && why in WHY ? (why as AskIntent["why"]) : "nothingToFill", scope: "none" };
  }

  // Which fields: Jev's, field by field. A fill route under its floor is no reason to ask; the fields decide.
  const open: AskPart[] = [];
  const verdicts = scope === null ? [] : snap.fields.map((f) => ({ f, v: scopeVerdict(scope, f.ref) }));
  const chosen = verdicts.filter((x) => x.v === "asks").map((x) => x.f);
  const unclear = verdicts.filter((x) => x.v === "unclear").map((x) => x.f);
  let offered: IntentField[] = [];
  if (unclear.length > 0) {
    open.push("fields");
    offered = inOrder(snap, [...chosen, ...unclear]);
  } else if (chosen.length === 0) {
    // Nothing settled: offer any field either wording said the request asks for, below the cutoff or not agreed.
    offered = scope === null ? [] : snap.fields.filter((f) => scope.some((r) => r.answers[scopeId(f.ref)]?.choice === "asks"));
    // Every field "not" in both wordings, on a fill Jev settled: the form has no field the instruction asks for.
    if (offered.length === 0 && route === "fill" && scope !== null) return { ...base, route: "refuse", why: "noSuchField", scope: "none" };
    open.push("fields");
  }
  // Every empty field chosen: still a list of exactly those fields (a page goal's "all" would take inputs past the
  // snapshot, goals/page-planner.ts), whose values fill asks as Fill all does (FillScope.wholeForm).
  const empties = snap.fields.filter((f) => !f.filled);
  const wholeForm = chosen.length > 0 && chosen.length === empties.length && empties.every((f) => chosen.includes(f));
  const jevFields = {
    scope: "list" as const,
    fields: open.includes("fields") ? [] : chosen.map((f) => f.ref),
    ...(open.includes("fields") ? { options: offered.map((f) => f.ref) } : { agreed: true as const, ...(wholeForm ? { wholeForm: true as const } : {}) }),
  };
  // A plan carries Jev's fields, so a page host that fills a plan's form fills only those, or asks (ask.ts).
  if (route === "plan") return { ...base, route: "plan", why: "none", ...jevFields };
  // In scope for tying values: the chosen fields, or the offered ones when the fields are asked (applyFixed keeps a
  // literal only on a field the user then picks).
  const typable = (open.includes("fields") ? offered : chosen).filter((f) => f.neverTyped === null);
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

  const parts = { ...jevFields, section: "none", sources, whose: person ?? "user", literals, ...(named === undefined ? {} : { person: named }) };
  if (open.length > 0) {
    const first = open[0] as AskPart;
    const why = first === "fields" ? "whichFields" : first === "source" ? "whichSource" : unnamed ? "otherPersonUnnamed" : "whichPerson";
    return { route: "ask", why, ...parts, open };
  }
  return { route: "fill", why: "none", ...parts };
}
