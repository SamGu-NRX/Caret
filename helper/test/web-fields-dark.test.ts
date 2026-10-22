// What goes dark on the web now that a page's text field never sends its text (counsel 2026-10-09, "Degradations"):
// each refuses loudly, with a reason the user or the log reads, instead of acting on a value Caret no longer has.
// Every name and value is invented.
import { describe, expect, it } from "vitest";
import { collectCandidates } from "../src/fill/candidates.ts";
import { alternateVeto, readableFields } from "../src/fill/alternate.ts";
import { capture, WEB_ANSWER_DARK } from "../src/memory/answers.ts";
import { owedFields } from "../src/goals/left.ts";
import { unitOf } from "../src/fill/note-unit.ts";
import { textValueOf } from "../src/engines/page-link.ts";
import { ScreenModel, holdsText } from "../src/model.ts";
import { PAGE_WINDOW_KIND } from "../src/engines/windows.ts";
import type { Node, TextPageControl } from "../src/protocol.ts";
import { c, chrome, FakePage, WIN } from "./fake-page.ts";
import { field, snap } from "./builders.ts";
import { PageEngineLink } from "../src/engines/page-link.ts";

const web = (nodes: Node[], windowId = "page:eng1:7") => snap([{ key: "f0", parent: null, role: "AXWebArea", label: "Apply" }, ...nodes.map((n) => ({ ...n, parent: "f0" }))], { at: 1000, windowId, kind: PAGE_WINDOW_KIND, title: "Apply", app: chrome });

describe("a page text field's node", () => {
  const ctl = (extra: Partial<TextPageControl>): TextPageControl => ({ id: "e1", key: "k", strongKey: null, kind: "email", role: "textbox", name: "Email", form: null, rect: [0, 0, 1, 1], hasValue: true, rev: 4, ...extra });
  it("holds \"\" when the page says it is empty, Caret's own text at the rev it knew it at, and is unread otherwise", () => {
    expect(textValueOf(ctl({ hasValue: false }), undefined)).toEqual({ value: "" });
    expect(textValueOf(ctl({}), { text: "robin@example.test", rev: 4 })).toEqual({ value: "robin@example.test" });
    expect(textValueOf(ctl({}), { text: "robin@example.test", rev: 3 })).toEqual({ unread: true });
    expect(textValueOf(ctl({}), undefined)).toEqual({ unread: true });
    expect(textValueOf(ctl({ hasValue: null, rev: null, withheld: "prefilled" }), { text: "x", rev: 4 })).toEqual({ unread: true });
  });

  it("reads as filled to every emptiness check when unread", () => {
    expect(holdsText({ key: "k", parent: null, role: "AXTextField", editable: true, unread: true })).toBe(true);
    expect(holdsText({ key: "k", parent: null, role: "AXTextField", editable: true, value: "" })).toBe(false);
  });
});

describe("copying from another tab's field", () => {
  it("is dark: a web field is no copy source, even holding Caret's own text, while a native field still is", () => {
    const model = new ScreenModel();
    model.apply(web([field("f0/email", "robin@example.test", { label: "Email", rev: 3 })]));
    model.apply(snap([field("native/email", "dana@example.test", { label: "Email" })], { at: 1100, windowId: "note" }));
    model.apply(snap([], { at: 2000, windowId: "form", focused: true }));
    const texts = collectCandidates(model, "form", { now: 3000 }).candidates.map((x) => x.text);
    expect(texts).toContain("dana@example.test");
    expect(texts).not.toContain("robin@example.test");
  });
});

describe("a note typed in a web textarea", () => {
  it("is dark: its unit is incomplete, so no value from it is admitted on ownership", () => {
    const model = new ScreenModel();
    model.apply(web([{ key: "f0/note", parent: null, role: "AXTextArea", label: "Notes", editable: true, unread: true, rev: 2 }]));
    expect(unitOf(model, "page:eng1:7", "f0/note")).toMatchObject({ complete: false });
  });
});

describe("the \"would repeat your existing email\" veto", () => {
  it("fails closed, saying why, when the form's main email is a web field Caret cannot read", () => {
    const model = new ScreenModel();
    model.apply(web([field("f0/email", "", { label: "Email", unread: true, rev: 2 }), field("f0/alt", "", { label: "Alternate email", rev: 0 })]));
    const w = model.windows.get("page:eng1:7");
    if (w === undefined) throw new Error("no window");
    const fields = readableFields(w);
    expect(fields.find((f) => f.key === "f0/email")).toMatchObject({ unread: true, value: "" });
    expect(alternateVeto({ key: "f0/alt", name: "Alternate email", text: "robin@example.test" }, { fields, writes: [], saved: [] })).toEqual({ says: "it may repeat your Email, which Caret cannot read on this page", repeats: { field: "f0/email" } });
  });
});

describe("saving an answer typed in a web field (S1)", () => {
  it("is dark: refused with its reason, never saved as empty", () => {
    const model = new ScreenModel();
    model.apply(web([{ key: "f0/why", parent: null, role: "AXTextArea", label: "Why this role?", editable: true, unread: true, rev: 5, entry: "typed" }]));
    const w = model.windows.get("page:eng1:7");
    if (w === undefined) throw new Error("no window");
    expect(capture(w, "f0/why", { site: "https://jobs.example.test/apply", caretWrote: [] })).toEqual({ ok: false, why: "unavailable", says: WEB_ANSWER_DARK });
  });
});

describe("a required web field the user filled", () => {
  it("is owed nothing: unread text is text, for the goal's left-to-you check", () => {
    const model = new ScreenModel();
    model.apply(web([{ key: "f0/email", parent: null, role: "AXTextField", label: "Email *", editable: true, unread: true, rev: 3 }, { key: "f0/start", parent: null, role: "AXDateField", label: "Start date *", editable: true, unread: true, rev: 1 }]));
    const w = model.windows.get("page:eng1:7");
    if (w === undefined) throw new Error("no window");
    expect(owedFields(w).map((f) => [f.label, f.empty])).toEqual([["Email", false], ["Start date", false]]);
  });
});

describe("a write that reached a re-rendered field through a strong-key rebind", () => {
  it("keeps what the helper knows of the field under the element it wrote, so its node holds Caret's text and Undo can reach it", async () => {
    const page = new FakePage(() => [c("e1", "text", "Full name", { value: "" })]);
    const model = new ScreenModel();
    const link = new PageEngineLink(page.session, (s) => model.apply(s));
    page.session.receive({ type: "pageHello", v: 1, extensionId: page.session.info.extensionId, version: "0", profile: "p", instance: "w", startedAt: 1, capabilities: [] });
    await link.run({ kind: "walk", pid: chrome.pid, windowId: WIN });
    link.grant({ type: "actGrant", v: 1, taskId: "t1", pid: chrome.pid, windowId: WIN, at: Date.now(), expires: Date.now() + 10_000 });
    const key = `f0/${page.controls[0]?.key}`;
    // The page re-rendered the field before the write: the content script rebinds and names the replacement, e9.
    page.onAct = (v, p) => {
      if (v.kind !== "pageWrite") return null;
      const x = p.find("e1");
      x.id = "e9";
      const readings = p.write({ ...v, id: "e9" }, v.value);
      return { outcome: "ok", detail: "rebound by its strong key", readings, reboundTo: "e9" };
    };
    expect((await link.run({ kind: "write", pid: chrome.pid, windowId: WIN, key, role: "AXTextField", attribute: "value", expect: "", value: "Robin Vale", taskId: "t1", mark: "m1" })).outcome).toBe("ok");
    page.onAct = null;
    await link.run({ kind: "walk", pid: chrome.pid, windowId: WIN });
    expect(model.windows.get(WIN)?.nodes.get(key)).toMatchObject({ value: "Robin Vale" });
    expect(model.windows.get(WIN)?.nodes.get(key)?.unread).toBeUndefined();
  });
});

describe("Undo after the page reloaded", () => {
  it("is refused with its reason: the page that kept the field's text before Caret's write went with it", async () => {
    const page = new FakePage(() => [c("e1", "text", "Full name", { value: "" })]);
    const model = new ScreenModel();
    const link = new PageEngineLink(page.session, (s) => model.apply(s));
    page.session.receive({ type: "pageHello", v: 1, extensionId: page.session.info.extensionId, version: "0", profile: "p", instance: "w", startedAt: 1, capabilities: [] });
    await link.run({ kind: "walk", pid: chrome.pid, windowId: WIN });
    link.grant({ type: "actGrant", v: 1, taskId: "t1", pid: chrome.pid, windowId: WIN, at: Date.now(), expires: Date.now() + 10_000 });
    const key = `f0/${page.controls[0]?.key}`;
    expect((await link.run({ kind: "write", pid: chrome.pid, windowId: WIN, key, role: "AXTextField", attribute: "value", expect: "", value: "Robin Vale", taskId: "t1", mark: "m1" })).outcome).toBe("ok");
    page.reload();
    await link.run({ kind: "walk", pid: chrome.pid, windowId: WIN });
    const r = await link.run({ kind: "write", pid: chrome.pid, windowId: WIN, key, role: "AXTextField", attribute: "value", expect: "Robin Vale", value: "", taskId: "t1", sameAs: "m1" });
    expect(r).toMatchObject({ outcome: "notSameElement", detail: expect.stringMatching(/reloaded/u) });
    expect(page.verbs.filter((v) => v.kind === "pageRestore")).toEqual([]);
  });
});
