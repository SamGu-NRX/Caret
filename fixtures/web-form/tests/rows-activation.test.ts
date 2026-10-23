// Slice 2's browser acceptance (rows-activation): the real extension in headless Chrome for Testing, the real helper
// on its sockets, and tests/fake-host.mjs standing in for the signed Mac bridge and test host, which do not exist
// here. A pageWalk of /mail/ carries the Kayak row with its cells and qualification (page-link's projection), a
// pageActivateItem under a scoped grant opens the row through the page's own click handler (one pushState, the thread
// rendered, the oracle's report), and the same verb aimed at the row-shaped submit button is refused before anything
// is pressed — the navigation negative (public/mail/index.html). Nothing of the fill is involved: no Jev question is
// ever asked, so one being asked fails this run loudly.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Helper } from "../../../helper/src/helper.ts";
import { HelperServer } from "../../../helper/src/server.ts";
import { Store } from "../../../helper/src/store.ts";
import { pageHost } from "../../../helper/src/engines/host.ts";
import { pageFront } from "../../../helper/src/engines/front.ts";
import { pageTabReader } from "../../../helper/src/engines/tab-source.ts";
import { newLaunchSecret } from "../../../helper/src/launch.ts";
import { wirePageEngines } from "../../../helper/src/engines/wire.ts";
import { FakeCalendar, SocketReaderLink } from "../../../helper/src/executor/means.ts";
import type { EngineSession } from "../../../helper/src/engines/session.ts";
import type { AskJev } from "../../../helper/src/fill/jev.ts";
import type { WriterPort } from "../../../helper/src/writer/port.ts";
import { Cdp, chrome, cleanup, launch, preflight, sleep, tail, undo, writeManifest } from "../rig.ts";
import { FixtureSite } from "../server.ts";

const HERE = import.meta.dirname;
const ROOT = join(HERE, "..", "..", "..");
const EXT = join(ROOT, "extension");
const EXTENSION_ID = readFileSync(join(EXT, "EXTENSION_ID"), "utf8").trim();

/** No fill runs here: a Jev question is a bug this run must name, never answer. */
const askJev: AskJev = async (req) => {
  throw new Error(`no Jev question may be asked in the activation run: ${req.purpose ?? "?"}`);
};
const writer: WriterPort = {
  route: { model: "canned", provider: "canned", canonical: "canned" } as unknown as WriterPort["route"],
  async write(req) {
    return { model: "canned", provider: "canned", output: { program: null, reply: "" }, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, latencyMs: 0, costUsd: 0 };
  },
};

let site: FixtureSite;
let engineSession: EngineSession;
let cdp: Cdp;
interface Walked {
  tabId: number;
  frameId: number;
  documentId: string;
  origin: string;
  navGen: number;
  row: { id: string; name: string; cells: string[]; inForm: boolean | undefined; href: string | undefined };
  button: { id: string; name: string };
}
let walked: Walked;

before(async () => {
  preflight();
  execFileSync(process.execPath, [join(EXT, "build.mjs")], { stdio: "inherit" });
  const files = mkdtempSync(join(tmpdir(), "caret-rows-activation-"));
  undo.push({ what: `temporary directory ${files}`, fn: () => rmSync(files, { recursive: true, force: true }) });

  // ---- the helper, wired as journey.ts wires it (the page engine's helper side) ----
  const sockDir = join(files, "s");
  mkdirSync(sockDir, { mode: 0o700 });
  const screenSock = join(sockDir, "screen.sock");
  const pageSock = join(sockDir, "page.sock");
  const secret = newLaunchSecret();
  const warnings: string[] = [];
  const warn = (l: string): void => void warnings.push(l);
  const store = new Store(join(files, "data"));
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
    publish: (m) => void server?.publish(m),
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
  wirePageEngines({ host, helper, publish: (m) => void server?.publish(m), warn });
  await host.server.listen();
  const tick = setInterval(() => helper.tick(), 250);
  undo.push({
    what: "helper",
    fn: async () => {
      clearInterval(tick);
      await server?.close();
      await host.server.close();
      helper.shutdown();
      helper.memory.close();
      helper.journal.close();
      store.close();
    },
  });

  // ---- the Native Messaging host: the fake host with this run's socket, secret and pid baked into a launcher ----
  const bin = join(files, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const fakeHost = join(bin, "fake-host.mjs");
  copyFileSync(join(HERE, "fake-host.mjs"), fakeHost);
  chmodSync(fakeHost, 0o755);
  const launcher = join(bin, "launch-host.mjs");
  const args = ["--socket", pageSock, "--secret-hex", secret.toString("hex"), "--helper-pid", String(process.pid), "--extension-id", EXTENSION_ID];
  writeFileSync(
    launcher,
    `#!/usr/bin/env -S node\nimport { spawn } from "node:child_process";\nconst p = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(fakeHost)}, ${args.map((a) => JSON.stringify(a)).join(", ")}], { stdio: ["inherit", "inherit", "inherit"] });\np.on("exit", (c) => process.exit(c ?? 1));\n`,
  );
  chmodSync(launcher, 0o755);
  // In the launch profile's own NativeMessagingHosts, as the journey writes it, and in the default profile's too,
  // where Chrome on Linux also looks for manifests whatever --user-data-dir says. writeManifest refuses to overwrite
  // a manifest this run did not write, so a real Caret install outside the sandbox stops this run instead of breaking.
  writeManifest(join(files, "profile", "NativeMessagingHosts"), EXTENSION_ID, launcher);
  writeManifest(join(homedir(), ".config", "google-chrome", "NativeMessagingHosts"), EXTENSION_ID, launcher);

  // ---- the site and Chrome for Testing with the built extension ----
  site = new FixtureSite();
  await site.start();
  undo.push({ what: "fixture site", fn: () => site.stop() });
  const exe = await chrome();
  const profile = join(files, "profile");
  const chromeLog = join(files, "chrome.log");
  const browser = launch(exe, profile, [`${site.mainOrigin}/mail/`], { ...process.env }, join(EXT, "dist"), chromeLog, ["--window-size=1280,1600"], true);
  undo.push({ what: "Chrome for Testing", fn: async () => void (await browser.stop()) });
  cdp = browser.cdp as Cdp;

  // ---- the engine says hello, and its first walk carries the row ----
  try {
    engineSession = await host.registry.waitForEngine((s) => s.info.extensionId === EXTENSION_ID && s.info.browser.pid > 0, 60_000);
    const answered = await engineSession.command({ kind: "pageWalk", tabId: null }, 20_000);
    assert.equal(answered.result.outcome, "ok", `the walk of /mail/ failed: ${answered.result.detail}`);
    const snapshot = answered.snapshot;
    assert.ok(snapshot, "the walk sent no snapshot");
    const top = (snapshot.frames.find((f) => f.parentFrameId === -1) ?? snapshot.frames[0]) as (typeof snapshot.frames)[number];
    assert.ok(top, "the walk sent no top frame");
    const row = top.controls.find((c) => c.kind === "row" && c.name.startsWith("Kayak · "));
    assert.ok(row, `no Kayak row walked: ${top.controls.map((c) => `${c.kind}:${c.name.slice(0, 40)}`).join(", ")}`);
    const button = top.controls.find((c) => c.kind === "button" && c.name === "Saved search: flight itineraries");
    assert.ok(button, "the row-shaped submit button is not walked");
    walked = {
      tabId: snapshot.tabId,
      frameId: top.frameId,
      documentId: top.documentId,
      origin: top.origin,
      navGen: top.navGen,
      row: { id: row.id, name: row.name, cells: row.cells ?? [], inForm: row.inForm, href: row.href },
      button: { id: button.id, name: button.name },
    };
  } catch (e) {
    throw new Error(`no engine or no row: ${e instanceof Error ? e.message : String(e)}; Chrome log: ${tail(chromeLog)}`);
  }
});

after(async () => {
  await cleanup();
});

/** Waits until `pred` holds, polling. */
const until = async (what: string, pred: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  for (;;) {
    if (pred()) return;
    if (Date.now() > end) throw new Error(`${what} within ${ms} ms`);
    await sleep(50);
  }
};

/** Evaluates an expression in /mail/'s page. */
const inPage = async <T>(expression: string): Promise<T> => {
  const { sessionId } = await cdp.page(`${site.mainOrigin}/mail/`);
  const r = (await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)) as { result: { value: T }; exceptionDetails?: { exception?: { description?: string } } };
  if (r.exceptionDetails !== undefined) throw new Error(`the page threw: ${r.exceptionDetails.exception?.description ?? "unknown"}`);
  return r.result.value;
};

test("the walk projects the row's cells and qualification, the submit button is refused, and the activation opens it", async () => {
  // The projection, end to end in a real browser: cells in order, the qualification navVerdict reads.
  assert.deepEqual(walked.row.cells, ["Kayak", "Flight itinerary", "3m ago"]);
  assert.equal(walked.row.inForm, false);
  assert.equal(walked.row.href, "none");

  // A scoped act grant for the walked frame and generation, as the helper's page engine issues one.
  const at = Date.now();
  engineSession.grant({
    type: "scopedActGrant",
    v: 1,
    taskId: "test:rows-activation:s0",
    scope: { kind: "page", engine: engineSession.info.engine, tabId: walked.tabId, frameId: walked.frameId, origin: walked.origin, navGen: walked.navGen },
    at,
    expires: at + 30_000,
  });

  // The navigation negative first, while the walked button is still the live element: the same verb at the row-shaped
  // submit button is refused on its role before anything is pressed.
  const refused = await engineSession.command(
    { kind: "pageActivateItem", tabId: walked.tabId, frameId: walked.frameId, documentId: walked.documentId, id: walked.button.id, control: "row", name: "Saved search: flight itineraries", taskId: "test:rows-activation:s0", rebind: false },
    15_000,
  );
  assert.notEqual(refused.result.outcome, "ok", `the submit button was activated: ${refused.result.detail}`);
  assert.match(refused.result.detail ?? "", /not a row/i);
  assert.equal(site.mail.submits, 0, "the row-shaped search form was never submitted");
  assert.equal(site.mail.state?.open, null, "the refusal opened nothing");
  assert.equal(site.mail.state?.historyUpdates, 0, "the refusal changed no history");

  // Caret opens the row itself: the page's own click handler runs (one pushState, the thread rendered in place).
  const opened = await engineSession.command(
    { kind: "pageActivateItem", tabId: walked.tabId, frameId: walked.frameId, documentId: walked.documentId, id: walked.row.id, control: "row", name: walked.row.name, taskId: "test:rows-activation:s0", rebind: false },
    15_000,
  );
  assert.equal(opened.result.outcome, "ok", `the activation failed: ${opened.result.detail}`);
  await until("the page's report of the open", () => site.mail.state?.open === "kayak" && site.mail.state.historyUpdates === 1);
  assert.equal(await inPage<string>("location.hash"), "#thread/kayak");
  assert.equal(await inPage<string>("document.title"), "Flight itinerary - Mail");
  assert.ok(await inPage<boolean>("document.querySelector('.thread h2')?.textContent === 'Flight itinerary'"));
  assert.deepEqual(site.mail.sent, [], "opening a row sends nothing");
});
