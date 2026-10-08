// A store writes only under a local root that does not sync (privacy/store-path.ts): a file a sync client uploads
// leaves the Mac with no request made, so it would be a provider disclosure without the per-window budget.
import { constants, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { assertLocalStorePath, storePathRefusal, SyncedStorePath, writeLocalFile } from "../src/privacy/store-path.ts";
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

  // Independent of where HOME is (it may be inside the temporary directory): a folder at the filesystem's root is under
  // no store root.
  const outside = join(sep, `caret-store-path-outside-${process.pid}`);

  it("refuses any folder outside the roots", () => {
    expect(storePathRefusal(join(outside, "rows.json"))).toMatch(/outside the local store roots/u);
  });

  it("follows symlinks: a link inside the temporary directory to a folder outside the roots refuses", () => {
    const link = join(dir, "to-outside");
    symlinkSync(outside, link);
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

describe("INT1 review 2 P1: symlinks and .. cannot route a store into a synced folder", () => {
  // Links only: nothing is written there.
  const synced = join(h, "Library", "CloudStorage", "Dropbox-caret-store-path-test");

  it("refuses a dangling final symlink whose target is in a synced folder", () => {
    const link = join(dir, "dangling.json");
    symlinkSync(join(synced, "new.json"), link);
    expect(existsSync(link)).toBe(false);
    expect(storePathRefusal(link)).not.toBeNull();
    expect(() => writeStoreJson(link, { n: 1 })).toThrow(SyncedStorePath);
  });

  it("resolves a symlinked directory before '..', so to-sync/../rows.json is judged where it lands", () => {
    // The link points into a synced folder (which need not exist: nothing is written there).
    const link = join(dir, "to-sync");
    symlinkSync(join(synced, "sub"), link);
    expect(storePathRefusal(join(dir, "rows.json"))).toBeNull();
    expect(storePathRefusal(`${link}/../rows.json`)).not.toBeNull();
    expect(() => writeStore(`${link}/../rows.json`, "x")).toThrow(SyncedStorePath);
  });

  it("refuses a final symlink even to an allowed place: the write would follow it", () => {
    const real = join(dir, "real.json");
    writeStoreJson(real, { n: 1 });
    const link = join(dir, "link-to-real.json");
    symlinkSync(real, link);
    expect(() => writeStoreJson(link, { n: 2 })).toThrow(SyncedStorePath);
  });
});

describe("INT1 review 3: relative paths and hard links", () => {
  const synced = join(h, "Library", "CloudStorage", "Dropbox-caret-store-path-test");

  it("resolves a relative path's links before its '..', from the working folder as given", () => {
    const work = join(dir, "w", "sub");
    mkdirSync(work, { recursive: true });
    symlinkSync(join(synced, "inner"), join(work, "to-sync"));
    const was = process.cwd();
    process.chdir(work);
    try {
      expect(storePathRefusal("rows.json")).toBeNull();
      expect(storePathRefusal("to-sync/../rows.json")).toMatch(/syncs to a provider/u);
    } finally {
      process.chdir(was);
    }
  });

  it("refuses a file with another hard link, without truncating it", () => {
    const other = join(dir, "other-name.json");
    writeFileSync(other, "keep me");
    const p = join(dir, "hard.json");
    linkSync(other, p);
    expect(() => writeLocalFile(p, "x")).toThrow(SyncedStorePath);
    expect(readFileSync(other, "utf8")).toBe("keep me");
  });

  it("Node passes O_NOFOLLOW_ANY through: an open through a linked folder fails", () => {
    if (process.platform !== "darwin") return;
    mkdirSync(join(dir, "nfa-real"));
    symlinkSync(join(dir, "nfa-real"), join(dir, "nfa-link"));
    expect(() => openSync(join(dir, "nfa-link", "f"), constants.O_WRONLY | constants.O_CREAT | 0x20000000, 0o600)).toThrow(/ELOOP/u);
  });
});

describe("INT1 review 4: paths are compared as the volume stores them", () => {
  it("a synced folder spelled in another case is a synced folder (macOS volumes ignore case)", () => {
    if (process.platform !== "darwin") return;
    expect(storePathRefusal(join(h, "library", "cloudstorage", "Dropbox", "rows.json"))).toMatch(/syncs to a provider/u);
    expect(storePathRefusal(join(h, "LIBRARY", "Mobile Documents", "com~apple~CloudDocs", "rows.json"))).toMatch(/syncs to a provider/u);
  });

  it("a root spelled in another case is the root", () => {
    if (process.platform !== "darwin") return;
    expect(storePathRefusal(join(dir.toUpperCase(), "rows.json"))).toBeNull();
  });
});
