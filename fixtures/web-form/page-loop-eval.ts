// The browser loop's latency, end to end (P1, plans/fast-browser.md "Latency budget"). Each page loads in the run's own
// headless Chrome for Testing with the extension, through the signed bridge and test host to an in-process helper, as
// accept.ts runs them. Per page: the walk on load, Ask's intent (the heads maker's one request), the Fill all proposal
// (fill rounds), the writes Fill all makes through the executor and the page link, and the walk after them. Every page
// command is timed by the page link (engines/page-link.ts VerbTiming); the extension reports its own walk time, so a
// walk's round trip less that time is the hop chain (content script, worker, bridge, XPC host, helper).
//
//   node fixtures/web-form/page-loop-eval.ts --sign-identity SHA1 --out DIR [--jev canned|live] [--spend-limit USD]
//        [--pages id,id] [--w4-dir DIR] [--w4-key FILE] [--w4-note FILE] [--path fill|goal]
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
// Exit 0 when every page was walked, no field took a value the answer key does not allow, nothing was pressed and the
// POST count is 0. The bridge and its test host must already be built (accept.ts builds them); the extension is
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
import { loadJevKey, makeJevClient, type AskJev, type JevRequest, type JevResult } from "../../helper/src/fill/jev.ts";
import { PAGE_CHECKED, PROTOCOL_VERSION, Snapshot, type HelperMessage } from "../../helper/src/protocol.ts";
import type { WindowState } from "../../helper/src/model.ts";
import { intentSnapshot } from "../../helper/src/planner/intent.ts";
import { headsIntentMaker } from "../../helper/src/planner/intent-heads.ts";
import { jevGate } from "../../helper/src/goals/gates.ts";
import { SnippetLedger } from "../../helper/src/privacy.ts";
import { loadAsks, loadCorpus, normLabel, type CorpusForm } from "../../helper/scripts/realfill-corpus.ts";
import { CFT_BUILD, Cdp, HOST_NAME, chrome, cleanup, designated, launch, launchdJob, preflight, setSay, signedCopy, sleep, tail, undo, writeManifest } from "./rig.ts";

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
  },
});
if (args["sign-identity"] === undefined || args.out === undefined) throw new Error("--sign-identity and --out are required");
if (args.jev !== "canned" && args.jev !== "live") throw new Error("--jev is canned or live");
if (args.path !== "fill" && args.path !== "goal") throw new Error("--path is fill or goal");
const GOAL = args.path === "goal";
const OUT = args.out;
const LIVE = args.jev === "live";
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
  kind: "corpus" | "w4";
  path: string;
  /** The answer key: what each field may hold after the fill. */
  key: Expect[];
  /** Ask's instruction for the intent: the form's first B24 ask, else a whole-form request. */
  instruction: string;
  /** Windows the reader would show beside the page, oldest first; the last is the one the user just left. */
  sources: Snapshot[];
  /** What the user told Caret, for a form whose source is memory. */
  about: { label: string; value: string }[];
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
const wanted = args.pages?.split(",");
const pages: Page[] = [
  ...corpus.forms.map(corpusPage),
  ...(existsSync(args["w4-dir"]) ? W4_SITES.filter((s) => existsSync(join(args["w4-dir"], `${s}.html`))).map(w4Page) : []),
].filter((p) => wanted === undefined || wanted.includes(p.id));
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
  if (e.control === "radio" || e.control === "select" || e.control === "combobox") return values.some((v) => new RegExp(`(?:^|[^\\p{L}])${v.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:$|[^\\p{L}])`, "iu").test(text));
  return false;
}

/** Canned Jev: Ask's heads read the whole form from any source for the user; each fill question takes the answer key's value. */
const canned: AskJev = async (req: JevRequest): Promise<JevResult> => {
  if ("scope" in req.questions) {
    const pick: Record<string, string> = { scope: "all", source: "any", whose: "user", why: "nothingToFill", section: "none" };
    return { model: "canned", answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { choice: pick[k] ?? "none", confidence: 0.9 }])), nouls: Object.fromEntries(Object.keys(req.nouls ?? {}).map((k) => [k, 0])), inputTokens: 0, latencyMs: 0, costUsd: 0 };
  }
  const answers = Object.fromEntries(
    Object.entries(req.questions).map(([k, q]) => {
      if (k.endsWith("_whose") || k.endsWith("_owner")) return [k, { choice: "user", confidence: 0.95 }];
      if ("yes" in q.criteria && "no" in q.criteria) return [k, { choice: "no", confidence: 0.95 }];
      const e = keyFor(typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions));
      const quoted = (t: string | null): string | null => (t === null ? null : (/^"([^"]*)"/u.exec(t)?.[1] ?? null));
      const hit = e === undefined ? undefined : Object.entries(q.criteria).find(([, t]) => {
        const text = quoted(t);
        return text !== null && fits(text, e);
      })?.[0];
      return [k, hit === undefined ? { choice: "none" in q.criteria ? "none" : (Object.keys(q.criteria)[0] ?? "none"), confidence: 0.9 } : { choice: hit, confidence: 0.95 }];
    }),
  );
  return { model: "canned", answers, ...(req.nouls === undefined ? {} : { nouls: Object.fromEntries(Object.keys(req.nouls).map((k) => [k, 0])) }), inputTokens: 0, latencyMs: 0, costUsd: 0 };
};
const live = LIVE ? makeJevClient(() => loadJevKey()) : null;
const askJev: AskJev = async (req) => {
  if (spent >= SPEND_LIMIT) throw new Error(`spend limit $${SPEND_LIMIT} reached`);
  const r = live === null ? await canned(req) : await live(req);
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
  } | null;
}

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
  helper = new Helper({ store, askJev, shadow: false, allowBackgroundFocus: false, readerLink: host.link, pageCovers: (pid) => host.registry.forBrowser(pid) !== undefined, pageDocument: (id) => host.registry.documentOf(id), calendar: null, publish: (m) => void published.push(m), warn: (l) => void warnings.push(l), ...(GOAL ? { ask: { maker: "heads" as const } } : {}) });
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
  const browser = launch(exe, profile, [`${site.origin}/blank.html`], { ...process.env, CARET_BRIDGE_SERVICE: service }, join(EXT, "dist"), log, ["--window-size=1280,1600"], true);
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
  /** P2: the Ask's goal on this page, from its preview to its undo (see the header). */
  const goalPath = async (p: Page, row: Row, ready: number, w: WindowState, before: Map<string, string>): Promise<void> => {
    stage = "ask";
    const mark = published.length;
    const a0 = performance.now();
    const reply = await helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: `eval-${p.id}`, at: Date.now(), instruction: "fill out this form from my notes", windowId }, undefined, true, true);
    const previewMs = ms(ready);
    void a0;
    if (reply.type !== "goalProgress" || reply.event !== "segment") {
      row.error = `no preview: ${reply.type === "goalProgress" ? `${reply.event} ${"says" in reply ? reply.says : ""}` : reply.type === "askQuestion" ? `asked: ${reply.text}` : `${reply.type} ${"error" in reply && reply.error !== null ? JSON.stringify(reply.error).slice(0, 200) : ""}`}`;
      row.pageMs = ms(ready);
      return;
    }
    // The disagreement report: the goal value gate's question on every fill-gated write of the plan, scored by the key.
    stage = "verify";
    const plan = helper.goals.planOf(reply.goalId);
    const gated = (plan?.segments ?? []).flatMap((s) => s.steps).filter((x) => x.gate === "fill" && x.value !== null);
    const v0 = calls.length;
    const dropped = gated.length === 0 ? new Map<string, string>() : await jevGate(plan?.instruction ?? "", gated.map((x) => ({ ref: x.ref, target: x.target, written: x.writes ?? x.value?.text ?? "", value: x.value as NonNullable<typeof x.value> })), askJev, new SnippetLedger(helper.model.windows.values()));
    const disagreements = gated.flatMap((x) => {
      const verdict = dropped.has(x.ref) ? ("dropped" as const) : ("kept" as const);
      const node = w.nodes.get(x.target.key);
      const right = scoreField(node?.label ?? x.target.own, x.writes ?? "");
      // Only the writes verifyWrites would drop disagree with fill; each kept one agrees.
      return verdict === "dropped" ? [{ field: x.target.label, value: x.writes ?? "", verify: verdict, key: right === null ? ("unscored" as const) : right ? ("right" as const) : ("wrong" as const) }] : [];
    });
    const verifyRequests = calls.length - v0;
    // One Tab: the preview's acceptance. Then any segment the writes revealed, each its own Tab.
    stage = "writes";
    const segments: { goalId: string }[] = [{ goalId: reply.goalId }];
    let tabs = 0;
    let revealMs: number | null = null;
    let outcome = "refused";
    let next: typeof reply | undefined = reply;
    while (next !== undefined && tabs < 4) {
      tabs++;
      const r = await helper.handleGoalAccept({ type: "goalAccept", v: PROTOCOL_VERSION, goalId: next.goalId, segment: next.segment, digest: next.digest, at: Date.now() });
      const lastWrite = performance.now();
      await helper.goals.idle();
      outcome = r?.outcome ?? "refused";
      const fin = published.slice(mark).filter((m) => m.type === "goalProgress" && m.goalId === next?.goalId && m.event === "finished").at(-1);
      if (fin?.type === "goalProgress" && fin.event === "finished") outcome = fin.outcome;
      const goalIds = new Set(segments.map((x) => x.goalId));
      const more = published.slice(mark).find((m): m is typeof reply => m.type === "goalProgress" && m.event === "segment" && !goalIds.has(m.goalId));
      if (more !== undefined && more.reason === "afterReveal") {
        revealMs ??= ms(lastWrite);
        segments.push({ goalId: more.goalId });
      }
      next = more;
    }
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
      const ok = scoreField(n.label ?? "", now);
      if (ok === false) row.wrong.push(`${n.label ?? n.key}: '${now}'`);
      if (ok === true) eligibleWritten++;
    }
    const eligible = p.key.filter((k) => k.expected !== "none" && k.expected !== "handoff" && k.expected !== "unchecked").length;
    // One undo per segment, newest first: every field must hold what it held before the Ask.
    stage = "undo";
    const notRestored: string[] = [];
    for (const sgt of [...segments].reverse()) {
      if (!helper.executor.has(`${sgt.goalId}:s0`)) continue;
      const u = await helper.executor.undo(`${sgt.goalId}:s0`);
      notRestored.push(...u.notRestored.map((x) => x.reason));
    }
    await host.link.run({ kind: "walk", pid, windowId });
    const undone = helper.model.windows.get(windowId) as WindowState;
    const differ = [...undone.nodes.values()].filter((n) => n.editable === true && (n.value ?? "") !== (before.get(n.key) ?? ""));
    for (const n of differ) notRestored.push(`${n.label ?? n.key} holds '${n.value ?? ""}'`);
    row.goal = { previewMs, steps: reply.steps.length, left: reply.warnings.length, tabs, eligible, eligibleWritten, revealMs, restored: notRestored.length === 0, notRestored, outcome, disagreements, verifyRequests };
  };

  const rows: Row[] = [];
  for (const p of pages) {
    page = p;
    const row: Row = { id: p.id, kind: p.kind, controls: 0, walk: null, intent: null, fill: null, previewMs: null, run: null, finalWalk: null, pageMs: null, wrong: [], written: 0, error: null, goal: null };
    rows.push(row);
    try {
      // The desk: last page's sources and memory gone, this page's in place, the source focused last and left for the browser.
      for (const w of [...helper.model.windows.values()]) if (w.window.windowId !== windowId) helper.handleReader({ type: "windowClosed", v: 1, at: Date.now(), windowId: w.window.windowId });
      for (const e of helper.handleMemory({ type: "memoryRequest", v: 1, requestId: "l", op: "list", kind: "about" }).entries ?? []) helper.handleMemory({ type: "memoryRequest", v: 1, requestId: "f", op: "forget", id: e.id });
      for (const a of p.about) {
        const added = helper.handleMemory({ type: "memoryRequest", v: 1, requestId: "a", op: "add", kind: "about", fields: { label: a.label, value: a.value, source: "typed" } });
        if (added.error !== null) throw new Error(`About '${a.label}' was not added: ${added.error}`);
      }
      const base = Date.now() - 60_000 * p.sources.length;
      p.sources.forEach((s, i) => void helper.handleReader({ ...s, at: base + i * 60_000, focused: i === p.sources.length - 1 }));
      helper.handleReader({ type: "appSwitch", v: 1, at: Date.now(), from: textEdit, to: session.info.browser });

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

function writeReport(rows: readonly Row[], presses: number): void {
  const nums = (f: (r: Row) => number | null | undefined): number[] => rows.flatMap((r) => {
    const x = f(r);
    return typeof x === "number" ? [x] : [];
  });
  const acts = timings.filter((t) => t.stage === "writes" && t.verb !== "pageWalk");
  const walks = timings.filter((t) => t.verb === "pageWalk" && t.extensionMs !== null);
  const rewalks = acts.flatMap((t) => (t.rewalk === null ? [] : [t.rewalk]));
  const hop = [...walks.map((t) => t.commandMs - (t.extensionMs as number)), ...rewalks.flatMap((r) => (r.extensionMs === null ? [] : [r.commandMs - r.extensionMs]))];
  const kindOf = (t: VerbTiming): string => (t.verb === "pageSelect" ? "native select" : t.control === "combobox" ? "combobox" : t.control === "radio" || (t.verb === "pageChooseOption" && t.control === "button") ? "radio / Yes-No" : t.control === "checkbox" ? "checkbox" : t.control === "date" || t.control === "time" || t.control === "datetime" ? "date / time" : "text");
  const kinds = ["text", "date / time", "radio / Yes-No", "checkbox", "native select", "combobox"];
  const target: Record<string, string> = { text: "≤ 120", "date / time": "≤ 120", "radio / Yes-No": "≤ 120", checkbox: "≤ 120", "native select": "≤ 150", combobox: "≤ 1500 (cap 4000)" };
  const md = [
    `# Page loop latency (P1): ${args.jev} Jev`,
    "",
    `${rows.length} pages (${rows.filter((r) => r.kind === "corpus").length} corpus, ${rows.filter((r) => r.kind === "w4").length} W4 saved). Chrome for Testing ${CFT_BUILD}, headless, temporary profile; extension, signed bridge and test host as accept.ts runs them. Jev: ${args.jev}${LIVE ? `, ${calls.length} requests, $${spent.toFixed(4)}` : ""}. Wrong ${rows.reduce((n, r) => n + r.wrong.length, 0)}, presses ${presses}, POSTs ${posts}. Times in ms; ready is document.readyState complete.`,
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
      `# Page goals (P2): ${args.jev} Jev`,
      "",
      `${rows.length} pages. Ask: "fill out this form from my notes", heads maker, page planner. Jev: ${args.jev}${LIVE ? `, ${calls.length} requests, $${spent.toFixed(4)}` : ""}. Wrong ${rows.reduce((n, r) => n + r.wrong.length, 0)}, presses ${presses}, POSTs ${posts}.`,
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
  writeFileSync(join(OUT, "page-loop.json"), `${JSON.stringify({ jev: args.jev, cft: CFT_BUILD, spent, posts, presses, rows, timings, calls }, null, 1)}\n`);
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
