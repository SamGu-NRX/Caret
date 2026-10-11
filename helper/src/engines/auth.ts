// page.sock's handshake (protocol.ts EngineChallenge, EngineHello, EngineWelcome), on B23's scheme: the launch secret
// the launcher gave the helper and the reader, and a helper proof bound to the helper's process id, which the
// connecting side requires to be its socket's peer (LOCAL_PEERPID), so a process that relays the handshake to the real
// helper is refused. The key is pageKey(launch secret), HMAC-SHA256(secret, PAGE_KEY_LABEL), so a proof never exposes
// the secret that authenticates the helper to the reader. Neither side sends the key: each proves it holds it with an
// HMAC over both nonces.
//
// Since W3 the side that connects is the Caret host, relaying for a caret-bridge it verified over XPC with a
// code-signing requirement (bridge/Sources/CaretBridgeXPC). The host holds the launch secret in memory, so the key is
// never written anywhere: the `<socket>.key` file W1 wrote for the bridge is gone, because any process running as the
// user could read it (W1 review #1). Node cannot read a Unix socket peer's uid or pid, so the helper's side of the peer
// check is the filesystem: the socket is 0600 in a directory only the user can write.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";

const BRIDGE_LABEL = "caret-page-bridge";
const HELPER_LABEL = "caret-page-helper";
const PAGE_KEY_LABEL = "caret-page-key";

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

/**
 * What the connecting side must send for this challenge and its own nonce, bound to the pid of the helper it sees as its
 * socket's peer (LOCAL_PEERPID). The helper checks it with its own pid, so a same-user process that swapped the socket
 * path and passed the host's hello through to the real helper gets nothing: the host bound that hello to the swapper's
 * pid (W3 review #1). The helper's own proof is bound to its pid the other way.
 */
export function bridgeProof(secret: Buffer, challenge: string, bridgeNonce: string, helperPid: number): string {
  return hmac(secret, BRIDGE_LABEL, challenge, bridgeNonce, String(helperPid));
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
 * Removes a `<socket>.key` an earlier build wrote beside page.sock (W1 to I1), so no page key is left readable on disk.
 * Only that exact name is touched, and a missing file is fine.
 */
export function removeOldKeyFile(socketPath: string): void {
  try {
    unlinkSync(`${socketPath}.key`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
