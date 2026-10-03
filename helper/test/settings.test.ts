// The settings message and the gate it drives. Unit tests pin the level table and the gate's rules;
// the socket tests send `settings` as the host would and check that the very next decision of a producer
// follows it: paused asks Jev nothing and withdraws what is shown, a role turned off holds its family,
// and Quiet's budget of one offer an hour holds the second.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { ConsumerMessage, HelperMessage, PROTOCOL_VERSION, type Focus, type HelperMessage as Message, type Settings, type SettingsLevel, type SettingsRole } from "../src/protocol.ts";
import { DEFAULT_SETTINGS, LEVELS, OfferGate } from "../src/offers/settings.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { FIXTURE_APP, MAIL_APP, focus, jevPickingText, snap, text } from "./builders.ts";
import { LineClient, SocketReader, loadRecording } from "./socket-reader.ts";

const HOUR = 60 * 60 * 1000;
const ALL: SettingsRole[] = ["fill", "repeat", "watch", "calendar", "words"];
const settings = (o: { roles?: SettingsRole[]; level?: SettingsLevel; paused?: boolean; at?: number } = {}): Settings => ({
  type: "settings",
  v: PROTOCOL_VERSION,
  at: o.at ?? 1,
  roles: o.roles ?? ALL,
  level: o.level ?? "balanced",
  paused: o.paused ?? false,
});

describe("the level table and the gate", () => {
  it("holds the assumed numbers in one table", () => {
    expect(Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [k, [v.offersPerHour, v.routineSightings]]))).toEqual({ quiet: [1, null], balanced: [4, 3], eager: [8, 2] });
    expect(LEVELS.quiet.families).toEqual({ fill: true, pending: true, loop: false, routine: false, event: false });
    expect(LEVELS.balanced.families.event && LEVELS.eager.families.event).toBe(true);
    expect(DEFAULT_SETTINGS).toEqual({ roles: ALL, level: "balanced", paused: false });
  });

  it("checks pause, role and level before the budget, and counts the budget over a rolling hour", () => {
    const g = new OfferGate({ roles: ["watch"], level: "quiet", paused: true });
    expect(g.holds("loop", 0)).toEqual(["caretPaused", "roleOff", "levelOff"]);
    expect(g.holds("pending", 0)).toEqual(["caretPaused"]);
    g.apply({ roles: ["watch"], level: "quiet", paused: false });
    expect(g.holds("pending", 0)).toEqual([]);
    g.spoke(10);
    expect(g.holds("pending", 20)).toEqual(["hourlyBudget"]);
    expect(g.holds("pending", 10 + HOUR)).toEqual([]);
    expect(g.spokenLastHour(10 + HOUR)).toBe(0);
  });

  it("keeps the hour's offers across a restart, as times only, so a new helper holds the same budget", () => {
    const dir = mkdtempSync(join(tmpdir(), "caret-budget-"));
    try {
      const log = (st: Store) => ({ load: () => st.offerTimes(), record: (at: number) => st.recordOffer(at) });
      const first = new Store(dir);
      const g = new OfferGate(DEFAULT_SETTINGS, log(first));
      for (const at of [1000, 2000, 3000, 4000]) g.spoke(at);
      expect(g.holds("fill", 5000)).toEqual(["hourlyBudget"]);
      first.close();

      // A restarted helper reads the same store: Balanced's four offers still hold the fifth.
      const second = new Store(dir);
      const helper = new Helper({ store: second, askJev: null, shadow: false, allowBackgroundFocus: false, publish: () => undefined });
      expect(helper.gate.holds("fill", 5000)).toEqual(["hourlyBudget"]);
      expect(helper.gate.holds("fill", 1000 + HOUR)).toEqual([]);
      helper.shutdown();
      helper.memory.close();

      // The table holds a time per offer and nothing else, and drops times over an hour older than the newest.
      const g2 = new OfferGate(DEFAULT_SETTINGS, log(second));
      g2.spoke(3500 + HOUR);
      expect(second.offerTimes()).toEqual([4000, 3500 + HOUR]);
      second.close();
      const db = new DatabaseSync(join(dir, "screen.sqlite"), { readOnly: true });
      expect((db.prepare("PRAGMA table_info(offer_budget)").all() as { name: string }[]).map((c) => c.name)).toEqual(["id", "at"]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the families a change turns off, and every allowed one on pause", () => {
    const g = new OfferGate();
    expect(g.apply({ roles: ["fill", "watch"], level: "balanced", paused: false })).toEqual(["loop", "routine", "event"]);
    expect(g.apply({ roles: ["fill", "watch"], level: "balanced", paused: true })).toEqual(["fill", "pending"]);
    expect(g.apply({ roles: ALL, level: "quiet", paused: false })).toEqual([]);
  });

  it("parses the message strictly: known roles once each, a known level, every key", () => {
    expect(ConsumerMessage.parse(settings())).toEqual(settings());
    expect(ConsumerMessage.safeParse(settings({ roles: ["fill", "fill"] })).success).toBe(false);
    expect(ConsumerMessage.safeParse({ ...settings(), roles: ["ghost"] }).success).toBe(false);
    expect(ConsumerMessage.safeParse({ ...settings(), level: "loud" }).success).toBe(false);
    const { paused: _, ...noPause } = settings();
    expect(ConsumerMessage.safeParse(noPause).success).toBe(false);
    expect(HelperMessage.parse({ type: "offerWithdrawn", v: PROTOCOL_VERSION, at: 1, id: "x", reason: "settings" })).toMatchObject({ reason: "settings" });
  });
});

describe("pending watches follow the watch role", () => {
  const JOB = "5150-3";
  const COMPOSE = "6160-4";
  let dir: string;
  let store: Store;
  let helper: Helper;
  let asks: number;
  beforeEach(() => {
    asks = 0;
    dir = mkdtempSync(join(tmpdir(), "caret-settings-"));
    store = new Store(dir);
    const ask: AskJev = async () => ({ model: "jev-test", answers: { finished: { choice: "no", confidence: 0.9 }, waiting: { choice: "no", confidence: 0.9 } }, inputTokens: 1, latencyMs: 1, costUsd: 0 });
    helper = new Helper({ store, askJev: (req) => (asks++, ask(req)), shadow: false, allowBackgroundFocus: false, publish: () => undefined, readerLink: { run: async () => ({ type: "verbResult", v: PROTOCOL_VERSION, id: "x", at: 0, outcome: "ok", detail: null }) } });
  });
  afterEach(() => {
    helper.shutdown();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  /** The user is in a job window that shows running work, then leaves it for a compose window. */
  const leaveRunningJob = (at: number): void => {
    helper.handleReader(snap([text(`dev.caret.fixture/standard/statictext:running~${at}`, `Running tests… ${at % 97} of 48`)], { at, windowId: JOB, title: "Test run", focused: true }));
    helper.handleReader(snap([text("dev.caret.mail/standard/statictext:to~0", "To")], { at: at + 10, windowId: COMPOSE, app: MAIL_APP, title: "New message", focused: true }));
  };
  const watches = (): string[] => helper.tasks.answer({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "r", op: "list" }).tasks.filter((t) => t.kind === "watch").map((t) => `${t.state}:${t.detail ?? ""}`);

  it("registers no watch with the role off, and turning it off ends the watches running", () => {
    helper.handleSettings(settings({ roles: ["fill", "repeat"] }));
    leaveRunningJob(1000);
    expect(watches()).toEqual([]);
    helper.handleSettings(settings());
    leaveRunningJob(2000);
    expect(watches()).toEqual(["running:"]);
    helper.handleSettings(settings({ roles: ["fill"] }));
    expect(watches()).toEqual(["failed:you turned off watching"]);
  });

  it("asks nothing about a watched window while Caret is paused, and asks once it is not", async () => {
    leaveRunningJob(1000);
    expect(watches()).toEqual(["running:"]);
    helper.handleSettings(settings({ paused: true }));
    helper.handleReader(snap([text("dev.caret.fixture/standard/statictext:done~0", "Done. 48 of 48 tests passed.")], { at: 2000, windowId: JOB, title: "Test run" }));
    await helper.pending.whenIdle();
    await new Promise((r) => setTimeout(r, 200));
    expect(asks).toBe(0);
    helper.handleSettings(settings());
    await new Promise((r) => setTimeout(r, 200));
    await helper.pending.whenIdle();
    expect(asks).toBe(1);
  });
});

describe("settings over the socket take effect on the next decision", () => {
  const FORM = "5150-2";
  const NAME = "dev.caret.fixture/standard/textfield:name~0";
  const VALUES: Record<string, string> = { Name: "Dana Whitfield", Email: "dana.whitfield@example.com", Phone: "+1 (512) 555-0142" };
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let host: LineClient;
  let reader: SocketReader;
  let clock: number;
  let jevCalls: number;
  /** While set, Jev's answers wait for it. */
  let jevGate: Promise<void> | null;

  const hooks = {
    applied: (windowId: string, at: number): boolean => helper.model.windows.get(windowId)?.updatedAt === at,
    tick: (at: number): void => helper.tick(at),
  };
  /** Waits until the helper has handled every line the host and reader sent before this call. */
  const settled = async (): Promise<void> => {
    const requestId = `sync-${clock}-${jevCalls}-${host.received.length}`;
    host.send({ type: "activityRequest", v: PROTOCOL_VERSION, requestId, op: "list" });
    await host.waitFor((m) => m.type === "activityReply" && m.requestId === requestId);
  };
  /** The user focuses the form's Name field again, at the helper's clock. */
  const focusName = (): void => reader.send({ ...focus(FORM, NAME, clock), app: FIXTURE_APP } satisfies Focus);
  const popups = (): Message[] => host.received.filter((m): m is Message => (m as Message).type === "popup");

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-settings-socket-"));
    store = new Store(join(dir, "data"));
    clock = 10_000;
    jevCalls = 0;
    jevGate = null;
    const pick = jevPickingText((_, instructions) => VALUES[/Label: '([^']+)'/.exec(instructions)?.[1] ?? ""] ?? null);
    // This test's helper talks to this test's server only. Through the `server` variable, a run still in
    // flight when its test ended published its stop into a later test's host (B13's socket flake).
    const own: HelperServer = new HelperServer(join(dir, "screen.sock"), () => mine, () => {});
    const mine: Helper = new Helper({
      store,
      askJev: async (req) => {
        jevCalls++;
        await jevGate;
        return pick(req);
      },
      shadow: false,
      allowBackgroundFocus: false,
      now: () => clock,
      publish: (m) => own.publish(m),
      sendToReader: (cmd) => own.sendToReader(cmd),
    });
    helper = mine;
    server = own;
    await server.listen();
    host = await LineClient.connect(join(dir, "screen.sock"));
    host.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "host-test" });
    reader = await SocketReader.connect(join(dir, "screen.sock"));
  });

  afterEach(async () => {
    host.close();
    reader.close();
    helper.shutdown();
    await server.close();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("paused asks Jev nothing; unpaused, the next focus offers; paused again withdraws the pop-up and refuses its accept", async () => {
    host.send(settings({ paused: true }));
    await settled();
    await reader.replay(loadRecording("offers-fill.ndjson"), hooks);
    await settled();
    expect([jevCalls, popups().length]).toEqual([0, 0]);

    host.send(settings({ paused: false }));
    focusName();
    const popup = await host.waitFor<{ offerKey: string }>((m) => m.type === "popup");
    expect(jevCalls).toBe(2);

    host.send(settings({ paused: true }));
    await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === popup.offerKey && m.reason === "settings");
    host.send({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: popup.offerKey, actionId: "fillAll", overrides: {}, at: clock });
    await host.waitFor((m) => m.type === "error" && String(m.message).includes(popup.offerKey));
    expect(reader.verbs.filter((v) => v.kind === "write")).toEqual([]);
    store.flush();
    expect(store.counts()).toMatchObject({ "fill.held_caretPaused": 1, "settings.applied": 3 });
  });

  it("a pause that arrives while Jev answers holds the pop-up the answer would have made", async () => {
    let release = (): void => {};
    jevGate = new Promise((r) => (release = r));
    await reader.replay(loadRecording("offers-fill.ndjson"), hooks);
    await settled();
    expect(jevCalls).toBe(2);
    host.send(settings({ paused: true }));
    await settled();
    release();
    await settled();
    await new Promise((r) => setTimeout(r, 20));
    expect(popups()).toEqual([]);
    store.flush();
    expect(store.counts()).toMatchObject({ "fill.held_caretPaused": 1 });
  });

  it("charges an offer to the hour from when it was shown, not from when it was asked for", async () => {
    host.send(settings({ level: "quiet" }));
    let release = (): void => {};
    jevGate = new Promise((r) => (release = r));
    await reader.replay(loadRecording("offers-fill.ndjson"), hooks);
    await settled();
    expect(jevCalls).toBe(2);
    // Jev answers ten minutes after the focus that asked.
    clock += 10 * 60 * 1000;
    const shownAt = clock;
    release();
    const first = await host.waitFor<{ offerKey: string }>((m) => m.type === "popup");
    host.send(settings({ level: "quiet", roles: ["watch"] }));
    await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === first.offerKey);
    host.send(settings({ level: "quiet" }));
    jevGate = null;
    // An hour after the ask but not after the showing: still held.
    clock = shownAt + HOUR - 60_000;
    focusName();
    await settled();
    expect(jevCalls).toBe(2);
    clock = shownAt + HOUR + 1;
    focusName();
    await host.waitFor((m) => m.type === "popup" && m.offerKey !== first.offerKey);
  });

  it("a fill role turned off holds fills; Quiet then allows one offer an hour", async () => {
    host.send(settings({ roles: ["repeat", "watch", "words"] }));
    await settled();
    await reader.replay(loadRecording("offers-fill.ndjson"), hooks);
    await settled();
    expect([jevCalls, popups().length]).toEqual([0, 0]);

    host.send(settings({ level: "quiet" }));
    focusName();
    const first = await host.waitFor<{ offerKey: string }>((m) => m.type === "popup");
    // Turning the role off and on again withdraws the pop-up; the hour's one offer is spent.
    host.send(settings({ level: "quiet", roles: ["watch"] }));
    await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === first.offerKey && m.reason === "settings");
    host.send(settings({ level: "quiet" }));
    clock += 60_000;
    focusName();
    await settled();
    expect([jevCalls, popups().length]).toEqual([2, 1]);

    clock += HOUR;
    focusName();
    await host.waitFor((m) => m.type === "popup" && m.offerKey !== first.offerKey);
    expect(jevCalls).toBe(4);
    store.flush();
    expect(store.counts()).toMatchObject({ "fill.held_roleOff": 1, "fill.held_hourlyBudget": 1 });
  });
});
