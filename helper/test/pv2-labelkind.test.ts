// The coordinator's structural step after SC1 step 3's evidence: a node whose own label names a sensitive kind is
// excluded when the window is read in if it holds a value (a value, a typed value or a placeholder), whatever its role,
// not only an editable control; and a container labelled for a secret excludes what it holds. These hold with the marker
// heuristics on or off: they are the model's, before any view.
import { describe, expect, it } from "vitest";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { node, snap } from "./builders.ts";

const SECRET = "violet-orchard-seven";
const read = (nodes: Parameters<typeof snap>[0], values: Parameters<typeof snap>[1]["values"] = []): WindowState => {
  const m = new ScreenModel();
  m.apply(snap(nodes, { at: 1000, windowId: "w", values }));
  return m.windows.get("w") as WindowState;
};

describe("a value-holding node whose own label names a sensitive kind", () => {
  it("is excluded whatever its role: a cell, a static text with a value, a placeholder", () => {
    const w = read([node("cell", "AXCell", { label: "Password", value: SECRET }), node("st", "AXStaticText", { label: "Card number", value: "Visa ending 0002" }), node("ph", "AXGroup", { label: "PIN", placeholder: "4 digits" })]);
    expect(w.nodes.get("cell")?.excluded).toBeDefined();
    expect(w.nodes.get("cell")?.value).toBeUndefined();
    expect(w.nodes.get("st")?.excluded).toBeDefined();
    expect(w.nodes.get("st")?.value).toBeUndefined();
    expect(w.nodes.get("ph")?.excluded).toBeDefined();
  });

  it("is excluded when it holds a typed value, and the typed value goes", () => {
    const w = read([node("t", "AXGroup", { label: "Security code" })], [{ kind: "number" as never, text: "812", nodeKey: "t" } as never]);
    expect(w.nodes.get("t")?.excluded).toBeDefined();
    expect(w.values).toEqual([]);
  });

  it("leaves a label that holds nothing, and a label that names no kind", () => {
    const w = read([node("l", "AXStaticText", { label: "Password" }), node("h", "AXCell", { label: "Password hint", value: "my cat" })]);
    expect(w.nodes.get("l")?.excluded).toBeUndefined();
    expect(w.nodes.get("l")?.label).toBe("Password");
    expect(w.nodes.get("h")?.excluded).toBeUndefined();
    expect(w.nodes.get("h")?.value).toBe("my cat");
  });
});

describe("a container labelled for a secret", () => {
  it("excludes the value-holding nodes under it, however deep and whatever lies between", () => {
    const w = read([node("g", "AXGroup", { label: "Password" }), node("s", "AXScrollArea", { parent: "g" }), node("v", "AXStaticText", { parent: "s", label: "Current", value: SECRET })]);
    expect(w.nodes.get("v")?.value).toBeUndefined();
    expect(w.nodes.get("v")?.excluded).toBeDefined();
  });

  it("is not a page or a window titled with a kind: their title names no field", () => {
    const w = read([node("p", "AXWebArea", { label: "Change password" }), node("f", "AXStaticText", { parent: "p", label: "Email", value: "robin@example.test" })]);
    expect(w.nodes.get("f")?.value).toBe("robin@example.test");
  });
});
