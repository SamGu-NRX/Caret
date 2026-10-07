// The acceptance rig, shared by accept.ts and page-loop-eval.ts: pinned headless Chrome for Testing on a temporary
// profile, the bridge's Native Messaging manifest (never a real browser's directory), signed copies of the bridge and
// its test host, the test host as a temporary launchd job, a DevTools pipe to the run's own browser, and the cleanup
// registry that undoes all of it. Moved here from accept.ts unchanged, except that it logs through setSay.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, computeExecutablePath, detectBrowserPlatform, install } from "@puppeteer/browsers";

const HERE = fileURLToPath(new URL(".", import.meta.url));
let say = (_: string): void => {};
/** Where the rig's own lines go (the disk check, the browser it installed, a failed cleanup). */
export function setSay(f: (s: string) => void): void {
  say = f;
}

/** Chrome for Testing stable on 2026-10-04 (resolveBuildId "stable"); pinned so every run tests the same browser. */
export const CFT_BUILD = "154.0.8037.92";
export const CACHE = join(HERE, ".browsers");
export const HOST_NAME = "ai.caret.bridge";
export const SUPPORT = join(homedir(), "Library", "Application Support");
/** Chrome for Testing's default user-data directory's NativeMessagingHosts: not Sam's Chrome profile. */
export const CFT_NM_DIR = join(SUPPORT, "Google", "Chrome for Testing", "NativeMessagingHosts");
/** Directories this run must never write (brief W1 rules). */
export const FORBIDDEN_NM = [join(SUPPORT, "Google", "Chrome", "NativeMessagingHosts"), join(SUPPORT, "net.imput.helium", "NativeMessagingHosts"), join(SUPPORT, "Chromium", "NativeMessagingHosts")];

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- caret-heavy custody (ops/heavy, branch ops/heavy-queue) ----
// Under a caret-heavy job, the job's recovery owner must know every launchd job and Chrome's process group before
// they start, so that a cleanup which outlives this process (the supervisor's, or the recovery owner's after the
// supervisor died) stops them by exact label and verified identity. Outside caret-heavy these variables are unset and
// nothing here changes.
/** "<python> <flags> <register.py>": the job's registration command (supervise.py; its paths hold no spaces). */
const REGISTER = process.env.CARET_HEAVY_REGISTER;
/** Every launchd label this job starts must begin with it. */
export const LAUNCHD_PREFIX = process.env.CARET_HEAVY_LAUNCHD_PREFIX;

/** Registers a resource with the recovery owner and returns once it is journalled; throws if it was refused. */
function register(kind: "launchd" | "group", value: string): void {
  if (REGISTER === undefined) return;
  const [cmd, ...args] = REGISTER.split(" ");
  if (cmd === undefined) throw new Error("CARET_HEAVY_REGISTER is empty");
  execFileSync(cmd, [...args, kind, value], { stdio: ["ignore", "ignore", "pipe"] });
}

/** Members of process group `pgid`: a list, or null when pgrep failed for any reason but "none". */
function groupMembers(pgid: number): number[] | null {
  try {
    return execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" }).split("\n").filter((x) => x !== "").map(Number);
  } catch (e) {
    return (e as { status?: number }).status === 1 ? [] : null;
  }
}

/**
 * Every process of one Chrome launch carries this variable, set to the launch's random nonce: Chrome's helpers inherit
 * its environment. groupStop signals only what it has just proved is the launch's own: the leader by its pid, start time
 * and marker, or a member by its marker. A group id alone proves nothing once the group may have emptied (I4 review).
 */
const OWNER_VAR = "CARET_RIG_CHROME_OWNER";
const owners = new WeakMap<ChildProcess, { nonce: string; start: string | undefined }>();

/** A process as `ps` shows it: its start time and whether its environment entries hold the marker. */
type Seen = { start: string; marked: boolean } | "gone" | "unknown";

/**
 * Reads `pid` twice, without and with its environment (`ps -E` appends the environment to the arguments), so the
 * marker is looked for in the environment entries alone. "gone": no such process. "unknown": `ps` failed otherwise,
 * or the two reads disagree (the pid changed hands, or its arguments changed, between them).
 */
function inspect(pid: number, nonce: string): Seen {
  const read = (env: boolean): string | "gone" | "unknown" => {
    try {
      return execFileSync("ps", [env ? "-wwE" : "-ww", "-o", "lstart=,command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\n$/, "");
    } catch (e) {
      const { status, stdout } = e as { status?: number; stdout?: string };
      return status === 1 && !stdout ? "gone" : "unknown";
    }
  };
  const plain = read(false);
  if (plain === "gone" || plain === "unknown") return plain;
  const withEnv = read(true);
  if (withEnv === "gone") return "gone";
  if (withEnv === "unknown" || !withEnv.startsWith(plain)) return "unknown";
  // lstart is the first 24 characters ("Wed Oct  7 13:55:12 2026").
  return { start: plain.slice(0, 24), marked: new RegExp(`(^|\\s)${OWNER_VAR}=${nonce}(\\s|$)`).test(withEnv.slice(plain.length)) };
}

// ---- cleanup registry: everything this run creates is undone here, in reverse order ----
export const undo: { what: string; fn: () => Promise<void> | void }[] = [];
export async function cleanup(): Promise<void> {
  for (const u of undo.splice(0).reverse()) {
    try {
      await u.fn();
    } catch (e) {
      say(`cleanup of ${u.what} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export function preflight(): void {
  const freeGiB = Number(execFileSync("df", ["-k", "/"], { encoding: "utf8" }).trim().split("\n")[1]?.split(/\s+/)[3]) / 1048576;
  if (!(freeGiB >= 8)) throw new Error(`blocked: disk (${freeGiB.toFixed(1)} GiB free, the floor is 8)`);
  say(`disk ${freeGiB.toFixed(1)} GiB free`);
  for (const f of FORBIDDEN_NM) if (CFT_NM_DIR === f) throw new Error("refusing: the manifest directory is a real browser's");
}

export async function chrome(): Promise<string> {
  const platform = detectBrowserPlatform();
  if (platform === undefined) throw new Error("cannot detect the platform for Chrome for Testing");
  const installed = await install({ browser: Browser.CHROME, buildId: CFT_BUILD, cacheDir: CACHE, platform });
  const exe = computeExecutablePath({ browser: Browser.CHROME, buildId: CFT_BUILD, cacheDir: CACHE, platform });
  say(`Chrome for Testing ${CFT_BUILD} at ${installed.path}`);
  return exe;
}

/** Writes the manifest for `bridge` into `dir`, creating what is missing, and registers its removal. */
export function writeManifest(dir: string, extensionId: string, bridge: string): void {
  if (FORBIDDEN_NM.includes(dir)) throw new Error(`refusing to write ${dir}`);
  const created: string[] = [];
  for (let d = dir; !existsSync(d); d = join(d, "..")) created.unshift(d);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${HOST_NAME}.json`);
  if (existsSync(file)) throw new Error(`${file} already exists; not overwriting something this run did not write`);
  writeFileSync(file, `${JSON.stringify({ name: HOST_NAME, description: "Caret page bridge (acceptance)", path: bridge, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2)}\n`);
  undo.push({
    what: file,
    fn: () => {
      rmSync(file, { force: true });
      for (const d of created.reverse()) if (existsSync(d) && readdirSync(d).length === 0) rmdirSync(d);
    },
  });
}

/**
 * Copies `bin` to `dest` and signs it as `identifier` with `identity` (a certificate SHA-1, or "-" for ad hoc), with
 * the hardened runtime so no library can be injected into it. Returns `dest`.
 */
export function signedCopy(bin: string, dest: string, identifier: string, identity: string): string {
  copyFileSync(bin, dest);
  execFileSync("codesign", ["--force", "--sign", identity, "--identifier", identifier, "--options", "runtime", "--timestamp=none", dest], { stdio: "pipe" });
  return dest;
}

/** `codesign -d -r-`'s designated requirement of a signed path. */
export function designated(path: string): string {
  const out = execFileSync("codesign", ["-d", "-r-", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const m = /designated => (.*)/.exec(out);
  if (m?.[1] === undefined) throw new Error(`no designated requirement for ${path}`);
  return m[1].trim();
}

const xml = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Starts `program` as a temporary launchd job in this user's GUI domain that owns Mach service `service`, from a plist
 * in this run's private directory; it is booted out at cleanup. Resolves once its log says it is listening.
 */
export async function launchdJob(dir: string, label: string, service: string, program: string[], log: string, env: Record<string, string> = {}): Promise<void> {
  if (LAUNCHD_PREFIX !== undefined && !label.startsWith(LAUNCHD_PREFIX)) throw new Error(`launchd label ${label} is not under this job's prefix ${LAUNCHD_PREFIX}`);
  const plist = join(dir, `${label}.plist`);
  const envXml = Object.keys(env).length === 0 ? "" : `<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("")}</dict>\n`;
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${program.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
<key>MachServices</key><dict><key>${xml(service)}</key><true/></dict>
<key>RunAtLoad</key><true/>
<key>StandardErrorPath</key><string>${xml(log)}</string>
${envXml}</dict></plist>
`, { mode: 0o600 });
  const domain = `gui/${process.getuid?.() ?? 501}`;
  register("launchd", label);  // before bootstrap: once the recovery owner journals it, it can boot it out
  execFileSync("launchctl", ["bootstrap", domain, plist], { stdio: "pipe" });
  undo.push({
    what: `launchd job ${label}`,
    fn: () => {
      try {
        execFileSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
      } catch {
        /* already gone */
      }
    },
  });
  for (let i = 0; i < 100; i++) {
    if (existsSync(log) && readFileSync(log, "utf8").includes("listening on")) return;
    await sleep(100);
  }
  throw new Error(`the launchd job ${label} did not start listening: ${tail(log)}`);
}

export interface Running {
  proc: ChildProcess;
  stop: () => Promise<void>;
  /** The DevTools pipe, when launched with one. */
  cdp: Cdp | null;
}

/** The Chrome DevTools Protocol over --remote-debugging-pipe: requests on fd 3, answers on fd 4, each NUL-terminated. */
export class Cdp {
  private next = 1;
  private buf = "";
  private readonly pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private readonly out: Writable;
  constructor(out: Writable, inp: Readable) {
    this.out = out;
    inp.setEncoding("utf8");
    inp.on("data", (d: string) => {
      this.buf += d;
      for (let i = this.buf.indexOf("\0"); i >= 0; i = this.buf.indexOf("\0")) {
        const m = JSON.parse(this.buf.slice(0, i)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
        this.buf = this.buf.slice(i + 1);
        const p = m.id === undefined ? undefined : this.pending.get(m.id);
        if (p === undefined || m.id === undefined) continue;
        this.pending.delete(m.id);
        if (m.error !== undefined) p.reject(new Error(m.error.message));
        else p.resolve(m.result ?? {});
      }
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (this.pending.delete(id), reject(new Error(`${method} got no answer within 10 s`))), 10_000);
      this.pending.set(id, { resolve: (r) => (clearTimeout(timer), resolve(r)), reject: (e) => (clearTimeout(timer), reject(e)) });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) })}\0`);
    });
  }

  /** The page target whose URL starts with `prefix`, and a flat session attached to it. */
  async page(prefix: string): Promise<{ targetId: string; sessionId: string }> {
    const { targetInfos } = (await this.send("Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] };
    const t = targetInfos.find((x) => x.type === "page" && x.url.startsWith(prefix));
    if (t === undefined) throw new Error(`no page target at ${prefix}: ${targetInfos.map((x) => `${x.type} ${x.url}`).join(", ")}`);
    const { sessionId } = (await this.send("Target.attachToTarget", { targetId: t.targetId, flatten: true })) as { sessionId: string };
    return { targetId: t.targetId, sessionId };
  }

  /** The centre of `selector`'s box, read with one evaluate (which waits for the page's main thread). */
  async centre(sessionId: string, selector: string): Promise<[number, number]> {
    const r = (await this.send("Runtime.evaluate", { expression: `(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`, returnByValue: true }, sessionId)) as { result: { value: [number, number] } };
    return r.result.value;
  }

  /** A real (trusted) left click at a point; it queues behind a page whose main thread is busy. */
  async clickAt(sessionId: string, [x, y]: [number, number]): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, sessionId);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, sessionId);
  }

  /** A real (trusted) left click at the centre of `selector`'s box. */
  async click(sessionId: string, selector: string): Promise<void> {
    await this.clickAt(sessionId, await this.centre(sessionId, selector));
  }
}

/**
 * Headless Chrome for Testing on `profile`; its own process group, so stopping it stops every helper process too.
 * Under caret-heavy, Chrome is held by a shell until its group is registered with the job's recovery owner; if the
 * registration fails, or this process dies first, Chrome never starts.
 */
/** `extension`: the unpacked extension directory to load, or null for none. */
export function launch(exe: string, profile: string, urls: string[], env: NodeJS.ProcessEnv, extension: string | null, log: string, extra: string[] = [], devtools = false): Running {
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
    ...(devtools ? ["--remote-debugging-pipe"] : []),
    ...urls,
  ];
  const proc = spawnChrome(exe, flags, env, devtools ? ["ignore", "pipe", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"]);
  const cdp = devtools ? new Cdp(proc.stdio[3] as Writable, proc.stdio[4] as Readable) : null;
  const out = createWriteStream(log, { flags: "a" });
  proc.stdout?.pipe(out);
  proc.stderr?.pipe(out);
  const stop = groupStop(proc);
  undo.push({ what: `Chrome for Testing pid ${proc.pid}`, fn: stop });
  return { proc, stop, cdp };
}

/**
 * Chrome for Testing as the leader of its own process group. Every Chrome a fixture starts goes through here (launch,
 * and tasks/chrome.ts launchHeadless), so under caret-heavy none runs before its group is registered: a shell holds
 * Chrome until one line arrives on the descriptor after `stdio`'s, written once the group is registered, then execs
 * Chrome in place (same pid, same group).
 */
export function spawnChrome(exe: string, flags: string[], env: NodeJS.ProcessEnv, stdio: ("ignore" | "pipe")[]): ChildProcess {
  const go = stdio.length;
  const nonce = randomBytes(16).toString("hex");
  const marked = { ...env, [OWNER_VAR]: nonce };
  const proc = REGISTER === undefined
    ? spawn(exe, flags, { env: marked, detached: true, stdio })
    : spawn("/bin/sh", ["-c", `IFS= read -r _ <&${go} || exit 97; exec ${go}<&-; exec "$@"`, "chrome-held", exe, ...flags], { env: marked, detached: true, stdio: [...stdio, "pipe"] });
  if (proc.pid === undefined) throw new Error("Chrome for Testing did not start");
  // The leader's start time, while it is certainly alive (not yet reaped: this function has not yielded since spawn).
  const seen = inspect(proc.pid, nonce);
  owners.set(proc, { nonce, start: typeof seen === "object" && seen.marked ? seen.start : undefined });
  if (REGISTER !== undefined) {
    try {
      register("group", String(proc.pid));
    } catch (e) {
      process.kill(-proc.pid, "SIGKILL");
      throw new Error(`Chrome's process group was not registered, so it was never started: ${e instanceof Error ? e.message : String(e)}`);
    }
    (proc.stdio[go] as Writable).end("G\n");
  }
  return proc;
}

/**
 * Stops the process group `proc` leads: SIGTERM, up to 5 s for everything of the launch's to go (Chrome's helpers can
 * outlive it), then SIGKILL and a report of any survivor.
 * Nothing is signalled on the group id alone: once the group has emptied, the id is free, and another process can lead
 * a group under it, start helpers and exit (I4 re-review), and node's exit fields can lag the reap (libuv reaps first).
 * So each signal follows its own proof, read just before it: while the leader is alive with its recorded start time
 * and the marker, it holds the group id and the whole group is signalled; otherwise each member whose environment
 * shows the marker is signalled by its pid. A member without it is reported, never signalled; one `ps` cannot read is
 * reported too, and keeps the stop from counting the launch as gone. What is left is the classic pid race: a pid would
 * have to be freed and reused within the moment between its `ps` read and the signal.
 * Once nothing of the launch's is left, `gone` latches and nothing is signalled again (I4 review: accept.ts stops a
 * browser, and cleanup stops it again).
 */
export function groupStop(proc: ChildProcess): () => Promise<void> {
  const pid = proc.pid;
  if (pid === undefined) throw new Error("no process group to stop: the process did not start");
  const owner = owners.get(proc);
  let gone = false;
  type Count = { ours: number; unknown: number[]; foreign: number[] };
  /** One pass over the group: signals what it proves is the launch's (when `sig` is given) and counts. */
  const pass = (sig: NodeJS.Signals | null): Count | null => {
    if (owner?.start !== undefined) {
      const leader = inspect(pid, owner.nonce);
      if (typeof leader === "object" && leader.marked && leader.start === owner.start) {
        if (sig !== null) {
          try {
            process.kill(-pid, sig);
          } catch {
            /* the group emptied since the read */
          }
        }
        return { ours: 1, unknown: [], foreign: [] };
      }
    }
    const members = groupMembers(pid);
    if (members === null) return null;
    const count: Count = { ours: 0, unknown: [], foreign: [] };
    for (const member of members) {
      const seen: Seen = owner === undefined ? "unknown" : inspect(member, owner.nonce);
      if (seen === "gone") continue;
      if (seen === "unknown") count.unknown.push(member);
      else if (!seen.marked) count.foreign.push(member);
      else {
        count.ours++;
        if (sig !== null) {
          try {
            process.kill(member, sig);
          } catch {
            /* exited since the read */
          }
        }
      }
    }
    return count;
  };
  const empty = (): boolean => {
    if (gone) return true;
    const count = pass(null);
    if (count !== null && count.ours === 0 && count.unknown.length === 0) gone = true;
    return gone;
  };
  const report = (): void => {
    const count = pass(null);
    if (count === null) return say(`Chrome's process group ${pid} cannot be listed`);
    if (count.unknown.length > 0) say(`Chrome's process group id ${pid} lists ${JSON.stringify(count.unknown)}, whose environment cannot be read; not signalled`);
    if (count.foreign.length > 0) say(`Chrome's process group id ${pid} also lists ${JSON.stringify(count.foreign)} without this launch's marker; not signalled`);
  };
  /** Polls until nothing of the launch's is left or `ms` have passed (by the clock: each poll runs `ps`). */
  const settle = async (ms: number): Promise<void> => {
    const until = Date.now() + ms;
    while (!empty() && Date.now() < until) await sleep(100);
  };
  return async () => {
    if (gone) return;
    if (!empty()) {
      pass("SIGTERM");
      await settle(5000);
    }
    if (!gone) {
      pass("SIGKILL");
      await settle(5000);
      if (!gone) say(`Chrome's process group ${pid} still has members of this launch, or unreadable ones, after SIGKILL`);
    }
    report();
  };
}

/** The frontmost app's display name, by LaunchServices; the run aborts if Chrome for Testing ever takes it. */
export function frontmost(): string {
  try {
    const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
    return /"LSDisplayName"="([^"]*)"/.exec(execFileSync("lsappinfo", ["info", "-only", "name", asn], { encoding: "utf8" }))?.[1] ?? "?";
  } catch {
    return "?";
  }
}

/** The frontmost app's pid, by LaunchServices, or null. */
export function frontmostPid(): number | null {
  try {
    const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
    const m = /"pid"=(\d+)/.exec(execFileSync("lsappinfo", ["info", "-only", "pid", asn], { encoding: "utf8" }));
    return m?.[1] === undefined ? null : Number(m[1]);
  } catch {
    return null;
  }
}

/** Every process in Chrome's tree: pid, ppid, rss (KiB) and command. */
export function processTree(root: number): { pid: number; ppid: number; rss: number; cmd: string }[] {
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

export function tail(file: string): string {
  try {
    return readFileSync(file, "utf8").split("\n").slice(-15).join(" | ");
  } catch {
    return "(no log)";
  }
}
