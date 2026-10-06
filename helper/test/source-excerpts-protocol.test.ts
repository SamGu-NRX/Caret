// L1: the wire for source excerpts (protocol SourceExcerpt, GoalPageView rows' `source` and `excerpt`, and `left`).
// Every name and value is invented.
import { describe, expect, it } from "vitest";
import * as protocol from "../src/protocol.ts";

const { GoalPageView, SourceExcerpt } = protocol as unknown as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;

const good = { text: "Robin Vale\nEmail: robin@example.test\nPhone: 555 0100", start: 18, end: 36, name: "Robin's details.txt", edited: null };

describe("SourceExcerpt", () => {
  it("is exported with its capability", () => {
    expect((protocol as Record<string, unknown>).SOURCE_EXCERPTS_CAPABILITY).toBe("sourceExcerpts");
    expect(SourceExcerpt).toBeDefined();
  });

  it("accepts a good excerpt, with a tab or with a pdf", () => {
    expect(good.text.slice(good.start, good.end)).toBe("robin@example.test");
    expect(SourceExcerpt?.safeParse(good).success).toBe(true);
    expect(SourceExcerpt?.safeParse({ ...good, tab: { title: "Robin Vale - Profile", host: "people.example.test" } }).success).toBe(true);
    expect(SourceExcerpt?.safeParse({ ...good, pdf: { path: "/Users/robin/cv.pdf", page: 0 } }).success).toBe(true);
    expect(SourceExcerpt?.safeParse({ ...good, edited: 1790100000000 }).success).toBe(true);
  });

  it("refuses 7 lines, 601 characters, an empty or reversed span, a span past the text, and a pdf with a tab", () => {
    const bad = (x: unknown): boolean => SourceExcerpt?.safeParse(x).success === false;
    expect(bad({ ...good, text: "a\nb\nc\nd\ne\nf\ng", start: 0, end: 1 })).toBe(true);
    expect(SourceExcerpt?.safeParse({ ...good, text: "a\nb\nc\nd\ne\nf", start: 0, end: 1 }).success).toBe(true);
    expect(bad({ ...good, text: "x".repeat(601), start: 0, end: 1 })).toBe(true);
    expect(SourceExcerpt?.safeParse({ ...good, text: "x".repeat(600), start: 0, end: 600 }).success).toBe(true);
    expect(bad({ ...good, start: 5, end: 5 })).toBe(true);
    expect(bad({ ...good, start: 6, end: 5 })).toBe(true);
    expect(bad({ ...good, end: good.text.length + 1 })).toBe(true);
    expect(bad({ ...good, pdf: { path: "/a.pdf", page: 1 }, tab: { title: "t", host: "h.test" } })).toBe(true);
  });
});

describe("GoalPageView with sources, excerpts and left", () => {
  const view = {
    windowId: "page:eng1:7",
    app: { pid: 4100, bundleId: "com.google.chrome.for.testing", name: "Google Chrome for Testing" },
    anchor: null,
    viewport: null,
    from: "TextEdit, Robin's details.txt",
    rows: [
      { step: 0, label: "Email", value: "robin@example.test", picked: false, source: { kind: "window", name: "TextEdit" }, excerpt: good },
      { step: 1, label: "Country", value: "Canada", picked: true, source: { kind: "request", name: "" } },
    ],
    attach: [],
    left: [
      { label: "Why do you want this job?", why: "answer", says: "'Why do you want this job?' is yours to write: Caret doesn't write answers." },
      { label: "Gender", why: "identity", says: "'Gender' is yours: Caret found nothing on screen or in memory for it." },
    ],
  };

  it("parses rows with source and excerpt, and left", () => {
    expect(GoalPageView?.safeParse(view).success).toBe(true);
  });

  it("refuses an unknown source kind or left reason", () => {
    expect(GoalPageView?.safeParse({ ...view, rows: [{ ...view.rows[0], source: { kind: "pdf", name: "" } }] }).success).toBe(false);
    expect(GoalPageView?.safeParse({ ...view, left: [{ ...view.left[0], why: "dropped" }] }).success).toBe(false);
  });
});
