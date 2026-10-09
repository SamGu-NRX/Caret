// L1: local text on the helper's socket. fixtures/golden/local-model.ndjson is the contract the host batch builds
// against: a host hello that declares "localModel", a draft request with the draft grammar and its answer, a rewrite
// with no grammar answered busy, and a request answered unavailable. Then the helper's side over the real server: who
// gets a request, whose answer counts, and that every way of getting no text is its own error. All text is synthetic.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnyMessage, ConsumerMessage, HelperMessage, LOCAL_MODEL_CAPABILITY, LocalTextReply, LocalTextRequest, PROTOCOL_VERSION } from "../src/protocol.ts";
import type { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { DRAFT_GRAMMAR, draftAsk } from "../src/writer/local-draft.ts";
import { HostLocalModel, LocalModelUnavailable } from "../src/writer/local-port.ts";
import { authenticateHost, LineClient, TEST_LAUNCH_SECRET } from "./socket-reader.ts";

const lines = readFileSync(new URL("../fixtures/golden/local-model.ndjson", import.meta.url), "utf8").trim().split("\n");
const at = (i: number): Record<string, unknown> => JSON.parse(lines[i] as string) as Record<string, unknown>;
const FROM_HOST = new Set(["hello", "localTextReply"]);

describe("the local-model protocol lines", () => {
  it("parses every golden line and writes it back byte for byte", () => {
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(["hello", "localTextRequest", "localTextReply", "localTextRequest", "localTextReply", "localTextRequest", "localTextReply"]);
    for (const l of lines) {
      const m = JSON.parse(l) as { type: string };
      expect(JSON.stringify((FROM_HOST.has(m.type) ? ConsumerMessage : HelperMessage).parse(m)), m.type).toBe(l);
    }
  });

  it("carries the draft grammar the helper sends, and the capability by name", () => {
    expect(at(1).grammar).toBe(DRAFT_GRAMMAR);
    expect(at(0).capabilities).toContain(LOCAL_MODEL_CAPABILITY);
  });

  it("refuses the shapes the contract rules out", () => {
    const bad = (m: unknown): boolean => !AnyMessage.safeParse(m).success;
    expect(bad({ ...at(2), text: null })).toBe(true);
    expect(bad({ ...at(4), text: "partial words" })).toBe(true);
    expect(bad({ ...at(4), outcome: "retry" })).toBe(true);
    expect(bad({ ...at(1), kind: "polish" })).toBe(true);
    expect(bad({ ...at(1), maxTokens: 0 })).toBe(true);
    expect(bad({ ...at(1), grammar: "" })).toBe(true);
    expect(bad({ ...at(1), prompt: { ...(at(1).prompt as object), basis: Array.from({ length: 9 }, () => "x") } })).toBe(true);
    expect(bad({ ...at(1), id: "" })).toBe(true);
  });
});

describe("local text over the helper's socket", () => {
  let dir: string;
  let server: HelperServer;
  let local: HostLocalModel;
  let clock: number;
  const warnings: string[] = [];
  // The server calls only these on a consumer's hello and close.
  const helper = { hostConnected: () => {}, consumerConnected: () => {}, hostDisconnected: () => {}, readerClosed: () => {} } as unknown as Helper;
  const hello = (capabilities: string[], host = true) => ({ ...at(0), ...(host ? {} : { host: undefined }), capabilities });
  const ask = () => draftAsk("draft a reply to Priya saying I'm in", { name: "Message", placeholder: null }, ["Order arrived damaged\nFrom: Priya Raman <priya.raman@northwind.example>"], clock);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-local-"));
    clock = 1_790_000_300_000;
    local = new HostLocalModel((m) => server.sendLocalText(m), () => clock);
    server = new HelperServer(join(dir, "s", "screen.sock"), () => helper, (l) => void warnings.push(l), TEST_LAUNCH_SECRET, local);
    await server.listen();
    warnings.length = 0;
  });
  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function host(capabilities = ["routing", "goalPlans", LOCAL_MODEL_CAPABILITY], isHost = true): Promise<LineClient> {
    const c = await LineClient.connect(join(dir, "s", "screen.sock"));
    c.send(hello(capabilities, isHost));
    if (isHost) await authenticateHost(c);
    // A round trip after the hello, so the server has registered it before the test sends anything.
    c.send({ type: "localTextReply", v: PROTOCOL_VERSION, id: "warm-up", outcome: "busy", text: null, model: "", latencyMs: 0 });
    await new Promise((r) => setTimeout(r, 30));
    return c;
  }

  it("sends the request to the host that declared localModel, and resolves with its answer", async () => {
    const h = await host();
    const p = local.complete(ask());
    const req = LocalTextRequest.parse(await h.waitFor((m) => m.type === "localTextRequest"));
    expect(req).toMatchObject({ kind: "draft", grammar: DRAFT_GRAMMAR, prompt: { field: { name: "Message", placeholder: null } }, deadlineMs: clock + 20_000 });
    h.send({ type: "localTextReply", v: PROTOCOL_VERSION, id: req.id, outcome: "ok", text: "Hi Priya, I'm in.", model: "gemma.gguf", latencyMs: 640 });
    expect(await p).toEqual({ model: "gemma.gguf", text: "Hi Priya, I'm in.", latencyMs: 640, promptTokens: null, outputTokens: null, stop: null });
    h.s.destroy();
  });

  it("fails at once with no such host, and sends nothing to a consumer that only listed the capability", async () => {
    await expect(local.complete(ask())).rejects.toMatchObject({ why: "noHost" });
    const notHost = await host([LOCAL_MODEL_CAPABILITY], false);
    const noCap = await host(["routing"]);
    await expect(local.complete(ask())).rejects.toBeInstanceOf(LocalModelUnavailable);
    expect([...notHost.received, ...noCap.received].some((m) => (m as { type: string }).type === "localTextRequest")).toBe(false);
    notHost.s.destroy();
    noCap.s.destroy();
  });

  it("takes an answer only from that host, and refuses another's by name", async () => {
    const h = await host();
    const other = await host(["routing"]);
    const p = local.complete(ask());
    const req = LocalTextRequest.parse(await h.waitFor((m) => m.type === "localTextRequest"));
    other.send({ type: "localTextReply", v: PROTOCOL_VERSION, id: req.id, outcome: "ok", text: "Not from the host.", model: "x", latencyMs: 1 });
    expect(await other.waitFor((m) => m.type === "error")).toMatchObject({ message: 'localTextReply needs a host hello with "localModel" in its capabilities' });
    h.send({ type: "localTextReply", v: PROTOCOL_VERSION, id: req.id, outcome: "ok", text: "From the host.", model: "gemma.gguf", latencyMs: 5 });
    expect((await p).text).toBe("From the host.");
    h.s.destroy();
    other.s.destroy();
  });

  it("says each way of getting no text: busy, the host leaving, the deadline, and a late answer", async () => {
    const h = await host();
    const busy = local.complete(ask());
    const r1 = LocalTextRequest.parse(await h.waitFor((m) => m.type === "localTextRequest"));
    h.send(LocalTextReply.parse({ ...at(4), id: r1.id }));
    await expect(busy).rejects.toMatchObject({ why: "busy", message: "the host's local model answered busy (gemma-4-E2B-i1-Q4_K_M.gguf)" });

    const late = local.complete({ ...ask(), deadlineMs: clock });
    const r2 = LocalTextRequest.parse(await h.waitFor((m) => m.type === "localTextRequest" && m.id !== r1.id));
    await expect(late).rejects.toMatchObject({ why: "timeout" });
    h.send({ type: "localTextReply", v: PROTOCOL_VERSION, id: r2.id, outcome: "ok", text: "Too late.", model: "gemma.gguf", latencyMs: 1500 });
    await new Promise((r) => setTimeout(r, 30));
    expect(warnings).toContain(`localTextReply ${r2.id}: no request waits for it`);

    const gone = local.complete(ask());
    await h.waitFor((m) => m.type === "localTextRequest" && m.id !== r1.id && m.id !== r2.id);
    h.s.destroy();
    await expect(gone).rejects.toMatchObject({ why: "hostGone" });
    await expect(local.complete(ask())).rejects.toMatchObject({ why: "noHost" });
  });

  it("refuses an oversized request in the helper, naming the field, before anything is sent", async () => {
    const h = await host();
    await expect(local.complete({ ...ask(), maxTokens: 9999 })).rejects.toThrow(/maxTokens/);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.received.some((m) => (m as { type: string }).type === "localTextRequest")).toBe(false);
    h.s.destroy();
  });
});
