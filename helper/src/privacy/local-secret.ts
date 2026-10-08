// A credential this process generated, written to a local file as it is: the launch secret a test host reads with
// --secret-file (fixtures/web-form page-loop-eval.ts, tab-source-journey.ts). It is random bytes, never model or screen
// text, so the store path's format withholding (privacy/send.ts writeStore) has nothing to protect in it and can only
// break it: a 32-byte secret's hex can read as a card number or a token and be replaced, and the host then fails to
// authenticate. So this path does no withholding, and takes only bytes newLocalSecret made in this process, unchanged.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

/** Each secret newLocalSecret made, with a copy of its bytes as made, so a buffer changed since cannot be written. */
const MADE = new WeakMap<Buffer, Buffer>();

/** `bytes` random bytes, registered as this process's own generated secret. */
export function newLocalSecret(bytes = 32): Buffer {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 1024) throw new RangeError("newLocalSecret takes 16 to 1024 bytes");
  const s = randomBytes(bytes);
  MADE.set(s, Buffer.from(s));
  return s;
}

/** A buffer that newLocalSecret did not make, or that changed after it made it: refused, nothing written. */
export class NotALocalSecret extends Error {
  constructor() {
    super("writeLocalSecretFile writes only a secret newLocalSecret made in this process, unchanged; nothing was written");
    this.name = "NotALocalSecret";
  }
}

/** Writes a generated secret's hex to `path`, readable by this user only, with no withholding. */
export function writeLocalSecretFile(path: string, secret: Buffer): void {
  const made = MADE.get(secret);
  if (made === undefined || !made.equals(secret)) throw new NotALocalSecret();
  writeFileSync(path, secret.toString("hex"), { mode: 0o600 });
}
