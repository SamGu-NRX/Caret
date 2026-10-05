// W2: the helper's side of page controls. The confirmed-file rule for attaches, the combobox and attach verbs the page
// link builds, "Not on this site" reaching every engine, the host's presence signal, and page focus reaching the fill
// path while a covered browser's Accessibility focus does not. Every name, address and file here is invented.
import { mkdtempSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_ATTACH_BYTES, PROTOCOL_VERSION, type HelperMessage, type HelperToEngine, type PageEngineState, type PageSnapshot, type ReaderMessage, type Snapshot } from "../src/protocol.ts";
import { ConfirmedFiles } from "../src/engines/attach.ts";
import { EngineSession } from "../src/engines/session.ts";
import { PageEngineLink, toVerbOutcome } from "../src/engines/page-link.ts";
import { pageHost } from "../src/engines/host.ts";
import { BrowserPresence, isChromiumBrowser } from "../src/engines/presence.ts";
import { wirePageEngines } from "../src/engines/wire.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { SocketReaderLink } from "../src/executor/means.ts";
import type { AskJev } from "../src/fill/jev.ts";

const X = "kcmlnoabcdefghijklmnopabcdefghij";
const chrome = { pid: 4100, bundleId: "com.google.chrome.for.testing", name: "Google Chrome for Testing" };

function snapshot(id: string, opts: { focused?: string | null; tabId?: number } = {}): PageSnapshot {
  const focused = opts.focused === undefined ? "e2" : opts.focused;
  return {
    type: "pageSnapshot", v: PROTOCOL_VERSION, id, at: 1000, tabId: opts.tabId ?? 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply: Synthetic Role",
    frames: [{
      frameId: 0, parentFrameId: -1, documentId: "D0", origin: "http://127.0.0.1:4310", path: "/form", navGen: 1, title: "Apply: Synthetic Role", headings: ["Apply: Synthetic Role"], iframes: [], excluded: {}, truncated: false,
      controls: [
        { id: "e1", key: "form[apply]/textbox:first name~0", strongKey: null, kind: "text", role: "textbox", name: "First name", value: "", form: "form#apply", rect: [0, 0, 200, 20] },
        { id: "e2", key: "form[apply]/textbox:email~0", strongKey: null, kind: "email", role: "textbox", name: "Email", value: "", form: "form#apply", rect: [0, 30, 200, 20] },
        { id: "e3", key: "form[react-form]/combobox:country of residence~0", strongKey: null, kind: "combobox", role: "combobox", name: "Country of residence", value: "", form: "form#react-form", rect: [0, 60, 200, 20] },
        { id: "e4", key: "form[apply]/button:resume~0", strongKey: null, kind: "file", role: "button", name: "Resume", form: "form#apply", rect: [0, 90, 200, 20] },
      ],
    }],
    missing: [],
    focused: focused === null ? null : { frameId: 0, id: focused, selection: [0, 0] },
  };
}

/** A session whose engine answers walks with `snap` and every other command with `result`. */
function rig(result: (verb: HelperToEngine) => object = () => ({ outcome: "ok", detail: null }), snap: (id: string) => PageSnapshot = (id) => snapshot(id)) {
  const sent: HelperToEngine[] = [];
  const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => {
    sent.push(m);
    queueMicrotask(() => {
      if (m.type !== "pageCommand") return;
      if (m.verb.kind === "pageWalk") session.receive(snap(m.id));
      session.receive({ type: "pageResult", v: 1, id: m.id, at: 1, ...(m.verb.kind === "pageWalk" ? { outcome: "ok", detail: null } : result(m)) } as never);
    });
    return true;
  }, 500);
  return { session, sent };
}
const hello = { type: "pageHello" as const, v: 1 as const, extensionId: X, version: "0.1.0", profile: "p", instance: "w", startedAt: 1, capabilities: [] };
const commands = (sent: HelperToEngine[]) => sent.flatMap((m) => (m.type === "pageCommand" ? [m.verb] : []));

describe("confirmed files", () => {
  /** The one field each confirmation here is for. */
  const T = ConfirmedFiles.target("page:eng1:7", "f0/form[apply]/button:resume~0");
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "caret-attach-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, bytes: Buffer): string => {
    const p = join(dir, name);
    writeFileSync(p, bytes);
    return p;
  };

  it("reads the confirmed file once, as the user named it, with its digest and bytes", () => {
    const bytes = Buffer.from("%PDF-1.4\nsynthetic resume\n");
    const files = new ConfirmedFiles();
    expect(files.confirm("t1", file("Robin Resume.pdf", bytes), T)).toEqual({ ok: true });
    const got = files.read("t1", T);
    expect(got).toEqual({ name: "Robin Resume.pdf", type: "application/pdf", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), data: bytes.toString("base64") });
    expect(files.read("t1", T)).toEqual({ refused: "no file was confirmed for task t1" });
  });

  it("refuses without a confirmation, for another task, after the grant's lifetime, and when the file changed", () => {
    let now = 0;
    const files = new ConfirmedFiles(() => now);
    const p = file("cv.docx", Buffer.from("one"));
    expect(files.read("t1", T)).toEqual({ refused: "no file was confirmed for task t1" });
    files.confirm("t1", p, T);
    expect(files.read("t2", T)).toEqual({ refused: "no file was confirmed for task t2" });
    now = 120_001;
    expect(files.read("t1", T)).toEqual({ refused: "the confirmation of the file expired" });
    now = 0;
    files.confirm("t1", p, T);
    writeFileSync(p, "two!");
    expect(files.read("t1", T)).toEqual({ refused: "the file changed after you confirmed it" });
    files.confirm("t1", p, T);
    utimesSync(p, new Date(1_000_000), new Date(1_000_000));
    expect(files.read("t1", T)).toEqual({ refused: "the file changed after you confirmed it" });
  });

  it("refuses another file put at the path, and the same file with other bytes, even with size and time kept", () => {
    const files = new ConfirmedFiles();
    const p = file("cv.pdf", Buffer.from("aaaa"));
    const t = statSync(p).mtime;
    files.confirm("t1", p, T);
    const swap = file("swap.pdf", Buffer.from("bbbb"));
    utimesSync(swap, t, t);
    renameSync(swap, p);
    expect(files.read("t1", T)).toEqual({ refused: "the file changed after you confirmed it" });
    files.confirm("t2", p, T);
    writeFileSync(p, "cccc");
    utimesSync(p, t, t);
    expect(files.read("t2", T)).toEqual({ refused: "the file changed after you confirmed it" });
  });

  it("refuses a relative path, a directory, a file over the cap, and a symlink planted after the confirmation", () => {
    const files = new ConfirmedFiles();
    expect(files.confirm("t", "cv.pdf", T)).toEqual({ refused: "the confirmed file has no absolute path" });
    expect(files.confirm("t", dir, T)).toEqual({ refused: "the confirmed path is not a file" });
    const big = join(dir, "big.pdf");
    writeFileSync(big, Buffer.alloc(MAX_ATTACH_BYTES + 1));
    expect(files.confirm("t", big, T)).toMatchObject({ refused: expect.stringContaining("Caret attaches files up to") });
    const p = file("cv.pdf", Buffer.from("cv"));
    files.confirm("t", p, T);
    unlinkSync(p);
    symlinkSync(file("secret.txt", Buffer.from("cv")), p);
    expect(files.read("t", T)).toEqual({ refused: "the confirmed file cannot be opened" });
  });

  it("gives the file only to the field it was confirmed for (H5 review #1)", () => {
    const files = new ConfirmedFiles();
    const p = join(dir, "cv.pdf");
    writeFileSync(p, "abc");
    files.confirm("t1", p, T);
    expect(files.read("t1", ConfirmedFiles.target("page:eng1:7", "f0/form[apply]/textbox:email~0"))).toEqual({ refused: "the file was confirmed for another field" });
    // The refusal used the confirmation up: the run gets one try.
    expect(files.read("t1", T)).toEqual({ refused: "no file was confirmed for task t1" });
  });

  it("refuses a FIFO at once instead of waiting on it", () => {
    const fifo = join(dir, "resume.pdf");
    execFileSync("mkfifo", [fifo]);
    expect(new ConfirmedFiles().confirm("t", fifo, T)).toEqual({ refused: "the confirmed path is not a file" });
  });

  it("follows an alias at confirmation and gives the page the name the user saw", () => {
    const real = file("Resume-final-v3.pdf", Buffer.from("cv"));
    const alias = join(dir, "Resume.pdf");
    symlinkSync(real, alias);
    const files = new ConfirmedFiles();
    files.confirm("t", alias, T);
    expect(files.read("t", T)).toMatchObject({ name: "Resume.pdf", size: 2 });
  });
});

describe("page link: combobox and attach", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "caret-attach-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a combobox by picking the option named the value, and shows it as an editable field", async () => {
    const { session, sent } = rig();
    const applied: Snapshot[] = [];
    const link = new PageEngineLink(session, (s) => applied.push(s));
    await link.run({ kind: "walk", pid: 4100, windowId: "page:eng1:7" });
    expect(applied[0]?.nodes.find((n) => n.label === "Country of residence")).toMatchObject({ role: "AXComboBox", editable: true, value: "" });
    const r = await link.run({ kind: "write", pid: 4100, windowId: "page:eng1:7", key: "f0/form[react-form]/combobox:country of residence~0", role: "AXComboBox", attribute: "value", expect: "", value: "United States", taskId: "t1" });
    expect(r.outcome).toBe("ok");
    expect(commands(sent)[1]).toEqual({ kind: "pageChooseOption", tabId: 7, frameId: 0, documentId: "D0", id: "e3", control: "combobox", name: "Country of residence", taskId: "t1", expect: "", value: "United States" });
    // The pick waits for the page, so its command lives longer than a write's.
    const cmd = sent.find((m) => m.type === "pageCommand" && m.verb.kind === "pageChooseOption");
    expect(cmd?.type === "pageCommand" && cmd.expires - Date.now()).toBeGreaterThan(5000);
  });

  it("attaches only the file confirmed for the task, and asks the engine nothing without one", async () => {
    const { session, sent } = rig(() => ({ outcome: "ok", detail: null, attached: { via: "input", file: { name: "cv.pdf", size: 3 }, shown: true } }));
    const link = new PageEngineLink(session, () => {});
    await link.run({ kind: "walk", pid: 4100, windowId: "page:eng1:7" });
    const files = new ConfirmedFiles();
    const key = "f0/form[apply]/button:resume~0";
    const none = await link.attachFile("page:eng1:7", key, "t1", files);
    expect(none.verb.outcome).toBe("notAllowed");
    expect(commands(sent).filter((v) => v.kind === "pageAttachFile")).toEqual([]);
    const p = join(dir, "cv.pdf");
    writeFileSync(p, "abc");
    files.confirm("t1", p, ConfirmedFiles.target("page:eng1:7", key));
    const done = await link.attachFile("page:eng1:7", key, "t1", files);
    expect(done.verb.outcome).toBe("ok");
    expect(done.page?.attached).toEqual({ via: "input", file: { name: "cv.pdf", size: 3 }, shown: true });
    expect(commands(sent).find((v) => v.kind === "pageAttachFile")).toMatchObject({ id: "e4", control: "file", taskId: "t1", file: { name: "cv.pdf", size: 3, data: "YWJj" } });
    // Used once.
    expect((await link.attachFile("page:eng1:7", key, "t1", files)).verb.outcome).toBe("notAllowed");
  });

  it("sends no file to a control that is not a file input or a dropzone, and keeps the confirmation", async () => {
    const { session, sent } = rig();
    const link = new PageEngineLink(session, () => {});
    await link.run({ kind: "walk", pid: 4100, windowId: "page:eng1:7" });
    const files = new ConfirmedFiles();
    const p = join(dir, "cv.pdf");
    writeFileSync(p, "abc");
    const email = "f0/form[apply]/textbox:email~0";
    files.confirm("t1", p, ConfirmedFiles.target("page:eng1:7", email));
    const r = await link.attachFile("page:eng1:7", email, "t1", files);
    expect(r.verb.outcome).toBe("axError");
    expect(commands(sent).filter((v) => v.kind === "pageAttachFile")).toEqual([]);
    expect(files.read("t1", ConfirmedFiles.target("page:eng1:7", email))).toMatchObject({ name: "cv.pdf" });
  });

  it("reads siteOff as not allowed", () => {
    expect(toVerbOutcome({ type: "pageResult", v: 1, id: "x", at: 1, outcome: "siteOff", detail: "Caret is off on http://127.0.0.1:4310" }).outcome).toBe("notAllowed");
  });
});

describe("page link: undo writes only the element its write went to (B23 on pages)", () => {
  const email = "f0/form[apply]/textbox:email~0";
  const write = (extra: { mark?: string; sameAs?: string }, value = "robin@example.test", expect = "") =>
    ({ kind: "write" as const, pid: 4100, windowId: "page:eng1:7", key: email, role: "AXTextField", attribute: "value" as const, expect, value, taskId: "t1", ...extra });

  it("restores under the mark its write recorded", async () => {
    const { session, sent } = rig();
    const link = new PageEngineLink(session, () => {});
    await link.run({ kind: "walk", pid: 4100, windowId: "page:eng1:7" });
    expect((await link.run(write({ mark: "m1" }))).outcome).toBe("ok");
    expect((await link.run(write({ sameAs: "m1" }, "", "robin@example.test"))).outcome).toBe("ok");
    expect(commands(sent).filter((v) => v.kind === "pageWrite")).toHaveLength(2);
  });

  it("refuses an undo whose mark it never recorded, and sends the page nothing", async () => {
    const { session, sent } = rig();
    const link = new PageEngineLink(session, () => {});
    await link.run({ kind: "walk", pid: 4100, windowId: "page:eng1:7" });
    const r = await link.run(write({ sameAs: "m-from-before-a-restart" }, "", "robin@example.test"));
    expect(r.outcome).toBe("notSameElement");
    expect(commands(sent).filter((v) => v.kind === "pageWrite")).toEqual([]);
  });

  it("refuses an undo when the key is now in another document; another registry id goes to the page, which checks the object under the mark (W3)", async () => {
    const changes: { id: string; documentId: string; sent: number }[] = [{ id: "e9", documentId: "D0", sent: 2 }, { id: "e2", documentId: "D1", sent: 1 }];
    for (const change of changes) {
      let walks = 0;
      const { session, sent } = rig(undefined, (id) => {
        const s = snapshot(id);
        if (++walks <= 2) return s;
        const f = s.frames[0]!;
        const controls = f.controls.map((c) => (c.id === "e2" ? { ...c, id: change.id } : c));
        return { ...s, frames: [{ ...f, controls, documentId: change.documentId }] };
      });
      const link = new PageEngineLink(session, () => {});
      await link.run({ kind: "walk", pid: 4100, windowId: "page:eng1:7" });
      expect((await link.run(write({ mark: "m1" }))).outcome).toBe("ok");
      await link.run({ kind: "walk", pid: 4100, windowId: "page:eng1:7" });
      const r = await link.run(write({ sameAs: "m1" }, "", "robin@example.test"));
      expect(commands(sent).filter((v) => v.kind === "pageWrite"), JSON.stringify(change)).toHaveLength(change.sent);
      if (change.sent === 1) expect(r.outcome, JSON.stringify(change)).toBe("notSameElement");
      else expect(commands(sent).filter((v) => v.kind === "pageWrite").at(-1)).toMatchObject({ id: "e9", sameAs: "m1", rebind: false });
    }
  });
});

describe("Not on this site", () => {
  it("reaches each engine after its hello and on every change, as the whole list", async () => {
    const host = pageHost({ path: "/nonexistent/page.sock", secret: randomBytes(32), reader: { run: async () => ({ type: "verbResult", v: 1, id: "r", at: 0, outcome: "noWindow", detail: null }) }, apply: () => {}, warn: () => {} });
    host.registry.setSitesOff(["https://jobs.example.test", "http://127.0.0.1:4310", "https://jobs.example.test"]);
    const { session, sent } = rig();
    host.registry.add(session);
    expect(sent).toEqual([]);
    session.receive(hello);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([{ type: "pageSitesOff", v: 1, origins: ["http://127.0.0.1:4310", "https://jobs.example.test"] }]);
    host.registry.setSitesOff([]);
    expect(sent.at(-1)).toEqual({ type: "pageSitesOff", v: 1, origins: [] });
    expect(host.registry.forBrowser(4100)).toBe(session);
    expect(host.registry.forBrowser(4101)).toBeUndefined();
  });
});

describe("presence: Caret can't see this page yet", () => {
  const chromeApp = { pid: 6100, bundleId: "com.google.Chrome", name: "Google Chrome" };
  const focus = (app: typeof chromeApp, editable: boolean): ReaderMessage => ({ type: "focus", v: 1, at: 1, app, windowId: `${app.pid}-1`, key: "k", role: "AXTextField", editable, empty: true, frontmost: true });

  it("says missing once when the user types in a frontmost Chromium browser with no engine, and connected when one comes", () => {
    const said: PageEngineState[] = [];
    const engines = new Set<number>();
    const p = new BrowserPresence({ publish: (m) => said.push(m), hasEngine: (pid) => engines.has(pid), now: () => 5 });
    p.onReader({ type: "appSwitch", v: 1, at: 1, from: null, to: chromeApp });
    expect(said).toEqual([]);
    p.onReader(focus(chromeApp, false));
    expect(said).toEqual([]);
    p.onReader(focus(chromeApp, true));
    p.onReader(focus(chromeApp, true));
    p.onReader({ type: "userInput", v: 1, at: 2, pid: 6100, kind: "key", point: null });
    expect(said).toEqual([{ type: "pageEngine", v: 1, at: 5, browser: chromeApp, state: "missing" }]);
    engines.add(6100);
    p.engineConnected(chromeApp);
    expect(said.map((m) => m.state)).toEqual(["missing", "connected"]);
    p.onReader(focus(chromeApp, true));
    expect(said.length).toBe(2);
  });

  it("says nothing for an app that is not a Chromium browser, for a browser with an engine, or before any typing", () => {
    const said: PageEngineState[] = [];
    const p = new BrowserPresence({ publish: (m) => said.push(m), hasEngine: (pid) => pid === 4100 });
    p.onReader(focus({ pid: 7000, bundleId: "com.apple.Safari", name: "Safari" }, true));
    p.onReader(focus({ pid: 4100, bundleId: "com.google.chrome.for.testing", name: "Chrome for Testing" }, true));
    p.onReader({ type: "appSwitch", v: 1, at: 1, from: null, to: { pid: 6200, bundleId: "net.imput.helium", name: "Helium" } });
    expect(said).toEqual([]);
    expect(["com.google.Chrome.canary", "net.imput.helium", "com.brave.Browser", "com.microsoft.edgemac.Dev"].every(isChromiumBrowser)).toBe(true);
    expect(["com.apple.Safari", "com.google.Chromecast", "org.mozilla.firefox", "com.tinyspeck.slackmacgap"].some(isChromiumBrowser)).toBe(false);
  });
});

describe("page focus into the fill path", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-w2-"));
    store = new Store(join(dir, "data"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Picks the About email wherever a question offers it and says the field is the user's; none elsewhere. */
  const canned: AskJev = async (req) => ({
    model: "canned",
    answers: Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        if (id.endsWith("_whose")) return [id, { choice: "user", confidence: 0.95 }];
        const pick = Object.entries(q.criteria).find(([, text]) => text?.includes('"robin@example.test"'))?.[0];
        return [id, pick === undefined ? { choice: "none", confidence: 0.9 } : { choice: pick, confidence: 0.95 }];
      }),
    ),
    inputTokens: 0,
    latencyMs: 0,
    costUsd: 0,
  });

  function build(): { helper: Helper; published: HelperMessage[]; session: EngineSession; sent: HelperToEngine[]; readerSent: unknown[]; readerSocket: SocketReaderLink } {
    const published: HelperMessage[] = [];
    const readerSent: unknown[] = [];
    const readerSocket = new SocketReaderLink((m) => (readerSent.push(m), true), 500);
    let helper: Helper;
    const host = pageHost({ path: join(dir, "page.sock"), secret: randomBytes(32), reader: readerSocket, apply: (m) => void helper.handleReader(m), warn: () => {} });
    helper = new Helper({ store, askJev: canned, shadow: false, allowBackgroundFocus: false, readerLink: host.link, readerAnswers: readerSocket, pageCovers: (pid) => host.registry.forBrowser(pid) !== undefined, calendar: null, publish: (m) => published.push(m), warn: () => {} });
    wirePageEngines({ host, helper, publish: (m) => published.push(m), warn: () => {} });
    const { session, sent } = rig();
    host.registry.add(session);
    session.receive(hello);
    helper.handleMemory({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "a", op: "add", kind: "about", fields: { label: "Email", value: "robin@example.test", source: "typed" } });
    return { helper, published, session, sent, readerSent, readerSocket };
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
  };

  it("walks the tab when focus moves in the frontmost browser and asks for a fill of the page window's focused field", async () => {
    const { helper, published, session, sent } = build();
    await settle();
    expect(published.filter((m) => m.type === "pageEngine")).toEqual([expect.objectContaining({ state: "connected", browser: chrome })]);
    // Not frontmost: the report is ignored, nothing is walked.
    session.receive({ type: "pageFocus", v: 1, at: 1, tabId: 7, frameId: 0 });
    await settle();
    expect(commands(sent)).toEqual([]);
    helper.handleReader({ type: "appSwitch", v: 1, at: 2, from: null, to: chrome });
    session.receive({ type: "pageFocus", v: 1, at: 3, tabId: 7, frameId: 0 });
    await settle();
    expect(commands(sent)).toEqual([{ kind: "pageWalk", tabId: 7 }]);
    const fills = published.filter((m) => m.type === "fillProposal" || m.type === "popup");
    expect(fills.length).toBe(1);
    const p = fills[0];
    if (p?.type === "fillProposal") {
      expect(p.windowId).toBe("page:eng1:7");
      expect(p.fields.find((f) => f.key === "f0/form[apply]/textbox:email~0")?.value).toBe("robin@example.test");
    } else {
      expect(JSON.stringify(p)).toContain("robin@example.test");
      expect(JSON.stringify(p)).toContain("page:eng1:7");
    }
  });

  it("asks no fill from Accessibility's view of a browser that has a page engine", async () => {
    const { helper, published } = build();
    await settle();
    helper.handleReader({ type: "snapshot", v: 1, seq: 1, at: 1, reason: "focus", app: chrome, window: { windowId: "4100-1", kind: "standard", title: "Apply", frame: null }, focused: true, root: null, nodes: [{ key: "a/email", parent: null, role: "AXTextField", label: "Email", value: "", editable: true }], values: [], focusedKey: "a/email", stats: { walkMs: 0, visited: 1, truncated: false } });
    const p = helper.handleReader({ type: "focus", v: 1, at: 2, app: chrome, windowId: "4100-1", key: "a/email", role: "AXTextField", editable: true, empty: true, frontmost: true });
    expect(p).toBeNull();
    await settle();
    expect(published.filter((m) => m.type === "fillProposal" || m.type === "popup")).toEqual([]);
  });

  it("answers the reader's verbResults through the reader's link inside the routed one (W1 note)", async () => {
    const { helper, readerSent } = build();
    const pending = helper.readerVerb({ kind: "walk", pid: 5150, windowId: "5150-1" });
    const cmd = readerSent[0] as { id: string };
    expect(cmd).toMatchObject({ type: "readerCommand", verb: { kind: "walk", windowId: "5150-1" } });
    helper.handleReader({ type: "verbResult", v: 1, id: cmd.id, at: 1, outcome: "ok", detail: null });
    expect((await pending).outcome).toBe("ok");
    // And a reader counts as connected only once it says hello.
    expect(helper.hasReader).toBe(false);
  });
});
