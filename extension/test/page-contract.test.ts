// The page wire has one schema, the helper's (helper/src/protocol.ts). This drives the real worker through a fake
// `chrome` and parses everything it sends with that schema, then checks the shared fixtures the Swift bridge also
// decodes (bridge/Tests/CaretPageProtocolTests) against the same schema. The worker builds its messages inline at
// each send, so the test captures what it posts to the native port rather than calling a builder.
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AnyPageMessage, EngineMessage, HelperToEngine } from "../../helper/src/protocol.ts";
import { parseFromHelper } from "../src/worker/wire.ts";
import { fakeChrome, settle, type Frame } from "./fake-chrome.ts";

const ORIGIN = "https://form.example.test";
const FORM: Frame = { frameId: 0, parentFrameId: -1, documentId: "D1", url: `${ORIGIN}/apply` };
const OTHER: Frame = { frameId: 0, parentFrameId: -1, documentId: "D2", url: `${ORIGIN}/other` };
const target = { tabId: 1, frameId: 0, documentId: "D1", id: "field-1", control: "text", name: "First name", taskId: "t1" } as const;
const walkReport = {
  origin: ORIGIN, path: "/apply", title: "Apply", headings: ["Synthetic form"], iframes: [], viewport: [1280, 900], screen: [0, 0, 1280, 1000],
  excluded: { password: 1 }, truncated: false, focused: { id: "field-1", selection: [0, 3] }, hasFocus: true, walkMs: 1,
  controls: [{ id: "field-1", key: "k1", strongKey: "[\"form\",\"first\"]", kind: "text", role: "textbox", name: "First name", value: "Ada", form: "apply", rect: [0, 0, 100, 20] }],
};

const directory = new URL("../../helper/fixtures/contracts/page/", import.meta.url);
const fixtures = readdirSync(directory).filter((f) => f.endsWith(".json")).map((name) => ({ name, value: JSON.parse(readFileSync(new URL(name, directory), "utf8")) as unknown }));
const kinds = (schema: typeof EngineMessage | typeof HelperToEngine) => schema.options.map((o) => o.shape.type.value).sort();

let sent: Record<string, unknown>[] = [];

/** One connection's worth of traffic: every kind the worker sends, and pageResult in each shape it builds. */
async function drive(): Promise<Record<string, unknown>[]> {
  const f = fakeChrome();
  // The helper checks the extension id's shape; content-script senders must carry the same id.
  f.chrome.runtime.id = "a".repeat(32);
  vi.stubGlobal("chrome", f.chrome);
  vi.resetModules();
  f.frames.set(1, [FORM]);
  f.frames.set(2, [OTHER]);
  await import("../src/worker.ts");
  await settle();
  const helper = (m: Record<string, unknown>) => f.fire("port.message", { v: 1, ...m });
  const expires = Date.now() + 5000;
  await helper({ type: "engineReady", engine: "e1" });
  await f.fire("nav.committed", { tabId: 1, frameId: 0, documentId: "D1" });
  await f.fire("nav.committed", { tabId: 2, frameId: 0, documentId: "D2" });
  await helper({ type: "pagePing", id: "ping" });
  await f.fire("tabs.activated", { tabId: 1, windowId: 9 });
  f.answers.set("1:0:walk", walkReport);
  await helper({ type: "pageCommand", id: "walk", expires, verb: { kind: "pageWalk", tabId: 1 } });
  await helper({ type: "pageCommand", id: "press", expires, verb: { kind: "pagePress", ...target, name: "Submit" } });
  await helper({ type: "pageCommand", id: "late", expires: Date.now() - 1, verb: { kind: "pageWalk", tabId: 1 } });
  await helper({ type: "scopedActGrant", taskId: "t1", at: Date.now(), expires, scope: { kind: "page", engine: "e1", tabId: 1, frameId: 0, origin: ORIGIN, navGen: 2 } });
  f.answers.set("1:0:act", { outcome: "ok", detail: null, readings: { before: "", afterInput: "Ada", afterBlur: "Ada", invalid: true, error: "Required" } });
  await helper({ type: "pageCommand", id: "write", expires, verb: { kind: "pageWrite", ...target, expect: "", value: "Ada" } });
  await f.fire("runtime.message", { caret: 1, op: "userInput", kind: "key" }, { id: f.chrome.runtime.id, tab: { id: 1 }, frameId: 0 }, () => {});
  f.state.active.set(9, 2);
  await f.fire("tabs.activated", { tabId: 2, windowId: 9 });
  f.answers.set("1:0:frame", { origin: ORIGIN, viewport: [1280, 900], iframes: [] });
  f.answers.set("1:0:text", { selection: [], blocks: ["Synthetic text"], cut: false, docsText: null });
  await helper({ type: "pageReadText", id: "read", expires, tabId: 1 });
  const results = ["walk", "press", "late", "write", "read"];
  for (let i = 0; i < 50 && results.some((id) => !f.sentToHelper.some((m) => m.type === "pageResult" && m.id === id)); i++) await settle();
  return f.sentToHelper;
}

describe("extension/helper page contract", () => {
  beforeAll(async () => {
    sent = await drive();
  });

  it("sends every kind the helper's schema receives from the extension", () => {
    expect([...new Set(sent.map((m) => String(m.type)))].sort()).toEqual(kinds(EngineMessage));
    const outcomes = sent.filter((m) => m.type === "pageResult").map((m) => `${String(m.id)}:${String(m.outcome)}`);
    expect(outcomes.sort()).toEqual(["late:error", "press:handoff", "read:ok", "walk:ok", "write:ok"]);
  });

  it("sends only messages the helper's schema accepts", () => {
    for (const m of sent) expect(EngineMessage.safeParse(m).error?.issues ?? [], `${String(m.type)} ${String(m.id ?? "")}`).toEqual([]);
  });

  it.each(fixtures)("$name parses with the helper's schema", ({ value }) => {
    expect(AnyPageMessage.safeParse(value).error?.issues ?? []).toEqual([]);
  });

  it("decodes every helper-to-extension fixture with the worker's own decoder", () => {
    const incoming = fixtures.filter(({ value }) => HelperToEngine.safeParse(value).success);
    expect([...new Set(incoming.map(({ value }) => (value as { type: string }).type))].sort()).toEqual(kinds(HelperToEngine));
    for (const { name, value } of incoming) expect(parseFromHelper(value), name).not.toBeNull();
  });
});
