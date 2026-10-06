// The browser loop's latency, end to end (P1, plans/fast-browser.md "Latency budget"). Each page loads in the run's own
// headless Chrome for Testing with the extension, through the signed bridge and test host to an in-process helper, as
// accept.ts runs them. Per page: the walk on load, Ask's intent (the heads maker's one request), the Fill all proposal
// (fill rounds), the writes Fill all makes through the executor and the page link, and the walk after them. Every page
// command is timed by the page link (engines/page-link.ts VerbTiming); the extension reports its own walk time, so a
// walk's round trip less that time is the hop chain (content script, worker, bridge, XPC host, helper).
//
//   node fixtures/web-form/page-loop-eval.ts --sign-identity SHA1 --out DIR [--jev canned|live] [--spend-limit USD]
//        [--pages id,id] [--w4-dir DIR] [--w4-key FILE] [--w4-note FILE] [--path fill|goal]
//        [--engine canned|jev|llama|gemini] [--log-requests FILE]
//
// J1: --engine names the decision engine in Jev's place (engines/decide/harness.ts; --jev live is --engine jev). Every
// engine but canned answers behind the record-and-replay cache (CARET_JEV_CACHE, replay-or-record by default), so a rerun
// of an unchanged page costs nothing. The cache and --log-requests take only the text of windows this eval put on the
// desk itself: the fixture page's tab and each page's replayed sources.
//
// --path goal (P2): Ask's whole-form instruction from a host that runs goals, planned by the page planner (goals/
// page-planner.ts): the preview, one acceptance, any reveal continuation (accepted too), and one undo per segment, which
// must put every field back. Beside it, the disagreement report: each fill-gated write is also put to the goal value
// gate's question (verifyWrites, goals/gates.ts jevGate), and each disagreement is scored against the answer key.
//
// Pages: the 14 forms of fixtures/realfill (B27's corpus), with their recorded notes and mails replayed into the helper
// as the reader shows them; and W4's saved real pages (Greenhouse, Lever, Ashby, HubSpot; ~/.caret-run/evidence/browser/
// w4/real, never committed), served with their scripts removed and a policy that loads nothing from any other origin,
// with W4's synthetic note. Canned Jev answers each fill question with the answer key's value, so every kind of write
// is made; live Jev is TypeSafe's, under --spend-limit. Nothing is pressed or submitted: the server counts any POST.
//
// --suite tasks (with --path goal): F1's browser task pages (tasks/site.ts TASK_PAGES) instead, served by FixtureSite
// in-process, with Chrome behind F1's network sink, scored by F1's oracle (oracle.ts), which reads the pages through
// their own probe and never through Caret. Each page's tasks/expect/<page>.json sources are replayed as the reader would
// show them: the email as a Mail window, then the note as a TextEdit window (the window the user just left), and each
// memory entry as an About entry. The wizard's pages are reached by the harness's own Next press after a second Ask
// and acceptance leaves Caret's fill on the page. Canned Jev finds a question's field by the texts the page's markup
// puts next to each data-oracle field (taskFields below), not by reading Caret's walk.
//
// Exit 0 when every page was walked, no field took a value the answer key does not allow, nothing was pressed and the
// POST count is 0 (tasks: no oracle wrong, submit, stray press, off-site request or probe error, every undo restored,
// every page previewed). The bridge and its test host must already be built (accept.ts builds them); the extension is
// rebuilt here. Keys come from CARET_ENV_FILE and are never printed.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Helper } from "../../helper/src/helper.ts";
import { Store } from "../../helper/src/store.ts";
import { pageHost } from "../../helper/src/engines/host.ts";
import { newLaunchSecret } from "../../helper/src/launch.ts";
import { wirePageEngines } from "../../helper/src/engines/wire.ts";
import { pageWindowId } from "../../helper/src/engines/windows.ts";
import type { VerbTiming } from "../../helper/src/engines/page-link.ts";
import type { EngineSession } from "../../helper/src/engines/session.ts";
import type { ReaderLink } from "../../helper/src/executor/means.ts";
import type { AskJev, JevRequest, JevResult } from "../../helper/src/fill/jev.ts";
import { harnessEngine } from "../../helper/src/engines/decide/harness.ts";
import { engineName } from "../../helper/src/engines/decide/port.ts";
import { PAGE_CHECKED, PROTOCOL_VERSION, Snapshot, type GoalProgress, type HelperMessage } from "../../helper/src/protocol.ts";
import type { WindowState } from "../../helper/src/model.ts";
import { intentSnapshot } from "../../helper/src/planner/intent.ts";
import { headsIntentMaker } from "../../helper/src/planner/intent-heads.ts";
import { jevGate } from "../../helper/src/goals/gates.ts";
import { readyOnLoad } from "../../helper/src/offers/ready-on-load.ts";
import { SnippetLedger } from "../../helper/src/privacy.ts";
import { loadAsks, loadCorpus, normLabel, type CorpusForm } from "../../helper/scripts/realfill-corpus.ts";
import { CFT_BUILD, Cdp, HOST_NAME, chrome, cleanup, designated, launch, launchdJob, preflight, setSay, signedCopy, sleep, tail, undo, writeManifest } from "./rig.ts";
import { NetworkSink, type Oracle, type Scored } from "./oracle.ts";
import { FixtureSite } from "./server.ts";
import { TASK_PAGES, loadExpectation, taskPage, type Expectation } from "./tasks/site.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const EXT = join(ROOT, "extension");
const BRIDGE = join(ROOT, "bridge", ".build", "release", "caret-bridge");
const TESTHOST = join(ROOT, "bridge", ".build", "release", "caret-bridge-testhost");
const W4 = join(homedir(), ".caret-run", "evidence", "browser", "w4");

const { values: args } = parseArgs({
  options: {
    "sign-identity": { type: "string" },
    out: { type: "string" },
    jev: { type: "string", default: "canned" },
    /** J1: the decision engine; overrides --jev. */
    engine: { type: "string" },
    /** J1: every request's full body, for the token breakdown (fixture text only). */
    "log-requests": { type: "string" },
    "spend-limit": { type: "string", default: "0.04" },
    pages: { type: "string" },
    corpus: { type: "string", default: join(ROOT, "fixtures", "realfill") },
    windows: { type: "string", default: join(ROOT, "helper", "fixtures", "recorded", "realfill-windows.ndjson") },
    "w4-dir": { type: "string", default: join(W4, "real") },
    "w4-key": { type: "string", default: join(W4, "replay", "key.json") },
    "w4-note": { type: "string", default: join(W4, "replay", "note.txt") },
    /** Writes every Jev question and answer to this NDJSON file (synthetic and public form text only). */
    "log-jev": { type: "string" },
    /** fill: P1's Fill all (Command-1). goal: P2's Ask on the page, planned by the page planner. */
    path: { type: "string", default: "fill" },
    /** corpus: the realfill corpus and W4's saved pages. tasks: F1's browser task pages, scored by F1's oracle (goal path only). */
    suite: { type: "string", default: "corpus" },
    /**
     * Task pages only. blind: F1's own sources (its note, email and memory, written blind to fill). labelled: one note
     * of "Label: value" lines, each the page's own label for a field and F1's expected value, so every reveal trigger
     * is a value fill can copy; it measures the loop's mechanics (Tabs, reveals, control kinds), not fill's reading.
     */
    sources: { type: "string", default: "blind" },
    /**
     * P3. wizard: F1's three-page wizard as one journey: one Ask on page 1, each next page reached by the harness's Next
     * and offered by the carried goal (reason nextPage), page 3's resume attached by its file input with a file the
     * eval confirms (wizard-drop: by the dropzone instead). load: every page of the suite loaded with no Ask and no focus,
     * counting the ready-on-load offers and their Jev requests, plus a search-only and a login page.
     */
    journey: { type: "string" },
  },
});
if (args["sign-identity"] === undefined || args.out === undefined) throw new Error("--sign-identity and --out are required");
if (args.jev !== "canned" && args.jev !== "live") throw new Error("--jev is canned or live");
if (args.path !== "fill" && args.path !== "goal") throw new Error("--path is fill or goal");
if (args.suite !== "corpus" && args.suite !== "tasks") throw new Error("--suite is corpus or tasks");
if (args.suite === "tasks" && args.path !== "goal") throw new Error("--suite tasks runs the goal path only: add --path goal");
const GOAL = args.path === "goal";
const TASKS = args.suite === "tasks";
if (args.sources !== "blind" && args.sources !== "labelled") throw new Error("--sources is blind or labelled");
const LABELLED = args.sources === "labelled";
const OUT = args.out;
const JOURNEY = args.journey ?? null;
if (JOURNEY !== null && !["wizard", "wizard-drop", "load"].includes(JOURNEY)) throw new Error("--journey is wizard, wizard-drop or load");
if (JOURNEY !== null && JOURNEY !== "load" && !TASKS) throw new Error("--journey wizard runs on --suite tasks");
const ENGINE = engineName(args.engine ?? (args.jev === "live" ? "jev" : "canned"));
/** Spends money: Jev itself. */
const LIVE = ENGINE === "jev";
const CANNED = ENGINE === "canned";
const SPEND_LIMIT = Number(args["spend-limit"]);

const t0 = Date.now();
const say = (s: string): void => void process.stdout.write(`[page-loop +${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}\n`);
setSay(say);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void cleanup().then(() => process.exit(130)));

/** W4's saved real pages, by the brief: Greenhouse, Lever, Ashby and HubSpot (Workday's saved page is a job list). */
const W4_SITES = ["greenhouse-discord", "greenhouse-embed-figma", "lever-palantir-apply", "ashby-ramp-application", "hubspot-contact-sales"];

interface Expect {
  label: string;
  expected: string;
  accept: string[];
  /** The corpus's control kind; null for W4's key, which does not say. */
  control: string | null;
}
interface Page {
  id: string;
  kind: "corpus" | "w4" | "task";
  path: string;
  /** The answer key: what each field may hold after the fill. */
  key: Expect[];
  /** Ask's instruction for the intent: the form's first B24 ask, else a whole-form request. */
  instruction: string;
  /** Windows the reader would show beside the page, oldest first; the last is the one the user just left. */
  sources: Snapshot[];
  /** What the user told Caret, for a form whose source is memory. */
  about: { label: string; value: string }[];
  /** A task page's expectations by data-oracle name (tasks/expect/<page>.json); the oracle scores against these. */
  expected?: Record<string, string>;
}

// ---- pages ----
const corpus = loadCorpus(args.corpus);
const asks = loadAsks(args.corpus, corpus);
const recorded = readFileSync(args.windows, "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
const recordedFor = (title: string): Snapshot => {
  const hits = recorded.filter((s) => s.window.title === title || s.window.title.startsWith(`${title} - `));
  if (hits.length !== 1) throw new Error(`${hits.length} recorded windows are titled '${title}'`);
  return hits[0] as Snapshot;
};
const corpusPage = (f: CorpusForm): Page => ({
  id: f.id,
  kind: "corpus",
  path: `/corpus/${f.id}.html`,
  key: f.fields.map((x) => ({ label: x.label, expected: x.expected, accept: x.accept ?? [], control: x.control })),
  instruction: asks.find((x) => x.form === f.id && x.expected !== "refuse")?.instruction ?? "fill in everything you can from my notes",
  sources: [...corpus.decoys, f.source].flatMap((s) => (s.kind === "memory" ? [] : [recordedFor(s.title ?? "")])),
  about: f.source.kind === "memory" ? f.source.about : [],
});
const w4Key = existsSync(args["w4-key"]) ? (JSON.parse(readFileSync(args["w4-key"], "utf8")) as { sites: Record<string, { label: string; expected: string; accept?: string[] }[]> }).sites : {};
const w4Note = existsSync(args["w4-note"]) ? readFileSync(args["w4-note"], "utf8") : "";
const noteWindow = (text: string): Snapshot => ({
  type: "snapshot",
  v: PROTOCOL_VERSION,
  seq: 1,
  at: Date.now(),
  reason: "initial",
  app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" },
  window: { windowId: "w4-note", kind: "standard", title: "Application details.txt", frame: [0, 0, 700, 500] },
  focused: true,
  root: null,
  nodes: [{ key: "com.apple.TextEdit/standard/textarea:~0", parent: null, role: "AXTextArea", value: text, editable: true }],
  values: [],
  focusedKey: null,
  stats: { walkMs: 0, visited: 1, truncated: false },
});
const w4Page = (site: string): Page => ({
  id: site,
  kind: "w4",
  path: `/w4/${site}.html`,
  key: (w4Key[site] ?? []).map((x) => ({ label: x.label, expected: x.expected, accept: x.accept ?? [], control: null })),
  instruction: "fill in this application from my notes",
  sources: [noteWindow(w4Note)],
  about: [],
});
/** A task page's email as Mail shows it: its header lines and its body as static text, top to bottom. */
const mailWindow = (m: Expectation["sources"]["email"]): Snapshot => {
  const line = (n: number, text: string, height = 18): Snapshot["nodes"][number] => ({ key: `com.apple.mail/standard/statictext:~${n}`, parent: null, role: "AXStaticText", value: text, frame: [20, 560 + n * 24, 860, height] });
  return {
    type: "snapshot",
    v: PROTOCOL_VERSION,
    seq: 1,
    at: Date.now(),
    reason: "initial",
    app: { pid: 7002, bundleId: "com.apple.mail", name: "Mail" },
    window: { windowId: "task-mail", kind: "standard", title: m.subject, frame: [0, 520, 900, 640] },
    focused: false,
    root: null,
    nodes: [line(0, `From: ${m.from}`), line(1, `To: ${m.to}`), line(2, `Subject: ${m.subject}`), line(3, m.body, 400)],
    values: [],
    focusedKey: null,
    stats: { walkMs: 0, visited: 4, truncated: false },
  };
};
/** The goal path's Ask on every page. It names no source: see askGoal. */
const TASK_INSTRUCTION = "fill out this form";
/** F1's task pages: the email focused first and the note last, so the note is the window the user just left. */
const taskPageOf = (name: string): Page => {
  const e = loadExpectation(name);
  return {
    id: name,
    kind: "task",
    path: taskPage(name).path,
    key: [],
    instruction: TASK_INSTRUCTION,
    sources: [mailWindow(e.sources.email), noteWindow(e.sources.note)],
    about: e.sources.memory.map((m) => ({ label: m.key, value: m.value })),
    expected: e.expected,
  };
};
const wanted = args.pages?.split(",");
const pages: Page[] = (
  TASKS
    ? TASK_PAGES.map((t) => taskPageOf(t.name))
    : [...corpus.forms.map(corpusPage), ...(existsSync(args["w4-dir"]) ? W4_SITES.filter((s) => existsSync(join(args["w4-dir"], `${s}.html`))).map(w4Page) : [])]
).filter((p) => wanted === undefined || wanted.includes(p.id));
if (pages.length === 0) throw new Error("no pages to run");

// ---- the site: the corpus forms and W4's saved markup, on 127.0.0.1; any POST is counted and refused ----
let posts = 0;
/** Nothing from another origin, no script, no frame: the saved real pages render as markup only. */
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; script-src 'none'; frame-src 'none'; connect-src 'self'; form-action 'self'";
function serve(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET") {
      posts++;
      res.writeHead(403).end();
      return;
    }
    const html = (body: string): void => void res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "no-store" }).end(body);
    if (url.pathname === "/blank.html") return html("<!doctype html><title>blank</title><p>page-loop eval</p>");
    // P3's load journey: a page whose only field is a search box, and a login page (synthetic).
    if (url.pathname === "/p3/search.html") return html('<!doctype html><title>Jobs</title><form role="search" action="/s"><label>Search jobs <input type="search" name="q"></label> <label>Search location <input type="search" name="where"></label><button>Search</button></form>');
    if (url.pathname === "/p3/login.html") return html('<!doctype html><title>Sign in</title><form action="/login"><label>Email <input type="email" name="email"></label> <label>Password <input type="password" name="pw"></label><button>Sign in</button></form>');
    const c = /^\/corpus\/([\w-]+)\.html$/.exec(url.pathname);
    const form = c === null ? undefined : corpus.forms.find((f) => f.id === c[1]);
    if (form !== undefined) return html(readFileSync(join(args.corpus, form.file), "utf8"));
    const w = /^\/w4\/([\w-]+)\.html$/.exec(url.pathname);
    if (w !== null && W4_SITES.includes(w[1] as string)) {
      const raw = readFileSync(join(args["w4-dir"], `${w[1]}.html`), "utf8");
      return html(raw.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "").replace(/<base\b[^>]*>/gi, ""));
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

// ---- Jev ----
let page: Page | null = null;
let stage = "";
const calls: { page: string; stage: string; inputTokens: number; latencyMs: number; costUsd: number }[] = [];
let spent = 0;
/** The answer key's value for a fill question's field, by the label its descriptor quotes. */
const keyFor = (ins: string): Expect | undefined => {
  const label = /Label: '([^']+)'/u.exec(ins)?.[1];
  return label === undefined ? undefined : page?.key.find((k) => normLabel(k.label) === normLabel(label));
};
/**
 * Whether a candidate's quoted text is the key's value as a person wrote it: the same text; for a date or time field the
 * same day or minute ("March 3, 1991" for 1991-03-03, "7:30 pm" for 19:30); for a field with options, the option as a
 * whole word ("Large, mushroom and onion" for Large). Canned Jev only; fill's own rules still decide what is written.
 */
function fits(text: string, e: Expect): boolean {
  const values = e.expected === "none" || e.expected === "handoff" || e.expected === "unchecked" ? [] : [e.expected, ...e.accept];
  if (values.includes(text)) return true;
  if (e.control === "date") {
    const d = new Date(Date.parse(text.replace(/^born\s+/iu, "")));
    const iso = Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return iso !== null && values.includes(iso);
  }
  if (e.control === "time") {
    const m = /\b(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\b/iu.exec(text);
    const hhmm = m === null ? null : `${String((Number(m[1]) % 12) + (m[3]?.toLowerCase() === "p" ? 12 : 0)).padStart(2, "0")}:${m[2]}`;
    return hhmm !== null && values.includes(hhmm);
  }
  if (e.control === "radio" || e.control === "select" || e.control === "combobox") return namesOption(text, values);
  // Task pages only. A month field: the same month ("August 2022" for 2022-08).
  if (e.control === "month") {
    const d = new Date(Date.parse(text));
    return !Number.isNaN(d.getTime()) && values.includes(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  // A picker or react-select lists options by search: the option as a whole word, or two or more words that each start
  // a word of the option, as the page's own search matches them ("San Diego, California" finds "San Diego, California,
  // United States"). One word is not enough: "Portland" would stand for either Portland.
  if (e.control === "picker") {
    const words = (s: string): string[] => s.toLowerCase().split(/[\s,]+/u).filter((x) => x !== "");
    const typed = words(text);
    return namesOption(text, values) || (typed.length >= 2 && values.some((v) => typed.every((w) => words(v).some((p) => p.startsWith(w)))));
  }
  return false;
}
/** Whether `text` holds one of `values` as a whole word ("Large, mushroom and onion" for Large). */
const namesOption = (text: string, values: readonly string[]): boolean => values.some((v) => new RegExp(`(?:^|[^\\p{L}])${v.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:$|[^\\p{L}])`, "iu").test(text));

// ---- task pages: which data-oracle field a fill question is about ----
/**
 * A task page field as the page's markup names it: its data-oracle name and kind, its control's type, and every text the
 * markup puts next to it that could label it (label[for], aria-labelledby, aria-label, a wrapping label, a fieldset's
 * legend, the label of its row, a placeholder). Read from the live page (frames and open shadow roots included), since
 * some labels follow the page's state (State reads Province for Canada).
 */
interface TaskField {
  name: string;
  kind: string;
  type: string;
  names: string[];
}
/**
 * Run in the page through the DevTools pipe: every [data-oracle] field of the document, its same-origin frames and its
 * open shadow roots, with the texts next to it. A radio's own label ("Yes") is left out: it names an option, not the field.
 */
const TASK_FIELDS_JS = `(() => {
  const clean = (s) => (s ?? "").replace(/\\s+/g, " ").trim();
  const out = [];
  const visit = (root) => {
    for (const e of root.querySelectorAll("[data-oracle]")) {
      const controls = e.matches("input, select, textarea") ? [e] : [...e.querySelectorAll("input, select, textarea, [role=combobox], button")];
      const names = new Set();
      const add = (s) => { const t = clean(s); if (t !== "") names.add(t); };
      const refs = (ids) => {
        if (!ids) return;
        const parts = ids.split(/\\s+/).filter(Boolean).map((id) => clean(root.getElementById(id)?.textContent));
        add(parts.join(" "));
        for (const x of parts) add(x);
      };
      for (const x of [e, ...controls]) {
        if (x.id) for (const l of root.querySelectorAll('label[for="' + CSS.escape(x.id) + '"]')) add(l.textContent);
        refs(x.getAttribute("aria-labelledby"));
        refs(x.getAttribute("data-labelledby"));
        add(x.getAttribute("aria-label"));
        if (!(x.tagName === "INPUT" && x.type === "radio")) add(x.closest("label")?.textContent);
        add(x.getAttribute("placeholder"));
      }
      if (e.tagName === "FIELDSET") add(e.querySelector("legend")?.textContent);
      // The row's label, unless it is another field's own (Ashby's Phone row also holds the SMS consent radios).
      const head = e.closest(".row, [data-field-path]")?.querySelector("label, .label");
      const owner = head?.getAttribute("for") ? root.getElementById(head.getAttribute("for")) : null;
      if (head && !head.contains(e) && (owner === null || owner === e || controls.includes(owner))) add(head.textContent);
      const c = controls[0];
      out.push({ name: e.getAttribute("data-oracle"), kind: e.getAttribute("data-oracle-kind") ?? "", type: c === undefined ? "" : (c.getAttribute("type") ?? c.tagName.toLowerCase()), names: [...names] });
    }
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) visit(el.shadowRoot);
      if (el.tagName === "IFRAME") {
        let d = null;
        try { d = el.contentDocument; } catch {}
        if (d) visit(d);
      }
    }
  };
  visit(document);
  return out;
})()`;
/**
 * Run in the page: each [data-oracle] field's own state, read from the DOM (value, selected option, checked boxes and
 * radios), across same-origin frames and open shadow roots. The undo check reads it beside the oracle (P2): F1's probe
 * posts state with fetch keepalive and drops a failed post after recording it as sent, so a burst of restores can
 * leave the oracle on an older reading (tasks-forty-debug: the DOM empty, the oracle still "Josephine").
 */
const DOM_VALUES_JS = `(() => {
  const out = {};
  const visit = (root) => {
    for (const e of root.querySelectorAll("[data-oracle]")) {
      const xs = e.matches("input, select, textarea") ? [e] : [...e.querySelectorAll("input, select, textarea")];
      out[e.getAttribute("data-oracle")] = JSON.stringify(xs.map((x) => (x.type === "checkbox" || x.type === "radio" ? x.checked : x.tagName === "SELECT" ? x.value : x.type === "file" ? x.files?.length ?? 0 : x.value)));
    }
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) visit(el.shadowRoot);
      if (el.tagName === "IFRAME") {
        let d = null;
        try { d = el.contentDocument; } catch {}
        if (d) visit(d);
      }
    }
  };
  visit(document);
  return out;
})()`;
/** Reads the current page's TaskFields; set once the browser is up. */
let readTaskFields: (() => Promise<TaskField[]>) | null = null;
/** The current page's fields as last read; null until the first question about a page. */
let taskFields: TaskField[] | null = null;
/** Per task page: what canned Jev picked for each field it was asked about while the Ask ran (null: none), and question labels that named no field or several. */
interface TaskAsks {
  picked: Map<string, string | null>;
  unmapped: Set<string>;
  ambiguous: Set<string>;
}
const taskAsks = new Map<string, TaskAsks>();
const asksOn = (id: string): TaskAsks => {
  let a = taskAsks.get(id);
  if (a === undefined) taskAsks.set(id, (a = { picked: new Map(), unmapped: new Set(), ambiguous: new Set() }));
  return a;
};
/** Fields whose markup names `said`; a label the descriptor cut ("…") matches by its start. */
function fieldsNamed(said: string, fields: readonly TaskField[]): TaskField[] {
  const want = normLabel(said);
  const cut = want.endsWith("…") ? want.slice(0, -1).trim() : null;
  return fields.filter((f) => f.names.some((n) => (cut === null ? normLabel(n) === want : normLabel(n).startsWith(cut))));
}
/** fits()'s control for a task field: option lists by their kind, dates and months by their input type. */
const controlOf = (f: TaskField): string | null =>
  f.kind === "select" || f.kind === "radios" || f.kind === "pressgroup" ? "select" : f.kind === "react-select" || f.kind === "picker" ? "picker" : f.type === "date" || f.type === "month" || f.type === "time" ? f.type : null;
/** The texts a fill question names its field by (descriptor.ts, controls.ts), in the order they are tried. A label may hold an apostrophe ("Referrer's name"), so each ends at "'." */
const SAID = [/Label: '(.+?)'\.(?=\s|$)/u, /Nearest label: '(.+?)'\.(?=\s|$)/u, /Placeholder: '(.+?)'\.(?=\s|$)/u];
/**
 * The task page expectation for a fill question's field: the one data-oracle field whose markup carries the question's
 * label (else its nearest label, else its placeholder). A label no field carries rereads the page once, for a field
 * revealed or relabelled since; a label two fields carry answers nothing.
 */
async function taskKeyFor(ins: string): Promise<Expect | undefined> {
  const p = page;
  if (p?.expected === undefined || readTaskFields === null) return undefined;
  const said = SAID.flatMap((re) => {
    const m = re.exec(ins)?.[1];
    return m === undefined ? [] : [m];
  });
  if (said.length === 0) return undefined;
  const log = asksOn(p.id);
  for (let fresh = taskFields === null; ; fresh = true) {
    if (fresh) taskFields = await readTaskFields();
    for (const s of said) {
      const hits = fieldsNamed(s, taskFields ?? []);
      const f = hits[0];
      if (hits.length === 1 && f !== undefined) return { label: f.name, expected: p.expected[f.name] ?? "none", accept: [], control: controlOf(f) };
      if (hits.length > 1) {
        log.ambiguous.add(`'${s}': ${hits.map((h) => h.name).join(", ")}`);
        return undefined;
      }
    }
    if (fresh) break;
  }
  log.unmapped.add(said.map((s) => `'${s}'`).join(" / "));
  return undefined;
}

/** Canned Jev: Ask's heads read the whole form from any source for the user; each fill question takes the answer key's value. */
const canned: AskJev = async (req: JevRequest): Promise<JevResult> => {
  if ("scope" in req.questions) {
    const pick: Record<string, string> = { scope: "all", source: "any", whose: "user", why: "nothingToFill", section: "none" };
    return { model: "canned", answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { choice: pick[k] ?? "none", confidence: 0.9 }])), nouls: Object.fromEntries(Object.keys(req.nouls ?? {}).map((k) => [k, 0])), inputTokens: 0, latencyMs: 0, costUsd: 0 };
  }
  const entries = Object.entries(req.questions);
  const filled = (k: string, q: (typeof entries)[number][1]): boolean => !(k.endsWith("_whose") || k.endsWith("_owner") || ("yes" in q.criteria && "no" in q.criteria));
  const instructionsOf = (q: (typeof entries)[number][1]): string => (typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions));
  const keys = await Promise.all(entries.map(([k, q]) => (!filled(k, q) ? undefined : TASKS ? taskKeyFor(instructionsOf(q)) : keyFor(instructionsOf(q)))));
  const answers = Object.fromEntries(
    entries.map(([k, q], i) => {
      if (k.endsWith("_whose") || k.endsWith("_owner")) return [k, { choice: "user", confidence: 0.95 }];
      if ("yes" in q.criteria && "no" in q.criteria) return [k, { choice: "no", confidence: 0.95 }];
      const e = keys[i];
      const quoted = (t: string | null): string | null => (t === null ? null : (/^"([^"]*)"/u.exec(t)?.[1] ?? null));
      const hit = e === undefined ? undefined : Object.entries(q.criteria).find(([, t]) => {
        const text = quoted(t);
        return text !== null && fits(text, e);
      })?.[0];
      // Task pages: what canned Jev picked for each field the Ask (and its reveal) asked about; a pick is never replaced by a later none.
      if (TASKS && e !== undefined && page !== null && (stage === "ask" || stage === "writes")) {
        const picked = asksOn(page.id).picked;
        const text = hit === undefined ? null : quoted(q.criteria[hit] ?? null);
        if (text !== null || !picked.has(e.label)) picked.set(e.label, text);
      }
      return [k, hit === undefined ? { choice: "none" in q.criteria ? "none" : (Object.keys(q.criteria)[0] ?? "none"), confidence: 0.9 } : { choice: hit, confidence: 0.95 }];
    }),
  );
  return { model: "canned", answers, ...(req.nouls === undefined ? {} : { nouls: Object.fromEntries(Object.keys(req.nouls).map((k) => [k, 0])) }), inputTokens: 0, latencyMs: 0, costUsd: 0 };
};
/** Windows this eval put on the desk from fixtures: the fixture page's tab and each page's replayed sources. */
const fixtureIds = new Set<string>();
const decide = harnessEngine({ name: ENGINE, canned, fixture: { windows: (id) => fixtureIds.has(id), memory: true, plan: true }, ...(args["log-requests"] === undefined ? {} : { logRequests: args["log-requests"] }) });
const askJev: AskJev = async (req) => {
  if (spent >= SPEND_LIMIT) throw new Error(`spend limit $${SPEND_LIMIT} reached`);
  const r = await decide.ask(req);
  spent += r.costUsd;
  if (args["log-jev"] !== undefined) appendFileSync(args["log-jev"], `${JSON.stringify({ page: page?.id ?? "", stage, questions: Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, { ins: String(q.instructions).slice(0, 400), criteria: q.criteria }])), answers: r.answers, nouls: r.nouls ?? {} })}\n`);
  calls.push({ page: page?.id ?? "", stage, inputTokens: r.inputTokens, latencyMs: r.latencyMs, costUsd: r.costUsd });
  return r;
};

// ---- timings ----
const timings: (VerbTiming & { page: string; stage: string })[] = [];
const ms = (from: number): number => Math.round((performance.now() - from) * 10) / 10;

interface Row {
  id: string;
  kind: Page["kind"];
  controls: number;
  /** The load walk: its round trip, the extension's time, and the slowest frame's own walk in the page. */
  walk: { commandMs: number; extensionMs: number | null; contentMs: number | null } | null;
  intent: { ms: number; jevMs: number; requests: number; scope: string; route: string } | null;
  fill: { ms: number; jevMs: number; requests: number; proposed: number; withheld: number } | null;
  previewMs: number | null;
  run: { ms: number; outcome: string; detail: string | null; writes: number } | null;
  finalWalk: { commandMs: number; extensionMs: number | null; contentMs: number | null } | null;
  pageMs: number | null;
  wrong: string[];
  written: number;
  error: string | null;
  /** P2's goal path: what the preview offered, what one Tab wrote, the reveal, the undo, and the disagreement report. */
  goal: {
    previewMs: number;
    steps: number;
    left: number;
    tabs: number;
    eligible: number;
    eligibleWritten: number;
    /** From the last write's verified step to the reveal's preview, when the page revealed controls. */
    revealMs: number | null;
    restored: boolean;
    notRestored: string[];
    outcome: string;
    disagreements: { field: string; value: string; verify: "dropped" | "kept"; key: "right" | "wrong" | "unscored" }[];
    verifyRequests: number;
    /** C1: what the preview said Caret left, and how each segment ended (a stop's or finish's own words), for diagnosis. */
    warnings: string[];
    ended: string[];
    /** C1: Jev requests this page made outside the disagreement report: the Ask's, and any fill a focus asked for. */
    jevRequests: number;
  } | null;
  /** A task page, by F1's oracle (--suite tasks only). */
  task?: TaskRow;
}

interface TaskRow {
  /** How the page was reached: navigated, or the harness's Next on the wizard page before. */
  arrived: string;
  /** Fields the oracle still read as changed after the undo while the DOM read them as before (the probe's lag). */
  oracleLag?: string[];
  /** The preview's warnings, what Caret said it left. */
  warnings: string[];
  /** Whether the oracle scored the page (right, eligible, wrong and missed below hold its result). */
  scored: boolean;
  right: number;
  eligible: number;
  wrong: Scored["wrong"];
  /** Expected a value, still empty; each says what canned Jev picked for it, if it was asked. */
  missed: string[];
  absent: string[];
  /** wizard-3's file fields: P3's attach gap, not counted as missed. */
  attachGap: string[];
  /** Expected fields hidden when the page loaded, when no afterReveal preview came. */
  revealMissing: string[];
  /** The second Ask that leaves Caret's fill on a wizard page before the harness presses Next. */
  refill: string | null;
  unmapped: string[];
  ambiguous: string[];
}

/** How the goal path judges a task page: by the oracle, not by Caret's walk. */
interface TaskJudge {
  preview(reply: Segment): void;
  /** Scores the page once the probe's reports settle; fills the row's wrong and its task fields. */
  score(): Promise<{ eligible: number; right: number }>;
  /** Fields whose value differs from the reading before the Ask. */
  unrestored(): Promise<string[]>;
  /** A write the disagreement report names, judged by the expectation of the field its label names. */
  scoreWrite(label: string, value: string): "right" | "wrong" | "unscored";
}
type Segment = Extract<GoalProgress, { event: "segment" }>;

async function main(): Promise<number> {
  preflight();
  for (const f of [BRIDGE, TESTHOST]) if (!existsSync(f)) throw new Error(`${f} is missing: build it first (accept.ts builds the bridge and its test host)`);
  say("building the extension");
  execFileSync(process.execPath, [join(EXT, "build.mjs")], { stdio: "inherit" });
  const exe = await chrome();
  const extensionId = readFileSync(join(EXT, "EXTENSION_ID"), "utf8").trim();
  mkdirSync(OUT, { recursive: true });

  const tmp = mkdtempSync(join(tmpdir(), "caret-loop-"));
  undo.push({ what: `temporary directory ${tmp}`, fn: () => rmSync(tmp, { recursive: true, force: true }) });
  const site = await serve();
  undo.push({ what: "page server", fn: () => new Promise<void>((r) => (site.server.closeAllConnections(), site.server.close(() => r()))) });
  // Task pages: F1's site in-process, its oracle, and the network sink Chrome is launched behind.
  let fixture: { site: FixtureSite; sink: NetworkSink } | null = null;
  if (TASKS) {
    const fs = new FixtureSite();
    await fs.start();
    undo.push({ what: "fixture site", fn: () => fs.stop() });
    const sink = new NetworkSink(fs.tasks.oracle);
    await sink.start();
    undo.push({ what: "network sink", fn: () => sink.stop() });
    fixture = { site: fs, sink };
  }

  const sockDir = join(tmp, "s");
  mkdirSync(sockDir, { mode: 0o700 });
  const sockPath = join(sockDir, "page.sock");
  // No native reader: its one verb a page task needs, watchInput, is answered ok (as accept.ts does), so the page engine's own guard is what reports input.
  const noReader: ReaderLink = { run: async (v) => ({ type: "verbResult", v: 1, id: "none", at: Date.now(), outcome: v.kind === "watchInput" ? "ok" : "noWindow", detail: v.kind === "watchInput" ? null : "no reader in this eval" }) };
  const store = new Store(join(tmp, "data"));
  let helper: Helper;
  const secret = newLaunchSecret();
  const warnings: string[] = [];
  const host = pageHost({ path: sockPath, secret, reader: noReader, apply: (m) => void helper.handleReader(m), warn: (l) => void warnings.push(l), onTiming: (t) => void timings.push({ ...t, page: page?.id ?? "", stage }) });
  const published: HelperMessage[] = [];
  helper = new Helper({ store, askJev, shadow: false, allowBackgroundFocus: false, readerLink: host.link, pageCovers: (pid) => host.registry.forBrowser(pid) !== undefined, pageDocument: (id) => host.registry.documentOf(id), pageContext: (id) => host.registry.contextOf(id), calendar: null, publish: (m) => void published.push(m), warn: (l) => void warnings.push(l), ...(GOAL ? { ask: { maker: "heads" as const } } : {}), ...(JOURNEY !== null ? { goalFiles: true } : {}),
    // I6: the load journey measures each page's own verdict, so the hour's offer budget (four, balanced) is lifted: P3's
    // run read W4's five saved pages 0 of 5 because the first four corpus pages had spent it (helper.ts pageWalked).
    ...(JOURNEY === "load" ? { offersPerHour: 1000 } : {}) });
  wirePageEngines({ host, helper, publish: (m) => void published.push(m), warn: (l) => void warnings.push(l) });
  await host.server.listen();
  undo.push({ what: "helper", fn: async () => (await host.server.close(), helper.shutdown(), helper.memory.close(), store.close()) });

  const bin = join(tmp, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const sign = args["sign-identity"] as string;
  const bridge = signedCopy(BRIDGE, join(bin, "caret-bridge"), "dev.caret.bridge", sign);
  const testHost = signedCopy(TESTHOST, join(bin, "caret-bridge-testhost"), "dev.caret.host", sign);
  const cftApp = exe.slice(0, exe.indexOf(".app/") + 4);
  const service = `dev.caret.w3test.${randomBytes(4).toString("hex")}`;
  const secretFile = join(sockDir, "launch-secret");
  writeFileSync(secretFile, secret.toString("hex"), { mode: 0o600 });
  await launchdJob(tmp, service, service, [testHost, "--service", service, "--socket", sockPath, "--secret-file", secretFile, "--browser-requirement", designated(cftApp)], join(tmp, "testhost.log"));
  const profile = join(tmp, "profile");
  writeManifest(join(profile, "NativeMessagingHosts"), extensionId, bridge);
  const log = join(tmp, "chrome.log");
  const since = Date.now();
  const browser = launch(exe, profile, [`${site.origin}/blank.html`], { ...process.env, CARET_BRIDGE_SERVICE: service }, join(EXT, "dist"), log, ["--window-size=1280,1600", ...(fixture?.sink.chromeFlags() ?? [])], true);
  let session: EngineSession;
  try {
    session = await host.registry.waitForEngine((s) => s.info.extensionId === extensionId && s.info.connectedAt >= since, 30_000);
  } catch {
    throw new Error(`no engine said hello; Chrome log: ${tail(log)}`);
  }
  say(`engine ${session.info.engine}, Chrome for Testing ${CFT_BUILD} pid ${session.info.browser.pid}`);
  const cdp = browser.cdp as Cdp;
  const { sessionId } = await cdp.page(`${site.origin}/blank.html`);
  let first = await session.command({ kind: "pageWalk", tabId: null });
  for (let i = 0; i < 40 && first.snapshot === null; i++) (await sleep(250), (first = await session.command({ kind: "pageWalk", tabId: null })));
  if (first.snapshot === null) throw new Error(`the blank page was never walked: ${first.result.outcome} ${first.result.detail ?? ""}`);
  const tabId = first.snapshot.tabId;
  const windowId = pageWindowId(session.info.engine, tabId);
  fixtureIds.add(windowId);
  const pid = session.info.browser.pid;
  const textEdit = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };
  /** The slowest frame's own walk in the tab's last snapshot (content.ts), or null from an extension that does not say. */
  const contentMs = (): number | null => {
    const xs = (session.tabs.get(tabId)?.frames ?? []).flatMap((f) => (f.walkMs === undefined ? [] : [f.walkMs]));
    return xs.length === 0 ? null : Math.max(...xs);
  };
  const evaluate = async (expression: string): Promise<unknown> => ((await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)) as { result: { value?: unknown } }).result.value;

  /** Whether the answer key allows what a field now holds; null for a field the key does not score. */
  const scoreField = (label: string, now: string): boolean | null => {
    const e = page?.key.find((k) => normLabel(k.label) === normLabel(label));
    if (e === undefined || e.expected === "handoff") return null;
    return e.expected === "checked" ? now === PAGE_CHECKED : e.expected !== "none" && e.expected !== "unchecked" && (now === e.expected || e.accept.includes(now));
  };
  /**
   * Ask's whole-form instruction on this page: the first segment's preview, or why there is none. Every page asks "fill
   * out this form", which names no source: "from my notes" makes code read only the window it resolves "my notes" to
   * (planner/sources.ts; intent.ts "A picked source is the only one"), which on the corpus was a decoy note
   * (evidence/screen/p2/goal-canned-2) and on F1's pages left out its email and memory (tasks-dev2).
   */
  const askGoal = async (p: Page, requestId: string): Promise<Segment | string> => {
    // P1's per-page instruction (Page.instruction) stays the fill path's intent probe; the goal path asks the whole form.
    const instruction = TASK_INSTRUCTION;
    const reply = await helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId, at: Date.now(), instruction, windowId }, undefined, true, true);
    if (reply.type === "goalProgress" && reply.event === "segment") return reply;
    return `no preview: ${reply.type === "goalProgress" ? `${reply.event} ${"says" in reply ? reply.says : ""}` : reply.type === "askQuestion" ? `asked: ${reply.text}` : `${reply.type} ${"error" in reply && reply.error !== null ? JSON.stringify(reply.error).slice(0, 200) : ""}`}`;
  };
  /** One Tab: the preview's acceptance. Then any segment the writes revealed, each its own Tab. `mark` is where the Ask's messages start. */
  const acceptAll = async (reply: Segment, mark: number): Promise<{ segments: { goalId: string }[]; tabs: number; revealMs: number | null; outcome: string }> => {
    const segments: { goalId: string }[] = [{ goalId: reply.goalId }];
    let tabs = 0;
    let revealMs: number | null = null;
    let outcome = "refused";
    let next: Segment | undefined = reply;
    while (next !== undefined && tabs < 4) {
      tabs++;
      const r = await helper.handleGoalAccept({ type: "goalAccept", v: PROTOCOL_VERSION, goalId: next.goalId, segment: next.segment, digest: next.digest, at: Date.now() });
      const lastWrite = performance.now();
      await helper.goals.idle();
      outcome = r?.outcome ?? "refused";
      const fin = published.slice(mark).filter((m) => m.type === "goalProgress" && m.goalId === next?.goalId && m.event === "finished").at(-1);
      if (fin?.type === "goalProgress" && fin.event === "finished") outcome = fin.outcome;
      const goalIds = new Set(segments.map((x) => x.goalId));
      const more = published.slice(mark).find((m): m is Segment => m.type === "goalProgress" && m.event === "segment" && !goalIds.has(m.goalId));
      if (more !== undefined && more.reason === "afterReveal") {
        revealMs ??= ms(lastWrite);
        segments.push({ goalId: more.goalId });
      }
      next = more;
    }
    return { segments, tabs, revealMs, outcome };
  };
  /** P2: the Ask's goal on this page, from its preview to its undo (see the header). A task page is judged by `task`, the oracle. */
  const goalPath = async (p: Page, row: Row, ready: number, w: WindowState, before: Map<string, string>, task: TaskJudge | null = null): Promise<void> => {
    stage = "ask";
    const mark = published.length;
    const reply = await askGoal(p, `eval-${p.id}`);
    const previewMs = ms(ready);
    if (typeof reply === "string") {
      row.error = reply;
      row.pageMs = ms(ready);
      return;
    }
    task?.preview(reply);
    // The disagreement report: the goal value gate's question on every fill-gated write of the plan, scored by the key.
    stage = "verify";
    const plan = helper.goals.planOf(reply.goalId);
    const gated = (plan?.segments ?? []).flatMap((s) => s.steps).filter((x) => x.gate === "fill" && x.value !== null);
    const v0 = calls.length;
    const dropped = gated.length === 0 ? new Map<string, string>() : await jevGate(plan?.instruction ?? "", gated.map((x) => ({ ref: x.ref, target: x.target, written: x.writes ?? x.value?.text ?? "", value: x.value as NonNullable<typeof x.value> })), askJev, new SnippetLedger(helper.model.windows.values()));
    const disagreements = gated.flatMap((x) => {
      const verdict = dropped.has(x.ref) ? ("dropped" as const) : ("kept" as const);
      const node = w.nodes.get(x.target.key);
      const label = node?.label ?? x.target.own;
      const right = task === null ? scoreField(label, x.writes ?? "") : task.scoreWrite(label, x.writes ?? "");
      const key = right === null || right === "unscored" ? ("unscored" as const) : right === true || right === "right" ? ("right" as const) : ("wrong" as const);
      // Only the writes verifyWrites would drop disagree with fill; each kept one agrees.
      return verdict === "dropped" ? [{ field: x.target.label, value: x.writes ?? "", verify: verdict, key }] : [];
    });
    const verifyRequests = calls.length - v0;
    stage = "writes";
    const { segments, tabs, revealMs, outcome } = await acceptAll(reply, mark);
    row.pageMs = ms(ready);
    stage = "final";
    await host.link.run({ kind: "walk", pid, windowId });
    const after = helper.model.windows.get(windowId) as WindowState;
    let eligibleWritten = 0;
    for (const n of after.nodes.values()) {
      const was = before.get(n.key) ?? "";
      const now = n.value ?? "";
      if (n.editable !== true || now === was) continue;
      row.written++;
      if (task !== null) continue;
      const ok = scoreField(n.label ?? "", now);
      if (ok === false) row.wrong.push(`${n.label ?? n.key}: '${now}'`);
      if (ok === true) eligibleWritten++;
    }
    let eligible = p.key.filter((k) => k.expected !== "none" && k.expected !== "handoff" && k.expected !== "unchecked").length;
    if (task !== null) ({ eligible, right: eligibleWritten } = await task.score());
    // One undo per segment, newest first: every field must hold what it held before the Ask.
    stage = "undo";
    const notRestored: string[] = [];
    for (const sgt of [...segments].reverse()) {
      if (!helper.executor.has(`${sgt.goalId}:s0`)) continue;
      const u = await helper.executor.undo(`${sgt.goalId}:s0`);
      notRestored.push(...u.notRestored.map((x) => x.reason));
    }
    await host.link.run({ kind: "walk", pid, windowId });
    if (task === null) {
      const undone = helper.model.windows.get(windowId) as WindowState;
      const differ = [...undone.nodes.values()].filter((n) => n.editable === true && (n.value ?? "") !== (before.get(n.key) ?? ""));
      for (const n of differ) notRestored.push(`${n.label ?? n.key} holds '${n.value ?? ""}'`);
    } else notRestored.push(...(await task.unrestored()));
    const goalIds = new Set(segments.map((x) => x.goalId));
    const ended = published.slice(mark).flatMap((m) => (m.type === "goalProgress" && goalIds.has(m.goalId) && (m.event === "stopped" || m.event === "finished") ? [`${m.event}: ${m.says}${m.event === "finished" && m.left.length > 0 ? ` [left: ${m.left.join(" / ")}]` : ""}`] : []));
    const jevRequests = calls.filter((c) => c.page === p.id && c.stage !== "verify").length;
    row.goal = { previewMs, steps: reply.steps.length, left: reply.warnings.length, tabs, eligible, eligibleWritten, revealMs, restored: notRestored.length === 0, notRestored, outcome, disagreements, verifyRequests, warnings: reply.warnings, ended, jevRequests };
  };

  /** The desk: last page's sources and memory gone, this page's in place, the source focused last and left for the browser. */
  const desk = (p: Page): void => {
    for (const w of [...helper.model.windows.values()]) if (w.window.windowId !== windowId) helper.handleReader({ type: "windowClosed", v: 1, at: Date.now(), windowId: w.window.windowId });
    for (const e of helper.handleMemory({ type: "memoryRequest", v: 1, requestId: "l", op: "list", kind: "about" }).entries ?? []) helper.handleMemory({ type: "memoryRequest", v: 1, requestId: "f", op: "forget", id: e.id });
    for (const a of p.about) {
      const added = helper.handleMemory({ type: "memoryRequest", v: 1, requestId: "a", op: "add", kind: "about", fields: { label: a.label, value: a.value, source: "typed" } });
      if (added.error !== null) throw new Error(`About '${a.label}' was not added: ${added.error}`);
    }
    for (const s of p.sources) fixtureIds.add(s.window.windowId);
    const base = Date.now() - 60_000 * p.sources.length;
    p.sources.forEach((s, i) => void helper.handleReader({ ...s, at: base + i * 60_000, focused: i === p.sources.length - 1 }));
    helper.handleReader({ type: "appSwitch", v: 1, at: Date.now(), from: textEdit, to: session.info.browser });
  };
  const newRow = (p: Page): Row => ({ id: p.id, kind: p.kind, controls: 0, walk: null, intent: null, fill: null, previewMs: null, run: null, finalWalk: null, pageMs: null, wrong: [], written: 0, error: null, goal: null });

  // ---- task pages (--suite tasks): the goal path on each, judged by F1's oracle ----
  const runTasks = async (fs: FixtureSite): Promise<number> => {
    const oracle = fs.tasks.oracle;
    readTaskFields = async () => {
      const v = await evaluate(TASK_FIELDS_JS);
      if (!Array.isArray(v)) throw new Error(`reading the task page's fields gave ${JSON.stringify(v)?.slice(0, 200)}`);
      return v as TaskField[];
    };
    /** The page's values once two readings 200 ms apart agree (probe.js posts each change as it happens), at most 4 s. */
    const settle = async (name: string): Promise<Record<string, string>> => {
      let prev = JSON.stringify(oracle.values(name));
      for (let i = 0; i < 20; i++) {
        await sleep(200);
        const now = JSON.stringify(oracle.values(name));
        if (now === prev) break;
        prev = now;
      }
      return JSON.parse(prev) as Record<string, string>;
    };
    // --sources labelled: each page's note from its own labels (read with every dependent section shown) and F1's values.
    if (LABELLED) {
      for (const p of pages) {
        const expected = p.expected as Record<string, string>;
        await cdp.send("Page.navigate", { url: `${fs.mainOrigin}${p.path}?show=all` }, sessionId);
        let fields: TaskField[] = [];
        for (let n = 0; n < 40; n++) {
          await sleep(150);
          const v = await evaluate(TASK_FIELDS_JS);
          fields = Array.isArray(v) ? (v as TaskField[]) : [];
          if (Object.keys(expected).every((k) => fields.some((f) => f.name === k))) break;
        }
        const lines = Object.entries(expected).flatMap(([k, v]) => {
          const f = fields.find((x) => x.name === k);
          const label = f?.names.find((x) => x.trim() !== "")?.trim().replace(/[*:]+$/u, "").trim();
          if (v === "none" || f === undefined || label === undefined || f.kind === "file") return [];
          return [`${label}: ${f.kind === "checkbox" ? (v === "true" ? "yes" : "no") : v}`];
        });
        p.sources = [noteWindow(lines.join("\n"))];
        p.about = [];
        say(`${p.id}: labelled note of ${lines.length} lines`);
      }
    }
    const rows: Row[] = [];
    /** The wizard page whose Next the harness presses to reach the next page, once Caret's fill is on it. */
    let pressFrom: string | null = null;
    for (const [i, p] of pages.entries()) {
      page = p;
      taskFields = null;
      const name = p.id;
      const expected = p.expected as Record<string, string>;
      const row = newRow(p);
      const t: TaskRow = { arrived: "navigated", warnings: [], scored: false, right: 0, eligible: 0, wrong: [], missed: [], absent: [], attachGap: [], revealMissing: [], refill: null, unmapped: [], ambiguous: [] };
      row.task = t;
      rows.push(row);
      const from = pressFrom;
      pressFrom = null;
      try {
        desk(p);
        // Load: by the harness's Next from the wizard page before, else by navigating. Ready is the oracle's first full
        // report from this load (every field the expectations name, from every frame), as tests/browser.test.ts waits.
        stage = "load";
        const old = new Set(oracle.loads(name));
        if (from !== null) {
          try {
            await fs.tasks.harnessPress(from, "next");
            t.arrived = `harness Next on ${from}`;
          } catch (e) {
            t.arrived = `navigated: the harness Next on ${from} failed (${e instanceof Error ? e.message : String(e)})`;
            await cdp.send("Page.navigate", { url: `${fs.mainOrigin}${p.path}` }, sessionId);
          }
        } else await cdp.send("Page.navigate", { url: `${fs.mainOrigin}${p.path}` }, sessionId);
        const frames = taskPage(name).files.length;
        await oracle.waitFor(() => oracle.currentLoads(name).filter((l) => !old.has(l)).length === frames && Object.keys(expected).every((k) => k in oracle.values(name)), `${name}'s first full report from this load`, 15_000);
        const ready = performance.now();
        // The walk must show an editable control: Ashby renders its form 400 ms after load.
        stage = "walk";
        let w: WindowState | undefined;
        for (let n = 0; n < 50; n++) {
          const walked = await host.link.run({ kind: "walk", pid, windowId });
          w = walked.outcome === "ok" ? helper.model.windows.get(windowId) : undefined;
          if (w !== undefined && [...w.nodes.values()].some((x) => x.editable === true)) break;
          w = undefined;
          await sleep(100);
        }
        if (w === undefined) throw new Error(`the walk never showed an editable control on ${name}`);
        const w0 = timings.filter((x) => x.page === p.id && x.stage === "walk").at(-1);
        row.walk = w0 === undefined ? null : { commandMs: w0.commandMs, extensionMs: w0.extensionMs, contentMs: contentMs() };
        const before = new Map([...w.nodes.values()].map((n) => [n.key, n.value ?? ""]));
        row.controls = [...w.nodes.values()].filter((n) => n.editable === true).length;
        const oracleBefore = await settle(name);
        const domBefore = (await evaluate(DOM_VALUES_JS)) as Record<string, string>;
        const hiddenAtLoad = Object.entries(oracle.readings(name) ?? {}).filter(([k, r]) => !r.visible && (expected[k] ?? "none") !== "none").map(([k]) => k);

        // wizard-3's file fields are P3's attach gap (the dropzone's input is hidden): not a fill miss.
        const attachGap = (): string[] => (name === "wizard-3" ? Object.entries(oracle.readings(name) ?? {}).filter(([, r]) => r.kind === "file").map(([k]) => k) : []);
        const eligibleOf = (gap: readonly string[]): number => Object.entries(expected).filter(([k, v]) => v !== "none" && !gap.includes(k)).length;
        const judge: TaskJudge = {
          preview: (reply) => void (t.warnings = reply.warnings),
          score: async () => {
            await settle(name);
            t.scored = true;
            const s = oracle.score(name, expected);
            const gap = attachGap();
            const kinds = oracle.readings(name) ?? {};
            const picked = asksOn(name).picked;
            t.eligible = eligibleOf(gap);
            t.right = s.right.filter((k) => !gap.includes(k)).length;
            t.wrong = s.wrong;
            row.wrong = s.wrong.map((x) => `${x.field}: '${x.actual}' (expected ${x.expected})`);
            t.missed = s.missed.filter((k) => !gap.includes(k)).map((k) => `${k} (${kinds[k]?.kind === "file" ? "file; " : ""}${!picked.has(k) ? "canned never asked" : picked.get(k) === null ? "canned: none" : `canned picked '${picked.get(k)}'`})`);
            t.attachGap = gap.filter((k) => (expected[k] ?? "none") !== "none");
            t.absent = s.absent;
            return { eligible: t.eligible, right: t.right };
          },
          unrestored: async () => {
            // A field is unrestored when the DOM itself differs from before the Ask; one only the oracle still shows
            // as changed is the probe's lag, said apart (oracleLag).
            const now = await settle(name);
            const dom = (await evaluate(DOM_VALUES_JS)) as Record<string, string>;
            const differs = [...new Set([...Object.keys(oracleBefore), ...Object.keys(now)])].filter((k) => (now[k] ?? "") !== (oracleBefore[k] ?? ""));
            const real = [...new Set([...Object.keys(domBefore), ...Object.keys(dom)])].filter((k) => (dom[k] ?? "") !== (domBefore[k] ?? ""));
            t.oracleLag = differs.filter((k) => !real.includes(k));
            return real.map((k) => `${k}: the DOM holds ${dom[k] ?? "nothing"} (was ${domBefore[k] ?? "nothing"}; the oracle reads '${now[k] ?? ""}')`);
          },
          scoreWrite: (label, value) => {
            const hits = fieldsNamed(label, taskFields ?? []);
            const f = hits[0];
            const want = f === undefined || hits.length > 1 ? undefined : expected[f.name];
            if (f === undefined || want === undefined) return "unscored";
            if (want === "none") return "wrong";
            if (value === want) return "right";
            // A typed text is compared as written; a pick, a date or a number may be written in another form than the oracle reads.
            return f.kind === "text" && !["date", "month", "time", "number"].includes(f.type) ? "wrong" : "unscored";
          },
        };
        await goalPath(p, row, ready, w, before, judge);
        // A page with no preview is scored as it stands, so its missed fields say what canned Jev was offered.
        if (row.goal === null) await judge.score();
        if (hiddenAtLoad.length > 0 && row.goal !== null && row.goal.revealMs === null) t.revealMissing = hiddenAtLoad;

        // The wizard: a second Ask leaves Caret's fill on the page, and the harness presses Next to the next page (pressed
        // even when the first Ask had no preview, so the next page still loads the way a person reaches it).
        const nextName = taskPage(name).next;
        if (nextName !== null && pages[i + 1]?.id === nextName) pressFrom = name;
        if (pressFrom !== null && row.goal !== null) {
          stage = "refill";
          const mark = published.length;
          const again = await askGoal(p, `eval-${p.id}-again`);
          if (typeof again === "string") t.refill = `second Ask: ${again}`;
          else {
            const r = await acceptAll(again, mark);
            await settle(name);
            const s = oracle.score(name, expected);
            const gap = attachGap();
            t.refill = `${s.right.filter((k) => !gap.includes(k)).length}/${eligibleOf(gap)} right, ${s.wrong.length} wrong (${r.outcome}, ${r.tabs} tabs)`;
            row.wrong.push(...s.wrong.map((x) => `second Ask ${x.field}: '${x.actual}' (expected ${x.expected})`));
          }
        }
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e);
      }
      const a = asksOn(name);
      t.unmapped = [...a.unmapped];
      t.ambiguous = [...a.ambiguous];
      say(`${name} (${t.arrived}): goal ${row.goal?.outcome ?? "-"}, preview ${fmt(row.goal?.previewMs ?? null)} ms, ${row.goal?.steps ?? 0} steps, right ${t.right}/${t.eligible}, wrong ${t.wrong.length}${t.wrong.length > 0 ? ` (${row.wrong.join("; ")})` : ""}, missed ${t.missed.length}, tabs ${row.goal?.tabs ?? 0}, reveal ${fmt(row.goal?.revealMs ?? null)} ms, undo ${row.goal === null ? "-" : row.goal.restored ? "restored" : `NOT restored ${row.goal.notRestored.join("; ")}`}${(t.oracleLag?.length ?? 0) > 0 ? ` (the oracle lagged on ${t.oracleLag?.length ?? 0} fields the DOM shows restored)` : ""}, page ${fmt(row.pageMs)} ms${t.refill === null ? "" : `; second Ask ${t.refill}`}${row.error === null ? "" : `; ${row.error}`}`);
    }
    page = null;
    readTaskFields = null;

    const presses = timings.filter((x) => x.verb === "pagePress" || x.verb === "pageAttachFile").length;
    const sum = oracle.summary();
    writeTaskReport(rows, presses, sum);
    const wrong = rows.reduce((n, r) => n + r.wrong.length, 0);
    const failed = [
      wrong > 0 ? `${wrong} wrong` : "",
      sum.submits > 0 ? `${sum.submits} submits` : "",
      sum.strayPresses.length > 0 ? `${sum.strayPresses.length} stray presses` : "",
      sum.offsite.length > 0 ? `${sum.offsite.length} off-site requests` : "",
      sum.probeErrors.length > 0 ? `${sum.probeErrors.length} probe errors` : "",
      presses > 0 ? `${presses} page-link presses` : "",
      posts > 0 ? `${posts} POSTs to the blank-page server` : "",
      // No preview fails a page, except one with nothing eligible to fill (wizard-3 once its file fields, P3's attach gap,
      // are set aside), where Caret's "found nothing to put in" is the right answer.
      ...rows.filter((r) => r.goal === null && !(r.task?.scored === true && r.task.eligible === 0 && r.error?.startsWith("no preview") === true)).map((r) => `${r.id}: no preview (${r.error ?? "?"})`),
      ...rows.filter((r) => r.goal !== null && !r.goal.restored).map((r) => `${r.id}: undo not restored`),
    ].filter((x) => x !== "");
    say(`pages ${rows.length}, wrong ${wrong}, submits ${sum.submits}, stray presses ${sum.strayPresses.length}, off-site ${sum.offsite.length}, probe errors ${sum.probeErrors.length}, presses ${presses}; ${failed.length === 0 ? "pass" : `FAIL: ${failed.join("; ")}`}`);
    return failed.length === 0 ? 0 : 1;
  };
  // ---- P3 journeys (--journey) ----
  /** Every write verb the page link sent, by document and control: a second one for the same pair is a replayed write. */
  const sent = new Map<string, number>();
  const command = session.command.bind(session);
  session.command = ((verb, timeoutMs) => {
    if (verb.kind !== "pageWalk" && "documentId" in verb && "id" in verb) {
      const k = `${verb.kind}|${verb.documentId}|${verb.id}`;
      sent.set(k, (sent.get(k) ?? 0) + 1);
    }
    return command(verb, timeoutMs);
  }) as typeof session.command;
  const nextSegment = async (after: number, ms0: number): Promise<Segment | null> => {
    for (let n = 0; n < 250; n++) {
      const m = published.slice(after).find((x): x is Segment => x.type === "goalProgress" && x.event === "segment" && x.reason === "nextPage");
      if (m !== undefined) return m;
      if (performance.now() - ms0 > 5000) return null;
      await sleep(20);
    }
    return null;
  };
  const finishedOf = async (goalId: string): Promise<Extract<GoalProgress, { event: "finished" }> | null> => {
    for (let n = 0; n < 200; n++) {
      await helper.goals.idle();
      const f = published.find((x): x is Extract<GoalProgress, { event: "finished" }> => x.type === "goalProgress" && x.event === "finished" && x.goalId === goalId);
      if (f !== undefined) return f;
      await sleep(25);
    }
    return null;
  };
  const runWizard = async (fs: FixtureSite, drop: boolean): Promise<number> => {
    const oracle = fs.tasks.oracle;
    // Diagnostics: the worker's focus reports (the content script's ready report among them) and the page walks.
    let focusReports = 0;
    const onFocus = session.onFocus;
    session.onFocus = (m, x) => {
      focusReports++;
      onFocus?.(m, x);
    };
    readTaskFields = async () => {
      const v = await evaluate(TASK_FIELDS_JS);
      if (!Array.isArray(v)) throw new Error(`reading the task page's fields gave ${JSON.stringify(v)?.slice(0, 200)}`);
      return v as TaskField[];
    };
    const settleOracle = async (name: string): Promise<void> => {
      let prev = JSON.stringify(oracle.values(name));
      for (let i = 0; i < 20; i++) {
        await sleep(200);
        const now = JSON.stringify(oracle.values(name));
        if (now === prev) break;
        prev = now;
      }
    };
    const wiz = ["wizard-1", "wizard-2", "wizard-3"].map((n) => pages.find((p) => p.id === n) ?? taskPageOf(n));
    // In the dropzone journey the user gives the resume to the dropzone's row: that field, not the file input, holds it.
    if (drop) {
      const e = wiz[2]?.expected as Record<string, string>;
      (wiz[2] as Page).expected = { ...e, resume: "none", resume_drop: e.resume ?? "none" };
    }
    // --sources labelled: one note of the wizard's three pages, each line a field's own label and F1's value (runTasks
    // builds one per page; the journey's pages share one person and one note).
    if (LABELLED) {
      const all: string[] = [];
      for (const p of wiz) {
        const expected = p.expected as Record<string, string>;
        await cdp.send("Page.navigate", { url: `${fs.mainOrigin}${p.path}?show=all` }, sessionId);
        let fields: TaskField[] = [];
        for (let n = 0; n < 40; n++) {
          await sleep(150);
          const v = await evaluate(TASK_FIELDS_JS);
          fields = Array.isArray(v) ? (v as TaskField[]) : [];
          if (Object.keys(expected).every((k) => fields.some((f) => f.name === k))) break;
        }
        for (const [k, v] of Object.entries(expected)) {
          const f = fields.find((x) => x.name === k);
          const label = f?.names.find((x) => x.trim() !== "")?.trim().replace(/[*:]+$/u, "").trim();
          if (v === "none" || f === undefined || label === undefined || f.kind === "file") continue;
          all.push(`${label}: ${f.kind === "checkbox" ? (v === "true" ? "yes" : "no") : v}`);
        }
      }
      for (const p of wiz) {
        p.sources = [noteWindow(all.join("\n"))];
        p.about = [];
      }
      say(`wizard: labelled note of ${all.length} lines`);
    }
    // The resume the user chooses in page 3's attach row: the one the recruiter's email names (tasks/expect/wizard-3.json).
    const resume = join(tmp, "ines-vandermeer-resume-2026.pdf");
    writeFileSync(resume, "%PDF-1.4\n% synthetic resume for the P3 wizard journey\n");
    const out: { page: string; arrived: string; previewMs: number | null; steps: number; attach: string | null; outcome: string; right: number; eligible: number; wrong: string[]; missed: string[]; note: string }[] = [];
    desk(wiz[0] as Page);
    let goalId: string | null = null;
    let lastName: string | null = null;
    for (const p of wiz) {
      page = p;
      taskFields = null;
      const name = p.id;
      const expected = p.expected as Record<string, string>;
      const row = { page: name, arrived: "", previewMs: null as number | null, steps: 0, attach: null as string | null, outcome: "-", right: 0, eligible: Object.values(expected).filter((v) => v !== "none").length, wrong: [] as string[], missed: [] as string[], note: "" };
      out.push(row);
      try {
        stage = "load";
        const old = new Set(oracle.loads(name));
        const mark = published.length;
        if (lastName === null) {
          await cdp.send("Page.navigate", { url: `${fs.mainOrigin}${p.path}` }, sessionId);
          row.arrived = "navigated";
        } else {
          await fs.tasks.harnessPress(lastName, "next");
          row.arrived = `harness Next on ${lastName}`;
        }
        const frames = taskPage(name).files.length;
        await oracle.waitFor(() => oracle.currentLoads(name).filter((l) => !old.has(l)).length === frames && Object.keys(expected).every((k) => k in oracle.values(name)), `${name}'s first full report`, 15_000);
        const ready = performance.now();
        let seg: Segment | null;
        if (lastName === null) {
          // Page 1: the user's Ask. The walk must show a field first (the oracle's report can come before the engine's).
          for (let n = 0; n < 50; n++) {
            const walked = await host.link.run({ kind: "walk", pid, windowId });
            const w = walked.outcome === "ok" ? helper.model.windows.get(windowId) : undefined;
            if (w !== undefined && [...w.nodes.values()].some((x) => x.editable === true)) break;
            await sleep(100);
          }
          stage = "ask";
          const r = await askGoal(p, "p3-wizard");
          seg = typeof r === "string" ? null : r;
          if (seg === null) row.note = r as string;
        } else {
          // Pages 2 and 3: nothing but the page load. The content script's ready report walks the tab; the carried goal plans it.
          stage = "carry";
          const f0 = focusReports;
          seg = await nextSegment(mark, ready);
          if (seg === null) row.note = `no nextPage preview within 5 s of the load (${focusReports - f0} focus reports from the worker since; document ${host.registry.documentOf(windowId) ?? "?"})`;
        }
        row.previewMs = seg === null ? null : ms(ready);
        if (seg === null) {
          lastName = name;
          continue;
        }
        row.steps = seg.steps.length;
        // Page 3: the eval plays the user choosing the resume in an attach row (the input's, or the dropzone's).
        const rows = seg.steps.filter((x) => x.kind === "attach");
        const pick = rows.find((x) => (drop ? /drop/i.test(x.says) : !/drop/i.test(x.says)));
        row.attach = rows.length === 0 ? null : `${rows.map((x) => x.says).join(" | ")}${pick === undefined ? "" : ` -> chose ${pick.says.split(":")[0]}`}`;
        stage = "writes";
        await helper.handleGoalAccept({ type: "goalAccept", v: PROTOCOL_VERSION, goalId: seg.goalId, segment: seg.segment, digest: seg.digest, at: Date.now(), ...(pick === undefined ? {} : { confirmedFile: { step: pick.index, path: resume } }) });
        const fin = await finishedOf(seg.goalId);
        const stop = published.find((x): x is Extract<GoalProgress, { event: "stopped" }> => x.type === "goalProgress" && x.event === "stopped" && x.goalId === seg?.goalId);
        row.outcome = fin?.outcome ?? (stop === undefined ? "not finished" : `stopped (${stop.reason}: ${stop.says.slice(0, 160)})`);
        if (fin !== null && fin.left.length > 0) row.note = `left: ${fin.left.join(" / ").slice(0, 300)}`;
        goalId = seg.goalId;
        const plan = helper.goals.planOf(seg.goalId);
        row.note = `${row.note === "" ? "" : `${row.note}; `}scope ${plan?.page?.kind ?? "?"}, carrying ${helper.goals.carrying(windowId, null)}`;
        await settleOracle(name);
        const sc = oracle.score(name, expected);
        row.right = sc.right.length;
        row.wrong = sc.wrong.map((x) => `${x.field}: '${x.actual}' (expected ${x.expected})`);
        row.missed = sc.missed;
      } catch (e) {
        row.note = e instanceof Error ? e.message : String(e);
      }
      lastName = name;
      say(`${name} (${row.arrived}): preview ${fmt(row.previewMs)} ms, ${row.steps} steps, ${row.outcome}, right ${row.right}/${row.eligible}, wrong ${row.wrong.length}${row.wrong.length > 0 ? ` (${row.wrong.join("; ")})` : ""}${row.attach === null ? "" : `; attach ${row.attach}`}${row.note === "" ? "" : `; ${row.note}`}`);
    }
    page = null;
    readTaskFields = null;
    const sum = oracle.summary();
    const values3 = oracle.values("wizard-3");
    const attached = drop ? values3.resume_drop : values3.resume;
    const replayed = [...sent].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
    const presses = timings.filter((x) => x.verb === "pagePress").length;
    const lines = [
      `# P3 wizard journey (${drop ? "attach by dropzone" : "attach by file input"}), ${new Date().toISOString()}`,
      "",
      `Decisions: ${decide.says}; sources ${LABELLED ? "labelled" : "blind (F1's note, email and memory)"}. One Ask on wizard-1; wizard-2 and wizard-3 reached by the harness's Next and offered by the carried goal. Preview time is from the oracle's first full report of the load.`,
      "",
      "| page | arrived | preview ms | steps | outcome | right / eligible | wrong | missed | attach | note |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...out.map((r) => `| ${r.page} | ${cell(r.arrived)} | ${fmt(r.previewMs)} | ${r.steps} | ${r.outcome} | ${r.right} / ${r.eligible} | ${cell(r.wrong.join("; ") || "0")} | ${cell(r.missed.join(", ") || "-")} | ${cell(r.attach ?? "-")} | ${cell(r.note || "-")} |`),
      "",
      `- wizard-3 ${drop ? "resume_drop" : "resume"} reads: ${attached ?? "(nothing)"}; the other file field: ${(drop ? values3.resume : values3.resume_drop) || "(empty)"}`,
      `- submits ${sum.submits}, stray presses ${sum.strayPresses.length}, page-link presses ${presses}, off-site ${sum.offsite.length}, probe errors ${sum.probeErrors.length}, POSTs to the blank server ${posts}`,
      `- write verbs sent ${[...sent.values()].reduce((a, b) => a + b, 0)}, replayed ${replayed.length}${replayed.length > 0 ? `: ${replayed.join(", ")}` : ""}`,
      `- Jev requests ${calls.length}${LIVE ? `, $${spent.toFixed(4)}` : ""}; last goal ${goalId ?? "-"}`,
      "",
      "Helper warnings about goals and fills (synthetic page text only):",
      "",
      ...warnings.filter((l) => /^goal |^fill/u.test(l)).slice(-30).map((l) => `- ${cell(l, 300)}`),
    ];
    writeFileSync(join(OUT, drop ? "wizard-drop.md" : "wizard.md"), lines.join("\n") + "\n");
    // R1: the same rows as data, with each decision request's latency, for the slow runner's scoring.
    writeFileSync(join(OUT, drop ? "wizard-drop.json" : "wizard.json"), `${JSON.stringify({ engine: decide.says, drop, labelled: LABELLED, attached: attached ?? null, submits: sum.submits, presses, replayed: replayed.length, rows: out, calls }, null, 1)}\n`);
    const wrong = out.reduce((n, r) => n + r.wrong.length, 0);
    const failed = [
      ...out.filter((r) => r.previewMs === null || r.previewMs > 2000).map((r) => `${r.page}: preview ${r.previewMs === null ? "none" : `${Math.round(r.previewMs)} ms`}`),
      wrong > 0 ? `${wrong} wrong` : "",
      attached !== "ines-vandermeer-resume-2026.pdf" ? `the resume did not land (${attached ?? "nothing"})` : "",
      sum.submits > 0 ? `${sum.submits} submits` : "",
      sum.strayPresses.length > 0 ? `${sum.strayPresses.length} stray presses` : "",
      presses > 0 ? `${presses} presses` : "",
      replayed.length > 0 ? `${replayed.length} replayed writes` : "",
      sum.offsite.length > 0 ? `${sum.offsite.length} off-site` : "",
    ].filter((x) => x !== "");
    say(`wizard journey: ${failed.length === 0 ? "pass" : `FAIL: ${failed.join("; ")}`}`);
    return failed.length === 0 ? 0 : 1;
  };
  /** P3: every page loaded with no Ask and no field in focus: does the ambient Fill all fire, and what did it cost in Jev requests. */
  const runLoad = async (fs: FixtureSite | null): Promise<number> => {
    const list: { id: string; url: string; p: Page | null }[] = [
      ...pages.map((p) => ({ id: p.id, url: `${p.kind === "task" && fs !== null ? fs.mainOrigin : site.origin}${p.path}`, p })),
      { id: "p3-search", url: `${site.origin}/p3/search.html`, p: null },
      { id: "p3-login", url: `${site.origin}/p3/login.html`, p: null },
    ];
    const out: { id: string; fired: boolean; requests: number; offerMs: number | null; note: string; check: string; held: string }[] = [];
    const heldCounts = (): Record<string, number> => {
      store.flush();
      return Object.fromEntries(Object.entries(store.counts()).filter(([k]) => k.startsWith("fill.load_held_")));
    };
    for (const x of list) {
      page = x.p;
      taskFields = null;
      desk(x.p ?? { ...(pages[0] as Page), about: [], sources: [noteWindow("Search jobs: robotics\nSearch location: Denver\nEmail: robin@example.test")] });
      const mark = published.length;
      const c0 = calls.length;
      const held0 = heldCounts();
      const loads = (helper as unknown as { opts: { store: Store } }).opts.store;
      void loads;
      const t1 = performance.now();
      await cdp.send("Page.navigate", { url: x.url }, sessionId);
      for (let i = 0; i < 200 && (await evaluate("document.readyState === 'complete' ? location.href : ''")) !== x.url; i++) await sleep(25);
      // The late report comes 1 s after load; a fill takes a few hundred ms more.
      let offerMs: number | null = null;
      for (let i = 0; i < 100; i++) {
        await sleep(30);
        if (offerMs === null && published.slice(mark).some((m) => m.type === "popup" || m.type === "fillProposal")) offerMs = ms(t1);
      }
      await helper.routedSettled;
      // The code check as it reads the page now, with no About entries (they are the corpus's memory forms' only source).
      const w = helper.model.windows.get(windowId);
      const v = w === undefined ? null : readyOnLoad(helper.model, w, [], { excluded: host.registry.contextOf(windowId)?.excluded ?? {} });
      const check = v === null ? "not walked" : v.fires ? `fires: ${v.fields.length} fields` : `${v.why}: ${v.fields.length} with a candidate`;
      const fired = published.slice(mark).some((m) => m.type === "popup" || m.type === "fillProposal");
      const errs = published.slice(mark).filter((m) => m.type === "error").map((m) => (m.type === "error" ? m.message : ""));
      const held = Object.entries(heldCounts()).flatMap(([k, n]) => (n > (held0[k] ?? 0) ? [k.slice("fill.load_held_".length)] : [])).join(", ");
      out.push({ id: x.id, fired, requests: calls.length - c0, offerMs, note: errs.join("; ").slice(0, 200), check, held });
      say(`${x.id}: ${fired ? `fired (${fmt(offerMs)} ms from navigation)` : "no offer"}, ${calls.length - c0} Jev requests${errs.length > 0 ? `; ${errs[0]}` : ""}`);
    }
    page = null;
    const group = (pre: (id: string) => boolean): string => {
      const xs = out.filter((o) => pre(o.id));
      return `${xs.filter((o) => o.fired).length} of ${xs.length} fired, ${xs.reduce((n, o) => n + o.requests, 0)} Jev requests`;
    };
    const lines = [
      `# P3 ready on load, ${new Date().toISOString()}`,
      "",
      "Each page loaded with no Ask and no field in focus, after its sources were put on the desk (the note as the window the user left). Jev canned; a request is any Jev call between the navigation and 3 s after load. The hour's offer budget is lifted (offersPerHour 1000), so each page is measured on its own; 'held' counts loads a settings rule held before the code check.",
      "",
      "| page | fired | Jev requests | offer ms from navigation | code check now (no About) | held | note |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...out.map((o) => `| ${o.id} | ${o.fired ? "yes" : "no"} | ${o.requests} | ${fmt(o.offerMs)} | ${o.check} | ${o.held || "-"} | ${cell(o.note || "-")} |`),
      "",
      `- B27 corpus: ${group((id) => corpus.forms.some((f) => f.id === id))}`,
      `- W4 saved pages: ${group((id) => W4_SITES.includes(id))}`,
      `- F1 task pages: ${group((id) => TASK_PAGES.some((t) => t.name === id))}`,
      `- search-only and login: ${group((id) => id.startsWith("p3-"))}`,
    ];
    writeFileSync(join(OUT, "ready-on-load.md"), lines.join("\n") + "\n");
    const bad = out.filter((o) => o.id.startsWith("p3-") && o.requests > 0);
    say(`ready on load: ${lines.slice(-4).join("; ")}${bad.length > 0 ? `; FAIL: ${bad.map((o) => o.id).join(", ")} sent Jev requests` : ""}`);
    return bad.length === 0 ? 0 : 1;
  };
  if (JOURNEY === "wizard" || JOURNEY === "wizard-drop") return await runWizard(fixture?.site as FixtureSite, JOURNEY === "wizard-drop");
  if (JOURNEY === "load") return await runLoad(fixture?.site ?? null);
  if (fixture !== null) return await runTasks(fixture.site);

  const rows: Row[] = [];
  for (const p of pages) {
    page = p;
    const row = newRow(p);
    rows.push(row);
    try {
      desk(p);

      // Load. Ready is the page's own document.readyState, read through the DevTools pipe.
      stage = "load";
      const url = `${site.origin}${p.path}`;
      await cdp.send("Page.navigate", { url }, sessionId);
      for (let i = 0; i < 200 && (await evaluate("document.readyState === 'complete' ? location.href : ''")) !== url; i++) await sleep(25);
      const ready = performance.now();

      stage = "walk";
      const walked = await host.link.run({ kind: "walk", pid, windowId });
      if (walked.outcome !== "ok") throw new Error(`walk: ${walked.outcome} ${walked.detail ?? ""}`);
      const toWalked = ms(ready);
      const w0 = timings.filter((t) => t.page === p.id && t.stage === "walk").at(-1);
      row.walk = w0 === undefined ? null : { commandMs: w0.commandMs, extensionMs: w0.extensionMs, contentMs: contentMs() };
      const w = helper.model.windows.get(windowId) as WindowState;
      const before = new Map([...w.nodes.values()].map((n) => [n.key, n.value ?? ""]));
      row.controls = [...w.nodes.values()].filter((n) => n.editable === true).length;

      if (GOAL) {
        await goalPath(p, row, ready, w, before);
        say(`${p.id}: goal ${row.goal?.outcome ?? "-"}, preview ${fmt(row.goal?.previewMs ?? null)} ms, ${row.goal?.steps ?? 0} steps, written ${row.goal?.eligibleWritten ?? 0}/${row.goal?.eligible ?? 0} eligible, tabs ${row.goal?.tabs ?? 0}, reveal ${fmt(row.goal?.revealMs ?? null)} ms, undo ${row.goal?.restored === true ? "restored" : `NOT restored ${row.goal?.notRestored.join("; ") ?? ""}`}, page ${fmt(row.pageMs)} ms; wrong ${row.wrong.length}${row.wrong.length > 0 ? ` (${row.wrong.join("; ")})` : ""}; disagreements ${row.goal?.disagreements.length ?? 0}${row.error === null ? "" : `; ${row.error}`}`);
        continue;
      }
      // Ask's intent: the heads maker's one request on the form as walked.
      stage = "intent";
      const memory = p.about.map((a, i) => ({ id: `about-${i + 1}`, label: a.label, text: a.value, whose: "user" as const }));
      const n0 = calls.length;
      const i0 = performance.now();
      const made = await headsIntentMaker(askJev).make(intentSnapshot(p.instruction, helper.model, w, memory));
      row.intent = { ms: ms(i0), jevMs: made.use.latencyMs, requests: calls.length - n0, scope: made.intent.scope, route: made.intent.route };

      // Fill all, as the host's Command-1 asks for it: the proposal is the preview.
      stage = "fill";
      const trigger = [...w.nodes.values()].find((n) => n.editable === true && n.role === "AXTextField" && (n.value ?? "") === "" && !n.states?.includes("secure"));
      if (trigger === undefined) throw new Error("no empty text field to start the fill from");
      const n1 = calls.length;
      const f0 = performance.now();
      const proposal = await helper.handleConsumer({ type: "fillRequest", v: 1, windowId, fieldKey: trigger.key });
      row.fill = proposal === null ? null : { ms: ms(f0), jevMs: proposal.jev.latencyMs, requests: calls.length - n1, proposed: proposal.fields.filter((f) => f.value !== null || f.handoff !== null).length, withheld: proposal.fields.filter((f) => f.withheld !== null).length };
      // Ambient: ready, walked, filled. Ask's intent ran in between here; it is reported apart and added for Ask's preview.
      row.previewMs = proposal === null ? null : toWalked + (row.fill?.ms ?? 0);
      if (proposal === null) {
        row.error = `no proposal: ${published.filter((m) => m.type === "error").map((m) => (m.type === "error" ? m.message : "")).slice(-1)[0] ?? "none"}`;
      } else {
        stage = "writes";
        const r0 = performance.now();
        const mark = published.length;
        const done = await helper.handleFillAll({ type: "fillAll", v: 1, proposalId: proposal.id, at: Date.now() });
        // A refused Fill all answers null and says why in a stopped taskProgress.
        const refusal = published.slice(mark).find((m) => m.type === "taskProgress" && m.taskId === proposal.id && m.stopReason === "refused");
        row.run = { ms: ms(r0), outcome: done?.outcome ?? "refused", detail: done?.detail ?? (refusal?.type === "taskProgress" ? refusal.detail : null), writes: timings.filter((t) => t.page === p.id && t.stage === "writes" && t.verb !== "pageWalk").length };
      }
      stage = "final";
      await host.link.run({ kind: "walk", pid, windowId });
      const wf = timings.filter((t) => t.page === p.id && t.stage === "final").at(-1);
      row.finalWalk = wf === undefined ? null : { commandMs: wf.commandMs, extensionMs: wf.extensionMs, contentMs: contentMs() };
      row.pageMs = ms(ready) - (row.intent?.ms ?? 0);

      // Score every field the walk shows against the answer key: a value Caret put there that the key does not allow is wrong.
      const after = helper.model.windows.get(windowId) as WindowState;
      for (const n of after.nodes.values()) {
        const was = before.get(n.key) ?? "";
        const now = n.value ?? "";
        if (n.editable !== true || now === was) continue;
        row.written++;
        const e = p.key.find((k) => normLabel(k.label) === normLabel(n.label ?? ""));
        if (e === undefined || e.expected === "handoff") continue;
        const ok = e.expected === "checked" ? now === PAGE_CHECKED : e.expected !== "none" && e.expected !== "unchecked" && (now === e.expected || e.accept.includes(now));
        if (!ok) row.wrong.push(`${n.label ?? n.key}: '${now}' (key: ${e.expected})`);
      }
    } catch (e) {
      row.error = e instanceof Error ? e.message : String(e);
    }
    say(`${p.id}: walk ${row.walk?.commandMs ?? "-"} ms (extension ${row.walk?.extensionMs ?? "-"}), intent ${row.intent?.ms ?? "-"} ms, fill ${row.fill?.ms ?? "-"} ms, run ${row.run?.outcome ?? "-"} ${row.run?.ms ?? "-"} ms (${row.run?.writes ?? 0} writes), final walk ${row.finalWalk?.commandMs ?? "-"} ms; wrong ${row.wrong.length}${row.error === null ? "" : `; ${row.error}`}${row.run?.detail ? `; ${row.run.detail.slice(0, 140)}` : ""}`);
  }
  page = null;

  const presses = timings.filter((t) => t.verb === "pagePress" || t.verb === "pageAttachFile").length;
  writeReport(rows, presses);
  const walkedAll = rows.every((r) => r.walk !== null);
  const wrong = rows.reduce((n, r) => n + r.wrong.length, 0);
  if (GOAL && rows.some((r) => r.goal !== null && !r.goal.restored)) return 1;
  say(`pages ${rows.length}, walked ${rows.filter((r) => r.walk !== null).length}, wrong ${wrong}, presses ${presses}, POSTs ${posts}; Jev ${calls.length} requests, $${spent.toFixed(4)}`);
  return walkedAll && wrong === 0 && presses === 0 && posts === 0 ? 0 : 1;
}

// ---- report ----
const pct = (xs: readonly number[], p: number): number | null => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : (s[Math.min(s.length - 1, Math.floor(p * s.length))] as number);
};
const fmt = (x: number | null): string => (x === null ? "-" : String(Math.round(x)));
const line = (name: string, xs: readonly number[], target: string, note = ""): string => `| ${name} | ${xs.length} | ${fmt(pct(xs, 0.5))} | ${fmt(pct(xs, 0.95))} | ${fmt(xs.length === 0 ? null : Math.max(...xs))} | ${target} | ${note} |`;

/** A write's kind, for the per-kind rows of the stage table, and each kind's budget. */
const kindOf = (t: VerbTiming): string => (t.verb === "pageSelect" ? "native select" : t.control === "combobox" ? "combobox" : t.control === "radio" || (t.verb === "pageChooseOption" && t.control === "button") ? "radio / Yes-No" : t.control === "checkbox" ? "checkbox" : t.control === "date" || t.control === "time" || t.control === "datetime" ? "date / time" : "text");
const kinds = ["text", "date / time", "radio / Yes-No", "checkbox", "native select", "combobox"];
const target: Record<string, string> = { text: "≤ 120", "date / time": "≤ 120", "radio / Yes-No": "≤ 120", checkbox: "≤ 120", "native select": "≤ 150", combobox: "≤ 1500 (cap 4000)" };
const numsOf = (rows: readonly Row[], f: (r: Row) => number | null | undefined): number[] => rows.flatMap((r) => {
  const x = f(r);
  return typeof x === "number" ? [x] : [];
});
const cell = (s: string, max = 400): string => s.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, max);

function writeReport(rows: readonly Row[], presses: number): void {
  const nums = (f: (r: Row) => number | null | undefined): number[] => numsOf(rows, f);
  const acts = timings.filter((t) => t.stage === "writes" && t.verb !== "pageWalk");
  const walks = timings.filter((t) => t.verb === "pageWalk" && t.extensionMs !== null);
  const rewalks = acts.flatMap((t) => (t.rewalk === null ? [] : [t.rewalk]));
  const hop = [...walks.map((t) => t.commandMs - (t.extensionMs as number)), ...rewalks.flatMap((r) => (r.extensionMs === null ? [] : [r.commandMs - r.extensionMs]))];
  const md = [
    `# Page loop latency (P1): ${ENGINE}`,
    "",
    `${rows.length} pages (${rows.filter((r) => r.kind === "corpus").length} corpus, ${rows.filter((r) => r.kind === "w4").length} W4 saved). Chrome for Testing ${CFT_BUILD}, headless, temporary profile; extension, signed bridge and test host as accept.ts runs them. Decisions: ${decide.says}, ${calls.length} requests${LIVE ? `, $${spent.toFixed(4)}` : ""}. Wrong ${rows.reduce((n, r) => n + r.wrong.length, 0)}, presses ${presses}, POSTs ${posts}. Times in ms; ready is document.readyState complete.`,
    "",
    "| stage | n | p50 | p95 | max | budget | how measured |",
    "|---|---|---|---|---|---|---|",
    line("Walk on load (round trip)", nums((r) => r.walk?.commandMs), "≤ 100", "helper to content script and back"),
    line("  of it, the extension's walk", nums((r) => r.walk?.extensionMs), "≤ 60", "worker, from command to snapshot"),
    line("    of that, the page's own walk", nums((r) => r.walk?.contentMs), "", "slowest frame's content script"),
    line("    worker to content and back", nums((r) => (r.walk?.extensionMs == null || r.walk.contentMs === null ? null : r.walk.extensionMs - r.walk.contentMs)), "", "extension's time less the page's walk (load and final walks)"),
    line("  hop chain per round trip", hop, "≤ 40", "every walk: round trip less the extension's time (helper, socket, host, XPC, bridge, Native Messaging, worker)"),
    line("Intent (Ask, heads maker)", nums((r) => r.intent?.ms), "≤ 400", "one Jev request; its own latency below"),
    line("  Jev latency of the intent", nums((r) => r.intent?.jevMs), "", ""),
    line("Fill rounds (proposal)", nums((r) => r.fill?.ms), "≤ 1200", "fillRequest to proposal"),
    line("  Jev latency of the fill", nums((r) => r.fill?.jevMs), "", "slower of each parallel pair, summed"),
    line("Preview visible, ambient", nums((r) => r.previewMs), "≤ 1800", "ready to proposal: walk + fill"),
    line("Preview visible, Ask (derived)", nums((r) => (r.previewMs === null || r.intent === null ? null : r.previewMs + r.intent.ms)), "≤ 2200", "ambient + intent; Ask runs them in turn"),
    ...kinds.map((k) => line(`Write: ${k} (verb round trip)`, acts.filter((t) => kindOf(t) === k).map((t) => t.commandMs), target[k] as string, "")),
    line("  re-walk after each write", rewalks.map((r) => r.commandMs), "(cut in P2)", "page-link act() walks the tab again"),
    line("  write + re-walk, per write", acts.map((t) => t.commandMs + (t.rewalk?.commandMs ?? 0)), "", "what the executor waits per write today"),
    line("Fill all run (executor)", nums((r) => r.run?.ms), "", "fillAll to the task's end"),
    line("Final walk", nums((r) => r.finalWalk?.commandMs), "≤ 500 with watch", "one walk after the run"),
    line("Page, machine time", nums((r) => r.pageMs), "≈ 5000", "ready to final walk, intent excluded"),
    "",
    "| page | controls | walk (ext) | intent (scope) | fill (Jev, req) | proposed / withheld | preview | run | writes | final walk | page | wrong | note |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.id} | ${r.controls} | ${fmt(r.walk?.commandMs ?? null)} (${fmt(r.walk?.extensionMs ?? null)}) | ${fmt(r.intent?.ms ?? null)} (${r.intent?.route ?? "-"} ${r.intent?.scope ?? ""}) | ${fmt(r.fill?.ms ?? null)} (${fmt(r.fill?.jevMs ?? null)}, ${r.fill?.requests ?? "-"}) | ${r.fill?.proposed ?? "-"} / ${r.fill?.withheld ?? "-"} | ${fmt(r.previewMs)} | ${r.run === null ? "-" : `${r.run.outcome} ${fmt(r.run.ms)}`} | ${r.run?.writes ?? 0} | ${fmt(r.finalWalk?.commandMs ?? null)} | ${fmt(r.pageMs)} | ${r.wrong.length === 0 ? 0 : r.wrong.join("; ").replace(/\|/g, "/")} | ${(r.error ?? r.run?.detail ?? "").replace(/\|/g, "/").slice(0, 160)} |`),
  ];
  if (GOAL) {
    const g = rows.flatMap((r) => (r.goal === null ? [] : [{ r, g: r.goal }]));
    const dis = g.flatMap(({ r, g: x }) => x.disagreements.map((d) => ({ page: r.id, ...d })));
    md.length = 0;
    md.push(
      `# Page goals (P2): ${ENGINE}`,
      "",
      `${rows.length} pages. Ask: "fill out this form", heads maker, page planner. Decisions: ${decide.says}, ${calls.length} requests${LIVE ? `, $${spent.toFixed(4)}` : ""}. Wrong ${rows.reduce((n, r) => n + r.wrong.length, 0)}, presses ${presses}, POSTs ${posts}.`,
      "",
      "| stage | n | p50 | p95 | max | budget | how measured |",
      "|---|---|---|---|---|---|---|",
      line("Walk on load (round trip)", nums((r) => r.walk?.commandMs), "≤ 100", ""),
      line("Preview visible, Ask", nums((r) => r.goal?.previewMs), "≤ 2200", "ready to the goal's preview: walk, intent, fill, plan"),
      line("Reveal preview after the last write", nums((r) => r.goal?.revealMs), "≤ 1500", "accept's end to the afterReveal preview"),
      line("Page time", nums((r) => r.pageMs), "< 10000", "ready to the last segment's end, every Tab included"),
      ...kinds.map((k) => line(`Write: ${k} (verb round trip)`, acts.filter((t) => kindOf(t) === k).map((t) => t.commandMs), target[k] as string, "")),
      line("  re-walk after a write", rewalks.map((r) => r.commandMs), "(cut in P2)", "acts that still re-walk: combobox picks, failures"),
      "",
      `Disagreements, verifyWrites against proposeFill: ${dis.length} of ${g.reduce((n, x) => n + x.g.steps, 0)} fill-gated writes would be dropped by verifyWrites (${g.reduce((n, x) => n + x.g.verifyRequests, 0)} extra requests). Of those, wrong by the key: ${dis.filter((d) => d.key === "wrong").length}; right: ${dis.filter((d) => d.key === "right").length}; unscored: ${dis.filter((d) => d.key === "unscored").length}.`,
      "",
      "| page | field | value | verifyWrites | key |",
      "|---|---|---|---|---|",
      ...dis.map((d) => `| ${d.page} | ${d.field.replace(/\|/g, "/")} | ${d.value.replace(/\|/g, "/").slice(0, 60)} | ${d.verify} | ${d.key} |`),
      "",
      "| page | controls | preview | steps | left | tabs | written / eligible | reveal | outcome | undo | page | wrong | note |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.id} | ${r.controls} | ${fmt(r.goal?.previewMs ?? null)} | ${r.goal?.steps ?? "-"} | ${r.goal?.left ?? "-"} | ${r.goal?.tabs ?? "-"} | ${r.goal === null ? "-" : `${r.goal.eligibleWritten} / ${r.goal.eligible}`} | ${fmt(r.goal?.revealMs ?? null)} | ${r.goal?.outcome ?? "-"} | ${r.goal === null ? "-" : r.goal.restored ? "restored" : r.goal.notRestored.join("; ").replace(/\|/g, "/").slice(0, 120)} | ${fmt(r.pageMs)} | ${r.wrong.length === 0 ? 0 : r.wrong.join("; ").replace(/\|/g, "/")} | ${(r.error ?? "").replace(/\|/g, "/").slice(0, 160)} |`),
    );
  }
  writeFileSync(join(OUT, "page-loop.md"), `${md.join("\n")}\n`);
  writeFileSync(join(OUT, "page-loop.json"), `${JSON.stringify({ jev: args.jev, engine: decide.says, cft: CFT_BUILD, spent, posts, presses, rows, timings, calls }, null, 1)}\n`);
  say(`wrote ${join(OUT, "page-loop.md")}`);
}

/** The task suite's report: each page as F1's oracle scored it, the oracle's run-wide record, and the stage times. */
function writeTaskReport(rows: readonly Row[], presses: number, sum: ReturnType<Oracle["summary"]>): void {
  const nums = (f: (r: Row) => number | null | undefined): number[] => numsOf(rows, f);
  const acts = timings.filter((t) => t.stage === "writes" && t.verb !== "pageWalk");
  const rewalks = acts.flatMap((t) => (t.rewalk === null ? [] : [t.rewalk]));
  const g = rows.flatMap((r) => (r.goal === null ? [] : [{ r, g: r.goal }]));
  const dis = g.flatMap(({ r, g: x }) => x.disagreements.map((d) => ({ page: r.id, ...d })));
  const wrong = rows.reduce((n, r) => n + r.wrong.length, 0);
  const notes = (r: Row): string => {
    const t = r.task;
    if (t === undefined) return "";
    return [
      t.arrived,
      r.error ?? "",
      t.refill === null ? "" : `second Ask: ${t.refill}`,
      t.attachGap.length > 0 ? `attach gap (P3, not counted): ${t.attachGap.join(", ")}` : "",
      r.goal === null && t.scored && t.eligible === 0 ? "nothing eligible to fill, so no preview is right" : "",
      t.revealMissing.length > 0 ? `no afterReveal preview; expected fields hidden at load: ${t.revealMissing.join(", ")}` : "",
      t.absent.length > 0 ? `absent: ${t.absent.join(", ")}` : "",
      t.unmapped.length > 0 ? `labels no field carries: ${t.unmapped.join("; ")}` : "",
      t.ambiguous.length > 0 ? `labels several fields carry: ${t.ambiguous.join("; ")}` : "",
      t.warnings.length > 0 ? `left: ${t.warnings.join(" / ")}` : "",
    ].filter((x) => x !== "").join(". ");
  };
  const md = [
    `# Page goals on F1's task pages (P2): ${ENGINE}`,
    "",
    `${rows.length} pages, served by FixtureSite in-process; Chrome for Testing ${CFT_BUILD}, headless, behind F1's network sink; extension, signed bridge and test host as accept.ts runs them. Ask: "${TASK_INSTRUCTION}" (it names no source: "from my notes" would keep Caret to the note, and the expectations also draw on the email and memory), heads maker, page planner. Scored by F1's oracle (oracle.ts), which reads each page through its own probe: right / wrong / missed from oracle.score against tasks/expect/<page>.json; eligible is the fields expected to hold a value. Undo is checked against oracle.values before the Ask. Decisions: ${decide.says}, ${calls.length} requests${LIVE ? `, $${spent.toFixed(4)}` : ""}.`,
    "",
    ...(!CANNED
      ? []
      : [
          "Canned Jev's mapping: a fill question names its field by the label, nearest label or placeholder in Caret's descriptor. Canned Jev takes the one data-oracle field whose markup carries that text (label[for], aria-labelledby, aria-label, a wrapping label, a fieldset legend, its row's label, its placeholder), read from the live page through the DevTools pipe, and answers with a candidate that is that field's expected value: exactly; the same day or month for a date or month input; the option as a whole word for a select, radios or Yes/No; for a picker or react-select also two or more words that each start a word of the option. A label no field or several fields carry gets none. It never reads Caret's walk, so a field Caret mislabels is asked about and answered none.",
          "",
        ]),
    `Oracle, whole run: wrong ${wrong}, submits ${sum.submits}, stray presses ${sum.strayPresses.length}${sum.strayPresses.length > 0 ? ` (${sum.strayPresses.map((p) => `${p.page} ${p.target}${p.trusted ? " trusted" : ""}`).join("; ")})` : ""}, harness presses ${sum.harnessPresses}, off-site ${sum.offsite.length}${sum.offsite.length > 0 ? ` (${sum.offsite.map((o) => `${o.method} ${o.target}`).join("; ")})` : ""}, browser's own services ${sum.browserService}, probe errors ${sum.probeErrors.length}${sum.probeErrors.length > 0 ? ` (${sum.probeErrors.map((e) => `${e.page}: ${e.error}`).join("; ")})` : ""}. Page-link presses ${presses}.`,
    "",
    "| stage | n | p50 | p95 | max | budget | how measured |",
    "|---|---|---|---|---|---|---|",
    line("Walk on load (round trip)", nums((r) => r.walk?.commandMs), "≤ 100", "the first walk that showed an editable control"),
    line("Preview visible, Ask", nums((r) => r.goal?.previewMs), "≤ 2200", "the oracle's first full report to the goal's preview: walk, intent, fill, plan"),
    line("Reveal preview after the last write", nums((r) => r.goal?.revealMs), "≤ 1500", "accept's end to the afterReveal preview"),
    line("Page time", nums((r) => r.pageMs), "< 10000", "ready to the last segment's end, every Tab included"),
    ...kinds.map((k) => line(`Write: ${k} (verb round trip)`, acts.filter((t) => kindOf(t) === k).map((t) => t.commandMs), target[k] as string, "")),
    line("  re-walk after a write", rewalks.map((r) => r.commandMs), "(cut in P2)", "acts that still re-walk: combobox picks, failures"),
    "",
    "| page | controls | preview | steps | left | tabs | right / eligible | wrong | missed | reveal | outcome | undo | page | disagreements | note |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => {
      const t = r.task;
      return `| ${r.id} | ${r.controls} | ${fmt(r.goal?.previewMs ?? null)} | ${r.goal?.steps ?? "-"} | ${r.goal?.left ?? "-"} | ${r.goal?.tabs ?? "-"} | ${t === undefined || !t.scored ? "-" : `${t.right} / ${t.eligible}`} | ${r.wrong.length === 0 ? 0 : cell(r.wrong.join("; "))} | ${t === undefined || t.missed.length === 0 ? 0 : cell(`${t.missed.length}: ${t.missed.join("; ")}`)} | ${fmt(r.goal?.revealMs ?? null)} | ${r.goal?.outcome ?? "-"} | ${r.goal === null ? "-" : r.goal.restored ? "restored" : cell(r.goal.notRestored.join("; "), 300)} | ${fmt(r.pageMs)} | ${r.goal?.disagreements.length ?? "-"} | ${cell(notes(r), 900)} |`;
    }),
    "",
    `Disagreements, verifyWrites against proposeFill: ${dis.length} fill-gated writes would be dropped by verifyWrites (${g.reduce((n, x) => n + x.g.verifyRequests, 0)} extra requests). Scored by the field's expectation: wrong ${dis.filter((d) => d.key === "wrong").length}, right ${dis.filter((d) => d.key === "right").length}, unscored ${dis.filter((d) => d.key === "unscored").length} (a pick, date or number whose written form differs from the oracle's reading, or a label no single field carries).${!CANNED ? "" : " Canned Jev answers no to every yes/no question, verifyWrites' included, so under canned Jev every fill-gated write counts as dropped: this table means something only with live Jev."}`,
    "",
    "| page | field | value | verifyWrites | expectation |",
    "|---|---|---|---|---|",
    ...dis.map((d) => `| ${d.page} | ${cell(d.field)} | ${cell(d.value, 60)} | ${d.verify} | ${d.key} |`),
  ];
  writeFileSync(join(OUT, "page-loop.md"), `${md.join("\n")}\n`);
  writeFileSync(join(OUT, "page-loop.json"), `${JSON.stringify({ suite: "tasks", jev: args.jev, engine: decide.says, cft: CFT_BUILD, spent, presses, oracle: sum, cannedPicks: Object.fromEntries([...taskAsks].map(([k, a]) => [k, Object.fromEntries(a.picked)])), rows, timings, calls }, null, 1)}\n`);
  say(`wrote ${join(OUT, "page-loop.md")}`);
}

let code = 1;
try {
  code = await main();
} catch (e) {
  say(`run failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
} finally {
  await cleanup();
  const leftovers = [join(homedir(), "Library", "Application Support", "Google", "Chrome for Testing", "NativeMessagingHosts", `${HOST_NAME}.json`)].filter((f) => existsSync(f));
  if (leftovers.length > 0) say(`left behind: ${leftovers.join(", ")}`);
  say(`cleaned up; exit ${code}`);
}
process.exit(code);
