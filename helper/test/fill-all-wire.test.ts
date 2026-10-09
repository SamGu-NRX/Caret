// D2-04: the host's Command-1 on a per-field fill proposal asks the helper for the whole form in one transaction
// (protocol FillAll), and a control Caret writes in that transaction says so in its hand-off (FillHandoff.writes). The
// lines in fixtures/golden/fill-all.ndjson are the contract the host (H5/H6) decodes: a host hello that declares the
// capability, a proposal, the request, its run, a second request refused, and the undo.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnyMessage, ConsumerMessage, FILL_ALL_CAPABILITY, FillProposal, HelperMessage, PROTOCOL_VERSION } from "../src/protocol.ts";
import { HelperServer } from "../src/server.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { authenticateHost, LineClient, TEST_LAUNCH_SECRET } from "./socket-reader.ts";

const lines = readFileSync(new URL("../fixtures/golden/fill-all.ndjson", import.meta.url), "utf8").trim().split("\n");
const CONSUMER = new Set(["hello", "fillAll", "taskControl"]);

describe("the fill-all protocol lines", () => {
  it("parses every golden line and writes it back byte for byte", () => {
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(["hello", "fillProposal", "fillAll", "taskProgress", "taskProgress", "taskProgress", "fillAll", "error", "taskProgress", "taskControl", "taskProgress"]);
    for (const l of lines) {
      const m = JSON.parse(l) as { type: string };
      expect(JSON.stringify((CONSUMER.has(m.type) ? ConsumerMessage : HelperMessage).parse(m)), m.type).toBe(l);
    }
  });

  it("marks only the controls Caret writes, and keeps every control's value out of `value`", () => {
    const p = FillProposal.parse(JSON.parse(lines[1] as string));
    expect(p.fields.map((f) => [f.control, f.value === null ? null : "value", f.handoff?.writes ?? null])).toEqual([
      ["text", "value", null],
      ["select", null, true],
      ["radio", null, true],
      ["checkbox", null, true],
      ["checkbox", null, null],
      ["date", null, true],
      ["date", null, null],
    ]);
  });

  it("refuses the shapes the contract rules out", () => {
    const at = (i: number): Record<string, unknown> => JSON.parse(lines[i] as string) as Record<string, unknown>;
    const bad = (m: unknown): boolean => !AnyMessage.safeParse(m).success;
    expect(bad({ ...at(2), proposalId: "" })).toBe(true);
    expect(bad({ ...at(2), at: -1 })).toBe(true);
    const p = at(1) as { fields: Record<string, unknown>[] };
    const select = p.fields[1] as Record<string, unknown>;
    // A control's value is never `value`, even one Caret writes; `writes` is true or absent.
    expect(bad({ ...p, fields: [{ ...select, value: "Canada", source: select.handoff && (select.handoff as Record<string, unknown>).source }] })).toBe(true);
    expect(bad({ ...p, fields: [{ ...select, handoff: { ...(select.handoff as object), writes: false } }] })).toBe(true);
  });
});

describe("fillAll on the socket", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-fill-all-"));
    store = new Store(join(dir, "data"));
    const own: HelperServer = new HelperServer(join(dir, "screen.sock"), () => mine, () => {}, TEST_LAUNCH_SECRET);
    const mine: Helper = new Helper({ store, askJev: () => Promise.reject(new Error("no Jev here")), shadow: false, allowBackgroundFocus: false, publish: (m) => own.publish(m) });
    helper = mine;
    server = own;
    await server.listen();
  });
  afterEach(async () => {
    await server.close();
    helper.shutdown();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ask = { type: "fillAll", v: PROTOCOL_VERSION, proposalId: "fill-404", at: 1 } as const;

  it("is refused by name from a host that did not declare the capability, and from a consumer that is not the host", async () => {
    for (const hello of [
      { type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "old-host", host: true },
      { type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 2, version: "tool", capabilities: [FILL_ALL_CAPABILITY] },
    ]) {
      const c = await LineClient.connect(join(dir, "screen.sock"));
      c.send(hello);
      if (hello.host === true) await authenticateHost(c);
      c.send(ask);
      const e = await c.waitFor((m) => m.type === "error" && String(m.message).includes("fillAll"));
      expect(e.message).toBe(`fillAll needs a host hello with "${FILL_ALL_CAPABILITY}" in its capabilities`);
      c.close();
    }
  });

  it("reaches the helper from a host that declared it: an unknown proposal is refused there, as an offerAccept's is", async () => {
    const c = await LineClient.connect(join(dir, "screen.sock"));
    c.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "host", host: true, capabilities: [FILL_ALL_CAPABILITY] });
    await authenticateHost(c);
    c.send(ask);
    const stopped = await c.waitFor((m) => m.type === "taskProgress" && m.taskId === "fill-404");
    expect(stopped).toMatchObject({ phase: "stopped", stopReason: "refused", detail: "no such fill proposal, or it expired" });
    c.close();
  });
});
