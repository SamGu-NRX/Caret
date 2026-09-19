// Runs the whole pipeline without the web app. Live if TYPESAFE_API_KEY is set, mock otherwise.
import { writeFileSync } from "node:fs";
import { runPipeline } from "../lib/pipeline.ts";

const result = await runPipeline();
writeFileSync("last-run.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ status: result.status, mode: result.mode, summary: result.summary, holds: result.holds, dropped: result.dropped, reason: result.reason }, null, 2));
if (result.draft_reply) console.log("\n--- draft reply ---\n" + result.draft_reply.body);
