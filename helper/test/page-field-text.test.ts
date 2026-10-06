// P4 items 7 and 9: what the host's pageField says about the field being typed in on a page, from the tab's walk, and
// its golden lines (fixtures/golden/page-field-text.ndjson), which the host's Swift mirror decodes (H13).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, PageFieldText, PageSnapshot, type PageControl } from "../src/protocol.ts";
import { ownSuggestions, pageFieldText } from "../src/engines/field-text.ts";

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
