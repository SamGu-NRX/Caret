// P2, from P1's findings: one field that fails its recheck no longer cancels the whole Fill all. It is listed as the
// user's, with why, and the rest is offered and written. And the decision on a span inside a longer source line: a
// control's value passes only when its own "Label:" line still holds it, or (with no label) when code derives exactly
// that part from the line again; a short answer inside a longer sentence never passes. Every name and value is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type FillProposal, type HelperMessage, type OfferPopup, type PageControl } from "../src/protocol.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { pageHost } from "../src/engines/host.ts";
import { wirePageEngines } from "../src/engines/wire.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { ScreenModel } from "../src/model.ts";
import { sourceHolds } from "../src/offers/fill-popup.ts";
import { field, focus, jevPickingText, snap } from "./builders.ts";
import { c, chrome, FakePage, hello, okReader, TEXTEDIT, WIN } from "./fake-page.ts";

/** A source window whose one text area holds `text`. */
const source = (text: string) => {
  const m = new ScreenModel();
  m.apply(snap([field("te/n", text, { role: "AXTextArea" })], { at: 1, windowId: "n", title: "Notes.txt", app: TEXTEDIT, focused: true }));
  return m.windows.get("n")!;
};

describe("sourceHolds: a span inside a longer source line (P2 decision)", () => {
  const LOCATION = "Location: Oakland, California, United States (in the Bay Area)";

  it("passes a control's value on its own 'Label:' line, which still holds it", () => {
    expect(sourceHolds(source(LOCATION), "te/n", "United States", "Location", "combobox")).toBe(true);
    // The line under another label no longer says it is the location.
    expect(sourceHolds(source("Moving from: Oakland, California, United States"), "te/n", "United States", "Location", "combobox")).toBe(false);
  });

  it("passes an unlabelled control's value only when code derives exactly that part from the line again", () => {
    expect(sourceHolds(source("Oakland, California, United States"), "te/n", "United States", null, "combobox")).toBe(true);
    expect(sourceHolds(source(LOCATION), "te/n", "California", null, "select")).toBe(true);
    expect(sourceHolds(source("12 Harbor Way, Oakland, CA 94607"), "te/n", "94607", null, "select")).toBe(true);
  });

  it("refuses a short answer inside a sentence that now says otherwise, and a span that is no derived part", () => {
    expect(sourceHolds(source("I have a valid driving license? No."), "te/n", "No", null, "select")).toBe(false);
    expect(sourceHolds(source("We ship to the United States only."), "te/n", "United States", null, "combobox")).toBe(false);
    // The same line whole still passes, as before P2.
    expect(sourceHolds(source("Yes\nNo"), "te/n", "No", null, "select")).toBe(true);
  });

  it("holds a text field's value to the node's text, as before", () => {
    expect(sourceHolds(source(LOCATION), "te/n", "Oakland", null, "text")).toBe(true);
    expect(sourceHolds(source(LOCATION), "te/n", "Berkeley", null, "text")).toBe(false);
  });
});

/** A short apply form: two text fields and a country dropdown named only by its label, as W4's Greenhouse pages show it. */
const form = (): PageControl[] => [c("e1", "text", "Full name", { value: "" }), c("e2", "email", "Email", { value: "" }), c("e3", "combobox", "Country", { value: "" })];
const NOTE = ["Full name: Robin Vale", "Email: robin@example.test", "Location: Oakland, California, United States (in the Bay Area)"].join("\n");
const PICKS: Record<string, string> = { "Full name": "Robin Vale", Email: "robin@example.test", Country: "United States" };

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

async function rig(during: ((h: Helper) => Promise<void>) | null = null): Promise<{ helper: Helper; page: FakePage; published: HelperMessage[] }> {
  const dir = mkdtempSync(join(tmpdir(), "caret-p2r-"));
  const store = new Store(join(dir, "data"));
  const page = new FakePage(form, "Apply: Engineer");
  const published: HelperMessage[] = [];
  const pick = jevPickingText((_, ins) => PICKS[/Label: '([^']+)'/.exec(ins)?.[1] ?? ""] ?? null, 0.95);
  let once = during;
  // `during` runs while Jev answers, as the user may change a source then.
  const jev: AskJev = async (req) => {
    const r = await pick(req);
    const f = once;
    once = null;
    if (f !== null) await f(helper);
    return r;
  };
  let helper: Helper;
  const host = pageHost({ path: join(dir, "page.sock"), secret: Buffer.alloc(32, 1), reader: okReader, apply: (m) => void helper.handleReader(m), warn: () => {} });
  helper = new Helper({ store, askJev: jev, shadow: false, allowBackgroundFocus: false, readerLink: host.link, calendar: null, publish: (m) => void published.push(m), warn: () => {} });
  wirePageEngines({ host, helper, publish: () => {}, warn: () => {} });
  host.registry.add(page.session);
  page.session.receive(hello);
  await new Promise((r) => setTimeout(r, 0));
  await helper.handleReader(snap([field("te/note", NOTE, { role: "AXTextArea" })], { at: Date.now() - 5000, windowId: "note", title: "Robin.txt", app: TEXTEDIT, focused: true }));
  expect((await host.link.run({ kind: "walk", pid: chrome.pid, windowId: WIN })).outcome).toBe("ok");
  cleanups.push(() => {
    helper.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { helper, page, published };
}

const KEY = (id: string): string => `f0/${form().find((x) => x.id === id)?.key ?? id}`;
const rows = (p: OfferPopup): string[] => p.spec.blocks.flatMap((b) => (b.type === "fields" ? b.rows.map((r) => r.value?.text ?? "") : b.type === "facts" ? b.rows.map((r) => r.value.text) : []));

describe("one field that fails its recheck (P2)", () => {
  it("offers a country derived from the note's labelled Location line (W4's Greenhouse refusal)", async () => {
    const { helper, page, published } = await rig();
    const p = (await helper.handleReader(focus(WIN, KEY("e1"), Date.now(), { app: chrome }))) as FillProposal;
    expect(p.fields.find((f) => f.key === KEY("e3"))?.handoff).toMatchObject({ value: "United States", context: "Location", writes: true });
    const popup = published.find((m): m is OfferPopup => m.type === "popup");
    expect(popup, "the pop-up was refused whole").toBeDefined();
    expect(rows(popup as OfferPopup)).toEqual(["Robin Vale", "robin@example.test", "United States"]);
    const r = await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: (popup as OfferPopup).offerKey, actionId: "fillAll", overrides: {}, at: Date.now() });
    expect(r?.outcome).toBe("done");
    expect([page.shown("e1"), page.shown("e2"), page.shown("e3")]).toEqual(["Robin Vale", "robin@example.test", "United States"]);
  });

  it("lists a field whose source changed while Jev answered as the user's, with why, and offers the rest", async () => {
    const changed = NOTE.replace("Email: robin@example.test", "Email: (ask Robin)");
    const { helper, page, published } = await rig(async (h) => {
      await h.handleReader(snap([field("te/note", changed, { role: "AXTextArea" })], { at: Date.now() - 4000, windowId: "note", title: "Robin.txt", app: TEXTEDIT, focused: false }));
    });
    await helper.handleReader(focus(WIN, KEY("e1"), Date.now(), { app: chrome }));
    const popup = published.find((m): m is OfferPopup => m.type === "popup");
    expect(popup, "the pop-up was refused whole").toBeDefined();
    expect(rows(popup as OfferPopup)).toEqual(["Robin Vale", "United States", "Email: where Caret read its value changed"]);
    await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: (popup as OfferPopup).offerKey, actionId: "fillAll", overrides: {}, at: Date.now() });
    expect([page.shown("e1"), page.shown("e2"), page.shown("e3")]).toEqual(["Robin Vale", "", "United States"]);
  });
});
