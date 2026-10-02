import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { PROTOCOL_VERSION, type HelperMessage } from "../src/protocol.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { field, focus, MAIL_APP, snap, text, value } from "./builders.ts";

const FORM = "5150-1";
const EMAIL = "dev.caret.fixture/standard/textfield:email~0";

function connect(path: string): Promise<{ s: Socket; lines: unknown[]; next: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const s = createConnection(path);
    const lines: unknown[] = [];
    const waiters: ((v: unknown) => void)[] = [];
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const m: unknown = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        const w = waiters.shift();
        if (w !== undefined) w(m);
        else lines.push(m);
      }
    });
    const next = (): Promise<unknown> => (lines.length > 0 ? Promise.resolve(lines.shift()) : new Promise((r) => waiters.push(r)));
    s.once("connect", () => resolve({ s, lines, next }));
    s.once("error", reject);
  });
}

const send = (s: Socket, m: unknown): void => {
  s.write(JSON.stringify(m) + "\n");
};

describe("helper socket", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let path: string;
  let jevCalls = 0;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-sock-"));
    path = join(dir, "screen.sock");
    store = new Store(join(dir, "data"));
    jevCalls = 0;
    const askJev: AskJev = async (req) => {
      jevCalls++;
      return {
        model: "jev-test",
        answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: Object.keys(req.questions[id]?.criteria ?? {})[0] ?? "none", confidence: 0.95 }])),
        inputTokens: 10,
        latencyMs: 1,
        costUsd: 0,
      };
    };
    let s: HelperServer | null = null;
    const helper = new Helper({ store, askJev, shadow: false, allowBackgroundFocus: false, publish: (m: HelperMessage) => s?.publish(m) });
    server = new HelperServer(path, () => helper, () => {});
    s = server;
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers a memory request to the asking consumer only, and rejects a bad edit with its reason", async () => {
    const asker = await connect(path);
    const other = await connect(path);
    const hello = { type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "t" };
    send(asker.s, hello);
    send(other.s, hello);
    send(asker.s, { type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "q1", op: "list", kind: "permission" });
    const reply = (await asker.next()) as { type: string; requestId: string; error: string | null; entries: { id: string; says: string }[] };
    expect(reply).toMatchObject({ type: "memoryReply", requestId: "q1", error: null });
    expect(reply.entries.map((e) => e.says)).toContain("Write where you are: ask first");
    send(asker.s, { type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "q2", op: "edit", id: "permission-sensitive", fields: { rule: "act" } });
    expect(await asker.next()).toMatchObject({ requestId: "q2", error: "sensitive can be handoff, not act", entries: [] });
    await new Promise((r) => setTimeout(r, 50));
    expect(other.lines).toEqual([]);
    asker.s.destroy();
    other.s.destroy();
  });

  it("turns a reader focus on an empty field into a proposal that consumers receive", async () => {
    const consumer = await connect(path);
    send(consumer.s, { type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "test" });
    const reader = await connect(path);
    send(reader.s, { type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 2, version: "test" });
    send(reader.s, snap([text("m/statictext:a~0", "dana.whitfield@example.com")], { at: 1000, windowId: "6160-1", app: MAIL_APP, values: [value("email", "dana.whitfield@example.com", "m/statictext:a~0")] }));
    send(reader.s, snap([field(EMAIL, "", { label: "Email" })], { at: 2000, windowId: FORM, focused: true }));
    send(reader.s, focus(FORM, EMAIL, 2100));
    const p = (await consumer.next()) as { type: string; fields: { value: string | null }[] };
    expect(p.type).toBe("fillProposal");
    expect(p.fields[0]?.value).toBe("dana.whitfield@example.com");

    // A consumer can also ask directly.
    send(consumer.s, { type: "fillRequest", v: PROTOCOL_VERSION, windowId: FORM, fieldKey: EMAIL });
    expect(((await consumer.next()) as { type: string }).type).toBe("fillProposal");
    expect(jevCalls).toBe(4); // two asks per proposal
    reader.s.destroy();
    consumer.s.destroy();
  });

  it("answers an invalid line with an error instead of dropping it", async () => {
    const reader = await connect(path);
    send(reader.s, { type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 2, version: "test" });
    send(reader.s, { type: "snapshot", v: PROTOCOL_VERSION });
    const e = (await reader.next()) as { type: string; message: string };
    expect(e.type).toBe("error");
    expect(e.message).toMatch(/invalid reader message/);
    reader.s.destroy();
  });

  it("refuses a client whose first line is not a hello", async () => {
    const c = await connect(path);
    send(c.s, { type: "pasteboard", v: PROTOCOL_VERSION, at: 1, changeCount: 1 });
    const e = (await c.next()) as { type: string; message: string };
    expect(e.message).toMatch(/first message must be hello/);
    c.s.destroy();
  });

  it("refuses to start a second helper on a live socket", async () => {
    const second = new HelperServer(path, () => {
      throw new Error("unused");
    }, () => {});
    await expect(second.listen()).rejects.toThrow(/already listening/);
  });
});

describe("executor over the socket", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let path: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-exec-sock-"));
    path = join(dir, "s.sock");
    store = new Store(join(dir, "data"));
    let s: HelperServer | null = null;
    const helper = new Helper({
      store,
      askJev: null,
      shadow: false,
      allowBackgroundFocus: false,
      publish: (m: HelperMessage) => s?.publish(m),
      sendToReader: (cmd) => s?.sendToReader(cmd) ?? false,
    });
    server = new HelperServer(path, () => helper, () => {});
    s = server;
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends reader commands to the reader, matches its answers, and streams taskProgress to consumers", async () => {
    const W = "5150-3";
    let value = "";
    const window = () => snap([field(EMAIL, value, { label: "Email" })], { at: Date.now(), windowId: W, title: "Fixture form", reason: "request" });
    const reader = await connect(path);
    send(reader.s, { type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 2, version: "test" });
    send(reader.s, window());
    // A scripted reader: every command gets a fresh snapshot (after acting) and then its answer.
    const commands: string[] = [];
    const serve = (async () => {
      for (;;) {
        const c = (await reader.next()) as { type: string; id: string; verb: { kind: string; expect?: string; value?: string } };
        if (c.type !== "readerCommand") continue;
        commands.push(c.verb.kind);
        let outcome = "ok";
        if (c.verb.kind === "write") {
          if (c.verb.expect === value) value = c.verb.value ?? "";
          else outcome = "changed";
        }
        if (c.verb.kind !== "watchInput") send(reader.s, window());
        send(reader.s, { type: "verbResult", v: PROTOCOL_VERSION, id: c.id, at: Date.now(), outcome, detail: null });
      }
    })();
    void serve;

    const consumer = await connect(path);
    send(consumer.s, { type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "test" });
    const plan = {
      id: "p",
      title: "p",
      slots: {},
      steps: [{ says: "Email holds d@example.com", end: { kind: "valueEquals", window: { title: "Fixture form" }, target: { key: EMAIL, describe: "Email" }, value: "d@example.com" } }],
    };
    send(consumer.s, { type: "runPlan", v: PROTOCOL_VERSION, taskId: "sock-1", plan, slots: {} });
    const phases: string[] = [];
    for (;;) {
      const m = (await consumer.next()) as { type: string; phase?: string };
      if (m.type !== "taskProgress") continue;
      phases.push(m.phase ?? "");
      if (m.phase === "done" || m.phase === "stopped") break;
    }
    expect(phases).toEqual(["started", "acting", "verified", "done"]);
    expect(value).toBe("d@example.com");
    // The watch is released after "done" is published, so its command may still be on the way.
    for (let i = 0; i < 50 && commands.length < 5; i++) await new Promise((r) => setTimeout(r, 10));
    expect(commands).toEqual(["walk", "watchInput", "walk", "write", "watchInput"]);
    reader.s.destroy();
    consumer.s.destroy();
  });
});
