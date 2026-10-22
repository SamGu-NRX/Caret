// Caret's headless acceptance journey (journey-rows.ts lists its rows and oracles). One run of the real helper code
// against the real extension, with this script playing Caret's host on the helper's socket.
//
//   node fixtures/web-form/journey.ts [--sign-identity SHA1] [--out DIR]      (pnpm -C fixtures/web-form journey)
//
// --sign-identity (or CARET_SIGN_IDENTITY) names the Apple Development identity of BridgeTrust.teamId; --out (or
// CARET_JOURNEY_OUT) defaults to ~/.caret-run/evidence/alpha/journey-<short sha>, with "+dirty" when tracked files differ.
//
// What runs, as main.ts wires it: an in-process Helper and its HelperServer on a screen socket, started with a launch
// secret; page.sock beside it for the page engine; the signed bridge and test host (bridge/.build, which accept.ts
// builds) as a temporary launchd job; headless Chrome for Testing on a temporary profile with the extension loaded and
// the Native Messaging manifest in that profile only (rig.ts). Calendar writes go to FakeCalendar (executor/means.ts),
// never EventKit. Jev is canned (canned-jev.ts rules through engines/decide/canned.ts); the goal program writer is a
// canned stand-in that answers only row 4's request. No model is called.
//
// Three socket clients stand where the Mac's processes would:
// - the host: hello with host: true, answers the hostChallenge with the host proof (host-auth.ts), and sends what
//   Caret's Tab, Esc and menus send (goalRequest, planRequest, goalAccept, offerAccept, offerStop, taskControl,
//   settings);
// - a reader that reads nothing: caret-screen's role, there only to say the browser is the frontmost app (appSwitch)
//   and to answer the watch verbs. A helper with no reader refuses goals ("No screen reader is connected");
// - a plain consumer without host: true, for row 5b.
//
// The user's own actions are made through the DevTools pipe as a user would make them: trusted clicks and typed text in
// the page, tab switches through the extension worker's chrome.tabs (as a click on a tab gives). Routing is off
// (HelperOptions.routing null), as apps/caret/scripts/acceptance_helper.ts runs it: canned Jev has no rules for the
// router's questions, and each producer then triggers itself.
//
// Evidence goes to --out: results.md and results.json (journey-rows.ts), journey.log, host.ndjson (each message the host
// received, by type and size), canned-gaps.txt, and screenshots. Exit 0 only when every row passes.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Helper } from "../../helper/src/helper.ts";
import { HelperServer } from "../../helper/src/server.ts";
import { Store } from "../../helper/src/store.ts";
import { hostKey, hostProof } from "../../helper/src/host-auth.ts";
import { pageHost } from "../../helper/src/engines/host.ts";
import { pageFront } from "../../helper/src/engines/front.ts";
import { pageTabReader } from "../../helper/src/engines/tab-source.ts";
import { newLaunchSecret } from "../../helper/src/launch.ts";
import { writeLocalSecretFile } from "../../helper/src/privacy/local-secret.ts";
import { appendStoreJson, writeStore, writeStoreJson } from "../../helper/src/privacy/send.ts";
import { wirePageEngines } from "../../helper/src/engines/wire.ts";
import { pageWindowId } from "../../helper/src/engines/windows.ts";
import type { EngineSession } from "../../helper/src/engines/session.ts";
import { FakeCalendar, SocketReaderLink } from "../../helper/src/executor/means.ts";
import { EVENT_CHANGED } from "../../helper/src/executor/executor.ts";
import { isConversation } from "../../helper/src/conversation.ts";
import { nodeText } from "../../helper/src/model.ts";
import type { AskJev, JevRequest } from "../../helper/src/fill/jev.ts";
import { CannedGap, cannedReply, type CannedAnswer, type CannedRules } from "../../helper/src/engines/decide/canned.ts";
import { GROQ_QWEN_3_8_27B } from "../../helper/src/writer/config.ts";
import type { WriterPort } from "../../helper/src/writer/port.ts";
import { DEFAULT_SETTINGS } from "../../helper/src/offers/settings.ts";
import {
  ASK_CHOICES_CAPABILITY, ASK_SCOPE_CAPABILITY, ASK_TASK_CAPABILITY, FILL_ALL_CAPABILITY, GOAL_PLANS_CAPABILITY, MEMORY_DOCUMENTS_CAPABILITY,
  PAGE_TEXT_CAPABILITY, PROTOCOL_VERSION, SAVED_ANSWERS_CAPABILITY, SPEND_CAPABILITY, VALUE_CHECKS_CAPABILITY,
  type EngineMessage, type PageVerb,
} from "../../helper/src/protocol.ts";
import { CFT_BUILD, Cdp, chrome, cleanup, designated, LAUNCHD_PREFIX, launch, launchdJob, preflight, setSay, signedCopy, sleep, tail, undo, writeManifest } from "./rig.ts";
import { NetworkSink, sameText } from "./oracle.ts";
import { FixtureSite } from "./server.ts";
import { loadExpectation, taskPage } from "./tasks/site.ts";
import { pageLoopRules } from "./canned-jev.ts";
import { fieldWhoseAnswer, loadOwners, ownerOfText, ownersOf, valueOwnerAnswer, type Owners } from "./owners.ts";
import { buildReport, reportMarkdown, type Observation, type RowId } from "./journey-rows.ts";
import type { MailEvent } from "./mail.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const EXT = join(ROOT, "extension");
const BRIDGE = join(ROOT, "bridge", ".build", "release", "caret-bridge");
const TESTHOST = join(ROOT, "bridge", ".build", "release", "caret-bridge-testhost");

const { values: args } = parseArgs({ options: { "sign-identity": { type: "string" }, out: { type: "string" } } });

const t0 = Date.now();
const lines: string[] = [];
const say = (s: string): void => {
  const l = `[journey +${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`;
  lines.push(l);
  process.stdout.write(`${l}\n`);
};
setSay(say);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void cleanup().then(() => process.exit(130)));

const commit = ((): string => {
  const sha = execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["-C", ROOT, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "";
  return dirty ? `${sha}+dirty` : sha;
})();
/**
 * The Apple Development identity of BridgeTrust.teamId (bridge/Sources/CaretBridgeXPC/Trust.swift) the bridge and test host
 * are signed with: the bridge and the host each refuse the other under any other signature, so there is no default.
 */
const SIGN: string = args["sign-identity"] ?? process.env.CARET_SIGN_IDENTITY ?? "";
if (SIGN === "") throw new Error("name the signing identity: --sign-identity SHA1 or CARET_SIGN_IDENTITY (security find-identity -v -p codesigning; the team in BridgeTrust.teamId)");
const OUT = args.out ?? process.env.CARET_JOURNEY_OUT ?? join(homedir(), ".caret-run", "evidence", "alpha", `journey-${commit}`);

// ---- the run's fixed inputs ----

const FORM_PAGE = "wizard-1";
const expected = loadExpectation(FORM_PAGE).expected;
/** wizard-1's labels and the oracle's name for each. */
const LABEL_FIELD: Record<string, string> = { "First name": "first_name", "Last name": "last_name", Email: "email", Phone: "phone", Country: "country", State: "state" };
const owners: Owners = ownersOf(loadOwners(join(HERE, "owners.json"), true), FORM_PAGE, []) ?? ((): never => {
  throw new Error(`owners.json has no ${FORM_PAGE}`);
})();
/** Row 2's Ask, as a user types it in Ask Caret. */
const ASK_FILL = "fill this form from the mail";
/** Row 4's goal, nav-goals.test.ts's page task. */
const NAV_INSTRUCTION = "Reply to Kayak's flight itinerary with its confirmation number";
/** nav-goals.test.ts's PAGE program: open Kayak's thread, read its code, draft the reply, leave Send. */
const NAV_PROGRAM = `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  const box = await caret.readWindow();
  const kayak = box.targets.find((t) => t.kind === "row" && t.label.startsWith("Kayak · Flight itinerary · "));
  const open = caret.navigate(kayak.ref, "e:open");
  const thread = await caret.observe(open);
  const code = thread.values.find((v) => v.display.includes("labelled 'Confirmation number'")).display.split('"')[1];
  const reply = caret.fill(thread.targets.find((t) => t.kind === "text" && t.label.endsWith("Reply")).ref, caret.draft("Thanks, the confirmation number is " + code + ".", [thread.window]));
  const send = caret.press(thread.targets.find((t) => t.label === "Send").ref, "e:yours");
  return caret.plan({ basedOn: box.snapshot, steps: [open, reply, send] });
}`;
/** Values typed into form.html's never-read fields for row 5a. Synthetic: a test card number and made-up secrets. */
const SECRETS = [
  { label: "Password", selector: "#pw", value: "Tr0mbone-Lattice-91" },
  { label: "Card number", selector: "#card", value: "4111 1111 1111 1111" },
  { label: "One-time code", selector: "#otp", value: "482913" },
];
/** Typed into the switched-off site's form for row 6; seen anywhere from the engine, it came from that site. */
const OFF_MARKER = "Quillfeather 7731";

// ---- canned Jev, recorded ----

/** Every Jev request's sent parts (state, questions, yes/no questions), kept in memory for row 5a only; never written out. */
const jevRequests: { at: number; purpose: string; body: string }[] = [];
const cannedGaps: string[] = [];
const quoted = (t: string | null | undefined): string | null => (t === null || t === undefined ? null : (/^"([^"]*)"/u.exec(t)?.[1] ?? null));
const labelOf = (q: JevRequest["questions"][string]): string | undefined => /Label: '(.+?)'\.(?=\s|$)/u.exec(typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions))?.[1];
/** A fill question takes the option quoting wizard-1's expected value for its field exactly, else none. */
const fillValue = async (q: JevRequest["questions"][string]): Promise<CannedAnswer> => {
  const label = labelOf(q);
  const want = label === undefined ? undefined : expected[LABEL_FIELD[label] ?? ""];
  const hit = want === undefined || want === "none" ? undefined : Object.entries(q.criteria).find(([, t]) => {
    const text = quoted(t);
    return text !== null && sameText(text, want);
  })?.[0];
  return hit === undefined ? { choice: "none" in q.criteria ? "none" : (Object.keys(q.criteria)[0] ?? "none"), confidence: 0.9 } : { choice: hit, confidence: 0.95 };
};
const base = pageLoopRules(fillValue, {
  // G2 as page-loop-eval answers it: whose details a field asks for by its oracle name, whose a value is by its text.
  whose: (q) => {
    const label = labelOf(q);
    return fieldWhoseAnswer(label === undefined ? null : (LABEL_FIELD[label] ?? null), owners, (listed, field) => listed === field);
  },
  owner: (q, id, req) => {
    const text = req.subjects?.[id];
    if (text === undefined) throw new Error(`whose-value question ${id} came with no subject (JevRequest.subjects)`);
    return valueOwnerAnswer(text, q.criteria, owners);
  },
});
const rules: CannedRules = {
  ...base,
  choice: {
    ...base.choice,
    // Row 1's messages arrange something the user attends, as their text says; both asks answer yes.
    "event.card:attend": () => ({ choice: "yes", confidence: 0.95 }),
  },
};
const askJev: AskJev = async (req) => {
  jevRequests.push({ at: Date.now(), purpose: req.purpose ?? "?", body: JSON.stringify({ state: req.state, questions: req.questions, nouls: req.nouls ?? null }) });
  try {
    return await cannedReply(req, rules);
  } catch (e) {
    if (e instanceof CannedGap) cannedGaps.push(e.message);
    throw e;
  }
};

/** The goal program writer's stand-in: row 4's program for row 4's request only, and no program for any other. */
let writerScript: string | null = null;
const writerCalls: { kind: string; answered: boolean }[] = [];
const writer: WriterPort = {
  route: GROQ_QWEN_3_8_27B,
  async write(req) {
    const program = req.kind === "goal" ? writerScript : null;
    writerCalls.push({ kind: req.kind, answered: program !== null });
    return { model: "canned", provider: "canned", output: { program, reply: program ?? "" }, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, latencyMs: 0, costUsd: 0 };
  },
};

// ---- a line client on the helper's socket ----

type Msg = Record<string, unknown> & { type?: string };
class Line {
  readonly received: Msg[] = [];
  onMessage: ((m: Msg) => void) | null = null;
  private buf = "";
  private readonly s: Socket;
  private constructor(s: Socket) {
    this.s = s;
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      this.buf += d;
      for (let nl = this.buf.indexOf("\n"); nl >= 0; nl = this.buf.indexOf("\n")) {
        const m = JSON.parse(this.buf.slice(0, nl)) as Msg;
        this.buf = this.buf.slice(nl + 1);
        this.received.push(m);
        this.onMessage?.(m);
      }
    });
  }
  static connect(path: string): Promise<Line> {
    return new Promise((resolve, reject) => {
      const s = createConnection(path);
      s.once("connect", () => resolve(new Line(s)));
      s.once("error", reject);
    });
  }
  send(m: unknown): void {
    this.s.write(`${JSON.stringify(m)}\n`);
  }
  /** The first message at index `from` or later that matches, waiting up to `ms`; null when none came. */
  async next(pred: (m: Msg) => boolean, from: number, ms: number): Promise<Msg | null> {
    const end = Date.now() + ms;
    for (;;) {
      const hit = this.received.slice(from).find(pred);
      if (hit !== undefined) return hit;
      if (Date.now() > end) return null;
      await sleep(50);
    }
  }
  close(): void {
    this.s.destroy();
  }
}

/** Caret's host hello (apps/caret HostHello.capabilities, routing off), with the capabilities only a host is granted. */
const HOST_CAPABILITIES = [MEMORY_DOCUMENTS_CAPABILITY, FILL_ALL_CAPABILITY, ASK_CHOICES_CAPABILITY, SPEND_CAPABILITY, GOAL_PLANS_CAPABILITY, SAVED_ANSWERS_CAPABILITY, PAGE_TEXT_CAPABILITY, VALUE_CHECKS_CAPABILITY, ASK_SCOPE_CAPABILITY, ASK_TASK_CAPABILITY];
/** What a Caret without a host key says (HostHello.make host: false): the same less hostOnlyCapabilities. */
const PLAIN_CAPABILITIES = [MEMORY_DOCUMENTS_CAPABILITY, ASK_CHOICES_CAPABILITY, SPEND_CAPABILITY, VALUE_CHECKS_CAPABILITY, ASK_SCOPE_CAPABILITY, ASK_TASK_CAPABILITY];
/** Messages that offer the user something; a plain consumer must get none (row 5b). */
const PROPOSAL_TYPES = new Set(["fillProposal", "popup", "action", "alternatives", "patternOffer", "goalProgress", "planProposal", "askQuestion", "fileSaveOffer", "answerSaveOffer"]);

// ---- the run ----

const observations: Partial<Record<RowId, Observation>> = {};
let reached = "the run's setup";
function observe(id: RowId, o: Observation): void {
  observations[id] = o;
  const pass = o.driven && JSON.stringify(o.observed) === JSON.stringify(o.expected);
  say(`${pass ? "PASS" : "FAIL"} ${id}${pass ? "" : `: ${o.cause ?? ""}`}`);
}
const notDriven = (expectedValue: unknown, cause: string, observedValue: unknown = null): Observation => ({ driven: false, observed: observedValue, expected: expectedValue, cause });

async function main(): Promise<void> {
  preflight();
  for (const f of [BRIDGE, TESTHOST]) if (!existsSync(f)) throw new Error(`${f} is missing: build it first (swift build -c release --package-path bridge for caret-bridge and caret-bridge-testhost)`);
  mkdirSync(OUT, { recursive: true });
  say(`alpha ${commit}; building the extension`);
  execFileSync(process.execPath, [join(EXT, "build.mjs")], { stdio: "inherit" });
  const exe = await chrome();
  const extensionId = readFileSync(join(EXT, "EXTENSION_ID"), "utf8").trim();

  const tmp = mkdtempSync(join(tmpdir(), "caret-journey-"));
  undo.push({ what: `temporary directory ${tmp}`, fn: () => rmSync(tmp, { recursive: true, force: true }) });
  const site = new FixtureSite();
  await site.start();
  undo.push({ what: "fixture site", fn: () => site.stop() });
  // Row 6's switched-off site: the same pages on another origin.
  const offSite = new FixtureSite();
  await offSite.start();
  undo.push({ what: "switched-off fixture site", fn: () => offSite.stop() });
  const sink = new NetworkSink(site.tasks.oracle);
  await sink.start();
  undo.push({ what: "network sink", fn: () => sink.stop() });
  const oracle = site.tasks.oracle;

  // ---- the helper, wired as main.ts wires it ----
  const sockDir = join(tmp, "s");
  mkdirSync(sockDir, { mode: 0o700 });
  const screenSock = join(sockDir, "screen.sock");
  const pageSock = join(sockDir, "page.sock");
  const secret = newLaunchSecret();
  const warnings: string[] = [];
  const warn = (l: string): void => void warnings.push(l);
  const store = new Store(join(tmp, "data"));
  const calendar = new FakeCalendar();
  let server: HelperServer | null = null;
  let helper: Helper;
  const readerSocket = new SocketReaderLink((cmd) => server?.sendToReader(cmd) ?? false);
  const host = pageHost({ path: pageSock, secret, reader: readerSocket, apply: (m) => void helper.handleReader(m), purge: (s) => helper.purgeWindow(s), warn });
  helper = new Helper({
    store,
    askJev,
    shadow: false,
    allowBackgroundFocus: false,
    publish: (m) => server?.publish(m),
    sendToReader: (cmd) => server?.sendToReader(cmd) ?? false,
    readerLink: host.link,
    readerAnswers: readerSocket,
    pageCovers: (pid) => host.registry.forBrowser(pid) !== undefined,
    pageFront: (pid, frame) => pageFront(host.registry, pid, frame),
    pageDocument: (id) => host.registry.documentOf(id),
    pageContext: (id) => host.registry.contextOf(id),
    tabReader: pageTabReader(host.registry),
    calendar,
    writer,
    ask: { maker: "heads" },
    routing: null,
    warn,
  });
  server = new HelperServer(screenSock, () => helper, warn, secret);
  await server.listen();
  wirePageEngines({ host, helper, publish: (m) => server?.publish(m), warn });
  await host.server.listen();
  const tick = setInterval(() => helper.tick(), 250);
  undo.push({ what: "helper", fn: async () => (clearInterval(tick), await server?.close(), await host.server.close(), helper.shutdown(), helper.memory.close(), helper.journal.close(), store.close()) });

  // ---- the reader that reads nothing, the host, and a plain consumer ----
  const reader = await Line.connect(screenSock);
  undo.push({ what: "reader connection", fn: () => reader.close() });
  reader.onMessage = (m) => {
    if (m.type !== "readerCommand") return;
    const verb = m.verb as { kind: string };
    const watch = verb.kind === "watchInput" || verb.kind === "watchWindows" || verb.kind === "watchPresses";
    reader.send({ type: "verbResult", v: PROTOCOL_VERSION, id: m.id, at: Date.now(), outcome: watch ? "ok" : "noWindow", detail: watch ? null : "no native reader in this journey" });
  };
  reader.send({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: process.pid, version: "journey-reader" });

  const hostLine = await Line.connect(screenSock);
  undo.push({ what: "host connection", fn: () => hostLine.close() });
  hostLine.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: process.pid, version: "caret-journey-host", host: true, capabilities: HOST_CAPABILITIES });
  const challenge = await hostLine.next((m) => m.type === "hostChallenge" || m.type === "error", 0, 5000);
  if (challenge?.type !== "hostChallenge") throw new Error(`no hostChallenge: ${JSON.stringify(challenge)}`);
  hostLine.send({ type: "hostProof", v: PROTOCOL_VERSION, proof: hostProof(hostKey(secret), String(challenge.nonce)) });
  if ((await hostLine.next((m) => m.type === "hostAuthenticated" || m.type === "error", 0, 5000))?.type !== "hostAuthenticated") throw new Error("the host proof was refused");
  say("host authenticated on the helper's socket");

  const plain = await Line.connect(screenSock);
  undo.push({ what: "plain consumer connection", fn: () => plain.close() });
  plain.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: process.pid, version: "journey-plain-consumer", capabilities: PLAIN_CAPABILITIES });

  // ---- the bridge, the test host and Chrome for Testing ----
  const bin = join(tmp, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const bridge = signedCopy(BRIDGE, join(bin, "caret-bridge"), "dev.caret.bridge", SIGN);
  const testHost = signedCopy(TESTHOST, join(bin, "caret-bridge-testhost"), "dev.caret.host", SIGN);
  const cftApp = exe.slice(0, exe.indexOf(".app/") + 4);
  const suffix = randomBytes(4).toString("hex");
  const service = `dev.caret.w3test.${suffix}`;
  const label = LAUNCHD_PREFIX === undefined ? service : `${LAUNCHD_PREFIX}w3test.${suffix}`;
  const secretFile = join(sockDir, "launch-secret");
  writeLocalSecretFile(secretFile, secret);
  await launchdJob(tmp, label, service, [testHost, "--service", service, "--socket", pageSock, "--secret-file", secretFile, "--browser-requirement", designated(cftApp)], join(tmp, "testhost.log"));
  const profile = join(tmp, "profile");
  writeManifest(join(profile, "NativeMessagingHosts"), extensionId, bridge);
  const chromeLog = join(tmp, "chrome.log");
  const since = Date.now();
  const mailUrl = `${site.mainOrigin}/mail/`;
  const browser = launch(exe, profile, [mailUrl], { ...process.env, CARET_BRIDGE_SERVICE: service }, join(EXT, "dist"), chromeLog, ["--window-size=1280,1600", ...sink.chromeFlags()], true);
  let session: EngineSession;
  try {
    session = await host.registry.waitForEngine((s) => s.info.extensionId === extensionId && s.info.connectedAt >= since, 30_000);
  } catch {
    throw new Error(`no engine said hello; Chrome log: ${tail(chromeLog)}`);
  }
  say(`engine ${session.info.engine}, Chrome for Testing ${CFT_BUILD} pid ${session.info.browser.pid}`);
  const cdp = browser.cdp as Cdp;
  // The browser is the app the user is in, as caret-screen would report it.
  reader.send({ type: "appSwitch", v: PROTOCOL_VERSION, at: Date.now(), from: null, to: session.info.browser });

  // Every message the engine sends the helper, as a summary (row 6), and every page command the helper sends (rows 3, 4).
  const engineSeen: { at: number; type: string; tabId: number | null; origins: string[]; fieldText: boolean; tabText: boolean; json: string }[] = [];
  const receive = session.receive.bind(session);
  session.receive = (m: EngineMessage) => {
    const x = m as { type: string; tabId?: number; frames?: { origin: string }[]; focused?: { text?: unknown } | null; text?: { frames: { origin: string }[] }; docs?: { field?: unknown } };
    const origins = [...(x.frames ?? []), ...(x.text?.frames ?? [])].map((f) => f.origin);
    engineSeen.push({ at: Date.now(), type: x.type, tabId: x.tabId ?? null, origins, fieldText: (x.focused?.text !== undefined && x.focused.text !== null) || (x.docs?.field !== undefined && x.docs.field !== null) || (x.type === "pageFocus" && "text" in x && (x as { text?: unknown }).text !== undefined), tabText: x.text !== undefined, json: JSON.stringify(m) });
    return receive(m);
  };
  // Page verbs name their control by `name` (its accessible name, protocol.ts PageTarget) and `id`; they carry no node key.
  const commands: { at: number; kind: string; tabId: number | null; name: string | null }[] = [];
  const command = session.command.bind(session);
  session.command = (verb: PageVerb, timeoutMs?: number) => {
    const v = verb as { kind: string; tabId?: number | null; name?: string };
    commands.push({ at: Date.now(), kind: v.kind, tabId: v.tabId ?? null, name: v.name ?? null });
    return command(verb, timeoutMs);
  };
  const ACTS = new Set(["pageWrite", "pagePress", "pageSelect", "pageChooseOption", "pageSetChecked", "pageInsertText", "pageAttachFile"]);

  // The extension's worker, where tab switches are made as a click on a tab makes them (tab-source-journey.ts).
  const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] };
  const workerTarget = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`));
  if (workerTarget === undefined) throw new Error("the extension's worker is not running");
  const { sessionId: ws } = (await cdp.send("Target.attachToTarget", { targetId: workerTarget.targetId, flatten: true })) as { sessionId: string };
  const inWorker = async <T>(expression: string): Promise<T> => {
    const r = (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, ws)) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (r.exceptionDetails !== undefined) throw new Error(`worker threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  interface TabRow { id: number; url: string; windowId: number }
  const tabs = (): Promise<TabRow[]> => inWorker("chrome.tabs.query({}).then((ts) => ts.map((t) => ({ id: t.id, url: t.url ?? '', windowId: t.windowId })))");
  const switchTo = async (tabId: number): Promise<void> => {
    await inWorker(`chrome.tabs.update(${tabId}, { active: true }).then((t) => chrome.windows.update(t.windowId, { focused: true })).then(() => true)`);
    await sleep(500);
  };
  const closeTab = async (tabId: number): Promise<void> => void (await inWorker(`chrome.tabs.remove(${tabId}).then(() => true)`));
  const openTab = async (url: string, windowId: number): Promise<number> => inWorker<number>(`chrome.tabs.create({ url: ${JSON.stringify(url)}, windowId: ${windowId}, active: true }).then((t) => t.id)`);
  /** A DevTools session on the page target at exactly `url`. */
  const pageSession = async (url: string): Promise<string> => {
    for (let i = 0; i < 40; i++) {
      const { targetInfos: ts } = (await cdp.send("Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] };
      const t = ts.find((x) => x.type === "page" && x.url === url);
      if (t !== undefined) return ((await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true })) as { sessionId: string }).sessionId;
      await sleep(250);
    }
    throw new Error(`no page target at ${url}`);
  };
  const evaluate = async <T>(sid: string, expression: string): Promise<T> => ((await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid)) as { result: { value: T } }).result.value;
  /** The user types `text` where the caret is. */
  const typeText = async (sid: string, text: string): Promise<void> => void (await cdp.send("Input.insertText", { text }, sid));
  const shots: string[] = [];
  const screenshot = async (sid: string, name: string): Promise<void> => {
    try {
      const { data } = (await cdp.send("Page.captureScreenshot", { format: "png" }, sid)) as { data: string };
      writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
      shots.push(`${name}.png`);
    } catch (e) {
      say(`screenshot ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  let mailTab: TabRow | undefined;
  for (let i = 0; i < 40 && mailTab === undefined; i++) {
    mailTab = (await tabs()).find((t) => t.url.startsWith(mailUrl));
    if (mailTab === undefined) await sleep(250);
  }
  if (mailTab === undefined) throw new Error("the mail tab did not open");
  const mailTabId = mailTab.id;
  const mailWindow = pageWindowId(session.info.engine, mailTab.id);
  const mailSid = await pageSession(mailUrl);
  const browserWindow = mailTab.windowId;
  for (let i = 0; i < 40 && helper.model.windows.get(mailWindow)?.focused !== true; i++) await sleep(150);
  say(`mail tab ${mailTab.id} focused in the model: ${String(helper.model.windows.get(mailWindow)?.focused)}`);
  /** The user clicks a message row in the inbox (from the thread view, Back first). */
  const openThread = async (id: string): Promise<void> => {
    if (await evaluate<boolean>(mailSid, "location.hash !== ''")) {
      await evaluate(mailSid, "history.back()");
      await sleep(400);
    }
    await cdp.click(mailSid, `tr[data-id="${id}"]`);
    for (let i = 0; i < 40 && site.mail.state?.open !== id; i++) await sleep(100);
    await sleep(800);
  };
  const hostMark = (): number => hostLine.received.length;
  const progressOf = (from: number, goalId: string): Msg[] => hostLine.received.slice(from).filter((m) => m.type === "goalProgress" && m.goalId === goalId);
  const textsFor = (from: number, ids: Set<string>): string[] =>
    hostLine.received.slice(from).flatMap((m) => {
      const id = String(m.taskId ?? m.goalId ?? m.offerKey ?? (m.task as { id?: string } | undefined)?.id ?? "");
      if (![...ids].some((x) => id === x || id.startsWith(`${x}:`))) return [];
      return [m.says, m.detail, (m.task as { status?: string } | undefined)?.status].filter((s): s is string => typeof s === "string" && s !== "");
    });

  // ==== Row 4: slice 2, milestone A, in the mail tab ====
  reached = "row 4 (slice 2 milestone A)";
  await (async () => {
    const code = site.mail.code;
    const drafted = `Thanks, the confirmation number is ${code}.`;
    const exp = { firstPreview: [["handoff", "navigate", "Open 'Flight itinerary' (Kayak) yourself. Caret continues once it's open"]], waitedForUser: true, secondPreview: [["write", "write"], ["handoff", "yours"]], reply: drafted, open: "kayak", sends: 0, submits: 0, historyUpdates: 1, caretPresses: 0 };
    const cmd0 = commands.length;
    const mark = hostMark();
    writerScript = NAV_PROGRAM;
    hostLine.send({ type: "goalRequest", v: PROTOCOL_VERSION, requestId: "nav-1", instruction: NAV_INSTRUCTION, at: Date.now() });
    const first = await hostLine.next((m) => m.type === "goalProgress" && m.requestId === "nav-1", mark, 20_000);
    writerScript = null;
    const steps = (m: Msg | null): unknown[] => ((m?.steps as { kind: string; tier?: string; says: string }[] | undefined) ?? []).map((s) => [s.kind, s.tier ?? null, s.says]);
    const mailOracle = (): { sends: number; submits: number; historyUpdates: number; reply: string | null; open: string | null } => ({ sends: site.mail.sent.length, submits: site.mail.submits, historyUpdates: site.mail.state?.historyUpdates ?? 0, reply: site.mail.state?.reply ?? null, open: site.mail.state?.open ?? null });
    if (first?.event !== "segment") {
      // The user opens the row anyway, so the mail oracle still shows what Caret did meanwhile: nothing.
      await openThread("kayak");
      const o = mailOracle();
      const caretPresses = commands.slice(cmd0).filter((c) => c.kind === "pagePress").length;
      const why = first === null ? "no reply to the goalRequest within 20 s" : `${String(first.event)}: ${String(first.says ?? JSON.stringify(first).slice(0, 300))}`;
      const rows = helper.model.windows.get(mailWindow);
      const rowNodes = rows === undefined ? 0 : [...rows.nodes.values()].filter((n) => n.role === "AXRow").length;
      const rowsSay = rowNodes === 0 ? "The mail tab's page window has no AXRow node: the page engine does not project the inbox's role=row rows as list rows (slice 2 step 3, pending), so the goal program finds no 'Kayak · Flight itinerary' row to open" : `The mail tab's page window has ${rowNodes} AXRow nodes`;
      observe("slice2-milestone-a", notDriven(exp, `no preview: ${why}. ${rowsSay}. The mail oracle meanwhile: ${o.sends} sends, ${o.submits} search submits, ${caretPresses} presses dispatched by Caret; writer calls ${JSON.stringify(writerCalls)}`, { firstPreview: first === null ? null : steps(first), ...o, caretPresses }));
      await screenshot(mailSid, "row4-mail-kayak");
      return;
    }
    const goalId = String(first.goalId);
    hostLine.send({ type: "goalAccept", v: PROTOCOL_VERSION, goalId, segment: first.segment, digest: first.digest, at: Date.now() });
    const waiting = await hostLine.next((m) => m.type === "taskProgress" && String(m.taskId).startsWith(goalId) && m.phase === "acting" && String(m.detail ?? "").startsWith("waiting for you"), mark, 15_000);
    // The user opens Kayak's thread.
    await openThread("kayak");
    const second = await hostLine.next((m) => m.type === "goalProgress" && m.goalId === goalId && m.event === "segment" && m.segment !== first.segment, mark, 20_000);
    if (second !== null) {
      hostLine.send({ type: "goalAccept", v: PROTOCOL_VERSION, goalId, segment: second.segment, digest: second.digest, at: Date.now() });
      await hostLine.next((m) => m.type === "goalProgress" && m.goalId === goalId && (m.event === "finished" || m.event === "stopped"), mark, 20_000);
      await sleep(800);
    }
    const o = mailOracle();
    const caretPresses = commands.slice(cmd0).filter((c) => c.kind === "pagePress").length;
    const observed = { firstPreview: steps(first), waitedForUser: waiting !== null, secondPreview: second === null ? null : steps(second).map((s) => (s as unknown[]).slice(0, 2)), reply: o.reply, open: o.open, sends: o.sends, submits: o.submits, historyUpdates: o.historyUpdates, caretPresses };
    const ended = progressOf(mark, goalId).filter((m) => m.event === "stopped" || m.event === "finished").map((m) => `${String(m.event)}: ${String(m.says)}`);
    observe("slice2-milestone-a", { driven: true, observed, expected: exp, cause: `the goal ended: ${ended.join(" | ") || "no end reported"}` });
    await screenshot(mailSid, "row4-mail-kayak");
  })();

  // ==== Row 1: mail to event, 1b undo, 1c undo after an edit ====
  reached = "row 1 (mail to event)";
  // Location is outside the event contract (event-card.ts, CalendarEvent): compared fields only; location goes in the row's note.
  const eventOracle = (e: MailEvent): { title: string; date: string; start: string; end: string } => ({ title: e.title, date: e.date, start: e.start, end: e.end });
  /** An instant as YYYY-MM-DD and HH:MM in `zone`. */
  const local = (iso: string, zone: string): { date: string; time: string } => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  };
  /** Opens a message, clicks into its reply, types, and waits for an event offer: the offer, or null. */
  const eventOffer = async (id: string, e: MailEvent): Promise<{ offer: Msg | null; diagnosis: string; times: number }> => {
    const mark = hostMark();
    await openThread(id);
    await cdp.click(mailSid, "textarea");
    await typeText(mailSid, "Sounds good");
    const offer = await hostLine.next((m) => m.type === "action" && m.app === "Calendar", mark, 10_000);
    const w = helper.model.windows.get(mailWindow);
    const node = w === undefined ? undefined : [...w.nodes.values()].find((n) => nodeText(n).includes(e.sentence));
    const times = w === undefined ? 0 : w.values.filter((v) => v.kind === "date" || v.kind === "time").length;
    const candidate = w === undefined || node === undefined ? null : helper.events.candidate(w, node.key, e.sentence, "conversation");
    const diagnosis = `the thread's window ${w === undefined ? "is not in the model" : `is ${isConversation(w) ? "" : "not "}a conversation, its line ${node === undefined ? "is missing" : "is there"}, it has ${times} typed date/time values, and event-card.ts reads the line as ${candidate === null ? "no event" : JSON.stringify(candidate.time.kind)}`}`;
    return { offer, diagnosis, times };
  };
  await (async () => {
    const { coffee, lunch } = site.mail.events;
    const exp1 = { offer: eventOracle(coffee), calendar: [eventOracle(coffee)] };
    const exp1b = { calendarAfterUndo: [] };
    const exp1c = { undoSays: EVENT_CHANGED, calendarAfterUndo: [{ ...eventOracle(lunch), start: "13:00", end: "14:00" }] };
    const { offer, diagnosis, times } = await eventOffer("maya", coffee);
    await screenshot(mailSid, "row1-mail-maya");
    const gap = "(location is not in the event contract)";
    if (offer === null) {
      const why = times === 0 ? "Page snapshots carry no typed values (helper/src/engines/page-link.ts sets values: [] for every page window), so offers/event-card.ts spansIn finds no time span in a web thread" : "the window has typed time values, so the cause is elsewhere (see journey.log and warnings.txt)";
      const cause = `no event offer within 10 s: ${diagnosis}. ${why}; ${gap}`;
      observe("mail-to-event", { driven: true, observed: { offer: null, calendar: [] }, expected: exp1, cause });
      observe("mail-to-event-undo", notDriven(exp1b, "not driven: row 1 made no offer, so nothing was added to undo"));
      const second = await eventOffer("jonah", lunch);
      observe("mail-to-event-undo-edited", notDriven(exp1c, second.offer === null ? `not driven: Jonah's lunch made no offer either (${second.diagnosis})` : "not driven: row 1 made no offer"));
      return;
    }
    // Tab on the offer: the event goes into the fake calendar.
    const shown = (o: Msg): { title: string; date: string; start: string; end: string } => {
      const spec = o.variants as { blocks: { type: string; title?: { text: string }; rows?: { label: string; value: { text: string } }[] }[] };
      const facts = spec.blocks.find((b) => b.type === "facts")?.rows ?? [];
      const ev = helper.events.shown().find((x) => x.offerKey === o.offerKey);
      const when = ev !== undefined && "start" in ev.when ? ev.when : null;
      return { title: spec.blocks.find((b) => b.type === "header")?.title?.text ?? "", date: when === null ? "" : local(when.start, coffee.zone).date, start: when === null ? "" : local(when.start, coffee.zone).time, end: when === null ? "" : local(when.end, coffee.zone).time };
    };
    const inCalendar = (): { title: string; date: string; start: string; end: string }[] => [...calendar.events.values()].map((ev) => ({ title: ev.title, date: local(ev.start, coffee.zone).date, start: local(ev.start, coffee.zone).time, end: local(ev.end, coffee.zone).time }));
    const offerSeen = shown(offer);
    const offerFacts = (offer.variants as { blocks: { type: string; rows?: { label: string; value: { text: string } }[] }[] }).blocks.find((b) => b.type === "facts")?.rows ?? [];
    const locationNote = `location is not in the event contract (offers/event-card.ts, CalendarEvent); the message says "${coffee.location}", the card shows ${JSON.stringify(offerFacts.find((r) => /where|location/i.test(r.label))?.value.text ?? null)}`;
    const offerKey = String(offer.offerKey);
    let mark = hostMark();
    hostLine.send({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: offerKey, actionId: "add", overrides: {}, at: Date.now() });
    await hostLine.next((m) => m.type === "taskProgress" && m.taskId === offerKey && (m.phase === "done" || m.phase === "stopped" || m.phase === "handoff"), mark, 10_000);
    const added = inCalendar();
    observe("mail-to-event", { driven: true, observed: { offer: offerSeen, calendar: added }, expected: exp1, cause: "the offer or the calendar entry differs from the message", note: locationNote });
    // 1b: Undo.
    mark = hostMark();
    hostLine.send({ type: "taskControl", v: PROTOCOL_VERSION, taskId: offerKey, action: "undo" });
    await hostLine.next((m) => m.type === "taskProgress" && m.taskId === offerKey && (m.phase === "undone" || m.phase === "stopped"), mark, 10_000);
    await sleep(300);
    observe("mail-to-event-undo", { driven: true, observed: { calendarAfterUndo: inCalendar() }, expected: exp1b, cause: `undo said: ${textsFor(mark, new Set([offerKey])).join(" | ")}` });
    // 1c: a second event, edited in the calendar, then Undo.
    const next = await eventOffer("jonah", lunch);
    if (next.offer === null) return observe("mail-to-event-undo-edited", notDriven(exp1c, `not driven: Jonah's lunch made no offer (${next.diagnosis})`));
    const key2 = String(next.offer.offerKey);
    mark = hostMark();
    hostLine.send({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: key2, actionId: "add", overrides: {}, at: Date.now() });
    await hostLine.next((m) => m.type === "taskProgress" && m.taskId === key2 && (m.phase === "done" || m.phase === "stopped" || m.phase === "handoff"), mark, 10_000);
    // The user moves the event 30 minutes later in their calendar.
    for (const ev of calendar.events.values()) {
      ev.start = new Date(Date.parse(ev.start) + 30 * 60_000).toISOString();
      ev.end = new Date(Date.parse(ev.end) + 30 * 60_000).toISOString();
    }
    // The oracle after the edit: Undo must leave exactly this, and say why.
    const editedNow = inCalendar();
    mark = hostMark();
    hostLine.send({ type: "taskControl", v: PROTOCOL_VERSION, taskId: key2, action: "undo" });
    await hostLine.next((m) => m.type === "taskProgress" && m.taskId === key2 && (m.phase === "undone" || m.phase === "stopped"), mark, 10_000);
    await sleep(300);
    const said = textsFor(mark, new Set([key2]));
    const undoSays = said.some((s) => s.includes(EVENT_CHANGED)) ? EVENT_CHANGED : said.join(" | ");
    observe("mail-to-event-undo-edited", { driven: editedNow.length === 1, observed: { undoSays, calendarAfterUndo: inCalendar() }, expected: { undoSays: EVENT_CHANGED, calendarAfterUndo: editedNow }, cause: `${editedNow.length} event(s) in the calendar before the undo; undo said: ${said.join(" | ") || "nothing"}` });
  })();

  // ==== Rows 2 and 3: Ask fill on wizard-1 from the mail, then Stop mid-fill ====
  reached = "row 2 (ask fill)";
  const formUrl = (tag: string): string => `${site.mainOrigin}${taskPage(FORM_PAGE).path}?journey=${tag}`;
  /** Opens wizard-1 in a new tab after the user reads Orbitline's profile mail, so the mail tab is the tab just left. */
  let lastFormTab: number | null = null;
  const formFromMail = async (tag: string): Promise<{ tabId: number; windowId: string; sid: string; before: Record<string, string> }> => {
    // One wizard-1 tab at a time: the oracle reads the newest load of each frame.
    if (lastFormTab !== null) await closeTab(lastFormTab);
    await switchTo(mailTabId);
    await openThread("orbitline");
    const oldLoads = new Set(oracle.loads(FORM_PAGE));
    const tabId = await openTab(formUrl(tag), browserWindow);
    lastFormTab = tabId;
    await oracle.waitFor(() => oracle.currentLoads(FORM_PAGE).filter((l) => !oldLoads.has(l)).length >= taskPage(FORM_PAGE).files.length && Object.keys(expected).every((k) => k in oracle.values(FORM_PAGE)), `${FORM_PAGE}'s first full report`, 10_000);
    // The user reads the mail again and comes back to the form: the mail tab is the one just left.
    await switchTo(mailTabId);
    await switchTo(tabId);
    const windowId = pageWindowId(session.info.engine, tabId);
    for (let i = 0; i < 30 && helper.model.windowBefore(windowId) !== mailWindow; i++) await sleep(150);
    return { tabId, windowId, sid: await pageSession(formUrl(tag)), before: { ...oracle.values(FORM_PAGE) } };
  };
  const settle = async (): Promise<Record<string, string>> => {
    let prev = JSON.stringify(oracle.values(FORM_PAGE));
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      const now = JSON.stringify(oracle.values(FORM_PAGE));
      if (now === prev) break;
      prev = now;
    }
    return JSON.parse(prev) as Record<string, string>;
  };
  const fieldOf = (labelText: string): string => LABEL_FIELD[labelText] ?? `label:${labelText}`;
  type Segment = Msg & { goalId: string; segment: number; digest: string; page?: { rows: { step: number; label: string; value: string }[] } };
  await (async () => {
    const exp = { preview: { ...expected }, written: { ...expected }, ownerViolations: [], changedAfterUndo: [] };
    const form = await formFromMail("ask");
    const mark = hostMark();
    hostLine.send({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "ask-fill-1", at: Date.now(), instruction: ASK_FILL, windowId: form.windowId });
    const reply = await hostLine.next((m) => (m.type === "goalProgress" || m.type === "planProposal" || m.type === "askQuestion") && m.requestId === "ask-fill-1", mark, 30_000);
    if (reply?.type !== "goalProgress" || reply.event !== "segment") {
      observe("ask-fill", notDriven(exp, `no page goal preview: ${reply === null ? "no reply within 30 s" : JSON.stringify(reply).slice(0, 400)}; canned gaps: ${cannedGaps.slice(-2).join(" | ") || "none"}`));
      return;
    }
    // Each Tab accepts the segment showing; a write that reveals a field (State after Country) previews the next.
    const preview: Record<string, string> = {};
    const accepted: { goalId: string; segment: number }[] = [];
    let next: Segment | null = reply as Segment;
    for (let tabsPressed = 0; next !== null && tabsPressed < 6; tabsPressed++) {
      for (const r of next.page?.rows ?? []) preview[fieldOf(r.label)] = r.value;
      accepted.push({ goalId: next.goalId, segment: next.segment });
      const at = hostMark();
      hostLine.send({ type: "goalAccept", v: PROTOCOL_VERSION, goalId: next.goalId, segment: next.segment, digest: next.digest, at: Date.now() });
      const end = await hostLine.next((m) => m.type === "goalProgress" && m.goalId === next?.goalId && (m.event === "finished" || m.event === "stopped"), at, 20_000);
      const seen = new Set(accepted.map((a) => `${a.goalId}:${a.segment}`));
      next = (await hostLine.next((m) => m.type === "goalProgress" && m.event === "segment" && !seen.has(`${String(m.goalId)}:${String(m.segment)}`), at, end?.event === "finished" ? 2500 : 500)) as Segment | null;
    }
    const after = await settle();
    await screenshot(form.sid, "row2-form-filled");
    const changed = Object.keys(after).filter((k) => after[k] !== form.before[k]);
    const written = Object.fromEntries(changed.map((k) => [k, after[k] ?? ""]));
    const ownerViolations = changed.filter((k) => owners.otherFields.includes(k) || ownerOfText(after[k] ?? "", owners) === "other").map((k) => `${k}: ${after[k] ?? ""}`);
    // Undo, newest segment first, as the activity list's Undo sends it for each, one after the other: the helper refuses
    // an older segment's Undo while a newer one's writes stand ("undo ... first: its writes came after this one's").
    const undoMark = hostMark();
    for (const a of [...accepted].reverse()) {
      const taskId = `${a.goalId}:s${a.segment}`;
      const at = hostMark();
      hostLine.send({ type: "taskControl", v: PROTOCOL_VERSION, taskId, action: "undo" });
      await hostLine.next((m) => m.type === "taskProgress" && m.taskId === taskId && (m.phase === "undone" || m.phase === "stopped"), at, 10_000);
    }
    await sleep(500);
    const undone = await settle();
    await screenshot(form.sid, "row2-form-undone");
    const changedAfterUndo = Object.keys(undone).filter((k) => undone[k] !== form.before[k]).map((k) => `${k}: ${undone[k] ?? ""}`);
    const ids = new Set(accepted.map((a) => a.goalId));
    const said = [...progressOf(mark, [...ids][0] ?? "").filter((m) => m.event === "finished" || m.event === "stopped").map((m) => String(m.says)), ...textsFor(undoMark, ids)];
    observe("ask-fill", { driven: true, observed: { preview, written, ownerViolations, changedAfterUndo }, expected: exp, cause: `${accepted.length} segment(s) accepted; Caret said: ${said.join(" | ") || "nothing"}${cannedGaps.length > 0 ? `; canned gaps: ${cannedGaps.slice(-2).join(" | ")}` : ""}` });
  })();

  reached = "row 3 (stop mid-fill)";
  await (async () => {
    const form = await formFromMail("stop");
    const mark = hostMark();
    hostLine.send({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "ask-stop-1", at: Date.now(), instruction: ASK_FILL, windowId: form.windowId });
    const reply = await hostLine.next((m) => (m.type === "goalProgress" || m.type === "planProposal" || m.type === "askQuestion") && m.requestId === "ask-stop-1", mark, 30_000);
    if (reply?.type !== "goalProgress" || reply.event !== "segment") {
      observe("stop-mid-fill", notDriven({ writesAfterStop: 0, mayHaveBeenWritten: "the fields dispatched and not verified before the stop" }, `no page goal preview to accept: ${reply === null ? "no reply within 30 s" : JSON.stringify(reply).slice(0, 300)}`));
      return;
    }
    const seg = reply as Segment;
    const taskId = `${seg.goalId}:s${seg.segment}`;
    if ((seg.page?.rows.length ?? 0) < 2) {
      observe("stop-mid-fill", notDriven({ writesAfterStop: 0 }, `the preview has ${seg.page?.rows.length ?? 0} write(s); a stop mid-fill needs at least two`));
      return;
    }
    // Esc on the working line the moment the first write is verified, as the host sees it.
    let stopAt: number | null = null;
    const prior = hostLine.onMessage;
    hostLine.onMessage = (m) => {
      if (stopAt === null && m.type === "goalProgress" && m.event === "step" && m.taskId === taskId && m.phase === "verified") {
        hostLine.send({ type: "offerStop", v: PROTOCOL_VERSION, offerId: taskId, at: Date.now() });
        stopAt = Date.now();
      }
    };
    const cmd0 = commands.length;
    const acceptMark = hostMark();
    hostLine.send({ type: "goalAccept", v: PROTOCOL_VERSION, goalId: seg.goalId, segment: seg.segment, digest: seg.digest, at: Date.now() });
    await hostLine.next((m) => m.type === "goalProgress" && m.goalId === seg.goalId && (m.event === "finished" || m.event === "stopped"), acceptMark, 20_000);
    await sleep(1500);
    hostLine.onMessage = prior;
    await screenshot(form.sid, "row3-form-stopped");
    const formTab = form.tabId;
    const acts = commands.slice(cmd0).filter((c) => ACTS.has(c.kind) && c.tabId === formTab);
    const stopped = stopAt ?? Number.POSITIVE_INFINITY;
    const dispatched = [...new Set(acts.filter((c) => c.at <= stopped).map((c) => fieldOf(c.name ?? "?")))];
    const verified = new Set(progressOf(acceptMark, seg.goalId).filter((m) => m.event === "step" && m.phase === "verified").map((m) => fieldOf(String(m.says).split(":")[0] ?? "")));
    const texts = [...progressOf(acceptMark, seg.goalId).map((m) => String(m.says ?? "")), ...textsFor(acceptMark, new Set([seg.goalId]))];
    const claimed = [...new Set(Object.keys(LABEL_FIELD).filter((l) => texts.some((t) => /may have been written/i.test(t) && t.includes(l))).map(fieldOf))].sort();
    const observed = { stopSent: stopAt !== null, writesAfterStop: acts.filter((c) => c.at > stopped).length, mayHaveBeenWritten: claimed };
    const expectedRow = { stopSent: true, writesAfterStop: 0, mayHaveBeenWritten: dispatched.filter((f) => !verified.has(f)).sort() };
    observe("stop-mid-fill", { driven: stopAt !== null, observed, expected: expectedRow, cause: stopAt === null ? "no write was verified, so the host never sent Stop" : `dispatched before the stop: ${dispatched.join(", ") || "none"}; verified: ${[...verified].join(", ") || "none"}; Caret said: ${[...new Set(texts)].join(" | ") || "nothing"}` });
  })();

  // ==== Row 5: secrets on form.html, then a plain consumer's view ====
  reached = "row 5 (privacy)";
  const formHtml = `${site.mainOrigin}/form`;
  const since5 = Date.now();
  const plainMark = plain.received.length;
  const formTab = await openTab(formHtml, browserWindow);
  await sleep(1500);
  const formSid = await pageSession(formHtml);
  for (const s of SECRETS) {
    await cdp.click(formSid, s.selector);
    await typeText(formSid, s.value);
  }
  // A fillable field: the user clicks First name, which is empty.
  await cdp.click(formSid, "#first_name");
  await sleep(5000);
  await screenshot(formSid, "row5-form-secrets");
  plain.send({ type: "firstLookPreviewRequest", v: PROTOCOL_VERSION, requestId: "plain-preview-1", at: Date.now(), families: ["fill", "event"], level: "balanced" });
  plain.send({ type: "firstLook", v: PROTOCOL_VERSION, requestId: "plain-look-1", at: Date.now(), families: ["fill", "event"], level: "balanced", deadlineMs: 5000 });
  await plain.next((m) => m.type === "firstLookReply" || (m.type === "error" && /firstLook/.test(String(m.message))), plainMark, 8000);
  await sleep(500);
  {
    const got = plain.received;
    const proposals = got.filter((m) => PROPOSAL_TYPES.has(m.type ?? "")).map((m) => String(m.type));
    const previews = got.filter((m) => m.type === "firstLookPreview" || (m.type === "firstLookReply" && m.found !== null)).map((m) => String(m.type));
    const whileField = got.slice(plainMark).filter((m) => PROPOSAL_TYPES.has(m.type ?? "")).length;
    const counts = (xs: string[]): Record<string, number> => xs.reduce<Record<string, number>>((a, t) => ((a[t] = (a[t] ?? 0) + 1), a), {});
    observe("privacy-non-host", {
      driven: true,
      observed: { proposals: proposals.length, previews: previews.length },
      expected: { proposals: 0, previews: 0 },
      cause: `the plain consumer got ${JSON.stringify(counts(proposals))} over the run (${whileField} while form.html's First name was focused) and previews ${JSON.stringify(counts(previews))}; its firstLookPreviewRequest was ${got.some((m) => m.type === "error" && /firstLookPreviewRequest/.test(String(m.message))) ? "refused" : "answered"}. Every send passes helper/src/send-gate.ts, which gives a consumer that has not proven the host key only status`,
    });
  }

  // ==== Row 6: the off site ====
  reached = "row 6 (site off)";
  await (async () => {
    const offOrigin = offSite.mainOrigin;
    hostLine.send({ type: "settings", v: PROTOCOL_VERSION, at: Date.now(), roles: [...DEFAULT_SETTINGS.roles], level: DEFAULT_SETTINGS.level, paused: false, sitesOff: [offOrigin] });
    await sleep(800);
    const seen0 = engineSeen.length;
    const offUrl = `${offOrigin}/form`;
    const offTab = await openTab(offUrl, browserWindow);
    await sleep(1500);
    const offSid = await pageSession(offUrl);
    await cdp.click(offSid, "#first_name");
    await typeText(offSid, OFF_MARKER);
    await cdp.click(offSid, "#email");
    await sleep(1000);
    await screenshot(offSid, "row6-off-site");
    // The user leaves it for the fixture form and clicks an empty field there: a fill may read the tab just left.
    await switchTo(formTab);
    await cdp.click(formSid, "#email");
    await sleep(2500);
    // The helper's own read of that tab, as the tab source makes it.
    const direct = await session.readText(offTab, 3000);
    await sleep(300);
    const fromOff = engineSeen.slice(seen0).filter((x) => x.tabId === offTab || x.origins.includes(offOrigin) || x.json.includes(OFF_MARKER) || x.json.includes(offOrigin));
    // A focus move on an off site is reported with ids only (PageFocusMoved: type, v, at, tabId, frameId; #14 64dc3571
    // "Focus reports from those pages carry only the tab and frame ids"). Those carry nothing of the page and are
    // reported as a note; a focus report carrying any other key counts.
    const ID_ONLY = new Set(["type", "v", "at", "tabId", "frameId"]);
    const focus = fromOff.filter((x) => x.type === "pageFocus");
    const focusWithContent = focus.filter((x) => Object.keys(JSON.parse(x.json) as object).some((k) => !ID_ONLY.has(k)));
    const observed = {
      snapshots: fromOff.filter((x) => x.type === "pageSnapshot").length,
      focusReports: focusWithContent.length,
      fieldText: fromOff.filter((x) => x.fieldText || x.json.includes(OFF_MARKER)).length,
      tabText: fromOff.filter((x) => x.tabText).length,
    };
    observe("deny-site-off", { driven: true, observed, expected: { snapshots: 0, focusReports: 0, fieldText: 0, tabText: 0 }, cause: `${fromOff.length} engine message(s) about the switched-off tab or origin: ${[...new Set(fromOff.map((x) => x.type))].join(", ") || "none"}; the helper's direct read of the tab answered ${direct.outcome}`, note: `${focus.length - focusWithContent.length} id-only focus report(s) from the off tab (tab and frame ids, no page content), as #14's contract sends` });
    hostLine.send({ type: "settings", v: PROTOCOL_VERSION, at: Date.now(), roles: [...DEFAULT_SETTINGS.roles], level: DEFAULT_SETTINGS.level, paused: false, sitesOff: [] });
  })();

  // ==== Row 5a: every recorded Jev request against the secrets on the page ====
  reached = "row 5a (Jev requests)";
  {
    const variants = SECRETS.flatMap((s) => [s.value, s.value.replaceAll(" ", "")]);
    const leaking = jevRequests.filter((r) => variants.some((v) => r.body.includes(v)));
    const after = jevRequests.filter((r) => r.at >= since5).length;
    const listed = SECRETS.map((s) => `${s.label} (sha256 ${createHash("sha256").update(s.value).digest("hex").slice(0, 12)}, ${s.value.length} chars)`).join(", ");
    const byPurpose = jevRequests.reduce<Record<string, number>>((a, r) => ((a[r.purpose] = (a[r.purpose] ?? 0) + 1), a), {});
    observe("privacy-jev-requests", after === 0
      ? notDriven({ requestsWithSecret: [] }, `no Jev request was made after the secrets were typed (${jevRequests.length} before), so the row shows nothing about them`, { requestsWithSecret: leaking.map((r) => r.purpose) })
      : { driven: true, observed: { requestsWithSecret: leaking.map((r) => r.purpose) }, expected: { requestsWithSecret: [] }, cause: `searched ${jevRequests.length} requests (${after} after the secrets were typed; by purpose ${JSON.stringify(byPurpose)}) for ${listed}` });
  }

  // ---- evidence ----
  reached = "the end";
  rmSync(join(OUT, "host.ndjson"), { force: true });
  for (const m of hostLine.received) appendStoreJson(join(OUT, "host.ndjson"), { type: m.type, chars: JSON.stringify(m).length, id: m.taskId ?? m.goalId ?? m.offerKey ?? m.requestId ?? null, event: m.event ?? m.phase ?? null });
  writeStore(join(OUT, "canned-gaps.txt"), `${cannedGaps.join("\n")}\n`);
  writeStore(join(OUT, "warnings.txt"), `${warnings.map((w) => w.slice(0, 400)).join("\n")}\n`);
  writeStoreJson(join(OUT, "run.json"), { commit, chrome: CFT_BUILD, engine: session.info.engine, jevRequests: jevRequests.length, writerCalls, pageCommands: commands.length, engineMessages: engineSeen.length, screenshots: shots }, 2);
}

function writeReport(): number {
  const report = buildReport(commit, new Date().toISOString(), observations, `the run stopped at ${reached}`);
  writeStoreJson(join(OUT, "results.json"), report, 2);
  writeStore(join(OUT, "results.md"), reportMarkdown(report));
  say(`${report.passed}/${report.rows.length} rows pass; evidence in ${OUT}`);
  return report.failed === 0 ? 0 : 1;
}

main()
  .then(async () => {
    const code = writeReport();
    await cleanup();
    say("cleaned up");
    writeStore(join(OUT, "journey.log"), `${lines.join("\n")}\n`);
    process.exit(code);
  })
  .catch(async (e: unknown) => {
    say(`run failed at ${reached}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    mkdirSync(OUT, { recursive: true });
    writeReport();
    await cleanup();
    writeStore(join(OUT, "journey.log"), `${lines.join("\n")}\n`);
    process.exit(1);
  });
