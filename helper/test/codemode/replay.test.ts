// Slice 2 (CU-COUNSEL-R2 D4): observe() ends a run as pending, and a replay of the same program on its record answers
// recorded choices without the chooser, serves recorded observations, and refuses any step or choice that differs from
// the run it replays. Synthetic snapshots; every name and code is invented.
import { describe, expect, test } from "vitest";
import { runCodePlan, type ChooserPort } from "../../src/codemode/sandbox.ts";
import type { PlanStep, PlanningSnapshot, Recorded, SandboxOutcome } from "../../src/codemode/types.ts";

const NAV = ["e:open", "e:yours"];
const INBOX: PlanningSnapshot = {
  snapshot: "s1",
  window: "w1",
  revision: "r1",
  title: "Inbox",
  targets: [
    { ref: "t1", label: "Kayak · Flight itinerary · 3m ago", kind: "row", canFill: false, options: [], allowedPressEffects: [], allowedNavigateEffects: NAV },
    { ref: "t2", label: "Dana Whitfield · Flight itinerary · 9:41 AM", kind: "row", canFill: false, options: [], allowedPressEffects: [], allowedNavigateEffects: NAV },
  ],
  values: [],
  questions: [
    {
      ref: "s1q1",
      text: "Which row of the list in 'Inbox' does the goal mean?",
      options: [
        { ref: "s1q1o1", label: "Kayak · Flight itinerary · 3m ago" },
        { ref: "s1q1o2", label: "Dana Whitfield · Flight itinerary · 9:41 AM" },
      ],
    },
  ],
};
/** Observation 1: Kayak's message open, its code a value, the reply field a target. */
const OPENED: PlanningSnapshot = {
  snapshot: "g1:s1",
  window: "g1:w2",
  revision: "g1:r2",
  title: "Inbox",
  targets: [{ ref: "g1:t1", label: "Reply", kind: "text", canFill: true, options: [], allowedPressEffects: [] }],
  values: [{ ref: "g1:v1", display: '"QX7R2P" (Confirmation number in Inbox)', origin: { kind: "span", snapshot: "g1:s2", source: "obs1:win", startUTF16: 0, endUTF16: 6, digest: "d" } }],
  questions: [],
};

/** Picks the Kayak row by choose(), opens it, observes, and fills the reply with the code. */
const PROGRAM = `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  const box = await caret.readWindow();
  const q = box.questions[0];
  const pick = await caret.choose(q.options.map((o) => o.ref));
  const label = q.options.find((o) => o.ref === pick).label;
  const open = caret.navigate(box.targets.find((t) => t.label === label).ref, "e:open");
  const seen = await caret.observe(open);
  const fill = caret.fill(seen.targets.find((t) => t.label === "Reply").ref, seen.values[0].ref);
  return caret.plan({ basedOn: box.snapshot, steps: [open, fill] });
}`;

/** A chooser that counts its calls and picks Kayak. */
function counting(): ChooserPort & { calls: number } {
  const f = Object.assign(async () => (f.calls++, "s1q1o1"), { calls: 0 });
  return f;
}

const ok = (o: SandboxOutcome): Extract<SandboxOutcome, { ok: true }> => {
  if (!o.ok) throw new Error(`refused: ${o.kind}: ${o.detail}`);
  return o;
};
const refusal = (o: SandboxOutcome): { kind: string; detail: string } => {
  if (o.ok) throw new Error(`expected a refusal, got ${JSON.stringify(o.plan.steps)}`);
  return { kind: o.kind, detail: o.detail };
};

/** The first run, and the record a goal keeps once its navigation ran and observation 1 was read. */
async function firstRun(): Promise<{ out: Extract<SandboxOutcome, { ok: true }>; record: Recorded }> {
  const out = ok(await runCodePlan(PROGRAM, [INBOX], counting(), { multiWindow: true, navigation: true }));
  const pending = out.pending;
  if (pending === null) throw new Error("expected a pending observe");
  const prefix: PlanStep[] = [...out.plan.steps, { ref: pending.ref, kind: "observe", after: pending.after }];
  return { out, record: { observations: [OPENED], choices: out.plan.choices.map((c) => ({ requestDigest: c.requestDigest, chosen: c.chosen })), prefix } };
}

describe("observe ends a first run as pending", () => {
  test("the plan stops at the navigate, Jev chose once, and nothing after the observe is registered", async () => {
    const chooser = counting();
    const out = ok(await runCodePlan(PROGRAM, [INBOX], chooser, { multiWindow: true, navigation: true }));
    expect(out.pending).toEqual({ ref: "step:2", after: "step:1", index: 0 });
    expect(out.plan.steps).toEqual([{ ref: "step:1", kind: "navigate", target: "t1", effect: "e:open" }]);
    expect(chooser.calls).toBe(1);
    expect(out.plan.choices).toEqual([{ question: "s1q1", offered: ["s1q1o1", "s1q1o2"], chosen: "s1q1o1", requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(out.stats).toMatchObject({ chooseCalls: 1, steps: 2 });
  });

  test("a run that may not observe again ends as observeBudget", async () => {
    expect(refusal(await runCodePlan(PROGRAM, [INBOX], counting(), { multiWindow: true, navigation: true, replay: { observations: [], choices: [], prefix: [], mayObserve: false } })).kind).toBe("observeBudget");
  });

  test("navigate and observe are refused outside a run that may navigate", async () => {
    expect(refusal(await runCodePlan(PROGRAM, [INBOX], counting(), { multiWindow: true }))).toMatchObject({ kind: "violation", detail: expect.stringMatching(/cannot navigate/) });
  });

  test("observe takes only the navigate created just before it", async () => {
    const program = `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  const box = await caret.readWindow();
  const open = caret.navigate(box.targets[0].ref, "e:open");
  await caret.observe("step:9");
  return caret.plan({ basedOn: box.snapshot, steps: [open] });
}`;
    expect(refusal(await runCodePlan(program, [INBOX], counting(), { multiWindow: true, navigation: true }))).toMatchObject({ kind: "violation", detail: expect.stringMatching(/observe takes the navigate step created just before it/) });
  });

  test("a row's navigate effect must be one it lists", async () => {
    const program = `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  const box = await caret.readWindow();
  return caret.plan({ basedOn: box.snapshot, steps: [caret.navigate(box.targets[0].ref, "e:select")] });
}`;
    expect(refusal(await runCodePlan(program, [INBOX], counting(), { multiWindow: true, navigation: true }))).toMatchObject({ kind: "violation", detail: expect.stringMatching(/no allowed navigate effect e:select/) });
  });
});

describe("a replay on the record", () => {
  test("answers the recorded choice without the chooser, serves the observation, and plans only after the prefix", async () => {
    const { record } = await firstRun();
    const chooser = counting();
    const out = ok(await runCodePlan(PROGRAM, [INBOX], chooser, { multiWindow: true, navigation: true, replay: { ...record, mayObserve: true } }));
    expect(chooser.calls).toBe(0);
    expect(out.pending).toBeNull();
    expect(out.plan.steps).toEqual([...record.prefix, { ref: "step:3", kind: "fill", target: "g1:t1", value: "g1:v1" }]);
    // Recorded choices and prefix steps count toward no budget.
    expect(out.stats).toMatchObject({ chooseCalls: 0, steps: 1 });
  });

  test("a recorded choice whose request digest differs ends as diverged before any chooser call", async () => {
    const { record } = await firstRun();
    const chooser = counting();
    const mutated = { ...record, choices: [{ requestDigest: "0".repeat(64), chosen: "s1q1o1" }] };
    expect(refusal(await runCodePlan(PROGRAM, [INBOX], chooser, { multiWindow: true, navigation: true, replay: { ...mutated, mayObserve: true } })).kind).toBe("diverged");
    expect(chooser.calls).toBe(0);
  });

  test("a step that differs from the recorded prefix ends as diverged", async () => {
    const { record } = await firstRun();
    const prefix: PlanStep[] = [{ ref: "step:1", kind: "navigate", target: "t2", effect: "e:open" }, ...record.prefix.slice(1)];
    expect(refusal(await runCodePlan(PROGRAM, [INBOX], counting(), { multiWindow: true, navigation: true, replay: { ...record, prefix, mayObserve: true } }))).toMatchObject({ kind: "diverged", detail: expect.stringMatching(/step 1/) });
  });

  test("a plan that reorders the executed prefix ends as diverged", async () => {
    const { record } = await firstRun();
    const reordered = PROGRAM.replace("steps: [open, fill]", "steps: [fill, open]");
    expect(refusal(await runCodePlan(reordered, [INBOX], counting(), { multiWindow: true, navigation: true, replay: { ...record, mayObserve: true } })).kind).toBe("diverged");
  });

  test("the per-run step budget counts only the steps after the prefix", async () => {
    const { record } = await firstRun();
    const run = (steps: number) => runCodePlan(PROGRAM, [INBOX], counting(), { multiWindow: true, navigation: true, limits: { steps }, replay: { ...record, mayObserve: true } });
    expect(ok(await run(1)).plan.steps).toHaveLength(3);
    expect(refusal(await run(0))).toMatchObject({ kind: "violation", detail: expect.stringMatching(/at most 0 steps/) });
  });

  test("an observation whose refs repeat a snapshot's is refused as input", async () => {
    const { record } = await firstRun();
    const clash = { ...OPENED, targets: [{ ...OPENED.targets[0]!, ref: "t1" }] };
    expect(refusal(await runCodePlan(PROGRAM, [INBOX], counting(), { multiWindow: true, navigation: true, replay: { ...record, observations: [clash], mayObserve: true } })).kind).toBe("input");
  });
});
