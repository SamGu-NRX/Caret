// Fill from what the user told Caret (B17), on held-out forms: does a typed Name or Email go only where
// the form asks for the user's own name or email?
//
//   node scripts/about-fill-eval.ts --forms FILE --out DIR --jev oracle|eager|live [--max-usd 0.05]
//        [--memory-cutoff N] [--no-whose] [--whose-cutoff N]
//
// FILE is a list of forms written by someone who had not seen the rules (fill/about.ts); each field
// expects the user's Name, the user's Email, the first or last part of the user's Name (B27), nothing, or a
// value an open window shows. Each form is a
// window of its own, alone or beside the fixture's Reference or Inbox window as the real reader recorded
// them (fixtures/recorded/fixture-sources.ndjson), and goes through proposeFill as the helper calls it.
// Nothing opens a window; the Jev answers decide what is filled:
//   oracle  picks exactly the expected value when it is offered: what the code lets a perfect Jev do.
//   eager   picks the user's own value whenever a question offers it, else the oracle's answer: the wrong
//           fills the code alone would allow, which only Jev's judgment keeps out.
//   live    asks Jev; needs CARET_ENV_FILE and stops before spending more than --max-usd.
// --memory-store (M1) takes the user's Name and Email from a markdown memory store in a temporary folder, written,
// closed and reopened, instead of from literals: the fills must not change.
// --memory-cutoff, --whose-cutoff and --no-whose (whose: false) set fill.ts's options (B18). A field may say `who`: whose
// details it wants (user, other, unclear, n/a). The report then counts by it, and sweeps the memory cutoff
// (and the whose cutoff, unless --no-whose) over the answers Jev gave, so one live pass shows every cutoff.
import { writeStore, writeStoreJson } from "../src/privacy/send.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryStore } from "../src/patterns/memory.ts";
import { parseArgs } from "node:util";
import { DecisionsAttemptError } from "../src/engines/decide/decisions.ts";
import { harnessEngine } from "../src/engines/decide/harness.ts";
import { engineName } from "../src/engines/decide/port.ts";
import { positiveNumber } from "./flags.ts";
import { fileURLToPath } from "node:url";
import { ScreenModel } from "../src/model.ts";
import { aboutValues } from "../src/fill/about.ts";
import { namePart, splitName } from "../src/fill/derive.ts";
import { FillError, proposeFill } from "../src/fill/fill.ts";
import { loadJevKey, makeJevClient, type AskJev, type JevRequest, type JevResult } from "../src/fill/jev.ts";
import { PROTOCOL_VERSION, type FillProposal, type Node, type Snapshot } from "../src/protocol.ts";

const { values: a } = parseArgs({
  options: {
    forms: { type: "string" },
    out: { type: "string" },
    jev: { type: "string", default: "oracle" },
    engine: { type: "string" },
    "log-requests": { type: "string" },
    "max-usd": { type: "string", default: "0.05" },
    "memory-cutoff": { type: "string" },
    "no-whose": { type: "boolean", default: false },
    "whose-cutoff": { type: "string" },
    "memory-store": { type: "boolean", default: false },
  },
});
if (a.forms === undefined || a.out === undefined) throw new Error("--forms and --out are required");
if (!["oracle", "eager", "live"].includes(a.jev ?? "")) throw new Error("--jev is oracle, eager or live");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const MAX_USD = positiveNumber("max-usd", a["max-usd"]);

// "first" and "last" are a part of the user's Name, which fill offers a field that asks for one (B24, Q1 bug 11).
// B17's and B18's forms were written when fill copied a typed value only whole, so they label such fields "none";
// B26 scored m21's "Sam" and "Rivera" under "Your details" wrong for that reason. B27 relabels those fields in
// copies (~/.caret-run/evidence/screen/b27/memsets), each with its reason in `relabel`.
type Expect = "name" | "email" | "first" | "last" | "none" | { value: string };
interface FormField {
  label: string | null;
  placeholder: string | null;
  section: string | null;
  expect: Expect;
  who?: "user" | "other" | "unclear" | "n/a";
}
interface Form {
  id: string;
  app: string;
  title: string;
  open: "none" | "reference" | "inbox";
  fields: FormField[];
}
const forms = JSON.parse(readFileSync(a.forms, "utf8")) as Form[];

// The user's typed About entries, as onboarding keeps them.
const ABOUT = a["memory-store"] ? aboutFromStore() : aboutValues([
  { id: "about-name", fields: { label: "Name", value: "Sam Rivera", source: "typed" } },
  { id: "about-email", fields: { label: "Email", value: "sam.rivera@example.com", source: "typed" } },
]);

/** The same two values, kept by "remember this" in a markdown store, then read back by a fresh store. Never the user's folder. */
function aboutFromStore(): ReturnType<typeof aboutValues> {
  const dir = mkdtempSync(join(tmpdir(), "caret-about-eval-"));
  try {
    const first = new MemoryStore(dir);
    first.addTyped({ label: "Name", value: "Sam Rivera", source: "typed" }, (l) => `typed:${l.toLowerCase()}`, 1);
    first.addTyped({ label: "Email", value: "sam.rivera@example.com", source: "typed" }, (l) => `typed:${l.toLowerCase()}`, 2);
    first.close();
    const again = new MemoryStore(dir);
    const out = aboutValues(again.active("about"));
    again.close();
    if (out.length !== 2) throw new Error(`the memory store gave ${out.length} About values, not 2`);
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const USER_NAME = ABOUT.find((x) => x.kind === "name")?.value ?? "";
const part = (p: "first" | "last"): string => {
  const v = namePart(splitName(USER_NAME), p);
  if (v === null) throw new Error(`the user's Name '${USER_NAME}' has no ${p} name`);
  return v;
};
/** The user's own first and last names: a pick of one of these is a part of the user's Name from memory (see the check below). */
const OWN_PARTS = new Set([part("first"), part("last")]);
const expected = (e: Expect): string | null =>
  e === "name" ? USER_NAME : e === "email" ? "sam.rivera@example.com" : e === "first" ? part("first") : e === "last" ? part("last") : e === "none" ? null : e.value;

const SOURCES = (readFileSync(fileURLToPath(new URL("../fixtures/recorded/fixture-sources.ndjson", import.meta.url)), "utf8").trim().split("\n").map((l) => JSON.parse(l)) as Snapshot[]);
// A derived pick's id does not say whether it came from memory or a window. These windows never show either part of
// the user's name, so a derived pick of one is from memory; the run stops if a fixture change breaks that.
for (const s of SOURCES) for (const t of [s.window.title, ...s.nodes.flatMap((n) => [n.label ?? "", n.value ?? ""])]) if ([...OWN_PARTS].some((w) => new RegExp(`\\b${w}\\b`).test(t))) throw new Error(`fixture window '${s.window.title}' shows a part of the user's name, so derived memory picks cannot be told apart`);
const source = (open: Form["open"]): Snapshot | null => (open === "none" ? null : (SOURCES.find((s) => s.window.title === (open === "reference" ? "Caret Fixture — Reference" : "Caret Fixture — Inbox")) ?? null));

/** The form as the reader would send it: each section a labelled group, each field a text field in it. */
function formSnapshot(f: Form, windowId: string, at: number): { snap: Snapshot; keys: string[] } {
  const nodes: Node[] = [];
  const keys: string[] = [];
  const groups = new Map<string, string>();
  f.fields.forEach((x, i) => {
    let parent: string | null = null;
    if (x.section !== null) {
      parent = groups.get(x.section) ?? `dev.caret.form/standard/group:${x.section.toLowerCase()}~0`;
      if (!groups.has(x.section)) {
        groups.set(x.section, parent);
        nodes.push({ key: parent, parent: null, role: "AXGroup", label: x.section });
      }
    }
    const key = `${parent ?? "dev.caret.form/standard"}/textfield:f${i}~0`;
    keys.push(key);
    nodes.push({
      key,
      parent,
      role: "AXTextField",
      editable: true,
      frame: [200, 60 + 40 * i, 280, 24],
      ...(x.label === null ? {} : { label: x.label }),
      ...(x.placeholder === null ? {} : { placeholder: x.placeholder }),
    });
  });
  const snap: Snapshot = {
    type: "snapshot",
    v: PROTOCOL_VERSION,
    seq: 0,
    at,
    reason: "focus",
    app: { pid: 9100, bundleId: `dev.caret.eval.${f.id}`, name: f.app },
    window: { windowId, kind: "standard", title: f.title, frame: [0, 0, 800, 600] },
    focused: true,
    root: null,
    nodes,
    values: [],
    focusedKey: keys[0] ?? null,
    stats: { walkMs: 1, visited: nodes.length, truncated: false },
  };
  return { snap, keys };
}

// MARK: - Jev

/** Which form field a question is about, by its label or placeholder and its section as the descriptor quotes them. */
let current: Form | null = null;
const fieldOf = (instructions: string, form: Form | null = current): FormField => {
  // Up to the quote that ends the sentence, so a label with an apostrophe ("Manager's name") reads whole.
  const m = /Label: '(.*?)'\.(?: |$)|Placeholder: '(.*?)'\.(?: |$)/.exec(instructions);
  const name = m?.[1] ?? m?.[2] ?? "";
  const section = /Section: '(.*?)'\.(?: |$)/.exec(instructions)?.[1] ?? null;
  // As the descriptor reads them (descriptor.ts): whitespace collapsed, a long label cut with an ellipsis, and a
  // section past 60 characters left out.
  const clean = (x: string | null): string | null => (x === null ? null : x.replace(/\s+/g, " ").trim() || null);
  const sectionAsRead = (x: string | null): string | null => {
    const c = clean(x);
    return c !== null && c.length <= 60 ? c : null;
  };
  const same = (raw: string | null): boolean => {
    const x = clean(raw);
    return x !== null && (x === name || (name.endsWith("…") && x.startsWith(name.slice(0, -1))));
  };
  const hits = (form?.fields ?? []).filter((x) => same(x.label ?? x.placeholder) && sectionAsRead(x.section) === section);
  if (hits.length !== 1) throw new Error(`question names '${name}' in section '${section}', which matches ${hits.length} fields of ${form?.id}`);
  return hits[0] as FormField;
};
const MEMORY = "which the user told Caret";
/** Whether a field expects one of the user's own values: Name, Email or a part of Name. */
const expectsOwn = (e: Expect): boolean => e === "name" || e === "email" || e === "first" || e === "last";
/** Whose details a field wants as the oracle answers it: its `who`, or the user's when it expects one of the user's own values (B17's forms say no `who`). */
const whoOf = (f: FormField): "user" | "other" | "unclear" =>
  f.who === "user" || f.who === "other" ? f.who : f.who === undefined && expectsOwn(f.expect) ? "user" : "unclear";
const scripted =
  (eager: boolean): AskJev =>
  async (req: JevRequest) => {
    const answers: Record<string, { choice: string; confidence: number }> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      // Whose a window's value is (B24's owner questions, which name no form field). Every person's value the
      // Reference and Inbox windows show is Dana's or Priya's, never the user's.
      if (id.endsWith("_owner")) {
        answers[id] = { choice: eager ? "user" : "other", confidence: 0.95 };
        continue;
      }
      const f = fieldOf(String(q.instructions));
      if (id.endsWith("_whose")) {
        answers[id] = { choice: eager ? "user" : whoOf(f), confidence: 0.95 };
        continue;
      }
      const crit = Object.entries(q.criteria);
      const own = crit.find(([, d]) => d?.includes(MEMORY));
      const want = expected(f.expect);
      const hit = eager && own !== undefined ? own : crit.find(([, d]) => want !== null && d?.startsWith(`"${want}"`));
      answers[id] = { choice: hit?.[0] ?? "none", confidence: 0.95 };
    }
    return { model: `jev-${eager ? "eager" : "oracle"}`, answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };
let calls = 0;
let cost = 0;
const fixtureIds = new Set<string>();
const decide = a.engine === undefined ? null : harnessEngine({
  name: engineName(a.engine), canned: scripted(a.jev === "eager"),
  fixture: { windows: (id) => fixtureIds.has(id), memory: true, plan: false },
  logRequests: a["log-requests"] ?? join(OUT, "requests.ndjson"),
  decisionsMaxUsd: MAX_USD,
});
const real = decide?.ask ?? (a.jev === "live" ? makeJevClient(loadJevKey) : null);
const engine = decide?.says ?? `Jev ${a.jev}`;
/** Each field's whose-details answers, in ask order, as Jev gave them. */
const whoseOf = new Map<FormField, { choice: string; confidence: number }[]>();
const ask: AskJev = async (req) => {
  calls++;
  // The form this request is about, taken before awaiting: a failed sibling ask lets the loop move on while this one is out.
  const form = current;
  let r: JevResult;
  if (real === null) r = await scripted(a.jev === "eager")(req);
  else {
    if (cost >= MAX_USD) throw new Error(`stopped: the live pass reached its $${MAX_USD} budget`);
    try { r = await real(req); }
    catch (e) {
      if (decide?.decisionsSpend === undefined && e instanceof DecisionsAttemptError) cost += e.attempt.costUsd ?? 0;
      throw e;
    } finally {
      // The ledger includes unknown usage at its full reservation, including sibling attempts.
      if (decide?.decisionsSpend !== undefined) cost = decide.decisionsSpend.run().usd;
    }
    if (decide?.decisionsSpend === undefined) cost += r.costUsd;
  }
  for (const [id, q] of Object.entries(req.questions)) {
    const ans = r.answers[id];
    if (!id.endsWith("_whose") || ans === undefined) continue;
    const f = fieldOf(String(q.instructions), form);
    whoseOf.set(f, [...(whoseOf.get(f) ?? []), ans]);
  }
  return r;
};
const fillOpts = {
  ...(a["memory-cutoff"] === undefined ? {} : { memoryCutoff: Number(a["memory-cutoff"]) }),
  ...(a["no-whose"] ? { whose: false } : {}),
  ...(a["whose-cutoff"] === undefined ? {} : { whoseCutoff: Number(a["whose-cutoff"]) }),
};

// MARK: - running

type Outcome = "right" | "wrong" | "blank" | "missed";
interface Row {
  form: string;
  field: string;
  section: string | null;
  expect: string;
  got: string | null;
  from: "memory" | "window" | null;
  offered: boolean;
  withheld: string | null;
  outcome: Outcome;
  /** Each ask's choice and confidence, with "(own)" when it chose the user's own value: "m1 0.62 (own) / n2 0.58 (own)". */
  asks: string;
  who: string;
  /** When both asks agreed on a value from memory: that value and the lower confidence; for the sweep. */
  memoryPick: { value: string; confidence: number; sourceCut: boolean } | null;
  /** The whose-details answers, with --whose. */
  whose: { choice: string; confidence: number }[];
}
/** Whether an ask chose a value from memory: an About entry (m1...; readAsk maps the second ask's n ids back), or a part of the user's Name derived from it. */
const ownPick = (k: { choice: string; value: string | null }): boolean => /^m\d+$/.test(k.choice) || (/^d\d+$/.test(k.choice) && k.value !== null && OWN_PARTS.has(k.value));
const rows: Row[] = [];
const errors: string[] = [];
let windowN = 0;
for (const f of forms) {
  const m = new ScreenModel();
  const src = source(f.open);
  if (src !== null) m.apply({ ...structuredClone(src), at: 1000 });
  const windowId = `9100-${++windowN}`;
  const { snap, keys } = formSnapshot(f, windowId, 2000);
  m.apply(snap);
  for (const id of m.windows.keys()) fixtureIds.add(id);
  current = f;
  let p: FillProposal | null = null;
  try {
    p = await proposeFill(m, ask, windowId, keys[0] as string, 3000, { about: ABOUT, ...fillOpts });
  } catch (e) {
    if (!(e instanceof FillError && /no candidate values/.test(e.message))) {
      errors.push(`${f.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
  }
  f.fields.forEach((x, i) => {
    const pf = p?.fields.find((y) => y.key === keys[i]);
    const want = expected(x.expect);
    const got = pf?.value ?? null;
    const outcome: Outcome = got === null ? (want === null ? "blank" : "missed") : got === want ? "right" : "wrong";
    rows.push({
      form: f.id,
      field: x.label ?? `(placeholder) ${x.placeholder}`,
      section: x.section,
      expect: typeof x.expect === "string" ? x.expect : `"${x.expect.value}"`,
      got,
      from: pf?.memory != null ? "memory" : pf?.source != null ? "window" : null,
      offered: (pf?.asks.length ?? 0) > 0,
      withheld: pf?.withheld ?? null,
      outcome,
      asks: (pf?.asks ?? []).map((k) => `${k.choice} ${k.confidence.toFixed(2)}${ownPick(k) ? " (own)" : ""}`).join(" / "),
      who: x.who ?? "",
      memoryPick: (() => {
        const [k1, k2] = pf?.asks ?? [];
        if (k1 === undefined || k2 === undefined || k1.choice !== k2.choice || !ownPick(k1) || k1.value === null) return null;
        return { value: k1.value, confidence: Math.min(k1.confidence, k2.confidence), sourceCut: pf?.withheld === "sourceCut" };
      })(),
      whose: whoseOf.get(x) ?? [],
    });
  });
}

// MARK: - report

const count = (pred: (r: Row) => boolean): number => rows.filter(pred).length;
const own = (r: Row): boolean => r.expect === "name" || r.expect === "email";
const ownPart = (r: Row): boolean => r.expect === "first" || r.expect === "last";
const md: string[] = [`# Fill from what the user told Caret, held-out forms, ${engine}`, ""];
md.push(`Forms: ${forms.length}; fields: ${rows.length}. Rules as committed; the forms were written by an agent that saw only the world description.`, "");
md.push(`- Wrong fills: ${count((r) => r.outcome === "wrong")} (of them from memory: ${count((r) => r.outcome === "wrong" && r.from === "memory")})`);
md.push(`- The user's own Name or Email filled: ${count((r) => own(r) && r.outcome === "right")} of ${count(own)}`);
md.push(`- The user's own first or last name filled: ${count((r) => ownPart(r) && r.outcome === "right")} of ${count(ownPart)}`);
md.push(`- A window's value filled as expected: ${count((r) => !own(r) && !ownPart(r) && r.expect !== "none" && r.outcome === "right")} of ${count((r) => !own(r) && !ownPart(r) && r.expect !== "none")}`);
md.push(`- Left blank as expected: ${count((r) => r.expect === "none" && r.outcome === "blank")} of ${count((r) => r.expect === "none")}`);
md.push(`- ${engine}: ${calls} calls, $${cost.toFixed(5)}${real !== null ? ` (budget $${MAX_USD})` : " (scripted)"}; errors: ${errors.length}`);
md.push(`- Options: ${JSON.stringify(fillOpts)}`, "");
const whos = [...new Set(rows.map((r) => r.who))].filter((x) => x !== "");
if (whos.length > 0) {
  md.push("By whose details the field wants:", "", "| Who | Fields | Filled right | Filled wrong | Blank |", "| --- | --- | --- | --- | --- |");
  for (const w of whos) md.push(`| ${w} | ${count((r) => r.who === w)} | ${count((r) => r.who === w && r.outcome === "right")} | ${count((r) => r.who === w && r.outcome === "wrong")} | ${count((r) => r.who === w && r.got === null)} |`);
  md.push("");
}
// The sweep: what a value from memory would do at each cutoff, from the answers Jev gave in this pass.
// A field fills from memory when both asks agreed on it, the lower confidence clears the memory cutoff,
// no cut withheld it, and, unless --no-whose, both whose answers say the user's at the whose cutoff or above.
const memoryOk = (r: Row, mc: number, wc: number | null): boolean =>
  r.memoryPick !== null && !r.memoryPick.sourceCut && r.memoryPick.confidence >= mc && (wc === null || (r.whose.length === 2 && r.whose.every((x) => x.choice === "user") && Math.min(...r.whose.map((x) => x.confidence)) >= wc));
const wantOf = (r: Row): string | null => (expectsOwn(r.expect as Expect) ? expected(r.expect as Expect) : null);
md.push("Sweep over memory picks (wrong = a value from memory where the field wants another value or none):", "", "| Memory cutoff | Whose cutoff | Own filled (whole and parts) | Wrong from memory |", "| --- | --- | --- | --- |");
for (const wc of a["no-whose"] ? [null] : [0, 0.5, 0.6, 0.7, 0.8]) {
  for (const mc of [0, 0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75]) {
    const filled = rows.filter((r) => memoryOk(r, mc, wc));
    md.push(`| ${mc} | ${wc ?? "-"} | ${filled.filter((r) => wantOf(r) === r.memoryPick?.value).length} of ${count((r) => own(r) || ownPart(r))} | ${filled.filter((r) => wantOf(r) !== r.memoryPick?.value).length} |`);
  }
}
md.push("");
md.push("| Form | Field | Section | Who | Expected | Got | From | Outcome | Withheld | Asks | Whose |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) md.push(`| ${r.form} | ${r.field} | ${r.section ?? ""} | ${r.who} | ${r.expect} | ${r.got ?? ""} | ${r.from ?? ""} | ${r.outcome} | ${r.withheld ?? ""} | ${r.asks} | ${r.whose.map((x) => `${x.choice} ${x.confidence.toFixed(2)}`).join(" / ")} |`);
if (errors.length > 0) md.push("", "## Errors", "", ...errors.map((e) => `- ${e}`));
writeStore(`${OUT}/about-fill-eval.md`, md.join("\n") + "\n");
writeStoreJson(`${OUT}/about-fill-eval.json`, { engine, jev: decide === null ? a.jev : null, calls, cost, rows, errors }, 2);
console.log(md.slice(0, 9).join("\n"));
process.exit(errors.length > 0 ? 1 : 0);
