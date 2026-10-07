// The B24 scoreboard: grounded fill on the real-form corpus (fixtures/realfill) with live Jev, headless. It
// replays the windows realfill-capture.ts recorded from Chrome and TextEdit into a fresh ScreenModel per form:
// the two shared decoy windows focused minutes ago, the form's source focused just before the form (the window
// the user just left), and the form focused on its first empty text field, as a person arrives at a form after
// reading their note. A memory source becomes the About entries proposeFill offers. Then one proposeFill per
// form, and every corpus field is scored against its expected value.
//
//   node scripts/realfill-eval.ts --out DIR [--windows FILE] [--forms a,b] [--spend-limit USD] [--seed N] [--page DIR]
//
// --page DIR (D2-04): each form as the page engine read it (DIR/<form id>.snapshot.json, from fixtures/web-form/accept.ts
// --sites) in place of the reader's recorded window, so selects, radios, boxes and dates are written where they can be.
//
// A field is right when the proposed value is the expected one (or one it accepts), wrong when a value is
// proposed that is not, missed when an expected value got none, and a correct blank when "none" or
// "handoff" got none. Wrong fills must be 0. The key is TYPESAFE_API_KEY from the environment or from
// CARET_ENV_FILE; it is never printed. Output holds synthetic corpus text only.
import { Disclosure } from "../src/privacy/disclosure.ts";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { proposeFill } from "../src/fill/fill.ts";
import { loadJevKey, makeJevClient, type AskJev } from "../src/fill/jev.ts";
import { heldAsConversation, heldToHalf, windowBudget } from "../src/privacy.ts";
import { collectCandidates, cutKinds } from "../src/fill/candidates.ts";
import { formInputs } from "../src/fill/fill.ts";
import { describeField } from "../src/fill/descriptor.ts";
import { fieldTerms } from "../src/fill/kinds.ts";
import { PageSnapshot, Snapshot, type FillField, type FillProposal, type Node } from "../src/protocol.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { EngineSession } from "../src/engines/session.ts";
import { rng } from "../test/large-scene.ts";
import { buildDesk, loadCorpus, nodesFor, T0, type CorpusField, type CorpusForm } from "./realfill-corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    corpus: { type: "string", default: join(here, "../../fixtures/realfill") },
    windows: { type: "string", default: join(here, "../fixtures/recorded/realfill-windows.ndjson") },
    forms: { type: "string" },
    "spend-limit": { type: "string", default: "0.30" },
    seed: { type: "string", default: "24" },
    /** Writes every Jev question and answer to this NDJSON file (synthetic corpus text only), for reading the checks. */
    "log-jev": { type: "string" },
    page: { type: "string" },
  },
});
if (a.out === undefined) throw new Error("--out is required");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const corpus = loadCorpus(resolve(a.corpus));
const snaps = readFileSync(resolve(a.windows), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
const only = a.forms === undefined ? null : new Set(a.forms.split(","));
const SPEND_LIMIT = Number(a["spend-limit"]);

let spent = 0;
let calls = 0;
const live = makeJevClient(loadJevKey);
const askJev: AskJev = async (req) => {
  if (spent >= SPEND_LIMIT) throw new Error(`spend limit $${SPEND_LIMIT} reached`);
  const r = await live(req);
  spent += r.costUsd;
  calls++;
  if (a["log-jev"] !== undefined) appendFileSync(a["log-jev"], JSON.stringify({ form: current, questions: Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, String(q.instructions).slice(0, 300)])), answers: r.answers }) + "\n");
  return r;
};
let current = "";

type Verdict = "right" | "wrong" | "missed" | "blank" | "unseen";
interface Scored {
  /** True when the proposed value is a hand-off (a control the user sets), not a write. A control a Fill all writes (D2-04, FillHandoff.writes) is a write. */
  handoff: boolean;
  label: string;
  control: string;
  expected: string;
  proposed: string | null;
  verdict: Verdict;
  /** Why an expected value got none: withheld's reason, "none" when Jev chose none, "notAsked", or "notInModel". */
  why: string | null;
}

function score(f: CorpusField, nodes: Node[], fields: readonly FillField[]): Scored {
  const keys = new Set(nodes.map((n) => n.key));
  const mine = fields.filter((x) => keys.has(x.key));
  // A text field's value is written by Caret; a control's (select, radio, checkbox, date, time) is handed to the user.
  const valueOf = (x: FillField): string | null => x.value ?? x.handoff?.value ?? null;
  const withValue = mine.filter((x) => valueOf(x) !== null);
  const proposed = withValue.length === 0 ? null : withValue.map(valueOf).join(" | ");
  const fillable = f.expected !== "none" && f.expected !== "handoff";
  const base = { handoff: withValue.some((x) => x.value === null && x.handoff?.writes !== true), label: f.label, control: f.control, expected: f.expected, proposed };
  if (proposed !== null) {
    const good = [f.expected, ...(f.accept ?? [])];
    return { ...base, verdict: fillable && withValue.length === 1 && good.includes(proposed) ? "right" : "wrong", why: null };
  }
  if (!fillable) return { ...base, verdict: "blank", why: null };
  if (mine.length === 0) return { ...base, verdict: nodes.length === 0 ? "unseen" : "missed", why: nodes.length === 0 ? "notFound" : "notInModel" };
  const x = mine[0] as FillField;
  return { ...base, verdict: "missed", why: x.withheld ?? (x.asks.length === 0 ? (x.control === "select" ? "noOptions" : "notAsked") : "none") };
}

/** How the privacy budget treated the form's source window: its budget, whether it was held to half, and whether a span of it did not fit. */
interface SourceCut {
  budget: number | null;
  half: boolean;
  cut: boolean;
  removedKinds: string[];
}
const results: { form: CorpusForm; proposal: FillProposal | null; error: string | null; scored: Scored[]; source: SourceCut }[] = [];

/** The form as the page engine read it, in the app of the reader's recorded window of it, or null without --page. */
function pageWindow(form: CorpusForm): Snapshot | null {
  if (a.page === undefined) return null;
  const file = join(resolve(a.page), `${form.id}.snapshot.json`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    process.stderr.write(`${form.id}: no page snapshot at ${file}; left out\n`);
    return null;
  }
  const recorded = snaps.find((s) => s.window.title === form.title || s.window.title.startsWith(`${form.title} - `));
  const browser = recorded?.app ?? { pid: 4100, bundleId: "com.google.chrome.for.testing", name: "Google Chrome for Testing" };
  const session = new EngineSession({ engine: "corpus", browser, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
  return toWindowSnapshot(PageSnapshot.parse(JSON.parse(raw)), session, 1);
}
for (const [fi, form] of corpus.forms.entries()) {
  if (only !== null && !only.has(form.id)) continue;
  const page = pageWindow(form);
  if (a.page !== undefined && page === null) continue;
  const { model, form: w, source: sw, trigger, about } = buildDesk(corpus, snaps, form, page ?? undefined);
  current = form.id;
  let proposal: FillProposal | null = null;
  let error: string | null = null;
  try {
    const r = rng(Number(a.seed) * 1000 + fi);
    proposal = await proposeFill(model, askJev, w.window.windowId, trigger.key, T0, { rand: (n) => Math.floor(r() * n), newId: () => `realfill-${form.id}`, about });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const scored = form.fields.map((f) => score(f, nodesFor(w, f), proposal?.fields ?? []));
  // The same generator run proposeFill made, without Jev, to say whether the budget cut the source itself.
  const terms = formInputs(w, trigger.key).map((x) => {
    const d = describeField(w, x.node);
    return fieldTerms([d.label, d.nearest, d.placeholder]);
  });
  const gen = collectCandidates(model, w.window.windowId, { now: T0, ledger: new Disclosure(model.windows.values()), fields: terms });
  const source: SourceCut = {
    budget: sw === null ? null : windowBudget(sw),
    half: sw !== null && (heldToHalf(sw) || heldAsConversation(sw)),
    cut: sw !== null && gen.cut.includes(sw.window.windowId),
    removedKinds: [...cutKinds(model, gen.cut, gen.candidates)],
  };
  results.push({ form, proposal, error, scored, source });
  const n = (v: Verdict) => scored.filter((s) => s.verdict === v).length;
  process.stderr.write(`${form.id}: right ${n("right")}, wrong ${n("wrong")}, missed ${n("missed")}, blank ${n("blank")}, unseen ${n("unseen")}${error === null ? "" : `; error: ${error}`}\n`);
}

// MARK: - report

const all = results.flatMap((r) => r.scored);
const count = (xs: readonly Scored[], v: Verdict) => xs.filter((s) => s.verdict === v).length;
const fillable = (xs: readonly Scored[]) => xs.filter((s) => s.expected !== "none" && s.expected !== "handoff").length;
/** Fields given a value Caret writes, right or wrong; and fields given one the user sets. */
const written = (xs: readonly Scored[]) => xs.filter((s) => s.proposed !== null && !s.handoff).length;
const handed = (xs: readonly Scored[]) => xs.filter((s) => s.proposed !== null && s.handoff).length;
const md: string[] = [
  "# Real-form scoreboard (B24)",
  "",
  `Windows: ${a.windows}. Jev calls ${calls}, $${spent.toFixed(4)}. Seed ${a.seed}.`,
  "",
  "| form | source | fillable | right | written | handed off | wrong | missed | correct blanks | not found | source budget | source cut | kinds cut |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...results.map(
    (r) =>
      `| ${r.form.id} | ${r.form.source.kind} | ${fillable(r.scored)} | ${count(r.scored, "right")} | ${written(r.scored)} | ${handed(r.scored)} | ${count(r.scored, "wrong")} | ${count(r.scored, "missed")} | ${count(r.scored, "blank")} | ${count(r.scored, "unseen")} | ${r.source.budget ?? ""}${r.source.half ? " (half)" : ""} | ${r.source.cut ? "yes" : "no"} | ${r.source.removedKinds.join(", ")} |`,
  ),
  `| **all** | | ${fillable(all)} | ${count(all, "right")} | ${written(all)} | ${handed(all)} | ${count(all, "wrong")} | ${count(all, "missed")} | ${count(all, "blank")} | ${count(all, "unseen")} | | ${results.filter((r) => r.source.cut).length} cut | |`,
  "",
  "Written: fields given a value Caret writes in the form's one Fill all (text, and in a page the engine owns its controls); handed off: a value the user sets.",
  "",
  `Right values Caret writes: ${all.filter((s) => s.verdict === "right" && !s.handoff).length}; right values handed to the user (a select, radio, box, date or time): ${all.filter((s) => s.verdict === "right" && s.handoff).length}.`,
  "",
  "Why expected values were missed:",
  "",
  ...Object.entries(
    all
      .filter((s) => s.verdict === "missed" || s.verdict === "unseen")
      .reduce<Record<string, number>>((acc, s) => {
        const k = `${s.control}: ${s.why ?? "?"}`;
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
  )
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `- ${k}: ${v}`),
  "",
  "## Wrong fills",
  "",
  ...(all.some((s) => s.verdict === "wrong") ? results.flatMap((r) => r.scored.filter((s) => s.verdict === "wrong").map((s) => `- ${r.form.id} / ${s.label}: proposed '${s.proposed}', expected '${s.expected}'`)) : ["None."]),
  "",
  "## Per field",
  "",
  ...results.flatMap((r) => [
    `### ${r.form.id}${r.error === null ? "" : ` (error: ${r.error})`}`,
    "",
    "| field | control | expected | proposed | verdict | why |",
    "|---|---|---|---|---|---|",
    ...r.scored.map((s) => `| ${s.label} | ${s.control} | ${s.expected} | ${s.proposed ?? ""} | ${s.verdict} | ${s.why ?? ""} |`),
    "",
  ]),
];
writeFileSync(join(OUT, "realfill-eval.md"), md.join("\n") + "\n");
writeFileSync(join(OUT, "realfill-eval.json"), JSON.stringify({ calls, spent, results: results.map((r) => ({ form: r.form.id, error: r.error, scored: r.scored, proposal: r.proposal })) }, null, 1) + "\n");
process.stderr.write(`wrote ${join(OUT, "realfill-eval.md")}; all: right ${count(all, "right")}/${fillable(all)}, wrong ${count(all, "wrong")}; $${spent.toFixed(4)}\n`);
