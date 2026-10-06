// P4: the worker's read of the tab the user just left, driven through its real listeners with a fake `chrome`: which
// tab it reads, which frames it asks for text (never a hidden one, never one on an excluded site), what it rechecks
// before asking, and that a walk on a denied site asks for no caret text. The content scripts' halves run in a real
// browser in fixtures/web-form/tests/tab-text.test.ts and the journey (tab-source-journey.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...a: never[]) => unknown;
interface Frame {
  frameId: number;
  parentFrameId: number;
  documentId: string;
  url: string;
}

/** A fake of the chrome APIs the worker uses, with every listener kept so a test can fire the events. */
function fakeChrome() {
  const listeners = new Map<string, Listener[]>();
  const on = (name: string) => ({ addListener: (f: Listener) => void listeners.set(name, [...(listeners.get(name) ?? []), f]) });
  const fire = async (name: string, ...a: unknown[]): Promise<void> => {
    for (const f of listeners.get(name) ?? []) await (f as (...x: unknown[]) => unknown)(...a);
  };
  const sentToHelper: Record<string, unknown>[] = [];
  const port = { onMessage: on("port.message"), onDisconnect: on("port.disconnect"), postMessage: (m: Record<string, unknown>) => void sentToHelper.push(m) };
  const frames = new Map<number, Frame[]>();
  /** What each frame's content script answers, by `${tabId}:${frameId}:${op}`; every message it got is kept. */
  const answers = new Map<string, unknown>();
  const asked: { tabId: number; frameId: number; op: string; msg: Record<string, unknown> }[] = [];
  /** Run while a frame answers (a test changes the world mid-read here). */
  let duringAnswer: (op: string, frameId: number) => void = () => {};
  const state = { focusedWindow: 9, active: new Map<number, number>([[9, 1]]), titles: new Map<number, string>() };
  const chrome = {
    runtime: { id: "x", getManifest: () => ({ version: "0" }), connectNative: () => port, onMessage: on("runtime.message"), onInstalled: on("runtime.installed"), lastError: undefined },
    storage: { local: { get: async () => ({ profile: "p" }), set: async () => {} } },
    tabs: {
      query: async () => [...state.active].map(([windowId, id]) => ({ id, windowId, active: true })),
      get: async (id: number) => ({ id, windowId: 9, active: state.active.get(9) === id, title: state.titles.get(id) ?? "" }),
      sendMessage: async (tabId: number, msg: Record<string, unknown>, opts: { frameId: number }) => {
        asked.push({ tabId, frameId: opts.frameId, op: String(msg.op), msg });
        duringAnswer(String(msg.op), opts.frameId);
        return answers.get(`${tabId}:${opts.frameId}:${String(msg.op)}`);
      },
      onActivated: on("tabs.activated"),
      onRemoved: on("tabs.removed"),
      onReplaced: on("tabs.replaced"),
      onDetached: on("tabs.detached"),
      onZoomChange: on("tabs.zoom"),
    },
    windows: { WINDOW_ID_NONE: -1, getLastFocused: async () => ({ id: state.focusedWindow, focused: true }), onFocusChanged: on("windows.focus"), onRemoved: on("windows.removed") },
    webNavigation: {
      getAllFrames: async ({ tabId }: { tabId: number }) => frames.get(tabId) ?? [],
      getFrame: async () => null,
      onCommitted: on("nav.committed"),
      onHistoryStateUpdated: on("nav.history"),
      onReferenceFragmentUpdated: on("nav.fragment"),
      onBeforeNavigate: on("nav.before"),
    },
    scripting: { executeScript: async () => [] },
    dom: undefined,
  };
  return { chrome, fire, sentToHelper, frames, answers, asked, state, setDuring: (f: typeof duringAnswer) => void (duringAnswer = f) };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const MAIL = "https://mail.example.test";
const self = (origin: string, viewport: [number, number], iframes: { src: string; rect: number[]; inner: [number, number] }[] = []) => ({ origin, viewport, iframes });
const text = (blocks: string[]) => ({ selection: [], blocks, cut: false, docsText: null });

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

  it("tells a frame on a site on the deny list not to report the text around the caret in a walk (P4 second review)", async () => {
    await start([{ frameId: 0, parentFrameId: -1, documentId: "V0", url: "https://accounts.google.com/signin" }]);
    f.answers.set("1:0:walk", { origin: "https://accounts.google.com", path: "/signin", title: "t", headings: [], controls: [], iframes: [], viewport: [1280, 900], excluded: {}, truncated: false, focused: { id: "e1", selection: [0, 0], text: { before: "a", after: "", selection: "" } }, hasFocus: true, walkMs: 1 });
    await f.fire("port.message", { type: "pageCommand", v: 1, id: "w1", expires: Date.now() + 5000, verb: { kind: "pageWalk", tabId: 1 } });
    for (let i = 0; i < 20 && !f.sentToHelper.some((m) => m.type === "pageSnapshot"); i++) await settle();
    expect(f.asked.find((a) => a.op === "walk")?.msg.caretText).toBe(false);
    const snap = f.sentToHelper.find((m) => m.type === "pageSnapshot") as { focused: { text: unknown } } | undefined;
    expect(snap?.focused.text).toBeNull();
  });
});
