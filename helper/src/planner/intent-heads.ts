// Ask's intent as one Jev request with heads (P1, plans/fast-browser.md "Intent as one request with heads"). One
// request carries every question about the instruction; the scope answer decides which of the others are read:
//   - scope, the operation head: the whole form, a section, particular fields, a plan, unclear, or refuse;
//   - why, read only when scope is refuse;
//   - section, read only when scope is section;
//   - source and whose, always read;
//   - one yes/no question per field, read only when scope is fields.
// The staged Jev maker (intent-makers.ts) asked two stages twice each and rarely cleared both floors, so 14 to 16 of
// B24's 20 asks ended as "which fields?" (writer/config.ts). Here a whole-form scope settles in one answer.
//
// One request means no second wording agrees with the first, so planAsk checks this maker's scope as it checks the
// writer's (ask.ts confirmScope: Jev, asked twice, confirms fields the instruction does not name and a whole form the
// instruction does not state). Values the instruction spells out are tied to fields by code (tieLiterals), never by Jev.
import { asksForWholeForm } from "./scope-words.ts";
import { readScope, type ScopeReading } from "./scope-reading.ts";
import { readWhose } from "./people.ts";
import type { AskJev, JevRequest, JevResult } from "../fill/jev.ts";
import type { IntentMaker, MakerUse } from "./intent-makers.ts";
import { ROUTE_CUTOFF, NOUL_FLOOR } from "./intent-makers.ts";
import type { AskIntent, IntentField, IntentSnapshot } from "./intent.ts";
import { relevance } from "./planner.ts";
import { fieldWords, restrictsSources } from "./sources.ts";
import { PlannerError } from "./validate.ts";
import { jevFailedError, type AskPart } from "./says.ts";

/** Lowest confidence for the scope, section, why, source and whose heads: the memo's floors, plan section 3's provisional router floor, not calibrated. */
export const HEAD_FLOOR = ROUTE_CUTOFF;
/** Lowest probability of yes for a field the instruction asks for (scope fields): plan section 4's provisional floor, not calibrated. */
export const FIELD_FLOOR = NOUL_FLOOR;

const SCOPE: Record<string, string> = {
  all: "Fill every empty field of the form Caret can: the whole form, or everything Caret knows.",
  section: "Fill the fields under one heading of the form.",
  fields: "Fill or change only particular fields that the instruction names or describes.",
  plan: "More than filling fields with values that already exist: press a button, submit, send, add an event to the calendar, write a message, reply or description in new words, or a task of several steps.",
  unclear: "The instruction is too unclear to say which fields it means.",
  refuse: "Something Caret must not or cannot do here: pay, give a card number, a password, a one-time code or a Social Security number, or fill a field this form does not have.",
};
const WHY: Record<string, string> = {
  neverTyped: "It asks for a card number, a password, a one-time code, or a Social Security or other government ID number.",
  payment: "It asks to pay.",
  pressOrSend: "It asks to submit, send or press something, and nothing else.",
  noSuchField: "It asks for a field this form does not have.",
  nothingToFill: "Something else Caret should not do.",
};

const TASK = "Caret reads the user's instruction about the form on screen: what to do, which fields, from where, and for whom. Answer from the instruction; Caret finds the values itself.";

/**
 * A1: the options of the question that confirms code's reading (scope-reading.ts). The reading is one option; the
 * others are the ways it could be wrong: the whole form, fewer fields, other fields, or no fill at all. Only a top
 * choice of "code" acts on the reading (readHeads); any other answer asks which fields, with the reading's fields
 * among the choices.
 */
export function readingCriteria(r: ScopeReading): Record<string, string> {
  const c: Record<string, string> = { code: r.says };
  if (r.kind === "all") c.some = "Fill only some particular fields of the form, not all of them.";
  else {
    c.all = "Fill every empty field of the form.";
    if (r.fields.length > 1) c.fewer = "Fill only some of those fields.";
    c.other = "Fill other fields than those, or more of them.";
  }
  c.none = "Fill no field: the instruction asks Caret to press a button, send, pay, write something new, or do something it must refuse.";
  return c;
}

/** The one request: the form, sources and people as state, the heads as Choice questions, one Noul per field. */
export function headsRequest(snap: IntentSnapshot): JevRequest {
  const declared = snap.ledger.declared();
  const sectionRef = new Map(snap.sections.map((s) => [s.name, s.ref]));
  const state = {
    instruction: snap.instruction,
    form: {
      title: snap.title === null ? `${snap.window.app.name} window` : `${snap.window.app.name} window '${snap.title}'`,
      sections: snap.sections.map((s) => ({ id: s.ref, name: s.name })),
      fields: snap.fields.map((f) => ({ id: f.ref, name: f.name, control: f.neverTyped === null ? f.control : "never typed by Caret", filled: f.filled, section: f.section === null ? null : (sectionRef.get(f.section) ?? null) })),
    },
    sources: snap.windows.map((w) => ({ id: w.ref, title: `${w.app}: ${w.title}${w.from === null ? "" : ` (from ${w.from})`}` })),
    people: snap.persons.map((p) => ({ id: p.ref, span: p.span })),
    task: TASK,
  };
  const scope = snap.sections.length > 0 ? SCOPE : Object.fromEntries(Object.entries(SCOPE).filter(([k]) => k !== "section"));
  const source: Record<string, string> = { any: "The instruction does not say where the values come from.", ...(snap.memory.length > 0 ? { memory: "What the user told Caret about themselves (their own name and email)." } : {}), instruction: "Only values the instruction itself spells out." };
  for (const w of snap.windows) source[w.ref] = `The ${w.app} window '${w.title}'${w.from === null ? "" : `, from ${w.from}`}.`;
  const whose: Record<string, string> = { user: "The user's own details, or each field's own: the instruction names no one else whose details go in." };
  for (const p of snap.persons) whose[p.ref] = `The details of ${p.span}, whom the instruction names.`;
  whose.unclear = "Someone else's details, but the instruction does not say whose.";
  const questions: JevRequest["questions"] = {
    scope: { type: "choice", instructions: "Which fields of the form does the instruction ask Caret to fill, or what else does it ask?", criteria: scope },
    why: { type: "choice", instructions: "If Caret should refuse the instruction, why?", criteria: WHY },
    source: { type: "choice", instructions: "Where does the instruction say the values come from?", criteria: source },
    whose: { type: "choice", instructions: "Whose details does the instruction ask Caret to put in the form?", criteria: whose },
  };
  if (snap.sections.length > 0) {
    const section: Record<string, string> = Object.fromEntries(snap.sections.map((s) => [s.ref, `The fields under '${s.name}'.`]));
    section.none = "No one heading of the form.";
    questions.section = { type: "choice", instructions: "Which heading's fields does the instruction ask Caret to fill?", criteria: section };
  }
  // A1: code's reading of the scope, offered as one option among the ways it could be wrong.
  const code = readScope(snap).reading;
  if (code !== null) questions.reading = { type: "choice", instructions: "Which of these does the instruction ask Caret to do?", criteria: readingCriteria(code) };
  const nouls: NonNullable<JevRequest["nouls"]> = {};
  for (const f of snap.fields) nouls[`n_${f.ref}`] = { type: "noul", instructions: `Does the instruction ask to fill or change '${f.name}'?` };
  return { state, questions, nouls, snippets: declared.snippets, charged: declared.charged };
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
 * quoted value may hold commas. The field must be the one field of the whole form the clause names best, and in scope:
 * "set Full name to Alice and fill Company" ties Alice to nothing when only Company is in scope (P1 review). A clause
 * that names no field of the form ties its value to the one field in scope, when the instruction spells out one value.
 * A tie only offers the value in that field's fill question; Jev still chooses it there.
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
      const best = named[0] as { f: IntentField; n: number };
      if ((named.length === 1 || best.n > (named[1] as { n: number }).n) && scoped.includes(best.f)) field = best.f;
    } else if (snap.literals.length === 1 && scoped.length === 1) field = scoped[0];
    if (field !== undefined && !out.some((l) => l.field === field.ref)) out.push({ field: field.ref, text: span });
  }
  return out;
}

/** Jev as an intent maker in one request (P1). */
export function headsIntentMaker(askJev: AskJev): IntentMaker {
  return {
    name: "heads",
    async make(snap) {
      let r: JevResult;
      try {
        r = await askJev(headsRequest(snap));
      } catch (e) {
        throw jevFailedError(e);
      }
      const use: MakerUse = { maker: "heads", model: r.model, calls: 1, inputTokens: r.inputTokens, outputTokens: 0, costUsd: r.costUsd, latencyMs: r.latencyMs };
      return { intent: readHeads(snap, r), use };
    },
  };
}

/** The intent one answer gives, at the floors: an unsettled part is asked about (B29), never read wider. */
export function readHeads(snap: IntentSnapshot, r: JevResult): AskIntent {
  const base: AskIntent = { route: "ask", why: "whichFields", scope: "all", section: "none", fields: [], sources: [], whose: "user", literals: [] };
  // P2: the whole form is settled under the floor when Jev's top choice is the whole form and code's own grammar reads
  // the whole instruction as a whole-form request (scope-words.ts WHOLE_FORM, B28's reviewed allowlist, which planAsk
  // already trusts without a confirmation). Live P2 run: Jev chose "all" for "fill out this form" on all 19 corpus and
  // W4 pages, at a margin of 0.46 to 0.78, under the floor on 17, and each of those asked "Which fields do you mean?"
  // (evidence/screen/p2/goal-live-1). Anything else still needs the floor.
  const scope = settled(r, "scope") ?? (r.answers.scope?.choice === "all" && asksForWholeForm(snap.instruction) ? "all" : null);
  if (scope === "refuse") {
    const why = settled(r, "why");
    return { ...base, route: "refuse", why: why !== null && why in WHY ? (why as AskIntent["why"]) : "nothingToFill", scope: "none" };
  }
  // A1: code's reading of the scope, which the model's top choice either confirms or does not. A confirmed reading
  // stands over a plan head (the model chose a fill of those fields in the same answer); a refusal still wins.
  const reading = readScope(snap).reading;
  const agreed = reading !== null && r.answers.reading?.choice === "code";
  if (scope === "plan" && !agreed) return { ...base, route: "plan", why: "none", scope: "none" };

  const open: AskPart[] = [];
  // Which fields.
  let kind: "all" | "section" | "list" = "all";
  let section = "none";
  let listed: IntentField[] = [];
  if (reading !== null) {
    // Agreed: code's fields. Not agreed: asked, with the reading's fields among the choices (choices.ts).
    if (agreed && reading.kind === "fields") ((kind = "list"), (listed = reading.fields));
    else if (!agreed) open.push("fields");
  } else if (scope === "all") kind = "all";
  else if (scope === "section") {
    const s = snap.sections.length === 0 ? null : settled(r, "section");
    if (s !== null && s !== "none" && snap.sections.some((x) => x.ref === s)) ((kind = "section"), (section = s));
    else open.push("fields");
  } else if (scope === "fields") {
    kind = "list";
    listed = snap.fields.filter((f) => (r.nouls?.[`n_${f.ref}`] ?? 0) >= FIELD_FLOOR);
  } else open.push("fields"); // unclear, or below the floor

  // In scope for tying values: every empty field Caret may type, the section's, or the confirmed list.
  const sectionName = snap.sections.find((x) => x.ref === section)?.name;
  const empty = snap.fields.filter((f) => !f.filled && f.neverTyped === null);
  const scoped = kind === "all" ? empty : kind === "section" ? empty.filter((f) => f.section === sectionName) : listed.filter((f) => f.neverTyped === null);
  const literals = open.includes("fields") ? [] : agreed && reading !== null ? reading.literals : tieLiterals(snap, scoped);
  const fields = kind === "list" ? [...new Set([...listed.map((f) => f.ref), ...literals.map((l) => l.field)])] : [];
  if (kind === "list" && fields.length === 0) open.push("fields");

  // Where from. The instruction's own words come first, whatever the head says, since checkIntent reads "any" as every
  // window but the excluded ones (P1 review: a settled "any" read Draft.txt for "my email from my rental notes"):
  //   - keeping Caret to some sources ("only what I typed", "don't read other windows"): only "instruction" stands, and
  //     anything else is asked;
  //   - naming windows: those windows as code resolved them (sources.ts); one the request does not list is asked;
  //   - saying nothing: the head's answer, or every source, as an ambient fill reads them, when it is unsettled.
  const source = settled(r, "source");
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
  const code = readWhose(snap, snap.others, snap.memoryValues, reading?.because.some((b) => b.endsWith("(someone else's)")) ?? false);
  const whose = settled(r, "whose");
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

  const parts = { scope: kind, section, fields, sources, whose: person ?? "user", literals, ...(named === undefined ? {} : { person: named }), ...(agreed ? { agreed: true as const } : {}) };
  if (open.length > 0) {
    const first = open[0] as AskPart;
    const why = first === "fields" ? "whichFields" : first === "source" ? "whichSource" : unnamed ? "otherPersonUnnamed" : "whichPerson";
    return { route: "ask", why, ...parts, open };
  }
  return { route: "fill", why: "none", ...parts };
}
