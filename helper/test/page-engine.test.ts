// W1: the helper's side of the page engine: page.sock's handshake, engine sessions, the registry and the routed link.
import { mkdtempSync, rmSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type ActGrant, type HelperToEngine, type PageSnapshot, type ReaderVerb, type Snapshot, type VerbResult, type WindowClosed } from "../src/protocol.ts";
import { RoutedReaderLink, type ReaderLink } from "../src/executor/means.ts";
import { bridgeProof, helperProof, newNonce, pageKey } from "../src/engines/auth.ts";
import { pageHost, type PageHost } from "../src/engines/host.ts";
import { EngineSession } from "../src/engines/session.ts";
import { PageEngineLink, toVerbOutcome, toWindowSnapshot } from "../src/engines/page-link.ts";
import { parsePageWindow } from "../src/engines/windows.ts";
import { LineClient } from "./socket-reader.ts";

const X = "kcmlnoabcdefghijklmnopabcdefghij";
const browser = { pid: 4100, bundleId: "com.google.chrome.for.testing", name: "Google Chrome for Testing" };

function snapshot(id: string, tabId = 7, navGen = 1): PageSnapshot {
  return {
    type: "pageSnapshot", v: PROTOCOL_VERSION, id, at: 1, tabId, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Synthetic",
    frames: [
      { frameId: 0, parentFrameId: -1, documentId: "D0", origin: "http://127.0.0.1:4310", path: "/form", navGen, title: "Synthetic", headings: [], iframes: [], excluded: {}, truncated: false,
        controls: [
          { id: "e1", key: "textbox:first name~0", strongKey: null, kind: "text", role: "textbox", name: "First name", value: "", form: null, rect: [0, 0, 100, 20] },
          { id: "e2", key: "combobox:country~0", strongKey: null, kind: "select", role: "combobox", name: "Country", value: "", options: [{ value: "", label: "Choose", selected: true }, { value: "ca", label: "Canada", selected: false }], form: null, rect: [0, 30, 100, 20] },
          { id: "e3", key: "button:submit~0", strongKey: null, kind: "button", role: "button", name: "Submit", form: null, rect: [0, 60, 100, 20] },
        ] },
      { frameId: 4, parentFrameId: 0, documentId: "D4", origin: "http://127.0.0.1:4311", path: "/embed", navGen: 2, title: "", headings: [], iframes: [], excluded: {}, truncated: false,
        controls: [{ id: "e1", key: "textbox:referral~0", strongKey: null, kind: "text", role: "textbox", name: "Referral", value: "x", form: null, rect: [0, 0, 100, 20] }] },
    ],
    missing: [], focused: { frameId: 4, id: "e1", selection: null },
  };
}

describe("page key", () => {
  it("is derived from the launch secret, the same for every start of one launch, and never the secret itself", () => {
    const launch = randomBytes(32);
    const a = pageKey(launch);
    expect(a.length).toBe(32);
    expect(a.equals(launch)).toBe(false);
    expect(pageKey(launch).equals(a)).toBe(true);
    expect(pageKey(randomBytes(32)).equals(a)).toBe(false);
    expect(() => pageKey(Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});

describe("page.sock handshake", () => {
  let dir: string;
  let host: PageHost;
  const applied: (Snapshot | WindowClosed)[] = [];
  const warnings: string[] = [];
  const nullReader: ReaderLink = { run: async (v) => ({ type: "verbResult", v: 1, id: "r", at: 0, outcome: "noWindow", detail: v.kind }) };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-page-"));
    applied.length = 0;
    warnings.length = 0;
    host = pageHost({ path: join(dir, "page.sock"), secret: LAUNCH, reader: nullReader, apply: (m) => applied.push(m), warn: (l) => warnings.push(l) });
    await host.server.listen();
  });
  afterEach(async () => {
    await host.server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const LAUNCH = randomBytes(32);
  const secret = (): Buffer => pageKey(LAUNCH);

  async function bridge(key: Buffer = secret(), helperPid = process.pid): Promise<{ c: LineClient; welcome: Record<string, unknown> | null; nonce: string; challenge: string }> {
    const c = await LineClient.connect(join(dir, "page.sock"));
    const ch = await c.waitFor((m) => m.type === "engineChallenge");
    const challenge = ch.nonce as string;
    const nonce = newNonce();
    c.send({ type: "engineHello", v: 1, role: "page", browser, extensionId: X, bridgeVersion: "0.1.0", nonce, proof: bridgeProof(key, challenge, nonce, helperPid) });
    const welcome = await c.waitFor((m) => m.type === "engineWelcome", 1000).catch(() => null);
    return { c, welcome, nonce, challenge };
  }

  it("writes no key beside the socket, and removes one an earlier build left there (W3)", async () => {
    await host.server.close();
    writeFileSync(join(dir, "page.sock.key"), "an earlier build's key", { mode: 0o600 });
    host = pageHost({ path: join(dir, "page.sock"), secret: LAUNCH, reader: nullReader, apply: (m) => applied.push(m), warn: (l) => warnings.push(l) });
    await host.server.listen();
    expect(readdirSync(dir).sort()).toEqual(["page.sock"]);
    expect(statSync(join(dir, "page.sock")).mode & 0o777).toBe(0o600);
  });

  it("welcomes a bridge that holds the secret, proves itself back, and registers the engine at its hello", async () => {
    const { c, welcome, nonce, challenge } = await bridge();
    expect(welcome).not.toBeNull();
    // The proof is bound to the helper's pid, which the bridge checks against its socket's peer (LOCAL_PEERPID).
    expect(welcome?.pid).toBe(process.pid);
    expect(welcome?.proof).toBe(helperProof(secret(), challenge, nonce, process.pid));
    expect(secret().equals(pageKey(LAUNCH))).toBe(true);
    c.send({ type: "pageHello", v: 1, extensionId: X, version: "0.1.0", profile: "p", instance: "w1", startedAt: 1, capabilities: [] });
    const s = await host.registry.waitForEngine(() => true, 1000);
    expect(s.info.engine).toBe(welcome?.engine);
    expect(s.info.browser).toEqual(browser);
    c.s.destroy();
  });

  it("refuses a bridge with the wrong secret before sending it anything but the challenge", async () => {
    const { c, welcome } = await bridge(Buffer.alloc(32, 7));
    expect(welcome).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(c.received.map((m) => (m as { type: string }).type)).toEqual(["engineChallenge"]);
    expect(c.s.destroyed || c.s.readableEnded).toBe(true);
    expect(host.registry.list()).toHaveLength(0);
    expect([...host.server.refused.keys()]).toEqual(["the bridge's proof does not match this launch's key and this helper"]);
  });

  it("refuses a hello made for another process: a relay that took over the socket path cannot pass the host's hello on (W3 review #1)", async () => {
    // The host binds its proof to the pid it sees as its peer; behind a relay that is the relay, not this helper.
    const { c, welcome } = await bridge(secret(), process.pid + 1);
    expect(welcome).toBeNull();
    expect(host.registry.list()).toHaveLength(0);
    expect([...host.server.refused.keys()]).toEqual(["the bridge's proof does not match this launch's key and this helper"]);
    c.s.destroy();
  });

  it("refuses a peer whose first line is a page message, and one that says nothing", async () => {
    const c = await LineClient.connect(join(dir, "page.sock"));
    await c.waitFor((m) => m.type === "engineChallenge");
    c.send({ type: "pageHello", v: 1, extensionId: X, version: "0", profile: "p", instance: "w", startedAt: 1, capabilities: [] });
    await new Promise((r) => setTimeout(r, 50));
    expect(host.registry.list()).toHaveLength(0);
    expect(host.server.refused.get("first line is not a valid engineHello")).toBe(1);
  });

  it("ignores a pageHello for another extension than the bridge was launched for", async () => {
    const { c } = await bridge();
    c.send({ type: "pageHello", v: 1, extensionId: "a".repeat(32), version: "0.1.0", profile: "p", instance: "w1", startedAt: 1, capabilities: [] });
    await expect(host.registry.waitForEngine(() => true, 200)).rejects.toThrow();
    expect(warnings.some((w) => w.includes("the bridge was launched for"))).toBe(true);
    c.s.destroy();
  });

  it("closes the engine's windows in the model when the bridge goes, and its window ids then route nowhere", async () => {
    const { c, welcome } = await bridge();
    c.send({ type: "pageHello", v: 1, extensionId: X, version: "0.1.0", profile: "p", instance: "w1", startedAt: 1, capabilities: [] });
    const s = await host.registry.waitForEngine(() => true, 1000);
    c.onMessage = (m) => {
      const cmd = m as { type: string; id: string; verb: { kind: string } };
      if (cmd.type === "pageCommand" && cmd.verb.kind === "pageWalk") {
        c.send(snapshot(cmd.id));
        c.send({ type: "pageResult", v: 1, id: cmd.id, at: 2, outcome: "ok", detail: null });
      }
    };
    const windowId = `page:${welcome?.engine as string}:7`;
    const walked = await host.link.run({ kind: "walk", pid: 4100, windowId });
    expect(walked.outcome).toBe("ok");
    expect(applied.at(-1)).toMatchObject({ type: "snapshot", window: { windowId, kind: "page" }, app: browser });
    c.s.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(applied.at(-1)).toEqual(expect.objectContaining({ type: "windowClosed", windowId }));
    expect(s.closed).toBe(true);
    expect((await host.link.run({ kind: "walk", pid: 4100, windowId })).outcome).toBe("noWindow");
  });
});

describe("engine session and page link", () => {
  function rig(): { session: EngineSession; sent: HelperToEngine[]; link: PageEngineLink; applied: Snapshot[]; answer: (f: (m: HelperToEngine) => void) => void } {
    const sent: HelperToEngine[] = [];
    const applied: Snapshot[] = [];
    let responder: (m: HelperToEngine) => void = () => {};
    const session = new EngineSession({ engine: "eng1", browser, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => {
      sent.push(m);
      queueMicrotask(() => responder(m));
      return true;
    }, 200);
    const link = new PageEngineLink(session, (s) => applied.push(s));
    return { session, sent, link, applied, answer: (f) => (responder = f) };
  }

  const walker = (session: EngineSession, snap: (id: string) => PageSnapshot = (id) => snapshot(id)) => (m: HelperToEngine): void => {
    if (m.type !== "pageCommand") return;
    if (m.verb.kind === "pageWalk") session.receive(snap(m.id));
    session.receive({ type: "pageResult", v: 1, id: m.id, at: 1, outcome: "ok", detail: null });
  };

  it("turns a tab into one window: an AXWebArea per frame, controls under it, a select showing its selected label", () => {
    const { session } = rig();
    const s = toWindowSnapshot(snapshot("c"), session, 1);
    expect(s.window.windowId).toBe("page:eng1:7");
    expect(s.nodes.map((n) => [n.key, n.parent, n.role])).toEqual([
      ["f0", null, "AXWebArea"], ["f0/textbox:first name~0", "f0", "AXTextField"], ["f0/combobox:country~0", "f0", "AXPopUpButton"],
      // Its options as menu items, as fill reads a select's options (I2); the empty-valued placeholder is no choice.
      ["f0/combobox:country~0/option~1", "f0/combobox:country~0", "AXMenuItem"], ["f0/button:submit~0", "f0", "AXButton"],
      ["f4", "f0", "AXWebArea"], ["f4/textbox:referral~0", "f4", "AXTextField"],
    ]);
    // Its placeholder (value "") shows as no value, so fill counts the select unfilled (W4).
    expect(s.nodes.find((n) => n.key === "f0/combobox:country~0")?.value).toBe("");
    expect(s.focusedKey).toBe("f4/textbox:referral~0");
    expect(s.nodes.find((n) => n.key === "f0/textbox:first name~0")?.editable).toBe(true);
  });

  it("turns one ActGrant into a scoped grant per frame, each pinned to the frame's origin and navGen; revoke passes through", async () => {
    const { session, sent, link, answer } = rig();
    answer(walker(session));
    await link.run({ kind: "walk", pid: 4100, windowId: "page:eng1:7" });
    const g: ActGrant = { type: "actGrant", v: 1, taskId: "t1", pid: 4100, windowId: "page:eng1:7", at: 10, expires: 20 };
    link.grant(g);
    link.grant({ type: "actRevoke", v: 1, taskId: "t1", at: 30 });
    const grants = sent.filter((m) => m.type === "scopedActGrant" || m.type === "actRevoke");
    expect(grants).toEqual([
      { type: "scopedActGrant", v: 1, taskId: "t1", scope: { kind: "page", engine: "eng1", tabId: 7, frameId: 0, origin: "http://127.0.0.1:4310", navGen: 1 }, at: 10, expires: 20 },
      { type: "scopedActGrant", v: 1, taskId: "t1", scope: { kind: "page", engine: "eng1", tabId: 7, frameId: 4, origin: "http://127.0.0.1:4311", navGen: 2 }, at: 10, expires: 20 },
      expect.objectContaining({ type: "actRevoke", taskId: "t1" }),
    ]);
  });

  it("grants nothing for a tab it has not walked, or another engine's window", () => {
    const { sent, link } = rig();
    link.grant({ type: "actGrant", v: 1, taskId: "t1", pid: 4100, windowId: "page:eng1:7", at: 10, expires: 20 });
    link.grant({ type: "actGrant", v: 1, taskId: "t1", pid: 4100, windowId: "page:other:7", at: 10, expires: 20 });
    expect(sent).toEqual([]);
  });

  it("writes the element the walk named, by value for a select, then re-walks before answering", async () => {
    const { session, sent, link, applied, answer } = rig();
    answer(walker(session));
    await link.run({ kind: "walk", pid: 4100, windowId: "page:eng1:7" });
    const before = applied.length;
    const r = await link.run({ kind: "write", pid: 4100, windowId: "page:eng1:7", key: "f0/combobox:country~0", role: "AXPopUpButton", attribute: "value", expect: "", value: "Canada", taskId: "t1" });
    expect(r.outcome).toBe("ok");
    const verbs = sent.filter((m) => m.type === "pageCommand").map((m) => (m.type === "pageCommand" ? m.verb : null));
    expect(verbs[1]).toEqual({ kind: "pageSelect", tabId: 7, frameId: 0, documentId: "D0", id: "e2", control: "select", name: "Country", taskId: "t1", expect: "", value: "ca" });
    expect(verbs[2]).toEqual({ kind: "pageWalk", tabId: 7 });
    expect(applied.length).toBe(before + 1);
    const text = await link.run({ kind: "write", pid: 4100, windowId: "page:eng1:7", key: "f4/textbox:referral~0", role: "AXTextField", attribute: "value", expect: "x", value: "ABC", taskId: "t1" });
    expect(text.outcome).toBe("ok");
    expect(verbs.length).toBe(3);
    // A verified text write is not walked after (P2's deferred walk): it is the last command.
    const last = sent.filter((m) => m.type === "pageCommand").at(-1);
    expect(last?.type === "pageCommand" && last.verb).toMatchObject({ kind: "pageWrite", frameId: 4, documentId: "D4", id: "e1", expect: "x", value: "ABC" });
  });

  it("refuses a write without a task, a focus write, and a raise, without asking the engine", async () => {
    const { session, sent, link, answer } = rig();
    answer(walker(session));
    await link.run({ kind: "walk", pid: 4100, windowId: "page:eng1:7" });
    const n = sent.length;
    const verbs: ReaderVerb[] = [
      { kind: "write", pid: 4100, windowId: "page:eng1:7", key: "f0/textbox:first name~0", role: "AXTextField", attribute: "value", expect: "", value: "A" },
      { kind: "write", pid: 4100, windowId: "page:eng1:7", key: "f0/textbox:first name~0", role: "AXTextField", attribute: "focused", expect: "", value: "", taskId: "t" },
      { kind: "raise", pid: 4100, windowId: "page:eng1:7", taskId: "t" },
      { kind: "write", pid: 4100, windowId: "page:eng1:7", key: "f0/nope", role: "AXTextField", attribute: "value", expect: "", value: "A", taskId: "t" },
    ];
    const outs: VerbResult["outcome"][] = [];
    for (const v of verbs) outs.push((await link.run(v)).outcome);
    expect(outs).toEqual(["notAllowed", "axError", "notAllowed", "noElement"]);
    expect(sent.length).toBe(n);
  });

  it("maps page outcomes onto the reader's: stale is changed, a revert is changed, a different value left behind is axError", () => {
    const r = (outcome: string, readings?: object) => toVerbOutcome({ type: "pageResult", v: 1, id: "x", at: 1, outcome, detail: "d", ...(readings === undefined ? {} : { readings }), ...(outcome === "handoff" ? { risk: "outbound" } : {}) } as never).outcome;
    expect(r("ok")).toBe("ok");
    expect(r("alreadyTrue")).toBe("ok");
    expect(r("stale")).toBe("changed");
    expect(r("notAllowed")).toBe("notAllowed");
    expect(r("handoff")).toBe("notAllowed");
    expect(r("failed", { before: "a", afterInput: "b", afterBlur: "a", invalid: false, error: null })).toBe("changed");
    expect(r("failed", { before: "a", afterInput: "b", afterBlur: "c", invalid: false, error: null })).toBe("axError");
    expect(r("failed")).toBe("axError");
    expect(r("excluded")).toBe("secure");
  });

  it("fails a command the engine never answers, and every pending one when the engine closes", async () => {
    const { session } = rig();
    const late = await session.command({ kind: "pageWalk", tabId: 1 }, 30);
    expect(late.result).toMatchObject({ outcome: "error", detail: expect.stringContaining("no answer") });
    const pending = session.command({ kind: "pageWalk", tabId: 1 }, 5000);
    session.close();
    expect((await pending).result.outcome).toBe("error");
    expect((await session.command({ kind: "pageWalk", tabId: 1 })).result.detail).toBe("the engine is gone");
  });
});

describe("RoutedReaderLink", () => {
  it("sends page windows to their engine, everything else to the reader, and a revoke to both", async () => {
    const calls: string[] = [];
    const fake = (name: string): ReaderLink => ({
      run: async (v) => (calls.push(`${name} run ${v.kind}`), { type: "verbResult", v: 1, id: "x", at: 0, outcome: "ok", detail: null }),
      grant: (m) => void calls.push(`${name} ${m.type}`),
    });
    const reader = fake("reader");
    const engine = fake("engine");
    const link = new RoutedReaderLink(reader, { engineFor: (w) => (parsePageWindow(w)?.engine === "e1" ? engine : null), engines: () => [engine] });
    await link.run({ kind: "walk", pid: 1, windowId: "1-1" });
    await link.run({ kind: "walk", pid: 1, windowId: "page:e1:3" });
    await link.run({ kind: "watchInput", pids: [1] });
    expect((await link.run({ kind: "walk", pid: 1, windowId: "page:gone:3" })).outcome).toBe("noWindow");
    link.grant({ type: "actGrant", v: 1, taskId: "t", pid: 1, windowId: "page:e1:3", at: 0, expires: 1 });
    link.grant({ type: "actGrant", v: 1, taskId: "t", pid: 1, windowId: "1-1", at: 0, expires: 1 });
    link.grant({ type: "calendarGrant", v: 1, taskId: "t", at: 0, expires: 1 });
    link.grant({ type: "actRevoke", v: 1, taskId: "t", at: 2 });
    expect(calls).toEqual([
      "reader run walk", "engine run walk", "reader run watchInput",
      "engine actGrant", "reader actGrant", "reader calendarGrant", "reader actRevoke", "engine actRevoke",
    ]);
  });
});
