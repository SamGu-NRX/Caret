// The fresh review of bbd9126 (INT1, the integration of PV2, SCP1, HA2 and the gate): each finding as it was found.
import { describe, expect, it } from "vitest";
import { ScreenModel, type WindowState } from "../src/model.ts";
import type { Node } from "../src/protocol.ts";
import { Disclosure } from "../src/privacy/disclosure.ts";
import { redactWindow } from "../src/fill/redact.ts";
import { node, snap, text } from "./builders.ts";
import { ownedOf, ownedStale, unitsHolding } from "../src/fill/note-unit.ts";

const SECRET = "API key: Zq7x";

/** A page web area whose section text holds a secret line, by the outline attribute or by the heading list. */
function page(how: "outline" | "headings"): ScreenModel {
  const area: Node =
    how === "outline"
      ? node("wa", "AXWebArea", { label: "Docs", outline: [{ key: "wa#o1", heading: true, text: SECRET }, { key: "wa#o2", heading: true, text: "Setup" }] })
      : node("wa", "AXWebArea", { label: "Docs", headings: [SECRET, "Setup"] });
  const m = new ScreenModel();
  m.apply(snap([area, text("t1", "Open the settings", undefined, "wa")], { at: 1000, windowId: "page", title: "Docs" }));
  return m;
}

describe("INT1 review P1: a secret in a page's section text never reaches plan, held or drafted text", () => {
  for (const how of ["outline", "headings"] as const) {
    it(`through the ${how}`, () => {
      const m = page(how);
      const view = redactWindow(m.windows.get("page") as WindowState);
      // Redaction removes the secret section line.
      expect(JSON.stringify([...view.nodes.values()])).not.toContain("Zq7x");
      const d = new Disclosure(m.windows.values());
      expect(d.planText("Open Zq7x")).toBeNull();
      expect(d.heldText("Open Zq7x")).toBeNull();
      expect(d.draftedText("Open Zq7x")).toBeNull();
      // The kept section and plain words still go.
      expect(d.planText("Open Setup")).toBe("Open Setup");
    });
  }
});

describe("INT1 review P1: ownership units read a page's heading and outline text", () => {
  const card = (outline: string, how: "outline" | "headings" = "outline"): ScreenModel => {
    const area: Node = how === "outline" ? node("wa", "AXWebArea", { label: "Contacts", outline: [{ key: "wa#o1", heading: true, text: outline }] }) : node("wa", "AXWebArea", { label: "Contacts", headings: [outline] });
    const m = new ScreenModel();
    m.apply(snap([area, { ...text("c1", "Contact card", undefined, "wa"), value: "Phone: 555-0388" }], { at: 1000, windowId: "page", title: "Contacts" }));
    return m;
  };

  for (const how of ["outline", "headings"] as const) {
    it(`a unit shows the ${how}'s disclaimer, and a redacted ${how} line makes it incomplete with a new digest`, () => {
      const said = unitsHolding(card("Neither contact line is mine.", how), "555-0388", "form", null);
      expect(said).toHaveLength(1);
      expect(said?.[0]?.text).toContain("Neither contact line is mine.");
      expect(said?.[0]?.complete).toBe(true);
      const cut = unitsHolding(card("API key note: Zq7x-Kw2", how), "555-0388", "form", null);
      expect(cut?.[0]?.text).not.toContain("Zq7x");
      expect(cut?.[0]?.complete).toBe(false);
      expect(cut?.[0]?.digest).not.toBe(said?.[0]?.digest);
    });
  }

  it("a value admitted on the disclaimed note is stale once the outline changes to a redacted line", () => {
    const before = card("Neither contact line is mine.");
    const units = unitsHolding(before, "555-0388", "form", { windowId: "page", nodeKey: "c1" }) ?? [];
    const owned = ownedOf("form", units);
    expect(ownedStale(before, "555-0388", { windowId: "page", nodeKey: "c1" }, owned)).toBeNull();
    expect(ownedStale(card("API key note: Zq7x-Kw2"), "555-0388", { windowId: "page", nodeKey: "c1" }, owned)).not.toBeNull();
  });

  it("finds a duplicate source whose only copy of the value is in its section text", () => {
    const m = card("Neither contact line is mine.");
    m.apply(snap([node("wb", "AXWebArea", { label: "Other", headings: ["Call 555-0388 for Ana"] })], { at: 1000, windowId: "other", title: "Other" }));
    const units = unitsHolding(m, "555-0388", "form", null) ?? [];
    expect(units.map((u) => u.windowId).sort()).toEqual(["other", "page"]);
  });
});
