// A generated launch secret is written as it is (privacy/local-secret.ts): no format withholding, and only bytes
// newLocalSecret made in this process, unchanged.
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { newLocalSecret, NotALocalSecret, writeLocalSecretFile } from "../src/privacy/local-secret.ts";
import { newLaunchSecret } from "../src/launch.ts";
import { withholdValues } from "../src/privacy/exclude.ts";

const dir = mkdtempSync(join(tmpdir(), "local-secret-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A generated secret whose hex the store path's withholder would change, found by drawing (about 1 in 200 do). */
function alteredSecret(): Buffer {
  for (let i = 0; i < 20_000; i++) {
    const s = newLaunchSecret();
    if (withholdValues(s.toString("hex")) !== s.toString("hex")) return s;
  }
  throw new Error("no generated secret in 20,000 draws that the withholder alters");
}

describe("writeLocalSecretFile", () => {
  it("writes a secret the withholder would alter exactly as generated, readable by this user only", () => {
    const s = alteredSecret();
    const p = join(dir, "launch-secret");
    writeLocalSecretFile(p, s);
    expect(readFileSync(p, "utf8")).toBe(s.toString("hex"));
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("refuses bytes this process did not generate, and a generated secret changed since", () => {
    const p = join(dir, "refused");
    expect(() => writeLocalSecretFile(p, Buffer.from("4111111111111111", "utf8"))).toThrow(NotALocalSecret);
    expect(() => writeLocalSecretFile(p, Buffer.from(newLocalSecret()))).toThrow(NotALocalSecret);
    const s = newLocalSecret();
    s.write("hunter2");
    expect(() => writeLocalSecretFile(p, s)).toThrow(NotALocalSecret);
    expect(existsSync(p)).toBe(false);
  });

  it("generates only a secret's size of bytes", () => {
    expect(newLocalSecret().length).toBe(32);
    expect(() => newLocalSecret(4)).toThrow(RangeError);
  });
});
