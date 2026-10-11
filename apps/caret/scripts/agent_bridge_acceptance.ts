// Caret.app as its launchd agent, end to end (brief H4, acceptance 3; xpc-bridge-host spec, "How to verify on the host").
//
// The acceptance build (scripts/build-app.sh acceptance) runs as a temporary launchd job labelled dev.caret.host that
// owns dev.caret.host.page-bridge, in --acceptance-services-only mode: it makes its own launch secret, starts its
// bundled helper (and would start the reader, which waits without an Accessibility grant), and vends the bridge
// service. No tap, model or window. Its home is a temporary directory. Then:
//
//   1. launchctl print shows the job, its program and the Mach service.
//   2. Chrome for Testing (headless, temporary profile, the bundled Caret for Chrome) starts the bundled caret-bridge,
//      which opens an engine on the helper Caret started: the secret Caret made, the page key derived from it, and
//      the helper's proof of its pid all held.
//   3. The same bridge started by this script (not a browser), a copy signed by another team, and an ad hoc copy are
//      each refused before an engine opens.
//   4. No key file sits beside the sockets.
//   5. Booting the job out stops Caret, and with it the helper.
//
// The Native Messaging manifest goes only in the temporary profile's NativeMessagingHosts, which Chrome for Testing
// reads with --user-data-dir (W1). The acceptance build trusts Chrome for Testing by its designated requirement, which
// this script passes in; the shipped build cannot.
//
//   node apps/caret/scripts/agent_bridge_acceptance.ts --app APP --chrome EXE --other-identity SHA1 --out DIR
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({ options: { app: { type: "string" }, chrome: { type: "string" }, "other-identity": { type: "string" }, out: { type: "string" } } });
if (a.app === undefined || a.chrome === undefined || a["other-identity"] === undefined || a.out === undefined) {
  throw new Error("usage: --app APP --chrome EXE --other-identity SHA1 --out DIR");
}
const APP = resolve(a.app);
const CHROME = resolve(a.chrome);
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const LABEL = "dev.caret.host";
const SERVICE = "dev.caret.host.page-bridge";
const EXTENSION_ID = "idbkbnaepbamcdecogahbinlcodkbmmj";
const DOMAIN = `gui/${process.getuid?.() ?? 501}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const results: { name: string; pass: boolean; detail: string }[] = [];
const undo: (() => void | Promise<void>)[] = [];

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, pass: true, detail });
    console.log(`PASS ${name}: ${detail}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, pass: false, detail });
    console.log(`FAIL ${name}: ${detail}`);
  }
}

function expect(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

async function until<T>(what: string, ms: number, fn: () => T | undefined | null | false): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`${what}: not within ${ms / 1000} s`);
    await sleep(100);
  }
}

const loaded = (): boolean => {
  try {
    execFileSync("launchctl", ["print", `${DOMAIN}/${LABEL}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const designated = (path: string): string => {
  const out = execFileSync("codesign", ["-d", "-r-", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const m = /designated => (.*)/.exec(out);
  if (m?.[1] === undefined) throw new Error(`no designated requirement for ${path}`);
  return m[1].trim();
};

const xml = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Runs the bridge as a process that is not a browser, until it exits (15 s at most). */
async function bridgeAlone(bridge: string): Promise<{ code: number | null; err: string }> {
  const env = { ...process.env };
  delete env.CARET_BRIDGE_SERVICE;
  const p = spawn(bridge, [`chrome-extension://${EXTENSION_ID}/`], { env, stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  p.stderr?.setEncoding("utf8").on("data", (d: string) => (err += d));
  const code = await new Promise<number | null>((done) => {
    const t = setTimeout(() => (p.kill("SIGKILL"), done(null)), 15_000);
    p.once("exit", (c) => (clearTimeout(t), done(c)));
  });
  return { code, err: err.trim() };
}

async function main(): Promise<number> {
  if (loaded()) throw new Error(`a job labelled ${LABEL} is already loaded in ${DOMAIN}; not replacing it`);
  const tmp = mkdtempSync("/tmp/caret-a3-");
  undo.push(() => rmSync(tmp, { recursive: true, force: true }));
  const home = join(tmp, "h");
  const log = join(OUT, "host.log");
  writeFileSync(log, "");
  const caret = join(APP, "Contents", "MacOS", "Caret");
  const bridge = join(APP, "Contents", "Helpers", "caret-bridge");
  const extension = join(APP, "Contents", "Resources", "Caret for Chrome");
  const cftApp = CHROME.slice(0, CHROME.indexOf(".app/") + 4);
  const program = [caret, "--home", home, "--acceptance-services-only", "--acceptance-browser-requirement", designated(cftApp)];
  const plist = join(tmp, `${LABEL}.plist`);
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${program.map((x) => `<string>${xml(x)}</string>`).join("")}</array>
<key>MachServices</key><dict><key>${SERVICE}</key><true/></dict>
<key>EnvironmentVariables</key><dict><key>CARET_LAUNCHD_AGENT</key><string>1</string></dict>
<key>RunAtLoad</key><true/>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`, { mode: 0o600 });
  execFileSync("launchctl", ["bootstrap", DOMAIN, plist], { stdio: "pipe" });
  undo.push(() => {
    try {
      execFileSync("launchctl", ["bootout", `${DOMAIN}/${LABEL}`], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  });
  const text = (): string => readFileSync(log, "utf8");
  let helperPid = 0;

  await check("Caret.app as the launchd agent starts its bundled helper and vends the bridge service", async () => {
    const started = await until("the helper starts", 20_000, () => /started the helper, process (\d+)/.exec(text()));
    helperPid = Number(started[1]);
    await until("the bridge service is on", 10_000, () => text().includes(`page bridge on: vending ${SERVICE}`));
    await until("the helper listens on page.sock", 15_000, () => existsSync(join(home, "sockets", "page.sock")));
    const printed = execFileSync("launchctl", ["print", `${DOMAIN}/${LABEL}`], { encoding: "utf8" });
    writeFileSync(join(OUT, "launchctl-print.txt"), printed);
    expect(new RegExp(`endpoints = \\{[^}]*"${SERVICE.replaceAll(".", "\\.")}"`, "s").test(printed), `${SERVICE} is not among the job's endpoints`);
    const prog = /program = (.*)/.exec(printed)?.[1] ?? "";
    expect(prog === caret, `the job runs ${prog}`);
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(helperPid)], { encoding: "utf8" }).trim();
    expect(cmd.startsWith(join(APP, "Contents", "Helpers", "node")) && cmd.includes("--auth-fd 0"), cmd);
    return `launchctl: program ${prog}, endpoint ${SERVICE}; helper ${helperPid}: ${cmd.slice(cmd.indexOf("/Contents/") + 1, cmd.indexOf("--auth-fd") + 11)}…`;
  });

  await check("Chrome for Testing starts the bundled bridge, which opens an engine on the helper Caret started", async () => {
    const profile = join(tmp, "p");
    const nm = join(profile, "NativeMessagingHosts");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "ai.caret.bridge.json"), JSON.stringify({ name: "ai.caret.bridge", description: "Caret page bridge (H4 acceptance)", path: bridge, type: "stdio", allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] }, null, 2));
    const flags = ["--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic",
      "--disable-sync", "--disable-background-networking", "--disable-component-update", `--load-extension=${extension}`, `--disable-extensions-except=${extension}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch", "about:blank"];
    const env = { ...process.env };
    delete env.CARET_BRIDGE_SERVICE;
    const chrome: ChildProcess = spawn(CHROME, flags, { env, detached: true, stdio: "ignore" });
    const pid = chrome.pid ?? 0;
    undo.push(async () => {
      try {
        process.kill(-pid, "SIGTERM");
        await sleep(1000);
        process.kill(-pid, "SIGKILL");
      } catch {
        /* gone */
      }
    });
    const m = await until("an engine opens", 30_000, () => /engine (\S+) open for bridge process (\d+), (.+) \((\d+)\), extension (\S+)/.exec(text()));
    expect(m[5] === EXTENSION_ID, `extension ${m[5]}`);
    expect(Number(m[4]) === pid, `the engine's browser is process ${m[4]}, Chrome for Testing is ${pid}`);
    return `engine ${m[1]} for bridge ${m[2]}, ${m[3]} (${m[4]})`;
  });

  const refused = async (label: string, path: string, says: RegExp): Promise<string> => {
    const before = (text().match(/ open for bridge process/g) ?? []).length;
    const r = await bridgeAlone(path);
    await sleep(300);
    expect(r.code === 1 && says.test(r.err), `exit ${r.code}: ${r.err}`);
    expect((text().match(/ open for bridge process/g) ?? []).length === before, "an engine opened");
    return `${label}: ${r.err.split("\n").at(-1)}`;
  };
  await check("the bundled bridge started by a process that is not a browser is refused", () => refused("not a browser", bridge, /not a browser Caret knows/));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  for (const [label, identity] of [["another team", a["other-identity"] as string], ["ad hoc", "-"]] as const) {
    await check(`a bridge signed ${label} is refused by the host's requirement`, async () => {
      const copy = join(bin, `caret-bridge-${identity === "-" ? "adhoc" : "other"}`);
      copyFileSync(bridge, copy);
      execFileSync("codesign", ["--force", "--sign", identity, "--identifier", "dev.caret.bridge", "--options", "runtime", "--timestamp=none", copy], { stdio: "pipe" });
      return refused(label, copy, /relaying nothing/);
    });
  }

  await check("no key file sits beside the sockets", async () => {
    const files = readdirSync(join(home, "sockets")).sort();
    expect(files.every((f) => f.endsWith(".sock")), `the socket directory holds ${files.join(", ")}`);
    return files.join(", ");
  });

  await check("booting the job out stops Caret and its helper", async () => {
    execFileSync("launchctl", ["bootout", `${DOMAIN}/${LABEL}`], { stdio: "pipe" });
    await until("the job is gone", 10_000, () => !loaded());
    await until("the helper is gone", 10_000, () => {
      try {
        process.kill(helperPid, 0);
        return false;
      } catch {
        return true;
      }
    });
    return `job unloaded; helper ${helperPid} gone`;
  });
  return 0;
}

let code = 1;
try {
  await main();
} catch (e) {
  results.push({ name: "setup", pass: false, detail: e instanceof Error ? e.message : String(e) });
  console.log(`FAIL setup: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  for (const fn of undo.reverse()) await fn();
  writeFileSync(join(OUT, "agent-bridge-acceptance.json"), JSON.stringify(results, null, 2));
  const passed = results.filter((r) => r.pass).length;
  console.log(`${passed}/${results.length} passed`);
  code = passed === results.length && results.length > 0 ? 0 : 1;
}
process.exit(code);
