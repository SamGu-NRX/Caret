// H9: the user's own words over a draft in a goal's preview (goalEdit). The segment is previewed again with the words as
// the user's value under a new digest; nothing runs until that preview is accepted, and the old digest is refused. Only
// a drafted write of the segment waiting can be edited, by the connection it was offered to. Every name is invented.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YOURS_EFFECT } from "../src/goals/capabilities.ts";
import { ConsumerMessage, GOAL_PLANS_CAPABILITY, HelperMessage, PROTOCOL_VERSION, type GoalEdit, type GoalProgress } from "../src/protocol.ts";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { LineClient, until } from "./socket-reader.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { areaKey, fieldKey, goalScene, MAIL, mailWindow, replyWindow, standInJev, type CannedStep, type GoalScene } from "./goal-desk.ts";

const EMAIL = "priya.raman@northwind.example";
const DRAFT = "Hi Priya, I'm in for Thursday, October 8 at 3:00 PM.";
const MINE = "Thursday at 3 works. I'll bring the receipt.";
const REPLY: CannedStep[] = [
  { fill: { window: "Re: Order", target: "To", value: EMAIL } },
  { draft: { window: "Re: Order", target: "Message", text: DRAFT, from: ["Order ORD-2026-48213 arrived damaged"] } },
  { press: { window: "Re: Order", target: "Send", effect: YOURS_EFFECT } },
];
type Segment = Extract<GoalProgress, { event: "segment" }>;

const scenes: GoalScene[] = [];
afterEach(async () => {
  for (const s of scenes.splice(0)) await s.close();
});
async function previewed(): Promise<{ sc: GoalScene; first: Segment }> {
  const sc = goalScene({ scripts: [REPLY], windows: [mailWindow(), replyWindow()], userWindow: "6161-2", askJev: standInJev({ noul: 0.99 }) });
  scenes.push(sc);
  const first = await sc.request("draft a reply to Priya saying I'm in");
  if (first.event !== "segment") throw new Error(`no preview: ${JSON.stringify(first)}`);
  return { sc, first };
}
const edit = (first: Segment, over: Partial<GoalEdit> = {}): GoalEdit => ({ type: "goalEdit", v: PROTOCOL_VERSION, goalId: first.goalId, segment: first.segment, digest: first.digest, step: 1, text: MINE, at: 0, ...over });
const errors = (sc: GoalScene): string[] => sc.published.flatMap((m: HelperMessage) => (m.type === "error" ? [m.message] : []));

describe("goalEdit", () => {
  it("previews the segment again with the user's words, not a draft, under a new digest", async () => {
    const { sc, first } = await previewed();
    expect(first.steps[1]).toMatchObject({ kind: "write", drafted: DRAFT });
    const again = sc.helper.handleGoalEdit(edit(first), sc.session);
    expect(again).toMatchObject({ event: "segment", goalId: first.goalId, segment: 0, reason: "start", requestId: first.requestId });
    const shown = again as Segment;
    expect(shown.digest).not.toBe(first.digest);
    expect(shown.steps[1]).toEqual({ index: 1, kind: "write", says: `Message: ${MINE}` });
    expect(shown.steps[0]).toEqual(first.steps[0]);
    expect(shown.steps[2]).toEqual(first.steps[2]);
    // Published to goal hosts, as every later preview is.
    expect(sc.published.at(-1)).toEqual(shown);
    expect(sc.desk.writes).toEqual([]);
  });

  it("runs the user's words only on the new preview's acceptance, and refuses the old digest", async () => {
    const { sc, first } = await previewed();
    const shown = sc.helper.handleGoalEdit(edit(first), sc.session) as Segment;
    sc.goals.push(shown);
    await sc.accept(first.goalId, { digest: first.digest });
    expect(errors(sc).at(-1)).toMatch(/^goalAccept refused: the acceptance names another plan/);
    expect(sc.desk.writes).toEqual([]);
    await sc.accept(first.goalId, { digest: shown.digest });
    expect(sc.desk.node("6161-2", areaKey(MAIL, "Message"))?.value).toBe(MINE);
    expect(sc.desk.node("6161-2", fieldKey(MAIL, "To"))?.value).toBe(EMAIL);
    expect(sc.goals.at(-1)).toMatchObject({ event: "finished", outcome: "handoff" });
  });

  it("refuses anything but a drafted write of the segment waiting, from its own connection, and changes nothing", async () => {
    const { sc, first } = await previewed();
    const refused = (m: GoalEdit, session = sc.session): string => {
      expect(sc.helper.handleGoalEdit(m, session)).toBeNull();
      return errors(sc).at(-1) ?? "";
    };
    expect(refused(edit(first, { step: 0 }))).toMatch(/not text Caret drafted/);
    expect(refused(edit(first, { step: 2 }))).toMatch(/not text Caret drafted/);
    expect(refused(edit(first, { step: 7 }))).toMatch(/step 8 is not in segment 1/);
    expect(refused(edit(first, { digest: "0".repeat(64) }))).toMatch(/another plan/);
    expect(refused(edit(first, { segment: 1 }))).toMatch(/waits for segment 1, not 2/);
    expect(refused(edit(first), "another-host"))
      .toMatch(/offered to another connection/);
    expect(refused(edit(first, { goalId: "goal-none" }))).toMatch(/no goal goal-none/);
    expect(refused(edit(first, { text: "   " }))).toMatch(/empty/);
    // A value Caret never types, by its shape, is refused here as a draft of it would be (gates.ts codeGate).
    expect(refused(edit(first, { text: "4111 1111 1111 1111" }))).toMatch(/Caret never types/);
    // Nothing above changed the preview: its digest is still the one to accept.
    await sc.accept(first.goalId, { digest: first.digest });
    expect(sc.desk.node("6161-2", areaKey(MAIL, "Message"))?.value).toBe(DRAFT);
  });

  it("cannot edit a segment once it was accepted", async () => {
    const { sc, first } = await previewed();
    await sc.accept(first.goalId);
    expect(sc.helper.handleGoalEdit(edit(first), sc.session)).toBeNull();
    expect(errors(sc).at(-1)).toMatch(/^goalEdit refused: goal .* is not waiting for segment 1/);
  });

  it("is a consumer message with the acceptance's digest rules and the draft's length", () => {
    const ok = edit({ goalId: "goal-1-r1", segment: 0, digest: "a".repeat(64) } as Segment);
    expect(ConsumerMessage.safeParse(ok).success).toBe(true);
    for (const bad of [{ digest: "A".repeat(64) }, { text: "" }, { text: "x".repeat(601) }, { step: -1 }]) expect(ConsumerMessage.safeParse({ ...ok, ...bad }).success).toBe(false);
  });
});

describe("the goal edit and partial lines (fixtures/golden/goal-edit-and-partial.ndjson)", () => {
  // Generated from desk runs: a draft previewed, the user's words over it, the old digest refused, the new one run to a
  // hand-off; and a goal whose dropped write leaves it partial (G2). The host decodes the same file.
  const lines = readFileSync(new URL("../fixtures/golden/goal-edit-and-partial.ndjson", import.meta.url), "utf8").trim().split("\n");
  const CONSUMER = new Set(["goalRequest", "goalAccept", "goalEdit"]);

  it("parses every line and writes it back byte for byte", () => {
    const parsed = lines.map((l) => JSON.parse(l) as { type: string; event?: string });
    expect(parsed.map((m) => (m.type === "goalProgress" ? `goalProgress:${m.event}` : m.type))).toEqual([
      "goalRequest", "goalProgress:segment", "goalEdit", "goalProgress:segment", "goalAccept", "error", "goalAccept",
      "goalProgress:step", "goalProgress:step", "goalProgress:step", "goalProgress:finished",
      "goalRequest", "goalProgress:segment", "goalAccept", "goalProgress:step", "goalProgress:finished",
    ]);
    for (const [i, l] of lines.entries()) {
      const m = parsed[i] as { type: string };
      expect(JSON.stringify((CONSUMER.has(m.type) ? ConsumerMessage : HelperMessage).parse(m)), `line ${i + 1}`).toBe(l);
    }
  });
});

describe("goalEdit on the socket", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-goal-edit-"));
    store = new Store(join(dir, "data"));
    const own: HelperServer = new HelperServer(join(dir, "screen.sock"), () => mine, () => {});
    const mine: Helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => own.publish(m) });
    helper = mine;
    server = own;
    await server.listen();
  });
  afterEach(async () => {
    await server.close();
    helper.shutdown();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const goalEdit = { type: "goalEdit", v: PROTOCOL_VERSION, goalId: "goal-1-r1", segment: 0, digest: "a".repeat(64), step: 1, text: "Yes.", at: 1 } as const;

  it("is refused by name from a host without goalPlans, and answered to the asker alone when it names no goal", async () => {
    const old = await LineClient.connect(join(dir, "screen.sock"));
    old.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "old-host", host: true });
    old.send(goalEdit);
    const e = await old.waitFor((m) => m.type === "error");
    expect(e.message).toBe(`goalEdit needs a host hello with "${GOAL_PLANS_CAPABILITY}" in its capabilities`);
    old.close();
    const host = await LineClient.connect(join(dir, "screen.sock"));
    host.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 2, version: "caret-host", host: true, capabilities: [GOAL_PLANS_CAPABILITY] });
    const other = await LineClient.connect(join(dir, "screen.sock"));
    other.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 3, version: "caret-host-2", host: true, capabilities: [GOAL_PLANS_CAPABILITY] });
    await until(() => helper.hostPresent);
    host.send(goalEdit);
    await host.waitFor((m) => m.type === "error" && m.message === "goalEdit refused: no goal goal-1-r1");
    await new Promise((r) => setTimeout(r, 50));
    expect(other.received.filter((m) => (m as { type: string }).type === "error")).toEqual([]);
    host.close();
    other.close();
  });
});

// I2: an Ask's goal edits are held to the scope the drafted value was minted under (fill/ask-scope.ts).
describe("goalEdit under an Ask's scope (I2)", () => {
  async function askPreviewed(from = "6161-2"): Promise<{ sc: GoalScene; first: Segment }> {
    const values = standInJev({ noul: 0.99 });
    // Heads say plan; the scope ask chooses Message alone, so the program's To is left out.
    const askJev: AskJev = async (req) => {
      if (req.purpose === "ask.heads") return { model: "t", inputTokens: 0, latencyMs: 0, costUsd: 0, answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: { route: "plan", why: "nothingToFill", source: "any", whose: "user" }[id] ?? "none", confidence: 0.95 }])) };
      if (req.purpose === "ask.scope") return { model: "t", inputTokens: 0, latencyMs: 0, costUsd: 0, answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { choice: /[Tt]he field 'Message'/u.test(String(q.instructions)) ? "asks" : "not", confidence: 0.95 }])) };
      return values(req);
    };
    const sc = goalScene({ scripts: [REPLY], windows: [mailWindow(), replyWindow()], userWindow: "6161-2", askJev, ask: { maker: "heads" } });
    scenes.push(sc);
    const first = (await sc.helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "a1", at: sc.desk.at, instruction: "write the message saying I'm in", windowId: from }, sc.session, true, true)) as GoalProgress;
    if (first.type !== "goalProgress" || first.event !== "segment") throw new Error(`no preview: ${JSON.stringify(first)}`);
    return { sc, first };
  }

  it("from the email, a window with no field: settles the reply window's scope when the goal writes there (ruling 5)", async () => {
    const { sc, first } = await askPreviewed("6161-1");
    expect(first.steps.some((s) => s.says.startsWith("To:"))).toBe(false);
    expect(first.steps.some((s) => s.kind === "write" && "drafted" in s)).toBe(true);
    expect(JSON.stringify(first)).toContain("the Ask did not ask Caret to fill");
    expect(sc.desk.writes).toEqual([]);
  });

  it("drops the write Jev did not choose, and takes the user's words over the draft it did", async () => {
    const { sc, first } = await askPreviewed();
    expect(first.steps.some((s) => s.says.startsWith("To:"))).toBe(false);
    const step = first.steps.findIndex((s) => s.kind === "write" && "drafted" in s);
    expect(sc.helper.handleGoalEdit(edit(first, { step }), sc.session)).toMatchObject({ event: "segment" });
  });

  it("refuses the edit once the drafted field reads differently than when the Ask was asked", async () => {
    const { sc, first } = await askPreviewed();
    const step = first.steps.findIndex((s) => s.kind === "write" && "drafted" in s);
    const w = replyWindow();
    sc.desk.show({ ...w, nodes: [{ key: "dev.caret.mailfixture/standard/heading:other~0", parent: null, role: "AXHeading", label: "Internal note" }, ...w.nodes] });
    const r = sc.helper.handleGoalEdit(edit(first, { step }), sc.session);
    expect(r).not.toMatchObject({ event: "segment", digest: expect.any(String), steps: expect.arrayContaining([expect.objectContaining({ says: `Message: ${MINE}` })]) });
    expect(sc.desk.writes).toEqual([]);
  });
});
