// H13: inline text in a page field, the helper's half. The host is told the text around the field's caret, whether the
// page offers its own suggestions there, and where the caret is on screen (pageField), but only a host that declared
// pageText; every other consumer gets the field without them. The host's pageInsert puts accepted text in through the
// page engine, under a grant for that one insert, and the reply says how it went without quoting the page.
// Every name and value is invented.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer, withoutPageText } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { ConsumerMessage, HelperMessage, PROTOCOL_VERSION, type ActGrant, type ActRevoke, type CalendarGrant, type HelperToEngine, type PageControl, type PageField, type PageSnapshot, type VerbResult } from "../src/protocol.ts";
import type { ReaderLink } from "../src/executor/means.ts";
import { EngineSession } from "../src/engines/session.ts";
import { pageHost } from "../src/engines/host.ts";
import { PageEngineLink } from "../src/engines/page-link.ts";
import { wirePageEngines } from "../src/engines/wire.ts";
import { X, chrome, hello as pageHello } from "./fake-page.ts";

const golden = readFileSync(new URL("../fixtures/golden/page-inline.ndjson", import.meta.url), "utf8").trim().split("\n");
const at = (i: number): Record<string, unknown> => JSON.parse(golden[i] as string) as Record<string, unknown>;
const CONSUMER = new Set(["hello", "pageInsert"]);

describe("the H13 golden lines (fixtures/golden/page-inline.ndjson), which the host decodes", () => {
  it("parses every line and writes it back byte for byte", () => {
    expect(golden.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(["hello", "pageField", "pageInsert", "pageInsertReply", "pageField", "pageInsert", "pageInsertReply", "pageField", "pageField"]);
    for (const l of golden) {
      const m = JSON.parse(l) as { type: string };
      expect(JSON.stringify((CONSUMER.has(m.type) ? ConsumerMessage : HelperMessage).parse(m)), m.type).toBe(l);
    }
  });

  it("refuses an insert longer than the text a walk reports, and an empty one, quoting neither in the refusal", () => {
    const insert = at(2);
    expect(ConsumerMessage.safeParse({ ...insert, text: "" }).success).toBe(false);
    const long = ConsumerMessage.safeParse({ ...insert, expect: "PAGETEXT".repeat(300) });
    expect(long.success).toBe(false);
    // The server logs and returns this message (server.ts reject): it must not carry the page's text.
    expect(long.success ? "" : long.error.message).not.toContain("PAGETEXT");
  });
});

// ---------------------------------------------------------------------------------------------------------------------

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
const hostHello = (pid: number, capabilities: string[], host = true) => ({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid, version: "test", ...(host ? { host: true } : {}), capabilities });

/** A page link that records grants and inserts, and answers each insert with `outcome`. */
function fakeLink(outcome: VerbResult["outcome"], extra: Partial<VerbResult> = {}) {
  const grants: (ActGrant | ActRevoke | CalendarGrant)[] = [];
  const inserts: { windowId: string; key: string; expect: string; text: string; taskId: string }[] = [];
  const link: ReaderLink = {
    run: async () => ({ type: "verbResult", v: 1, id: "r", at: 0, outcome: "ok", detail: null }),
    grant: (m) => void grants.push(m),
    insertText: async (windowId, key, expect, text, taskId) => {
      inserts.push({ windowId, key, expect, text, taskId });
      return { type: "verbResult", v: 1, id: "r", at: 0, outcome, detail: "'Cover letter' quoted here", ...extra };
    },
  };
  return { link, grants, inserts };
}

describe("page text on the socket (H13)", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let path: string;
  let fake: ReturnType<typeof fakeLink>;
  const warnings: string[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-inline-sock-"));
    path = join(dir, "screen.sock");
    store = new Store(join(dir, "data"));
    fake = fakeLink("ok");
    let s: HelperServer | null = null;
    helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, readerLink: fake.link, publish: (m) => s?.publish(m), warn: (l) => void warnings.push(l) });
    server = new HelperServer(path, () => helper, (l) => void warnings.push(l));
    s = server;
    await server.listen();
  });
  afterEach(async () => {
    helper.shutdown();
    await server.close();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    warnings.length = 0;
  });

  it("sends a page field's text and caret only to a host that declared pageText", async () => {
    const texted = await connect(path);
    const plain = await connect(path);
    const tool = await connect(path);
    send(texted.s, hostHello(1, ["pageText"]));
    send(plain.s, hostHello(2, []));
    // A consumer that is not the host cannot get the text by naming the capability.
    send(tool.s, hostHello(3, ["pageText"], false));
    await tick();
    server.publish(HelperMessage.parse(at(1)));
    await tick();
    const field = (c: { lines: Record<string, unknown>[] }) => c.lines.find((l) => l.type === "pageField");
    expect(field(texted)).toEqual(at(1));
    for (const c of [plain, tool]) {
      expect(field(c)).toEqual(withoutPageText(HelperMessage.parse(at(1)) as PageField));
      expect(JSON.stringify(field(c))).not.toContain("apply for the");
      expect(field(c)?.caret).toBeUndefined();
    }
    for (const c of [texted, plain, tool]) c.s.destroy();
  });

  it("takes pageInsert only from a host that declared pageText", async () => {
    const plain = await connect(path);
    send(plain.s, hostHello(2, []));
    await tick();
    send(plain.s, at(2));
    await tick();
    expect(plain.lines.filter((l) => l.type === "error").map((l) => String(l.message))).toEqual([expect.stringMatching(/pageInsert needs a host hello with "pageText"/)]);
    expect(fake.inserts).toEqual([]);
    plain.s.destroy();
  });

  it("inserts under a grant for that insert alone, revokes it, and answers the asker", async () => {
    const texted = await connect(path);
    send(texted.s, hostHello(1, ["pageText"]));
    await tick();
    send(texted.s, at(2));
    await tick();
    expect(fake.inserts).toEqual([{ windowId: "page:eng1:7", key: "f0/form[apply]/textarea:cover letter~0", expect: "I am writing to apply for the ", text: "Field Robotics Technician role", taskId: "inline-1" }]);
    expect(fake.grants.map((g) => [g.type, "taskId" in g ? g.taskId : null])).toEqual([["actGrant", "inline-1"], ["actRevoke", "inline-1"]]);
    const grant = fake.grants[0] as ActGrant;
    expect(grant.windowId).toBe("page:eng1:7");
    expect(grant.expires - grant.at).toBeLessThanOrEqual(5000);
    expect(texted.lines.find((l) => l.type === "pageInsertReply")).toMatchObject({ requestId: "inline-1", outcome: "inserted" });
    texted.s.destroy();
  });
});

describe("handlePageInsert (H13)", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-inline-"));
    store = new Store(join(dir, "data"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const insert = (): ConsumerMessage => ConsumerMessage.parse(at(2));
  const make = (fake: ReturnType<typeof fakeLink>, warn: string[] = []) => new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, readerLink: fake.link, publish: () => {}, warn: (l) => void warn.push(l) });

  // H13 review (P1/P2): refused is nothing written, checked before the write; failed is a write the page did not keep,
  // with the field reading as before; unverified is a field that changed but not to the insert, or an answer that
  // cannot say (a timeout, an error mid-way), which the host must not call "didn't take it".
  it("says refused before any write, failed when the field reads as before, unverified otherwise, quoting nothing from the page", async () => {
    const cases = [
      ["changed", {}, "refused"],
      ["notAllowed", {}, "refused"],
      ["noElement", {}, "refused"],
      ["changed", { insert: "unchanged" }, "failed"],
      ["axError", { insert: "unverified" }, "unverified"],
      ["axError", {}, "unverified"],
    ] as const;
    for (const [outcome, extra, said] of cases) {
      const fake = fakeLink(outcome, extra);
      const warn: string[] = [];
      const h = make(fake, warn);
      const r = await h.handlePageInsert(insert() as never);
      expect(r.outcome, `${outcome} ${JSON.stringify(extra)}`).toBe(said);
      expect(r.says).not.toContain("Cover letter");
      expect(warn.join("\n")).not.toMatch(/apply for the|Robotics/);
      expect(fake.grants.at(-1)?.type).toBe("actRevoke");
      h.shutdown();
      h.memory.close();
    }
  });

  it("inserts nothing while Caret is paused, or for a window that is not a page", async () => {
    const fake = fakeLink("ok");
    const h = make(fake);
    const settings = (paused: boolean) => ({ type: "settings" as const, v: PROTOCOL_VERSION as 1, at: 1, roles: ["fill" as const, "words" as const], level: "balanced" as const, paused });
    h.handleSettings(settings(true));
    expect((await h.handlePageInsert(insert() as never)).outcome).toBe("refused");
    h.handleSettings(settings(false));
    expect((await h.handlePageInsert({ ...(insert() as object), windowId: "4100-3" } as never)).outcome).toBe("refused");
    expect(fake.inserts).toEqual([]);
    expect(fake.grants).toEqual([]);
    h.shutdown();
    h.memory.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("the page field the host hears (H13)", () => {
  const VIEW: NonNullable<PageSnapshot["view"]> = { window: [100, 50, 800, 600], viewport: [800, 500], zoom: 1 };
  const area = { id: "e1", key: "form[apply]/textarea:cover letter~0", strongKey: null, kind: "textarea" as const, role: "textbox", name: "Cover letter", value: "I am writing", form: "form#apply", rect: [16, 40, 400, 120] as [number, number, number, number] };
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-inline-focus-"));
    store = new Store(join(dir, "data"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function build(focused: PageSnapshot["focused"], origin = "http://127.0.0.1:4310", path = "/apply", kind: "textarea" | "contenteditable" = "textarea") {
    const published: HelperMessage[] = [];
    let helper: Helper;
    const host = pageHost({ path: join(dir, "page.sock"), secret: randomBytes(32), reader: { run: async () => ({ type: "verbResult", v: 1, id: "r", at: 0, outcome: "ok", detail: null }) } as never, apply: (m) => void helper.handleReader(m), purge: (s) => helper.purgeWindow(s), warn: () => {} });
    helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, readerLink: host.link, pageCovers: (pid) => host.registry.forBrowser(pid) !== undefined, calendar: null, publish: (m) => published.push(m), warn: () => {} });
    wirePageEngines({ host, helper, publish: (m) => published.push(m), warn: () => {} });
    const snap = (id: string): PageSnapshot => ({
      type: "pageSnapshot", v: PROTOCOL_VERSION, id, at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply",
      frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin, path, navGen: 1, title: "Apply", headings: [], iframes: [], excluded: {}, truncated: false, controls: [{ ...area, kind }] }],
      missing: [], focused, view: VIEW,
    });
    let session: EngineSession;
    session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m: HelperToEngine) => {
      queueMicrotask(() => {
        if (m.type !== "pageCommand") return;
        if (m.verb.kind === "pageWalk") session.receive(snap(m.id));
        session.receive({ type: "pageResult", v: 1, id: m.id, at: 1, outcome: "ok", detail: null } as never);
      });
      return true;
    }, 500);
    host.registry.add(session);
    session.receive(pageHello);
    return { published, session, helper };
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const fields = (p: HelperMessage[]): PageField[] => p.filter((m): m is PageField => m.type === "pageField");

  it("carries the text around the caret, and the caret in screen points", async () => {
    const { published, session, helper } = build({ frameId: 0, id: "e1", selection: [12, 12], text: { before: "I am writing", after: "", selection: "" }, caret: [110, 50, 1, 18] });
    await settle();
    helper.handleReader({ type: "appSwitch", v: 1, at: 2, from: null, to: chrome });
    session.receive({ type: "pageFocus", v: 1, at: 3, tabId: 7, frameId: 0 });
    await settle();
    const f = fields(published).at(-1);
    expect(f).toMatchObject({ key: "f0/form[apply]/textarea:cover letter~0", text: { before: "I am writing", after: "", selection: "" }, ownSuggestions: null, docsText: null });
    // The viewport's top sits at the window's bottom less its height: 50 + 600 - 500 = 150 (page-link screenRect).
    expect(f?.caret).toEqual([210, 200, 1, 18]);
    // The walked element itself, which an insert must name (H13 review: a key survives a replaced field).
    expect(f?.token).toBe("0:D0:e1");
    // The host decides by the kind where inline text may show (one ⌘Z after typing behaves per kind).
    expect(f?.fieldKind).toBe("textarea");
    expect(HelperMessage.safeParse(f).success).toBe(true);
  });

  it("says when the field's document lost focus (the address bar), so the host offers nothing there", async () => {
    const { published, session, helper } = build({ frameId: 0, id: "e1", selection: [12, 12], text: { before: "I am writing", after: "", selection: "" }, caret: [110, 50, 1, 18], hasFocus: false });
    await settle();
    helper.handleReader({ type: "appSwitch", v: 1, at: 2, from: null, to: chrome });
    session.receive({ type: "pageFocus", v: 1, at: 3, tabId: 7, frameId: 0 });
    await settle();
    expect(fields(published).at(-1)?.pageFocused).toBe(false);
  });

  it("says Gmail's compose body offers its own suggestions", async () => {
    const { published, session, helper } = build({ frameId: 0, id: "e1", selection: [0, 0], text: { before: "Hi Gareth, ", after: "", selection: "" }, caret: null }, "https://mail.google.com", "/mail/u/0/", "contenteditable");
    await settle();
    helper.handleReader({ type: "appSwitch", v: 1, at: 2, from: null, to: chrome });
    session.receive({ type: "pageFocus", v: 1, at: 3, tabId: 7, frameId: 0 });
    await settle();
    const f = fields(published).at(-1);
    expect(f?.ownSuggestions).toBe("gmail");
    expect(f?.fieldKind).toBe("contenteditable");
    expect(f?.caret).toBeUndefined();
  });

  it("adds nothing for a field whose page said nothing about its text", async () => {
    const { published, session, helper } = build({ frameId: 0, id: "e1", selection: [0, 0] });
    await settle();
    helper.handleReader({ type: "appSwitch", v: 1, at: 2, from: null, to: chrome });
    session.receive({ type: "pageFocus", v: 1, at: 3, tabId: 7, frameId: 0 });
    await settle();
    const f = fields(published).at(-1);
    expect(f).toBeDefined();
    expect(Object.keys(f as object)).not.toContain("text");
    expect(Object.keys(f as object)).not.toContain("caret");
    expect(Object.keys(f as object)).not.toContain("fieldKind");
  });
});

describe("an insert names the element the offer was made for (H13 review)", () => {
  const CONTROLS: PageControl[] = [{ id: "e1", key: "form[a]/textarea:cover letter~0", strongKey: null, kind: "textarea", role: "textbox", name: "Cover letter", form: "form#a", rect: [0, 0, 100, 20], value: "" }];
  function snap(id: string): PageSnapshot {
    return {
      type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w", at: 1, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply",
      frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: "http://127.0.0.1:4310", path: "/apply", navGen: 1, title: "Apply", headings: [], controls: CONTROLS.map((c) => ({ ...c, id })), iframes: [], excluded: {}, truncated: false }],
      missing: [], focused: { frameId: 0, id, selection: [0, 0], text: { before: "", after: "", selection: "" } },
    };
  }
  it("refuses when the key now names a replacement element, and sends nothing to the page", async () => {
    const sent: HelperToEngine[] = [];
    const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => {
      sent.push(m);
      if (m.type === "pageCommand") queueMicrotask(() => session.receive({ type: "pageResult", v: 1, id: m.id, at: 1, outcome: "ok", detail: null }));
      return true;
    }, 200);
    session.receive(pageHello);
    // The offer was made for e1; the page has since replaced the field with e9 under the same label.
    session.tabs.set(7, snap("e9"));
    const link = new PageEngineLink(session, () => {});
    const key = "f0/form[a]/textarea:cover letter~0";
    expect((await link.insertText("page:eng1:7", key, "", "x", "t", "0:D0:e1")).outcome).toBe("changed");
    expect(sent.filter((m) => m.type === "pageCommand")).toEqual([]);
    expect((await link.insertText("page:eng1:7", key, "", "x", "t", "0:D0:e9")).outcome).toBe("ok");
  });
});
