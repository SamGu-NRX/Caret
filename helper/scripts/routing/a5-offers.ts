// The A5 offers fixture with routing on and off (brief R2, after H6's offers_routing_measure.ts on v2/routing), here in
// the helper alone: each of A5's recordings (fixtures/recorded/offers-fill, offers-loop, offers-pending) is replayed
// through the real socket into a fresh Helper, and the offers it publishes are counted. Nothing is accepted. H6 counted
// "wanted" from the same helper-published messages; its host only relayed them.
//
//   node scripts/routing/a5-offers.ts --out DIR --mode off|live|capture [--runs 3] [--settle-ms 6000]
//     [--spend-cap USD] [--env-file FILE]
//
//   off      no router: every producer offers on its own, as before D2-02.
//   live     the router on, with live Jev for router questions only; every other question goes to A5's fake.
//   capture  the router on, answered abstain here with no call; each router request is saved to DIR for reading.
//
// A host is played in process: it connects with routing (so write is legal) and sends the default settings from its
// own session, which is where the helper records the watch role (routing/consent.ts).
import { writeStore, writeStoreJson } from "../../src/privacy/send.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Helper } from "../../src/helper.ts";
import { HelperServer } from "../../src/server.ts";
import { Store } from "../../src/store.ts";
import { MemoryStore } from "../../src/patterns/memory.ts";
import { loadJevKey, makeJevClient, sealRequest, storedRecord, type AskJev, type JevRequest, type SealedRequest } from "../../src/fill/jev.ts";
import { PROTOCOL_VERSION, type HelperMessage } from "../../src/protocol.ts";
import { DEFAULT_SETTINGS } from "../../src/offers/settings.ts";
import { jevPickingText } from "../../test/builders.ts";
import { SocketReader, loadRecording } from "../../test/socket-reader.ts";

const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    mode: { type: "string", default: "capture" },
    runs: { type: "string", default: "3" },
    "settle-ms": { type: "string", default: "6000" },
    "spend-cap": { type: "string", default: "0.01" },
    "env-file": { type: "string", default: "/Users/samgu/Programming Projects/Caret/.env" },
  },
});
if (a.out === undefined) throw new Error("--out is required");
const MODE = a.mode;
if (MODE !== "off" && MODE !== "live" && MODE !== "capture") throw new Error(`--mode is off, live or capture, not ${String(MODE)}`);
const OUT = a.out;
mkdirSync(OUT, { recursive: true });
const RUNS = Number(a.runs);
const SETTLE_MS = Number(a["settle-ms"]);
const SPEND_CAP = Number(a["spend-cap"]);
const SOCKETS = join(homedir(), ".caret-run", "sockets");
mkdirSync(SOCKETS, { recursive: true });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

for (const pid of [5150, 6160, 7170]) {
  let live = true;
  try {
    process.kill(pid, 0);
  } catch (e) {
    live = (e as NodeJS.ErrnoException).code === "EPERM";
  }
  if (live) throw new Error(`pid ${pid} is a live process; the recordings' pids must not exist. Nothing was started.`);
}

/** A5's fake Jev (offers_socket_acceptance.ts on v2/host) for every question that is not a router's. */
const FILL_VALUES: Record<string, string> = { Name: "Dana Whitfield", Email: "dana.whitfield@example.com", Phone: "+1 (512) 555-0142" };
const fake: AskJev = async (req) => {
  if (req.questions.finished !== undefined) {
    const done = /done|passed/i.test(String((req.state as Record<string, unknown>).lines_that_changed));
    return { model: "jev-test", answers: { finished: { choice: done ? "yes" : "no", confidence: 0.9 }, waiting: { choice: "no", confidence: 0.9 } }, inputTokens: 1, latencyMs: 1, costUsd: 0 };
  }
  return jevPickingText((_, instructions) => FILL_VALUES[/Label: '([^']+)'/.exec(instructions)?.[1] ?? ""] ?? null)(req);
};

const isRouter = (r: JevRequest): boolean => "outcome" in r.questions || "task" in r.questions || "route" in r.questions;
let routerCalls = 0;
let spendUsd = 0;
let overCap = 0;
const captured: { recording: string; run: number; request: SealedRequest }[] = [];
let current = { recording: "", run: 0 };
process.env.CARET_ENV_FILE = a["env-file"];
const live = MODE === "live" ? makeJevClient(loadJevKey) : null;
const askJev: AskJev = async (req) => {
  if (!isRouter(req)) return fake(req);
  routerCalls++;
  if (MODE === "capture") {
    // Sealed when captured: the file records this frozen copy (PV2).
    captured.push({ ...current, request: sealRequest(req) });
    const answers = Object.fromEntries(Object.keys(req.questions).map((q) => [q, { choice: q === "route" ? "handoff" : "abstain", confidence: 0.9 }]));
    return { model: "capture", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  }
  if (spendUsd >= SPEND_CAP) {
    overCap++;
    throw new Error(`live router spend reached $${SPEND_CAP}`);
  }
  const r = await (live as AskJev)(req);
  spendUsd += r.costUsd;
  return r;
};

const RECORDINGS: { file: string; wanted: HelperMessage["type"] }[] = [
  { file: "offers-fill.ndjson", wanted: "popup" },
  { file: "offers-loop.ndjson", wanted: "alternatives" },
  { file: "offers-pending.ndjson", wanted: "action" },
];
/** Every message type that puts something in front of the user. */
const OFFER_TYPES = new Set(["popup", "alternatives", "action", "patternOffer", "fillProposal", "firstLookOffer"]);
const HOST = "r2-host";

async function replay(file: string, wanted: string): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "caret-r2-a5-"));
  const sock = join(SOCKETS, `r2-a5-${process.pid}.sock`);
  const store = new Store(join(dir, "data"));
  const memory = new MemoryStore(join(dir, "data"));
  const sent: HelperMessage[] = [];
  const warnings: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const setTimer = (fn: () => void, ms: number): (() => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return () => {
      clearTimeout(t);
      timers.delete(t);
    };
  };
  let server: HelperServer | null = null;
  const helper = new Helper({
    store,
    memory,
    askJev,
    shadow: false,
    allowBackgroundFocus: false,
    routing: MODE === "off" ? null : { setTimer },
    publish: (m) => {
      sent.push(m);
      server?.publish(m);
    },
    sendToReader: (cmd) => server?.sendToReader(cmd) ?? false,
    warn: (l) => warnings.push(l),
  });
  server = new HelperServer(sock, () => helper, (l) => warnings.push(`server: ${l}`));
  await server.listen();
  helper.hostConnected(HOST, true);
  helper.handleSettings({ type: "settings", v: PROTOCOL_VERSION, at: Date.now(), roles: [...DEFAULT_SETTINGS.roles], level: DEFAULT_SETTINGS.level, paused: false }, HOST);
  const reader = await SocketReader.connect(sock);
  const lines = loadRecording(file);
  await reader.replay(lines, { applied: (w, at) => helper.model.windows.get(w)?.updatedAt === at, tick: (at) => helper.tick(at) });
  await sleep(SETTLE_MS);
  for (let i = 0; i < 400; i++) {
    await helper.routing?.idle();
    await helper.routedSettled;
    if (timers.size === 0) break;
    await sleep(50);
  }
  const offers: Record<string, number> = {};
  for (const m of sent) if (OFFER_TYPES.has(m.type)) offers[m.type] = (offers[m.type] ?? 0) + 1;
  // Offers in front of the user, each once: a loop's alternatives (offerKey "<patternOffer id>.<cell>") are part of
  // their pattern offer, as the host shows them (H6 counted 9 on the host with routing off).
  const distinct = new Set<string>();
  for (const m of sent) {
    if (!OFFER_TYPES.has(m.type)) continue;
    const r = m as unknown as { id?: string; offerKey?: string };
    distinct.add(m.type === "alternatives" ? (r.offerKey ?? "").replace(/\.\d+$/, "") : (r.id ?? r.offerKey ?? `${m.type}?`));
  }
  const decisions = (helper.routing?.decisions ?? []).map((d) => ({ breakpoint: d.breakpoint, outcome: d.outcome, by: d.by, local: d.local, route: d.route, consent: d.consent, refused: d.refused, failure: d.failure, confidence: d.confidence, answered: d.answered, latencyMs: d.latencyMs }));
  const routeDecisions = sent.filter((m) => m.type === "routeDecision").length;
  helper.shutdown();
  reader.close();
  await server.close();
  memory.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  const shown = distinct.size;
  const wantedShown = (offers[wanted] ?? 0) > 0;
  return { recording: file, offers, shown, wantedShown, unwanted: shown - (wantedShown ? 1 : 0), routeDecisions, decisions, warnings: warnings.slice(0, 20) };
}

const replays: Record<string, unknown>[] = [];
for (let run = 1; run <= RUNS; run++)
  for (const r of RECORDINGS) {
    current = { recording: r.file, run };
    replays.push(await replay(r.file, r.wanted));
  }
const wanted = replays.filter((r) => r.wantedShown === true).length;
const shown = replays.reduce((n, r) => n + (r.shown as number), 0);
const unwanted = replays.reduce((n, r) => n + (r.unwanted as number), 0);
const summary = { at: new Date().toISOString(), mode: MODE, runs: RUNS, settleMs: SETTLE_MS, shown, wanted: `${wanted}/${replays.length}`, unwanted, routerCalls, spendUsd: Number(spendUsd.toFixed(6)), overCap };
writeStoreJson(join(OUT, `a5-${MODE}.json`), { ...summary, replays }, 2);
// PV2 Q2: each captured request is checked as it is written, values in formats Caret never carries withheld (storableRequest).
if (MODE === "capture") writeStoreJson(join(OUT, "a5-router-requests.json"), captured.map(({ request: r, ...at }) => ({ ...at, request: storedRecord(r, (f) => ({ purpose: f.purpose, state: f.state, questions: f.questions, nouls: f.nouls, snippets: f.snippets, charged: f.charged })) })), 2);
console.log(JSON.stringify(summary));
process.exit(0);
