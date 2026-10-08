// The fresh review of bbd9126 (INT1, the integration of PV2, SCP1, HA2 and the gate): each finding as it was found.
import { describe, expect, it } from "vitest";
import { ScreenModel, type WindowState } from "../src/model.ts";
import type { Node } from "../src/protocol.ts";
import { Disclosure } from "../src/privacy/disclosure.ts";
import { redactWindow } from "../src/fill/redact.ts";
import { node, snap, text } from "./builders.ts";
import { ownedOf, ownedStale, unitsHolding } from "../src/fill/note-unit.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DailySpend, localDay } from "../src/engines/decide/daily-cap.ts";
import { SyncedStorePath } from "../src/privacy/store-path.ts";

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

describe("INT1 review 2 P1: a container labelled for a secret takes everything under it", () => {
  const SECRET = "violet-orchard-seven";
  const group = (label: string): Node => node("g", "AXGroup", { label });
  const child = (extra: Partial<Node>): Node => ({ ...node("c", "AXStaticText", extra), parent: "g" });
  const textOf = (m: ScreenModel): string => JSON.stringify([...(m.windows.get("w")?.nodes.values() ?? [])]);

  it("readmits the kept descendants when a truncated snapshot renames the container to a secret's kind", () => {
    const m = new ScreenModel();
    m.apply(snap([group("Details"), child({ value: SECRET })], { at: 1000, windowId: "w", title: "Notes" }));
    expect(textOf(m)).toContain(SECRET);
    // A cut walk that reaches only the container, now labelled "Password", with no value of its own.
    m.apply({ ...snap([group("Password")], { at: 2000, windowId: "w", title: "Notes" }), stats: { walkMs: 5, visited: 1, truncated: true } });
    expect(textOf(m)).not.toContain(SECRET);
    expect(m.windows.get("w")?.nodes.get("c")?.excluded).toBe("password");
  });

  it("drops a descendant's content-bearing label, not only its value", () => {
    const m = new ScreenModel();
    m.apply(snap([group("Password"), child({ label: SECRET })], { at: 1000, windowId: "w", title: "Notes" }));
    expect(textOf(m)).not.toContain(SECRET);
    // With the marker heuristics off too (SC1 step 3's switch): the structural rule alone keeps it out.
    const was = process.env.CARET_TEST_MARKERS_OFF;
    process.env.CARET_TEST_MARKERS_OFF = "1";
    try {
      const m2 = new ScreenModel();
      m2.apply(snap([group("Password"), child({ label: SECRET })], { at: 1000, windowId: "w2", title: "Notes" }));
      const d = new Disclosure(m2.windows.values());
      expect(d.candidate(redactWindow(m2.windows.get("w2") as WindowState), SECRET)).toBeNull();
    } finally {
      if (was === undefined) delete process.env.CARET_TEST_MARKERS_OFF;
      else process.env.CARET_TEST_MARKERS_OFF = was;
    }
  });

  it("drops a descendant's placeholder, heading list and outline text too", () => {
    const m = new ScreenModel();
    m.apply(snap([group("Password"), { ...node("p", "AXWebArea", { placeholder: SECRET, headings: [SECRET], outline: [{ key: "p#o1", heading: true, text: SECRET }] }), parent: "g" }], { at: 1000, windowId: "w", title: "Notes" }));
    expect(textOf(m)).not.toContain(SECRET);
  });
});

describe("INT1 review 3", () => {
  it("the spend log refuses a day file that is a symbolic link, and leaves its target unchanged", () => {
    const base = mkdtempSync(join(tmpdir(), "spend-link-"));
    try {
      const now = new Date("2026-10-08T12:00:00");
      const target = join(base, "elsewhere.ndjson");
      writeFileSync(target, "");
      const dir = join(base, "spend");
      mkdirSync(dir);
      symlinkSync(target, join(dir, `${localDay(now)}.ndjson`));
      const spend = new DailySpend({ dir, capUsd: 1, now: () => now });
      expect(() => spend.reserve(0.01).settle(0.01, 1)).toThrow(SyncedStorePath);
      expect(readFileSync(target, "utf8")).toBe("");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

});
