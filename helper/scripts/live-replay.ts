// Live-Jev replay, headless: no reader, no fixture app, no windows. It loads recorded and synthetic
// screens into the helper's model and asks live Jev, once with the conversation rule on and once with it
// off (privacy.ts setConversationCap), to measure what the rule costs. With the sources as Messages
// windows and the rule on, it also replays fill without B14's name group and without each of B13's two
// coverage changes (kinds by cost per field served, and not asking a field of no kind after a cut; fill.ts
// FillOptions), sweeps a
// higher confidence cutoff for values from conversations over the answers, and compares every field
// with an earlier run's (--compare, B12's by default).
//
//   node scripts/live-replay.ts --out DIR [--fill-dir DIR] [--sets cal-1,cal-2,...] [--compare FILE]
//     [--variants "sources in Messages,..."] [--rules on|off|on,off] [--no-look] [--spend-limit USD]
//     [--fixes "B14,..."]
//
// --variants, --rules, --fixes and --no-look run part of it again, to see how much of a difference is Jev
// answering differently on a second ask.
//
// Fill: each set is a fill calibration recording (reader-record.ndjson and gold.json from the
// caret-fixture runs in --fill-dir), replayed whole into a ScreenModel, then one proposeFill per form,
// as scripts/fill-eval.ts asked after its recording. Two variants per set: the windows as recorded (no
// conversation among them), and the same windows with the Reference and Inbox source windows relabelled
// as Messages windows, so every value the forms want sits in a conversation. The candidate order is
// seeded per set and form, so on and off differ only in what the rule lets through.
//
// First look: the synthetic desks of test/desks.ts and the recorded fixtures, seeded into a Helper whose
// reader answers every verb with ok, then one firstLook for every family. Each desk names the offer a
// right answer is.
//
// The key is TYPESAFE_API_KEY from the environment or from CARET_ENV_FILE (default: the Caret checkout's
// .env); it is never printed. Output holds synthetic text only.
import { writeStore } from "../src/privacy/send.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { positiveNumber } from "./flags.ts";
import { ScreenModel } from "../src/model.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { JEV_MODEL, jevSettings, loadJevKey, makeJevClient, type AskJev, type JevRequest } from "../src/fill/jev.ts";
import { heldAsConversation, setConversationCap } from "../src/privacy.ts";
import { conversationSign } from "../src/conversation.ts";
import { PROTOCOL_VERSION, ReaderMessage, Snapshot, type FirstLookReply, type Frame, type ReaderVerb, type ValueKind, type VerbResult } from "../src/protocol.ts";
import { rng } from "../test/large-scene.ts";
import { loadRecording } from "../test/socket-reader.ts";
import { agentThreads, chatWindow, notesWindow, shortChats } from "../test/desks.ts";

const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    "fill-dir": { type: "string", default: join(homedir(), ".caret-run", "evidence", "screen", "fill-distractors-v2") },
    sets: { type: "string", default: "cal-1,cal-2,cal-3,accept-1,accept-2,accept-3" },
    "env-file": { type: "string", default: join(homedir(), "Programming Projects", "Caret", ".env") },
    compare: { type: "string", default: join(homedir(), ".caret-run", "evidence", "screen", "b13", "live-final2", "live-replay.json") },
    variants: { type: "string" },
    rules: { type: "string", default: "on,off" },
    "no-look": { type: "boolean", default: false },
    "spend-limit": { type: "string", default: "0.145" },
    fixes: { type: "string" },
  },
});
/** The run stops before spending more than this on Jev (--spend-limit). B14's brief allows $0.15; B13's full run spent $0.113. */
const SPEND_LIMIT_USD = positiveNumber("spend-limit", a["spend-limit"]);

/**
 * The earlier run to compare with, read before any request so a bad file costs nothing; a file that is
 * not a replay's JSON is reported and left out rather than stopping the run.
 */
type EarlierRow = Pick<FillRow, "set" | "variant" | "rule" | "fix" | "form" | "label" | "gold" | "proposed">;
const earlier: { fillRows: EarlierRow[] } | null = (() => {
  if (a.compare === undefined || a.compare === "") return null;
  try {
    const d = JSON.parse(readFileSync(a.compare, "utf8")) as { fillRows?: unknown };
    const rows = d.fillRows;
    const ok = Array.isArray(rows) && rows.length > 0 && rows.every((r) => typeof r === "object" && r !== null && ["set", "variant", "rule", "fix", "form", "label"].every((k) => typeof (r as Record<string, unknown>)[k] === "string"));
    if (!ok) throw new Error("its fillRows are missing or malformed");
    return d as NonNullable<typeof earlier>;
  } catch (e) {
    process.stderr.write(`--compare ${a.compare} left out: ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
})();
if (a.out === undefined) throw new Error("--out is required");
mkdirSync(a.out, { recursive: true });

const jevEnv = { ...process.env, CARET_ENV_FILE: process.env.CARET_ENV_FILE ?? a["env-file"] };
const jev = makeJevClient((provider) => loadJevKey(jevEnv, provider), 10_000, undefined, jevSettings(jevEnv));

interface Call {
  part: "fill" | "firstLook";
  condition: string;
  latencyMs: number;
  inputTokens: number;
  costUsd: number;
  /** Characters of declared candidate text per source window id, each distinct text once. */
  taken: Record<string, number>;
  /** The same, for the source windows the conversation rule held. */
  conversations: Record<string, number>;
  /** What the request's ledger charged each window the conversation rule held (JevRequest.charged). */
  charged: Record<string, number>;
}
const calls: Call[] = [];
/** Thrown by ask once the spend limit is reached. The run then starts no new condition and still writes its report. */
class BudgetStop extends Error {}
/** Conditions a Jev error or the spend limit cut short; the report lists them. */
const errors: { condition: string; error: string }[] = [];
let stopped = false;
const failed = (e: unknown): void => {
  errors.push({ condition, error: e instanceof Error ? e.message : String(e) });
  if (e instanceof BudgetStop) stopped = true;
  process.stderr.write(`${condition}: ${errors.at(-1)?.error}\n`);
};
let part: Call["part"] = "fill";
let condition = "";
/** The model the current asks read from, to tell which source windows the conversation rule held. */
let current: ScreenModel | null = null;
const ask: AskJev = async (req: JevRequest) => {
  const spent = calls.reduce((n, c) => n + c.costUsd, 0);
  if (spent >= SPEND_LIMIT_USD) {
    stopped = true;
    throw new BudgetStop(`spent $${spent.toFixed(4)}, the run's limit is $${SPEND_LIMIT_USD}`);
  }
  const r = await jev(req);
  const taken: Record<string, number> = {};
  for (const s of new Map(req.snippets.filter((x) => x.kind === "candidate").map((x) => [`${x.windowId}\u0000${x.text}`, x])).values()) taken[s.windowId] = (taken[s.windowId] ?? 0) + s.text.length;
  const conversations = Object.fromEntries(
    Object.entries(taken).filter(([id]) => {
      const w = current?.windows.get(id);
      return w !== undefined && heldAsConversation(w);
    }),
  );
  const held = (id: string): boolean => {
    const w = current?.windows.get(id);
    return w !== undefined && heldAsConversation(w);
  };
  const charged = Object.fromEntries(Object.entries(req.charged).filter(([id]) => held(id)));
  calls.push({ part, condition, latencyMs: r.latencyMs, inputTokens: r.inputTokens, costUsd: r.costUsd, taken, conversations, charged });
  return r;
};

const CAPS = [true, false].filter((on) => (a.rules ?? "").split(",").includes(on ? "on" : "off"));
const capName = (on: boolean): string => (on ? "rule on" : "rule off");

// MARK: - fill over the calibration recordings

interface GoldField { label: string; gold: string | null; frame: Frame }
interface GoldForm { window: string; fields: GoldField[] }
interface FillRow {
  set: string;
  variant: string;
  rule: string;
  /** Which fixes were on: MAIN (all), or the name of the one left out. */
  fix: string;
  form: string;
  label: string;
  gold: string | null;
  proposed: string | null;
  confidence: number;
  withheld: string | null;
  /** Whether the proposed value came from a window the conversation rule held, for the cutoff sweep. */
  fromConversation: boolean;
}

/** B14 as shipped, and each of its name group and B13's two coverage changes left out; the comparison runs where conversations are cut. */
const MAIN = "B14";
const FIXES = [
  { name: MAIN, opts: {} },
  { name: "B14, names ungrouped", opts: { nameGroup: false } },
  { name: "B14, kinds in field order", opts: { kindsByCost: false } },
  { name: "B14, field of no kind asked", opts: { unknownKindRule: false } },
] as const;

const MESSAGES = { bundleId: "com.apple.MobileSMS", name: "Messages" };
const SOURCE_TITLES = /Reference|Inbox/;

function relabel(m: ReaderMessage, pid: number): ReaderMessage {
  if (m.type !== "snapshot" || !SOURCE_TITLES.test(m.window.title)) return m;
  return { ...m, app: { pid, ...MESSAGES } };
}

/**
 * Twenty-four earlier messages, each with values of the kinds the forms take (dates, times, amounts, emails,
 * phones, URLs, addresses, IDs), as the reader would report them. Put above a source window's own text,
 * they make each Messages window hold more values of those kinds than its budget, which is where a cut
 * splits a kind and the cut rule has to act. Invented, like the fixture.
 */
const EARLIER: [string, [ValueKind, string][]][] = [
  ["Kofi: the venue deposit of $240.00 is due September 30, 2026", [["amount", "$240.00"], ["date", "September 30, 2026"]]],
  ["Aiko: call me at +1 (737) 555-0110 after 4:30 PM", [["phone", "+1 (737) 555-0110"], ["time", "4:30 PM"]]],
  ["Kofi: plan is at https://docs.example.com/q4-plan", [["url", "https://docs.example.com/q4-plan"]]],
  ["Aiko: cc mara.okafor@example.org on INV-2026-0912", [["email", "mara.okafor@example.org"], ["id", "INV-2026-0912"]]],
  ["Kofi: ship to 88 Rainey St, Austin, TX 78701 by Monday, October 12, 2026", [["address", "88 Rainey St, Austin, TX 78701"], ["date", "Monday, October 12, 2026"]]],
  ["Aiko: standup moves to 9:15 AM on Tuesday, October 6, 2026", [["time", "9:15 AM"], ["date", "Tuesday, October 6, 2026"]]],
  ["Kofi: the refund was $72.40, ref RFD-2026-3317", [["amount", "$72.40"], ["id", "RFD-2026-3317"]]],
  ["Aiko: new number is +1 (512) 555-0187", [["phone", "+1 (512) 555-0187"]]],
  ["Kofi: slides at https://slides.example.com/kickoff", [["url", "https://slides.example.com/kickoff"]]],
  ["Aiko: write to kofi.mensah@example.net for the badge", [["email", "kofi.mensah@example.net"]]],
  ["Kofi: room hold ends 5:45 PM, Wednesday, October 14, 2026", [["time", "5:45 PM"], ["date", "Wednesday, October 14, 2026"]]],
  ["Aiko: parking is $18.00 at 301 Brazos St, Austin, TX 78701", [["amount", "$18.00"], ["address", "301 Brazos St, Austin, TX 78701"]]],
  ["Kofi: invoice INV-2026-1044 for $1,180.00 went out Friday, September 25, 2026", [["id", "INV-2026-1044"], ["amount", "$1,180.00"], ["date", "Friday, September 25, 2026"]]],
  ["Aiko: Lena's cell is +1 (512) 555-0163", [["phone", "+1 (512) 555-0163"]]],
  ["Kofi: lena.ortiz@lumenlabs.example wants the deck by 2:00 PM", [["email", "lena.ortiz@lumenlabs.example"], ["time", "2:00 PM"]]],
  ["Aiko: the portal is https://lumenlabs.example/portal", [["url", "https://lumenlabs.example/portal"]]],
  ["Kofi: return label goes to 1450 Lamar Blvd, Austin, TX 78703", [["address", "1450 Lamar Blvd, Austin, TX 78703"]]],
  ["Aiko: ticket SUP-31877 says the total was $1,351.50", [["id", "SUP-31877"], ["amount", "$1,351.50"]]],
  ["Kofi: retro is Thursday, October 15, 2026 at 3:30 PM", [["date", "Thursday, October 15, 2026"], ["time", "3:30 PM"]]],
  ["Aiko: join at https://meet.example.com/rtv-pkq-wzd", [["url", "https://meet.example.com/rtv-pkq-wzd"]]],
  ["Kofi: ordered on September 21, 2026 as ORD-2026-47950", [["date", "September 21, 2026"], ["id", "ORD-2026-47950"]]],
  ["Aiko: billing contact is ap@lumenlabs.example", [["email", "ap@lumenlabs.example"]]],
  ["Kofi: their front desk is +1 (512) 555-0100", [["phone", "+1 (512) 555-0100"]]],
  ["Aiko: lunch order came to $64.25", [["amount", "$64.25"]]],
];

function withEarlier(m: ReaderMessage): ReaderMessage {
  if (m.type !== "snapshot" || m.root !== null || !SOURCE_TITLES.test(m.window.title)) return m;
  const group = "dev.caret.replay/standard/group:earlier~0";
  const nodes = EARLIER.map(([line], i) => ({ key: `${group}/statictext:${i}~0`, parent: group, role: "AXStaticText", label: line }));
  const values = EARLIER.flatMap(([, vs], i) => vs.map(([kind, text]) => ({ kind, text, nodeKey: `${group}/statictext:${i}~0` })));
  return { ...m, nodes: [{ key: group, parent: null, role: "AXGroup", label: "Earlier messages" }, ...nodes, ...m.nodes], values: [...values, ...m.values] };
}

const VARIANTS = ["as recorded", "sources in Messages", "long Messages threads"] as const;
type Variant = (typeof VARIANTS)[number];
const toVariant = (v: Variant, m: ReaderMessage, pid: number): ReaderMessage => (v === "as recorded" ? m : v === "sources in Messages" ? relabel(m, pid) : relabel(withEarlier(m), pid));

const center = (f: Frame): [number, number] => [f[0] + f[2] / 2, f[1] + f[3] / 2];
const inside = (p: [number, number], f: Frame): boolean => p[0] >= f[0] && p[0] <= f[0] + f[2] && p[1] >= f[1] && p[1] <= f[1] + f[3];
const hashSeed = (s: string): number => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

const fillRows: FillRow[] = [];
const sourceSigns: Record<string, string | null> = {};
for (const set of (a.sets ?? "").split(",").filter((s) => s !== "")) {
  const dir = join(a["fill-dir"], set);
  const gold = JSON.parse(readFileSync(join(dir, "gold.json"), "utf8")) as { pid: number; forms: GoldForm[] };
  const messages = readFileSync(join(dir, "reader-record.ndjson"), "utf8").trim().split("\n").map((l) => ReaderMessage.parse(JSON.parse(l)));
  const latest = new Map<string, Snapshot>();
  for (const m of messages) if (m.type === "snapshot" && m.root === null) latest.set(m.window.title, m);
  const last = Math.max(...messages.map((m) => ("at" in m ? m.at : 0)));
  for (const variant of VARIANTS) {
    if (a.variants !== undefined && !a.variants.split(",").includes(variant)) continue;
    for (const on of CAPS) {
      for (const fix of FIXES) {
        if (a.fixes !== undefined && !a.fixes.split(",").includes(fix.name)) continue;
        if (stopped) continue;
        // The comparison runs where conversations are cut: the Messages variants with the rule on.
        if (fix.name !== MAIN && !(variant !== "as recorded" && on)) continue;
        if (variant === "long Messages threads" && !on) continue;
        setConversationCap(on);
        part = "fill";
        condition = `${variant}, ${capName(on)}, ${fix.name}`;
        const model = new ScreenModel();
        current = model;
        for (const m of messages) {
          const x = toVariant(variant, m, gold.pid + 1);
          if (x.type === "snapshot") model.apply(x);
          else if (x.type === "windowClosed") model.close(x.windowId, x.at);
        }
        for (const w of model.windows.values()) sourceSigns[`${variant}: ${w.window.title.replace(/^Caret Fixture — /, "")}`] = conversationSign(w);
        for (const form of gold.forms) {
          const s = latest.get(form.window);
          if (s === undefined) throw new Error(`${set}: no snapshot of ${form.window}`);
          const byKey = new Map<string, GoldField>();
          for (const g of form.fields) {
            const n = s.nodes.find((x) => x.editable === true && x.frame !== undefined && inside(center(g.frame), x.frame));
            if (n === undefined) throw new Error(`${set}: no field under ${g.label} in ${form.window}`);
            byKey.set(n.key, g);
          }
          const trigger = [...byKey.keys()][0] as string;
          const r = rng(hashSeed(`${set}/${form.window}`));
          let p: Awaited<ReturnType<typeof proposeFill>>;
          try {
            p = await proposeFill(model, ask, s.window.windowId, trigger, last + 1000, { rand: (n) => Math.floor(r() * n), ...fix.opts });
          } catch (e) {
            failed(e);
            if (stopped) break;
            continue;
          }
          for (const f of p.fields) {
            const g = byKey.get(f.key);
            if (g === undefined) continue;
            const from = f.source === null ? undefined : model.windows.get(f.source.windowId);
            fillRows.push({
              set,
              variant,
              rule: capName(on),
              fix: fix.name,
              form: form.window.replace(/^Caret Fixture — /, ""),
              label: g.label,
              gold: g.gold,
              proposed: f.value,
              confidence: f.confidence,
              withheld: f.withheld,
              fromConversation: from !== undefined && heldAsConversation(from),
            });
          }
        }
      }
    }
  }
}
current = null;
setConversationCap(true);

// MARK: - first look over seeded desks

interface Desk {
  name: string;
  messages: () => ReaderMessage[];
  /** Snapshots only (windows open when onboarding ends), or the whole stream so a pending watch runs. */
  whole: boolean;
  /** What a right answer is: the family, the window titles allowed, and for a fill the values by field label. */
  want: { family: string; windows: string[]; values?: Record<string, string> };
}
const FORM_VALUES = { Name: "Dana Whitfield", Email: "dana.whitfield@example.com", Phone: "+1 (512) 555-0142" };
const DESKS: Desk[] = [
  { name: "fill desk (mail card, team chat, notes)", messages: () => [notesWindow(500), chatWindow(600), ...loadRecording("offers-fill.ndjson")], whole: false, want: { family: "fill", windows: ["Checkout"], values: FORM_VALUES } },
  { name: "short chats (values only in conversations)", messages: shortChats, whole: false, want: { family: "fill", windows: ["Checkout"], values: FORM_VALUES } },
  { name: "pending desk (test run)", messages: () => [notesWindow(500), ...loadRecording("offers-pending.ndjson")], whole: true, want: { family: "pending", windows: ["Test run"] } },
  { name: "agent threads (T3 done, Codex waiting)", messages: agentThreads, whole: true, want: { family: "pending", windows: ["Seating chart", "Badge export"] } },
];

const okReader = { run: async (v: ReaderVerb): Promise<VerbResult> => ({ type: "verbResult", v: PROTOCOL_VERSION, id: v.kind, at: 0, outcome: "ok", detail: null }) };

interface LookRow {
  desk: string;
  rule: string;
  outcome: string;
  family: string | null;
  window: string | null;
  header: string | null;
  right: boolean;
  values: { label: string; want: string | null; got: string | null }[];
  /** For a fill desk, the form's own proposal asked once more after the look: the first look offers a fill only when every empty field has a value (fill-popup.ts fillPopupEligible). */
  proposal: { label: string; want: string | null; got: string | null }[];
  ms: number;
  error: string | null;
}
const lookRows: LookRow[] = [];
for (const desk of a["no-look"] === true ? [] : DESKS) {
  for (const on of CAPS) {
    if (stopped) continue;
    setConversationCap(on);
    part = "firstLook";
    condition = `${desk.name}, ${capName(on)}`;
    const dir = mkdtempSync(join(tmpdir(), "caret-live-replay-"));
    const store = new Store(dir);
    const helper = new Helper({ store, askJev: ask, shadow: false, allowBackgroundFocus: true, readerLink: okReader, publish: () => undefined });
    current = helper.model;
    try {
      for (const m of desk.messages().filter((x) => desk.whole || x.type === "snapshot")) {
        await helper.handleReader(m);
        if ("at" in m) helper.tick(m.at);
      }
      await helper.pending.whenIdle();
      const t0 = performance.now();
      const reply: FirstLookReply = await helper.handleFirstLook({ type: "firstLook", v: PROTOCOL_VERSION, requestId: "live", at: Date.now(), families: ["fill", "pending", "loop", "routine"], level: "eager", deadlineMs: 8000 });
      const ms = performance.now() - t0;
      const found = reply.found;
      const header = found?.spec.blocks.find((b) => b.type === "header");
      const fields = found?.spec.blocks.find((b) => b.type === "fields");
      const got = new Map<string, string | null>();
      if (fields !== undefined && fields.type === "fields") for (const row of fields.rows) got.set(row.destination.text, row.value?.text ?? null);
      const values = Object.entries(desk.want.values ?? {}).map(([label, want]) => ({ label, want, got: [...got].find(([d]) => d.includes(label))?.[1] ?? null }));
      const right =
        reply.outcome === "found" &&
        found?.family === desk.want.family &&
        desk.want.windows.includes(found.window.title) &&
        values.every((v) => v.got === null || v.got === v.want) &&
        (values.length === 0 || values.some((v) => v.got === v.want));
      const proposal: LookRow["proposal"] = [];
      const form = [...helper.model.windows.values()].find((w) => desk.want.values !== undefined && desk.want.windows.includes(w.window.title));
      if (form !== undefined) {
        condition = `${desk.name}, ${capName(on)}, proposal`;
        const trigger = [...form.nodes.values()].find((n) => n.editable === true)?.key as string;
        const p = await proposeFill(helper.model, ask, form.window.windowId, trigger, Date.now());
        for (const [label, want] of Object.entries(desk.want.values ?? {})) proposal.push({ label, want, got: p.fields.find((f) => f.descriptor.includes(`'${label}'`))?.value ?? null });
      }
      lookRows.push({ desk: desk.name, rule: capName(on), outcome: reply.outcome, family: found?.family ?? null, window: found?.window.title ?? null, header: header?.type === "header" ? header.title.text : null, right, values, proposal, ms, error: reply.error });
    } catch (e) {
      failed(e);
    } finally {
      helper.shutdown();
      helper.memory.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
setConversationCap(true);

// MARK: - report

const pct = (n: number, d: number): string => (d === 0 ? "-" : `${n} of ${d} (${((100 * n) / d).toFixed(1)}%)`);
const quantile = (xs: number[], q: number): number => {
  const s = xs.toSorted((x, y) => x - y);
  return s.length === 0 ? Number.NaN : (s[Math.min(s.length - 1, Math.floor(q * s.length))] as number);
};
const lines: string[] = ["# Live-Jev replay, conversation rule on and off", "", `Run ${new Date().toISOString()}, headless, model ${JEV_MODEL}. Synthetic text only.`, ""];

lines.push("## Fill over the calibration recordings", "", `Sets: ${a.sets}. One proposeFill per form per condition (two asks each), candidate order seeded per set and form.`, "");
lines.push(
  "Fix: B14 is B13 (the ledger charging every window a request reveals, no typed value used as a label, conversation kinds by cost per field served, and no field of no kind asked after a cut) with a conversation's name-like lines offered whole or not at all when a field takes a name, and no name-like value proposed after a cut of names. The five variants (as recorded and sources in Messages, rule on and off, and long Messages threads with the rule on) run with B14. Where conversations are cut (the Messages variants, rule on), fill also runs with the name group and with each of B13's last two fixes left out. \"long Messages threads\" adds twenty-four earlier messages full of dates, times, amounts, emails, phones, URLs, addresses and IDs above each Messages source window (EARLIER in the script), so the budget cannot hold every value of a kind and the cut rule has to act.",
  "",
  "\"Most charged to one conversation\" is the ledger's own count (JevRequest.charged), which also charges lines revealed through another window's text; \"most from one conversation\" counts declared snippets only, as B12's report did.",
  "",
  "| Variant | Rule | Fix | Exact | Wrong fills | Answerable filled | Missed | Withheld (disagree / low / source cut) | Most chars from one source window | Most from one conversation | Most charged to one conversation | Latency per ask p50 / p90 ms | Input tokens | Spend |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
);
const conditionRows = (variant: string, on: boolean, fix: string): FillRow[] => fillRows.filter((r) => r.variant === variant && r.rule === capName(on) && r.fix === fix);
for (const variant of VARIANTS) {
  for (const on of CAPS) {
    for (const fix of FIXES) {
      const rows = conditionRows(variant, on, fix.name);
      if (rows.length === 0) continue;
      const cs = calls.filter((c) => c.part === "fill" && c.condition === `${variant}, ${capName(on)}, ${fix.name}`);
      const exact = rows.filter((r) => r.proposed === r.gold).length;
      const wrong = rows.filter((r) => r.proposed !== null && r.proposed !== r.gold).length;
      const answerable = rows.filter((r) => r.gold !== null);
      const filled = answerable.filter((r) => r.proposed === r.gold).length;
      const missed = answerable.filter((r) => r.proposed === null).length;
      const most = Math.max(0, ...cs.flatMap((c) => Object.values(c.taken)));
      const mostConversation = Math.max(0, ...cs.flatMap((c) => Object.values(c.conversations)));
      const mostCharged = Math.max(0, ...cs.flatMap((c) => Object.values(c.charged)));
      const held = (w: string): number => rows.filter((r) => r.withheld === w).length;
      lines.push(
        `| ${variant} | ${capName(on)} | ${fix.name} | ${pct(exact, rows.length)} | ${wrong} | ${pct(filled, answerable.length)} | ${missed} | ${held("disagree")} / ${held("lowConfidence")} / ${held("sourceCut")} | ${most} | ${mostConversation} | ${mostCharged} | ${quantile(cs.map((c) => c.latencyMs), 0.5).toFixed(0)} / ${quantile(cs.map((c) => c.latencyMs), 0.9).toFixed(0)} | ${cs.reduce((n, c) => n + c.inputTokens, 0)} | $${cs.reduce((n, c) => n + c.costUsd, 0).toFixed(4)} |`,
      );
    }
  }
}

lines.push("", "### Wrong fills", "", "| Set | Variant | Rule | Fix | Form | Field | Gold | Filled | Confidence |", "|---|---|---|---|---|---|---|---|---|");
for (const r of fillRows.filter((x) => x.proposed !== null && x.proposed !== x.gold)) {
  lines.push(`| ${r.set} | ${r.variant} | ${r.rule} | ${r.fix} | ${r.form} | ${r.label} | ${r.gold ?? "(none)"} | ${r.proposed} | ${r.confidence} |`);
}

// B11's alternative: a higher cutoff for values from conversations. A cutoff only blanks values the asks
// already agreed on, so it is computed over the recorded answers rather than asked again.
const SWEEP = [0.75, 0.8, 0.85, 0.9, 0.95];
lines.push(
  "",
  "### A higher cutoff for values from conversations, over the same answers (rule on)",
  "",
  `A value from a conversation is kept only at or above the cutoff; others keep ${0.75}. Cells: wrong fills, answerable filled.`,
  "",
  `| Variant | Fix | ${SWEEP.map((c) => `cutoff ${c.toFixed(2)}`).join(" | ")} |`,
  `|---|---|${SWEEP.map(() => "---").join("|")}|`,
);
for (const variant of VARIANTS.filter((v) => v !== "as recorded")) for (const fix of FIXES) {
  const rows = conditionRows(variant, true, fix.name);
  if (rows.length === 0) continue;
  const cells = SWEEP.map((c) => {
    const kept = rows.map((r) => (r.proposed !== null && r.fromConversation && r.confidence < c ? null : r.proposed));
    const wrong = rows.filter((r, i) => kept[i] !== null && kept[i] !== r.gold).length;
    const answerable = rows.filter((r) => r.gold !== null).length;
    const filled = rows.filter((r, i) => r.gold !== null && kept[i] === r.gold).length;
    return `${wrong}, ${pct(filled, answerable)}`;
  });
  lines.push(`| ${variant} | ${fix.name} | ${cells.join(" | ")} |`);
}

lines.push("", "Conversation sign of each window as replayed (conversation.ts):", "");
for (const [w, s] of Object.entries(sourceSigns)) lines.push(`- ${w}: ${s ?? "not a conversation"}`);

// Against the earlier run (--compare): its main fix against MAIN, over the fields both runs asked.
if (earlier !== null) {
  const mainFix = earlier.fillRows[0]?.fix ?? "";
  const key = (r: EarlierRow): string => `${r.set}\u0000${r.variant}\u0000${r.rule}\u0000${r.form}\u0000${r.label}`;
  const asked = new Set(fillRows.filter((r) => r.fix === MAIN).map(key));
  const old = (variant: string, rule: string): EarlierRow[] => earlier.fillRows.filter((r) => r.variant === variant && r.rule === rule && r.fix === mainFix && asked.has(key(r)));
  lines.push("", `### Against the earlier run (${mainFix}, ${a.compare})`, "", `| Variant | Rule | Answerable filled, ${mainFix} | Answerable filled, ${MAIN} | Wrong, ${mainFix} | Wrong, ${MAIN} |`, "|---|---|---|---|---|---|");
  for (const variant of VARIANTS) for (const on of CAPS) {
    const was = old(variant, capName(on));
    const now = conditionRows(variant, on, MAIN);
    if (was.length === 0 || now.length === 0) continue;
    const filled = (rows: readonly EarlierRow[]): string => pct(rows.filter((r) => r.gold !== null && r.proposed === r.gold).length, rows.filter((r) => r.gold !== null).length);
    const wrong = (rows: readonly EarlierRow[]): number => rows.filter((r) => r.proposed !== null && r.proposed !== r.gold).length;
    lines.push(`| ${variant} | ${capName(on)} | ${filled(was)} | ${filled(now)} | ${wrong(was)} | ${wrong(now)} |`);
  }
  lines.push("", `#### Fields that changed against ${mainFix} (rule on)`, "", `| Set | Variant | Form | Field | Gold | ${mainFix} | ${MAIN} | ${MAIN} withheld |`, "|---|---|---|---|---|---|---|---|");
  for (const variant of VARIANTS) for (const r of conditionRows(variant, true, MAIN)) {
    const o = old(variant, "rule on").find((x) => x.set === r.set && x.form === r.form && x.label === r.label);
    if (o !== undefined && o.proposed !== r.proposed) lines.push(`| ${r.set} | ${variant} | ${r.form} | ${r.label} | ${r.gold ?? "(none)"} | ${o.proposed ?? "(none)"} | ${r.proposed ?? "(none)"} | ${r.withheld ?? "-"} |`);
  }
}

lines.push("", `### Fields that changed between rule on and off (${MAIN})`, "", "| Set | Variant | Form | Field | Gold | Rule on | Rule off |", "|---|---|---|---|---|---|---|");
for (const r of fillRows.filter((x) => x.rule === "rule on" && x.fix === MAIN)) {
  const off = fillRows.find((x) => x.rule === "rule off" && x.fix === MAIN && x.set === r.set && x.variant === r.variant && x.form === r.form && x.label === r.label);
  if (off !== undefined && off.proposed !== r.proposed) lines.push(`| ${r.set} | ${r.variant} | ${r.form} | ${r.label} | ${r.gold ?? "(none)"} | ${r.proposed ?? "(none)"} | ${off.proposed ?? "(none)"} |`);
}

lines.push("", "## First look over seeded desks", "", "| Desk | Rule | Outcome | Offer | Right | Values right / wrong / blank | Form's proposal right / wrong / blank | First look ms | Jev asks | Spend |", "|---|---|---|---|---|---|---|---|---|---|");
for (const r of lookRows) {
  const cs = calls.filter((c) => c.part === "firstLook" && c.condition === `${r.desk}, ${r.rule}`);
  const v = r.values;
  const tally = (xs: LookRow["values"]): string => (xs.length === 0 ? "-" : `${xs.filter((x) => x.got === x.want).length} / ${xs.filter((x) => x.got !== null && x.got !== x.want).length} / ${xs.filter((x) => x.got === null).length}`);
  lines.push(
    `| ${r.desk} | ${r.rule} | ${r.outcome}${r.error === null ? "" : ` (${r.error})`} | ${r.family ?? "-"} on ${r.window ?? "-"}: ${r.header ?? ""} | ${r.right ? "yes" : "no"} | ${tally(v)} | ${tally(r.proposal)} | ${r.ms.toFixed(0)} | ${cs.length} | $${cs.reduce((n, c) => n + c.costUsd, 0).toFixed(4)} |`,
  );
}
const total = calls.reduce((n, c) => n + c.costUsd, 0);
lines.push("", `Jev asks in all: ${calls.length}; input tokens ${calls.reduce((n, c) => n + c.inputTokens, 0)}; spend $${total.toFixed(4)} at $0.042 per million input tokens.`);
if (errors.length > 0 || stopped) {
  lines.push("", `## Errors${stopped ? " (stopped at the spend limit; later conditions did not run)" : ""}`, "");
  for (const e of errors) lines.push(`- ${e.condition}: ${e.error}`);
}

writeStore(join(a.out, "live-replay.md"), `${lines.join("\n")}\n`);
writeStore(join(a.out, "live-replay.json"), `${JSON.stringify({ fillRows, lookRows, calls, sourceSigns, errors, stopped }, null, 2)}\n`);
process.stdout.write(`${lines.join("\n")}\n`);
process.exitCode = errors.length > 0 || stopped ? 1 : 0;
