// The routing corpus (D2-02): every moment of helper/fixtures/routing/corpus.json, which a writer who never saw the
// router labeled, through a routed Helper with live Jev, scored by outcome and route.
//
//   node scripts/routing/corpus-eval.ts --out DIR [--corpus FILE] [--host-writes on|off] [--ids m01,m02]
//     [--spend-limit USD] [--env-file FILE]
//
// Each moment gets a fresh helper and data directory. Its windows go in as reader snapshots, the window listed second
// first so it is the one the user just left; typed values come from the reader's own detector (detect-values.swift,
// compiled once with apps/screen-reader's TypedValues.swift). Then the user's app comes to the front, the focus arrives,
// and the router decides. A moment with an incoming line gets that line after the first decision, as a new snapshot
// of its conversation, and the last decision is scored. An explicit Ask goes through handlePlanRequest with the
// production Ask maker (writer/config.ts ASK_MAKER) and is scored by the route it logged in Router 2's words.
//
// --host-writes on is the design: a host that takes write decisions. off is today's main.ts, where write is not legal.
// The output holds the corpus's synthetic text and the routers' answers; no key is ever printed.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Helper } from "../../src/helper.ts";
import { Store } from "../../src/store.ts";
import { MemoryStore } from "../../src/patterns/memory.ts";
import { loadJevKey, makeJevClient, type AskJev, type JevRequest } from "../../src/fill/jev.ts";
import { PROTOCOL_VERSION, type AppRef, type Node, type Snapshot, type TypedValue, type ValueKind } from "../../src/protocol.ts";
import type { Decision } from "../../src/routing/coordinator.ts";
import { makeWriterPort } from "../../src/writer/port.ts";
import { ASK_MAKER } from "../../src/writer/config.ts";
import { devWriterRoute } from "../../src/writer/routes.ts";
import { keyLabel } from "../../test/scene.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    corpus: { type: "string", default: join(HERE, "..", "..", "fixtures", "routing", "corpus.json") },
    "host-writes": { type: "string", default: "on" },
    ids: { type: "string" },
    "spend-limit": { type: "string", default: "0.30" },
    "env-file": { type: "string", default: join(homedir(), "Programming Projects", "Caret", ".env") },
    /** Writes every router request and its answer to router-requests.ndjson in --out (synthetic corpus text only). */
    dump: { type: "boolean", default: false },
    /** Seconds between Ask moments: Groq's gpt-oss-120b allows 8,000 tokens a minute and an intent takes about 2,000. */
    "ask-gap-s": { type: "string", default: "30" },
    /**
     * The Ask intent maker: "config" is production's (writer/config.ts ASK_MAKER, Jev since L1), "jev" is B25's Jev maker.
     * A writer maker needs --writer naming its route.
     */
    "ask-maker": { type: "string", default: "config" },
    /** L1: the code-mode and intent writer's route, "groq:<model>" or "gateway:<model>"; none by default, as in the helper. */
    writer: { type: "string" },
    /** The helper runs on the wall clock, so a decision's latency includes its router calls (route entry). */
    "real-clock": { type: "boolean", default: false },
  },
});
if (a.out === undefined) throw new Error("--out is required");
const OUT = a.out;
mkdirSync(OUT, { recursive: true });
process.env.CARET_ENV_FILE ??= a["env-file"];
const hostWrites = a["host-writes"] === "on";
const SPEND_LIMIT = Number(a["spend-limit"]);

interface CNode {
  id: string;
  role: "text" | "field" | "button" | "link";
  text?: string;
  label?: string;
  value?: string;
  placeholder?: string;
  multiline?: boolean;
  secure?: boolean;
}
interface CWindow {
  id: string;
  app: string;
  bundleId: string;
  title: string;
  conversation?: boolean;
  nodes: CNode[];
}
interface Moment {
  id: string;
  category: string;
  describe: string;
  settings?: { paused?: boolean };
  windows: CWindow[];
  frontmost: string;
  focus: { window: string; node: string } | null;
  typed: string | null;
  incoming: { window: string; node: string } | null;
  ime?: boolean;
  ask: string | null;
  memory?: { label: string; value: string }[];
  expected: { outcome: string; route: string | null };
}
const corpus = JSON.parse(readFileSync(a.corpus, "utf8")) as { moments: Moment[] };
const only = a.ids === undefined ? null : new Set(a.ids.split(","));
const moments = corpus.moments.filter((m) => only === null || only.has(m.id));

// The reader's detector, compiled once.
const detectBin = join(tmpdir(), "caret-detect-values");
if (!existsSync(detectBin)) {
  const r = join(REPO, "apps", "screen-reader", "Sources", "CaretScreenCore");
  execFileSync("/usr/bin/lockf", ["-k", join(homedir(), ".caret-run", "locks", "build.lock"), "swiftc", "-O", "-parse-as-library", "-o", detectBin, join(r, "TypedValues.swift"), join(HERE, "detect-values.swift")], { stdio: "inherit" });
}
const allTexts = [...new Set(moments.flatMap((m) => m.windows.flatMap((w) => w.nodes.flatMap((n) => [n.text, n.label, n.value].filter((t): t is string => t !== undefined && t !== "")))))];
const detected = JSON.parse(execFileSync(detectBin, { input: JSON.stringify(allTexts), maxBuffer: 1 << 26 }).toString()) as { kind: ValueKind; text: string }[][];
const valuesOf = new Map(allTexts.map((t, i) => [t, detected[i] ?? []]));

// Live Jev, counted by question type, under the spend limit.
const jevClient = makeJevClient(loadJevKey);
const spend = { usd: 0, calls: { router1: 0, router2: 0, producer: 0 }, routerMs: [] as number[], routerTokens: [] as number[], producerTokens: [] as number[] };
const askJev: AskJev = async (req: JevRequest) => {
  if (spend.usd >= SPEND_LIMIT) throw new Error(`spend limit $${SPEND_LIMIT} reached`);
  // The routers send without retry (judge.ts); B25's Jev intent maker also names a question "route", so the flag tells them apart.
  const router = req.retry429 === false;
  const which = router && ("outcome" in req.questions || "task" in req.questions) ? "router1" : router && "route" in req.questions ? "router2" : "producer";
  const r = await jevClient(req);
  if (a.dump && which !== "producer") appendFileSync(join(OUT, "router-requests.ndjson"), `${JSON.stringify({ moment: current, which, state: req.state, questions: req.questions, answers: r.answers })}\n`);
  spend.usd += r.costUsd;
  spend.calls[which]++;
  if (which === "producer") spend.producerTokens.push(r.inputTokens);
  else {
    spend.routerMs.push(r.latencyMs);
    spend.routerTokens.push(r.inputTokens);
  }
  return r;
};

class Clock {
  at = Date.parse("2026-10-05T10:00:00-05:00");
  private readonly due: { at: number; fn: () => void; live: boolean }[] = [];
  readonly setTimer = (fn: () => void, ms: number): (() => void) => {
    const t = { at: this.at + ms, fn, live: true };
    this.due.push(t);
    return () => {
      t.live = false;
    };
  };
  advance(ms: number): void {
    const end = this.at + ms;
    for (;;) {
      const next = this.due.filter((t) => t.live && t.at <= end).sort((x, y) => x.at - y.at)[0];
      if (next === undefined) break;
      this.at = Math.max(this.at, next.at);
      next.live = false;
      next.fn();
    }
    this.at = end;
  }
}

const ROLE: Record<CNode["role"], string> = { text: "AXStaticText", field: "AXTextField", button: "AXButton", link: "AXLink" };

function buildWindow(w: CWindow, app: AppRef, windowId: string, at: number, focusedKey: string | null, skip: string | null): { snap: Snapshot; keys: Map<string, string> } {
  const keys = new Map<string, string>();
  const ordinals = new Map<string, number>();
  const nodes: Node[] = [];
  const values: TypedValue[] = [];
  w.nodes.forEach((n, i) => {
    const role = n.role === "field" ? (n.secure === true ? "AXSecureTextField" : n.multiline === true ? "AXTextArea" : "AXTextField") : ROLE[n.role];
    const name = keyLabel(n.label ?? n.text ?? n.id);
    const base = `${w.bundleId}/standard/${role.slice(2).toLowerCase()}:${name}`;
    const ord = ordinals.get(base) ?? 0;
    ordinals.set(base, ord + 1);
    const key = `${base}~${ord}`;
    keys.set(n.id, key);
    if (n.id === skip) return;
    const node: Node = { key, parent: null, role, frame: [100, 40 + 32 * i, 420, n.multiline === true ? 120 : 24] };
    if (n.role === "text") node.label = n.text ?? "";
    else if (n.label !== undefined) node.label = n.label;
    if (n.role === "field") {
      node.editable = true;
      if (n.secure === true) node.states = ["secure"];
      else if ((n.value ?? "") !== "") node.value = n.value;
      if (n.placeholder !== undefined) node.placeholder = n.placeholder;
    }
    nodes.push(node);
    if (n.secure === true) return;
    for (const t of n.role === "field" ? [n.value] : [n.text, n.label]) for (const v of t === undefined ? [] : (valuesOf.get(t) ?? [])) values.push({ kind: v.kind, text: v.text, nodeKey: key });
  });
  return {
    snap: { type: "snapshot", v: PROTOCOL_VERSION, seq: 0, at, reason: "focus", app, window: { windowId, kind: "standard", title: w.title, frame: [0, 0, 1200, 900] }, focused: true, root: null, nodes, values, focusedKey, stats: { walkMs: 5, visited: nodes.length, truncated: false } },
    keys,
  };
}

/** The route a decision chose, in the corpus's words. */
function routeOf(d: Decision | undefined): string | null {
  if (d === undefined || d.route === null) return null;
  if (d.outcome === "ask") return null;
  if (d.route.startsWith("handoff")) return "handoff";
  if (d.route.startsWith("workflow:")) return d.route.slice("workflow:".length);
  return d.route;
}

interface Row {
  id: string;
  category: string;
  expected: { outcome: string; route: string | null };
  got: { outcome: string; route: string | null };
  by: string;
  local: string | null;
  refused: string | null;
  confidence: number | null;
  /** Router 1's (or 2's) answer as given, refused or not. */
  answered: string | null;
  decisions: number;
  routerCalls: number;
  latencyMs: number | null;
  offered: string[];
  /** Routes of tasks Router 1 chose beside the published decision (R3), as "act/<route>". */
  beside: string[];
  note: string | null;
}
const rows: Row[] = [];
/** The moment being run, for the request dump. */
let current = "";
let lastAskAt = 0;

for (const m of moments) {
  if (spend.usd >= SPEND_LIMIT) {
    process.stdout.write(`spend limit reached before ${m.id}\n`);
    break;
  }
  current = m.id;
  const dir = mkdtempSync(join(tmpdir(), "caret-routing-corpus-"));
  const store = new Store(join(dir, "data"));
  const tally: Record<string, number> = {};
  const count = store.count.bind(store);
  store.count = (metric: string, n = 1, at = Date.now()) => {
    tally[metric] = (tally[metric] ?? 0) + n;
    count(metric, n, at);
  };
  const memory = new MemoryStore(join(dir, "data"));
  const clock = new Clock();
  const published: string[] = [];
  const decisions: Decision[] = [];
  const routerBefore = spend.calls.router1 + spend.calls.router2;
  let note: string | null = null;
  const helper = new Helper({
    store,
    memory,
    askJev,
    shadow: false,
    allowBackgroundFocus: false,
    publish: (msg) => {
      if (msg.type === "popup" || msg.type === "action" || msg.type === "fillProposal" || msg.type === "patternOffer" || msg.type === "alternatives") published.push(msg.type === "action" ? `action:${msg.app}` : msg.type);
    },
    now: a["real-clock"] ? Date.now : () => clock.at,
    routing: { ...(a["real-clock"] ? {} : { setTimer: clock.setTimer }), hostWrites: () => hostWrites, onDecision: (d) => decisions.push(d) },
    readerLink: { run: async () => ({ type: "verbResult", v: PROTOCOL_VERSION, id: "x", at: clock.at, outcome: "ok", detail: null }) },
    ask: ASK_MAKER === "jev" || a["ask-maker"] === "jev" ? { maker: "jev" } : { maker: "writer", writer: makeWriterPort(devWriterRoute(a.writer ?? "(no --writer)")) },
    writer: a["ask-maker"] === "jev" || a.writer === undefined ? null : makeWriterPort(devWriterRoute(a.writer)),
    warn: () => undefined,
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setImmediate(r));
      await helper.routing?.idle();
      await helper.routedSettled;
      await helper.eventsSettled;
    }
  };
  try {
    if (m.settings?.paused === true) helper.handleSettings({ type: "settings", v: PROTOCOL_VERSION, at: clock.at, roles: ["fill", "repeat", "watch", "calendar", "words"], level: "balanced", paused: true });
    for (const e of m.memory ?? []) helper.handleMemory({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: `mem-${e.label}`, op: "add", kind: "about", fields: { label: e.label, value: e.value, source: "typed" } });
    const pids = new Map<string, number>();
    const apps = new Map<string, AppRef>();
    const ids = new Map<string, string>();
    m.windows.forEach((w, i) => {
      if (!pids.has(w.bundleId)) pids.set(w.bundleId, 5000 + pids.size);
      const pid = pids.get(w.bundleId) as number;
      apps.set(w.id, { pid, bundleId: w.bundleId, name: w.app });
      ids.set(w.id, `${pid}-${i + 1}`);
    });
    const keys = new Map<string, Map<string, string>>();
    // The frontmost window last, the one listed after it just before: the user just left that one.
    const order = [...m.windows.filter((w) => w.id !== m.frontmost).reverse(), ...m.windows.filter((w) => w.id === m.frontmost)];
    for (const w of order) {
      clock.advance(1000);
      const focusedKey = m.focus !== null && m.focus.window === w.id ? `@${m.focus.node}` : null;
      const skip = m.incoming !== null && m.incoming.window === w.id ? m.incoming.node : null;
      const built = buildWindow(w, apps.get(w.id) as AppRef, ids.get(w.id) as string, clock.at, null, skip);
      if (focusedKey !== null) built.snap.focusedKey = built.keys.get(m.focus?.node ?? "") ?? null;
      keys.set(w.id, built.keys);
      void helper.handleReader(built.snap);
    }
    const front = apps.get(m.frontmost) as AppRef;
    clock.advance(200);
    void helper.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: clock.at, from: null, to: front });
    const fw = m.windows.find((w) => w.id === m.frontmost) as CWindow;
    const fnode = m.focus === null ? undefined : m.windows.find((w) => w.id === m.focus?.window)?.nodes.find((n) => n.id === m.focus?.node);
    const fkey = m.focus === null ? null : (keys.get(m.focus.window)?.get(m.focus.node) ?? null);
    if (m.ime === true && fkey !== null) helper.routing?.hostEditing({ windowId: ids.get(fw.id) as string, key: fkey, selection: "caret", composing: true });
    clock.advance(100);
    void helper.handleReader({
      type: "focus",
      v: PROTOCOL_VERSION,
      at: clock.at,
      app: front,
      windowId: ids.get(m.focus?.window ?? fw.id) as string,
      key: fkey,
      role: fnode === undefined ? "AXGroup" : fnode.role === "field" ? (fnode.secure === true ? "AXSecureTextField" : fnode.multiline === true ? "AXTextArea" : "AXTextField") : ROLE[fnode.role],
      editable: fnode?.role === "field",
      empty: (fnode?.value ?? "") === "",
      frontmost: true,
    });
    await settle();
    if (m.incoming !== null) {
      clock.advance(2500);
      const w = m.windows.find((x) => x.id === m.incoming?.window) as CWindow;
      const built = buildWindow(w, apps.get(w.id) as AppRef, ids.get(w.id) as string, clock.at, null, null);
      built.snap.focused = false;
      built.snap.reason = "event";
      void helper.handleReader(built.snap);
      await settle();
      clock.advance(2500);
      await settle();
    }
    let got: Row["got"];
    let by = "";
    let d: Decision | undefined;
    if (m.ask !== null) {
      clock.advance(2500);
      const gap = Number(a["ask-gap-s"]) * 1000 - (Date.now() - lastAskAt);
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      lastAskAt = Date.now();
      const reply = await helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: m.id, at: clock.at, instruction: m.ask, windowId: ids.get(m.frontmost) as string });
      const routed = Object.keys(tally).find((k) => k.startsWith("route.ask_"));
      const kind = routed?.slice("route.ask_".length) ?? null;
      got = kind === null ? { outcome: "act", route: "handoff" } : kind === "ask" ? { outcome: "ask", route: null } : { outcome: "act", route: kind };
      by = "ask";
      const err = (reply as { error?: { code: string } | null }).error ?? null;
      const detail = (reply as { error?: { detail?: string } | null }).error?.detail ?? "";
      note = kind === null ? `no intent; planner error ${err?.code ?? "?"}: ${detail.replace(/org_[A-Za-z0-9]+/g, "org_X").slice(0, 400)}` : err === null ? null : `error ${err.code}`;
    } else {
      // The context's own decision: a consented offer or a task checked beside a kept write session is not one (R2).
      d = decisions.filter((x) => x.published).at(-1);
      got = { outcome: d?.outcome ?? "none", route: routeOf(d) };
      by = d?.by ?? "none";
    }
    rows.push({
      id: m.id,
      category: m.category,
      expected: m.expected,
      got,
      by,
      local: d?.local ?? null,
      refused: d?.refused === null || d?.refused === undefined ? null : `router${d.refused.router}:${d.refused.why}`,
      confidence: d?.confidence ?? null,
      answered: d?.answered ?? null,
      decisions: decisions.length,
      routerCalls: spend.calls.router1 + spend.calls.router2 - routerBefore,
      latencyMs: d === undefined ? null : d.latencyMs,
      offered: published,
      beside: decisions.filter((x) => !x.published && x.by !== "consent" && x.outcome === "act").map((x) => `act/${routeOf(x) ?? "?"}`),
      note,
    });
    const r = rows.at(-1) as Row;
    const ok = r.got.outcome === r.expected.outcome && (r.expected.outcome !== "act" || r.got.route === r.expected.route);
    process.stdout.write(`${ok ? "ok  " : "MISS"} ${m.id} ${m.category} expected ${m.expected.outcome}${m.expected.route === null ? "" : `/${m.expected.route}`} got ${r.got.outcome}${r.got.route === null ? "" : `/${r.got.route}`}${r.beside.length === 0 ? "" : ` beside ${r.beside.join(",")}`} (${r.by}${r.local === null ? "" : `:${r.local}`}${r.refused === null ? "" : ` ${r.refused}`}) $${spend.usd.toFixed(4)}\n`);
  } catch (e) {
    process.stdout.write(`ERROR ${m.id}: ${e instanceof Error ? e.message : String(e)}\n`);
  } finally {
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// Precision and recall per outcome; route accuracy where both said act.
const OUTCOMES = ["abstain", "write", "ask", "act"];
const per = OUTCOMES.map((o) => {
  const tp = rows.filter((r) => r.got.outcome === o && r.expected.outcome === o).length;
  const said = rows.filter((r) => r.got.outcome === o).length;
  const truth = rows.filter((r) => r.expected.outcome === o).length;
  return { outcome: o, tp, said, truth, precision: said === 0 ? null : tp / said, recall: truth === 0 ? null : tp / truth };
});
const actWrong = rows.filter((r) => r.got.outcome === "act" && r.expected.outcome !== "act");
// A task offered beside the published decision is an act too, behind Tab like every other (R3).
const besideWrong = rows.filter((r) => r.beside.length > 0 && r.expected.outcome !== "act");
const besideRight = rows.filter((r) => r.expected.outcome === "act" && r.got.outcome !== "act" && r.beside.includes(`act/${r.expected.route}`));
const bothAct = rows.filter((r) => r.got.outcome === "act" && r.expected.outcome === "act");
const routeRight = bothAct.filter((r) => r.got.route === r.expected.route).length;
const exact = rows.filter((r) => r.got.outcome === r.expected.outcome && (r.expected.outcome !== "act" || r.got.route === r.expected.route)).length;
const pct = (x: number | null): string => (x === null ? "n/a" : `${(100 * x).toFixed(0)}%`);
const q = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
};
const confusion = OUTCOMES.map((e) => [e, ...OUTCOMES.map((g) => rows.filter((r) => r.expected.outcome === e && r.got.outcome === g).length), rows.filter((r) => r.expected.outcome === e && !OUTCOMES.includes(r.got.outcome)).length]);
// What Router 1 would have decided at other floors, from its recorded answers (outcome only; Router 2 was not asked
// where Router 1 was refused, so routes are not scored here).
const FLOORS = [0.75, 0.5, 0.25, 0];
const curve = FLOORS.map((f) => {
  const got = rows.map((r) => {
    if (r.by !== "router1" && r.by !== "router2" && r.by !== "single") return r.got.outcome;
    if (r.by === "router1" && r.answered !== null && OUTCOMES.includes(r.answered) && (r.confidence ?? 0) >= f) return r.answered;
    if (r.by === "router1") return "abstain";
    return r.got.outcome;
  });
  const stat = OUTCOMES.map((o) => {
    const tp = rows.filter((r, i) => got[i] === o && r.expected.outcome === o).length;
    const said = got.filter((g) => g === o).length;
    const truth = rows.filter((r) => r.expected.outcome === o).length;
    return `${o} ${pct(said === 0 ? null : tp / said)}/${pct(truth === 0 ? null : tp / truth)}`;
  });
  const wrongAct = rows.filter((r, i) => got[i] === "act" && r.expected.outcome !== "act").length;
  const right = rows.filter((r, i) => got[i] === r.expected.outcome).length;
  return `| ${f} | ${right}/${rows.length} | ${stat.join(" | ")} | ${wrongAct} |`;
});
const md = [
  `# Routing corpus, host writes ${hostWrites ? "on" : "off"}, Ask maker ${a["ask-maker"] === "jev" ? "jev (no Groq)" : ASK_MAKER}`,
  "",
  `${rows.length} moments of ${corpus.moments.length}; exact (outcome, and route for act) ${exact}/${rows.length}. Jev spend $${spend.usd.toFixed(4)}: Router 1 ${spend.calls.router1} calls, Router 2 ${spend.calls.router2}, producers ${spend.calls.producer}.`,
  `Acted when it should not have: ${actWrong.length}${actWrong.length === 0 ? "" : ` (${actWrong.map((r) => `${r.id} expected ${r.expected.outcome}`).join(", ")})`}. Route right where both said act: ${routeRight}/${bothAct.length}.`,
  `Tasks offered beside the published decision: ${rows.filter((r) => r.beside.length > 0).length}; where act was expected and the published decision was not act, the expected route beside it: ${besideRight.length}${besideRight.length === 0 ? "" : ` (${besideRight.map((r) => r.id).join(", ")})`}; beside where act was not expected: ${besideWrong.length}${besideWrong.length === 0 ? "" : ` (${besideWrong.map((r) => `${r.id} expected ${r.expected.outcome}`).join(", ")})`}.`,
  `Router call latency ms p50 ${q(spend.routerMs, 0.5)?.toFixed(0)}, p95 ${q(spend.routerMs, 0.95)?.toFixed(0)}; route entry (breakpoint to decision) for router-decided moments p50 ${q(rows.flatMap((r) => (r.by === "router1" || r.by === "router2" || r.by === "single") && r.latencyMs !== null ? [r.latencyMs] : []), 0.5)}, p95 ${q(rows.flatMap((r) => (r.by === "router1" || r.by === "router2" || r.by === "single") && r.latencyMs !== null ? [r.latencyMs] : []), 0.95)}, for local decisions p50 ${q(rows.flatMap((r) => r.by === "local" && r.latencyMs !== null ? [r.latencyMs] : []), 0.5)}, p95 ${q(rows.flatMap((r) => r.by === "local" && r.latencyMs !== null ? [r.latencyMs] : []), 0.95)}${a["real-clock"] ? " (wall clock)" : " (the eval's fake clock, which does not advance during calls: see the call latency)"}. Router input tokens mean ${(spend.routerTokens.reduce((x, y) => x + y, 0) / Math.max(1, spend.routerTokens.length)).toFixed(0)}.`,
  "",
  "| Outcome | Said | Truth | Right | Precision | Recall |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
  ...per.map((p) => `| ${p.outcome} | ${p.said} | ${p.truth} | ${p.tp} | ${pct(p.precision)} | ${pct(p.recall)} |`),
  "",
  "Router 1's floor, from the answers it gave (outcome right; then precision/recall per outcome; acts that should not have been):",
  "",
  `| Floor | Outcome right | ${OUTCOMES.join(" | ")} | Wrong acts |`,
  `| ---: | ---: | ${OUTCOMES.map(() => "---").join(" | ")} | ---: |`,
  ...curve,
  "",
  "Confusion (rows expected, columns got):",
  "",
  `| expected \\ got | ${OUTCOMES.join(" | ")} | other |`,
  `| --- | ${OUTCOMES.map(() => "---:").join(" | ")} | ---: |`,
  ...confusion.map((c) => `| ${c.join(" | ")} |`),
  "",
  "| Moment | Category | Expected | Got | Beside | By | Local / refused | Answered | Conf | Router calls | Offered | Note |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | --- | --- |",
  ...rows.map((r) => `| ${r.id} | ${r.category} | ${r.expected.outcome}${r.expected.route === null ? "" : `/${r.expected.route}`} | ${r.got.outcome}${r.got.route === null ? "" : `/${r.got.route}`} | ${r.beside.join(", ")} | ${r.by} | ${r.local ?? r.refused ?? ""} | ${r.answered ?? ""} | ${r.confidence?.toFixed(2) ?? ""} | ${r.routerCalls} | ${r.offered.join(", ")} | ${r.note ?? ""} |`),
  "",
];
const stem = `corpus-${hostWrites ? "on" : "off"}${a["ask-maker"] === "jev" ? "-askjev" : ""}${a["real-clock"] ? "-clock" : ""}`;
writeFileSync(join(OUT, `${stem}.md`), md.join("\n"));
writeFileSync(join(OUT, `${stem}.json`), `${JSON.stringify({ hostWrites, spend, per, rows }, null, 2)}\n`);
process.stdout.write(`${md.slice(0, 4).join("\n")}\n`);
