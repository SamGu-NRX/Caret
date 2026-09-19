// Runs Paul Gettel's jev-scheduler pipeline once and prints its result as JSON.
//
// Why a wrapper at all: runPipeline() takes no arguments, resolves its input
// files from process.cwd(), and posts to SCHEDULE_WEBHOOK_URL when that
// variable is set. None of that can be configured at the call site, so the
// only way to invoke his code without editing it is to control the process it
// runs in. This wrapper is that process. It does not reimplement his planner
// and does not copy his files.
//
// What it guarantees before calling him:
//   - SCHEDULE_WEBHOOK_URL is absent, so the POST branch cannot be reached.
//     The wrapper refuses to start if the caller left it set.
//   - JEV_MOCK=1 and no TYPESAFE_API_KEY, so his Jev client stays in its own
//     deterministic mock mode and makes no network call.
//   - cwd is his checkout, because that is where his loader looks for inputs.
//     runPipeline() writes no files, so this stays a read-only use of it.
//
// Usage: node scripts/paul_scheduler_bridge.mjs <path-to-jev-scheduler>
// Output on stdout: {"ok":true,"result":{...}} or {"ok":false,"error":"..."}

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  process.exit(1);
}

const root = process.argv[2];
if (!root) fail("Usage: paul_scheduler_bridge.mjs <path-to-jev-scheduler>");

if (process.env.SCHEDULE_WEBHOOK_URL) {
  fail(
    "SCHEDULE_WEBHOOK_URL is set. This adapter runs the sample pipeline only and refuses " +
      "to run in an environment where his webhook branch could fire."
  );
}

const pipeline = path.join(root, "lib", "pipeline.ts");
if (!existsSync(pipeline)) fail(`No jev-scheduler pipeline at ${pipeline}`);

process.env.JEV_MOCK = "1";
delete process.env.TYPESAFE_API_KEY;

try {
  // His loader captures process.cwd() when the module is evaluated, so the
  // directory has to be set before the import, not before the call.
  process.chdir(root);
  const { runPipeline } = await import(pathToFileURL(pipeline).href);
  if (typeof runPipeline !== "function") {
    fail("jev-scheduler no longer exports runPipeline()");
  }
  const result = await runPipeline();
  process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
} catch (error) {
  fail(`${error && error.name ? error.name : "Error"}: ${error && error.message ? error.message : error}`);
}
