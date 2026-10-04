// B22: taking control back is immediate and exact. A live Helper behind a HelperServer on a temporary Unix
// socket, a reader simulator that answers commands one at a time and applies grants and revokes the moment
// they arrive (as caret-screen's per-app queue and control path do), and a consumer playing the host.
// The race: the executor's write waits in the reader's queue behind a slow call; the user takes control
// back while it waits. No act may reach the app after the revoke. The boundary is the reader's last grant
// check: an AX call the reader has already dispatched cannot be called back, so these tests hold the act
// in the queue, before that check.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { PROTOCOL_VERSION, type OfferAction } from "../src/protocol.ts";
import type { Plan, Step } from "../src/executor/schema.ts";
import type { TaskResult } from "../src/executor/executor.ts";
import { field, FIXTURE_APP, snap } from "./builders.ts";
import { LineClient, SocketReader, until } from "./socket-reader.ts";

const K = (s: string): string => `dev.caret.fixture/standard/${s}`;
const FORM = "5150-1";
const TITLE = "Fixture — Lifecycle";
const NAME = K("textfield:name~0");
const EMAIL = K("textfield:email~0");
const write = (key: string, value: string): Step => ({ says: `${key} holds ${value}`, end: { kind: "valueEquals", window: { title: TITLE }, target: { key, describe: key }, value } });
const two = (): Plan => ({ id: "p", title: "Fill the form", slots: {}, steps: [write(NAME, "Dana"), write(EMAIL, "d@example.com")] });
/** How long the slow call ahead of the write holds the reader's queue: long enough for a control line to cross two sockets. */
const SLOW_MS = 300;

describe("taking control back (B22)", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let host: LineClient;
  let reader: SocketReader;
  /** Called once with the task id when the executor's Email write has arrived at the reader and waits behind the slow call. */
  let whileQueued: ((taskId: string) => void | Promise<void>) | null;
  /** The next walk the reader receives is held SLOW_MS. */
  let slowArmed: boolean;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-b22-"));
    store = new Store(join(dir, "data"));
    whileQueued = null;
    slowArmed = false;
    const own: HelperServer = new HelperServer(join(dir, "screen.sock"), () => mine, () => {});
    const mine: Helper = new Helper({
      store,
      askJev: null,
      shadow: false,
      allowBackgroundFocus: false,
      publish: (m) => own.publish(m),
      sendToReader: (cmd) => own.sendToReader(cmd),
      executorHooks: {
        // Right before step 2 sends its write, something else asks the reader for a walk of the same app, a
        // slow one, so the write is queued behind it.
        beforeAct: async (_taskId, step) => {
          if (step !== 1) return;
          slowArmed = true;
          void mine.readerVerb({ kind: "walk", pid: FIXTURE_APP.pid, windowId: FORM });
        },
      },
    });
    server = own;
    helper = mine;
    await server.listen();
    host = await LineClient.connect(join(dir, "screen.sock"));
    host.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "host-test" });
    reader = await SocketReader.connect(join(dir, "screen.sock"));
    reader.serial = true;
    reader.enforceGrants = true;
    reader.delayFor = (v) => {
      if (v.kind !== "walk" || !slowArmed) return undefined;
      slowArmed = false;
      return SLOW_MS;
    };
    reader.onCommand = (v) => {
      if (v.kind !== "write" || v.key !== EMAIL || whileQueued === null) return;
      const f = whileQueued;
      whileQueued = null;
      void f(v.taskId ?? "");
    };
    reader.send(snap([field(NAME, ""), field(EMAIL, "old@example.com")], { at: 100, windowId: FORM, title: TITLE, seq: 1 }));
    await until(() => helper.model.windows.has(FORM));
  });

  afterEach(async () => {
    host.close();
    reader.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Resets the form, runs the two-field plan under a grant, and takes control back while step 2's write is queued. */
  async function race(taskId: string, takeBack: ((taskId: string) => void | Promise<void>) | null, p: Plan = two()): Promise<TaskResult> {
    reader.setValue(FORM, NAME, "");
    reader.setValue(FORM, EMAIL, "old@example.com");
    await until(() => helper.model.windows.get(FORM)?.nodes.get(EMAIL)?.value === "old@example.com" && helper.model.windows.get(FORM)?.nodes.get(NAME)?.value === undefined);
    whileQueued = takeBack;
    return helper.executor.run(taskId, p, {}, undefined, { grant: true });
  }

  /** The time the reader received the task's first revoke, or Infinity. */
  const revokedAt = (taskId: string): number => reader.grantTimes.find((g) => g.type === "actRevoke" && g.taskId === taskId)?.at ?? Number.POSITIVE_INFINITY;
  const actsAfter = (taskId: string, t: number) => reader.acted.filter((a) => a.verb.kind !== "walk" && "taskId" in a.verb && a.verb.taskId === taskId && a.at >= t);

  it("holds the executor's write behind the slow call, so the race is real", async () => {
    const t0 = performance.now();
    const r = await race("t0", null);
    expect(r.outcome).toBe("done");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(SLOW_MS);
    expect(reader.value(FORM, EMAIL)).toBe("d@example.com");
  });

  const control = (action: "pause" | "takeOver" | "stop", reason?: "input") => (taskId: string) =>
    host.send({ type: "taskControl", v: PROTOCOL_VERSION, taskId, action, ...(reason === undefined ? {} : { reason }) });

  // S1 audit #3 (pause, input) and the existing take-over and stop: every way the user takes control back.
  const sources: [string, (taskId: string) => void | Promise<void>, TaskResult["outcome"]][] = [
    ["pause from the host", control("pause"), "paused"],
    ["pause for the user's input, from the host", control("pause", "input"), "paused"],
    ["the user's click in the window, from the reader", () => reader.send({ type: "userInput", v: PROTOCOL_VERSION, at: 200, pid: FIXTURE_APP.pid, kind: "mouse", point: [20, 20] }), "paused"],
    ["take over from the host", control("takeOver"), "paused"],
    ["stop from the host", control("stop"), "stopped"],
  ];

  // S1 audit #4: a change to what a run the user accepted depends on.
  sources.push(["Caret paused from the host's settings", () => host.send({ type: "settings", v: PROTOCOL_VERSION, at: 1, roles: ["fill", "repeat", "watch", "calendar", "words"], level: "balanced", paused: true }), "stopped"]);

  it("no act reaches the app after the revoke: the user forgets the memory entry the queued write copies", async () => {
    const added = helper.handleMemory({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "a", op: "add", kind: "about", fields: { label: "Email", value: "d@example.com", source: "typed" } });
    const id = added.entries[0]!.id;
    const p = two();
    p.steps[1] = { ...p.steps[1]!, memory: id };
    const r = await race("t1", () => host.send({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "f", op: "forget", id }), p);
    expect(r).toMatchObject({ outcome: "stopped", step: 1 });
    expect(r.detail).toMatch(/what you told Caret/);
    expect(actsAfter("t1", revokedAt("t1"))).toEqual([]);
    expect(reader.value(FORM, EMAIL)).toBe("old@example.com");
  });

  // S1 audit #5: before B22 a consumer's close only took it out of the consumer set.
  it("no act reaches the app after the revoke: the host session that accepted the task disconnects", async () => {
    // An action line as the host is shown one (protocol.ndjson's), recorded with a run under a grant, as a producer records its offers.
    const golden = readFileSync(fileURLToPath(new URL("../fixtures/golden/protocol.ndjson", import.meta.url)), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const action = { ...golden.find((l) => l.type === "action" && l.offerKey === "offer-5"), offerKey: "accept-1" } as unknown as OfferAction;
    helper.offers.record(action, () => helper.executor.run("accept-1", two(), {}, undefined, { grant: true }));
    reader.setValue(FORM, NAME, "");
    reader.setValue(FORM, EMAIL, "old@example.com");
    await until(() => helper.model.windows.get(FORM)?.nodes.get(EMAIL)?.value === "old@example.com" && helper.model.windows.get(FORM)?.nodes.get(NAME)?.value === undefined);
    whileQueued = () => host.close();
    host.send({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: "accept-1", actionId: "finish", overrides: {}, at: 1 });
    await until(() => helper.executor.has("accept-1") && !helper.executor.live("accept-1"), 3000);
    expect(helper.tasks.get("accept-1")).toMatchObject({ state: "failed", cause: "caret" });
    expect(helper.tasks.get("accept-1")?.detail).toMatch(/the host that started it disconnected/);
    expect(actsAfter("accept-1", revokedAt("accept-1"))).toEqual([]);
    expect(reader.acted.filter((a) => a.verb.kind === "write" && a.verb.taskId === "accept-1")).toHaveLength(1);
    expect(reader.value(FORM, EMAIL)).toBe("old@example.com");
  });

  for (const [name, takeBack, outcome] of sources) {
    it(`no act reaches the app after the revoke: ${name}`, async () => {
      const r = await race("t1", takeBack);
      expect(r).toMatchObject({ outcome, step: 1 });
      const t = revokedAt("t1");
      expect(t).toBeLessThan(Number.POSITIVE_INFINITY);
      expect(actsAfter("t1", t)).toEqual([]);
      expect(reader.value(FORM, EMAIL)).toBe("old@example.com");
      // The write was still queued when the revoke came: the reader judged it after, and refused it.
      expect(reader.verbs.filter((v) => v.kind === "write" && v.key === EMAIL)).toHaveLength(1);
    });
  }
});
