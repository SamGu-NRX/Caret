// P4: the worker's read of the tab the user just left, driven through its real listeners with a fake `chrome`: which
// tab it reads, which frames it asks for text (never a hidden one, never one on an excluded site), what it rechecks
// before asking, and that a tab on the deny list is never walked. The content scripts' halves run in a real
// browser in fixtures/web-form/tests/tab-text.test.ts and the journey (tab-source-journey.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/shared/sha256.ts";
import { fakeChrome, settle, type Frame } from "./fake-chrome.ts";
import { deniedOrigin } from "../src/worker/left-tab.ts";

const MAIL = "https://mail.example.test";
const self = (origin: string, viewport: [number, number], iframes: { src: string; rect: number[]; inner: [number, number] }[] = []) => ({ origin, viewport, iframes });
const text = (blocks: string[]) => ({ selection: [], blocks, cut: false, docsText: null, title: "" });

let f: ReturnType<typeof fakeChrome>;

/** Loads the real worker against a fresh fake, says the engine is ready, and commits tab 1's frames as `frames` gives them. */
async function start(tab1: Frame[]): Promise<void> {
  f = fakeChrome();
  vi.stubGlobal("chrome", f.chrome);
  vi.resetModules();
  f.frames.set(1, tab1);
  f.frames.set(2, [{ frameId: 0, parentFrameId: -1, documentId: "FORM", url: "http://127.0.0.1:4310/apply" }]);
  await import("../src/worker.ts");
  await settle();
  await f.fire("port.message", { type: "engineReady", v: 1, engine: "e1" });
  for (const fr of tab1) await f.fire("nav.committed", { tabId: 1, frameId: fr.frameId, documentId: fr.documentId });
  await f.fire("nav.committed", { tabId: 2, frameId: 0, documentId: "FORM" });
  await settle();
}

/** The user switches from tab 1 (the mail) to tab 2 (the form) in window 9. */
async function leaveMail(): Promise<void> {
  f.state.active.set(9, 2);
  await f.fire("tabs.activated", { tabId: 2, windowId: 9 });
}

async function read(tabId: number): Promise<Record<string, unknown>> {
  const id = `r${Math.random()}`;
  await f.fire("port.message", { type: "pageReadText", v: 1, id, expires: Date.now() + 5000, tabId });
  for (let i = 0; i < 50; i++) {
    const r = f.sentToHelper.find((m) => m.type === "pageResult" && m.id === id);
    if (r !== undefined) return r;
    await settle();
  }
  throw new Error("no pageResult");
}

const MAIL_FRAMES: Frame[] = [
  { frameId: 0, parentFrameId: -1, documentId: "D0", url: `${MAIL}/inbox` },
  { frameId: 4, parentFrameId: 0, documentId: "D4", url: `${MAIL}/message` },
  { frameId: 5, parentFrameId: 0, documentId: "D5", url: `${MAIL}/hidden` },
];

describe("the worker's read of the tab the user just left", () => {
  beforeEach(async () => {
    await start(MAIL_FRAMES);
    // The top frame shows one visible iframe (the message); frame 5 is in an iframe hidden with display:none.
    f.answers.set("1:0:frame", self(MAIL, [1280, 900], [{ src: `${MAIL}/message`, rect: [0, 100, 800, 400], inner: [800, 400] }]));
    f.answers.set("1:4:frame", self(MAIL, [800, 400]));
    f.answers.set("1:5:frame", self(MAIL, [0, 0]));
    f.answers.set("1:0:text", text(["Inbox"]));
    f.answers.set("1:4:text", text(["First name: Ines"]));
    f.answers.set("1:5:text", text(["Cell: 555-0100"]));
  });

  it("reads the tab left, asks a hidden frame about itself only and never for its text", async () => {
    await leaveMail();
    const r = await read(1);
    expect(r.outcome).toBe("ok");
    expect((r.text as { blocks: string[] }).blocks).toEqual(["Inbox", "First name: Ines"]);
    expect(f.asked.filter((a) => a.op === "text").map((a) => a.frameId).sort()).toEqual([0, 4]);
    // Each text message carries the moment past which the frame gives none (rule 2).
    expect(f.asked.find((a) => a.op === "text")?.msg.until).toEqual(expect.any(Number));
  });

  it("never reads the tab the user is in, or a tab before the user left one", async () => {
    expect((await read(1)).outcome).toBe("notAllowed");
    await leaveMail();
    expect((await read(2)).outcome).toBe("notAllowed");
    expect(f.asked).toEqual([]);
  });

  it("asks no frame for text when the user comes back to the tab while its frames answer (P4 second review)", async () => {
    await leaveMail();
    f.setDuring((op) => {
      if (op !== "frame") return;
      f.state.active.set(9, 1);
      void f.fire("tabs.activated", { tabId: 1, windowId: 9 });
    });
    const r = await read(1);
    expect(r.outcome).toBe("stale");
    expect(f.asked.filter((a) => a.op === "text")).toEqual([]);
  });

  it("asks no frame for text when the site is turned off while its frames answer (P4 second review)", async () => {
    await leaveMail();
    f.setDuring((op) => {
      if (op === "frame") void f.fire("port.message", { type: "pageSitesOff", v: 1, origins: [MAIL] });
    });
    const r = await read(1);
    expect(r.outcome).toBe("siteOff");
    expect(f.asked.filter((a) => a.op === "text")).toEqual([]);
  });

  it("never reads a frame that committed or appeared after the user left, nor the tab once its top frame navigated", async () => {
    await leaveMail();
    f.frames.set(1, [...MAIL_FRAMES, { frameId: 6, parentFrameId: 0, documentId: "D6", url: `${MAIL}/late` }]);
    await f.fire("nav.committed", { tabId: 1, frameId: 6, documentId: "D6" });
    await read(1);
    expect(f.asked.some((a) => a.frameId === 6)).toBe(false);
    // A frame that appears with no commit (an initial about:blank) is in no record of the tab as the user left it.
    f.frames.set(1, [...MAIL_FRAMES, { frameId: 7, parentFrameId: 0, documentId: "D7", url: "about:blank" }]);
    f.answers.set("1:0:frame", self(MAIL, [1280, 900], [{ src: `${MAIL}/message`, rect: [0, 100, 800, 400], inner: [800, 400] }, { src: "about:", rect: [0, 600, 300, 100], inner: [300, 100] }]));
    f.answers.set("1:7:frame", self(MAIL, [300, 100]));
    f.answers.set("1:7:text", text(["Cell: 555-0101"]));
    const late = await read(1);
    expect(f.asked.some((a) => a.frameId === 7)).toBe(false);
    expect((late.text as { blocks: string[] }).blocks.join("\n")).not.toContain("555-0101");
    await f.fire("nav.committed", { tabId: 1, frameId: 0, documentId: "D0b" });
    f.frames.set(1, [{ ...MAIL_FRAMES[0] as Frame, documentId: "D0b" }]);
    expect((await read(1)).outcome).toBe("notAllowed");
  });

  it("never reads a tab on the deny list", async () => {
    await start([{ frameId: 0, parentFrameId: -1, documentId: "V0", url: "https://vault.bitwarden.com/#/vault" }]);
    await leaveMail();
    expect((await read(1)).outcome).toBe("siteOff");
    expect(f.asked).toEqual([]);
  });

  it("refuses a walk of a tab on the deny list with siteOff, asking no frame and sending no page text, label or value", async () => {
    await start([
      { frameId: 0, parentFrameId: -1, documentId: "V0", url: "https://accounts.google.com/signin" },
      { frameId: 3, parentFrameId: 0, documentId: "V3", url: "https://forms.example.test/embed" },
    ]);
    f.answers.set("1:0:walk", { origin: "https://accounts.google.com", path: "/signin", title: "Sign in - Synthetic", headings: ["Choose an account"], controls: [{ id: "e1", key: "k", strongKey: null, kind: "email", role: "textbox", name: "Email or phone", value: "ines@example.test", form: null, rect: [0, 0, 10, 10] }], iframes: [], viewport: [1280, 900], excluded: {}, truncated: false, focused: { id: "e1", selection: [0, 0], text: { before: "ines@", after: "", selection: "" }, caret: [10, 10, 1, 16] }, hasFocus: true, walkMs: 1 });
    await f.fire("port.message", { type: "pageCommand", v: 1, id: "w1", expires: Date.now() + 5000, verb: { kind: "pageWalk", tabId: 1 } });
    for (let i = 0; i < 20 && !f.sentToHelper.some((m) => m.type === "pageResult"); i++) await settle();
    const r = f.sentToHelper.find((m) => m.type === "pageResult" && m.id === "w1");
    expect(r?.outcome).toBe("siteOff");
    expect(f.asked).toEqual([]);
    expect(f.sentToHelper.some((m) => m.type === "pageSnapshot")).toBe(false);
    const sent = JSON.stringify(f.sentToHelper);
    for (const planted of ["Sign in - Synthetic", "Choose an account", "Email or phone", "ines@example.test", "ines@"]) expect(sent).not.toContain(planted);
  });

  it("never asks a child frame on the deny list, and walks the rest of the tab", async () => {
    await start([
      { frameId: 0, parentFrameId: -1, documentId: "P0", url: "https://shop.example.test/checkout" },
      { frameId: 2, parentFrameId: 0, documentId: "P2", url: "https://vault.bitwarden.com/#/vault" },
    ]);
    f.answers.set("1:0:walk", { origin: "https://shop.example.test", path: "/checkout", title: "Checkout", headings: [], controls: [], iframes: [], viewport: [1280, 900], excluded: {}, truncated: false, focused: null, hasFocus: true, walkMs: 1 });
    f.answers.set("1:2:walk", { origin: "https://vault.bitwarden.com", path: "/", title: "Vault", headings: ["Logins"], controls: [], iframes: [], viewport: [400, 300], excluded: {}, truncated: false, focused: null, hasFocus: false, walkMs: 1 });
    await f.fire("port.message", { type: "pageCommand", v: 1, id: "w2", expires: Date.now() + 5000, verb: { kind: "pageWalk", tabId: 1 } });
    for (let i = 0; i < 20 && !f.sentToHelper.some((m) => m.type === "pageSnapshot"); i++) await settle();
    expect(f.asked.map((a) => a.frameId)).toEqual([0]);
    const snap = f.sentToHelper.find((m) => m.type === "pageSnapshot") as { frames: { frameId: number }[]; missing: { frameId: number; reason: string }[] } | undefined;
    expect(snap?.frames.map((x) => x.frameId)).toEqual([0]);
    expect(snap?.missing).toContainEqual({ frameId: 2, reason: "Caret never reads this site" });
    expect(JSON.stringify(f.sentToHelper)).not.toContain("Logins");
  });
});

/** Asks the worker to walk tab 1 and waits for its pageResult. */
async function walkTab(id: string): Promise<Record<string, unknown>> {
  await f.fire("port.message", { type: "pageCommand", v: 1, id, expires: Date.now() + 5000, verb: { kind: "pageWalk", tabId: 1 } });
  for (let i = 0; i < 30; i++) {
    const r = f.sentToHelper.find((m) => m.type === "pageResult" && m.id === id);
    if (r !== undefined) return r;
    await settle();
  }
  throw new Error("no pageResult");
}

const report = (origin: string, path: string, title: string) => ({ origin, path, title, headings: [], controls: [], iframes: [], viewport: [1280, 900], excluded: {}, truncated: false, focused: null, hasFocus: true, walkMs: 1 });

describe("the deny list and the walk, review round 2", () => {
  it("denies a host written with a trailing dot (#1)", async () => {
    expect(deniedOrigin("https://accounts.google.com.")).toBe(true);
    expect(deniedOrigin("https://vault.bitwarden.com.")).toBe(true);
    await start([{ frameId: 0, parentFrameId: -1, documentId: "V0", url: "https://accounts.google.com./signin" }]);
    expect((await walkTab("t1")).outcome).toBe("siteOff");
    expect(f.asked).toEqual([]);
  });

  it("never reads the tab left when its host has a trailing dot (#1)", async () => {
    await start([{ frameId: 0, parentFrameId: -1, documentId: "V0", url: "https://vault.bitwarden.com./#/vault" }]);
    await leaveMail();
    expect((await read(1)).outcome).toBe("siteOff");
    expect(f.asked).toEqual([]);
  });

  it("refuses a walk whose top frame has no http(s) origin, asking no frame (#6)", async () => {
    await start([
      { frameId: 0, parentFrameId: -1, documentId: "B0", url: "about:blank" },
      { frameId: 3, parentFrameId: 0, documentId: "B3", url: "https://forms.example.test/embed" },
    ]);
    f.answers.set("1:3:walk", report("https://forms.example.test", "/embed", "Embedded"));
    const r = await walkTab("t2");
    expect(r.outcome).toBe("siteOff");
    expect(f.asked).toEqual([]);
  });

  it("takes the snapshot's title from the walked document, not from the tab (#3)", async () => {
    await start([{ frameId: 0, parentFrameId: -1, documentId: "P0", url: "https://shop.example.test/checkout" }]);
    f.answers.set("1:0:walk", report("https://shop.example.test", "/checkout", "Checkout"));
    f.state.titles.set(1, "Bitwarden Web Vault");
    expect((await walkTab("t3")).outcome).toBe("ok");
    const snap = f.sentToHelper.find((m) => m.type === "pageSnapshot");
    expect(snap?.title).toBe("Checkout");
    expect(JSON.stringify(f.sentToHelper)).not.toContain("Bitwarden");
  });

  it("discards a walk whose tab navigated while its frames answered (#3)", async () => {
    await start([{ frameId: 0, parentFrameId: -1, documentId: "P0", url: "https://shop.example.test/checkout" }]);
    f.answers.set("1:0:walk", report("https://shop.example.test", "/checkout", "Checkout"));
    f.setDuring((op) => {
      if (op !== "walk") return;
      // The tab goes to a vault while the frame answers.
      f.frames.set(1, [{ frameId: 0, parentFrameId: -1, documentId: "V1", url: "https://vault.bitwarden.com/#/vault" }]);
      f.state.titles.set(1, "Bitwarden Web Vault");
      void f.fire("nav.committed", { tabId: 1, frameId: 0, documentId: "V1" });
    });
    const r = await walkTab("t4");
    expect(r.outcome).toBe("stale");
    expect(f.sentToHelper.some((m) => m.type === "pageSnapshot")).toBe(false);
    expect(JSON.stringify(f.sentToHelper)).not.toMatch(/Bitwarden|Checkout/u);
  });

  it("takes the read text's title from the document it read, not from the tab (#3)", async () => {
    await start(MAIL_FRAMES);
    f.answers.set("1:0:frame", self(MAIL, [1280, 900]));
    f.answers.set("1:0:text", { ...text(["Inbox"]), title: "Inbox - Mail" });
    f.state.titles.set(1, "Bitwarden Web Vault");
    await leaveMail();
    const r = await read(1);
    expect(r.outcome).toBe("ok");
    expect((r.text as { title: string }).title).toBe("Inbox - Mail");
    expect(JSON.stringify(f.sentToHelper)).not.toContain("Bitwarden");
  });
});

describe("section name tokens in a walk's snapshot (SCP1)", () => {
  it("sends a token for each section name and no digest, salt or excluded text", async () => {
    await start([{ frameId: 0, parentFrameId: -1, documentId: "S0", url: "https://service.example/request" }]);
    const digest = sha256Hex("equipment details");
    f.answers.set("1:0:walk", { origin: "https://service.example", path: "/request", title: "t", headings: ["Equipment details"], sections: [{ id: "o1", heading: true, text: "Equipment details", digest }, { id: "o2", heading: true, digest }], sectionOverflow: [digest], controls: [], iframes: [], viewport: [1280, 900], excluded: {}, truncated: false, focused: null, hasFocus: true, walkMs: 1 });
    await f.fire("port.message", { type: "pageCommand", v: 1, id: "w9", expires: Date.now() + 5000, verb: { kind: "pageWalk", tabId: 1 } });
    for (let i = 0; i < 20 && !f.sentToHelper.some((m) => m.type === "pageSnapshot"); i++) await settle();
    const snap = f.sentToHelper.find((m) => m.type === "pageSnapshot") as { frames: { sections: { name: string }[]; sectionNames: string[] }[] } | undefined;
    const frame = snap?.frames[0];
    expect(frame?.sections[0]?.name).toMatch(/^[0-9a-f]{64}$/u);
    expect(frame?.sections[1]?.name).toBe(frame?.sections[0]?.name);
    expect(frame?.sectionNames).toEqual([frame?.sections[0]?.name]);
    expect(JSON.stringify(snap)).not.toContain(digest);
    expect(JSON.stringify(snap)).not.toMatch(/digest|salt/u);
  });
});

describe("focus and typing reports to the helper (H13)", () => {
  const typed = (frameId = 0) => f.fire("runtime.message", { caret: 1, op: "focusMoved" }, { id: "x", tab: { id: 1 }, frameId }, () => {});
  const focusReports = (): Record<string, unknown>[] => f.sentToHelper.filter((m) => m.type === "pageFocus");

  it("sends a report that came within 150 ms of the last one when that time is up, instead of dropping it", async () => {
    await start([{ frameId: 0, parentFrameId: -1, documentId: "D0", url: "http://127.0.0.1:4310/apply" }]);
    await typed();
    for (let i = 0; i < 5; i++) await settle();
    expect(focusReports()).toHaveLength(1);
    // Two keystrokes of a burst: neither is sent at once, and the last is not lost.
    await typed();
    await typed();
    for (let i = 0; i < 5; i++) await settle();
    expect(focusReports()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 170));
    for (let i = 0; i < 5; i++) await settle();
    expect(focusReports()).toHaveLength(2);
  });

  it("reports the caret with the text on a page, and whether the field's document has focus", async () => {
    await start([{ frameId: 0, parentFrameId: -1, documentId: "D0", url: "http://127.0.0.1:4310/apply" }]);
    f.answers.set("1:0:walk", { origin: "http://127.0.0.1:4310", path: "/apply", title: "t", headings: [], controls: [], iframes: [], viewport: [1280, 900], excluded: {}, truncated: false, focused: { id: "e1", selection: [1, 1], text: { before: "a", after: "", selection: "" }, caret: [10, 10, 1, 16] }, hasFocus: true, walkMs: 1 });
    await f.fire("port.message", { type: "pageCommand", v: 1, id: "w1", expires: Date.now() + 5000, verb: { kind: "pageWalk", tabId: 1 } });
    for (let i = 0; i < 20 && !f.sentToHelper.some((m) => m.type === "pageSnapshot"); i++) await settle();
    const snap = f.sentToHelper.find((m) => m.type === "pageSnapshot") as { focused: { text: unknown; caret: unknown; hasFocus: unknown } } | undefined;
    expect(snap?.focused.caret).toEqual([10, 10, 1, 16]);
    expect(snap?.focused.text).toEqual({ before: "a", after: "", selection: "" });
    // H13 review: whether the field's document has focus travels with it.
    expect(snap?.focused.hasFocus).toBe(true);
  });

  it("sends a focus report from a page on the deny list with nothing but where it came from", async () => {
    await start([{ frameId: 0, parentFrameId: -1, documentId: "V0", url: "https://accounts.google.com/signin" }]);
    await typed();
    for (let i = 0; i < 5; i++) await settle();
    expect(focusReports()).toHaveLength(1);
    expect(Object.keys(focusReports()[0] ?? {}).sort()).toEqual(["at", "frameId", "tabId", "type", "v"]);
  });
});

describe("a site switched off while work is in flight (review round 5)", () => {
  const TOP = "https://shop.example.test";
  const CHILD = "https://pay.example.test";
  const FRAMES: Frame[] = [
    { frameId: 0, parentFrameId: -1, documentId: "P0", url: `${TOP}/checkout` },
    { frameId: 3, parentFrameId: 0, documentId: "P3", url: `${CHILD}/embed` },
  ];
  const helperSays = (m: Record<string, unknown>) => f.fire("port.message", { v: 1, ...m });
  const resultOf = async (id: string): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 40; i++) {
      const r = f.sentToHelper.find((m) => m.type === "pageResult" && m.id === id);
      if (r !== undefined) return r;
      await settle();
    }
    throw new Error(`no pageResult ${id}`);
  };
  const childReport = { ...report(CHILD, "/embed", "Pay"), headings: ["Card details"], iframes: [], viewport: [400, 300] };
  const topReport = { ...report(TOP, "/checkout", "Checkout"), iframes: [{ src: `${CHILD}/embed`, rect: [0, 100, 400, 300], inner: [400, 300] }] };
  const grant = (frameId: number, origin: string) => helperSays({ type: "scopedActGrant", taskId: "t1", at: Date.now(), expires: Date.now() + 5000, scope: { kind: "page", engine: "e1", tabId: 1, frameId, origin, navGen: 2 } });
  const write = (id: string) => helperSays({ type: "pageCommand", id, expires: Date.now() + 5000, verb: { kind: "pageWrite", tabId: 1, frameId: 3, documentId: "P3", id: "e1", control: "text", name: "Name on card", taskId: "t1", expect: "", value: "Ines" } });

  it("matches a site switched off with a trailing dot, both ways (#6)", async () => {
    await start(FRAMES);
    await helperSays({ type: "pageSitesOff", origins: [`${TOP}.`] });
    expect((await walkTab("s1")).outcome).toBe("siteOff");
    await start([{ frameId: 0, parentFrameId: -1, documentId: "Q0", url: `${TOP}./checkout` }]);
    await helperSays({ type: "pageSitesOff", origins: [TOP] });
    expect((await walkTab("s2")).outcome).toBe("siteOff");
    expect(f.asked).toEqual([]);
  });

  it("keeps the child frame when nothing is switched off (the control for the next case)", async () => {
    await start(FRAMES);
    f.answers.set("1:0:walk", topReport);
    f.answers.set("1:3:walk", childReport);
    await walkTab("s0");
    const snap = f.sentToHelper.find((m) => m.type === "pageSnapshot") as { frames: { frameId: number }[] } | undefined;
    expect(snap?.frames.map((x) => x.frameId)).toEqual([0, 3]);
  });

  it("leaves out a child frame whose site was switched off while the walk ran (#5)", async () => {
    await start(FRAMES);
    f.answers.set("1:0:walk", topReport);
    f.answers.set("1:3:walk", childReport);
    f.setDuring((op, frameId) => {
      if (op === "walk" && frameId === 3) void helperSays({ type: "pageSitesOff", origins: [CHILD] });
    });
    await walkTab("s3");
    const snap = f.sentToHelper.find((m) => m.type === "pageSnapshot") as { frames: { frameId: number }[] } | undefined;
    expect(snap?.frames.map((x) => x.frameId)).toEqual([0]);
    expect(JSON.stringify(f.sentToHelper)).not.toContain("Card details");
  });

  it("ends a child frame's grant when its top page's site is switched off, and grantAlive says no (#5)", async () => {
    await start(FRAMES);
    await grant(3, CHILD);
    let alive: unknown = null;
    await f.fire("runtime.message", { caret: 1, op: "grantAlive", taskId: "t1" }, { id: "x", tab: { id: 1 }, frameId: 3 }, (r: unknown) => void (alive = r));
    for (let i = 0; i < 10; i++) await settle();
    expect(alive).toBe(true);
    await helperSays({ type: "pageSitesOff", origins: [TOP] });
    for (let i = 0; i < 10; i++) await settle();
    alive = null;
    await f.fire("runtime.message", { caret: 1, op: "grantAlive", taskId: "t1" }, { id: "x", tab: { id: 1 }, frameId: 3 }, (r: unknown) => void (alive = r));
    for (let i = 0; i < 10; i++) await settle();
    expect(alive).toBe(false);
    await write("w1");
    expect((await resultOf("w1")).outcome).toBe("notAllowed");
  });

  it("forwards no readings from an act whose top page's site was switched off while it ran (#5)", async () => {
    await start(FRAMES);
    await grant(3, CHILD);
    f.answers.set("1:3:act", { outcome: "failed", detail: "the page holds another value", readings: { before: "", afterInput: "Ines", afterBlur: "IN-4242", invalid: true, error: "Card ending 4242 declined" } });
    f.setDuring((op) => {
      if (op === "act") void helperSays({ type: "pageSitesOff", origins: [TOP] });
    });
    await write("w2");
    const r = await resultOf("w2");
    expect(r.readings).toBeUndefined();
    expect(JSON.stringify(f.sentToHelper)).not.toMatch(/4242/u);
  });
});
