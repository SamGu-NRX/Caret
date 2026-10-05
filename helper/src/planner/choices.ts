// Ask questions with choices (B29). When an Ask cannot settle which fields, where to copy from, or whose details, and
// code can list that part's real candidates from the screen, the user gets one short question with those candidates
// as options instead of a refusal. Picking one continues the same Ask with that part fixed (ask.ts); the pick fixes
// only what it names. Pure: it reads the snapshot and the model and builds the options.
//
//   - fields: the form's empty fields Caret may fill that fit what the instruction says (the fields or sections it
//     names by their words, the meaning of a section phrase such as "contact info", else the kinds of value it names),
//     or every empty field when it says nothing that fits; many may be picked, at most MAX_ASK_OPTIONS listed.
//   - source: the open windows, other than any the instruction rules out, whose text holds a value of a kind or label
//     the fields in scope want, and what the user told Caret when it holds something; one is picked. Memory is not in
//     the lead's list: B24's "my name and email please" comes from it, and no window could be the right answer.
//   - person: the user, or someone the instruction or an open mail names (a name once, its longest form); one is picked.
//
// Nothing is listed past MAX_ASK_OPTIONS: an Ask whose candidates do not fit is refused as before.
import type { ScreenModel } from "../model.ts";
import { MAX_ASK_OPTIONS, type AskOption } from "../protocol.ts";
import { describeField } from "../fill/descriptor.ts";
import { collectCandidates } from "../fill/candidates.ts";
import { fieldKinds, fieldTerms, NAME_TERM, overlap } from "../fill/kinds.ts";
import { mentionedKind } from "../memory/sensitive.ts";
import { namesShortLabel, relevance } from "./planner.ts";
import { normalizeInstruction, SECTION_WORDS } from "./scope-words.ts";
import { fieldWords } from "./sources.ts";
import { ASKS, type AskPart } from "./says.ts";
import type { AskFixed, IntentField, IntentSnapshot } from "./intent.ts";

/** One option as the host shows it, and what picking it fixes. */
export interface Choice {
  option: AskOption;
  fixes: AskFixed;
}

export interface Choices {
  part: AskPart;
  text: string;
  pick: "one" | "many";
  options: Choice[];
}

/**
 * Words that ask Caret to press, send or pay. An instruction holding one is never asked about with choices: a pick of
 * fields would answer a request Caret refuses (B26's sentences stand). Written from saysPressAsked's words, not measured.
 */
const PRESS_WORDS = /\b(?:submit|send|reply|delete|remove|scrap|discard|trash|pay|purchase|buy|checkout|check out|place the order|press|click|hit)\b/iu;

/** Whether an instruction must be refused rather than asked about: it names a kind Caret never types, or a press. */
export function mustRefuse(instruction: string): boolean {
  return mentionedKind(instruction) !== null || PRESS_WORDS.test(instruction);
}

/** Why no question can be asked, for the refusal's detail; null when `choices` holds one. */
export type ChoicesResult = { choices: Choices; why: null } | { choices: null; why: string };

const no = (why: string): ChoicesResult => ({ choices: null, why });

/** The question for `part`, or why there is none. `scoped` are the fields the Ask has in scope so far, for a source question. */
export function choicesFor(part: AskPart, snap: IntentSnapshot, model: ScreenModel, scoped: readonly IntentField[], now: number): ChoicesResult {
  if (mustRefuse(snap.instruction)) return no("the instruction asks for something Caret refuses");
  if (part === "fields") return fieldChoices(snap);
  if (part === "source") return sourceChoices(snap, model, scoped.length > 0 ? scoped : empties(snap), now);
  return personChoices(snap);
}

const empties = (snap: IntentSnapshot): IntentField[] => snap.fields.filter((f) => !f.filled && f.neverTyped === null);

/** The label words fill reads a field by (fill.ts proposeFill), or none for a field whose node is gone. */
function labelWords(snap: IntentSnapshot, f: IntentField): (string | null)[] {
  const n = snap.window.nodes.get(f.key);
  if (n === undefined) return [];
  const d = describeField(snap.window, n);
  return [d.label, d.nearest, d.placeholder];
}

/**
 * The words a field's kind is read from here: its label words and its section's heading, so Month and Year under "Date
 * of birth" are dates for "my birthday" (B24's ask-04 offered only Day). Only for choosing options; fill reads kinds as before.
 */
const kindWords = (snap: IntentSnapshot, f: IntentField): (string | null)[] => [...labelWords(snap, f), f.section];

/**
 * The empty fields that fit the instruction, in document order: those it names by their words or by their section's,
 * and those a section phrase's meaning takes; else those of a kind of value it names; else every empty field.
 */
export function fittingFields(snap: IntentSnapshot): IntentField[] {
  const all = empties(snap);
  const fw = fieldWords(snap.instruction);
  const said = normalizeInstruction(snap.instruction);
  const meanings = SECTION_WORDS.filter((p) => p.fits !== null && p.re.test(said)).map((p) => p.fits as NonNullable<typeof p.fits>);
  const typed = (f: IntentField): boolean => f.control === "text" || f.control === "combobox";
  const named = all.filter(
    (f) =>
      relevance(fw, f.name) > 0 ||
      namesShortLabel(fw, f.name) ||
      (f.section !== null && relevance(fw, f.section) > 0) ||
      meanings.some((m) => m({ labelWords: labelWords(snap, f), name: f.name, typed: typed(f) })),
  );
  if (named.length > 0) return named;
  const kinds = fieldKinds([fw]);
  const name = fieldTerms([fw]).has(NAME_TERM);
  const byKind = all.filter((f) => {
    const words = kindWords(snap, f);
    return [...fieldKinds(words)].some((k) => kinds.has(k)) || (name && fieldTerms(words).has(NAME_TERM));
  });
  return byKind.length > 0 ? byKind : all;
}

function fieldChoices(snap: IntentSnapshot): ChoicesResult {
  const fit = fittingFields(snap);
  if (fit.length === 0) return no("the form has no empty field Caret may fill");
  if (fit.length > MAX_ASK_OPTIONS) return no(`${fit.length} empty fields fit the instruction, more than one question lists`);
  return {
    choices: {
      part: "fields",
      text: ASKS.fields,
      pick: "many",
      options: fit.map((f, i) => ({ option: { kind: "field", id: `o${i + 1}`, label: f.name, section: f.section }, fixes: { fields: [f.key] } })),
    },
    why: null,
  };
}

/**
 * The windows that hold a value the fields want: a candidate of a kind one of them takes, or one on a "Label: value"
 * line whose label shares a term with one of them. Most recently used first, as the snapshot lists windows.
 */
function sourceChoices(snap: IntentSnapshot, model: ScreenModel, scoped: readonly IntentField[], now: number): ChoicesResult {
  const wanted = scoped.map((f) => fieldTerms(labelWords(snap, f)));
  const kinds = new Set(scoped.flatMap((f) => [...fieldKinds(labelWords(snap, f))]));
  const excluded = new Set(snap.excluded);
  // No ledger: this only finds which windows hold such values, locally; nothing here goes to a model.
  const { candidates } = collectCandidates(model, snap.window.window.windowId, { now, exclude: excluded });
  const holds = new Set(
    candidates
      .filter((c) => (c.kind !== null && kinds.has(c.kind)) || (c.labelled === true && wanted.some((t) => overlap(t, fieldTerms([c.context])) > 0)))
      .map((c) => c.source.windowId),
  );
  const windows = snap.windows.filter((w) => holds.has(w.windowId) && !excluded.has(w.windowId));
  const memory = snap.memory.length > 0;
  if (windows.length === 0 && !memory) return no("no open window holds a value the fields in scope want, and Caret was told nothing");
  const options: Choice[] = windows.slice(0, MAX_ASK_OPTIONS - (memory ? 1 : 0)).map((w, i) => ({ option: { kind: "window", id: `o${i + 1}`, app: w.app, title: w.title }, fixes: { source: { kind: "window", windowId: w.windowId } } }));
  if (memory) options.push({ option: { kind: "memory", id: `o${options.length + 1}` }, fixes: { source: { kind: "memory" } } });
  return { choices: { part: "source", text: ASKS.source, pick: "one", options }, why: null };
}

/** The user, then each person the instruction names, then each sender an open mail shows, once each. */
function personChoices(snap: IntentSnapshot): ChoicesResult {
  const all = [...snap.persons.map((p) => p.span), ...snap.windows.flatMap((w) => (w.from === null ? [] : [w.from]))].map((n) => n.trim()).filter((n) => n !== "");
  // "Ines" in the instruction and "Ines Lindqvist" on a mail are one person: a name whose words begin a longer one goes.
  const words = (n: string): string[] => n.toLowerCase().split(/\s+/u);
  const within = (a: string, b: string): boolean => a.length < b.length && words(a).every((w, i) => words(b)[i] === w);
  const names: string[] = [];
  for (const t of all) if (!all.some((o) => within(t, o)) && !names.some((x) => x.toLowerCase() === t.toLowerCase())) names.push(t);
  if (names.length === 0) return no("no one is named in the instruction or on screen");
  const options: Choice[] = [{ option: { kind: "you", id: "o1" }, fixes: { person: { kind: "user" } } }];
  for (const name of names.slice(0, MAX_ASK_OPTIONS - 1)) options.push({ option: { kind: "person", id: `o${options.length + 1}`, name }, fixes: { person: { kind: "person", name } } });
  return { choices: { part: "person", text: ASKS.person, pick: "one", options }, why: null };
}
