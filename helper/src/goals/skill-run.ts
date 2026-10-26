// A rerun of a goal kept as a skill (skill.ts), with no model. Each segment runs in two phases. Plan: the program runs
// on windows read now, each choose() answered by its site's rule, and the steps it registers are only recorded. Check:
// the segment's trace (its choices, then its writes by target shape and value source) must equal the reviewed one.
// Only then are the segment's steps handed to the executor; its observation is then read and the next segment planned.
//
// A rule that does not hold, a choice no site declares, or any difference in the trace ends the rerun as `diverged`
// before that segment's steps run: a skill writes the reviewed write set on fresh values, or nothing.
import { compileProgram } from "../codemode/compile.ts";
import type { ChooserPort } from "../codemode/sandbox.ts";
import type { PlanningSnapshot, Recorded } from "../codemode/types.ts";
import type { AskJev } from "../fill/jev.ts";
import { GoalSkillBody } from "../patterns/memory.ts";
import type { Hash } from "../patterns/routines.ts";
import { canonical, type TargetBinding, type ValueBinding } from "./plan.ts";
import { chosenLabels, nextPrior, PLAN_API_VERSION, readSites, relates, runSegment, segmentTrace, type Gens, type Read, type SkillInventory, type TraceEntry } from "./skill.ts";

export type DivergeReason =
  | "apiChanged" // the plan API is not the one the program was written for
  | "programChanged" // the source does not compile to its digest
  | "undeclaredSite" // a choose() no site declares
  | "siteMismatch" // the question asked is not the site's
  | "constantMissing" // no option reads as the constant
  | "sourceMissing" // the read site a match needs is not on screen
  | "noCandidate" // no option carries the value read
  | "ambiguous" // more than one option fits the rule
  | "trace" // the segment would register another write set
  | "draft"
  | "sandbox";

export type SkillRunResult =
  | { outcome: "done"; segments: number }
  | { outcome: "diverged"; segment: number; site: string | null; reason: DivergeReason; detail: string }
  /** The executor did not run a segment, or its observation could not be read. */
  | { outcome: "stopped"; segment: number; detail: string };

/** One segment's checked steps, as the executor gets them: what each step acts on and copies, read now. */
export interface SkillSegment {
  index: number;
  steps: { ref: string; kind: "fill" | "press" | "navigate"; target: TargetBinding; value: ValueBinding | null; effect: string | null }[];
}

export interface SkillPorts {
  /** The windows gen 0 reads, frozen now, with their bindings. */
  read(): Promise<{ snapshots: PlanningSnapshot[]; inventory: SkillInventory }>;
  /** Observation `n` (refs prefixed `g<n>:`, replay.ts prefixSnapshot), read after segment n-1 ran. */
  observe(n: number): Promise<{ snapshot: PlanningSnapshot; inventory: SkillInventory }>;
  /**
   * The executor path for one checked segment. It is handed the rerun's models, which refuse: nothing a skill runs may
   * ask a model. Returns null once the segment ran, else why it did not.
   */
  execute(segment: SkillSegment, models: AskJev): Promise<string | null>;
}

/** A model port that throws on every call and counts the calls. */
export interface RefusingModels {
  askJev: AskJev;
  readonly calls: number;
}

export function refusingModels(): RefusingModels {
  let calls = 0;
  return {
    askJev: async (req) => {
      calls++;
      throw new Error(`a skill rerun asks no model (${req.purpose})`);
    },
    get calls() {
      return calls;
    },
  };
}

class RuleFailure extends Error {
  readonly site: string;
  readonly reason: DivergeReason;
  constructor(site: string, reason: DivergeReason, detail: string) {
    super(detail);
    this.site = site;
    this.reason = reason;
  }
}

/**
 * choose() answered by rules: the k-th choice of the run past the recorded ones is site `firstSite + k`. A failure is
 * kept in `failed` and thrown, which ends the run (sandbox callbackError) before anything else is asked.
 */
function ruleChooser(sites: GoalSkillBody["sites"], firstSite: number, reads: ReadonlyMap<string, Read>, hash: Hash, failed: { at: RuleFailure | null }): ChooserPort {
  const byId = new Map([...reads.values()].map((r) => [r.shape.id, r]));
  let k = firstSite;
  return async (req) => {
    const site = sites[k];
    const id = `c${++k}`;
    const fail = (reason: DivergeReason, detail: string): never => {
      failed.at ??= new RuleFailure(id, reason, detail);
      throw failed.at;
    };
    if (site === undefined) return fail("undeclaredSite", `the program asks choice ${k}; the skill declares ${sites.length}`);
    if (hash(req.question.text) !== site.promptHmac) return fail("siteMismatch", `choice ${k} asks another question than the one reviewed`);
    const rule = site.rule;
    let hits: typeof req.options;
    if (rule.kind === "constant") {
      hits = req.options.filter((o) => hash(o.label.trim()) === rule.labelHmac);
      if (hits.length === 0) return fail("constantMissing", `none of ${req.options.length} options reads as the one reviewed`);
    } else {
      const source = byId.get(rule.sourceSite);
      if (source === undefined) return fail("sourceMissing", `the value the choice follows is not where it was read`);
      hits = req.options.filter((o) => relates(o.label, source.text, rule.relation, hash));
      if (hits.length === 0) return fail("noCandidate", `no option carries the value read`);
    }
    if (hits.length > 1) return fail("ambiguous", `${hits.length} options fit the ${rule.kind} rule`);
    return (hits[0] as (typeof req.options)[number]).ref;
  };
}

/** The first entry where `got` and `want` differ, as a site and a sentence; null when they are equal. */
function traceDifference(got: readonly TraceEntry[], want: readonly TraceEntry[]): { site: string | null; detail: string } | null {
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    const g = got[i];
    const w = want[i];
    if (g !== undefined && w !== undefined && canonical(g) === canonical(w)) continue;
    const site = (g ?? w)?.site ?? null;
    if (g === undefined) return { site, detail: `entry ${i + 1}: the reviewed ${w?.kind} is missing` };
    if (w === undefined) return { site, detail: `entry ${i + 1}: an extra ${g.kind} the review never saw` };
    return { site, detail: `entry ${i + 1}: ${g.kind}${g.kind === "write" ? ` ${g.step}` : ""} where the review has ${w.kind}${w.kind === "write" ? ` ${w.step}` : ""}${g.kind === w.kind ? " on another site or value" : ""}` };
  }
  return null;
}

const merge = (a: SkillInventory, b: SkillInventory): SkillInventory => ({ targets: new Map([...a.targets, ...b.targets]), values: new Map([...a.values, ...b.values]) });

/** Reruns a skill's program on the screen as it is now. */
export async function rerunGoalSkill(raw: GoalSkillBody, ports: SkillPorts, o: { hash: Hash; models?: RefusingModels }): Promise<SkillRunResult> {
  const body = GoalSkillBody.parse(raw);
  const hash = o.hash;
  const models = o.models ?? refusingModels();
  const diverged = (segment: number, site: string | null, reason: DivergeReason, detail: string): SkillRunResult => ({ outcome: "diverged", segment, site, reason, detail });
  if (body.program.apiVersion !== PLAN_API_VERSION) return diverged(0, null, "apiChanged", "the plan API changed since the program was reviewed");
  const compiled = compileProgram(body.program.source);
  if (!compiled.ok || compiled.digest !== body.program.digest) return diverged(0, null, "programChanged", compiled.ok ? "the source is not the reviewed program" : compiled.detail);

  const first = await ports.read();
  const gen0 = first.snapshots;
  const observations: PlanningSnapshot[] = [];
  let inventory = first.inventory;
  const chosen = new Map<string, string>();
  let prior: Pick<Recorded, "choices" | "prefix"> = { choices: [], prefix: [] };
  let observes = 0;
  for (let s = 0; ; s++) {
    const gens: Gens = [gen0, ...observations.map((x) => [x])];
    const reads = readSites(gens, inventory, hash);
    const firstSite = prior.choices.length;
    const failed: { at: RuleFailure | null } = { at: null };
    const ran = await runSegment(compiled, gen0, observations, prior, ruleChooser(body.sites, firstSite, reads, hash, failed));
    if (failed.at !== null) return diverged(s, failed.at.site, failed.at.reason, failed.at.message);
    if ("refused" in ran) return diverged(s, null, "sandbox", `${ran.refused}: ${ran.detail}`);
    if (ran.plan.drafts.length > 0) return diverged(s, null, "draft", "the program composed text on this run");
    chosenLabels(ran.newChoices, firstSite, gens, chosen);
    const traced = segmentTrace(s, firstSite, ran, { gens, inventory, reads, chosen, observesBefore: observes, hash });
    if ("reason" in traced) return diverged(s, null, "trace", `${traced.reason}: ${traced.detail}`);
    const differs = traceDifference(traced.entries, body.expectedTrace.filter((e) => e.segment === s));
    if (differs !== null) return diverged(s, differs.site, "trace", differs.detail);

    // segmentTrace refused any step whose target, or fill whose value, has no binding.
    const bound = <T>(v: T | undefined, what: string): T => {
      if (v === undefined) throw new Error(`segment ${s}: ${what} lost its binding after the trace check`);
      return v;
    };
    const steps: SkillSegment["steps"] = [];
    for (const x of ran.newSteps) {
      if (x.kind !== "fill" && x.kind !== "press" && x.kind !== "navigate") continue;
      const target = bound(inventory.targets.get(x.target), x.target);
      const value = x.kind === "fill" ? bound(inventory.values.get(x.value), x.value) : null;
      steps.push({ ref: x.ref, kind: x.kind, target, value, effect: x.kind === "fill" ? null : x.effect });
    }
    if (steps.length > 0) {
      const why = await ports.execute({ index: s, steps }, models.askJev);
      if (why !== null) return { outcome: "stopped", segment: s, detail: why };
    }
    observes += ran.newSteps.filter((x) => x.kind === "observe").length;
    prior = nextPrior(ran);
    if (ran.pending === null) {
      const later = body.expectedTrace.find((e) => e.segment > s);
      if (later !== undefined) return diverged(s, later.site, "trace", `the program ended at segment ${s}; the review goes on to segment ${later.segment}`);
      return { outcome: "done", segments: s + 1 };
    }
    let next: Awaited<ReturnType<SkillPorts["observe"]>>;
    try {
      next = await ports.observe(s + 1);
    } catch (e) {
      return { outcome: "stopped", segment: s, detail: `observation ${s + 1}: ${e instanceof Error ? e.message : String(e)}` };
    }
    observations.push(next.snapshot);
    inventory = merge(inventory, next.inventory);
  }
}
