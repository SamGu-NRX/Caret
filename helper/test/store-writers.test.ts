// Every file a helper store writes goes through privacy/store-path.ts, which holds it to local, non-synced roots. The
// guarantee is structural: outside ALLOWED, each with its reason, no module under helper/src imports anything from node:fs
// but the functions that cannot write a file's content, or anything from node:sqlite (test/fs-writers.ts). The allowed
// modules that write check their own paths, so each is aimed below at a folder outside every root and must refuse.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { storePathRefusal, SyncedStorePath } from "../src/privacy/store-path.ts";
import { Store } from "../src/store.ts";
import { MemoryStore } from "../src/patterns/memory.ts";
import { RecoveryJournal } from "../src/executor/journal.ts";
import { MemoryDocumentStore } from "../src/memory/documents.ts";
import { migrateSealedMemory } from "../src/memory/migrate.ts";
import { seal } from "../src/sealed.ts";
import { fsImportViolations } from "./fs-writers.ts";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

/** Modules that may use a write-capable fs function themselves, and why. */
const ALLOWED: Readonly<Record<string, string>> = {
  "privacy/store-path.ts": "the checked writer itself",
  "memory/documents.ts": "the memory store's install protocol: writeSync on a descriptor openLocalFile opened, and rename and link of its own files inside the memory folder, which its constructor checks",
  "store.ts": "opens its SQLite database at a checked path; SQLite writes only through that file and its -wal and -shm beside it",
  "patterns/memory.ts": "opens its SQLite database at a checked path; SQLite writes only through that file and its -wal and -shm beside it",
  "executor/journal.ts": "opens its SQLite database at a checked path; SQLite writes only through that file and its -wal and -shm beside it",
  "engines/attach.ts": "opens an attachment read-only (O_RDONLY | O_NOFOLLOW) to check and read it; writes nothing",
  "launch.ts": "writeSync of the 32-byte host key to the descriptor its parent named with --host-key-fd, then closes it; opens no path",
};

// A folder at the filesystem's root is outside every root wherever HOME is, and this user cannot create it: a module
// that fails to refuse throws EACCES, not SyncedStorePath, and writes nothing.
const outside = join(sep, `caret-store-writers-${process.pid}`);
const tmp = mkdtempSync(join(tmpdir(), "store-writers-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const REFUSES: Record<string, () => unknown> = {
  "store.ts": () => new Store(join(outside, "data")),
  "patterns/memory.ts": () => new MemoryStore(join(outside, "patterns")),
  "executor/journal.ts": () => new RecoveryJournal(join(outside, "journal")),
  "memory/documents.ts": () => new MemoryDocumentStore(join(outside, "Memory")),
};

describe("every file a helper store writes goes through the checked writer", () => {
  it("no module outside the allowlist imports a function that can write a file", () => {
    const found = files(SRC).map((f) => relative(SRC, f)).flatMap((f) => (ALLOWED[f] !== undefined ? [] : fsImportViolations(readFileSync(join(SRC, f), "utf8")).map((w) => `${f}: ${w}`)));
    expect(found).toEqual([]);
  });

  it("every allowed module other than the writer refuses a folder outside the roots", () => {
    // attach.ts writes nothing and launch.ts writes only to a descriptor its parent passed: neither takes a path to refuse.
    expect(Object.keys(ALLOWED).filter((f) => f !== "privacy/store-path.ts" && f !== "engines/attach.ts" && f !== "launch.ts").sort()).toEqual(Object.keys(REFUSES).sort());
    for (const [file, run] of Object.entries(REFUSES)) expect(run, file).toThrow(SyncedStorePath);
  });

  it("the memory migration refuses a staging folder outside the roots, when the memory folder is itself a root", () => {
    // Run with HOME in a folder outside every root, so the app's own memory folder (a root) has a parent that is not one:
    // the staging folder made beside it would fall outside every root. A child process, so HOME is its own.
    const home = join(homedir(), `.caret-store-writers-home-${process.pid}`);
    if (storePathRefusal(join(home, "x")) === null) return;
    const data = join(tmp, "data");
    new MemoryStore(data).close();
    const key = readFileSync(join(data, "memory.key"));
    const db = new DatabaseSync(join(data, "memory.sqlite"));
    db.exec("DELETE FROM meta");
    db.prepare("INSERT INTO memory (id, kind, paused, match, fields, sealed, count, first_seen, last_seen, app) VALUES (?, 'about', 0, 'm', NULL, ?, 1, 1, 1, NULL)").run("about-1a2b3c4d", seal(key, JSON.stringify({ label: "Name", value: "Dana Whitfield", source: "typed" })));
    db.close();
    const script = `
      const { DatabaseSync } = require("node:sqlite");
      const { readFileSync } = require("node:fs");
      const { join } = require("node:path");
      const { migrateSealedMemory } = require(${JSON.stringify(fileURLToPath(new URL("../src/memory/migrate.ts", import.meta.url)))});
      const data = ${JSON.stringify(data)};
      try {
        migrateSealedMemory({ db: new DatabaseSync(join(data, "memory.sqlite")), key: readFileSync(join(data, "memory.key")), dataDir: data, memoryDir: join(process.env.HOME, "Library", "Application Support", "Caret"), now: 0 });
        console.log("no refusal");
      } catch (e) { console.log(e.name); }`;
    try {
      mkdirSync(home);
      const r = spawnSync(process.execPath, ["--no-warnings", "-e", script], { env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmpdir() }, encoding: "utf8" });
      expect(`${r.stdout.trim()} ${r.stderr.slice(0, 200)}`.trim()).toBe("SyncedStorePath");
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the import rule refuses every binding but the permitted ones, however it is spelled", () => {
    const breaks = (src: string): boolean => fsImportViolations(src).length > 0;
    for (const src of [
      'import { appendFileSync } from "node:fs";',
      'import { openSync as open } from "node:fs";',
      'import { promises } from "node:fs";',
      'import * as fs from "node:fs";',
      'import fs from "fs";',
      'import { writeFile } from "node:fs/promises";',
      'import { readFileSync, renameSync } from "node:fs";',
      'export { writeFileSync } from "node:fs";',
      'export * from "node:fs/promises";',
      'const fs = await import("node:fs");',
      'const fs = require("node:fs");',
      'const m = require(name);',
      'import { createRequire } from "node:module"; const r = createRequire(import.meta.url);',
      'import * as mod from "module";',
      'const { createRequire } = await import("node:module");',
      'const mod = require("node:module");',
      'export { createRequire } from "node:module";',
      'export * from "module";',
      'import { DatabaseSync } from "node:sqlite";',
    ]) expect(breaks(src), src).toBe(true);
    for (const src of [
      'import { readFileSync as read, existsSync, constants } from "node:fs"; import type { Stats } from "node:fs";',
      'import type { DatabaseSync } from "node:sqlite";',
      'const s = require("node:path");',
      'import { stripTypeScriptTypes } from "node:module";',
    ]) expect(breaks(src), src).toBe(false);
  });
});
