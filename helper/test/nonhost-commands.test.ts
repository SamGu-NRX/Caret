// A consumer that has not proven the host key cannot make Caret act (src/request-gate.ts). Its offerAccept, runPlan,
// taskControl and settings each get the named refusal and change nothing, while the proven host's still work, Stop and
// Undo included, with that consumer connected.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { DEFAULT_SETTINGS } from "../src/offers/settings.ts";
import { PROTOCOL_VERSION, type OfferAction } from "../src/protocol.ts";
import type { Plan, Step } from "../src/executor/schema.ts";
import { field, snap } from "./builders.ts";
import { authenticateHost, LineClient, SocketReader, TEST_LAUNCH_SECRET, until } from "./socket-reader.ts";

const K = (s: string): string => `dev.caret.fixture/standard/${s}`;
const FORM = "5150-1";
const TITLE = "Fixture — Commands";
const NAME = K("textfield:name~0");
const EMAIL = K("textfield:email~0");
const write = (key: string, value: string): Step => ({ says: `${key} holds ${value}`, end: { kind: "valueEquals", window: { title: TITLE }, target: { key, describe: key }, value } });
const two = (): Plan => ({ id: "p", title: "Fill the form", slots: {}, steps: [write(NAME, "Dana"), write(EMAIL, "d@example.com")] });
const golden = readFileSync(fileURLToPath(new URL("../fixtures/golden/protocol.ndjson", import.meta.url)), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
const hello = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", version: "commands-test", ...extra });
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

describe("what a consumer that is not the proven host may make Caret do", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let host: LineClient;
  let other: LineClient;
  let reader: SocketReader;
  let logged: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-commands-"));
    store = new Store(join(dir, "data"));
    logged = [];
    const own: HelperServer = new HelperServer(join(dir, "screen.sock"), () => mine, (l) => logged.push(l), TEST_LAUNCH_SECRET);
    const mine: Helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => own.publish(m), sendToReader: (cmd) => own.sendToReader(cmd) });
    server = own;
    helper = mine;
    await server.listen();
    host = await LineClient.connect(join(dir, "screen.sock"));
    host.send(hello({ pid: 1, host: true }));
    await authenticateHost(host);
    other = await LineClient.connect(join(dir, "screen.sock"));
    other.send(hello({ pid: 2 }));
    reader = await SocketReader.connect(join(dir, "screen.sock"));
    reader.send(snap([field(NAME, ""), field(EMAIL, "old@example.com")], { at: 100, windowId: FORM, title: TITLE, seq: 1 }));
    await until(() => helper.model.windows.has(FORM));
  });

  afterEach(async () => {
    host.close();
    other.close();
    reader.close();
    helper.shutdown();
    await server.close();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const refusal = (type: string, because: string) => ({ type: "error", message: `${type} needs a host hello (host: true): ${because}` });
  const writes = (): number => reader.verbs.filter((v) => v.kind === "write").length;
  /** The host's run of the two-field plan, through the socket, to its end. */
  const hostRun = async (taskId: string): Promise<void> => {
    host.send({ type: "runPlan", v: PROTOCOL_VERSION, taskId, plan: two(), slots: {} });
    await host.waitFor((m) => m.type === "taskProgress" && m.taskId === taskId && (m.phase === "done" || m.phase === "stopped"), 5000);
  };

  it("refuses a non-host's offerAccept by name and runs nothing; the host's accept runs", async () => {
    const action = { ...golden.find((l) => l.type === "action" && l.offerKey === "offer-5"), offerKey: "accept-1" } as unknown as OfferAction;
    helper.offers.record(action, () => helper.executor.run("accept-1", two(), {}, undefined, { grant: true }));
    other.send({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: "accept-1", actionId: "finish", overrides: {}, at: 2 });
    expect(await other.waitFor((m) => m.type === "error")).toMatchObject(refusal("offerAccept", "accepting an offer makes Caret act"));
    await settle();
    expect(helper.offers.get("accept-1")?.accepted).toBe(false);
    expect(writes()).toBe(0);
    expect(logged).toContain("refused offerAccept from consumer-2 (other): offerAccept needs a host hello (host: true): accepting an offer makes Caret act");

    host.send({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: "accept-1", actionId: "finish", overrides: {}, at: 3 });
    await host.waitFor((m) => m.type === "taskProgress" && m.taskId === "accept-1" && m.phase === "done", 5000);
    expect([reader.value(FORM, NAME), reader.value(FORM, EMAIL)]).toEqual(["Dana", "d@example.com"]);
  });

  it("refuses a non-host's runPlan by name and starts no task; the host's runs", async () => {
    other.send({ type: "runPlan", v: PROTOCOL_VERSION, taskId: "theirs", plan: two(), slots: {} });
    expect(await other.waitFor((m) => m.type === "error")).toMatchObject(refusal("runPlan", "a plan writes into your apps"));
    await settle();
    expect(helper.tasks.get("theirs")).toBeUndefined();
    expect(writes()).toBe(0);
    await hostRun("mine");
    expect([reader.value(FORM, NAME), reader.value(FORM, EMAIL)]).toEqual(["Dana", "d@example.com"]);
  });

  it("refuses a non-host's taskControl by name and leaves the host's task; the host's Undo restores it", async () => {
    await hostRun("mine");
    other.send({ type: "taskControl", v: PROTOCOL_VERSION, taskId: "mine", action: "undo" });
    expect(await other.waitFor((m) => m.type === "error")).toMatchObject(refusal("taskControl", "it pauses, resumes, stops or undoes Caret's work for you"));
    await settle();
    expect([reader.value(FORM, NAME), reader.value(FORM, EMAIL)]).toEqual(["Dana", "d@example.com"]);

    host.send({ type: "taskControl", v: PROTOCOL_VERSION, taskId: "mine", action: "undo" });
    await host.waitFor((m) => m.type === "taskProgress" && m.taskId === "mine" && m.phase === "undone", 5000);
    expect([reader.value(FORM, NAME), reader.value(FORM, EMAIL)]).toEqual(["", "old@example.com"]);
  });

  it("stops the host's run on the host's Stop while a non-host is connected, and not on the non-host's", async () => {
    // Each write is held, so the run is still under way when the stops arrive.
    reader.delayMs.write = 300;
    let first = (): void => undefined;
    const writing = new Promise<void>((r) => (first = r));
    reader.onCommand = (v) => void (v.kind === "write" && first());
    host.send({ type: "runPlan", v: PROTOCOL_VERSION, taskId: "mine", plan: two(), slots: {} });
    await writing;
    other.send({ type: "offerStop", v: PROTOCOL_VERSION, offerId: "mine", at: 5 });
    expect(await other.waitFor((m) => m.type === "error")).toMatchObject(refusal("offerStop", "it stops or undoes what an offer did for you"));
    expect(helper.executor.live("mine")).toBe(true);
    host.send({ type: "offerStop", v: PROTOCOL_VERSION, offerId: "mine", at: 6 });
    expect(await host.waitFor((m) => m.type === "taskProgress" && m.taskId === "mine" && (m.phase === "done" || m.phase === "stopped"), 5000)).toMatchObject({ phase: "stopped", stopReason: "you" });
    // The write held when the Stop came lands; the second step never starts.
    expect(reader.value(FORM, EMAIL)).toBe("old@example.com");
  });

  it("refuses a non-host's settings by name and keeps the user's; the host's apply", async () => {
    const paused = { type: "settings", v: PROTOCOL_VERSION, at: 7, roles: [...DEFAULT_SETTINGS.roles], level: DEFAULT_SETTINGS.level, paused: true };
    expect(helper.gate.settings.paused).toBe(false);
    other.send(paused);
    expect(await other.waitFor((m) => m.type === "error")).toMatchObject(refusal("settings", "settings decide what Caret may do"));
    await settle();
    expect(helper.gate.settings.paused).toBe(false);
    host.send(paused);
    await until(() => helper.gate.settings.paused);
  });

  it("refuses the other host-only commands by name too: offerControl, fillResult, a second hello", async () => {
    other.send({ type: "offerControl", v: PROTOCOL_VERSION, offerId: "x", action: "dismiss" });
    other.send({ type: "fillResult", v: PROTOCOL_VERSION, at: 1, proposalId: "p-9", windowId: FORM, fieldKey: EMAIL, outcome: "inserted", reason: null, method: "axValue", valueLength: 3 });
    await until(() => other.received.filter((m) => (m as { type?: string }).type === "error").length >= 2);
    expect(other.received.map((m) => String((m as { message?: string }).message).split(":")[0])).toEqual(["offerControl needs a host hello (host", "fillResult needs a host hello (host"]);
    host.send(hello({ pid: 1, host: true }));
    expect(await host.waitFor((m) => m.type === "error")).toMatchObject({ message: "a connection says hello once; this one already has" });
  });
});
