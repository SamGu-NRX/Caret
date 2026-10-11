// Pattern acceptance with timings: replays the planted and distractor streams (test/stream.ts) at 50
// reader events a second, then forgets one routine and replays two more days, then runs the
// edit-to-memory scenario. Writes results.json and a short summary.md to --out.
//
//   node scripts/patterns-eval.ts --out DIR [--pace-ms 20]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Helper } from "../src/helper.ts";
import { DEFAULT_SETTINGS } from "../src/offers/settings.ts";
import { Store } from "../src/store.ts";
import { PROTOCOL_VERSION, type HelperMessage, type PatternOffer } from "../src/protocol.ts";
import { checkStream, distractorStream, plantedStream, replay, rerunStream, type Stream } from "../test/stream.ts";
import { Desk, grid, roster } from "../test/scene.ts";

/** Eager: routines need two silent hits there, the rule this evaluation's planted streams and earlier results were built on. */
const EVAL_SETTINGS = { ...DEFAULT_SETTINGS, level: "eager" } as const;

const { values: a } = parseArgs({ options: { out: { type: "string" }, "pace-ms": { type: "string", default: "20" } } });
if (a.out === undefined) throw new Error("--out is required");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const PACE = Number(a["pace-ms"]);

const quantiles = (xs: number[]): { n: number; p50: number; p95: number; p99: number; max: number } => {
  const v = [...xs].sort((x, y) => x - y);
  const q = (p: number): number => v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? 0;
  return { n: v.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: v[v.length - 1] ?? 0 };
};

function fresh(): { helper: Helper; sent: HelperMessage[]; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "caret-patterns-eval-"));
  const store = new Store(dir);
  const sent: HelperMessage[] = [];
  const helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, settings: EVAL_SETTINGS, publish: (m) => sent.push(m) });
  return {
    helper,
    sent,
    done: () => {
      helper.memory.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function run(name: string, s: Stream, h = fresh()): Promise<Record<string, unknown>> {
  const load = loadavg();
  const t0 = Date.now();
  const r = await replay(h.helper, h.sent, s, PACE);
  const wallS = (Date.now() - t0) / 1000;
  const check = checkStream(s, r, h.helper);
  const decisions = h.helper.memory.decisions();
  return {
    name,
    events: s.messages.length,
    wallSeconds: wallS,
    eventsPerSecond: s.messages.length / wallS,
    loadAverageAtStart: load,
    check,
    offers: r.offers.map((o) => ({ index: o.index, kind: o.offer.kind, says: o.offer.says, showProbability: o.offer.showProbability })),
    decisions: {
      total: decisions.length,
      spoken: decisions.filter((d) => d.speak).length,
      heldBy: Object.fromEntries([...new Set(decisions.flatMap((d) => d.reasons))].map((k) => [k, decisions.filter((d) => d.reasons.includes(k)).length])),
    },
    perRecognizerMs: h.helper.patterns.timings.summary(),
    perEventMs: { wall: quantiles(r.eventMs), cpu: quantiles(r.eventCpuMs) },
    loadAverageAtEnd: loadavg(),
  };
}

// 1, 2 and 5: planted and distractor streams at 50 events a second.
const planted = fresh();
const plantedStreamData = plantedStream();
const plantedResult = await run("planted", plantedStreamData, planted);
const distractorResult = await run("distractor", distractorStream());

// 4a: forget the mail routine, replay two more days of both routines on the same memory.
// The planted mail routine is the one whose steps read the Calendar window; noise also teaches small routines into Mail.
const routinesBefore = planted.helper.memory.list("routine");
const active = routinesBefore.filter((e) => e.status === "active" && e.kind === "routine" && e.fields.dstApp === "Mail Fixture");
if (active.length !== 1) throw new Error(`expected one active routine into Mail, found ${active.length}`);
const mailId = active[0]!.id;
const forget = planted.helper.handleMemory({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "f", op: "forget", id: mailId });
const lastAt = (plantedStreamData.messages.at(-1) as { at: number }).at;
const rerun = rerunStream(lastAt);
const before = planted.sent.length;
const rr = await replay(planted.helper, planted.sent, rerun, PACE);
const rerunOffers = planted.sent.slice(before).filter((m): m is PatternOffer => m.type === "patternOffer");
const rerunCheck = checkStream(rerun, rr, planted.helper);
const forgetResult = {
  forgotten: mailId,
  forgetError: forget.error,
  rerunEvents: rerun.messages.length,
  offersAfterForget: rerunCheck.routines.map((x) => ({ routine: x.name, offeredAt: x.offeredAt, offersRight: x.offersRight })),
  routinesBeforeForget: routinesBefore.map((e) => `${e.id}: ${e.says}`),
  routinesAfterRerun: planted.helper.memory.list("routine").map((e) => `${e.id}: ${e.says}`),
  rerunOfferCount: rerunOffers.length,
};
planted.done();

// 4b: an edit to a filled value becomes memory, and editing that memory changes the next fill.
async function editScenario(): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "caret-edit-"));
  const store = new Store(dir);
  const sent: HelperMessage[] = [];
  const desk = new Desk();
  const helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, settings: EVAL_SETTINGS, publish: (m) => sent.push(m), readerLink: desk });
  desk.attach(helper);
  const offers = (): PatternOffer[] => sent.filter((m): m is PatternOffer => m.type === "patternOffer");
  const sitting = (id: string) => {
    const g = grid(["Guest"], 6, id);
    const src = roster();
    desk.showList(src);
    desk.advance(1000);
    desk.showGrid(g);
    desk.fill(g, 0, 0, src.lines[0]!);
    desk.fill(g, 1, 0, src.lines[1]!);
    return g;
  };
  const g1 = sitting("6160-31");
  const first = offers().at(-1)!;
  await helper.handleOffer({ type: "offerControl", v: PROTOCOL_VERSION, offerId: first.id, action: "take" });
  desk.fill(g1, 2, 0, "Marcus Raman (ops)");
  const about = helper.handleMemory({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "a", op: "list", kind: "about" }).entries;
  desk.close(g1.windowId);
  sitting("6160-32");
  const second = offers().at(-1)!;
  const edit = helper.handleMemory({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "e", op: "edit", id: about[0]!.id, fields: { value: "Marcus Raman, Operations" } });
  desk.close("6160-32");
  sitting("6160-33");
  const third = offers().at(-1)!;
  helper.memory.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  return {
    firstPrediction: first.cells[0]?.value,
    userEditedTo: "Marcus Raman (ops)",
    learned: about.map((e) => e.says),
    nextFillAfterLearning: second.cells[0]?.value,
    memoryEditedTo: edit.entries[0]?.says,
    nextFillAfterMemoryEdit: third.cells[0]?.value,
  };
}
const editResult = await editScenario();

const results = { pacingMs: PACE, planted: plantedResult, distractor: distractorResult, forgetRerun: forgetResult, editChangesNextFill: editResult };
writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));

const f = (x: number): string => x.toFixed(3);
const row = (r: Record<string, unknown>): string => {
  const t = r.perRecognizerMs as Record<string, { n: number; wall: { p50: number; p99: number; max: number }; cpu: { p99: number; max: number } }>;
  return Object.entries(t)
    .map(([k, v]) => `| ${r.name} | ${k} | ${v.n} | ${f(v.wall.p50)} | ${f(v.wall.p99)} | ${f(v.wall.max)} | ${f(v.cpu.p99)} | ${f(v.cpu.max)} |`)
    .join("\n");
};
const ev = (r: Record<string, unknown>): string => {
  const v = r.perEventMs as { wall: { n: number; p50: number; p99: number; max: number }; cpu: { p99: number; max: number } };
  return `| ${r.name} | whole event (model, text, transfers, patterns) | ${v.wall.n} | ${f(v.wall.p50)} | ${f(v.wall.p99)} | ${f(v.wall.max)} | ${f(v.cpu.p99)} | ${f(v.cpu.max)} |`;
};
const load = (r: Record<string, unknown>): string => (r.loadAverageAtStart as number[]).map((x) => x.toFixed(1)).join(" / ");
writeFileSync(
  join(OUT, "summary.md"),
  `# Pattern stream evaluation

Generated by \`helper/scripts/patterns-eval.ts\` at ${new Date().toISOString()}, replaying at one event every ${PACE} ms.

| stream | events | wall s | events/s | load average at start (1/5/15 min, ${cpus().length} cores) |
| --- | --- | --- | --- | --- |
| planted | ${plantedResult.events} | ${(plantedResult.wallSeconds as number).toFixed(1)} | ${(plantedResult.eventsPerSecond as number).toFixed(1)} | ${load(plantedResult)} |
| distractor | ${distractorResult.events} | ${(distractorResult.wallSeconds as number).toFixed(1)} | ${(distractorResult.eventsPerSecond as number).toFixed(1)} | ${load(distractorResult)} |

Handling time per call, milliseconds. Wall time includes waiting for a CPU on a shared Mac; CPU time is process CPU (process.cpuUsage), which also counts V8's helper threads.

| stream | recognizer | calls | wall p50 | wall p99 | wall max | cpu p99 | cpu max |
| --- | --- | --- | --- | --- | --- | --- | --- |
${row(plantedResult)}
${ev(plantedResult)}
${row(distractorResult)}
${ev(distractorResult)}

Results are in results.json: per-loop and per-routine checks, offers, decision counts, the forget rerun and the edit scenario.
`,
);
console.log(JSON.stringify({ planted: plantedResult.check, distractorOffers: (distractorResult.offers as unknown[]).length, forgetResult, editResult }, null, 1));
process.exit(0);
