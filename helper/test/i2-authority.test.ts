// I2 lead ruling (re-review of ec4e4bb): every mint carries an explicit authority, and it matches the origin of the
// plan it ends up in. Before it, a missing scope meant "outside an Ask", so an unscoped mint passed validation and the
// guard. The property is checked on every path by recording every mint as it is made (contract.ts setMintObserver);
// then the reviewer's two reproductions.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { authorityRefusal, type Origin } from "../src/fill/ask-scope.ts";
import { setMintObserver, type CheckedValue } from "../src/fill/contract.ts";
import { proposeFill } from "../src/fill/fill.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { ScreenModel } from "../src/model.ts";
import { PROTOCOL_VERSION, type GoalProgress } from "../src/protocol.ts";
import { AskAsks, AskRefused, planAsk } from "../src/planner/ask.ts";
import { headsIntentMaker } from "../src/planner/intent-heads.ts";
import { planTask } from "../src/planner/planner.ts";
import { field, node, optionIs, scopeLabel, snap } from "./builders.ts";
import { rig } from "./page-rig.ts";
import { goalScene, mailWindow, replyWindow, standInJev, MAIL, line, textField, type CannedStep, type GoalScene } from "./goal-desk.ts";

const seen: CheckedValue[] = [];
beforeEach(() => {
  setGeneratorClock(() => 0);
  seen.length = 0;
  setMintObserver((c) => seen.push(c));
});
afterEach(() => {
  setGeneratorClock(null);
  setMintObserver(null);
});

/** Every mint made since the last reset carries an authority, and it is the plan's origin's. */
function allMatch(origin: Origin): void {
  expect(seen.length).toBeGreaterThan(0);
  for (const c of seen) {
    expect(c.authority).toBeDefined();
    expect(authorityRefusal(c.authority, origin), `${c.field.name}: ${JSON.stringify(c.authority.kind)}`).toBeNull();
  }
}

const WIN = "signup";
const ABOUT = [
  { id: "about-1", label: "Name", value: "Elena Vance", kind: "fullName" },
  { id: "about-2", label: "Email", value: "elena.vance@example.com", kind: "email" },
] as never[];
const MEMORY = [
  { id: "about-1", label: "Name", text: "Elena Vance", whose: "user" as const },
  { id: "about-2", label: "Email", text: "elena.vance@example.com", whose: "user" as const },
];
const VALUES: Record<string, string> = { Name: "Elena Vance", Email: "elena.vance@example.com" };

function desk(nodes = [field("sf/name", "", { label: "Name", frame: [10, 10, 200, 20] }), field("sf/email", "", { label: "Email", frame: [10, 40, 200, 20] })]): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap(nodes, { at: 1000, windowId: WIN, title: "Sign up", app: { pid: 7100, bundleId: "com.example.signup", name: "Signup" }, focused: true, focusedKey: nodes[0]?.key ?? null }));
  return m;
}

/** Jev for an Ask: heads say `route`; the scope question chooses `asks`; value questions take VALUES. */
const jev = (route: string, asks: readonly string[], log: JevRequest[] = []): AskJev => async (req) => {
  log.push(req);
  return {
    model: "t",
    inputTokens: 1,
    latencyMs: 1,
    costUsd: 0,
    answers: Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        const ins = String(q.instructions);
        const pick = (c: string) => [id, { choice: c, confidence: 0.95 }] as const;
        if (req.purpose === "ask.heads") return pick({ route, why: "nothingToFill", source: "any", whose: "user" }[id] ?? "none");
        if (req.purpose === "ask.scope" && id === "section") return pick("fields");
        if (req.purpose === "ask.scope") return pick(asks.includes(scopeLabel(ins)) ? "asks" : "not");
        if (id === "press") return pick("none" in q.criteria ? "none" : (Object.keys(q.criteria).at(-1) ?? "none"));
        const want = Object.entries(VALUES).find(([l]) => ins.includes(`'${l}'`))?.[1];
        const hit = want === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => optionIs(d, want));
        if (hit !== undefined) return pick(hit[0]);
        if ("yes" in q.criteria) return pick("yes");
        if ("user" in q.criteria) return pick("user");
        return pick(Object.keys(q.criteria).at(-1) ?? "none");
      }),
    ),
  };
};

describe("property: every mint carries an authority matching its plan's origin, on every path", () => {
  it("an Ask's fill", async () => {
    const ask = jev("some", ["Name", "Email"]);
    const d = await planAsk("my name and email", desk(), { values: () => MEMORY }, ABOUT, { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "p1", windowId: WIN, now: 2000 });
    expect(d.route === "fill" && d.checked.origin.kind).toBe("ask");
    allMatch((d as { checked: { origin: Origin } }).checked.origin);
  });

  it("an Ask's native plan", async () => {
    const ask = jev("plan", ["Name", "Email"]);
    const d = await planAsk("put my details in and tidy it up", desk(), { values: () => MEMORY }, ABOUT, { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "p2", windowId: WIN, now: 2000 });
    expect((d as { checked: { origin: Origin } }).checked.origin.kind).toBe("ask");
    allMatch((d as { checked: { origin: Origin } }).checked.origin);
  });

  it("an ambient fill proposal, and a plan request planned without an Ask", async () => {
    const m = desk();
    const p = await proposeFill(m, jev("some", []), WIN, "sf/name", 2000, { about: ABOUT, rand: () => 0, newId: () => "fp-1" });
    expect(p.fields.some((f) => f.value !== null)).toBe(true);
    allMatch({ kind: "fill", proposalId: "fp-1" });
    seen.length = 0;
    const d = await planTask("fill out this form", desk(), { values: () => MEMORY }, { askJev: jev("some", []), offerKey: "pt-1", windowId: WIN, now: 2000, rand: () => 0 });
    expect(d.checked.origin).toEqual({ kind: "plan", offerKey: "pt-1" });
    allMatch(d.checked.origin);
  });

  it("an Ask's page goal", async () => {
    const r = await rig();
    const s = (await r.ask("fill out this form from my note")) as Extract<GoalProgress, { event: "segment" }>;
    const plan = r.helper.goals.planOf(s.goalId);
    expect(plan?.origin.kind).toBe("askGoal");
    allMatch(plan?.origin as Origin);
  });

  describe("goals on the desk", () => {
    const scenes: GoalScene[] = [];
    afterEach(async () => {
      for (const x of scenes.splice(0)) await x.close();
    });
    const REPLY: CannedStep[] = [{ fill: { window: "Re: Order", target: "To", value: "priya.raman@northwind.example" } }];

    it("a goal a host requested directly", async () => {
      const sc = goalScene({ scripts: [REPLY], windows: [mailWindow(), replyWindow()], userWindow: "6161-2", askJev: standInJev({ noul: 0.99 }) });
      scenes.push(sc);
      const g = await sc.request("send Priya the reply");
      const plan = g.event === "segment" ? sc.helper.goals.planOf(g.goalId) : null;
      expect(plan?.origin.kind).toBe("goal");
      allMatch(plan?.origin as Origin);
    });

    it("an Ask's writer goal from a window with no field, scoped on the reply window", async () => {
      const values = standInJev({ noul: 0.99 });
      const askJev: AskJev = async (req) => (req.purpose === "ask.heads" || req.purpose === "ask.scope" ? jev("plan", ["To"])(req) : values(req));
      const sc = goalScene({ scripts: [REPLY], windows: [mailWindow(), replyWindow()], userWindow: "6161-1", askJev, ask: { maker: "heads" } });
      scenes.push(sc);
      const g = (await sc.helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "a1", at: sc.desk.at, instruction: "reply to Priya", windowId: "6161-1" }, sc.session, true, true)) as GoalProgress;
      const plan = g.type === "goalProgress" && g.event === "segment" ? sc.helper.goals.planOf(g.goalId) : null;
      expect(plan?.origin.kind).toBe("askGoal");
      allMatch(plan?.origin as Origin);
    });
  });
});

describe("reproduction 1: a field no name reads is never an Ask's to write", () => {
  it("writes nothing into a window whose one field has no name, and says it left it to the user", async () => {
    const unnamed = desk([field("sf/x", "", { frame: [10, 10, 200, 20] })]);
    // A planner Jev that puts the email in any field it is asked about: only the inventory can keep the field out.
    const inner = jev("plan", []);
    const ask: AskJev = async (req) => {
      const r = await inner(req);
      if (req.purpose === "planner.fields") for (const [id, q] of Object.entries(req.questions)) if (id !== "press") r.answers[id] = { choice: Object.entries(q.criteria).find(([, d]) => String(d).startsWith('"elena.vance@example.com"'))?.[0] ?? "keep", confidence: 0.95 };
      return r;
    };
    const r = await planAsk("fill out this form", unnamed, { values: () => MEMORY }, ABOUT, { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "u1", windowId: WIN, now: 2000, rand: () => 0 }).catch((e: unknown) => e);
    const writes = r instanceof AskRefused ? [] : (r as { checked: { writes: unknown[] } }).checked.writes;
    expect(writes).toEqual([]);
    expect(seen.filter((c) => c.field.key === "sf/x")).toEqual([]);
    // And the Ask says the field is the user's.
    expect((r as Error).message).toMatch(/field with no name is yours to fill/u);
  });
});

describe("reproduction 2: a continued Ask settles nothing again, and the attach rule never reruns (doc-1, then doc-2)", () => {
  it("answers a question asked on doc-1 after the page became doc-2: no attachment, no write", async () => {
    let doc = "doc-1";
    const P = "page:i2:resume";
    const m = new ScreenModel();
    m.apply(
      snap(
        [
          node("pg/web", "AXWebArea", { label: "Apply" }),
          field("pg/name", "", { parent: "pg/web", label: "Name", frame: [10, 10, 200, 20] }),
          field("pg/email", "", { parent: "pg/web", label: "Email", frame: [10, 40, 200, 20] }),
        ],
        { at: 1000, windowId: P, kind: "page", title: "Apply", focused: true, focusedKey: "pg/name" },
      ),
    );
    // Jev leaves Email unclear, so the Ask asks which fields; the user answers after the page moved to doc-2.
    const ask: AskJev = async (req) => {
      const r = await jev("some", ["Name"])(req);
      if (req.purpose === "ask.scope") for (const [id, q] of Object.entries(req.questions)) if (scopeLabel(String(q.instructions)) === "Email") r.answers[id] = { choice: "unclear", confidence: 0.95 };
      return r;
    };
    const first = await planAsk("fill in my details", m, { values: () => MEMORY }, ABOUT, { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "r1", windowId: P, now: 2000, documentOf: () => doc }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(AskAsks);
    const q = (first as AskAsks).question;
    expect(q.resume.document).toBe("doc-1");
    doc = "doc-2";
    const pick = q.options.find((c) => c.option.kind === "field" && c.option.label === "Name");
    const after = await planAsk("fill in my details", m, { values: () => MEMORY }, ABOUT, { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "r1", windowId: P, now: 3000, documentOf: () => doc, resume: { ...q.resume, fixed: { ...q.resume.fixed, ...(pick?.fixes ?? {}) } } }).catch((e: unknown) => e);
    const writes = after instanceof AskRefused ? [] : (after as { checked: { writes: unknown[] } }).checked.writes;
    expect(writes).toEqual([]);
  });
});

// Imported for the goal desk's fixtures above.
void [MAIL, line, textField];

describe("ruling 4: authority identifies the request (AskScope.askId)", () => {
  it("refuses a mint from \"use my work email\" under a separate \"use my personal email\" Ask with identical fields", async () => {
    const ask = jev("some", ["Email"]);
    const m = desk();
    const work = await planAsk("use my work email", m, { values: () => MEMORY }, ABOUT, { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "w", windowId: WIN, now: 2000 });
    const personal = await planAsk("use my personal email", m, { values: () => MEMORY }, ABOUT, { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "p", windowId: WIN, now: 2000 });
    const a = work as { plan: unknown; slots: Record<string, string>; checked: { mints: ReadonlyMap<string, CheckedValue>; origin: Origin } };
    const b = personal as { checked: { origin: Origin } };
    expect(a.checked.origin.kind === "ask" && b.checked.origin.kind === "ask" && [...a.checked.origin.scope.fields]).toEqual(b.checked.origin.kind === "ask" ? [...b.checked.origin.scope.fields] : null);
    const { validatePlan } = await import("../src/planner/validate.ts");
    expect(() => validatePlan(a.plan, a.slots, { model: m, memory: MEMORY, instruction: "use my personal email", origin: b.checked.origin, documentOf: null }, a.checked.mints)).toThrow(/another Ask's scope/u);
  });
});

describe("rulings 1 and 2: a resume settles nothing and refuses a changed document; the scope is settled before any question", () => {
  const page = (): ScreenModel => {
    const m = new ScreenModel();
    m.apply(snap([node("pg/web", "AXWebArea", { label: "Apply" }), field("pg/name", "", { parent: "pg/web", label: "Name", frame: [10, 10, 200, 20] }), field("pg/email", "", { parent: "pg/web", label: "Email", frame: [10, 40, 200, 20] })], { at: 1000, windowId: "page:i2:g", kind: "page", title: "Apply", focused: true, focusedKey: "pg/name" }));
    return m;
  };
  /** Jev that leaves Email unclear, so the Ask asks which fields. */
  const unclearEmail = (log: JevRequest[] = []): AskJev => async (req) => {
    const r = await jev("some", ["Name"], log)(req);
    if (req.purpose === "ask.scope") for (const [id, q] of Object.entries(req.questions)) if (scopeLabel(String(q.instructions)) === "Email") r.answers[id] = { choice: "unclear", confidence: 0.95 };
    return r;
  };

  it("a page Ask with goals, answered after the page became doc-2, is refused before any goal is handed off", async () => {
    let doc = "doc-1";
    const m = page();
    const ask = unclearEmail();
    const opts = { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "g1", windowId: "page:i2:g", now: 2000, goals: true as const, documentOf: () => doc };
    const q = ((await planAsk("fill in my details", m, { values: () => MEMORY }, ABOUT, opts).catch((e: unknown) => e)) as AskAsks).question;
    expect(q.resume.document).toBe("doc-1");
    doc = "doc-2";
    const pick = q.options.find((c) => c.option.kind === "field" && c.option.label === "Name");
    const after = await planAsk("fill in my details", m, { values: () => MEMORY }, ABOUT, { ...opts, now: 3000, resume: { ...q.resume, fixed: { ...q.resume.fixed, ...(pick?.fixes ?? {}) } } }).catch((e: unknown) => e);
    expect(after).toBeInstanceOf(AskRefused);
  });

  it("a writer's Ask asks the per-field question before its first question, which carries the frozen scope; its resume asks it no more", async () => {
    const log: JevRequest[] = [];
    const ask = jev("some", ["Name", "Email"], log);
    // The writer cannot tell which fields: the Ask asks which, offering only the fields the scope question settled.
    const writer = { name: "writer" as const, async make() { return { intent: { route: "ask" as const, why: "whichFields" as const, scope: "none" as const, section: "none", fields: [], sources: ["any"], whose: "user", literals: [] }, use: { maker: "writer" as const, model: "t", calls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 } }; } };
    const first = await planAsk("do this one", desk(), { values: () => MEMORY }, ABOUT, { askJev: ask, maker: writer as never, writer: null, offerKey: "wq", windowId: WIN, now: 2000 }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(AskAsks);
    const q = (first as AskAsks).question;
    expect(log.some((r) => r.purpose === "ask.scope")).toBe(true);
    expect(q.resume.scopeKeys?.length).toBe(2);
    const before = log.length;
    const pick = q.options[0];
    await planAsk("do this one", desk(), { values: () => MEMORY }, ABOUT, { askJev: ask, maker: writer as never, writer: null, offerKey: "wq", windowId: WIN, now: 3000, resume: { ...q.resume, fixed: { ...q.resume.fixed, ...(pick?.fixes ?? {}) } } }).catch(() => null);
    expect(log.slice(before).some((r) => r.purpose === "ask.scope")).toBe(false);
  });

  it("refuses a resume that carries no settled scope", async () => {
    const ask = unclearEmail();
    const opts = { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "g2", windowId: "page:i2:g", now: 2000 };
    const m = page();
    const q = ((await planAsk("fill in my details", m, { values: () => MEMORY }, ABOUT, opts).catch((e: unknown) => e)) as AskAsks).question;
    const { scopeKeys: _, ...old } = q.resume;
    await expect(planAsk("fill in my details", m, { values: () => MEMORY }, ABOUT, { ...opts, resume: old as never })).rejects.toBeInstanceOf(AskRefused);
  });
});

describe("ruling 3: an Ask's goal never mints a goal's authority", () => {
  it("withholds the page plan, loudly, when the Ask's scopes hold none for the page's document now", async () => {
    const r = await rig();
    const { planPage } = await import("../src/goals/page-planner.ts");
    const { macClock } = await import("../src/offers/event-time.ts");
    const { scopeSet } = await import("../src/fill/ask-scope.ts");
    const { WIN: PAGE_WIN } = await import("./fake-page.ts");
    const run = planPage(r.helper.model, { goalId: "g-noscope", instruction: "fill out this form", windowId: PAGE_WIN, scope: null, kind: "all", section: null, about: [], askJev: jev("some", []), now: Date.now(), clock: macClock(new Date()), readerSession: 0, pageDocument: (id) => r.host.registry.documentOf(id), scopes: scopeSet("ask-g", null), documentOf: (id) => r.host.registry.documentOf(id) });
    await expect(run).rejects.toThrow(/The Ask settled no field of this page/u);
    expect(seen.filter((c) => c.authority.kind === "goal")).toEqual([]);
  });
});

describe("last round: questions carry and offer only the settled scope", () => {
  const writerSays = (intent: Record<string, unknown>) => ({ name: "writer" as const, async make() { return { intent: { route: "ask", why: "whichFields", scope: "none", section: "none", fields: [], sources: ["any"], whose: "user", literals: [], ...intent } as never, use: { maker: "writer" as const, model: "t", calls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 } }; } });

  it("ruling 3: a writer's refusal still asks the scope question first, so no question is ever saved unsettled", async () => {
    const log: JevRequest[] = [];
    await planAsk("pay for it", desk(), { values: () => MEMORY }, ABOUT, { askJev: jev("some", ["Name"], log), maker: writerSays({ route: "refuse", why: "payment", scope: "none" }) as never, writer: null, offerKey: "rf", windowId: WIN, now: 2000 }).catch(() => null);
    expect(log.some((r) => r.purpose === "ask.scope")).toBe(true);
  });

  it("ruling 4: filters the fields that fit to the settled ones before the option limit", async () => {
    const phones = Array.from({ length: 10 }, (_, i) => field(`sf/p${i + 1}`, "", { label: `Phone ${i + 1}`, frame: [10, 10 + 30 * i, 200, 20] }));
    const e = await planAsk("add my phone", desk(phones), { values: () => MEMORY }, ABOUT, { askJev: jev("some", ["Phone 1", "Phone 2"]), maker: writerSays({}) as never, writer: null, offerKey: "lim", windowId: WIN, now: 2000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskAsks);
    expect((e as AskAsks).question.options.map((c) => (c.option.kind === "field" ? c.option.label : c.option.kind))).toEqual(["Phone 1", "Phone 2"]);
  });

  it("ruling 5: a source question looks for the values of the settled fields only", async () => {
    const m = desk([field("sf/email", "", { label: "Email", frame: [10, 10, 200, 20] }), field("sf/phone", "", { label: "Phone", frame: [10, 40, 200, 20] })]);
    m.apply(snap([field("n1/t", "Email: elena.vance@example.com", { role: "AXTextArea" })], { at: 900, windowId: "n1", title: "Email note.txt", app: { pid: 7201, bundleId: "com.apple.TextEdit", name: "TextEdit" } }));
    m.apply(snap([field("n2/t", "Phone: (512) 555-0147", { role: "AXTextArea" })], { at: 950, windowId: "n2", title: "Phone note.txt", app: { pid: 7202, bundleId: "com.apple.TextEdit", name: "TextEdit" } }));
    m.apply(snap([field("sf/email", "", { label: "Email", frame: [10, 10, 200, 20] }), field("sf/phone", "", { label: "Phone", frame: [10, 40, 200, 20] })], { at: 1000, windowId: WIN, title: "Sign up", app: { pid: 7100, bundleId: "com.example.signup", name: "Signup" }, focused: true, focusedKey: "sf/email" }));
    const e = await planAsk("fill it in from my note", m, { values: () => MEMORY }, ABOUT, { askJev: jev("some", ["Email"]), maker: writerSays({ why: "whichSource", scope: "all" }) as never, writer: null, offerKey: "src", windowId: WIN, now: 2000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskAsks);
    const titles = (e as AskAsks).question.options.map((c) => JSON.stringify(c.option));
    expect(titles.some((t) => t.includes("Email note"))).toBe(true);
    expect(titles.some((t) => t.includes("Phone note"))).toBe(false);
  });
});

describe("final rulings", () => {
  const page = (): ScreenModel => {
    const m = new ScreenModel();
    m.apply(snap([node("pg/web", "AXWebArea", { label: "Apply" }), field("pg/name", "", { parent: "pg/web", label: "Name", frame: [10, 10, 200, 20] }), field("pg/email", "", { parent: "pg/web", label: "Email", frame: [10, 40, 200, 20] })], { at: 1000, windowId: "page:i2:f", kind: "page", title: "Apply", focused: true, focusedKey: "pg/name" }));
    return m;
  };

  it("ruling 2: a fresh Ask whose page became another document while it planned hands off no goal (the attach rule settled doc-1)", async () => {
    let doc = "doc-1";
    const log: JevRequest[] = [];
    const ask = jev("some", ["Name", "Email"], log);
    const heads = headsIntentMaker(ask);
    const flipping = { name: heads.name, make: async (s: Parameters<typeof heads.make>[0], sig?: AbortSignal, settled?: Parameters<typeof heads.make>[2]) => ((doc = "doc-2"), heads.make(s, sig, settled)) };
    const m = page();
    const settled = { askId: "ask-attach", windowId: "page:i2:f", document: "doc-1", seen: {}, asks: ["pg/name", "pg/email"], unresolved: [] };
    const r = await planAsk("fill this in", m, { values: () => MEMORY }, ABOUT, { askJev: ask, maker: flipping as never, writer: null, offerKey: "f1", windowId: "page:i2:f", now: 2000, goals: true, documentOf: () => doc, settled }).catch((e: unknown) => e);
    expect(r).toBeInstanceOf(AskRefused);
    expect(log.filter((q) => q.purpose === "ask.scope")).toHaveLength(0);
  });

  it("ruling 3: a field Jev answered \"asks\" below the cutoff is offered, and the user's pick puts it in the scope, recorded as theirs", async () => {
    const low: AskJev = async (req) => {
      const r = await jev("some", [])(req);
      if (req.purpose === "ask.scope") for (const [id, q] of Object.entries(req.questions)) if (scopeLabel(String(q.instructions)) === "Email") r.answers[id] = { choice: "asks", confidence: 0.3 };
      return r;
    };
    const e = await planAsk("my email", desk(), { values: () => MEMORY }, ABOUT, { askJev: low, maker: headsIntentMaker(low), writer: null, offerKey: "lo", windowId: WIN, now: 2000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskAsks);
    const q = (e as AskAsks).question;
    const email = q.options.find((c) => c.option.kind === "field" && c.option.label === "Email");
    expect(email).toBeDefined();
    const d = await planAsk("my email", desk(), { values: () => MEMORY }, ABOUT, { askJev: low, maker: headsIntentMaker(low), writer: null, offerKey: "lo", windowId: WIN, now: 3000, resume: { ...q.resume, fixed: { ...q.resume.fixed, ...(email?.fixes ?? {}) } } });
    const origin = (d as { checked: { origin: Origin; writes: { node: { key: string } }[] } }).checked;
    expect(origin.writes.map((w) => w.node.key)).toEqual(["sf/email"]);
    expect(origin.origin.kind === "ask" && [...origin.origin.scope.picked]).toEqual(["sf/email"]);
  });
});

describe("follow-up: a below-cutoff field is offered beside an unclear one", () => {
  it("offers Email (\"asks\" at 0.3) beside Name (\"unclear\"), and a pick of Email puts it in the scope", async () => {
    const ask: AskJev = async (req) => {
      const r = await jev("some", [])(req);
      if (req.purpose === "ask.scope")
        for (const [id, q] of Object.entries(req.questions)) {
          const ins = String(q.instructions);
          if (scopeLabel(ins) === "Name") r.answers[id] = { choice: "unclear", confidence: 0.95 };
          if (scopeLabel(ins) === "Email") r.answers[id] = { choice: "asks", confidence: 0.3 };
        }
      return r;
    };
    const e = await planAsk("my details", desk(), { values: () => MEMORY }, ABOUT, { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "nu", windowId: WIN, now: 2000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskAsks);
    const q = (e as AskAsks).question;
    expect(q.options.map((c) => (c.option.kind === "field" ? c.option.label : c.option.kind))).toEqual(["Name", "Email"]);
    const email = q.options.find((c) => c.option.kind === "field" && c.option.label === "Email");
    const d = await planAsk("my details", desk(), { values: () => MEMORY }, ABOUT, { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "nu", windowId: WIN, now: 3000, resume: { ...q.resume, fixed: { ...q.resume.fixed, ...(email?.fixes ?? {}) } } });
    const c = (d as { checked: { origin: Origin; writes: { node: { key: string } }[] } }).checked;
    expect(c.writes.map((w) => w.node.key)).toEqual(["sf/email"]);
    expect(c.origin.kind === "ask" && [...c.origin.scope.picked]).toEqual(["sf/email"]);
  });
});
