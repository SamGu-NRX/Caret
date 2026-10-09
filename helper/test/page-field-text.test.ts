// P4 items 7 and 9: what the host's pageField says about the field being typed in on a page, from the tab's walk, and
// its golden lines (fixtures/golden/page-field-text.ndjson), which the host's Swift mirror decodes (H13).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, PageFieldText, PageSnapshot, type PageControl } from "../src/protocol.ts";
import { fieldKind, nearbyFrames, ownSuggestions, pageFieldText } from "../src/engines/field-text.ts";

const golden = readFileSync(fileURLToPath(new URL("../fixtures/golden/page-field-text.ndjson", import.meta.url)), "utf8").trim().split("\n").map((l) => JSON.parse(l) as unknown);

const ctl = (id: string, kind: PageControl["kind"], name: string): PageControl => ({ id, key: `${kind}:${name.toLowerCase()}~0`, strongKey: null, kind, role: "textbox", name, form: null, rect: [0, 0, 100, 20] });
function snapAt(origin: string, path: string, controls: PageControl[], focused: PageSnapshot["focused"], docs?: PageSnapshot["docs"]): PageSnapshot {
  return PageSnapshot.parse({
    type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w", at: 1, tabId: 1, browserWindowId: 1, active: true, inFocusedWindow: true, title: "t",
    frames: [{ frameId: 0, parentFrameId: -1, documentId: "D", origin, path, navGen: 1, title: "t", headings: [], controls, iframes: [], excluded: {}, truncated: false }],
    missing: [], focused, ...(docs === undefined ? {} : { docs }),
  });
}

describe("the page's own suggestions (item 9)", () => {
  it("are Gmail's in its compose body and Google Docs' in a document, by origin and path only", () => {
    expect(ownSuggestions("https://mail.google.com", "/mail/u/0/", "contenteditable")).toBe("gmail");
    expect(ownSuggestions("https://mail.google.com", "/mail/u/0/", "text")).toBeNull();
    expect(ownSuggestions("https://mail.google.com.evil.test", "/mail/u/0/", "contenteditable")).toBeNull();
    expect(ownSuggestions("https://docs.google.com", "/document/d/abc/edit", null)).toBe("google-docs");
    expect(ownSuggestions("https://docs.google.com", "/spreadsheets/d/abc/edit", null)).toBeNull();
    expect(ownSuggestions("https://example.test", "/document/x", "contenteditable")).toBeNull();
  });
});

describe("pageField's text (item 7)", () => {
  it("is the focused control's text around its caret, as the walk read it", () => {
    const s = snapAt("http://127.0.0.1:4310", "/apply", [ctl("e1", "textarea", "Cover letter")], { frameId: 0, id: "e1", selection: [30, 30], text: { before: "I am writing to apply for the ", after: " role.", selection: "" } });
    expect(pageFieldText(s)).toEqual(golden[0]);
  });

  it("is Gmail's compose body with its own suggestions named", () => {
    const s = snapAt("https://mail.google.com", "/mail/u/0/", [ctl("e7", "contenteditable", "Message Body")], { frameId: 0, id: "e7", selection: null, text: { before: "Hi Gareth,\nThanks for the details. ", after: "", selection: "" } });
    expect(pageFieldText(s)).toEqual(golden[1]);
  });

  it("says when a Google Doc's text for assistive technology is off, and gives the caret's text there when it is on", () => {
    expect(pageFieldText(snapAt("https://docs.google.com", "/document/d/abc/edit", [], null, { kind: "document", text: "off", field: null }))).toEqual(golden[2]);
    expect(pageFieldText(snapAt("https://docs.google.com", "/document/d/abc/edit", [], null, { kind: "document", text: "on", field: { before: "Quarterly plan\nOwner: ", after: "Ines Vandermeer", selection: "" } }))).toEqual(golden[3]);
  });

  it("is nothing when no kept control has focus: a password, card or one-time-code field never reaches the walk's focus", () => {
    // The walk reports focus only on a control it kept (extension content.ts walk), so an excluded field's snapshot has none.
    expect(pageFieldText(snapAt("https://bank.example.test", "/login", [], null))).toEqual(golden[4]);
    // An extension before P4 sends no text: nothing is guessed from the value.
    const old = snapAt("http://127.0.0.1:4310", "/apply", [ctl("e1", "text", "Name")], { frameId: 0, id: "e1", selection: [0, 0] });
    expect(pageFieldText(old).text).toBeNull();
  });

  it("has golden lines that parse losslessly", () => {
    for (const g of golden) expect(PageFieldText.parse(g)).toEqual(g);
    expect(PageFieldText.safeParse({ ...(golden[0] as object), text: { before: "a".repeat(2001), after: "", selection: "" } }).success).toBe(false);
  });
});

describe("pageField's fieldKind (H13)", () => {
  const focus = { frameId: 0, id: "e1", selection: [0, 0] as [number, number], text: { before: "", after: "", selection: "" } };
  it("is input, textarea or contenteditable by the focused control's walked kind", () => {
    for (const k of ["text", "email", "tel", "url", "number", "search"] as const) expect(fieldKind(snapAt("https://example.test", "/", [ctl("e1", k, "F")], focus)), k).toBe("input");
    expect(fieldKind(snapAt("https://example.test", "/", [ctl("e1", "textarea", "F")], focus))).toBe("textarea");
    expect(fieldKind(snapAt("https://example.test", "/", [ctl("e1", "contenteditable", "F")], focus))).toBe("contenteditable");
  });

  it("is none for a control with no text of the user's, no focus, or a Google Docs editor", () => {
    expect(fieldKind(snapAt("https://example.test", "/", [ctl("e1", "date", "F")], focus))).toBeNull();
    expect(fieldKind(snapAt("https://example.test", "/", [ctl("e1", "checkbox", "F")], focus))).toBeNull();
    expect(fieldKind(snapAt("https://example.test", "/", [], null))).toBeNull();
    expect(fieldKind(snapAt("https://docs.google.com", "/document/d/abc/edit", [], null, { kind: "document", text: "on", field: { before: "a", after: "", selection: "" } }))).toBeNull();
  });
});

describe("pageField's nearby frames (v2/inline)", () => {
  // The DF1 form: 680-wide fields every 70 px, each label's text 21 px over its field, at zoom 1 in a window at the origin.
  const row = (i: number, name: string): PageControl => ({ ...ctl(`e${i}`, "text", name), rect: [10, 100 + i * 70, 680, 32], labelRect: [10, 79 + i * 70, 90, 15] });
  const toScreen = (r: readonly [number, number, number, number]): [number, number, number, number] => [r[0], r[1], r[2], r[3]];
  const form = [row(0, "First Name"), row(1, "Last Name"), row(2, "Email"), row(3, "Phone"), row(4, "Resume")];

  it("names the other fields and every label near the focused one, its own label included, nearest first", () => {
    const s = snapAt("https://jobs.example.test", "/apply", form, { frameId: 0, id: "e0", selection: [0, 0], text: { before: "", after: "", selection: "" } });
    const near = nearbyFrames(s, toScreen);
    expect(near).not.toBeNull();
    expect(near).toContainEqual([10, 79, 90, 15]);
    expect(near).toContainEqual([10, 149, 90, 15]);
    expect(near).toContainEqual([10, 170, 680, 32]);
    expect(near).not.toContainEqual([10, 100, 680, 32]);
    expect(near?.[0]).toEqual([10, 79, 90, 15]);
  });

  it("leaves out what is further than its range and needs a screen position", () => {
    const s = snapAt("https://jobs.example.test", "/apply", form, { frameId: 0, id: "e0", selection: [0, 0], text: { before: "", after: "", selection: "" } });
    expect(nearbyFrames(s, toScreen)).not.toContainEqual([10, 380, 680, 32]);
    expect(nearbyFrames(s, null)).toBeNull();
  });
});
