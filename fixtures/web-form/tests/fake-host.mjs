#!/usr/bin/env -S node
// A stand-in for caret-bridge and the test host on machines without the signed Mac binaries (the rows-activation
// browser test). Chrome launches it as the extension's Native Messaging host; it performs page.sock's handshake with
// the page key of the launch secret it is given and relays: Native Messaging frames on stdin become NDJSON lines on
// the socket, socket lines become frames on stdout, engineReady first as the bridge does. It passes only its own
// message types on, as the real relay does, and verifies nothing about its caller beyond what Chrome itself checked
// (the manifest's allowed_origins), because the test runs it from the extension it wrote.
import { createHmac, randomBytes } from "node:crypto";
import net from "node:net";

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const SOCKET = arg("--socket");
const SECRET_HEX = arg("--secret-hex");
const HELPER_PID = Number(arg("--helper-pid"));
const EXTENSION_ID = arg("--extension-id");
const VERSION = 1;
if (SOCKET === undefined || SECRET_HEX === undefined || !Number.isInteger(HELPER_PID) || EXTENSION_ID === undefined) {
  console.error("usage: fake-host.mjs --socket PATH --secret-hex HEX --helper-pid PID --extension-id ID");
  process.exit(1);
}

// page.sock's key: HMAC-SHA256(launch secret, "caret-page-key"), held in memory, never written (engines/auth.ts).
const key = createHmac("sha256", Buffer.from(SECRET_HEX, "hex")).update("caret-page-key", "utf8").digest();

/** One Native Messaging frame to the extension: u32 little-endian length, then the UTF-8 JSON. */
const out = (payload) => {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([head, payload]));
};

const sock = net.createConnection(SOCKET);
let lineBuf = "";
sock.setEncoding("utf8");
sock.on("data", (chunk) => {
  lineBuf += chunk;
  for (let nl = lineBuf.indexOf("\n"); nl >= 0; nl = lineBuf.indexOf("\n")) {
    const line = lineBuf.slice(0, nl);
    lineBuf = lineBuf.slice(nl + 1);
    if (line.trim() === "") continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type === "engineChallenge") {
      // The proof binds the challenge, this side's nonce and the helper's pid, over the page key (auth.ts bridgeProof).
      const nonce = randomBytes(32).toString("hex");
      const proof = createHmac("sha256", key)
        .update(["caret-page-bridge", m.nonce, nonce, String(HELPER_PID)].join("\n"), "utf8")
        .digest("hex");
      const hello = {
        type: "engineHello",
        v: VERSION,
        role: "page",
        browser: { pid: process.ppid, bundleId: "com.google.chrome.for.testing", name: "Chrome for Testing" },
        extensionId: EXTENSION_ID,
        bridgeVersion: "fake-host",
        nonce,
        proof,
      };
      sock.write(`${JSON.stringify(hello)}\n`);
    } else if (m.type === "engineWelcome") {
      // The helper proved itself; the extension's first message is engineReady, as the bridge's is.
      out(Buffer.from(JSON.stringify({ type: "engineReady", v: VERSION, engine: m.engine })));
    } else {
      out(Buffer.from(line));
    }
  }
});
sock.on("error", (e) => {
  console.error(`page.sock: ${e.message}`);
  process.exit(1);
});

// Native Messaging frames from the extension become lines on the socket.
let frameBuf = Buffer.alloc(0);
process.stdin.on("data", (d) => {
  frameBuf = Buffer.concat([frameBuf, d]);
  while (frameBuf.length >= 4) {
    const n = frameBuf.readUInt32LE(0);
    if (n > 64 * 1024 * 1024) process.exit(1);
    if (frameBuf.length < 4 + n) break;
    const payload = frameBuf.subarray(4, 4 + n);
    frameBuf = frameBuf.subarray(4 + n);
    sock.write(`${payload.toString("utf8")}\n`);
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
