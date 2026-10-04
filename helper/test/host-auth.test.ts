// B23: which consumer is the host (Sol #6 on B22), and the helper's side of the reader's authentication
// (CodeRabbit on PR #4): the proof goes first, a helper with no launch secret is refused by name, and the socket's
// directory is the user's own. The reader's side is in apps/screen-reader/Tests/CaretScreenAXTests/AuthTests.swift.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer, helperProof } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { LineClient, until } from "./socket-reader.ts";

const SECRET = Buffer.from("caret-b23-golden-launch-secret!!");
const CHALLENGE = Buffer.from("caret-b23-golden-challenge-32byt").toString("base64");
const hello = (role: "reader" | "consumer", extra: Record<string, unknown> = {}) => ({ type: "hello", v: PROTOCOL_VERSION, role, mode: "live", pid: 9, version: "test", ...extra });

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
    expect(first).toEqual({ type: "helperAuth", v: PROTOCOL_VERSION, proof: helperProof(SECRET, CHALLENGE) });
    reader.close();
  });

  it("refuses, by name, a reader that asks for proof when the helper has no launch secret", async () => {
    const reader = await LineClient.connect(await listen(null));
    reader.send(hello("reader", { challenge: CHALLENGE }));
    const err = await reader.waitFor((m) => m.type === "error");
    expect(String(err.message)).toMatch(/without a launch secret/);
    await new Promise<void>((r) => (reader.s.destroyed ? r() : reader.s.once("close", () => r())));
    expect(reader.received.some((m) => (m as { type?: string }).type === "helperAuth")).toBe(false);
  });

  it("counts only a consumer whose hello says host as the host", async () => {
    const path = await listen(SECRET);
    const script = await LineClient.connect(path);
    script.send(hello("consumer"));
    script.send({ type: "activityRequest", v: PROTOCOL_VERSION, requestId: "a", op: "list" });
    await script.waitFor((m) => m.type === "activityReply");
    expect(helper.hostPresent).toBe(false);
    const host = await LineClient.connect(path);
    host.send(hello("consumer", { host: true }));
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
});
