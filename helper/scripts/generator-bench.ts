// Times the candidate generator per focus on large synthetic screens (test/large-scene.ts), before
// B6 (the frozen generator in test/legacy-candidates.ts, capped at 80 as the product ran it) and
// after, and measures how long a fill request holds the helper's event loop.
//
//   node --expose-gc scripts/generator-bench.ts --out DIR [--focuses N] [--legacy-focuses N]
//
// Scenes: "day" (about 1,500 spans and 280 typed values), "day, lines only" (its typed values
// removed, so the generator reads lines), and "4x day" (about 5,500 spans). Before each focus every
// window is sent again ("cold": each window's cached indexes are rebuilt) or only the window the user
// left ("warm"). Per focus it records the generator's time, and the synchronous part of a fill
// request through the Helper with a Jev that answers at once, which is how long the request holds the
// event loop. An event-loop delay monitor (1 ms resolution) runs during the requests as a cross-check.
// Writes results.json and summary.md, and the day scene as NDJSON reader messages (scene-day.ndjson).
import { writeStore, writeStoreJson, writeStoreNdjson } from "../src/privacy/send.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { positiveInt } from "./flags.ts";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { collectCandidates, MAX_CANDIDATES } from "../src/fill/candidates.ts";
import { Helper } from "../src/helper.ts";
import { ScreenModel } from "../src/model.ts";
import { PROTOCOL_VERSION, type Snapshot } from "../src/protocol.ts";
import { Store } from "../src/store.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { largeScene, type LargeScene } from "../test/large-scene.ts";
import { legacyGenerateCandidates } from "../test/legacy-candidates.ts";

const { values: a } = parseArgs({ options: { out: { type: "string" }, focuses: { type: "string", default: "200" }, "legacy-focuses": { type: "string", default: "50" } } });
if (a.out === undefined) throw new Error("--out is required");
const OUT = a.out;
const FOCUSES = positiveInt("focuses", a.focuses);
/** The old generator takes most of a second per focus on the largest scene, so it is timed on fewer focuses. */
const LEGACY_FOCUSES = Math.min(FOCUSES, positiveInt("legacy-focuses", a["legacy-focuses"]));
mkdirSync(OUT, { recursive: true });

const quant = (xs: number[]): { p50: number; p95: number; max: number; n: number } => {
  const s = [...xs].sort((x, y) => x - y);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  const r = (x: number): number => Math.round(x * 100) / 100;
  return { p50: r(q(0.5)), p95: r(q(0.95)), max: r(s.at(-1) ?? 0), n: s.length };
};

let answeredAt = 0;
const answerNone: AskJev = async (req) => {
  answeredAt = performance.now();
  return {
    model: "bench",
    answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: "none", confidence: 0.9 }])),
    inputTokens: 0,
    latencyMs: 0,
    costUsd: 0,
  };
};

/** The scene's snapshots again, a step later, so the model gives every window a new state. */
const resend = (snaps: readonly Snapshot[], step: number): Snapshot[] => snaps.map((s) => ({ ...s, at: s.at + step, focused: false }));
const tickNext = (): Promise<void> => new Promise((r) => setImmediate(r));
/**
 * With --expose-gc, collects before each timed section, so garbage from the bench's own resent
 * snapshots (every window, every focus, in cold mode) is not collected inside a measurement.
 */
const collect = (): void => (globalThis as { gc?: () => void }).gc?.();

interface Row {
  scene: string;
  spans: number;
  nodes: number;
  mode: "cold" | "warm";
  legacyMs: ReturnType<typeof quant>;
  generatorMs: ReturnType<typeof quant>;
  overBudget: number;
  requestSyncMs: ReturnType<typeof quant>;
  requestCpuMs: ReturnType<typeof quant>;
  answerToProposalMs: ReturnType<typeof quant>;
  loopDelayMaxMs: number;
  loopDelayP99Ms: number;
}

async function run(name: string, scene: LargeScene, mode: "cold" | "warm"): Promise<Row> {
  const field = "dev.caret.form/standard/textfield:email~0";
  const formSnap = scene.snapshots.at(-1) as Snapshot;
  const others = scene.snapshots.slice(0, -1);

  // Generator alone, before and after, on a bare model.
  const model = new ScreenModel();
  for (const s of scene.snapshots) model.apply(s);
  const legacy: number[] = [];
  const now: number[] = [];
  let over = 0;
  for (let i = 0; i < FOCUSES; i++) {
    const changed = mode === "cold" ? others : [others[i % others.length] as Snapshot];
    for (const s of resend(changed, i + 1)) model.apply(s);
    const at = formSnap.at + 10_000 + i;
    collect();
    let t0 = performance.now();
    if (i < LEGACY_FOCUSES) {
      legacyGenerateCandidates(model, scene.formWindowId, MAX_CANDIDATES, at);
      legacy.push(performance.now() - t0);
    }
    // The legacy pass above built no cached index, so the generator below pays for its own.
    for (const s of resend(changed, i + 1 + 0.5)) model.apply(s);
    collect();
    t0 = performance.now();
    const { stats } = collectCandidates(model, scene.formWindowId, { now: at });
    now.push(performance.now() - t0);
    if (stats.overBudget) over++;
  }

  // A fill request through the Helper: its synchronous part is how long it holds the event loop.
  const dir = mkdtempSync(join(tmpdir(), "caret-bench-"));
  const store = new Store(dir);
  const helper = new Helper({ store, askJev: answerNone, shadow: false, allowBackgroundFocus: true, publish: () => undefined });
  for (const s of scene.snapshots) void helper.handleReader(s);
  const sync: number[] = [];
  const cont: number[] = [];
  /** CPU time of the same slice: wall time well above it means the process waited for a CPU. */
  const syncCpu: number[] = [];
  const h = monitorEventLoopDelay({ resolution: 1 });
  for (let i = 0; i < FOCUSES; i++) {
    const changed = mode === "cold" ? others : [others[i % others.length] as Snapshot];
    for (const s of resend(changed, 1000 + i)) void helper.handleReader(s);
    await tickNext();
    collect();
    h.enable();
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    const p = helper.handleConsumer({ type: "fillRequest", v: PROTOCOL_VERSION, windowId: scene.formWindowId, fieldKey: field });
    sync.push(performance.now() - t0);
    const c1 = process.cpuUsage(c0);
    syncCpu.push((c1.user + c1.system) / 1000);
    const proposal = await p;
    // From the second ask's answer to the proposal: the request's other synchronous slice.
    cont.push(performance.now() - answeredAt);
    if (proposal === null) throw new Error("the fill request made no proposal");
    await tickNext();
    h.disable();
  }
  helper.shutdown();
  helper.memory.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  return {
    scene: name,
    spans: legacyGenerateCandidates(model, scene.formWindowId, Number.POSITIVE_INFINITY).length,
    nodes: scene.nodes,
    mode,
    legacyMs: quant(legacy),
    generatorMs: quant(now),
    overBudget: over,
    requestSyncMs: quant(sync),
    requestCpuMs: quant(syncCpu),
    answerToProposalMs: quant(cont),
    loopDelayMaxMs: Math.round(h.max / 1e4) / 100,
    loopDelayP99Ms: Math.round(h.percentile(99) / 1e4) / 100,
  };
}

/** The monitor's own floor on this Mac: the same enable, two loop turns, disable, with no request. */
async function baseline(): Promise<{ p99: number; max: number }> {
  const h = monitorEventLoopDelay({ resolution: 1 });
  for (let i = 0; i < FOCUSES; i++) {
    await tickNext();
    collect();
    h.enable();
    await tickNext();
    await tickNext();
    h.disable();
  }
  return { p99: Math.round(h.percentile(99) / 1e4) / 100, max: Math.round(h.max / 1e4) / 100 };
}

const day = largeScene(7, 1);
const noTyped: LargeScene = (() => {
  const snapshots = day.snapshots.map((s) => ({ ...s, values: [] }));
  const model = new ScreenModel();
  for (const s of snapshots) model.apply(s);
  return { ...day, snapshots, model };
})();
const big = largeScene(7, 4);

writeStoreNdjson(join(OUT, "scene-day.ndjson"), day.snapshots);
const load = loadavg();
const rows: Row[] = [];
for (const [name, scene] of [["day", day], ["day, lines only", noTyped], ["4x day", big]] as const) {
  for (const mode of ["cold", "warm"] as const) {
    const r = await run(name, scene, mode);
    rows.push(r);
    process.stdout.write(`${name} ${mode}: legacy p95 ${r.legacyMs.p95} ms, generator p95 ${r.generatorMs.p95} ms, request sync p95 ${r.requestSyncMs.p95} ms max ${r.requestSyncMs.max} ms\n`);
  }
}
const floor = await baseline();
const loadAfter = loadavg();
writeStoreJson(join(OUT, "results.json"), { at: new Date().toISOString(), focuses: FOCUSES, loadavg: { before: load, after: loadAfter }, monitorFloorMs: floor, rows }, 2);

const md = [
  "# Candidate generator per focus",
  "",
  `\`node ${(globalThis as { gc?: unknown }).gc === undefined ? "" : "--expose-gc "}scripts/generator-bench.ts --out DIR --focuses ${FOCUSES} --legacy-focuses ${LEGACY_FOCUSES}\` in the helper, ${new Date().toISOString().slice(0, 16)}Z, one-minute load average ${load[0]?.toFixed(1)} before and ${loadAfter[0]?.toFixed(1)} after (this Mac was shared). ${FOCUSES} focuses per row, the first ${LEGACY_FOCUSES} of them also timed before.`,
  "",
  "- *Before*: the generator as of 129b4b3 with the product's cap of 80.",
  "- *After*: the early-capped generator with its 15 ms budget.",
  "- *Request*: the synchronous part of a fill request through the Helper, with a Jev that answers at once. It covers form fields, descriptors, the generator and both asks' prompts, and is how long the request holds the event loop.",
  "- *Request CPU*: the CPU time the process used in that slice. Wall time well above it is the process waiting for a CPU on a loaded Mac, not the helper's code.",
  "- *Answer to proposal*: from the second ask's answer to the finished proposal, the request's other synchronous slice.",
  "- *Cold*: every window changed before the focus, so every cached index is rebuilt. *Warm*: one window changed.",
  `- ${(globalThis as { gc?: unknown }).gc === undefined ? "Run without --expose-gc: garbage from the resent snapshots can be collected inside a measurement." : "Run with --expose-gc: the heap was collected before each timed section, so the bench's own resent snapshots are not collected inside one."}`,
  "",
  "| Scene | Spans | Nodes | Mode | Before p50 / p95 ms | After p50 / p95 / max ms | Over budget | Request p50 / p95 / max ms | Request CPU p95 / max ms | Answer to proposal p95 / max ms | Loop delay p99 / max ms |",
  "|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|",
  ...rows.map(
    (r) =>
      `| ${r.scene} | ${r.spans} | ${r.nodes} | ${r.mode} | ${r.legacyMs.p50} / ${r.legacyMs.p95} | ${r.generatorMs.p50} / ${r.generatorMs.p95} / ${r.generatorMs.max} | ${r.overBudget} | ${r.requestSyncMs.p50} / ${r.requestSyncMs.p95} / ${r.requestSyncMs.max} | ${r.requestCpuMs.p95} / ${r.requestCpuMs.max} | ${r.answerToProposalMs.p95} / ${r.answerToProposalMs.max} | ${r.loopDelayP99Ms} / ${r.loopDelayMaxMs} |`,
  ),
  "",
  `With no request at all, the same monitor cycle read p99 ${floor.p99} ms and max ${floor.max} ms: on a loaded Mac the loop-delay column includes the process waiting for a CPU, so the request column is the measure of what the helper's own code holds.`,
  "",
];
writeStore(join(OUT, "summary.md"), md.join("\n"));
