// Apple's on-device model as a decision engine (J1 part B): the availability check only. The engine is not built,
// since the model cannot answer on Sam's Mac today (Apple Intelligence is off; see appleAvailability).
//
// Design, for when it can answer:
// - Where: in the host, not the helper. The Foundation Models framework is Swift-only and runs in the calling app's
//   process, so the host answers a decide request the way it answers L1's localTextRequest (writer/local-port.ts): the
//   helper sends the request, the host runs it and replies. Text stays on the Mac (reach "mac").
// - Prompt: as llama.ts lays it out, one session per request: instructions with the state and the labelled options once,
//   then one respond(to:generating:) per question, so the session's transcript carries the prefix.
// - Answer: guided generation constrains the reply to the question's labels, a @Generable enum built per question
//   (DynamicGenerationSchema, since the labels change by request).
// - Confidence: the framework gives no token probabilities, so a label's probability is its share of k replies, each
//   sampled with GenerationOptions(sampling: .random(...)), and confidence follows confidence.ts from those
//   shares. Five replies a question would make a fill of 18 fields 90 generations; that needs measuring before it is chosen.
//   Callers' dual asks still have to agree, as for every engine.
// - The context window is 4,096 tokens, under one large fill request's prefix (about 13,000 tokens for the corpus's
//   rental application, evidence/screen/j1), so a request over it is split by field or refused as too long.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export type AppleAvailability = { available: true } | { available: false; reason: string };

const SCRIPT = fileURLToPath(new URL("./apple-availability.swift", import.meta.url));

/** Whether the on-device model can answer on this Mac, from the framework itself (a Swift compile; seconds). */
export function appleAvailability(): Promise<AppleAvailability> {
  return new Promise((resolve, reject) => {
    execFile("xcrun", ["swift", SCRIPT], { timeout: 180_000 }, (err, stdout, stderr) => {
      if (err !== null) return reject(new Error(`the availability check did not run: ${stderr.trim().slice(0, 300) || err.message}`));
      const line = stdout.trim();
      if (line === "available") return resolve({ available: true });
      const m = /^unavailable (.+)$/.exec(line);
      if (m?.[1] === undefined) return reject(new Error(`the availability check printed '${line.slice(0, 120)}'`));
      resolve({ available: false, reason: m[1] });
    });
  });
}
