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
import { field, node, snap } from "./builders.ts";
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
        if (req.purpose === "ask.scope") return pick(asks.includes(/[Tt]he field '([^']+)'/u.exec(ins)?.[1] ?? "") ? "asks" : "not");
        if (id === "press") return pick("none" in q.criteria ? "none" : (Object.keys(q.criteria).at(-1) ?? "none"));
        const want = Object.entries(VALUES).find(([l]) => ins.includes(`'${l}'`))?.[1];
        const hit = want === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => String(d).startsWith(`"${want}"`));
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
      if (req.purpose === "ask.scope") for (const [id, q] of Object.entries(req.questions)) if (/field 'Email'/u.test(String(q.instructions))) r.answers[id] = { choice: "unclear", confidence: 0.95 };
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
