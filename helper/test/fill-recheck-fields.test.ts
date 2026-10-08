// P2, from P1's findings: one field that fails its recheck no longer cancels the whole Fill all. It is listed as the
// user's, with why, and the rest is offered and written. And the decision on a span inside a longer source line: a
// control's value passes only when its own "Label:" line still holds it, or the line it was read from reads as it did.
// I1: the recheck is the write contract's (fill/contract.ts provenanceStale), which holds a value to the digests of the
// lines it was read from, so a line that changed in any way refuses it. Every name and value is invented.
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
import { holds } from "./recheck.ts";
import { field, focus, jevPickingText, snap } from "./builders.ts";
import { c, chrome, FakePage, hello, okReader, TEXTEDIT, WIN } from "./fake-page.ts";

/** A source window whose one text area holds `text`. */
const source = (text: string): ScreenModel => {
  const m = new ScreenModel();
  m.apply(snap([field("te/n", text, { role: "AXTextArea" })], { at: 1, windowId: "n", title: "Notes.txt", app: TEXTEDIT, focused: true }));
  return m;
};
/** Whether `span`, read from the note as `was` (beside `context`), is still held once the note reads `now`. */
const held = (was: string, now: string, span: string, context: string | null = null): boolean => holds(source, { windowId: "n", nodeKey: "te/n" }, was, now, span, context);

describe("the recheck of a span inside a longer source line (P2 decision)", () => {
  const LOCATION = "Location: Oakland, California, United States (in the Bay Area)";

  it("passes a control's value on its own 'Label:' line, which still holds it", () => {
    expect(held(LOCATION, LOCATION, "Oakland, California, United States", "Location")).toBe(true);
    // The line under another label no longer says it is the location.
    expect(held(LOCATION, "Moving from: Oakland, California, United States", "Oakland, California, United States", "Location")).toBe(false);
  });

  it("passes an unlabelled line's value only while the line reads as it did", () => {
    expect(held("Oakland, California, United States", "Oakland, California, United States", "Oakland, California, United States")).toBe(true);
    expect(held("12 Harbor Way, Oakland, CA 94607", "12 Harbor Way, Oakland, CA 94607", "12 Harbor Way, Oakland, CA 94607")).toBe(true);
    // A line that gained a label is not the line the value was read from (P2 review), whatever the label says.
    expect(held("Oakland, California, United States", "Do not use: Oakland, California, United States", "Oakland, California, United States")).toBe(false);
  });

  it("refuses a short answer inside a line that now says otherwise", () => {
    // D2-04 review: "Valid driving license: no" became a question whose answer is the same word.
    expect(held("Valid driving license: no", "I have a valid driving license? No.", "no", "Valid driving license")).toBe(false);
    expect(held("Ship to: United States", "We ship to the United States only.", "United States", "Ship to")).toBe(false);
    expect(held("Yes\nNo", "Yes\nNo", "No")).toBe(true);
  });

  it("holds a text field's value to the lines it was read from", () => {
    expect(held(LOCATION, LOCATION, "Oakland")).toBe(true);
    expect(held(LOCATION, LOCATION.replace("Oakland", "Berkeley"), "Oakland")).toBe(false);
  });
});

/** A short apply form: two text fields and a country dropdown named only by its label, as W4's Greenhouse pages show it. */
const form = (): PageControl[] => [c("e1", "text", "Full name", { value: "" }), c("e2", "email", "Email", { value: "" }), c("e3", "combobox", "Country", { value: "" })];
// G2 round 4: a value's recheck reads its line and the lines either side (fill/line-values.ts lineDigests), so a line
// between the values keeps an edit to one from touching another's neighbourhood.
const NOTE = ["Full name: Robin Vale", "", "Phone: none on file", "", "Email: robin@example.test", "", "Notes: none", "", "Location: Oakland, California, United States (in the Bay Area)"].join("\n");
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
  const host = pageHost({ path: join(dir, "page.sock"), secret: Buffer.alloc(32, 1), reader: okReader, apply: (m) => void helper.handleReader(m), purge: (s) => helper.purgeWindow(s), warn: () => {} });
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

  it("offers nothing from a note that changed while Jev answered (HA2 review P1: every value from it rests on the whole note)", async () => {
    const changed = NOTE.replace("Email: robin@example.test", "Email: (ask Robin)");
    const { helper, page, published } = await rig(async (h) => {
      await h.handleReader(snap([field("te/note", changed, { role: "AXTextArea" })], { at: Date.now() - 4000, windowId: "note", title: "Robin.txt", app: TEXTEDIT, focused: false }));
    });
    await helper.handleReader(focus(WIN, KEY("e1"), Date.now(), { app: chrome }));
    // Before HA2's review the Email row alone went to the user and the rest were offered. Each value is now bound to the
    // whole note its owner questions showed (contract.ts Provenance owned), and that note changed, so none is offered.
    expect(published.some((m) => m.type === "popup")).toBe(false);
    expect([page.shown("e1"), page.shown("e2"), page.shown("e3")]).toEqual(["", "", ""]);
  });
});
