// Records how the reader sees the B24 real-form corpus (fixtures/realfill): every form and mail page in a
// Chrome started with a temporary profile and served from 127.0.0.1, and every note in a TextEdit started
// by direct exec. The reader runs with --only-pids on those two processes, so nothing else is read. The
// result is one full snapshot per window, written to --out as NDJSON, which scripts/realfill-eval.ts
// replays without a reader, windows or the GUI gate.
//
//   node scripts/realfill-capture.ts --bin ../apps/screen-reader/.build/debug --out FILE [--corpus DIR]
//
// It opens windows, so the caller holds gui.lock and passes the GUI gates first (evidence/screen/b24/gui.sh).
// It posts no input. It stops, closes everything it started and exits 3 as soon as HID idle drops under
// 5 s, since then someone is using the Mac. Only processes it started are signalled; its temporary
// directories are deleted at the end.
import { writeStore } from "../src/privacy/send.ts";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { PROTOCOL_VERSION, type Snapshot } from "../src/protocol.ts";
import type { WindowState } from "../src/model.ts";
import { Cdp } from "./cdp.ts";
import { loadCorpus, mailHtml, noteTitle, type Corpus } from "./realfill-corpus.ts";

const run = promisify(execFile);
const { values: a } = parseArgs({
  options: {
    bin: { type: "string" },
    out: { type: "string" },
    corpus: { type: "string", default: join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/realfill") },
    "settle-ms": { type: "string", default: "45000" },
    /** experiments/ax-probe built at this path: its tree of the probe page and of a note goes next to --out. */
    probe: { type: "string" },
  },
});
if (a.bin === undefined || a.out === undefined) throw new Error("--bin and --out are required");
const BIN = resolve(a.bin);
const OUT = resolve(a.out);
const CORPUS_DIR = resolve(a.corpus);
const corpus: Corpus = loadCorpus(CORPUS_DIR);
const TEXTEDIT = "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// MARK: - processes and folders this script started, and only those

const own = new Map<number, ChildProcess>();
const tempDirs: string[] = [];
function started(label: string, proc: ChildProcess): number {
  const pid = proc.pid;
  if (pid === undefined || pid <= 1) throw new Error(`${label} did not start`);
  own.set(pid, proc);
  if (aborted !== null) {
    proc.kill("SIGTERM");
    throw new Aborted(aborted);
  }
  return pid;
}
const alive = (pid: number): boolean => {
  const st = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return st !== "" && !st.startsWith("Z");
};
function cleanup(): void {
  for (const p of own.values()) if (p.exitCode === null && p.signalCode === null) p.kill("SIGTERM");
  const deadline = Date.now() + 10_000;
  for (const [pid, p] of own) {
    if (p.exitCode !== null || p.signalCode !== null) continue;
    while (alive(pid) && Date.now() < deadline) spawnSync("/bin/sleep", ["0.2"]);
    if (alive(pid)) p.kill("SIGKILL");
  }
  own.clear();
  for (const d of tempDirs.splice(0)) {
    // Chrome's helper processes name the profile in their arguments; compared as text.
    const left = spawnSync("/bin/ps", ["-axo", "pid=,args="], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((l) => l.includes(`--user-data-dir=${d}`))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((p) => p > 1);
    for (const p of left) {
      try {
        process.kill(p, "SIGTERM");
      } catch {
        // already gone
      }
    }
    const until = Date.now() + 5000;
    while (left.some(alive) && Date.now() < until) spawnSync("/bin/sleep", ["0.2"]);
    if (!left.some(alive)) rmSync(d, { recursive: true, force: true });
    else process.stderr.write(`kept ${d}: a process using it did not exit\n`);
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
class Aborted extends Error {}
process.on("uncaughtException", (e) => {
  process.stderr.write(`realfill-capture: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(e instanceof Aborted ? 3 : 1);
});

// MARK: - the GUI gate while running: stop as soon as someone uses the Mac (this script posts no input)

let aborted: string | null = null;
const idleWatch = setInterval(() => {
  void run("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"]).then(
    ({ stdout }) => {
      const m = /"HIDIdleTime" = (\d+)/.exec(stdout);
      const s = m?.[1] === undefined ? 0 : Number(m[1]) / 1e9;
      if (s < 5 && aborted === null) {
        aborted = `HID idle dropped to ${s.toFixed(1)} s`;
        cleanup();
        process.stderr.write(`deferred: user active (${aborted})\n`);
        process.exit(3);
      }
    },
    () => {
      aborted = "cannot read HID idle";
      cleanup();
      process.exit(3);
    },
  );
}, 1000);
const check = (): void => {
  if (aborted !== null) throw new Aborted(aborted);
};

// MARK: - the pages, on 127.0.0.1 only

const pages = new Map<string, string>();
for (const f of corpus.forms) pages.set(`/forms/${basename(f.file)}`, readFileSync(join(CORPUS_DIR, f.file), "utf8"));
const mails = [...corpus.forms.map((f) => f.source), ...corpus.decoys].filter((s) => s.kind === "mail");
// A page with one control of each kind the field model needs, for ax-probe's raw tree (what Chrome exposes, and what is settable).
pages.set("/probe.html", `<!doctype html><html><head><title>Caret control probe</title></head><body><form>
<label for=s>Degree</label><select id=s><option value="">Select...</option><option>Bachelor's Degree</option><option>Master's Degree</option></select>
<label for=d>Start date</label><input type=date id=d>
<label for=t>Start time</label><input type=time id=t>
<fieldset><legend>Size</legend><label><input type=radio name=z> Small</label><label><input type=radio name=z> Large</label></fieldset>
<label><input type=checkbox id=c> Text me</label></form></body></html>`);
for (const m of mails) pages.set(`/mail/${basename(m.file, ".mail.json")}`, mailHtml(JSON.parse(readFileSync(join(CORPUS_DIR, m.file), "utf8"))));
const http = createServer((req, res) => {
  const body = pages.get((req.url ?? "").split("?")[0] ?? "");
  if (body === undefined) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

// MARK: - helper in process (shadow: it holds the screen model and never calls Jev)

const storeDir = mkdtempSync(join(tmpdir(), "caret-realfill-store-"));
tempDirs.push(storeDir);
const sockDir = mkdtempSync(join(tmpdir(), "caret-realfill-sock-"));
tempDirs.push(sockDir);
const SOCKET = join(sockDir, "s.sock");
let server: HelperServer | null = null;
const helper = new Helper({
  store: new Store(storeDir),
  askJev: () => Promise.reject(new Error("the capture asks Jev nothing")),
  shadow: true,
  allowBackgroundFocus: false,
  publish: (m) => server?.publish(m),
  sendToReader: (m) => server?.sendToReader(m) ?? false,
});
server = new HelperServer(SOCKET, () => helper, (l) => process.stderr.write(`helper: ${l}\n`));
await server.listen();
const tick = setInterval(() => helper.tick(), 250);

// MARK: - the apps

// TextEdit is sandboxed and opens a file named on its command line only from inside its own container, so
// the notes are copied to a folder of this run's own under the container's tmp, deleted at the end.
const teTmp = join(homedir(), "Library/Containers/com.apple.TextEdit/Data/tmp");
if (!existsSync(teTmp)) throw new Error(`${teTmp} does not exist; start TextEdit once by hand first`);
const notesDir = mkdtempSync(join(teTmp, "caret-realfill-notes-"));
tempDirs.push(notesDir);
const notes = [...corpus.forms.map((f) => f.source), ...corpus.decoys].filter((s) => s.kind === "note");
const notePaths = [...new Set(notes.map((n) => n.file))].map((file) => {
  const p = join(notesDir, noteTitle(file));
  copyFileSync(join(CORPUS_DIR, file), p);
  return p;
});
check();
const te = spawn(TEXTEDIT, ["-ApplePersistenceIgnoreState", "YES", "-NSQuitAlwaysKeepsWindows", "NO", ...notePaths], { stdio: "ignore" });
const tePid = started("TextEdit", te);

const profile = mkdtempSync(join(tmpdir(), "caret-realfill-chrome-"));
tempDirs.push(profile);
const urls = [...corpus.forms.map((f) => `${base}/forms/${basename(f.file)}`), ...mails.map((m) => `${base}/mail/${basename(m.file, ".mail.json")}`)];
const uniqueUrls = [...new Set(urls), ...(a.probe === undefined ? [] : [`${base}/probe.html`])];
check();
const chrome = spawn(
  CHROME,
  [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-extensions", "--disable-background-networking", "--remote-debugging-port=0", "--new-window", uniqueUrls[0] as string],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const chromePid = started("Chrome", chrome);
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms: number): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    check();
    if (await ok()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const portFile = join(profile, "DevToolsActivePort");
await until("Chrome's DevTools port", () => existsSync(portFile), 30_000);
const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
for (const u of uniqueUrls.slice(1)) {
  check();
  await cdp.send("Target.createTarget", { url: u, newWindow: true });
  await sleep(300);
}

check();
const record = join(sockDir, "reader.ndjson");
const reader = spawn(join(BIN, "caret-screen"), ["--socket", SOCKET, "--only-pids", `${chromePid},${tePid}`, "--event-pids", `${chromePid},${tePid}`, "--background-interval", "5", "--record", record], { stdio: ["ignore", "ignore", "pipe"] });
started("reader", reader);
let readerLog = "";
reader.stderr?.setEncoding("utf8");
reader.stderr?.on("data", (d: string) => (readerLog += d));

// Every corpus window is in the model with every field label it should show, or the settle time runs out.
const titles = (): string[] => [...helper.model.windows.values()].map((w) => w.window.title);
const ready = (): boolean => {
  const ts = titles();
  return corpus.forms.every((f) => ts.some((t) => t.startsWith(f.title))) && notePaths.every((p) => ts.some((t) => t.startsWith(basename(p)))) && mails.every((m) => ts.some((t) => t.startsWith(m.title ?? "")));
};
const settle = Number(a["settle-ms"]);
await until("every corpus window", ready, settle).catch((e: unknown) => process.stderr.write(`${String(e)}; windows seen: ${JSON.stringify(titles())}\n`));
// Chrome builds a page's web tree some time after the first read; one more background round after that.
await sleep(12_000);
check();

// MARK: - one full snapshot per window, as the model holds it now

const snapshotOf = (w: WindowState, seq: number): Snapshot => ({
  type: "snapshot",
  v: PROTOCOL_VERSION,
  seq,
  at: w.updatedAt,
  reason: "initial",
  app: w.app,
  window: w.window,
  focused: false,
  root: null,
  nodes: [...w.nodes.values()],
  values: w.values,
  focusedKey: null,
  stats: { walkMs: 0, visited: w.nodes.size, truncated: false },
});
const out = [...helper.model.windows.values()]
  .filter((w) => w.app.pid === chromePid || w.app.pid === tePid)
  .map((w, i) => snapshotOf(w, i + 1))
  // The served port changes from run to run; the replay names pages by path.
  .map((s) => JSON.parse(JSON.stringify(s).replaceAll(base, "http://127.0.0.1:8765")) as Snapshot);
mkdirSync(dirname(OUT), { recursive: true });
writeStore(OUT, out.map((s) => JSON.stringify(s)).join("\n") + "\n");
process.stderr.write(`wrote ${out.length} windows to ${OUT}: ${JSON.stringify(out.map((s) => `${s.window.title} (${s.nodes.length} nodes)`))}\n`);
if (readerLog.trim() !== "") writeStore(`${OUT}.reader.log`, readerLog);
if (a.probe !== undefined) {
  for (const [pid, title, name] of [[chromePid, "Caret control probe", "probe-chrome"], [tePid, noteTitle(notes[0]?.file ?? ""), "probe-textedit"]] as const) {
    const r = spawnSync(resolve(a.probe), ["tree", String(pid), title], { encoding: "utf8", timeout: 30_000 });
    writeStore(`${OUT}.${name}.json`, r.stdout || r.stderr);
  }
}
clearInterval(idleWatch);
clearInterval(tick);
cdp.close();
await server.close();
http.close();
cleanup();
process.exit(0);
