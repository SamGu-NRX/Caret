// C2: the page goal, end to end through the Helper and the page engine of fill-transaction.test.ts, for what fill
// finds in round 2: a month input (lead decision 1), memory values written through a control's conversion (decisions 4
// and 5), a place's country (decision 2) and a long form in parts of 20 (decision 3). Each write is previewed, needs its
// own acceptance and is undone with its segment. Every name and value is invented.
import { afterEach, describe, expect, it } from "vitest";
import type { PageControl } from "../src/protocol.ts";
import { c } from "./fake-page.ts";
import { closeRigs, goalMessages, presses, rig, type Finished, type Segment } from "./page-rig.ts";

afterEach(closeRigs);

describe("a month input (C2 decision 1)", () => {
  it("writes the month and year the user wrote, and undo empties it", async () => {
    const controls = (): PageControl[] => [c("e1", "text", "Employer", { value: "" }), c("e2", "month", "Start date", { value: "" })];
    const r = await rig({ controls, note: "Employer: Tallgrass Mechatronics\nStart date: Aug '22", picks: { Employer: "Tallgrass Mechatronics", "Start date": "Aug '22" } });
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview.steps.map((s) => s.says)).toEqual(["Employer: Tallgrass Mechatronics", "Start date: 2022-08", "The rest is yours"]);
    expect((await r.accept(preview))?.outcome).toBe("done");
    await r.helper.goals.idle();
    expect(r.page.shown("e2")).toBe("2022-08");
    expect(presses(r)).toBe(0);
    const u = await r.helper.executor.undo(`${preview.goalId}:s0`);
    expect(u.notRestored).toEqual([]);
    expect(r.page.shown("e2")).toBe("");
    expect(goalMessages(r).find((m): m is Finished => m.event === "finished")?.outcome).toBe("done");
  });
});
