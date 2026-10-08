// I2: the lead's rulings on the re-review of 487bdf0, each as the reviewer's reproduction: the Ask's scope is settled
// once by the per-field scope question (uploads with the fields, in document order), frozen with the document it was
// asked on, kept by a goal across its replans, and asked on every route of every maker.
import { afterEach, describe, expect, it } from "vitest";
import { scopeSet } from "../src/fill/ask-scope.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { ScreenModel } from "../src/model.ts";
import { FILE_INPUT_SUBROLE } from "../src/engines/page-link.ts";
import { AskRefused, planAsk, type AskGoal } from "../src/planner/ask.ts";
import { headsIntentMaker, scopeRequest } from "../src/planner/intent-heads.ts";
import type { IntentMaker } from "../src/planner/intent-makers.ts";
import { intentSnapshot, type AskIntent } from "../src/planner/intent.ts";
import { buildInventory } from "../src/goals/inventory.ts";
import { lowerGoal } from "../src/goals/lower.ts";
import { runCodePlan } from "../src/codemode/sandbox.ts";
import { macClock } from "../src/offers/event-time.ts";
import { caseWindow, cannedProgram, goalScene, mailWindow, standInJev, SUPPORT, textField, type CannedStep, type GoalScene } from "./goal-desk.ts";
import { field, node, optionIs, scopeLabel, snap } from "./builders.ts";

const PAGE = "page:i2:9";
const WEB = "pg/web";
const NAME = "pg/name";
const EMAIL = "pg/email";
const RESUME = "pg/resume";
const ABOUT = [
  { id: "about-1", label: "Name", value: "Elena Vance", kind: "fullName" },
  { id: "about-2", label: "Email", value: "elena.vance@example.com", kind: "email" },
] as never[];
const MEMORY = [
  { id: "about-1", label: "Name", text: "Elena Vance", whose: "user" as const },
  { id: "about-2", label: "Email", text: "elena.vance@example.com", whose: "user" as const },
];

/** A page with Name and Email, then a Documents group holding a Resume upload. */
function page(): ScreenModel {
  const m = new ScreenModel();
  m.apply(
    snap(
      [
        node(WEB, "AXWebArea", { label: "Apply" }),
        field(NAME, "", { parent: WEB, label: "Name", frame: [10, 10, 200, 20] }),
        field(EMAIL, "", { parent: WEB, label: "Email", frame: [10, 40, 200, 20] }),
        node("pg/docs", "AXGroup", { parent: WEB, subrole: "AXFieldset", label: "Documents" }),
        node(RESUME, "AXButton", { parent: "pg/docs", subrole: FILE_INPUT_SUBROLE, label: "Resume", frame: [10, 70, 80, 20] }),
      ],
      { at: 1000, windowId: PAGE, kind: "page", title: "Apply", focused: true, focusedKey: NAME },
    ),
  );
  return m;
}

/** Jev: the scope question asks for the fields in `asks` by label; value questions take VALUES; confirmations say yes. */
const jev = (asks: readonly string[], seen: JevRequest[] = []): AskJev => async (req) => {
  seen.push(req);
  const VALUES: Record<string, string> = { Name: "Elena Vance", Email: "elena.vance@example.com" };
  return {
    model: "t",
    inputTokens: 1,
    latencyMs: 1,
    costUsd: 0,
    answers: Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        const ins = String(q.instructions);
        const pick = (c: string) => [id, { choice: c, confidence: 0.95 }] as const;
        if (req.purpose === "ask.heads") return pick({ route: "some", why: "nothingToFill", source: "any", whose: "user" }[id] ?? "none");
        if (req.purpose === "ask.scope" && id === "section") return pick("fields");
        if (req.purpose === "ask.scope") return pick(asks.includes(scopeLabel(ins)) ? "asks" : "not");
        if ("yes" in q.criteria) return pick("yes");
        const want = Object.entries(VALUES).find(([l]) => ins.includes(`'${l}'`))?.[1];
        const hit = want === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => optionIs(d, want));
        if (hit !== undefined) return pick(hit[0]);
        if ("user" in q.criteria) return pick("user");
        return pick(Object.keys(q.criteria).at(-1) ?? "none");
      }),
    ),
  };
};

/** A maker that reads the instruction as `intent`, as the writer does: no per-field scope of its own. */
const writerLike = (intent: Partial<AskIntent>): IntentMaker => ({
  name: "writer",
  async make() {
    return { intent: { route: "fill", why: "none", scope: "all", section: "none", fields: [], sources: ["any"], whose: "user", literals: [], ...intent }, use: { maker: "writer", model: "t", calls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 } };
  },
});

describe("ruling B: uploads are asked in the same scope question as the fields, in document order", () => {
  it("asks Name, Email and the Resume upload in one request each wording, the upload last, with its group declared", () => {
    const s = intentSnapshot("fill this in and attach my resume", page(), page().windows.get(PAGE) as never, []);
    for (const w of [0, 1] as const) {
      const req = scopeRequest(s, w);
      // SCP1: the field questions; the section question rides beside them.
      const ins = Object.entries(req.questions).filter(([id]) => id !== "section").map(([, q]) => String(q.instructions));
      expect(ins.map((t) => scopeLabel(t))).toEqual(["Name", "Email", "Resume"]);
      expect(ins[2]).toContain("file upload");
      expect(req.snippets.map((x) => x.text)).toContain("Documents");
    }
  });
});

describe("ruling B: the scope's document is read with the question's snapshot, before planning awaits", () => {
  it("writes nothing when the page turns into another document while the intent is made", async () => {
    let doc = "doc-1";
    const ask = jev(["Name"]);
    const heads = headsIntentMaker(ask);
    const flipping: IntentMaker = { name: heads.name, make: async (s) => ((doc = "doc-2"), heads.make(s)) };
    const r = await planAsk("my name please", page(), { values: () => MEMORY }, ABOUT, { askJev: ask, maker: flipping, writer: null, offerKey: "d1", windowId: PAGE, now: 2000, documentOf: () => doc }).catch((e: unknown) => e);
    const writes = r instanceof AskRefused ? [] : (r as { checked: { writes: unknown[] } }).checked.writes;
    expect(writes).toEqual([]);
    // The same Ask on a page that stays one document writes Name: the refusal above is the document's.
    const stable = await planAsk("my name please", page(), { values: () => MEMORY }, ABOUT, { askJev: ask, maker: heads, writer: null, offerKey: "d2", windowId: PAGE, now: 2000, documentOf: () => "doc-1" });
    expect((stable as { checked: { writes: { node: { key: string } }[] } }).checked.writes.map((w) => w.node.key)).toEqual([NAME]);
  });
});

describe("ruling D: a writer's plan on a page asks the per-field question; no whole-form confirmation stands in", () => {
  it("keeps Email out of the page goal's scope when the scope question does not choose it, and takes the upload it chose", async () => {
    const seen: JevRequest[] = [];
    const d = (await planAsk("fill out this form and attach my resume", page(), { values: () => MEMORY }, [], { askJev: jev(["Name", "Resume"], seen), maker: writerLike({ route: "plan", scope: "none" }), writer: null, offerKey: "w1", windowId: PAGE, now: 2000, goals: true })) as AskGoal;
    expect(d.route).toBe("goal");
    expect(seen.some((r) => r.purpose === "ask.scope")).toBe(true);
    expect([...(d.askScope?.fields ?? [])].sort()).toEqual([NAME, RESUME]);
    // Ruling E: the upload Jev chose joins the page's own scope, so the page planner offers its attach row.
    expect(d.page?.scope.fields).toEqual([NAME, RESUME]);
  });
});

describe("ruling C: a goal's scopes persist across replans; a changed field is refused, never settled again", () => {
  const scenes: GoalScene[] = [];
  afterEach(async () => {
    for (const s of scenes.splice(0)) await s.close();
  });
  const STEPS: CannedStep[] = [{ fill: { window: "New case", target: "Order number", value: "ORD-2026-48213" } }];

  it("settles the case window once, reuses it, and drops the write after the field is relabelled", async () => {
    const sc = goalScene({ scripts: [], windows: [mailWindow(), caseWindow()], userWindow: "7171-1", askJev: standInJev() });
    scenes.push(sc);
    let settles = 0;
    const settleScope = async (windowId: string, document: string | null) => {
      settles++;
      const { askScope, fieldFingerprint } = await import("../src/fill/ask-scope.ts");
      const w = sc.helper.model.windows.get(windowId) as never;
      const key = "dev.caret.supportfixture/standard/textfield:order number~0";
      return askScope(windowId, document, [key], { [key]: fieldFingerprint(w, key) }, null, "ask-c");
    };
    const lower = async (scopes: ReturnType<typeof scopeSet>) => {
      const inv = buildInventory(sc.helper.model, { instruction: "copy the order number into the case", windows: ["7171-1", "6161-1"], memory: [], calendar: null, clock: macClock(new Date(sc.desk.at)), now: sc.desk.at, readerSession: 1 });
      const ran = await runCodePlan(cannedProgram(inv.snapshots, STEPS), inv.snapshots, async () => null, { multiWindow: true, drafts: true });
      if (!ran.ok) throw new Error(`sandbox ${ran.kind}: ${ran.detail}`);
      return lowerGoal("g-c", "copy the order number into the case", ran.plan, inv.inventory, { askJev: standInJev(), ledger: inv.ledger, scopes, documentOf: null, settleScope });
    };
    const first = await lower(scopeSet("ask-c", null));
    expect(settles).toBe(1);
    expect(first.segments.flatMap((x) => x.steps).filter((x) => x.kind === "write")).toHaveLength(1);
    const again = await lower(first.scopes as ReturnType<typeof scopeSet>);
    expect(settles).toBe(1);
    expect(again.segments.flatMap((x) => x.steps).filter((x) => x.kind === "write")).toHaveLength(1);
    // The Order number field now reads as another field: the kept scope refuses it, and nothing settles it again.
    sc.desk.show({ ...caseWindow(), nodes: [textField(SUPPORT, "Order number", ""), ...caseWindow().nodes.slice(1)].map((n) => (n.label === "Order number" ? { ...n, placeholder: "Your previous order" } : n)) });
    // With its one write dropped the plan has nothing left, and says why.
    await expect(lower(first.scopes as ReturnType<typeof scopeSet>)).rejects.toThrow(/'Order number' changed since Caret asked about it/u);
    expect(settles).toBe(1);
  });
});
