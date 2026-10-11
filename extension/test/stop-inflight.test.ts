import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeChrome } from "./fake-chrome.ts";

const ORIGIN = "https://form.example.test";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("worker Stop with a dispatched page write", () => {
  it.each([0, 10, 40, 200])("revokes at %i ms but still delivers the in-flight result", async (stopAfter) => {
    vi.useFakeTimers();
    const f = fakeChrome();
    vi.stubGlobal("chrome", f.chrome);
    vi.resetModules();
    f.frames.set(1, [{ frameId: 0, parentFrameId: -1, documentId: "D1", url: `${ORIGIN}/apply` }]);
    await import("../src/worker.ts");
    await vi.advanceTimersByTimeAsync(0);
    await f.fire("port.message", { type: "engineReady", v: 1, engine: "e1" });
    await f.fire("nav.committed", { tabId: 1, frameId: 0, documentId: "D1" });
    await f.fire("port.message", {
      type: "scopedActGrant", v: 1, taskId: "t", at: Date.now(), expires: Date.now() + 5000,
      scope: { kind: "page", engine: "e1", tabId: 1, frameId: 0, origin: ORIGIN, navGen: 2 },
    });
    let dispatched = false;
    let value = "Original name";
    // The content setter and its reply are separate events. The worker must not discard that reply on revocation.
    f.answers.set("1:0:act", new Promise((resolve) => {
      f.setDuring((op) => {
        if (op !== "act") return;
        dispatched = true;
        value = "Dana";
        setTimeout(() => { void f.fire("port.message", { type: "actRevoke", v: 1, taskId: "t", at: Date.now() }); }, stopAfter);
        setTimeout(() => resolve({ outcome: "failed", detail: "the write went in, then the grant ended" }), 250);
      });
    }));
    await f.fire("port.message", {
      type: "pageCommand", v: 1, id: "write", expires: Date.now() + 5000,
      verb: { kind: "pageWrite", tabId: 1, frameId: 0, documentId: "D1", id: "field", control: "text", name: "First Name", taskId: "t", expect: "Original name", value: "Dana", mark: "m" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatched).toBe(true);
    await vi.advanceTimersByTimeAsync(stopAfter);
    let alive: unknown = true;
    await f.fire("runtime.message", { caret: 1, op: "grantAlive", taskId: "t" }, { id: f.chrome.runtime.id, tab: { id: 1 }, frameId: 0 }, (v: unknown) => { alive = v; });
    expect(alive).toBe(false);
    expect(f.sentToHelper.some((m) => m.type === "pageResult" && m.id === "write")).toBe(false);
    await vi.advanceTimersByTimeAsync(250 - stopAfter);
    expect(value).toBe("Dana");
    expect(f.sentToHelper.filter((m) => m.type === "pageResult" && m.id === "write")).toMatchObject([{ outcome: "failed", detail: "the write went in, then the grant ended" }]);
    // A later dispatch is refused at the worker, without reaching the content setter again.
    await f.fire("port.message", {
      type: "pageCommand", v: 1, id: "next", expires: Date.now() + 5000,
      verb: { kind: "pageWrite", tabId: 1, frameId: 0, documentId: "D1", id: "field", control: "text", name: "First Name", taskId: "t", expect: "Dana", value: "Must not run" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.asked.filter((m) => m.op === "act")).toHaveLength(1);
    expect(f.sentToHelper.find((m) => m.type === "pageResult" && m.id === "next")).toMatchObject({ outcome: "notAllowed" });
  });
});
