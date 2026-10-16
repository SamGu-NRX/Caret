import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { appOff, DEFAULT_APPS_OFF, readAppsOff } from "../src/privacy/read-policy.ts";
import { snap, text } from "./builders.ts";

const dirs: string[] = [];
function denyFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "caret-required-apps-"));
  dirs.push(dir);
  const path = join(dir, "deny-apps.txt");
  writeFileSync(path, body);
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const required = ["com.apple.Terminal", "com.apple.systempreferences", "dev.caret.host"];
function expectModelDenies(prefixes: readonly string[], bundleId: string): void {
  const model = new ScreenModel();
  model.setAppsOff(prefixes);
  model.apply(snap([text("t", "Synthetic window")], {
    at: 1000, app: { pid: 8100, bundleId, name: "Synthetic app" }, windowId: "excluded",
  }));
  expect(model.windows.has("excluded"), bundleId).toBe(false);
}

describe("required app exclusions", () => {
  it.each(required)("a password-manager-only file still denies %s", (bundleId) => {
    const body = "# beta.1 exclusions\ncom.1password\ncom.bitwarden.desktop\n";
    const path = denyFile(body);
    const prefixes = readAppsOff(path)!;
    expectModelDenies(prefixes, bundleId);
    expect(readFileSync(path, "utf8")).toBe(body);
  });

  it("editing the file cannot remove any required entry", () => {
    const path = denyFile(DEFAULT_APPS_OFF.join("\n"));
    for (const bundleId of DEFAULT_APPS_OFF) expectModelDenies(readAppsOff(path)!, bundleId);
    writeFileSync(path, "# all required entries removed\n");
    for (const bundleId of DEFAULT_APPS_OFF) expectModelDenies(readAppsOff(path)!, bundleId);
    expect(readFileSync(path, "utf8")).toBe("# all required entries removed\n");
  });

  it("keeps user additions and dot-separated descendants, not siblings", () => {
    const path = denyFile("# local additions\n  dev.example.private  \n\n");
    const prefixes = readAppsOff(path)!;
    expectModelDenies(prefixes, "dev.example.private");
    expectModelDenies(prefixes, "dev.example.private.child");
    expect(appOff("dev.example.privatex", prefixes)).toBe(false);
  });

  it("a caller cannot remove the required set by replacing model exclusions", () => {
    for (const bundleId of DEFAULT_APPS_OFF) expectModelDenies([], bundleId);
  });

  it("an unreadable file remains an error", () => {
    const path = denyFile("");
    rmSync(path);
    mkdirSync(path);
    expect(() => readAppsOff(path)).toThrow();
  });

  it("a missing file still uses model defaults without writing the file", () => {
    const path = denyFile("");
    rmSync(path);
    expect(readAppsOff(path)).toBeNull();
    const model = new ScreenModel();
    model.apply(snap([text("t", "Synthetic window")], {
      at: 1000, app: { pid: 8100, bundleId: "com.apple.Terminal", name: "Terminal" }, windowId: "excluded",
    }));
    expect(model.windows.has("excluded")).toBe(false);
    expect(() => readFileSync(path)).toThrow();
  });
});
