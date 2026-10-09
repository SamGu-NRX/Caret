// Slice 2: which cells name a row (goals/identity.ts), the two navigation end states over a window, and who makes a
// navigation (goals/capabilities.ts navVerdict). Each has one right answer, so each is tested on its own.
import { describe, expect, test } from "vitest";
import { allowedNavigateEffects, navVerdict, type NavTarget } from "../src/goals/capabilities.ts";
import { identityOf, itemOpened, normalizeCell, rowCells, rowSelected, textsByKey, timeShaped } from "../src/goals/identity.ts";
import type { WindowState } from "../src/model.ts";
import type { Node } from "../src/protocol.ts";

describe("identity cells", () => {
  test.each(["3m ago", "2 hours ago", "9:41 AM", "9:41 am", "10/08/2026", "2026-10-08", "12:05", "Today", "yesterday", "Mon", "Thursday", "Oct", "Sept.", "december"])("'%s' is time-shaped and never anchors", (c) => {
    expect(timeShaped(c)).toBe(true);
  });

  test.each(["Kayak", "Flight itinerary", "Oct 8", "Dana Whitfield", "Case 4471 update", "May I ask"])("'%s' is not time-shaped", (c) => {
    expect(timeShaped(c)).toBe(false);
  });

  test("a cell is trimmed, its spaces collapsed and a trailing ellipsis dropped", () => {
    expect(normalizeCell("  Your flight to   SFO dep… ")).toBe("Your flight to SFO dep");
    expect(normalizeCell("Your flight to SFO dep...")).toBe("Your flight to SFO dep");
  });

  test("the sender and subject anchor; a time and a short cell do not", () => {
    expect(identityOf(["Kayak", "Flight itinerary", "3m ago"])).toEqual({ cells: ["Kayak", "Flight itinerary", "3m ago"], anchors: [0, 1] });
    expect(identityOf(["Re", "Dana Whitfield", "Yesterday"])).toEqual({ cells: ["Re", "Dana Whitfield", "Yesterday"], anchors: [1] });
  });

  test("a row with no cell a detail could repeat has no identity", () => {
    expect(identityOf(["3m ago", "!"])).toBeNull();
    expect(identityOf([])).toBeNull();
  });
});

// A mail window: a table of two rows (cells under each), and a detail pane outside it.
const K = (s: string): string => `dev.caret.mailfixture/standard/${s}`;
function mail(o: { selected?: string[]; detail?: string[]; decoyDetail?: boolean } = {}): WindowState {
  const nodes: Node[] = [{ key: K("table:messages~0"), parent: null, role: "AXTable", label: "Messages" }];
  const row = (id: string, cells: string[]): void => {
    nodes.push({ key: K(`row:${id}`), parent: K("table:messages~0"), role: "AXRow", ...(o.selected?.includes(id) === true ? { states: ["selected" as const] } : {}) });
    cells.forEach((c, i) => {
      nodes.push({ key: K(`row:${id}/cell~${i}`), parent: K(`row:${id}`), role: "AXCell" });
      nodes.push({ key: K(`row:${id}/cell~${i}/text`), parent: K(`row:${id}/cell~${i}`), role: "AXStaticText", label: c });
    });
  };
  row("kayak", ["Kayak", "Flight itinerary", "3m ago"]);
  row("dana", ["Dana Whitfield", "Flight itinerary", "9:41 AM"]);
  for (const [i, t] of (o.detail ?? []).entries()) nodes.push({ key: K(`group:message/text~${i}`), parent: null, role: "AXStaticText", label: t });
  nodes.push({ key: K("group:message/textarea:reply~0"), parent: null, role: "AXTextArea", label: "Reply", editable: true, value: "Kayak Flight itinerary" });
  return { app: { pid: 1, bundleId: "dev.caret.mailfixture", name: "Mail" }, window: { windowId: "1-1", title: "Inbox", kind: "standard", frame: null } as WindowState["window"], focused: true, nodes: new Map(nodes.map((n) => [n.key, n])), values: [], focusedKey: null, updatedAt: 0, lastFocusedAt: 0 };
}
const KAYAK = { cells: ["Kayak", "Flight itinerary", "3m ago"], anchors: [0, 1] };

describe("itemOpened", () => {
  test("never holds on the list's own cells, nor on an editable field's text", () => {
    expect(itemOpened(mail(), KAYAK)).toBe(false);
  });

  test("holds when every anchor is in some detail node", () => {
    expect(itemOpened(mail({ detail: ["From: Kayak <no-reply@kayak.example>", "Subject: Flight itinerary", "Confirmation number: QX7R2P"] }), KAYAK)).toBe(true);
  });

  test("does not hold for the other sender's message of the same subject", () => {
    expect(itemOpened(mail({ detail: ["From: Dana Whitfield", "Subject: Flight itinerary"] }), KAYAK)).toBe(false);
  });

  test("matches an anchor by its first 24 characters only", () => {
    const long = { cells: ["Your flight to SFO departs Oct 14 at 7:05"], anchors: [0] };
    expect(itemOpened(mail({ detail: ["Your flight to SFO departs Oct 14 at 7:05 AM from gate B3"] }), long)).toBe(true);
    expect(itemOpened(mail({ detail: ["Your flight to SFO depart"] }), long)).toBe(true);
    expect(itemOpened(mail({ detail: ["Your flight to SFO dep"] }), long)).toBe(false);
  });

  test("an anchor matched only as part of another row's longer anchor does not count for this row", () => {
    // The old booking's date is an anchor its detail need not show: what decides is the longer subject.
    const dana = { cells: ["Dana Whitfield", "Flight itinerary", "9:41 AM"], anchors: [0, 1], others: [["Kayak", "Flight itinerary"], ["Dana Whitfield", "Flight itinerary (old)", "Oct 2"]] };
    expect(itemOpened(mail({ detail: ["From: Dana Whitfield", "Subject: Flight itinerary"] }), dana)).toBe(true);
    expect(itemOpened(mail({ detail: ["From: Dana Whitfield", "Subject: Flight itinerary (old)"] }), dana)).toBe(false);
    // Another row's anchors shown beside this row's (Kayak, mentioned in Dana's message) leave the detail Dana's.
    expect(itemOpened(mail({ detail: ["From: Dana Whitfield", "Subject: Flight itinerary", "Is this the Kayak booking?"] }), dana)).toBe(true);
  });

  test("the strong form counts only nodes new or changed since the read before the act", () => {
    const before = mail({ detail: ["From: Kayak", "Subject: Flight itinerary"] });
    expect(itemOpened(before, KAYAK, textsByKey(before))).toBe(false);
    const after = mail({ detail: ["From: Kayak <no-reply@kayak.example>", "Subject: Flight itinerary (re-sent)"] });
    expect(itemOpened(after, KAYAK, textsByKey(before))).toBe(true);
  });
});

describe("rowSelected", () => {
  test("holds for the exact row alone selected in its table", () => {
    expect(rowSelected(mail({ selected: ["kayak"] }), K("table:messages~0"), K("row:kayak"), "AXRow")).toBe(true);
  });

  test("does not hold when another row of the table is selected too, or the row is not", () => {
    expect(rowSelected(mail({ selected: ["kayak", "dana"] }), K("table:messages~0"), K("row:kayak"), "AXRow")).toBe(false);
    expect(rowSelected(mail({ selected: ["dana"] }), K("table:messages~0"), K("row:kayak"), "AXRow")).toBe(false);
  });

  test("does not hold for a node of another role at the row's key", () => {
    expect(rowSelected(mail({ selected: ["kayak"] }), K("table:messages~0"), K("row:kayak"), "AXCell")).toBe(false);
  });
});

test("a row's cells are its texts once each, in order", () => {
  expect(rowCells(mail(), K("row:kayak"))).toEqual(["Kayak", "Flight itinerary", "3m ago"]);
});

describe("navVerdict", () => {
  const native: NavTarget = { kind: "AXRow", page: false, label: "Kayak · Flight itinerary · 3m ago", windowKind: "standard", bundleId: "dev.caret.mailfixture", selectable: false, inForm: null, href: null };
  const page: NavTarget = { kind: "row", page: true, label: "Kayak · Flight itinerary · 3m ago", windowKind: "page", bundleId: "com.google.Chrome", selectable: false, inForm: false, href: "none" };

  test("a native row the reader cannot select is the user's to open", () => {
    expect(navVerdict(native, "e:open")).toMatchObject({ kind: "navigate", actor: "you", capability: { name: "openItem" } });
  });

  test("a native row the reader can select is Caret's", () => {
    expect(navVerdict({ ...native, selectable: true }, "e:select")).toMatchObject({ kind: "navigate", actor: "caret", capability: { name: "selectRow" } });
  });

  test("a qualified page row is Caret's; one unqualified, in a form or linking elsewhere is the user's", () => {
    expect(navVerdict(page, "e:open")).toMatchObject({ actor: "caret" });
    for (const t of [{ ...page, inForm: null }, { ...page, inForm: true }, { ...page, href: "other" as const }, { ...page, href: null }, { ...page, kind: "button" }]) expect(navVerdict(t, "e:open")).toMatchObject({ kind: "navigate", actor: "you" });
  });

  test("e:yours is the user's and opens", () => {
    expect(navVerdict({ ...native, selectable: true }, "e:yours")).toMatchObject({ kind: "navigate", actor: "you", capability: { name: "openItem" } });
  });

  test("a row that reads as a risk class, or any row of a system prompt, is refused", () => {
    expect(navVerdict({ ...native, label: "Delete all · 2d" }, "e:open")).toMatchObject({ kind: "refuse", why: "destructive" });
    expect(navVerdict({ ...native, windowKind: "systemdialog" }, "e:open")).toMatchObject({ kind: "refuse", why: "system" });
  });

  test("an unknown effect, or a native target that is not a row, is refused", () => {
    expect(navVerdict(native, "e:reveal")).toMatchObject({ kind: "refuse" });
    expect(navVerdict({ ...native, kind: "AXButton" }, "e:open")).toMatchObject({ kind: "refuse" });
  });

  test("a row lists every navigation some capability allows, then e:yours; a refused row lists none", () => {
    expect(allowedNavigateEffects(native)).toEqual(["e:select", "e:open", "e:yours"]);
    expect(allowedNavigateEffects({ ...native, label: "Pay now · invoice" })).toEqual([]);
  });
});
