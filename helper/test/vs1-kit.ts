// Value settlement tests on the B31 corpus desks: an Ask runs as the scoreboard runs it (scripts/realfill-asks.ts), the
// scripted oracle answering every question (scripts/realfill-oracle.ts), and a test overrides the value questions and the
// verifier field by field. Every window and memory entry comes from fixture files.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Snapshot } from "../src/protocol.ts";
import type { AskJev, JevRequest, JevResult } from "../src/fill/jev.ts";
import { mintOf, type FillTrace } from "../src/fill/fill.ts";
import { headsIntentMaker } from "../src/planner/intent-heads.ts";
import { AskAsks, AskRefused, planAsk, type AskDraft, type AskResume } from "../src/planner/ask.ts";
import { PlannerError } from "../src/planner/validate.ts";
import { buildDesk, loadAsks, loadCorpus, nodesFor, pageForm, T0, type CorpusAsk, type Desk } from "../scripts/realfill-corpus.ts";
import { realfillOracle } from "../scripts/realfill-oracle.ts";
import { rng } from "./large-scene.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const corpus = loadCorpus(join(here, "../../fixtures/realfill"));
const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
export const B31 = loadAsks(join(here, "../../fixtures/realfill"), corpus, "asks-b31.json");

/** The exact proposed output a value question's option states (fill.ts VALUE_CRITERION), or null for none or another format. */
export function optionOutput(criterion: string | null | undefined): string | null {
  return criterion == null ? null : (/^Proposed value: "([\s\S]*?)"\. Source: /u.exec(criterion)?.[1] ?? null);
}

export type Answer = { choice: string; confidence: number };
/** A value question's option: its id in this wording, its exact output and its whole criterion. */
export interface Option {
  id: string;
  output: string | null;
  /** The text of the candidate the option stands for (FillTrace), which a recorded answer named. */
  source: string | null;
  criterion: string;
}
/**
 * Overrides for one Ask. `value` answers a field's value question in one wording (the first is 0), given the field's corpus
 * label and its options; undefined leaves the oracle's answer. `verify` answers a verifier question by the field's label
 * and the exact output, in one wording.
 */
export interface Overrides {
  value?: (label: string, wording: 0 | 1, options: readonly Option[], req: JevRequest) => Answer | undefined;
  verify?: (label: string, wording: 0 | 1, output: string, instructions: string) => Answer | undefined;
}

export interface Run {
  ask: CorpusAsk;
  desk: Desk;
  requests: JevRequest[];
  traces: FillTrace[];
  /** The Ask's outcome: a draft, a question (AskAsks), or a refusal. */
  outcome: AskDraft | AskRefused;
  /** Corpus label by node key. */
  labelOf: ReadonlyMap<string, string>;
  /** Continues the Ask from a question, the user's picks applied as helper.ts handleAskAnswer applies them. */
  resume: (resume: AskResume) => Promise<AskDraft | AskRefused>;
}

/**
 * The corpus labels an outcome writes or hands off, with their values: a draft's checked writes and controls; while a value
 * question is open, the fill it is about, by its checked writes (a field with a mint) and its controls.
 */
export function proposedOf(r: Pick<Run, "labelOf">, d: AskDraft | AskRefused | null): Record<string, string> {
  if (d instanceof AskAsks && d.question.part === "value") {
    const fields = d.question.resume.values?.proposal.fields ?? [];
    return Object.fromEntries(fields.flatMap((f) => (f.control === "text" && f.value !== null && mintOf(f) !== undefined ? [[r.labelOf.get(f.key) ?? f.key, f.value]] : f.handoff !== null ? [[r.labelOf.get(f.key) ?? f.key, f.handoff.value]] : [])));
  }
  if (d === null || d instanceof AskRefused) return {};
  return Object.fromEntries([...d.checked.writes.map((w) => [r.labelOf.get(w.node.key) ?? w.node.key, w.value] as const), ...(d.controls ?? []).map((c) => [r.labelOf.get(c.key) ?? c.key, c.value] as const)]);
}

/** Runs B31 Ask `id` on its desk (`page`: the page engine's walk, as the scoreboard's default), with `values` value questions on. */
export async function runB31(id: string, o: Overrides & { window?: "page" | "reader"; values?: boolean; seed?: number } = {}): Promise<Run> {
  const ask = B31.find((x) => x.id === id);
  if (ask === undefined) throw new Error(`no B31 ask ${id}`);
  const form = corpus.forms.find((f) => f.id === ask.form);
  if (form === undefined) throw new Error(`no form ${ask.form}`);
  const desk = buildDesk(corpus, snaps, form, (o.window ?? "page") === "page" ? pageForm(form) : undefined);
  const labelOf = new Map(form.fields.flatMap((f) => nodesFor(desk.form, f).map((n) => [n.key, f.label] as const)));
  const traces: FillTrace[] = [];
  const requests: JevRequest[] = [];
  let current = ask.id;
  const oracle = realfillOracle({ asks: B31, corpus, current: () => current, traces: () => traces, corpusLabel: () => labelOf });
  const jev: AskJev = async (req) => {
    requests.push(req);
    const base: JevResult = await oracle(req);
    const t = traces.find((x) => x.owns(req));
    const answers = { ...base.answers };
    for (const [qid, q] of Object.entries(req.questions)) {
      if (req.purpose === "fill.values" && /^f\d+$/u.test(qid) && o.value !== undefined && t !== undefined) {
        const key = t.fields.find((f) => f.id === qid)?.key;
        const label = key === undefined ? qid : (labelOf.get(key) ?? qid);
        const options = Object.entries(q.criteria).map(([k, c]) => ({ id: k, output: optionOutput(c), source: t.options.get(k)?.text ?? null, criterion: c ?? "" }));
        const wording = (Object.keys(q.criteria).some((k) => /^[vne]\d+$/u.test(k)) ? 1 : 0) as 0 | 1;
        const a = o.value(label, wording, options, req);
        if (a !== undefined) answers[qid] = a;
      }
      if (req.purpose === "fill.verify" && o.verify !== undefined) {
        const ins = String(q.instructions);
        const output = /Exact output: "([\s\S]*?)"\. /u.exec(ins)?.[1] ?? "";
        const label = [...labelOf.values()].find((l) => ins.includes(`'${l}'`)) ?? "";
        const wording = (ins.startsWith("Exact output:") ? 1 : 0) as 0 | 1;
        const a = o.verify(label, wording, output, ins);
        if (a !== undefined) answers[qid] = a;
      }
    }
    return { ...base, answers };
  };
  const r = rng((o.seed ?? 24) * 1000 + B31.indexOf(ask));
  const run = async (resume?: AskResume): Promise<AskDraft | AskRefused> => {
    try {
      return await planAsk(ask.instruction, desk.model, { values: () => desk.memory }, desk.about, {
        askJev: jev, maker: headsIntentMaker(jev), writer: null, offerKey: `vs1-${ask.id}`, windowId: desk.form.window.windowId, now: T0,
        rand: (n) => Math.floor(r() * n), fillTrace: (t) => traces.push(t), values: o.values === true, ...(resume === undefined ? {} : { resume }),
      });
    } catch (e) {
      if (e instanceof AskRefused) return e;
      if (e instanceof PlannerError) throw new Error(`a planner error that is not an Ask refusal: ${e.message}`);
      throw e;
    }
  };
  const outcome = await run();
  return {
    ask, desk, requests, traces, outcome, labelOf,
    resume: (resume) => {
      current = `${ask.id}+pick`;
      return run(resume);
    },
  };
}

/** The value requests fill sent for field `label` in a run: each wording's question with its options. */
export function valueQuestions(r: Run, label: string): { req: JevRequest; id: string; options: Option[]; instructions: string }[] {
  return r.requests.flatMap((req) => {
    if (req.purpose !== "fill.values") return [];
    const t = r.traces.find((x) => x.owns(req));
    const f = t?.fields.find((x) => r.labelOf.get(x.key) === label);
    const q = f === undefined ? undefined : req.questions[f.id];
    if (f === undefined || q === undefined) return [];
    return [{ req, id: f.id, instructions: String(q.instructions), options: Object.entries(q.criteria).map(([k, c]) => ({ id: k, output: optionOutput(c), source: t?.options.get(k)?.text ?? null, criterion: c ?? "" })) }];
  });
}

/** Answers with the option whose exact output is `text` at `confidence`, else none at it. */
export const byOutput = (options: readonly Option[], text: string | null, confidence: number): Answer => ({ choice: options.find((x) => text !== null && x.output === text)?.id ?? "none", confidence });

/** Answers with the option a recorded answer named: its exact output, else the candidate it stands for; else none. */
export const byRecorded = (options: readonly Option[], text: string | null, confidence: number): Answer => ({ choice: text === null ? "none" : (options.find((x) => x.output === text) ?? options.find((x) => x.source === text))?.id ?? "none", confidence });
