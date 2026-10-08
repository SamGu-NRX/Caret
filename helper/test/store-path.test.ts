// A store writes only under a local root that does not sync (privacy/store-path.ts): a file a sync client uploads
// leaves the Mac with no request made, so it would be a provider disclosure without the per-window budget.
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { assertLocalStorePath, storePathRefusal, SyncedStorePath } from "../src/privacy/store-path.ts";
import { appendStore, writeStore, writeStoreJson } from "../src/privacy/send.ts";

const dir = mkdtempSync(join(tmpdir(), "store-path-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const h = homedir();

describe("the store path check", () => {
  it("allows the evidence root, the temporary directory and the repository", () => {
    expect(storePathRefusal(join(h, ".caret-run", "evidence", "screen", "x", "rows.json"))).toBeNull();
    expect(storePathRefusal(join(dir, "a", "b.ndjson"))).toBeNull();
    expect(storePathRefusal(fileURLToPath(new URL("../../fixtures/realfill/new.ndjson", import.meta.url)))).toBeNull();
  });

  it("refuses iCloud Drive, File Provider and home-folder sync mounts, whether or not the file exists yet", () => {
    for (const p of [
      join(h, "Library", "Mobile Documents", "com~apple~CloudDocs", "rows.json"),
      join(h, "Library", "CloudStorage", "Dropbox", "rows.json"),
      join(h, "Library", "CloudStorage", "OneDrive-Personal", "rows.json"),
      join(h, "Library", "CloudStorage", "GoogleDrive-sam@example.test", "My Drive", "rows.json"),
      join(h, "Dropbox", "evidence", "rows.json"),
      join(h, "Google Drive", "rows.json"),
      join(h, "OneDrive - Example", "rows.json"),
    ]) expect(storePathRefusal(p), p).toMatch(/syncs to a provider/u);
  });

  it("refuses any other folder, such as Documents or Desktop, which macOS can sync to iCloud", () => {
    expect(storePathRefusal(join(h, "Documents", "rows.json"))).toMatch(/outside the local store roots/u);
    expect(storePathRefusal(join(h, "Desktop", "rows.json"))).toMatch(/outside the local store roots/u);
  });

  it("follows symlinks: a link inside the temporary directory to a folder outside the roots refuses", () => {
    const target = join(h, "Desktop");
    if (!existsSync(target)) return;
    const link = join(dir, "to-desktop");
    symlinkSync(target, link);
    expect(storePathRefusal(join(link, "rows.json"))).toMatch(/outside the local store roots/u);
    expect(() => assertLocalStorePath(join(link, "rows.json"))).toThrow(SyncedStorePath);
  });

  it("is asserted by every store before it writes", () => {
    const p = join(h, "Library", "Mobile Documents", "com~apple~CloudDocs", "caret-store-path-test.json");
    expect(() => writeStore(p, "x")).toThrow(SyncedStorePath);
    expect(() => appendStore(p, "x")).toThrow(SyncedStorePath);
    expect(() => writeStoreJson(p, { n: 1 })).toThrow(SyncedStorePath);
    expect(existsSync(p)).toBe(false);
    writeStoreJson(join(dir, "ok.json"), { n: 1 });
    expect(existsSync(join(dir, "ok.json"))).toBe(true);
  });
});
