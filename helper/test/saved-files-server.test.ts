// H14: on the socket, the memory window's Files section belongs to hosts that declared GOAL_FILES_CAPABILITY. Only they
// may send savedFilesRequest, and the reply, which names files and paths, goes to the asker alone.
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { authenticateRawHost, TEST_LAUNCH_SECRET } from "./socket-reader.ts";

function connect(path: string): Promise<{ s: Socket; lines: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const s = createConnection(path);
    const lines: Record<string, unknown>[] = [];
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      buf += d;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        lines.push(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
        buf = buf.slice(nl + 1);
      }
    });
    s.once("connect", () => resolve({ s, lines }));
    s.once("error", reject);
  });
}
const send = (s: Socket, m: unknown): void => void s.write(JSON.stringify(m) + "\n");
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
const hello = (pid: number, capabilities: string[]) => ({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid, version: "test", host: true, capabilities });
const list = { type: "savedFilesRequest", v: PROTOCOL_VERSION, requestId: "files-1", op: "list" };

describe("saved files on the socket (H14)", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let path: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-h14-sock-"));
    path = join(dir, "screen.sock");
    store = new Store(join(dir, "data"));
    let s: HelperServer | null = null;
    helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => s?.publish(m) });
    server = new HelperServer(path, () => helper, () => {}, TEST_LAUNCH_SECRET);
    s = server;
    await server.listen();
  });
  afterEach(async () => {
    helper.shutdown();
    await server.close();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers the asker only", async () => {
    const asker = await connect(path);
    const other = await connect(path);
    send(asker.s, hello(1, ["goalPlans", "goalFiles"]));
    send(other.s, hello(2, ["goalPlans", "goalFiles"]));
    await authenticateRawHost(asker.s, asker.lines);
    await authenticateRawHost(other.s, other.lines);
    await tick();
    send(asker.s, list);
    await tick();
    expect(asker.lines).toEqual([{ type: "savedFilesReply", v: PROTOCOL_VERSION, requestId: "files-1", error: null, files: [] }]);
    expect(other.lines).toEqual([]);
    asker.s.destroy();
    other.s.destroy();
  });

  it("refuses a host that did not declare goalFiles", async () => {
    const plain = await connect(path);
    send(plain.s, hello(2, ["goalPlans"]));
    await authenticateRawHost(plain.s, plain.lines);
    await tick();
    send(plain.s, list);
    await tick();
    expect(plain.lines.map((l) => l.type)).toEqual(["error"]);
    expect(String(plain.lines[0]?.message)).toMatch(/savedFilesRequest needs a host hello with "goalFiles"/);
    plain.s.destroy();
  });
});
