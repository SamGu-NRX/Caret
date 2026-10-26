// A finished goal kept as a skill whose reruns ask no model (the idea is Pomerado's: compile an agent's one-off run into
// a reviewed routine). The writer's program is kept as it ran. What it touched is kept as shapes under the local keyed
// hash, never as text: each target by app, role, node key and label, each value by the place it was read. Each choose()
// site is lowered to a rule: `constant` when the chosen option's text is explained by nothing the run read (it must be
// there again, once), `match` when it carries a value read earlier in the run (the option carrying that value, read
// fresh, must be the only one). The steps the run registered, segment by segment, are the reviewed write set
// (expectedTrace) a rerun must reproduce before anything of it runs (skill-run.ts).
//
// Mint runs the program again on the goal's record, one run per segment as continueGoal did, with every choice answered
// from the record, so it needs the record before releaseReplay drops it. Nothing read is stored: a value's text is
// only hashed, compared and dropped.
import { stripTypeScriptTypes } from "node:module";
import { parse } from "acorn";
import { compileProgram } from "../codemode/compile.ts";
import { runProgramJs, type ChooserPort } from "../codemode/sandbox.ts";
import { requestDigest, type ChoiceRecord, type DraftPlan, type PendingObserve, type PlanStep, type PlanningSnapshot, type Recorded, type RefusalKind } from "../codemode/types.ts";
import type { GoalSkillBody } from "../patterns/memory.ts";
import type { Hash } from "../patterns/routines.ts";
import { GOAL_API } from "../writer/goal-prompt.ts";
import type { GoalInventory } from "./plan.ts";
import { canonical, sha256 } from "./plan.ts";
import { GOAL_NEW_STEPS, type ReplayRecord } from "./replay.ts";

/** Bumped whenever a check below changes what passes; a body reviewed under another version is not run. */
export const SKILL_CHECKS_VERSION = 1;

/** The plan API the program was written against, as its writer was shown it: a program kept under another API is not run. */
export const PLAN_API_VERSION = sha256(GOAL_API);

/** How a row's cells are joined into its label and its list question's option labels (inventory.ts, rows). */
const CELL_SEPARATOR = " · ";

/** Names a kept program may not use: a clock, randomness or the network would make a rerun differ from the run reviewed. */
const BANNED = new Set(["Date", "fetch", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "performance"]);

export type SkillInventory = Pick<GoalInventory, "targets" | "values">;

/** A finished goal as GoalRuns holds it before releaseReplay: its program, what each run read, and Jev's choices. */
export type FinishedGoal = Pick<ReplayRecord, "source" | "programDigest" | "gen0" | "observations" | "choices"> & { inventory: SkillInventory };

export type MintRefusal =
  | "digest" // the source is not the program the goal ran
  | "bannedIdentifier" // a clock, randomness or the network
  | "literalEqualsRead" // the program spells out a value the run read
  | "source" // compileProgram refused it
  | "sandbox" // the run on the record did not reproduce
  | "unfinished" // the record does not end at plan()
  | "draft" // text the program composed: not a verbatim copy of a read value
  | "unsupportedStep" // ask and waitFor
  | "stepBudget"
  | "unchosenSite" // Jev chose nothing there
  | "ambiguousOption" // the chosen option's text is not unique among its options
  | "ambiguousSource" // two different read values each explain the choice
  | "writeNotFromRead" // a fill whose value no window showed
  | "unboundTarget"; // a step's target has no binding

export type MintResult = { ok: true; body: GoalSkillBody } | { ok: false; reason: MintRefusal; detail: string };

type Body = GoalSkillBody;
type Site = Body["sites"][number];
type Rule = Site["rule"];
type TargetShape = Body["bindings"]["targets"][number];
type ReadShape = Body["bindings"]["reads"][number];
export type TraceEntry = Body["expectedTrace"][number];

const shapeId = (prefix: "t" | "r", shape: object): string => `${prefix}:${sha256(canonical(shape)).slice(0, 16)}`;

// MARK: - source checks

interface AstNode {
  type: string;
  [key: string]: unknown;
}
const isNode = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

/**
 * Why the source may not be kept, or null: a banned name (Math only as `Math.<name>` other than random), or a string
 * literal whose keyed hash, trimmed or not, is that of a value the run read: an answer written into the program would be
 * written again on every rerun, whatever the screen then shows.
 */
export function sourceRefusal(source: string, readHmacs: ReadonlySet<string>, hash: Hash): { reason: "bannedIdentifier" | "literalEqualsRead" | "source"; detail: string } | null {
  let root: AstNode;
  try {
    root = parse(stripTypeScriptTypes(source, { mode: "strip" }), { ecmaVersion: 2023, sourceType: "script" }) as unknown as AstNode;
  } catch (e) {
    return { reason: "source", detail: e instanceof Error ? e.message : String(e) };
  }
  const literal = (s: string): boolean => s.trim() !== "" && (readHmacs.has(hash(s)) || readHmacs.has(hash(s.trim())));
  const stack: [AstNode, AstNode | null][] = [[root, null]];
  while (stack.length > 0) {
    const [node, parent] = stack.pop()!;
    if (node.type === "Identifier") {
      const name = node.name as string;
      if (BANNED.has(name)) return { reason: "bannedIdentifier", detail: name };
      if (name === "Math") {
        const member = parent?.type === "MemberExpression" && parent.object === node && parent.computed === false ? ((parent.property as AstNode).name as string) : null;
        if (member === null || member === "random") return { reason: "bannedIdentifier", detail: member === "random" ? "Math.random" : "Math outside Math.<name>" };
      }
    }
    if (node.type === "Literal" && typeof node.value === "string" && literal(node.value)) return { reason: "literalEqualsRead", detail: `the string literal at offset ${String(node.start)}` };
    if (node.type === "TemplateElement") {
      const cooked = (node.value as { cooked: string | null }).cooked;
      if (cooked !== null && literal(cooked)) return { reason: "literalEqualsRead", detail: `the template text at offset ${String(node.start)}` };
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) {
        for (const c of v) if (isNode(c)) stack.push([c, node]);
      } else if (isNode(v)) stack.push([v, node]);
    }
  }
  return null;
}

// MARK: - one segment

export interface SegmentRun {
  plan: DraftPlan;
  pending: PendingObserve | null;
  /** The steps this run registered after the prefix, its pending observe last. */
  newSteps: PlanStep[];
  /** The choices this run asked after the recorded ones. */
  newChoices: ChoiceRecord[];
}

/**
 * One run of the program for segment `observations.length`: the earlier segments' choices answered from `prior`, their
 * steps the prefix, the observations served, and a stop at the next observe. As continueGoal runs it (replay.ts).
 */
export async function runSegment(compiled: { js: string; digest: string }, gen0: readonly PlanningSnapshot[], observations: readonly PlanningSnapshot[], prior: Pick<Recorded, "choices" | "prefix">, choose: ChooserPort): Promise<SegmentRun | { refused: RefusalKind; detail: string }> {
  const ran = await runProgramJs(compiled.js, compiled.digest, gen0, choose, {
    multiWindow: true,
    drafts: true,
    navigation: true,
    replay: { observations: [...observations], choices: prior.choices, prefix: prior.prefix, mayObserve: true },
  });
  if (!ran.ok) return { refused: ran.kind, detail: ran.detail };
  const pending: PlanStep[] = ran.pending === null ? [] : [{ ref: ran.pending.ref, kind: "observe", after: ran.pending.after }];
  return { plan: ran.plan, pending: ran.pending, newSteps: [...ran.plan.steps.slice(prior.prefix.length), ...pending], newChoices: ran.plan.choices.slice(prior.choices.length) };
}

/** The prefix and recorded choices the run after `r` replays. */
export const nextPrior = (r: SegmentRun): Pick<Recorded, "choices" | "prefix"> => ({
  choices: r.plan.choices.map((c) => ({ requestDigest: c.requestDigest, chosen: c.chosen })),
  prefix: r.pending === null ? r.plan.steps : [...r.plan.steps, { ref: r.pending.ref, kind: "observe", after: r.pending.after }],
});

// MARK: - shapes

/** Each window the program has been handed so far, by generation: gen 0's snapshots, then each observation's. */
export type Gens = readonly (readonly PlanningSnapshot[])[];

function locate<T>(gens: Gens, find: (s: PlanningSnapshot) => T | undefined): { gen: number; index: number; hit: T } | null {
  for (const [gen, snaps] of gens.entries())
    for (const [index, s] of snaps.entries()) {
      const hit = find(s);
      if (hit !== undefined) return { gen, index, hit };
    }
  return null;
}

/** A read site and the text read there now; the text is never stored. */
export interface Read {
  shape: ReadShape;
  text: string;
}

/**
 * Every value the windows showed that a window holds (not the instruction's, memory's or a draft's), by value ref, in
 * the order the program was handed them. Two values of one node are told apart by their order in it.
 */
export function readSites(gens: Gens, inv: SkillInventory, hash: Hash): Map<string, Read> {
  const out = new Map<string, Read>();
  for (const [gen, snaps] of gens.entries())
    for (const [index, s] of snaps.entries()) {
      const seen = new Map<string, number>();
      for (const v of s.values) {
        const b = inv.values.get(v.ref);
        if (b === undefined || b.source === null) continue;
        const keyHmac = hash(b.source.key);
        const ordinal = seen.get(keyHmac) ?? 0;
        seen.set(keyHmac, ordinal + 1);
        const base = { gen, index, keyHmac, ordinal };
        out.set(v.ref, { shape: { id: shapeId("r", base), ...base }, text: b.text });
      }
    }
  return out;
}

/** Whether an option's label carries `text`: the whole label, or one of a row's cells, compared by keyed hash. */
export function relates(label: string, text: string, relation: "equals" | "cell", hash: Hash): boolean {
  const want = hash(text.trim());
  return relation === "equals" ? hash(label.trim()) === want : label.split(CELL_SEPARATOR).some((c) => hash(c.trim()) === want);
}

/** The question a choice was asked about and where, and the option it chose. */
function choiceOf(c: ChoiceRecord, gens: Gens): { gen: number; question: PlanningSnapshot["questions"][number]; chosenIndex: number } | null {
  const at = locate(gens, (s) => s.questions.find((q) => q.ref === c.question));
  if (at === null) return null;
  return { gen: at.gen, question: at.hit, chosenIndex: at.hit.options.findIndex((o) => o.ref === c.chosen) };
}

/** The label each choice chose, by site id, for the choices `firstSite` on: what a target picked by a choice is known by. */
export function chosenLabels(choices: readonly ChoiceRecord[], firstSite: number, gens: Gens, into: Map<string, string>): void {
  for (const [k, c] of choices.entries()) {
    const at = choiceOf(c, gens);
    const label = at === null ? undefined : at.question.options[at.chosenIndex]?.label;
    if (label !== undefined) into.set(`c${firstSite + k + 1}`, label);
  }
}

function targetShape(ref: string, gens: Gens, inv: SkillInventory, chosen: ReadonlyMap<string, string>, hash: Hash): TargetShape | null {
  const b = inv.targets.get(ref);
  const at = locate(gens, (s) => s.targets.find((t) => t.ref === ref));
  if (b === undefined || at === null) return null;
  const labelFrom = [...chosen].find(([, label]) => label === at.hit.label)?.[0] ?? null;
  const container = b.row?.container ?? null;
  const base = {
    gen: at.gen,
    index: at.index,
    app: b.domain.kind === "window" ? b.domain.bundleId : "calendar",
    windowKind: b.domain.kind === "window" ? b.domain.windowKind : "calendar",
    role: b.role,
    list: container === null ? null : { keyHmac: hash(container.key), role: container.role },
    keyHmac: labelFrom === null ? hash(b.key) : null,
    labelHmac: labelFrom === null ? hash(at.hit.label) : null,
    labelFrom,
  };
  return { id: shapeId("t", base), ...base };
}

/**
 * Segment `segment`'s trace: its new choices (sites `firstSite` on), then its steps in the order they were registered,
 * the observe that ends it as a read. Within a segment a choice's place among the steps is not recorded (DraftPlan
 * keeps them apart), so choices go first. A write is known by its target's shape and, for a fill, the read site of its
 * value: a program that branches on what it read and so writes elsewhere, or another value, makes another trace.
 */
export function segmentTrace(
  segment: number,
  firstSite: number,
  run: SegmentRun,
  ctx: { gens: Gens; inventory: SkillInventory; reads: ReadonlyMap<string, Read>; chosen: ReadonlyMap<string, string>; observesBefore: number; hash: Hash },
): { entries: TraceEntry[]; targets: TargetShape[]; reads: ReadShape[] } | { reason: "unsupportedStep" | "unboundTarget" | "writeNotFromRead"; detail: string } {
  const entries: TraceEntry[] = run.newChoices.map((_, k) => ({ segment, kind: "choose", site: `c${firstSite + k + 1}` }));
  const targets: TargetShape[] = [];
  const reads: ReadShape[] = [];
  let observes = ctx.observesBefore;
  for (const s of run.newSteps) {
    if (s.kind === "observe") {
      entries.push({ segment, kind: "read", site: `gen${++observes}` });
      continue;
    }
    if (s.kind === "ask" || s.kind === "waitFor") return { reason: "unsupportedStep", detail: `${s.ref} is ${s.kind}` };
    const t = targetShape(s.target, ctx.gens, ctx.inventory, ctx.chosen, ctx.hash);
    if (t === null) return { reason: "unboundTarget", detail: `${s.ref} targets ${s.target}` };
    targets.push(t);
    if (s.kind === "fill") {
      const r = ctx.reads.get(s.value);
      if (r === undefined) return { reason: "writeNotFromRead", detail: `${s.ref} fills ${s.value}, which no window showed` };
      reads.push(r.shape);
      entries.push({ segment, kind: "write", step: "fill", site: t.id, effect: null, valueFrom: r.shape.id });
    } else entries.push({ segment, kind: "write", step: s.kind, site: t.id, effect: s.effect, valueFrom: null });
  }
  return { entries, targets, reads };
}

// MARK: - choose sites

/**
 * A choice lowered to a rule, or why it cannot be. `match` when values read in the question's window or before carry
 * the chosen option and no other: exactly one distinct such text, the first read place of it kept. `constant`
 * otherwise. Neither holds an option's index, which a reorder would turn into another option.
 */
function lowerSite(c: ChoiceRecord, gens: Gens, reads: ReadonlyMap<string, Read>, hash: Hash): { rule: Rule; seen: Site["seen"]; promptHmac: string; source: ReadShape | null } | { reason: MintRefusal; detail: string } {
  const at = choiceOf(c, gens);
  if (at === null) return { reason: "sandbox", detail: `question ${c.question} is in no window the program was handed` };
  if (c.chosen === null || at.chosenIndex < 0) return { reason: "unchosenSite", detail: `Jev chose no option of ${c.question}` };
  const options = at.question.options;
  const optionHmacs = options.map((o) => hash(o.label.trim()));
  const mine = optionHmacs[at.chosenIndex] as string;
  if (optionHmacs.filter((h) => h === mine).length > 1) return { reason: "ambiguousOption", detail: `another option of ${c.question} reads the same as the one chosen` };
  const explains: { read: Read; relation: "equals" | "cell" }[] = [];
  for (const r of reads.values()) {
    if (r.shape.gen > at.gen || r.text.trim() === "") continue;
    for (const relation of ["equals", "cell"] as const) {
      const hits = options.filter((o) => relates(o.label, r.text, relation, hash));
      if (hits.length === 1 && hits[0]?.ref === c.chosen) {
        explains.push({ read: r, relation });
        break;
      }
    }
  }
  const seen = { options: options.length, optionHmacs, chosenIndex: at.chosenIndex };
  const promptHmac = hash(at.question.text);
  if (new Set(explains.map((e) => hash(e.read.text.trim()))).size > 1) return { reason: "ambiguousSource", detail: `values read with different texts each pick the option chosen for ${c.question}` };
  const first = explains[0];
  if (first === undefined) return { rule: { kind: "constant", labelHmac: mine }, seen, promptHmac, source: null };
  return { rule: { kind: "match", sourceSite: first.read.shape.id, relation: first.relation }, seen, promptHmac, source: first.read.shape };
}

// MARK: - mint

/**
 * The skill body of a finished goal, or the first check it fails, by name. `now` stamps the review; nothing else here
 * reads a clock.
 */
export async function mintGoalSkill(run: FinishedGoal, o: { hash: Hash; now: number }): Promise<MintResult> {
  const refuse = (reason: MintRefusal, detail: string): MintResult => ({ ok: false, reason, detail });
  const hash = o.hash;
  if (sha256(run.source) !== run.programDigest) return refuse("digest", "the source's SHA-256 is not the digest the goal ran");
  const all: Gens = [run.gen0, ...run.observations.map((s) => [s])];
  // Every value the program was handed, the instruction's and memory's too: a literal spelling one out is an answer.
  const readHmacs = new Set<string>();
  for (const snaps of all)
    for (const s of snaps)
      for (const v of s.values) {
        const text = run.inventory.values.get(v.ref)?.text;
        if (text !== undefined && text.trim() !== "") readHmacs.add(hash(text.trim()));
      }
  const bad = sourceRefusal(run.source, readHmacs, hash);
  if (bad !== null) return refuse(bad.reason, bad.detail);
  const compiled = compileProgram(run.source);
  if (!compiled.ok) return refuse("source", compiled.detail);

  const sites: Site[] = [];
  const expectedTrace: TraceEntry[] = [];
  const targets = new Map<string, TargetShape>();
  const readShapes = new Map<string, ReadShape>();
  const chosen = new Map<string, string>();
  let prior: Pick<Recorded, "choices" | "prefix"> = { choices: [], prefix: [] };
  let observes = 0;
  for (let s = 0; s <= run.observations.length; s++) {
    const firstSite = prior.choices.length;
    let next = firstSite;
    const fromRecord: ChooserPort = async (req) => {
      const kept = run.choices[next++];
      if (kept === undefined || kept.requestDigest !== requestDigest(req)) throw new Error(`choice ${next} is not the recorded one`);
      return kept.chosen;
    };
    const ran = await runSegment(compiled, run.gen0, run.observations.slice(0, s), prior, fromRecord);
    if ("refused" in ran) return refuse("sandbox", `segment ${s}: ${ran.refused}: ${ran.detail}`);
    if ((ran.pending === null) !== (s === run.observations.length)) return refuse("unfinished", `segment ${s} ${ran.pending === null ? "reached plan() before the goal's last observation" : "stopped at an observe the goal never took"}`);
    if (ran.plan.drafts.length > 0) return refuse("draft", `the program composes ${ran.plan.drafts.length} text(s); a skill writes only values it read`);
    const gens = all.slice(0, s + 1);
    const reads = readSites(gens, run.inventory, hash);
    for (const [k, c] of ran.newChoices.entries()) {
      const lowered = lowerSite(c, gens, reads, hash);
      if ("reason" in lowered) return refuse(lowered.reason, lowered.detail);
      sites.push({ siteId: `c${firstSite + k + 1}`, segment: s, promptHmac: lowered.promptHmac, rule: lowered.rule, seen: lowered.seen });
      if (lowered.source !== null) readShapes.set(lowered.source.id, lowered.source);
    }
    chosenLabels(ran.newChoices, firstSite, gens, chosen);
    const traced = segmentTrace(s, firstSite, ran, { gens, inventory: run.inventory, reads, chosen, observesBefore: observes, hash });
    if ("reason" in traced) return refuse(traced.reason, traced.detail);
    expectedTrace.push(...traced.entries);
    for (const t of traced.targets) targets.set(t.id, t);
    for (const r of traced.reads) readShapes.set(r.id, r);
    observes += ran.newSteps.filter((x) => x.kind === "observe").length;
    prior = nextPrior(ran);
    if (prior.prefix.length > GOAL_NEW_STEPS) return refuse("stepBudget", `the program registers ${prior.prefix.length} steps; a goal registers at most ${GOAL_NEW_STEPS}`);
  }
  if (prior.choices.length !== run.choices.length) return refuse("unfinished", `the record holds ${run.choices.length} choices and the program asked ${prior.choices.length}`);
  return {
    ok: true,
    body: {
      program: { source: run.source, digest: run.programDigest, apiVersion: PLAN_API_VERSION },
      bindings: { targets: [...targets.values()], reads: [...readShapes.values()] },
      sites,
      expectedTrace,
      review: { checksVersion: SKILL_CHECKS_VERSION, passedAt: o.now },
    },
  };
}
