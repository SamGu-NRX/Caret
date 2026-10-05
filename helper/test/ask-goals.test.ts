// B30 part 1: an Ask whose intent route is plan, from a host that runs goal plans, is offered as a D2-06 goal: the same
// preview (segments, digests), the same acceptances and receipts. A consumer that does not run goal plans keeps the
// single-window planner. Every name and number is invented.
import { afterEach, describe, expect, it } from "vitest";
import type { AskJev } from "../src/fill/jev.ts";
import { PROTOCOL_VERSION, type GoalProgress } from "../src/protocol.ts";
import { WRITER_ROUTE } from "../src/writer/config.ts";
import type { WriterPort } from "../src/writer/port.ts";
import type { PlanningSnapshot } from "../src/codemode/types.ts";
import { areaKey, cannedProgram, caseWindow, detailsWindow, fieldKey, goalScene, MAIL, mailWindow, replyWindow, SUPPORT, type CannedStep, type GoalScene } from "./goal-desk.ts";

const ORDER = "ORD-2026-48213";
const PROBLEM = "The desk lamp arrived with a cracked base and does not switch on.";
const STEPS: CannedStep[] = [
  { fill: { window: "New case", target: "Order number", value: ORDER } },
  { fill: { window: "Case details", target: "Description", value: "cracked base" } },
];
const INSTRUCTION = "copy the order number from the email into the support case, then put the problem in the case description";

/** One writer for both kinds: the intent says `route`, and each goal request gets the scene's canned program. */
function askAndGoalWriter(route: string): WriterPort & { kinds: string[] } {
  const kinds: string[] = [];
  return {
    route: WRITER_ROUTE,
    kinds,
    async write(req) {
      kinds.push(req.kind);
      const base = { model: "canned", provider: "canned", inputTokens: 0, outputTokens: 0, reasoningTokens: 0, latencyMs: 0, costUsd: 0 };
      if (req.kind === "intent") {
        const json = { route, why: "none", scope: route === "fill" ? "all" : "none", section: "none", fields: [], sources: ["any"], whose: "user", literals: [] };
        return { ...base, output: { program: null, reply: JSON.stringify(json), json } };
      }
      const program = cannedProgram((req.input as { snapshots: PlanningSnapshot[] }).snapshots, STEPS);
      return { ...base, output: { program, reply: program } };
    },
  };
}
/** Jev that is never asked anything on these paths: a call fails the test. */
const silentJev: AskJev = async () => {
  throw new Error("Jev was asked");
};

const scenes: GoalScene[] = [];
afterEach(async () => {
  for (const s of scenes.splice(0)) await s.close();
});
function scene(route = "plan"): GoalScene & { writer2: ReturnType<typeof askAndGoalWriter> } {
  const writer2 = askAndGoalWriter(route);
  const sc = goalScene({ scripts: [STEPS], windows: [mailWindow(), caseWindow(), detailsWindow()], userWindow: "7171-1", writer: writer2, askJev: silentJev, ask: { maker: "writer", writer: writer2 } });
  scenes.push(sc);
  return Object.assign(sc, { writer2 });
}
const ask = (sc: GoalScene, canGoal: boolean, requestId = "a1") =>
  sc.helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId, at: sc.desk.at, instruction: INSTRUCTION, windowId: "7171-1" }, sc.session, true, canGoal);

describe("Ask's plan route for a host that runs goal plans", () => {
  it("answers with the goal's first preview, the same one a goalRequest gets", async () => {
    const sc = scene();
    const viaAsk = await ask(sc, true);
    expect(viaAsk.type).toBe("goalProgress");
    const preview = viaAsk as Extract<GoalProgress, { event: "segment" }>;
    expect(preview).toMatchObject({ event: "segment", requestId: "a1", segment: 0, segments: 2, reason: "start" });
    expect(sc.writer2.kinds).toEqual(["intent", "goal"]);
    const direct = goalScene({ scripts: [STEPS], windows: [mailWindow(), caseWindow(), detailsWindow()], userWindow: "7171-1" });
    scenes.push(direct);
    const viaGoal = await direct.request(INSTRUCTION);
    expect(viaGoal).toMatchObject({ event: "segment", steps: preview.steps, digest: preview.digest, where: preview.where });
  });

  it("runs only on the preview's acceptances, segment by segment, with receipts", async () => {
    const sc = scene();
    const first = (await ask(sc, true)) as Extract<GoalProgress, { event: "segment" }>;
    sc.goals.push(first);
    expect(sc.desk.writes).toEqual([]);
    await sc.accept(first.goalId);
    await sc.accept(first.goalId);
    expect(sc.desk.node("7171-1", fieldKey(SUPPORT, "Order number"))?.value).toBe(ORDER);
    expect(sc.desk.node("7171-2", areaKey(SUPPORT, "Description"))?.value).toBe(PROBLEM);
    expect(sc.helper.goals.get(first.goalId)?.cursor.receipts.map((r) => r.status)).toEqual(["verified", "verified"]);
    expect(sc.goals.at(-1)).toMatchObject({ event: "finished", outcome: "done", verified: 2 });
  });

  it("keeps the single-window planner for a consumer that does not run goal plans", async () => {
    const sc = scene();
    const r = await ask(sc, false);
    expect(r.type).toBe("planProposal");
    expect(sc.writer2.kinds).not.toContain("goal");
  });
});

describe("an Ask from the email the user is reading", () => {
  it("acts in the reply and copies from the email, which stays a source", async () => {
    const steps: CannedStep[] = [
      { fill: { window: "Re: Order", target: "To", value: "priya.raman@northwind.example" } },
      { fill: { window: "Re: Order", target: "Message", value: "cracked base" } },
    ];
    const writer = { ...askAndGoalWriter("plan"), write: async (req: Parameters<WriterPort["write"]>[0]) => {
      const base = { model: "canned", provider: "canned", inputTokens: 0, outputTokens: 0, reasoningTokens: 0, latencyMs: 0, costUsd: 0 };
      if (req.kind === "intent") {
        const json = { route: "plan", why: "none", scope: "none", section: "none", fields: [], sources: ["any"], whose: "user", literals: [] };
        return { ...base, output: { program: null, reply: JSON.stringify(json), json } };
      }
      const program = cannedProgram((req.input as { snapshots: PlanningSnapshot[] }).snapshots, steps);
      return { ...base, output: { program, reply: program } };
    } };
    const sc = goalScene({ scripts: [], windows: [mailWindow(), replyWindow()], userWindow: "6161-1", writer, askJev: silentJev, ask: { maker: "writer", writer } });
    scenes.push(sc);
    const r = await sc.helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "m1", at: sc.desk.at, instruction: "reply to Priya with the problem", windowId: "6161-1" }, sc.session, true, true);
    expect(r).toMatchObject({ type: "goalProgress", event: "segment", where: { kind: "window", title: "Re: Order ORD-2026-48213 arrived damaged" } });
    sc.goals.push(r as GoalProgress);
    await sc.accept((r as GoalProgress).goalId);
    expect(sc.desk.node("6161-2", fieldKey(MAIL, "To"))?.value).toBe("priya.raman@northwind.example");
  });
});
