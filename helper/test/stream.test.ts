// The pattern acceptance over synthetic streams, without pacing. scripts/patterns-eval.ts runs the
// same streams at 50 events a second and records handling times.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import type { HelperMessage } from "../src/protocol.ts";
import { checkStream, distractorStream, plantedStream, replay } from "./stream.ts";

describe("pattern acceptance on synthetic streams", () => {
  let dir: string;
  let store: Store;
  let helper: Helper;
  let sent: HelperMessage[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-stream-"));
    store = new Store(dir);
    sent = [];
    helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => sent.push(m) });
  });
  afterEach(() => {
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds all three planted loops at round two and offers each routine only after two silent hits", async () => {
    const s = plantedStream();
    expect(s.messages.length).toBeGreaterThanOrEqual(2000);
    const r = await replay(helper, sent, s);
    const c = checkStream(s, r, helper);
    expect(c.loops.map((l) => [l.name, l.foundAtRoundTwo, l.predictionRight, l.finishRight])).toEqual(c.loops.map((l) => [l.name, true, true, true]));
    expect(c.routines.map((x) => x.offeredAt)).toEqual([[4, 5], [4, 5]]);
    // The stream's user types every offered value by hand. Each routine day has three: the first two
    // each leave a re-offer of the rest, and the third ends it. A loop's finish is re-offered only where
    // the user paused longer than EDIT_SETTLE_MS between rows (B9).
    expect(c.routines.map((x) => x.reofferedAt)).toEqual([[4, 4, 5, 5], [4, 4, 5, 5]]);
    expect(c.loops.map((l) => l.finishReoffers)).toEqual([1, 2, 0]);
    expect(c.routines.every((x) => x.offersRight)).toBe(true);
    expect(c.unexpectedOffers).toEqual([]);
  });

  it("makes no offer on the distractor stream", async () => {
    const s = distractorStream();
    expect(s.messages.length).toBeGreaterThanOrEqual(2000);
    const r = await replay(helper, sent, s);
    expect(r.offers).toEqual([]);
  });
});
