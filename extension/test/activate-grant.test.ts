// A grant names the frame's navigation generation (worker.ts act). A same-document history update since the grant is
// refused for every verb, because an unrelated pushState may have put other fields behind the walked ids. The one
// update a grant follows is the single one seen around its own task's row open. Drives the real worker through a
// fake chrome; every value is invented.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeChrome, settle } from "./fake-chrome.ts";

const ORIGIN = "https://mail.example.test";
const write = { kind: "pageWrite", tabId: 1, frameId: 0, documentId: "D1", id: "field-9", control: "text", name: "", taskId: "t", expectRev: 0, value: "Dana" };
const open = { kind: "pageActivateItem", tabId: 1, frameId: 0, documentId: "D1", id: "row-1", control: "row", name: "Kayak · Flight itinerary", taskId: "t", rebind: false };
const wrote = { outcome: "ok", detail: null, readings: { sameAsBefore: false, landed: true, equivalent: true, empty: false, typedBetween: false, rev: 1 } };

afterEach(() => vi.unstubAllGlobals());

/** The worker with a page grant for task "t" at navGen 7 of tab 1's top frame, and a way to send it commands. */
async function worker() {
  const f = fakeChrome();
  vi.stubGlobal("chrome", f.chrome);
  vi.resetModules();
  f.frames.set(1, [{ frameId: 0, parentFrameId: -1, documentId: "D1", url: `${ORIGIN}/inbox` }]);
  await import("../src/worker.ts");
  await settle();
  await f.fire("port.message", { type: "engineReady", v: 1, engine: "e1" });
  await f.fire("nav.committed", { tabId: 1, frameId: 0, documentId: "D1" });
  const pushState = () => f.fire("nav.history", { tabId: 1, frameId: 0 });
  for (let gen = 2; gen < 7; gen++) await pushState();
  await f.fire("port.message", { type: "scopedActGrant", v: 1, taskId: "t", at: Date.now(), expires: Date.now() + 5000, scope: { kind: "page", engine: "e1", tabId: 1, frameId: 0, origin: ORIGIN, navGen: 7 } });
  let n = 0;
  const command = async (verb: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => {
    const id = `c${++n}`;
    await f.fire("port.message", { type: "pageCommand", v: 1, id, expires: Date.now() + 5000, verb });
    // An open waits out the page's reactions (worker.ts POST_PRESS_MS) before it answers.
    const result = () => f.sentToHelper.find((m) => m.type === "pageResult" && m.id === id);
    for (let i = 0; i < 100 && result() === undefined; i++) await new Promise((r) => setTimeout(r, 10));
    return result();
  };
  const acts = () => f.asked.filter((m) => m.op === "act").map((m) => (m.msg.verb as { kind: string }).kind);
  return { f, pushState, command, acts };
}

describe("a grant and the page's own history updates", () => {
  it("refuses a write after an unrelated pushState, before the page is asked", async () => {
    const { f, pushState, command, acts } = await worker();
    f.answers.set("1:0:act", wrote);
    await pushState();
    const r = await command(write);
    expect(r).toMatchObject({ outcome: "stale", detail: "the frame navigated since the grant (navGen 7, now 8)" });
    expect(acts()).toEqual([]);
  });

  it("follows the one update its own row open made, and no update after it", async () => {
    const { f, pushState, command, acts } = await worker();
    f.answers.set("1:0:act", { outcome: "ok", detail: null });
    f.setDuring((op) => {
      if (op === "act") void pushState();
    });
    expect(await command(open)).toMatchObject({ outcome: "ok" });
    f.setDuring(() => {});
    f.answers.set("1:0:act", wrote);
    expect(await command(write)).toMatchObject({ outcome: "ok" });
    await pushState();
    expect(await command(write)).toMatchObject({ outcome: "stale", detail: "the frame navigated since the grant (navGen 8, now 9)" });
    expect(acts()).toEqual(["pageActivateItem", "pageWrite"]);
  });

  it("stops the run when the open moved the page twice, and the grant follows neither", async () => {
    const { f, pushState, command, acts } = await worker();
    f.answers.set("1:0:act", { outcome: "ok", detail: null });
    f.setDuring((op) => {
      if (op !== "act") return;
      void pushState();
      void pushState();
    });
    expect(await command(open)).toMatchObject({ outcome: "failed", pageChanged: ["navigated"] });
    f.setDuring(() => {});
    f.answers.set("1:0:act", wrote);
    expect(await command(write)).toMatchObject({ outcome: "notAllowed" });
    expect(acts()).toEqual(["pageActivateItem"]);
  });
});
