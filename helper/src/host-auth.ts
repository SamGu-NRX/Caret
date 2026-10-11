// The host's proof to the helper that it is the Caret that holds the launch secret (protocol.ts HostChallenge,
// HostProof, HostAuthenticated). Without it, any process of the same user could connect to screen.sock, say
// `host: true`, and be sent what Caret's Accessibility grant reads: the text around a page field's caret, saved
// answers, route decisions and goal previews.
//
// The key is hostKey(launch secret), HMAC-SHA256(secret, "caret-host-key"), separate from the reader's helperProof
// (server.ts) and page.sock's pageKey (engines/auth.ts), so no proof made with one key passes another check. Caret.app
// derives the same key from the secret it made (ServiceLauncher.swift); a development script gets it from
// src/launch.ts --host-key-fd. The host never sends the key, only an HMAC of the helper's per-connection nonce.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const HOST_KEY_LABEL = "caret-host-key";
const HOST_PROOF_LABEL = "caret-host-proof";

/** The host key for one launch: derived from the 32-byte launch secret, never the secret itself. */
export function hostKey(launchSecret: Buffer): Buffer {
  if (launchSecret.length !== 32) throw new Error(`a launch secret is 32 bytes, not ${launchSecret.length}`);
  return createHmac("sha256", launchSecret).update(HOST_KEY_LABEL, "utf8").digest();
}

/** A fresh challenge for one host connection: base64 of 32 random bytes. */
export function newHostNonce(): string {
  return randomBytes(32).toString("base64");
}

/** What the host answers the helper's `nonce` with: base64 HMAC-SHA256(hostKey, "caret-host-proof\n" + nonce). */
export function hostProof(key: Buffer, nonce: string): string {
  return proofBytes(key, nonce).toString("base64");
}

/** Whether `given` is the proof for `nonce` under `key`, compared in constant time. */
export function hostProofMatches(key: Buffer, nonce: string, given: string): boolean {
  const expected = proofBytes(key, nonce);
  const got = Buffer.from(given, "base64");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function proofBytes(key: Buffer, nonce: string): Buffer {
  return createHmac("sha256", key).update(`${HOST_PROOF_LABEL}\n${nonce}`, "utf8").digest();
}
