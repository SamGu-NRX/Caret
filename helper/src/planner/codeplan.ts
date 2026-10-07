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
import { createHash } from "node:crypto";
import type { ScreenModel, WindowState } from "../model.ts";
import { describeCandidate, generateCandidates } from "../fill/candidates.ts";
import { fieldPart, namePart, splitAddress, splitName } from "../fill/derive.ts";
import { fieldKinds, isNameLike } from "../fill/kinds.ts";
import { writeMisfit } from "../fill/writable.ts";
import { OWNER_CRITERIA, WHOSE_CRITERIA, WHOSE_CUTOFF } from "../fill/fill.ts";
import { SnippetLedger, WINDOW_CHARS } from "../privacy.ts";
import type { AskJev } from "../fill/jev.ts";
import type { Plan, Step, WindowSel } from "../executor/schema.ts";
import { runCodePlan } from "../codemode/sandbox.ts";
import { jevChooser } from "../codemode/jev-chooser.ts";
import type { PlanningSnapshot } from "../codemode/types.ts";
import type { WriterPort } from "../writer/port.ts";
import { WRITER_MAX_OUTPUT_TOKENS } from "../writer/config.ts";
import { instructionValues } from "./spans.ts";
import { asksToFillForm, byRelevance, namesShortLabel, outrankedFields, PLAN_CUTOFF, relevance, writableFields, type Field, type PlanDraft, type PlannerMemory } from "./planner.ts";
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
  display: string;
  window: WindowState | null;
  owner: "user" | "other" | null;
  /** The node of `window` the value was read from (D2-06 rechecks it before a goal segment runs); null for the instruction and memory. */
  key: string | null;
  /** The memory entry it was copied from, as Step.memory names it ("about-1", or "about-1#first" for a part). */
  memory: string | null;
}

/**
 * The values a program may write: the instruction's own spans and memory (with a remembered name's parts),
 * listed with the form; then each other window's candidates and the parts code splits from a person's name or
 * an address, by window, most recent first, in at most MAX_SOURCE_WINDOWS windows, as the plan API's
 * readWindow(windowRef) shapes it. Each window's list is held to the writer's per-window budget (plan-prompt.ts).
 */
export function valueList(instruction: string, model: ScreenModel, w: WindowState, memory: readonly MemoryValue[], ledger: SnippetLedger, now: number, formRoom: number): Value[] {
  const out: Value[] = [];
  const used = new Map<WindowState | null, number>();
  const add = (text: string, display: string, win: WindowState | null, owner: Value["owner"], key: string | null = null, memoryRef: string | null = null): void => {
    const d = display.length <= 400 ? display : `${display.slice(0, 399)}…`;
    const room = win === null ? formRoom : WINDOW_CHARS - win.window.title.length;
    const u = used.get(win) ?? 0;
    if (out.length >= MAX_VALUES || out.some((v) => v.text === text) || u + d.length > room) return;
    used.set(win, u + d.length);
    out.push({ text, display: d, window: win, owner, key, memory: memoryRef });
  };
  const spans = instructionValues(instruction);
  if (ledger.plan(spans)) for (const s of spans) add(s, `"${s}" (written in the instruction)`, null, null);
  for (const m of memory) {
    if (!ledger.plan([m.text, m.label])) continue;
    // Memory holds people as well as the user (helper.ts plannerMemory): whose an entry is comes from the entry.
    const owner = m.whose ?? null;
    const whose = owner === "user" ? "the user's" : owner === "other" ? "someone else's" : "a";
    add(m.text, `"${m.text}" (${whose} ${m.label}, from memory)`, null, owner, null, m.id);
    const s = /\bname\b/i.test(m.label) || owner === "other" ? splitName(m.text) : null;
    if (s?.kind === "split") for (const [part, t] of [["first name", s.first], ["middle name", s.middle], ["last name", s.last]] as const) if (t !== null) add(t, `"${t}" (the ${part} in ${whose} ${m.label}, from memory)`, null, owner, null, `${m.id}#${part.split(" ")[0]}`);
  }
  const cands = generateCandidates(model, w.window.windowId, MAX_VALUES, now, ledger);
  const windows = [...new Set(cands.map((c) => c.source.windowId))].slice(0, MAX_SOURCE_WINDOWS);
  for (const id of windows) {
    const win = model.windows.get(id) ?? null;
    if (win === null) continue;
    const mine = cands.filter((c) => c.source.windowId === id);
    for (const c of mine) add(c.text, describeCandidate(c), win, null, c.source.nodeKey);
    for (const c of mine) {
      const parts = splitAddress(c.text);
      if (parts !== null) for (const [k, v] of Object.entries(parts)) if (v !== undefined) add(v, `"${v}" (the ${k} of ${describeCandidate(c)})`, win, null, c.source.nodeKey);
      const name = c.context !== null && /\bname\b/i.test(c.context) && isNameLike(c.text, c.context) ? splitName(c.text) : null;
      if (name?.kind === "split") for (const part of ["first", "middle", "last"] as const) {
        const t = namePart(name, part);
        if (t !== null) add(t, `"${t}" (the ${part} name in ${describeCandidate(c)})`, win, null, c.source.nodeKey);
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
  const w = model.windows.get(o.windowId);
  if (w === undefined) throw new PlannerError("unseenWindow", `window ${o.windowId} is not open`);
  const all = writableFields(w);
  if (all.length === 0) throw new PlannerError("nothingToDo", `'${w.window.title}' has no field Caret can write`);
  const ledger = new SnippetLedger(model.windows.values());
  if (!ledger.plan([instruction])) throw new PlannerError("privacy", "your instruction quotes more of an open window than one request may carry");
  // The title as the writer sees it, cut to the snapshot's 200 characters, is what the ledger declares (fix-check review).
  const title = w.window.title.slice(0, 200);
  if (!ledger.take(w, "descriptor", [title])) throw new PlannerError("privacy", `'${title}' is longer than one request may carry`);
  // A form window gives a request less than half its text (privacy.ts), which may not hold every field's name:
  // the fields the instruction names go first, then the rest in document order, as the planner takes them.
  const fields = byRelevance(instruction, all).filter((f) => ledger.take(w, "descriptor", [f.name]));
  if (fields.length === 0) throw new PlannerError("privacy", `no field name of '${w.window.title}' fits what one request may carry`);
  const targets = fields.map((f, i) => ({ ref: `t${i + 1}`, label: f.name, kind: fieldPart(f.label) ?? "textField", canFill: true, options: [], allowedPressEffects: [] }));
  const room = WINDOW_CHARS - title.length - targets.reduce((n, t) => n + t.label.length, 0);
  const memoryValues = memory.values();
  const values = valueList(instruction, model, w, memoryValues, ledger, now, room);
  if (values.length === 0) throw new PlannerError("nothingToDo", "nothing on screen, in memory or in your instruction could go in a field");
  // The form's snapshot holds its fields with the instruction's and memory's values; each source window is a
  // snapshot of its own, read by readWindow(window). Value refs are numbered across them.
  const ref = (v: Value): string => `v${values.indexOf(v) + 1}`;
  const origin = (v: Value, snap: string) => ({ kind: "span" as const, snapshot: snap, source: v.window?.window.windowId ?? "instruction", startUTF16: 0, endUTF16: v.text.length, digest: digest(v.text) });
  const sourceWindows = [...new Set(values.flatMap((v) => (v.window === null ? [] : [v.window])))];
  const snapshots: PlanningSnapshot[] = [
    {
      snapshot: "s1",
      window: "w1",
      revision: digest(JSON.stringify([...w.nodes.keys()])),
      title,
      targets,
      values: values.filter((v) => v.window === null).map((v) => ({ ref: ref(v), display: v.display, origin: origin(v, "s1") })),
      questions: [],
    },
    ...sourceWindows.map((sw, i): PlanningSnapshot => ({
      snapshot: `s${i + 2}`,
      window: `w${i + 2}`,
      revision: digest(JSON.stringify([...sw.nodes.keys()])),
      // A source window's title went through the ledger whole, as each value's fact; past 200 characters it is left out here.
      title: sw.window.title.length <= 200 ? sw.window.title : "",
      targets: [],
      values: values.filter((v) => v.window === sw).map((v) => ({ ref: ref(v), display: v.display, origin: origin(v, `s${i + 2}`) })),
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
    written = await o.writer.write({ kind: "plan", disclosureId: o.offerKey, disclosed: writerDisclosure, input: { goal: instruction.slice(0, 500), snapshots }, maxOutputTokens: WRITER_MAX_OUTPUT_TOKENS, signal: o.signal ?? AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new PlannerError("unavailable", `the plan writer failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
  const use: WriterUse = { model: written.model, latencyMs: written.latencyMs, costUsd: written.costUsd, inputTokens: written.inputTokens, outputTokens: written.outputTokens, program: written.output.program, disclosed: writerDisclosure };
  if (written.output.program === null) throw new PlannerError("unsure", "the plan writer wrote no program");
  const ran = await runCodePlan(written.output.program, snapshots, jevChooser(o.askJev, instruction), o.signal === undefined ? {} : { signal: o.signal });
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
  const confirmed = await confirmFields(instruction, unnamed, o.askJev, ledger);
  const kept = picked.filter((p) => p.field === undefined || !unnamed.includes(p.field) || confirmed.has(p.field.node.key)).map((p) => p.f);
  if (kept.length === 0) throw new PlannerError("nothingToDo", `the plan program filled only fields the instruction does not ask about (${unnamed.map((f) => f.name).join(", ")})`);
  // Jev checks each write the writer chose: that the value is what the instruction asks to put in that field,
  // both asks agreeing at PLAN_CUTOFF; and, for a field that takes a person's details, that the field and the
  // value are the same person's (fill's owner veto). A write that fails either is dropped. Live, the writer put
  // the user's own phone in Reference phone and an RSVP sender's email in the user's Email (asks-dev-3).
  const dropped = await verifyWrites(instruction, kept.flatMap((f) => {
    const field = fields[Number(f.target.slice(1)) - 1];
    const value = values[Number(f.value.slice(1)) - 1];
    return field === undefined || value === undefined ? [] : [{ key: f.ref, field, value }];
  }), o.askJev, ledger);
  const unvetoed = kept.filter((f) => !dropped.has(f.ref));
  if (unvetoed.length === 0) throw new PlannerError("unsure", "Jev did not confirm any value the plan program chose for its field");
  const sel: WindowSel = { bundleId: w.app.bundleId, title: w.window.title, ...(w.window.number === undefined ? {} : { number: w.window.number }), ...(w.window.kind === PAGE_WINDOW_KIND ? { page: true as const, windowId: w.window.windowId } : {}) };
  const slots: Record<string, string> = {};
  const slotNames: Record<string, string> = {};
  const seenTargets = new Set<string>();
  const steps: Step[] = unvetoed.map((f, i) => {
    const t = Number(f.target.slice(1)) - 1;
    const v = Number(f.value.slice(1)) - 1;
    const field = fields[t];
    const value = values[v];
    if (field === undefined || value === undefined || !/^t\d+$/.test(f.target) || !/^v\d+$/.test(f.value)) throw new PlannerError("schema", `the plan program named ${f.target} and ${f.value}, which the snapshot did not list`);
    if (seenTargets.has(field.node.key)) throw new PlannerError("schema", `the plan program fills ${field.name} twice`);
    seenTargets.add(field.node.key);
    // The kind check runs again in validatePlan; here it names the field, so a refusal says which.
    const bad = writeMisfit(value.text, { labelWords: [field.label] });
    if (bad !== null) throw new PlannerError("wrongKind", `${field.name}: ${bad}`);
    const slot = `v${i + 1}`;
    slots[slot] = value.text;
    slotNames[slot] = `the value for ${field.name}`;
    return { says: `${field.name} holds {{${slot}}}`, end: { kind: "valueEquals", window: sel, target: { key: field.node.key, describe: `the ${field.name} field` }, value: `{{${slot}}}` } };
  });
  const plan: Plan = { id: o.offerKey, title: instruction.replace(/\s+/g, " ").trim().slice(0, 100), slots: slotNames, steps };
  const ctx: PlanContext = { model, memory: memoryValues, instruction };
  const checked = validatePlan(plan, slots, ctx);
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
    jev: { calls: ran.stats.chooseCalls, costUsd: 0, latencyMs: 0 },
    writer: use,
  };
}

const ASKS_ABOUT_WORDINGS = [
  (instr: string, d: string): string => `The user asked: "${instr}". Does that ask to fill in or change this field? ${d}`,
  (instr: string, d: string): string => `Field: ${d} Instruction: "${instr}". Is this field one the instruction asks to fill or change?`,
] as const;
const ASKS_ABOUT = { yes: "Yes: the instruction asks for this field.", no: "No: the instruction does not ask about this field." } as const;

/**
 * The fields of `unnamed` that Jev, asked twice with different wordings, agrees at PLAN_CUTOFF the instruction
 * asks to change. Their descriptors were taken through the ledger with the window's other field names.
 */
async function confirmFields(instruction: string, unnamed: readonly Field[], askJev: AskJev, ledger: SnippetLedger): Promise<Set<string>> {
  if (unnamed.length === 0) return new Set();
  const declared = ledger.declared();
  const req = (wording: 0 | 1): JevRequest =>
    sentOnly({
      purpose: "codeplan.asksAbout",
      state: { instruction, task: "Caret drafted field writes for the user's instruction and checks that each field is one the instruction asks about." },
      questions: Object.fromEntries(unnamed.map((f, i) => [`f${i + 1}`, { type: "choice" as const, instructions: ASKS_ABOUT_WORDINGS[wording](instruction, f.name), criteria: { ...ASKS_ABOUT } }])),
      snippets: declared.snippets,
      charged: declared.charged,
    });
  let r: Awaited<ReturnType<AskJev>>[];
  try {
    r = await Promise.all([askJev(req(0)), askJev(req(1))]);
  } catch (e) {
    throw jevFailedError(e);
  }
  const out = new Set<string>();
  unnamed.forEach((f, i) => {
    const [a, b] = [r[0]?.answers[`f${i + 1}`], r[1]?.answers[`f${i + 1}`]];
    if (a?.choice === "yes" && b?.choice === "yes" && Math.min(a.confidence, b.confidence) >= PLAN_CUTOFF) out.add(f.node.key);
  });
  return out;
}

/** A field that takes a person's details: a name or a part of one, an email, a phone or an address. */
function personalField(label: string): boolean {
  return fieldPart(label) !== null || [...fieldKinds([label])].some((k) => k === "email" || k === "phone" || k === "address");
}

const VERIFY = { yes: "Yes: this is the value this field asks for.", no: "No: it is another value, another person's, or not what this field asks for." } as const;

/**
 * One write Jev checks: the field by its name (taken through the ledger) and its label, and the value as the writer
 * read it, with the window it came from (null for the instruction and memory) and whose it is when code knows. A
 * code plan's Field and Value fit as they are; a goal's step (goals/gates.ts) passes the same parts.
 */
export interface WriteToVerify {
  key: string;
  field: { name: string; label: string };
  value: { display: string; window: unknown; owner: "user" | "other" | null };
}

/**
 * The writes, by step ref, that Jev does not confirm: for a value from a window, asked twice with different
 * wordings, the two asks must agree at PLAN_CUTOFF that it is the value the field asks for. For a field that takes
 * a person's details, a write is also dropped when both asks agree the field wants one person's details and
 * the value is another's (fill.ts WHOSE_CRITERIA and OWNER_CRITERIA, at WHOSE_CUTOFF); a value from memory is
 * the user's, and one written in the instruction is the user's own choice.
 */
export async function verifyWrites(instruction: string, writes: readonly WriteToVerify[], askJev: AskJev, ledger: SnippetLedger): Promise<Set<string>> {
  if (writes.length === 0) return new Set();
  const declared = ledger.declared();
  const req = (wording: 0 | 1): JevRequest => {
    const questions: JevRequest["questions"] = {};
    writes.forEach((x, i) => {
      // Every value is checked, from memory and the instruction too (review: a writer put the user's Personal
      // email in Work email unchecked). The field is named by its name, which went through the ledger; its
      // descriptor can hold a placeholder that did not.
      questions[`c${i + 1}`] = {
        type: "choice",
        instructions: wording === 0 ? `A form has the field '${x.field.name}'. Is this value the right one for it? ${x.value.display} The user asked: "${instruction}".` : `Value: ${x.value.display} Field: '${x.field.name}'. The user asked: "${instruction}". Does this value belong in this field?`,
        criteria: { ...VERIFY },
      };
      if (!personalField(x.field.label)) return;
      questions[`f${i + 1}`] = { type: "choice", instructions: wording === 0 ? `The user asked: "${instruction}". A form has the field '${x.field.name}'. Whose details does this field ask for?` : `Field: '${x.field.name}'. Instruction: "${instruction}". Is this field for the details of the user filling in the form, of someone else, or can you not tell?`, criteria: { ...WHOSE_CRITERIA } };
      if (x.value.window !== null) questions[`v${i + 1}`] = { type: "choice", instructions: wording === 0 ? `A value on the user's screen: ${x.value.display} Whose details is it?` : `Whose details is this value, the user's or someone else's? ${x.value.display}`, criteria: { ...OWNER_CRITERIA } };
    });
    return sentOnly({ purpose: "plan.verify", state: { instruction, task: "Caret checks each value a drafted plan would write before offering the plan." }, questions, snippets: declared.snippets, charged: declared.charged });
  };
  let r: Awaited<ReturnType<AskJev>>[];
  try {
    r = await Promise.all([askJev(req(0)), askJev(req(1))]);
  } catch (e) {
    throw jevFailedError(e);
  }
  const agreed = (id: string, options: object, floor: number): string | null => {
    const [a, b] = [r[0]?.answers[id], r[1]?.answers[id]];
    return a !== undefined && b !== undefined && a.choice === b.choice && a.choice in options && Math.min(a.confidence, b.confidence) >= floor ? a.choice : null;
  };
  const out = new Set<string>();
  writes.forEach((x, i) => {
    if (agreed(`c${i + 1}`, VERIFY, PLAN_CUTOFF) !== "yes") return void out.add(x.key);
    if (!personalField(x.field.label)) return;
    const wants = agreed(`f${i + 1}`, WHOSE_CRITERIA, WHOSE_CUTOFF);
    const is = x.value.window === null ? x.value.owner : agreed(`v${i + 1}`, OWNER_CRITERIA, WHOSE_CUTOFF);
    if (wants !== null && is !== null && wants !== "unclear" && is !== "unclear" && wants !== is) out.add(x.key);
  });
  return out;
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
  const sent = sentStrings([instruction, snapshots.map((x) => [x.title, x.targets.map((t) => t.label), x.values.map((v) => v.display)])]);
  return snippets.filter((x) => sent.some((t) => t.includes(x.text)));
}
