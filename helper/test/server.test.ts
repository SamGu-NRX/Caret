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
        answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: "c1", confidence: 0.95 }])),
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
    expect(jevCalls).toBe(2);
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
