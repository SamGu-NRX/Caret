// A finished goal kept as a skill (goals/skill.ts) and rerun with no model (goals/skill-run.ts). The fixture is the
// slice-2 mail goal of codemode/replay.test.ts and nav-goals.test.ts: pick Kayak's row with choose(), open it, read the
// confirmation code and the passenger, pick the passenger's row with choose(), open it, and copy the code into the
// reply. The first run's choices are a scripted stand-in for Jev. Every name and code is invented.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runCodePlan, type ChooserPort } from "../src/codemode/sandbox.ts";
import type { PlanStep, PlanningSnapshot, Recorded, SandboxOutcome } from "../src/codemode/types.ts";
import { rerunGoalSkill, refusingModels, type SkillPorts, type SkillSegment } from "../src/goals/skill-run.ts";
import { mintGoalSkill, type FinishedGoal, type SkillInventory } from "../src/goals/skill.ts";
import { sha256, type GoalDomain, type TargetBinding, type ValueBinding } from "../src/goals/plan.ts";
import { GoalSkillBody, SkillBody } from "../src/patterns/memory.ts";
import type { Hash } from "../src/patterns/routines.ts";

const hash: Hash = (t) => createHmac("sha256", "goal-skills-fixture-key").update(t).digest("hex").slice(0, 16);

/** The mail fixture app of goal-desk.ts. */
const BUNDLE = "dev.caret.mailfixture";
const DOMAIN: GoalDomain = { kind: "window", windowId: "6262-1", pid: 6161, bundleId: BUNDLE, appName: "Mail Fixture", title: "Inbox", number: 1, windowKind: "standard", page: false };
const key = (s: string): string => `${BUNDLE}/standard/${s}`;
const QUESTION = "Which row of this list does the goal mean?";
const NAV = ["e:open", "e:yours"];

const KAYAK = "Kayak · Flight itinerary · 3m ago";
const DANA = "Dana Whitfield · Flight itinerary · 9:41 AM";
const DANA_SEAT = "Dana Whitfield · Seat change · 10:02 AM";

function bindTarget(ref: string, label: string, role: string, nodeKey: string, control: TargetBinding["control"], row: string[] | null): TargetBinding {
  return {
    ref,
    domain: DOMAIN,
    key: nodeKey,
    role,
    label,
    control,
    value: "",
    options: null,
    own: label,
    placeholder: null,
    ...(row === null ? {} : { row: { cells: row, others: [], container: { key: key("table:messages~0"), role: "AXTable" }, selectable: true, inForm: null, href: null, kind: "AXRow" } }),
  };
}

function bindValue(ref: string, text: string, nodeKey: string): ValueBinding {
  return { ref, text, display: text, origin: { kind: "span", snapshot: "s1", source: "obs:6262-1", startUTF16: 0, endUTF16: text.length, digest: "d" }, source: { windowId: "obs:6262-1", key: nodeKey, revision: "r1" }, memory: null, event: null, draft: null, owner: null };
}

/** The list window as one generation shows it (`p` its ref prefix): its rows as targets and as one question's options. */
function listWindow(p: string, rows: readonly string[], values: PlanningSnapshot["values"], inv: Map<string, TargetBinding>): PlanningSnapshot {
  const targets = rows.map((label, i) => {
    const ref = `${p}t${i + 1}`;
    inv.set(ref, bindTarget(ref, label, "AXRow", key(`row:${i}~0`), "row", label.split(" · ")));
    return { ref, label, kind: "row", canFill: false, options: [], allowedPressEffects: [], allowedNavigateEffects: NAV };
  });
  return { snapshot: `${p}s1`, window: `${p}w1`, revision: `${p}r1`, title: "Inbox", targets, values, questions: [{ ref: `${p}s1q1`, text: QUESTION, options: rows.map((label, i) => ({ ref: `${p}s1q1o${i + 1}`, label })) }] };
}

interface Scene {
  gen0: PlanningSnapshot[];
  observations: PlanningSnapshot[];
  inventory: SkillInventory;
}

/** The three windows the goal reads: the inbox, Kayak's message open (code, passenger), Dana's message open (Reply, Notes). */
function scene(o: { kayak?: string; code?: string; rowsAfter?: string[] } = {}): Scene {
  const targets = new Map<string, TargetBinding>();
  const values = new Map<string, ValueBinding>();
  const code = o.code ?? "QX7R2P";
  const inbox = listWindow("", [o.kayak ?? KAYAK, DANA], [], targets);
  values.set("g1:v1", bindValue("g1:v1", code, key("statictext:line 3~0")));
  values.set("g1:v2", bindValue("g1:v2", "Dana Whitfield", key("statictext:line 4~0")));
  const kayak = listWindow("g1:", [o.kayak ?? KAYAK, ...(o.rowsAfter ?? [DANA])], [
    { ref: "g1:v1", display: `"${code}" (Confirmation number in Inbox)`, origin: { kind: "span", snapshot: "g1:s1", source: "obs1:6262-1", startUTF16: 0, endUTF16: code.length, digest: "d" } },
    { ref: "g1:v2", display: '"Dana Whitfield" (Passenger in Inbox)', origin: { kind: "span", snapshot: "g1:s1", source: "obs1:6262-1", startUTF16: 0, endUTF16: 14, digest: "d" } },
  ], targets);
  targets.set("g2:t1", bindTarget("g2:t1", "Reply", "AXTextArea", key("textarea:reply~0"), "text", null));
  targets.set("g2:t2", bindTarget("g2:t2", "Notes", "AXTextArea", key("textarea:notes~0"), "text", null));
  const dana: PlanningSnapshot = {
    snapshot: "g2:s1",
    window: "g2:w1",
    revision: "g2:r1",
    title: "Flight itinerary",
    targets: [
      { ref: "g2:t1", label: "Reply", kind: "text", canFill: true, options: [], allowedPressEffects: [] },
      { ref: "g2:t2", label: "Notes", kind: "text", canFill: true, options: [], allowedPressEffects: [] },
    ],
    values: [],
    questions: [],
  };
  return { gen0: [inbox], observations: [kayak, dana], inventory: { targets, values } };
}

/** Kayak's row by choose(), then the passenger's row by choose(), then the code copied into Reply. */
const PROGRAM = `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  const box = await caret.readWindow();
  const q = box.questions[0];
  const pick = await caret.choose(q.options.map((o) => o.ref));
  const label = q.options.find((o) => o.ref === pick).label;
  const open = caret.navigate(box.targets.find((t) => t.label === label).ref, "e:open");
  const msg = await caret.observe(open);
  const q2 = msg.questions[0];
  const who = await caret.choose(q2.options.map((o) => o.ref));
  const whoLabel = q2.options.find((o) => o.ref === who).label;
  const openDana = caret.navigate(msg.targets.find((t) => t.label === whoLabel).ref, "e:open");
  const dana = await caret.observe(openDana);
  const code = msg.values.find((v) => v.display.includes("Confirmation number"));
  const fill = caret.fill(dana.targets.find((t) => t.label === "Reply").ref, code.ref);
  return caret.plan({ basedOn: box.snapshot, steps: [open, openDana, fill] });
}`;

/** Jev's stand-in: Kayak's row in the inbox, Dana's flight in the opened message. Counts its calls. */
function standIn(): ChooserPort & { calls: number } {
  const f = Object.assign(
    async (req: Parameters<ChooserPort>[0]) => {
      f.calls++;
      const want = req.question.ref.startsWith("g1:") ? DANA : KAYAK;
      return req.options.find((o) => o.label === want)?.ref ?? null;
    },
    { calls: 0 },
  );
  return f;
}

type Write = { key: string; value: string };

/** One goal, run as GoalRuns runs it: a run per segment, each replaying the ones before (goals/replay.ts continueGoal). */
async function goalRun(source: string, sc: Scene): Promise<{ goal: FinishedGoal; writes: Write[]; jev: number }> {
  const jev = standIn();
  let record: Pick<Recorded, "choices" | "prefix"> = { choices: [], prefix: [] };
  let last: Extract<SandboxOutcome, { ok: true }> | null = null;
  for (let s = 0; s <= sc.observations.length; s++) {
    const out = await runCodePlan(source, sc.gen0, jev, { multiWindow: true, drafts: true, navigation: true, replay: { observations: sc.observations.slice(0, s), ...record, mayObserve: true } });
    if (!out.ok) throw new Error(`segment ${s}: ${out.kind}: ${out.detail}`);
    const pending: PlanStep[] = out.pending === null ? [] : [{ ref: out.pending.ref, kind: "observe", after: out.pending.after }];
    record = { choices: out.plan.choices.map((c) => ({ requestDigest: c.requestDigest, chosen: c.chosen })), prefix: [...out.plan.steps, ...pending] };
    last = out;
  }
  if (last === null || last.pending !== null) throw new Error("the goal did not finish");
  const writes = last.plan.steps.flatMap((x) => (x.kind === "fill" ? [{ key: sc.inventory.targets.get(x.target)?.key ?? "?", value: hash(sc.inventory.values.get(x.value)?.text ?? "?") }] : []));
  return { goal: { source, programDigest: sha256(source), gen0: sc.gen0, observations: sc.observations, choices: record.choices, inventory: sc.inventory }, writes, jev: jev.calls };
}

/** The screen a rerun reads, and an executor that records each segment it is handed. */
function ports(sc: Scene): SkillPorts & { segments: SkillSegment[]; writes: () => Write[] } {
  const segments: SkillSegment[] = [];
  return {
    segments,
    read: async () => ({ snapshots: sc.gen0, inventory: sc.inventory }),
    observe: async (n) => {
      const snapshot = sc.observations[n - 1];
      if (snapshot === undefined) throw new Error(`no observation ${n}`);
      return { snapshot, inventory: sc.inventory };
    },
    execute: async (segment) => {
      segments.push(segment);
      return null;
    },
    writes: () => segments.flatMap((g) => g.steps.flatMap((x) => (x.kind === "fill" && x.value !== null ? [{ key: x.target.key, value: hash(x.value.text) }] : []))),
  };
}

async function minted(source = PROGRAM): Promise<{ body: GoalSkillBody; writes: Write[]; jev: number }> {
  const run = await goalRun(source, scene());
  const m = await mintGoalSkill(run.goal, { hash, now: 1_790_000_000_000 });
  if (!m.ok) throw new Error(`mint refused: ${m.reason}: ${m.detail}`);
  return { body: m.body, writes: run.writes, jev: run.jev };
}

/** Every string a snapshot holds: titles, labels, displays, questions and options. */
const snapshotTexts = (sc: Scene): string[] => [...sc.gen0, ...sc.observations].flatMap((s) => [s.title, ...s.targets.map((t) => t.label), ...s.values.map((v) => v.display), ...s.questions.flatMap((q) => [q.text, ...q.options.map((o) => o.label)])]);

describe("goal skills (Pomerado-style: a reviewed goal program rerun with no model)", { timeout: 60_000 }, () => {
  it("mints a body that holds no value the run read and no snapshot text", async () => {
    const { body, jev } = await minted();
    expect(jev).toBe(2);
    expect(SkillBody.parse({ kind: "program", ...body })).toMatchObject({ kind: "program" });
    // Kayak's row is explained by nothing read before it; Dana's row carries the passenger read in Kayak's message.
    expect(body.sites.map((s) => s.rule.kind)).toEqual(["constant", "match"]);
    const json = JSON.stringify(body);
    for (const read of ["QX7R2P", "Dana Whitfield"]) {
      expect(json).not.toContain(read);
      expect(json).not.toContain(hash(read));
    }
    // The program is kept as written, so the labels it spells out ("Reply") are in it; nothing else a window showed is.
    const rest = JSON.stringify({ ...body, program: { ...body.program, source: "" } });
    for (const text of snapshotTexts(scene())) if (!PROGRAM.includes(text)) expect(rest, text).not.toContain(text);
  });

  it("reruns with no model call and writes what the first run wrote", async () => {
    const { body, writes } = await minted();
    const models = refusingModels();
    const desk = ports(scene());
    expect(await rerunGoalSkill(body, desk, { hash, models })).toEqual({ outcome: "done", segments: 3 });
    expect(models.calls).toBe(0);
    expect(desk.writes()).toEqual(writes);
    expect(writes).toEqual([{ key: key("textarea:reply~0"), value: hash("QX7R2P") }]);
  });

  it("writes the code the screen shows now, not the one the run read", async () => {
    const { body } = await minted();
    const models = refusingModels();
    const desk = ports(scene({ code: "ZZ9K4M" }));
    expect(await rerunGoalSkill(body, desk, { hash, models })).toMatchObject({ outcome: "done" });
    expect(models.calls).toBe(0);
    expect(desk.writes()).toEqual([{ key: key("textarea:reply~0"), value: hash("ZZ9K4M") }]);
  });

  it("diverges at the constant site when its option was renamed, before anything runs", async () => {
    const { body } = await minted();
    const models = refusingModels();
    const desk = ports(scene({ kayak: "Kayak.com · Flight itinerary · 3m ago" }));
    expect(await rerunGoalSkill(body, desk, { hash, models })).toMatchObject({ outcome: "diverged", segment: 0, site: "c1", reason: "constantMissing" });
    expect(desk.segments).toEqual([]);
    expect(models.calls).toBe(0);
  });

  it("diverges as ambiguous when two rows carry the matched value, and writes nothing", async () => {
    const { body } = await minted();
    const models = refusingModels();
    const desk = ports(scene({ rowsAfter: [DANA, DANA_SEAT] }));
    expect(await rerunGoalSkill(body, desk, { hash, models })).toMatchObject({ outcome: "diverged", segment: 1, site: "c2", reason: "ambiguous" });
    // Segment 0 (opening Kayak's message) ran before the second choice was asked; no fill reached the executor.
    expect(desk.segments.map((g) => g.steps.map((x) => x.kind))).toEqual([["navigate"]]);
    expect(desk.writes()).toEqual([]);
    expect(models.calls).toBe(0);
  });

  it("diverges on the trace when the program branches on what it read and writes elsewhere", async () => {
    // A display-text branch the sandbox allows: the same program writes into Notes once the code no longer starts with QX.
    const branching = PROGRAM.replace('dana.targets.find((t) => t.label === "Reply")', 'dana.targets.find((t) => t.label === (code.display.includes("QX") ? "Reply" : "Notes"))');
    expect(branching).not.toBe(PROGRAM);
    const { body } = await minted(branching);
    const desk = ports(scene({ code: "ZZ9K4M" }));
    expect(await rerunGoalSkill(body, desk, { hash })).toMatchObject({ outcome: "diverged", segment: 2, reason: "trace" });
    expect(desk.writes()).toEqual([]);
  });

  it("refuses to mint a program that spells out a value it read, uses a clock, or composes text, each by name", async () => {
    const { goal } = await goalRun(PROGRAM, scene());
    const as = (source: string): FinishedGoal => ({ ...goal, source, programDigest: sha256(source) });
    const literal = PROGRAM.replace("code.ref);", 'caret.draft("QX7R2P", [msg.window]));');
    const clock = PROGRAM.replace("const box = await caret.readWindow();", "const box = await caret.readWindow();\n  const at = Date.now();");
    expect(literal).not.toBe(PROGRAM);
    expect(clock).not.toBe(PROGRAM);
    expect(await mintGoalSkill(as(literal), { hash, now: 0 })).toMatchObject({ ok: false, reason: "literalEqualsRead" });
    expect(await mintGoalSkill(as(clock), { hash, now: 0 })).toMatchObject({ ok: false, reason: "bannedIdentifier", detail: "Date" });
    // A draft no literal gives away still runs on the record, and is refused as composed text: an open question.
    const drafted = PROGRAM.replace("code.ref);", 'caret.draft("Hi Dana, the code is " + code.display.split(\'"\')[1], [msg.window]));');
    const run = await goalRun(drafted, scene());
    expect(await mintGoalSkill(run.goal, { hash, now: 0 })).toMatchObject({ ok: false, reason: "draft" });
  });
});
