// AES-256-GCM under the helper's local key file (mode 0600), shared by the memory store and the recovery
// journal (B23). Moved here from patterns/memory.ts unchanged, so both seal with the same key.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { assertLocalStorePath } from "./privacy/store-path.ts";

/** iv (12 bytes) | tag (16 bytes) | ciphertext. */
export function seal(key: Buffer, text: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function open(key: Buffer, b: Buffer): string {
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

/** The 32-byte key at `path`, created once with mode 0600. Any other length is refused. */
export function loadKey(path: string): Buffer {
  assertLocalStorePath(path);
  if (!existsSync(path)) {
    try {
      // Exclusive create: two helpers starting at once must not each write a different key.
      writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  chmodSync(path, 0o600);
  const b = readFileSync(path);
  if (b.length !== 32) throw new Error(`memory key ${path} is ${b.length} bytes, expected 32; refusing to use it`);
  return b;
}
