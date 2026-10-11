import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { snap } from "./builders.ts";

const focus = (model: ScreenModel, windowId: string, at: number) => model.apply(snap([], { windowId, at, focused: true }));
const current = (model: ScreenModel) => model.userWindow()?.window.windowId;

describe("focus timestamp ties", () => {
  it("follows A/B/A focus arrival order, including a refocus of an existing window", () => {
    const model = new ScreenModel();
    focus(model, "A", 1000);
    focus(model, "B", 1000);
    expect(current(model)).toBe("B");
    focus(model, "A", 1000);
    expect(current(model)).toBe("A");
  });

  it("does not let a non-focus update change the tie winner", () => {
    const model = new ScreenModel();
    focus(model, "A", 1000);
    focus(model, "B", 1000);
    focus(model, "A", 1000);
    model.apply(snap([], { windowId: "B", at: 2000, focused: false }));
    model.apply(snap([], { windowId: "C", at: 3000, focused: false }));
    expect(current(model)).toBe("A");
  });

  it("keeps the focus timestamp primary when an older focus arrives later", () => {
    const model = new ScreenModel();
    focus(model, "A", 2000);
    focus(model, "B", 1000);
    expect(current(model)).toBe("A");
    focus(model, "B", 2000);
    expect(current(model)).toBe("B");
  });

  it("preserves arrival order in a model view without sharing its counter", () => {
    const model = new ScreenModel();
    focus(model, "A", 1000);
    focus(model, "B", 1000);
    focus(model, "A", 1000);
    const view = model.withNodes(new Map());
    expect(current(view)).toBe("A");
    focus(model, "B", 1000);
    expect(current(model)).toBe("B");
    expect(current(view)).toBe("A");
    focus(view, "B", 1000);
    expect(current(view)).toBe("B");
  });

  it("forgets focus order for closed windows and a reset session", () => {
    const model = new ScreenModel();
    focus(model, "A", 1000);
    focus(model, "B", 1000);
    model.close("B", 1001);
    model.apply(snap([], { windowId: "B", at: 2000, focused: false }));
    expect(current(model)).toBe("A");
    model.reset();
    focus(model, "B", 1000);
    focus(model, "A", 1000);
    expect(current(model)).toBe("A");
  });
});
