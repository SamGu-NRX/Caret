// Sam's rule for P1: no Groq. Every test file runs with process.env behind this guard, so any read of GROQ_API_KEY (how
// writer/env.ts readKey and main.ts look for it) throws, and a read that something caught still fails the file. The
// variable is removed first, so copying the environment for a child process never trips it.
import { afterAll } from "vitest";

export const GROQ_KEY = "GROQ_API_KEY";
/** Stacks of every read in this file; test/no-groq.test.ts empties it after reading on purpose. */
export const GROQ_READS = Symbol.for("caret.test.groqReads");

const reads: string[] = [];
(globalThis as Record<symbol, unknown>)[GROQ_READS] = reads;
delete process.env[GROQ_KEY];
const env = process.env;
process.env = new Proxy(env, {
  get(target, prop, receiver) {
    if (prop === GROQ_KEY) {
      reads.push(new Error("read").stack ?? "");
      throw new Error(`${GROQ_KEY} was read in the test suite; Caret's tests use no Groq key`);
    }
    return Reflect.get(target, prop, receiver);
  },
});

afterAll(() => {
  if (reads.length > 0) throw new Error(`${GROQ_KEY} was read ${reads.length} time(s) in this file, first at: ${reads[0]}`);
});
