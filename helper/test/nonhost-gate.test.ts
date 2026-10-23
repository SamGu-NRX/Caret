// A consumer that has not proven the host key gets only status (src/send-gate.ts): no proposal while the screen has a
// fillable field, no first look, no preview, no memory. The proven host still gets what it got before, and the reader
// gets its commands and never the screen-derived messages meant for the host. Every message the server withholds is
// logged with the reason.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { MEMORY_DOCUMENTS_CAPABILITY, PROTOCOL_VERSION, SPEND_CAPABILITY, type HelperMessage, type Spend } from "../src/protocol.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { field, focus, MAIL_APP, snap, text, value } from "./builders.ts";
import { authenticateHost, LineClient, TEST_LAUNCH_SECRET, until } from "./socket-reader.ts";

const FORM = "5150-1";
const EMAIL = "dev.caret.fixture/standard/textfield:email~0";
const SPEND: Spend = { type: "spend", v: PROTOCOL_VERSION, at: 5, since: 1, jev: { calls: 2, failed: 0, inputTokens: 40, outputTokens: 0, costUsd: 0 }, writer: { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } };
const hello = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 3, version: "nonhost-test", ...extra });
const types = (c: LineClient): string[] => c.received.map((m) => String((m as { type?: unknown }).type));
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

describe("what a consumer that is not the proven host is sent", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let path: string;
  let logged: string[];
  let jevCalls: number;
  const clients: LineClient[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-nonhost-"));
    path = join(dir, "screen.sock");
    store = new Store(join(dir, "data"));
    logged = [];
    jevCalls = 0;
    const askJev: AskJev = async (req) => (jevCalls++, {
      model: "jev-test",
      answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: Object.keys(req.questions[id]?.criteria ?? {})[0] ?? "none", confidence: 0.95 }])),
      inputTokens: 10,
      latencyMs: 1,
      costUsd: 0,
    });
    let s: HelperServer | null = null;
    helper = new Helper({ store, askJev, shadow: false, allowBackgroundFocus: false, publish: (m: HelperMessage) => s?.publish(m), sendToReader: (m) => s?.sendToReader(m) ?? false });
    server = new HelperServer(path, () => helper, (line) => logged.push(line), TEST_LAUNCH_SECRET);
    server.spendNow = () => SPEND;
    s = server;
    await server.listen();
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    helper.shutdown();
    await server.close();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const connect = async (h: Record<string, unknown>): Promise<LineClient> => {
    const c = await LineClient.connect(path);
    clients.push(c);
    c.send(h);
    if (h.host === true) await authenticateHost(c);
    return c;
  };

  /** A mail window holding an address, then an empty Email field focused in the frontmost form: a fillable field. */
  const fillableField = async (): Promise<LineClient> => {
    const reader = await connect({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 2, version: "test" });
    reader.send(snap([text("m/statictext:a~0", "dana.whitfield@example.com")], { at: 1000, windowId: "6160-1", app: MAIL_APP, values: [value("email", "dana.whitfield@example.com", "m/statictext:a~0")] }));
    reader.send(snap([field(EMAIL, "", { label: "Email" })], { at: 2000, windowId: FORM, focused: true }));
    reader.send(focus(FORM, EMAIL, 2100));
    return reader;
  };

  it("sends no proposal to an unauthenticated consumer while the screen has a fillable field, and logs why", async () => {
    const plain = await connect(hello({ capabilities: [MEMORY_DOCUMENTS_CAPABILITY, SPEND_CAPABILITY] }));
    const host = await connect(hello({ host: true }));
    await fillableField();
    const p = await host.waitFor<{ fields: { value: string | null }[] }>((m) => m.type === "fillProposal");
    expect(p.fields[0]?.value).toBe("dana.whitfield@example.com");
    await settle();
    expect(types(plain)).toEqual(["spend"]);
    expect(logged).toContain("withheld fillProposal from consumer-1 (other): fillProposal is derived from the screen or the user's data, and only a host whose proof checked out is sent that");
  });

  it("refuses an unauthenticated consumer's own fill request by name, before asking Jev", async () => {
    const host = await connect(hello({ host: true }));
    await fillableField();
    await host.waitFor((m) => m.type === "fillProposal");
    await settle();
    const before = jevCalls;
    const plain = await connect(hello());
    plain.send({ type: "fillRequest", v: PROTOCOL_VERSION, windowId: FORM, fieldKey: EMAIL });
    expect(await plain.waitFor((m) => m.type === "error")).toMatchObject({ message: "fillRequest needs a host hello (host: true): a fillProposal quotes values and labels from the screen" });
    await settle();
    expect(types(plain)).toEqual(["error"]);
    expect(jevCalls).toBe(before);
  });

  it("refuses a non-host screenTextRequest without returning screen text", async () => {
    const host = await connect(hello({ host: true }));
    await fillableField();
    await host.waitFor((m) => m.type === "fillProposal");
    const plain = await connect(hello());
    plain.send({ type: "screenTextRequest", v: PROTOCOL_VERSION, id: "nonhost-screen", revision: 0, pid: 5150, windowNumber: 101, maxCharacters: 2048 });
    expect(await plain.waitFor((m) => m.type === "error")).toMatchObject({ message: "screenTextRequest needs a host hello (host: true): screen text is derived from the reader's model" });
    await settle();
    expect(types(plain)).toEqual(["error"]);
    expect(JSON.stringify(plain.received)).not.toContain("dana.whitfield@example.com");
    expect(logged).toContain("refused screenTextRequest from consumer-2 (other): screenTextRequest needs a host hello (host: true): screen text is derived from the reader's model");
  });

  it("gives an unauthenticated consumer no first-look preview and no first look", async () => {
    await fillableField();
    const plain = await connect(hello());
    plain.send({ type: "firstLookPreviewRequest", v: PROTOCOL_VERSION, requestId: "pv-1", at: 3000, families: ["fill", "event"], level: "balanced" });
    plain.send({ type: "firstLook", v: PROTOCOL_VERSION, requestId: "look-1", at: 3000, families: ["fill", "event"], level: "balanced", deadlineMs: 2000 });
    await until(() => plain.received.length >= 2);
    await settle();
    expect(plain.received).toMatchObject([
      { type: "error", message: "firstLookPreviewRequest needs a host hello (host: true): only the host shows the preview as consent" },
      { type: "error", message: "firstLook needs a host hello (host: true): a first look's offer names a window and quotes its values" },
    ]);
  });

  it("refuses an unauthenticated consumer memory, activity, plans and file confirmations", async () => {
    const plain = await connect(hello({ capabilities: [MEMORY_DOCUMENTS_CAPABILITY] }));
    plain.send({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "m1", op: "list", kind: "permission" });
    plain.send({ type: "memoryDocumentRequest", v: PROTOCOL_VERSION, requestId: "m2", op: "list" });
    plain.send({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "a1", op: "list" });
    plain.send({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "p1", at: 1, instruction: "fill this form" });
    await until(() => plain.received.length >= 4);
    await settle();
    expect(types(plain)).toEqual(["error", "error", "error", "error"]);
    expect(plain.received.map((m) => String((m as { message: string }).message).split(":")[0])).toEqual(["memoryRequest needs a host hello (host", "memoryDocumentRequest needs a host hello (host", "activityRequest needs a host hello (host", "planRequest needs a host hello (host"]);
  });

  it("still sends an unauthenticated consumer status: spend counters and the refusal of its own bad line", async () => {
    const plain = await connect(hello({ capabilities: [SPEND_CAPABILITY] }));
    expect(await plain.waitFor((m) => m.type === "spend")).toEqual(SPEND);
    plain.send({ type: "nope" });
    expect(await plain.waitFor((m) => m.type === "error")).toMatchObject({ message: expect.stringContaining("invalid consumer message") });
    server.publish(SPEND);
    await until(() => types(plain).filter((t) => t === "spend").length === 2);
  });

  it("sends the proven host the proposal, memory, activity and spend it got before", async () => {
    const host = await connect(hello({ host: true, capabilities: [SPEND_CAPABILITY] }));
    expect(await host.waitFor((m) => m.type === "spend")).toEqual(SPEND);
    await fillableField();
    expect(await host.waitFor((m) => m.type === "fillProposal")).toMatchObject({ windowId: FORM });
    host.send({ type: "fillRequest", v: PROTOCOL_VERSION, windowId: FORM, fieldKey: EMAIL });
    await until(() => types(host).filter((t) => t === "fillProposal").length === 2, 3000);
    host.send({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "m1", op: "list", kind: "permission" });
    expect(await host.waitFor((m) => m.type === "memoryReply")).toMatchObject({ requestId: "m1", error: null });
    host.send({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "a1", op: "list" });
    expect(await host.waitFor((m) => m.type === "activityReply")).toMatchObject({ requestId: "a1", error: null });
    expect(logged.filter((l) => l.startsWith("withheld"))).toEqual([]);
  });

  it("gives a host hello still waiting on its proof nothing but the challenge", async () => {
    await fillableField();
    const pending = await LineClient.connect(path);
    clients.push(pending);
    pending.send(hello({ host: true, capabilities: [SPEND_CAPABILITY] }));
    await pending.waitFor((m) => m.type === "hostChallenge");
    server.publish(SPEND);
    helper.handleConsumer({ type: "fillRequest", v: PROTOCOL_VERSION, windowId: FORM, fieldKey: EMAIL });
    await settle();
    expect(types(pending)).toEqual(["hostChallenge"]);
  });

  it("sends the reader its commands and never the host's messages", async () => {
    const reader = await fillableField();
    const host = await connect(hello({ host: true }));
    host.send({ type: "fillRequest", v: PROTOCOL_VERSION, windowId: FORM, fieldKey: EMAIL });
    await host.waitFor((m) => m.type === "fillProposal");
    server.sendToReader({ type: "actRevoke", v: PROTOCOL_VERSION, taskId: "t-1", at: 1 });
    await reader.waitFor((m) => m.type === "actRevoke");
    await settle();
    expect(types(reader).filter((t) => t !== "readerCommand" && t !== "actRevoke")).toEqual([]);
  });

  it("throws, naming the type, when asked to send a type that has no class", () => {
    expect(() => server.publish({ type: "somethingNew" } as unknown as HelperMessage)).toThrow('message type "somethingNew" has no class in MESSAGE_CLASS');
  });
});
