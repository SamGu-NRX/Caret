// H10's ⌘1 "source is gone": the reader walks depth first and stops at its deadline (Walker.swift), then sends the
// nodes it reached as a full snapshot (root null) with stats.truncated. A cut walk must not drop what it never reached.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import type { Snapshot } from "../src/protocol.ts";
import { field, node, snap, text, value } from "./builders.ts";

const W = "w-note";

function full(at: number): Snapshot {
  return snap(
    [
      node("toolbar", "AXToolbar"),
      node("toolbar/bold", "AXButton", { parent: "toolbar", label: "Bold" }),
      node("scroll", "AXScrollArea"),
      field("scroll/text", "Order ORD-7731 ships Friday", { parent: "scroll", role: "AXTextArea" }),
      text("status", "Saved"),
    ],
    { at, windowId: W, title: "Note", focused: true, focusedKey: "scroll/text", values: [value("id", "ORD-7731", "scroll/text")] },
  );
}

function cut(nodes: Snapshot["nodes"], at: number, o: { focusedKey?: string | null } = {}): Snapshot {
  const s = snap(nodes, { at, windowId: W, title: "Note", focused: true, focusedKey: o.focusedKey ?? null });
  return { ...s, stats: { ...s.stats, truncated: true } };
}

describe("a reader walk cut short (H10)", () => {
  it("keeps the nodes it did not reach, and their typed values", () => {
    const m = new ScreenModel();
    m.apply(full(1000));
    // The deadline hit inside the toolbar: the text area, its scroll area and the status line were never read.
    const changes = m.apply(cut([node("toolbar", "AXToolbar"), node("toolbar/bold", "AXButton", { parent: "toolbar", label: "Bold" })], 2000));
    const w = m.windows.get(W);
    expect([...(w?.nodes.keys() ?? [])]).toEqual(["toolbar", "toolbar/bold", "scroll", "scroll/text", "status"]);
    expect(w?.nodes.get("scroll/text")?.value).toBe("Order ORD-7731 ships Friday");
    expect(w?.values.map((v) => v.text)).toEqual(["ORD-7731"]);
    expect(w?.focusedKey).toBe("scroll/text");
    expect(changes.filter((c) => c.kind === "removed")).toEqual([]);
  });

  it("drops a node the walk passed without seeing, and takes the new text of what it reached", () => {
    const m = new ScreenModel();
    m.apply(full(1000));
    // The walk reached the text area (so it passed the bold button, which is gone) and was cut before the status line.
    const changes = m.apply(
      cut(
        [node("toolbar", "AXToolbar"), node("scroll", "AXScrollArea"), field("scroll/text", "Order ORD-7731 ships Monday", { parent: "scroll", role: "AXTextArea" })],
        2000,
      ),
    );
    const w = m.windows.get(W);
    expect([...(w?.nodes.keys() ?? [])]).toEqual(["toolbar", "scroll", "scroll/text", "status"]);
    expect(w?.nodes.get("scroll/text")?.value).toBe("Order ORD-7731 ships Monday");
    expect(changes.map((c) => `${c.kind}:${c.key}`).sort()).toEqual(["removed:toolbar/bold", "value:scroll/text"]);
  });

  it("keeps the whole window when the cut walk reached nothing it knew", () => {
    const m = new ScreenModel();
    m.apply(full(1000));
    m.apply(cut([], 2000));
    expect(m.windows.get(W)?.nodes.size).toBe(5);
  });

  it("still replaces the window on a complete walk", () => {
    const m = new ScreenModel();
    m.apply(full(1000));
    m.apply(snap([node("toolbar", "AXToolbar")], { at: 2000, windowId: W, title: "Note", focused: true }));
    expect([...(m.windows.get(W)?.nodes.keys() ?? [])]).toEqual(["toolbar"]);
  });

  it("replaces a page whole even when its walk is cut: a page's walk is per frame, and a new document shares no nodes with the old", () => {
    const m = new ScreenModel();
    const page = (nodes: Snapshot["nodes"], at: number, truncated: boolean): Snapshot => {
      const s = snap(nodes, { at, windowId: "page-1", kind: "page" });
      return { ...s, stats: { ...s.stats, truncated } };
    };
    m.apply(page([field("f0/name", ""), field("f0/email", "")], 1000, false));
    m.apply(page([field("f0/school", "")], 2000, true));
    expect([...(m.windows.get("page-1")?.nodes.keys() ?? [])]).toEqual(["f0/school"]);
  });
});
