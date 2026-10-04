// The page engine's acceptance (browser layer memo, section 7: batch 1, and batch 2 from W2), as one command:
//
//   node fixtures/web-form/accept.ts [--skip-build] [--electron DIR] [--no-reader] [--nm-probe] [--idle SECONDS] [--memory-tabs N] [--dump-walk] [--evidence DIR]
//
// It builds the extension and the bridge, installs the pinned Chrome for Testing with @puppeteer/browsers, writes
// the bridge's Native Messaging manifest into Chrome for Testing's own directory (never Chrome's or Helium's),
// starts the fixture site on 127.0.0.1 and the helper in fixture mode in this process (canned Jev answers, page.sock
// in a temporary directory), launches headless Chrome for Testing on a temporary profile with --load-extension, waits
// for the engine's hello, and runs every batch 1 check through the helper's EngineRegistry. It removes the manifest,
// the profile and the sockets, and stops every process it started, whatever happened. Exit 0 only when every check
// passed.
//
// --nm-probe   first tries a manifest only in the temporary profile's NativeMessagingHosts, then only in Chrome for
//              Testing's default directory, and reports which one Chrome read (memo hypothesis 1).
// --idle S     after the checks, sends nothing for S seconds, then pings: the same worker instance on the same
//              connection answers if an open Native Messaging port kept the worker alive (memo hypothesis 2).
// --memory-tabs N   instead of the checks, measures renderer physical footprint with N fixture tabs open: no
//              extension, the extension without its content script, and the extension as built, two rounds each.
// --dump-walk  prints the first walk's frames and missing frames, then stops; for debugging frame composition.
// --electron DIR   an Electron installed by helper/scripts/electron-setup.sh: the reader check then also starts a
//              windowless Electron fixture and expects exactly one AXManualAccessibility attempt, on it.
// --no-reader  skips the reader check, which builds and runs caret-screen (it needs the Accessibility grant).
//
// Batch 2 (W2) adds: react-select and an ARIA combobox picked and verified, a filter that matches two options
// stopping with both names, a file attached through the input and through the dropzone from a file this run owns
// (over 1 MB, so the bridge chunks it), a fill proposal made from a page snapshot with canned Jev, "Not on this
// site", the host's presence signal, and the reader's AXManualAccessibility log. /submitted still reads 0.
// A caller that already holds the heavy lock sets CARET_HEAVY_LOCK_HELD=1, so the bridge build does not wait on it.
//
// Browser control is the page's own script taking commands from the fixture server (fixture.js); no debugger or CDP
// connection is made, so nothing here keeps the worker alive but the port under test.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Browser, computeExecutablePath, detectBrowserPlatform, install } from "@puppeteer/browsers";
import { Helper } from "../../helper/src/helper.ts";
import { Store } from "../../helper/src/store.ts";
import { pageHost, type PageHost } from "../../helper/src/engines/host.ts";
import type { EngineSession } from "../../helper/src/engines/session.ts";
import { pageWindowId } from "../../helper/src/engines/windows.ts";
import { wirePageEngines } from "../../helper/src/engines/wire.ts";
import { ConfirmedFiles } from "../../helper/src/engines/attach.ts";
import type { PageEngineLink } from "../../helper/src/engines/page-link.ts";
import type { ReaderLink } from "../../helper/src/executor/means.ts";
import type { AskJev } from "../../helper/src/fill/jev.ts";
import type { HelperMessage, PageControl, PageFrame, PageResult, PageSnapshot, PageVerb } from "../../helper/src/protocol.ts";
import { FixtureSite } from "./server.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const EXT = join(ROOT, "extension");
const BRIDGE_PKG = join(ROOT, "bridge");
const BRIDGE = join(BRIDGE_PKG, ".build", "release", "caret-bridge");
const READER_PKG = join(ROOT, "apps", "screen-reader");
const READER = join(READER_PKG, ".build", "debug", "caret-screen");
/** Chrome for Testing stable on 2026-10-04 (resolveBuildId "stable"); pinned so every run tests the same browser. */
const CFT_BUILD = "154.0.8037.92";
const CACHE = join(HERE, ".browsers");
const HOST_NAME = "ai.caret.bridge";
const SUPPORT = join(homedir(), "Library", "Application Support");
/** Chrome for Testing's default user-data directory's NativeMessagingHosts: not Sam's Chrome profile. */
const CFT_NM_DIR = join(SUPPORT, "Google", "Chrome for Testing", "NativeMessagingHosts");
/** Directories this run must never write (brief W1 rules). */
const FORBIDDEN_NM = [join(SUPPORT, "Google", "Chrome", "NativeMessagingHosts"), join(SUPPORT, "net.imput.helium", "NativeMessagingHosts"), join(SUPPORT, "Chromium", "NativeMessagingHosts")];

const { values: args } = parseArgs({
  options: {
    "skip-build": { type: "boolean", default: false },
    "nm-probe": { type: "boolean", default: false },
    idle: { type: "string", default: "0" },
    "memory-tabs": { type: "string", default: "0" },
    "dump-walk": { type: "boolean", default: false },
    electron: { type: "string" },
    "no-reader": { type: "boolean", default: false },
    evidence: { type: "string", default: join(homedir(), ".caret-run", "evidence", "browser", "w2") },
  },
});

const t0 = Date.now();
const say = (s: string): void => void process.stdout.write(`[accept +${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- cleanup registry: everything this run creates is undone here, in reverse order ----
const undo: { what: string; fn: () => Promise<void> | void }[] = [];
async function cleanup(): Promise<void> {
  for (const u of undo.splice(0).reverse()) {
    try {
      await u.fn();
    } catch (e) {
      say(`cleanup of ${u.what} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void cleanup().then(() => process.exit(130)));

function preflight(): void {
  const freeGiB = Number(execFileSync("df", ["-k", "/"], { encoding: "utf8" }).trim().split("\n")[1]?.split(/\s+/)[3]) / 1048576;
  if (!(freeGiB >= 8)) throw new Error(`blocked: disk (${freeGiB.toFixed(1)} GiB free, the floor is 8)`);
  say(`disk ${freeGiB.toFixed(1)} GiB free`);
  for (const f of FORBIDDEN_NM) if (CFT_NM_DIR === f) throw new Error("refusing: the manifest directory is a real browser's");
}

function build(): void {
  if (args["skip-build"]) {
    if (!existsSync(BRIDGE) || !existsSync(join(EXT, "dist", "manifest.json")) || (!args["no-reader"] && !existsSync(READER))) throw new Error("--skip-build, but the bridge, the reader or extension/dist is missing");
    return;
  }
  say("building the extension");
  execFileSync(process.execPath, [join(EXT, "build.mjs")], { stdio: "inherit" });
  const swift = (what: string, cmd: string[]): void => {
    // A caller that already holds the heavy lock says so; taking it again from a child would wait on the parent forever.
    if (process.env.CARET_HEAVY_LOCK_HELD === "1") {
      say(`building ${what}; the caller holds the heavy lock`);
      execFileSync(cmd[0] as string, cmd.slice(1), { stdio: "inherit" });
    } else {
      say(`building ${what}, under the shared heavy lock`);
      execFileSync("/usr/bin/lockf", ["-k", join(homedir(), ".long-run", "locks", "heavy.lock"), ...cmd], { stdio: "inherit" });
    }
  };
  swift("the bridge (release)", ["swift", "build", "-c", "release", "--package-path", BRIDGE_PKG, "--product", "caret-bridge"]);
  if (!args["no-reader"]) swift("the reader (debug)", ["swift", "build", "--package-path", READER_PKG, "--product", "caret-screen"]);
}

async function chrome(): Promise<string> {
  const platform = detectBrowserPlatform();
  if (platform === undefined) throw new Error("cannot detect the platform for Chrome for Testing");
  const installed = await install({ browser: Browser.CHROME, buildId: CFT_BUILD, cacheDir: CACHE, platform });
  const exe = computeExecutablePath({ browser: Browser.CHROME, buildId: CFT_BUILD, cacheDir: CACHE, platform });
  say(`Chrome for Testing ${CFT_BUILD} at ${installed.path}`);
  return exe;
}

/** Writes the bridge manifest into `dir`, creating what is missing, and registers its removal. */
function writeManifest(dir: string, extensionId: string): void {
  if (FORBIDDEN_NM.includes(dir)) throw new Error(`refusing to write ${dir}`);
  const created: string[] = [];
  for (let d = dir; !existsSync(d); d = join(d, "..")) created.unshift(d);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${HOST_NAME}.json`);
  if (existsSync(file)) throw new Error(`${file} already exists; not overwriting something this run did not write`);
  writeFileSync(file, `${JSON.stringify({ name: HOST_NAME, description: "Caret page bridge (W1 acceptance)", path: BRIDGE, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2)}\n`);
  undo.push({
    what: file,
    fn: () => {
      rmSync(file, { force: true });
      for (const d of created.reverse()) if (existsSync(d) && readdirSync(d).length === 0) rmdirSync(d);
    },
  });
}

interface Running {
  proc: ChildProcess;
  stop: () => Promise<void>;
}

/** Headless Chrome for Testing on `profile`; its own process group, so stopping it stops every helper process too. */
/** `extension`: the unpacked extension directory to load, or null for none. */
function launch(exe: string, profile: string, urls: string[], env: NodeJS.ProcessEnv, extension: string | null, log: string, extra: string[] = []): Running {
  const flags = [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--use-mock-keychain",
    "--password-store=basic",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    ...(extension !== null ? [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`, "--disable-features=DisableLoadExtensionCommandLineSwitch"] : []),
    ...extra,
    ...urls,
  ];
  const proc = spawn(exe, flags, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const out = createWriteStream(log, { flags: "a" });
  proc.stdout?.pipe(out);
  proc.stderr?.pipe(out);
  const pid = proc.pid;
  if (pid === undefined) throw new Error("Chrome for Testing did not start");
  const stop = async (): Promise<void> => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      return;
    }
    for (let i = 0; i < 50 && proc.exitCode === null && proc.signalCode === null; i++) await sleep(100);
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  };
  undo.push({ what: `Chrome for Testing pid ${pid}`, fn: stop });
  return { proc, stop };
}

/** The frontmost app's display name, by LaunchServices; the run aborts if Chrome for Testing ever takes it. */
function frontmost(): string {
  try {
    const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
    return /"LSDisplayName"="([^"]*)"/.exec(execFileSync("lsappinfo", ["info", "-only", "name", asn], { encoding: "utf8" }))?.[1] ?? "?";
  } catch {
    return "?";
  }
}

/** Every process in Chrome's tree: pid, ppid, rss (KiB) and command. */
function processTree(root: number): { pid: number; ppid: number; rss: number; cmd: string }[] {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), cmd: m[4] ?? "" }));
  const keep = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) if (!keep.has(r.pid) && keep.has(r.ppid)) (keep.add(r.pid), (grew = true));
  }
  return rows.filter((r) => keep.has(r.pid));
}

// ---- checks ----
interface CheckResult {
  name: string;
  pass: boolean;
  ms: number;
  detail: string;
}
const results: CheckResult[] = [];
async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({ name, pass: true, ms: Date.now() - start, detail });
    say(`PASS ${name}: ${detail}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, pass: false, ms: Date.now() - start, detail });
    say(`FAIL ${name}: ${detail}`);
  }
}
function expect(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

interface Engine {
  host: PageHost;
  helper: Helper;
  session: EngineSession;
  tabId: number;
}

async function walk(e: Engine): Promise<PageSnapshot> {
  const a = await e.session.command({ kind: "pageWalk", tabId: e.tabId });
  if (a.result.outcome !== "ok" || a.snapshot === null) throw new Error(`walk: ${a.result.outcome} ${a.result.detail ?? ""}`);
  return a.snapshot;
}

function control(s: PageSnapshot, name: string, origin?: string): { frame: PageFrame; c: PageControl } {
  const hits = s.frames.flatMap((frame) => (origin !== undefined && frame.origin !== origin ? [] : frame.controls.filter((c) => c.name === name).map((c) => ({ frame, c }))));
  if (hits.length !== 1 || hits[0] === undefined) throw new Error(`${hits.length} controls named '${name}'`);
  return hits[0];
}

function target(s: PageSnapshot, name: string, taskId: string, origin?: string) {
  const { frame, c } = control(s, name, origin);
  return { tabId: s.tabId, frameId: frame.frameId, documentId: frame.documentId, id: c.id, control: c.kind, name: c.name, taskId };
}

/** The executor's way in: one ActGrant for the tab's window through the routed link, which pins every frame. */
function grant(e: Engine, taskId: string): void {
  const now = Date.now();
  e.host.link.grant({ type: "actGrant", v: 1, taskId, pid: e.session.info.browser.pid, windowId: pageWindowId(e.session.info.engine, e.tabId), at: now, expires: now + 60_000 });
}
function revoke(e: Engine, taskId: string): void {
  e.host.link.grant({ type: "actRevoke", v: 1, taskId, at: Date.now() });
}
async function run(e: Engine, verb: PageVerb): Promise<PageResult> {
  return (await e.session.command(verb)).result;
}
const outcome = (r: PageResult): string => `${r.outcome}${r.detail === null ? "" : ` (${r.detail})`}`;

async function stateHas(site: FixtureSite, key: string, value: unknown, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (site.state?.[key] === value) return;
    await sleep(50);
  }
  throw new Error(`React state ${key} is ${JSON.stringify(site.state?.[key])}, not ${JSON.stringify(value)}`);
}

async function read(site: FixtureSite, selector: string): Promise<string | undefined> {
  return (await site.command({ cmd: "read", selector })).value;
}

const TOP_NAMES = ["First name", "Email", "Start date", "Country", "Remote OK", "Day", "Night", "Cover note", "Department", "Show more", "Badge code", "Resume", "Drop your resume here", "Submit", "Preferred name", "City", "Country of residence"];
const NEVER_NAMES = ["Password", "Card number", "One-time code", "Visually hidden", "Off screen", "Not displayed", "Hidden from assistive tech", "Gender", "I agree to the terms of service", "Transparent", "Clipped away", "Expiry month", "Yes", "No", "Hidden frame field", "Sandboxed field", "Prefer to self-describe"];

async function checks(e: Engine, site: FixtureSite): Promise<void> {
  let s = await walk(e);

  await check("snapshot covers the main document, both iframes and the closed shadow root", async () => {
    const top = s.frames.find((f) => f.parentFrameId === -1);
    const same = s.frames.find((f) => f.parentFrameId !== -1 && f.origin === site.mainOrigin && f.path === "/frame/same");
    const cross = s.frames.find((f) => f.origin === site.embedOrigin);
    expect(top !== undefined && same !== undefined && cross !== undefined, `frames: ${s.frames.map((f) => `${f.frameId}@${f.origin}${f.path}`).join(", ")}; missing ${JSON.stringify(s.missing)}`);
    const names = top!.controls.map((c) => c.name);
    for (const n of TOP_NAMES) expect(names.filter((x) => x === n).length === 1, `top frame lacks exactly one '${n}': ${JSON.stringify(names)}`);
    expect(same!.controls.map((c) => c.name).join() === "Referral code", `same-origin frame: ${same!.controls.map((c) => c.name).join()}`);
    expect(s.frames.filter((f) => f.controls.some((c) => c.name === "Referral code")).length === 1, "the hidden duplicate of the referral frame was kept");
    const inline = s.frames.find((f) => f.controls.some((c) => c.name === "Inline frame field"));
    expect(inline !== undefined && inline.origin === site.mainOrigin, `the srcdoc frame that inherits the page's origin is missing: ${JSON.stringify(s.missing)}`);
    expect(cross!.controls.map((c) => c.name).join() === "Portfolio URL", `cross-origin frame: ${cross!.controls.map((c) => c.name).join()}`);
    const kinds: Record<string, string> = { "First name": "text", Email: "email", "Start date": "date", Country: "select", "Remote OK": "checkbox", Day: "radio", "Cover note": "textarea", Department: "combobox", Resume: "file", Submit: "button", "Preferred name": "text", "Country of residence": "combobox", "Badge code": "text" };
    for (const [n, k] of Object.entries(kinds)) expect(control(s, n).c.kind === k, `'${n}' is a ${control(s, n).c.kind}, not a ${k}`);
    expect(control(s, "Badge code").c.shadow === "closed", "Badge code is not marked as inside a closed shadow root");
    expect(control(s, "Country").c.options?.some((o) => o.label === "Canada") === true, "Country lists no Canada");
    expect(control(s, "First name").c.strongKey !== null && control(s, "Country of residence").c.strongKey !== null, "author identifiers gave no strong key");
    const all = s.frames.flatMap((f) => f.controls.map((c) => c.name));
    for (const n of NEVER_NAMES) expect(!all.includes(n), `excluded control '${n}' left the frame`);
    const x = top!.excluded;
    expect(x.password === 1 && (x.hidden ?? 0) >= 1 && x.payment === 2 && x.oneTimeCode === 1 && (x.invisible ?? 0) >= 5 && x.ariaHidden === 1 && (x.selfIdentification ?? 0) >= 5, `exclusion counts ${JSON.stringify(x)}`);
    expect(s.missing.filter((m) => m.reason.includes("not visible in the parent")).length >= 2, `the hidden iframes were not both dropped: missing ${JSON.stringify(s.missing)}`);
    return `${s.frames.length} frames, ${s.frames.reduce((n, f) => n + f.controls.length, 0)} controls, excluded ${JSON.stringify(x)}, missing ${JSON.stringify(s.missing)}`;
  });

  grant(e, "t-main");

  await check("a pageWrite on the React controlled input holds after blur, and React's state equals it", async () => {
    const r = await run(e, { kind: "pageWrite", ...target(s, "Preferred name", "t-main"), expect: "", value: "Robin Example" });
    expect(r.outcome === "ok", outcome(r));
    expect(r.readings?.afterInput === "Robin Example" && r.readings.afterBlur === "Robin Example", `readings ${JSON.stringify(r.readings)}`);
    await stateHas(site, "preferred", "Robin Example");
    return `readings ${JSON.stringify(r.readings)}; React state preferred=${JSON.stringify(site.state?.preferred)}`;
  });

  await check("the revert field reports failed", async () => {
    const r = await run(e, { kind: "pageWrite", ...target(s, "City", "t-main"), expect: "Springfield", value: "Shelbyville" });
    expect(r.outcome === "failed" && r.detail === "the page kept the old value", outcome(r));
    expect(r.readings?.afterBlur === "Springfield", `readings ${JSON.stringify(r.readings)}`);
    await stateHas(site, "city", "Springfield");
    return `${outcome(r)}; readings ${JSON.stringify(r.readings)}`;
  });

  await check("a native select is verified by selectedOptions", async () => {
    const r = await run(e, { kind: "pageSelect", ...target(s, "Country", "t-main"), expect: "", value: "ca" });
    expect(r.outcome === "ok" && r.readings?.afterBlur === "ca", `${outcome(r)} ${JSON.stringify(r.readings)}`);
    expect((await read(site, "#country")) === "ca", "the page's select does not hold ca");
    return `readings ${JSON.stringify(r.readings)}`;
  });

  await check("a write with no grant is notAllowed", async () => {
    const r = await run(e, { kind: "pageWrite", ...target(s, "First name", "t-none"), expect: "", value: "Nobody" });
    expect(r.outcome === "notAllowed", outcome(r));
    expect((await read(site, "#first_name")) === "", "the field changed anyway");
    return outcome(r);
  });

  await check("a write after actRevoke is notAllowed", async () => {
    grant(e, "t-rev");
    const first = await run(e, { kind: "pageWrite", ...target(s, "Email", "t-rev"), expect: "", value: "robin@example.test" });
    expect(first.outcome === "ok", `the granted write did not land: ${outcome(first)}`);
    revoke(e, "t-rev");
    const r = await run(e, { kind: "pageWrite", ...target(s, "Email", "t-rev"), expect: "robin@example.test", value: "other@example.test" });
    expect(r.outcome === "notAllowed", outcome(r));
    expect((await read(site, "#email")) === "robin@example.test", "the field changed after the revoke");
    return `before revoke ${first.outcome}; after ${outcome(r)}`;
  });

  await check("a value the page changed between walk and write is stale", async () => {
    s = await walk(e);
    const t = target(s, "First name", "t-main");
    await site.command({ cmd: "mutate", selector: "#first_name", value: "Typed by page" });
    const r = await run(e, { kind: "pageWrite", ...t, expect: "", value: "Robin" });
    expect(r.outcome === "stale", outcome(r));
    expect((await read(site, "#first_name")) === "Typed by page", "the page's text was overwritten");
    return outcome(r);
  });

  await check("a re-rendered field rebinds only by its author identifier and expected value", async () => {
    const t = target(s, "First name", "t-main");
    await site.command({ cmd: "replace", selector: "#first_name" });
    const r = await run(e, { kind: "pageWrite", ...t, expect: "Typed by page", value: "Robin" });
    expect(r.outcome === "ok" && (r.detail ?? "").includes("rebound by its strong key"), outcome(r));
    expect((await read(site, "#first_name")) === "Robin", "the replacement field does not hold the value");
    return outcome(r);
  });

  await check("writes reach the cross-origin frame and the closed shadow root", async () => {
    s = await walk(e);
    grant(e, "t-frames");
    const a = await run(e, { kind: "pageWrite", ...target(s, "Portfolio URL", "t-frames", site.embedOrigin), expect: "", value: "https://example.test/robin" });
    const b = await run(e, { kind: "pageWrite", ...target(s, "Badge code", "t-frames"), expect: "", value: "B-1234" });
    expect(a.outcome === "ok" && b.outcome === "ok", `portfolio ${outcome(a)}; badge ${outcome(b)}`);
    const again = await walk(e);
    expect(control(again, "Portfolio URL", site.embedOrigin).c.value === "https://example.test/robin" && control(again, "Badge code").c.value === "B-1234", "a re-walk does not show the values");
    return `portfolio ${a.outcome}, badge ${b.outcome}`;
  });

  await check("a checkbox is set and verified; a press with a harmless name is still a hand-off", async () => {
    const c = await run(e, { kind: "pageSetChecked", ...target(s, "Remote OK", "t-main"), checked: true });
    expect(c.outcome === "ok" && (await read(site, "#remote")) === "true", `checkbox ${outcome(c)}`);
    const p = await run(e, { kind: "pagePress", ...target(s, "Show more", "t-main") });
    expect(p.outcome === "handoff" && p.risk === "pageScript" && (await read(site, "#more-state")) === "collapsed", `press ${outcome(p)}`);
    return `checkbox ${c.outcome}; Show more ${p.outcome} (${p.risk}), page untouched`;
  });

  await check("the executor's write path (RoutedReaderLink, reader verbs) lands and the screen model shows it", async () => {
    const windowId = pageWindowId(e.session.info.engine, e.tabId);
    const w0 = await e.host.link.run({ kind: "walk", pid: e.session.info.browser.pid, windowId });
    expect(w0.outcome === "ok", `walk ${w0.outcome} ${w0.detail ?? ""}`);
    const win = e.helper.model.windows.get(windowId);
    const node = [...(win?.nodes.values() ?? [])].find((n) => n.label === "Cover note");
    expect(node !== undefined, "the screen model has no Cover note in the page window");
    const now = Date.now();
    e.host.link.grant({ type: "actGrant", v: 1, taskId: "t-exec", pid: e.session.info.browser.pid, windowId, at: now, expires: now + 60_000 });
    const r = await e.host.link.run({ kind: "write", pid: e.session.info.browser.pid, windowId, key: node!.key, role: node!.role, attribute: "value", expect: "", value: "A synthetic note", taskId: "t-exec" });
    expect(r.outcome === "ok", `write ${r.outcome} ${r.detail ?? ""}`);
    const after = e.helper.model.windows.get(windowId)?.nodes.get(node!.key);
    expect(after?.value === "A synthetic note", `the model holds ${JSON.stringify(after?.value)}`);
    e.host.link.grant({ type: "actRevoke", v: 1, taskId: "t-exec", at: Date.now() });
    return `window ${windowId}, key ${node!.key}, model value ${JSON.stringify(after?.value)}`;
  });

  await check("a navigation between walk and write is stale", async () => {
    s = await walk(e);
    grant(e, "t-nav");
    const t = target(s, "Email", "t-nav");
    const since = Date.now();
    await site.command({ cmd: "navigate", url: `${site.mainOrigin}/form2` });
    await site.waitForLoad((h) => h.endsWith("/form2"), since);
    const r = await run(e, { kind: "pageWrite", ...t, expect: "robin@example.test", value: "late@example.test" });
    expect(r.outcome === "stale", outcome(r));
    return outcome(r);
  });

  await check("Submit is a hand-off and /submitted reads 0", async () => {
    s = await walk(e);
    grant(e, "t-submit");
    const r = await run(e, { kind: "pagePress", ...target(s, "Submit", "t-submit") });
    expect(r.outcome === "handoff" && r.risk === "outbound", outcome(r));
    await sleep(500);
    const res = await fetch(`${site.mainOrigin}/submitted`);
    const count = ((await res.json()) as { count: number }).count;
    expect(count === 0, `/submitted reads ${count}`);
    return `${outcome(r)}, risk ${r.risk}; /submitted ${count}`;
  });
}

async function decoyCheck(e: Engine, site: FixtureSite): Promise<void> {
  await check("a frame hidden off screen is not vouched for by a visible sibling", async () => {
    const since = Date.now();
    await site.command({ cmd: "navigate", url: `${site.mainOrigin}/decoy` });
    await site.waitForLoad((h) => h.endsWith("/decoy"), since);
    let s = await walk(e);
    for (let i = 0; i < 20 && s.missing.length + s.frames.length < 3; i++) {
      await sleep(250);
      s = await walk(e);
    }
    const names = s.frames.flatMap((f) => f.controls.map((c) => c.name));
    expect(!names.includes("Offscreen frame field"), `the off-screen frame's field left it: ${JSON.stringify(names)}`);
    expect(s.missing.some((m) => m.reason.includes("more frames than visible iframes")), `missing ${JSON.stringify(s.missing)}`);
    return `frames kept ${s.frames.length}; missing ${JSON.stringify(s.missing)}`;
  });
}

// ---- batch 2 (W2) ----

/** The slow verbs (a combobox pick, an attach) wait for the page; they get the page link's longer timeout. */
async function runSlow(e: Engine, verb: PageVerb): Promise<PageResult> {
  return (await e.session.command(verb, 10_000)).result;
}

/** A fresh /form, walked once its React part is in. */
async function freshForm(e: Engine, site: FixtureSite): Promise<PageSnapshot> {
  const since = Date.now();
  await site.command({ cmd: "navigate", url: `${site.mainOrigin}/form` });
  await site.waitForLoad((h) => h.endsWith("/form"), since);
  let s = await walk(e);
  for (let i = 0; i < 40 && !s.frames.some((f) => f.controls.some((c) => c.name === "Country of residence")); i++) {
    await sleep(250);
    s = await walk(e);
  }
  return s;
}

async function attr(site: FixtureSite, selector: string, name: string): Promise<string | undefined> {
  return (await site.command({ cmd: "attr", selector, name })).value;
}
async function text(site: FixtureSite, selector: string): Promise<string | undefined> {
  return (await site.command({ cmd: "text", selector })).value;
}

/** The node the model holds for a page control, by its name. */
function nodeKey(e: Engine, name: string): string {
  const w = e.helper.model.windows.get(pageWindowId(e.session.info.engine, e.tabId));
  const hits = [...(w?.nodes.values() ?? [])].filter((n) => n.label === name);
  if (hits.length !== 1 || hits[0] === undefined) throw new Error(`${hits.length} nodes named '${name}' in the page window`);
  return hits[0].key;
}

async function batch2(e: Engine, site: FixtureSite, tmp: string, published: HelperMessage[]): Promise<void> {
  let s = await freshForm(e, site);
  grant(e, "t-b2");

  await check("react-select 'Country of residence' is set to United States, verified by chip, hidden input and aria-expanded=false", async () => {
    const r = await runSlow(e, { kind: "pageChooseOption", ...target(s, "Country of residence", "t-b2"), expect: "", value: "United States" });
    expect(r.outcome === "ok", `${outcome(r)} ${JSON.stringify(r.choice)}`);
    expect(r.choice?.flavor === "reactSelect" && r.choice.hiddenInput === "set" && r.choice.expanded === false, `choice ${JSON.stringify(r.choice)}`);
    expect(r.readings?.afterBlur === "United States", `readings ${JSON.stringify(r.readings)}`);
    // The same three, read by the page itself, and React's own state.
    const hidden = await read(site, 'input[name="rs_country"]');
    const expanded = await attr(site, "#rs-country", "aria-expanded");
    const chip = await text(site, '#react-form [class*="singleValue"]');
    expect(hidden === "us" && expanded === "false" && chip === "United States", `page: hidden ${hidden}, aria-expanded ${expanded}, chip ${chip}`);
    await stateHas(site, "country", "us");
    s = await walk(e);
    expect(control(s, "Country of residence").c.value === "United States", `the walk shows ${JSON.stringify(control(s, "Country of residence").c.value)}`);
    return `chip '${chip}', hidden input '${hidden}', aria-expanded ${expanded}, React country=${JSON.stringify(site.state?.country)}; choice ${JSON.stringify(r.choice)}`;
  });

  await check("a filter two options match stops, names both, and leaves the control as it was", async () => {
    const r = await runSlow(e, { kind: "pageChooseOption", ...target(s, "Country of residence", "t-b2"), expect: "United States", value: "United" });
    const m = r.choice?.matches ?? [];
    expect(r.outcome === "failed" && m.includes("United States") && m.includes("United States Minor Outlying Islands") && m.length === 2, `${outcome(r)} ${JSON.stringify(r.choice)}`);
    expect((r.detail ?? "").includes("'United States'") && (r.detail ?? "").includes("'United States Minor Outlying Islands'"), `detail ${r.detail}`);
    expect(r.readings?.afterBlur === "United States", `readings ${JSON.stringify(r.readings)}`);
    const hidden = await read(site, 'input[name="rs_country"]');
    const expanded = await attr(site, "#rs-country", "aria-expanded");
    const filter = await read(site, "#rs-country");
    expect(hidden === "us" && expanded === "false" && filter === "", `page after the stop: hidden ${hidden}, aria-expanded ${expanded}, filter '${filter}'`);
    await stateHas(site, "country", "us");
    return `${outcome(r)}; page unchanged (hidden ${hidden}, aria-expanded ${expanded}, filter empty)`;
  });

  await check("an ARIA combobox whose listbox is a portal is set by its option and verified", async () => {
    const r = await runSlow(e, { kind: "pageChooseOption", ...target(s, "Department", "t-b2"), expect: "", value: "Research" });
    expect(r.outcome === "ok" && r.choice?.flavor === "aria" && r.choice.expanded === false, `${outcome(r)} ${JSON.stringify(r.choice)}`);
    const v = await read(site, "#dept");
    expect(v === "Research", `#dept holds ${v}`);
    return `${outcome(r)}; #dept ${v}; choice ${JSON.stringify(r.choice)}`;
  });

  // A file this run owns: synthetic bytes, over 1 MB so the helper's line reaches the extension in pageChunk parts.
  const fileName = "Robin-Example-Resume.pdf";
  const filePath = join(tmp, fileName);
  writeFileSync(filePath, Buffer.concat([Buffer.from("%PDF-1.4\n% synthetic, made by accept.ts\n"), randomBytes(1_500_000)]));
  const fileSize = readFileSync(filePath).length;
  const windowId = pageWindowId(e.session.info.engine, e.tabId);
  const link = e.host.registry.engineFor(windowId) as PageEngineLink;
  const files = new ConfirmedFiles();

  await check("a file goes into the file input through DataTransfer: files[0] name and size, and the page shows its name", async () => {
    await link.run({ kind: "walk", pid: e.session.info.browser.pid, windowId });
    grant(e, "t-file");
    const c = files.confirm("t-file", filePath);
    expect("ok" in c, JSON.stringify(c));
    const a = await link.attachFile(windowId, nodeKey(e, "Resume"), "t-file", files);
    const at = a.page?.attached;
    expect(a.page?.outcome === "ok" && at?.via === "input" && at.file?.name === fileName && at.file.size === fileSize && at.shown, `${a.page === null ? a.verb.detail : outcome(a.page)} ${JSON.stringify(at)}`);
    const shown = await text(site, "#resume-name");
    expect(shown === `${fileName} (${fileSize} bytes)`, `the page shows '${shown}'`);
    return `files[0] ${at?.file?.name} ${at?.file?.size} bytes; page shows '${shown}'; the line carried ${Math.ceil((fileSize * 4) / 3)} base64 characters, over the 1 MiB frame cap`;
  });

  await check("the same file dropped on the dropzone: the page shows its name", async () => {
    grant(e, "t-drop");
    files.confirm("t-drop", filePath);
    const a = await link.attachFile(windowId, nodeKey(e, "Drop your resume here"), "t-drop", files);
    const at = a.page?.attached;
    expect(a.page?.outcome === "ok" && at?.via === "drop" && at.shown, `${a.page === null ? a.verb.detail : outcome(a.page)} ${JSON.stringify(at)}`);
    const dropped = await text(site, "#dropped");
    expect(dropped === fileName, `#dropped shows '${dropped}'`);
    return `dropzone shows '${dropped}'`;
  });

  await check("an attach with no confirmed file is refused before the engine is asked", async () => {
    grant(e, "t-unconfirmed");
    const before = await text(site, "#dropped");
    const a = await link.attachFile(windowId, nodeKey(e, "Drop your resume here"), "t-unconfirmed", files);
    expect(a.page === null && a.verb.outcome === "notAllowed", `${a.verb.outcome} ${a.verb.detail}`);
    expect((await text(site, "#dropped")) === before, "the dropzone changed");
    return `${a.verb.outcome}: ${a.verb.detail}`;
  });

  await check("a file is never dropped on a control that holds no file input of its own", async () => {
    grant(e, "t-notdz");
    files.confirm("t-notdz", filePath);
    const a = await link.attachFile(windowId, nodeKey(e, "Show more"), "t-notdz", files);
    expect(a.page?.outcome === "unsupported", `${a.page === null ? `${a.verb.outcome} ${a.verb.detail}` : outcome(a.page)}`);
    return outcome(a.page as PageResult);
  });

  await check("a page snapshot makes a fill proposal: focus in the page, the helper walks it and Jev (canned) fills Email from what you told Caret", async () => {
    e.helper.handleMemory({ type: "memoryRequest", v: 1, requestId: "w2-about", op: "add", kind: "about", fields: { label: "Email", value: "robin@example.test", source: "typed" } });
    // The reader would say the browser is frontmost; there is no reader here, so the run says it.
    e.helper.handleReader({ type: "appSwitch", v: 1, at: Date.now(), from: null, to: e.session.info.browser });
    const mark = published.length;
    const focused = await site.command({ cmd: "focus", selector: "#email" });
    let fill: HelperMessage | undefined;
    for (let i = 0; i < 40 && fill === undefined; i++) {
      await sleep(250);
      fill = published.slice(mark).find((m) => (m.type === "fillProposal" || m.type === "popup") && JSON.stringify(m).includes(windowId));
    }
    expect(fill !== undefined, `no fill offer for ${windowId} (page hasFocus ${focused.value}); published since: ${published.slice(mark).map((m) => m.type).join(", ") || "nothing"}`);
    expect(JSON.stringify(fill).includes("robin@example.test"), `the offer holds no robin@example.test: ${JSON.stringify(fill).slice(0, 400)}`);
    return `${fill?.type} for ${windowId} with robin@example.test (page hasFocus ${focused.value})`;
  });

  await check("the host hears the page engine state: connected for this browser, missing for a Chromium browser with none", async () => {
    const connected = published.find((m) => m.type === "pageEngine" && m.state === "connected" && m.browser.pid === e.session.info.browser.pid);
    expect(connected !== undefined, `no connected state for pid ${e.session.info.browser.pid}`);
    // A reader's view of another, engine-less Chrome being typed in (synthetic messages; no such process).
    const other = { pid: 999_999, bundleId: "com.google.Chrome", name: "Google Chrome" };
    const mark = published.length;
    e.helper.handleReader({ type: "appSwitch", v: 1, at: Date.now(), from: e.session.info.browser, to: other });
    e.helper.handleReader({ type: "focus", v: 1, at: Date.now(), app: other, windowId: "999999-1", key: null, role: "AXTextField", editable: true, empty: true, frontmost: true });
    const said = published.slice(mark).filter((m) => m.type === "pageEngine");
    e.helper.handleReader({ type: "appSwitch", v: 1, at: Date.now(), from: other, to: e.session.info.browser });
    expect(said.length === 1 && said[0]?.type === "pageEngine" && said[0].state === "missing" && said[0].browser.pid === 999_999, `said ${JSON.stringify(said)}`);
    return `connected for ${e.session.info.browser.bundleId}; missing for ${other.bundleId} (pid ${other.pid})`;
  });

  await check("Not on this site: nothing is walked or written there, focus there is not reported, and a frame of an off site is left out", async () => {
    s = await walk(e);
    const t = target(s, "First name", "t-off");
    grant(e, "t-off");
    e.host.registry.setSitesOff([site.mainOrigin]);
    const w = await e.session.command({ kind: "pageWalk", tabId: e.tabId });
    const r = await run(e, { kind: "pageWrite", ...t, expect: "", value: "Off site" });
    const last = e.session.tabs.get(e.tabId);
    await site.command({ cmd: "focus", selector: "#first_name" });
    await sleep(1000);
    const walkedSince = e.session.tabs.get(e.tabId) !== last;
    expect(w.result.outcome === "siteOff" && r.outcome === "siteOff" && !walkedSince, `walk ${outcome(w.result)}; write ${outcome(r)}; walked after focus: ${walkedSince}`);
    expect((await read(site, "#first_name")) === "", "the field changed");
    e.host.registry.setSitesOff([site.embedOrigin]);
    const part = await walk(e);
    const embed = part.frames.some((f) => f.origin === site.embedOrigin);
    expect(!embed && part.missing.some((m) => m.reason.includes("off on this site")), `embed frame kept: ${embed}; missing ${JSON.stringify(part.missing)}`);
    e.host.registry.setSitesOff([]);
    const back = await walk(e);
    expect(back.frames.some((f) => f.origin === site.embedOrigin), "the embed frame did not come back");
    return `walk ${w.result.outcome}, write ${r.outcome}, no walk after focus; embed frame left out while its origin was off, back after`;
  });
}

/**
 * The reader's AXManualAccessibility log (W2): caret-screen reads only this run's processes (--only-pids), headless
 * Chrome for Testing and, with --electron, a windowless Electron app; its log must show no attempt on the Chromium
 * browser and exactly one on Electron.
 */
async function readerCheck(chromePid: number, tmp: string): Promise<void> {
  await check(`the reader asks no Chromium browser for AXManualAccessibility${args.electron === undefined ? "" : ", and asks the Electron fixture once"}`, async () => {
    const pids = [chromePid];
    let electronPid: number | null = null;
    if (args.electron !== undefined) {
      const exe = join(args.electron, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
      expect(existsSync(exe), `no Electron at ${exe}`);
      const appDir = mkdtempSync(join(tmp, "electron-app-"));
      writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "caret-w2-electron", main: "main.cjs" }));
      // Windowless and out of the Dock: it never takes the front.
      writeFileSync(join(appDir, "main.cjs"), 'const { app } = require("electron");\napp.setActivationPolicy?.("accessory");\napp.whenReady().then(() => process.stdout.write(`caret-electron pid ${process.pid}\\n`));\nsetTimeout(() => app.quit(), 60000);\n');
      const { ELECTRON_RUN_AS_NODE: _asNode, ...env } = process.env;
      const proc = spawn(exe, [appDir, `--user-data-dir=${join(tmp, "electron-profile")}`], { env, stdio: ["ignore", "pipe", "pipe"] });
      undo.push({ what: `Electron pid ${proc.pid}`, fn: () => void proc.kill("SIGKILL") });
      electronPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the Electron fixture did not start within 15 s")), 15_000);
        proc.stdout?.setEncoding("utf8").on("data", (d: string) => {
          const m = /caret-electron pid (\d+)/.exec(d);
          if (m !== null) (clearTimeout(timer), resolve(Number(m[1])));
        });
      });
      expect(electronPid === proc.pid, `Electron said pid ${electronPid}, spawned ${proc.pid}`);
      pids.push(electronPid);
    }
    const deny = join(tmp, "deny-apps.txt");
    writeFileSync(deny, "");
    const log = join(tmp, "reader.log");
    const out = createWriteStream(log);
    const reader = spawn(READER, ["--shadow", "--socket", join(tmp, "s", "screen.sock"), "--deny-list", deny, "--only-pids", pids.join(","), "--background-interval", "5"], { stdio: ["ignore", "pipe", "pipe"] });
    reader.stdout?.pipe(out);
    reader.stderr?.pipe(out);
    undo.push({ what: `caret-screen pid ${reader.pid}`, fn: () => void reader.kill("SIGKILL") });
    await sleep(6000);
    reader.kill("SIGTERM");
    for (let i = 0; i < 30 && reader.exitCode === null && reader.signalCode === null; i++) await sleep(100);
    const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.includes("AXManualAccessibility") || l.includes("not trusted"));
    expect(!lines.some((l) => l.includes("not trusted")), `the reader lacks the Accessibility grant: ${lines.join(" | ")}`);
    const attempts = lines.filter((l) => /AXManualAccessibility on /.test(l));
    const skipped = lines.filter((l) => l.includes("AXManualAccessibility not attempted on Google Chrome for Testing"));
    expect(skipped.length === 1, `the reader did not see Chrome for Testing as a Chromium browser: ${lines.join(" | ") || "no lines"}`);
    expect(!attempts.some((l) => /Chrome|Chromium|Helium/.test(l)), `an attempt on a Chromium browser: ${attempts.join(" | ")}`);
    if (electronPid !== null) expect(attempts.length === 1 && (attempts[0] ?? "").includes("(electron)"), `Electron attempts: ${attempts.join(" | ") || "none"}`);
    else expect(attempts.length === 0, `attempts: ${attempts.join(" | ")}`);
    return lines.map((l) => l.replace(/^\[caret-screen\] /, "")).join(" | ");
  });
}

async function idleCheck(e: Engine, seconds: number): Promise<void> {
  await check(`an open Native Messaging port keeps the MV3 worker alive through ${seconds} s idle`, async () => {
    const hello = e.session.hello;
    expect(hello !== null, "no hello");
    const bridges = (): number[] => processTree(e.session.info.browser.pid).filter((p) => p.cmd.includes("caret-bridge")).map((p) => p.pid);
    const before = bridges();
    say(`idling ${seconds} s: no command, ping or page traffic to the engine (bridge pids ${before.join(",")})`);
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      if (e.session.closed) throw new Error(`the engine's connection closed after ${((Date.now() - (end - seconds * 1000)) / 1000).toFixed(0)} s idle`);
      await sleep(1000);
    }
    const pong = await e.session.ping();
    expect(pong !== null, "no pong");
    expect(pong!.instance === hello!.instance && pong!.startedAt === hello!.startedAt, `another worker answered: ${JSON.stringify(pong)} vs hello ${hello!.instance}`);
    expect(!e.session.closed, "the connection closed");
    const after = bridges();
    expect(after.join() === before.join(), `bridge pids changed: ${before.join(",")} -> ${after.join(",")}`);
    return `same worker instance ${pong!.instance} (started ${new Date(hello!.startedAt).toISOString()}), same connection and bridge pid ${after.join(",")} after ${seconds} s`;
  });
}

/** Physical footprint (bytes) of each pid, from macOS footprint: dirty and compressed memory, not RSS's shared pages. */
function footprints(pids: number[], tmp: string): Map<number, number> {
  const out = new Map<number, number>();
  if (pids.length === 0) return out;
  const file = join(tmp, "footprint.json");
  execFileSync("footprint", ["-j", file, ...pids.map(String)], { stdio: "ignore", timeout: 120_000 });
  const j = JSON.parse(readFileSync(file, "utf8")) as { processes: { pid: number; auxiliary?: { phys_footprint?: number }; footprint?: number }[] };
  for (const p of j.processes) out.set(p.pid, p.auxiliary?.phys_footprint ?? p.footprint ?? 0);
  rmSync(file, { force: true });
  return out;
}

/**
 * Renderer memory with `tabs` fixture tabs, three ways: no extension; the extension with its content script removed
 * (the cost of having any extension); the extension as built. The content script's own cost is the third minus the
 * second. Two rounds each, interleaved, so drift on a shared Mac shows up as spread.
 */
async function memory(exe: string, site: FixtureSite, tabs: number, tmp: string): Promise<void> {
  type Reading = { tabs: number; renderers: number; rssKiB: number; footprintKiB: number; extensionKiB: number };
  const noScript = join(tmp, "ext-no-content-script");
  execFileSync("cp", ["-R", join(EXT, "dist"), noScript]);
  const m = JSON.parse(readFileSync(join(noScript, "manifest.json"), "utf8")) as Record<string, unknown>;
  delete m.content_scripts;
  writeFileSync(join(noScript, "manifest.json"), JSON.stringify(m));
  const configs: [string, string | null][] = [["none", null], ["noScript", noScript], ["full", join(EXT, "dist")]];
  const measure = async (extension: string | null): Promise<Reading> => {
    const profile = mkdtempSync(join(tmp, "mem-"));
    site.tabsLoaded = 0;
    // Headless Chrome takes one URL; the opener page opens the tabs (noopener, so each is its own browsing context group).
    const c = launch(exe, profile, [`${site.mainOrigin}/opener?n=${tabs}`], process.env, extension, join(tmp, "chrome-memory.log"), ["--disable-popup-blocking"]);
    for (let i = 0; i < 120 && site.tabsLoaded < tabs; i++) await sleep(250);
    // Let the pages and the content scripts settle, then read every process in the browser's tree.
    await sleep(15_000);
    const pid = c.proc.pid as number;
    if (c.proc.exitCode !== null) throw new Error(`Chrome for Testing exited early (${c.proc.exitCode}); log tail: ${tail(join(tmp, "chrome-memory.log"))}`);
    const tree = processTree(pid);
    const renderers = tree.filter((p) => p.cmd.includes("--type=renderer") && !p.cmd.includes("--extension-process"));
    const ext = tree.filter((p) => p.cmd.includes("--extension-process"));
    const fp = footprints([...renderers, ...ext].map((p) => p.pid), tmp);
    const out = {
      tabs: site.tabsLoaded,
      renderers: renderers.length,
      rssKiB: renderers.reduce((n, p) => n + p.rss, 0),
      footprintKiB: renderers.reduce((n, p) => n + (fp.get(p.pid) ?? 0), 0) / 1024,
      extensionKiB: ext.reduce((n, p) => n + (fp.get(p.pid) ?? 0), 0) / 1024,
    };
    await c.stop();
    rmSync(profile, { recursive: true, force: true });
    return out;
  };
  await check(`content-script memory with ${tabs} tabs`, async () => {
    const runs = new Map<string, Reading[]>(configs.map(([k]) => [k, []]));
    for (let round = 0; round < 2; round++) for (const [k, dir] of configs) runs.get(k)?.push(await measure(dir));
    for (const rs of runs.values()) for (const r of rs) expect(r.tabs >= tabs, `only ${r.tabs} of ${tabs} tabs loaded`);
    const mean = (k: string, f: keyof Reading): number => {
      const rs = runs.get(k) ?? [];
      return rs.reduce((n, r) => n + r[f], 0) / rs.length;
    };
    const mib = (kib: number): string => (kib / 1024).toFixed(0);
    const each = (k: string): string => (runs.get(k) ?? []).map((r) => `${mib(r.footprintKiB)}`).join("/");
    const scriptPerTab = (mean("full", "footprintKiB") - mean("noScript", "footprintKiB")) / tabs;
    const extensionPerTab = (mean("noScript", "footprintKiB") - mean("none", "footprintKiB")) / tabs;
    const rssPerTab = (mean("full", "rssKiB") - mean("noScript", "rssKiB")) / tabs;
    return `renderer footprint MiB per round: none ${each("none")}, extension without content script ${each("noScript")}, full ${each("full")} (${runs.get("full")?.[0]?.renderers} renderers); content script ${scriptPerTab.toFixed(0)} KiB per tab (rss ${rssPerTab.toFixed(0)}); any extension ${extensionPerTab.toFixed(0)} KiB per tab; extension process ${mib(mean("full", "extensionKiB"))} MiB`;
  });
}

async function main(): Promise<number> {
  preflight();
  build();
  const exe = await chrome();
  const extensionId = readFileSync(join(EXT, "EXTENSION_ID"), "utf8").trim();
  const front0 = frontmost();

  const tmp = mkdtempSync(join(tmpdir(), "caret-w2-"));
  undo.push({ what: `temporary directory ${tmp}`, fn: () => rmSync(tmp, { recursive: true, force: true }) });
  const log = join(tmp, "chrome.log");

  const site = new FixtureSite();
  await site.start();
  undo.push({ what: "fixture site", fn: () => site.stop() });
  say(`fixture site ${site.mainOrigin}, embed ${site.embedOrigin}`);

  const memTabs = Number(args["memory-tabs"]);
  if (memTabs > 0) {
    await memory(exe, site, memTabs, tmp);
    return report(front0);
  }

  // The helper, in fixture mode: page.sock in a private temporary directory, Jev answered by a canned function.
  const sockDir = join(tmp, "s");
  mkdirSync(sockDir, { mode: 0o700 });
  const sockPath = join(sockDir, "page.sock");
  let jevCalls = 0;
  // Canned Jev: picks the About email batch 2 adds wherever a question offers it, says such a field is the user's,
  // and answers none to everything else.
  const askJev: AskJev = async (req) => {
    jevCalls++;
    const answers = Object.fromEntries(
      Object.entries(req.questions).map(([k, q]) => {
        if (k.endsWith("_whose")) return [k, { choice: "user", confidence: 0.95 }];
        const pick = Object.entries(q.criteria).find(([, t]) => t?.includes('"robin@example.test"'))?.[0];
        return [k, pick === undefined ? { choice: "none", confidence: 0.9 } : { choice: pick, confidence: 0.95 }];
      }),
    );
    return { model: "canned", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };
  const warnings: string[] = [];
  const warn = (l: string): void => void warnings.push(l);
  const noReader: ReaderLink = { run: async () => ({ type: "verbResult", v: 1, id: "none", at: Date.now(), outcome: "noWindow", detail: "no reader in fixture mode" }) };
  const store = new Store(join(tmp, "data"));
  // Assigned right below; the host needs a way to reach it before it exists.
  let helper: Helper;
  const host = pageHost({ path: sockPath, reader: noReader, apply: (m) => void helper.handleReader(m), warn });
  const published: HelperMessage[] = [];
  helper = new Helper({ store, askJev, shadow: false, allowBackgroundFocus: false, readerLink: host.link, pageCovers: (pid) => host.registry.forBrowser(pid) !== undefined, calendar: null, publish: (m) => void published.push(m), warn });
  wirePageEngines({ host, helper, publish: (m) => void published.push(m), warn });
  await host.server.listen();
  undo.push({
    what: "helper",
    fn: async () => {
      await host.server.close();
      helper.shutdown();
      helper.memory.close();
      store.close();
    },
  });
  const env = { ...process.env, CARET_PAGE_SOCKET: sockPath };
  const url = `${site.mainOrigin}/form`;

  /** Puts the manifest in `nmDir` only, launches on `profile`, and waits for this launch's engine. */
  const connect = async (nmDir: string, waitMs: number, profile: string): Promise<{ session: EngineSession | null; stop: () => Promise<void> }> => {
    writeManifest(nmDir, extensionId);
    const manifest = join(nmDir, `${HOST_NAME}.json`);
    const removeManifest = async (): Promise<void> => {
      const u = undo.findIndex((x) => x.what === manifest);
      if (u >= 0) await undo.splice(u, 1)[0]?.fn();
    };
    const since = Date.now();
    const c = launch(exe, profile, [url], env, join(EXT, "dist"), log);
    const stop = async (): Promise<void> => {
      await c.stop();
      await removeManifest();
    };
    try {
      return { session: await host.registry.waitForEngine((s) => s.info.extensionId === extensionId && s.info.connectedAt >= since, waitMs), stop };
    } catch {
      await stop();
      return { session: null, stop };
    }
  };

  // Hypothesis 1: each directory alone, each on its own fresh profile and browser.
  const nmProbe: Record<string, boolean> = {};
  if (args["nm-probe"]) {
    for (const [label, dir] of [["--user-data-dir/NativeMessagingHosts", (p: string) => join(p, "NativeMessagingHosts")], [CFT_NM_DIR.replace(homedir(), "~"), () => CFT_NM_DIR]] as const) {
      const profile = mkdtempSync(join(tmp, "probe-"));
      say(`hypothesis 1: manifest only in ${label}`);
      const r = await connect(dir(profile), 20_000, profile);
      nmProbe[label] = r.session !== null;
      say(`hypothesis 1: ${label} ${r.session === null ? "not read" : "read"}`);
      await r.stop();
    }
  }
  // The checks run with the manifest in the temporary profile, which goes away with it.
  const profile = join(tmp, "profile");
  const { session } = await connect(join(profile, "NativeMessagingHosts"), 30_000, profile);
  if (session === null) {
    results.push({ name: "the engine says hello", pass: false, ms: 0, detail: `no engine within the wait; Chrome log tail: ${tail(log)}` });
    return report(front0, { nmProbe, warnings });
  }
  results.push({ name: "the engine says hello", pass: true, ms: Date.now() - session.info.connectedAt, detail: `engine ${session.info.engine}, browser ${session.info.browser.bundleId} pid ${session.info.browser.pid}, worker ${session.hello?.instance}` });
  say(`engine ${session.info.engine} from ${session.info.browser.name} (${session.info.browser.bundleId}, pid ${session.info.browser.pid})`);

  await site.waitForLoad((h) => h.endsWith("/form"), 0);
  // The first walk may come before the frames' scripts are in; try for up to 10 s.
  let first = await session.command({ kind: "pageWalk", tabId: null });
  for (let i = 0; i < 40 && (first.snapshot === null || first.snapshot.frames.length < 4); i++) {
    await sleep(250);
    first = await session.command({ kind: "pageWalk", tabId: null });
  }
  if (first.snapshot === null) {
    results.push({ name: "the active tab can be walked", pass: false, ms: 0, detail: outcome(first.result) });
    return report(front0, { nmProbe, warnings });
  }
  const e: Engine = { host, helper, session, tabId: first.snapshot.tabId };
  if (args["dump-walk"]) {
    say(JSON.stringify({ frames: first.snapshot.frames.map((f) => ({ frameId: f.frameId, parent: f.parentFrameId, origin: f.origin, path: f.path, iframes: f.iframes, controls: f.controls.length })), missing: first.snapshot.missing }));
    return report(front0);
  }
  // React mounts after the bundle runs; give the walk a form with its React part in place.
  for (let i = 0; i < 40 && !(await walk(e)).frames.some((f) => f.controls.some((c) => c.name === "Country of residence")); i++) await sleep(250);

  await checks(e, site);
  await batch2(e, site, tmp, published);
  await decoyCheck(e, site);
  if (!args["no-reader"]) await readerCheck(session.info.browser.pid, tmp);
  await check("/submitted still reads 0 after every batch 2 check", async () => {
    const count = ((await (await fetch(`${site.mainOrigin}/submitted`)).json()) as { count: number }).count;
    expect(count === 0, `/submitted reads ${count}`);
    return `/submitted ${count}`;
  });
  const idle = Number(args.idle);
  if (idle > 0) await idleCheck(e, idle);
  if (frontmost() !== front0 && /Chrome for Testing/.test(frontmost())) results.push({ name: "Chrome for Testing never took the front", pass: false, ms: 0, detail: frontmost() });
  return report(front0, { nmProbe, warnings, jevCalls, engineHello: session.hello, pageEngine: published.filter((m) => m.type === "pageEngine") });
}

function tail(file: string): string {
  try {
    return readFileSync(file, "utf8").split("\n").slice(-15).join(" | ");
  } catch {
    return "(no log)";
  }
}

function report(front0: string, extra: Record<string, unknown> = {}): number {
  const passed = results.filter((r) => r.pass).length;
  say(`${passed} of ${results.length} checks passed; front app before ${front0}, after ${frontmost()}`);
  mkdirSync(args.evidence, { recursive: true });
  const name = `accept-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(join(args.evidence, name), `${JSON.stringify({ at: new Date().toISOString(), cft: CFT_BUILD, args, results, ...extra }, null, 2)}\n`);
  say(`evidence ${join(args.evidence, name)}`);
  return passed === results.length && results.length > 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  say(`run failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
} finally {
  await cleanup();
  const leftovers = [join(CFT_NM_DIR, `${HOST_NAME}.json`)].filter((f) => existsSync(f));
  if (leftovers.length > 0) say(`left behind: ${leftovers.join(", ")}`);
  say(`cleaned up; exit ${code}`);
}
process.exit(code);

