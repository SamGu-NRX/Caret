// D2-06: a goal program's DraftPlan lowered to executor end states, cut into segments, and digested. The press
// registry is strict and isolated: one capability, and Send, Submit, Pay and Delete are always the user's.
import { afterEach, describe, expect, it } from "vitest";
import { runCodePlan } from "../src/codemode/sandbox.ts";
import type { DraftPlan, PlanningSnapshot } from "../src/codemode/types.ts";
import { classifyPress } from "../src/executor/risk.ts";
import { allowedEffects, PRESS_CAPABILITIES, pressVerdict, YOURS_EFFECT } from "../src/goals/capabilities.ts";
import { buildInventory } from "../src/goals/inventory.ts";
import { GoalError, lowerGoal, MAX_SEGMENTS } from "../src/goals/lower.ts";
import { goalDigest, segmentDigest, type GoalDomain, type GoalInventory, type GoalPlan, type GoalStep, type TargetBinding, type ValueBinding } from "../src/goals/plan.ts";
import { macClock } from "../src/offers/event-time.ts";
import { cannedProgram, caseWindow, detailsWindow, goalScene, mailWindow, replyWindow, wizardWindow, type CannedStep, type DeskWindow, type GoalScene } from "./goal-desk.ts";

const native = { windowKind: "standard", bundleId: "dev.caret.supportfixture", page: false } as const;

describe("the press registry", () => {
  it("holds exactly one capability, reveal on a whole 'Next', and every label it names is one the boundary tables allow", () => {
    expect(PRESS_CAPABILITIES.map((c) => [c.effect, [...c.labels], [...c.roles], c.verifier, c.endsSegment])).toEqual([["e:reveal", ["next"], ["AXButton"], "fieldsRevealed", true]]);
    for (const c of PRESS_CAPABILITIES) for (const l of c.labels) expect(classifyPress({ label: l, windowKind: "standard", bundleId: "dev.caret.fixture" }), l).toBe("safe");
    expect(Object.isFrozen(PRESS_CAPABILITIES) && PRESS_CAPABILITIES.every((c) => Object.isFrozen(c) && Object.isFrozen(c.labels))).toBe(true);
  });

  it("hands Send, Submit, Pay and Delete to the user whatever effect the program names, by their risk class", () => {
    for (const [label, why] of [["Send", "outbound"], ["Submit", "outbound"], ["Send now", "outbound"], ["Pay", "money"], ["Pay now", "money"], ["Delete", "destructive"], ["Delete draft", "destructive"]] as const) {
      for (const effect of ["e:reveal", YOURS_EFFECT, null]) {
        const v = pressVerdict({ label, role: "AXButton", ...native }, effect);
        expect(v.kind === "handoff" && v.why, `${label} ${effect}`).toBe(why);
      }
      expect(allowedEffects({ label, role: "AXButton", ...native })).toEqual([YOURS_EFFECT]);
    }
  });

  it("presses a native 'Next' only for e:reveal; Continue, Save draft, a page's Next, a system prompt's Next and a link are the user's", () => {
    const next = pressVerdict({ label: "  Next ", role: "AXButton", ...native }, "e:reveal");
    expect(next.kind === "press" && next.capability.effect).toBe("e:reveal");
    expect(allowedEffects({ label: "Next", role: "AXButton", ...native })).toEqual(["e:reveal", YOURS_EFFECT]);
    const cases: [string, Parameters<typeof pressVerdict>[0], string | null, string][] = [
      ["Continue", { label: "Continue", role: "AXButton", ...native }, "e:reveal", "unverifiable"],
      ["Save draft", { label: "Save draft", role: "AXButton", ...native }, "e:reveal", "unverifiable"],
      ["Next page", { label: "Next page", role: "AXButton", ...native }, "e:reveal", "unverifiable"],
      ["page Next", { label: "Next", role: "AXButton", windowKind: "page", bundleId: "com.google.Chrome", page: true }, "e:reveal", "unverifiable"],
      ["system Next", { label: "Next", role: "AXButton", windowKind: "systemdialog", bundleId: "dev.caret.fixture", page: false }, "e:reveal", "system"],
      ["link Next", { label: "Next", role: "AXLink", ...native }, "e:reveal", "unverifiable"],
      ["Next as yours", { label: "Next", role: "AXButton", ...native }, YOURS_EFFECT, "unverifiable"],
      ["unknown effect", { label: "Next", role: "AXButton", ...native }, "e:save", "unverifiable"],
    ];
    for (const [name, t, effect, why] of cases) {
      const v = pressVerdict(t, effect);
      expect(v.kind === "handoff" && v.why, name).toBe(why);
    }
    expect(allowedEffects({ label: "Continue", role: "AXButton", ...native })).toEqual([YOURS_EFFECT]);
  });
});

// MARK: - lowering, over real snapshots of the desk's windows

const scenes: GoalScene[] = [];
afterEach(async () => {
  for (const s of scenes.splice(0)) await s.close();
});

/** Freezes the desk's windows as a goal request would, runs the canned program, and lowers it. */
async function lowered(windows: DeskWindow[], acting: string[], steps: CannedStep[], o: { multiWindow?: boolean; calendar?: boolean } = {}): Promise<GoalPlan> {
  const sc = goalScene({ scripts: [], windows, userWindow: acting[0] as string });
  scenes.push(sc);
  const inv = buildInventory(sc.helper.model, { instruction: "do the goal", windows: acting, memory: [], calendar: o.calendar === false ? null : "Caret", clock: macClock(new Date(sc.desk.at)), now: sc.desk.at, readerSession: 1 });
  const ran = await runCodePlan(cannedProgram(inv.snapshots, steps), inv.snapshots, async () => null, { multiWindow: o.multiWindow ?? true });
  if (!ran.ok) throw new Error(`sandbox ${ran.kind}: ${ran.detail}`);
  return lowerGoal("goal-t", "do the goal", ran.plan, inv.inventory);
}

const MAIL_TO_SUPPORT: CannedStep[] = [
  { fill: { window: "New case", target: "Order number", value: "ORD-2026-48213" } },
  { fill: { window: "Case details", target: "Description", value: "cracked base" } },
];

describe("lowering", () => {
  it("cuts mail to support form into two segments, one window each, of exact-key value writes with their sources", async () => {
    const g = await lowered([mailWindow(), caseWindow(), detailsWindow()], ["7171-1", "7171-2"], MAIL_TO_SUPPORT);
    expect(g.segments.map((s) => [s.index, s.reason, s.domain.kind === "window" ? s.domain.windowId : s.domain.calendar, s.steps.map((x) => x.kind)])).toEqual([
      [0, "start", "7171-1", ["write"]],
      [1, "crossWindow", "7171-2", ["write"]],
    ]);
    const [a, b] = g.segments;
    // Exact targets: the previewed element by key and role, never a look-alike by label.
    expect(a?.plan.steps[0]?.end).toMatchObject({ kind: "valueEquals", window: { bundleId: "dev.caret.supportfixture", title: "{{title}}" }, target: { key: "{{k0}}", role: "{{r0}}", exact: true }, value: "{{v0}}" });
    expect(a?.slots).toMatchObject({ title: "Support — New case", k0: "dev.caret.supportfixture/standard/textfield:order number~0", v0: "ORD-2026-48213" });
    expect(b?.slots.v0).toBe("The desk lamp arrived with a cracked base and does not switch on.");
    // Each value names where it was read, which the digest covers and a recheck reads again.
    expect(a?.steps[0]?.value?.source).toMatchObject({ windowId: "6161-1", key: "dev.caret.mailfixture/standard/statictext:line 2~0" });
    expect(g.digest).toBe(goalDigest(g.programHash, g.segments.map((s) => s.digest), g.warnings));
  });

  it("keeps D2-05's one-window rule unless the run asks for a goal: the same program is a violation without multiWindow", async () => {
    await expect(lowered([mailWindow(), caseWindow(), detailsWindow()], ["7171-1", "7171-2"], MAIL_TO_SUPPORT, { multiWindow: false })).rejects.toThrow(/violation: .*outside snapshot s1/);
  });

  it("lowers the calendar to a calendarEvent of the derived event, then the reply's writes, and Send to the user as an outbound hand-off", async () => {
    const g = await lowered([mailWindow(), replyWindow()], ["6161-2"], [
      { fill: { window: "Calendar", target: "Caret", value: "Meet Priya" } },
      { fill: { window: "Re: Order", target: "To", value: "priya.raman@northwind.example" } },
      { fill: { window: "Re: Order", target: "Message", value: "cracked base" } },
      { press: { window: "Re: Order", target: "Send", effect: YOURS_EFFECT } },
    ]);
    expect(g.segments.map((s) => [s.reason, s.domain.kind, s.steps.map((x) => x.kind)])).toEqual([
      ["start", "calendar", ["calendar"]],
      ["crossWindow", "window", ["write", "write", "handoff"]],
    ]);
    const cal = g.segments[0]?.plan.steps[0]?.end;
    expect(cal).toMatchObject({ kind: "calendarEvent", calendar: "{{calendar}}", title: "{{t0}}" });
    // 3:00 to 3:45 PM PT, in whatever zone this Mac is in.
    expect(cal?.kind === "calendarEvent" && [Date.parse(cal.start), Date.parse(cal.end)]).toEqual([Date.parse("2026-10-08T15:00:00-07:00"), Date.parse("2026-10-08T15:45:00-07:00")]);
    expect(g.segments[0]?.slots).toMatchObject({ calendar: "Caret", t0: "Meet Priya" });
    expect(g.segments[1]?.plan.steps[2]?.end).toMatchObject({ kind: "handoff", why: "outbound" });
    expect(g.segments[1]?.steps[2]?.says).toBe("'Send' reads as outbound; you press it");
    expect(g.warnings).toEqual([]);
  });

  it("refuses Send as Caret's own press: a program cannot name e:reveal for it, and lowering hands it off even if a snapshot listed it", async () => {
    // The sandbox refuses an effect the target does not list.
    const sc = goalScene({ scripts: [], windows: [mailWindow(), replyWindow()], userWindow: "6161-2" });
    scenes.push(sc);
    const inv = buildInventory(sc.helper.model, { instruction: "x", windows: ["6161-2"], memory: [], calendar: null, clock: macClock(new Date(sc.desk.at)), now: sc.desk.at, readerSession: 1 });
    const send = inv.snapshots[0]?.targets.find((t) => t.label === "Send");
    expect(send?.allowedPressEffects).toEqual([YOURS_EFFECT]);
    const ran = await runCodePlan(cannedProgram(inv.snapshots, [{ press: { window: "Re: Order", target: "Send", effect: "e:reveal" } }]), inv.snapshots, async () => null, { multiWindow: true });
    expect(!ran.ok && ran.kind === "violation" && ran.detail).toMatch(/no allowed press effect e:reveal/);
    // Lowering on its own, given a draft that names e:reveal for Send: a hand-off, said as a warning, never a press.
    const draft: DraftPlan = { basedOn: "s1", window: "w1", choices: [], programDigest: "a".repeat(64), steps: [{ ref: "step:1", kind: "fill", target: "t1", value: "v1" }, { ref: "step:2", kind: "press", target: send?.ref ?? "", effect: "e:reveal" }] };
    const g = lowerGoal("goal-send", "x", { ...draft, steps: [{ ref: "step:1", kind: "fill", target: inv.snapshots[0]?.targets.find((t) => t.label === "To")?.ref ?? "", value: [...inv.inventory.values.values()].find((v) => v.text.includes("@"))?.ref ?? "" }, draft.steps[1] as DraftPlan["steps"][number]] }, inv.inventory);
    const last = g.segments[0]?.steps.at(-1);
    expect([last?.kind, last?.handoff, last?.effect]).toEqual(["handoff", "outbound", null]);
    expect(g.segments[0]?.plan.steps.some((s) => s.via?.kind === "press")).toBe(false);
    expect(g.warnings).toEqual(["'Send' reads as outbound; you press it."]);
  });

  it("lowers Next with e:reveal to a fieldsRevealed press that ends its segment; steps after it in the window are another segment", async () => {
    const g = await lowered([mailWindow(), wizardWindow()], ["7171-3"], [
      { fill: { window: "Report a problem", target: "Order number", value: "ORD-2026-48213" } },
      { press: { window: "Report a problem", target: "Next", effect: "e:reveal" } },
    ]);
    expect(g.segments.map((s) => [s.reason, s.steps.map((x) => [x.kind, x.effect])])).toEqual([["start", [["write", null], ["press", "e:reveal"]]]]);
    expect(g.segments[0]?.plan.steps[1]).toMatchObject({ end: { kind: "fieldsRevealed", target: { key: "{{k1}}", role: "{{r1}}", exact: true } }, via: { kind: "press", target: { key: "{{k1}}", role: "{{r1}}", label: "{{l1}}", exact: true } } });
    expect(g.segments[0]?.slots).toMatchObject({ r1: "AXButton", l1: "Next" });
    const after = await lowered([mailWindow(), wizardWindow()], ["7171-3"], [
      { press: { window: "Report a problem", target: "Next", effect: "e:reveal" } },
      { fill: { window: "Report a problem", target: "Order number", value: "ORD-2026-48213" } },
    ]);
    expect(after.segments.map((s) => [s.reason, s.steps.map((x) => x.kind)])).toEqual([["start", ["press"]], ["afterReveal", ["write"]]]);
  });

  it("hands an unknown press (Continue) to the user and ends the plan there", async () => {
    const g = await lowered([mailWindow(), wizardWindow()], ["7171-3"], [
      { fill: { window: "Report a problem", target: "Order number", value: "ORD-2026-48213" } },
      { press: { window: "Report a problem", target: "Continue", effect: YOURS_EFFECT } },
    ]);
    expect(g.segments[0]?.steps.map((x) => [x.kind, x.handoff, x.says])).toEqual([["write", null, "Order number: ORD-2026-48213"], ["handoff", "unverifiable", "You press 'Continue'"]]);
    expect(g.segments[0]?.plan.steps[1]?.end).toMatchObject({ kind: "handoff", why: "unverifiable" });
  });
});

// MARK: - refusals, on a hand-built inventory

const win = { kind: "window" as const, windowId: "w-a", pid: 10, bundleId: "dev.caret.a", appName: "A", title: "Form A", number: null, windowKind: "standard", page: false };
const page = { ...win, windowId: "page:e1:3", bundleId: "com.google.Chrome", appName: "Chrome", title: "Apply", windowKind: "page", page: true };
const tgt = (ref: string, over: Partial<TargetBinding> = {}): TargetBinding => ({ ref, domain: win, key: `k-${ref}`, role: "AXTextField", label: `Field ${ref}`, control: "text", value: "", options: null, ...over });
const val = (ref: string, text: string, over: Partial<ValueBinding> = {}): ValueBinding => ({ ref, text, display: `"${text}"`, origin: { kind: "span", snapshot: "s1", source: "w-src", startUTF16: 0, endUTF16: text.length, digest: "d" }, source: { windowId: "w-src", key: "src", revision: "r" }, memory: null, event: null, ...over });

function inventory(targets: TargetBinding[], values: ValueBinding[]): GoalInventory {
  return { readerSession: 1, targets: new Map(targets.map((t) => [t.ref, t])), values: new Map(values.map((v) => [v.ref, v])), revisions: new Map([["w-a", "r1"]]), documents: new Map() };
}
const draft = (steps: DraftPlan["steps"]): DraftPlan => ({ basedOn: "s1", window: "w1", steps, choices: [], programDigest: "b".repeat(64) });
const refusal = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof GoalError) return e.code;
    throw e;
  }
  return "none";
};

describe("lowering refuses, by name", () => {
  const inv = inventory(
    [
      tgt("t1"),
      tgt("t2", { label: "Email" }),
      tgt("t3", { value: "already here" }),
      tgt("t4", { control: "button", role: "AXButton", label: "Next" }),
      tgt("t5", { control: "select", role: "AXPopUpButton", label: "Country", options: ["Canada", "Mexico"] }),
      tgt("t6", { control: "select", role: "AXPopUpButton", label: "Country", options: ["Canada", "Mexico"], domain: page, key: "f0/select:country~0" }),
      tgt("t7", { control: "checkbox", role: "AXCheckBox", label: "Remote OK", domain: page }),
      tgt("t8", { control: "calendar", role: "calendar", label: "Caret", domain: { kind: "calendar", calendar: "Caret" }, key: "calendar" }),
      tgt("t9", { control: "date", role: "AXDateField", label: "Start date", domain: page, key: "f0/date:start~0" }),
    ],
    [val("v1", "ORD-1"), val("v2", "The lamp arrived broken and I would like a replacement."), val("v3", "Canada"), val("v4", "Peru"), val("v5", "Meet Priya", { event: { title: "Meet Priya", start: "2026-10-08T15:00:00-07:00", end: "2026-10-08T15:45:00-07:00", says: "Thu 3:00 to 3:45 PM", sentence: "s" } }), val("v6", "October 20, 2026"), val("v7", "2026-10-20", { origin: { kind: "derived", inputs: ["v6"], resolver: "values/date", version: "values/1", parametersDigest: "p" } })],
  );
  const lower = (steps: DraftPlan["steps"]) => () => lowerGoal("g", "x", draft(steps), inv);

  it("refuses a question, a wait no press causes, a step after a hand-off, unknown refs and a missing program", () => {
    expect(refusal(lower([{ ref: "a", kind: "ask", question: "q1" }]))).toBe("unsupportedStep");
    expect(refusal(lower([{ ref: "a", kind: "fill", target: "t1", value: "v1" }, { ref: "b", kind: "waitFor", effect: "e:reveal", timeoutMs: 500 }]))).toBe("unsupportedStep");
    expect(refusal(lower([{ ref: "a", kind: "press", target: "t4", effect: YOURS_EFFECT }, { ref: "b", kind: "fill", target: "t1", value: "v1" }]))).toBe("stepAfterHandoff");
    expect(refusal(lower([{ ref: "a", kind: "fill", target: "t99", value: "v1" }]))).toBe("schema");
    expect(refusal(lower([{ ref: "a", kind: "fill", target: "t1", value: "v99" }]))).toBe("schema");
    expect(refusal(lower([{ ref: "a", kind: "fill", target: "t1", value: "v1" }, { ref: "b", kind: "fill", target: "t1", value: "v1" }]))).toBe("schema");
    expect(refusal(() => lowerGoal("g", "x", { ...draft([{ ref: "a", kind: "fill", target: "t1", value: "v1" }]), programDigest: "nope" }, inv))).toBe("schema");
    // A wait right after the press whose effect it names is merged into that press.
    expect(refusal(lower([{ ref: "a", kind: "press", target: "t4", effect: "e:reveal" }, { ref: "b", kind: "waitFor", effect: "e:reveal", timeoutMs: 500 }]))).toBe("none");
  });

  it("refuses a value whose kind does not fit, text over text, a choice that is not an option, an event in a field and a date that is not a resolved one", () => {
    expect(refusal(lower([{ ref: "a", kind: "fill", target: "t2", value: "v2" }]))).toBe("wrongKind");
    expect(refusal(lower([{ ref: "a", kind: "fill", target: "t3", value: "v1" }]))).toBe("notEmpty");
    expect(refusal(lower([{ ref: "a", kind: "fill", target: "t6", value: "v4" }]))).toBe("wrongKind");
    expect(refusal(lower([{ ref: "a", kind: "fill", target: "t1", value: "v5" }]))).toBe("wrongKind");
    expect(refusal(lower([{ ref: "a", kind: "fill", target: "t8", value: "v1" }]))).toBe("wrongKind");
    expect(refusal(lower([{ ref: "a", kind: "fill", target: "t9", value: "v6" }]))).toBe("wrongKind");
    expect(refusal(lower([{ ref: "a", kind: "fill", target: "t9", value: "v7" }]))).toBe("none");
  });

  it("writes a page select by its option, hands a native select and any box to the user, and refuses a plan that is all hand-offs", () => {
    const g = lowerGoal("g", "x", draft([{ ref: "a", kind: "fill", target: "t6", value: "v3" }, { ref: "b", kind: "fill", target: "t1", value: "v1" }]), inv);
    expect(g.segments.map((s) => s.steps.map((x) => [x.kind, x.writes]))).toEqual([[["write", "Canada"]], [["write", "ORD-1"]]]);
    const n = lowerGoal("g", "x", draft([{ ref: "a", kind: "fill", target: "t1", value: "v1" }, { ref: "b", kind: "fill", target: "t5", value: "v3" }]), inv);
    expect(n.segments[0]?.steps.map((x) => [x.kind, x.handoff])).toEqual([["write", null], ["handoff", "unverifiable"]]);
    expect(refusal(lower([{ ref: "a", kind: "fill", target: "t7", value: "v3" }]))).toBe("nothingToDo");
    expect(refusal(lower([{ ref: "a", kind: "press", target: "t4", effect: YOURS_EFFECT }]))).toBe("nothingToDo");
  });

  it(`refuses more than ${MAX_SEGMENTS} segments`, () => {
    const many = Array.from({ length: MAX_SEGMENTS + 1 }, (_, i) => tgt(`m${i}`, { domain: { ...win, windowId: `w-${i}` } }));
    const big = inventory(many, [val("v1", "ORD-1")]);
    expect(refusal(() => lowerGoal("g", "x", draft(many.map((t, i) => ({ ref: `s${i}`, kind: "fill" as const, target: t.ref, value: "v1" }))), big))).toBe("tooManySegments");
  });
});

describe("the digest", () => {
  const step: GoalStep = { ref: "a", index: 0, kind: "write", says: "Field t1: ORD-1", target: tgt("t1"), value: val("v1", "ORD-1"), writes: "ORD-1", effect: null, handoff: null };
  const base: { index: number; domain: GoalDomain; reason: "start"; steps: GoalStep[] } = { index: 0, domain: win, reason: "start", steps: [step] };
  const X = "e".repeat(64);
  const d0 = segmentDigest("p".repeat(64), base, [], X);
  const variant = (over: Partial<GoalStep>, warnings: string[] = [], program = "p".repeat(64)): string => segmentDigest(program, { ...base, steps: [{ ...step, ...over }] }, warnings, X);

  it("is the same for the same plan and differs for any change of order, target, value, provenance, precondition, effect, warning or executable plan", () => {
    expect(segmentDigest("p".repeat(64), structuredClone(base), [], X)).toBe(d0);
    const changed = {
      order: segmentDigest("p".repeat(64), { ...base, steps: [{ ...step, index: 1 }] }, [], X),
      target: variant({ target: tgt("t1", { key: "k-other" }) }),
      value: variant({ value: val("v1", "ORD-2"), writes: "ORD-2" }),
      provenance: variant({ value: val("v1", "ORD-1", { source: { windowId: "w-other", key: "src", revision: "r" } }) }),
      origin: variant({ value: val("v1", "ORD-1", { origin: { kind: "memory", entryId: "about-1", fileRevision: "", digest: "d" }, source: null }) }),
      precondition: variant({ target: tgt("t1", { value: "typed" }) }),
      effect: variant({ kind: "press", effect: "e:reveal", value: null, writes: null }),
      warning: variant({}, ["'Send' reads as outbound; you press it."]),
      program: variant({}, [], "q".repeat(64)),
      window: segmentDigest("p".repeat(64), { ...base, domain: { ...win, windowId: "w-b" } }, [], X),
      executable: segmentDigest("p".repeat(64), base, [], "f".repeat(64)),
    };
    for (const [what, d] of Object.entries(changed)) expect(d, what).not.toBe(d0);
    expect(new Set(Object.values(changed)).size).toBe(Object.keys(changed).length);
  });
});
