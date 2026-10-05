// The acceptance rig, shared by accept.ts and page-loop-eval.ts: pinned headless Chrome for Testing on a temporary
// profile, the bridge's Native Messaging manifest (never a real browser's directory), signed copies of the bridge and
// its test host, the test host as a temporary launchd job, a DevTools pipe to the run's own browser, and the cleanup
// registry that undoes all of it. Moved here from accept.ts unchanged, except that it logs through setSay.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
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
export async function launchdJob(dir: string, label: string, service: string, program: string[], log: string): Promise<void> {
  const plist = join(dir, `${label}.plist`);
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${program.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
<key>MachServices</key><dict><key>${xml(service)}</key><true/></dict>
<key>RunAtLoad</key><true/>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`, { mode: 0o600 });
  const domain = `gui/${process.getuid?.() ?? 501}`;
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

/** Headless Chrome for Testing on `profile`; its own process group, so stopping it stops every helper process too. */
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
  const proc = spawn(exe, flags, { env, detached: true, stdio: devtools ? ["ignore", "pipe", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"] });
  const cdp = devtools ? new Cdp(proc.stdio[3] as Writable, proc.stdio[4] as Readable) : null;
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
  return { proc, stop, cdp };
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
