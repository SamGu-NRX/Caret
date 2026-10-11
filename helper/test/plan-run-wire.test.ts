// D2-06: the goal plan protocol. fixtures/golden/plan-run.ndjson is the contract a host decodes (H6 builds the UI):
// a host hello that declares goalPlans, a goal request and its first segment's preview, each acceptance and the
// progress it starts, a repeated acceptance refused, a goal a dialog stopped with its fresh plan, and a request code
// refused. Only a host that declared the capability may send the two goal messages or receive goalProgress.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { SAYS } from "../src/planner/says.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnyMessage, ConsumerMessage, GOAL_PLANS_CAPABILITY, HelperMessage, PROTOCOL_VERSION } from "../src/protocol.ts";
import { HelperServer } from "../src/server.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { LineClient, until } from "./socket-reader.ts";

const lines = readFileSync(new URL("../fixtures/golden/plan-run.ndjson", import.meta.url), "utf8").trim().split("\n");
const CONSUMER = new Set(["hello", "goalRequest", "goalAccept"]);
const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

describe("the goal plan protocol lines", () => {
  it("parses every golden line and writes it back byte for byte", () => {
    expect(parsed.map((m) => (m.type === "goalProgress" ? `${String(m.type)}:${String(m.event)}` : m.type))).toEqual([
      "hello", "goalRequest", "goalProgress:segment", "goalAccept", "goalProgress:step", "goalProgress:segment", "goalAccept",
      "goalProgress:step", "goalProgress:step", "goalProgress:step", "goalProgress:finished", "goalAccept", "error",
      "goalRequest", "goalProgress:segment", "goalAccept", "goalProgress:step", "goalProgress:stopped", "goalProgress:segment",
      "goalRequest", "goalProgress:stopped",
      "goalRequest", "goalProgress:segment", "goalAccept",
    ]);
    for (const [i, l] of lines.entries()) {
      const m = parsed[i] as { type: string };
      expect(JSON.stringify((CONSUMER.has(m.type) ? ConsumerMessage : HelperMessage).parse(m)), `line ${i + 1}`).toBe(l);
    }
  });

  it("ties each acceptance to the preview it answers, and each fresh plan to the goal it replaces", () => {
    const previews = parsed.filter((m) => m.event === "segment");
    for (const a of parsed.filter((m) => m.type === "goalAccept")) expect(previews.some((p) => p.goalId === a.goalId && p.segment === a.segment && p.digest === a.digest)).toBe(true);
    const stop = parsed.find((m) => m.event === "stopped" && m.reason === "dialog");
    const fresh = parsed.find((m) => m.event === "segment" && m.reason === "freshPlan");
    expect([stop?.freshPlan, fresh?.replaces]).toEqual([fresh?.goalId, stop?.goalId]);
    // A hand-off finish says the draft is ready and the press is the user's; it is never "done".
    expect(parsed.find((m) => m.event === "finished")).toMatchObject({ outcome: "handoff", says: "Ready: 3 done. 'Send' reads as outbound; you press it." });
  });

  it("marks text Caret composed as drafted, whole, beside what the step says (B30)", () => {
    const steps = parsed.flatMap((m) => (m.event === "segment" ? (m.steps as { says: string; drafted?: string }[]) : []));
    const drafted = steps.filter((x) => x.drafted !== undefined);
    expect(drafted).toEqual([{ index: 1, kind: "write", says: "Message: Hi Priya, I'm in for Thursday, October 8 at 3:00 PM.", drafted: "Hi Priya, I'm in for Thursday, October 8 at 3:00 PM." }]);
    // A copied value is never marked: "drafted" means Caret wrote the words.
    expect(steps.filter((x) => x.drafted === undefined).some((x) => x.says.startsWith("Message: The desk lamp"))).toBe(true);
    const preview = parsed.find((m) => m.goalId === "goal-4-r4" && m.event === "segment") as Record<string, unknown>;
    const bad = (m: unknown): boolean => !AnyMessage.safeParse(m).success;
    expect(bad({ ...preview, steps: [{ index: 1, kind: "write", says: "Message: x", drafted: "" }] })).toBe(true);
    expect(bad({ ...preview, steps: [{ index: 1, kind: "write", says: "Message: x", drafted: "x".repeat(601) }] })).toBe(true);
  });

  it("refuses the shapes the contract rules out", () => {
    const at = (i: number): Record<string, unknown> => ({ ...(parsed[i] as Record<string, unknown>) });
    const bad = (m: unknown): boolean => !AnyMessage.safeParse(m).success;
    const accept = at(3);
    expect(bad({ ...accept, digest: "ABC" })).toBe(true);
    expect(bad({ ...accept, digest: (accept.digest as string).toUpperCase() })).toBe(true);
    expect(bad({ ...accept, segment: -1 })).toBe(true);
    expect(bad({ ...at(1), instruction: "" })).toBe(true);
    expect(bad({ ...at(1), instruction: "x".repeat(501) })).toBe(true);
    const preview = at(2);
    expect(bad({ ...preview, steps: [] })).toBe(true);
    expect(bad({ ...preview, reason: "because" })).toBe(true);
    expect(bad({ ...preview, where: { kind: "window", title: "x" } })).toBe(true);
    expect(bad({ ...at(17), reason: "maybe" })).toBe(true);
    expect(bad({ ...at(10), outcome: "sent" })).toBe(true);
    expect(bad({ ...at(4), phase: "acting" })).toBe(true);
  });
});

describe("goal messages on the socket", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-goal-wire-"));
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

  const request = { type: "goalRequest", v: PROTOCOL_VERSION, requestId: "r1", instruction: "add this meeting", at: 1 } as const;
  const accept = { type: "goalAccept", v: PROTOCOL_VERSION, goalId: "goal-1-r1", segment: 0, digest: "a".repeat(64), at: 1 } as const;

  it("refuses both by name from a host without the capability and from a consumer that is not the host", async () => {
    for (const hello of [
      { type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "old-host", host: true },
      { type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "script", capabilities: [GOAL_PLANS_CAPABILITY] },
    ]) {
      const c = await LineClient.connect(join(dir, "screen.sock"));
      c.send(hello);
      c.send(request);
      c.send(accept);
      for (const type of ["goalRequest", "goalAccept"]) {
        const e = await c.waitFor((m) => m.type === "error" && String(m.message).startsWith(type));
        expect(e.message).toBe(`${type} needs a host hello with "${GOAL_PLANS_CAPABILITY}" in its capabilities`);
      }
      expect(c.received.filter((m) => (m as { type: string }).type === "goalProgress")).toEqual([]);
      c.close();
    }
  });

  it("answers a goal-planning host's request to it alone, and sends goalProgress only to such hosts", async () => {
    const host = await LineClient.connect(join(dir, "screen.sock"));
    host.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 2, version: "caret-host", host: true, capabilities: [GOAL_PLANS_CAPABILITY] });
    const other = await LineClient.connect(join(dir, "screen.sock"));
    other.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 3, version: "watcher" });
    await until(() => helper.hostPresent);
    host.send(request);
    // No writer is configured here, as the helper starts since L1, so the reply is a refusal, to the asker only.
    const reply = await host.waitFor((m) => m.type === "goalProgress");
    expect(reply).toMatchObject({ event: "stopped", reason: "refused", requestId: "r1", says: SAYS.noPlanWriter });
    // A published goalProgress reaches the goal-planning host and no other consumer.
    server.publish({ type: "goalProgress", v: PROTOCOL_VERSION, at: 1, goalId: "g", requestId: null, event: "finished", outcome: "done", verified: 1, skipped: 0, left: [], says: "Done: 1 step verified." });
    await host.waitFor((m) => m.type === "goalProgress" && m.goalId === "g");
    await new Promise((r) => setTimeout(r, 50));
    expect(other.received.filter((m) => (m as { type: string }).type === "goalProgress")).toEqual([]);
    // An acceptance of a goal that does not exist runs nothing and says why.
    host.send(accept);
    await host.waitFor((m) => m.type === "error" && m.message === "goalAccept refused: no goal goal-1-r1");
    // The refusal names the goal: it goes to the asker alone.
    await new Promise((r) => setTimeout(r, 50));
    expect(other.received.filter((m) => (m as { type: string }).type === "error")).toEqual([]);
    host.close();
    other.close();
  });
});
