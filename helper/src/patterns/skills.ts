// Skills (B19): routines Caret names, offers to keep, and lets run without a Tab once they have earned it.
//   Naming. When a scored silent prediction leaves a routine proven at the user's level, Caret names it
//     once, in the background (naming.ts), from structure only.
//   Keep. At the end of a Caret run of a routine that succeeded, a routine that is not yet a skill gets
//     one offer: "Keep this as <name>?". Accepting makes it a skill, on Tab; declining is remembered and
//     the offer is never made for that routine again. An offer nobody answers expires and may come back
//     after a later run.
//   Earn. Each run of a skill is clean when it reached every end state, or stopped only at the hand-off
//     the plan ends with. PROMOTE_AFTER clean runs in a row bring one offer: "Do this one on your own
//     from now on?". Accepted, later runs start from the trigger without a Tab, still with progress,
//     undo and take over. Any run that is not clean, and any undo of a skill's run, resets the count and
//     puts the skill back on Tab; it can earn the offer again, unless the user declined it.
//   Never promoted: a skill whose plan has a step that hands a press to the user (risk.ts decides each
//     step from its control's label), and a skill whose runs wrote under a permission the user's rule
//     does not let run unasked (mayRunUnasked).
import { randomUUID } from "node:crypto";
import { classifyLabel } from "../executor/risk.ts";
import type { Plan } from "../executor/schema.ts";
import type { TaskResult } from "../executor/executor.ts";
import type { AskJev } from "../fill/jev.ts";
import type { ScreenModel } from "../model.ts";
import { PROTOCOL_VERSION, type HelperMessage, type PermissionRule, type SkillAnswer, type SkillOffer } from "../protocol.ts";
import type { OfferGate } from "../offers/settings.ts";
import { expired } from "../offers/lifetimes.ts";
import { offerable, type MemoryStore, type RoutineRecord, type SkillRecord } from "./memory.ts";
import { fallbackName, list, nameRoutine, safeFacts, type NameResult, type RoutineFacts } from "./naming.ts";
import type { BundleClose, RoutineCell } from "./routines.ts";

/** What naming reads from a predicted or offered cell: where it writes, and where and what it copies from. */
export type FactCell = Pick<RoutineCell, "dstWindowId" | "dstLabel" | "srcWindowId" | "srcKey" | "value">;

/**
 * Clean runs in a row before Caret offers to run a skill without a Tab. Assumed, not measured: the plan's
 * permission table names 10 (fable55-plan.md section 3). B21 read two real days of the shadow store
 * (scripts/real-day-replay.ts, 557 transfers): the shadow helper's own recognizer saw no routine more than
 * twice and scored no prediction; an approximate replay through this code found one routine 8 times and no
 * run of a routine repeating into its destination longer than 3. The data can neither support nor refute
 * 10, so it is kept until a store holds routines that repeat past it.
 */
export const PROMOTE_AFTER = 10;

/** The permissions a routine run writes under: in the window the user is in, or in another. */
export type WriteAction = "writeHere" | "writeElsewhere";

/**
 * Whether a skill whose runs write under `action` may run without a Tab while the user's rule for that
 * action is `rule`. "Write where you are" starts at ask, and the plan's table says it becomes act per
 * routine after enough clean runs when Caret proposes it and the user agrees: that agreement is the
 * promote offer, so ask or act both allow it. "Reversible write elsewhere" may only become "act if
 * pre-approved": at ask, nothing is promoted past it (B19 brief).
 */
export function mayRunUnasked(action: WriteAction, rule: PermissionRule): boolean {
  return action === "writeHere" ? rule === "ask" || rule === "act" : rule === "actIfApproved";
}

/** The press a plan hands to the user, read per step by the risk table; null when every step is a write Caret verifies. */
export function handedPress(plan: Plan): { step: number; why: string } | null {
  for (const [i, s] of plan.steps.entries()) {
    if (s.end.kind === "handoff") return { step: i, why: s.end.why };
    if (s.via?.kind === "press") {
      const risk = classifyLabel(s.via.target.label ?? s.via.target.describe);
      if (risk !== "safe") return { step: i, why: risk };
    }
  }
  return null;
}

/** A run reached every end state, or stopped only at the hand-off its plan ends with, as planned. */
export function cleanRun(plan: Plan, r: Pick<TaskResult, "outcome" | "step">): boolean {
  if (r.outcome === "done") return true;
  const last = plan.steps.length - 1;
  return r.outcome === "handoff" && r.step === last && plan.steps[last]?.end.kind === "handoff";
}

export interface SkillsDeps {
  model: ScreenModel;
  memory: MemoryStore;
  publish: (m: HelperMessage) => void;
  gate: OfferGate;
  shadow: () => boolean;
  askJev: AskJev | null;
  /** Values the routine with this signature was seen copying (RoutineRecognizer.valuesOf). */
  valuesOf: (sig: string) => string[];
  rand?: (n: number) => number;
}

interface OpenOffer {
  msg: SkillOffer;
  /** A keep offer's trigger clause, rendered from the run's fields when the offer was made. */
  trigger: string | null;
}

/**
 * A run of a skill, by task id. Kept as long as the executor keeps the task, which is for good, since its
 * undo can come any time and must reset the skill.
 */
interface SkillRun {
  skillId: string;
  action: WriteAction;
}

export class Skills {
  private readonly deps: SkillsDeps;
  private readonly offers = new Map<string, OpenOffer>();
  private readonly runs = new Map<string, SkillRun>();
  private readonly naming = new Set<Promise<void>>();
  private clock = 0;
  /** Every naming that finished, newest last, for evaluations and the debug view. Bounded. */
  readonly named: { routineId: string; result: Omit<NameResult, "requests"> }[] = [];

  constructor(deps: SkillsDeps) {
    this.deps = deps;
    // An offer out when the helper last stopped is gone with it; its routine or skill may be asked again.
    deps.memory.clearOfferedSkillStates();
  }

  // MARK: - naming

  /**
   * A bundle closed. Each routine a hit just left proven at the user's level, unnamed and never asked,
   * is named now, in the background. The facts are read here, while the closing window is still in the
   * screen model.
   */
  onBundleClosed(close: BundleClose, at: number): void {
    this.clock = Math.max(this.clock, at);
    const sightings = this.deps.gate.rules.routineSightings;
    if (sightings === null || this.deps.shadow()) return;
    for (const s of close.scored) {
      if (!s.hit || s.cells.length === 0) continue;
      const r = this.deps.memory.routine(s.routineId);
      if (r === null || r.namingAsked || r.name !== null || !offerable(r, sightings)) continue;
      this.deps.memory.markNamingAsked(r.id);
      const facts = this.facts(r, s.cells);
      const p = nameRoutine(facts, this.deps.askJev, () => this.deps.model.windows.values(), this.deps.rand)
        .then((result) => {
          if (result.name !== null && result.by !== null) this.deps.memory.setRoutineName(r.id, result.name, result.by);
          const { requests: _r, ...kept } = result;
          return kept;
        })
        // nameRoutine reports a failed request in its result; what lands here is a store failure, kept for the record.
        .catch((e: unknown): Omit<NameResult, "requests"> => ({ name: null, by: null, asks: 0, costUsd: 0, failures: [`naming failed: ${e instanceof Error ? e.message : String(e)}`] }))
        .then((result) => {
          this.named.push({ routineId: r.id, result });
          if (this.named.length > 200) this.named.shift();
        })
        .finally(() => this.naming.delete(p));
      this.naming.add(p);
    }
  }

  /** Resolves once every naming started so far has finished, for tests and evaluations. */
  async namesSettled(): Promise<void> {
    while (this.naming.size > 0) await Promise.all([...this.naming]);
  }

  /** What naming may know about a routine, read from the cells of one of its predictions and the live screen model. */
  facts(r: RoutineRecord, cells: readonly FactCell[]): RoutineFacts {
    const model = this.deps.model;
    const dstWindow = model.windows.get(cells[0]?.dstWindowId ?? "") ?? null;
    const srcLabels: RoutineFacts["srcLabels"] = [];
    for (const c of cells) {
      const w = model.windows.get(c.srcWindowId);
      const n = w?.nodes.get(c.srcKey);
      if (w === undefined || n === undefined) continue;
      // A static text's label is its content, so its section's label stands for it.
      const own = n.editable === true || n.role !== "AXStaticText" ? n.label : undefined;
      const parent = n.parent === null ? undefined : w.nodes.get(n.parent);
      const text = own ?? (parent !== undefined && parent.role !== "AXStaticText" ? parent.label : undefined);
      if (text !== undefined && text.trim() !== "") srcLabels.push({ window: w, text });
    }
    return {
      routineId: r.id,
      dstApp: r.steps[0]?.dstApp ?? dstWindow?.app.name ?? "",
      dstWindow,
      dstLabels: cells.map((c) => c.dstLabel ?? "").filter((l) => l.trim() !== ""),
      srcApps: [...new Set(r.steps.map((s) => s.srcApp))],
      srcLabels,
      count: r.count,
      values: [...new Set([...this.deps.valuesOf(r.sig), ...cells.map((c) => c.value)])],
    };
  }

  // MARK: - runs

  /** The skill made from this routine and not paused, or null. */
  activeSkill(routineId: string | null): SkillRecord | null {
    if (routineId === null) return null;
    const s = this.deps.memory.skillFor(routineId);
    return s === null || s.paused ? null : s;
  }

  /**
   * Whether a prediction of this routine into this window may start a run with no Tab now: the skill is on
   * its own, its plan hands nothing to the user, and the user's rule for the permission the run would
   * write under still allows it.
   */
  runsOnItsOwn(routineId: string, action: WriteAction, plan: Plan): boolean {
    const s = this.activeSkill(routineId);
    if (s === null || !s.onItsOwn || s.handsOff !== null) return false;
    if (this.deps.memory.routine(routineId)?.finish != null) return false;
    if (handedPress(plan) !== null) return false;
    return mayRunUnasked(action, this.deps.memory.permission(action));
  }

  /** A run of a skill started; its result and any undo of it are counted against the skill. */
  runStarted(taskId: string, routineId: string | null, action: WriteAction): void {
    const s = this.activeSkill(routineId);
    if (s !== null) this.runs.set(taskId, { skillId: s.id, action });
  }

  /**
   * A run of a routine's offer ended. A skill's run is counted, clean or not; a clean one may bring the
   * promote offer, and a clean run of a routine that is not a skill may bring the keep offer.
   */
  afterRun(taskId: string, routineId: string, plan: Plan, cells: readonly FactCell[], r: Pick<TaskResult, "outcome" | "step">, at: number): void {
    this.clock = Math.max(this.clock, at);
    const memory = this.deps.memory;
    const clean = cleanRun(plan, r);
    const run = this.runs.get(taskId);
    if (run !== undefined) {
      const s = memory.skill(run.skillId);
      if (s === null) return;
      if (!clean) {
        this.reset(memory.updateSkill(s.id, { runs: s.runs + 1 }, at), at);
        return;
      }
      const wrote = s.wrote.includes(run.action) ? s.wrote : [...s.wrote, run.action];
      const next = memory.updateSkill(s.id, { runs: s.runs + 1, cleanRuns: s.cleanRuns + 1, wrote }, at);
      this.maybePromote(next, plan, taskId);
      return;
    }
    if (!clean || this.offeringHeld()) return;
    const routine = memory.routine(routineId);
    if (routine === null || routine.keep !== null || memory.skillFor(routineId) !== null) return;
    const facts = safeFacts(this.facts(routine, cells));
    const name = routine.name ?? fallbackName(facts);
    if (name === null) return;
    if (routine.name === null) memory.setRoutineName(routine.id, name, "code");
    memory.setRoutineKeep(routine.id, "offered");
    this.offer(
      { kind: "keep", taskId, routineId, skillId: null, name, says: `Keep this as ${name}?`, detail: "Caret will offer it when you start it again.", accept: "Keep", decline: "No thanks" },
      trigger(facts),
    );
  }

  /**
   * The user undid a run, or changed a value it wrote: a skill's run resets its count, and a promote offer
   * that run brought is withdrawn.
   */
  reversed(taskId: string, at: number): void {
    const run = this.runs.get(taskId);
    if (run === undefined) return;
    const s = this.deps.memory.skill(run.skillId);
    if (s !== null) this.reset(s, at);
  }

  /** Any failure, mismatch, undo or take over: the count starts again and the skill goes back on Tab. A declined promote offer stays declined. */
  private reset(s: SkillRecord, at: number): void {
    for (const o of [...this.offers.values()]) if (o.msg.kind === "promote" && o.msg.skillId === s.id) this.close(o, "stale");
    this.deps.memory.updateSkill(s.id, { cleanRuns: 0, onItsOwn: false, wrote: [], promote: s.promote === "declined" ? "declined" : null }, at);
  }

  private maybePromote(s: SkillRecord, plan: Plan, taskId: string): void {
    if (s.onItsOwn || s.promote !== null || s.cleanRuns < s.needed || this.offeringHeld()) return;
    if (s.handsOff !== null || handedPress(plan) !== null || this.deps.memory.routine(s.routineId)?.finish != null) return;
    if (!s.wrote.every((a) => mayRunUnasked(a, this.deps.memory.permission(a)))) return;
    this.deps.memory.updateSkill(s.id, { promote: "offered" }, this.clock);
    this.offer({
      kind: "promote",
      taskId,
      routineId: s.routineId,
      skillId: s.id,
      name: s.name,
      says: "Do this one on your own from now on?",
      detail: "You'll see it happen and can undo it.",
      accept: "Do it on its own",
      decline: "Keep asking",
    });
  }

  /** Caret is paused or the user's settings turn routines off: no skill offer is made. The hourly budget does not apply, since the offer answers a run the user just took. */
  private offeringHeld(): boolean {
    return this.deps.shadow() || this.deps.gate.holds("routine", this.clock).some((h) => h !== "hourlyBudget");
  }

  // MARK: - offers

  private offer(o: { kind: SkillOffer["kind"]; taskId: string; routineId: string; skillId: string | null; name: string; says: string; detail: string; accept: string; decline: string }, trigger: string | null = null): void {
    const msg: SkillOffer = {
      type: "skillOffer",
      v: PROTOCOL_VERSION,
      // Unique across helper restarts, so a late answer to an offer from before one cannot land on another.
      id: `skill-offer-${randomUUID().slice(0, 13)}`,
      at: this.clock,
      kind: o.kind,
      taskId: o.taskId,
      routineId: o.routineId,
      skillId: o.skillId,
      name: o.name,
      says: o.says,
      detail: o.detail,
      actions: [{ id: "accept", label: o.accept }, { id: "decline", label: o.decline }],
    };
    this.offers.set(msg.id, { msg, trigger });
    this.deps.publish(msg);
  }

  /** Every skill offer still open, for tests and the debug view. */
  openOffers(): SkillOffer[] {
    return [...this.offers.values()].map((o) => o.msg);
  }

  /** The user's answer. Returns why it was refused, or null when it was applied. */
  answer(m: SkillAnswer): string | null {
    const o = this.offers.get(m.id);
    if (o === undefined) return `skill offer ${m.id}: no such offer, or it was answered or expired`;
    const at = Math.max(this.clock, m.at);
    const memory = this.deps.memory;
    const msg = o.msg;
    if (msg.kind === "keep") {
      const routine = memory.routine(msg.routineId);
      if (routine === null) {
        this.close(o, "stale");
        return `skill offer ${m.id}: its routine was forgotten`;
      }
      if (m.answer === "accept") {
        const handsOff = routine.finish === null ? null : { label: routine.finish.label, why: routine.finish.why };
        memory.addSkill(routine.id, { name: msg.name, trigger: o.trigger ?? `a ${routine.steps[0]?.dstApp ?? "matching"} window opens with its fields empty`, needed: PROMOTE_AFTER, handsOff }, at);
      } else memory.setRoutineKeep(routine.id, "declined");
    } else {
      const s = msg.skillId === null ? null : memory.skill(msg.skillId);
      if (s === null) {
        this.close(o, "stale");
        return `skill offer ${m.id}: its skill was forgotten`;
      }
      memory.updateSkill(s.id, m.answer === "accept" ? { onItsOwn: true, promote: null } : { promote: "declined" }, at);
    }
    this.close(o, m.answer === "accept" ? "taken" : "dismissed", true);
    return null;
  }

  /** Ends offers past their lifetime; an unanswered keep or promote offer may be made again after a later run. */
  tick(now: number): void {
    this.clock = Math.max(this.clock, now);
    for (const o of [...this.offers.values()]) if (expired("skill", o.msg.at, this.clock)) this.close(o, "expired");
  }

  /** Withdraws an offer. Unless it was answered, the routine or skill goes back to where it stood before the offer, so a later run may make it again. */
  private close(o: OpenOffer, reason: "taken" | "dismissed" | "expired" | "stale" | "settings", answered = false): void {
    if (!this.offers.delete(o.msg.id)) return;
    if (!answered) {
      const memory = this.deps.memory;
      if (o.msg.kind === "keep") {
        if (memory.routine(o.msg.routineId)?.keep === "offered") memory.setRoutineKeep(o.msg.routineId, null);
      } else if (o.msg.skillId !== null) {
        const s = memory.skill(o.msg.skillId);
        if (s?.promote === "offered") memory.updateSkill(s.id, { promote: null }, this.clock);
      }
    }
    this.deps.publish({ type: "offerWithdrawn", v: PROTOCOL_VERSION, at: this.clock, id: o.msg.id, reason });
  }

  /** Caret was paused or routines turned off: open skill offers go, as `settings`. */
  withdrawAll(): void {
    for (const o of [...this.offers.values()]) this.close(o, "settings");
  }
}

/** When a kept routine is offered, as a clause: "a Tracker window opens with Order, Carrier and Tracking empty". */
export function trigger(f: RoutineFacts): string {
  const fields = f.dstLabels.length === 0 ? "its fields" : list(f.dstLabels.slice(0, 4));
  // "an Electron window" (B20); a name that starts with a vowel letter takes "an". Names read aloud otherwise ("an MCP") are rare enough to leave.
  return f.dstApp === "" ? `a window opens with ${fields} empty` : `${/^[aeiou]/i.test(f.dstApp) ? "an" : "a"} ${f.dstApp} window opens with ${fields} empty`;
}
