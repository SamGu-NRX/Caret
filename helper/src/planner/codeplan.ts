import { Disclosure, type Minted, type ModelText } from "../privacy/disclosure.ts";
import { savedValuesOf } from "../fill/alternate.ts";
import { instructionForModel, instructionView } from "../fill/redact.ts";
import { viewOf } from "../fill/candidates.ts";
// Ask with natural phrasing (Q1 bugs 3 and 4). When the deterministic planner cannot ground an instruction
// ("fill the rest of this from my note", "my name and email please": it asks Jev about the fields the
// instruction names, and 7 of Q1's 10 instructions ended as unsure or nothing to do), the code-mode writer
// (writer/) writes a short program and the sandbox (codemode/) runs it against one frozen snapshot of the
// window: its fields as target refs and the values Caret may write as value refs. The program can only pick
// refs; code turns the picked pairs into the planner's own plan of field writes, and validatePlan checks it
// exactly as it checks the deterministic planner's: every value traces to a window, memory or the
// instruction, and fits its field's kind (a sentence is never a date). Nothing runs until the host accepts the
// plan, as before. A press, a wait or a question in the program is refused here: generated programs only
// fill (plan section 5, "Unknown presses remain handoffs"; this batch hands off none).
import type { Authority, DocumentReader } from "../fill/ask-scope.ts";
import { createHash } from "node:crypto";
import type { ScreenModel, WindowState } from "../model.ts";
import { unitKey, unitsHolding } from "../fill/note-unit.ts";
import { describeCandidate, generateCandidates, mintCandidate, type Candidate } from "../fill/candidates.ts";
import { asksCountry, fieldPart, namePart, splitAddress, splitName } from "../fill/derive.ts";
import { fieldKinds, isNameLike } from "../fill/kinds.ts";
import { candidateProvenance, OWNER_CRITERIA, WHOSE_CRITERIA, WHOSE_CUTOFF } from "../fill/fill.ts";
import type { CheckedValue, Provenance } from "../fill/contract.ts";
import type { AskJev } from "../fill/jev.ts";
import type { Plan, Step, WindowSel } from "../executor/schema.ts";
import { runCodePlan } from "../codemode/sandbox.ts";
import { jevChooser } from "../codemode/jev-chooser.ts";
import type { PlanningSnapshot } from "../codemode/types.ts";
import type { WriterPort } from "../writer/port.ts";
import { WRITER_MAX_OUTPUT_TOKENS } from "../writer/config.ts";
import { instructionValues } from "./spans.ts";
import { allRefused, asksToFillForm, byRelevance, mintFieldName, mintWrites, namesShortLabel, outrankedFields, PLAN_CUTOFF, relevance, writableFields, type Field, type PlanDraft, type PlannerMemory } from "./planner.ts";
import type { JevRequest } from "../fill/jev.ts";
import { PlannerError, validatePlan, type PlanContext } from "./validate.ts";
import type { MemoryValue } from "./trace.ts";
import type { Snippet } from "../privacy.ts";
import { PAGE_WINDOW_KIND } from "../engines/windows.ts";
import { jevFailedError } from "./says.ts";

export interface CodePlanOptions {
  writer: WriterPort;
  askJev: AskJev;
  /** The plan's id, which is also the offer's key, the task id, and the writer request's disclosure id. */
  offerKey: string;
  /** The window the instruction is about: the host's, or the deterministic planner's choice. */
  windowId: string;
  now?: number;
  signal?: AbortSignal;
  /** I2: the fields the writer is shown, by node key (PlanTaskOptions.fields), which saves it choosing others; absent, every writable field. */
  fields?: readonly string[];
  /**
   * I2: who authorizes the plan's writes (ask-scope.ts Authority): an Ask's scope, which the write contract and
   * validatePlan enforce; absent, this plan request itself (kind "plan", by its offer key).
   */
  authority?: Authority;
  /** Which page document a window shows now (the owning helper's page engine), for an Ask's scope. */
  documentOf?: DocumentReader | null;
}

/** What the writer cost and wrote, for the proposal's log and the scoreboard. */
export interface WriterUse {
  /** The ledger's declarations the writer request carried (disclosureFor). */
  disclosed: readonly Snippet[];
  model: string;
  latencyMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  program: string | null;
}

export type CodePlanDraft = PlanDraft & { writer: WriterUse };

/** Values one snapshot lists at most. Assumed, like the planner's MAX_PLAN_VALUES. */
const MAX_VALUES = 40;

const digest = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** A value a program may write: its text, how the writer reads it, the window that shows it (or null), and whose it is when code knows. */
export interface Value {
  text: string;
  /** How the writer reads it, minted by the request's Disclosure. */
  display: ModelText;
  window: WindowState | null;
  owner: "user" | "other" | null;
  /** The node of `window` the value was read from (D2-06 rechecks it before a goal segment runs); null for the instruction and memory. */
  key: string | null;
  /** The memory entry it was copied from, as Step.memory names it ("about-1", or "about-1#first" for a part). */
  memory: string | null;
  /** W2: where it was read, as the write contract carries it (fill/contract.ts). */
  provenance: Provenance;
}

/**
 * The values a program may write: the instruction's own spans and memory (with a remembered name's parts),
 * listed with the form; then each other window's candidates and the parts code splits from a person's name or
 * an address, by window, most recent first, in at most MAX_SOURCE_WINDOWS windows, as the plan API's
 * readWindow(windowRef) shapes it. A value whose display the ledger refuses is left out.
 */
export function valueList(instruction: string, model: ScreenModel, w: WindowState, memory: readonly MemoryValue[], ledger: Disclosure, now: number): Value[] {
  const d = ledger;
  const out: Value[] = [];
  const retainedValues = new Set(instructionView(instruction).retained.flatMap(instructionValues));
  const LEFT = "[a field Caret leaves to you]";
  /** `said` mints the display; what the display was before SC1 is the oracle, so a display redaction changes is not listed. */
  const add = (text: string, said: () => ModelText | null, display: string, win: WindowState | null, owner: Value["owner"], provenance: Provenance, key: string | null = null, memoryRef: string | null = null): void => {
    // Preserve the local value ref for refusal, but disclose no span removed with a forbidden clause.
    const withheld = provenance.kind === "instruction" && !retainedValues.has(text);
    const safe = withheld ? LEFT : instructionForModel(display);
    if (out.length >= MAX_VALUES || out.some((v) => v.text === text)) return;
    const m = withheld ? d.own(LEFT) : safe === display ? said() : null;
    if (m === null) return;
    out.push({ text, display: d.cut(m, 400), window: win, owner, key, memory: memoryRef, provenance });
  };
  const spans = instructionValues(instruction);
  if (ledger.plan(spans.map((s) => (retainedValues.has(s) ? instructionForModel(s) : LEFT)))) {
    for (const s of spans) {
      add(s, () => {
        const m = d.instructionSpan(instruction, s);
        return m === null ? null : d.t`"${m}" (written in the instruction)`;
      }, `"${s}" (written in the instruction)`, null, null, { kind: "instruction", span: s });
    }
  }
  for (const m of memory) {
    if (!ledger.plan([m.text, m.label])) continue;
    // Memory holds people as well as the user (helper.ts plannerMemory): whose an entry is comes from the entry.
    const owner = m.whose ?? null;
    const whose = owner === "user" ? d.own("the user's") : owner === "other" ? d.own("someone else's") : d.own("a");
    const entry: Provenance = { kind: "memory", id: m.id, label: m.label, part: null, whose: owner };
    const text = d.memoryText(m.label, m.text);
    const label = d.memoryText(null, m.label);
    add(m.text, () => (text === null || label === null ? null : d.t`"${text}" (${whose} ${label}, from memory)`), `"${m.text}" (${whose} ${m.label}, from memory)`, null, owner, entry, null, m.id);
    const s = /\bname\b/i.test(m.label) || owner === "other" ? splitName(m.text) : null;
    if (s?.kind === "split") {
      for (const [part, t] of [["first name", s.first], ["middle name", s.middle], ["last name", s.last]] as const) {
        if (t === null) continue;
        add(t, () => {
          const v = text === null ? null : d.derived(text, t);
          return v === null || label === null ? null : d.t`"${v}" (the ${d.own(part)} in ${whose} ${label}, from memory)`;
        }, `"${t}" (the ${part} in ${whose} ${m.label}, from memory)`, null, owner, { kind: "derived", how: "namePart", base: entry, also: null }, null, `${m.id}#${part.split(" ")[0]}`);
      }
    }
  }
  const cands = generateCandidates(model, w.window.windowId, MAX_VALUES, now, ledger);
  const windows = [...new Set(cands.map((c) => c.source.windowId))].slice(0, MAX_SOURCE_WINDOWS);
  /** A part of a candidate, said as "<the part> of/in <the candidate's line>". */
  const partOf = (c: Candidate, v: string, say: (value: ModelText, whole: ModelText) => ModelText): ModelText | null => {
    const whole = mintCandidate(d, model, c);
    const base = d.again(c.text);
    const value = base === null ? null : d.derived(base, v);
    return whole === null || value === null ? null : say(value, whole);
  };
  for (const id of windows) {
    const win = viewOf(model, id) ?? null;
    if (win === null) continue;
    const mine = cands.filter((c) => c.source.windowId === id);
    for (const c of mine) add(c.text, () => mintCandidate(d, model, c), describeCandidate(c), win, null, candidateProvenance(model, c), c.source.nodeKey);
    for (const c of mine) {
      const parts = splitAddress(c.text);
      if (parts !== null) for (const [k, v] of Object.entries(parts)) if (v !== undefined) add(v, () => partOf(c, v, (value, whole) => d.t`"${value}" (the ${d.id(k)} of ${whole})`), `"${v}" (the ${k} of ${describeCandidate(c)})`, win, null, { kind: "derived", how: "addressPart", base: candidateProvenance(model, c), also: null }, c.source.nodeKey);
      const name = c.context !== null && /\bname\b/i.test(c.context) && isNameLike(c.text, c.context) ? splitName(c.text) : null;
      if (name?.kind === "split") for (const part of ["first", "middle", "last"] as const) {
        const t = namePart(name, part);
        if (t !== null) add(t, () => partOf(c, t, (value, whole) => d.t`"${value}" (the ${d.own(part)} name in ${whole})`), `"${t}" (the ${part} name in ${describeCandidate(c)})`, win, null, { kind: "derived", how: "namePart", base: candidateProvenance(model, c), also: null }, c.source.nodeKey);
      }
    }
  }
  return out;
}

/** Windows besides the form whose values one plan request lists: the API's four readWindow calls, the form's included. */
const MAX_SOURCE_WINDOWS = 3;

/** Plans an instruction with the code-mode writer. Throws PlannerError with the failing check's code. */
export async function planWithCode(instruction: string, model: ScreenModel, memory: PlannerMemory, o: CodePlanOptions): Promise<CodePlanDraft> {
  const now = o.now ?? Date.now();
  const w = viewOf(model, o.windowId);
  if (w === undefined) throw new PlannerError("unseenWindow", `window ${o.windowId} is not open`);
  const all = writableFields(w).filter((f) => o.fields === undefined || o.fields.includes(f.node.key));
  if (all.length === 0) throw new PlannerError("nothingToDo", `'${w.window.title}' has no field Caret can write`);
  const ledger = new Disclosure(model);
  if (!ledger.plan([instructionForModel(instruction)])) throw new PlannerError("privacy", "your instruction quotes more of an open window than one request may carry");
  // The title as the writer sees it, cut to the snapshot's 200 characters, is what the ledger declares (fix-check review).
  const title = w.window.title.slice(0, 200);
  if (!ledger.take(w, "descriptor", [title])) throw new PlannerError("privacy", `'${title}' is longer than one request may carry`);
  // A form window gives a request less than half its text (privacy.ts), which may not hold every field's name:
  // the fields the instruction names go first, then the rest in document order, as the planner takes them.
  const fields = byRelevance(instruction, all).filter((f) => ledger.take(w, "descriptor", [f.name]));
  if (fields.length === 0) throw new PlannerError("privacy", `no field name of '${w.window.title}' fits what one request may carry`);
  const d = ledger;
  const names = new Map(fields.map((f) => [f, mintFieldName(d, w, f)]));
  const targets = fields.flatMap((f, i) => {
    const label = names.get(f);
    return label === null || label === undefined ? [] : [{ ref: d.id(`t${i + 1}`), label, kind: d.id(fieldPart(f.label) ?? "textField"), canFill: true, options: [], allowedPressEffects: [] }];
  });
  const titleText = d.descriptor(w, title) ?? d.own("");
  const memoryValues = memory.values();
  const values = valueList(instruction, model, w, memoryValues, ledger, now);
  if (values.length === 0) throw new PlannerError("nothingToDo", "nothing on screen, in memory or in your instruction could go in a field");
  // The form's snapshot holds its fields with the instruction's and memory's values; each source window is a
  // snapshot of its own, read by readWindow(window). Value refs are numbered across them.
  const ref = (v: Value): string => `v${values.indexOf(v) + 1}`;
  const origin = (v: Value, snap: string) => ({ kind: d.own("span"), snapshot: d.id(snap), source: d.id(v.window?.window.windowId ?? "instruction"), startUTF16: 0, endUTF16: v.text.length, digest: d.id(digest(v.text)) });
  const sourceWindows = [...new Set(values.flatMap((v) => (v.window === null ? [] : [v.window])))];
  const snapshots: Minted<PlanningSnapshot>[] = [
    {
      snapshot: d.id("s1"),
      window: d.id("w1"),
      revision: d.id(digest(JSON.stringify([...w.nodes.keys()]))),
      title: titleText,
      targets,
      values: values.filter((v) => v.window === null).map((v) => ({ ref: d.id(ref(v)), display: v.display, origin: origin(v, "s1") })),
      questions: [],
    },
    ...sourceWindows.map((sw, i): Minted<PlanningSnapshot> => ({
      snapshot: d.id(`s${i + 2}`),
      window: d.id(`w${i + 2}`),
      revision: d.id(digest(JSON.stringify([...sw.nodes.keys()]))),
      // A source window's title went through the ledger whole, as each value's fact; past 200 characters it is left out here.
      title: sw.window.title.length <= 200 ? (d.descriptor(sw, sw.window.title) ?? d.own("")) : d.own(""),
      targets: [],
      values: values.filter((v) => v.window === sw).map((v) => ({ ref: d.id(ref(v)), display: v.display, origin: origin(v, `s${i + 2}`) })),
      questions: [],
    })),
  ];
  // What the writer request discloses: the ledger's declarations that its prompt carries, recorded with the
  // draft under the request's disclosure id (the offer key). Every screen text in the snapshots came through
  // the ledger: field names and the title by take, values by the generator's takes, memory and the
  // instruction by plan (review: the writer call carried only an id).
  const writerDisclosure = disclosureFor(ledger.declared().snippets, snapshots, instruction);
  let written: Awaited<ReturnType<WriterPort["write"]>>;
  try {
    written = await o.writer.write(ledger.seal({ kind: "plan", disclosureId: o.offerKey, disclosed: writerDisclosure, input: { goal: d.slice(d.instruction(instruction), 500), snapshots }, maxOutputTokens: WRITER_MAX_OUTPUT_TOKENS, signal: o.signal ?? AbortSignal.timeout(15_000) }));
  } catch (e) {
    throw new PlannerError("unavailable", `the plan writer failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
  const use: WriterUse = { model: written.model, latencyMs: written.latencyMs, costUsd: written.costUsd, inputTokens: written.inputTokens, outputTokens: written.outputTokens, program: written.output.program, disclosed: writerDisclosure };
  if (written.output.program === null) throw new PlannerError("unsure", "the plan writer wrote no program");
  const ran = await runCodePlan(written.output.program, snapshots, jevChooser(o.askJev, instruction, ledger), o.signal === undefined ? {} : { signal: o.signal });
  if (!ran.ok) throw new PlannerError("unsure", `the plan program was refused (${ran.kind}): ${ran.detail.slice(0, 200)}`);
  const other = ran.plan.steps.filter((s) => s.kind !== "fill");
  if (other.length > 0) throw new PlannerError("unsupportedStep", `the plan program asked to ${other[0]?.kind}, and a written plan only fills fields`);
  const fills = ran.plan.steps.flatMap((s) => (s.kind === "fill" ? [s] : []));
  if (fills.length === 0) throw new PlannerError("nothingToDo", "the plan program found nothing to fill");
  // The writer chose the fields; code checks it chose only fields the instruction asks about. A field the
  // instruction names by its words, or any field when it asks to fill the form, stands; any other must be
  // confirmed by Jev, both asks agreeing at PLAN_CUTOFF that the instruction asks to change it, or its write is
  // dropped. Live, the writer filled Email, Phone and Student ID for "sign me up for the saturday section and
  // put my birthday in" (B24 Ask scoreboard, asks-dev-1); the deterministic planner has the same rule (B18).
  // A field the instruction rules out by naming another section's field of the same label is never written:
  // the planner leaves it (outrankedFields), and the writer cannot override that (review: "fill billing city"
  // wrote Shipping City).
  const outranked = outrankedFields(instruction, all);
  const picked = fills.map((f) => ({ f, field: fields[Number(f.target.slice(1)) - 1] })).filter((p) => p.field === undefined || !outranked.has(p.field.node.key));
  if (picked.length === 0) throw new PlannerError("nothingToDo", "the plan program filled only fields your instruction rules out");
  const unnamed = asksToFillForm(instruction) ? [] : picked.flatMap((p) => (p.field !== undefined && relevance(instruction, p.field.name) === 0 && !namesShortLabel(instruction, p.field.label) ? [p.field] : []));
  const confirmed = await confirmFields(instruction, unnamed, o.askJev, ledger, w);
  const kept = picked.filter((p) => p.field === undefined || !unnamed.includes(p.field) || confirmed.has(p.field.node.key)).map((p) => p.f);
  if (kept.length === 0) throw new PlannerError("nothingToDo", `the plan program filled only fields the instruction does not ask about (${unnamed.map((f) => f.name).join(", ")})`);
  // Jev checks each write the writer chose, for a field that takes a person's details: that the field and the value
  // are the same person's (fill's owner veto); a write that fails is dropped. Live, the writer put the user's own
  // phone in Reference phone and an RSVP sender's email in the user's Email (asks-dev-3). Whether the value is exactly
  // the field's is the write contract's verifier, below (W2: it replaced this check's yes/no value question).
  // HA2 review 2, item 1: each value's notes are read once, before the owner check is sent, and bound as read.
  const disclosed = new Map(kept.flatMap((f) => {
    const value = values[Number(f.value.slice(1)) - 1];
    return value === undefined ? [] : [[f.ref, sourceNotes(model, value.provenance, w.window.windowId)] as const];
  }));
  const { dropped, jev: owners } = await verifyWrites(instruction, kept.flatMap((f) => {
    const field = fields[Number(f.target.slice(1)) - 1];
    const value = values[Number(f.value.slice(1)) - 1];
    const name = field === undefined ? null : (names.get(field) ?? null);
    return field === undefined || value === undefined || name === null ? [] : [{ key: f.ref, field: { name, label: field.label }, value: { ...value, notes: disclosed.get(f.ref) ?? null } }];
  }), o.askJev, ledger);
  const unvetoed = kept.filter((f) => !dropped.has(f.ref));
  if (unvetoed.length === 0) throw new PlannerError("unsure", "Jev said every value the plan program chose is another person's");
  // W2: each value the program chose meets the write contract in its field, with where it was read (fill/contract.ts);
  // a value it refuses is dropped, as an unconfirmed one was before W2, and a plan left with none is refused.
  const pairOf = (f: (typeof unvetoed)[number]): { field: Field; value: Value } | null => {
    const field = fields[Number(f.target.slice(1)) - 1];
    const value = values[Number(f.value.slice(1)) - 1];
    return field === undefined || value === undefined || !/^t\d+$/.test(f.target) || !/^v\d+$/.test(f.value) ? null : { field, value };
  };
  for (const f of unvetoed) if (pairOf(f) === null) throw new PlannerError("schema", `the plan program named ${f.target} and ${f.value}, which the snapshot did not list`);
  const minted = await mintWrites(unvetoed.map((f) => {
    const { field, value } = pairOf(f) as { field: Field; value: Value };
    // HA2 review P1: a person's value is bound to the notes its owner check showed, rechecked before each write.
    const notes = personalField(field.label) ? (disclosed.get(f.ref) ?? null) : null;
    return { key: f.ref, w, node: field.node, name: field.name, text: value.text, provenance: notes === null ? value.provenance : bindNotes(value.provenance, notes, w.window.windowId), owner: value.owner };
  }), { askJev: o.askJev, ledger, instruction, now, authority: o.authority ?? { kind: "plan", offerKey: o.offerKey }, documentOf: o.documentOf ?? null }, savedValuesOf(memoryValues));
  const checkedFills = unvetoed.filter((f) => minted.mints.has(f.ref));
  if (checkedFills.length === 0) throw allRefused(minted.refused);
  const sel: WindowSel = { bundleId: w.app.bundleId, title: w.window.title, ...(w.window.number === undefined ? {} : { number: w.window.number }), ...(w.window.kind === PAGE_WINDOW_KIND ? { page: true as const, windowId: w.window.windowId } : {}) };
  const slots: Record<string, string> = {};
  const slotNames: Record<string, string> = {};
  const mints = new Map<string, CheckedValue>();
  const seenTargets = new Set<string>();
  const steps: Step[] = checkedFills.map((f, i) => {
    const { field, value } = pairOf(f) as { field: Field; value: Value };
    if (seenTargets.has(field.node.key)) throw new PlannerError("schema", `the plan program fills ${field.name} twice`);
    seenTargets.add(field.node.key);
    const slot = `v${i + 1}`;
    slots[slot] = value.text;
    slotNames[slot] = `the value for ${field.name}`;
    mints.set(slot, minted.mints.get(f.ref) as CheckedValue);
    return { says: `${field.name} holds {{${slot}}}`, end: { kind: "valueEquals", window: sel, target: { key: field.node.key, describe: `the ${field.name} field` }, value: `{{${slot}}}` } };
  });
  const plan: Plan = { id: o.offerKey, title: instruction.replace(/\s+/g, " ").trim().slice(0, 100), slots: slotNames, steps };
  const ctx: PlanContext = { model, memory: memoryValues, instruction, origin: o.authority ?? { kind: "plan", offerKey: o.offerKey }, documentOf: o.documentOf ?? null };
  const checked = validatePlan(plan, slots, ctx, mints);
  if (checked.window.window.windowId !== w.window.windowId) throw new PlannerError("unknownWindow", `'${w.window.title}' closed while Caret planned, and another window took its title`);
  const sources: Record<string, string> = {};
  for (const wr of checked.writes) if (wr.trace.from === "window") sources[`v${wr.step + 1}`] = wr.trace.windowId;
  const withMemory = plan.steps.map((s, i) => {
    const t = checked.writes.find((wr) => wr.step === i)?.trace;
    return t?.from === "memory" ? { ...s, memory: t.part === undefined ? t.id : `${t.id}#${t.part}` } : s;
  });
  const finalPlan: Plan = { ...plan, steps: withMemory, ...(Object.keys(sources).length === 0 ? {} : { sources }) };
  return {
    plan: finalPlan,
    slots,
    checked,
    answers: {},
    withheld: [],
    // HA2: the owner checks' requests count, as the chooser's do.
    jev: { calls: ran.stats.chooseCalls + owners.calls, costUsd: owners.costUsd, latencyMs: owners.latencyMs },
    writer: use,
  };
}

const ASKS_ABOUT_WORDINGS = [
  (m: Disclosure, instr: ModelText, d: ModelText): ModelText => m.t`The user asked: "${instr}". Does that ask to fill in or change this field? ${d}`,
  (m: Disclosure, instr: ModelText, d: ModelText): ModelText => m.t`Field: ${d} Instruction: "${instr}". Is this field one the instruction asks to fill or change?`,
] as const;
const ASKS_ABOUT = { yes: "Yes: the instruction asks for this field.", no: "No: the instruction does not ask about this field." } as const;

/**
 * The fields of `unnamed` that Jev, asked twice with different wordings, agrees at PLAN_CUTOFF the instruction
 * asks to change. Their descriptors were taken through the ledger with the window's other field names.
 */
async function confirmFields(raw: string, unnamed: readonly Field[], askJev: AskJev, ledger: Disclosure, w: WindowState): Promise<Set<string>> {
  if (unnamed.length === 0) return new Set();
  const d = ledger;
  const instruction = d.instruction(raw);
  const named = unnamed.flatMap((f) => {
    const name = mintFieldName(d, w, f);
    return name === null ? [] : [{ f, name }];
  });
  const declared = ledger.declared();
  const req = (wording: 0 | 1): JevRequest =>
    sentOnly(d.seal({
      purpose: "codeplan.asksAbout",
      state: { instruction, task: d.own("Caret drafted field writes for the user's instruction and checks that each field is one the instruction asks about.") },
      questions: Object.fromEntries(named.map(({ name }, i) => [`f${i + 1}`, { type: "choice" as const, instructions: ASKS_ABOUT_WORDINGS[wording](d, instruction, name), criteria: d.ownRecord(ASKS_ABOUT) }])),
      snippets: declared.snippets,
      charged: declared.charged,
    }));
  let r: Awaited<ReturnType<AskJev>>[];
  try {
    r = await Promise.all([askJev(req(0)), askJev(req(1))]);
  } catch (e) {
    throw jevFailedError(e);
  }
  const out = new Set<string>();
  named.forEach(({ f }, i) => {
    const [a, b] = [r[0]?.answers[`f${i + 1}`], r[1]?.answers[`f${i + 1}`]];
    if (a?.choice === "yes" && b?.choice === "yes" && Math.min(a.confidence, b.confidence) >= PLAN_CUTOFF) out.add(f.node.key);
  });
  return out;
}

/** A field that takes a person's details: a name or a part of one, an email, a phone, an address or a part of one. */
export function personalField(label: string): boolean {
  // HA2 (lead decision 2): a country is a part of a person's address too.
  return fieldPart(label) !== null || asksCountry(label) || [...fieldKinds([label])].some((k) => k === "email" || k === "phone" || k === "address");
}

/**
 * HA2: a whole text that holds a value (fill/note-unit.ts NoteUnit, complete), with its window's id. verifyWrites mints
 * it through its request's Disclosure (onScreen). No window is held, so a goal inventory that freezes notes keeps only these.
 */
export interface SourceNote {
  windowId: string;
  /** The text area it is, or null for its whole window (note-unit.ts (c)). */
  nodeKey: string | null;
  text: string;
  digest: string;
}

/** HA2: the window nodes a value was read from, with the span read there: a window provenance's, a derived value's base's and extra source's. */
export function sourceRefs(pr: Provenance): { windowId: string; nodeKey: string; span: string }[] {
  if (pr.kind === "window") return [{ windowId: pr.windowId, nodeKey: pr.nodeKey, span: pr.span }];
  if (pr.kind !== "derived") return [];
  return [...sourceRefs(pr.base), ...(pr.also === null ? [] : sourceRefs(pr.also))];
}

/**
 * HA2: the notes an owner question about a value must show (fill/note-unit.ts, the lead's rules on the review): every
 * unit on screen that holds each span it was read from, (a) all of them, (c) a text area or its whole window, never the
 * form `form`. Null, which withholds a value from a field that wants the user's details, when a source is gone or (b) a
 * unit redaction cut. Empty for a value from the instruction or memory, which no owner question judges.
 */
export function sourceNotes(model: ScreenModel, pr: Provenance, form: string | null): SourceNote[] | null {
  const out = new Map<string, SourceNote>();
  for (const r of sourceRefs(pr)) {
    const units = unitsHolding(model, r.span, form, r);
    if (units === null || units.some((u) => !u.complete)) return null;
    for (const u of units) out.set(unitKey(u), { windowId: u.windowId, nodeKey: u.nodeKey, text: u.text, digest: u.digest });
  }
  return [...out.values()];
}

/**
 * HA2 review P1: `pr` with every window source bound to the notes its owner judgement showed (contract.ts Provenance
 * owned), so the recheck before each write refuses it once any of them changes. `notes` are the units that held each
 * span (sourceNotes, or a goal's frozen ones).
 */
export function bindNotes(pr: Provenance, notes: readonly SourceNote[], form: string | null): Provenance {
  if (pr.kind === "derived") return { ...pr, base: bindNotes(pr.base, notes, form), also: pr.also === null ? null : bindNotes(pr.also, notes, form) };
  if (pr.kind !== "window") return pr;
  const units = notes.filter((n) => n.text.replace(/\s+/gu, " ").includes(pr.span.replace(/\s+/gu, " ").trim()) || (n.windowId === pr.windowId && (n.nodeKey === null || n.nodeKey === pr.nodeKey)));
  return { ...pr, owned: { form, units: units.map((u) => ({ windowId: u.windowId, nodeKey: u.nodeKey, digest: u.digest })) } };
}

/**
 * HA2: each value's notes as they are now (sourceNotes), by the value's ref, or null for a value whose notes cannot be
 * shown: what a goal inventory freezes at plan time for its gate's owner questions (goals/gates.ts jevGate). A value
 * with no entry is withheld there from a field that wants the user's details.
 */
export function frozenNotes(model: ScreenModel, values: Iterable<{ ref: string; provenance?: Provenance; source: { windowId: string; key: string } | null }>, form: string | null): Map<string, readonly SourceNote[] | null> {
  const out = new Map<string, readonly SourceNote[] | null>();
  for (const v of values) {
    const pr: Provenance | null = v.provenance ?? (v.source === null ? null : { kind: "window", windowId: v.source.windowId, nodeKey: v.source.key, app: "", title: "", span: "", label: null, line: null, partOf: null, context: null, lines: [], sentences: [] });
    if (pr !== null) out.set(v.ref, sourceNotes(model, pr, form));
  }
  return out;
}

/** What verifyWrites' requests cost, for a draft's or a goal's Jev usage. */
export interface CheckUse {
  calls: number;
  costUsd: number;
  latencyMs: number;
}

const VERIFY = { yes: "Yes: this is the value this field asks for.", no: "No: it is another value, another person's, or not what this field asks for." } as const;

/**
 * One write Jev checks: the field by its name (taken through the ledger) and its label, and the value as the writer
 * read it, with the window it came from (null for the instruction and memory) and whose it is when code knows. A
 * code plan's Field and Value fit as they are; a goal's step (goals/gates.ts) passes the same parts.
 */
export interface WriteToVerify {
  key: string;
  /** `name` as the request's Disclosure minted it; `label`, code's reading of what the field takes, never sent. */
  field: { name: ModelText; label: string };
  /**
   * HA2: `notes` are the whole texts a window value was read from (sourceNotes, or a goal inventory's frozen ones), which
   * both owner questions must show for the owner judgement to count; null when a source could not be read. A window
   * value given no notes is treated as unread: it never passes.
   */
  value: { display: ModelText; window: unknown; owner: "user" | "other" | null; notes: readonly SourceNote[] | null };
  /**
   * Whether Jev is asked if the value belongs in the field (the `c` question). W2: a page write's exactness is the
   * write contract's verifier (fill/contract.ts checkValues), so only a calendar event, which no page step writes,
   * still asks it (goals/gates.ts jevGate); every page write asks only the whose and owner questions.
   */
  askValue?: boolean;
}

/**
 * The writes, by step ref, that Jev does not confirm: for a write that asks its value (askValue; since W2 only a calendar
 * event), asked twice with different wordings, the two asks must agree at PLAN_CUTOFF that it is the value the field
 * asks for. For a field that takes
 * a person's details, a write is also dropped when both asks agree the field wants one person's details and
 * the value is another's (fill.ts WHOSE_CRITERIA and OWNER_CRITERIA, at WHOSE_CUTOFF); a value from memory is
 * the user's, and one written in the instruction is the user's own choice.
 */
export async function verifyWrites(raw: string, writes: readonly WriteToVerify[], askJev: AskJev, ledger: Disclosure): Promise<{ dropped: Set<string>; jev: CheckUse }> {
  const d = ledger;
  const instruction = d.instruction(raw);
  // W2: nothing to ask when no write asks its value and none takes a person's details.
  if (writes.every((x) => x.askValue !== true && !personalField(x.field.label))) return { dropped: new Set(), jev: { calls: 0, costUsd: 0, latencyMs: 0 } };
  // HA2 (lead decision 3): fill's rule on this path. Both owner questions about a window value name the whole notes it
  // was read from, sent once in the state (source_notes) and charged to their windows' owner-note allotments; a value whose
  // notes do not fit, or could not be read, is dropped below when its field wants the user's details.
  const notes = new Map<string, ModelText>();
  /** Each note's id ("note_1") as this request's Disclosure minted it. */
  const noteSaid = new Map<string, ModelText>();
  const noteIds = writes.map((x): string[] | null => {
    if (!personalField(x.field.label) || x.value.window === null) return [];
    if (x.value.notes === null || x.value.notes.length === 0) return null;
    const idOf = (text: string): string | undefined => [...notes].find(([, t]) => t === text)?.[0];
    // Minted as owner notes of windows this request was built over that still show them whole in their redacted views
    // (OUTPUT-LEDGER-SPEC section 8), all of a value's notes or none: a frozen note no window still shows is never sent.
    const fresh = [...new Set(x.value.notes.map((n) => n.text).filter((t) => idOf(t) === undefined))];
    const said = d.ownerNotesOnScreen(fresh);
    if (said === null) return null;
    said.forEach((s) => {
      // The id is a key of the request's state, which PV2 holds to identifiers (disclosure.ts KEY): "note_1", not "note 1".
      const id = `note_${notes.size + 1}`;
      notes.set(id, s);
      noteSaid.set(id, d.id(id));
    });
    return x.value.notes.map((n) => idOf(n.text)!);
  });
  const noteSays = (i: number): ModelText => {
    const ids = noteIds[i];
    return ids === null || ids === undefined || ids.length === 0 ? d.own("") : d.t` The whole text it was read from is ${d.join(ids.flatMap((id) => noteSaid.get(id) ?? []), " and ")} in source_notes; whose it is depends on all of that text.`;
  };
  const declared = ledger.declared();
  const req = (wording: 0 | 1): JevRequest => {
    const questions: JevRequest["questions"] = {};
    writes.forEach((x, i) => {
      // Every value is checked, from memory and the instruction too (review: a writer put the user's Personal
      // email in Work email unchecked). The field is named by its name, which went through the ledger; its
      // descriptor can hold a placeholder that did not.
      const name = x.field.name;
      const shown = x.value.display;
      if (x.askValue === true) questions[`c${i + 1}`] = {
        type: "choice",
        instructions: wording === 0 ? d.t`A form has the field '${name}'. Is this value the right one for it? ${shown} The user asked: "${instruction}".` : d.t`Value: ${shown} Field: '${name}'. The user asked: "${instruction}". Does this value belong in this field?`,
        criteria: d.ownRecord(VERIFY),
      };
      if (!personalField(x.field.label)) return;
      questions[`f${i + 1}`] = { type: "choice", instructions: wording === 0 ? d.t`The user asked: "${instruction}". A form has the field '${name}'. Whose details does this field ask for?` : d.t`Field: '${name}'. Instruction: "${instruction}". Is this field for the details of the user filling in the form, of someone else, or can you not tell?`, criteria: d.ownRecord(WHOSE_CRITERIA) };
      if (x.value.window !== null) questions[`v${i + 1}`] = { type: "choice", instructions: wording === 0 ? d.t`A value on the user's screen: ${shown}${noteSays(i)} Whose details is it?` : d.t`Whose details is this value, the user's or someone else's? ${shown}${noteSays(i)}`, criteria: d.ownRecord(OWNER_CRITERIA) };
    });
    const state = { instruction, task: d.own("Caret checks each value a drafted plan would write before offering the plan."), ...(notes.size === 0 ? {} : { source_notes: Object.fromEntries(notes) }) };
    return sentOnly(d.seal({ purpose: "plan.verify", state, questions, snippets: declared.snippets, charged: declared.charged }));
  };
  const reqs = [req(0), req(1)] as const;
  /** HA2: whether both requests, as built, show every note of write `i` in its owner question and carry it whole. */
  const shown = (i: number): boolean => {
    const ids = noteIds[i];
    if (ids === null || ids === undefined) return false;
    return reqs.every((q) => {
      const ins = String(q.questions[`v${i + 1}`]?.instructions ?? "");
      const sent = (q.state as { source_notes?: Record<string, string> }).source_notes ?? {};
      return (ids.length === 0 || ins.includes(`${ids.join(" and ")} in source_notes`)) && ids.every((id) => sent[id] === notes.get(id));
    });
  };
  let r: Awaited<ReturnType<AskJev>>[];
  try {
    r = await Promise.all([askJev(reqs[0]), askJev(reqs[1])]);
  } catch (e) {
    throw jevFailedError(e);
  }
  const agreed = (id: string, options: object, floor: number): string | null => {
    const [a, b] = [r[0]?.answers[id], r[1]?.answers[id]];
    return a !== undefined && b !== undefined && a.choice === b.choice && a.choice in options && Math.min(a.confidence, b.confidence) >= floor ? a.choice : null;
  };
  const out = new Set<string>();
  writes.forEach((x, i) => {
    if (x.askValue === true && agreed(`c${i + 1}`, VERIFY, PLAN_CUTOFF) !== "yes") return void out.add(x.key);
    if (!personalField(x.field.label)) return;
    const wants = agreed(`f${i + 1}`, WHOSE_CRITERIA, WHOSE_CUTOFF);
    const is = x.value.window === null ? x.value.owner : agreed(`v${i + 1}`, OWNER_CRITERIA, WHOSE_CUTOFF);
    if (wants !== null && is !== null && wants !== "unclear" && is !== "unclear" && wants !== is) return void out.add(x.key);
    // HA2: an owner judgement about a window value counts only when both questions showed its whole notes.
    if (wants === "user" && x.value.window !== null && !shown(i)) out.add(x.key);
  });
  return { dropped: out, jev: { calls: 2, costUsd: (r[0]?.costUsd ?? 0) + (r[1]?.costUsd ?? 0), latencyMs: Math.max(r[0]?.latencyMs ?? 0, r[1]?.latencyMs ?? 0) } };
}

/** Every string a request carries in its state and questions. */
function sentStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) sentStrings(x, out);
  return out;
}

/** A request with only the snippets it sends: a check asks about some fields and values, not all the ledger took. */
function sentOnly(req: JevRequest): JevRequest {
  const sent = sentStrings([req.state, req.questions]);
  return { ...req, snippets: req.snippets.filter((x) => sent.some((t) => t.includes(x.text))) };
}

/** The declarations a writer request's snapshots and goal carry. */
export function disclosureFor(snippets: readonly Snippet[], snapshots: readonly PlanningSnapshot[], instruction: string): Snippet[] {
  const sent = sentStrings([instructionForModel(instruction), snapshots.map((x) => [x.title, x.targets.map((t) => t.label), x.values.map((v) => v.display)])]);
  return snippets.filter((x) => sent.some((t) => t.includes(x.text)));
}
