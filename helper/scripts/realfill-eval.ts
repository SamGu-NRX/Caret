// The B24 scoreboard: grounded fill on the real-form corpus (fixtures/realfill) with live Jev, headless. It
// replays the windows realfill-capture.ts recorded from Chrome and TextEdit into a fresh ScreenModel per form:
// the two shared decoy windows focused minutes ago, the form's source focused just before the form (the window
// the user just left), and the form focused on its first empty text field, as a person arrives at a form after
// reading their note. A memory source becomes the About entries proposeFill offers. Then one proposeFill per
// form, and every corpus field is scored against its expected value.
//
//   node scripts/realfill-eval.ts --out DIR [--windows FILE] [--forms a,b] [--spend-limit USD] [--seed N]
//
// A field is right when the proposed value is the expected one (or one it accepts), wrong when a value is
// proposed that is not, missed when an expected value got none, and a correct blank when "none" or
// "handoff" got none. Wrong fills must be 0. The key is TYPESAFE_API_KEY from the environment or from
// CARET_ENV_FILE; it is never printed. Output holds synthetic corpus text only.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { aboutKind, type AboutValue } from "../src/fill/about.ts";
import { loadJevKey, makeJevClient, type AskJev } from "../src/fill/jev.ts";
import { forgetWindows } from "../src/privacy.ts";
import { Snapshot, type FillField, type FillProposal, type Node } from "../src/protocol.ts";
import { rng } from "../test/large-scene.ts";
import { loadCorpus, type CorpusField, type CorpusForm, type CorpusSource } from "./realfill-corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    corpus: { type: "string", default: join(here, "../../fixtures/realfill") },
    windows: { type: "string", default: join(here, "../fixtures/recorded/realfill-windows.ndjson") },
    forms: { type: "string" },
    "spend-limit": { type: "string", default: "0.30" },
    seed: { type: "string", default: "24" },
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
const live = makeJevClient(() => loadJevKey());
const askJev: AskJev = async (req) => {
  if (spent >= SPEND_LIMIT) throw new Error(`spend limit $${SPEND_LIMIT} reached`);
  const r = await live(req);
  spent += r.costUsd;
  calls++;
  return r;
};

/** The recorded window a source or form is shown in: by its page title, note file name or mail subject. */
function windowOf(title: string): Snapshot {
  const hits = snaps.filter((s) => s.window.title === title || s.window.title.startsWith(`${title} - `));
  if (hits.length !== 1) throw new Error(`${hits.length} recorded windows are titled '${title}'`);
  return hits[0] as Snapshot;
}
const sourceWindow = (s: CorpusSource): Snapshot | null => (s.kind === "memory" ? null : windowOf(s.title ?? ""));

/** Required markers, a trailing colon and "(optional)" are not part of what a label says. */
export const normLabel = (s: string): string =>
  s
    .replace(/\((?:required|optional)\)/gi, "")
    .replace(/[*:]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** The nodes a corpus field is: the control whose label is the field's, or for a radio group its option buttons. */
function nodesFor(w: WindowState, f: CorpusField): Node[] {
  const want = normLabel(f.label);
  const nodes = [...w.nodes.values()];
  if (f.control === "radio") {
    const group = nodes.find((n) => n.subrole === "AXFieldset" && normLabel(n.label ?? "") === want);
    return group === undefined ? [] : nodes.filter((n) => n.parent === group.key && n.role === "AXRadioButton");
  }
  const roles: Record<string, readonly string[]> = {
    select: ["AXPopUpButton"],
    checkbox: ["AXCheckBox"],
    date: ["AXDateField"],
    time: ["AXTimeField"],
    combobox: ["AXComboBox"],
    file: ["AXButton", "AXGroup"],
  };
  const ok = roles[f.control] ?? ["AXTextField", "AXTextArea"];
  const groupKey = f.group === undefined ? null : (nodes.find((n) => n.subrole === "AXFieldset" && normLabel(n.label ?? "") === normLabel(f.group ?? ""))?.key ?? null);
  return nodes.filter((n) => ok.includes(n.role) && normLabel(n.label ?? "") === want && (groupKey === null || n.parent === groupKey));
}

type Verdict = "right" | "wrong" | "missed" | "blank" | "unseen";
interface Scored {
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
  const withValue = mine.filter((x) => x.value !== null);
  const proposed = withValue.length === 0 ? null : withValue.map((x) => x.value).join(" | ");
  const fillable = f.expected !== "none" && f.expected !== "handoff";
  const base = { label: f.label, control: f.control, expected: f.expected, proposed };
  if (proposed !== null) {
    const good = [f.expected, ...(f.accept ?? [])];
    return { ...base, verdict: fillable && withValue.length === 1 && good.includes(proposed) ? "right" : "wrong", why: null };
  }
  if (!fillable) return { ...base, verdict: "blank", why: null };
  if (mine.length === 0) return { ...base, verdict: nodes.length === 0 ? "unseen" : "missed", why: nodes.length === 0 ? "notFound" : "notInModel" };
  const x = mine[0] as FillField;
  return { ...base, verdict: "missed", why: x.withheld ?? (x.asks.length === 0 ? "notAsked" : "none") };
}

const T0 = 1_800_000_000_000;
const results: { form: CorpusForm; proposal: FillProposal | null; error: string | null; scored: Scored[] }[] = [];
for (const [fi, form] of corpus.forms.entries()) {
  if (only !== null && !only.has(form.id)) continue;
  forgetWindows();
  const model = new ScreenModel();
  const put = (s: Snapshot, at: number, focusedKey: string | null = null): void => {
    model.apply({ ...s, at, focused: true, focusedKey });
  };
  corpus.decoys.forEach((d, i) => {
    const s = sourceWindow(d);
    if (s !== null) put(s, T0 - 600_000 + i * 60_000);
  });
  const src = sourceWindow(form.source);
  if (src !== null) put(src, T0 - 30_000);
  const formSnap = windowOf(form.title);
  const trigger = formSnap.nodes.find((n) => n.editable === true && (n.role === "AXTextField" || n.role === "AXTextArea") && (n.value ?? "") === "" && n.parent !== null && !n.key.includes("address and search bar"));
  if (trigger === undefined) throw new Error(`form ${form.id} has no empty text field to start from`);
  put(formSnap, T0, trigger.key);
  const w = model.windows.get(formSnap.window.windowId) as WindowState;
  const about: AboutValue[] =
    form.source.kind === "memory"
      ? form.source.about.flatMap((x, i) => {
          const kind = aboutKind(x.label, x.value);
          return kind === null ? [] : [{ id: `about-${i + 1}`, label: x.label, value: x.value, kind }];
        })
      : [];
  let proposal: FillProposal | null = null;
  let error: string | null = null;
  try {
    const r = rng(Number(a.seed) * 1000 + fi);
    proposal = await proposeFill(model, askJev, formSnap.window.windowId, trigger.key, T0, { rand: (n) => Math.floor(r() * n), newId: () => `realfill-${form.id}`, about });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const scored = form.fields.map((f) => score(f, nodesFor(w, f), proposal?.fields ?? []));
  results.push({ form, proposal, error, scored });
  const n = (v: Verdict) => scored.filter((s) => s.verdict === v).length;
  process.stderr.write(`${form.id}: right ${n("right")}, wrong ${n("wrong")}, missed ${n("missed")}, blank ${n("blank")}, unseen ${n("unseen")}${error === null ? "" : `; error: ${error}`}\n`);
}

// MARK: - report

const all = results.flatMap((r) => r.scored);
const count = (xs: readonly Scored[], v: Verdict) => xs.filter((s) => s.verdict === v).length;
const fillable = (xs: readonly Scored[]) => xs.filter((s) => s.expected !== "none" && s.expected !== "handoff").length;
const md: string[] = [
  "# Real-form scoreboard (B24)",
  "",
  `Windows: ${a.windows}. Jev calls ${calls}, $${spent.toFixed(4)}. Seed ${a.seed}.`,
  "",
  "| form | source | fillable | right | wrong | missed | correct blanks | not found |",
  "|---|---|---|---|---|---|---|---|",
  ...results.map((r) => `| ${r.form.id} | ${r.form.source.kind} | ${fillable(r.scored)} | ${count(r.scored, "right")} | ${count(r.scored, "wrong")} | ${count(r.scored, "missed")} | ${count(r.scored, "blank")} | ${count(r.scored, "unseen")} |`),
  `| **all** | | ${fillable(all)} | ${count(all, "right")} | ${count(all, "wrong")} | ${count(all, "missed")} | ${count(all, "blank")} | ${count(all, "unseen")} |`,
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
