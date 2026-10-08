// P4's journey: the tab the user just left is a fill source. In the run's own headless Chrome for Testing on a
// temporary profile, with the extension, the signed bridge and test host and an in-process helper (as page-loop-eval
// runs them): a webmail-like tab holds a message (public/tabsource/webmail.html, its body in a visible iframe, decoys
// around it), F1's wizard-1 form is in a second tab. The user reads the message, switches to the form tab and clicks
// First name; the fill offer must come from the message, Tab (the pop-up's Fill all) writes it, and F1's oracle reads
// the page back: 0 wrong, 0 presses, 0 submits, nothing off-site. Then the rules are tried on the real worker: no read
// of the tab the user is in or of a tab never left, none on a site that is off, none after the left tab navigated or
// closed.
//
//   node fixtures/web-form/tab-source-journey.ts --sign-identity SHA1 --out DIR [--jev canned|live] [--spend-limit USD]
//        [--engine canned|jev|gateway:<model>]
//
// R1: --engine names the decision engine as page-loop-eval's does (engines/decide/harness.ts), behind the replay cache;
// its requests carry only the text of the tabs this journey opened from its own fixture pages.
//
// Tab switches are made through the browser's own tabs and windows APIs, evaluated in the extension's worker over the
// DevTools pipe, so the worker's listeners see the same activation events a click on a tab gives. The bridge and its
// test host must already be built (accept.ts builds them). Canned Jev answers each fill question with F1's expected
// value when a candidate quotes it exactly; live Jev is TypeSafe's, under --spend-limit. Exit 0 only when every check holds.
import { writeStore, writeStoreJson } from "../../helper/src/privacy/send.ts";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Helper } from "../../helper/src/helper.ts";
import { Store } from "../../helper/src/store.ts";
import { pageHost } from "../../helper/src/engines/host.ts";
import { newLaunchSecret } from "../../helper/src/launch.ts";
import { writeLocalSecretFile } from "../../helper/src/privacy/local-secret.ts";
import { wirePageEngines } from "../../helper/src/engines/wire.ts";
import { pageWindowId } from "../../helper/src/engines/windows.ts";
import { pageTabReader, type TabReader } from "../../helper/src/engines/tab-source.ts";
import type { EngineSession } from "../../helper/src/engines/session.ts";
import type { ReaderLink } from "../../helper/src/executor/means.ts";
import type { AskJev, JevRequest, JevResult } from "../../helper/src/fill/jev.ts";
import { cannedReply, type CannedAnswer } from "../../helper/src/engines/decide/canned.ts";
import { harnessEngine } from "../../helper/src/engines/decide/harness.ts";
import { engineName } from "../../helper/src/engines/decide/port.ts";
import { PROTOCOL_VERSION, type HelperMessage, type OfferPopup, type PageResult } from "../../helper/src/protocol.ts";
import { CFT_BUILD, Cdp, chrome, cleanup, designated, launch, launchdJob, preflight, setSay, signedCopy, sleep, tail, undo, writeManifest } from "./rig.ts";
import { NetworkSink, sameText } from "./oracle.ts";
import { FixtureSite } from "./server.ts";
import { loadExpectation, taskPage } from "./tasks/site.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const EXT = join(ROOT, "extension");
const BRIDGE = join(ROOT, "bridge", ".build", "release", "caret-bridge");
const TESTHOST = join(ROOT, "bridge", ".build", "release", "caret-bridge-testhost");
const PAGES = join(HERE, "public", "tabsource");

const { values: args } = parseArgs({
  options: {
    "sign-identity": { type: "string" },
    out: { type: "string" },
    jev: { type: "string", default: "canned" },
    "spend-limit": { type: "string", default: "0.05" },
    /** R1: the decision engine; overrides --jev. */
    engine: { type: "string" },
  },
});
if (args["sign-identity"] === undefined || args.out === undefined) throw new Error("--sign-identity and --out are required");
if (args.jev !== "canned" && args.jev !== "live") throw new Error("--jev is canned or live");
const OUT = args.out;
const SPEND_LIMIT = Number(args["spend-limit"]);

const t0 = Date.now();
const lines: string[] = [];
const say = (s: string): void => {
  const l = `[tab-source +${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`;
  lines.push(l);
  process.stdout.write(`${l}\n`);
};
setSay(say);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void cleanup().then(() => process.exit(130)));

const PAGE = "wizard-1";
const expected = loadExpectation(PAGE).expected;
/** The form's labels, as wizard-1 shows them, and the oracle's name for each. */
const LABEL_FIELD: Record<string, string> = { "First name": "first_name", "Last name": "last_name", Email: "email", Phone: "phone", Country: "country", State: "state" };
/** Phone numbers on the webmail page that are not the message's: a read must never take one (see webmail.html). */
const DECOYS = ["555-0112", "555-0199", "555-0198", "555-0100", "555-0177"];

// ---- Jev ----
let spent = 0;
const quoted = (t: string | null | undefined): string | null => (t === null || t === undefined ? null : (/^"([^"]*)"/u.exec(t)?.[1] ?? null));
/**
 * Canned, by kind of question (helper engines/decide/canned.ts; a kind with no rule throws): each fill question takes the
 * candidate that quotes F1's expected value for its field exactly, else none; whose and owner questions say the user's.
 * The journey makes Fill all offers only, so a fill's questions are all it meets.
 */
const fillValue = (q: JevRequest["questions"][string]): CannedAnswer => {
  const ins = typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions);
  const label = /Label: '(.+?)'\.(?=\s|$)/u.exec(ins)?.[1];
  const want = label === undefined ? undefined : expected[LABEL_FIELD[label] ?? ""];
  const hit = want === undefined || want === "none" ? undefined : Object.entries(q.criteria).find(([, t]) => {
    const text = quoted(t);
    return text !== null && sameText(text, want);
  })?.[0];
  return hit === undefined ? { choice: "none" in q.criteria ? "none" : (Object.keys(q.criteria)[0] ?? "none"), confidence: 0.9 } : { choice: hit, confidence: 0.95 };
};
const theUsers = (): CannedAnswer => ({ choice: "user", confidence: 0.95 });
const canned: AskJev = (req: JevRequest): Promise<JevResult> =>
  cannedReply(req, {
    confidence: 0.9,
    choice: { "fill.whose:whose": theUsers, "fill.whose:owner": theUsers, "fill.values:whose": theUsers, "fill.values:owner": theUsers, "fill.values:value": fillValue, "fill.values:answer": () => "none", "fill.verify:verdict": () => "exact" },
    noul: {},
  });
const ENGINE = engineName(args.engine ?? (args.jev === "live" ? "jev" : "canned"));
/** Windows of the tabs this journey opened, each from its own fixture page: the only text a request may carry. */
const fixtureIds = new Set<string>();
const decide = harnessEngine({ name: ENGINE, canned, fixture: { windows: (id) => fixtureIds.has(id), memory: true, plan: true } });
/** Each decision request's latency, for the slow runner's report (R1). */
const calls: { latencyMs: number; costUsd: number }[] = [];
const askJev: AskJev = async (req) => {
  if (spent >= SPEND_LIMIT) throw new Error(`spend limit $${SPEND_LIMIT} reached`);
  const r = await decide.ask(req);
  spent += r.costUsd;
  calls.push({ latencyMs: r.latencyMs, costUsd: r.costUsd });
  return r;
};

// ---- the webmail site: its own loopback origin, as a mail site is another site than the form's ----
function serveMail(): Promise<{ server: Server; origin: string }> {
  const routes: Record<string, string> = { "/tabsource/webmail": "webmail.html", "/tabsource/message": "message.html", "/tabsource/hidden": "hidden.html" };
  const server = createServer((req, res) => {
    const file = routes[new URL(req.url ?? "/", "http://127.0.0.1").pathname];
    if (req.method !== "GET" || file === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(readFileSync(join(PAGES, file), "utf8"));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<number> {
  preflight();
  for (const f of [BRIDGE, TESTHOST]) if (!existsSync(f)) throw new Error(`${f} is missing: build it first (accept.ts builds the bridge and its test host)`);
  say("building the extension");
  execFileSync(process.execPath, [join(EXT, "build.mjs")], { stdio: "inherit" });
  const exe = await chrome();
  const extensionId = readFileSync(join(EXT, "EXTENSION_ID"), "utf8").trim();
  mkdirSync(OUT, { recursive: true });
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = ""): void => {
    checks.push({ name, ok, detail });
    say(`${ok ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : `: ${detail}`}`);
  };

  const tmp = mkdtempSync(join(tmpdir(), "caret-p4-"));
  undo.push({ what: `temporary directory ${tmp}`, fn: () => rmSync(tmp, { recursive: true, force: true }) });
  const mail = await serveMail();
  undo.push({ what: "mail server", fn: () => new Promise<void>((r) => (mail.server.closeAllConnections(), mail.server.close(() => r()))) });
  const site = new FixtureSite();
  await site.start();
  undo.push({ what: "fixture site", fn: () => site.stop() });
  const sink = new NetworkSink(site.tasks.oracle);
  await sink.start();
  undo.push({ what: "network sink", fn: () => sink.stop() });
  const oracle = site.tasks.oracle;

  const sockDir = join(tmp, "s");
  mkdirSync(sockDir, { mode: 0o700 });
  const sockPath = join(sockDir, "page.sock");
  const noReader: ReaderLink = { run: async (v) => ({ type: "verbResult", v: 1, id: "none", at: Date.now(), outcome: v.kind === "watchInput" ? "ok" : "noWindow", detail: v.kind === "watchInput" ? null : "no reader in this journey" }) };
  const store = new Store(join(tmp, "data"));
  let helper: Helper;
  const secret = newLaunchSecret();
  const warnings: string[] = [];
  const host = pageHost({ path: sockPath, secret, reader: noReader, apply: (m) => void helper.handleReader(m), purge: (s) => helper.purgeWindow(s), warn: (l) => void warnings.push(l) });
  // Every read the helper makes for a fill, kept here in memory only to check what it took; never written out.
  const fillReads: PageResult[] = [];
  const base = pageTabReader(host.registry);
  const tabReader: TabReader = { readText: async (w) => {
    const r = await base.readText(w);
    if (r !== null) fillReads.push(r);
    return r;
  }, sitesOff: () => base.sitesOff(), documentOf: (w) => base.documentOf(w) };
  const published: HelperMessage[] = [];
  // No reader plays the Mac here: focus counts wherever it is (allowBackgroundFocus), as in the other page evals' tests.
  helper = new Helper({ store, askJev, shadow: false, allowBackgroundFocus: true, readerLink: host.link, pageCovers: (pid) => host.registry.forBrowser(pid) !== undefined, pageDocument: (id) => host.registry.documentOf(id), calendar: null, tabReader, publish: (m) => void published.push(m), warn: (l) => void warnings.push(l) });
  wirePageEngines({ host, helper, publish: (m) => void published.push(m), warn: (l) => void warnings.push(l), allowBackground: true });
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
  writeLocalSecretFile(secretFile, secret);
  await launchdJob(tmp, service, service, [testHost, "--service", service, "--socket", sockPath, "--secret-file", secretFile, "--browser-requirement", designated(cftApp)], join(tmp, "testhost.log"));
  const profile = join(tmp, "profile");
  writeManifest(join(profile, "NativeMessagingHosts"), extensionId, bridge);
  const log = join(tmp, "chrome.log");
  const since = Date.now();
  const mailUrl = `${mail.origin}/tabsource/webmail`;
  const formUrl = `${site.mainOrigin}${taskPage(PAGE).path}`;
  const browser = launch(exe, profile, [mailUrl], { ...process.env, CARET_BRIDGE_SERVICE: service }, join(EXT, "dist"), log, ["--window-size=1280,1600", ...sink.chromeFlags()], true);
  let session: EngineSession;
  try {
    session = await host.registry.waitForEngine((s) => s.info.extensionId === extensionId && s.info.connectedAt >= since, 30_000);
  } catch {
    throw new Error(`no engine said hello; Chrome log: ${tail(log)}`);
  }
  say(`engine ${session.info.engine}, Chrome for Testing ${CFT_BUILD} pid ${session.info.browser.pid}`);
  const cdp = browser.cdp as Cdp;

  // The extension's worker, where the harness plays the user's tab switches through chrome.tabs and chrome.windows.
  const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] };
  const workerTarget = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`));
  if (workerTarget === undefined) throw new Error("the extension's worker is not running");
  const { sessionId: ws } = (await cdp.send("Target.attachToTarget", { targetId: workerTarget.targetId, flatten: true })) as { sessionId: string };
  const inWorker = async <T>(expression: string): Promise<T> => {
    const r = (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, ws)) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (r.exceptionDetails !== undefined) throw new Error(`worker threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  interface TabRow { id: number; url: string; active: boolean; windowId: number }
  const tabs = (): Promise<TabRow[]> => inWorker("chrome.tabs.query({}).then((ts) => ts.map((t) => ({ id: t.id, url: t.url ?? '', active: t.active, windowId: t.windowId })))");
  const focusedWindow = (): Promise<{ id: number; focused: boolean }> => inWorker("chrome.windows.getLastFocused().then((w) => ({ id: w.id, focused: w.focused }))");
  /** The user clicks a tab: it becomes the active tab of its window, and that window has focus. */
  const switchTo = async (tabId: number): Promise<void> => {
    await inWorker(`chrome.tabs.update(${tabId}, { active: true }).then((t) => chrome.windows.update(t.windowId, { focused: true })).then(() => true)`);
    await sleep(400);
  };

  let mailTab: TabRow | undefined;
  for (let i = 0; i < 40 && mailTab === undefined; i++) {
    mailTab = (await tabs()).find((t) => t.url.startsWith(mailUrl));
    if (mailTab === undefined) await sleep(250);
  }
  if (mailTab === undefined) throw new Error("the webmail tab did not open");
  fixtureIds.add(pageWindowId(session.info.engine, mailTab.id));
  // The form, opened in a tab of the same window, as a link from the message would open it.
  const oldLoads = new Set(oracle.loads(PAGE));
  const formTabId = await inWorker<number>(`chrome.tabs.create({ url: ${JSON.stringify(formUrl)}, windowId: ${mailTab.windowId}, active: true }).then((t) => t.id)`);
  fixtureIds.add(pageWindowId(session.info.engine, formTabId));
  await oracle.waitFor(() => oracle.currentLoads(PAGE).filter((l) => !oldLoads.has(l)).length >= taskPage(PAGE).files.length && Object.keys(expected).every((k) => k in oracle.values(PAGE)), `${PAGE}'s first full report`, 10_000);
  const strangerTabId = await inWorker<number>(`chrome.tabs.create({ url: ${JSON.stringify(`${mail.origin}/tabsource/message`)}, windowId: ${mailTab.windowId}, active: false }).then((t) => t.id)`);
  fixtureIds.add(pageWindowId(session.info.engine, strangerTabId));
  const before = { ...oracle.values(PAGE) };
  const fw = await focusedWindow();
  say(`tabs: mail ${mailTab.id}, form ${formTabId}, never visited ${strangerTabId}; last focused window ${fw.id} focused=${fw.focused}`);

  // The user reads the message, then switches to the form tab and clicks First name.
  await switchTo(mailTab.id);
  const mailWindow = pageWindowId(session.info.engine, mailTab.id);
  for (let i = 0; i < 20 && helper.model.windows.get(mailWindow)?.focused !== true; i++) await sleep(150);
  check("the mail tab is the window the user is in, as the page engine walked it", helper.model.windows.get(mailWindow)?.focused === true);
  await switchTo(formTabId);
  const formWindow = pageWindowId(session.info.engine, formTabId);
  for (let i = 0; i < 20 && helper.model.windowBefore(formWindow) !== mailWindow; i++) await sleep(150);
  check("the window the user just left, for the form, is the mail tab (fill's source rule)", helper.model.windowBefore(formWindow) === mailWindow, String(helper.model.windowBefore(formWindow)));
  const { sessionId: fs } = await cdp.page(formUrl);
  const mark = published.length;
  await cdp.click(fs, "#first_name");
  let popup: OfferPopup | undefined;
  for (let i = 0; i < 60 && popup === undefined; i++) {
    popup = published.slice(mark).find((m): m is OfferPopup => m.type === "popup");
    if (popup === undefined) await sleep(150);
  }
  check("a focus in the form offers a fill pop-up", popup !== undefined, popup === undefined ? `published: ${published.slice(mark).map((m) => m.type).join(", ")}; warnings: ${warnings.slice(-3).join(" | ")}` : "");
  const read = fillReads[0];
  check("the fill read the tab just left once, and only it", fillReads.length === 1 && read?.outcome === "ok" && read.text?.tabId === mailTab.id, `${fillReads.length} reads; ${fillReads.map((r) => `${r.outcome}${r.text === undefined ? "" : ` tab ${r.text.tabId}`}`).join(", ")}`);
  const readText = [...(read?.text?.selection ?? []), ...(read?.text?.blocks ?? [])].join("\n");
  check("the read took the message in the visible iframe", readText.includes("First name: Ines") && (read?.text?.frames.length ?? 0) === 2, `frames ${JSON.stringify(read?.text?.frames.map((f) => f.frameId))}`);
  const tookDecoy = DECOYS.filter((d) => readText.includes(d));
  check("the read took no decoy: outside the main region, hidden, in a hidden iframe, or in the reply draft", tookDecoy.length === 0, tookDecoy.join(", "));
  check("the read stayed under 16 KB", Buffer.byteLength(readText) <= 16 * 1024, `${Buffer.byteLength(readText)} bytes`);

  // Tab: the pop-up's Fill all.
  if (popup !== undefined) {
    const sources = popup.spec.blocks.find((b) => b.type === "source");
    say(`pop-up: ${JSON.stringify(popup.spec.blocks.find((b) => b.type === "header"))}; source ${JSON.stringify(sources)}`);
    const r = await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: popup.offerKey, actionId: "fillAll", overrides: {}, at: Date.now() });
    say(`Fill all: ${JSON.stringify(r)}`);
  }
  await sleep(1500);
  const after = oracle.values(PAGE);
  const scored = oracle.score(PAGE, expected);
  const filled = Object.keys(after).filter((k) => after[k] !== before[k]);
  say(`oracle: right ${scored.right.length} [${scored.right.join(", ")}], wrong ${scored.wrong.length}, missed ${scored.missed.length} [${scored.missed.join(", ")}]`);
  check("the oracle reads back values from the message", ["first_name", "last_name", "email", "phone"].every((k) => {
    const value = after[k];
    const want = expected[k];
    return value !== undefined && want !== undefined && want !== "none" && sameText(value, want);
  }), JSON.stringify(Object.fromEntries(filled.map((k) => [k, after[k]]))));
  check("0 wrong", scored.wrong.length === 0, JSON.stringify(scored.wrong));
  check("0 submits", oracle.submits.length === 0, String(oracle.submits.length));
  check("0 presses", oracle.strayPresses().length === 0, JSON.stringify(oracle.strayPresses()));
  check("nothing off-site", oracle.offsite().length === 0, JSON.stringify(oracle.offsite()));
  check("no probe error", oracle.probeErrors.length === 0, JSON.stringify(oracle.probeErrors));
  check("no warning carries the message's text", !/Vandermeer|Gareth|555-0147/.test(warnings.join("\n")), `${warnings.length} warnings`);

  // The rules, against the real worker.
  const direct = (tabId: number): Promise<PageResult> => session.readText(tabId, 3000);
  check("rule 1: the tab the user is in is never read", (await direct(formTabId)).outcome === "notAllowed");
  check("rule 1: a tab the user never left is never read", (await direct(strangerTabId)).outcome === "notAllowed");
  check("rule 1: the tab just left still reads (within LEFT_TAB_MS)", (await direct(mailTab.id)).outcome === "ok");
  host.registry.setSitesOff([mail.origin]);
  await sleep(200);
  check("rule 5: never on a site the user turned Caret off for", (await direct(mailTab.id)).outcome === "siteOff");
  host.registry.setSitesOff([]);
  await sleep(200);
  const { sessionId: ms } = await cdp.page(mailUrl);
  await cdp.send("Runtime.evaluate", { expression: "location.hash = 'm2'", returnByValue: true }, ms);
  await sleep(300);
  const nav = await direct(mailTab.id);
  check("rule 2: never after the tab left navigated", nav.outcome === "notAllowed" && /navigated/.test(nav.detail ?? ""), `${nav.outcome}: ${nav.detail ?? ""}`);
  await inWorker(`chrome.tabs.remove(${mailTab.id}).then(() => true)`);
  await sleep(300);
  check("rule 2: never after the tab left closed", (await direct(mailTab.id)).outcome === "notAllowed");

  const report = { at: new Date().toISOString(), jev: args.jev, engine: decide.says, spentUsd: spent, calls, page: PAGE, checks, oracle: { right: scored.right, wrong: scored.wrong, missed: scored.missed, submits: oracle.submits.length, strayPresses: oracle.strayPresses().length, offsite: oracle.offsite().length } };
  writeStoreJson(join(OUT, "journey.json"), report, 2);
  writeStore(join(OUT, "journey.log"), `${lines.join("\n")}\n`);
  const failed = checks.filter((c) => !c.ok);
  say(`${checks.length - failed.length}/${checks.length} checks passed; ${decide.says}, $${spent.toFixed(4)}`);
  return failed.length === 0 ? 0 : 1;
}

main()
  .then(async (code) => {
    await cleanup();
    say("cleaned up");
    process.exit(code);
  })
  .catch(async (e: unknown) => {
    say(`run failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    await cleanup();
    if (args.out !== undefined) writeStore(join(args.out, "journey.log"), `${lines.join("\n")}\n`);
    process.exit(1);
  });
