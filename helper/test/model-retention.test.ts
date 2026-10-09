// How long the screen model keeps a window's text (model.ts ScreenModel.close, purge, expire). Every value is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { RollingText } from "../src/rolling-text.ts";
import { Store } from "../src/store.ts";
import { field, FIXTURE_APP, MAIL_APP, snap, text, value } from "./builders.ts";

const PLANTED = "Ines Vandermeer, 4471 Larkspur Lane";
const NOTE = "w-note";

/** Every piece of text the model holds anywhere: its windows' nodes, titles and values, and its change log. */
function held(m: ScreenModel): string[] {
  const out: string[] = [];
  for (const w of m.windows.values()) {
    out.push(w.window.title);
    for (const n of w.nodes.values()) out.push(n.label ?? "", n.value ?? "", n.placeholder ?? "");
    for (const v of w.values) out.push(v.text);
  }
  for (const c of m.changeLog()) out.push(c.before ?? "", c.after ?? "");
  return out;
}
const holds = (m: ScreenModel, s: string): boolean => held(m).some((t) => t.includes(s));

/** A note showing the planted line, then the same note with that line edited, so the change log quotes it too. */
function planted(m: ScreenModel, at: number): void {
  m.apply(snap([text("n/line~0", PLANTED), field("n/body~0", "")], { at, windowId: NOTE, values: [value("address", "4471 Larkspur Lane", "n/line~0")] }));
  m.apply(snap([text("n/line~0", `${PLANTED} (old)`), field("n/body~0", PLANTED)], { at: at + 1000, windowId: NOTE }));
}

describe("a closed window", () => {
  it("leaves nothing of its text in the model, change log included", () => {
    const m = new ScreenModel();
    planted(m, 1000);
    expect(holds(m, PLANTED)).toBe(true);
    expect(m.close(NOTE, 3000)?.kind).toBe("windowClosed");
    expect(holds(m, PLANTED)).toBe(false);
    expect(m.changeLog().at(-1)).toMatchObject({ windowId: NOTE, kind: "windowClosed" });
  });

  it("keeps the change log of the windows still open", () => {
    const m = new ScreenModel();
    planted(m, 1000);
    m.apply(snap([text("o/line~0", "Larkspur")], { at: 1000, windowId: "w-other" }));
    m.apply(snap([text("o/line~0", "Larkspur Lane")], { at: 2000, windowId: "w-other" }));
    m.close(NOTE, 3000);
    expect(m.changeLog().filter((c) => c.windowId === "w-other" && c.kind === "value")).toHaveLength(1);
  });
});

describe("a purged window (a site switched off)", () => {
  it("keeps only the text of its purged walk, and its change log never quotes what the purge removed", () => {
    const m = new ScreenModel();
    planted(m, 1000);
    m.purge(snap([text("n/kept~0", "Shipping")], { at: 3000, windowId: NOTE }));
    expect(holds(m, PLANTED)).toBe(false);
    expect(holds(m, "4471 Larkspur")).toBe(false);
    expect([...(m.windows.get(NOTE)?.nodes.keys() ?? [])]).toEqual(["n/kept~0"]);
  });

  it("drops the removed text from the rolling text at once and keeps what the window still shows", () => {
    const m = new ScreenModel();
    const t = new RollingText();
    const note = (): WindowState => {
      const w = m.windows.get(NOTE);
      if (w === undefined) throw new Error("the note is not in the model");
      return w;
    };
    m.apply(snap([text("n/line~0", PLANTED), text("n/kept~0", "Shipping address")], { at: 1000, windowId: NOTE }));
    t.observe(note(), 1000);
    m.purge(snap([text("n/kept~0", "Shipping address")], { at: 2000, windowId: NOTE }));
    t.keepOnly(note());
    const opts = { excludeWindowId: "w-form", seenBy: 2000 };
    expect(t.find(PLANTED, null, opts)).toBeNull();
    expect(t.find("Shipping address", null, opts)?.obs.firstSeen).toBe(1000);
  });
});

describe("a window whose text is not read again", () => {
  const MIN = 60 * 1000;

  it("is gone from the model ten minutes after its last snapshot, change log included", () => {
    const m = new ScreenModel();
    planted(m, 0);
    expect(m.expire(1000 + 10 * MIN, null)).toEqual([]);
    expect(holds(m, PLANTED)).toBe(true);
    expect(m.expire(1001 + 10 * MIN, null)).toEqual([NOTE]);
    expect(m.windows.has(NOTE)).toBe(false);
    expect(holds(m, PLANTED)).toBe(false);
  });

  it("stays while each snapshot refreshes it", () => {
    const m = new ScreenModel();
    planted(m, 0);
    m.apply(snap([text("n/line~0", PLANTED)], { at: 9 * MIN, windowId: NOTE }));
    expect(m.expire(18 * MIN, null)).toEqual([]);
    expect(holds(m, PLANTED)).toBe(true);
    expect(m.expire(19 * MIN + 1, null)).toEqual([NOTE]);
  });

  it("stays while it is the window the user is in, and for ten minutes after", () => {
    const m = new ScreenModel();
    planted(m, 0);
    for (let t = 0; t <= 60 * MIN; t += 10_000) expect(m.expire(t, NOTE)).toEqual([]);
    expect(holds(m, PLANTED)).toBe(true);
    expect(m.expire(70 * MIN, null)).toEqual([]);
    expect(m.expire(70 * MIN + 1, null)).toEqual([NOTE]);
    expect(holds(m, PLANTED)).toBe(false);
  });

  it("comes back with its next snapshot without logging a window opening, and only that snapshot's text", () => {
    const m = new ScreenModel();
    planted(m, 0);
    m.expire(11 * MIN, null);
    const back = m.apply(snap([text("n/other~0", "Shipping")], { at: 12 * MIN, windowId: NOTE }));
    expect(back.some((c) => c.kind === "windowOpened")).toBe(false);
    expect(holds(m, PLANTED)).toBe(false);
    // A closed window's id is spent: the next window to bring it opens as new.
    m.close(NOTE, 13 * MIN);
    expect(m.apply(snap([], { at: 14 * MIN, windowId: NOTE })).map((c) => c.kind)).toEqual(["windowOpened"]);
  });

  it("is not brought back by a purge", () => {
    const m = new ScreenModel();
    planted(m, 0);
    m.expire(11 * MIN, null);
    m.purge(snap([text("n/line~0", PLANTED)], { at: 0, windowId: NOTE }));
    expect(m.windows.has(NOTE)).toBe(false);
  });
});

describe("the helper's copies of a window's text", () => {
  const MIN = 60 * 1000;
  const FORM = "5150-1";
  let dir: string;
  let store: Store;
  let h: Helper;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-retention-"));
    store = new Store(join(dir, "data"));
    h = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: () => {} });
    void h.handleReader({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 1, version: "t" });
    // The user is in a form; the note with the planted line is in another app, left alone.
    void h.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: 1, from: null, to: FIXTURE_APP });
    void h.handleReader(snap([field("f/name~0", "")], { at: 1, windowId: FORM, focused: true }));
    void h.handleReader(snap([text("n/line~0", PLANTED)], { at: 1, windowId: NOTE, app: MAIL_APP }));
  });
  afterEach(() => {
    h.shutdown();
    h.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const found = (at: number) => h.text.find(PLANTED, null, { excludeWindowId: FORM, seenBy: at });

  it("hold a planted value for ten minutes without a snapshot, then neither the model nor the rolling text has it", () => {
    for (let t = 10_000; t <= 10 * MIN; t += 10_000) h.tick(t);
    expect(holds(h.model, PLANTED)).toBe(true);
    expect(found(10 * MIN)).not.toBeNull();
    h.tick(10 * MIN + 10_000);
    expect(holds(h.model, PLANTED)).toBe(false);
    expect(found(10 * MIN + 10_000)).toBeNull();
    // The form the user is in stays.
    expect(h.model.windows.has(FORM)).toBe(true);
  });

  it("drop it from the model at once when its window closes", () => {
    void h.handleReader({ type: "windowClosed", v: PROTOCOL_VERSION, at: 2, windowId: NOTE });
    expect(holds(h.model, PLANTED)).toBe(false);
  });

  it("drop it from the model and the rolling text at once when its site is switched off", () => {
    h.purgeWindow(snap([text("n/kept~0", "Inbox")], { at: 2, windowId: NOTE, app: MAIL_APP }));
    expect(holds(h.model, PLANTED)).toBe(false);
    expect(found(2)).toBeNull();
  });
});
