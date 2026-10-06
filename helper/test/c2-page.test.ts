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

describe("a value from memory written through a control's conversion (C2 decisions 4 and 5)", () => {
  const options = (labels: string[]) => [{ value: "", label: "Select...", selected: true }, ...labels.map((l) => ({ value: l.toLowerCase(), label: l, selected: false }))];
  const controls = (): PageControl[] => [
    c("e1", "text", "First name", { value: "" }),
    c("e2", "date", "Date of birth", { value: "" }),
    c("e3", "select", "Dietary needs", { options: options(["None", "Vegetarian", "Vegan"]) }),
    c("e4", "select", "Are you authorized to work in your country of residence?", { options: options(["Yes", "No"]) }),
  ];
  const remember = (r: Awaited<ReturnType<typeof rig>>, label: string, value: string): string => {
    const added = r.helper.handleMemory({ type: "memoryRequest", v: 1, requestId: `m-${label}`, op: "add", kind: "about", fields: { label, value, source: "typed" } });
    return added.entries?.[0]?.id as string;
  };
  const picks = { "First name": "Jo", "Date of birth": "March 14, 1990", "Dietary needs": "vegetarian", "Are you authorized to work in your country of residence?": "yes" };

  it("runs to done: the entries still give what was written, though the page holds it in another form", async () => {
    const r = await rig({ controls, note: "First name: Jo", picks });
    remember(r, "Date of birth", "March 14, 1990");
    remember(r, "diet", "vegetarian");
    remember(r, "Work authorization", "yes");
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview.steps.map((s) => s.says)).toEqual(["First name: Jo", "Date of birth: 1990-03-14", "Dietary needs: Vegetarian", "Are you authorized to work in your country of residence?: Yes", "The rest is yours"]);
    expect((await r.accept(preview))?.outcome).toBe("done");
    await r.helper.goals.idle();
    expect([r.page.shown("e2"), r.page.shown("e3"), r.page.shown("e4")]).toEqual(["1990-03-14", "Vegetarian", "Yes"]);
    expect(goalMessages(r).find((m): m is Finished => m.event === "finished")?.outcome).toBe("done");
    expect((await r.helper.executor.undo(`${preview.goalId}:s0`)).notRestored).toEqual([]);
  });

  it("writes a C1 yes-or-no entry as the menu's own Yes (base: the run stopped, reading 'yes' as changed)", async () => {
    const r = await rig({ controls, note: "First name: Jo", picks });
    remember(r, "Work authorization", "yes");
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview.steps.map((s) => s.says)).toContain("Are you authorized to work in your country of residence?: Yes");
    expect((await r.accept(preview))?.outcome).toBe("done");
    await r.helper.goals.idle();
    expect(r.page.shown("e4")).toBe("Yes");
    expect(goalMessages(r).filter((m) => m.event === "stopped")).toEqual([]);
  });

  it("stops before writing when an entry changed after the preview", async () => {
    const r = await rig({ controls, note: "First name: Jo", picks });
    const diet = remember(r, "diet", "vegetarian");
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview.steps.map((s) => s.says)).toContain("Dietary needs: Vegetarian");
    r.helper.handleMemory({ type: "memoryRequest", v: 1, requestId: "m2", op: "edit", id: diet, fields: { label: "diet", value: "vegan" } });
    expect(await r.accept(preview)).toBeNull();
    await r.helper.goals.idle();
    expect(goalMessages(r).find((m) => m.event === "stopped")).toMatchObject({ reason: "sourceChanged" });
    expect(r.page.shown("e3")).toBe("");
  });
});
