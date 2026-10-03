// Live-Jev replay, headless: no reader, no fixture app, no windows. It loads recorded and synthetic
// screens into the helper's model and asks live Jev, once with the conversation rule on and once with it
// off (privacy.ts setConversationCap), to measure what the rule costs. With the sources as Messages
// windows and the rule on, it also replays fill without B12's two changes (relevance-first spending and
// the source-cut rule, fill.ts FillOptions), one at a time and both, and sweeps a higher confidence
// cutoff for values from conversations over the answers, the alternative B11 named.
//
//   node scripts/live-replay.ts --out DIR [--fill-dir DIR] [--sets cal-1,cal-2,...]
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ScreenModel } from "../src/model.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { JEV_MODEL, loadJevKey, makeJevClient, type AskJev, type JevRequest } from "../src/fill/jev.ts";
import { heldAsConversation, setConversationCap } from "../src/privacy.ts";
import { conversationSign } from "../src/conversation.ts";
import { PROTOCOL_VERSION, ReaderMessage, Snapshot, type FirstLookReply, type Frame, type ReaderVerb, type VerbResult } from "../src/protocol.ts";
import { rng } from "../test/large-scene.ts";
import { loadRecording } from "../test/socket-reader.ts";
import { agentThreads, chatWindow, notesWindow, shortChats } from "../test/desks.ts";

const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    "fill-dir": { type: "string", default: join(homedir(), ".caret-run", "evidence", "screen", "fill-distractors-v2") },
    sets: { type: "string", default: "cal-1,cal-2,cal-3,accept-1,accept-2,accept-3" },
    "env-file": { type: "string", default: join(homedir(), "Programming Projects", "Caret", ".env") },
  },
});
if (a.out === undefined) throw new Error("--out is required");
mkdirSync(a.out, { recursive: true });

const key = loadJevKey({ ...process.env, CARET_ENV_FILE: process.env.CARET_ENV_FILE ?? a["env-file"] });
const jev = makeJevClient(() => key);

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
}
const calls: Call[] = [];
let part: Call["part"] = "fill";
let condition = "";
/** The model the current asks read from, to tell which source windows the conversation rule held. */
let current: ScreenModel | null = null;
const ask: AskJev = async (req: JevRequest) => {
  const r = await jev(req);
  const taken: Record<string, number> = {};
  for (const s of new Map(req.snippets.filter((x) => x.kind === "candidate").map((x) => [`${x.windowId}\u0000${x.text}`, x])).values()) taken[s.windowId] = (taken[s.windowId] ?? 0) + s.text.length;
  const conversations = Object.fromEntries(
    Object.entries(taken).filter(([id]) => {
      const w = current?.windows.get(id);
      return w !== undefined && heldAsConversation(w);
    }),
  );
  calls.push({ part, condition, latencyMs: r.latencyMs, inputTokens: r.inputTokens, costUsd: r.costUsd, taken, conversations });
  return r;
};

const CAPS = [true, false] as const;
const capName = (on: boolean): string => (on ? "rule on" : "rule off");

// MARK: - fill over the calibration recordings

interface GoldField { label: string; gold: string | null; frame: Frame }
interface GoldForm { window: string; fields: GoldField[] }
interface FillRow {
  set: string;
  variant: string;
  rule: string;
  /** Which of B12's changes were on: "B12" (both), "cut rule only", "relevance only", "neither (B11)". */
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

/** B12's two changes, each on or off; the four variants run with both on, the comparison only on Messages with the rule on. */
const FIXES = [
  { name: "B12", cutRule: true, relevance: true },
  { name: "neither (B11)", cutRule: false, relevance: false },
  { name: "cut rule only", cutRule: true, relevance: false },
  { name: "relevance only", cutRule: false, relevance: true },
] as const;

const MESSAGES = { bundleId: "com.apple.MobileSMS", name: "Messages" };
const SOURCE_TITLES = /Reference|Inbox/;

function relabel(m: ReaderMessage, pid: number): ReaderMessage {
  if (m.type !== "snapshot" || !SOURCE_TITLES.test(m.window.title)) return m;
  return { ...m, app: { pid, ...MESSAGES } };
}

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
  for (const variant of ["as recorded", "sources in Messages"] as const) {
    for (const on of CAPS) {
      for (const fix of FIXES) {
        if (fix.name !== "B12" && !(variant === "sources in Messages" && on)) continue;
        setConversationCap(on);
        part = "fill";
        condition = `${variant}, ${capName(on)}, ${fix.name}`;
        const model = new ScreenModel();
        current = model;
        for (const m of messages) {
          const x = variant === "as recorded" ? m : relabel(m, gold.pid + 1);
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
          const p = await proposeFill(model, ask, s.window.windowId, trigger, last + 1000, { rand: (n) => Math.floor(r() * n), cutRule: fix.cutRule, relevance: fix.relevance });
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
for (const desk of DESKS) {
  for (const on of CAPS) {
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
  "Fix: B12 is relevance-first spending plus the source-cut rule. The four variants run with B12; with the sources in Messages and the rule on, fill also runs without either change, and with each alone.",
  "",
  "| Variant | Rule | Fix | Exact | Wrong fills | Answerable filled | Missed | Withheld (disagree / low / source cut) | Most chars from one source window | Most from one conversation | Latency per ask p50 / p90 ms | Input tokens | Spend |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
);
const conditionRows = (variant: string, on: boolean, fix: string): FillRow[] => fillRows.filter((r) => r.variant === variant && r.rule === capName(on) && r.fix === fix);
for (const variant of ["as recorded", "sources in Messages"]) {
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
      const held = (w: string): number => rows.filter((r) => r.withheld === w).length;
      lines.push(
        `| ${variant} | ${capName(on)} | ${fix.name} | ${pct(exact, rows.length)} | ${wrong} | ${pct(filled, answerable.length)} | ${missed} | ${held("disagree")} / ${held("lowConfidence")} / ${held("sourceCut")} | ${most} | ${mostConversation} | ${quantile(cs.map((c) => c.latencyMs), 0.5).toFixed(0)} / ${quantile(cs.map((c) => c.latencyMs), 0.9).toFixed(0)} | ${cs.reduce((n, c) => n + c.inputTokens, 0)} | $${cs.reduce((n, c) => n + c.costUsd, 0).toFixed(4)} |`,
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
  "### A higher cutoff for values from conversations, over the same answers (sources in Messages, rule on)",
  "",
  `A value from a conversation is kept only at or above the cutoff; others keep ${0.75}. Cells: wrong fills, answerable filled.`,
  "",
  `| Fix | ${SWEEP.map((c) => `cutoff ${c.toFixed(2)}`).join(" | ")} |`,
  `|---|${SWEEP.map(() => "---").join("|")}|`,
);
for (const fix of FIXES) {
  const rows = conditionRows("sources in Messages", true, fix.name);
  if (rows.length === 0) continue;
  const cells = SWEEP.map((c) => {
    const kept = rows.map((r) => (r.proposed !== null && r.fromConversation && r.confidence < c ? null : r.proposed));
    const wrong = rows.filter((r, i) => kept[i] !== null && kept[i] !== r.gold).length;
    const answerable = rows.filter((r) => r.gold !== null).length;
    const filled = rows.filter((r, i) => r.gold !== null && kept[i] === r.gold).length;
    return `${wrong}, ${pct(filled, answerable)}`;
  });
  lines.push(`| ${fix.name} | ${cells.join(" | ")} |`);
}

lines.push("", "Conversation sign of each window as replayed (conversation.ts):", "");
for (const [w, s] of Object.entries(sourceSigns)) lines.push(`- ${w}: ${s ?? "not a conversation"}`);

lines.push("", "### Fields that changed between B11 and B12 (sources in Messages, rule on)", "", "| Set | Form | Field | Gold | B11 | B12 | B12 withheld |", "|---|---|---|---|---|---|---|");
for (const r of conditionRows("sources in Messages", true, "B12")) {
  const old = conditionRows("sources in Messages", true, "neither (B11)").find((x) => x.set === r.set && x.form === r.form && x.label === r.label);
  if (old !== undefined && old.proposed !== r.proposed) lines.push(`| ${r.set} | ${r.form} | ${r.label} | ${r.gold ?? "(none)"} | ${old.proposed ?? "(none)"} | ${r.proposed ?? "(none)"} | ${r.withheld ?? "-"} |`);
}

lines.push("", "### Fields that changed between rule on and off (B12)", "", "| Set | Variant | Form | Field | Gold | Rule on | Rule off |", "|---|---|---|---|---|---|---|");
for (const r of fillRows.filter((x) => x.rule === "rule on" && x.fix === "B12")) {
  const off = fillRows.find((x) => x.rule === "rule off" && x.fix === "B12" && x.set === r.set && x.variant === r.variant && x.form === r.form && x.label === r.label);
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

writeFileSync(join(a.out, "live-replay.md"), `${lines.join("\n")}\n`);
writeFileSync(join(a.out, "live-replay.json"), `${JSON.stringify({ fillRows, lookRows, calls, sourceSigns }, null, 2)}\n`);
process.stdout.write(`${lines.join("\n")}\n`);
