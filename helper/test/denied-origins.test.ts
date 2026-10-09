// The helper's copy of the deny list (privacy/denied-origins.ts) and where it applies: every page snapshot and tab
// text entering an engine session (engines/session.ts). The extension refuses these pages itself; this is the second
// line, for an extension that walked one anyway. Every page, label and value is invented.
import { describe, expect, it } from "vitest";
import { DENIED_HOSTS as EXTENSION_HOSTS } from "../../extension/src/worker/left-tab.ts";
import { DENIED_HOSTS, canonicalOrigin, deniedOrigin } from "../src/privacy/denied-origins.ts";
import { EngineSession, screenReadings } from "../src/engines/session.ts";
import { toVerbOutcome, topFrameOn } from "../src/engines/page-link.ts";
import { PROTOCOL_VERSION, type HelperToEngine, type PageFrame, type PageSnapshot } from "../src/protocol.ts";
import { X, chrome } from "./fake-page.ts";

describe("DENIED_HOSTS", () => {
  it("is the extension's list, pattern for pattern", () => {
    expect(DENIED_HOSTS.map((r) => `${r.source}/${r.flags}`)).toEqual(EXTENSION_HOSTS.map((r) => `${r.source}/${r.flags}`));
  });

  it("denies account pages and vaults, and no ordinary site", () => {
    for (const o of ["https://accounts.google.com", "https://vault.bitwarden.com", "https://my.1password.eu", "https://appleid.apple.com"]) expect(deniedOrigin(o), o).toBe(true);
    // Review round 2, #1: a fully qualified host with its trailing dot is the same site.
    for (const o of ["https://accounts.google.com.", "https://vault.bitwarden.com.", "https://ACCOUNTS.google.com."]) expect(deniedOrigin(o), o).toBe(true);
    for (const o of ["https://docs.google.com", "https://jobs.example.test", "http://127.0.0.1:4310", "https://notbitwarden.com"]) expect(deniedOrigin(o), o).toBe(false);
  });
});

const frame = (frameId: number, origin: string, over: Partial<PageFrame> = {}): PageFrame => ({
  frameId, parentFrameId: frameId === 0 ? -1 : 0, documentId: `D${frameId}`, origin, path: "/", navGen: 1, title: `Frame ${frameId}`, headings: [], iframes: [], excluded: {}, truncated: false,
  controls: [{ id: `e${frameId}`, key: `textbox:email~${frameId}`, strongKey: null, kind: "email", role: "textbox", name: "Email or phone", value: "ines@example.test", form: null, rect: [0, 0, 200, 20] }],
  ...over,
});

/** A session whose engine answers each walk with `frames` and an ok result, and each text read with `text`'s frames. */
function rig(frames: PageFrame[], focusedFrame: number | null = null) {
  const seen: PageSnapshot[] = [];
  const session: EngineSession = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m: HelperToEngine) => {
    queueMicrotask(() => {
      if (m.type === "pageCommand" && m.verb.kind === "pageWalk") {
        session.receive({ type: "pageSnapshot", v: PROTOCOL_VERSION, id: m.id, at: Date.now(), tabId: 4, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Synthetic tab", frames, missing: [], focused: focusedFrame === null ? null : { frameId: focusedFrame, id: `e${focusedFrame}`, selection: [0, 0], text: { before: "ines@", after: "", selection: "" } } });
        session.receive({ type: "pageResult", v: PROTOCOL_VERSION, id: m.id, at: Date.now(), outcome: "ok", detail: null });
      }
      if (m.type === "pageReadText") {
        session.receive({ type: "pageResult", v: PROTOCOL_VERSION, id: m.id, at: Date.now(), outcome: "ok", detail: null, text: { tabId: 4, leftAt: Date.now(), title: "Synthetic tab", frames: frames.map((f) => ({ frameId: f.frameId, origin: f.origin })), selection: [], blocks: ["Recovery code: 1111-2222"], cut: false, docsText: null } });
      }
    });
    return true;
  }, 500);
  session.onSnapshot = (s) => void seen.push(s);
  return { session, seen };
}

describe("an engine session and the deny list", () => {
  it("answers a walk of a tab on the deny list with siteOff, keeps no snapshot and tells no one", async () => {
    const { session, seen } = rig([frame(0, "https://accounts.google.com")], 0);
    const a = await session.command({ kind: "pageWalk", tabId: 4 });
    expect(a.result.outcome).toBe("siteOff");
    expect(a.snapshot).toBeNull();
    expect(session.tabs.size).toBe(0);
    expect(seen).toEqual([]);
  });

  it("answers a walk of a tab on the deny list with a trailing-dot host as siteOff (review round 2, #1)", async () => {
    const { session } = rig([frame(0, "https://accounts.google.com.")], 0);
    expect((await session.command({ kind: "pageWalk", tabId: 4 })).result.outcome).toBe("siteOff");
  });

  it("drops a frame on the deny list from a snapshot, with focus in it, and keeps the rest", async () => {
    const { session, seen } = rig([frame(0, "https://shop.example.test"), frame(2, "https://vault.bitwarden.com", { headings: ["Logins"] })], 2);
    const a = await session.command({ kind: "pageWalk", tabId: 4 });
    expect(a.result.outcome).toBe("ok");
    expect(a.snapshot?.frames.map((f) => f.frameId)).toEqual([0]);
    expect(a.snapshot?.missing).toEqual([{ frameId: 2, reason: "Caret never reads this site" }]);
    expect(a.snapshot?.focused).toBeNull();
    expect(JSON.stringify([a.snapshot, session.tabs.get(4), seen])).not.toContain("Logins");
  });

  it("never hands on the text of a tab with a frame on the deny list", async () => {
    const { session } = rig([frame(0, "https://my.1password.com")]);
    const r = await session.readText(4);
    expect(r.outcome).toBe("siteOff");
    expect(r.text).toBeUndefined();
  });

  it("passes an ordinary tab's snapshot and text through unchanged", async () => {
    const { session } = rig([frame(0, "https://jobs.example.test")], 0);
    const a = await session.command({ kind: "pageWalk", tabId: 4 });
    expect(a.snapshot?.frames[0]?.controls[0]?.value).toBe("ines@example.test");
    expect((await session.readText(4)).text?.blocks).toEqual(["Recovery code: 1111-2222"]);
  });
});

describe("an act's readings (review round 3)", () => {
  it("drops a write's readings when a value in them is one Caret never carries, so the write reads as unverified", async () => {
    const session: EngineSession = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m: HelperToEngine) => {
      queueMicrotask(() => {
        if (m.type === "pageCommand") session.receive({ type: "pageResult", v: PROTOCOL_VERSION, id: m.id, at: Date.now(), outcome: "failed", detail: "the page holds another value than Caret wrote", readings: { before: "", afterInput: "4111 1111 1111 1111", afterBlur: "4111 1111 1111 1111", invalid: true, error: "Code swordfish expired" } });
      });
      return true;
    }, 500);
    const a = await session.command({ kind: "pageWrite", taskId: "t1", tabId: 4, frameId: 0, documentId: "D0", id: "e1", control: "text", name: "Name", value: "Ines", expect: "" });
    expect(a.result.outcome).toBe("failed");
    expect(a.result.readings).toBeUndefined();
    expect(JSON.stringify(a.result)).not.toMatch(/swordfish|4111/u);
    expect(toVerbOutcome(a.result).outcome).toBe("axError");
  });

  it("never keeps the page's error or description text, and keeps ordinary values for the write's check", () => {
    const r = screenReadings({ type: "pageResult", v: PROTOCOL_VERSION, id: "w", at: 0, outcome: "failed", detail: null, readings: { before: "", afterInput: "Ines", afterBlur: "", invalid: true, error: "Your recovery code swordfish expired" } });
    expect(r.readings).toEqual({ before: "", afterInput: "Ines", afterBlur: "", invalid: true, error: null });
  });
});

describe("site-off origins, canonical both ways (review round 5, #6)", () => {
  it("writes an origin the extension's way: lower case, no default port, no trailing dot", async () => {
    const { canonicalOrigin: extension } = await import("../../extension/src/worker/left-tab.ts");
    for (const o of ["https://Shop.Example.test.", "https://shop.example.test:443", "http://127.0.0.1:4310", "https://shop.example.test.:8443", "https://shop.example.test"]) {
      expect(canonicalOrigin(o), o).toBe(extension(o));
    }
    expect(canonicalOrigin("https://shop.example.test.")).toBe("https://shop.example.test");
  });

  it("keeps a frame out of the model when its site was switched off with or without the trailing dot", () => {
    const snap = (origin: string): PageSnapshot => ({ type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w", at: 0, tabId: 4, browserWindowId: 1, active: true, inFocusedWindow: true, title: "t", frames: [frame(0, origin)], missing: [], focused: null });
    const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, () => true);
    session.sitesOff(["https://shop.example.test."]);
    expect(topFrameOn(snap("https://shop.example.test"), session.offSites)).toBe(false);
    session.sitesOff(["https://shop.example.test"]);
    expect(topFrameOn(snap("https://shop.example.test."), session.offSites)).toBe(false);
  });
});
