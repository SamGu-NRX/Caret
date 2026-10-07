import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// test/setup/no-groq.ts fails any test file that reads the Groq key (P1).
// test/setup/verifier.ts answers the write contract's verifier for every test file that does not pass its own (W2).
// J1: every Jev client adds to the day's spend file (engines/decide/daily-cap.ts); tests keep theirs out of the user's.
export default defineConfig({ test: { setupFiles: ["./test/setup/no-groq.ts", "./test/setup/verifier.ts"], env: { CARET_JEV_SPEND_DIR: join(tmpdir(), `caret-jev-spend-vitest-${process.pid}`) } } });
