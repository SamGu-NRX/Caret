// W1: an evaluation's canned engine answers each question by a rule for its kind and throws on any kind it has no rule
// for (engines/decide/canned.ts). page-loop-eval's engine answered A1's `reading` head "none" ("fill no field"), so every
// canned page goal asked which fields to fill and the canned browser sets wrote nothing. These tests meet the canned
// engine with every kind of question the Ask, fill, the goal gate and the planner build, on the real-form corpus's
// replayed desks. All text is synthetic fixture text.
import { minted } from "./minted.ts";
import { Disclosure } from "../src/privacy/disclosure.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { proposeFill } from "../src/fill/fill.ts";
import type { AskJev, JevRequest, JevResult } from "../src/fill/jev.ts";
import { AskAsks, planAsk } from "../src/planner/ask.ts";
import { headsIntentMaker } from "../src/planner/intent-heads.ts";
import { jevIntentMaker } from "../src/planner/intent-makers.ts";
import { sourceNotes, verifyWrites } from "../src/planner/codeplan.ts";
import { planTask, taskWindow } from "../src/planner/planner.ts";
import { CannedGap, cannedReply, questionKind } from "../src/engines/decide/canned.ts";
import { Snapshot } from "../src/protocol.ts";
import { buildDesk, loadCorpus, T0, type Desk } from "../scripts/realfill-corpus.ts";
import { PAGE_LOOP_HEADS, pageLoopCanned } from "../../fixtures/web-form/canned-jev.ts";
import { setTestVerifier } from "../src/fill/contract.ts";
import { STAND_IN } from "./setup/verifier.ts";

beforeAll(() => setGeneratorClock(() => 0));
afterAll(() => setGeneratorClock(null));

const here = dirname(fileURLToPath(import.meta.url));
const corpus = loadCorpus(join(here, "../../fixtures/realfill"));
const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
const desks = (): { form: (typeof corpus.forms)[number]; desk: Desk }[] => corpus.forms.map((form) => ({ form, desk: buildDesk(corpus, snaps, form) }));
const quoted = (t: string | null | undefined): string | null => (typeof t === "string" ? (/^"([^"]*)"/u.exec(t)?.[1] ?? null) : null);

/** page-loop-eval's canned engine, each fill question taking an option that quotes one of the form's key values. */
function canned(form: (typeof corpus.forms)[number], seen: JevRequest[]): AskJev {
  const keys = new Set(form.fields.flatMap((f) => [f.expected, ...(f.accept ?? [])]));
  const engine = pageLoopCanned(async (q) => {
    const hit = Object.entries(q.criteria).find(([, d]) => keys.has(quoted(d) ?? "\u0000"))?.[0];
    return { choice: hit ?? "none", confidence: 0.95 };
  });
  return async (req) => (seen.push(req), engine(req));
}

describe("page-loop-eval's canned engine", () => {
  // W2: the write contract's verifier asks the canned engine here, not the suite's stand-in, so its rule is met.
  beforeAll(() => setTestVerifier(null));
  afterAll(() => setTestVerifier(STAND_IN));
  it("reads a whole-form Ask from the heads and both scope wordings, so it fills instead of asking which fields to fill", async () => {
    for (const { form, desk } of desks()) {
      const seen: JevRequest[] = [];
      const ask = canned(form, seen);
      let asked: string | null = null;
      try {
        await planAsk("fill out this form", desk.model, { values: () => desk.memory }, desk.about, { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: `k-${form.id}`, windowId: desk.form.window.windowId, now: T0, rand: () => 0 });
      } catch (e) {
        if (e instanceof AskAsks) asked = e.message;
        else if (!(e instanceof Error) || e instanceof CannedGap) throw e;
      }
      expect({ form: form.id, asked }).toEqual({ form: form.id, asked: null });
      const heads = seen.find((r) => r.purpose === "ask.heads");
      expect(heads?.questions.route?.criteria).toHaveProperty(PAGE_LOOP_HEADS.route as string);
      expect(seen.filter((r) => r.purpose === "ask.scope")).toHaveLength(2);
    }
  }, 120_000);

  it("meets every kind of question an Ask, a fill and the goal gate send, with no gap", async () => {
    const kinds = new Set<string>();
    for (const { form, desk } of desks()) {
      for (const instruction of ["fill out this form", "do this one for me", "add my email and my phone"]) {
        const seen: JevRequest[] = [];
        const ask = canned(form, seen);
        await planAsk(instruction, desk.model, { values: () => desk.memory }, desk.about, { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: `k-${form.id}`, windowId: desk.form.window.windowId, now: T0, rand: () => 0 }).catch((e: unknown) => {
          if (e instanceof CannedGap || !(e instanceof Error)) throw e;
        });
        const p = await proposeFill(desk.model, ask, desk.form.window.windowId, desk.trigger.key, T0, { about: desk.about, rand: () => 0 }).catch((e: unknown) => {
          if (e instanceof CannedGap || !(e instanceof Error)) throw e;
          return null;
        });
        // W2: the value question goes only with a calendar event now (goals/gates.ts jevGate); asked here so its rule is met.
        // The fill's descriptors and values stand in for a plan's minted texts here (fixture wording, test/minted.ts).
        const d = new Disclosure(desk.model.windows.values());
        const writes = (p?.fields ?? []).filter((f) => f.value !== null).map((f, i) => ({ key: `s${i}`, field: { name: d.own(f.descriptor as never), label: f.descriptor }, value: { display: d.own(`"${f.value as string}"` as never), window: f.source?.windowId ?? null, owner: null, notes: f.source === null ? [] : sourceNotes(desk.model, { kind: "window", windowId: f.source.windowId, nodeKey: f.source.nodeKey, app: "", title: "", span: f.value as string, label: null, line: null, partOf: null, context: null, lines: [], sentences: [] }, desk.form.window.windowId) }, askValue: true }));
        if (writes.length > 0) await verifyWrites(instruction, writes, ask, d);
        for (const r of seen) for (const id of [...Object.keys(r.questions), ...Object.keys(r.nouls ?? {})]) kinds.add(questionKind(r, id));
      }
    }
    // Every kind the page goal path asks was met here, so each rule above is exercised. A3: the heads maker's scope is
    // Jev's own, which planAsk does not confirm again, so ask.confirm (another maker's scope) is not among them.
    for (const k of ["ask.heads:route", "ask.heads:why", "ask.heads:source", "ask.heads:whose", "ask.scope:field", "fill.whose:whose", "fill.whose:owner", "fill.values:value", "fill.verify:verdict", "plan.verify:value", "plan.verify:whose"]) expect(kinds).toContain(k);
  }, 300_000);
});

describe("every request the planner and fill build says what it asks", () => {
  /** Answers every choice with its first option and every yes/no with 0.5: it only drives the paths, which may refuse. */
  const anything = (seen: JevRequest[]): AskJev => async (req): Promise<JevResult> => {
    seen.push(req);
    return { model: "any", answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { choice: Object.keys(q.criteria)[0] ?? "none", confidence: 0.9 }])), nouls: Object.fromEntries(Object.keys(req.nouls ?? {}).map((id) => [id, 0.5])), inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };

  it("names a purpose, and asks only ids its purpose names (questionKind), on every path", async () => {
    const seen: JevRequest[] = [];
    for (const { desk } of desks().slice(0, 6)) {
      const ask = anything(seen);
      const swallow = (e: unknown): void => {
        if (e instanceof CannedGap || !(e instanceof Error)) throw e;
      };
      await planAsk("fill out this form", desk.model, { values: () => desk.memory }, desk.about, { askJev: ask, maker: jevIntentMaker(ask, { rand: () => 0 }), writer: null, offerKey: "k", windowId: desk.form.window.windowId, now: T0, rand: () => 0 }).catch(swallow);
      await taskWindow("fill out the application", desk.model, { askJev: ask, rand: () => 0 }).catch(swallow);
      await planTask("put my email in the form", desk.model, { values: () => desk.memory }, { askJev: ask, offerKey: "k", windowId: desk.form.window.windowId, now: T0, rand: () => 0 }).catch(swallow);
    }
    const purposes = new Set(seen.map((r) => r.purpose));
    for (const p of ["intent.route", "planner.window", "planner.fields"]) expect(purposes).toContain(p);
    for (const r of seen) for (const id of [...Object.keys(r.questions), ...Object.keys(r.nouls ?? {})]) expect(() => questionKind(r, id)).not.toThrow();
  }, 300_000);
});

describe("cannedReply", () => {
  const req: JevRequest = minted({ purpose: "ask.scope", state: {}, questions: { s_f1: { type: "choice", instructions: "Which?", criteria: { asks: "Yes", not: "No", unclear: "Unclear" } } }, snippets: [], charged: {} });

  it("throws on a kind it has no rule for, naming the kind and the request", async () => {
    await expect(cannedReply(req, { confidence: 0.9, choice: {}, noul: {} })).rejects.toThrow(/no rule for question kind 'ask\.scope:field' \(id 's_f1'.*in a ask\.scope request asking s_f1/u);
  });

  it("throws on a request with no purpose, on an id its purpose does not ask, and on an answer that is no option", async () => {
    const { purpose: _, ...bare } = req;
    await expect(cannedReply(bare, { confidence: 0.9, choice: { "ask.scope:field": () => "asks" }, noul: {} })).rejects.toThrow(/no purpose/u);
    await expect(cannedReply({ ...req, questions: { mystery: req.questions.s_f1 as JevRequest["questions"][string] } }, { confidence: 0.9, choice: {}, noul: {} })).rejects.toThrow(/asks 'mystery'/u);
    await expect(cannedReply(req, { confidence: 0.9, choice: { "ask.scope:field": () => "all" }, noul: {} })).rejects.toThrow(/not one of its options/u);
    await expect(cannedReply(req, { confidence: 0.9, choice: { "ask.scope:field": () => "asks" }, noul: {} })).resolves.toMatchObject({ answers: { s_f1: { choice: "asks", confidence: 0.9 } } });
  });
});
