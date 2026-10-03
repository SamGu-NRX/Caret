// Permission uses (B17): each action type keeps its last five uses (what, where, when, how it ended),
// sealed in memory, and the memory reply carries them in the shape the host decodes
// (fixtures/golden/memory.ndjson, `uses` on a permission entry). Jev is a fake; names are invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { MemoryStore } from "../src/patterns/memory.ts";
import { MAX_PERMISSION_USES, MemoryReply, PROTOCOL_VERSION, type ActionType, type HelperMessage, type MemoryEntry, type OfferPopup, type PermissionUse } from "../src/protocol.ts";
import type { Plan, Step } from "../src/executor/schema.ts";
import { field, focus, jevPickingText, snap } from "./builders.ts";
import { FakeApp, K, TITLE, executorWindow, wireButtons } from "./fake-app.ts";
import { LineClient, SocketReader } from "./socket-reader.ts";

const usesOf = (entries: readonly MemoryEntry[], action: ActionType): PermissionUse[] => {
  const e = entries.find((x) => x.kind === "permission" && x.fields.action === action);
  if (e?.kind !== "permission") throw new Error(`no ${action} permission`);
  return e.uses ?? [];
};

describe("the memory store's permission uses", () => {
  let dir: string;
  let m: MemoryStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-uses-"));
    m = new MemoryStore(dir);
  });
  afterEach(() => {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the last five per action, newest first, and leaves other actions alone", () => {
    for (let i = 1; i <= 7; i++) m.recordUse("writeHere", { at: 1000 * i, says: `Filled Field ${i} in Mail Fixture`, app: "Mail Fixture", outcome: "done" });
    m.recordUse("outbound", { at: 500, says: "Left 'Send' in Mail Fixture to you", app: "Mail Fixture", outcome: "handedOff" });
    const perms = m.list("permission");
    expect(usesOf(perms, "writeHere").map((u) => u.says)).toEqual([7, 6, 5, 4, 3].map((i) => `Filled Field ${i} in Mail Fixture`));
    expect(usesOf(perms, "outbound")).toEqual([{ at: 500, says: "Left 'Send' in Mail Fixture to you", app: "Mail Fixture", outcome: "handedOff" }]);
    expect(usesOf(perms, "read")).toEqual([]);
    // Trimmed on disk, not only in the reply.
    m.flushDecisions();
    expect(m.uses("writeHere")).toHaveLength(MAX_PERMISSION_USES);
  });

  it("seals what a use says: no field name or app in the clear", () => {
    m.recordUse("writeHere", { at: 1, says: "Filled Passport number in Travel Desk", app: "Travel Desk", outcome: "done" });
    m.flushDecisions();
    const db = new DatabaseSync(join(dir, "memory.sqlite"));
    const raw = JSON.stringify(db.prepare("SELECT * FROM uses").all(), (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v));
    db.close();
    expect(raw).not.toContain("Passport");
    expect(raw).not.toContain("Travel Desk");
  });

  it("answers a list in the shape the host decodes: every permission carries uses", () => {
    m.recordUse("writeHere", { at: 1790000120000, says: "Filled Guest in Mail Fixture", app: "Mail Fixture", outcome: "done" });
    const perms = m.list("permission");
    expect(perms.every((p) => p.kind === "permission" && Array.isArray(p.uses))).toBe(true);
    const reply = MemoryReply.parse({ type: "memoryReply", v: PROTOCOL_VERSION, requestId: "r", error: null, entries: perms });
    expect(usesOf(reply.entries, "writeHere")[0]).toEqual({ at: 1790000120000, says: "Filled Guest in Mail Fixture", app: "Mail Fixture", outcome: "done" });
  });
});

describe("the executor's uses", () => {
  let dir: string;
  let store: Store;
  let app: FakeApp;
  let helper: Helper;
  const W = { titleStartsWith: TITLE };
  const write = (key: string, value: string): Step => ({ says: `${key} holds ${value}`, end: { kind: "valueEquals", window: W, target: { key, describe: key }, value } });
  const plan = (steps: Step[], id = "p"): Plan => ({ id, title: id, slots: {}, steps });
  const uses = (action: ActionType): PermissionUse[] => usesOf(helper.memory.list("permission"), action);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-exec-uses-"));
    store = new Store(join(dir, "data"));
    // The fixture's window, with a Pay invoice button as caret-fixture has (B16).
    app = new FakeApp([...executorWindow(), { key: K("button:pay invoice~0"), parent: null, role: "AXButton", label: "Pay invoice", frame: [400, 500, 100, 30] }]);
    wireButtons(app);
    helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: () => undefined, readerLink: app });
    app.helper = helper;
    app.show();
  });
  afterEach(() => {
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records a run's writes in a window the user is not in as a write elsewhere, and a Send it left as outbound", async () => {
    const r = await helper.executor.run(
      "t1",
      plan([
        write(K("textfield:name~0"), "Dana"),
        { says: "the message is sent", end: { kind: "exists", window: W, target: { label: "Sent!", describe: "sent notice" } }, via: { kind: "press", target: { label: "Send", describe: "Send button" } } },
      ]),
      {},
    );
    expect(r.outcome).toBe("handoff");
    expect(uses("writeElsewhere")).toEqual([{ at: expect.any(Number), says: "Filled Name in Caret Fixture", app: "Caret Fixture", outcome: "done" }]);
    expect(uses("outbound")).toEqual([{ at: expect.any(Number), says: "Left 'Send' in Caret Fixture to you", app: "Caret Fixture", outcome: "handedOff" }]);
    expect(uses("writeHere")).toEqual([]);
  });

  it("files a Pay hand-off under sensitive, a safe hand-off under nothing, and says when a run stopped", async () => {
    await helper.executor.run("t1", plan([{ says: "You press Pay", end: { kind: "handoff", window: W, target: { key: K("button:pay invoice~0"), describe: "the Pay invoice button" }, why: "money" } }]), {});
    await helper.executor.run("t2", plan([{ says: "You press Archive", end: { kind: "handoff", window: W, target: { key: K("button:archive~0"), describe: "the Archive button" }, why: "unverifiable" } }]), {});
    expect(uses("sensitive").map((u) => u.says)).toEqual(["Left 'Pay invoice' in Caret Fixture to you"]);
    expect(["read", "show", "writeHere", "outbound", "destructive"].flatMap((a) => uses(a as ActionType))).toEqual([]);
    // A write whose field is gone stops the run after the first write.
    const r = await helper.executor.run("t3", plan([write(K("textfield:name~0"), "Ines"), write(K("textfield:gone~0"), "x")]), {});
    expect(r.outcome).toBe("stopped");
    expect(uses("writeElsewhere")[0]).toMatchObject({ says: "Filled Name in Caret Fixture, then stopped", outcome: "stopped" });
  });
});

// Acceptance (B17 brief, 3): uses appear after fixture fills and acts, at most five per type, in the
// memory reply the host reads, over the real socket.
describe("permission uses over the socket", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let host: LineClient;
  let reader: SocketReader;
  const hooks = { applied: (w: string, at: number) => helper.model.windows.get(w)?.updatedAt === at, tick: (at: number) => helper.tick(at) };
  const F = (s: string): string => `dev.caret.fixture/standard/${s}`;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-uses-sock-"));
    store = new Store(join(dir, "data"));
    let n = 0;
    const own: HelperServer = new HelperServer(join(dir, "screen.sock"), () => mine, () => {});
    const mine: Helper = new Helper({
      store,
      askJev: jevPickingText((_, ins) => ({ Name: "Sam Rivera", Email: "sam.rivera@example.com" })[/Label: '([^']+)'/.exec(ins)?.[1] ?? ""] ?? null),
      shadow: false,
      allowBackgroundFocus: false,
      newId: () => `id-${++n}`,
      publish: (m: HelperMessage) => own.publish(m),
      sendToReader: (cmd) => own.sendToReader(cmd),
    });
    helper = mine;
    server = own;
    await server.listen();
    host = await LineClient.connect(join(dir, "screen.sock"));
    host.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "host-test" });
    reader = await SocketReader.connect(join(dir, "screen.sock"));
    reader.enforceGrants = true;
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

  const memory = async (requestId: string, body: Record<string, unknown>): Promise<MemoryReply> => {
    host.send({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId, ...body });
    return MemoryReply.parse(await host.waitFor((m) => m.type === "memoryReply" && m.requestId === requestId));
  };

  it("records six fills of a fresh form, keeps the last five of each type, and sends them in the memory reply", async () => {
    // Eager allows eight offers an hour; Balanced's four would hold the fifth pop-up.
    host.send({ type: "settings", v: PROTOCOL_VERSION, at: 1, roles: ["fill", "repeat", "watch", "calendar", "words"], level: "eager", paused: false });
    await memory("a1", { op: "add", kind: "about", fields: { label: "Name", value: "Sam Rivera", source: "typed" } });
    await memory("a2", { op: "add", kind: "about", fields: { label: "Email", value: "sam.rivera@example.com", source: "typed" } });
    for (let i = 1; i <= 6; i++) {
      const windowId = `5150-${30 + i}`;
      const at = 10_000 * i;
      const nodes = ["Name", "Email"].map((l, j) => field(F(`textfield:${l.toLowerCase()}~0`), "", { label: l, frame: [100, 40 + 40 * j, 200, 24] }));
      await reader.replay([snap(nodes, { at, windowId, title: `Sign up ${i}`, focused: true, focusedKey: F("textfield:name~0") }), focus(windowId, F("textfield:name~0"), at + 10)], hooks);
      const popup = (await host.waitFor((m) => m.type === "popup" && (m as unknown as OfferPopup).field.windowId === windowId)) as unknown as OfferPopup;
      host.send({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: popup.offerKey, actionId: "fillAll", overrides: {}, at: 1 });
      await host.waitFor((m) => m.type === "taskProgress" && m.taskId === popup.offerKey && m.phase === "done");
      reader.send({ type: "windowClosed", v: PROTOCOL_VERSION, at: at + 5000, windowId });
    }
    const listed = await memory("l", { op: "list", kind: "permission" });
    const here = usesOf(listed.entries, "writeHere");
    expect(here).toHaveLength(MAX_PERMISSION_USES);
    expect(new Set(here.map((u) => u.says))).toEqual(new Set(["Filled Name and Email in Caret Fixture"]));
    expect(here.map((u) => u.at)).toEqual([...here.map((u) => u.at)].sort((x, y) => y - x));
    const shown = usesOf(listed.entries, "show");
    expect(shown).toHaveLength(MAX_PERMISSION_USES);
    expect(shown[0]).toMatchObject({ says: 'Offered "Fill 2 fields" in Caret Fixture', app: "Caret Fixture", outcome: "done" });
    // Each form was one question asked twice, counted once: the form's labels and what the user told Caret went to Jev.
    const read = usesOf(listed.entries, "read");
    expect(read).toHaveLength(MAX_PERMISSION_USES);
    expect(read[0]?.says).toBe("Sent snippets from Caret Fixture and what you told Caret to Jev");
    expect(usesOf(listed.entries, "writeElsewhere")).toEqual([]);
    // Every use has the host's three keys: at, says, app.
    for (const u of [...here, ...shown, ...read]) expect(Object.keys(u).sort()).toEqual(["app", "at", "outcome", "says"]);
  });

  it("records the host's own fill of one field, and one it could not make", async () => {
    await memory("a1", { op: "add", kind: "about", fields: { label: "Email", value: "sam.rivera@example.com", source: "typed" } });
    const windowId = "5150-41";
    const nodes = ["Email", "Phone"].map((l, j) => field(F(`textfield:${l.toLowerCase()}~0`), "", { label: l, frame: [100, 40 + 40 * j, 200, 24] }));
    await reader.replay([snap(nodes, { at: 3000, windowId, title: "Profile", focused: true, focusedKey: F("textfield:email~0") }), focus(windowId, F("textfield:email~0"), 3010)], hooks);
    const p = (await host.waitFor((m) => m.type === "fillProposal")) as { id: string };
    const result = (outcome: string) => ({ type: "fillResult", v: PROTOCOL_VERSION, at: 4000, proposalId: p.id, windowId, fieldKey: F("textfield:email~0"), outcome, reason: null, method: null, valueLength: 0 });
    host.send(result("failed"));
    host.send(result("inserted"));
    await new Promise((r) => setTimeout(r, 50));
    const here = usesOf((await memory("l", { op: "list", kind: "permission" })).entries, "writeHere");
    expect(here.map((u) => [u.says, u.outcome])).toEqual([
      ["Filled Email in Caret Fixture", "done"],
      ["Could not fill Email in Caret Fixture", "failed"],
    ]);
  });
});
