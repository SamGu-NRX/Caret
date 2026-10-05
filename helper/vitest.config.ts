import { defineConfig } from "vitest/config";

// test/setup/no-groq.ts fails any test file that reads the Groq key (P1).
export default defineConfig({ test: { setupFiles: ["./test/setup/no-groq.ts"] } });
