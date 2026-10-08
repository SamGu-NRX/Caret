// I3 lead ruling: an Ask is never refused whole because a question would be too long or because some fields are unclear.
// It fills the fields Jev's scope ask settled (both wordings "asks" at SCOPE_CUTOFF), through the write contract as
// usual; it asks about the unclear and below-cutoff fields only when they fit one question of MAX_ASK_OPTIONS options;
// otherwise it leaves each to the user with one sentence. B24 ask-01 ("fill the rest of this from my note", where Jev
// settled no field and voted for ten) is the reproduction. Every name and value is from the synthetic corpus.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { MAX_ASK_OPTIONS, PROTOCOL_VERSION, Snapshot, type AskQuestion } from "../src/protocol.ts";
import type { AskJev, JevRequest, JevResult } from "../src/fill/jev.ts";
import { intentSnapshot, type IntentSnapshot } from "../src/planner/intent.ts";
import { headsIntentMaker, headsRequest, readHeads, SCOPE_CUTOFF, scopeId } from "../src/planner/intent-heads.ts";
import { AskAsks, AskRefused, planAsk, type AskDraft } from "../src/planner/ask.ts";
import { planSpec } from "../src/planner/proposal.ts";
import { SAYS } from "../src/planner/says.ts";
import { buildDesk, loadCorpus, T0, type Desk } from "../scripts/realfill-corpus.ts";
import { field, scopeLabel, snap } from "./builders.ts";
import type { PageControl } from "../src/protocol.ts";
import { c } from "./fake-page.ts";
import { closeRigs, rig, type Segment } from "./page-rig.ts";

beforeEach(() => setGeneratorClock(() => 0));
afterEach(() => setGeneratorClock(null));

const here = dirname(fileURLToPath(import.meta.url));
const corpus = loadCorpus(join(here, "../../fixtures/realfill"));
const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
const deskOf = (form: string): Desk => buildDesk(corpus, snaps, corpus.forms.find((f) => f.id === form) ?? (() => { throw new Error(`no form ${form}`); })());
const PIZZA = "httpbin-pizza";
const ASK_01 = "fill the rest of this from my note";

type A = { choice: string; confidence: number };
/** Both wordings' scope answers, by field label: `by(label, wording)`. */
type ScopeBy = (label: string, wording: 0 | 1) => A;
const settled: A = { choice: "asks", confidence: 0.99 };
const below: A = { choice: "asks", confidence: SCOPE_CUTOFF - 0.2 };
const unclear: A = { choice: "unclear", confidence: 0.3 };
const not: A = { choice: "not", confidence: 0.99 };

// SCP1: the section question, when the form shows a section, names no one section.
const wording = (s: IntentSnapshot, w: 0 | 1, by: ScopeBy): JevResult => ({ model: "jev-test", answers: { ...Object.fromEntries(s.fields.map((f) => [scopeId(f.ref), by(f.name, w)])), section: { choice: "fields", confidence: 0.99 } }, inputTokens: 10, latencyMs: 1, costUsd: 0 });
const headsOf = (s: IntentSnapshot, route = "some"): JevResult => {
  const dflt: Record<string, string> = { route, why: "nothingToFill", source: "any", whose: "user" };
  return { model: "jev-test", answers: Object.fromEntries(Object.keys(headsRequest(s).questions).map((id) => [id, { choice: dflt[id] ?? "none", confidence: 0.9 }])), inputTokens: 10, latencyMs: 1, costUsd: 0 };
};
const names = (s: IntentSnapshot, refs: readonly string[] | undefined): string[] => (refs ?? []).map((r) => s.fields.find((f) => f.ref === r)?.name ?? r);
const pizza = (): IntentSnapshot => {
  const d = deskOf(PIZZA);
  return intentSnapshot(ASK_01, d.model, d.form, d.memory);
};
/** Settled for `sure`, unclear for `open`, below the cutoff for `low`, not for the rest. */
const scopeBy = (sure: readonly string[], open: readonly string[] = [], low: readonly string[] = []): ScopeBy => (label) => (sure.includes(label) ? settled : open.includes(label) ? unclear : low.includes(label) ? below : not);

/** B24 ask-01 in I2's first live run: no field settled, one unclear, nine voted "asks" below the cutoff in one wording or both. */
const ASK_01_LIVE: ScopeBy = (label, w) => {
  const first: Record<string, A> = { "Customer name": { choice: "asks", confidence: 0.66 }, Telephone: { choice: "asks", confidence: 0.56 }, "E-mail address": { choice: "asks", confidence: 0.52 } };
  const second: Record<string, A> = { "Customer name": { choice: "unclear", confidence: 0.04 }, Telephone: { choice: "asks", confidence: 0.12 }, "E-mail address": { choice: "asks", confidence: 0.07 }, "Pizza Size": { choice: "asks", confidence: 0.18 }, "Preferred delivery time": { choice: "asks", confidence: 0.06 } };
  return (w === 0 ? first[label] : second[label]) ?? (w === 0 ? { choice: "asks", confidence: 0.3 } : { choice: "not", confidence: 0.2 });
};

describe("which fields, when Jev settled some and not others (readHeads)", () => {
  it("fills the settled fields and leaves the rest to the user when the others do not fit one question", () => {
    const s = pizza();
    const sure = ["Customer name"];
    const rest = s.fields.map((f) => f.name).filter((n) => !sure.includes(n));
    expect(rest.length).toBeGreaterThan(MAX_ASK_OPTIONS);
    const i = readHeads(s, headsOf(s), [wording(s, 0, scopeBy(sure, ["Pizza Size"], rest)), wording(s, 1, scopeBy(sure, ["Pizza Size"], rest))]);
    expect(i).toMatchObject({ route: "fill", scope: "list", agreed: true });
    expect(i.open).toBeUndefined();
    expect(names(s, i.fields)).toEqual(sure);
    expect(names(s, i.unsure)).toEqual(rest);
  });

  it("asks about only the unclear and below-cutoff fields when they fit, keeping the settled ones", () => {
    const s = pizza();
    const by = scopeBy(["Customer name", "Telephone"], ["E-mail address"], ["Delivery instructions"]);
    const i = readHeads(s, headsOf(s), [wording(s, 0, by), wording(s, 1, by)]);
    expect(i).toMatchObject({ route: "ask", why: "whichFields", open: ["fields"] });
    expect(names(s, i.options)).toEqual(["E-mail address", "Delivery instructions"]);
    expect(names(s, i.sure)).toEqual(["Customer name", "Telephone"]);
    expect(i.unsure).toBeUndefined();
  });

  // G35: Jev answered "unclear" 0 times in B31's 300 live pairs, so a below-cutoff "asks" is asked about too.
  it("asks about below-cutoff fields beside settled ones even when nothing is unclear", () => {
    const s = pizza();
    const by = scopeBy(["Customer name"], [], ["Telephone"]);
    const i = readHeads(s, headsOf(s), [wording(s, 0, by), wording(s, 1, by)]);
    expect(i).toMatchObject({ route: "ask", why: "whichFields", open: ["fields"], fields: [] });
    expect(names(s, i.sure)).toEqual(["Customer name"]);
    expect(names(s, i.options)).toEqual(["Telephone"]);
    expect(i.unsure).toBeUndefined();
  });
});

describe("through planAsk", () => {
  /** Heads at 0.9, the scope ask by `by`, each value question by the note's value for its field, owners "user". */
  const jevFor = (by: ScopeBy, values: Record<string, string> = {}) => {
    const seen: JevRequest[] = [];
    const ask: AskJev = async (req) => {
      seen.push(req);
      const answers = Object.fromEntries(
        Object.entries(req.questions).map(([id, q]) => {
          const ins = String(q.instructions);
          if (id === "route") return [id, { choice: "some", confidence: 0.9 }];
          if (id === "source") return [id, { choice: "any", confidence: 0.9 }];
          if (id === "why") return [id, { choice: "nothingToFill", confidence: 0.9 }];
          if (id === "whose" || id.endsWith("_whose") || id.endsWith("_owner")) return [id, { choice: "user" in q.criteria ? "user" : (Object.keys(q.criteria)[0] ?? "none"), confidence: 0.9 }];
          // Wording 0 opens with the request (intent-heads.ts SCOPE_WORDINGS).
          if (id === "section") return [id, { choice: "fields", confidence: 0.99 }];
          if (id.startsWith("s_")) return [id, by(scopeLabel(ins), ins.startsWith("User request:") ? 0 : 1)];
          if ("yes" in q.criteria) return [id, { choice: "yes", confidence: 0.9 }];
          const want = Object.entries(values).find(([label]) => ins.includes(`'${label}'`))?.[1];
          const hit = want === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want}"`));
          return [id, { choice: hit?.[0] ?? "none", confidence: 0.9 }];
        }),
      );
      return { model: "jev-test", answers, inputTokens: 100, latencyMs: 1, costUsd: 0 };
    };
    return { ask, seen };
  };
  const run = (instruction: string, jev: ReturnType<typeof jevFor>, resume?: Parameters<typeof planAsk>[4]["resume"]) => {
    const d = deskOf(PIZZA);
    return planAsk(instruction, d.model, { values: () => d.memory }, d.about, { askJev: jev.ask, maker: headsIntentMaker(jev.ask), writer: null, offerKey: "i3", windowId: d.form.window.windowId, now: 2000, ...(resume === undefined ? {} : { resume }) });
  };
  const NOTE = { "Customer name": "Jordan Reyes", Telephone: "(512) 555-0147", "E-mail address": "jordan.reyes@example.org", "Delivery instructions": "side door, ring twice" };

  it("B24 ask-01: with no field settled and ten voted for, leaves them to the user by name instead of asking 'which fields?'", async () => {
    const e = await run(ASK_01, jevFor(ASK_01_LIVE, NOTE)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskRefused);
    expect(e).not.toBeInstanceOf(AskAsks);
    const r = e as AskRefused;
    expect(r.message).not.toBe(SAYS.whichFields);
    expect(r.code).toBe("unsure");
    for (const n of ["Customer name", "Telephone", "E-mail address", "Pizza Size"]) expect(r.message).toContain(n);
    expect(r.message).toMatch(/6 more/u);
  });

  it("fills the settled fields and lists each other field as the user's, with a sentence, when they do not fit one question", async () => {
    // HA2 review (a)(c): the customer's name and email are also in another window of the desk (732 characters, a mail that
    // gives under half its text), which no owner question can show whole, so they are withheld; the phone is the note's.
    const sure = ["Telephone"];
    const rest = ["Customer name", "E-mail address", "Pizza Size", "Bacon", "Extra Cheese", "Onion", "Mushroom", "Preferred delivery time", "Delivery instructions"];
    const by: ScopeBy = (label) => (sure.includes(label) ? settled : label === "Delivery instructions" ? unclear : rest.includes(label) ? below : not);
    // Nine unsettled fields: one question lists eight at most.
    const d = (await run(ASK_01, jevFor(by, NOTE))) as AskDraft;
    expect(d.checked.writes.map((w) => w.value)).toEqual(["(512) 555-0147"]);
    expect(d.unsure?.map((u) => u.name)).toEqual(rest);
    const yours = planSpec(d).blocks.find((b) => b.type === "facts" && b.rows.some((r) => /wasn't sure/u.test(r.value.text)));
    expect(yours?.type === "facts" && yours.rows.map((r) => r.value.text)).toEqual(expect.arrayContaining(["Pizza Size: Caret wasn't sure your request asks for it."]));
  });

  it("asks about only the unclear fields, saying the settled ones it will fill, and a pick adds to them", async () => {
    const by = scopeBy(["Customer name", "Telephone"], ["E-mail address", "Delivery instructions"]);
    const jev = jevFor(by, NOTE);
    const e = await run(ASK_01, jev).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskAsks);
    const q = (e as AskAsks).question;
    expect(q.options.map((c) => (c.option.kind === "field" ? c.option.label : c.option.kind))).toEqual(["E-mail address", "Delivery instructions"]);
    expect(q.text).toContain("Customer name");
    expect(q.text).toContain("Telephone");
    const email = q.options[0];
    if (email === undefined) throw new Error("no option");
    const after = (await run(ASK_01, jev, { ...q.resume, fixed: { ...q.resume.fixed, ...email.fixes } })) as AskDraft;
    // HA2 review (a)(c): the name and email are withheld, as above; the phone is written.
    expect(after.checked.writes.map((w) => w.value)).toEqual(["(512) 555-0147"]);
  });

  it("leaves the unsettled fields of a page goal to the user in its scope, never writing them", async () => {
    const m = deskOf("hubspot-contact").model;
    const labels = ["Full name", "Email", "Phone", "Company", "Job title", "Street", "City", "State", "ZIP", "Country", "Website"];
    m.apply(snap(labels.map((l, i) => field(`pg/f${i}`, "", { label: l })), { at: T0 + 1000, windowId: "page:i3:1", kind: "page", focused: true }));
    const by: ScopeBy = (label) => (label === "Full name" || label === "Email" ? settled : below);
    const jev = jevFor(by);
    const goal = await planAsk("fill in my details", m, { values: () => [] }, [], { askJev: jev.ask, maker: headsIntentMaker(jev.ask), writer: null, offerKey: "i3p", windowId: "page:i3:1", now: T0 + 2000, goals: true });
    expect(goal).toMatchObject({ route: "goal", page: { kind: "list", scope: { fields: ["pg/f0", "pg/f1"] } } });
    expect(goal.route === "goal" && goal.page?.unsure).toEqual(labels.slice(2).map((_, i) => `pg/f${i + 2}`));
    expect(goal.route === "goal" && [...(goal.askScope?.fields ?? [])]).toEqual(["pg/f0", "pg/f1"]);
  });
});

describe("a page goal through the helper", () => {
  afterEach(closeRigs);

  it("says each unsettled field is the user's before Tab, and writes only the settled ones", async () => {
    const labels = ["Full name", "Email", "Phone", "Company", "Job title", "Street", "City", "State", "ZIP", "Country", "Website"];
    const controls = (): PageControl[] => labels.map((l, i) => c(`e${i + 1}`, "text", l, { value: "" }));
    // The rig's maker is a writer (page-rig.ts), whose fields the scope ask settles (ask.ts settleFields): Full name and
    // Email, with the nine others unclear, more than one question lists.
    const scoped = (inner: AskJev): AskJev => async (req) => {
      const r = await inner(req);
      if (req.purpose !== "ask.scope") return r;
      const answers = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, ["Full name", "Email"].includes(scopeLabel(String(q.instructions))) ? settled : unclear]));
      return { ...r, answers };
    };
    const r = await rig({ controls, note: "Full name: Robin Okafor\nEmail: robin.okafor@example.com", picks: { "Full name": "Robin Okafor", Email: "robin.okafor@example.com" }, jev: scoped });
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview.steps.map((s) => s.says)).toEqual(["Full name: Robin Okafor", "Email: robin.okafor@example.com", "The rest is yours"]);
    expect(preview.warnings).toEqual(labels.slice(2).map((l) => `'${l}' is yours: Caret wasn't sure your request asks for it.`));
  });
});

describe("the writer maker's settlement (ask.ts settleFields)", () => {
  afterEach(closeRigs);

  it("asks about the unclear fields beside the settled one, and the answer fills both on the page", async () => {
    const labels = ["Full name", "Email", "Phone"];
    const controls = (): PageControl[] => labels.map((l, i) => c(`e${i + 1}`, "text", l, { value: "" }));
    const scoped = (inner: AskJev): AskJev => async (req) => {
      const r = await inner(req);
      if (req.purpose !== "ask.scope") return r;
      return { ...r, answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, scopeLabel(String(q.instructions)) === "Full name" ? settled : unclear])) };
    };
    const r = await rig({ controls, note: "Full name: Robin Okafor\nEmail: robin.okafor@example.com\nPhone: (737) 555-0101", picks: { "Full name": "Robin Okafor", Email: "robin.okafor@example.com", Phone: "(737) 555-0101" }, jev: scoped });
    const q = (await r.ask("fill out this form from my note")) as unknown as AskQuestion;
    expect(q.type).toBe("askQuestion");
    expect(q.text).toBe("Caret will fill Full name. Which of these should it fill too?");
    expect(q.options.map((o) => (o.kind === "field" ? o.label : o.kind))).toEqual(["Email", "Phone"]);
    const email = q.options.find((o) => o.kind === "field" && o.label === "Email");
    const preview = (await r.helper.handleAskAnswer({ type: "askAnswer", v: PROTOCOL_VERSION, requestId: "a2", at: Date.now(), questionId: q.questionId, picks: [email?.id ?? ""] }, undefined, true)) as Segment;
    expect(preview.steps.map((s) => s.says)).toEqual(["Full name: Robin Okafor", "Email: robin.okafor@example.com", "The rest is yours"]);
  });
});
