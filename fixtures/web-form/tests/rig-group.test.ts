// rig.ts's Chrome process group (I4 review), with light fakes and no browser: a shell script stands in for Chrome, a
// script for caret-heavy's registration, and a pgrep wrapper can claim the group's id is in use again. rig.ts reads
// CARET_HEAVY_REGISTER when it loads, so each case runs in its own node process.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const RIG = fileURLToPath(new URL("../rig.ts", import.meta.url));
let dir = "";

const script = (name: string, text: string): string => {
  const path = join(dir, name);
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  return path;
};

/** Runs `body` (an async function body with `rig`, `dir` and `sleep` in scope) in a fresh node process; its JSON result. */
function inChild(body: string, env: Record<string, string>): Record<string, unknown> {
  const main = join(dir, "main.mjs");
  writeFileSync(main, `const rig = await import(${JSON.stringify(RIG)});\nconst dir = ${JSON.stringify(dir)};\nconst sleep = (ms) => new Promise((r) => setTimeout(r, ms));\nconst out = await (async () => {\n${body}\n})();\nprocess.stdout.write(JSON.stringify(out));\n`);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CARET_HEAVY_")));
  return JSON.parse(execFileSync(process.execPath, [main], { env: { ...clean, ...env }, encoding: "utf8", timeout: 60_000 })) as Record<string, unknown>;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "caret-rig-group-")));
  // Stands in for Chrome: says it started, and what arrives on the DevTools request pipe (fd 3) goes back on fd 4.
  script("fake-chrome", `#!/bin/sh\ntouch "$(dirname "$0")/started"\nIFS= read -r line <&3\necho "echo:$line" >&4\nwhile :; do sleep 1; done\n`);
  script("register", `#!/bin/sh\nd=$(dirname "$0")\nif [ -e "$d/started" ]; then echo "$1 $2 AFTER-START" >> "$d/register.log"; else echo "$1 $2 before-start" >> "$d/register.log"; fi\n`);
  // pgrep, except that once "reused" exists it reports a member for any group: the id now names another group. The
  // member is the pid written in "reused", or 99999 when it is empty.
  script("pgrep", `#!/bin/sh\nr="$(dirname "$0")/reused"\n[ -e "$r" ] && { if [ -s "$r" ]; then cat "$r"; else echo 99999; fi; exit 0; }\nexec /usr/bin/pgrep "$@"\n`);
  // Stands in for a Chrome that exits by itself and leaves two processes in its group: a helper that inherited its
  // environment, and one started without the launch's marker.
  script("fake-chrome-exits", `#!/bin/sh\nd=$(dirname "$0")\nsleep 600 &\necho $! > "$d/helper.pid"\nenv -u CARET_RIG_CHROME_OWNER sleep 600 &\necho $! > "$d/foreign.pid"\ntouch "$d/started"\nexit 0\n`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("launchHeadless's Chrome (DevTools pipes on 3 and 4) is registered before it runs, and its pipes reach it", () => {
  const out = inChild(
    `const proc = rig.spawnChrome(dir + "/fake-chrome", [], process.env, ["ignore", "ignore", "ignore", "pipe", "pipe"]);
    proc.stdio[3].write("hello\\n");
    const reply = await new Promise((r) => proc.stdio[4].once("data", (b) => r(String(b).trim())));
    await rig.groupStop(proc)();
    return { pid: proc.pid, reply };`,
    { CARET_HEAVY_REGISTER: join(dir, "register") },
  );
  assert.equal(readFileSync(join(dir, "register.log"), "utf8").trim(), `group ${out.pid} before-start`);
  assert.equal(out.reply, "echo:hello");
});

test("outside caret-heavy nothing is registered and Chrome starts directly", () => {
  inChild(
    `const proc = rig.spawnChrome(dir + "/fake-chrome", [], process.env, ["ignore", "ignore", "ignore", "pipe", "pipe"]);
    for (let i = 0; i < 100 && !(await import("node:fs")).existsSync(dir + "/started"); i++) await sleep(50);
    await rig.groupStop(proc)();
    return {};`,
    {},
  );
  assert.ok(existsSync(join(dir, "started")));
  assert.ok(!existsSync(join(dir, "register.log")));
});

test("a group seen empty is never signalled again, even when its id lists members later", () => {
  const out = inChild(
    `const proc = rig.spawnChrome(dir + "/fake-chrome", [], process.env, ["ignore", "ignore", "ignore", "pipe", "pipe"]);
    const stop = rig.groupStop(proc);
    await stop();
    (await import("node:fs")).writeFileSync(dir + "/reused", "");
    const signalled = [];
    const kill = process.kill.bind(process);
    process.kill = (pid, sig) => (pid < 0 && signalled.push([pid, sig]), pid < 0 ? true : kill(pid, sig));
    await stop();
    return { signalled };`,
    { PATH: `${dir}:${process.env.PATH ?? ""}` },
  );
  assert.deepEqual(out.signalled, []);
});

test("a stranger's group that reuses Chrome's id after it emptied unseen is never signalled", () => {
  const out = inChild(
    `const fs = await import("node:fs");
    const { spawn } = await import("node:child_process");
    const proc = rig.spawnChrome(dir + "/fake-chrome", [], process.env, ["ignore", "ignore", "ignore", "pipe", "pipe"]);
    const stop = rig.groupStop(proc);
    for (let i = 0; i < 100 && !fs.existsSync(dir + "/started"); i++) await sleep(50);
    // Chrome's whole group goes away without the rig seeing it, and node reaps the leader.
    process.kill(-proc.pid, "SIGKILL");
    if (proc.exitCode === null && proc.signalCode === null) await new Promise((r) => proc.once("exit", r));
    // Another process now leads a group under the same id (the pgrep stand-in lists it), in a session of its own.
    const stranger = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    fs.writeFileSync(dir + "/reused", String(stranger.pid));
    const kill = process.kill.bind(process);
    const signalled = [];
    process.kill = (pid, sig) => (sig !== 0 && signalled.push([pid, sig ?? "SIGTERM"]), kill(pid, sig));
    await stop();
    process.kill = kill;
    let alive = true;
    try { kill(stranger.pid, 0); } catch { alive = false; }
    kill(stranger.pid, "SIGKILL");  // this test's own process, by exact pid
    return { signalled, alive };`,
    { PATH: `${dir}:${process.env.PATH ?? ""}` },
  );
  assert.deepEqual(out.signalled, []);
  assert.equal(out.alive, true);
});

test("after Chrome exits, its helpers are still stopped by the launch's marker, and a member without it is only reported", () => {
  const out = inChild(
    `const fs = await import("node:fs");
    const said = [];
    rig.setSay((s) => said.push(s));
    const proc = rig.spawnChrome(dir + "/fake-chrome-exits", [], process.env, ["ignore", "ignore", "ignore", "pipe", "pipe"]);
    if (proc.exitCode === null && proc.signalCode === null) await new Promise((r) => proc.once("exit", r));
    const helper = Number(fs.readFileSync(dir + "/helper.pid", "utf8"));
    const foreign = Number(fs.readFileSync(dir + "/foreign.pid", "utf8"));
    await rig.groupStop(proc)();
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const result = { helperAlive: alive(helper), foreignAlive: alive(foreign), foreign, said };
    process.kill(foreign, "SIGKILL");  // this test's own process, by exact pid
    return result;`,
    {},
  );
  assert.equal(out.helperAlive, false);
  assert.equal(out.foreignAlive, true);
  assert.ok((out.said as string[]).some((s) => s.includes(String(out.foreign)) && s.includes("not signalled")), JSON.stringify(out.said));
});
