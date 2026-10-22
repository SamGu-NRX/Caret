import { describe, expect, it } from "vitest";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { admittedScreenText } from "../src/inline/screen-context.ts";

const app = { pid: 7, bundleId: "dev.test.app", name: "Test" };
const win = (nodes: WindowState["nodes"]): WindowState => ({
  app, window: { windowId: "7-1", kind: "standard", title: "Test", frame: null }, focused: true,
  nodes, values: [], focusedKey: "field", updatedAt: 1, lastFocusedAt: 1,
});

describe("admitted inline screen text", () => {
  it("returns nearby static text and excludes secure, unread, editable and bounded values", () => {
    const m = new ScreenModel();
    m.frontmostPid = 7;
    m.focusedWindowId = "7-1";
    m.windows.set("7-1", win(new Map([
      ["field", { key: "field", parent: null, role: "AXTextField", frame: [100, 100, 200, 30], editable: true }],
      ["ok", { key: "ok", parent: null, role: "AXStaticText", label: "Reply from Dana", frame: [100, 140, 200, 30] }],
      ["secure", { key: "secure", parent: null, role: "AXStaticText", label: "password", excluded: "secure", frame: [100, 180, 200, 30] }],
      ["unread", { key: "unread", parent: null, role: "AXStaticText", label: "private", unread: true, frame: [100, 220, 200, 30] }],
      ["web", { key: "web", parent: null, role: "AXStaticText", label: "typed page value", editable: true, rev: 1, frame: [100, 260, 200, 30] }],
    ])));
    expect(admittedScreenText(m)).toBe("Reply from Dana");
  });

  it("does not return text for turned-off apps or sites", () => {
    const m = new ScreenModel();
    m.frontmostPid = 7;
    m.focusedWindowId = "7-1";
    m.windows.set("7-1", win(new Map([["ok", { key: "ok", parent: null, role: "AXStaticText", label: "private app text" }]])));
    expect(admittedScreenText(m, "7-1", 2048, ["dev.test."])).toBeNull();
    expect(admittedScreenText(m, "7-1", 2048, [], ["https://off.example"], "https://off.example")).toBeNull();
  });

  it("bounds output and returns nothing for an unknown window", () => {
    const m = new ScreenModel();
    expect(admittedScreenText(m, "missing")).toBeNull();
  });
});
