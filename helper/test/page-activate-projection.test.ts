// Slice 2: what the walk read about a page row reaches the model — the row's cells as its children, so rowCellParts
// binds the row by them, and inForm with href, so navVerdict decides whose open it is. A walk that reports none of it
// (an older engine, or a non-nav control) leaves the node unqualified: the open stays the user's.
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, PageFrame, type PageSnapshot } from "../src/protocol.ts";
import { EngineSession } from "../src/engines/session.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { X, chrome, hello } from "./fake-page.ts";

const row = (id: string, key: string, name: string, cells: string[], inForm?: boolean, href?: "none" | "hash" | "other") => ({
  id, key, strongKey: null, kind: "row" as const, role: "row" as const, name, form: null, rect: [0, 0, 400, 28] as [number, number, number, number],
  ...(cells.length === 0 ? {} : { cells }), ...(inForm === undefined ? {} : { inForm }), ...(href === undefined ? {} : { href }),
});

function snapshot(controls: ReturnType<typeof row>[], excluded: Record<string, number> = {}): PageSnapshot {
  return {
    type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w", at: 1, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Inbox",
    frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: "http://127.0.0.1:4310", path: "/inbox", navGen: 1, title: "Inbox", headings: [], controls, iframes: [], excluded, truncated: false }],
    missing: [], focused: null,
  };
}

function model(s: PageSnapshot) {
  const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, () => true, 200);
  session.receive(hello);
  session.tabs.set(7, s);
  return toWindowSnapshot(s, session, 1);
}

describe("what the model holds for a walked page row", () => {
  it("projects the row's cells as its own children and carries inForm and href on the row itself", () => {
    const m = model(snapshot([row("r1", "grid/kayak · flight itinerary · 2:10 pm~0", "Kayak · Flight itinerary · 2:10 PM", ["Kayak", "Flight itinerary", "2:10 PM"], false, "none")]));
    const r = m.nodes.find((n) => n.role === "AXRow");
    expect(r).toBeDefined();
    expect(r?.inForm).toBe(false);
    expect(r?.href).toBe("none");
    expect(m.nodes.filter((n) => n.parent === r?.key).map((n) => [n.role, n.label])).toEqual([["AXStaticText", "Kayak"], ["AXStaticText", "Flight itinerary"], ["AXStaticText", "2:10 PM"]]);
  });

  it("leaves a row the walk did not qualify unqualified: no inForm, no href, and no cells projected", () => {
    // An older engine's walk (the fields are optional on the wire) reads as unknown, and navVerdict keeps the open the user's.
    const m = model(snapshot([row("r1", "grid/kayak~0", "Kayak", [])]));
    const r = m.nodes.find((n) => n.role === "AXRow");
    expect(r?.inForm).toBeUndefined();
    expect(r?.href).toBeUndefined();
    expect(m.nodes.filter((n) => n.parent === r?.key)).toEqual([]);
  });

  it("carries a form row's inForm as true, so the open stays the user's, and the cells it did read", () => {
    const m = model(snapshot([row("r1", "form[a]/grid/saved~0", "Saved search: flight itineraries", ["Saved search: flight itineraries"], true)]));
    const r = m.nodes.find((n) => n.role === "AXRow");
    expect(r?.inForm).toBe(true);
    expect(m.nodes.filter((n) => n.parent === r?.key)).toHaveLength(1);
  });

  it("the wire takes the new exclusion reasons, so a walk that keeps out form rows and combobox options parses whole", () => {
    const s = snapshot([row("r1", "grid/kayak~0", "Kayak", ["Kayak"], false, "none")], { formRow: 1, comboboxOption: 2 });
    const f = PageFrame.parse(s.frames[0]);
    expect(f.excluded).toEqual({ formRow: 1, comboboxOption: 2 });
  });
});
