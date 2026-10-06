// P4: the pure halves of reading the tab the user just left. Which tab, for how long, which frames (left-tab.ts), and
// how much text and in what order (shared/tab-text.ts). The DOM half runs in a real browser:
// fixtures/web-form/tests/tab-text.test.ts.
import { describe, expect, it } from "vitest";
import { LEFT_TAB_MS, LeftTab, deniedOrigin, type FrameMark } from "../src/worker/left-tab.ts";
import { TAB_TEXT_BYTES, capFrame, capParagraphs, cutParagraph, joinFrames, utf8Bytes } from "../src/shared/tab-text.ts";

const gen = (): number => 1;
const marks = (top: [string, number], ...children: [number, string, number][]): FrameMark[] => [
  { frameId: 0, documentId: top[0], navGen: top[1] },
  ...children.map(([frameId, documentId, navGen]) => ({ frameId, documentId, navGen })),
];

/** The user in tab 1 (the mail), then in tab 2 (the form), at t=1000. */
function leftMail(): LeftTab {
  const t = new LeftTab();
  t.moved({ tabId: 1, windowId: 9 }, 0, gen);
  const rec = t.moved({ tabId: 2, windowId: 9 }, 1000, gen);
  if (rec === null) throw new Error("moving from tab 1 to tab 2 left no record");
  t.noted(rec, marks(["docA", 1], [5, "docF", 1]));
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
    const rec = t.moved({ tabId: 3, windowId: 9 }, 3000, gen);
    if (rec !== null) t.noted(rec, marks(["docB", 1]));
    expect(t.check(1, 3500, marks(["docA", 1]))).toMatchObject({ ok: false, why: "it is not the tab you just left" });
    expect(t.check(2, 3500, marks(["docB", 1]))).toMatchObject({ ok: true });
  });

  it("stops being the tab left once the user comes back to it", () => {
    const t = leftMail();
    t.moved({ tabId: 1, windowId: 9 }, 1500, gen);
    expect(t.check(1, 1600, marks(["docA", 1]))).toMatchObject({ ok: false });
  });

  it("is still the tab left when the browser loses focus to another app, and after it comes back to another tab", () => {
    const t = new LeftTab();
    t.moved({ tabId: 1, windowId: 9 }, 0, gen);
    const rec = t.moved(null, 1000, gen);
    if (rec === null) throw new Error("losing focus left no record");
    t.noted(rec, marks(["docA", 1]));
    expect(t.check(1, 1200, marks(["docA", 1]))).toMatchObject({ ok: true });
    // The worker does not know what the user did in the other app; the helper checks that the window they just left is this tab.
    t.moved({ tabId: 2, windowId: 9 }, 1300, gen);
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

  it("is not read when its top frame moved between leaving and the worker noting its frames", () => {
    const t = new LeftTab();
    t.moved({ tabId: 1, windowId: 9 }, 0, gen);
    const rec = t.moved({ tabId: 2, windowId: 9 }, 1000, () => 4);
    if (rec === null) throw new Error("no record");
    // Generation 4 when the user left; the frames, read a moment later, show 5.
    t.noted(rec, marks(["docA", 5]));
    expect(t.check(1, 1100, marks(["docA", 5]))).toMatchObject({ ok: false });
  });

  it("is not read before its frames are noted, and a late note for an older record is ignored", () => {
    const t = new LeftTab();
    t.moved({ tabId: 1, windowId: 9 }, 0, gen);
    const first = t.moved({ tabId: 2, windowId: 9 }, 1000, gen);
    expect(t.check(1, 1001, marks(["docA", 1]))).toMatchObject({ ok: false });
    t.moved({ tabId: 3, windowId: 9 }, 1100, gen);
    if (first !== null) t.noted(first, marks(["docA", 1]));
    expect(t.check(1, 1200, marks(["docA", 1]))).toMatchObject({ ok: false, why: "it is not the tab you just left" });
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

  it("cuts a single paragraph longer than the cap at a line break, else a space, never inside a surrogate pair", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} of the message`).join("\n");
    const head = cutParagraph(lines, TAB_TEXT_BYTES);
    expect(utf8Bytes(head)).toBeLessThanOrEqual(TAB_TEXT_BYTES);
    expect(lines.startsWith(`${head}\n`)).toBe(true);
    const words = "word ".repeat(5000);
    const w = cutParagraph(words, 100);
    expect(w.endsWith("word")).toBe(true);
    const emoji = "😀".repeat(10);
    expect(cutParagraph(emoji, 9)).toBe("😀😀");
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
