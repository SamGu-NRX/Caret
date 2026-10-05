// R2 lead decision 2, the consent boundary, end to end. The ledger reads only what the helper wrote when the user
// acted: a skill the user kept (MemoryStore), a watch of the helper's own that resolved (TaskRegistry), and the watch
// role from a host session's settings. Then A5's recordings over the real socket: a resolved watch passes with no
// router question only when a host sent the watch role; a learned loop always goes to Router 1. Everything is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { MemoryStore } from "../src/patterns/memory.ts";
import { DEFAULT_SETTINGS } from "../src/offers/settings.ts";
import { ConsentLedger } from "../src/routing/consent.ts";
import { PROTOCOL_VERSION, ROUTING_CAPABILITY, type TaskRecord } from "../src/protocol.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { jevPickingText } from "./builders.ts";
import { LineClient, SocketReader, loadRecording } from "./socket-reader.ts";

describe("the consent ledger reads only the helper's own records", () => {
  let dir: string;
  let m: MemoryStore;
  const tasks = new Map<string, Pick<TaskRecord, "kind" | "state" | "cause">>();
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-r2-consent-"));
    m = new MemoryStore(dir);
    tasks.clear();
  });
  afterEach(() => {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const step = { shapeHash: "s", srcBundle: "a", srcApp: "A", srcWindowKind: "standard", srcTemplateHash: "t", srcPos: 0, part: "whole", dstBundle: "b", dstApp: "Tracker", dstWindowKind: "standard", dstTemplateHash: "u", dstPos: 0 };
  const ledger = (): ConsentLedger => new ConsentLedger({ memory: m, task: (id) => tasks.get(id) });

  it("a skill counts while the user's Keep stands: not before it, not paused, not forgotten", () => {
    const r = m.recordRoutine("sig", [step], 1);
    const routineId = r?.id as string;
    const l = ledger();
    const claim = { kind: "skill", routineId } as const;
    // A routine Caret learned, with no Keep: no record.
    expect(l.verify(claim)).toBeNull();
    m.setRoutineKeep(routineId, "offered");
    expect(l.verify(claim)).toBeNull();
    const s = m.addSkill(routineId, { name: "Copy tracking", trigger: "a Tracker window opens with Order empty", needed: 3, handsOff: null }, 2);
    expect(l.verify(claim)).toEqual({ kind: "skill", reason: "you kept this as a skill" });
    m.setPaused(s.id, true);
    expect(l.verify(claim)).toBeNull();
    m.setPaused(s.id, false);
    expect(l.verify(claim)).not.toBeNull();
    m.forget(s.id, 3);
    expect(l.verify(claim)).toBeNull();
  });

  it("a watch counts once it resolved by the screen, and only on the watch role a host session sent", () => {
    const l = ledger();
    const claim = { kind: "watch", watchId: "watch-1" } as const;
    tasks.set("watch-1", { kind: "watch", state: "done", cause: "screen" });
    // The helper's defaults, and settings from a consumer that is not the host, are not the user's consent.
    expect(l.verify(claim)).toBeNull();
    l.settings([...DEFAULT_SETTINGS.roles], false);
    expect(l.verify(claim)).toBeNull();
    l.settings([...DEFAULT_SETTINGS.roles], true);
    expect(l.verify(claim)).toEqual({ kind: "watch", reason: "you have Caret watch unfinished work, and this watch resolved" });
    tasks.set("watch-1", { kind: "watch", state: "needsYou", cause: "screen" });
    expect(l.verify(claim)).not.toBeNull();
    for (const t of [{ kind: "watch", state: "running", cause: null }, { kind: "watch", state: "failed", cause: "you" }, { kind: "watch", state: "done", cause: "you" }, { kind: "plan", state: "done", cause: "screen" }] as const) {
      tasks.set("watch-1", t);
      expect(l.verify(claim), JSON.stringify(t)).toBeNull();
    }
    tasks.set("watch-1", { kind: "watch", state: "done", cause: "screen" });
    expect(l.verify({ kind: "watch", watchId: "watch-2" })).toBeNull();
    // The host turns watching off: the record is gone with it.
    l.settings(["fill"], true);
    expect(l.verify(claim)).toBeNull();
    // A non-host consumer cannot turn it back on.
    l.settings([...DEFAULT_SETTINGS.roles], false);
    expect(l.verify(claim)).toBeNull();
  });
});

const FILL_VALUES: Record<string, string> = { Name: "Dana Whitfield", Email: "dana.whitfield@example.com", Phone: "+1 (512) 555-0142" };

describe("A5's recordings with routing on, over the socket", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let reader: SocketReader;
  const clients: LineClient[] = [];
  const routerAsked: JevRequest[] = [];
  /** Router questions all abstain; every other question is A5's fake. */
  const askJev: AskJev = async (req) => {
    if ("outcome" in req.questions || "route" in req.questions) {
      routerAsked.push(req);
      const q = "outcome" in req.questions ? "outcome" : "route";
      return { model: "jev-test", answers: { [q]: { choice: q === "outcome" ? "abstain" : "handoff", confidence: 0.9 } }, inputTokens: 1, latencyMs: 1, costUsd: 0 };
    }
    if (req.questions.finished !== undefined) {
      const done = /done|passed/i.test(String((req.state as Record<string, unknown>).lines_that_changed));
      return { model: "jev-test", answers: { finished: { choice: done ? "yes" : "no", confidence: 0.9 }, waiting: { choice: "no", confidence: 0.9 } }, inputTokens: 1, latencyMs: 1, costUsd: 0 };
    }
    return jevPickingText((_, instructions) => FILL_VALUES[/Label: '([^']+)'/.exec(instructions)?.[1] ?? ""] ?? null)(req);
  };
  const hooks = {
    applied: (windowId: string, at: number): boolean => helper.model.windows.get(windowId)?.updatedAt === at,
    tick: (at: number): void => helper.tick(at),
  };
  const connect = async (hello: Record<string, unknown>): Promise<LineClient> => {
    const c = await LineClient.connect(join(dir, "screen.sock"));
    clients.push(c);
    c.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", ...hello });
    return c;
  };
  const settings = { type: "settings", v: PROTOCOL_VERSION, at: 1, roles: [...DEFAULT_SETTINGS.roles], level: DEFAULT_SETTINGS.level, paused: false };
  const settled = async (): Promise<void> => {
    await helper.pending.whenIdle();
    await helper.routing?.idle();
    await helper.routedSettled;
  };
  const criteria = (r: JevRequest): string => JSON.stringify((r.questions.outcome as { criteria?: unknown } | undefined)?.criteria ?? {});

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-r2-a5-"));
    store = new Store(join(dir, "data"));
    routerAsked.length = 0;
    let n = 0;
    const own: HelperServer = new HelperServer(join(dir, "screen.sock"), () => mine, () => {});
    const mine: Helper = new Helper({
      store,
      askJev,
      shadow: false,
      allowBackgroundFocus: false,
      newId: () => `id-${++n}`,
      now: () => reader?.clock ?? 0,
      publish: (msg) => own.publish(msg),
      sendToReader: (cmd) => own.sendToReader(cmd),
      routing: {},
    });
    helper = mine;
    server = own;
    await server.listen();
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    reader.close();
    helper.shutdown();
    await server.close();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes the resolved watch's Open with no router question when the host sent the watch role", async () => {
    const host = await connect({ pid: 1, version: "host-test", host: true, capabilities: [ROUTING_CAPABILITY] });
    host.send(settings);
    await host.waitFor((m) => m.type === "pageEngineState", 300).catch(() => undefined);
    reader = await SocketReader.connect(join(dir, "screen.sock"));
    await reader.replay(loadRecording("offers-pending.ndjson"), hooks);
    await settled();
    const open = await host.waitFor<{ type: string; app: string }>((m) => m.type === "action");
    expect(open.app).toBe("Caret Fixture");
    expect(routerAsked.some((r) => criteria(r).includes("Open Caret Fixture"))).toBe(false);
    expect(helper.routing?.decisions.find((d) => d.by === "consent")).toMatchObject({ outcome: "act", route: "workflow:openApp", consent: { kind: "watch" }, published: false });
  });

  it("routes the same Open to Router 1 when the watch role came from a consumer that is not the host", async () => {
    const host = await connect({ pid: 1, version: "host-test", host: true, capabilities: [ROUTING_CAPABILITY] });
    const other = await connect({ pid: 2, version: "eval-script" });
    other.send(settings);
    await other.waitFor((m) => m.type === "pageEngineState", 300).catch(() => undefined);
    reader = await SocketReader.connect(join(dir, "screen.sock"));
    await reader.replay(loadRecording("offers-pending.ndjson"), hooks);
    await settled();
    expect(routerAsked.some((r) => criteria(r).includes("Open Caret Fixture"))).toBe(true);
    expect(host.received.some((m) => (m as { type: string }).type === "action")).toBe(false);
    expect(helper.routing?.decisions.some((d) => d.by === "consent")).toBe(false);
  });

  it("takes the user's Keep and a skill's resume only from the host: no other consumer can write a consent record (review)", async () => {
    const step = { shapeHash: "s", srcBundle: "a", srcApp: "A", srcWindowKind: "standard", srcTemplateHash: "t", srcPos: 0, part: "whole", dstBundle: "b", dstApp: "Tracker", dstWindowKind: "standard", dstTemplateHash: "u", dstPos: 0 };
    const routineId = helper.memory.recordRoutine("sig", [step], 1)?.id as string;
    const skill = helper.memory.addSkill(routineId, { name: "Copy tracking", trigger: "a Tracker window opens with Order empty", needed: 3, handsOff: null }, 2);
    helper.memory.setPaused(skill.id, true);
    reader = await SocketReader.connect(join(dir, "screen.sock"));
    let answered = 0;
    const real = helper.handleSkillAnswer.bind(helper);
    helper.handleSkillAnswer = (m) => {
      answered++;
      real(m);
    };
    const other = await connect({ pid: 2, version: "page-engine" });
    other.send({ type: "skillAnswer", v: PROTOCOL_VERSION, id: "skill-offer-1", answer: "accept", at: 3 });
    expect(await other.waitFor((m) => m.type === "error")).toMatchObject({ message: 'skillAnswer needs a host hello (host: true): only the host shows keep and promote questions' });
    other.send({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "r1", op: "resume", id: skill.id });
    expect(await other.waitFor((m) => m.type === "memoryReply")).toMatchObject({ requestId: "r1", error: "resume needs a host hello (host: true): a paused skill comes back only from you", entries: [] });
    expect(answered).toBe(0);
    expect(helper.memory.skill(skill.id)?.paused).toBe(true);
    expect(helper.consent.verify({ kind: "skill", routineId })).toBeNull();
    // The host may: its resume is the user's.
    const host = await connect({ pid: 1, version: "host-test", host: true });
    host.send({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "r2", op: "resume", id: skill.id });
    expect(await host.waitFor((m) => m.type === "memoryReply")).toMatchObject({ requestId: "r2", error: null });
    expect(helper.consent.verify({ kind: "skill", routineId })).not.toBeNull();
  });

  it("sends a learned loop's next row to Router 1, which may say no, whatever the host consented to", async () => {
    const host = await connect({ pid: 1, version: "host-test", host: true, capabilities: [ROUTING_CAPABILITY] });
    host.send(settings);
    await host.waitFor((m) => m.type === "pageEngineState", 300).catch(() => undefined);
    reader = await SocketReader.connect(join(dir, "screen.sock"));
    await reader.replay(loadRecording("offers-loop.ndjson"), hooks);
    await settled();
    expect(routerAsked.some((r) => criteria(r).includes("next row"))).toBe(true);
    expect(host.received.some((m) => (m as { type: string }).type === "alternatives")).toBe(false);
    expect(helper.routing?.decisions.some((d) => d.by === "consent")).toBe(false);
  });
});
