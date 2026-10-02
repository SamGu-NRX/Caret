// Acceptance test for offers to the host, over the real socket: a live Helper behind a HelperServer on
// a temporary Unix socket, a reader simulator replaying recorded synthetic sessions, and a consumer
// playing the host. For each producer (grounded fill, loop, pending watch) the host receives one exact
// offer, accepts it, and the work runs as the task whose id is the offer's key. Jev is a fake that
// answers by rule; nothing here reads a key, opens a window or touches focus.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { PROTOCOL_VERSION, type OfferPopup } from "../src/protocol.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { jevPickingText } from "./builders.ts";
import { LineClient, SocketReader, loadRecording, until } from "./socket-reader.ts";

// The fill producer's builder, wrapped so one test can make it emit a spec the host would refuse. The
// message still goes through the helper's real publish path.
const flags = vi.hoisted(() => ({ corrupt: null as ((m: OfferPopup) => unknown) | null }));
vi.mock("../src/offers/fill-popup.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/offers/fill-popup.ts")>();
  return {
    ...orig,
    buildFillPopup: (...a: Parameters<typeof orig.buildFillPopup>) => {
      const m = orig.buildFillPopup(...a);
      return flags.corrupt === null ? m : flags.corrupt(m);
    },
  };
});

const F = (s: string): string => `dev.caret.fixture/standard/${s}`;
const M = (s: string): string => `dev.caret.mail/standard/${s}`;
const D = (s: string): string => `dev.caret.directory/standard/${s}`;
const FORM = "5150-2";
const ORDER = "6160-1";
const SEATING = "6160-2";
const ROSTER = "5150-1";
const DIRECTORY = "7170-1";
const JOB = "5150-3";
const COMPOSE = "6160-4";
const guest = (r: number): string => M(`textfield:guest~${r}`);
const person = (name: string): string => D(`group:people/statictext:${name.toLowerCase()}~0`);
const attendee = (name: string): string => F(`group:attendees/statictext:${name.toLowerCase()}~0`);

const FILL_VALUES: Record<string, string> = { Name: "Dana Whitfield", Email: "dana.whitfield@example.com", Phone: "+1 (512) 555-0142" };
/** Fill questions are answered by field label; the two pending questions by whether the window now reads as finished. */
const askJev: AskJev = async (req) => {
  if (req.questions.finished !== undefined) {
    const done = /done|passed/i.test(String((req.state as Record<string, unknown>).now));
    return { model: "jev-test", answers: { finished: { choice: done ? "yes" : "no", confidence: 0.9 }, waiting: { choice: "no", confidence: 0.9 } }, inputTokens: 1, latencyMs: 1, costUsd: 0 };
  }
  return jevPickingText((_, instructions) => FILL_VALUES[/Label: '([^']+)'/.exec(instructions)?.[1] ?? ""] ?? null)(req);
};

const TERMINAL = new Set(["done", "stopped", "handoff", "paused"]);
const at0 = (m: object): object => ({ ...m, at: 0 });
const accept = (offerId: string, actionId: string): object => ({ type: "offerAccept", v: PROTOCOL_VERSION, offerId, actionId, overrides: {}, at: 1 });

describe("offers over the socket", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let host: LineClient;
  let reader: SocketReader;

  const hooks = {
    applied: (windowId: string, at: number): boolean => helper.model.windows.get(windowId)?.updatedAt === at,
    tick: (at: number): void => helper.tick(at),
  };
  /** The phases of one task, in order, once it has reached a terminal one. */
  const phases = async (taskId: string): Promise<string[]> => {
    await host.waitFor((m) => m.type === "taskProgress" && m.taskId === taskId && TERMINAL.has(String(m.phase)));
    return host.received.flatMap((m) => {
      const p = m as { type: string; taskId?: string; phase?: string };
      return p.type === "taskProgress" && p.taskId === taskId ? [p.phase ?? ""] : [];
    });
  };
  const offersShown = (): string[] => host.received.flatMap((m) => {
    const t = (m as { type: string }).type;
    return t === "alternatives" || t === "action" || t === "popup" ? [t] : [];
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-offers-"));
    store = new Store(join(dir, "data"));
    let n = 0;
    helper = new Helper({
      store,
      askJev,
      shadow: false,
      allowBackgroundFocus: false,
      newId: () => `id-${++n}`,
      publish: (m) => server.publish(m),
      sendToReader: (cmd) => server.sendToReader(cmd),
    });
    server = new HelperServer(join(dir, "screen.sock"), () => helper, () => {});
    await server.listen();
    host = await LineClient.connect(join(dir, "screen.sock"));
    host.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "host-test" });
    reader = await SocketReader.connect(join(dir, "screen.sock"));
  });

  afterEach(async () => {
    flags.corrupt = null;
    host.close();
    reader.close();
    helper.shutdown();
    await server.close();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fill: a form whose every field is grounded becomes one pop-up, and Fill all writes each value", async () => {
    await reader.replay(loadRecording("offers-fill.ndjson"), hooks);
    const popup = await host.waitFor((m) => m.type === "popup");
    expect(at0(popup)).toEqual({
      type: "popup",
      v: 1,
      offerKey: "id-1",
      at: 0,
      field: { pid: 5150, windowId: FORM, key: F("textfield:name~0"), frame: [100, 40, 200, 24] },
      spec: {
        v: 1,
        id: "id-1",
        figure: "offering",
        blocks: [
          {
            type: "header",
            title: { text: "Fill 3 fields", ref: { rule: "count", derived: [{ node: `${FORM}/${F("textfield:name~0")}` }, { node: `${FORM}/${F("textfield:email~0")}` }, { node: `${FORM}/${F("textfield:phone~0")}` }] } },
          },
          { type: "source", value: { text: "Mail Fixture, Order confirmation", ref: { node: `${ORDER}/${M("statictext:dana whitfield~0")}` } } },
          {
            type: "fields",
            rows: [
              {
                destination: { text: "Name", ref: { rule: "fieldLabel", derived: [{ node: `${FORM}/${F("textfield:name~0")}` }] } },
                value: { text: "Dana Whitfield", ref: { node: `${ORDER}/${M("statictext:dana whitfield~0")}`, quote: "Dana Whitfield" } },
                state: "ready",
              },
              {
                destination: { text: "Email", ref: { rule: "fieldLabel", derived: [{ node: `${FORM}/${F("textfield:email~0")}` }] } },
                value: { text: "dana.whitfield@example.com", ref: { node: `${ORDER}/${M("statictext:dana.whitfield@example.com~0")}`, quote: "dana.whitfield@example.com" } },
                state: "ready",
              },
              {
                destination: { text: "Phone", ref: { rule: "fieldLabel", derived: [{ node: `${FORM}/${F("textfield:phone~0")}` }] } },
                value: { text: "+1 (512) 555-0142", ref: { node: `${ORDER}/${M("statictext:phone: +# (#) #-#~0")}`, quote: "+1 (512) 555-0142" } },
                state: "ready",
              },
            ],
          },
          { type: "actions", items: [{ id: "fillAll", label: "Fill all", key: "tab" }] },
        ],
      },
    });
    expect(host.received.some((m) => (m as { type: string }).type === "fillProposal")).toBe(false);

    host.send(accept("id-1", "fillAll"));
    expect(await phases("id-1")).toEqual(["started", "acting", "verified", "acting", "verified", "acting", "verified", "done"]);
    expect([F("textfield:name~0"), F("textfield:email~0"), F("textfield:phone~0")].map((k) => reader.value(FORM, k))).toEqual([
      "Dana Whitfield",
      "dana.whitfield@example.com",
      "+1 (512) 555-0142",
    ]);
    expect(await host.waitFor((m) => m.type === "offerWithdrawn")).toMatchObject({ id: "id-1", reason: "taken" });
  });

  it("loop: the next row comes with the other list's name, taking it switches lists, and Finish fills the rest from there", async () => {
    await reader.replay(loadRecording("offers-loop.ndjson"), hooks);
    const alternatives = await host.waitFor((m) => m.type === "alternatives");
    expect(at0(alternatives)).toEqual({
      type: "alternatives",
      v: 1,
      offerKey: "offer-1.0",
      at: 0,
      field: { pid: 6160, windowId: SEATING, key: guest(2), frame: [100, 100, 200, 24] },
      candidates: [
        { text: "Marcus Lowe", ref: { node: `${ROSTER}/${attendee("Marcus Lowe")}`, quote: "Marcus Lowe" } },
        { text: "Lena Hartmann", ref: { node: `${DIRECTORY}/${person("Lena Hartmann")}`, quote: "Lena Hartmann" } },
      ],
      quoted: true,
    });

    // The host inserts the second candidate itself; the reader sees the field change.
    const typed = reader.setValue(SEATING, guest(2), "Lena Hartmann");
    await until(() => hooks.applied(SEATING, typed.at));
    helper.tick(typed.at + 2000);
    const action = await host.waitFor((m) => m.type === "action");
    expect(at0(action)).toEqual({
      type: "action",
      v: 1,
      offerKey: "offer-2",
      at: 0,
      field: { pid: 6160, windowId: SEATING, key: guest(3), frame: [100, 130, 200, 24] },
      app: "Mail Fixture",
      endState: {
        text: "Finish the rest: 3 more values from Directory Fixture",
        ref: {
          rule: "loopFinish",
          derived: ["Oskar Lindqvist", "Yusuf Demir", "Mila Novak"].map((name) => ({ node: `${DIRECTORY}/${person(name)}`, quote: name })),
        },
      },
      actions: [{ id: "finish", label: "Finish", key: "tab" }],
    });
    expect(host.received.filter((m) => (m as { type: string }).type === "offerWithdrawn").map((m) => [(m as { id: string }).id, (m as { reason: string }).reason])).toEqual([
      ["offer-1.0", "taken"],
      ["offer-1", "taken"],
    ]);

    host.send(accept("offer-2", "finish"));
    expect(await phases("offer-2")).toEqual(["started", "acting", "verified", "acting", "verified", "acting", "verified", "done"]);
    expect([0, 1, 2, 3, 4, 5].map((r) => reader.value(SEATING, guest(r)))).toEqual(["Dana Whitfield", "Priya Raman", "Lena Hartmann", "Oskar Lindqvist", "Yusuf Demir", "Mila Novak"]);
  });

  it("pending: a watched run that finishes offers Open in the field the user is in, and taking it raises the window", async () => {
    await reader.replay(loadRecording("offers-pending.ndjson"), hooks);
    await helper.pending.whenIdle();
    const action = await host.waitFor((m) => m.type === "action");
    expect(at0(action)).toEqual({
      type: "action",
      v: 1,
      offerKey: "open-watch-id-1",
      at: 0,
      field: { pid: 6160, windowId: COMPOSE, key: M("textfield:to~0"), frame: [100, 40, 300, 24] },
      app: "Caret Fixture",
      endState: { text: "Done. 48 of 48 tests passed.", ref: { node: `${JOB}/${F("statictext:done. # of # tests passed.~0")}`, quote: "Done. 48 of 48 tests passed." } },
      actions: [{ id: "open", label: "Open Caret Fixture", key: "tab" }],
    });

    host.send(accept("open-watch-id-1", "open"));
    expect(await phases("open-watch-id-1")).toEqual(["started", "acting", "verified", "done"]);
    expect(reader.verbs.filter((v) => v.kind === "raise")).toEqual([{ kind: "raise", pid: 5150, windowId: JOB }]);
    expect(reader.focusedWindow()).toBe(JOB);
    expect(reader.frontmostPid).toBe(5150);
    expect(helper.model.focusedWindowId).toBe(JOB);
  });

  it("fill: an explicit fillRequest still gets the fillProposal it asks for", async () => {
    await reader.replay(loadRecording("offers-fill.ndjson"), hooks);
    await host.waitFor((m) => m.type === "popup");
    host.send({ type: "fillRequest", v: PROTOCOL_VERSION, windowId: FORM, fieldKey: F("textfield:name~0") });
    const p = await host.waitFor<{ fields: { value: string | null }[] }>((m) => m.type === "fillProposal");
    expect(p.fields.map((f) => f.value)).toEqual(["Dana Whitfield", "dana.whitfield@example.com", "+1 (512) 555-0142"]);
    expect(offersShown()).toEqual(["popup"]);
  });

  it("refuses an accept of an unknown offer with an error and a stopped taskProgress", async () => {
    host.send(accept("offer-404", "run"));
    expect(await host.waitFor((m) => m.type === "error")).toMatchObject({ message: "offer offer-404: no such offer, or it expired" });
    expect(at0(await host.waitFor((m) => m.type === "taskProgress"))).toEqual({
      type: "taskProgress",
      v: 1,
      at: 0,
      taskId: "offer-404",
      planId: "offer-404",
      phase: "stopped",
      step: null,
      steps: 0,
      says: null,
      detail: "no such offer, or it expired",
    });
  });

  it("stops a running fill on offerStop, after the step in flight", async () => {
    await reader.replay(loadRecording("offers-fill.ndjson"), hooks);
    await host.waitFor((m) => m.type === "popup");
    // The first write is answered late, so the run is still at step 1 when the host stops it.
    reader.delayMs.write = 300;
    host.send(accept("id-1", "fillAll"));
    await host.waitFor((m) => m.type === "taskProgress" && m.taskId === "id-1" && m.phase === "acting");
    host.send({ type: "offerStop", v: PROTOCOL_VERSION, offerId: "id-1", at: 2 });
    expect(await phases("id-1")).toEqual(["started", "acting", "verified", "stopped"]);
    const records = host.received.filter((m) => (m as { type: string; task?: { id: string } }).type === "activity" && (m as { task: { id: string } }).task.id === "id-1");
    expect(records.at(-1)).toMatchObject({ task: { state: "failed", cause: "you" } });
    expect(await host.waitFor((m) => m.type === "taskProgress" && m.phase === "stopped")).toMatchObject({ detail: "stopped by you before step 2 of 3" });
    expect([F("textfield:name~0"), F("textfield:email~0"), F("textfield:phone~0")].map((k) => reader.value(FORM, k))).toEqual(["Dana Whitfield", "", ""]);
  });

  it.each([
    ["a value with no ref", { text: "Dana Whitfield" }],
    ["a bare string value", "Dana Whitfield"],
  ])("never lets a pop-up with %s leave the helper", async (_, bad) => {
    flags.corrupt = (m) => {
      const fields = m.spec.blocks[2] as { rows: { value?: unknown }[] };
      (fields.rows[0] as { value?: unknown }).value = bad;
      return m;
    };
    await reader.replay(loadRecording("offers-fill.ndjson"), hooks);
    const err = await host.waitFor<{ message: string }>((m) => m.type === "error");
    expect(err.message).toBe("offer id-1 refused: missingReference(blocks[2].rows[0].value) at spec.blocks[2].rows[0].value");
    expect(err.message).not.toContain("Dana");
    await new Promise((r) => setTimeout(r, 50));
    expect(offersShown()).toEqual([]);
    expect(helper.offers.size).toBe(0);
    store.flush();
    expect(store.counts()["offers.refused"]).toBe(1);
  });
});
