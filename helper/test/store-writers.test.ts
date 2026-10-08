// INT1 review 2 P1: every file writer under helper/src holds its destination to the store path policy
// (privacy/store-path.ts). The writers are found in the code, not listed by hand: any file that calls a primitive that
// creates or changes a file or folder. Each found file must have an exerciser below, which aims it at a synced folder and
// expects SyncedStorePath before anything is created; a new writer without one fails the first test.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { storePathRefusal, SyncedStorePath } from "../src/privacy/store-path.ts";
import { Store } from "../src/store.ts";
import { MemoryStore } from "../src/patterns/memory.ts";
import { RecoveryJournal } from "../src/executor/journal.ts";
import { MemoryDocumentStore } from "../src/memory/documents.ts";
import { fileFailures, fileLog, filePace } from "../src/engines/decide/slow.ts";
import { DailySpend } from "../src/engines/decide/daily-cap.ts";
import { loadKey } from "../src/sealed.ts";
import { cachedAsk } from "../src/engines/decide/cache.ts";
import { HelperServer } from "../src/server.ts";
import { EngineServer } from "../src/engines/server.ts";
import { migrateSealedMemory } from "../src/memory/migrate.ts";
import { DatabaseSync } from "node:sqlite";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

/** A call that creates or changes a file or folder; a read-only open is not one. */
const WRITES = /\b(?:writeFileSync|appendFileSync|createWriteStream|renameSync|linkSync|copyFileSync|cpSync|symlinkSync|mkdirSync|mkdtempSync)\(|new DatabaseSync\(|openSync\([^)\n]*(?:O_CREAT|O_WRONLY|O_RDWR|O_APPEND|["'][wa]\+?["'])/u;

/** Files whose writes are the policy itself. */
const POLICY = new Set(["privacy/store-path.ts"]);

function writerFiles(): string[] {
  return files(SRC).map((f) => relative(SRC, f)).filter((f) => !POLICY.has(f) && WRITES.test(readFileSync(join(SRC, f), "utf8"))).sort();
}

// A folder the policy treats as synced (CARET_TEST_SYNCED_ROOT), inside the temporary directory: a writer that fails
// this test writes there, never into a real synced folder.
const tmp = mkdtempSync(join(tmpdir(), "store-writers-"));
const synced = join(tmp, "synced");
process.env.CARET_TEST_SYNCED_ROOT = synced;
const at = (name: string): string => join(synced, name);
afterAll(() => {
  delete process.env.CARET_TEST_SYNCED_ROOT;
  rmSync(tmp, { recursive: true, force: true });
});

/** Each writer aimed at a synced folder. Each must throw SyncedStorePath. */
const EXERCISE: Record<string, () => unknown> = {
  "store.ts": () => new Store(at("data")),
  "patterns/memory.ts": () => new MemoryStore(at("patterns")),
  "executor/journal.ts": () => new RecoveryJournal(at("journal")),
  "memory/documents.ts": () => new MemoryDocumentStore(at("Memory")),
  "engines/decide/slow.ts": () => {
    expect(() => filePace(at("pace.txt")).write?.(1)).toThrow(SyncedStorePath);
    expect(() => fileFailures(at("failures")).put("k", "e")).toThrow(SyncedStorePath);
    fileLog(at("slow.ndjson"))({ type: "x" } as never);
  },
  "engines/decide/daily-cap.ts": () => new DailySpend({ dir: at("spend"), capUsd: 1 }).reserve(0.01).settle(0.01, 1),
  "sealed.ts": () => loadKey(at("memory.key")),
  "engines/decide/cache.ts": () => cachedAsk(async () => ({ model: "m", answers: {}, inputTokens: 0, latencyMs: 0, costUsd: 0 }), { dir: at("cache"), mode: "record", engine: "canned", model: "m", fixture: { windows: () => true, plan: true } as never, env: {} } as never),
  "server.ts": () => new HelperServer(at("sockets/screen.sock"), () => null as never, () => undefined).listen(),
  "engines/server.ts": () => new EngineServer({ path: at("sockets/page.sock") } as never).listen(),
  "memory/migrate.ts": () => migrateSealedMemory({ db: new DatabaseSync(":memory:"), key: Buffer.alloc(32), dataDir: join(tmp, "data"), memoryDir: at("Memory"), now: 0 }),
};

describe("every file writer under helper/src holds its destination to the store path policy", () => {
  it("has an exerciser for every writer the code holds, and every writer uses the policy", () => {
    const found = writerFiles();
    expect(found.filter((f) => EXERCISE[f] === undefined)).toEqual([]);
    for (const f of found) expect(readFileSync(join(SRC, f), "utf8"), f).toMatch(/\b(?:assertLocalStorePath|writeLocalFile)\(/u);
  });

  for (const [file, run] of Object.entries(EXERCISE)) {
    it(`${file} refuses a synced folder before creating anything`, async () => {
      let threw: unknown = null;
      try {
        await run();
      } catch (e) {
        threw = e;
      }
      expect(threw, file).toBeInstanceOf(SyncedStorePath);
      expect(existsSync(synced)).toBe(false);
    });
  }

  it("treats the test's synced folder as synced, and a real one too", () => {
    expect(storePathRefusal(at("x.json"))).toMatch(/syncs to a provider/u);
    expect(storePathRefusal(join(homedir(), "Library", "CloudStorage", "Dropbox", "x.json"))).toMatch(/syncs to a provider/u);
  });

  it("the lint finds a new writer and a read-only open is not one", () => {
    expect(WRITES.test('appendFileSync(join(dir, "x.log"), line);')).toBe(true);
    expect(WRITES.test("const db = new DatabaseSync(path);")).toBe(true);
    expect(WRITES.test('const fd = openSync(path, "a");')).toBe(true);
    expect(WRITES.test("const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);")).toBe(false);
    expect(WRITES.test('const fd = openSync(path, "r");')).toBe(false);
  });
});
