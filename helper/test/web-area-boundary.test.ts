// What the native side's reads put in the helper for a browser page (docs/research/web-area-reads.md).
//
// A synthetic snapshot exactly as the screen reader sends it for a browser window: an AXWebArea
// holding page fields. The model, the privacy admission rules, the ledger's inventory and the
// protocol schema run for real on it. Everything here is invented.
//
// The passing tests pin today's behaviour. The `it.fails` tests state the proposed rule —
// "text-control values under an AXWebArea never reach the helper; the focused field's caret
// text is for inline writing only" (docs/research/web-area-reads.md) — which does not hold
// today, so each fails now. The same change that implements the rule removes `.fails` from
// these four and they become its regression tests.
import { describe, expect, it } from "vitest";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { TextPageControl, type Node } from "../src/protocol.ts";
import { admitValues, excludedValue } from "../src/privacy/exclude.ts";
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

describe("native reads under an AXWebArea, as they reach the helper today", () => {
  const { win } = browserWindow();

  it("the model keeps a revealed-password field's value under an AXWebArea", () => {
    expect(win.nodes.get("w1/pw")?.excluded).toBeUndefined();
    expect(win.nodes.get("w1/pw")?.value).toBe(PASSWORD);
  });

  it("the model keeps every other page field's value too", () => {
    expect(win.nodes.get("w1/name")?.value).toBe(NAME);
    expect(win.nodes.get("w1/email")?.value).toBe(EMAIL);
  });

  it("the admission rules withhold nothing from the revealed password's plain text", () => {
    // Not secure, no page-walker mark, no label naming a secret kind, no secret-shaped value:
    // nothing the SC1 rules can catch, which is why the value rides through.
    expect(excludedValue(PASSWORD)).toBeNull();
  });

  it("the reader-sent typed values are admitted for web-area nodes", () => {
    expect(admitValues(win.values as never, win.nodes)).toEqual(win.values);
    expect(win.values).toEqual([typed("email", EMAIL, "w1/email")]);
  });

  it("the ledger's inventory holds the page field's value as request-quotable text", () => {
    // partsOf is what the privacy ledger counts and what request builders quote spans of.
    const parts = partsOf(win);
    expect(parts).toContainEqual({ id: nodePart("w1/pw", "value"), raw: PASSWORD });
    expect(parts).toContainEqual({ id: nodePart("w1/email", "value"), raw: EMAIL });
  });
});

describe("the rule: text-control values under an AXWebArea never reach the helper", () => {
  const { win } = browserWindow();

  it("a non-focused page field's value is absent from the model", () => {
    expect(win.nodes.get("w1/pw")?.value).toBeUndefined();
  });

  it("the focused field's caret text reaches the model only for inline writing, never as a node value", () => {
    expect(win.nodes.get("w1/email")?.value).toBeUndefined();
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
