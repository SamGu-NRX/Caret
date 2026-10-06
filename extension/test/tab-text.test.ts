// P4: the pure halves of reading the tab the user just left. Which tab, for how long, which frames (left-tab.ts), and
// how much text and in what order (shared/tab-text.ts). The DOM half runs in a real browser:
// fixtures/web-form/tests/tab-text.test.ts.
import { describe, expect, it } from "vitest";
import { LEFT_TAB_MS, LeftTab, deniedOrigin, type FrameMark } from "../src/worker/left-tab.ts";
import { TAB_TEXT_BYTES, capFrame, capParagraphs, cutParagraph, joinFrames, utf8Bytes } from "../src/shared/tab-text.ts";

/** The worker knows no frames of a tab (it never saw one commit). */
const none = (): FrameMark[] => [];
const marks = (top: [string, number], ...children: [number, string, number][]): FrameMark[] => [
  { frameId: 0, documentId: top[0], navGen: top[1] },
  ...children.map(([frameId, documentId, navGen]) => ({ frameId, documentId, navGen })),
];

/** The user in tab 1 (the mail), then in tab 2 (the form), at t=1000. */
function leftMail(): LeftTab {
  const t = new LeftTab();
  t.moved({ tabId: 1, windowId: 9 }, 0, none);
  const rec = t.moved({ tabId: 2, windowId: 9 }, 1000, (tabId) => (tabId === 1 ? marks(["docA", 1], [5, "docF", 1]) : []));
  if (rec === null) throw new Error("moving from tab 1 to tab 2 left no record");
  return t;
}

describe("the tab the user just left (rule 1)", () => {
  it("is the one they were in when they moved to another tab", () => {
    expect(leftMail().check(1, 2000, marks(["docA", 1], [5, "docF", 1]))).toEqual({ ok: true, frames: marks(["docA", 1], [5, "docF", 1]) });
  });

  it("is never another tab: not the one they are in, not one left earlier, not a background one", () => {
    const t = leftMail();
    expect(t.check(2, 2000, marks(["docB", 1]))).toMatchObject({ ok: false });
    expect(t.check(7, 2000, marks(["docC", 1]))).toMatchObject({ ok: false, why: "it is not the tab you just left" });
    // Tab 1, then 2, then 3: only 2 is the tab just left.
    t.moved({ tabId: 3, windowId: 9 }, 3000, () => marks(["docB", 1]));
    expect(t.check(1, 3500, marks(["docA", 1]))).toMatchObject({ ok: false, why: "it is not the tab you just left" });
    expect(t.check(2, 3500, marks(["docB", 1]))).toMatchObject({ ok: true });
  });

  it("stops being the tab left once the user comes back to it", () => {
    const t = leftMail();
    t.moved({ tabId: 1, windowId: 9 }, 1500, none);
    expect(t.check(1, 1600, marks(["docA", 1]))).toMatchObject({ ok: false });
  });

  it("is not read while the user is in it again after another app, which leaves no other tab behind", () => {
    const t = new LeftTab();
    t.moved({ tabId: 1, windowId: 9 }, 0, none);
    const rec = t.moved(null, 1000, () => marks(["docA", 1]));
    if (rec === null) throw new Error("losing focus left no record");
    t.moved({ tabId: 1, windowId: 9 }, 1200, none);
    expect(t.check(1, 1300, marks(["docA", 1]))).toMatchObject({ ok: false });
  });

  it("is still the tab left when the browser loses focus to another app, and after it comes back to another tab", () => {
    const t = new LeftTab();
    t.moved({ tabId: 1, windowId: 9 }, 0, none);
    const rec = t.moved(null, 1000, () => marks(["docA", 1]));
    if (rec === null) throw new Error("losing focus left no record");
    expect(t.check(1, 1200, marks(["docA", 1]))).toMatchObject({ ok: true });
    // The worker does not know what the user did in the other app; the helper checks that the window they just left is this tab.
    t.moved({ tabId: 2, windowId: 9 }, 1300, none);
    expect(t.check(1, 1400, marks(["docA", 1]))).toMatchObject({ ok: true });
  });
});

describe("recent and unchanged (rule 2)", () => {
  it("is not read once LEFT_TAB_MS has passed since the user left it", () => {
    const t = leftMail();
    expect(t.check(1, 1000 + LEFT_TAB_MS, marks(["docA", 1], [5, "docF", 1]))).toMatchObject({ ok: true });
    expect(t.check(1, 1000 + LEFT_TAB_MS + 1, marks(["docA", 1], [5, "docF", 1]))).toEqual({ ok: false, why: `you left it more than ${LEFT_TAB_MS / 1000} s ago` });
  });

  it("is not read after a navigation, a history change or a reload of its top frame", () => {
    const t = leftMail();
    expect(t.check(1, 2000, marks(["docA", 2], [5, "docF", 1]))).toEqual({ ok: false, why: "the tab navigated or reloaded since you left it" });
    expect(t.check(1, 2000, marks(["docA2", 1], [5, "docF", 1]))).toEqual({ ok: false, why: "the tab navigated or reloaded since you left it" });
    expect(t.check(1, 2000, [])).toMatchObject({ ok: false });
  });

  it("reads only the child frames that are the documents they were, and none that appeared since", () => {
    const t = leftMail();
    expect(t.check(1, 2000, marks(["docA", 1], [5, "docF", 2], [6, "docNew", 1]))).toEqual({ ok: true, frames: marks(["docA", 1]) });
  });

  it("is not read after the tab closed", () => {
    const t = leftMail();
    t.closed(1);
    expect(t.check(1, 2000, marks(["docA", 1]))).toMatchObject({ ok: false, why: "it is not the tab you just left" });
  });

  it("is not read when the worker did not know its top document when the user left it (P4 review)", () => {
    const t = new LeftTab();
    t.moved({ tabId: 1, windowId: 9 }, 0, none);
    t.moved({ tabId: 2, windowId: 9 }, 1000, none);
    expect(t.check(1, 1100, marks(["docA", 1]))).toEqual({ ok: false, why: "Caret did not know the tab's document when you left it" });
  });

  it("reads only frames the worker knew when the user left: one that navigated since, or appeared since, is not read (P4 review)", () => {
    const t = new LeftTab();
    t.moved({ tabId: 1, windowId: 9 }, 0, none);
    t.moved({ tabId: 2, windowId: 9 }, 1000, () => marks(["docA", 1], [5, "docF", 1]));
    expect(t.check(1, 1100, marks(["docA", 1], [5, "docAfter", 2], [6, "docNew", 1]))).toEqual({ ok: true, frames: marks(["docA", 1]) });
  });
});

describe("never from an excluded site (rule 5)", () => {
  it("denies password managers and account pages, and anything that is not http(s)", () => {
    for (const o of ["https://my.1password.com", "https://vault.bitwarden.com", "https://lastpass.com", "https://passwords.google.com", "https://accounts.google.com", "https://pass.proton.me", "chrome://settings", "file:///Users", "null"]) {
      expect(deniedOrigin(o), o).toBe(true);
    }
    for (const o of ["https://mail.google.com", "https://docs.google.com", "http://127.0.0.1:8123", "https://notion.so", "https://notbitwarden.example"]) {
      expect(deniedOrigin(o), o).toBe(false);
    }
  });
});

describe("the 16 KB cap (rule 4)", () => {
  it("keeps whole paragraphs and stops at the first that does not fit", () => {
    const a = "a".repeat(10_000);
    const b = "b".repeat(6_000);
    const c = "c".repeat(500);
    const r = capParagraphs([a, b, c]);
    expect(r.cut).toBe(true);
    expect(r.kept).toEqual([a, b]);
    expect(r.kept.reduce((n, p) => n + utf8Bytes(p), 0) + r.kept.length - 1).toBeLessThanOrEqual(TAB_TEXT_BYTES);
  });

  it("counts UTF-8 bytes, not characters", () => {
    const wide = "é".repeat(5_000); // 10,000 bytes
    expect(capParagraphs([wide, "x".repeat(7_000)]).kept).toEqual([wide]);
  });

  it("cuts a single paragraph longer than the cap only at a line break", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} of the message`).join("\n");
    const head = cutParagraph(lines, TAB_TEXT_BYTES);
    expect(utf8Bytes(head)).toBeLessThanOrEqual(TAB_TEXT_BYTES);
    expect(lines.startsWith(`${head}\n`)).toBe(true);
    // Never inside a line: a single line longer than the cap is left out whole.
    expect(cutParagraph("word ".repeat(5000), 100)).toBe("");
    expect(cutParagraph("😀".repeat(10), 9)).toBe("");
    expect(capParagraphs(["x".repeat(TAB_TEXT_BYTES + 1)])).toEqual({ kept: [], cut: true });
  });

  it("is applied once over every frame of the tab", () => {
    const r = joinFrames([{ selection: [], blocks: ["t".repeat(9_000)] }, { selection: [], blocks: ["u".repeat(9_000)] }]);
    expect(r.cut).toBe(true);
    expect(r.blocks).toEqual(["t".repeat(9_000)]);
  });
});

describe("a selection is read first (rule 4)", () => {
  it("puts the selected text before the main region's, inside the same cap", () => {
    const r = capFrame({ selection: ["Phone: 555-0147"], blocks: ["Hi Ines,", "x".repeat(TAB_TEXT_BYTES)] });
    expect(r.selection).toEqual(["Phone: 555-0147"]);
    expect(r.blocks).toEqual(["Hi Ines,"]);
    expect(r.cut).toBe(true);
  });

  it("puts every frame's selection before any frame's main region", () => {
    const r = joinFrames([
      { selection: [], blocks: ["top paragraph"] },
      { selection: ["selected in the child"], blocks: ["child paragraph"] },
    ]);
    expect(r).toEqual({ selection: ["selected in the child"], blocks: ["top paragraph", "child paragraph"], cut: false });
  });

  it("keeps the selection when the main region alone would fill the cap", () => {
    const r = capFrame({ selection: ["Email: ines@example.org"], blocks: ["y".repeat(TAB_TEXT_BYTES - 5)] });
    expect(r.selection).toEqual(["Email: ines@example.org"]);
    expect(r.blocks).toEqual([]);
  });
});
