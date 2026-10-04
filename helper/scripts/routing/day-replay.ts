// The real-day replay for the routers (D2-02): Sam's two shadow-logged days, before and after routing. Read only;
// counts, hashes and timings only.
//
//   node scripts/routing/day-replay.ts --data-dir DIR --corpus-json FILE --out FILE.md [--json FILE]
//     [--start TIME] [--end TIME] [--pmset-log FILE]
//
// What the store holds decides what this can say. It keeps no screen text, so no router or fill question can be asked
// again about a real moment. It keeps, with times: every field entry of 6 or more characters (a shadow episode), with
// whether the value was on screen in another window first (findable), and every transfer (a value that appeared in one
// window and was then entered in another), with its source and destination app; and, per day, the count of focuses
// in editable fields. So:
//   - Moments are human-active field focuses. Their number is the day's editable-focus count scaled by the share of
//     that day's entries made while a person was at the keyboard (pmset spans), since focuses have no times.
//   - A useful moment is a focus whose entry was findable: the value the user then entered was on screen in another
//     window first (the opportunity report's measure), which is what a fill offer at that focus could have given.
//     Transfers grouped into form fills (one destination, each under 120 s after the last) are reported beside it.
//   - Before (producers on their own): fill asks Jev at every empty editable focus, CALLS_PER_FILL calls each. Whether a
//     fill grounds a value at a moment that is not useful cannot be known from hashes, so offers before are a range:
//     at least the useful moments, at most every focus, and the gate's 4 an hour (Balanced) caps both. The time-ordered
//     gate decides which useful moments still get an offer when the hour's budget was spent on others.
//   - After (routed, as main.ts runs it: no host takes write decisions): every focus where fill is a candidate is one
//     Router 1 context. How often Router 1 says act at a useful moment and at one that is not comes from the held-out
//     half of the routing corpus (the even ids, not tuned on), for form moments with and without the values on screen.
//     The real coordinator runs over the entries' real focus times with Jev answering at the corpus's median latency,
//     so cooldown and coalescing are counted, not assumed.
// Cost per call is Jev's price ($0.042 per million input tokens) times the mean input tokens the corpus run measured
// for router and fill requests.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { humanActiveSpans, type Span } from "../../src/opportunity.ts";
import { readShadowEpisodes, readTransfers } from "../../src/store.ts";
import { JEV_USD_PER_INPUT_TOKEN, type AskJev } from "../../src/fill/jev.ts";
import { LEVELS } from "../../src/offers/settings.ts";
import { BUNDLE_IDLE_MS } from "../../src/patterns/routines.ts";
import { ScreenModel } from "../../src/model.ts";
import { RoutingCoordinator } from "../../src/routing/coordinator.ts";
import type { RouteCandidate } from "../../src/routing/routes.ts";
import { PROTOCOL_VERSION, type Node } from "../../src/protocol.ts";

const { values: a } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    "corpus-json": { type: "string" },
    out: { type: "string" },
    json: { type: "string" },
    start: { type: "string", default: "2026-10-02T16:31:30Z" },
    end: { type: "string", default: "2026-10-04T02:00:00Z" },
    "pmset-log": { type: "string" },
  },
});
for (const k of ["data-dir", "corpus-json", "out"] as const) if (a[k] === undefined) throw new Error(`--${k} is required`);
const FROM = Date.parse(a.start as string);
const TO = Date.parse(a.end as string);

/** Jev calls one focus-triggered fill makes: two agreeing asks, four when a field takes a person's details (B24). */
const CALLS_PER_FILL = { low: 2, high: 4 };
const BUDGET = LEVELS.balanced.offersPerHour;

const tmp = mkdtempSync(join(tmpdir(), "caret-day-replay-"));
try {
  execFileSync("sqlite3", [`file:${join(resolve(a["data-dir"] as string), "screen.sqlite")}?mode=ro`, `.backup '${join(tmp, "s.sqlite")}'`], { stdio: ["ignore", "ignore", "inherit"] });
  const db = new DatabaseSync(join(tmp, "s.sqlite"), { readOnly: true });
  const episodes = readShadowEpisodes(db).filter((e) => e.at >= FROM && e.at <= TO).sort((x, y) => x.at - y.at);
  const transfers = readTransfers(db).filter((t) => t.at >= FROM && t.at <= TO).sort((x, y) => x.at - y.at);
  const daily = db.prepare("SELECT day, metric, n FROM counts WHERE metric IN ('shadow.field_focus', 'reader.focus_editable')").all() as { day: string; metric: string; n: number }[];
  db.close();

  const log = a["pmset-log"] === undefined ? execFileSync("pmset", ["-g", "log"], { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] }) : readFileSync(a["pmset-log"], "utf8");
  const spans: Span[] = humanActiveSpans(log).map((s) => ({ from: Math.max(s.from, FROM), to: Math.min(s.to, TO) })).filter((s) => s.to > s.from);
  const active = (t: number): boolean => spans.some((s) => t >= s.from && t <= s.to);
  const hours = spans.reduce((n, s) => n + (s.to - s.from), 0) / 3_600_000;
  const logStart = humanActiveSpans(log)[0]?.from ?? null;

  // Focuses: each local day's editable-focus count, times the share of that day's entries inside the window and active.
  const dayOf = (t: number): string => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const allEpisodes = (() => {
    const d2 = new DatabaseSync(join(tmp, "s.sqlite"), { readOnly: true });
    const r = readShadowEpisodes(d2);
    d2.close();
    return r;
  })();
  let focuses = 0;
  const focusByDay: Record<string, { count: number; share: number }> = {};
  for (const day of new Set(episodes.map((e) => dayOf(e.at)))) {
    const count = daily.find((r) => r.day === day && r.metric === "shadow.field_focus")?.n ?? 0;
    const ofDay = allEpisodes.filter((e) => dayOf(e.at) === day).length;
    const inside = episodes.filter((e) => dayOf(e.at) === day && active(e.at)).length;
    const share = ofDay === 0 ? 0 : inside / ofDay;
    focusByDay[day] = { count, share };
    focuses += count * share;
  }

  const activeEpisodes = episodes.filter((e) => active(e.at));
  const findable = activeEpisodes.filter((e) => e.existed !== "no").length;
  const activeTransfers = transfers.filter((t) => active(t.at));
  // Form fills: transfers into one destination, each under BUNDLE_IDLE_MS after the last.
  const groups: { at: number; dst: string; n: number }[] = [];
  const open = new Map<string, { at: number; last: number; n: number }>();
  for (const t of activeTransfers) {
    const dst = `${t.dstBundle}|${t.dstWindowKind}`;
    const g = open.get(dst);
    if (g !== undefined && t.at - g.last <= BUNDLE_IDLE_MS) {
      g.last = t.at;
      g.n++;
      continue;
    }
    if (g !== undefined) groups.push({ at: g.at, dst, n: g.n });
    open.set(dst, { at: t.at, last: t.at, n: 1 });
  }
  for (const [dst, g] of open) groups.push({ at: g.at, dst, n: g.n });
  groups.sort((x, y) => x.at - y.at);

  // Rates from the corpus's held-out half: form moments with the values on screen (expected fillAll) and without.
  const corpus = JSON.parse(readFileSync(a["corpus-json"] as string, "utf8")) as {
    spend: { routerMs: number[]; routerTokens: number[]; producerTokens: number[]; calls: { router1: number; router2: number; producer: number } };
    rows: { id: string; category: string; expected: { outcome: string; route: string | null }; got: { outcome: string; route: string | null }; answered: string | null; confidence: number | null; by: string }[];
  };
  const forms = corpus.rows.filter((r) => r.category === "form-with-source");
  const heldOut = forms.filter((r) => Number(r.id.slice(1)) % 2 === 0);
  const rate = (rows: typeof heldOut, floor: number): { act: number; n: number } => {
    const acts = rows.filter((r) => (r.by === "router1" ? r.answered === "act" && (r.confidence ?? 0) >= floor : r.got.outcome === "act")).length;
    return { act: acts, n: rows.length };
  };
  const split = (rows: typeof heldOut) => ({ useful: rows.filter((r) => r.expected.route === "fillAll"), notUseful: rows.filter((r) => r.expected.route !== "fillAll") });
  const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((x, y) => x + y, 0) / xs.length);
  const median = (xs: number[]): number => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? 0;
  const routerTokens = mean(corpus.spend.routerTokens);
  const fillTokens = mean(corpus.spend.producerTokens);
  const latency = median(corpus.spend.routerMs);

  // The real coordinator over the entries' focus times: each a new context with a fill candidate.
  let at = FROM;
  const due: { at: number; fn: () => void; live: boolean }[] = [];
  const model = new ScreenModel();
  const answers: (() => void)[] = [];
  const askJev: AskJev = () =>
    new Promise((res) => answers.push(() => res({ model: "replay", answers: { outcome: { choice: "abstain", confidence: 0.9 } }, inputTokens: 0, latencyMs: latency, costUsd: 0 })));
  const cand: RouteCandidate = { id: "fillAll", kind: "fillAll", says: "Fill", plain: "Fill", quotes: [], relevance: 0, run: () => undefined };
  const coord = new RoutingCoordinator({
    model,
    askJev,
    candidates: () => [cand],
    hostWrites: () => false,
    wordsOn: () => true,
    paused: () => false,
    live: () => true,
    readerSession: () => 1,
    now: () => at,
    setTimer: (fn, ms) => {
      const t = { at: at + ms, fn, live: true };
      due.push(t);
      return () => {
        t.live = false;
      };
    },
  });
  const flush = async (until: number): Promise<void> => {
    for (;;) {
      // Answer every request whose latency has passed, then fire due timers, in time order.
      const t = due.filter((x) => x.live && x.at <= until).sort((x, y) => x.at - y.at)[0];
      if (answers.length > 0 && (t === undefined || at + latency <= t.at) && at + latency <= until) {
        at += latency;
        (answers.shift() as () => void)();
        await coord.idle();
        continue;
      }
      if (t === undefined) break;
      at = Math.max(at, t.at);
      t.live = false;
      t.fn();
    }
    at = Math.max(at, until);
  };
  let n = 0;
  for (const e of activeEpisodes) {
    await flush(e.at);
    const key = `replay/textfield:f~${n++}`;
    const nodes: Node[] = [{ key, parent: null, role: "AXTextField", label: "Field", editable: true }];
    model.apply({ type: "snapshot", v: PROTOCOL_VERSION, seq: n, at: e.at, reason: "focus", app: { pid: 1, bundleId: e.dstBundle, name: e.dstBundle }, window: { windowId: "1-1", kind: "standard", title: "w", frame: [0, 0, 1, 1] }, focused: true, root: null, nodes, values: [], focusedKey: key, stats: { walkMs: 0, visited: 1, truncated: false } });
    model.frontmostPid = 1;
    coord.observe();
  }
  await flush(TO + 60_000);
  const coalesce = coord.stats.router1Calls / Math.max(1, coord.stats.contexts);

  // The gate, time-ordered over the entries' focus times: which findable entries still get an offer once offers at
  // earlier focuses in the hour spent its budget. Before at worst every entry's focus offers; at best only findable
  // ones do. Focuses with no entry have no time, so they are left out: the worst case is a floor on competition.
  const usefulKept = (offers: (e: (typeof activeEpisodes)[number]) => boolean): number => {
    const spent: number[] = [];
    let kept = 0;
    for (const e of activeEpisodes) {
      if (!offers(e)) continue;
      if (spent.filter((t) => t > e.at - 3_600_000).length >= BUDGET) continue;
      spent.push(e.at);
      if (e.existed !== "no") kept++;
    }
    return kept;
  };

  const perH = (x: number): string => (x / hours).toFixed(2);
  const usd = (calls: number, tokens: number): number => calls * tokens * JEV_USD_PER_INPUT_TOKEN;
  const fillsAfter = (floor: number, rows: typeof heldOut): { useful: number; noise: number; offers: number; routerCalls: number; fillCalls: { low: number; high: number } } => {
    const { useful, notUseful } = split(rows);
    const ru = rate(useful, floor);
    const rn = rate(notUseful, floor);
    const u = findable * (ru.n === 0 ? 0 : ru.act / ru.n);
    const noise = Math.max(0, focuses - findable) * (rn.n === 0 ? 0 : rn.act / rn.n);
    const routerCalls = focuses * coalesce;
    return { useful: u, noise, offers: Math.min(BUDGET * hours, u + noise), routerCalls, fillCalls: { low: (u + noise) * CALLS_PER_FILL.low, high: (u + noise) * CALLS_PER_FILL.high } };
  };
  const cols = [
    { name: "After, 0.75, held-out rates", a: fillsAfter(0.75, heldOut) },
    { name: "After, 0.75, all form rates", a: fillsAfter(0.75, forms) },
    { name: "After, 0.5, held-out rates", a: fillsAfter(0.5, heldOut) },
    { name: "After, 0.5, all form rates", a: fillsAfter(0.5, forms) },
  ];
  const before = {
    fillCalls: { low: focuses * CALLS_PER_FILL.low, high: focuses * CALLS_PER_FILL.high },
    offers: { low: Math.min(BUDGET * hours, findable), high: Math.min(BUDGET * hours, focuses) },
    usefulKept: { best: usefulKept((e) => e.existed !== "no"), worst: usefulKept(() => true) },
  };
  const rows = [
    ["Window", `${new Date(FROM).toISOString()} to ${new Date(TO).toISOString()}`],
    ["Human-active hours (pmset spans)", hours.toFixed(2)],
    ["Field focuses, human-active (scaled from daily counts)", `${focuses.toFixed(0)} (${perH(focuses)}/h)`],
    ["Entries of 6+ characters, human-active / findable", `${activeEpisodes.length} / ${findable}`],
    ["Transfers, human-active / grouped into form fills", `${activeTransfers.length} / ${groups.length} (${perH(groups.length)}/h)`],
  ];
  const md = [
    "# Routing: the real-day replay",
    "",
    "A counterfactual over the shadow store's counts and hashes (scripts/routing/day-replay.ts); see the header there for every assumption. No moment's text exists, so Router 1's answers at real moments are the held-out corpus rates, applied to real moment counts and timings.",
    "",
    ...rows.map(([k, v]) => `- ${k}: ${v}`),
    `- pmset log starts ${logStart === null ? "unknown" : new Date(logStart).toISOString()}.`,
    `- Coordinator over the ${activeEpisodes.length} entries' real focus times (Jev answering in ${latency.toFixed(0)} ms): ${coord.stats.contexts} contexts, ${coord.stats.router1Calls} Router 1 calls (${(100 * coalesce).toFixed(0)}%), ${coord.stats.replaced} replaced while waiting, ${coord.stats.staleDrops} stale replies dropped.`,
    ...[["Held-out", heldOut] as const, ["All (dev half tuned on)", forms] as const].map(([name, rows]) => {
      const { useful, notUseful } = split(rows);
      return `- ${name} corpus form moments: act at the 0.75 floor ${rate(useful, 0.75).act}/${useful.length} with values on screen, ${rate(notUseful, 0.75).act}/${notUseful.length} without; at 0.5, ${rate(useful, 0.5).act}/${useful.length} and ${rate(notUseful, 0.5).act}/${notUseful.length}.`;
    }),
    "- Router 1 calls assume every human-active field focus lists fill (an upper bound: fill is listed only where a field visibly fits a value), coalesced at the rate the coordinator showed on the entries' real focus times.",
    "- Before, fill Jev calls assume every editable focus is empty with candidates (an upper bound); the shadow helper ran with Jev off, so the real rate is not in the store.",
    `- Mean input tokens: router ${routerTokens.toFixed(0)}, fill ask ${fillTokens.toFixed(0)}.`,
    "",
    `| Per human-active hour | Before (producers alone) | ${cols.map((c) => c.name).join(" | ")} |`,
    `| --- | --- | ${cols.map(() => "---").join(" | ")} |`,
    `| Fill offers | ${perH(before.offers.low)} (gate cap ${BUDGET}) | ${cols.map((c) => perH(c.a.offers)).join(" | ")} |`,
    `| Offers at focuses whose entry was not on screen | ${perH(before.offers.low - before.usefulKept.best)} to ${perH(before.offers.high - before.usefulKept.worst)} | ${cols.map((c) => perH(c.a.noise)).join(" | ")} |`,
    `| Useful offers kept (findable entries) | ${perH(before.usefulKept.worst)} to ${perH(before.usefulKept.best)} of ${perH(findable)} | ${cols.map((c) => perH(c.a.useful)).join(" | ")} |`,
    `| Router 1 calls, at most | 0 | ${cols.map((c) => perH(c.a.routerCalls)).join(" | ")} |`,
    `| Fill Jev calls | up to ${perH(before.fillCalls.low)} to ${perH(before.fillCalls.high)} | ${cols.map((c) => `${perH(c.a.fillCalls.low)} to ${perH(c.a.fillCalls.high)}`).join(" | ")} |`,
    `| Jev cost, at most | $${(usd(before.fillCalls.high, fillTokens) / hours).toFixed(4)} | ${cols.map((c) => `$${((usd(c.a.routerCalls, routerTokens) + usd(c.a.fillCalls.high, fillTokens)) / hours).toFixed(4)}`).join(" | ")} |`,
    "",
  ];
  writeFileSync(a.out as string, md.join("\n"));
  if (a.json !== undefined) writeFileSync(a.json, `${JSON.stringify({ hours, focuses, focusByDay, entries: activeEpisodes.length, findable, transfers: activeTransfers.length, groups: groups.length, coordinator: coord.stats, before, after: cols, routerTokens, fillTokens, latency }, null, 2)}\n`);
  process.stdout.write(md.join("\n"));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
