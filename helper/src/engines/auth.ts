// The page bridge's handshake (protocol.ts EngineChallenge, EngineHello, EngineWelcome). The bridge is launched by
// the browser, not by Caret, so the per-launch secret cannot reach it through an inherited descriptor the way the
// reader's will (B23). The helper writes a fresh secret beside page.sock at every start instead, as a regular file
// only the user can read, in a directory only the user can write; the bridge refuses a secret file or directory
// that is anything else. Neither side ever sends the secret: each proves it holds it with an HMAC over both
// nonces, so a process that took over the socket path cannot answer the bridge, and a client without the secret
// is refused before any page message. Node cannot read a Unix socket peer's uid, so the helper's side of the uid
// check is the filesystem: the socket is 0600 in that directory. The bridge checks the helper's uid with
// getpeereid (bridge/Sources/CaretPageProtocol/Peer.swift).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const BRIDGE_LABEL = "caret-page-bridge";
const HELPER_LABEL = "caret-page-helper";

/** The secret file that goes with a page socket. */
export function secretPathFor(socketPath: string): string {
  return `${socketPath}.key`;
}

export function newNonce(): string {
  return randomBytes(32).toString("hex");
}

function hmac(secret: Buffer, label: string, first: string, second: string): string {
  return createHmac("sha256", secret).update(`${label}\n${first}\n${second}`, "utf8").digest("hex");
}

/** What the bridge must send for this challenge and its own nonce. */
export function bridgeProof(secret: Buffer, challenge: string, bridgeNonce: string): string {
  return hmac(secret, BRIDGE_LABEL, challenge, bridgeNonce);
}

/** What the helper answers, proving to the bridge it holds the same secret. */
export function helperProof(secret: Buffer, challenge: string, bridgeNonce: string): string {
  return hmac(secret, HELPER_LABEL, bridgeNonce, challenge);
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
 * Writes a fresh 32-byte secret for this helper's run, replacing any earlier one, and returns it. The file is
 * created exclusively with mode 0600 after the old one is removed, so it never exists with wider permissions,
 * and is never followed through a symlink.
 */
export function writeSecret(socketPath: string): Buffer {
  const path = secretPathFor(socketPath);
  checkPrivateDir(dirname(path));
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const secret = randomBytes(32);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, secret.toString("hex"));
    const st = fstatSync(fd);
    if ((st.mode & 0o777) !== 0o600) throw new Error(`secret file came out with mode ${(st.mode & 0o777).toString(8)}`);
  } finally {
    closeSync(fd);
  }
  return secret;
}

/** Removes this run's secret, if it is still there. */
export function removeSecret(socketPath: string): void {
  try {
    unlinkSync(secretPathFor(socketPath));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
