// Fill from what the user told Caret (B17), on held-out forms: does a typed Name or Email go only where
// the form asks for the user's own name or email?
//
//   node scripts/about-fill-eval.ts --forms FILE --out DIR --jev oracle|eager|live [--max-usd 0.05]
//
// FILE is a list of forms written by someone who had not seen the rules (fill/about.ts); each field
// expects the user's Name, the user's Email, nothing, or a value an open window shows. Each form is a
// window of its own, alone or beside the fixture's Reference or Inbox window as the real reader recorded
// them (fixtures/recorded/fixture-sources.ndjson), and goes through proposeFill as the helper calls it.
// Nothing opens a window; the Jev answers decide what is filled:
//   oracle  picks exactly the expected value when it is offered: what the code lets a perfect Jev do.
//   eager   picks the user's own value whenever a question offers it, else the oracle's answer: the wrong
//           fills the code alone would allow, which only Jev's judgment keeps out.
//   live    asks Jev; needs CARET_ENV_FILE and stops before spending more than --max-usd.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ScreenModel } from "../src/model.ts";
import { aboutValues } from "../src/fill/about.ts";
import { FillError, proposeFill } from "../src/fill/fill.ts";
import { loadJevKey, makeJevClient, type AskJev, type JevRequest } from "../src/fill/jev.ts";
import { PROTOCOL_VERSION, type FillProposal, type Node, type Snapshot } from "../src/protocol.ts";

const { values: a } = parseArgs({
  options: {
    forms: { type: "string" },
    out: { type: "string" },
    jev: { type: "string", default: "oracle" },
    "max-usd": { type: "string", default: "0.05" },
  },
});
if (a.forms === undefined || a.out === undefined) throw new Error("--forms and --out are required");
if (!["oracle", "eager", "live"].includes(a.jev ?? "")) throw new Error("--jev is oracle, eager or live");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const MAX_USD = Number(a["max-usd"]);

type Expect = "name" | "email" | "none" | { value: string };
interface FormField {
  label: string | null;
  placeholder: string | null;
  section: string | null;
  expect: Expect;
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
const ABOUT = aboutValues([
  { id: "about-name", fields: { label: "Name", value: "Sam Rivera", source: "typed" } },
  { id: "about-email", fields: { label: "Email", value: "sam.rivera@example.com", source: "typed" } },
]);
const expected = (e: Expect): string | null => (e === "name" ? "Sam Rivera" : e === "email" ? "sam.rivera@example.com" : e === "none" ? null : e.value);

const SOURCES = (readFileSync(fileURLToPath(new URL("../fixtures/recorded/fixture-sources.ndjson", import.meta.url)), "utf8").trim().split("\n").map((l) => JSON.parse(l)) as Snapshot[]);
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
const fieldOf = (instructions: string): FormField => {
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
  const hits = (current?.fields ?? []).filter((x) => same(x.label ?? x.placeholder) && sectionAsRead(x.section) === section);
  if (hits.length !== 1) throw new Error(`question names '${name}' in section '${section}', which matches ${hits.length} fields of ${current?.id}`);
  return hits[0] as FormField;
};
const MEMORY = "which the user told Caret";
const scripted =
  (eager: boolean): AskJev =>
  async (req: JevRequest) => {
    const answers: Record<string, { choice: string; confidence: number }> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const f = fieldOf(String(q.instructions));
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
const real = a.jev === "live" ? makeJevClient(() => loadJevKey()) : null;
const ask: AskJev = async (req) => {
  calls++;
  if (real === null) return scripted(a.jev === "eager")(req);
  if (cost >= MAX_USD) throw new Error(`stopped: the live pass reached its $${MAX_USD} budget`);
  const r = await real(req);
  cost += r.costUsd;
  return r;
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
}
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
  current = f;
  let p: FillProposal | null = null;
  try {
    p = await proposeFill(m, ask, windowId, keys[0] as string, 3000, { about: ABOUT });
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
      asks: (pf?.asks ?? []).map((k) => `${k.choice} ${k.confidence.toFixed(2)}${/^[mn]\d+$/.test(k.choice) ? " (own)" : ""}`).join(" / "),
    });
  });
}

// MARK: - report

const count = (pred: (r: Row) => boolean): number => rows.filter(pred).length;
const own = (r: Row): boolean => r.expect === "name" || r.expect === "email";
const md: string[] = [`# Fill from what the user told Caret, held-out forms, Jev ${a.jev}`, ""];
md.push(`Forms: ${forms.length}; fields: ${rows.length}. Rules as committed; the forms were written by an agent that saw only the world description.`, "");
md.push(`- Wrong fills: ${count((r) => r.outcome === "wrong")} (of them from memory: ${count((r) => r.outcome === "wrong" && r.from === "memory")})`);
md.push(`- The user's own Name or Email filled: ${count((r) => own(r) && r.outcome === "right")} of ${count(own)}`);
md.push(`- A window's value filled as expected: ${count((r) => !own(r) && r.expect !== "none" && r.outcome === "right")} of ${count((r) => !own(r) && r.expect !== "none")}`);
md.push(`- Left blank as expected: ${count((r) => r.expect === "none" && r.outcome === "blank")} of ${count((r) => r.expect === "none")}`);
md.push(`- Jev: ${calls} calls, $${cost.toFixed(5)}${a.jev === "live" ? ` (budget $${MAX_USD})` : " (scripted)"}; errors: ${errors.length}`, "");
md.push("| Form | Field | Section | Expected | Got | From | Outcome | Withheld | Asks |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) md.push(`| ${r.form} | ${r.field} | ${r.section ?? ""} | ${r.expect} | ${r.got ?? ""} | ${r.from ?? ""} | ${r.outcome} | ${r.withheld ?? ""} | ${r.asks} |`);
if (errors.length > 0) md.push("", "## Errors", "", ...errors.map((e) => `- ${e}`));
writeFileSync(`${OUT}/about-fill-eval.md`, md.join("\n") + "\n");
writeFileSync(`${OUT}/about-fill-eval.json`, JSON.stringify({ jev: a.jev, calls, cost, rows, errors }, null, 2) + "\n");
console.log(md.slice(0, 9).join("\n"));
process.exit(errors.length > 0 ? 1 : 0);
