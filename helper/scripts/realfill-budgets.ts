// What the privacy ledger lets fill take from each corpus form's source window, offline: the same generator run
// proposeFill makes (no Jev), on the replayed desk (realfill-corpus.ts buildDesk). For each form it reports the
// source's characters, its budget, what the generator's takes charged it, whether the budget cut it, how many candidates came
// from the source, and how many of its labelled values ("Label: value" lines) went into the question.
//
//   node scripts/realfill-budgets.ts --out FILE.md
import { writeStore } from "../src/privacy/send.ts";
import { Disclosure } from "../src/privacy/disclosure.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { collectCandidates, labelledLines, setGeneratorClock } from "../src/fill/candidates.ts";
import { describeField } from "../src/fill/descriptor.ts";
import { formInputs } from "../src/fill/fill.ts";
import { fieldTerms } from "../src/fill/kinds.ts";
import { windowBudget } from "../src/privacy.ts";
import { Snapshot } from "../src/protocol.ts";
import type { WindowState } from "../src/model.ts";
import { buildDesk, loadCorpus, T0 } from "./realfill-corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    corpus: { type: "string", default: join(here, "../../fixtures/realfill") },
    windows: { type: "string", default: join(here, "../fixtures/recorded/realfill-windows.ndjson") },
  },
});
if (a.out === undefined) throw new Error("--out is required");
// The generator's time budget reads a fixed clock, so a cold first form is not stopped partway (it was: the
// first three forms of one run offered half their candidates).
setGeneratorClock(() => 0);
const corpus = loadCorpus(resolve(a.corpus));
const snaps = readFileSync(resolve(a.windows), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));

/** A window's distinct lines' characters, read as privacy.test.ts reads them. */
function chars(w: WindowState): number {
  const seen = new Set<string>();
  for (const raw of [w.window.title, ...[...w.nodes.values()].flatMap((n) => [n.label, n.value, n.placeholder])]) {
    if (raw === undefined) continue;
    for (const l of raw.split("\n")) {
      const t = l.replace(/\s+/g, " ").trim();
      if (t !== "") seen.add(t);
    }
  }
  const lines = [...seen];
  return lines.reduce((n, l) => n + l.length, 0);
}

const rows: string[] = [];
for (const form of corpus.forms) {
  const desk = buildDesk(corpus, snaps, form);
  const sw = desk.source;
  if (sw === null) continue;
  const terms = formInputs(desk.form, desk.trigger.key).map((x) => {
    const d = describeField(desk.form, x.node);
    return fieldTerms([d.label, d.nearest, d.placeholder]);
  });
  const ledger = new Disclosure(desk.model);
  const gen = collectCandidates(desk.model, desk.form.window.windowId, { now: T0, ledger, fields: terms });
  const c = chars(sw);
  const offered = new Set(gen.candidates.filter((x) => x.source.windowId === sw.window.windowId).map((x) => x.text));
  const labelled = labelledLines(sw);
  const got = labelled.filter((l) => offered.has(l.value)).length;
  rows.push(`| ${form.id} | ${form.source.kind} | ${c} | ${windowBudget(sw)} | ${ledger.chars(sw.window.windowId)} | ${gen.cut.includes(sw.window.windowId) ? "yes" : "no"} | ${offered.size} | ${got} of ${labelled.length} |`);
}
const md = [
  "# Source budgets on the corpus",
  "",
  "Replayed recordings, the generator run fill makes, no Jev. Characters are distinct lines, as privacy.test.ts reads them.",
  "",
  "| form | source | chars | budget | charged | source cut | candidates from source | labelled values offered |",
  "|---|---|---|---|---|---|---|---|",
  ...rows,
];
writeStore(resolve(a.out), md.join("\n") + "\n");
process.stdout.write(md.join("\n") + "\n");
