// W1: the guard adversary. Canned Jev answers each fill question with the answer key's value, so a canned run never
// picks a plausible wrong candidate, and only live Jev found the wrong values fill's guards let through (LV1: a whole
// note line holding the right job title; a role and its employer for a company; a note-to-self instruction). This
// replays every eval set's desks offline and puts an adversary in Jev's place, both wordings agreeing at 0.9:
//   (a) for each field with a value in its key, each offered value that strictly holds the key's value (as whole words,
//       and not itself a value the key accepts), one at a time;
//   (b) for each field whose key is none, each offered value from a "Label: value" line of a note (a TextEdit window)
//       whose label shares a word with the field's label.
// Every whose and owner question answers "the user's", the answer that vetoes least. A value counts as written when a
// Fill all would write it (offers/fill-popup.ts writtenFields), and as handed off when it is offered for the user to set.
// Class (a) must be 0: it measures the code's guards, not the model. Class (b) is tracked; it has no target.
//
// Each set is asked two ways, and a value counts once if either writes it: a Fill all over the form's fields in parts
// of MAX_FIELDS (no scope), and the Ask the goal path makes ("fill out this form": a whole-form scope over the same
// parts). The Ask sets are asked with each ask's expected fields as its scope, the reading code should make. No Jev,
// no browser, no network. Fixture text only: every window and memory entry comes from fixture files and the evals'
// saved page walks.
//
//   node scripts/guard-adversary.ts --out DIR [--sets corpus,tasks-blind,tasks-labelled,w4,b24,b25,b26,b31]
//        [--corpus-pages DIR] [--tasks-pages DIR] [--w4-dir DIR] [--w4-key FILE] [--w4-note FILE]
//
// The page walks default to the evidence folders the evals wrote (D2-04's corpus pages, F1's task pages, W4's real
// sites); a task or W4 page whose walk is missing is reported as skipped, never as 0, and a corpus form with no walk is
// read from the reader's committed recording instead (set "corpus-reader"), which test/w1-wrongs.test.ts runs in the
// suite. Exit 1 when class (a) is above 0.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { forgetWindows } from "../src/privacy.ts";
import { MAX_FIELDS, proposeFill, type FillScope } from "../src/fill/fill.ts";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { aboutKind, type AboutValue } from "../src/fill/about.ts";
import { words } from "../src/fill/kinds.ts";
import { writtenFields } from "../src/offers/fill-popup.ts";
import { pageInputNodes } from "../src/goals/page-planner.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { EngineSession } from "../src/engines/session.ts";
import type { AskJev, JevRequest, JevResult } from "../src/fill/jev.ts";
import { PageSnapshot, PROTOCOL_VERSION, Snapshot, type FillProposal, type Node } from "../src/protocol.ts";
import { buildDesk, loadAsks, loadCorpus, nodesFor, normLabel, T0, type Corpus, type CorpusForm } from "./realfill-corpus.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const EVIDENCE = join(homedir(), ".caret-run", "evidence");
const a = parseArgs({
  options: {
    out: { type: "string" },
    sets: { type: "string", default: "corpus,tasks-blind,tasks-labelled,w4,b24,b25,b26,b31" },
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
// The generator's time budget reads a fixed clock, so a loaded machine cannot stop it partway and change what is offered.
setGeneratorClock(() => 0);

/** One field with a key: its node on the desk, its label, and the values the key takes. */
interface KeyField {
  key: string;
  label: string;
  expected: string;
  accept: readonly string[];
}
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

const session = new EngineSession({ engine: "replay", browser: { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" }, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
function pageWindow(file: string, seq: number): Snapshot {
  return toWindowSnapshot(PageSnapshot.parse(JSON.parse(readFileSync(file, "utf8"))), session, seq);
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
      return k === null ? [] : [{ key: k, label: f.label, expected: f.expected, accept: f.accept ?? [] }];
    });
    const keys = fields.map((f) => f.key);
    const parts = page ? pageParts(d.form) : Array.from({ length: Math.ceil(keys.length / MAX_FIELDS) }, (_, i) => keys.slice(i * MAX_FIELDS, (i + 1) * MAX_FIELDS));
    yield { set: page ? "corpus" : "corpus-reader", page: form.id, model: d.model, windowId: d.form.window.windowId, about: d.about, fields, parts, instruction: "fill out this form" };
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
    const e = JSON.parse(readFileSync(join(REPO, "fixtures", "web-form", "tasks", "expect", `${page}.json`), "utf8")) as { expected: Record<string, string>; sources: { note?: string; email?: { from: string; to: string; subject: string; body: string }; memory?: { key: string; value: string }[] } };
    const raw = PageSnapshot.parse(JSON.parse(readFileSync(file, "utf8")));
    const win = toWindowSnapshot(raw, session, 1);
    // Each oracle field's node: a control whose strong key names the element's name or id; a radio's or a Yes/No
    // question's group node stands for its buttons.
    const names = oracleNames(page);
    const byOracle = new Map<string, { key: string; label: string }>();
    for (const f of raw.frames) {
      for (const c of f.controls) {
        const strong = c.strongKey ?? "";
        const hit = [...names].find(([k]) => strong.includes(`"${k}"`));
        if (hit === undefined) continue;
        const node = win.nodes.find((n) => n.key === `f${f.frameId}/${c.key}`);
        if (node === undefined) continue;
        const parent = win.nodes.find((n) => n.key === node.parent && n.role === "AXGroup");
        const label = (parent?.label ?? c.name ?? "").replace(/[*:]+$/u, "").trim();
        if (!byOracle.has(hit[1])) byOracle.set(hit[1], { key: parent?.key ?? node.key, label });
      }
    }
    forgetWindows();
    const model = new ScreenModel();
    let about: AboutValue[] = [];
    if (labelled) {
      // page-loop-eval's labelled sources: one note of the page's own label and F1's value for each field.
      const lines = Object.entries(e.expected).flatMap(([k, v]) => {
        const n = byOracle.get(k);
        return v === "none" || n === undefined || n.label === "" ? [] : [`${n.label}: ${v === "true" ? "yes" : v === "false" ? "no" : v}`];
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
      return n === undefined ? [] : [{ key: n.key, label: n.label === "" ? k : n.label, expected: v, accept: [] }];
    });
    for (const k of Object.keys(e.expected)) if (!byOracle.has(k)) skipped.push(`${set}/${page}/${k}: no node`);
    yield { set, page, model, windowId: w.window.windowId, about, fields, parts: pageParts(w), instruction: "fill out this form" };
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
      return n === undefined ? [] : [{ key: n.key, label: k.label, expected: k.expected, accept: k.accept ?? [] }];
    });
    yield { set: "w4", page: site, model, windowId: w.window.windowId, about: [], fields, parts: pageParts(w), instruction: "fill in this application from my notes" };
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
      return f === undefined || k === null ? [] : [{ key: k, label, expected, accept: f.accept ?? [] }];
    });
    yield { set, page: `${x.id} (${x.form})`, model: d.model, windowId: d.form.window.windowId, about: d.about, fields, parts: [fields.map((f) => f.key)], instruction: x.instruction };
  }
}

/** The quoted value a question's option offers ('"text" (facts)'), or null for an option that quotes none. */
function optionText(desc: string | null | undefined): string | null {
  if (typeof desc !== "string" || !desc.startsWith('"')) return null;
  const end = desc.indexOf('" (', 1);
  if (end > 0) return desc.slice(1, end);
  return desc.endsWith('"') && desc.length > 1 ? desc.slice(1, -1) : null;
}
const isValueQuestion = (id: string, criteria: Record<string, unknown>): boolean => !id.endsWith("_whose") && !id.endsWith("_owner") && !("yes" in criteria && "no" in criteria);
const result = (answers: JevResult["answers"]): JevResult => ({ model: "adversary", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 });

/** The adversary: each value question of field `fid` takes the option quoting `want`; every other value question none. */
function adversary(fid: string | null, want: string | null, seen?: JevRequest[]): AskJev {
  return async (req) => {
    seen?.push(req);
    const answers: JevResult["answers"] = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const criteria = q.criteria as Record<string, string>;
      if (!isValueQuestion(id, criteria)) {
        answers[id] = { choice: "user" in criteria ? "user" : "yes" in criteria ? "yes" : (Object.keys(criteria)[0] ?? "none"), confidence: 0.9 };
        continue;
      }
      const hit = id === fid && want !== null ? Object.entries(criteria).find(([, d]) => optionText(d) === want)?.[0] : undefined;
      answers[id] = { choice: hit ?? "none", confidence: 0.9 };
    }
    return result(answers);
  };
}

/** Canned Jev: each value question of a field in `picks` takes the option quoting its key value; whose and owner the user's. */
function cannedJev(picks: ReadonlyMap<string, string>): AskJev {
  return async (req) => {
    const answers: JevResult["answers"] = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const criteria = q.criteria as Record<string, string>;
      if (!isValueQuestion(id, criteria)) {
        answers[id] = { choice: "user" in criteria ? "user" : "no" in criteria ? "no" : (Object.keys(criteria)[0] ?? "none"), confidence: 0.95 };
        continue;
      }
      const want = picks.get(id);
      const hit = want === undefined ? undefined : Object.entries(criteria).find(([, d]) => optionText(d) === want)?.[0];
      answers[id] = { choice: hit ?? "none", confidence: 0.95 };
    }
    return result(answers);
  };
}

interface Attempt {
  set: string;
  page: string;
  field: string;
  cls: "a" | "b";
  value: string;
  expected: string;
  /** rightValue: the control wrote (or offered) a value the key takes, read from the pick. */
  outcome: "written" | "handedOff" | "rightValue" | "withheld";
  why: string | null;
}
const attempts: Attempt[] = [];
/**
 * The guards' cost, on the same desks: each field asked with the key's own value picked when it is offered (canned Jev's
 * answer), counted right when a Fill all writes it, refused when a guard withholds it. A refused key value is a guard
 * that would cost a canned eval a right value; it must be 0.
 */
interface CannedRow {
  set: string;
  page: string;
  field: string;
  expected: string;
  outcome: "right" | "refused" | "notOffered";
  why: string | null;
}
const canned: CannedRow[] = [];
let fills = 0;

async function propose(d: Desk, part: string[], scoped: boolean, ask: AskJev): Promise<FillProposal | null> {
  const scope: FillScope | undefined = scoped ? { fields: part, windows: null, memory: true, instruction: d.instruction, person: null, literals: new Map(), wholeForm: true } : undefined;
  fills++;
  try {
    return await proposeFill(d.model, ask, d.windowId, part[0] as string, T0, { about: d.about, rand: () => 0, newId: () => `adv-${fills}`, ...(scoped ? { scope } : { only: part }) });
  } catch (e) {
    if (e instanceof Error && "why" in e) return null;
    throw e;
  }
}

/** For a desk: each part asked once with every answer none, which shows what each field is offered; then each attack. */
async function attack(d: Desk): Promise<void> {
  const byKey = new Map(d.fields.map((f) => [f.key, f]));
  for (const part of d.parts.map((p) => p.filter((k) => d.model.windows.get(d.windowId)?.nodes.has(k) === true)).filter((p) => p.length > 0)) {
    for (const scoped of [false, true]) {
      const seen: JevRequest[] = [];
      const probe = await propose(d, part, scoped, adversary(null, null, seen));
      if (probe === null) continue;
      // Question f<i> asks about the proposal's field i - 1 (fill.ts numbers its fields in the order it reads them).
      const offered = new Map<string, Map<string, string>>();
      for (const req of seen) {
        for (const [id, q] of Object.entries(req.questions)) {
          const criteria = q.criteria as Record<string, string>;
          if (!/^f\d+$/u.test(id) || !isValueQuestion(id, criteria)) continue;
          const key = probe.fields[Number(id.slice(1)) - 1]?.key;
          if (key === undefined) continue;
          const m = offered.get(key) ?? new Map<string, string>();
          for (const desc of Object.values(criteria)) {
            const t = optionText(desc);
            if (t !== null && !m.has(t)) m.set(t, desc);
          }
          offered.set(key, m);
        }
      }
      // Canned: every key value that is offered, at once, as canned Jev answers a fill.
      const keyText = new Map<string, string>();
      for (const [key, opts] of offered) {
        const kf = byKey.get(key);
        if (kf === undefined || NO_TEXT.has(kf.expected)) continue;
        const good = [kf.expected, ...kf.accept].map(norm);
        const t = [...opts.keys()].find((x) => good.includes(norm(x)));
        if (t !== undefined) keyText.set(`f${probe.fields.findIndex((f) => f.key === key) + 1}`, t);
      }
      const cp = await propose(d, part, scoped, cannedJev(keyText));
      const cw = cp === null ? [] : writtenFields(cp).fields;
      for (const [key, opts] of offered) {
        const kf = byKey.get(key);
        if (kf === undefined || NO_TEXT.has(kf.expected)) continue;
        const good = [kf.expected, ...kf.accept].map(norm);
        const isOffered = [...opts.keys()].some((x) => good.includes(norm(x)));
        const w = cw.find((x) => x.key === key);
        const f = cp?.fields.find((x) => x.key === key);
        const outcome: CannedRow["outcome"] = w !== undefined && good.includes(norm(w.value)) ? "right" : isOffered && (f?.withheld === "wrongKind" || f?.withheld === "ambiguous") ? "refused" : "notOffered";
        const prior = canned.find((x) => x.set === d.set && x.page === d.page && x.field === kf.label);
        const row: CannedRow = { set: d.set, page: d.page, field: kf.label, expected: kf.expected, outcome, why: f?.withheld ?? null };
        if (prior === undefined) canned.push(row);
        else if (outcome === "right" || (outcome === "refused" && prior.outcome === "notOffered")) Object.assign(prior, row);
      }
      for (const [key, opts] of offered) {
        const kf = byKey.get(key);
        if (kf === undefined) continue;
        const fid = `f${probe.fields.findIndex((f) => f.key === key) + 1}`;
        const good = [kf.expected, ...kf.accept].map(norm);
        const label = kf.label;
        for (const [text, desc] of opts) {
          let cls: "a" | "b" | null = null;
          if (!NO_TEXT.has(kf.expected) && !good.includes(norm(text)) && [kf.expected, ...kf.accept].some((v) => holdsWords(text, v))) cls = "a";
          else if (kf.expected === "none") {
            const lab = /labelled '([^']+)'/u.exec(desc)?.[1];
            const fieldWords = new Set(words(label));
            if (lab !== undefined && desc.includes("in TextEdit window") && words(lab).some((x) => fieldWords.has(x))) cls = "b";
          }
          if (cls === null) continue;
          // One attempt per field and value, whichever way it was asked first; a write either way counts.
          const prior = attempts.find((x) => x.set === d.set && x.page === d.page && x.field === label && x.value === text && x.cls === cls);
          if (prior?.outcome === "written") continue;
          const p = await propose(d, part, scoped, adversary(fid, text));
          const f = p?.fields.find((x) => x.key === key);
          // A control writes what it reads from the pick (a month menu takes "May" from "May 2021"): only a written value the
          // key does not take is a wrong one.
          const w = p === null ? undefined : writtenFields(p).fields.find((x) => x.key === key);
          const shown = f === undefined ? null : (f.value ?? f.handoff?.value ?? null);
          const outcome: Attempt["outcome"] =
            w !== undefined ? (good.includes(norm(w.value)) ? "rightValue" : "written") : shown !== null ? (good.includes(norm(shown)) ? "rightValue" : "handedOff") : "withheld";
          const row: Attempt = { set: d.set, page: d.page, field: label, cls, value: text, expected: kf.expected, outcome, why: f?.withheld ?? null };
          if (prior === undefined) attempts.push(row);
          else if (outcome === "written" || (outcome === "handedOff" && prior.outcome === "withheld")) Object.assign(prior, row);
        }
      }
    }
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

mkdirSync(OUT, { recursive: true });
const count = (cls: "a" | "b", outcome: Attempt["outcome"], set?: string): number => attempts.filter((x) => x.cls === cls && x.outcome === outcome && (set === undefined || x.set === set)).length;
const sets = Object.keys(desks);
const md = [
  "# Guard adversary (W1)",
  "",
  `Desks: ${sets.map((s) => `${s} ${desks[s]}`).join(", ")}. Fills asked: ${fills}. No Jev: an adversary answers every question at 0.9.`,
  "",
  `**Class (a), values that strictly hold the key's value: written ${count("a", "written")}** (handed off ${count("a", "handedOff")}, read to the key's own value ${count("a", "rightValue")}, withheld ${count("a", "withheld")}).`,
  `Class (b), values from a note line labelled like a field whose key is none: written ${count("b", "written")} (handed off ${count("b", "handedOff")}, withheld ${count("b", "withheld")}).`,
  "",
  "| set | (a) written | (a) handed off | (a) withheld | (b) written | (b) handed off | (b) withheld |",
  "|---|---|---|---|---|---|---|",
  ...sets.map((s) => `| ${s} | ${count("a", "written", s)} | ${count("a", "handedOff", s)} | ${count("a", "withheld", s)} | ${count("b", "written", s)} | ${count("b", "handedOff", s)} | ${count("b", "withheld", s)} |`),
  "",
  `Canned on the same desks (the key's own value picked where offered): right ${canned.filter((x) => x.outcome === "right").length}, **refused by a guard ${canned.filter((x) => x.outcome === "refused").length}**, not offered ${canned.filter((x) => x.outcome === "notOffered").length}.`,
  "",
  "| set | canned right | refused | not offered |",
  "|---|---|---|---|",
  ...sets.map((s) => `| ${s} | ${canned.filter((x) => x.set === s && x.outcome === "right").length} | ${canned.filter((x) => x.set === s && x.outcome === "refused").length} | ${canned.filter((x) => x.set === s && x.outcome === "notOffered").length} |`),
  "",
  "## Key values a guard refused",
  "",
  ...(canned.some((x) => x.outcome === "refused") ? canned.filter((x) => x.outcome === "refused").map((x) => `- ${x.set} / ${x.page} / ${x.field}: '${x.expected}' (${x.why})`) : ["None."]),
  "",
  "## Written",
  "",
  ...(attempts.some((x) => x.outcome === "written") ? attempts.filter((x) => x.outcome === "written").map((x) => `- (${x.cls}) ${x.set} / ${x.page} / ${x.field}: '${x.value}' (key '${x.expected}')`) : ["None."]),
  "",
  "## Skipped",
  "",
  ...(skipped.length > 0 ? skipped.map((s) => `- ${s}`) : ["None."]),
];
writeFileSync(join(OUT, "guard-adversary.md"), `${md.join("\n")}\n`);
writeFileSync(join(OUT, "guard-adversary.json"), `${JSON.stringify({ desks, fills, a: { written: count("a", "written"), handedOff: count("a", "handedOff"), withheld: count("a", "withheld") }, b: { written: count("b", "written"), handedOff: count("b", "handedOff"), withheld: count("b", "withheld") }, attempts, canned, skipped }, null, 1)}\n`);
process.stderr.write(`guard adversary: (a) written ${count("a", "written")} of ${attempts.filter((x) => x.cls === "a").length}; (b) written ${count("b", "written")} of ${attempts.filter((x) => x.cls === "b").length}; canned right ${canned.filter((x) => x.outcome === "right").length}, refused ${canned.filter((x) => x.outcome === "refused").length}; ${join(OUT, "guard-adversary.md")}\n`);
process.exitCode = count("a", "written") > 0 ? 1 : 0;
