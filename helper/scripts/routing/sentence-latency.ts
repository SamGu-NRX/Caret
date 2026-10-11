// How long the host's writing help waits on routing at a sentence end (brief R2, "Sentence-end latency"), in a scripted
// session over the real socket. A host connects with routing, the reader shows a notes document, and the session types
// sentences into its body. The host follows H6's RouteFollower (v2/routing): on focus it sends nothing and waits for the
// first routeDecision naming the field, which binds it; while the selection is a plain caret it sends no context after
// binding, so its first routingContext comes at the first sentence end. At each sentence end it sends routingContext
// (breakpoint "sentence", a new text revision), then the reader's walk follows. The host's ghost text waits for the
// first routeDecision naming that revision, at most RouteFollower.decisionBudgetMs (600 ms), after which it shows
// anyway; with routing off it never waits (gate .off). Measured: time from the host's routingContext to that decision,
// and from the reader's focus to the field's first decision.
//
// Router questions go to live Jev (spend capped); others are stubs. Some sentences name a person and a time, so the
// event card is a task beside the writing; the event card's own attend asks answer yes, so a card is shown exactly when
// the router chose it. The ghost model itself is the host's and is not run here.
//
//   node scripts/routing/sentence-latency.ts --out DIR [--mode on|off] [--key-ms 60] [--spend-cap 0.005] [--label x] [--dump]
//
// --dump writes every router request and its answer to router-requests[-label].ndjson in --out (the script's own text).
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
import { FakeCalendar } from "../../src/executor/means.ts";
import { loadJevKey, makeJevClient, sealRequest, storedRecord, type AskJev, type JevRequest } from "../../src/fill/jev.ts";
import { PROTOCOL_VERSION, ROUTING_CAPABILITY, type AppRef, type Node, type Snapshot, type TypedValue } from "../../src/protocol.ts";
import { DEFAULT_SETTINGS } from "../../src/offers/settings.ts";
import { authenticateHost, LineClient } from "../../test/socket-reader.ts";
import { newLaunchSecret } from "../../src/launch.ts";

const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    mode: { type: "string", default: "on" },
    "key-ms": { type: "string", default: "60" },
    "spend-cap": { type: "string", default: "0.005" },
    label: { type: "string", default: "" },
    "env-file": { type: "string", default: "/Users/samgu/Programming Projects/Caret/.env" },
    dump: { type: "boolean", default: false },
  },
});
if (a.out === undefined) throw new Error("--out is required");
const ON = a.mode === "on";
const KEY_MS = Number(a["key-ms"]);
const CAP = Number(a["spend-cap"]);
/** RouteFollower.decisionBudgetMs on v2/routing: the host's longest wait for a decision after a breakpoint. */
const BUDGET_MS = 600;
mkdirSync(a.out, { recursive: true });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SENTENCES: { text: string; when?: string }[] = [
  { text: "Thanks for the notes on the venue." },
  { text: "The deposit is due on the twelfth, so we should confirm the head count before then." },
  { text: "Lunch with Priya tomorrow at noon.", when: "tomorrow at noon" },
  { text: "I think the review can move to the afternoon if Dana agrees." },
  { text: "Let me know what works for the catering order." },
  { text: "I will send the final list once everyone has answered." },
  { text: "Call with Dana on Friday at 3pm.", when: "Friday at 3pm" },
  { text: "The slides still need the budget table." },
  { text: "Marcus asked whether the room has a projector." },
  { text: "If not, we can borrow the one from the third floor." },
  { text: "Please keep an eye on the parking passes." },
  { text: "That is everything for now." },
];

process.env.CARET_ENV_FILE = a["env-file"];
const live = makeJevClient(loadJevKey);
let routerCalls = 0;
let spend = 0;
const isRouter = (r: JevRequest): boolean => "outcome" in r.questions || "task" in r.questions || "route" in r.questions;
const askJev: AskJev = async (req) => {
  if (isRouter(req)) {
    if (spend >= CAP) throw new Error("spend cap");
    routerCalls++;
    // Sealed before it is sent: sent and dumped from this frozen copy (PV2).
    const sent = sealRequest(req);
    const r = await live(sent.asked);
    spend += r.costUsd;
    if (a.dump) appendStoreJson(join(a.out as string, `router-requests${a.label === "" ? "" : `-${a.label}`}.ndjson`), { at: performance.now(), ...storedRecord(sent, (f) => ({ state: f.state, questions: f.questions })), answers: r.answers });
    return r;
  }
  // The event card's own questions: attend yes. Anything else: the first option.
  const answers = Object.fromEntries(Object.keys(req.questions).map((k) => [k, { choice: k === "attend" ? "yes" : Object.keys((req.questions[k] as { criteria?: object }).criteria ?? { none: 1 })[0] ?? "none", confidence: 0.9 }]));
  return { model: "stub", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
};

const NOTES: AppRef = { pid: 4242, bundleId: "dev.caret.notes", name: "Notes Fixture" };
const WIN = "4242-1";
const BODY = "dev.caret.notes/standard/textarea:body~0";
let seq = 0;
const snapshot = (value: string, values: TypedValue[], at: number): Snapshot => {
  const nodes: Node[] = [{ key: BODY, parent: null, role: "AXTextArea", label: "Body", editable: true, ...(value === "" ? {} : { value }) }];
  return { type: "snapshot", v: PROTOCOL_VERSION, seq: ++seq, at, reason: "event", app: NOTES, window: { windowId: WIN, kind: "standard", title: "Plans", frame: [0, 0, 800, 600] }, focused: true, root: null, nodes, values, focusedKey: BODY, stats: { walkMs: 3, visited: 1, truncated: false } };
};

const dir = mkdtempSync(join(tmpdir(), "caret-r2-latency-"));
const sock = join(homedir(), ".caret-run", "sockets", `r2-lat-${process.pid}.sock`);
const store = new Store(join(dir, "data"));
const memory = new MemoryStore(join(dir, "data"));
let server: HelperServer | null = null;
const helper = new Helper({
  store,
  memory,
  askJev,
  shadow: false,
  allowBackgroundFocus: false,
  calendar: new FakeCalendar(),
  routing: ON ? {} : null,
  publish: (m) => server?.publish(m),
  sendToReader: (cmd) => server?.sendToReader(cmd) ?? false,
});
// The host below says host: true, which a helper accepts only with a proof under its launch secret (src/host-auth.ts).
const launchSecret = newLaunchSecret();
server = new HelperServer(sock, () => helper, () => undefined, launchSecret);
await server.listen();
const host = await LineClient.connect(sock);
host.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "r2-latency-host", host: true, capabilities: [ROUTING_CAPABILITY] });
await authenticateHost(host, launchSecret);
host.send({ type: "settings", v: PROTOCOL_VERSION, at: Date.now(), roles: [...DEFAULT_SETTINGS.roles], level: DEFAULT_SETTINGS.level, paused: false });
const reader = await LineClient.connect(sock);
reader.send({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 2, version: "r2-latency-reader" });
await sleep(100);

/** routeDecision arrival times by text revision (performance.now()), first one only; and the first naming the body. */
const arrived = new Map<string, { at: number; outcome: string | null }>();
let bound: { at: number; outcome: string | null } | null = null;
/** Calendar offers by the sentence each quotes (its end state's source), first arrival only. */
const calendar = new Map<string, number>();
host.onMessage = (m) => {
  const d = m as { type: string; textRevision?: string; outcome?: string | null; windowId?: string; key?: string | null; app?: string; endState?: { ref?: { derived?: { quote?: string }[] } } };
  if (d.type === "routeDecision" && d.textRevision !== undefined && !arrived.has(d.textRevision)) arrived.set(d.textRevision, { at: performance.now(), outcome: d.outcome ?? null });
  if (d.type === "routeDecision" && bound === null && d.windowId === WIN && d.key === BODY && d.outcome !== null) bound = { at: performance.now(), outcome: d.outcome ?? null };
  const quote = d.endState?.ref?.derived?.[0]?.quote;
  if (d.type === "action" && d.app === "Calendar" && quote !== undefined && !calendar.has(quote)) calendar.set(quote, performance.now());
};

void helper.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: Date.now(), from: null, to: NOTES });
let text = "Hi Dana, ";
const t0 = performance.now();
reader.send(snapshot(text, [], Date.now()));
reader.send({ type: "focus", v: PROTOCOL_VERSION, at: Date.now(), app: NOTES, windowId: WIN, key: BODY, role: "AXTextArea", editable: true, empty: false, frontmost: true });
let rev = 0;
const revision = (): string => `r${++rev}`;
for (let i = 0; ON && i < 300 && bound === null; i++) await sleep(20);
const focusDecision = bound as { at: number; outcome: string | null } | null;
const rows: { sentence: number; event: boolean; arrivalMs: number | null; waitMs: number; outcome: string | null; calendarMs: number | null }[] = [];
/** When each sentence's routingContext was sent. */
const sentAt = new Map<string, number>();
/** The reader's typed values, as its detector would report them in the same walk as the text that holds them. */
const valuesIn = (t: string): TypedValue[] => SENTENCES.flatMap((s) => (s.when !== undefined && t.includes(s.when) ? [{ kind: "date" as const, text: s.when, nodeKey: BODY }] : []));
for (const [i, s] of SENTENCES.entries()) {
  for (const ch of s.text) {
    text += ch;
    reader.send(snapshot(text, valuesIn(text), Date.now()));
    await sleep(KEY_MS);
  }
  text += " ";
  const r = revision();
  const sent = performance.now();
  host.send({ type: "routingContext", v: PROTOCOL_VERSION, at: Date.now(), windowId: WIN, key: BODY, selection: "caret", composing: false, textRevision: r, breakpoint: "sentence" });
  await sleep(30);
  reader.send(snapshot(text, valuesIn(text), Date.now()));
  for (let k = 0; k < 150 && !arrived.has(r); k++) await sleep(10);
  const got = arrived.get(r);
  const arrivalMs = got === undefined ? null : got.at - sent;
  rows.push({ sentence: i + 1, event: s.when !== undefined, arrivalMs: arrivalMs === null ? null : Number(arrivalMs.toFixed(2)), waitMs: ON ? Number(Math.min(arrivalMs ?? BUDGET_MS, BUDGET_MS).toFixed(2)) : 0, outcome: got?.outcome ?? null, calendarMs: null });
  sentAt.set(s.text, sent);
  await sleep(KEY_MS * 3);
}
// Each card is matched to the sentence it quotes, timed from that sentence's routingContext.
await sleep(4000);
for (const [i, s] of SENTENCES.entries()) {
  const at = calendar.get(s.text);
  const row = rows[i];
  if (at !== undefined && row !== undefined) row.calendarMs = Number((at - (sentAt.get(s.text) as number)).toFixed(1));
}
await helper.routing?.idle();
await helper.routedSettled;
const q = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((x, y) => x - y);
  return Number((s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] as number).toFixed(2));
};
const waits = rows.map((r) => r.waitMs);
const arrivals = rows.flatMap((r) => (r.arrivalMs === null ? [] : [r.arrivalMs]));
const decisions = (helper.routing?.decisions ?? []).map((d) => ({ breakpoint: d.breakpoint, outcome: d.outcome, by: d.by, published: d.published, route: d.route, latencyMs: d.latencyMs, calls: d.calls, confidence: d.confidence, answered: d.answered }));
const summary = {
  label: a.label,
  mode: a.mode,
  keyMs: KEY_MS,
  sentences: rows.length,
  focusDecision: focusDecision === null ? null : { ms: Number((focusDecision.at - t0).toFixed(1)), outcome: focusDecision.outcome },
  waitP50: q(waits, 0.5),
  waitP95: q(waits, 0.95),
  arrivalP50: q(arrivals, 0.5),
  arrivalP95: q(arrivals, 0.95),
  noDecision: rows.filter((r) => r.arrivalMs === null).length,
  overBudget: rows.filter((r) => (r.arrivalMs ?? Infinity) > BUDGET_MS).length,
  outcomes: rows.map((r) => r.outcome),
  routerCalls,
  spendUsd: Number(spend.toFixed(6)),
  stats: helper.routing === null ? null : { ...helper.routing.stats, callMs: undefined, entryMs: undefined },
  calendarOffers: calendar.size,
  eventCards: rows.filter((r) => r.event).map((r) => ({ sentence: r.sentence, calendarMs: r.calendarMs })),
};
writeStoreJson(join(a.out, `latency-${a.mode}${a.label === "" ? "" : `-${a.label}`}.json`), { ...summary, rows, decisions }, 2);
console.log(JSON.stringify(summary));
helper.shutdown();
host.close();
reader.close();
await server.close();
memory.close();
store.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
