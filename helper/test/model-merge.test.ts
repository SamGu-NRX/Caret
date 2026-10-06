// I6: P3's cut walk (model.ts mergeCutWalk) and P4's tab text view (ScreenModel.withNodes, leftAt) in one model. A cut
// native walk keeps what it did not reach, in the model and in every view fill reads; a page is still replaced whole;
// the text read from the tab the user left lives only in a view and never reaches the model, whatever is applied after.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { PAGE_SUBROLE, type Node, type Snapshot } from "../src/protocol.ts";
import { field, node, snap, text } from "./builders.ts";

const NOTE = "w-note";
const MAIL = "page:chrome:11";
const FORM = "page:chrome:12";

const cut = (s: Snapshot): Snapshot => ({ ...s, stats: { ...s.stats, truncated: true } });

function note(at: number, focused: boolean): Snapshot {
  return snap(
    [node("toolbar", "AXToolbar"), node("scroll", "AXScrollArea"), field("scroll/text", "Order ORD-7731 ships Friday", { parent: "scroll", role: "AXTextArea" }), text("status", "Saved")],
    { at, windowId: NOTE, title: "Note", focused },
  );
}

const page = (windowId: string, nodes: Node[], at: number, focused: boolean, title: string): Snapshot => snap(nodes, { at, windowId, kind: "page", title, focused });

const read = (value: string, i: number): Node => ({ key: `f0/read~b${i}`, parent: "f0", role: "AXStaticText", subrole: PAGE_SUBROLE.readOnDemand, value });

const readKeys = (m: ScreenModel): string[] => [...m.windows.values()].flatMap((w) => [...w.nodes.keys()].filter((k) => k.includes("read~")));

describe("cut walks and the tab-text view in one model (I6)", () => {
  it("a view of a model whose native window was cut short keeps its unread nodes, and adds the tab's text to the tab only", () => {
    const m = new ScreenModel();
    m.apply(note(1000, true));
    m.apply(page(MAIL, [node("f0", "AXWebArea"), field("f0/search", "", { parent: "f0" })], 2000, true, "Inbox"));
    m.apply(page(FORM, [node("f0", "AXWebArea"), field("f0/order", "", { parent: "f0" })], 3000, true, "Return form"));
    // The note's background walk was cut inside its toolbar: the text area it never reached stays (P3).
    m.apply(cut(snap([node("toolbar", "AXToolbar")], { at: 4000, windowId: NOTE, title: "Note" })));
    expect(m.windows.get(NOTE)?.nodes.get("scroll/text")?.value).toBe("Order ORD-7731 ships Friday");

    // P4: the user left the mail tab for the form at 3000.
    expect(m.windowBefore(FORM)).toBe(MAIL);
    expect(m.leftAt(MAIL)).toBe(3000);
    expect(m.leftAt(FORM)).toBeNull();

    const v = m.withNodes(new Map([[MAIL, { nodes: [read("Your order ORD-9902 has shipped", 0)], title: "Order shipped - Inbox" }]]));
    expect(v.windows.get(NOTE)?.nodes.get("scroll/text")?.value).toBe("Order ORD-7731 ships Friday");
    expect(v.windows.get(MAIL)?.nodes.get("f0/read~b0")?.value).toBe("Your order ORD-9902 has shipped");
    expect(v.windows.get(MAIL)?.nodes.has("f0/search")).toBe(true);
    expect(v.windows.get(MAIL)?.window.title).toBe("Order shipped - Inbox");
    expect(v.windowBefore(FORM)).toBe(MAIL);
    expect(v.leftAt(MAIL)).toBe(3000);
    // The model never holds the tab's text, and its title is the walk's.
    expect(readKeys(m)).toEqual([]);
    expect(m.windows.get(MAIL)?.window.title).toBe("Inbox");
  });

  it("walks applied after a view was made, cut or whole, never bring the tab's text into the model", () => {
    const m = new ScreenModel();
    m.apply(note(1000, false));
    m.apply(page(MAIL, [node("f0", "AXWebArea"), field("f0/search", "", { parent: "f0" })], 2000, true, "Inbox"));
    m.apply(page(FORM, [node("f0", "AXWebArea"), field("f0/order", "", { parent: "f0" })], 3000, true, "Return form"));
    const v = m.withNodes(new Map([[MAIL, { nodes: [read("Your order ORD-9902 has shipped", 0)], title: null }]]));

    // A cut walk of the mail page replaces it whole (P3 keeps unread nodes for native windows only).
    m.apply(cut(page(MAIL, [node("f0", "AXWebArea"), field("f0/reply", "", { parent: "f0" })], 4000, false, "Inbox")));
    expect([...(m.windows.get(MAIL)?.nodes.keys() ?? [])]).toEqual(["f0", "f0/reply"]);
    // A cut walk of the note keeps its text area, and nothing of the view's comes with it.
    m.apply(cut(snap([text("status", "Saved")], { at: 5000, windowId: NOTE, title: "Note" })));
    expect(m.windows.get(NOTE)?.nodes.size).toBe(4);
    expect(readKeys(m)).toEqual([]);

    // The view made earlier still reads as it did; a view made now holds the text over the page as walked now.
    expect(v.windows.get(MAIL)?.nodes.has("f0/search")).toBe(true);
    const later = m.withNodes(new Map([[MAIL, { nodes: [read("Your order ORD-9902 has shipped", 0)], title: null }]]));
    expect([...(later.windows.get(MAIL)?.nodes.keys() ?? [])]).toEqual(["f0", "f0/reply", "f0/read~b0"]);
    expect(later.windows.get(NOTE)?.nodes.get("scroll/text")?.value).toBe("Order ORD-7731 ships Friday");
  });

  it("a view brings back no window the model closed", () => {
    const m = new ScreenModel();
    m.apply(page(MAIL, [node("f0", "AXWebArea")], 2000, true, "Inbox"));
    m.apply(page(FORM, [node("f0", "AXWebArea"), field("f0/order", "", { parent: "f0" })], 3000, true, "Return form"));
    m.close(MAIL, 3500);
    const v = m.withNodes(new Map([[MAIL, { nodes: [read("Your order ORD-9902 has shipped", 0)], title: null }]]));
    expect(v.windows.has(MAIL)).toBe(false);
    expect(v.windowBefore(FORM)).toBeNull();
  });
});
