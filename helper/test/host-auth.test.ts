// B23: which consumer is the host (Sol #6 on B22), and the helper's side of the reader's authentication
// (CodeRabbit on PR #4): the proof goes first, a helper with no launch secret is refused by name, and the socket's
// directory is the user's own. The reader's side is in apps/screen-reader/Tests/CaretScreenAXTests/AuthTests.swift.
//
// The host's authentication to the helper (src/host-auth.ts): a hello with host: true is challenged, and nothing a host
// is sent reaches the connection until its proof checks out. The host's side is apps/caret HostAuthTests.swift, which
// checks the same vector (fixtures/golden/host-auth.json).
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pageKey } from "../src/engines/auth.ts";
import { Helper } from "../src/helper.ts";
import { hostKey, hostProof, hostProofMatches } from "../src/host-auth.ts";
import { sendHostKey } from "../src/launch.ts";
import { HelperServer, helperProof } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { ConsumerMessage, FILL_ALL_CAPABILITY, GOAL_FILES_CAPABILITY, GOAL_PLANS_CAPABILITY, HelperMessage, PAGE_TEXT_CAPABILITY, PROTOCOL_VERSION, ROUTING_CAPABILITY, SAVED_ANSWERS_CAPABILITY } from "../src/protocol.ts";
import { authenticateHost, LineClient, until } from "./socket-reader.ts";

const SECRET = Buffer.from("caret-b23-golden-launch-secret!!");
const CHALLENGE = Buffer.from("caret-b23-golden-challenge-32byt").toString("base64");
const hello = (role: "reader" | "consumer", extra: Record<string, unknown> = {}) => ({ type: "hello", v: PROTOCOL_VERSION, role, mode: "live", pid: 9, version: "test", ...extra });

const golden = (name: string): Record<string, unknown>[] =>
  readFileSync(fileURLToPath(new URL(`../fixtures/golden/${name}`, import.meta.url)), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
const VECTOR = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/golden/host-auth.json", import.meta.url)), "utf8")) as {
  launchSecret: string; hostKey: string; nonce: string; proof: string; lines: Record<string, unknown>[];
};
/** One of each message only a host with the matching capability is sent whole, from the golden files the host decodes. */
const PAGE_FIELD = HelperMessage.parse(golden("page-inline.ndjson")[1]);
const ROUTE = HelperMessage.parse(golden("routing.ndjson")[2]);
const GOAL = HelperMessage.parse(golden("page-goal.ndjson")[2]);
const ANSWER_OFFER = HelperMessage.parse(golden("answers.ndjson")[1]);
const EVERY_HOST_CAPABILITY = [PAGE_TEXT_CAPABILITY, SAVED_ANSWERS_CAPABILITY, ROUTING_CAPABILITY, GOAL_PLANS_CAPABILITY, GOAL_FILES_CAPABILITY, FILL_ALL_CAPABILITY];

const types = (c: LineClient): string[] => c.received.map((m) => String((m as { type?: unknown }).type));
const closed = (c: LineClient): Promise<void> => new Promise<void>((r) => (c.s.destroyed ? r() : c.s.once("close", () => r())));

describe("the helper's socket, B23", () => {
  let dir: string;
  let sockDir: string;
  let store: Store;
  let helper: Helper;
  let server: HelperServer | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-b23-"));
    sockDir = join(dir, "sockets");
    store = new Store(join(dir, "data"));
    helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => server?.publish(m), sendToReader: (m) => server?.sendToReader(m) ?? false });
    server = null;
  });
  afterEach(async () => {
    await server?.close();
    helper.memory.close();
    helper.journal.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const listen = async (secret: Buffer | null): Promise<string> => {
    const path = join(sockDir, "s.sock");
    server = new HelperServer(path, () => helper, () => undefined, secret);
    await server.listen();
    return path;
  };

  it("answers the reader's challenge with the proof before anything else", async () => {
    const reader = await LineClient.connect(await listen(SECRET));
    reader.send(hello("reader", { session: "reader-launch-1", challenge: CHALLENGE }));
    const first = await reader.waitFor((m) => m.type !== undefined);
    expect(first).toEqual({ type: "helperAuth", v: PROTOCOL_VERSION, proof: helperProof(SECRET, CHALLENGE, process.pid), pid: process.pid });
    reader.close();
  });

  it("refuses, by name, a reader that asks for proof when the helper has no launch secret", async () => {
    const reader = await LineClient.connect(await listen(null));
    reader.send(hello("reader", { challenge: CHALLENGE }));
    const err = await reader.waitFor((m) => m.type === "error");
    expect(String(err.message)).toMatch(/without a launch secret/);
    await closed(reader);
    expect(reader.received.some((m) => (m as { type?: string }).type === "helperAuth")).toBe(false);
  });

  it("counts only a consumer whose hello says host, and whose proof checked out, as the host", async () => {
    const path = await listen(SECRET);
    const script = await LineClient.connect(path);
    script.send(hello("consumer"));
    script.send({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "a", op: "list" });
    await script.waitFor((m) => m.type === "activityReply");
    expect(helper.hostPresent).toBe(false);
    const host = await LineClient.connect(path);
    host.send(hello("consumer", { host: true }));
    await host.waitFor((m) => m.type === "hostChallenge");
    expect(helper.hostPresent).toBe(false);
    await authenticateHost(host, SECRET);
    await until(() => helper.hostPresent);
    host.close();
    await until(() => !helper.hostPresent);
    script.close();
  });

  it("closes the socket's directory to other users when it opens", async () => {
    mkdirSync(sockDir, { mode: 0o755 });
    chmodSync(sockDir, 0o755);
    await listen(SECRET);
    expect(statSync(sockDir).mode & 0o777).toBe(0o700);
  });

  describe("the host's proof", () => {
    it("derives the golden vector's key and proof, apart from the page key", () => {
      const secret = Buffer.from(VECTOR.launchSecret, "hex");
      expect(secret).toEqual(SECRET);
      const key = hostKey(secret);
      expect(key.toString("hex")).toBe(VECTOR.hostKey);
      expect(hostProof(key, VECTOR.nonce)).toBe(VECTOR.proof);
      expect(hostProofMatches(key, VECTOR.nonce, VECTOR.proof)).toBe(true);
      // Domain-separated: neither the secret nor page.sock's key is the host key, and another nonce's proof fails.
      expect(key.equals(secret)).toBe(false);
      expect(key.equals(pageKey(secret))).toBe(false);
      expect(hostProofMatches(key, Buffer.alloc(32, 9).toString("base64"), VECTOR.proof)).toBe(false);
      expect(hostProofMatches(key, VECTOR.nonce, "")).toBe(false);
      expect(() => hostKey(Buffer.alloc(31))).toThrow(/32 bytes/);
    });

    it("puts the challenge and acceptance in HelperMessage and the proof in ConsumerMessage, each in one direction", () => {
      const [challenge, proof, accepted] = VECTOR.lines;
      expect(HelperMessage.parse(challenge)).toEqual({ type: "hostChallenge", v: 1, nonce: VECTOR.nonce });
      expect(ConsumerMessage.parse(proof)).toEqual({ type: "hostProof", v: 1, proof: VECTOR.proof });
      expect(HelperMessage.parse(accepted)).toEqual({ type: "hostAuthenticated", v: 1 });
      expect(ConsumerMessage.safeParse(challenge).success).toBe(false);
      expect(ConsumerMessage.safeParse(accepted).success).toBe(false);
      expect(HelperMessage.safeParse(proof).success).toBe(false);
      expect(HelperMessage.safeParse({ ...challenge, nonce: "short" }).success).toBe(false);
    });

    it("sends a host hello with no proof nothing a host gets: no page text, saved answer, route or goal", async () => {
      const path = await listen(SECRET);
      const plain = await LineClient.connect(path);
      plain.send(hello("consumer", { pid: 10 }));
      plain.send({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "a", op: "list" });
      await plain.waitFor((m) => m.type === "activityReply");
      const host = await LineClient.connect(path);
      host.send(hello("consumer", { host: true, capabilities: EVERY_HOST_CAPABILITY }));
      await host.waitFor((m) => m.type === "hostChallenge");
      for (const m of [PAGE_FIELD, ROUTE, GOAL, ANSWER_OFFER]) server?.publish(m);
      // The plain consumer is sent the page field without its text, which shows the publish went out.
      const field = await plain.waitFor((m) => m.type === "pageField");
      expect(field.text).toBeUndefined();
      await new Promise((r) => setTimeout(r, 50));
      expect(types(host)).toEqual(["hostChallenge"]);
      expect(helper.hostPresent).toBe(false);
      host.close();
      plain.close();
    });

    it("refuses a wrong proof by name and closes the socket", async () => {
      const host = await LineClient.connect(await listen(SECRET));
      host.send(hello("consumer", { host: true, capabilities: EVERY_HOST_CAPABILITY }));
      const challenge = await host.waitFor<{ nonce: string }>((m) => m.type === "hostChallenge");
      host.send({ type: "hostProof", v: PROTOCOL_VERSION, proof: hostProof(hostKey(Buffer.alloc(32, 1)), challenge.nonce) });
      const err = await host.waitFor((m) => m.type === "error");
      expect(String(err.message)).toMatch(/proof does not match this connection's challenge/);
      await closed(host);
      expect(types(host)).toEqual(["hostChallenge", "error"]);
      expect(helper.hostPresent).toBe(false);
    });

    it("refuses any other line before the proof, by name, and closes the socket", async () => {
      const host = await LineClient.connect(await listen(SECRET));
      host.send(hello("consumer", { host: true, capabilities: [ROUTING_CAPABILITY] }));
      await host.waitFor((m) => m.type === "hostChallenge");
      host.send({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "a", op: "list" });
      const err = await host.waitFor((m) => m.type === "error");
      expect(String(err.message)).toBe(`a host's next line after hello must be hostProof, not "activityRequest"; closing`);
      await closed(host);
      expect(types(host)).toEqual(["hostChallenge", "error"]);
    });

    it("refuses a proof made for another connection's challenge", async () => {
      const path = await listen(SECRET);
      const first = await LineClient.connect(path);
      const second = await LineClient.connect(path);
      first.send(hello("consumer", { host: true }));
      second.send(hello("consumer", { host: true }));
      const a = await first.waitFor<{ nonce: string }>((m) => m.type === "hostChallenge");
      const b = await second.waitFor<{ nonce: string }>((m) => m.type === "hostChallenge");
      expect(a.nonce).not.toBe(b.nonce);
      expect(Buffer.from(a.nonce, "base64")).toHaveLength(32);
      // The first connection's proof, replayed on the second.
      second.send({ type: "hostProof", v: PROTOCOL_VERSION, proof: hostProof(hostKey(SECRET), a.nonce) });
      expect(String((await second.waitFor((m) => m.type === "error")).message)).toMatch(/proof does not match/);
      await closed(second);
      expect(helper.hostPresent).toBe(false);
      // The first still authenticates with its own, once: a second proof answers nothing.
      first.send({ type: "hostProof", v: PROTOCOL_VERSION, proof: hostProof(hostKey(SECRET), a.nonce) });
      await first.waitFor((m) => m.type === "hostAuthenticated");
      await until(() => helper.hostPresent);
      first.send({ type: "hostProof", v: PROTOCOL_VERSION, proof: hostProof(hostKey(SECRET), a.nonce) });
      expect(String((await first.waitFor((m) => m.type === "error")).message)).toBe("hostProof answers a hostChallenge, and this connection has none outstanding");
      first.close();
    });

    it("closes a host connection that sends no proof within the timeout", async () => {
      const path = await listen(SECRET);
      if (server === null) throw new Error("no server");
      server.hostProofTimeoutMs = 40;
      const host = await LineClient.connect(path);
      host.send(hello("consumer", { host: true, capabilities: EVERY_HOST_CAPABILITY }));
      await host.waitFor((m) => m.type === "hostChallenge");
      const err = await host.waitFor((m) => m.type === "error", 1000);
      expect(String(err.message)).toBe("no hostProof within 40 ms of the host's hello; closing");
      await closed(host);
      expect(helper.hostPresent).toBe(false);
    });

    it("grants a proven host exactly the capabilities its hello asked for", async () => {
      const path = await listen(SECRET);
      const pageOnly = await LineClient.connect(path);
      pageOnly.send(hello("consumer", { pid: 11, host: true, capabilities: [PAGE_TEXT_CAPABILITY] }));
      await authenticateHost(pageOnly, SECRET);
      const routed = await LineClient.connect(path);
      routed.send(hello("consumer", { pid: 12, host: true, capabilities: [ROUTING_CAPABILITY, SAVED_ANSWERS_CAPABILITY, GOAL_PLANS_CAPABILITY] }));
      await authenticateHost(routed, SECRET);
      await until(() => helper.hostPresent);
      for (const m of [PAGE_FIELD, ROUTE, GOAL, ANSWER_OFFER]) server?.publish(m);
      expect(await pageOnly.waitFor((m) => m.type === "pageField")).toEqual(PAGE_FIELD);
      expect((await routed.waitFor((m) => m.type === "pageField")).text).toBeUndefined();
      await routed.waitFor((m) => m.type === "routeDecision");
      await routed.waitFor((m) => m.type === "goalProgress");
      await routed.waitFor((m) => m.type === "answerSaveOffer");
      // A host that did not ask for fillAll may not send it, though its proof checked out.
      pageOnly.send({ type: "fillAll", v: PROTOCOL_VERSION, proposalId: "p", at: 1 });
      expect(String((await pageOnly.waitFor((m) => m.type === "error")).message)).toMatch(/fillAll needs a host hello with "fillAll"/);
      expect(types(pageOnly)).toEqual(["hostChallenge", "hostAuthenticated", "pageField", "error"]);
      pageOnly.close();
      routed.close();
    });

    it("hands a script the host key on the descriptor named by launch.ts --host-key-fd, and refuses one that is not inherited", async () => {
      const launch = fileURLToPath(new URL("../src/launch.ts", import.meta.url));
      // A child with fd 3 a pipe back to this test, as a script's parent would pass it.
      const child = spawn(process.execPath, ["--input-type=module", "-e", `import { sendHostKey } from ${JSON.stringify(launch)}; sendHostKey("3", Buffer.from(${JSON.stringify(VECTOR.launchSecret)}, "hex"));`], { stdio: ["ignore", "ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      child.stdio[3]?.on("data", (d: Buffer) => chunks.push(d));
      const errors: Buffer[] = [];
      child.stderr?.on("data", (d: Buffer) => errors.push(d));
      const code = await new Promise<number | null>((r) => child.once("close", r));
      expect(Buffer.concat(errors).toString()).toBe("");
      expect(code).toBe(0);
      expect(Buffer.concat(chunks).toString("hex")).toBe(VECTOR.hostKey);
      expect(() => sendHostKey("2", SECRET)).toThrow("--host-key-fd 2 is not an inherited descriptor (3 and above)");
      expect(() => sendHostKey("3x", SECRET)).toThrow("--host-key-fd 3x is not an inherited descriptor (3 and above)");
      expect(() => sendHostKey("987", SECRET)).toThrow("--host-key-fd 987: no such open descriptor; the parent must pass one (a pipe's write end)");
    });

    it("refuses a host hello by name when the helper has no launch secret, and does not take it as a plain consumer", async () => {
      const host = await LineClient.connect(await listen(null));
      host.send(hello("consumer", { host: true, capabilities: EVERY_HOST_CAPABILITY }));
      const err = await host.waitFor((m) => m.type === "error");
      expect(String(err.message)).toMatch(/^this helper has no launch secret, so no host can authenticate/);
      await closed(host);
      expect(types(host)).toEqual(["error"]);
      expect(helper.hostPresent).toBe(false);
    });
  });
});
