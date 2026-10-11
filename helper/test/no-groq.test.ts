// P1: no Groq key is read anywhere in the suite. test/setup/no-groq.ts guards every file; this checks the guard is on,
// and that the way the helper reads a route's key (writer/env.ts readKey) is caught by it, in the environment and in a
// .env file alike.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readKey } from "../src/writer/env.ts";
import { GROQ_GPT_OSS_120B, GROQ_QWEN_3_8_27B } from "../src/writer/config.ts";
import { GROQ_KEY, GROQ_READS } from "./setup/no-groq.ts";

const reads = (): string[] => (globalThis as Record<symbol, string[]>)[GROQ_READS] as string[];

describe("no Groq key in the suite", () => {
  // Each read below is on purpose; emptied so the guard's end-of-file check passes for this file alone.
  afterEach(() => void reads().splice(0));

  it("throws on any read of the key from the environment, and records it", () => {
    expect(() => process.env[GROQ_KEY]).toThrow(/was read in the test suite/);
    expect(reads()).toHaveLength(1);
    expect(GROQ_KEY in process.env).toBe(false);
  });

  it("catches readKey for the Groq routes, even with a .env file that defines the key", () => {
    const dir = mkdtempSync(join(tmpdir(), "caret-no-groq-"));
    const file = join(dir, ".env");
    writeFileSync(file, `${GROQ_KEY}=not-a-real-key\n`);
    const was = process.env.CARET_ENV_FILE;
    process.env.CARET_ENV_FILE = file;
    try {
      for (const route of [GROQ_GPT_OSS_120B, GROQ_QWEN_3_8_27B]) expect(() => readKey(route.keyName)).toThrow(/was read in the test suite/);
      expect(reads()).toHaveLength(2);
    } finally {
      if (was === undefined) delete process.env.CARET_ENV_FILE;
      else process.env.CARET_ENV_FILE = was;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
