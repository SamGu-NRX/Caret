// The decision engine an evaluation harness runs on (J1): `--engine jev|canned|llama|gemini`, with the record-and-replay
// cache in front of every engine that costs money or time, and, for llama, the calibration its probabilities are read
// through. Harnesses only: everything here stores or sends fixture text.
//
// llama's server and calibration come from the environment, so every harness reads them the same way:
//   CARET_LLAMA_URL (http://127.0.0.1:8091), CARET_LLAMA_MODEL (a name for reports and cache keys), CARET_LLAMA_PROMPT
//   (chat or document), CARET_LLAMA_THINKING=off (tells a thinking model's template not to think), and
//   CARET_ENGINE_CALIBRATION ("choiceT,noulT"; 1,1 is none).
import { assertNoExcludedValue } from "../../privacy.ts";
import { verifySent } from "../../privacy/disclosure.ts";
import { appendStoredLine, seal, type StoreRecord } from "../../privacy/send.ts";
import { withholdValues } from "../../privacy/exclude.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { frozenRequest, HOIST_SHARED_OPTIONS, LAYA_FREE_MODEL, jevSettings, loadJevKey, makeJevClient, wireBody, type AskJev } from "../../fill/jev.ts";
import { DailySpend } from "./daily-cap.ts";
import { cachedAsk, cacheFromEnv, canonicalRequest, checkFixture, refuseShipped, type FixtureSources } from "./cache.ts";
import { DEFAULT_PACE_MS, DISK_FLOOR_GIB, fileFailures, fileLog, filePace, HOLD_FILE, PACE_FILE, REAL_CLOCK, runStop, slowAsk, terminateSelf } from "./slow.ts";
import { calibrated, UNCALIBRATED, type Calibration } from "./confidence.ts";
import { LLAMA_READING, llamaEngine } from "./llama.ts";
import type { DecideEngine, EngineName } from "./port.ts";

/** Where harnesses keep recorded answers unless CARET_JEV_CACHE says otherwise: outside every worktree, never committed. */
export const HARNESS_CACHE_DIR = join(homedir(), ".caret-run", "jev-cache");

export interface HarnessEngineOptions {
  name: EngineName;
  /** The harness's answer-key engine, for `canned`. */
  canned: AskJev | null;
  fixture: FixtureSources;
  env?: NodeJS.ProcessEnv;
  /** Appends every request (fixture text only) to this file, with its size as sent and with shared options sent once. */
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
  // B24 read raw (T 1, 1) gave no wrong value (runs/b24-qwen3-4b-v2: 1 right, 4 partial), so the smallest temperature
  // that keeps B24 at 0 wrong is 1. Held out, it is not usable: B25 3 wrong, F1's blind tasks 1, the corpus 2
  // (evidence/screen/j1/bakeoff.md). Kept so the bake-off reruns as it ran.
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

/**
 * R1: free Laya answers HTTP 422 to any request whose state is a JSON object, and accepts the same state as a JSON
 * string (probes of B24 ask-01's heads request, 2026-10-06, evidence/screen/r1/probe/laya-shapes.txt). Caret's builders
 * send objects, so for Laya the state goes as its JSON text: the same characters, in one string.
 */
function layaState(ask: AskJev): AskJev {
  // The JSON text is minted from the state's own minted strings, so the client's check still holds (SC1 risk 2).
  return (req) => ask(typeof req.state === "string" ? req : { ...req, state: req.disclosure.jsonText(req.state) });
}

function baseEngine(o: HarnessEngineOptions, env: NodeJS.ProcessEnv): DecideEngine {
  if (o.name === "jev" || o.name.startsWith("gateway:")) {
    const providerEnv = o.name === "jev" ? env : { ...env, CARET_JEV_PROVIDER: "gateway", CARET_JEV_MODEL: o.name.slice("gateway:".length) };
    const settings = jevSettings(providerEnv);
    const ask = makeJevClient((provider) => loadJevKey(providerEnv, provider), 10_000, DailySpend.fromEnv(providerEnv), settings, undefined, undefined, { fixture: o.fixture, env });
    return { name: o.name, model: settings.model, reach: settings.provider, ask: settings.model === LAYA_FREE_MODEL ? layaState(ask) : ask };
  }
  switch (o.name) {
    case "canned":
      if (o.canned === null) throw new Error("this harness has no canned engine");
      // A canned engine meets the Jev client's checks too, so a canned run fails where a live one would: the format check
      // (privacy.ts assertNoExcludedValue) and the minting and shape check on the body a live client would send (SC1 2b, 2c).
      return { name: "canned", model: "canned", reach: "mac", ask: (req) => (assertNoExcludedValue(req), verifySent(req, wireBody(req, "canned")), (o.canned as AskJev)(req)) };
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
    default:
      throw new Error("unrecognised decision engine");
  }
}

/**
 * R1: the slow runner's layer (slow.ts) under the cache, when the runner (scripts/slow-eval.ts) names an events file in
 * CARET_SLOW_EVAL_EVENTS. It needs the cache on, since a rerun after a limit must not ask again what was answered.
 */
function slowFromEnv(engine: DecideEngine, env: NodeJS.ProcessEnv, cacheDir: string | null, variant: string): AskJev {
  const events = env.CARET_SLOW_EVAL_EVENTS;
  if (events === undefined || events === "" || engine.name === "canned") return engine.ask;
  if (cacheDir === null) throw new Error("CARET_SLOW_EVAL_EVENTS needs the replay cache on: a rerun after a rate limit would ask every answered request again");
  const paceMs = Number(env.CARET_SLOW_EVAL_PACE_MS ?? DEFAULT_PACE_MS);
  if (!(paceMs >= 0)) throw new Error(`CARET_SLOW_EVAL_PACE_MS is '${env.CARET_SLOW_EVAL_PACE_MS}'; it must be milliseconds, 0 or more`);
  const where = { holdFile: env.CARET_SLOW_EVAL_HOLD ?? HOLD_FILE, diskPath: homedir(), floorGiB: Number(env.CARET_SLOW_EVAL_DISK_GIB ?? DISK_FLOOR_GIB) };
  return slowAsk(engine.ask, {
    clock: REAL_CLOCK,
    freeOnly: engine.model === LAYA_FREE_MODEL,
    paceMs,
    pace: filePace(env.CARET_SLOW_EVAL_PACE_FILE ?? PACE_FILE),
    failures: fileFailures(join(cacheDir, "failures")),
    keyOf: (req) => canonicalRequest(req, engine.name, engine.model, variant).key,
    stopCheck: () => runStop(where, Date.now()),
    log: fileLog(events),
    endPass: terminateSelf,
  });
}

/** A request log's record (privacy/send.ts StoreRecord): the sealed body, its sizes and timings, and an error's text. */
const LOG_RECORD: Omit<StoreRecord, "build"> = {
  name: "request log",
  envelope: {
    body: { kind: "wire" },
    chars: { kind: "scalar", types: ["number"] },
    sharedChars: { kind: "scalar", types: ["number"] },
    latencyMs: { kind: "scalar", types: ["number"] },
    inputTokens: { kind: "scalar", types: ["number"] },
    afterMs: { kind: "scalar", types: ["number"] },
    error: { kind: "answer", max: 2000 },
  },
  wording: [],
};

export function harnessEngine(o: HarnessEngineOptions): HarnessEngine {
  const env = o.env ?? process.env;
  const engine = baseEngine(o, env);
  const cache = engine.name === "canned" ? null : cacheFromEnv(env, HARNESS_CACHE_DIR);
  const variant = engine.reach === "typesafe" || engine.reach === "gateway" ? `provider:${engine.reach};body:${HOIST_SHARED_OPTIONS ? "shared-options" : "per-question"}${engine.model === LAYA_FREE_MODEL ? ";state:json-text" : ""}` : engine.name === "llama" ? `prompt:${env.CARET_LLAMA_PROMPT ?? "chat"};thinking:${env.CARET_LLAMA_THINKING ?? "default"};read:${LLAMA_READING}` : "";
  const sent = slowFromEnv(engine, env, cache?.dir ?? null, variant);
  let ask = cache === null ? sent : cachedAsk(sent, { ...cache, engine: engine.name, model: engine.model, variant, fixture: o.fixture, env });
  if (engine.model === LAYA_FREE_MODEL) {
    // Guard cached answers too: fixture-only Laya is not available in the shipped app.
    refuseShipped(process.env);
    refuseShipped(env);
    const fixtureAsk = ask;
    ask = async (req) => {
      refuseShipped(process.env);
      refuseShipped(env);
      checkFixture(req, o.fixture);
      return fixtureAsk(req);
    };
  }
  const cal = engine.name === "llama" ? calibrationFromEnv(env, engine.model) : UNCALIBRATED;
  if (engine.name === "llama") ask = calibrated(ask, cal);
  const log = o.logRequests;
  const inner = ask;
  if (log !== undefined) {
    // The log stores request text as the cache does, so it refuses the shipped app too, with the cache off as well.
    refuseShipped(env);
    ask = async (req) => {
      // The log holds request text, so it takes what the cache takes: fixture text only.
      checkFixture(req, o.fixture);
      // PV2 Q2: written only as it is checked at the write, as the client checks what it sends, with values in formats
      // Caret never carries withheld (privacy/send.ts storedLine).
      // Sealed once: the engine is asked, and the log written, from this frozen copy only.
      const sealed = seal({ req, wire: { state: req.state, model: engine.model, questions: { ...req.questions, ...req.nouls } } });
      const asked = frozenRequest(req, sealed.wire, sealed.charged);
      const t0 = performance.now();
      let r: Awaited<ReturnType<AskJev>>;
      try {
        r = await inner(asked);
      } catch (e) {
        // A failed request is logged with its error, which the eval's report shows only as the user's sentence.
        const error = withholdValues(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        appendStoredLine(log, sealed, { ...LOG_RECORD, build: (w) => ({ body: w, chars: JSON.stringify(w).length, error, afterMs: performance.now() - t0 }) }, { mode: 0o600 });
        throw e;
      }
      appendStoredLine(log, sealed, { ...LOG_RECORD, build: (w) => ({ body: w, chars: JSON.stringify(w).length, sharedChars: JSON.stringify(wireBody(frozenRequest(req, w), engine.model, true)).length, latencyMs: r.latencyMs, inputTokens: r.inputTokens }) }, { mode: 0o600 });
      return r;
    };
  }
  const says = `engine ${engine.name} (${engine.model})${cache === null ? "" : `, cache ${cache.mode} in ${cache.dir}`}${engine.name === "llama" ? `, calibration choice T ${cal.choiceT}, yes/no T ${cal.noulT}` : ""}`;
  return { engine, ask, says };
}
