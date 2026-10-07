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
  // pgrep, except that once "reused" exists it reports a member for any group: the id now names another group.
  script("pgrep", `#!/bin/sh\n[ -e "$(dirname "$0")/reused" ] && { echo 99999; exit 0; }\nexec /usr/bin/pgrep "$@"\n`);
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
