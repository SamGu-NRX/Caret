// An acceptance run's Caret is the host of the run's helper (src/host-auth.ts). The run here is the one the on-screen
// acceptance scripts make: apps/caret/scripts/acceptance_helper.ts started with the launch secret on standard input,
// and a Caret started through scripts/spawn-caret.ts with the same secret. The Caret is a stand-in that does what
// HelperClient does with the key it reads from CARET_HOST_KEY_FD, so the test needs no app build.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { newLaunchSecret, sendSecret } from "../src/launch.ts";
import { PAGE_TEXT_CAPABILITY, PROTOCOL_VERSION } from "../src/protocol.ts";
import { spawnCaret } from "../scripts/spawn-caret.ts";
import { until } from "./socket-reader.ts";

const ACCEPTANCE_HELPER = fileURLToPath(new URL("../../apps/caret/scripts/acceptance_helper.ts", import.meta.url));
const HOST_AUTH = pathToFileURL(fileURLToPath(new URL("../src/host-auth.ts", import.meta.url))).href;

// Reads the key once from the descriptor CARET_HOST_KEY_FD names, says hello as the host with pageText, answers the
// challenge, then sends one pageInsert (a message only a pageText host may send) and prints every line it got as JSON.
const STAND_IN = `
import { closeSync, readSync } from "node:fs";
import { createConnection } from "node:net";
import { hostProof } from ${JSON.stringify(HOST_AUTH)};
const fd = Number(process.env.CARET_HOST_KEY_FD);
const key = Buffer.alloc(32);
let got = 0;
while (got < 32) { const n = readSync(fd, key, got, 32 - got, null); if (n === 0) break; got += n; }
closeSync(fd);
const exposed = [key.toString("hex"), key.toString("base64")].some((k) => process.argv.some((a) => a.includes(k)) || Object.values(process.env).some((v) => v?.includes(k)));
const received = [];
const done = () => { process.stdout.write(JSON.stringify({ fd, got, exposed, received }) + "\\n"); process.exit(0); };
const s = createConnection(process.env.STAND_IN_SOCKET);
let buf = "";
s.setEncoding("utf8");
s.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    received.push(m);
    if (m.type === "hostChallenge") s.write(JSON.stringify({ type: "hostProof", v: ${PROTOCOL_VERSION}, proof: hostProof(key, m.nonce) }) + "\\n");
    if (m.type === "hostAuthenticated") s.write(JSON.stringify({ type: "pageInsert", v: ${PROTOCOL_VERSION}, requestId: "ahk-1", windowId: "w-1", key: "k-1", expect: "", text: "hi", token: "t-1", at: Date.now() }) + "\\n");
    if (m.type === "pageInsertReply" || m.type === "error") done();
  }
});
s.on("close", done);
s.write(JSON.stringify({ type: "hello", v: ${PROTOCOL_VERSION}, role: "consumer", mode: "live", pid: process.pid, version: "stand-in", host: true, capabilities: [${JSON.stringify(PAGE_TEXT_CAPABILITY)}] }) + "\\n");
`;

const exited = (c: ChildProcess): Promise<void> => new Promise((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once("exit", () => r())));

describe("an acceptance run's Caret", () => {
  const children: ChildProcess[] = [];
  let dir = "";

  afterEach(async () => {
    for (const c of children) c.kill("SIGTERM");
    await Promise.all(children.map(exited));
    children.length = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  it("is admitted as the host of acceptance_helper.ts through the key spawnCaret hands it", async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-ahk-"));
    const sock = join(dir, "h.sock");
    const secret = newLaunchSecret();
    const helper = spawn(process.execPath, [ACCEPTANCE_HELPER, "--auth-fd", "0", "--socket", sock, "--state", join(dir, "state.json")]);
    children.push(helper);
    sendSecret(helper, secret);
    let helperLog = "";
    helper.stderr.setEncoding("utf8");
    helper.stderr.on("data", (d: string) => (helperLog += d));
    await until(() => existsSync(sock), 20_000).catch(() => {
      throw new Error(`acceptance_helper.ts did not open its socket: ${helperLog.slice(-2000)}`);
    });

    const caret = spawnCaret(process.execPath, ["--input-type=module", "-e", STAND_IN], secret, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, STAND_IN_SOCKET: sock } });
    children.push(caret);
    let out = "";
    let err = "";
    caret.stdout?.setEncoding("utf8");
    caret.stdout?.on("data", (d: string) => (out += d));
    caret.stderr?.setEncoding("utf8");
    caret.stderr?.on("data", (d: string) => (err += d));
    await exited(caret);
    expect(err).toBe("");
    const report = JSON.parse(out) as { fd: number; got: number; exposed: boolean; received: { type: string; requestId?: string; message?: string }[] };

    expect(report.fd).toBe(3);
    expect(report.got).toBe(32);
    expect(report.exposed, "the key is on the descriptor only, never on argv or in the environment").toBe(false);
    expect(report.received.map((m) => m.type)).toEqual(["hostChallenge", "hostAuthenticated", "pageInsertReply"]);
    expect(report.received[2]?.requestId).toBe("ahk-1");
  }, 30_000);
});
