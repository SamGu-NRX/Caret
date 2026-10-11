// How long a newly focused field waits for its first routing decision (brief R3), over the real socket, against the
// host's 600 ms budget (RouteFollower.decisionBudgetMs on v2/routing). The host follows RouteFollower: on focus it sends
// nothing and waits for the first routeDecision naming the field. The user moves between three prose fields in two
// apps, less than two seconds apart, as someone switching between a note and a mail does; each field holds a finished
// sentence, so writing help is legal and Router 1 decides. Measured: from the reader's focus to the first decision
// naming the field, while the user is still in it.
//
// Router questions go to live Jev (spend capped); nothing else is asked.
//
//   node scripts/routing/focus-entry.ts --out DIR [--entries 12] [--gaps 1200,900,400] [--spend-cap 0.003] [--label x]
import { appendStore, appendStoreJson, writeStore, writeStoreJson } from "../../src/privacy/send.ts";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { Helper } from "../../src/helper.ts";
import { HelperServer } from "../../src/server.ts";
import { Store } from "../../src/store.ts";
import { MemoryStore } from "../../src/patterns/memory.ts";
import { loadJevKey, makeJevClient, sealRequest, storedRecord, type AskJev, type JevRequest } from "../../src/fill/jev.ts";
import { PROTOCOL_VERSION, ROUTING_CAPABILITY, type AppRef, type Snapshot } from "../../src/protocol.ts";
import { DEFAULT_SETTINGS } from "../../src/offers/settings.ts";
import { authenticateHost, LineClient } from "../../test/socket-reader.ts";
import { newLaunchSecret } from "../../src/launch.ts";

const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    entries: { type: "string", default: "12" },
    gaps: { type: "string", default: "1200,900,400" },
    "spend-cap": { type: "string", default: "0.003" },
    label: { type: "string", default: "" },
    dump: { type: "boolean", default: false },
    "env-file": { type: "string", default: "/Users/samgu/Programming Projects/Caret/.env" },
  },
});
if (a.out === undefined) throw new Error("--out is required");
const OUT = a.out;
const ENTRIES = Number(a.entries);
const GAPS = (a.gaps ?? "").split(",").map(Number);
const CAP = Number(a["spend-cap"]);
/** RouteFollower.decisionBudgetMs on v2/routing. */
const BUDGET_MS = 600;
const suffix = a.label === "" ? "" : `-${a.label}`;
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

process.env.CARET_ENV_FILE = a["env-file"];
const live = makeJevClient(loadJevKey);
let routerCalls = 0;
let spend = 0;
const askJev: AskJev = async (req: JevRequest) => {
  if (!("outcome" in req.questions || "task" in req.questions || "route" in req.questions)) throw new Error("only router questions are expected here");
  if (spend >= CAP) throw new Error("spend cap");
  routerCalls++;
  // Sealed before it is sent: sent and dumped from this frozen copy (PV2).
  const sent = sealRequest(req);
  const r = await live(sent.asked);
  spend += r.costUsd;
  if (a.dump) appendStoreJson(join(OUT, `router-requests${suffix}.ndjson`), { at: performance.now(), ...storedRecord(sent, (f) => ({ state: f.state, questions: f.questions })), answers: r.answers });
  return r;
};

const NOTES: AppRef = { pid: 4242, bundleId: "dev.caret.notes", name: "Notes Fixture" };
const MAIL: AppRef = { pid: 4343, bundleId: "dev.caret.mail", name: "Mail Fixture" };
interface Place {
  app: AppRef;
  windowId: string;
  title: string;
  key: string;
  text: string;
}
const PLACES: Place[] = [
  { app: NOTES, windowId: "4242-1", title: "Plans", key: "dev.caret.notes/standard/textarea:body~0", text: "Hi Dana, thanks for the notes on the venue. The deposit is due on the twelfth. " },
  { app: MAIL, windowId: "4343-1", title: "Re: catering", key: "dev.caret.mail/standard/textarea:body~0", text: "Dear Marcus, the room has a projector. We still need the budget table. " },
  { app: NOTES, windowId: "4242-2", title: "Ideas", key: "dev.caret.notes/standard/textarea:body~1", text: "Ideas for the offsite agenda. A walk after lunch would help. " },
];
let seq = 0;
const snapshot = (p: Place, focused: boolean): Snapshot => ({
  type: "snapshot",
  v: PROTOCOL_VERSION,
  seq: ++seq,
  at: Date.now(),
  reason: focused ? "focus" : "event",
  app: p.app,
  window: { windowId: p.windowId, kind: "standard", title: p.title, frame: [0, 0, 800, 600] },
  focused,
  root: null,
  nodes: [{ key: p.key, parent: null, role: "AXTextArea", label: "Body", editable: true, value: p.text }],
  values: [],
  focusedKey: p.key,
  stats: { walkMs: 3, visited: 1, truncated: false },
});

const dir = mkdtempSync(join(tmpdir(), "caret-r3-focus-"));
const sock = join(homedir(), ".caret-run", "sockets", `r3-focus-${process.pid}.sock`);
const store = new Store(join(dir, "data"));
const memory = new MemoryStore(join(dir, "data"));
let server: HelperServer | null = null;
const helper = new Helper({
  store,
  memory,
  askJev,
  shadow: false,
  allowBackgroundFocus: false,
  routing: {},
  publish: (m) => server?.publish(m),
  sendToReader: (cmd) => server?.sendToReader(cmd) ?? false,
});
// The host below says host: true, which a helper accepts only with a proof under its launch secret (src/host-auth.ts).
const launchSecret = newLaunchSecret();
server = new HelperServer(sock, () => helper, () => undefined, launchSecret);
await server.listen();
const host = await LineClient.connect(sock);
host.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "r3-focus-host", host: true, capabilities: [ROUTING_CAPABILITY] });
await authenticateHost(host, launchSecret);
host.send({ type: "settings", v: PROTOCOL_VERSION, at: Date.now(), roles: [...DEFAULT_SETTINGS.roles], level: DEFAULT_SETTINGS.level, paused: false });
const reader = await LineClient.connect(sock);
reader.send({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 2, version: "r3-focus-reader" });
await sleep(100);

interface Row {
  entry: number;
  title: string;
  /** Since the previous focus. */
  gapMs: number | null;
  arrivalMs: number | null;
  outcome: string | null;
}
const rows: Row[] = [];
let current: { row: Row; place: Place; t: number } | null = null;
host.onMessage = (m) => {
  const d = m as { type: string; windowId?: string; key?: string | null; outcome?: string | null };
  const c = current;
  if (d.type !== "routeDecision" || c === null || c.row.arrivalMs !== null || d.outcome === null) return;
  if (d.windowId === c.place.windowId && d.key === c.place.key) {
    c.row.arrivalMs = Number((performance.now() - c.t).toFixed(1));
    c.row.outcome = d.outcome ?? null;
  }
};

// The windows exist before the tour starts; the user is in none of them yet.
for (const p of PLACES) reader.send(snapshot(p, false));
await sleep(300);
let app: AppRef | null = null;
for (let i = 0; i < ENTRIES; i++) {
  const p = PLACES[i % PLACES.length] as Place;
  const gap = i === 0 ? null : (GAPS[(i - 1) % GAPS.length] as number);
  if (gap !== null) await sleep(gap);
  const row: Row = { entry: i + 1, title: p.title, gapMs: gap, arrivalMs: null, outcome: null };
  rows.push(row);
  current = { row, place: p, t: performance.now() };
  if (app?.pid !== p.app.pid) reader.send({ type: "appSwitch", v: PROTOCOL_VERSION, at: Date.now(), from: app, to: p.app });
  app = p.app;
  reader.send(snapshot(p, true));
  reader.send({ type: "focus", v: PROTOCOL_VERSION, at: Date.now(), app: p.app, windowId: p.windowId, key: p.key, role: "AXTextArea", editable: true, empty: false, frontmost: true });
}
// The last field: wait for its decision.
for (let k = 0; k < 300 && current !== null && (current as { row: Row }).row.arrivalMs === null; k++) await sleep(10);
await helper.routing?.idle();
const q = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((x, y) => x - y);
  return Number((s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] as number).toFixed(1));
};
// A field left before its decision came is measured as the time the user was in it, a lower bound.
const entry = rows.map((r, i) => r.arrivalMs ?? (i + 1 < rows.length ? (rows[i + 1]?.gapMs as number) : 3000));
const summary = {
  label: a.label,
  entries: rows.length,
  gaps: GAPS,
  entryP50: q(entry, 0.5),
  entryP95: q(entry, 0.95),
  overBudget: entry.filter((x) => x > BUDGET_MS).length,
  noDecisionWhileThere: rows.filter((r) => r.arrivalMs === null).length,
  routerCalls,
  spendUsd: Number(spend.toFixed(6)),
  stats: helper.routing === null ? null : { ...helper.routing.stats, callMs: undefined, entryMs: undefined },
};
const decisions = (helper.routing?.decisions ?? []).map((d) => ({ windowId: d.windowId, breakpoint: d.breakpoint, outcome: d.outcome, by: d.by, failure: d.failure, latencyMs: d.latencyMs, calls: d.calls }));
writeStoreJson(join(OUT, `focus-entry${suffix}.json`), { ...summary, rows, decisions }, 2);
console.log(JSON.stringify(summary));
helper.shutdown();
host.close();
reader.close();
await server.close();
memory.close();
store.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
