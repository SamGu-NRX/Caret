// apps/screen-reader/scripts/bundle-fixture.sh, run on a stand-in executable: the bundle has the
// identity macOS needs to activate the fixture, a copy of the executable rather than a link, and no
// Info.plist key that would fix its activation policy. Nothing is launched.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureExecutable } from "../scripts/fixture-path.ts";

const SCRIPT = fileURLToPath(new URL("../../apps/screen-reader/scripts/bundle-fixture.sh", import.meta.url));
const plist = (app: string, key: string): string => execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(app, "Contents/Info.plist")], { encoding: "utf8" }).trim();

describe("bundle-fixture.sh", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("wraps the executable in CaretFixture.app as dev.caret.fixture, and the scripts exec it there", () => {
    dir = mkdtempSync(join(tmpdir(), "caret-bundle-"));
    const bin = join(dir, "bin");
    execFileSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, "caret-fixture"), "#!/bin/sh\necho stand-in\n");
    chmodSync(join(bin, "caret-fixture"), 0o755);
    expect(() => fixtureExecutable(bin)).toThrow(/bundle-fixture\.sh/);

    const out = execFileSync("bash", [SCRIPT, bin], { encoding: "utf8" }).trim();
    const app = join(bin, "CaretFixture.app");
    expect(out).toBe(app);
    expect(plist(app, "CFBundleIdentifier")).toBe("dev.caret.fixture");
    expect(plist(app, "CFBundleExecutable")).toBe("caret-fixture");
    expect(plist(app, "CFBundlePackageType")).toBe("APPL");
    const xml = readFileSync(join(app, "Contents/Info.plist"), "utf8");
    expect(xml).not.toMatch(/LSUIElement|LSBackgroundOnly/);
    const exe = join(app, "Contents/MacOS/caret-fixture");
    expect(lstatSync(exe).isSymbolicLink()).toBe(false);
    expect(readFileSync(exe, "utf8")).toContain("stand-in");
    expect(fixtureExecutable(bin)).toBe(exe);

    // Bundling again replaces the old bundle.
    writeFileSync(join(bin, "caret-fixture"), "#!/bin/sh\necho second\n");
    execFileSync("bash", [SCRIPT, bin]);
    expect(readFileSync(exe, "utf8")).toContain("second");
  });

  it("refuses to bundle when there is no executable to wrap", () => {
    dir = mkdtempSync(join(tmpdir(), "caret-bundle-"));
    expect(() => execFileSync("bash", [SCRIPT, dir], { stdio: "pipe" })).toThrow(/no executable/);
    expect(existsSync(join(dir, "CaretFixture.app"))).toBe(false);
  });
});
