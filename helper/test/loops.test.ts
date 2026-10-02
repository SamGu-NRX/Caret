import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { describeTransfer, templateOf } from "../src/patterns/shape.ts";
import { LoopRecognizer, type LoopEvent } from "../src/patterns/loops.ts";
import { Desk, PEOPLE, cellKey, emailOf, grid, roster } from "./scene.ts";

describe("templateOf", () => {
  it("drops every ordinal and keeps the field's label", () => {
    expect(templateOf("app/standard/row:row #~2/textfield:guest~3", "AXTextField")).toBe("app/standard/row:row #/textfield:guest");
  });
  it("replaces a static text's own label, which is its content", () => {
    expect(templateOf("app/standard/group:attendees/statictext:dana whitfield~0", "AXStaticText")).toBe("app/standard/group:attendees/statictext:*");
  });
});

describe("loop recognizer over the helper's transfers", () => {
  let dir: string;
  let store: Store;
  let helper: Helper;
  let desk: Desk;
  let loops: LoopRecognizer;
  let events: LoopEvent[];
  let seen: number;

  /** Feeds every transfer the helper has detected since the last call to the recognizer. */
  const feed = (): void => {
    for (const t of helper.recentTransfers.slice(seen)) {
      const p = describeTransfer(helper.model, t, helper.text.findAll(t.value, t.kind, { excludeWindowId: t.dst.windowId, seenBy: t.at }));
      if (p !== null) events.push(...loops.onTransfer(p));
    }
    seen = helper.recentTransfers.length;
  };
  /** The user fills one cell; the recognizer hears about it as soon as the edit settles, as it would live. */
  const fill = (...a: Parameters<Desk["fill"]>): void => {
    desk.fill(...a);
    feed();
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-loops-"));
    store = new Store(dir);
    desk = new Desk();
    helper = new Helper({ store, askJev: null, shadow: true, allowBackgroundFocus: false, publish: () => {}, readerLink: desk });
    desk.attach(helper);
    loops = new LoopRecognizer(helper.model);
    events = [];
    seen = 0;
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("predicts row 3 after rows 1 and 2, and offers rows 4 to 6 once row 3 is typed", () => {
    const src = roster();
    const dst = grid();
    desk.showList(src);
    desk.advance(1000);
    desk.showGrid(dst);
    fill(dst, 0, 0, PEOPLE[0]!);
    expect(events).toEqual([]);
    fill(dst, 1, 0, PEOPLE[1]!);
    expect(events.map((e) => e.type)).toEqual(["predict"]);
    const p = events[0] as Extract<LoopEvent, { type: "predict" }>;
    expect(p.cells.map((c) => [c.dstKey, c.value])).toEqual([[cellKey(dst, 2, 0), PEOPLE[2]]]);

    fill(dst, 2, 0, PEOPLE[2]!);
    const c = events[1] as Extract<LoopEvent, { type: "confirmed" }>;
    expect(c.type).toBe("confirmed");
    expect(c.rest.map((r) => r.map((x) => [x.dstKey, x.value]))).toEqual([3, 4, 5].map((i) => [[cellKey(dst, i, 0), PEOPLE[i]]]));
  });

  it("finds a two-column loop at round two from a list with two lines per person", () => {
    const lines = PEOPLE.flatMap((n) => [n, emailOf(n)]);
    const src = roster(lines);
    const dst = grid(["Name", "Email"], 5);
    desk.showList(src);
    desk.advance(1000);
    desk.showGrid(dst);
    for (let r = 0; r < 2; r++) {
      fill(dst, r, 0, PEOPLE[r]!);
      fill(dst, r, 1, emailOf(PEOPLE[r]!));
    }
    feed();
    const p = events.find((e) => e.type === "predict");
    expect(p?.type === "predict" && p.cells.map((c) => c.value)).toEqual([PEOPLE[2], emailOf(PEOPLE[2]!)]);
  });

  it("ends the loop when the user types something else into the predicted row", () => {
    const dst = grid();
    desk.showList(roster());
    desk.advance(1000);
    desk.showGrid(dst);
    fill(dst, 0, 0, PEOPLE[0]!);
    fill(dst, 1, 0, PEOPLE[1]!);
    fill(dst, 2, 0, PEOPLE[5]!);
    feed();
    expect(events.map((e) => e.type)).toEqual(["predict", "ended"]);
    expect(loops.active).toBeNull();
  });

  it("does not see a loop in two transfers whose sources are far apart", () => {
    const dst = grid();
    desk.showList(roster());
    desk.advance(1000);
    desk.showGrid(dst);
    fill(dst, 0, 0, PEOPLE[0]!);
    fill(dst, 1, 0, PEOPLE[6]!);
    feed();
    expect(events).toEqual([]);
  });

  it("does not pair a name with an email from the same list, though they share a template", () => {
    const src = roster(PEOPLE.flatMap((n) => [n, emailOf(n)]));
    const dst = grid();
    desk.showList(src);
    desk.advance(1000);
    desk.showGrid(dst);
    fill(dst, 0, 0, PEOPLE[0]!);
    fill(dst, 1, 0, emailOf(PEOPLE[1]!));
    expect(events).toEqual([]);
  });

  it("keeps a loop whose values are also on screen in a second window", () => {
    desk.showList(roster());
    desk.showList(roster(PEOPLE.slice(0, 4), "5150-8"));
    desk.advance(1000);
    const dst = grid();
    desk.showGrid(dst);
    fill(dst, 0, 0, PEOPLE[0]!);
    fill(dst, 1, 0, PEOPLE[1]!);
    expect(events.map((e) => e.type)).toEqual(["predict"]);
  });

  it("offers nothing when the next destination is already filled", () => {
    const dst = grid();
    dst.values.set(cellKey(dst, 2, 0), "Already here");
    desk.showList(roster());
    desk.advance(1000);
    desk.showGrid(dst);
    fill(dst, 0, 0, PEOPLE[0]!);
    fill(dst, 1, 0, PEOPLE[1]!);
    feed();
    expect(events).toEqual([]);
  });
});
