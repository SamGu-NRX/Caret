// W4: grounded fill on real application forms, offline. It replays page walks saved by the read-only real-site pass
// (fixtures/web-form/accept.ts --sites writes <site>.snapshot.json) through the page link's window snapshot, with a
// synthetic note focused just before the form, as a person arrives at a form after reading their note. Then one
// proposeFill per form with live Jev, and every field in the answer key is scored as B24's scoreboard scores it
// (scripts/realfill-eval.ts): right when the proposed value is the expected one (or one it accepts), wrong when a value
// is proposed that is not, missed when an expected value got none, and a correct blank when "none" got none.
//
//   node scripts/page-replay-eval.ts --dir DIR --key FILE --note FILE --out DIR [--spend-limit USD] [--seed N]
//
// The key file: { "sites": { "<site>": [{ "label": "...", "expected": "...", "accept": ["..."] }] } }; a label names a
// page control as the model shows it (a radio or Yes/No question by its question). Wrong fills must be 0. The Jev key
// is TYPESAFE_API_KEY from the environment or CARET_ENV_FILE and is never printed. The snapshots hold public form
// labels only; the note and every value are invented.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as z from "zod";
import { ScreenModel } from "../src/model.ts";
import { forgetWindows } from "../src/privacy.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { loadJevKey, makeJevClient, storableRequest, type AskJev } from "../src/fill/jev.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { EngineSession } from "../src/engines/session.ts";
import { PageSnapshot, PROTOCOL_VERSION, type FillField, type Node, type Snapshot } from "../src/protocol.ts";
import { rng } from "../test/large-scene.ts";
import { normLabel, T0 } from "./realfill-corpus.ts";

const { values: a } = parseArgs({
  options: {
    dir: { type: "string" },
    key: { type: "string" },
    note: { type: "string" },
    out: { type: "string" },
    "spend-limit": { type: "string", default: "0.10" },
    seed: { type: "string", default: "4" },
    "log-jev": { type: "string" },
  },
});
if (a.dir === undefined || a.key === undefined || a.note === undefined || a.out === undefined) throw new Error("--dir, --key, --note and --out are required");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const SPEND_LIMIT = Number(a["spend-limit"]);

const Key = z.object({ sites: z.record(z.string(), z.array(z.object({ label: z.string(), expected: z.string(), accept: z.array(z.string()).optional() }).strict())) }).strict();
const key = Key.parse(JSON.parse(readFileSync(resolve(a.key), "utf8")));
const noteText = readFileSync(resolve(a.note), "utf8");

let spent = 0;
let calls = 0;
let current = "";
const live = makeJevClient(loadJevKey);
const askJev: AskJev = async (req) => {
  if (spent >= SPEND_LIMIT) throw new Error(`spend limit $${SPEND_LIMIT} reached`);
  const r = await live(req);
  spent += r.costUsd;
  calls++;
  if (a["log-jev"] !== undefined) appendFileSync(a["log-jev"], `${JSON.stringify({ site: current, questions: storableRequest(req, Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, String(q.instructions).slice(0, 300)]))), answers: r.answers })}\n`);
  return r;
};

const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
const session = new EngineSession({ engine: "replay", browser: chrome, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
const textEdit = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };

/** The note as TextEdit shows it through the reader (the shape of B24's recorded windows): one text area holding it all. */
function noteWindow(): Snapshot {
  const nodes: Node[] = [{ key: "com.apple.TextEdit/standard/textarea:~0", parent: null, role: "AXTextArea", value: noteText, editable: true }];
  return { type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at: T0 - 30_000, reason: "initial", app: textEdit, window: { windowId: "note", kind: "standard", title: "Application details.txt", frame: [0, 0, 700, 500] }, focused: true, root: null, nodes, values: [], focusedKey: null, stats: { walkMs: 0, visited: 1, truncated: false } };
}

type Verdict = "right" | "wrong" | "missed" | "blank" | "unseen";
interface Scored {
  label: string;
  expected: string;
  proposed: string | null;
  handoff: boolean;
  verdict: Verdict;
  why: string | null;
}

/** The nodes a key label names: a control labelled so, or a radio or Yes/No question's group and its buttons. */
function nodesFor(nodes: readonly Node[], label: string): Node[] {
  const want = normLabel(label);
  const hits = nodes.filter((n) => n.role !== "AXWebArea" && n.role !== "AXMenuItem" && n.role !== "AXRadioButton" && normLabel(n.label ?? "") === want);
  return [...hits, ...nodes.filter((n) => n.role === "AXRadioButton" && hits.some((h) => h.key === n.parent))];
}

function score(k: { label: string; expected: string; accept?: string[] | undefined }, nodes: Node[], fields: readonly FillField[]): Scored {
  const keys = new Set(nodes.map((n) => n.key));
  const mine = fields.filter((x) => keys.has(x.key));
  const valueOf = (x: FillField): string | null => x.value ?? x.handoff?.value ?? null;
  const withValue = mine.filter((x) => valueOf(x) !== null);
  const proposed = withValue.length === 0 ? null : withValue.map(valueOf).join(" | ");
  const fillable = k.expected !== "none";
  // A control a Fill all writes (D2-04, FillHandoff.writes) is a write, not a hand-off.
  const base = { label: k.label, expected: k.expected, proposed, handoff: withValue.some((x) => x.value === null && x.handoff?.writes !== true) };
  const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  if (proposed !== null) {
    const good = [k.expected, ...(k.accept ?? [])].map(norm);
    return { ...base, verdict: fillable && withValue.length === 1 && good.includes(norm(proposed)) ? "right" : "wrong", why: null };
  }
  if (!fillable) return { ...base, verdict: "blank", why: null };
  if (nodes.length === 0) return { ...base, verdict: "unseen", why: "notInModel" };
  const x = mine[0];
  return { ...base, verdict: "missed", why: x === undefined ? "notAsked" : (x.withheld ?? (x.asks.length === 0 ? "notAsked" : "none")) };
}

const results: { site: string; scored: Scored[]; error: string | null }[] = [];
for (const [i, [site, fieldsKey]] of Object.entries(key.sites).entries()) {
  current = site;
  const page = PageSnapshot.parse(JSON.parse(readFileSync(join(resolve(a.dir), `${site}.snapshot.json`), "utf8")));
  const win = toWindowSnapshot(page, session, 1);
  forgetWindows();
  const model = new ScreenModel();
  model.apply(noteWindow());
  const trigger = win.nodes.find((n) => n.editable === true && (n.role === "AXTextField" || n.role === "AXTextArea") && (n.value ?? "") === "");
  if (trigger === undefined) throw new Error(`${site} has no empty text field to start from`);
  model.apply({ ...win, at: T0, focused: true, focusedKey: trigger.key });
  model.frontmostPid = chrome.pid;
  let error: string | null = null;
  let fields: readonly FillField[] = [];
  try {
    const r = rng(Number(a.seed) * 1000 + i);
    const p = await proposeFill(model, askJev, win.window.windowId, trigger.key, T0, { rand: (n) => Math.floor(r() * n), newId: () => `replay-${site}` });
    fields = p.fields;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const nodes = [...(model.windows.get(win.window.windowId)?.nodes.values() ?? [])];
  const scored = fieldsKey.map((k) => score(k, nodesFor(nodes, k.label), fields));
  results.push({ site, scored, error });
  const n = (v: Verdict) => scored.filter((s) => s.verdict === v).length;
  process.stderr.write(`${site}: right ${n("right")}, wrong ${n("wrong")}, missed ${n("missed")}, blank ${n("blank")}, unseen ${n("unseen")}${error === null ? "" : `; error: ${error}`}\n`);
}

const all = results.flatMap((r) => r.scored);
const count = (xs: readonly Scored[], v: Verdict) => xs.filter((s) => s.verdict === v).length;
const fillable = (xs: readonly Scored[]) => xs.filter((s) => s.expected !== "none").length;
/** Fields given a value Caret writes, right or wrong; and fields given one the user sets. */
const written = (xs: readonly Scored[]) => xs.filter((s) => s.proposed !== null && !s.handoff).length;
const handed = (xs: readonly Scored[]) => xs.filter((s) => s.proposed !== null && s.handoff).length;
const md = [
  "# Real-site fill replay (W4)",
  "",
  `Snapshots: ${a.dir}. Jev calls ${calls}, $${spent.toFixed(4)}. Seed ${a.seed}.`,
  "",
  "| site | fillable | right | written | handed off | wrong | missed | correct blanks | not in model |",
  "|---|---|---|---|---|---|---|---|---|",
  ...results.map((r) => `| ${r.site}${r.error === null ? "" : ` (error: ${r.error})`} | ${fillable(r.scored)} | ${count(r.scored, "right")} | ${written(r.scored)} | ${handed(r.scored)} | ${count(r.scored, "wrong")} | ${count(r.scored, "missed")} | ${count(r.scored, "blank")} | ${count(r.scored, "unseen")} |`),
  `| **all** | ${fillable(all)} | ${count(all, "right")} | ${written(all)} | ${handed(all)} | ${count(all, "wrong")} | ${count(all, "missed")} | ${count(all, "blank")} | ${count(all, "unseen")} |`,
  "",
  "Written: fields given a value Caret writes in the form's one Fill all; handed off: a value the user sets.",
  "",
  `Right values Caret writes: ${all.filter((s) => s.verdict === "right" && !s.handoff).length}; right values handed to the user (a select, radio, Yes/No question or dropdown): ${all.filter((s) => s.verdict === "right" && s.handoff).length}.`,
  "",
  "## Wrong fills",
  "",
  ...(all.some((s) => s.verdict === "wrong") ? results.flatMap((r) => r.scored.filter((s) => s.verdict === "wrong").map((s) => `- ${r.site} / ${s.label}: proposed '${s.proposed}', expected '${s.expected}'`)) : ["None."]),
  "",
  "## Per field",
  "",
  ...results.flatMap((r) => [`### ${r.site}`, "", "| field | expected | proposed | verdict | why |", "|---|---|---|---|---|", ...r.scored.map((s) => `| ${s.label.slice(0, 90)} | ${s.expected} | ${s.proposed ?? ""} | ${s.verdict} | ${s.why ?? ""} |`), ""]),
];
writeFileSync(join(OUT, "page-replay.md"), `${md.join("\n")}\n`);
writeFileSync(join(OUT, "page-replay.json"), `${JSON.stringify({ calls, spent, results }, null, 1)}\n`);
process.stderr.write(`wrote ${join(OUT, "page-replay.md")}; all: right ${count(all, "right")}/${fillable(all)}, wrong ${count(all, "wrong")}; $${spent.toFixed(4)}\n`);
