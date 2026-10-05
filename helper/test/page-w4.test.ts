// W4: what real application forms need, on the helper's side of the page engine. A select whose chosen option is the
// HTML placeholder (value "") is unfilled whatever its label says (Lever's "Click Here (If you encounter an issue...)"),
// a radio group is labelled with its question, and a Yes/No question built from toggle buttons (Ashby) reads as a
// radio group whose answer the executor writes through the one press the page engine makes there. The content
// script's halves run in a real browser in fixtures/web-form/accept.ts. Every name and address here is invented.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { formControls } from "../src/fill/controls.ts";
import { PageEngineLink, toVerbOutcome, toWindowSnapshot } from "../src/engines/page-link.ts";
import { EngineSession } from "../src/engines/session.ts";
import { PageResult, PROTOCOL_VERSION, type HelperToEngine, type PageControl, type PageSnapshot, type PageVerb } from "../src/protocol.ts";

const ORIGIN = "https://jobs.example.test";
const X = "kcmlnoabcdefghijklmnopabcdefghij";
const browser = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
const WIN = "page:eng1:7";
const Q_YEARS = "Do you have a minimum of 7 years of experience building software?";
const Q_AUTH = "Are you legally authorized to work in the country for which you are applying?";

const control = (id: string, kind: PageControl["kind"], name: string, extra: Partial<PageControl> = {}): PageControl => ({
  id, key: `${kind}:${name.toLowerCase()}~${id}`, strongKey: null, kind, role: kind, name, form: null, rect: [0, 0, 100, 20], ...extra,
});

/** One application: a placeholder select, a native radio question without a legend, and a Yes/No toggle question. */
function controls(pressed: { yes: boolean; no: boolean } = { yes: false, no: false }): PageControl[] {
  const sk = JSON.stringify([ORIGIN, "form#application-form", "name=cards[c1][field0]", "radio"]);
  return [
    control("e1", "text", "Full name", { value: "" }),
    control("e2", "select", "How did you hear about us?", {
      options: [
        { value: "", label: "Click Here (If you encounter an issue, make sure your browser is updated)", selected: true },
        { value: "Referral", label: "Referral", selected: false },
        { value: "LinkedIn", label: "LinkedIn", selected: false },
      ],
    }),
    control("e3", "radio", "Yes", { strongKey: sk, form: "form#application-form", checked: false, group: { id: "e3", name: Q_AUTH } }),
    control("e4", "radio", "No", { strongKey: sk, form: "form#application-form", checked: false, group: { id: "e3", name: Q_AUTH } }),
    control("e5", "button", "Yes", { group: { id: "e9", name: Q_YEARS }, pressed: pressed.yes }),
    control("e6", "button", "No", { group: { id: "e9", name: Q_YEARS }, pressed: pressed.no }),
    control("e7", "button", "Submit Application"),
  ];
}

function snapshot(id: string, cs: PageControl[] = controls()): PageSnapshot {
  return {
    type: "pageSnapshot", v: PROTOCOL_VERSION, id, at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Application",
    frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: ORIGIN, path: "/apply", navGen: 1, title: "Application", headings: [], iframes: [], excluded: {}, truncated: false, controls: cs }],
    missing: [],
    focused: null,
  };
}

function rig(cs: () => PageControl[] = () => controls()) {
  const sent: HelperToEngine[] = [];
  const session = new EngineSession({ engine: "eng1", browser, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => {
    sent.push(m);
    queueMicrotask(() => {
      if (m.type !== "pageCommand") return;
      if (m.verb.kind === "pageWalk") session.receive(snapshot(m.id, cs()));
      session.receive({ type: "pageResult", v: 1, id: m.id, at: 1, outcome: "ok", detail: null });
    });
    return true;
  }, 200);
  const model = new ScreenModel();
  const link = new PageEngineLink(session, (s) => model.apply(s));
  const verbs = (): PageVerb[] => sent.flatMap((m) => (m.type === "pageCommand" ? [m.verb] : []));
  return { session, link, model, verbs };
}

const modelOf = (cs: PageControl[]): ScreenModel => {
  const { session } = rig();
  const m = new ScreenModel();
  m.apply(toWindowSnapshot(snapshot("w", cs), session, 1));
  return m;
};

describe("a select whose chosen option has an empty value (I2's queue)", () => {
  it("shows no value, so fill counts it unfilled though its placeholder reads like an answer", () => {
    const w = modelOf(controls()).windows.get(WIN)!;
    expect([...w.nodes.values()].find((n) => n.label === "How did you hear about us?")?.value).toBe("");
    expect(formControls(w).find((c) => c.control === "select")).toMatchObject({ label: "How did you hear about us?", options: ["Referral", "LinkedIn"] });
  });

  it("takes \"\" as what it shows before a write, and as the placeholder an undo writes back", async () => {
    const { link, verbs } = rig();
    await link.run({ kind: "walk", pid: browser.pid, windowId: WIN });
    const key = "f0/select:how did you hear about us?~e2";
    const r = await link.run({ kind: "write", pid: browser.pid, windowId: WIN, key, role: "AXPopUpButton", attribute: "value", expect: "", value: "Referral", taskId: "t1" });
    expect(r.outcome).toBe("ok");
    // The undo of a first pick restores "" (the executor's before), which names the placeholder option.
    const u = await link.run({ kind: "write", pid: browser.pid, windowId: WIN, key, role: "AXPopUpButton", attribute: "value", expect: "", value: "", taskId: "t1" });
    expect(u.outcome).toBe("ok");
    expect(verbs().filter((v) => v.kind === "pageSelect")).toEqual([expect.objectContaining({ expect: "", value: "Referral" }), expect.objectContaining({ expect: "", value: "" })]);
  });
});

describe("a radio group's question (I2's queue)", () => {
  it("groups buttons by the walk's group even when their name looks generated (Lever's cards[<uuid>][field0])", () => {
    const cs = controls().map((c) => (c.kind === "radio" ? { ...c, strongKey: null } : c));
    const w = modelOf(cs).windows.get(WIN)!;
    expect(formControls(w).filter((c) => c.control === "radio").map((c) => [c.label, c.options])).toEqual([[Q_AUTH, ["Yes", "No"]], [Q_YEARS, ["Yes", "No"]]]);
  });

  it("labels the group fill reads, so its hand-off names the question", () => {
    const w = modelOf(controls()).windows.get(WIN)!;
    const radios = formControls(w).filter((c) => c.control === "radio");
    expect(radios.map((c) => [c.label, c.options])).toEqual([[Q_AUTH, ["Yes", "No"]], [Q_YEARS, ["Yes", "No"]]]);
  });
});

describe("a Yes/No question built from toggle buttons (Ashby)", () => {
  const GROUP = "f0/pressgroup:e9";

  it("reads as a radio group holding its answer, checked where pressed, and leaves an answered one out of fill", () => {
    const w = modelOf(controls({ yes: false, no: true })).windows.get(WIN)!;
    expect(w.nodes.get(GROUP)).toMatchObject({ role: "AXGroup", subrole: "AXFieldset", label: Q_YEARS, value: "No", editable: true });
    const kids = [...w.nodes.values()].filter((n) => n.parent === GROUP).map((n) => [n.role, n.label, n.states ?? []]);
    expect(kids).toEqual([["AXRadioButton", "Yes", []], ["AXRadioButton", "No", ["checked"]]]);
    expect(formControls(w).filter((c) => c.control === "radio").map((c) => c.label)).toEqual([Q_AUTH]);
    // Submit stays a plain button.
    expect([...w.nodes.values()].find((n) => n.label === "Submit Application")?.role).toBe("AXButton");
  });

  it("answers a write with one press of the named option, naming the question, then re-walks", async () => {
    const { link, verbs } = rig();
    await link.run({ kind: "walk", pid: browser.pid, windowId: WIN });
    const r = await link.run({ kind: "write", pid: browser.pid, windowId: WIN, key: GROUP, role: "AXGroup", attribute: "value", expect: "", value: "Yes", taskId: "t1" });
    expect(r.outcome).toBe("ok");
    expect(verbs().slice(1)).toEqual([
      { kind: "pageChooseOption", tabId: 7, frameId: 0, documentId: "D0", id: "e5", control: "button", name: "Yes", taskId: "t1", expect: "", value: "Yes", question: Q_YEARS },
      { kind: "pageWalk", tabId: 7 },
    ]);
  });

  it("sends nothing for an option the question lacks, an answer other than expected, or an undo", async () => {
    const { link, verbs } = rig(() => controls({ yes: false, no: true }));
    await link.run({ kind: "walk", pid: browser.pid, windowId: WIN });
    const write = (value: string, expect: string, sameAs?: string) =>
      link.run({ kind: "write", pid: browser.pid, windowId: WIN, key: GROUP, role: "AXGroup", attribute: "value", expect, value, taskId: "t1", ...(sameAs === undefined ? {} : { sameAs }) });
    expect((await write("Maybe", "No")).outcome).toBe("noElement");
    expect((await write("Yes", "")).outcome).toBe("changed");
    expect((await write("", "No", "m1")).outcome).toBe("notSameElement");
    expect(verbs().filter((v) => v.kind !== "pageWalk")).toEqual([]);
  });
});

describe("a Yes/No press after which the page left (B28)", () => {
  const changed = { type: "pageResult" as const, v: 1 as const, id: "x", at: 1, outcome: "failed" as const, detail: "the page changed after the press (navigated), so Caret stopped", pageChanged: ["navigated" as const] };

  it("reaches the executor as axError carrying what changed, so the run stops with the press possibly landed", () => {
    expect(toVerbOutcome(changed)).toMatchObject({ outcome: "axError", pageChanged: ["navigated"] });
    // Without pageChanged a failed press keeps W4's reading, and carries none.
    expect(toVerbOutcome({ ...changed, pageChanged: undefined }).pageChanged).toBeUndefined();
  });

  it("answers the executor at once, with no walk of a page that is leaving (B28 review)", async () => {
    const sent: HelperToEngine[] = [];
    const session = new EngineSession({ engine: "eng1", browser, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => {
      sent.push(m);
      queueMicrotask(() => {
        if (m.type !== "pageCommand") return;
        // The first walk answers; the press answers that the page left; no later walk would be answered.
        if (m.verb.kind === "pageWalk" && sent.filter((x) => x.type === "pageCommand").length === 1) {
          session.receive(snapshot(m.id));
          session.receive({ type: "pageResult", v: 1, id: m.id, at: 1, outcome: "ok", detail: null });
        } else if (m.verb.kind === "pageChooseOption") session.receive({ ...changed, id: m.id });
      });
      return true;
    }, 200);
    const link = new PageEngineLink(session, () => undefined);
    await link.run({ kind: "walk", pid: browser.pid, windowId: WIN });
    const r = await link.run({ kind: "write", pid: browser.pid, windowId: WIN, key: "f0/pressgroup:e9", role: "AXGroup", attribute: "value", expect: "", value: "Yes", taskId: "t1" });
    expect(r).toMatchObject({ outcome: "axError", pageChanged: ["navigated"] });
    expect(sent.flatMap((m) => (m.type === "pageCommand" ? [m.verb.kind] : []))).toEqual(["pageWalk", "pageChooseOption"]);
  });

  it("takes pageChanged only on a failed result with no readings", () => {
    expect(PageResult.safeParse(changed).success).toBe(true);
    expect(PageResult.safeParse({ ...changed, outcome: "ok" }).success).toBe(false);
    expect(PageResult.safeParse({ ...changed, readings: { before: "", afterInput: "Yes", afterBlur: "Yes", invalid: false, error: null } }).success).toBe(false);
    expect(PageResult.safeParse({ ...changed, pageChanged: [] }).success).toBe(false);
  });
});
