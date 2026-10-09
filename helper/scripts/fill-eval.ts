// Grounded-fill evaluation against caret-fixture with live Jev.
//
//   node scripts/fill-eval.ts --gold GOLD.json --record READER_RECORDING.ndjson --rounds N --out DIR
//
// Needs a running helper (with Jev) and a caret-screen started with --only-pids <fixture pid>
// --record READER_RECORDING.ndjson, so the helper's screen model holds the fixture's synthetic
// windows and nothing else. Field keys are found by matching the fixture's gold frames against
// the recorded snapshots. For each form it sends one fillRequest per round, and it also records any
// proposal that a focus event produced on its own. Scores exact match against the gold values.
import { writeStore, writeStoreJson } from "../src/privacy/send.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { positiveInt } from "./flags.ts";
import { ScreenModel } from "../src/model.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { harnessEngine } from "../src/engines/decide/harness.ts";
import { FillProposal, PROTOCOL_VERSION, Snapshot, type Frame } from "../src/protocol.ts";

const { values: a } = parseArgs({
  options: {
    gold: { type: "string" },
    record: { type: "string" },
    rounds: { type: "string", default: "3" },
    engine: { type: "string", default: "jev" },
    "log-requests": { type: "string" },
    out: { type: "string" },
    socket: { type: "string", default: join(homedir(), ".caret-run", "sockets", "screen.sock") },
    "wait-focus": { type: "string", default: "0" },
  },
});
if (a.gold === undefined || a.record === undefined || a.out === undefined) throw new Error("--gold, --record and --out are required");
if (a.engine !== "jev" && a.engine !== "decisions") throw new Error("--engine is jev or decisions for this fixture evaluation");
const rounds = positiveInt("rounds", a.rounds);
// Before any request: a missing directory would otherwise throw at the first write, after Jev was paid.
mkdirSync(a.out, { recursive: true });

interface GoldField { label: string; gold: string | null; frame: Frame }
interface GoldForm { window: string; fields: GoldField[] }
const gold = JSON.parse(readFileSync(a.gold, "utf8")) as { pid: number; forms: GoldForm[] };

// Latest full snapshot of each form window.
const latest = new Map<string, Snapshot>();
for (const line of readFileSync(a.record, "utf8").trim().split("\n")) {
  const m = JSON.parse(line) as { type: string };
  if (m.type !== "snapshot") continue;
  const s = Snapshot.parse(m);
  // Proposals are written to disk with their values, so every source must be the synthetic fixture.
  if (s.app.pid !== gold.pid) throw new Error(`recording has a window from pid ${s.app.pid}; run caret-screen with --only-pids ${gold.pid}`);
  if (s.root === null) latest.set(s.window.title, s);
}

const center = (f: Frame): [number, number] => [f[0] + f[2] / 2, f[1] + f[3] / 2];
const inside = (p: [number, number], f: Frame): boolean => p[0] >= f[0] && p[0] <= f[0] + f[2] && p[1] >= f[1] && p[1] <= f[1] + f[3];

interface Target { windowId: string; title: string; trigger: string; goldByKey: Map<string, GoldField> }
const targets: Target[] = gold.forms.map((form) => {
  const s = latest.get(form.window);
  if (s === undefined) throw new Error(`no snapshot of ${form.window} in ${a.record}`);
  const goldByKey = new Map<string, GoldField>();
  for (const g of form.fields) {
    const node = s.nodes.find((n) => n.editable === true && n.frame !== undefined && inside(center(g.frame), n.frame));
    if (node === undefined) throw new Error(`no editable node under gold field ${g.label} in ${form.window}`);
    goldByKey.set(node.key, g);
  }
  const first = [...goldByKey.keys()][0];
  if (first === undefined) throw new Error(`form ${form.window} has no fields`);
  return { windowId: s.window.windowId, title: form.window, trigger: first, goldByKey };
});

const proposals: FillProposal[] = [];
const errors: string[] = [];
let fromFocus = 0;
if (a.engine === "decisions") {
  // Decisions never runs in the helper that reads live screens. Replay only the declared synthetic fixture recording
  // locally and score proposals without sending a write to the reader. The default Jev/socket path stays unchanged.
  const model = new ScreenModel();
  for (const snapshot of latest.values()) model.apply(snapshot);
  const ids = new Set([...latest.values()].map((s) => s.window.windowId));
  const decide = harnessEngine({ name: "decisions", canned: null,
    fixture: { windows: (id) => ids.has(id), memory: false, plan: false },
    logRequests: a["log-requests"] ?? join(a.out, "requests.ndjson"),
  });
  const now = Math.max(...[...latest.values()].map((s) => s.at)) + 1;
  try {
    for (let r = 0; r < rounds; r++) for (const target of targets) {
      const proposal = await proposeFill(model, decide.ask, target.windowId, target.trigger, now);
      proposals.push(proposal);
    }
  } finally { decide.engine.close?.(); }
} else {
  const sock = createConnection(a.socket);
  let waiter: ((p: FillProposal | null) => void) | null = null;
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, nl)) as { type: string; message?: string };
      buf = buf.slice(nl + 1);
      if (m.type === "error") {
        errors.push(m.message ?? "");
        const w = waiter;
        waiter = null;
        w?.(null);
      } else if (m.type === "fillProposal") {
        const p = FillProposal.parse(m);
        proposals.push(p);
        const w = waiter;
        waiter = null;
        w?.(p);
      }
    }
  });
  await new Promise<void>((r) => sock.once("connect", () => r()));
  sock.write(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: process.pid, version: "fill-eval" }) + "\n");

  // Proposals that arrive from focus events before the explicit requests start.
  const waitFocusMs = Number(a["wait-focus"]) * 1000;
  if (waitFocusMs > 0) await new Promise((r) => setTimeout(r, waitFocusMs));
  fromFocus = proposals.length;

  const ask = (t: Target): Promise<FillProposal | null> =>
    new Promise((resolve) => {
      waiter = resolve;
      sock.write(JSON.stringify({ type: "fillRequest", v: PROTOCOL_VERSION, windowId: t.windowId, fieldKey: t.trigger }) + "\n");
      setTimeout(() => {
        if (waiter === resolve) {
          waiter = null;
          resolve(null);
        }
      }, 20_000);
    });

  for (let r = 0; r < rounds; r++) {
    for (const t of targets) {
      const p = await ask(t);
      if (p === null) errors.push(`round ${r} ${t.title}: no proposal`);
    }
  }
  sock.destroy();

}

interface Row {
  form: string;
  label: string;
  gold: string | null;
  value: string | null;
  confidence: number;
  outcome: string;
  source: string | null;
  withheld: string | null;
  asks: { value: string | null; confidence: number }[];
}
const rows: Row[] = [];
const requests: { form: string; trigger: "focus" | "request"; latencyMs: number; inputTokens: number; costUsd: number; candidates: number; fields: number }[] = [];
proposals.forEach((p, i) => {
  const t = targets.find((x) => x.windowId === p.windowId);
  if (t === undefined) return;
  requests.push({ form: t.title, trigger: i < fromFocus ? "focus" : "request", latencyMs: p.jev.latencyMs, inputTokens: p.jev.inputTokens, costUsd: p.jev.costUsd, candidates: p.candidates, fields: p.fields.length });
  for (const f of p.fields) {
    const g = t.goldByKey.get(f.key);
    if (g === undefined) continue;
    const outcome =
      f.value === g.gold ? "exact" : f.value === null ? "missed" : g.gold === null ? "wrong fill (gold none)" : "wrong fill";
    rows.push({
      form: t.title,
      label: g.label,
      gold: g.gold,
      value: f.value,
      confidence: f.confidence,
      outcome,
      source: f.source?.windowTitle ?? null,
      withheld: f.withheld,
      asks: f.asks.map((x) => ({ value: x.value, confidence: x.confidence })),
    });
  }
});

const count = (o: string): number => rows.filter((r) => r.outcome === o).length;
const lat = requests.map((r) => r.latencyMs).sort((x, y) => x - y);
const q = (p: number): number => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] ?? NaN;
const summary = {
  requests: requests.length,
  fromFocus,
  fieldJudgments: rows.length,
  exact: count("exact"),
  wrongFill: count("wrong fill") + count("wrong fill (gold none)"),
  missed: count("missed"),
  exactRate: rows.length === 0 ? 0 : count("exact") / rows.length,
  answerable: rows.filter((r) => r.gold !== null).length,
  answerableFilled: rows.filter((r) => r.gold !== null && r.value === r.gold).length,
  withheldDisagree: rows.filter((r) => r.withheld === "disagree").length,
  withheldLow: rows.filter((r) => r.withheld === "lowConfidence").length,
  cutoff: proposals[0]?.cutoff ?? null,
  latencyMs: { min: lat[0], median: q(0.5), p90: q(0.9), max: lat[lat.length - 1] },
  inputTokens: requests.reduce((s, r) => s + r.inputTokens, 0),
  costUsd: requests.reduce((s, r) => s + r.costUsd, 0),
  errors,
};
writeStoreJson(join(a.out, "fill-eval.json"), { summary, requests, rows }, 2);

const md: string[] = [];
md.push(`# Grounded fill on caret-fixture, live Jev`, "");
md.push(`${summary.requests} requests (${fromFocus} triggered by a focus event, the rest by fillRequest), ${summary.fieldJudgments} field judgments over ${targets.length} forms.`, "");
md.push(`| Measure | Value |`, `| --- | --- |`);
md.push(`| Exact match | ${summary.exact} of ${summary.fieldJudgments} (${(summary.exactRate * 100).toFixed(1)}%) |`);
md.push(`| Wrong fills | ${summary.wrongFill} |`);
md.push(`| Missed (no value proposed, gold had one) | ${summary.missed} |`);
md.push(`| Answerable fields filled correctly | ${summary.answerableFilled} of ${summary.answerable} (${((100 * summary.answerableFilled) / Math.max(1, summary.answerable)).toFixed(1)}%) |`);
md.push(`| Withheld: asks disagreed / under cutoff ${summary.cutoff} | ${summary.withheldDisagree} / ${summary.withheldLow} |`);
md.push(`| Latency per request, ms | min ${summary.latencyMs.min?.toFixed(0)}, median ${summary.latencyMs.median.toFixed(0)}, p90 ${summary.latencyMs.p90.toFixed(0)}, max ${summary.latencyMs.max?.toFixed(0)} |`);
md.push(`| Input tokens | ${summary.inputTokens} |`);
md.push(`| Spend | $${summary.costUsd.toFixed(5)} |`, "");
md.push(`| Form | Field | Gold | Proposed | Confidence | Outcome | Ask 1 | Ask 2 |`, `| --- | --- | --- | --- | --- | --- | --- | --- |`);
const seen = new Set<string>();
for (const r of rows) {
  const askText = (i: number): string => `${r.asks[i]?.value ?? "(none)"} ${r.asks[i]?.confidence.toFixed(2) ?? ""}`;
  const k = `${r.form}|${r.label}|${r.value}|${askText(0)}|${askText(1)}`;
  if (seen.has(k)) continue;
  seen.add(k);
  const n = rows.filter((x) => `${x.form}|${x.label}|${x.value}|${x.asks[0]?.value ?? "(none)"} ${x.asks[0]?.confidence.toFixed(2) ?? ""}|${x.asks[1]?.value ?? "(none)"} ${x.asks[1]?.confidence.toFixed(2) ?? ""}` === k).length;
  md.push(
    `| ${r.form.replace("Caret Fixture — ", "")} | ${r.label} | ${r.gold ?? "(none)"} | ${r.value ?? "(none)"} | ${r.confidence.toFixed(2)} | ${r.outcome}${r.withheld === null ? "" : ` (withheld: ${r.withheld})`}${n > 1 ? ` ×${n}` : ""} | ${askText(0)} | ${askText(1)} |`,
  );
}
if (errors.length > 0) md.push("", "Errors:", ...errors.map((e) => `- ${e}`));
writeStore(join(a.out, "fill-eval.md"), md.join("\n") + "\n");
console.log(md.slice(0, 14).join("\n"));
