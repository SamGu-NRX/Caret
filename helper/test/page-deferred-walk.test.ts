// The deferred walk (plans/fast-browser.md, "Latency budget"): a verified text write, native select or tick/radio check
// patches the tab's last walk for that one control instead of walking the tab again, and one trailing walk follows the
// last such act. Every other act re-walks as before. Every name here is invented.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_CHECKED, PROTOCOL_VERSION, type HelperToEngine, type PageControl, type PageSnapshot, type PageVerb } from "../src/protocol.ts";
import { EngineSession } from "../src/engines/session.ts";
import { PageEngineLink, TRAILING_WALK_MS, type VerbTiming } from "../src/engines/page-link.ts";
import { ScreenModel, type Change } from "../src/model.ts";

const X = "kcmlnoabcdefghijklmnopabcdefghij";
const browser = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
const WIN = "page:eng1:7";
const Q = "Are you legally authorized to work here?";

const control = (id: string, kind: PageControl["kind"], name: string, extra: Partial<PageControl> = {}): PageControl => ({
  id, key: `${kind}:${name.toLowerCase()}~${id}`, strongKey: null, kind, role: kind, name, form: null, rect: [0, 0, 100, 20], ...extra,
});

const controls = (): PageControl[] => [
  control("e1", "text", "Full name", { value: "" }),
  control("e2", "select", "Country", { options: [{ value: "", label: "Choose one", selected: true }, { value: "ca", label: "Canada", selected: false }, { value: "us", label: "United States", selected: false }] }),
  control("e3", "checkbox", "I agree", { checked: false }),
  control("e4", "radio", "Yes", { checked: false, group: { id: "g1", name: Q } }),
  control("e5", "radio", "No", { checked: true, group: { id: "g1", name: Q } }),
  control("e6", "combobox", "Department", { value: "" }),
];

const KEY = { name: "f0/text:full name~e1", country: "f0/select:country~e2", agree: "f0/checkbox:i agree~e3", yes: "f0/radio:yes~e4", no: "f0/radio:no~e5", group: "f0/radiogroup:g1", dept: "f0/combobox:department~e6" };

function snapshot(id: string): PageSnapshot {
  return {
    type: "pageSnapshot", v: PROTOCOL_VERSION, id, at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Application", walkMs: 9,
    frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: "https://jobs.example.test", path: "/apply", navGen: 1, title: "Application", headings: [], iframes: [], excluded: {}, truncated: false, controls: controls() }],
    missing: [],
    focused: null,
  };
}

const readings = (before: string, after: string) => ({ before, afterInput: after, afterBlur: after, invalid: false, error: null });

/** A session whose engine answers walks with snapshot() and every act with `result`. */
function rig(result: (v: Exclude<PageVerb, { kind: "pageWalk" }>) => object = () => ({ outcome: "ok", detail: null })) {
  const sent: HelperToEngine[] = [];
  const session = new EngineSession({ engine: "eng1", browser, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => {
    sent.push(m);
    queueMicrotask(() => {
      if (m.type !== "pageCommand") return;
      if (m.verb.kind === "pageWalk") {
        session.receive(snapshot(m.id));
        session.receive({ type: "pageResult", v: 1, id: m.id, at: 1, outcome: "ok", detail: null });
      } else session.receive({ type: "pageResult", v: 1, id: m.id, at: 1, ...result(m.verb) } as never);
    });
    return true;
  }, 500);
  const model = new ScreenModel();
  const changes: Change[] = [];
  const timings: VerbTiming[] = [];
  const link = new PageEngineLink(session, (s) => void changes.push(...model.apply(s)), (t) => timings.push(t));
  const verbs = (): PageVerb[] => sent.flatMap((m) => (m.type === "pageCommand" ? [m.verb] : []));
  const write = (key: string, role: string, expect: string, value: string) => link.run({ kind: "write", pid: browser.pid, windowId: WIN, key, role, attribute: "value", expect, value, taskId: "t1" });
  const node = (key: string) => model.windows.get(WIN)?.nodes.get(key);
  const tab = (id: string) => session.tabs.get(7)?.frames[0]?.controls.find((c) => c.id === id);
  return { session, link, model, changes, timings, verbs, write, node, tab };
}

type Rig = ReturnType<typeof rig>;

/** Walks the tab, then forgets what was sent and recorded so far. */
async function walked(r: Rig): Promise<number> {
  expect((await r.link.run({ kind: "walk", pid: browser.pid, windowId: WIN })).outcome).toBe("ok");
  const n = r.verbs().length;
  r.changes.length = 0;
  r.timings.length = 0;
  return n;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a verified write patches the model instead of walking the tab", () => {
  it("text: one command, the model holds the read-back value with a value change, and the stored walk is replaced, not edited", async () => {
    const r = rig((v) => ({ outcome: "ok", detail: null, readings: readings("", v.kind === "pageWrite" ? v.value : "") }));
    const n = await walked(r);
    const before = r.session.tabs.get(7);
    expect((await r.write(KEY.name, "AXTextField", "", "Robin Example")).outcome).toBe("ok");
    expect(r.verbs().slice(n).map((v) => v.kind)).toEqual(["pageWrite"]);
    expect(r.node(KEY.name)?.value).toBe("Robin Example");
    expect(r.changes).toEqual([expect.objectContaining({ kind: "value", windowId: WIN, key: KEY.name, before: "", after: "Robin Example" })]);
    expect(r.tab("e1")?.value).toBe("Robin Example");
    expect(r.session.tabs.get(7)).not.toBe(before);
    expect(before?.frames[0]?.controls[0]?.value).toBe("");
    expect(r.timings).toEqual([expect.objectContaining({ verb: "pageWrite", outcome: "ok", rewalk: null })]);
    r.link.cancelTrailingWalks();
  });

  it("text answered alreadyTrue with no readings: the field holds the value written", async () => {
    const r = rig(() => ({ outcome: "alreadyTrue", detail: null }));
    const n = await walked(r);
    expect((await r.write(KEY.name, "AXTextField", "", "Robin Example")).outcome).toBe("ok");
    expect(r.verbs().slice(n).map((v) => v.kind)).toEqual(["pageWrite"]);
    expect(r.node(KEY.name)?.value).toBe("Robin Example");
    r.link.cancelTrailingWalks();
  });

  it("select: the option with the verb's value is the only one selected, and the model shows its label", async () => {
    const r = rig();
    const n = await walked(r);
    expect((await r.write(KEY.country, "AXPopUpButton", "", "Canada")).outcome).toBe("ok");
    expect(r.verbs().slice(n).map((v) => v.kind)).toEqual(["pageSelect"]);
    expect(r.tab("e2")?.options).toEqual([{ value: "", label: "Choose one", selected: false }, { value: "ca", label: "Canada", selected: true }, { value: "us", label: "United States", selected: false }]);
    expect(r.node(KEY.country)?.value).toBe("Canada");
    expect(r.changes).toEqual([expect.objectContaining({ kind: "value", key: KEY.country, before: "", after: "Canada" })]);
    r.link.cancelTrailingWalks();
  });

  it("checkbox: ticked in the walk and the model, with a value change to PAGE_CHECKED", async () => {
    const r = rig();
    const n = await walked(r);
    expect((await r.write(KEY.agree, "AXCheckBox", "", PAGE_CHECKED)).outcome).toBe("ok");
    expect(r.verbs().slice(n).map((v) => v.kind)).toEqual(["pageSetChecked"]);
    expect(r.tab("e3")?.checked).toBe(true);
    expect(r.node(KEY.agree)).toMatchObject({ value: PAGE_CHECKED, states: ["checked"] });
    expect(r.changes).toEqual([expect.objectContaining({ kind: "value", key: KEY.agree, before: "", after: PAGE_CHECKED })]);
    r.link.cancelTrailingWalks();
  });

  it("radio: the button is checked, the group's other button unchecked, and the group node holds the checked name", async () => {
    const r = rig();
    const n = await walked(r);
    expect(r.node(KEY.group)?.value).toBe("No");
    expect((await r.write(KEY.group, "AXGroup", "No", "Yes")).outcome).toBe("ok");
    expect(r.verbs().slice(n).map((v) => v.kind)).toEqual(["pageSetChecked"]);
    expect([r.tab("e4")?.checked, r.tab("e5")?.checked]).toEqual([true, false]);
    expect(r.node(KEY.yes)?.states).toEqual(["checked"]);
    expect(r.node(KEY.no)?.states).toBeUndefined();
    expect(r.node(KEY.group)?.value).toBe("Yes");
    expect(r.changes).toEqual([expect.objectContaining({ kind: "value", key: KEY.group, before: "No", after: "Yes" })]);
    r.link.cancelTrailingWalks();
  });
});

describe("every other act re-walks the tab as before", () => {
  it.each([
    ["failed", { outcome: "failed", detail: "the page kept the old value", readings: readings("", "") }],
    ["stale", { outcome: "stale", detail: "the field changed since the walk" }],
    ["error", { outcome: "error", detail: "no answer" }],
  ])("a text write answered %s", async (_, answer) => {
    const r = rig(() => answer);
    const n = await walked(r);
    await r.write(KEY.name, "AXTextField", "", "Robin Example");
    expect(r.verbs().slice(n).map((v) => v.kind)).toEqual(["pageWrite", "pageWalk"]);
    expect(r.timings[0]?.rewalk).not.toBeNull();
  });

  it("a combobox pick answered ok", async () => {
    const r = rig();
    const n = await walked(r);
    expect((await r.write(KEY.dept, "AXComboBox", "", "Research")).outcome).toBe("ok");
    expect(r.verbs().slice(n).map((v) => v.kind)).toEqual(["pageChooseOption", "pageWalk"]);
  });

  it("a refused write sends no walk at all", async () => {
    const r = rig(() => ({ outcome: "notAllowed", detail: "no grant" }));
    const n = await walked(r);
    await r.write(KEY.name, "AXTextField", "", "Robin Example");
    expect(r.verbs().slice(n).map((v) => v.kind)).toEqual(["pageWrite"]);
  });

  it("a write whose control is not in the last walk any more falls back to the walk", async () => {
    const r = rig();
    const n = await walked(r);
    // The write was resolved against e1; by the time the page answers, the stored walk no longer holds it.
    const verbSent = r.write(KEY.name, "AXTextField", "", "Robin Example");
    const s = r.session.tabs.get(7)!;
    r.session.tabs.set(7, { ...s, frames: [{ ...s.frames[0]!, controls: s.frames[0]!.controls.filter((c) => c.id !== "e1") }] });
    await verbSent;
    expect(r.verbs().slice(n).map((v) => v.kind)).toEqual(["pageWrite", "pageWalk"]);
  });
});

describe("the trailing walk", () => {
  it("runs once, TRAILING_WALK_MS after the last of several patched acts, and is timed like a walk", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const r = rig();
    const n = await walked(r);
    await r.write(KEY.name, "AXTextField", "", "Robin");
    vi.advanceTimersByTime(TRAILING_WALK_MS - 10);
    await r.write(KEY.agree, "AXCheckBox", "", PAGE_CHECKED);
    vi.advanceTimersByTime(TRAILING_WALK_MS - 10);
    await r.write(KEY.country, "AXPopUpButton", "", "Canada");
    vi.advanceTimersByTime(TRAILING_WALK_MS - 1);
    expect(r.verbs().slice(n).map((v) => v.kind)).toEqual(["pageWrite", "pageSetChecked", "pageSelect"]);
    vi.advanceTimersByTime(1);
    expect(r.verbs().slice(n).map((v) => v.kind)).toEqual(["pageWrite", "pageSetChecked", "pageSelect", "pageWalk"]);
    await vi.waitFor(() => expect(r.timings.at(-1)).toMatchObject({ verb: "pageWalk", control: null, outcome: "ok", extensionMs: 9, rewalk: null }));
    vi.advanceTimersByTime(10 * TRAILING_WALK_MS);
    expect(r.verbs().slice(n).filter((v) => v.kind === "pageWalk")).toHaveLength(1);
  });

  it("is dropped by a walk of the tab in between, by cancelTrailingWalks, and once the session closed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const r = rig();
    const n = await walked(r);
    await r.write(KEY.name, "AXTextField", "", "Robin");
    await r.link.run({ kind: "walk", pid: browser.pid, windowId: WIN });
    vi.advanceTimersByTime(10 * TRAILING_WALK_MS);
    expect(r.verbs().slice(n).map((v) => v.kind)).toEqual(["pageWrite", "pageWalk"]);

    await r.write(KEY.agree, "AXCheckBox", "", PAGE_CHECKED);
    r.link.cancelTrailingWalks(7);
    vi.advanceTimersByTime(10 * TRAILING_WALK_MS);
    expect(r.verbs().slice(n).map((v) => v.kind)).toEqual(["pageWrite", "pageWalk", "pageSetChecked"]);

    await r.write(KEY.group, "AXGroup", "No", "Yes");
    r.session.close();
    vi.advanceTimersByTime(10 * TRAILING_WALK_MS);
    expect(r.verbs().slice(n).map((v) => v.kind)).toEqual(["pageWrite", "pageWalk", "pageSetChecked", "pageSetChecked"]);
  });

  it("an act's own re-walk drops it too", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const r = rig();
    const n = await walked(r);
    await r.write(KEY.name, "AXTextField", "", "Robin");
    await r.write(KEY.dept, "AXComboBox", "", "Research");
    vi.advanceTimersByTime(10 * TRAILING_WALK_MS);
    expect(r.verbs().slice(n).map((v) => v.kind)).toEqual(["pageWrite", "pageChooseOption", "pageWalk"]);
  });
});
