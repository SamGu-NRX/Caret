// Execute the production gate against isolated source/config changes, never the app build.
import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(): string {
  const path = mkdtempSync(join(tmpdir(), "caret-gate-"));
  fixtures.push(path);
  for (const dir of ["helper/src", "helper/scripts", "scripts", "caret", "apps/mac/Sources/Caret", "apps/caret/Sources/CaretHost/Onboarding"]) mkdirSync(join(path, dir), { recursive: true });
  cpSync(join(root, "helper/src"), join(path, "helper/src"), { recursive: true });
  for (const file of ["helper/scripts/privacy-gate.ts", "scripts/check_vercel_gemini.py", "scripts/check_onboarding_privacy.py", "apps/mac/Sources/Caret/PermissionView.swift", "caret/completions.py", "apps/mac/Sources/Caret/Info.plist"]) cpSync(join(root, file), join(path, file));
  writeFileSync(join(path, VIEW), ONBOARDING);
  return path;
}
const VIEW = "apps/caret/Sources/CaretHost/Onboarding/OnboardingView.swift";
// The shape the gate requires of the real view: the binding reads only the resource, and the window renders it.
const ONBOARDING = `static let privacyLine = { () -> PrivacyPromise? in
    guard let url = Bundle.main.url(forResource: "PrivacyPromise", withExtension: "txt"),
          let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
    return PrivacyPromise(text)
  }()
  var promise = PermissionsScreen.privacyLine
  PrivacyPromiseText(promise: promise)`;
function acceptAll(path: string): void {
  mkdirSync(join(path, "helper/src/privacy"), { recursive: true });
  writeFileSync(join(path, "helper/src/privacy/accepted.ts"), 'export const PRIVACY_ACCEPTANCES = { "pv2-sites-send": { commit: "0123456789abcdef0123456789abcdef01234567", by: "fixture reviewer", at: "2026-10-07T00:00:00Z" }, "ha2-copied-conversation": { commit: "0123456789abcdef0123456789abcdef01234567", by: "fixture reviewer", at: "2026-10-07T00:00:00Z" } };\n');
}
function gate(path: string, enabled = "0", extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [join(path, "helper/scripts/privacy-gate.ts")], {
    encoding: "utf8", env: { ...process.env, CARET_DEV_VERCEL_GEMINI: enabled, CARET_PRIVACY_RESOURCE: join(path, "PrivacyPromise.txt"), ...extra },
  });
}
/** The finished-app check alone, as build-app.sh, the Xcode phase and package_mac.py run it once the app is assembled. */
function verify(path: string, shipped: string) {
  const env: Record<string, string | undefined> = { ...process.env, CARET_DEV_VERCEL_GEMINI: "0", CARET_VERIFY_PRIVACY_RESOURCE: shipped };
  delete env.CARET_PRIVACY_RESOURCE;
  return spawnSync(process.execPath, [join(path, "helper/scripts/privacy-gate.ts")], { encoding: "utf8", env });
}

describe("privacy build gate", () => {
  it("refuses PV2 independently of the owner-note disclosure", () => {
    const path = fixture(); acceptAll(path);
    const file = join(path, "helper/src/privacy/accepted.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace(/"pv2-sites-send": \{[^}]*\}/, '"pv2-sites-send": null'));
    const result = gate(path);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PV2's Sites and send-boundary fixes aren't accepted yet; the promise's switched-off sentence isn't backed");
    expect(result.stderr).not.toContain("OWNER_NOTE_DISCLOSURE");
  });
  it("refuses the copied-conversation condition independently of PV2", () => {
    const path = fixture(); acceptAll(path);
    const file = join(path, "helper/src/privacy/accepted.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace(/"ha2-copied-conversation": \{[^}]*\}/, '"ha2-copied-conversation": null'));
    const result = gate(path);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ha2-copied-conversation");
    expect(result.stderr).toContain("No request carries more than half of a conversation.");
    expect(result.stderr).not.toContain("pv2-sites-send");
  });
  it("refuses the owner-note disclosure independently of PV2", () => {
    const path = fixture(); acceptAll(path);
    const file = join(path, "helper/src/privacy.ts");
    // TODO(INT1): the allotment is 0 until re-expressed on the output-based ledger, and at 0 no disclosure is needed;
    // the gate is checked at the 2,000 Sam approved.
    writeFileSync(file, readFileSync(file, "utf8").replace(/export const OWNER_NOTE_DISCLOSURE: string \| null = "[^"\n]*";/, "export const OWNER_NOTE_DISCLOSURE: string | null = null;").replace("export const OWNER_NOTE_CHARS = 0;", "export const OWNER_NOTE_CHARS = 2000;"));
    expect(readFileSync(file, "utf8")).toContain("export const OWNER_NOTE_CHARS = 2000;");
    expect(gate(path).stderr).toContain("OWNER_NOTE_DISCLOSURE");
    expect(gate(path).status).toBe(1);
  });
  it("allows an accepted, disclosed tree with Gemini off", () => {
    const path = fixture(); acceptAll(path);
    expect(gate(path).status).toBe(0);
    const source = readFileSync(join(path, "helper/src/privacy.ts"), "utf8");
    expect(readFileSync(join(path, "PrivacyPromise.txt"), "utf8")).toBe(source.split("export const PRIVACY_PROMISE = `")[1]?.split("`;")[0]);
  });
  it("refuses an assembled app whose promise is missing, empty or different", () => {
    const path = fixture(); acceptAll(path);
    expect(gate(path).status).toBe(0);
    const shipped = join(path, "PrivacyPromise.txt");
    expect(verify(path, shipped).status).toBe(0);
    const cases: [string, () => void, string][] = [
      ["missing", () => rmSync(shipped), "is missing"],
      ["empty", () => writeFileSync(shipped, ""), "is empty"],
      ["whitespace", () => writeFileSync(shipped, "\n\n"), "is empty"],
      ["different", () => writeFileSync(shipped, "What Caret sends\n\nA sentence nobody approved."), "differs from PRIVACY_PROMISE"],
    ];
    for (const [, damage, why] of cases) {
      damage();
      const result = verify(path, shipped);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`privacy gate: refusing to package: the app's privacy promise ${shipped} ${why}`);
    }
  });
  it("refuses an onboarding binding with fallback text", () => {
    for (const fallback of ['return nil }', 'return PrivacyPromise("") }', 'return PrivacyPromise("Caret sends very little.") }']) {
      const path = fixture(); acceptAll(path);
      writeFileSync(join(path, VIEW), ONBOARDING.replace("return nil }", fallback));
      const result = gate(path);
      expect(result.status).toBe(fallback === "return nil }" ? 0 : 1);
      if (result.status === 1) expect(result.stderr).toContain("the onboarding copy must render PRIVACY_PROMISE");
    }
  });
  it("refuses an onboarding view that renders something other than the binding", () => {
    const path = fixture(); acceptAll(path);
    writeFileSync(join(path, VIEW), ONBOARDING.replace("PrivacyPromiseText(promise: promise)", "PrivacyPromiseText(promise: nil)"));
    expect(gate(path).status).toBe(1);
  });
  it("refuses a Gemini default changed to on", () => {
    const path = fixture(); acceptAll(path);
    const file = join(path, "caret/completions.py");
    writeFileSync(file, readFileSync(file, "utf8").replace("VERCEL_GEMINI_ENABLED = False", "VERCEL_GEMINI_ENABLED = True"));
    const result = gate(path);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("VERCEL_GEMINI_ENABLED must default to False");
  });
  it("refuses an enabled build environment", () => {
    const path = fixture(); acceptAll(path);
    const result = gate(path, "1");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CARET_DEV_VERCEL_GEMINI=1");
  });
  it("refuses a packaged launch environment enabling Gemini", () => {
    const path = fixture(); acceptAll(path);
    writeFileSync(join(path, "apps/mac/Sources/Caret/Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>LSEnvironment</key><dict><key>CARET_DEV_VERCEL_GEMINI</key><string>1</string></dict></dict></plist>');
    const result = gate(path);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LSEnvironment");
  });
});
