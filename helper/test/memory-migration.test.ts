// M1 migration: the sealed store moves to markdown once, automatically and silently, or not at all. Each test builds a
// sealed store from before M1 in a fresh temporary directory; nothing here opens the user's real memory.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/patterns/memory.ts";
import { parseDocument } from "../src/memory/parse.ts";
import { seal } from "../src/sealed.ts";

interface Legacy {
  id: string;
  kind: "about" | "people" | "preference" | "skill" | "routine";
  match: string;
  fields: unknown;
  paused?: boolean;
  app?: string | null;
  at?: number;
}

const ROUTINE_STEP = { shapeHash: "s", srcBundle: "a", srcApp: "A", srcWindowKind: "standard", srcTemplateHash: "t", srcPos: 0, part: "whole", dstBundle: "b", dstApp: "Tracker", dstWindowKind: "standard", dstTemplateHash: "u", dstPos: 0 };
const SKILL_JSON = { routineId: "routine-1a2b3c4d", name: "Copy tracking", trigger: "a Tracker window opens with Order empty", runs: 4, cleanRuns: 3, needed: 3, onItsOwn: true, handsOff: null, wrote: ["writeElsewhere"], promote: null };
const ROWS: Legacy[] = [
  { id: "about-1a2b3c4d", kind: "about", match: "m1", fields: { label: "Name", value: "Dana Whitfield", source: "typed" }, at: 1_790_000_001_000 },
  { id: "about-5e6f7a8b", kind: "about", match: "m2", fields: { label: "Guest", value: " Marcus Lowe (ops) ", source: "edit" }, app: "Mail Fixture", at: 1_790_000_002_000 },
  { id: "about-9c0d1e2f", kind: "about", match: "m3", fields: { label: "Work email", value: "dana@lumen.example", source: "contacts" }, paused: true, at: 1_790_000_003_000 },
  { id: "people-0a1b2c3d", kind: "people", match: "m4", fields: { alias: "Dana", name: "Dana Reyes" }, app: "Mail Fixture", at: 1_790_000_004_000 },
  { id: "preference-0c1d2e3f", kind: "preference", match: "format:phone", fields: { rule: "format", valueKind: "phone", template: "(###) ###-####" }, app: "Caret Fixture", at: 1_790_000_005_000 },
  { id: "preference-4a5b6c7d", kind: "preference", match: "m5", fields: { rule: "useInstead", field: "Guest", aboutId: "about-5e6f7a8b" }, app: "Mail Fixture", at: 1_790_000_006_000 },
  { id: "preference-8e9f0a1b", kind: "preference", match: "dontOffer:routine:dev.caret.mail", fields: { rule: "dontOffer", offerKind: "routine", bundleId: "dev.caret.mail", appName: "Mail Fixture" }, paused: true, at: 1_790_000_007_000 },
  { id: "routine-1a2b3c4d", kind: "routine", match: "sig", fields: { steps: [ROUTINE_STEP], name: "Copy tracking", keep: "kept" }, at: 1_790_000_008_000 },
  { id: "skill-4e5f6a7b", kind: "skill", match: "routine-1a2b3c4d", fields: SKILL_JSON, at: 1_790_000_009_000 },
];
const SEALED = new Set(["about", "people", "preference"]);

/** A store as it was before M1: personal fields sealed in the database, no markdown, no content mode recorded. */
function legacyStore(dir: string, rows: readonly Legacy[] = ROWS): void {
  new MemoryStore(dir).close();
  rmSync(join(dir, "Memory"), { recursive: true, force: true });
  const key = readFileSync(join(dir, "memory.key"));
  const db = new DatabaseSync(join(dir, "memory.sqlite"));
  db.exec("DELETE FROM meta");
  for (const r of rows) {
    const at = r.at ?? 1_790_000_000_000;
    db.prepare("INSERT INTO memory (id, kind, paused, match, fields, sealed, count, first_seen, last_seen, app) VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?, ?)").run(
      r.id,
      r.kind,
      r.paused === true ? 1 : 0,
      r.match,
      SEALED.has(r.kind) ? null : JSON.stringify(r.fields),
      SEALED.has(r.kind) ? seal(key, JSON.stringify(r.fields)) : null,
      at,
      at,
      r.app ?? null,
    );
  }
  db.close();
}

function sqliteRows(dir: string): unknown[] {
  const db = new DatabaseSync(join(dir, "memory.sqlite"));
  try {
    return db.prepare("SELECT id, kind, paused, match, fields, hex(sealed) AS sealed, count, first_seen, last_seen, app FROM memory ORDER BY id").all();
  } finally {
    db.close();
  }
}

describe("migrating the sealed store to markdown", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-migrate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("moves every entry with the same id, fields and status, keeps the sealed values as a backup, and never runs twice", () => {
    legacyStore(dir);
    const m = new MemoryStore(dir);
    expect(m.migration).toEqual({ outcome: "migrated", moved: 8, excluded: [], error: null });
    expect(m.contentMode).toBe("documents");
    const entries = m.list().filter((e) => e.kind !== "permission" && e.kind !== "routine");
    const got = Object.fromEntries(entries.map((e) => [e.id, { status: e.status, fields: e.kind === "skill" ? { name: e.fields.name, trigger: e.fields.trigger, onItsOwn: e.fields.onItsOwn, cleanRuns: e.fields.cleanRuns } : e.fields, noticed: (e as { noticed?: unknown }).noticed ?? null }]));
    const n = (app: string | null, at: number) => ({ app, windowTitle: null, at });
    expect(got).toEqual({
      // What the user typed, and a rule they set, are active; what Caret learned is noticed, where it was last seen.
      "about-1a2b3c4d": { status: "active", fields: { label: "Name", value: "Dana Whitfield", source: "typed" }, noticed: null },
      "about-5e6f7a8b": { status: "noticed", fields: { label: "Guest", value: " Marcus Lowe (ops) ", source: "edit" }, noticed: n("Mail Fixture", 1_790_000_002_000) },
      "about-9c0d1e2f": { status: "paused", fields: { label: "Work email", value: "dana@lumen.example", source: "contacts" }, noticed: n("Contacts", 1_790_000_003_000) },
      "people-0a1b2c3d": { status: "noticed", fields: { alias: "Dana", name: "Dana Reyes" }, noticed: n("Mail Fixture", 1_790_000_004_000) },
      "preference-0c1d2e3f": { status: "noticed", fields: { rule: "format", valueKind: "phone", template: "(###) ###-####" }, noticed: n("Caret Fixture", 1_790_000_005_000) },
      "preference-4a5b6c7d": { status: "noticed", fields: { rule: "useInstead", field: "Guest", aboutId: "about-5e6f7a8b" }, noticed: n("Mail Fixture", 1_790_000_006_000) },
      "preference-8e9f0a1b": { status: "paused", fields: { rule: "dontOffer", offerKind: "routine", bundleId: "dev.caret.mail", appName: "Mail Fixture" }, noticed: null },
      // A skill's approval and counts stay in the database, untouched by migration.
      "skill-4e5f6a7b": { status: "active", fields: { name: "Copy tracking", trigger: "a Tracker window opens with Order empty", onItsOwn: true, cleanRuns: 3 }, noticed: null },
    });
    // The values live only in the files now; the database holds the sealed backup, still sealed.
    const mem = join(dir, "Memory");
    expect(readdirSync(mem).sort()).toEqual(["about-me.md", "people.md", "preferences.md", "skills"]);
    expect(readdirSync(join(mem, "skills"))).toEqual(["skill-4e5f6a7b.md"]);
    for (const f of ["about-me.md", "people.md", "preferences.md", "skills/skill-4e5f6a7b.md"]) expect(lstatSync(join(mem, f)).mode & 0o777, f).toBe(0o600);
    expect(lstatSync(mem).mode & 0o777).toBe(0o700);
    const db = new DatabaseSync(join(dir, "memory.sqlite"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory WHERE sealed IS NOT NULL").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT id FROM memory_backup ORDER BY id").all().map((r) => (r as { id: string }).id)).toEqual(ROWS.filter((r) => SEALED.has(r.kind)).map((r) => r.id).sort());
    db.close();
    expect(readFileSync(join(mem, "about-me.md"), "utf8")).toContain('- Value: " Marcus Lowe (ops) "');
    expect(existsSync(join(dir, "memory-migration.json"))).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes("staging"))).toEqual([]);
    m.close();
    const again = new MemoryStore(dir);
    expect(again.migration.outcome).toBe("done");
    expect(again.list().filter((e) => e.kind !== "permission" && e.kind !== "routine").map((e) => e.id).sort()).toEqual(Object.keys(got).sort());
    again.close();
  });

  it("keeps the old store byte for byte when an entry cannot be decrypted, names it, and migrates once the key is right", () => {
    legacyStore(dir);
    const before = sqliteRows(dir);
    const key = readFileSync(join(dir, "memory.key"));
    writeFileSync(join(dir, "memory.key"), Buffer.alloc(32, 7));
    const warned: string[] = [];
    const m = new MemoryStore(dir, { warn: (l) => warned.push(l) });
    expect(m.migration.outcome).toBe("failed");
    expect(m.migration.error).toMatch(/^memory migration: entry about-1a2b3c4d \(about\) cannot be decrypted: .+; the sealed store stays in use$/);
    expect(warned).toEqual([m.migration.error]);
    expect(m.contentMode).toBe("sealed");
    m.close();
    expect(sqliteRows(dir)).toEqual(before);
    expect(existsSync(join(dir, "Memory"))).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes("staging") || f.includes("migration"))).toEqual([]);

    writeFileSync(join(dir, "memory.key"), key);
    const fixed = new MemoryStore(dir);
    expect(fixed.migration).toMatchObject({ outcome: "migrated", moved: 8 });
    fixed.close();
  });

  it("while migration fails the sealed store stays in use: reads, edits and learned facts still work", () => {
    legacyStore(dir);
    // One corrupt blob stops the whole move, so the rest is read from the sealed columns as before.
    const db = new DatabaseSync(join(dir, "memory.sqlite"));
    db.prepare("INSERT INTO memory (id, kind, paused, match, sealed, count, first_seen, last_seen) VALUES ('about-bad00000', 'about', 1, 'bad', x'00', 1, 1, 1)").run();
    db.close();
    const m = new MemoryStore(dir);
    expect(m.migration.error).toMatch(/entry about-bad00000 \(about\) cannot be decrypted/);
    expect(m.about("about-1a2b3c4d")).toEqual({ label: "Name", value: "Dana Whitfield", source: "typed" });
    expect(m.edit("people-0a1b2c3d", { name: "Dana R. Reyes" }, 5).fields).toEqual({ alias: "Dana", name: "Dana R. Reyes" });
    const id = m.upsert("people", "m9", { alias: "Marcus", name: "Marcus Lowe" }, 6, "Mail", { app: "Mail", window: null, at: 6 });
    expect(m.get(id)).toMatchObject({ status: "active", fields: { name: "Marcus Lowe" } });
    m.close();
    expect(existsSync(join(dir, "Memory"))).toBe(false);
  });

  it("leaves out a value Caret never keeps: it stays only in the encrypted backup, and the warning says why", () => {
    legacyStore(dir, [...ROWS, { id: "about-cafe0001", kind: "about", match: "m6", fields: { label: "Card", value: "4111 1111 1111 1111", source: "edit" } }]);
    const warned: string[] = [];
    const m = new MemoryStore(dir, { warn: (l) => warned.push(l) });
    expect(m.migration).toMatchObject({ outcome: "migrated", moved: 8, excluded: [{ id: "about-cafe0001", why: "Caret doesn't keep card numbers in memory" }] });
    expect(warned).toEqual(["memory migration: about-cafe0001 was not written to markdown: Caret doesn't keep card numbers in memory; it stays only in the encrypted backup"]);
    expect(readFileSync(join(dir, "Memory", "about-me.md"), "utf8")).not.toContain("4111");
    expect(m.list("about").map((e) => e.id)).not.toContain("about-cafe0001");
    m.close();
    const db = new DatabaseSync(join(dir, "memory.sqlite"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_backup WHERE id = 'about-cafe0001'").get()).toEqual({ n: 1 });
    db.close();
  });

  it("finishes an install a crash interrupted after the rename, from the marker", () => {
    legacyStore(dir);
    const m = new MemoryStore(dir, { migrationHooks: { afterRename: () => { throw new Error("killed"); } } });
    expect(m.migration.outcome).toBe("failed");
    expect(m.migration.error).toMatch(/the files are installed but the database step failed \(killed\)/);
    expect(m.contentMode).toBe("sealed");
    m.close();
    expect(existsSync(join(dir, "memory-migration.json"))).toBe(true);
    const restarted = new MemoryStore(dir);
    expect(restarted.migration).toMatchObject({ outcome: "resumed", moved: 8 });
    expect(restarted.contentMode).toBe("documents");
    expect(restarted.get("about-1a2b3c4d").fields).toEqual({ label: "Name", value: "Dana Whitfield", source: "typed" });
    expect(existsSync(join(dir, "memory-migration.json"))).toBe(false);
    restarted.close();
  });

  it("drops a staging folder a crash left before the rename and starts again", () => {
    legacyStore(dir);
    const kept = join(dir, "kept");
    // As if the process died here: the marker and the staging folder survive.
    const m = new MemoryStore(dir, {
      migrationHooks: {
        beforeRename: () => {
          const marker = JSON.parse(readFileSync(join(dir, "memory-migration.json"), "utf8")) as { staging: string };
          mkdirSync(kept);
          cpSync(marker.staging, join(kept, "staging"), { recursive: true });
          cpSync(join(dir, "memory-migration.json"), join(kept, "marker"));
          writeFileSync(join(kept, "path"), marker.staging);
          throw new Error("killed");
        },
      },
    });
    expect(m.migration.outcome).toBe("failed");
    m.close();
    const staging = readFileSync(join(kept, "path"), "utf8");
    renameSync(join(kept, "staging"), staging);
    renameSync(join(kept, "marker"), join(dir, "memory-migration.json"));
    const restarted = new MemoryStore(dir);
    expect(restarted.migration).toMatchObject({ outcome: "migrated", moved: 8 });
    expect(existsSync(staging)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes("staging"))).toEqual([]);
    restarted.close();
  });

  it("refuses to write into a memory folder that already holds files, touching neither", () => {
    legacyStore(dir);
    mkdirSync(join(dir, "Memory"));
    writeFileSync(join(dir, "Memory", "notes.md"), "mine\n");
    const before = sqliteRows(dir);
    const m = new MemoryStore(dir);
    expect(m.migration.error).toMatch(/Memory already holds notes\.md; not writing the sealed store over it/);
    m.close();
    expect(readFileSync(join(dir, "Memory", "notes.md"), "utf8")).toBe("mine\n");
    expect(sqliteRows(dir)).toEqual(before);
  });

  it("starts a fresh store in markdown with no files, inside its own directory unless told otherwise", () => {
    const m = new MemoryStore(dir);
    expect(m.migration.outcome).toBe("fresh");
    expect(m.folder).toBe(join(dir, "Memory"));
    expect(readdirSync(join(dir, "Memory")).sort()).toEqual(["skills"]);
    m.close();
  });

  it("round-trips every legacy entry through the files exactly, compared field by field after parsing", () => {
    legacyStore(dir);
    new MemoryStore(dir).close();
    const about = parseDocument("about-me", readFileSync(join(dir, "Memory", "about-me.md"), "utf8"));
    const people = parseDocument("people", readFileSync(join(dir, "Memory", "people.md"), "utf8"));
    const prefs = parseDocument("preferences", readFileSync(join(dir, "Memory", "preferences.md"), "utf8"));
    const back = [...about.records, ...people.records, ...prefs.records].map((r) => [r.record.id, r.record.fields]);
    expect(Object.fromEntries(back)).toEqual(Object.fromEntries(ROWS.filter((r) => SEALED.has(r.kind)).map((r) => [r.id, r.fields])));
    expect([...about.diagnostics, ...people.diagnostics, ...prefs.diagnostics]).toEqual([]);
  });
});
