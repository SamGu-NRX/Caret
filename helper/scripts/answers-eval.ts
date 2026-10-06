// S1: saved answers on a blind corpus (fixtures/answers/corpus.json, written by an agent that never saw this code):
// 12 saved answers of one synthetic applicant across 3 organizations, and 20 prose fields from application forms, each
// with the answer it should get or "none", and the answer the guards must withhold and why.
//
//   node scripts/answers-eval.ts --out DIR --jev oracle|live [--passes 3] [--max-usd 0.05]
//
//   oracle  Jev picks the corpus's own answer for each field (the expected one, else the one it expects withheld), so
//           the run measures the code: the guards and the plumbing, not the match.
//   live    asks Jev; needs CARET_ENV_FILE (the key is read from it, never printed) and stops before spending more than
//           --max-usd.
//
// Each page of the corpus becomes one page window holding its prose fields, and fill runs once per page, as a focus in
// its first field would. Per field the outcome is one of:
//   right     the expected answer (or one the corpus also accepts) offered; or nothing offered where the corpus
//             expects nothing;
//   withheld  an answer matched and the guards withheld it for the reason the corpus gives;
//   missed    the corpus expects an answer and none was offered (withheld for another reason, or not matched);
//   wrong     an answer offered that the corpus does not accept. The bar is 0.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ScreenModel } from "../src/model.ts";
import { FillError, proposeFill } from "../src/fill/fill.ts";
import { loadJevKey, makeJevClient, type AskJev, type JevRequest } from "../src/fill/jev.ts";
import type { SavedAnswer } from "../src/memory/answers.ts";
import { questionExcerpt } from "../src/fill/answers.ts";
import { PROTOCOL_VERSION, type FillField, type FillProposal, type Node } from "../src/protocol.ts";
import { positiveInt, positiveNumber } from "./flags.ts";

interface CorpusAnswer {
  id: string;
  org: string;
  question: string;
  answer: string;
  site: string;
  form: string;
}
interface CorpusField {
  id: string;
  page: { title: string; site: string; headings: string[] };
  control: "textarea" | "text";
  label: string;
  placeholder: string | null;
  nearby: string | null;
  maxLength: number | null;
  expect: string;
  alsoOk: string[];
  withheld: { answer: string; why: "otherOrganization" | "tooLong" } | null;
  trap: string | null;
}

const a = parseArgs({
  options: {
    corpus: { type: "string", default: fileURLToPath(new URL("../fixtures/answers/corpus.json", import.meta.url)) },
    out: { type: "string" },
    jev: { type: "string", default: "oracle" },
    passes: { type: "string", default: "1" },
    "max-usd": { type: "string", default: "0.05" },
  },
}).values;
if (a.out === undefined) throw new Error("--out DIR is required");
if (a.jev !== "oracle" && a.jev !== "live") throw new Error("--jev is oracle or live");
const MAX_USD = positiveNumber("max-usd", a["max-usd"]);
const PASSES = positiveInt("passes", a.passes);
const out = resolve(a.out);
mkdirSync(out, { recursive: true });

const corpus = JSON.parse(readFileSync(a.corpus, "utf8")) as { answers: CorpusAnswer[]; fields: CorpusField[] };
const saved: SavedAnswer[] = corpus.answers.map((x) => ({ id: x.id, status: "active", fields: { question: x.question, answer: x.answer, site: x.site, form: x.form, savedOn: "2026-10-01T12:00:00.000Z" } }));
const CHROME = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };

/** The corpus's answer for a field, for the oracle: the expected one, else the one it expects withheld, else none. */
const oracleAnswer = (f: CorpusField): string | null => (f.expect !== "none" ? f.expect : (f.withheld?.answer ?? null));

/** Which corpus field a question is about: its label's opening is in the field's descriptor, which the question quotes. */
const fieldOf = (fields: CorpusField[], instructions: string): CorpusField | undefined => fields.find((f) => instructions.includes(f.label.slice(0, 40)));

let spent = 0;
let tokens = 0;
const live = a.jev === "live" ? makeJevClient(loadJevKey) : null;
const requests: { page: string; pass: number; questions: number; inputTokens: number; costUsd: number }[] = [];

function askFor(fields: CorpusField[], page: string, pass: number): AskJev {
  return async (req: JevRequest) => {
    if (live !== null) {
      if (spent >= MAX_USD) throw new Error(`stopping: $${spent.toFixed(5)} spent, the cap is $${MAX_USD}`);
      const r = await live(req);
      spent += r.costUsd;
      tokens += r.inputTokens;
      requests.push({ page, pass, questions: Object.keys(req.questions).length, inputTokens: r.inputTokens, costUsd: r.costUsd });
      return r;
    }
    const answers = Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        const f = id.endsWith("_answer") ? fieldOf(fields, String(q.instructions)) : undefined;
        const want = f === undefined ? null : oracleAnswer(f);
        const c = corpus.answers.find((x) => x.id === want);
        const hit = c === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => d?.includes(`question "${questionExcerpt(c.question)}"`));
        return [id, { choice: hit?.[0] ?? "none", confidence: 0.9 }];
      }),
    );
    return { model: "oracle", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };
}

/** A page window holding the page's prose fields, each under the text near it, in the corpus's order. */
function pageModel(fields: CorpusField[], windowId: string): ScreenModel {
  const p = (fields[0] as CorpusField).page;
  const nodes: Node[] = [{ key: "frame-0", parent: null, role: "AXWebArea", label: p.title }];
  fields.forEach((f, i) => {
    const y = 80 + i * 160;
    if (f.nearby !== null) nodes.push({ key: `near-${f.id}`, parent: "frame-0", role: "AXStaticText", label: f.nearby, frame: [10, y - 40, 600, 20] });
    nodes.push({
      key: `form/textbox:${f.id}~0`,
      parent: "frame-0",
      role: f.control === "textarea" ? "AXTextArea" : "AXTextField",
      label: f.label,
      ...(f.placeholder === null ? {} : { placeholder: f.placeholder }),
      editable: true,
      frame: [10, y, 600, f.control === "textarea" ? 120 : 24],
      ...(f.maxLength === null ? {} : { maxLength: f.maxLength }),
    });
  });
  const model = new ScreenModel();
  model.apply({ type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at: 1000, reason: "request", app: CHROME, window: { windowId, kind: "page", title: p.title, frame: null }, focused: true, root: null, nodes, values: [], focusedKey: nodes.find((n) => n.editable === true)?.key ?? null, stats: { walkMs: 0, visited: nodes.length, truncated: false } });
  return model;
}

type Outcome = "right" | "withheld" | "missed" | "wrong";
interface Row {
  pass: number;
  field: string;
  trap: string | null;
  expect: string;
  got: string;
  withheld: string | null;
  says: string | null;
  outcome: Outcome;
}

function judge(f: CorpusField, x: FillField | undefined, pass: number): Row {
  const offered = x?.answer !== undefined && x.answer.withheld === null ? x.answer.id : null;
  const held = x?.answer?.withheld ?? null;
  const base = { pass, field: f.id, trap: f.trap, expect: f.withheld === null ? f.expect : `none (withhold ${f.withheld.answer}: ${f.withheld.why})`, says: held?.says ?? null };
  // A field fill left out of its question (its label did not fit the page's privacy budget) is "not asked".
  const got = x === undefined ? "not asked (budget)" : (offered ?? (held !== null ? `withheld ${x.answer?.id}` : `none${x.withheld == null ? "" : ` (${x.withheld})`}`));
  const ok = (id: string): boolean => id === f.expect || f.alsoOk.includes(id);
  let outcome: Outcome;
  if (offered !== null) outcome = ok(offered) ? "right" : "wrong";
  else if (held !== null && f.withheld !== null && held.why === f.withheld.why) outcome = "withheld";
  else if (f.expect !== "none") outcome = "missed";
  else outcome = "right";
  return { ...base, got, withheld: held?.why ?? null, outcome };
}

const rows: Row[] = [];
const pages = new Map<string, CorpusField[]>();
for (const f of corpus.fields) pages.set(`${f.page.title}\u0000${f.page.site}`, [...(pages.get(`${f.page.title}\u0000${f.page.site}`) ?? []), f]);
for (let pass = 1; pass <= PASSES; pass++) {
  let i = 0;
  for (const fields of pages.values()) {
    const windowId = `page-eval-${++i}`;
    const model = pageModel(fields, windowId);
    const trigger = `form/textbox:${(fields[0] as CorpusField).id}~0`;
    let p: FillProposal;
    try {
      p = await proposeFill(model, askFor(fields, (fields[0] as CorpusField).page.title, pass), windowId, trigger, 2000, { answers: saved, page: { site: (fields[0] as CorpusField).page.site, headings: (fields[0] as CorpusField).page.headings } });
    } catch (e) {
      // Fill itself refused the page (the focused field's label did not fit the page's privacy budget): nothing was asked.
      if (!(e instanceof FillError)) throw e;
      for (const f of fields) rows.push({ ...judge(f, undefined, pass), got: `not asked (${e.why})` });
      continue;
    }
    for (const f of fields) rows.push(judge(f, p.fields.find((x) => x.key === `form/textbox:${f.id}~0`), pass));
  }
}

const count = (o: Outcome, pass?: number): number => rows.filter((r) => r.outcome === o && (pass === undefined || r.pass === pass)).length;
const lines = [
  `# Saved answers, ${a.jev} Jev, ${PASSES} pass${PASSES === 1 ? "" : "es"} over ${corpus.fields.length} fields`,
  "",
  "| pass | right | withheld, correct reason | missed | wrong |",
  "| --- | --- | --- | --- | --- |",
  ...Array.from({ length: PASSES }, (_, k) => `| ${k + 1} | ${count("right", k + 1)} | ${count("withheld", k + 1)} | ${count("missed", k + 1)} | ${count("wrong", k + 1)} |`),
  "",
  live === null ? "No Jev requests (oracle)." : `Jev: ${requests.length} requests, ${tokens} input tokens, $${spent.toFixed(5)} (cap $${MAX_USD}).`,
  "",
  "| pass | field | expected | got | outcome | why withheld |",
  "| --- | --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.pass} | ${r.field} | ${r.expect} | ${r.got} | ${r.outcome} | ${r.says ?? ""} |`),
];
writeFileSync(resolve(out, "report.md"), `${lines.join("\n")}\n`);
writeFileSync(resolve(out, "rows.json"), JSON.stringify({ rows, requests, spentUsd: spent, inputTokens: tokens }, null, 2));
console.log(lines.slice(0, 6 + PASSES + 2).join("\n"));
if (count("wrong") > 0) process.exitCode = 1;
