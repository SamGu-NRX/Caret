import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { Store } from "../src/store.ts";
import { field, focus, FIXTURE_APP, MAIL_APP, snap, text, value } from "./builders.ts";

const SRC = "6160-1";
const FORM = "5150-1";
const EMAIL = "dev.caret.fixture/standard/textfield:email~0";
const NOTES = "dev.caret.fixture/standard/textfield:notes~0";

describe("shadow logger", () => {
  let dir: string;
  let store: Store;
  let helper: Helper;
  const published: unknown[] = [];

  const source = (at: number, extra = false) =>
    snap(
      [
        text("m/statictext:a~0", "Reply to dana.whitfield@example.com", [0, 0, 100, 10]),
        ...(extra ? [text("m/statictext:b~0", "Reference QX-77120", [0, 20, 100, 10])] : []),
      ],
      { at, windowId: SRC, app: MAIL_APP, values: [value("email", "dana.whitfield@example.com", "m/statictext:a~0")] },
    );
  const form = (at: number, email: string, notes: string) =>
    snap([field(EMAIL, email, { label: "Email" }), field(NOTES, notes, { label: "Notes" })], { at, windowId: FORM, app: FIXTURE_APP, focused: true });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-shadow-test-"));
    store = new Store(dir);
    published.length = 0;
    helper = new Helper({ store, askJev: null, shadow: true, allowBackgroundFocus: false, publish: (m) => published.push(m) });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts an entry that existed in another window before the focus as an opportunity", () => {
    void helper.handleReader(source(1000));
    void helper.handleReader(form(2000, "", ""));
    void helper.handleReader(focus(FORM, EMAIL, 3000));
    void helper.handleReader(form(4000, "dana.whitfield@example.com", ""));
    void helper.handleReader(focus(FORM, NOTES, 5000));
    store.flush();
    const rows = store.shadowEpisodes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ existed: "exact", trigger: "focus", enteredLength: 26, srcBundle: "dev.caret.mail", dstBundle: "dev.caret.fixture" });
    expect(store.counts()).toMatchObject({ "shadow.field_focus": 2, "shadow.entry": 1, "shadow.opportunity_exact": 1 });
  });

  it("does not count a source that appeared only after the focus", () => {
    void helper.handleReader(form(2000, "", ""));
    void helper.handleReader(focus(FORM, NOTES, 3000));
    void helper.handleReader(source(3500, true));
    void helper.handleReader(form(4000, "", "QX-77120"));
    helper.shutdown();
    expect(store.shadowEpisodes()[0]?.existed).toBe("no");
    expect(store.counts()["shadow.entry_not_found"]).toBe(1);
  });

  it("judges an idle entry without waiting for focus to move, and attributes a focus right after a switch", () => {
    void helper.handleReader(source(1000));
    void helper.handleReader(form(2000, "", ""));
    void helper.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: 2900, from: MAIL_APP, to: FIXTURE_APP });
    void helper.handleReader(focus(FORM, EMAIL, 3000));
    void helper.handleReader(form(4000, "Dana.Whitfield@example.com", ""));
    helper.tick(4000 + 10_000);
    const rows = store.shadowEpisodes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ existed: "normalized", trigger: "appSwitch" });
  });

  it("counts characters typed before the focus walk ran as part of the entry", () => {
    void helper.handleReader(source(1000));
    void helper.handleReader(form(2000, "", ""));
    void helper.handleReader(snap([field(EMAIL, "da", { label: "Email" }), field(NOTES, "", { label: "Notes" })], { at: 3000, windowId: FORM, app: FIXTURE_APP, focused: true, reason: "focus" }));
    void helper.handleReader(focus(FORM, EMAIL, 3000));
    void helper.handleReader(form(4000, "dana.whitfield@example.com", ""));
    helper.shutdown();
    expect(store.shadowEpisodes()[0]).toMatchObject({ existed: "exact", enteredLength: 26 });
  });

  it("judges a sent message on what was typed before the composer emptied, then watches the next one", () => {
    void helper.handleReader(source(1000));
    void helper.handleReader(form(2000, "", ""));
    void helper.handleReader(focus(FORM, NOTES, 3000));
    void helper.handleReader(form(4000, "", "dana.whitfield@example.com"));
    void helper.handleReader(form(4500, "", "")); // sent: the field empties
    void helper.handleReader(form(6000, "", "see you at the venue"));
    helper.shutdown();
    const rows = store.shadowEpisodes();
    expect(rows.map((r) => [r.existed, r.enteredLength])).toEqual([
      ["exact", 26],
      ["no", 20],
    ]);
    expect(rows[1]?.at).toBe(4500);
  });

  it("does not count clearing a prefilled field as an entry", () => {
    void helper.handleReader(form(2000, "", "draft from yesterday"));
    void helper.handleReader(focus(FORM, NOTES, 3000));
    void helper.handleReader(form(4000, "", ""));
    helper.shutdown();
    expect(store.shadowEpisodes()).toEqual([]);
  });

  it("counts short entries without judging them, and never calls Jev or publishes", () => {
    void helper.handleReader(form(2000, "", ""));
    void helper.handleReader(focus(FORM, NOTES, 3000));
    void helper.handleReader(form(4000, "", "ok"));
    helper.shutdown();
    expect(store.shadowEpisodes()).toHaveLength(0);
    expect(store.counts()["shadow.entry_short"]).toBe(1);
    expect(published).toHaveLength(0);
  });

  it("writes no plain text to disk", () => {
    void helper.handleReader(source(1000, true));
    void helper.handleReader(form(2000, "", ""));
    void helper.handleReader(focus(FORM, EMAIL, 3000));
    void helper.handleReader(form(4000, "dana.whitfield@example.com", ""));
    helper.shutdown();
    store.close();
    for (const f of readdirSync(dir)) {
      const bytes = readFileSync(join(dir, f)).toString("latin1");
      for (const secret of ["dana", "QX-77120", "Reply to", "textfield:email"]) expect(bytes.includes(secret), `${f} has ${secret}`).toBe(false);
    }
    store = new Store(dir);
  });
});
