// The decision engine an evaluation harness runs on (J1): `--engine jev|canned|llama|gemini`, with the record-and-replay
// cache in front of every engine that costs money or time, and, for llama, the calibration its probabilities are read
// through. Harnesses only: everything here stores or sends fixture text.
//
// llama's server and calibration come from the environment, so every harness reads them the same way:
//   CARET_LLAMA_URL (http://127.0.0.1:8091), CARET_LLAMA_MODEL (a name for reports and cache keys), CARET_LLAMA_PROMPT
//   (chat or document), CARET_LLAMA_THINKING=off (tells a thinking model's template not to think), and
//   CARET_ENGINE_CALIBRATION ("choiceT,noulT"; 1,1 is none).
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { JEV_MODEL, loadJevKey, makeJevClient, wireBody, type AskJev } from "../../fill/jev.ts";
import { cachedAsk, cacheFromEnv, checkFixture, type FixtureSources } from "./cache.ts";
import { calibrated, UNCALIBRATED, type Calibration } from "./confidence.ts";
import { llamaEngine } from "./llama.ts";
import type { DecideEngine, EngineName } from "./port.ts";

/** Where harnesses keep recorded answers unless CARET_JEV_CACHE says otherwise: outside every worktree, never committed. */
export const HARNESS_CACHE_DIR = join(homedir(), ".caret-run", "jev-cache");

export interface HarnessEngineOptions {
  name: EngineName;
  /** The harness's answer-key engine, for `canned`. */
  canned: AskJev | null;
  fixture: FixtureSources;
  env?: NodeJS.ProcessEnv;
  /** Appends every request as sent (its wire body, fixture text only) to this file, for the token breakdown. */
  logRequests?: string;
}

export interface HarnessEngine {
  engine: DecideEngine;
  ask: AskJev;
  /** One line for the report: the engine, model, cache and calibration. */
  says: string;
}

/**
 * Each llama model's calibration as the bake-off fitted it on B24, the calibration set (evidence/screen/j1/runs). A model
 * not listed has none, and an eval refuses to run it without CARET_ENGINE_CALIBRATION, since a small model's raw
 * probabilities pass callers' floors that Jev's would not; "1,1" runs it raw, for fitting.
 */
export const CALIBRATIONS: Readonly<Record<string, Calibration>> = {
  // B24 read raw (T 1, 1) gave no wrong value (runs/b24-qwen3-4b-T1: 1 right, 4 partial, 4 asked, 11 refused), so the
  // smallest temperature that keeps B24 at 0 wrong is 1. Held-out results: evidence/screen/j1 bake-off.
  "qwen3-4b-instruct-2507-q4km": { choiceT: 1, noulT: 1 },
};

export function calibrationFromEnv(env: NodeJS.ProcessEnv, model?: string): Calibration {
  const raw = env.CARET_ENGINE_CALIBRATION;
  if (raw === undefined || raw === "") {
    const known = model === undefined ? undefined : CALIBRATIONS[model];
    if (known !== undefined) return known;
    throw new Error(`no calibration for ${model ?? "this engine"}: set CARET_ENGINE_CALIBRATION ("choiceT,noulT"; "1,1" reads its probabilities raw, for fitting)`);
  }
  const [c, n] = raw.split(",").map(Number);
  if (c === undefined || n === undefined || !(c > 0) || !(n > 0)) throw new Error(`CARET_ENGINE_CALIBRATION is '${raw}'; it must be two temperatures above 0, "choiceT,noulT"`);
  return { choiceT: c, noulT: n };
}

function baseEngine(o: HarnessEngineOptions, env: NodeJS.ProcessEnv): DecideEngine {
  switch (o.name) {
    case "canned":
      if (o.canned === null) throw new Error("this harness has no canned engine");
      return { name: "canned", model: "canned", reach: "mac", ask: o.canned };
    case "jev":
      return { name: "jev", model: JEV_MODEL, reach: "typesafe", ask: makeJevClient(() => loadJevKey(env)) };
    case "llama": {
      const prompt = env.CARET_LLAMA_PROMPT ?? "chat";
      if (prompt !== "chat" && prompt !== "document") throw new Error(`CARET_LLAMA_PROMPT is '${prompt}'; it must be chat or document`);
      const model = env.CARET_LLAMA_MODEL;
      if (model === undefined || model === "") throw new Error("--engine llama needs CARET_LLAMA_MODEL, the name of the model llama-server runs");
      return llamaEngine({ url: env.CARET_LLAMA_URL ?? "http://127.0.0.1:8091", model, prompt, ...(env.CARET_LLAMA_THINKING === "off" ? { templateKwargs: { enable_thinking: false } } : {}) });
    }
    case "gemini":
      // Brief J1: Gemini Flash-Lite's free tier only with a key in Caret's .env, and there is none.
      throw new Error("--engine gemini needs GEMINI_API_KEY in Caret's .env, and there is none; it is not built");
  }
}

export function harnessEngine(o: HarnessEngineOptions): HarnessEngine {
  const env = o.env ?? process.env;
  const engine = baseEngine(o, env);
  const cache = engine.name === "canned" ? null : cacheFromEnv(env, HARNESS_CACHE_DIR);
  let ask = cache === null ? engine.ask : cachedAsk(engine.ask, { ...cache, engine: engine.name, model: engine.model, fixture: o.fixture, env });
  const cal = engine.name === "llama" ? calibrationFromEnv(env, engine.model) : UNCALIBRATED;
  if (engine.name === "llama") ask = calibrated(ask, cal);
  const log = o.logRequests;
  const inner = ask;
  if (log !== undefined) {
    ask = async (req) => {
      // The log holds request text, so it takes what the cache takes: fixture text only.
      checkFixture(req, o.fixture);
      const r = await inner(req);
      const body = { state: req.state, model: JEV_MODEL, questions: { ...req.questions, ...req.nouls } };
      appendFileSync(log, `${JSON.stringify({ body, chars: JSON.stringify(body).length, wireChars: JSON.stringify(wireBody(req)).length, latencyMs: r.latencyMs, inputTokens: r.inputTokens })}\n`, { mode: 0o600 });
      return r;
    };
  }
  const says = `engine ${engine.name} (${engine.model})${cache === null ? "" : `, cache ${cache.mode} in ${cache.dir}`}${engine.name === "llama" ? `, calibration choice T ${cal.choiceT}, yes/no T ${cal.noulT}` : ""}`;
  return { engine, ask, says };
}
