// W2: the lines in fixtures/golden/value-checks.ndjson are the contract a host decodes for the write contract's protocol
// additions: a hello with VALUE_CHECKS_CAPABILITY; a page walk whose text inputs carry their kind (Node.inputKind); a
// fill proposal that withholds one field as "notExact" and one as "unverified"; and the same proposal as a host without
// the capability is sent it, both reasons read as "wrongKind". On the socket only a host that declared the capability
// gets the new reasons. The values are synthetic.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer, withOldReasons } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { ConsumerMessage, HelperMessage, PROTOCOL_VERSION, ReaderMessage, VALUE_CHECKS_CAPABILITY, type FillProposal } from "../src/protocol.ts";

const lines = readFileSync(new URL("../fixtures/golden/value-checks.ndjson", import.meta.url), "utf8").trim().split("\n");
const at = (i: number): Record<string, unknown> => JSON.parse(lines[i] as string) as Record<string, unknown>;

describe("the value-check protocol lines (W2)", () => {
  it("parses every golden line and writes it back byte for byte", () => {
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(["hello", "snapshot", "fillProposal", "fillProposal"]);
    expect(JSON.stringify(ConsumerMessage.parse(at(0)))).toBe(lines[0]);
    expect(JSON.stringify(ReaderMessage.parse(at(1)))).toBe(lines[1]);
    expect(JSON.stringify(HelperMessage.parse(at(2)))).toBe(lines[2]);
    expect(JSON.stringify(HelperMessage.parse(at(3)))).toBe(lines[3]);
    expect((at(0).capabilities as string[]).includes(VALUE_CHECKS_CAPABILITY)).toBe(true);
    expect((at(1).nodes as { inputKind?: string }[]).map((n) => n.inputKind)).toEqual(["email", "text"]);
  });

  it("is the old line, reasons mapped to wrongKind, for a host without the capability", () => {
    const p = HelperMessage.parse(at(2)) as FillProposal;
    expect(p.fields.map((f) => f.withheld)).toEqual([null, "notExact", "unverified"]);
    expect(JSON.stringify(withOldReasons(p))).toBe(lines[3]);
  });
});

function connect(path: string): Promise<{ s: Socket; lines: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const s = createConnection(path);
    const got: Record<string, unknown>[] = [];
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      buf += d;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        got.push(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
        buf = buf.slice(nl + 1);
      }
    });
    s.once("connect", () => resolve({ s, lines: got }));
    s.once("error", reject);
  });
}
const send = (s: Socket, m: unknown): void => void s.write(JSON.stringify(m) + "\n");
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
const hello = (pid: number, capabilities: string[]) => ({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid, version: "test", host: true, capabilities });

describe("the new reasons on the socket (W2)", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let path: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-checks-sock-"));
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

  it("sends notExact and unverified only to a host that declared valueChecks; any other gets wrongKind", async () => {
    const checks = await connect(path);
    const plain = await connect(path);
    send(checks.s, hello(1, ["fillAll", VALUE_CHECKS_CAPABILITY]));
    send(plain.s, hello(2, ["fillAll"]));
    await tick();
    server.publish(HelperMessage.parse(at(2)));
    await tick();
    const reasons = (c: { lines: Record<string, unknown>[] }): unknown[] => c.lines.filter((l) => l.type === "fillProposal").flatMap((l) => (l.fields as { withheld: unknown }[]).map((f) => f.withheld));
    expect(reasons(checks)).toEqual([null, "notExact", "unverified"]);
    expect(reasons(plain)).toEqual([null, "wrongKind", "wrongKind"]);
    checks.s.destroy();
    plain.s.destroy();
  });
});
