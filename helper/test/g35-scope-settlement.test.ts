// G35: per-field scope settlement. Two "asks" answers, each at SCOPE_CUTOFF or above, are the only automatic admission;
// the section and never-typed vetoes run after it. Any other pair holding "asks" or "unclear" is unresolved: offered by
// its exact label when at most MAX_ASK_OPTIONS eligible fields are unresolved, never authorized without the user's pick.
// Missing or invalid answers fail closed. Every entry point that settles scope reads a pair the same way: the heads
// maker (readHeads), a settlement made before the Ask (helper.ts settleRequest, read back by the heads maker), the
// writer's settlement in planAsk, and a goal's (settleFields). Names and values are the synthetic corpus's.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { MAX_ASK_OPTIONS, Snapshot } from "../src/protocol.ts";
import type { AskJev, JevRequest, JevResult } from "../src/fill/jev.ts";
import { intentSnapshot, type AskIntent, type IntentSnapshot } from "../src/planner/intent.ts";
import { headsIntentMaker, headsRequest, readHeads, SCOPE_CUTOFF, scopeId, SECTION_QUESTION, settleFields } from "../src/planner/intent-heads.ts";
import type { IntentMaker } from "../src/planner/intent-makers.ts";
import { AskAsks, AskRefused, planAsk, type AskDraft } from "../src/planner/ask.ts";
import { PlannerError } from "../src/planner/validate.ts";
import { buildDesk, loadCorpus, type Desk } from "../scripts/realfill-corpus.ts";

beforeEach(() => setGeneratorClock(() => 0));
afterEach(() => setGeneratorClock(null));

const here = dirname(fileURLToPath(import.meta.url));
const corpus = loadCorpus(join(here, "../../fixtures/realfill"));
const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
const deskOf = (form: string): Desk => buildDesk(corpus, snaps, corpus.forms.find((f) => f.id === form) ?? (() => { throw new Error(`no form ${form}`); })());

// The pizza form's reader window: Customer name, Telephone, E-mail address, Pizza Size, four toppings, Preferred delivery
// time, Delivery instructions; no heading, so no section question.
const PIZZA = "httpbin-pizza";
const INSTRUCTION = "do the pizza order off my note";
const NOTE: Record<string, string> = { "Customer name": "Jordan Reyes", Telephone: "(512) 555-0147", "E-mail address": "jordan.reyes@example.org", "Delivery instructions": "side door, ring twice" };
const pizza = (instruction = INSTRUCTION): { desk: Desk; snap: IntentSnapshot } => {
  const desk = deskOf(PIZZA);
  return { desk, snap: intentSnapshot(instruction, desk.model, desk.form, desk.memory) };
};

type A = { choice: string; confidence: number };
/** One wording's scope answer for a field by its label; undefined leaves the answer out. */
type ScopeBy = (label: string, wording: 0 | 1) => A | undefined;
const result = (answers: JevResult["answers"]): JevResult => ({ model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 });
/** Both wordings by `by`; the section question, when the window shows a section, names no one section. */
const pair = (s: IntentSnapshot, by: ScopeBy): [JevResult, JevResult] =>
  [0, 1].map((w) => result({
    ...Object.fromEntries(s.fields.flatMap((f) => {
      const a = by(f.name, w as 0 | 1);
      return a === undefined ? [] : [[scopeId(f.ref), a]];
    })),
    ...(s.headings.length === 0 ? {} : { [SECTION_QUESTION]: { choice: "fields", confidence: 0.99 } }),
  })) as [JevResult, JevResult];
const heads = (s: IntentSnapshot): JevResult => {
  const dflt: Record<string, string> = { route: "some", why: "nothingToFill", source: "any", whose: "user" };
  return result(Object.fromEntries(Object.keys(headsRequest(s).questions).map((id) => [id, { choice: dflt[id] ?? "none", confidence: 0.9 }])));
};
// The desk writes the note's Telephone and Delivery instructions; its name and email are withheld for their owner (i3-partial-fill.test.ts).
const ANCHOR = "Telephone";
const TARGET = "Delivery instructions";
const sure: A = { choice: "asks", confidence: 0.99 };
const not: A = { choice: "not", confidence: 0.99 };
/** The anchor settled, the target answered `a` then `b`, every other field "not". */
const cell = (a: A | undefined, b: A | undefined): ScopeBy => (label, w) => (label === ANCHOR ? sure : label === TARGET ? (w === 0 ? a : b) : not);

/**
 * A Jev for a whole Ask on the pizza desk: heads fill some fields from any source for the user; the scope ask by `by`,
 * read from each question's id against the snapshot the Ask takes (its refs are the same); each value question picks the
 * note's value; owners the user's; the verifier says exact.
 */
function askJev(by: ScopeBy, instruction = INSTRUCTION) {
  const { snap } = pizza(instruction);
  const labelOf = (id: string): string => snap.fields.find((f) => scopeId(f.ref) === id)?.name ?? "";
  const seen: JevRequest[] = [];
  let scopeWording = 0;
  const ask: AskJev = async (req) => {
    seen.push(req);
    const w = req.purpose === "ask.scope" ? ((scopeWording++ % 2) as 0 | 1) : 0;
    const answers = Object.fromEntries(Object.entries(req.questions).flatMap(([id, q]) => {
      const ins = String(q.instructions);
      if (req.purpose === "ask.heads") return [[id, { choice: { route: "some", why: "nothingToFill", source: "any", whose: "user" }[id] ?? "none", confidence: 0.9 }]];
      if (id === SECTION_QUESTION) return [[id, { choice: "fields", confidence: 0.99 }]];
      if (req.purpose === "ask.scope") {
        const a = by(labelOf(id), w);
        return a === undefined ? [] : [[id, a]];
      }
      if (req.purpose === "fill.verify") return [[id, { choice: "exact" in q.criteria ? "exact" : "none", confidence: 1 }]];
      if (id.endsWith("_whose") || id.endsWith("_owner")) return [[id, { choice: "user" in q.criteria ? "user" : (Object.keys(q.criteria)[0] ?? "none"), confidence: 0.9 }]];
      if ("yes" in q.criteria) return [[id, { choice: "yes", confidence: 0.9 }]];
      const want = Object.entries(NOTE).find(([label]) => ins.includes(`'${label}'`))?.[1];
      const hit = want === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want}"`));
      return [[id, { choice: hit?.[0] ?? "none", confidence: 0.9 }]];
    }));
    return result(answers);
  };
  return { ask, seen, scopeRequests: () => seen.filter((r) => r.purpose === "ask.scope").length };
}

const plan = (j: ReturnType<typeof askJev>, o: { maker?: IntentMaker; resume?: Parameters<typeof planAsk>[4]["resume"]; instruction?: string } = {}) => {
  const d = deskOf(PIZZA);
  return planAsk(o.instruction ?? INSTRUCTION, d.model, { values: () => d.memory }, d.about, { askJev: j.ask, maker: o.maker ?? headsIntentMaker(j.ask), writer: null, offerKey: "g35", windowId: d.form.window.windowId, now: 2000, ...(o.resume === undefined ? {} : { resume: o.resume }) });
};
const labels = (s: IntentSnapshot, refs: readonly string[] | undefined): string[] => (refs ?? []).map((r) => s.fields.find((f) => f.ref === r)?.name ?? r);
/** A field's name in the Ask's snapshot (the reader's labels end in a colon), by node key. */
const nameOf = (key: string): string => pizza().snap.fields.find((f) => f.key === key)?.name ?? key;
const written = (d: AskDraft): string[] => d.checked.writes.map((w) => nameOf(w.node.key));
async function question(p: Promise<unknown>): Promise<AskAsks> {
  const e = await p.then(() => null, (x: unknown) => x);
  if (!(e instanceof AskAsks)) throw new Error(`expected a question, got ${e instanceof Error ? e.message : "a plan"}`);
  return e;
}

/** A writer's intent (ask.ts settles its fields with settleFields): a fill of the listed fields, from any source, for the user. */
const writerMaker = (fields: readonly string[]): IntentMaker => ({
  name: "writer",
  async make(snap) {
    const intent: AskIntent = { route: "fill", why: "none", scope: "list", section: "none", fields: snap.fields.filter((f) => fields.includes(f.name)).map((f) => f.ref), sources: ["any"], whose: "user", literals: [] };
    return { intent, use: { maker: "writer", model: "writer-test", calls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 } };
  },
});

// The decision truth table: every pairing of the three options, each at 0.49 and 0.50.
const CHOICES = ["asks", "not", "unclear"] as const;
const LEVELS = [SCOPE_CUTOFF - 0.01, SCOPE_CUTOFF] as const;
const CELLS = CHOICES.flatMap((c1) => LEVELS.flatMap((p1) => CHOICES.flatMap((c2) => LEVELS.map((p2) => ({ a: { choice: c1, confidence: p1 }, b: { choice: c2, confidence: p2 } })))));
type Outcome = "admitted" | "unresolved" | "none";
const expected = (a: A, b: A): Outcome => {
  if (a.choice === "asks" && b.choice === "asks" && a.confidence >= SCOPE_CUTOFF && b.confidence >= SCOPE_CUTOFF) return "admitted";
  return [a, b].some((x) => x.choice === "asks" || x.choice === "unclear") ? "unresolved" : "none";
};
const show = (c: { a: A; b: A }): string => `${c.a.choice}@${c.a.confidence} / ${c.b.choice}@${c.b.confidence}`;

describe("the decision truth table, through every settlement entry point", () => {
  it("covers all 36 pairings", () => {
    expect(CELLS).toHaveLength(36);
    expect(CELLS.filter((c) => expected(c.a, c.b) === "admitted")).toHaveLength(1);
  });

  it("readHeads: only asks/asks at the cutoff admits; any other pair with asks or unclear is offered beside the settled field", () => {
    const { snap: s } = pizza();
    for (const c of CELLS) {
      const i = readHeads(s, heads(s), pair(s, cell(c.a, c.b)));
      const admitted = [...(i.fields ?? []), ...(i.sure ?? [])];
      const got: Outcome = labels(s, admitted).includes(TARGET) ? "admitted" : labels(s, i.options).includes(TARGET) ? "unresolved" : "none";
      expect(got, show(c)).toBe(expected(c.a, c.b));
      // Nothing unresolved is ever authorized: it is offered, so the Ask asks first.
      if (got === "unresolved") expect(i, show(c)).toMatchObject({ route: "ask", why: "whichFields", open: ["fields"] });
      expect(labels(s, admitted), show(c)).toContain(ANCHOR);
    }
  });

  it("settleFields (a settlement before the Ask, the writer's, a goal's): the same three outcomes", async () => {
    const { snap: s } = pizza();
    for (const c of CELLS) {
      // settleFields sends wording 0, then wording 1.
      const answers = pair(s, cell(c.a, c.b));
      let n = 0;
      const r = await settleFields(s, async () => answers[n++ % 2] as JevResult);
      const got: Outcome = r.asks.some((f) => f.name === TARGET) ? "admitted" : r.unresolved.some((f) => f.name === TARGET) ? "unresolved" : "none";
      expect(got, show(c)).toBe(expected(c.a, c.b));
    }
  });

  it("a settlement made before the Ask reads back through the heads maker as readHeads reads the pair", async () => {
    const { snap: s } = pizza();
    for (const c of CELLS) {
      const answers = pair(s, cell(c.a, c.b));
      let n = 0;
      const pre = await settleFields(s, async () => answers[n++ % 2] as JevResult);
      const seenKeys = Object.fromEntries(s.fields.map((f) => [f.key, "x"]));
      const settled = { askId: "a", windowId: s.window.window.windowId, document: null, seen: seenKeys, asks: pre.asks.map((f) => f.key), unresolved: pre.unresolved.map((f) => f.key), sectionless: [], section: null };
      const made = await headsIntentMaker(async () => heads(s)).make(s, undefined, settled);
      const direct = readHeads(s, heads(s), answers);
      expect({ fields: made.intent.fields, sure: made.intent.sure, options: made.intent.options }, show(c)).toEqual({ fields: direct.fields, sure: direct.sure, options: direct.options });
    }
  });

  it("the writer's settlement in planAsk offers an unresolved field beside the settled one, never writes it", async () => {
    for (const c of CELLS) {
      const j = askJev(cell(c.a, c.b));
      const outcome = expected(c.a, c.b);
      const r = await plan(j, { maker: writerMaker([ANCHOR, TARGET]) }).catch((e: unknown) => e);
      if (outcome === "unresolved") {
        expect(r, show(c)).toBeInstanceOf(AskAsks);
        expect((r as AskAsks).question.options.map((o) => (o.option.kind === "field" ? o.option.label : "")), show(c)).toEqual([TARGET]);
      } else {
        expect(r, show(c)).not.toBeInstanceOf(Error);
        expect(written(r as AskDraft).includes(TARGET), show(c)).toBe(outcome === "admitted");
      }
    }
  });

  it("fails closed on a missing or invalid answer at every entry point, and asks Jev nothing more", async () => {
    const { snap: s } = pizza();
    const bad: [string, A | undefined][] = [["absent", undefined], ["outside the options", { choice: "maybe", confidence: 0.99 }]];
    for (const [what, b] of bad) {
      const answers = pair(s, cell(sure, b));
      expect(() => readHeads(s, heads(s), answers), what).toThrow(PlannerError);
      let n = 0;
      await expect(settleFields(s, async () => answers[n++ % 2] as JevResult), what).rejects.toThrow(PlannerError);
      const j = askJev(cell(sure, b));
      const e = await plan(j).catch((x: unknown) => x);
      expect(e, what).toBeInstanceOf(AskRefused);
      expect(e, what).not.toBeInstanceOf(AskAsks);
      expect((e as AskRefused).code, what).toBe("jevFailed");
      // One pair of scope requests, never a second pair in search of a better answer.
      expect(j.scopeRequests(), what).toBe(2);
    }
  });
});

describe("clarification: at most MAX_ASK_OPTIONS unresolved fields are offered by their exact labels", () => {
  const low: A = { choice: "asks", confidence: 0.4 };
  const others = (s: IntentSnapshot): string[] => s.fields.map((f) => f.name).filter((n) => n !== ANCHOR);

  it("offers eight unresolved fields with no literal 'unclear', beside the settled one", () => {
    const { snap: s } = pizza();
    const eight = others(s).slice(0, MAX_ASK_OPTIONS);
    expect(eight).toHaveLength(8);
    const i = readHeads(s, heads(s), pair(s, (l) => (l === ANCHOR ? sure : eight.includes(l) ? low : not)));
    expect(i).toMatchObject({ route: "ask", why: "whichFields", open: ["fields"] });
    expect(labels(s, i.options)).toEqual(eight);
    expect(labels(s, i.sure)).toEqual([ANCHOR]);
    expect(i.fields).toEqual([]);
  });

  it("keeps today's behaviour at nine: fills the settled field, leaves the nine to the user, asks nothing", () => {
    const { snap: s } = pizza();
    const nine = others(s);
    expect(nine).toHaveLength(9);
    const i = readHeads(s, heads(s), pair(s, (l) => (l === ANCHOR ? sure : low)));
    expect(i).toMatchObject({ route: "fill", agreed: true });
    expect(labels(s, i.fields)).toEqual([ANCHOR]);
    expect(labels(s, i.unsure)).toEqual(nine);
    expect(i.options).toBeUndefined();
  });

  it("the question lists the exact labels, says what it fills anyway, and a pick authorizes only the keys picked", async () => {
    const offered = ["Customer name", "E-mail address", "Delivery instructions"];
    const j = askJev((l) => (l === ANCHOR ? sure : offered.includes(l) ? low : not));
    const q = await question(plan(j));
    expect(q.question.text).toBe("Caret will fill Telephone. Which of these should it fill too?");
    expect(q.question.options.map((o) => (o.option.kind === "field" ? o.option.label : o.option.kind))).toEqual(offered);
    const pick = q.question.options.find((o) => o.option.kind === "field" && o.option.label === "Delivery instructions");
    const d = (await plan(j, { resume: { ...q.question.resume, fixed: { ...q.question.resume.fixed, fields: pick?.fixes.fields ?? [] } } })) as AskDraft;
    expect(written(d).sort()).toEqual(["Delivery instructions", "Telephone"]);
    const authority = d.checked.writes[0]?.checked.authority;
    const scope = authority?.kind === "ask" ? authority.scope : null;
    expect([...(scope?.fields ?? [])].map(nameOf).sort()).toEqual(["Delivery instructions", "Telephone"]);
    expect([...(scope?.picked ?? [])].map(nameOf)).toEqual(["Delivery instructions"]);
    // The continued Ask settles nothing again.
    expect(j.scopeRequests()).toBe(2);
  });

  it("an empty pick beside settled fields fills only those", async () => {
    const j = askJev((l) => (l === ANCHOR ? sure : l === TARGET ? low : not));
    const q = await question(plan(j));
    expect(q.question.settled).toEqual([ANCHOR]);
    const d = (await plan(j, { resume: { ...q.question.resume, fixed: { ...q.question.resume.fixed, fields: [] } } })) as AskDraft;
    expect(written(d)).toEqual([ANCHOR]);
  });

  it("an empty pick with nothing settled beside it writes nothing", async () => {
    const j = askJev((l) => (l === TARGET || l === ANCHOR ? low : not));
    const q = await question(plan(j));
    expect(q.question.settled).toEqual([]);
    const e = await plan(j, { resume: { ...q.question.resume, fixed: { ...q.question.resume.fixed, fields: [] } } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskRefused);
  });
});
