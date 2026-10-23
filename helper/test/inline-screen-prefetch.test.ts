import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { ScreenTextRevision, ScreenTextReply } from "../src/protocol.ts";
import { FIXTURE_APP, snap, text } from "./builders.ts";
import { authenticateHost, LineClient, TEST_LAUNCH_SECRET } from "./socket-reader.ts";

describe("screen prefetch reader revisions", () => {
  let dir: string;
  let helper: Helper;
  let server: HelperServer;
  let store: Store;
  const clients: LineClient[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-screen-prefetch-"));
    store = new Store(join(dir, "data"));
    helper = new Helper({ store, shadow: true, allowBackgroundFocus: false, askJev: async () => { throw new Error("screen text must not call Jev"); }, publish: (m) => server.publish(m) });
    server = new HelperServer(join(dir, "screen.sock"), () => helper, () => {}, TEST_LAUNCH_SECRET);
    await server.listen();
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await server.close();
    helper.shutdown();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const connect = async (role: "reader" | "consumer"): Promise<LineClient> => {
    const client = await LineClient.connect(join(dir, "screen.sock"));
    clients.push(client);
    client.send({ type: "hello", v: 1, role, mode: "shadow", pid: 3, version: "screen-prefetch-test", ...(role === "consumer" ? { host: true, capabilities: ["screenText"] } : {}) });
    if (role === "consumer") await authenticateHost(client);
    return client;
  };

  it("publishes revisions after model updates and refuses a request for an earlier reader revision", async () => {
    const host = await connect("consumer");
    const initial = await host.waitFor<ScreenTextRevision>((m) => m.type === "screenTextRevision");
    const reader = await connect("reader");
    reader.send(snap([text("nearby", "Window A text")], { at: 1000, windowId: "a", number: 101, focused: true }));
    const updated = await host.waitFor<ScreenTextRevision>((m) => m.type === "screenTextRevision" && Number(m.revision) > initial.revision + 1);
    const request = { type: "screenTextRequest", v: 1, id: "current", revision: updated.revision, pid: FIXTURE_APP.pid, windowNumber: 101, maxCharacters: 2048 };
    host.send(request);
    expect(await host.waitFor<ScreenTextReply>((m) => m.type === "screenTextReply" && m.id === "current")).toMatchObject({ text: "Window A text", revision: updated.revision });
    reader.send(snap([text("nearby", "New A text")], { at: 2000, windowId: "a", number: 101, focused: true }));
    const next = await host.waitFor<ScreenTextRevision>((m) => m.type === "screenTextRevision" && Number(m.revision) > updated.revision);
    host.send({ ...request, id: "stale" });
    expect(await host.waitFor<ScreenTextReply>((m) => m.type === "screenTextReply" && m.id === "stale")).toMatchObject({ text: null });
    host.send({ ...request, id: "fresh", revision: next.revision });
    expect(await host.waitFor<ScreenTextReply>((m) => m.type === "screenTextReply" && m.id === "fresh")).toMatchObject({ text: "New A text" });
    reader.close();
    const closed = await host.waitFor<ScreenTextRevision>((m) => m.type === "screenTextRevision" && Number(m.revision) > next.revision);
    host.send({ ...request, id: "disconnected", revision: closed.revision });
    expect(await host.waitFor<ScreenTextReply>((m) => m.type === "screenTextReply" && m.id === "disconnected")).toMatchObject({ text: null });
  });

  it("withholds the focused reader window from a host asking for another window of the same pid", async () => {
    const host = await connect("consumer");
    const reader = await connect("reader");
    reader.send(snap([text("nearby", "Window B text")], { at: 1000, windowId: "b", title: "Same title", number: 102, focused: true }));
    const updated = await host.waitFor<ScreenTextRevision>((m) => m.type === "screenTextRevision" && Number(m.revision) >= 2);
    host.send({ type: "screenTextRequest", v: 1, id: "other-window", revision: updated.revision, pid: FIXTURE_APP.pid, windowNumber: 101, maxCharacters: 2048 });
    expect(await host.waitFor<ScreenTextReply>((m) => m.type === "screenTextReply" && m.id === "other-window")).toMatchObject({ text: null });
  });
});
