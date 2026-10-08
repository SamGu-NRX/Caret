// One refusal policy for packaging, make app, and the Caret target's always-run Xcode phase.
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { writeStore } from "../src/privacy/send.ts";
import { dirname, join, resolve, sep } from "node:path";
import { PRIVACY_PROMISE, ownerNoteGate } from "../src/privacy.ts";
import { PRIVACY_ACCEPTANCES } from "../src/privacy/accepted.ts";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const reasons: string[] = [];
const owner = ownerNoteGate();
if (owner !== null) reasons.push(owner);
const required = [
  ["pv2-sites-send", "PV2's Sites and send-boundary fixes aren't accepted yet; the promise's switched-off sentence isn't backed", "It sends nothing from an app or website you've switched off."],
  ["ha2-copied-conversation", "HA2's copied-conversation fix isn't accepted yet", "No request carries more than half of a conversation."],
] as const;
// Internal VM and test builds use synthetic data and are never distributed, so the release acceptance records don't
// apply to them. build-app.sh sets this for debug and acceptance only and stamps their bundles CaretInternalBuild.
const internal = process.env.CARET_INTERNAL_BUILD === "1";
for (const [id, missing, sentence] of internal ? [] : required) {
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
// A verification run checks what the app already holds; one that also generated could write the file it is checking.
if (process.env.CARET_VERIFY_PRIVACY_RESOURCE && process.env.CARET_PRIVACY_RESOURCE) {
  reasons.push("CARET_PRIVACY_RESOURCE is set in a run that verifies the app's privacy promise; a verification run must not write it");
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
// The finished app's copy, checked after every step that could drop or replace it and before the app is signed or
// handed on. Onboarding has no text of its own to show in its place (OnboardingView.swift, PermissionsScreen).
const shipped = process.env.CARET_VERIFY_PRIVACY_RESOURCE;
if (shipped) {
  const checked = shippedApp(shipped);
  if ("problem" in checked) {
    console.error(`privacy gate: refusing to package: the app's privacy promise ${shipped} ${checked.problem}; onboarding would have nothing approved to show`);
    process.exit(1);
  }
  const stamp = internalStamp(checked.app);
  const why = typeof stamp === "string" ? stamp
    : stamp && !internal ? `${checked.app} is stamped CaretInternalBuild; internal builds are never distributed`
    : !stamp && internal ? `${checked.app} is an internal build without the CaretInternalBuild stamp`
    : null;
  if (why !== null) {
    console.error(`privacy gate: refusing to package: ${why}`);
    process.exit(1);
  }
}

/** The .app holding the promise, or why its copy cannot be shown: <name>.app/Contents/Resources/PrivacyPromise.txt, a regular file inside that app, with exactly PRIVACY_PROMISE. */
function shippedApp(path: string): { app: string } | { problem: string } {
  const file = resolve(path);
  const app = dirname(dirname(dirname(file)));
  if (!app.endsWith(".app") || file !== join(app, "Contents", "Resources", "PrivacyPromise.txt")) return { problem: "is not at <name>.app/Contents/Resources/PrivacyPromise.txt" };
  let stat;
  try { stat = lstatSync(file); } catch { return { problem: "is missing" }; }
  if (stat.isSymbolicLink()) return { problem: "is a symbolic link; the app must hold the file itself" };
  if (!stat.isFile()) return { problem: "is not a regular file" };
  if (!realpathSync(file).startsWith(realpathSync(app) + sep)) return { problem: `is outside ${app}` };
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return { problem: "is empty" };
  if (text !== PRIVACY_PROMISE) return { problem: "differs from PRIVACY_PROMISE in helper/src/privacy.ts" };
  return { app };
}

/** Whether the app's Info.plist carries CaretInternalBuild, or why it cannot be read. Python's plistlib reads XML and binary plists on any platform. */
function internalStamp(app: string): boolean | string {
  const plist = join(app, "Contents", "Info.plist");
  const read = spawnSync("python3", ["-c", [
    "import json, plistlib, sys",
    "with open(sys.argv[1], 'rb') as f: info = plistlib.load(f)",
    "if not isinstance(info, dict): sys.exit('not a dictionary')",
    "print(json.dumps(info.get('CaretInternalBuild', False)))",
  ].join("\n"), plist], { encoding: "utf8" });
  if (read.error || read.status !== 0) return `cannot read ${plist}: ${(read.error?.message ?? read.stderr.trim().split("\n").at(-1)) || "unknown error"}`;
  const value: unknown = JSON.parse(read.stdout);
  return typeof value === "boolean" ? value : `${plist}: CaretInternalBuild must be a boolean`;
}
console.log("privacy gate: disclosure, required acceptances and dev-only gateway configuration checked");
