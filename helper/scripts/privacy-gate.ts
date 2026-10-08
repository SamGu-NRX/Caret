// One refusal policy for packaging, make app, and the Caret target's always-run Xcode phase.
import { mkdirSync, readFileSync } from "node:fs";
import { writeStore } from "../src/privacy/send.ts";
import { dirname } from "node:path";
import { PRIVACY_PROMISE, ownerNoteGate } from "../src/privacy.ts";
import { PRIVACY_ACCEPTANCES } from "../src/privacy/accepted.ts";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const reasons: string[] = [];
const owner = ownerNoteGate();
if (owner !== null) reasons.push(owner);
const required = [
  ["pv2-sites-send", "PV2's Sites and send-boundary fixes aren't accepted yet; the promise's switched-off sentence isn't backed", "It sends nothing from an app or website you've switched off."],
  ["ha2-copied-conversation", "HA2's copied-conversation fix isn't accepted yet", "No request carries more than half of a conversation, counting repeated text once."],
] as const;
for (const [id, missing, sentence] of required) {
  const acceptance = PRIVACY_ACCEPTANCES[id];
  if (acceptance == null) reasons.push(`${missing} [${id} backs "${sentence}"]`);
  else if (!acceptance.commit?.trim() || !acceptance.by?.trim() || !acceptance.at?.trim() || Number.isNaN(Date.parse(acceptance.at))) {
    reasons.push(`${id} needs an acceptance record with commit, by and a valid at timestamp; it backs "${sentence}"`);
  }
}
const configuration = spawnSync("python3", [fileURLToPath(new URL("../../scripts/check_vercel_gemini.py", import.meta.url))], { encoding: "utf8" });
if (configuration.error || configuration.status !== 0) {
  reasons.push(configuration.error?.message ?? (configuration.stderr || configuration.stdout || "Cannot verify Vercel Gemini build configuration").trim());
}
const onboarding = spawnSync("python3", [fileURLToPath(new URL("../../scripts/check_onboarding_privacy.py", import.meta.url))], { encoding: "utf8" });
if (onboarding.error || onboarding.status !== 0) {
  reasons.push(onboarding.error?.message ?? (onboarding.stderr || onboarding.stdout || "Cannot verify onboarding privacy copy").trim());
}
if (reasons.length > 0) {
  for (const why of reasons) console.error(`privacy gate: refusing to package: ${why}`);
  process.exit(1);
}
// Generate only after every refusal check passes; this is the resource the onboarding owner must read.
const resource = process.env.CARET_PRIVACY_RESOURCE;
if (resource) {
  mkdirSync(dirname(resource), { recursive: true });
  // INT1: through privacy/send.ts, the one way a script writes a text file on v2/next (test/sc1-boundary.test.ts); the
  // read-back below still refuses a resource that differs from PRIVACY_PROMISE.
  writeStore(resource, PRIVACY_PROMISE, "utf8");
  if (readFileSync(resource, "utf8") !== PRIVACY_PROMISE) throw new Error(`${resource}: generated privacy resource differs from PRIVACY_PROMISE`);
}
console.log("privacy gate: disclosure, required acceptances and dev-only gateway configuration checked");
