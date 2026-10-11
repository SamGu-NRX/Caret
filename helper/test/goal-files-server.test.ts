// P3: on the socket, files in goal plans belong to hosts that declared GOAL_FILES_CAPABILITY. A preview with an attach
// row, and an offer to keep a file, go only to them (P3 review: every goal-planning host got them, and one without the
// capability could neither show nor decode the row); only they may send goalAccept.confirmedFile or fileSave.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { HelperMessage, PROTOCOL_VERSION } from "../src/protocol.ts";

const golden = readFileSync(new URL("../fixtures/golden/goal-files.ndjson", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

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

describe("files in goal plans on the socket (P3)", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let path: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-files-sock-"));
    path = join(dir, "screen.sock");
    store = new Store(join(dir, "data"));
    let s: HelperServer | null = null;
    helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => s?.publish(m) });
    server = new HelperServer(path, () => helper, () => {});
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

  it("sends a preview with an attach row, and a file offer, only to a host that shows attach rows", async () => {
    const files = await connect(path);
    const plain = await connect(path);
    send(files.s, hello(1, ["goalPlans", "goalFiles"]));
    send(plain.s, hello(2, ["goalPlans"]));
    await tick();
    const withAttach = HelperMessage.parse(golden[2]);
    const withoutAttach = HelperMessage.parse({ ...golden[20], steps: (golden[20]?.steps as { kind: string }[]).filter((x) => x.kind !== "attach") });
    server.publish(withAttach);
    server.publish(HelperMessage.parse(golden[15]));
    server.publish(withoutAttach);
    await tick();
    const kinds = (c: { lines: Record<string, unknown>[] }): string[] => c.lines.map((l) => `${String(l.type)}:${(l.steps as unknown[] | undefined)?.length ?? "-"}`);
    expect(kinds(files)).toEqual(["goalProgress:10", "fileSaveOffer:-", "goalProgress:2"]);
    expect(kinds(plain)).toEqual(["goalProgress:2"]);
    files.s.destroy();
    plain.s.destroy();
  });

  it("refuses confirmedFile and fileSave from a host that did not declare goalFiles", async () => {
    const plain = await connect(path);
    send(plain.s, hello(2, ["goalPlans"]));
    await tick();
    send(plain.s, golden[3]);
    send(plain.s, golden[16]);
    await tick();
    const errors = plain.lines.filter((l) => l.type === "error").map((l) => String(l.message));
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/confirmedFile needs a host hello with "goalFiles"/);
    expect(errors[1]).toMatch(/fileSave needs a host hello with "goalFiles"/);
    plain.s.destroy();
  });
});
