// B19 acceptance 2 and 4: three routines planted in a synthetic stream of several thousand reader events,
// and a distractor stream with near misses of each. Each stream is replayed into a helper at Eager (two
// silent hits prove a routine). From day 4 of the planted stream the routine windows are left for Caret: the
// driver takes each routine offer, the run writes through an in-process reader under act grants, and a
// keep offer that follows is accepted. Reports each routine's name and whether it passes the naming check
// with no value in it, and the keep offers on both streams.
//
//   node scripts/skills-eval.ts --out DIR [--jev fake|live] [--max-usd 0.02]
//
// --jev live sends only the naming question to Jev (CARET_ENV_FILE names the .env with the key); every other
// question the helper asks (fill on focus) is answered "none" here, for free. It stops before spending more
// than --max-usd.
import { writeStore } from "../src/privacy/send.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { positiveNumber } from "./flags.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { loadJevKey, makeJevClient, sealRequest, storedRecord, type AskJev, type JevRequest, type SealedRequest } from "../src/fill/jev.ts";
import { checkName, type RoutineFacts } from "../src/patterns/naming.ts";
import { PROTOCOL_VERSION, type HelperMessage, type PatternOffer, type SkillOffer } from "../src/protocol.ts";
import type { TaskResult } from "../src/executor/executor.ts";
import { StreamReader, skillStream, type SkillStream } from "../test/skill-stream.ts";

const { values: a } = parseArgs({ options: { out: { type: "string" }, jev: { type: "string", default: "fake" }, "max-usd": { type: "string", default: "0.02" } } });
if (a.out === undefined) throw new Error("--out is required");
if (a.jev !== "fake" && a.jev !== "live") throw new Error("--jev is fake or live");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const MAX_USD = positiveNumber("max-usd", a["max-usd"]);

const live = a.jev === "live" ? makeJevClient(loadJevKey) : null;
let spent = 0;
let liveCalls = 0;

/** Answers the naming question (live or the first name) and every other question with none. */
function jev(recorded: SealedRequest[]): AskJev {
  return async (req) => {
    const name = req.questions.name;
    if (name === undefined) {
      return { model: "local-none", answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { choice: "none", confidence: 1 }])), inputTokens: 0, latencyMs: 0, costUsd: 0 };
    }
    // Sealed when recorded: the file records this frozen copy, and the copy is what is sent (PV2).
    const sent = sealRequest(req);
    recorded.push(sent);
    if (live === null) {
      const first = Object.keys(name.criteria).find((k) => k !== "none") ?? "none";
      return { model: "fake", answers: { name: { choice: first, confidence: 0.9 } }, inputTokens: 0, latencyMs: 0, costUsd: 0 };
    }
    if (spent >= MAX_USD) throw new Error(`budget: $${spent.toFixed(5)} spent, cap $${MAX_USD}`);
    const r = await live(sent.asked);
    spent += r.costUsd;
    liveCalls++;
    return r;
  };
}

interface Outcome {
  stream: string;
  events: number;
  routineOffers: number;
  runs: { day: number; plant: string; outcome: string }[];
  keepOffers: { plant: string; name: string; says: string }[];
  routines: { plant: string; routineId: string; count: number; hits: number; misses: number; name: string | null; nameBy: string | null; check: string | null; valuesInName: string[] }[];
  namings: { routineId: string; name: string | null; by: string | null; asks: number; costUsd: number; failures: string[] }[];
  namingRequests: number;
  valuesInRequests: number;
  skills: { name: string; runs: number; cleanRuns: number }[];
  wallSeconds: number;
}

async function run(label: string, s: SkillStream, takeOffers: boolean): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), "caret-skills-eval-"));
  const store = new Store(dir);
  const sent: HelperMessage[] = [];
  const recorded: SealedRequest[] = [];
  const reader = new StreamReader();
  const helper = new Helper({
    store,
    askJev: jev(recorded),
    shadow: false,
    allowBackgroundFocus: false,
    readerLink: reader,
    settings: { roles: ["fill", "repeat", "watch", "calendar", "words"], level: "eager", paused: false },
    publish: (m) => sent.push(m),
  });
  reader.helper = helper;
  const out: Outcome = { stream: label, events: s.messages.length, routineOffers: 0, runs: [], keepOffers: [], routines: [], namings: [], namingRequests: 0, valuesInRequests: 0, skills: [], wallSeconds: 0 };
  const plantOf = (windowId: string) => s.plants.find((p) => p.opens.some((o) => o.windowId === windowId));
  const t0 = Date.now();
  let nextTick: number | null = null;
  try {
    for (const m of s.messages) {
      const at = "at" in m ? m.at : 0;
      if (nextTick === null) nextTick = at + 250;
      else if (at - nextTick > 60_000) {
        helper.tick(at - 1);
        nextTick = at + 250;
      } else for (; nextTick <= at; nextTick += 250) helper.tick(nextTick);
      reader.observe(m);
      const before = sent.length;
      await helper.handleReader(m);
      // A day passes between occurrences, and a naming answer takes about a second: let it land, as it would.
      if (m.type === "windowClosed") await helper.patterns.skills.namesSettled();
      const offers = sent.slice(before).filter((x): x is PatternOffer => x.type === "patternOffer" && x.kind === "routine");
      out.routineOffers += offers.length;
      for (const o of offers) {
        if (!takeOffers) continue;
        const p = plantOf(o.windowId);
        const at0 = sent.length;
        const r = (await helper.handleOffer({ type: "offerControl", v: PROTOCOL_VERSION, offerId: o.id, action: "take" })) as TaskResult | null;
        out.runs.push({ day: p?.opens.find((x) => x.windowId === o.windowId)?.day ?? -1, plant: p?.name ?? "?", outcome: r?.outcome ?? "refused" });
        for (const k of sent.slice(at0).filter((x): x is SkillOffer => x.type === "skillOffer" && x.kind === "keep")) {
          out.keepOffers.push({ plant: p?.name ?? "?", name: k.name, says: k.says });
          helper.handleSkillAnswer({ type: "skillAnswer", v: PROTOCOL_VERSION, id: k.id, answer: "accept", at });
        }
      }
    }
    await helper.patterns.skills.namesSettled();
    // Keep offers can also only follow runs; any published outside the loop above is counted too.
    const allKeeps = sent.filter((x) => x.type === "skillOffer" && x.kind === "keep").length;
    if (allKeeps !== out.keepOffers.length) throw new Error(`keep offers seen ${allKeeps}, counted ${out.keepOffers.length}`);
    const values = [...new Set(s.plants.flatMap((p) => p.opens.flatMap((o) => o.values)))];
    for (const e of helper.memory.list("routine")) {
      if (e.kind !== "routine") continue;
      const plant = s.plants.find((p) => p.dstApp === e.fields.dstApp);
      const facts: RoutineFacts = { routineId: e.id, dstApp: e.fields.dstApp, dstWindow: null, dstLabels: plant?.labels ?? [], srcApps: e.fields.srcApps, srcLabels: [], count: e.evidence.count, values };
      const name = e.fields.name;
      out.routines.push({
        plant: plant?.name ?? "(not planted)",
        routineId: e.id,
        count: e.evidence.count,
        hits: e.fields.silent.hits,
        misses: e.fields.silent.misses,
        name,
        nameBy: helper.memory.routine(e.id)?.nameBy ?? null,
        check: name === null ? null : checkName(name, facts),
        valuesInName: name === null ? [] : values.filter((v) => name.toLowerCase().includes(v.toLowerCase())),
      });
    }
    out.namings = helper.patterns.skills.named.map((n) => ({ routineId: n.routineId, name: n.result.name, by: n.result.by, asks: n.result.asks, costUsd: n.result.costUsd, failures: n.result.failures }));
    out.namingRequests = recorded.length;
    out.valuesInRequests = recorded.filter((r) => values.some((v) => JSON.stringify([r.asked.state, r.asked.questions]).includes(v))).length;
    out.skills = helper.memory.list("skill").flatMap((e) => (e.kind === "skill" ? [{ name: e.fields.name, runs: e.fields.runs, cleanRuns: e.fields.cleanRuns }] : []));
    writeStore(join(OUT, `naming-requests-${label}.json`), JSON.stringify(recorded.map((r) => storedRecord(r, (f) => ({ state: f.state, questions: f.questions, snippets: f.snippets, charged: f.charged }))), null, 2) + "\n");
  } finally {
    out.wallSeconds = (Date.now() - t0) / 1000;
    helper.shutdown();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

const planted = await run("planted", skillStream({ caretFrom: 4 }), true);
const distractor = await run("distractor", skillStream({ seed: 23, distractor: true }), true);
const results = { jev: a.jev, liveCalls, liveUsd: spent, planted, distractor };
writeStore(join(OUT, "results.json"), JSON.stringify(results, null, 2) + "\n");

const lines = [
  `# B19 skills eval (Jev ${a.jev})`,
  "",
  `Planted: ${planted.events} events, ${planted.routines.length} routines learned, ${planted.routineOffers} routine offers, ${planted.runs.length} Caret runs (${planted.runs.filter((r) => r.outcome === "done").length} done), ${planted.keepOffers.length} keep offers.`,
  ...planted.routines.map((r) => `- ${r.plant}: '${r.name}' by ${r.nameBy}; check ${r.check ?? "passes"}; values in name ${r.valuesInName.length}; seen ${r.count}, silent ${r.hits}/${r.hits + r.misses}`),
  `Naming requests ${planted.namingRequests}, holding a value ${planted.valuesInRequests}. Namings: ${planted.namings.map((n) => `${n.by} after ${n.asks} ask(s)${n.failures.length > 0 ? ` (${n.failures.join("; ")})` : ""}`).join(", ")}.`,
  `Skills kept: ${planted.skills.map((x) => `'${x.name}' ${x.runs} runs, ${x.cleanRuns} clean in a row`).join("; ")}.`,
  "",
  `Distractor: ${distractor.events} events, ${distractor.routines.length} routines counted, ${distractor.namings.length} named, ${distractor.routineOffers} routine offers, ${distractor.keepOffers.length} keep offers.`,
  "",
  a.jev === "live" ? `Live Jev: ${liveCalls} calls, $${spent.toFixed(5)} (cap $${MAX_USD}).` : "Jev: fake (first candidate).",
];
writeStore(join(OUT, "summary.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
