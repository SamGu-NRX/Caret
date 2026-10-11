// Event card sentences (brief B16) against live Jev.
//
//   CARET_ENV_FILE=... node scripts/event-eval.ts --out DIR [--max-usd 0.02]
//
// test/event-card.test.ts runs the 40 sentences of fixtures/golden/event-sentences.json through the
// helper with a fake Jev that answers as the fixture says. This asks live Jev the same two yes/no
// questions for every sentence where code found a person and a time ahead, and reports how its answers
// compare with the fixture's: 20 sentences should get two yeses, and the distractors that reach Jev
// should not. The sentence goes out as one window's line, held to that window's budget as in the helper.
import { writeStore, writeStoreJson } from "../src/privacy/send.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { positiveNumber } from "./flags.ts";
import { ScreenModel } from "../src/model.ts";
import { loadJevKey, makeJevClient, type AskJev } from "../src/fill/jev.ts";
import { askAttend, eventCandidate } from "../src/offers/event-card.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";

const { values: a } = parseArgs({ options: { out: { type: "string" }, "max-usd": { type: "string", default: "0.02" } } });
if (a.out === undefined) throw new Error("--out is required");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const MAX_USD = positiveNumber("max-usd", a["max-usd"]);
process.env.TZ = "America/Chicago";

interface Golden {
  now: string;
  sentences: { id: string; sentence: string; spans: { kind: string; text: string }[]; attend: "yes" | "no" | null; expect: unknown }[];
}
const golden = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/golden/event-sentences.json", import.meta.url)), "utf8")) as Golden;
const now = new Date(Date.parse(golden.now));

let cost = 0;
let calls = 0;
/** Thrown by ask once the budget is spent, so the loop stops asking and still writes its report. */
class BudgetStop extends Error {}
const real = makeJevClient(loadJevKey);
const ask: AskJev = async (req) => {
  if (cost >= MAX_USD) throw new BudgetStop(`stopped at the $${MAX_USD} budget`);
  const r = await real(req);
  calls++;
  cost += r.costUsd;
  return r;
};

const rows: { id: string; sentence: string; want: string | null; codePasses: boolean; asks: string[] | null; yes: boolean | null; agrees: boolean | null }[] = [];
/** Sentences whose asks failed (a Jev error, or the budget), left out of rows. */
const errors: { id: string; error: string }[] = [];
let stopped = false;
for (const s of golden.sentences) {
  if (stopped) break;
  const c = eventCandidate(s.sentence, s.spans.map((x) => x.text), [], { now, timeZone: "America/Chicago", locale: "en-US" });
  if (c === null) {
    rows.push({ id: s.id, sentence: s.sentence, want: s.attend, codePasses: false, asks: null, yes: null, agrees: s.attend === null ? true : null });
    continue;
  }
  // One compose window holding the sentence, as the helper sees the field the user typed it in.
  const model = new ScreenModel();
  const key = "dev.caret.mail/standard/textarea:body~0";
  model.apply({
    type: "snapshot", v: PROTOCOL_VERSION, seq: 0, at: now.getTime(), reason: "event",
    app: { pid: 6160, bundleId: "dev.caret.mail", name: "Mail Fixture" },
    window: { windowId: "6160-4", kind: "standard", title: "New message", frame: [0, 0, 800, 600] },
    focused: true, root: null, nodes: [{ key, parent: null, role: "AXTextArea", label: "Body", editable: true, value: s.sentence }],
    values: [], focusedKey: key, stats: { walkMs: 1, visited: 1, truncated: false },
  });
  const w = model.windows.get("6160-4");
  if (w === undefined) throw new Error("no window");
  let r: Awaited<ReturnType<typeof askAttend>>;
  try {
    r = await askAttend(ask, model, w, s.sentence, "typed");
  } catch (e) {
    errors.push({ id: s.id, error: e instanceof Error ? e.message : String(e) });
    stopped = e instanceof BudgetStop;
    process.stdout.write(`${s.id}: error: ${errors.at(-1)?.error}\n`);
    continue;
  }
  const yes = r?.yes ?? null;
  rows.push({ id: s.id, sentence: s.sentence, want: s.attend, codePasses: true, asks: r === null ? null : r.asks.map((x) => `${x.choice} ${x.confidence.toFixed(2)}`), yes, agrees: yes === null ? null : yes === (s.attend === "yes") });
  process.stdout.write(`${s.id}: ${r === null ? "not asked (privacy)" : `${r.asks.map((x) => x.choice).join("/")} -> ${yes ? "offer" : "no offer"}`}${s.attend === null ? " (fixture expected no ask)" : ""}\n`);
}

const asked = rows.filter((r) => r.codePasses);
const positives = rows.filter((r) => r.id.startsWith("s"));
const md = [
  "# Event card sentences, live Jev",
  "",
  `Reference time ${golden.now} (America/Chicago). Code decides person and time; Jev answers whether the user, who is typing the sentence, is arranging something they will attend, twice, and only two yeses make an offer.`,
  "",
  `- Sentences code passed to Jev: ${asked.length} (fixture expects ${golden.sentences.filter((s) => s.attend !== null).length})`,
  `- Of the 20 that should make an offer: ${positives.filter((r) => r.yes === true).length} got two yeses from live Jev`,
  `- Of the 20 distractors: ${rows.filter((r) => r.id.startsWith("d") && r.yes === true).length} got two yeses (would be offered); ${rows.filter((r) => r.id.startsWith("d") && !r.codePasses).length} stopped by code before any ask`,
  `- Live answers agreeing with the fixture's on the asked sentences: ${asked.filter((r) => r.agrees === true).length} of ${asked.length}`,
  `- Jev: ${calls} calls, $${cost.toFixed(5)} (budget $${MAX_USD}); errors: ${errors.length}${stopped ? "; stopped at the budget before every sentence was asked" : ""}`,
  ...errors.map((e) => `  - ${e.id}: ${e.error}`),
  "",
  "| Id | Sentence | Fixture | Code passes | Asks | Offer |",
  "| --- | --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.id} | ${r.sentence} | ${r.want ?? "not asked"} | ${r.codePasses ? "yes" : "no"} | ${r.asks?.join(", ") ?? "-"} | ${r.yes === null ? "-" : r.yes ? "yes" : "no"} |`),
];
writeStore(join(OUT, "event-eval.md"), md.join("\n") + "\n");
writeStoreJson(join(OUT, "event-eval.json"), { rows, errors, stopped, calls, cost }, 2);
console.log(md.slice(0, 10).join("\n"));
process.exitCode = errors.length > 0 ? 1 : 0;
