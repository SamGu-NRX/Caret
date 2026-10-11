// I6 (lead decision): a page plan presses nothing, so its last row says who goes on. "You press <label>" when the form
// it fills shows exactly one enabled forward button (Next, Continue, Review, Submit, Apply, Save and continue), named by
// its own label; "The rest is yours" with none or several. The row is never an action: lowering gives it no executor
// step, the run dispatches no press, and the executor refuses a hand-off that carries a means to act. Every name and
// value is invented.
import { afterEach, describe, expect, it } from "vitest";
import { Executor } from "../src/executor/executor.ts";
import { PlanError } from "../src/executor/schema.ts";
import { formScopeOf, readsForward } from "../src/goals/page-planner.ts";
import { ScreenModel } from "../src/model.ts";
import type { PageControl, ReaderVerb } from "../src/protocol.ts";
import { c, mixedControls } from "./fake-page.ts";
import { closeRigs, goalMessages, presses, rig, type Finished, type Segment } from "./page-rig.ts";

afterEach(closeRigs);

const fields = (): PageControl[] => [c("q1", "text", "Full name", { value: "" }), c("q2", "email", "Email", { value: "" })];
const settle = async (r: Awaited<ReturnType<typeof rig>>): Promise<void> => {
  await r.helper.goals.idle();
  await new Promise((x) => setTimeout(x, 0));
  await r.helper.goals.idle();
};

describe("which names read as forward", () => {
  it("takes the lead's names, alone or with a short tail, whatever their case and arrows", () => {
    for (const l of ["Next", "next →", "Continue", "Review", "Submit", "Apply", "Save and continue", "Submit Application", "Next step", "Continue to payment", "  Review & submit "]) expect(readsForward(l), l).toBe(true);
  });
  it("refuses other names, and a forward word inside a longer one", () => {
    for (const l of ["Back", "Cancel", "Save", "Search", "Nextdoor", "Applying", "Apply for this job", "Add another", "", "Submit my application to the team"]) expect(readsForward(l), l).toBe(false);
  });
});

describe("the form a control is in", () => {
  it("reads the frame and form scope from the walker's key", () => {
    expect(formScopeOf("f0/form[apply]/textbox:full name~0")).toBe("f0/form[apply]");
    expect(formScopeOf("f0/form@1/button:next~0")).toBe("f0/form@1");
    expect(formScopeOf("f2/button:next~0")).toBe("f2");
    // A name holding a slash is not a scope.
    expect(formScopeOf("f0/textbox:city/town~0")).toBe("f0");
    expect(formScopeOf("f0/form[a/b]/button:next~0")).toBe("f0/form[a/b]");
    expect(formScopeOf("f0/my-widget/button:next~0")).toBe("f0/my-widget");
  });
});

describe("the hand-off row a page plan ends with", () => {
  const last = async (controls: () => PageControl[]): Promise<Segment["steps"][number] | undefined> => {
    const r = await rig({ controls, title: "Apply: details" });
    const s = (await r.ask("fill out this form from my note")) as Segment;
    expect(s.event).toBe("segment");
    return s.steps.at(-1);
  };

  it("names the one forward button by its own label", async () => {
    expect(await last(() => [...fields(), c("b1", "button", "Back"), c("b2", "button", "Save and Continue")])).toMatchObject({ kind: "handoff", says: "You press Save and Continue" });
  });

  it("says the rest is yours with no forward button", async () => {
    expect(await last(() => [...fields(), c("b1", "button", "Back")])).toMatchObject({ kind: "handoff", says: "The rest is yours" });
  });

  it("says the rest is yours with two forward buttons, since Caret cannot tell which the user means", async () => {
    expect(await last(() => [...fields(), c("b1", "button", "Next"), c("b2", "button", "Submit")])).toMatchObject({ kind: "handoff", says: "The rest is yours" });
  });

  it("counts only buttons in the form it fills, enabled, and never a link or a file control", async () => {
    const other = (id: string, kind: PageControl["kind"], name: string, extra: Partial<PageControl> = {}): PageControl => ({ ...c(id, kind, name, extra), key: `form[search]/${kind}:${name.toLowerCase()}~0`, form: "form#search" });
    expect(await last(() => [...fields(), other("b1", "button", "Submit")])).toMatchObject({ says: "The rest is yours" });
    expect(await last(() => [...fields(), c("b1", "button", "Next", { disabled: true })])).toMatchObject({ says: "The rest is yours" });
    expect(await last(() => [...fields(), c("b1", "link", "Next")])).toMatchObject({ says: "The rest is yours" });
    expect(await last(() => [...fields(), c("b1", "button", "Continue"), other("b2", "button", "Submit")])).toMatchObject({ says: "You press Continue" });
  });

  it("is never pressed: the run has no executor step for it, presses nothing, and the end names it", async () => {
    const r = await rig({ controls: () => [...fields(), c("b1", "button", "Next")], title: "Apply: details" });
    const s = (await r.ask("fill out this form from my note")) as Segment;
    expect(s.steps.map((x) => x.says)).toEqual(["Full name: Robin Vale", "Email: robin@example.test", "You press Next"]);
    const seg = r.helper.goals.planOf(s.goalId)?.segments[0];
    expect(seg?.plan.steps.length).toBe(2);
    expect(seg?.plan.steps.some((x) => x.end.kind === "handoff")).toBe(false);
    const result = await r.accept(s);
    await settle(r);
    expect(result).toMatchObject({ outcome: "done", acted: 2 });
    expect(presses(r)).toBe(0);
    expect(goalMessages(r).some((m) => m.event === "step" && m.step === 2)).toBe(false);
    const end = goalMessages(r).find((m): m is Finished => m.event === "finished");
    expect(end).toMatchObject({ outcome: "done", says: "Done: 2 steps verified. You press Next." });
  });

  it("is refused anywhere but last in a page plan", async () => {
    const r = await rig({ controls: () => [...fields(), c("b1", "button", "Next")], title: "Apply: details" });
    const s = (await r.ask("fill out this form from my note")) as Segment;
    const plan = r.helper.goals.planOf(s.goalId);
    if (plan === null) throw new Error("no plan");
    const seg = plan.segments[0];
    if (seg === undefined) throw new Error("no segment");
    // The row moved ahead of a write.
    const moved = { ...plan, goalId: "g-moved", segments: [{ ...seg, steps: [seg.steps[2], seg.steps[0], seg.steps[1]].map((x, i) => ({ ...x, index: i })) as typeof seg.steps }] };
    expect(() => r.helper.goals.propose(moved, undefined, null)).toThrow(/not a hand-off row a page plan may offer/);
    // A row in a plan that is not a page plan.
    const { page: _page, ...native } = plan;
    expect(() => r.helper.goals.propose({ ...native, goalId: "g-native" }, undefined, null)).toThrow(/not a hand-off row a page plan may offer/);
  });
});

describe("the executor refuses a hand-off as an action (I6)", () => {
  it("refuses a plan whose hand-off carries a press, before any step runs", async () => {
    const verbs: ReaderVerb[] = [];
    const model = new ScreenModel();
    const ex = new Executor({ model, reader: { run: async (v: ReaderVerb) => (verbs.push(v), { type: "verbResult", v: 1, id: "r", at: 0, outcome: "ok", detail: null }) }, askJev: async () => { throw new Error("no Jev"); } } as unknown as ConstructorParameters<typeof Executor>[0]);
    const target = { key: "f0/form[apply]/button:next~0", role: "AXButton", describe: "Next", exact: true as const };
    const plan = { id: "p", title: "t", slots: {}, steps: [{ says: "You press Next", end: { kind: "handoff", window: { title: "Apply" }, target, why: "unverifiable" }, via: { kind: "press", target } }] };
    await expect(ex.run("t1", plan, {})).rejects.toThrow(PlanError);
    await expect(ex.run("t2", plan, {})).rejects.toThrow(/a hand-off is the user's to do/);
    expect(verbs).toEqual([]);
  });
});

// The mixed form's own row, as the host sees it in every page-goal preview of that fixture.
describe("the mixed form", () => {
  it("ends with its one forward button", async () => {
    const r = await rig({ controls: mixedControls });
    const s = (await r.ask("fill out this form from my note")) as Segment;
    expect(s.steps.at(-1)).toEqual({ index: s.steps.length - 1, kind: "handoff", says: "You press Submit Application" });
  });
});

describe("forgetting a source's values from a goal that ended (I6 review, GoalRuns.forgetSource)", () => {
  it("blanks the values and spans from that window, and a hand-off's quoted value in what the goal left", async () => {
    const r = await rig({ controls: () => [...fields(), c("b1", "button", "Next")], title: "Apply: details" });
    const { planPage } = await import("../src/goals/page-planner.ts");
    const { macClock } = await import("../src/offers/event-time.ts");
    const { jevPickingText } = await import("./builders.ts");
    const { byLabel, WIN } = await import("./fake-page.ts");
    const plan = await planPage(r.helper.model, { goalId: "g-forget", instruction: "fill out this form", windowId: WIN, scope: null, kind: "all", section: null, about: [], askJev: jevPickingText(byLabel, 0.95), now: Date.now(), clock: macClock(new Date()), readerSession: 0, pageDocument: (id) => r.host.registry.documentOf(id) });
    // A hand-off the plan left, quoting a value read from the note (as page-planner.ts leave records one).
    plan.left.push({ windowId: WIN, key: "k-choice", label: "Team", why: "dropped", says: "'Team' is yours: Caret leaves setting it to you ('Robotics Lab' fits it)", quotes: { windowId: "note", text: "Robotics Lab" } });
    r.helper.goals.propose(plan, undefined, null);
    // Not while it waits: a live goal still needs its values.
    r.helper.goals.forgetSource("g-forget", new Set(["note"]));
    expect(JSON.stringify(r.helper.goals.planOf("g-forget")?.left)).toMatch(/Robotics Lab/);
    r.helper.goals.readerRestarted();
    r.helper.goals.forgetSource("g-forget", new Set(["note"]));
    const kept = r.helper.goals.planOf("g-forget");
    const all = JSON.stringify(kept, (_, v: unknown) => (v instanceof Map ? [...v.entries()] : v));
    expect(all).not.toMatch(/Robotics Lab|Robin Vale|robin@example\.test/);
    expect(kept?.left.find((l) => l.key === "k-choice")).toEqual({ windowId: WIN, key: "k-choice", label: "Team", why: "dropped", says: "'Team' is yours: Caret leaves setting it to you ('…' fits it)" });
    expect(kept?.segments[0]?.steps.map((s) => s.says)).toEqual(["Full name: …", "Email: …", "You press Next"]);
  });
  it("G2 review: blanks the clause and the source texts a value was read from too", async () => {
    const r = await rig({ controls: () => [...fields(), c("b1", "button", "Next")], title: "Apply: details" });
    const { planPage } = await import("../src/goals/page-planner.ts");
    const { macClock } = await import("../src/offers/event-time.ts");
    const { jevPickingText } = await import("./builders.ts");
    const { byLabel, WIN } = await import("./fake-page.ts");
    const plan = await planPage(r.helper.model, { goalId: "g-clause", instruction: "fill out this form", windowId: WIN, scope: null, kind: "all", section: null, about: [], askJev: jevPickingText(byLabel, 0.95), now: Date.now(), clock: macClock(new Date()), readerSession: 0, pageDocument: (id) => r.host.registry.documentOf(id) });
    // A value read with a clause and from a longer source text. I1: fill records them in the value's write-contract
    // provenance (fill/contract.ts Provenance), which G2 kept as FillField.basis.clause and .from.
    for (const v of plan.inventory.values.values()) if (v.fill !== undefined) Object.assign(v, { provenance: { kind: "window", windowId: "note", nodeKey: "n", app: "", title: "", span: "source text Kestrel-7732 split", label: null, line: "the clause Kestrel-7731 quoted", partOf: null, context: null, lines: [], sentences: [] } });
    r.helper.goals.propose(plan, undefined, null);
    r.helper.goals.readerRestarted();
    r.helper.goals.forgetSource("g-clause", new Set(["note"]));
    const all = JSON.stringify(r.helper.goals.planOf("g-clause"), (_, v: unknown) => (v instanceof Map ? [...v.entries()] : v));
    expect(all).not.toMatch(/Kestrel-773/);
  });
});
