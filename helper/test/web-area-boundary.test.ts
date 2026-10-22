// What the native side's reads put in the helper for a browser page (docs/research/web-area-reads.md).
//
// A synthetic snapshot exactly as the screen reader sends it for a browser window: an AXWebArea
// holding page fields. The model, the privacy admission rules, the ledger's inventory and the
// protocol schema run for real on it. Everything here is invented.
//
// Native page text-entry values stay withheld, including revealed passwords and dates.
// Choice values and the page engine's own revision-checked writes keep their existing contract.
import { describe, expect, it, vi } from "vitest";
import * as privacy from "../src/privacy/exclude.ts";
import { PrivacyAdmissionError, ScreenModel, type WindowState } from "../src/model.ts";
import { TextPageControl, type Node } from "../src/protocol.ts";
import { admitNode, admitValues, excludedValue } from "../src/privacy/exclude.ts";
import { nodePart, partsOf } from "../src/privacy/ledger/source.ts";
import { field, node, snap, value as typed, FIXTURE_APP } from "./builders.ts";

const BROWSER = { pid: 7770, bundleId: "dev.caret.fixture.browser", name: "Browser Fixture" };
// A password a "show password" button revealed: role AXTextField, no secure state, and no
// accessible label that names a secret (an icon label, another language, "Sign-in details").
const PASSWORD = "valley lantern observed praise";
const NAME = "Dana Ortiz";
const EMAIL = "dana.ortiz@example.com";

function browserWindow(): { model: ScreenModel; win: WindowState } {
  const web: Node = node("w1", "AXWebArea", { label: "Sign in — Lumen Bank (fixture)" });
  const nodes = [
    web,
    field("w1/name", NAME, { parent: "w1", label: "Full name" }),
    field("w1/pw", PASSWORD, { parent: "w1" }),
    field("w1/email", EMAIL, { parent: "w1", label: "Email" }),
  ];
  const model = new ScreenModel();
  model.apply(
    snap(nodes, {
      at: 1,
      windowId: "browser-1",
      title: "Sign in — Lumen Bank (fixture)",
      app: BROWSER,
      focused: true,
      focusedKey: "w1/email",
      values: [typed("email", EMAIL, "w1/email")],
    }),
  );
  const win = model.windows.get("browser-1") as WindowState;
  return { model, win };
}

describe("native reads under an AXWebArea", () => {
  const { win } = browserWindow();

  it("the model marks filled page text controls as held without keeping their values", () => {
    for (const key of ["w1/name", "w1/pw", "w1/email"]) {
      expect(win.nodes.get(key)?.value).toBeUndefined();
      expect(win.nodes.get(key)?.unread).toBe(true);
    }
  });

  it("the admission rules do not retain a revealed password's plain text", () => {
    // The value is neither secret-shaped nor labelled sensitive; the explicit unread marker is the backstop.
    expect(excludedValue(PASSWORD)).toBeNull();
    expect(win.nodes.get("w1/pw")?.unread).toBe(true);
  });

  it("the reader-sent typed values are withheld for web-area text controls", () => {
    expect(admitValues(win.values as never, win.nodes)).toEqual([]);
    expect(win.values).toEqual([]);
  });

  it("the ledger inventory has no page-field value to quote", () => {
    // partsOf is what the privacy ledger counts and what request builders quote spans of.
    const parts = partsOf(win);
    expect(parts).not.toContainEqual({ id: nodePart("w1/pw", "value"), raw: PASSWORD });
    expect(parts).not.toContainEqual({ id: nodePart("w1/email", "value"), raw: EMAIL });
  });
});

describe("the rule: text-control values under an AXWebArea never reach the helper", () => {
  const { win } = browserWindow();

  it("a non-focused page field's value is absent from the model", () => {
    expect(win.nodes.get("w1/pw")?.value).toBeUndefined();
  });

  it("the focused field's caret text reaches the model only for inline writing, never as a node value", () => {
    expect(win.nodes.get("w1/email")?.value).toBeUndefined();
    expect(win.nodes.get("w1/email")?.unread).toBe(true);
  });

  it("no typed value is admitted from a web-area text field", () => {
    expect(admitValues(win.values as never, win.nodes)).toEqual([]);
  });

  it("the window's request-quotable parts hold no page field value", () => {
    const parts = partsOf(win).map((p) => p.id);
    expect(parts).not.toContain(nodePart("w1/pw", "value"));
    expect(parts).not.toContain(nodePart("w1/email", "value"));
  });
});

describe("web-area admission converges and preserves choices", () => {
  it.each(["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXDateField"])("withholds %s values and admits an unread node without changing it again", (role) => {
    const input = node("entry", role, { parent: "web", value: PASSWORD });
    const admitted = admitNode(input, { webArea: true });
    expect(admitted.value).toBeUndefined();
    expect(admitted.unread).toBe(true);
    expect(admitNode(admitted, { webArea: true })).toBe(admitted);
    const nodes = new Map([node("web", "AXWebArea"), input].map((n) => [n.key, n]));
    expect(admitValues([typed("email", EMAIL, "entry")], nodes)).toEqual([]);
  });

  it.each(["AXCheckBox", "AXRadioButton", "AXGroup", "AXPopUpButton", "AXStaticText"])("keeps %s values and typed values even when marked editable", (role) => {
    const input = node("choice", role, { parent: "web", value: EMAIL, editable: true });
    const values = [typed("email", EMAIL, "choice")];
    const model = new ScreenModel();
    model.apply(snap([node("web", "AXWebArea"), input], { at: 1, windowId: "choices", values }));
    const win = [...model.windows.values()][0]!;
    expect(win.nodes.get("choice")).toEqual(input);
    expect(win.values).toEqual(values);
  });

  it("keeps an empty text target available instead of marking it hidden", () => {
    const input = field("entry", "", { parent: "web" });
    expect(admitNode(input, { webArea: true })).toBe(input);
  });

  it("refuses a non-converging admission rule by name without publishing the snapshot", () => {
    const model = new ScreenModel();
    const actual = privacy.admitNode;
    const spy = vi.spyOn(privacy, "admitNode").mockImplementation((...args) => ({ ...actual(...args) }));
    try {
      expect(() => model.apply(snap([
        node("web", "AXWebArea"),
        field("entry", PASSWORD, { parent: "web" }),
        field("secret", "", { parent: "web", states: ["secure"] }),
      ], { at: 1, windowId: "refused" }))).toThrow(PrivacyAdmissionError);
      expect(new PrivacyAdmissionError().why).toBe("privacyAdmissionDidNotConverge");
      expect(model.windows.has("refused")).toBe(false);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(15);
    } finally {
      spy.mockRestore();
    }
  });

  it("converges with an unread field beside an excluded field", () => {
    const model = new ScreenModel();
    model.apply(snap([
      node("web", "AXWebArea"),
      field("entry", PASSWORD, { parent: "web" }),
      field("secret", "", { parent: "web", states: ["secure"] }),
    ], { at: 1, windowId: "mixed" }));
    const win = [...model.windows.values()][0]!;
    expect(win.nodes.get("entry")).toMatchObject({ unread: true });
    expect(win.nodes.get("entry")?.value).toBeUndefined();
    expect(win.nodes.get("secret")).toMatchObject({ excluded: "secure" });
  });
});

describe("the schema asymmetry the boundary rests on", () => {
  it("a page text control still refuses a value, while a native Node carries one", () => {
    // The extension side after #52: hasValue and rev, never text.
    const page = { id: "e1", key: "k1", strongKey: null, role: "textbox", name: "Email", form: null, rect: [0, 0, 10, 10] as [number, number, number, number], kind: "text" as const, hasValue: true, rev: 1 };
    expect(TextPageControl.safeParse(page).success).toBe(true);
    const refused = TextPageControl.safeParse({ ...page, value: EMAIL });
    expect(refused.success).toBe(false);
    expect(refused.success === false ? refused.error.issues[0]?.message : "").toContain("never leaves the page");
    // The native side: the same value on a Node parses, which is the hole the rule closes.
    expect(snap([field("w1/email", EMAIL, { parent: "w1", label: "Email" })], { at: 1, windowId: "w", app: FIXTURE_APP })).toBeDefined();
  });
});
