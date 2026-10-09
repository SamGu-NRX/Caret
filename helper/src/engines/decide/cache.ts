// Record and replay of decision requests, for test harnesses (brief J1, part A3). An evaluation run makes the same
// requests as the last run on an unchanged page, so with the cache a rerun costs nothing and answers the same.
//
// The cache writes each request's text to disk, and request text is screen text. So it runs only where every text
// is a fixture's:
// - it refuses to start in the shipped app (the launchd agent's CARET_LAUNCHD_AGENT, or CARET_OPENED_BY_LAUNCHSERVICES
//   on a copy LaunchServices opened; apps/caret LaunchRole), and the helper refuses CARET_JEV_CACHE outright
//   (refuseCacheInHelper), since the helper reads the user's real screen;
// - it refuses any request that declares text (privacy.ts Snippet) from a window the harness did not load from a
//   fixture, or from the user's memory unless the harness's memory is a fixture's, before it reads or writes anything;
// - it verifies each request as the client does (privacy/disclosure.ts: minted, in its shape) before it replays or
//   records it, so a replayed run fails where a live one would, and it stores the request with every value in a format
//   Caret never carries withheld (storable). An entry is kept until someone deletes it: nothing prunes the directory.
//
// A request is keyed by a hash of its canonical form: the engine and model, the state, and each question by its
// content, not its id. An option is named by its description's rank among the request's descriptions. A fill's second
// ask lists the same candidates shuffled under fresh ids every run (fill.ts shuffledWithinWindows), so keying on ids
// would miss every second ask; the recorded answer is mapped back to this run's ids. When two options share a
// description, or two questions their content, no renaming can tell them apart and the key uses the exact ids.
import { ENV, processEnv, type HostEnv } from "../../host-env.ts";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_SNIPPETS } from "../../privacy.ts";
import { frozenRequest, wireBody, type AskJev, type ChoiceQuestion, type JevRequest, type JevResult, type NoulQuestion } from "../../fill/jev.ts";
import { seal, writeStoredLine, type StoreRecord } from "../../privacy/send.ts";
import { renameLocal } from "../../privacy/store-path.ts";

export type CacheMode = "record" | "replay" | "replay-or-record";
const MODES: readonly CacheMode[] = ["record", "replay", "replay-or-record"];
const FORMAT = 1;

/** The cache refused to run, or refused a request, because request text could reach the disk from a real screen. */
export class CacheRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheRefused";
  }
}

/**
 * Which texts the harness loaded from fixtures: window ids it put on its desk from fixture files, its memory, and the
 * text its plans wrote from its own instructions (SnippetLedger.plan declares it under window id "plan").
 */
export interface FixtureSources {
  windows: (windowId: string) => boolean;
  memory: boolean;
  plan: boolean;
}

/** SnippetLedger.plan's window id (privacy.ts). */
const PLAN_SNIPPETS = "plan";

export interface CacheOptions {
  dir: string;
  mode: CacheMode;
  /** The engine and model answering, and anything else that changes their answer (canonicalRequest), part of every key. */
  engine: string;
  model: string;
  variant?: string;
  fixture: FixtureSources;
  /** The environment checked for the shipped app's markers; the process's own by default. */
  env?: HostEnv;
}

const SHIPPED_MARKERS = [ENV.caret_launchd_agent, ENV.caret_opened_by_launchservices] as const;

/** Throws CacheRefused in the shipped app (its launchd agent's marker, or a copy LaunchServices opened). */
export function refuseShipped(env: HostEnv): void {
  for (const m of SHIPPED_MARKERS) {
    if (env[m] !== undefined && env[m] !== "") throw new CacheRefused(`the decision cache stores request text on disk and runs only in test harnesses, but ${m} is set: this is the shipped app`);
  }
}

/** The helper serves the user's real screens, so a CARET_JEV_CACHE in its environment is a mistake: refused at start. */
export function refuseCacheInHelper(env: HostEnv = processEnv()): void {
  if (env[ENV.caret_jev_cache] !== undefined) throw new CacheRefused("CARET_JEV_CACHE is set, but the helper reads real screens and the decision cache would store their text on disk; the cache is only for test harnesses");
}

/**
 * The cache a harness uses: CARET_JEV_CACHE names the directory ("off" turns it off; unset is `dir`), and
 * CARET_JEV_CACHE_MODE the mode (replay-or-record unless set).
 */
export function cacheFromEnv(env: HostEnv, dir: string): { dir: string; mode: CacheMode } | null {
  const raw = env[ENV.caret_jev_cache_mode] ?? "replay-or-record";
  if (!(MODES as readonly string[]).includes(raw)) throw new Error(`CARET_JEV_CACHE_MODE is '${raw}'; it must be ${MODES.join(", ")}`);
  const named = env[ENV.caret_jev_cache];
  if (named === "off") return null;
  return { dir: named === undefined || named === "" ? dir : named, mode: raw as CacheMode };
}

type Question = ChoiceQuestion | NoulQuestion;
interface CanonQuestion {
  /** The request's own question id, only in an exact key. */
  id?: string;
  type: Question["type"];
  instructions: unknown;
  criteria: [string, string | null][] | Question["criteria"] | null;
}

export interface Canonical {
  key: string;
  /** True when the key uses the request's own ids, since descriptions or contents repeat (see the file's header). */
  exact: boolean;
  /** The canonical questions, in key order. */
  questions: CanonQuestion[];
  /** This request's question id at each canonical position. */
  questionIds: string[];
  /** Option id to canonical name, and back. */
  toCanon: Map<string, string>;
  fromCanon: Map<string, string>;
}

/** JSON with every object's keys sorted, so equal values print the same. */
function sortedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/**
 * `variant` names anything else that changes what the engine sees or how its answer is read for the same request: Jev's
 * body shape, llama's prompt and reading (harness.ts).
 */
export function canonicalRequest(req: JevRequest, engine: string, model: string, variant = ""): Canonical {
  const all: [string, Question][] = [...Object.entries(req.questions), ...Object.entries(req.nouls ?? {})];
  // Each option id's one description, and each description's one id; a clash in either direction keys exactly.
  const descOf = new Map<string, string | null>();
  const idOf = new Map<string, string>();
  let exact = false;
  for (const [, q] of all) {
    if (q.type !== "choice") continue;
    for (const [id, d] of Object.entries(q.criteria)) {
      const seen = descOf.get(id);
      if (seen !== undefined && seen !== d) exact = true;
      descOf.set(id, d);
      if (d !== null) {
        const other = idOf.get(d);
        if (other !== undefined && other !== id) exact = true;
        idOf.set(d, id);
      }
    }
  }
  // An option id the state or an instruction names ties that text to the id, not to the description: renaming would let
  // two requests that differ only in which description an id carries share a key (review). Such a request keys exactly.
  if (!exact) {
    const said = JSON.stringify([req.state, all.map(([, q]) => q.instructions)]);
    const named = (id: string): boolean => new RegExp(`(?<![\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "u").test(said);
    if ([...idOf.values()].some(named)) exact = true;
  }
  const toCanon = new Map<string, string>();
  if (!exact) {
    // Options with a description are named by its rank; an option with none is its own name (yes, no, none, a 1 to n).
    const descs = [...idOf.keys()].sort();
    descs.forEach((d, i) => toCanon.set(idOf.get(d) as string, `#${i + 1}`));
    for (const [id, d] of descOf) if (d === null) toCanon.set(id, id);
  } else for (const id of descOf.keys()) toCanon.set(id, id);
  const canonQ = (q: Question): CanonQuestion =>
    q.type === "choice"
      ? { type: q.type, instructions: q.instructions, criteria: Object.entries(q.criteria).map(([id, d]): [string, string | null] => [toCanon.get(id) as string, d]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) }
      : { type: q.type, instructions: q.instructions, criteria: q.criteria ?? null };
  let entries = all.map(([id, q]) => ({ id, c: canonQ(q), text: sortedJson(canonQ(q)) }));
  if (!exact && new Set(entries.map((e) => e.text)).size < entries.length) exact = true;
  if (exact) {
    for (const id of descOf.keys()) toCanon.set(id, id);
    entries = all.map(([id, q]) => ({ id, c: { ...canonQ(q), id }, text: sortedJson({ ...canonQ(q), id }) }));
  }
  entries.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  const questions = entries.map((e) => e.c);
  const key = createHash("sha256").update(sortedJson({ v: FORMAT, engine, model, variant, exact, state: req.state, questions })).digest("hex");
  return { key, exact, questions, questionIds: entries.map((e) => e.id), toCanon, fromCanon: new Map([...toCanon].map(([a, b]) => [b, a])) };
}

/** A recorded answer, by canonical question position and option name. */
interface Entry {
  v: number;
  engine: string;
  model: string;
  canonical: { exact: boolean; state: unknown; questions: CanonQuestion[] };
  answeredBy: string;
  answers: Record<number, { choice: string; confidence: number }>;
  nouls: Record<number, number>;
  probabilities: Record<number, Record<string, number>>;
  inputTokens: number;
  latencyMs: number;
  recordedAt: string;
}

/** Throws CacheRefused when `req` declares text that is not a fixture's (see the file's header). */
export function checkFixture(req: JevRequest, fixture: FixtureSources): void {
  // Every window the request declares text from, and every window its ledger charged: a plan's text is declared under
  // "plan", but each window line it holds is charged to that window.
  for (const id of new Set([...req.snippets.map((s) => s.windowId), ...Object.keys(req.charged)])) {
    if (id === MEMORY_SNIPPETS) {
      if (!fixture.memory) throw new CacheRefused("the decision cache stores request text on disk, and this request carries the user's memory, which this harness did not load from a fixture");
    } else if (id === PLAN_SNIPPETS) {
      if (!fixture.plan) throw new CacheRefused("the decision cache stores request text on disk, and this request carries a plan's text, which this harness did not write from a fixture's instruction");
    } else if (!fixture.windows(id)) {
      throw new CacheRefused(`the decision cache stores request text on disk, and this request carries text from window ${id}, which this harness did not load from a fixture`);
    }
  }
}

/**
 * A cache entry (privacy/send.ts StoreRecord): the request's state and its questions with their options renamed by rank
 * (canonicalRequest), and what the engine answered.
 */
const ENTRY_RECORD: Omit<StoreRecord, "build"> = {
  name: "decision cache",
  envelope: {
    v: { kind: "scalar", types: ["number"] },
    engine: { kind: "config", max: 100 },
    model: { kind: "config", max: 200 },
    "canonical.exact": { kind: "scalar", types: ["boolean"] },
    "canonical.state": { kind: "rendered", max: 400_000 },
    "canonical.questions": { kind: "rendered", max: 400_000 },
    answeredBy: { kind: "answer", max: 200 },
    "answers.*.choice": { kind: "answer", max: 200 },
    "answers.*.confidence": { kind: "scalar", types: ["number"] },
    "nouls.*": { kind: "scalar", types: ["number"] },
    "probabilities.*.*": { kind: "scalar", types: ["number"] },
    inputTokens: { kind: "scalar", types: ["number"] },
    latencyMs: { kind: "scalar", types: ["number"] },
    recordedAt: { kind: "config", max: 40 },
  },
  wording: ["choice noul"],
};

/** `ask` with the cache in front of it (see the file's header). */
export function cachedAsk(ask: AskJev, opts: CacheOptions): AskJev {
  refuseShipped(opts.env ?? processEnv());
  if (!(MODES as readonly string[]).includes(opts.mode)) throw new Error(`cache mode '${opts.mode}' is not one of ${MODES.join(", ")}`);
  return async (req) => {
    refuseShipped(opts.env ?? processEnv());
    checkFixture(req, opts.fixture);
    // Sealed once (privacy/send.ts): the key, the engine's request and the record all come from this frozen copy.
    const sealed = seal({ req, wire: wireBody(req, opts.model) });
    const asked = frozenRequest(req, sealed.wire, sealed.charged);
    const c = canonicalRequest(asked, opts.engine, opts.model, opts.variant ?? "");
    const path = join(opts.dir, c.key.slice(0, 2), `${c.key}.json`);
    if (opts.mode !== "record") {
      let entry: Entry | null = null;
      try {
        entry = JSON.parse(readFileSync(path, "utf8")) as Entry;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (entry !== null) return replayed(entry, c, asked.nouls !== undefined);
      if (opts.mode === "replay") throw new Error(`replay: nothing recorded for this ${opts.engine} request (${c.key.slice(0, 12)}) in ${opts.dir}`);
    }
    const r = await ask(asked);
    const pos = new Map(c.questionIds.map((id, i) => [id, i]));
    const at = (id: string): number => {
      const i = pos.get(id);
      if (i === undefined) throw new Error(`the ${opts.engine} engine answered ${id}, which the request did not ask`);
      return i;
    };
    const name = (id: string): string => c.toCanon.get(id) ?? id;
    // The request's part of the entry is read from the sealed bytes as it is written (storedLine's `wire`), never from an
    // object; the rest is what came back.
    const entry = (wire: unknown): Entry => {
      const sent = canonicalRequest(frozenRequest(req, wire), opts.engine, opts.model, opts.variant ?? "");
      return {
      v: FORMAT,
      engine: opts.engine,
      model: opts.model,
      canonical: { exact: sent.exact, state: (wire as { state: unknown }).state, questions: sent.questions },
      answeredBy: r.model,
      answers: Object.fromEntries(Object.entries(r.answers).map(([id, a]) => [at(id), { choice: name(a.choice), confidence: a.confidence }])),
      nouls: Object.fromEntries(Object.entries(r.nouls ?? {}).map(([id, p]) => [at(id), p])),
      probabilities: Object.fromEntries(Object.entries(r.probabilities ?? {}).map(([id, ps]) => [at(id), Object.fromEntries(Object.entries(ps).map(([o, p]) => [name(o), p]))])),
      inputTokens: r.inputTokens,
      latencyMs: r.latencyMs,
      recordedAt: new Date().toISOString(),
      };
    };
    mkdirSync(join(opts.dir, c.key.slice(0, 2)), { recursive: true, mode: 0o700 });
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    // Checked as it is written, after the answer came back (privacy/send.ts storedLine).
    writeStoredLine(tmp, sealed, { ...ENTRY_RECORD, build: entry }, { mode: 0o600 });
    renameLocal(tmp, path);
    return r;
  };
}

function replayed(e: Entry, c: Canonical, askedNouls: boolean): JevResult {
  const id = (i: string | number): string => {
    const q = c.questionIds[Number(i)];
    if (q === undefined) throw new Error("a recorded answer names a question this request does not have");
    return q;
  };
  const option = (n: string): string => {
    const o = c.fromCanon.get(n);
    if (o === undefined) throw new Error(`a recorded answer names option ${n}, which this request does not list`);
    return o;
  };
  const nouls = Object.entries(e.nouls).map(([i, p]) => [id(i), p] as const);
  const probabilities = Object.entries(e.probabilities).map(([i, ps]) => [id(i), Object.fromEntries(Object.entries(ps).map(([o, p]) => [option(o), p]))] as const);
  return {
    model: e.answeredBy,
    answers: Object.fromEntries(Object.entries(e.answers).map(([i, a]) => [id(i), { choice: option(a.choice), confidence: a.confidence }])),
    ...(askedNouls ? { nouls: Object.fromEntries(nouls) } : {}),
    ...(probabilities.length === 0 ? {} : { probabilities: Object.fromEntries(probabilities) }),
    inputTokens: e.inputTokens,
    latencyMs: e.latencyMs,
    // A replay sends nothing, so it costs nothing.
    costUsd: 0,
  };
}
