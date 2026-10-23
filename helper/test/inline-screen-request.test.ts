import { describe, expect, it } from "vitest";
import { ScreenTextReply, ScreenTextRequest } from "../src/protocol.ts";
import { answerScreenText as answer } from "../src/inline/screen-request.ts";
import { ScreenModel, type WindowState } from "../src/model.ts";

const answerScreenText = (model: ScreenModel, request: ScreenTextRequest) => answer(model, request, 7);

const request = { type: "screenTextRequest", v: 1, id: "r1", revision: 7, pid: 7, windowNumber: 101, maxCharacters: 2048 } as const;

function focusedModel(): ScreenModel {
  const model = new ScreenModel();
  model.frontmostPid = 7;
  model.focusedWindowId = "reader-window";
  const window: WindowState = {
    app: { pid: 7, bundleId: "dev.test.app", name: "Test" },
    window: { windowId: "reader-window", kind: "standard", title: "Test", frame: null, number: 101 },
    focused: true, focusedKey: null, values: [], updatedAt: 1, lastFocusedAt: 1,
    nodes: new Map([["text", { key: "text", parent: null, role: "AXStaticText", label: "Reply above" }]]),
  };
  model.windows.set("reader-window", window);
  return model;
}

describe("screen text wire messages", () => {
  it("validates request and reply and carries revision", () => {
    expect(ScreenTextRequest.parse(request)).toEqual(request);
    const reply = { type: "screenTextReply", v: 1, id: "r1", revision: 7, text: "Reply above" };
    expect(ScreenTextReply.parse(reply)).toEqual(reply);
  });

  it("preserves the host privacy lists", () => {
    const blocked = { ...request, appsOff: ["dev.test.app"], sitesOff: ["https://off.example"], site: "https://off.example" };
    expect(ScreenTextRequest.parse(blocked)).toEqual(blocked);
  });

  it("rejects invalid headers and a missing or invalid pid", () => {
    for (const invalid of [{ ...request, type: "other" }, { ...request, v: 2 }, { ...request, pid: undefined }, { ...request, pid: 0 }, { ...request, pid: -1 }, { ...request, pid: 7.5 }]) {
      expect(ScreenTextRequest.safeParse(invalid).success).toBe(false);
    }
  });

  it("uses the reader's focused window when its pid matches", () => {
    expect(answerScreenText(focusedModel(), request)).toEqual({ type: "screenTextReply", v: 1, id: "r1", revision: 7, text: "Reply above" });
  });

  it("withholds another window of the same app, even with the same title and frame", () => {
    const model = focusedModel();
    const other = { ...model.windows.get("reader-window")!, window: { windowId: "other-window", kind: "standard", title: "Test", frame: null, number: 102 } };
    model.windows.set("other-window", other);
    model.focusedWindowId = "other-window";
    expect(answerScreenText(model, request).text).toBeNull();
    expect(answerScreenText(model, { ...request, windowNumber: 102 }).text).toBe("Reply above");
  });

  it("withholds text when the reader cannot identify its window", () => {
    const model = focusedModel();
    delete model.windows.get("reader-window")!.window.number;
    expect(answerScreenText(model, request).text).toBeNull();
  });

  it("returns no text when the host pid differs from the focused window", () => {
    const model = focusedModel();
    // Keep the obsolete windowId too: old code must not satisfy this test by finding no window.
    const mismatched = { ...request, pid: 8, windowId: "reader-window" };
    expect(answerScreenText(model, mismatched)).toMatchObject({ text: null });
  });

  it("returns no text without a focused window or after the frontmost app changes", () => {
    const model = focusedModel();
    model.frontmostPid = 8;
    expect(answerScreenText(model, request).text).toBeNull();
    model.frontmostPid = 7;
    model.focusedWindowId = null;
    expect(answerScreenText(model, request).text).toBeNull();
  });

  it("withholds turned-off app and site text after wire decoding", () => {
    const model = focusedModel();
    const appOff = ScreenTextRequest.parse({ ...request, windowId: "reader-window", appsOff: ["dev.test.app"] });
    const siteOff = ScreenTextRequest.parse({ ...request, windowId: "reader-window", sitesOff: ["https://off.example"], site: "https://off.example" });
    expect(answerScreenText(model, appOff).text).toBeNull();
    expect(answerScreenText(model, siteOff).text).toBeNull();
    expect(answerScreenText(model, ScreenTextRequest.parse(request)).text).toBe("Reply above");
  });
});
