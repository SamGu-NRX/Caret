// HA2 recall lever 2, offline: what a repeat focus costs with and without the session's owner verdicts
// (fill/owner-cache.ts). Each corpus form is focused twice on its recorded desk; a stand-in Jev answers every question
// (every value and field the user's, no value picked), so only the requests and their size are measured, never answers.
// Usage: node scripts/owner-cache-eval.ts [--out FILE]. Fixture data only, no network.
import { readFileSync } from "node:fs";
import { writeStore } from "../src/privacy/send.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { proposeFill, FillError } from "../src/fill/fill.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { OwnerVerdicts } from "../src/fill/owner-cache.ts";
import { Snapshot } from "../src/protocol.ts";
import { buildDesk, loadCorpus } from "./realfill-corpus.ts";

const a = parseArgs({ options: { out: { type: "string" } } }).values;
const here = dirname(fileURLToPath(import.meta.url));
const corpus = loadCorpus(join(here, "../../fixtures/realfill"));
const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));

interface Tally { requests: number; whose: number; ownerQuestions: number; whoseChars: number; chars: number }
const zero = (): Tally => ({ requests: 0, whose: 0, ownerQuestions: 0, whoseChars: 0, chars: 0 });

const standIn = (t: Tally): AskJev => async (req: JevRequest) => {
  const size = JSON.stringify(req).length;
  t.requests++;
  t.chars += size;
  if (req.purpose === "fill.whose") {
    t.whose++;
    t.whoseChars += size;
    t.ownerQuestions += Object.keys(req.questions).filter((k) => k.endsWith("_owner")).length;
  }
  const answers = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { choice: req.purpose === "fill.verify" ? "exact" : "user" in q.criteria ? "user" : "none" in q.criteria ? "none" : (Object.keys(q.criteria)[0] ?? "none"), confidence: 0.95 }]));
  return { model: "stand-in", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
};

const rows: { mode: string; focus: number; t: Tally }[] = [];
for (const mode of ["no cache", "session cache"] as const) {
  const tallies = [zero(), zero()];
  for (const form of corpus.forms) {
    let d;
    try {
      d = buildDesk(corpus, snaps, form);
    } catch {
      continue;
    }
    const cache = mode === "session cache" ? new OwnerVerdicts() : undefined;
    for (const focus of [0, 1]) {
      try {
        await proposeFill(d.model, standIn(tallies[focus] as Tally), d.form.window.windowId, d.trigger.key, 3_000_000 + focus, { about: d.about, rand: () => 0, ...(cache === undefined ? {} : { ownerCache: cache }) });
      } catch (e) {
        if (!(e instanceof FillError)) throw e;
      }
    }
  }
  tallies.forEach((t, focus) => rows.push({ mode, focus: focus + 1, t }));
}
const lines = ["| mode | focus | requests | owner-stage requests | owner questions | owner-stage chars | all chars |", "|---|---|---|---|---|---|---|", ...rows.map((r) => `| ${r.mode} | ${r.focus} | ${r.t.requests} | ${r.t.whose} | ${r.t.ownerQuestions} | ${r.t.whoseChars} | ${r.t.chars} |`)];
console.log(lines.join("\n"));
if (a.out !== undefined) writeStore(a.out, `${lines.join("\n")}\n`);
