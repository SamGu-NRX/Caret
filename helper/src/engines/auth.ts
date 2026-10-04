// The page bridge's handshake (protocol.ts EngineChallenge, EngineHello, EngineWelcome), on B23's scheme: the
// launch secret both the helper and the reader got from the launcher (src/launch.ts), and a helper proof bound to the
// helper's process id, which the bridge requires to be its socket's peer (LOCAL_PEERPID), so a process that relays the
// bridge's handshake to the real helper is refused. The bridge is launched by the browser, not by Caret, so the secret
// cannot reach it on an inherited descriptor the way the reader's does. The helper writes a page key beside page.sock
// instead: HMAC-SHA256(launch secret, PAGE_KEY_LABEL), so the file never holds the secret that authenticates the
// helper to the reader. It is a regular file only the user can read, in a directory only the user can write; the
// bridge refuses anything else. Every start of one launch writes the same key, so a bridge that read it just before a
// crash restart still matches. Neither side sends the key: each proves it holds it with an HMAC over both nonces.
// Node cannot read a Unix socket peer's uid or pid, so the helper's side of the peer check is the filesystem: the
// socket is 0600 in that directory. The bridge checks the helper's uid with getpeereid and its pid with LOCAL_PEERPID
// (bridge/Sources/CaretPageProtocol/Peer.swift). W3 replaces the key file with XPC and a code-signing requirement.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const BRIDGE_LABEL = "caret-page-bridge";
const HELPER_LABEL = "caret-page-helper";
const PAGE_KEY_LABEL = "caret-page-key";

/** The secret file that goes with a page socket. */
export function secretPathFor(socketPath: string): string {
  return `${socketPath}.key`;
}

export function newNonce(): string {
  return randomBytes(32).toString("hex");
}

/** The key page.sock's handshake uses for one launch: derived from the launch secret, never the secret itself. */
export function pageKey(launchSecret: Buffer): Buffer {
  if (launchSecret.length !== 32) throw new Error(`a launch secret is 32 bytes, not ${launchSecret.length}`);
  return createHmac("sha256", launchSecret).update(PAGE_KEY_LABEL, "utf8").digest();
}

function hmac(secret: Buffer, ...parts: string[]): string {
  return createHmac("sha256", secret).update(parts.join("\n"), "utf8").digest("hex");
}

/** What the bridge must send for this challenge and its own nonce. */
export function bridgeProof(secret: Buffer, challenge: string, bridgeNonce: string): string {
  return hmac(secret, BRIDGE_LABEL, challenge, bridgeNonce);
}

/** What the helper with process id `pid` answers, proving to the bridge it holds the same key. */
export function helperProof(secret: Buffer, challenge: string, bridgeNonce: string, pid: number): string {
  return hmac(secret, HELPER_LABEL, bridgeNonce, challenge, String(pid));
}

/** Constant-time comparison of two hex proofs. */
export function proofMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(given, "hex");
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

/**
 * Refuses a directory the bridge would refuse: not a directory, owned by someone else, or writable by group or
 * others (where another user could replace the socket or the secret).
 */
export function checkPrivateDir(dir: string): void {
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (process.getuid !== undefined && st.uid !== process.getuid()) throw new Error(`${dir} belongs to uid ${st.uid}, not this user`);
  if ((st.mode & 0o022) !== 0) throw new Error(`${dir} is writable by group or others (mode ${(st.mode & 0o777).toString(8)})`);
}

/**
 * Writes this launch's page key (pageKey) beside the socket, replacing any earlier file. The file is created
 * exclusively with mode 0600 after the old one is removed, so it never exists with wider permissions, and is never
 * followed through a symlink.
 */
export function writeSecret(socketPath: string, key: Buffer): void {
  const path = secretPathFor(socketPath);
  checkPrivateDir(dirname(path));
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, key.toString("hex"));
    const st = fstatSync(fd);
    if ((st.mode & 0o777) !== 0o600) throw new Error(`secret file came out with mode ${(st.mode & 0o777).toString(8)}`);
  } finally {
    closeSync(fd);
  }
}

/** Removes this run's secret, if it is still there. */
export function removeSecret(socketPath: string): void {
  try {
    unlinkSync(secretPathFor(socketPath));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
