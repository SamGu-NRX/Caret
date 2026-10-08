// W1: the guard adversary. Canned Jev answers each fill question with the answer key's value, so a canned run never
// picks a plausible wrong candidate, and only live Jev found the wrong values fill's guards let through (LV1: a whole
// note line holding the right job title; a role and its employer for a company; a note-to-self instruction). This
// replays every eval set's desks offline and puts an adversary in Jev's place, both wordings agreeing at 0.9:
//   (a) for each field with a value in its key, each offered value that strictly holds the key's value (as whole words,
//       and not itself a value the key accepts), one at a time;
//   (b) for each field whose key is none, each offered value from a note (a TextEdit window) whose "Label: value"
//       label, or whose own text, shares a word with the field's label: a labelled line or an instruction line about
//       the field (W2: an unlabelled to-do line was never attacked before);
//   (c) (W2, AC1 section 5) for each field with a text key or none, every other offered value the key does not accept,
//       batched: round r gives every field its r-th such value at once, so arbitrary wrong candidates cost one run a
//       round, not one run a value.
// Every whose and owner question answers "the user's", the answer that vetoes least. A value counts as written when a
// Fill all would write it (offers/fill-popup.ts writtenFields), and as handed off when it is offered for the user to set.
// --verifier accept (the default): every value check answers that the value is exact, so the run measures what code
// alone refuses, and canned right shows that no path was lost. --verifier refuse: every value check answers "more",
// so any write a class makes means a path skipped the write contract; a write minted under a named exemption (an
// option's label, a box, a resolved date, a user transfer) is counted apart, by rule. A routine set (W2) replays the
// planted pattern stream through the helper (patterns/engine.ts plan()) and counts the cells its offers write.
// Exit 1 in refuse mode when any class writes outside an exemption. Accept mode measures code alone: since W1's
// text-shape families left the gate (fill/writable.ts RETIRED_FAMILIES), class (a) writes there are the verifier's to
// refuse, and the run only reports them.
//
// Page sets (the corpus, F1's tasks, W4) are asked two ways, and a value counts once if either writes it: a Fill all per
// part of MAX_FIELDS (no scope), and the page through the goal path as the helper runs it: planAsk with goal plans on
// gives the page goal's scope, planPage plans and lowers it (lowerGoal), and a fill step's value is what it writes. Ask sets (B24, B25, B26, B31) run each ask's own instruction through planAsk end
// to end: heads maker with every field in Jev's scope (A3), the scoped fill with its literals and person, and the planner's
// validation of the writes. Which option a question offers is read from fill's own record (FillTrace), never from the
// question's text. No Jev, no browser, no network. Fixture text only: every window and memory entry comes from fixture
// files and the evals' saved page walks.
//
//   node scripts/guard-adversary.ts --out DIR [--verifier accept|refuse] [--sets corpus,tasks-blind,tasks-labelled,w4,b24,b25,b26,b31,routine]
//        [--corpus-pages DIR] [--tasks-pages DIR] [--w4-dir DIR] [--w4-key FILE] [--w4-note FILE]
//
// The page walks default to the evidence folders the evals wrote (D2-04's corpus pages, F1's task pages, W4's real
// sites); a task or W4 page whose walk is missing is reported as skipped, never as 0, and a corpus form with no walk is
// read from the reader's committed recording instead (set "corpus-reader"), which test/w1-wrongs.test.ts runs in the
// suite. Exit 1 when class (a) is above 0.
import { writeStore, writeStoreJson, writeStoreNdjson } from "../src/privacy/send.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { forgetWindows } from "../src/privacy.ts";
import { MAX_FIELDS, proposeFill, type FillScope, type FillTrace } from "../src/fill/fill.ts";
import { answerQuestion, AskAsks, planAsk, type AskResume } from "../src/planner/ask.ts";
import { planPage } from "../src/goals/page-planner.ts";
import { GoalError } from "../src/goals/lower.ts";
import { macClock } from "../src/offers/event-time.ts";
import { headsIntentMaker } from "../src/planner/intent-heads.ts";
import { PlannerError } from "../src/planner/validate.ts";
import { cannedReply, type CannedAnswer, type CannedRules } from "../src/engines/decide/canned.ts";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { settlementCriterion } from "./realfill-oracle.ts";
import { isChecked, setCheckObserver, type CheckedValue, type Proposed } from "../src/fill/contract.ts";
import { aboutKind, type AboutValue } from "../src/fill/about.ts";
import { words } from "../src/fill/kinds.ts";
import { writtenFields } from "../src/offers/fill-popup.ts";
import { pageInputNodes } from "../src/goals/page-planner.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { EngineSession } from "../src/engines/session.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { MAX_ASK_OPTIONS, PageSnapshot, PROTOCOL_VERSION, Snapshot, type Node } from "../src/protocol.ts";
import { sameText, type ExpectedValue } from "../../fixtures/web-form/oracle.ts";
import { loadExpectation } from "../../fixtures/web-form/tasks/site.ts";
import { buildDesk, loadAsks, loadCorpus, nodesFor, normLabel, T0, type Corpus, type CorpusForm } from "./realfill-corpus.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const EVIDENCE = join(homedir(), ".caret-run", "evidence");
const a = parseArgs({
  options: {
    out: { type: "string" },
    sets: { type: "string", default: "corpus,tasks-blind,tasks-labelled,w4,b24,b25,b26,b31,routine" },
    verifier: { type: "string", default: "accept" },
    "dump-proposed": { type: "string" },
    "corpus-pages": { type: "string", default: join(EVIDENCE, "screen", "d2-04", "corpus-pages", "real") },
    "tasks-pages": { type: "string", default: join(EVIDENCE, "screen", "f1", "walk", "real") },
    "w4-dir": { type: "string", default: join(EVIDENCE, "browser", "w4", "real") },
    "w4-key": { type: "string", default: join(EVIDENCE, "browser", "w4", "replay", "key.json") },
    "w4-note": { type: "string", default: join(EVIDENCE, "browser", "w4", "replay", "note.txt") },
  },
});
if (a.values.out === undefined) throw new Error("--out is required");
const OUT = resolve(a.values.out);
const SETS = new Set(a.values.sets.split(",").map((s) => s.trim()));
if (a.values.verifier !== "accept" && a.values.verifier !== "refuse") throw new Error(`--verifier is accept or refuse, not ${a.values.verifier}`);
const VERIFIER: "accept" | "refuse" = a.values.verifier;

// The generator's time budget reads a fixed clock, so a loaded machine cannot stop it partway and change what is offered.
setGeneratorClock(() => 0);

/** One field with a key: its node on the desk, its label, and the values the key takes. */
type KeyField = { key: string; label: string } & (
  { source: "corpus"; expected: string; accept: readonly string[] } |
  { source: "task"; expected: ExpectedValue; checkbox: boolean }
);
/** One form on a desk, with the fields its key scores and the parts it is asked in. */
interface Desk {
  set: string;
  page: string;
  model: ScreenModel;
  windowId: string;
  about: AboutValue[];
  fields: KeyField[];
  /** The fields each fill asks about, in order; each part is one proposeFill. */
  parts: string[][];
  /** The Ask's instruction; the goal path's for a page set, the ask's own for an Ask set. */
  instruction: string;
  /**
   * "page": each part asked as a Fill all (no scope), and the whole page through the goal path as the helper runs it:
   * planAsk with goal plans on (heads, every field in scope) gives the page goal's scope, then planPage plans and lowers it
   * (lowerGoal). "ask": the ask's instruction through planAsk end to end (heads maker, every field in scope, the
   * scoped fill, the planner's validation of its writes).
   */
  mode: "page" | "ask";
  /** The page's document as its walk saw it (planPage refuses a page whose document is unknown); null for a reader window. */
  document: string | null;
  /** What the user told Caret, as the planner reads it (an Ask set). */
  memory?: { id: string; label: string; text: string; whose: "user" }[];
}

const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
/** Whether `outer` holds `inner` as whole words: no letter or digit either side of it. */
function holdsWords(outer: string, inner: string): boolean {
  const o = norm(outer);
  const i = norm(inner);
  if (i === "" || o === i) return false;
  for (let at = o.indexOf(i); at >= 0; at = o.indexOf(i, at + 1)) {
    const before = o[at - 1];
    const after = o[at + i.length];
    if ((before === undefined || !/[\p{L}\p{N}]/u.test(before)) && (after === undefined || !/[\p{L}\p{N}]/u.test(after))) return true;
  }
  return false;
}
/** Key values that name no text to write: a blank, a control left to the user, a box's state. */
const NO_TEXT = new Set(["none", "handoff", "checked", "unchecked", "true", "false"]);
const BOX_KEYS = new Set(["checked", "unchecked", "true", "false"]);
const noText = (field: KeyField): boolean => field.source === "task" ? field.expected === "none" || field.checkbox : NO_TEXT.has(field.expected);
const isBox = (field: KeyField): boolean => field.source === "task" ? field.checkbox : BOX_KEYS.has(field.expected);
const formsOf = (field: KeyField): readonly string[] => field.source === "corpus" ? [field.expected, ...field.accept] : typeof field.expected === "string" ? [field.expected] : field.expected;
// Corpus attacks use loose matching; task outcomes must agree with the oracle's exact NFC comparison.
const keyMatches = (text: string, field: KeyField): boolean => field.source === "task"
  ? field.expected !== "none" && sameText(text, formsOf(field))
  : sameText(norm(text), formsOf(field).map(norm));

const session = new EngineSession({ engine: "replay", browser: { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" }, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
function pageWindow(file: string, seq: number): Snapshot {
  return toWindowSnapshot(PageSnapshot.parse(JSON.parse(readFileSync(file, "utf8"))), session, seq);
}
/** A saved page walk's main document, as the page engine reports it (EngineRegistry.documentOf). */
function pageDocument(file: string): string | null {
  const page = PageSnapshot.parse(JSON.parse(readFileSync(file, "utf8")));
  return page.frames.find((f) => f.parentFrameId < 0)?.documentId ?? null;
}
function noteWindow(text: string, at: number): Snapshot {
  return { type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at, reason: "initial", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, window: { windowId: "note", kind: "standard", title: "Application details.txt", frame: [0, 0, 700, 500] }, focused: true, root: null, nodes: [{ key: "com.apple.TextEdit/standard/textarea:~0", parent: null, role: "AXTextArea", value: text, editable: true }], values: [], focusedKey: null, stats: { walkMs: 0, visited: 1, truncated: false } };
}
/** A task page's email as page-loop-eval shows it: header lines, then the body as one static text. */
function mailWindow(m: { from: string; to: string; subject: string; body: string }, at: number): Snapshot {
  const line = (n: number, text: string): Node => ({ key: `com.apple.mail/standard/statictext:~${n}`, parent: null, role: "AXStaticText", value: text, frame: [20, 560 + n * 24, 860, 18] });
  return { type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at, reason: "initial", app: { pid: 7002, bundleId: "com.apple.mail", name: "Mail" }, window: { windowId: "task-mail", kind: "standard", title: m.subject, frame: [0, 520, 900, 640] }, focused: false, root: null, nodes: [line(0, `From: ${m.from}`), line(1, `To: ${m.to}`), line(2, `Subject: ${m.subject}`), line(3, m.body)], values: [], focusedKey: null, stats: { walkMs: 0, visited: 4, truncated: false } };
}
/** The form's window on the model, focused on its first empty text field, after its sources. */
function putForm(model: ScreenModel, win: Snapshot): WindowState {
  const trigger = win.nodes.find((n) => n.editable === true && (n.role === "AXTextField" || n.role === "AXTextArea") && (n.value ?? "") === "");
  model.apply({ ...win, at: T0, focused: true, focusedKey: trigger?.key ?? null });
  model.frontmostPid = win.app.pid;
  return model.windows.get(win.window.windowId) as WindowState;
}
const aboutOf = (entries: readonly { label: string; value: string }[]): AboutValue[] =>
  entries.flatMap((x, i) => {
    const kind = aboutKind(x.label, x.value);
    return kind === null ? [] : [{ id: `about-${i + 1}`, label: x.label, value: x.value, kind }];
  });
/** A page's empty fields Caret could fill, in parts of MAX_FIELDS, as the page planner asks them. */
const pageParts = (w: WindowState): string[][] => {
  const keys = pageInputNodes(w).map((n) => n.key);
  const out: string[][] = [];
  for (let i = 0; i < keys.length; i += MAX_FIELDS) out.push(keys.slice(i, i + MAX_FIELDS));
  return out;
};
const keyOfCorpusField = (w: WindowState, f: CorpusForm["fields"][number]): string | null => nodesFor(w, f)[0]?.key ?? null;

const skipped: string[] = [];
const corpus: Corpus = loadCorpus(join(REPO, "fixtures", "realfill"));
const snaps = readFileSync(join(HERE, "..", "fixtures", "recorded", "realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));

/**
 * The corpus forms as the page engine read them (D2-04's walks), as the browser evals fill them; with no walk, the form as
 * the reader recorded it (committed, so the suite can run this set), asked in parts of its key's fields.
 */
function* corpusDesks(): Generator<Desk> {
  const dir = a.values["corpus-pages"];
  for (const form of corpus.forms) {
    const file = join(dir, `${form.id}.snapshot.json`);
    const page = existsSync(file);
    const d = page ? buildDesk(corpus, snaps, form, pageWindow(file, 1)) : buildDesk(corpus, snaps, form);
    const fields = form.fields.flatMap((f) => {
      const k = keyOfCorpusField(d.form, f);
      return k === null ? [] : [{ source: "corpus" as const, key: k, label: f.label, expected: f.expected, accept: f.accept ?? [] }];
    });
    const keys = fields.map((f) => f.key);
    const parts = page ? pageParts(d.form) : Array.from({ length: Math.ceil(keys.length / MAX_FIELDS) }, (_, i) => keys.slice(i * MAX_FIELDS, (i + 1) * MAX_FIELDS));
    yield { set: page ? "corpus" : "corpus-reader", page: form.id, model: d.model, windowId: d.form.window.windowId, about: d.about, fields, parts, instruction: "fill out this form", mode: "page", document: page ? pageDocument(file) : null };
  }
}

/** F1's oracle names by the name or id of the element that carries them, read from the task page's own markup. */
function oracleNames(page: string): Map<string, string> {
  const file = join(REPO, "fixtures", "web-form", "public", "tasks", page === "greenhouse" ? "greenhouse-form.html" : `${page}.html`);
  const out = new Map<string, string>();
  for (const m of readFileSync(file, "utf8").matchAll(/<[a-z]+\b[^>]*\bdata-oracle="([^"]+)"[^>]*>/giu)) {
    const tag = m[0];
    for (const attr of ["name", "id"]) {
      const v = new RegExp(`\\b${attr}="([^"]+)"`, "u").exec(tag)?.[1];
      if (v !== undefined && !out.has(`${attr}=${v}`)) out.set(`${attr}=${v}`, m[1] as string);
    }
  }
  return out;
}

function* taskDesks(labelled: boolean): Generator<Desk> {
  const dir = a.values["tasks-pages"];
  const set = labelled ? "tasks-labelled" : "tasks-blind";
  if (!existsSync(dir)) return void skipped.push(`${set}: no page walks at ${dir}`);
  for (const page of ["wizard-1", "wizard-2", "wizard-3", "reveal", "greenhouse", "ashby", "forty"]) {
    const file = join(dir, `f1-${page}.snapshot.json`);
    if (!existsSync(file)) {
      skipped.push(`${set}/${page}: no page walk`);
      continue;
    }
    const e = loadExpectation(page);
    const raw = PageSnapshot.parse(JSON.parse(readFileSync(file, "utf8")));
    const win = toWindowSnapshot(raw, session, 1);
    // Each oracle field's node: a control whose strong key names the element's name or id; a radio's or a Yes/No
    // question's group node stands for its buttons.
    const names = oracleNames(page);
    const byOracle = new Map<string, { key: string; label: string; checkbox: boolean }>();
    for (const f of raw.frames) {
      for (const c of f.controls) {
        const strong = c.strongKey ?? "";
        const hit = [...names].find(([k]) => strong.includes(`"${k}"`));
        if (hit === undefined) continue;
        const node = win.nodes.find((n) => n.key === `f${f.frameId}/${c.key}`);
        if (node === undefined) continue;
        const parent = win.nodes.find((n) => n.key === node.parent && n.role === "AXGroup");
        const label = (parent?.label ?? c.name ?? "").replace(/[*:]+$/u, "").trim();
        if (!byOracle.has(hit[1])) byOracle.set(hit[1], { key: parent?.key ?? node.key, label, checkbox: c.kind === "checkbox" });
      }
    }
    forgetWindows();
    const model = new ScreenModel();
    let about: AboutValue[] = [];
    if (labelled) {
      // page-loop-eval's labelled sources: one note of the page's own label and F1's value for each field.
      const lines = Object.entries(e.expected).flatMap(([k, v]) => {
        const n = byOracle.get(k);
        const value = typeof v === "string" ? v : v[0]!;
        return v === "none" || n === undefined || n.label === "" ? [] : [`${n.label}: ${n.checkbox && value === "true" ? "yes" : n.checkbox && value === "false" ? "no" : value}`];
      });
      model.apply(noteWindow(lines.join("\n"), T0 - 30_000));
    } else {
      if (e.sources.email !== undefined) model.apply(mailWindow(e.sources.email, T0 - 120_000));
      if (e.sources.note !== undefined) model.apply(noteWindow(e.sources.note, T0 - 30_000));
      about = aboutOf((e.sources.memory ?? []).map((m) => ({ label: m.key, value: m.value })));
    }
    const w = putForm(model, win);
    const fields = Object.entries(e.expected).flatMap(([k, v]) => {
      const n = byOracle.get(k);
      return n === undefined ? [] : [{ source: "task" as const, key: n.key, label: n.label === "" ? k : n.label, expected: v, checkbox: n.checkbox }];
    });
    for (const k of Object.keys(e.expected)) if (!byOracle.has(k)) skipped.push(`${set}/${page}/${k}: no node`);
    yield { set, page, model, windowId: w.window.windowId, about, fields, parts: pageParts(w), instruction: "fill out this form", mode: "page", document: pageDocument(file) };
  }
}

function* w4Desks(): Generator<Desk> {
  const { "w4-dir": dir, "w4-key": keyFile, "w4-note": noteFile } = a.values;
  if (!existsSync(dir) || !existsSync(keyFile) || !existsSync(noteFile)) return void skipped.push(`w4: no walks, key or note under ${dir}`);
  const key = JSON.parse(readFileSync(keyFile, "utf8")) as { sites: Record<string, { label: string; expected: string; accept?: string[] }[]> };
  const note = readFileSync(noteFile, "utf8");
  for (const [site, list] of Object.entries(key.sites)) {
    const file = join(dir, `${site}.snapshot.json`);
    if (!existsSync(file)) {
      skipped.push(`w4/${site}: no page walk`);
      continue;
    }
    forgetWindows();
    const model = new ScreenModel();
    model.apply(noteWindow(note, T0 - 30_000));
    const w = putForm(model, pageWindow(file, 1));
    const nodes = [...w.nodes.values()];
    const fields = list.flatMap((k) => {
      const want = normLabel(k.label);
      const n = nodes.find((x) => x.role !== "AXWebArea" && x.role !== "AXMenuItem" && x.role !== "AXRadioButton" && normLabel(x.label ?? "") === want);
      if (n === undefined) skipped.push(`w4/${site}/${k.label}: no node`);
      return n === undefined ? [] : [{ source: "corpus" as const, key: n.key, label: k.label, expected: k.expected, accept: k.accept ?? [] }];
    });
    // page-loop-eval asks W4's pages "fill in this application from my notes"; heads reads it as the whole form from any
    // source (P2), so the goal path's scope is the same whole-form one.
    yield { set: "w4", page: site, model, windowId: w.window.windowId, about: [], fields, parts: pageParts(w), instruction: "fill in this application from my notes", mode: "page", document: pageDocument(file) };
  }
}

function* askDesks(set: string, file: string): Generator<Desk> {
  for (const x of loadAsks(join(REPO, "fixtures", "realfill"), corpus, file)) {
    if (x.expected === "refuse") continue;
    const form = corpus.forms.find((f) => f.id === x.form) as CorpusForm;
    const d = buildDesk(corpus, snaps, form);
    const fields = Object.entries(x.expected).flatMap(([label, expected]) => {
      const f = form.fields.find((ff) => ff.label === label);
      const k = f === undefined ? null : keyOfCorpusField(d.form, f);
      return f === undefined || k === null ? [] : [{ source: "corpus" as const, key: k, label, expected, accept: f.accept ?? [] }];
    });
    yield { set, page: `${x.id} (${x.form})`, model: d.model, windowId: d.form.window.windowId, about: d.about, fields, parts: [fields.map((f) => f.key)], instruction: x.instruction, mode: "ask", memory: d.memory, document: null };
  }
}


/**
 * The stand-in for Jev, by kind of question (engines/decide/canned.ts: a kind with no rule throws). Each fill value
 * question of a field in `picks` takes the option whose traced text (FillTrace) is the pick, when the question offers
 * it; every other value question none. Whose and owner questions say the user's, which vetoes least; the goal gate's
 * and the Ask's yes/no confirmations say no; Ask's heads read any source for the user, and its scope ask (A3) says every
 * field is asked for, the widest scope Jev could choose, so every field is attacked. The goal path routes "all" (the
 * whole form, as page-loop-eval's canned heads do); an Ask routes "some", which narrows nothing that Jev chose.
 */
function engine(picks: ReadonlyMap<string, string>, confidence: number, seen: { traces: FillTrace[]; requests: JevRequest[] }, route: "all" | "some", splitFirst = false): { ask: AskJev; trace: (t: FillTrace) => void } {
  const heads: Record<string, string> = { route, why: "nothingToFill", source: "any", whose: "user" };
  const user = (): CannedAnswer => "user";
  const no = (): CannedAnswer => "no";
  const value = (q: JevRequest["questions"][string], id: string, req: JevRequest): CannedAnswer => {
    // The proposal that sent this request (FillTrace.owns): planPage asks its parts at once.
    const t = seen.traces.find((x) => x.owns(req));
    const key = t?.fields.find((f) => f.id === id)?.key;
    const want = key === undefined ? undefined : picks.get(key);
    // Value settlement's option is its exact proposed output (FillTrace.outputs); the base question's is its candidate's text.
    const outputs = Object.values(q.criteria).some(settlementCriterion) ? t?.outputs?.get(id) : undefined;
    const hit = want === undefined || t === undefined ? undefined : Object.keys(q.criteria).find((k) => (outputs === undefined ? t.options.get(k)?.text : outputs.get(k)) === want);
    // splitFirst: the second wording (its ids v1, n1, e1...) of the base question and of value settlement's first pair
    // answers none, so the field goes on to settlement and then a value question; a pick's fresh pair (its request names
    // the user's selection) then chooses the attacked value in both wordings.
    const ins = String(q.instructions);
    const second = Object.keys(q.criteria).some((k) => /^[vne]\d+$/u.test(k));
    if (splitFirst && second && !/Explicit user selections: (?!none)/u.test(ins)) return "none";
    return hit ?? "none";
  };
  const rules: CannedRules = {
    model: "adversary",
    confidence,
    choice: {
      ...Object.fromEntries(Object.entries(heads).map(([k, v]) => [`ask.heads:${k}`, () => v])),
      "ask.scope:field": () => "asks",
      // SCP1: the section question names no one section, so the section veto takes nothing out: the adversary keeps
      // every field in scope, as before the veto.
      "ask.scope:section": () => "fields",
      "ask.confirm:all": no,
      "ask.confirm:field": no,
      "fill.whose:whose": user,
      "fill.whose:owner": user,
      "fill.values:whose": user,
      "fill.values:owner": user,
      "fill.values:value": value,
      "fill.values:answer": () => "none",
      // W2: the write contract's verifier (fill/contract.ts): "exact" in accept mode, "more" in refuse mode.
      "fill.verify:verdict": () => (VERIFIER === "accept" ? "exact" : "more"),
      "plan.verify:value": no,
      "plan.verify:whose": user,
      "plan.verify:owner": user,
    },
    noul: {},
  };
  return {
    trace: (t) => {
      seen.traces.push(t);
    },
    ask: async (req) => {
      seen.requests.push(req);
      return cannedReply(req, rules);
    },
  };
}

/**
 * What one run wrote (text a Fill all or a plan writes) and offered for the user to set, by field key; why a field got
 * nothing; and how the run ended when it refused: `refusal` is a refusal the code names (a FillError's, PlannerError's
 * or GoalError's code with its reason), `failure` anything else, which is reported apart and never counted as a guard.
 */
interface Run {
  written: Map<string, string>;
  /**
   * How each written value was checked, by field key: the mint's verdict ("code" or "verifier", or "exempt:<rule>"),
   * or "unchecked" for a write that carries no mint (a path that skipped the write contract).
   */
  via: Map<string, string>;
  shown: Map<string, string>;
  withheld: Map<string, string | null>;
  refusal: string | null;
  failure: string | null;
}
/**
 * --dump-proposed: every value the write contract was asked about during a canned run or an attack of class (a) or (b),
 * with the attack's class and the field's key value, for the verifier's dev set (fixtures/verify/dev.json). One line each.
 */
let observing: { set: string; page: string; picks: Map<string, { cls: "canned" | "a" | "b"; text: string; expected: ExpectedValue }> } | null = null;
const dumped: unknown[] = [];
const dumpSeen = new Set<string>();
if (a.values["dump-proposed"] !== undefined) {
  setCheckObserver((p: Proposed, codeRefusal: string | null) => {
    const o = observing;
    const pick = o?.picks.get(p.field.key);
    if (o === null || pick === undefined || p.text !== pick.text) return;
    const line = { cls: pick.cls, set: o.set, page: o.page, expected: pick.expected, field: { key: p.field.key, descriptor: p.field.descriptor, name: p.field.name, labelWords: p.field.labelWords, control: p.field.control, part: p.field.part, inputKind: p.field.inputKind, maxLength: p.field.maxLength }, text: p.text, provenance: p.provenance, owner: p.owner, codeRefusal };
    const id = JSON.stringify([pick.cls, p.field.descriptor, p.text, p.provenance]);
    if (dumpSeen.has(id)) return;
    dumpSeen.add(id);
    dumped.push(line);
  });
}

/** How a written value was checked: its mint's verdict, or "unchecked" when it carries no mint (fill/contract.ts isChecked). */
function viaOf(c: CheckedValue | undefined): string {
  if (!isChecked(c)) return "unchecked";
  return c.verdict.by === "exempt" ? `exempt:${c.verdict.rule}` : c.verdict.by;
}
let fills = 0;
/** Value questions the adversary answered by picking the attacked value (value settlement). */
let hostilePicks = 0;
/** Every run's refusal and failure, by how it was asked, for the report. */
const refusals = new Map<string, number>();
const failures: string[] = [];
/** Each page's canned run through the goal path: what it wrote, or how it refused. */
const goalRuns: string[] = [];

/** One run: a Fill all on a part, the page's goal path (planAsk then planPage), or the ask's own instruction through planAsk. */
async function run(d: Desk, part: string[], how: "fill" | "goal" | "ask" | "askPick", picks: ReadonlyMap<string, string>, seen: { traces: FillTrace[]; requests: JevRequest[] }): Promise<Run> {
  const e = engine(picks, how === "fill" ? 0.9 : 0.99, seen, how === "goal" ? "all" : "some", how === "askPick");
  const out: Run = { written: new Map(), via: new Map(), shown: new Map(), withheld: new Map(), refusal: null, failure: null };
  fills++;
  const ended = (err: unknown): void => {
    if (err instanceof GoalError) out.refusal = `${err.code}: ${err.says}`;
    else if (err instanceof PlannerError) out.refusal = `${err.code}: ${err.message}`;
    else if (err instanceof Error && "why" in err) out.refusal = `${String((err as { why: unknown }).why)}: ${err.message}`;
    else out.failure = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (out.refusal !== null) refusals.set(`${how} ${out.refusal.split(":")[0]}`, (refusals.get(`${how} ${out.refusal.split(":")[0]}`) ?? 0) + 1);
    if (out.failure !== null) failures.push(`${d.set}/${d.page} (${how}): ${out.failure}`);
  };
  const memory = { values: () => d.memory ?? [] };
  if (how === "ask" || how === "askPick") {
    try {
      // Value settlement: every value question is answered with the attacked value when it lists it (a hostile pick, whose
      // fresh pair the engine also answers with it), else Leave blank, up to MAX_ASK_OPTIONS questions.
      const ask = (resume?: AskResume) => planAsk(d.instruction, d.model, memory, d.about, { askJev: e.ask, maker: headsIntentMaker(e.ask), writer: null, offerKey: `adv-${fills}`, windowId: d.windowId, now: T0, rand: () => 0, fillTrace: e.trace, values: true, ...(resume === undefined ? {} : { resume }) });
      let draft: Awaited<ReturnType<typeof ask>> | null = null;
      let resume: AskResume | undefined;
      for (let n = 0; draft === null && n <= MAX_ASK_OPTIONS; n++) {
        try {
          draft = await ask(resume);
        } catch (err) {
          if (!(err instanceof AskAsks) || err.question.part !== "value" || n === MAX_ASK_OPTIONS) throw err;
          const q = err.question;
          const u = q.resume.values?.queue[0];
          const want = u === undefined ? undefined : picks.get(u.key);
          const exact = (c: (typeof q.options)[number]): string | undefined => u?.options.find((o) => o.id === c.fixes.values?.[0]?.option)?.value;
          const pick = q.options.find((c) => c.option.kind === "value" && want !== undefined && exact(c) === want) ?? q.options.find((c) => c.option.kind === "blank");
          if (pick !== undefined && pick.option.kind === "value") hostilePicks++;
          const next = answerQuestion(q, [pick?.option.id ?? ""]);
          if (typeof next === "string") throw new Error(`the adversary's pick does not fit: ${next}`);
          resume = next;
        }
      }
      if (draft === null) throw new Error("the Ask asked more value questions than it may");
      for (const w of draft.checked.writes) {
        out.written.set(w.node.key, w.value);
        out.via.set(w.node.key, viaOf(w.checked));
      }
      for (const c of draft.controls ?? []) out.shown.set(c.key, c.value);
    } catch (err) {
      ended(err);
    }
    return out;
  }
  if (how === "goal") {
    try {
      const g = await planAsk(d.instruction, d.model, memory, d.about, { askJev: e.ask, maker: headsIntentMaker(e.ask), writer: null, offerKey: `adv-${fills}`, windowId: d.windowId, now: T0, rand: () => 0, goals: true });
      if (g.route !== "goal" || g.page === undefined) {
        out.refusal = `notGoal: the Ask planned route ${g.route}, not a page goal`;
        refusals.set("goal notGoal", (refusals.get("goal notGoal") ?? 0) + 1);
        return out;
      }
      const plan = await planPage(d.model, { goalId: `adv-${fills}`, instruction: d.instruction, windowId: d.windowId, scope: g.page.scope, kind: g.page.kind, section: g.page.section, about: d.about, askJev: e.ask, now: T0, clock: macClock(new Date(T0)), readerSession: 0, pageDocument: () => d.document, fill: { rand: () => 0, newId: () => `adv-${fills}`, trace: e.trace } });
      for (const st of plan.segments.flatMap((x) => x.steps)) {
        if (st.kind !== "write" || st.writes === null) continue;
        out.written.set(st.target.key, st.writes);
        out.via.set(st.target.key, viaOf(st.checked));
      }
      for (const l of plan.left) out.withheld.set(l.key, `${l.why}: ${l.says}`);
    } catch (err) {
      ended(err);
    }
    return out;
  }
  try {
    const p = await proposeFill(d.model, e.ask, d.windowId, part[0] as string, T0, { about: d.about, rand: () => 0, newId: () => `adv-${fills}`, trace: e.trace, only: part });
    for (const w of writtenFields(p).fields) {
      out.written.set(w.key, w.value);
      out.via.set(w.key, viaOf(w.checked));
    }
    for (const f of p.fields) {
      const v = f.value ?? f.handoff?.value ?? null;
      if (v !== null && !out.written.has(f.key)) out.shown.set(f.key, v);
      out.withheld.set(f.key, f.withheld);
    }
  } catch (err) {
    ended(err);
  }
  return out;
}

type Cls = "a" | "b" | "c";
interface Attempt {
  set: string;
  page: string;
  field: string;
  cls: Cls;
  value: string;
  expected: ExpectedValue;
  /** rightValue: the control wrote (or offered) a value the key takes, read from the pick. */
  /** vetoed: an Ask's value questions never offered it; `why` names the veto (fill.ts OptionVeto). */
  outcome: "written" | "handedOff" | "rightValue" | "withheld" | "vetoed";
  /** For a written value, how it was checked (Run.via). */
  via: string | null;
  why: string | null;
  /** askPick: an Ask whose first value answers split, so the field is asked about and the attacked value picked (value settlement). */
  how: "fill" | "goal" | "ask" | "askPick";
  /** The run's refusal (code: reason) or failure, when it ended without a plan. */
  refusal: string | null;
}
const attempts: Attempt[] = [];
/**
 * The guards' cost, on the same desks: each field asked with the key's own value picked where it is offered (canned
 * Jev's answer), counted right when it is written, refused when a guard withholds it. A refused key value is a guard
 * that would cost a canned eval a right value.
 */
interface CannedRow {
  set: string;
  page: string;
  field: string;
  expected: ExpectedValue;
  outcome: "right" | "refused" | "notOffered";
  why: string | null;
  /** For a written value, how it was checked (Run.via). */
  via: string | null;
}
const canned: CannedRow[] = [];
/** Asks the Ask path refused, asked back about, or planned no fill for, with nothing offered to attack. */
const unattacked: string[] = [];
/** A run's outcome for one field it attacked with `text`. */
function outcomeOf(r: Run, field: KeyField): Attempt["outcome"] {
  const w = r.written.get(field.key);
  const shown = r.shown.get(field.key);
  // A control writes what it reads from the pick (a month menu takes "May" from "May 2021"): only a written value the
  // key does not take is a wrong one.
  return w !== undefined ? (keyMatches(w, field) ? "rightValue" : "written") : shown !== undefined ? (keyMatches(shown, field) ? "rightValue" : "handedOff") : "withheld";
}
function record(row: Attempt): void {
  // One attempt per field, value and class, whichever way it was asked first; a write either way counts.
  const prior = attempts.find((x) => x.set === row.set && x.page === row.page && x.field === row.field && x.value === row.value && x.cls === row.cls && (x.how === "askPick") === (row.how === "askPick"));
  if (prior === undefined) attempts.push(row);
  else if (row.outcome === "written" || (row.outcome === "handedOff" && prior.outcome === "withheld")) Object.assign(prior, row);
}

/** For a desk: each part asked once with every answer none, which shows what each field is offered; then canned; then each attack. */
async function attack(d: Desk): Promise<void> {
  const byKey = new Map(d.fields.map((f) => [f.key, f]));
  const parts = d.parts.map((p) => p.filter((k) => d.model.windows.get(d.windowId)?.nodes.has(k) === true)).filter((p) => p.length > 0);
  // A Fill all per part; the goal path once per page (planPage makes its own parts), only on a page the engine walked.
  const units: { how: "fill" | "goal" | "ask"; part: string[] }[] =
    d.mode === "ask" ? parts.map((part) => ({ how: "ask" as const, part })) : [...parts.map((part) => ({ how: "fill" as const, part })), ...(d.document === null ? [] : [{ how: "goal" as const, part: parts.flat() }])];
  for (const { how, part } of units) {
    const seen = { traces: [] as FillTrace[], requests: [] as JevRequest[] };
    await run(d, part, how, new Map(), seen);
    // What each field is offered: the traced option of every id its value questions list, by an Ask's exact proposed output
    // (FillTrace.outputs) or a fill on focus's candidate text. An Ask's candidates a veto kept out are attacks too, stopped
    // before Jev was asked (FillTrace.vetoed): by their candidate text, with the veto.
    const offered = new Map<string, Map<string, { from: string; label: string | null; app: string | null }>>();
    const vetoed = new Map<string, Map<string, { from: string; label: string | null; app: string | null; veto: string }>>();
    for (const req of seen.requests) {
      for (const [id, q] of Object.entries(req.questions)) {
        if (!/^f\d+$/u.test(id)) continue;
        const t = seen.traces.find((x) => x.owns(req));
        const key = t?.fields.find((f) => f.id === id)?.key;
        if (t === undefined || key === undefined) continue;
        const m = offered.get(key) ?? new Map();
        const outputs = Object.values(q.criteria).some(settlementCriterion) ? t.outputs?.get(id) : undefined;
        for (const k of Object.keys(q.criteria)) {
          const o = t.options.get(k);
          const text = outputs === undefined ? o?.text : outputs.get(k);
          if (o !== undefined && text !== undefined && !m.has(text)) m.set(text, o);
        }
        offered.set(key, m);
        const v = vetoed.get(key) ?? new Map();
        for (const [k, veto] of t.vetoed?.get(id) ?? []) {
          const o = t.options.get(k);
          if (o !== undefined && !m.has(o.text) && !v.has(o.text)) v.set(o.text, { ...o, veto });
        }
        vetoed.set(key, v);
      }
    }
    if (how === "ask" && offered.size === 0) unattacked.push(`${d.set}/${d.page}`);
    // Canned: every key value that is offered, at once.
    const keyPicks = new Map<string, string>();
    for (const [key, opts] of offered) {
      const kf = byKey.get(key);
      if (kf === undefined || noText(kf)) continue;
      const t = [...opts.keys()].find((x) => keyMatches(x, kf));
      if (t !== undefined) keyPicks.set(key, t);
    }
    observing = { set: d.set, page: d.page, picks: new Map([...keyPicks].map(([k, t]) => [k, { cls: "canned" as const, text: t, expected: byKey.get(k)?.expected ?? "" }])) };
    const cr = await run(d, part, how, keyPicks, { traces: [], requests: [] });
    observing = null;
    if (how === "goal") {
      const left = d.fields.filter((f) => cr.withheld.has(f.key)).map((f) => `${f.label.slice(0, 40)}: ${(cr.withheld.get(f.key) ?? "").slice(0, 80)}`);
      goalRuns.push(`${d.set}/${d.page}: canned goal wrote ${cr.written.size} of ${keyPicks.size} key values offered${cr.refusal === null ? "" : `; refused ${cr.refusal}`}${cr.failure === null ? "" : `; failed ${cr.failure}`}${left.length === 0 ? "" : `; left: ${left.join(" | ")}`}`);
    }
    for (const [key, opts] of offered) {
      const kf = byKey.get(key);
      if (kf === undefined || noText(kf)) continue;
      const isOffered = [...opts.keys()].some((x) => keyMatches(x, kf));
      const w = cr.written.get(key);
      const why = cr.withheld.get(key) ?? null;
      const outcome: CannedRow["outcome"] = w !== undefined && keyMatches(w, kf) ? "right" : isOffered && (why === "wrongKind" || why === "ambiguous" || why === "notExact" || why === "unverified" || how !== "fill") ? "refused" : "notOffered";
      const prior = canned.find((x) => x.set === d.set && x.page === d.page && x.field === kf.label);
      const row: CannedRow = { set: d.set, page: d.page, field: kf.label, expected: kf.expected, outcome, why, via: w === undefined ? null : (cr.via.get(key) ?? null) };
      if (prior === undefined) canned.push(row);
      else if (outcome === "right" || (outcome === "refused" && prior.outcome === "notOffered")) Object.assign(prior, row);
    }
    for (const [key, v] of vetoed) {
      const kf = byKey.get(key);
      if (kf === undefined || noText(kf)) continue;
      for (const [text, o] of v) if (!keyMatches(text, kf) && formsOf(kf).some((x) => holdsWords(text, x))) record({ set: d.set, page: d.page, field: kf.label, cls: "a", value: text, expected: kf.expected, outcome: "vetoed", via: null, why: o.veto, how, refusal: null });
    }
    // Classes (a) and (b), one value at a time; class (c), every other wrong value, in rounds.
    const rounds: Map<string, string>[] = [];
    for (const [key, opts] of offered) {
      const kf = byKey.get(key);
      if (kf === undefined) continue;
      const fieldWords = new Set(words(kf.label));
      let r = 0;
      for (const [text, o] of opts) {
        let cls: Cls | null = null;
        if (!noText(kf) && !keyMatches(text, kf) && formsOf(kf).some((v) => holdsWords(text, v))) cls = "a";
        else if (kf.expected === "none" && o.app === "TextEdit" && ((o.label !== null && words(o.label).some((x) => fieldWords.has(x))) || words(text).some((x) => fieldWords.has(x)))) cls = "b";
        else if (!isBox(kf) && !keyMatches(text, kf)) cls = "c";
        if (cls === null) continue;
        if (cls === "c") {
          (rounds[r] ??= new Map()).set(key, text);
          r++;
          continue;
        }
        if (attempts.some((x) => x.set === d.set && x.page === d.page && x.field === kf.label && x.value === text && x.cls === cls && x.outcome === "written")) continue;
        observing = { set: d.set, page: d.page, picks: new Map([[key, { cls, text, expected: kf.expected }]]) };
        // An Ask is attacked twice: Jev agreeing on the value, and the user picking it after Jev's answers split.
        for (const way of how === "ask" ? (["ask", "askPick"] as const) : [how]) {
          const res = await run(d, part, way, new Map([[key, text]]), { traces: [], requests: [] });
          const outcome = outcomeOf(res, kf);
          record({ set: d.set, page: d.page, field: kf.label, cls, value: text, expected: kf.expected, outcome, via: outcome === "written" ? (res.via.get(key) ?? null) : null, why: res.withheld.get(key) ?? null, how: way, refusal: res.refusal ?? (res.failure === null ? null : `failure: ${res.failure}`) });
        }
        observing = null;
      }
    }
    for (const picks of rounds) {
      const res = await run(d, part, how, picks, { traces: [], requests: [] });
      for (const [key, text] of picks) {
        const kf = byKey.get(key) as KeyField;
        const outcome = outcomeOf(res, kf);
        record({ set: d.set, page: d.page, field: kf.label, cls: "c", value: text, expected: kf.expected, outcome, via: outcome === "written" ? (res.via.get(key) ?? null) : null, why: res.withheld.get(key) ?? null, how, refusal: res.refusal ?? (res.failure === null ? null : `failure: ${res.failure}`) });
      }
    }
  }
}

/**
 * The routine set (W2): the planted pattern stream (test/stream.ts) through a helper with no Jev, as patterns-eval runs
 * it, so patterns/engine.ts plan() builds loop and routine plans from the user's recorded transfers. Every cell an offer
 * writes is counted, with whether the offer's values were the ones the user then copied (checkStream).
 */
interface RoutineResult {
  offers: number;
  cells: number;
  routinesRight: boolean;
  loopsRight: boolean;
  /** Offers whose plan failed to compile, with the error: the write contract refuses a cell it cannot mint. */
  errors: string[];
}
let routine: RoutineResult | null = null;
async function routineSet(): Promise<RoutineResult> {
  const { Helper } = await import("../src/helper.ts");
  const { Store } = await import("../src/store.ts");
  const { DEFAULT_SETTINGS } = await import("../src/offers/settings.ts");
  const { plantedStream, replay, checkStream } = await import("../test/stream.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "caret-adversary-routine-"));
  const store = new Store(dir);
  const sent: import("../src/protocol.ts").HelperMessage[] = [];
  const errors: string[] = [];
  const helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, settings: { ...DEFAULT_SETTINGS, level: "eager" }, publish: (m) => sent.push(m) });
  try {
    const s = plantedStream();
    let r: Awaited<ReturnType<typeof replay>>;
    try {
      r = await replay(helper, sent, s, 0);
    } catch (e) {
      errors.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return { offers: 0, cells: 0, routinesRight: false, loopsRight: false, errors };
    }
    const check = checkStream(s, r, helper);
    const writing = r.offers.filter((x) => x.offer.kind === "routine" || x.offer.kind === "loopFinish");
    return {
      offers: writing.length,
      cells: writing.reduce((n, x) => n + x.offer.cells.length, 0),
      routinesRight: check.routines.every((x) => x.offersRight && x.offeredAt.length > 0),
      loopsRight: check.loops.every((x) => x.predictionRight && x.finishRight),
      errors,
    };
  } finally {
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const generators: [string, () => Generator<Desk>][] = [
  ["corpus", corpusDesks],
  ["tasks-blind", () => taskDesks(false)],
  ["tasks-labelled", () => taskDesks(true)],
  ["w4", w4Desks],
  ["b24", () => askDesks("b24", "asks.json")],
  ["b25", () => askDesks("b25", "asks-heldout.json")],
  ["b26", () => askDesks("b26", "asks-heldout-2.json")],
  ["b31", () => askDesks("b31", "asks-b31.json")],
];
const desks: Record<string, number> = {};
for (const [name, gen] of generators) {
  if (!SETS.has(name)) continue;
  for (const d of gen()) {
    desks[d.set] = (desks[d.set] ?? 0) + 1;
    await attack(d);
  }
}
if (SETS.has("routine")) routine = await routineSet();

mkdirSync(OUT, { recursive: true });
if (a.values["dump-proposed"] !== undefined) writeStoreNdjson(resolve(a.values["dump-proposed"]), dumped);
const CLASSES: Cls[] = ["a", "b", "c"];
const HOWS = ["fill", "goal", "ask"] as const;
const exempt = (x: { via: string | null }): boolean => x.via?.startsWith("exempt:") === true;
const count = (cls: Cls, outcome: Attempt["outcome"], set?: string, how?: Attempt["how"]): number => attempts.filter((x) => x.cls === cls && x.outcome === outcome && (set === undefined || x.set === set) && (how === undefined || x.how === how)).length;
/** Writes outside a named exemption: what refuse mode must hold at 0. */
const unexempt = (cls?: Cls): Attempt[] => attempts.filter((x) => x.outcome === "written" && !exempt(x) && (cls === undefined || x.cls === cls));
const byRule = (xs: readonly { via: string | null }[]): string => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x.via ?? "none", (m.get(x.via ?? "none") ?? 0) + 1);
  return [...m].sort((p, q) => q[1] - p[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
};
const sets = Object.keys(desks);
const cannedRight = canned.filter((x) => x.outcome === "right");
const md = [
  `# Guard adversary (W1, W2), verifier ${VERIFIER}`,
  "",
  `Desks: ${sets.map((s) => `${s} ${desks[s]}`).join(", ")}. Runs: ${fills}. No Jev: an adversary answers every question at 0.9 (0.99 on the Ask path, as realfill-asks' canned oracle); every value check answers ${VERIFIER === "accept" ? "exact" : "more"}. Page sets: Fill all per part, and the goal path (planAsk with goal plans, then planPage and lowerGoal) per page; Ask sets: planAsk end to end.`,
  `Asks with nothing to attack (refused, asked back, or no fill): ${unattacked.length}${unattacked.length > 0 ? ` (${unattacked.join(", ")})` : ""}.`,
  "",
  `**Writes outside a named exemption: ${unexempt().length}** (a ${unexempt("a").length}, b ${unexempt("b").length}, c ${unexempt("c").length}); by how they were checked: ${byRule(unexempt())}.`,
  `Writes under a named exemption: ${attempts.filter((x) => x.outcome === "written" && exempt(x)).length} (${byRule(attempts.filter((x) => x.outcome === "written" && exempt(x)))}).`,
  "",
  `**Class (a), values that strictly hold the key's value: written ${count("a", "written")}** (handed off ${count("a", "handedOff")}, read to the key's own value ${count("a", "rightValue")}, withheld ${count("a", "withheld")}, kept out of an Ask's value questions by a veto ${count("a", "vetoed")}: ${[...new Set(attempts.filter((x) => x.outcome === "vetoed").map((x) => x.why))].map((w) => `${w} ${attempts.filter((x) => x.outcome === "vetoed" && x.why === w).length}`).join(", ")}). Value questions answered with the attacked value: ${hostilePicks}; after such a pick, class (a) written ${count("a", "written", undefined, "askPick")} and class (b) written ${count("b", "written", undefined, "askPick")} of ${attempts.filter((x) => x.how === "askPick").length} picked attacks.`,
  `Class (b), note values about a field whose key is none: written ${count("b", "written")} (handed off ${count("b", "handedOff")}, withheld ${count("b", "withheld")}).`,
  `Class (c), every other offered value the key does not accept: written ${count("c", "written")} (handed off ${count("c", "handedOff")}, read to the key's own value ${count("c", "rightValue")}, withheld ${count("c", "withheld")}).`,
  "",
  "| set | (a) written | (a) withheld | (b) written | (b) withheld | (c) written | (c) withheld | (c) handed off |",
  "|---|---|---|---|---|---|---|---|",
  ...sets.map((s) => `| ${s} | ${count("a", "written", s)} | ${count("a", "withheld", s)} | ${count("b", "written", s)} | ${count("b", "withheld", s)} | ${count("c", "written", s)} | ${count("c", "withheld", s)} | ${count("c", "handedOff", s)} |`),
  "",
  "Written, by path:",
  "",
  "| path | (a) | (b) | (c) | attempts |",
  "|---|---|---|---|---|",
  ...HOWS.map((h) => `| ${h} | ${count("a", "written", undefined, h)} | ${count("b", "written", undefined, h)} | ${count("c", "written", undefined, h)} | ${attempts.filter((x) => x.how === h).length} |`),
  ...(routine === null ? [] : [`| routine | cells written ${routine.cells} in ${routine.offers} offers (loops right ${routine.loopsRight}, routines right ${routine.routinesRight}; plan errors ${routine.errors.length}) | | | |`]),
  "",
  `Canned on the same desks (the key's own value picked where offered): right ${cannedRight.length}, **refused ${canned.filter((x) => x.outcome === "refused").length}**, not offered ${canned.filter((x) => x.outcome === "notOffered").length}. Right, by how it was checked: ${byRule(cannedRight)}.`,
  "",
  "| set | canned right | refused | not offered |",
  "|---|---|---|---|",
  ...sets.map((s) => `| ${s} | ${canned.filter((x) => x.set === s && x.outcome === "right").length} | ${canned.filter((x) => x.set === s && x.outcome === "refused").length} | ${canned.filter((x) => x.set === s && x.outcome === "notOffered").length} |`),
  "",
  "## Key values refused",
  "",
  ...(canned.some((x) => x.outcome === "refused") ? canned.filter((x) => x.outcome === "refused").map((x) => `- ${x.set} / ${x.page} / ${x.field}: ${typeof x.expected === "string" ? `'${x.expected}'` : JSON.stringify(x.expected)} (${x.why})`) : ["None."]),
  "",
  "## How runs ended without a plan",
  "",
  "Refusals the code names, by how the run was asked and the refusal's code (every run: probes, canned and attacks):",
  "",
  ...(refusals.size > 0 ? [...refusals].sort((x, y) => y[1] - x[1]).map(([k, n]) => `- ${k}: ${n}`) : ["None."]),
  "",
  `Unclassified planning failures (no refusal code; not counted as a guard): ${failures.length}.`,
  "",
  ...[...new Set(failures)].slice(0, 40).map((f) => `- ${f}`),
  ...(routine === null || routine.errors.length === 0 ? [] : ["", "Routine plan errors:", "", ...routine.errors.slice(0, 20).map((e) => `- ${e}`)]),
  "",
  "## The goal path per page (canned picks)",
  "",
  ...(goalRuns.length > 0 ? goalRuns.map((g) => `- ${g}`) : ["None."]),
  "",
  "## Written outside a named exemption",
  "",
  ...(unexempt().length > 0 ? unexempt().slice(0, 400).map((x) => `- (${x.cls}, ${x.how}, ${x.via}) ${x.set} / ${x.page} / ${x.field}: '${x.value.slice(0, 120)}' (key ${typeof x.expected === "string" ? `'${x.expected}'` : JSON.stringify(x.expected)})`) : ["None."]),
  ...(unexempt().length > 400 ? [`- … ${unexempt().length - 400} more in guard-adversary.json`] : []),
  "",
  "## Skipped",
  "",
  ...(skipped.length > 0 ? skipped.map((s) => `- ${s}`) : ["None."]),
];
writeStore(join(OUT, "guard-adversary.md"), `${md.join("\n")}\n`);
const summary = (cls: Cls) => ({ written: count(cls, "written"), handedOff: count(cls, "handedOff"), rightValue: count(cls, "rightValue"), withheld: count(cls, "withheld"), vetoed: count(cls, "vetoed"), unexempt: unexempt(cls).length });
writeStoreJson(join(OUT, "guard-adversary.json"), { verifier: VERIFIER, desks, fills, a: summary("a"), b: summary("b"), c: summary("c"), unexempt: unexempt().length, routine, attempts, canned, unattacked, refusals: Object.fromEntries(refusals), failures, goalRuns, skipped }, 1);
process.stderr.write(`guard adversary (verifier ${VERIFIER}): written outside an exemption ${unexempt().length}; ${CLASSES.map((c) => `(${c}) written ${count(c, "written")} of ${attempts.filter((x) => x.cls === c).length}`).join("; ")}; canned right ${cannedRight.length}, refused ${canned.filter((x) => x.outcome === "refused").length}${routine === null ? "" : `; routine cells ${routine.cells} in ${routine.offers} offers, errors ${routine.errors.length}`}; ${join(OUT, "guard-adversary.md")}\n`);
process.exitCode = VERIFIER === "refuse" && (unexempt().length > 0 || (routine?.errors.length ?? 0) > 0 || failures.length > 0) ? 1 : 0;
