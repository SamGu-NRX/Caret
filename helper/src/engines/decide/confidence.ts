// Confidence for engines other than Jev (J1 part B), computed as Jev computes its own, so a caller's floor
// (FILL_CUTOFF, ROUTER1_FLOOR, HEAD_FLOOR and the rest) holds every engine to the same bar.
//
// TypeSafe documents a Choice's confidence as (p_max - 1/n) / (1 - 1/n) over its n options: 0 for an even split, 1
// when all the probability is on one option (docs.typesafe.ai/confidence, "How confidence is calculated"; copy in
// evidence/screen/j1/typesafe/confidence.md). For two options that is the top-two margin routing/judge.ts describes;
// for more it is not. A Noul's answer is the probability of yes itself.
//
// A small model's probabilities are not calibrated as Jev's are: it puts most of its mass on its first guess, right or
// wrong. So an engine's probabilities are first sharpened or flattened by a temperature fitted on a calibration set
// (fitTemperature in scripts that run the bake-off), p_i proportional to p_i^(1/T); T above 1 flattens.
import type { AskJev, JevResult } from "../../fill/jev.ts";

/** Jev's Choice confidence for a distribution over n options (see the file's header). */
export function choiceConfidence(probs: readonly number[]): number {
  const n = probs.length;
  if (n < 2) return n === 1 ? 1 : 0;
  const total = probs.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return 0;
  const top = Math.max(...probs) / total;
  return Math.max(0, Math.min(1, (top - 1 / n) / (1 - 1 / n)));
}

/** `probs` normalized, then each raised to 1/t and normalized again. */
export function withTemperature(probs: Readonly<Record<string, number>>, t: number): Record<string, number> {
  if (!(t > 0) || !Number.isFinite(t)) throw new Error(`a temperature must be a positive number, not ${t}`);
  const entries = Object.entries(probs).filter(([, p]) => p > 0);
  const raised = entries.map(([k, p]) => [k, Math.exp(Math.log(p) / t)] as const);
  const z = raised.reduce((a, [, p]) => a + p, 0);
  return Object.fromEntries(Object.keys(probs).map((k) => [k, z > 0 ? (raised.find(([x]) => x === k)?.[1] ?? 0) / z : 0]));
}

/** The probability of yes through a temperature, as a two-option distribution is. */
export function noulWithTemperature(pYes: number, t: number): number {
  const d = withTemperature({ yes: pYes, no: 1 - pYes }, t);
  return d.yes ?? 0;
}

/** How an engine's raw probabilities become what callers read: one temperature for choices, one for yes/no questions. */
export interface Calibration {
  choiceT: number;
  noulT: number;
}

export const UNCALIBRATED: Calibration = { choiceT: 1, noulT: 1 };

/**
 * The choice, confidence and yes probability callers read, from `r.probabilities` and `r.nouls` through `cal`. Every
 * choice answer must come with its probabilities: an engine that cannot say how sure it is cannot pass a floor.
 */
export function calibrate(r: JevResult, cal: Calibration): JevResult {
  const answers: JevResult["answers"] = {};
  for (const [q, a] of Object.entries(r.answers)) {
    const raw = r.probabilities?.[q];
    if (raw === undefined) throw new Error(`the engine answered ${q} without the probabilities its confidence comes from`);
    const p = withTemperature(raw, cal.choiceT);
    const ranked = Object.entries(p).sort(([, x], [, y]) => y - x);
    const choice = ranked[0]?.[0] ?? a.choice;
    answers[q] = { choice, confidence: choiceConfidence(Object.values(p)) };
  }
  const nouls = r.nouls === undefined ? undefined : Object.fromEntries(Object.entries(r.nouls).map(([q, p]) => [q, noulWithTemperature(p, cal.noulT)]));
  return { ...r, answers, ...(nouls === undefined ? {} : { nouls }) };
}

/**
 * `ask` with its answers read through `cal`. Each answer must come with a probability for exactly the options its
 * question listed, and must be the most likely of them: calibrate picks the choice again from the probabilities, so a
 * result whose choice and probabilities disagree would otherwise pass as its probabilities' pick (review).
 */
export function calibrated(ask: AskJev, cal: Calibration): AskJev {
  return async (req) => {
    const r = await ask(req);
    for (const [q, question] of Object.entries(req.questions)) {
      const a = r.answers[q];
      const p = r.probabilities?.[q];
      if (a === undefined || p === undefined) throw new Error(`the engine left ${q} without an answer and its probabilities`);
      const listed = Object.keys(question.criteria).sort();
      if (JSON.stringify(Object.keys(p).sort()) !== JSON.stringify(listed)) throw new Error(`the engine's probabilities for ${q} are not over the options it listed`);
      const top = Math.max(...Object.values(p));
      if ((p[a.choice] ?? -1) < top) throw new Error(`the engine answered ${q} with ${a.choice}, which its own probabilities do not rank first`);
    }
    return calibrate(r, cal);
  };
}
