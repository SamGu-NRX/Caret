// Drives fixtures/web-form/rig.ts (branch ops/heavy-browser) with light fakes, for tests/test_rig_ts.py.
//   node rig_ts_harness.mjs RIG_TS WORKDIR MODE
// MODE: launch | refused | launchd | plain. Prints one JSON line of observations. @puppeteer/browsers is stubbed, since
// nothing here installs a browser.
import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@puppeteer/browsers") return { url: "data:text/javascript,export const Browser={};export const computeExecutablePath=()=>'';export const detectBrowserPlatform=()=>'';export const install=async()=>({});", shortCircuit: true };
    return next(specifier, context);
  },
});

const [rigPath, dir, mode] = process.argv.slice(2);
const rig = await import(rigPath);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const members = (pgid) => {
  try {
    return execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
};
const out = {};

if (mode === "launch" || mode === "refused" || mode === "plain") {
  let error = null;
  let r = null;
  try {
    r = rig.launch(join(dir, "fake-chrome"), join(dir, "profile"), [], process.env, null, join(dir, "chrome.log"));
  } catch (e) {
    error = e.message;
  }
  out.error = error;
  if (r !== null) {
    out.pid = r.proc.pid;
    for (let i = 0; i < 100 && !existsSync(join(dir, "child.pid")); i++) await sleep(50);
    out.started = existsSync(join(dir, "started"));
    out.command = execFileSync("ps", ["-o", "command=", "-p", String(r.proc.pid)], { encoding: "utf8" }).trim();
    out.membersBeforeStop = members(r.proc.pid).length;
    const t = Date.now();
    await r.stop();
    out.stopMs = Date.now() - t;
    out.membersAfterStop = members(r.proc.pid);
  } else {
    await sleep(1000);
    out.started = existsSync(join(dir, "started"));
  }
  out.registerLog = existsSync(join(dir, "register.log")) ? readFileSync(join(dir, "register.log"), "utf8") : "";
}

if (mode === "launchd") {
  const log = join(dir, "job.log");
  const program = ["/bin/sh", "-c", "echo listening on >&2; exec sleep 600"];
  try {
    await rig.launchdJob(dir, "dev.caret.not-prefixed", "dev.caret.svc.a", program, log);
    out.unprefixed = "started";
  } catch (e) {
    out.unprefixed = e.message;
  }
  const label = `${process.env.CARET_HEAVY_LAUNCHD_PREFIX}w3test.${process.pid}`;
  await rig.launchdJob(dir, label, `dev.caret.svc.${process.pid}`, program, log);
  out.label = label;
  out.loaded = execFileSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], { stdio: "pipe" }).length > 0;
  await rig.cleanup();
  try {
    execFileSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], { stdio: "pipe" });
    out.afterCleanup = "still loaded";
  } catch {
    out.afterCleanup = "gone";
  }
  out.registerLog = readFileSync(join(dir, "register.log"), "utf8");
}
writeFileSync(join(dir, "result.json"), JSON.stringify(out));
