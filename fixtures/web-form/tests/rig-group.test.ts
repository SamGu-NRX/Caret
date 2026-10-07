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

/**
 * Runs `body` (an async function body with `rig`, `dir` and `sleep` in scope) in a fresh node process; its JSON result.
 * The child exits once the result is written: processes a case leaves (cleaned up by afterEach) cannot hold it open.
 */
function inChild(body: string, env: Record<string, string>): Record<string, unknown> {
  const main = join(dir, "main.mjs");
  writeFileSync(main, `const rig = await import(${JSON.stringify(RIG)});\nconst dir = ${JSON.stringify(dir)};\nconst sleep = (ms) => new Promise((r) => setTimeout(r, ms));\nconst out = await (async () => {\n${body}\n})();\nprocess.stdout.write(JSON.stringify(out), () => process.exit(0));\n`);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CARET_HEAVY_")));
  return JSON.parse(execFileSync(process.execPath, [main], { env: { ...clean, ...env }, encoding: "utf8", timeout: 60_000 })) as Record<string, unknown>;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "caret-rig-group-")));
  // Stands in for Chrome: says it started, and what arrives on the DevTools request pipe (fd 3) goes back on fd 4.
  script("fake-chrome", `#!/bin/sh\necho $$ > "$(dirname "$0")/chrome.pid"\ntouch "$(dirname "$0")/started"\nIFS= read -r line <&3\necho "echo:$line" >&4\nwhile :; do sleep 1; done\n`);
  script("register", `#!/bin/sh\nd=$(dirname "$0")\nif [ -e "$d/started" ]; then echo "$1 $2 AFTER-START" >> "$d/register.log"; else echo "$1 $2 before-start" >> "$d/register.log"; fi\n`);
  // pgrep, except that once "reused" exists it reports a member for any group: the id now names another group. The
  // member is the pid written in "reused", or 99999 when it is empty.
  script("pgrep", `#!/bin/sh\nr="$(dirname "$0")/reused"\n[ -e "$r" ] && { if [ -s "$r" ]; then cat "$r"; else echo 99999; fi; exit 0; }\nexec /usr/bin/pgrep "$@"\n`);
  // Stands in for a Chrome that exits by itself and leaves two processes in its group: a helper that inherited its
  // environment, and one started without the launch's marker.
  // Each child writes its pid itself, already running with its final environment, and the script waits for both.
  script("fake-chrome-exits", `#!/bin/sh\nd=$(dirname "$0")\necho $$ > "$d/chrome.pid"\nsh -c 'echo $$ > "$0/helper.pid.tmp"; mv "$0/helper.pid.tmp" "$0/helper.pid"; exec sleep 600' "$d" &\nenv -u CARET_RIG_CHROME_OWNER sh -c 'echo $$ > "$0/foreign.pid.tmp"; mv "$0/foreign.pid.tmp" "$0/foreign.pid"; exec sleep 600' "$d" &\nwhile [ ! -e "$d/helper.pid" ] || [ ! -e "$d/foreign.pid" ]; do sleep 0.05; done\ntouch "$d/started"\nexit 0\n`);
  // ps, except that while "ps-fails" exists it fails as if it could not read anything (status 2, not 1: not "gone").
  script("ps", `#!/bin/sh\n[ -e "$(dirname "$0")/ps-fails" ] && { echo "ps: cannot read" >&2; exit 2; }\nexec /bin/ps "$@"\n`);
});

afterEach(() => {
  // Teardown that does not depend on groupStop: each process a fake recorded, by its exact pid, only while its command
  // is still the one recorded (the sleepers, and the fake Chrome, whose whole group goes with it as its live leader).
  for (const [name, command, group] of [["helper.pid", "sleep", false], ["foreign.pid", "sleep", false], ["stranger.pid", "sleep", false], ["chrome.pid", "fake-chrome", true]] as const) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, "utf8"));
    try {
      if (execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).includes(command)) process.kill(group ? -pid : pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
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
    fs.writeFileSync(dir + "/stranger.pid", String(stranger.pid));
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
    const { execFileSync } = await import("node:child_process");
    const alive = (pid) => { try { const st = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim(); return st !== "" && !st.startsWith("Z"); } catch { return false; } };
    for (let i = 0; i < 50 && alive(helper); i++) await sleep(100);
    return { helperAlive: alive(helper), foreignAlive: alive(foreign), foreign, said };`,
    {},
  );
  assert.equal(out.helperAlive, false);
  assert.equal(out.foreignAlive, true);
  assert.ok((out.said as string[]).some((s) => s.includes(String(out.foreign)) && s.includes("not signalled")), JSON.stringify(out.said));
});

test("a leader that libuv has reaped while node still shows no exit is not trusted with the group id", () => {
  // libuv reaps every exited child before it runs their exit callbacks, in spawn order (I4 re-review). A child spawned
  // before Chrome exits together with it; inside that child's exit callback Chrome's pid is already gone while
  // proc.exitCode and proc.signalCode are still null, and a stranger is listed under Chrome's group id.
  const out = inChild(
    `const fs = await import("node:fs");
    const { spawn, execFileSync } = await import("node:child_process");
    const first = spawn("/bin/sh", ["-c", "while [ ! -e \\"$0/go\\" ]; do sleep 0.02; done", dir], { stdio: "ignore" });
    const proc = rig.spawnChrome(dir + "/fake-chrome", [], process.env, ["ignore", "ignore", "ignore", "pipe", "pipe"]);
    const stop = rig.groupStop(proc);
    for (let i = 0; i < 100 && !fs.existsSync(dir + "/started"); i++) await sleep(50);
    const stranger = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    fs.writeFileSync(dir + "/stranger.pid", String(stranger.pid));
    const kill = process.kill.bind(process);
    const exited = (pid) => { try { return execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z"); } catch { return true; } };
    // Both exit while this code holds the event loop; neither is reaped until it yields.
    kill(-proc.pid, "SIGKILL");
    fs.writeFileSync(dir + "/go", "");
    for (let i = 0; i < 200 && !(exited(first.pid) && exited(proc.pid)); i++) execFileSync("/bin/sleep", ["0.02"]);
    const signalled = [];
    const premise = await new Promise((resolve) => first.once("exit", () => {
      let chromeGone = true;
      try { execFileSync("/bin/ps", ["-p", String(proc.pid)], { stdio: "ignore" }); chromeGone = false; } catch {}
      const fieldsNull = proc.exitCode === null && proc.signalCode === null;
      fs.writeFileSync(dir + "/reused", String(stranger.pid));
      process.kill = (pid, sig) => (sig !== 0 && signalled.push([pid, sig ?? "SIGTERM"]), kill(pid, sig));
      const stopping = stop();  // its decision is made here, before its first await
      process.kill = kill;
      resolve({ chromeGone, fieldsNull, stopping });
    }));
    await premise.stopping;
    return { chromeGone: premise.chromeGone, fieldsNull: premise.fieldsNull, signalled };`,
    { PATH: `${dir}:${process.env.PATH ?? ""}` },
  );
  assert.deepEqual([out.chromeGone, out.fieldsNull], [true, true], "the premise: Chrome reaped, its exit not yet reported");
  assert.deepEqual(out.signalled, []);
});

test("a member whose environment cannot be read is not signalled, not taken as gone, and is stopped once it can be", () => {
  const out = inChild(
    `const fs = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const said = [];
    rig.setSay((s) => said.push(s));
    const proc = rig.spawnChrome(dir + "/fake-chrome-exits", [], process.env, ["ignore", "ignore", "ignore", "pipe", "pipe"]);
    if (proc.exitCode === null && proc.signalCode === null) await new Promise((r) => proc.once("exit", r));
    const helper = Number(fs.readFileSync(dir + "/helper.pid", "utf8"));
    const alive = (pid) => { try { const st = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim(); return st !== "" && !st.startsWith("Z"); } catch { return false; } };
    const stop = rig.groupStop(proc);
    fs.writeFileSync(dir + "/ps-fails", "");
    await stop();
    const aliveWhileUnreadable = alive(helper);
    fs.unlinkSync(dir + "/ps-fails");
    await stop();
    for (let i = 0; i < 50 && alive(helper); i++) await sleep(100);
    return { aliveWhileUnreadable, aliveAfter: alive(helper), said };`,
    { PATH: `${dir}:${process.env.PATH ?? ""}` },
  );
  assert.equal(out.aliveWhileUnreadable, true);
  assert.ok((out.said as string[]).some((s) => s.includes("cannot be read")), JSON.stringify(out.said));
  assert.equal(out.aliveAfter, false);
});
