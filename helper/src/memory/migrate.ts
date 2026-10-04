// Moves personal memory from the sealed database columns into markdown, once, automatically and silently (lead
// decision 2, 2026-10-04: the sealed store holds only development data). Plan section 6, steps 2 to 5:
//
//   1. Decrypt every sealed about, people and preference entry and read each skill's name and trigger. A value
//      Caret never keeps (sensitive.ts) is not written out; it stays only in the encrypted backup.
//   2. Render them to a staging folder beside the memory folder, with the same ids, then parse that folder back
//      with the normal reader and compare every record's id, kind, fields, status and provenance.
//   3. Any failure (a decryption, a parse, a write, a comparison) leaves the database untouched and returns the
//      specific error; the helper keeps using the sealed store and tries again at the next start. An empty memory
//      is never installed over entries that exist.
//   4. Install: a marker file with each file's checksum, then one rename of the staging folder, then one database
//      transaction that moves the sealed values into memory_backup and records that markdown is now the source.
//      A restart finds the marker and finishes the transaction if the installed files match it, or drops the
//      staging folder if the rename never happened.
//   5. The sealed values stay in memory_backup, still encrypted, as the rollback copy. Forgetting an entry deletes
//      its backup too.
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import * as z from "zod";
import { AboutFields, PeopleFields, PreferenceFields } from "../protocol.ts";
import { open } from "../sealed.ts";
import { MemoryDocumentStore, revisionOf } from "./documents.ts";
import { fileOf, formatDiagnostic, newDocument, recordDigest, ROOT_DOCS, SkillText, type DocId, type MemoryRecord } from "./parse.ts";
import { refusal, sensitiveKind, valueKind } from "./sensitive.ts";

export interface MigrationResult {
  /** fresh: nothing to move. done: moved before. migrated / resumed: moved now. failed: the sealed store stays in use. */
  outcome: "fresh" | "done" | "migrated" | "resumed" | "failed";
  moved: number;
  /** Entries left out of the markdown because they hold what Caret never keeps, with why. */
  excluded: { id: string; why: string }[];
  error: string | null;
}

export interface MigrationHooks {
  /** Runs after the staging folder is checked and the marker written, before the rename. */
  beforeRename?: () => void;
  /** Runs after the rename, before the database step: a crash here is what the marker recovers from. */
  afterRename?: () => void;
}

const MARKER = "memory-migration.json";
const Marker = z.object({
  state: z.literal("installing"),
  staging: z.string(),
  memoryDir: z.string(),
  moved: z.array(z.string()),
  excluded: z.array(z.string()),
  files: z.record(z.string(), z.string()),
});
type Marker = z.infer<typeof Marker>;

export const MIGRATION_TABLES = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- The sealed values migration moved out, still sealed: the rollback copy (plan section 6, step 5).
CREATE TABLE IF NOT EXISTS memory_backup (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  sealed BLOB NOT NULL,
  paused INTEGER NOT NULL,
  at INTEGER NOT NULL
);
`;

export function contentMode(db: DatabaseSync): "documents" | "sealed" {
  const r = db.prepare("SELECT value FROM meta WHERE key = 'content'").get() as { value: string } | undefined;
  return r?.value === "documents" ? "documents" : "sealed";
}

interface LegacyRow {
  id: string;
  kind: "about" | "people" | "preference" | "skill";
  paused: number;
  fields: string | null;
  sealed: Uint8Array | null;
  app: string | null;
  last_seen: number;
}

export function migrateSealedMemory(o: { db: DatabaseSync; key: Buffer; dataDir: string; memoryDir: string; now: number; hooks?: MigrationHooks }): MigrationResult {
  const { db } = o;
  db.exec(MIGRATION_TABLES);
  if (contentMode(db) === "documents") return { outcome: "done", moved: 0, excluded: [], error: null };
  const markerPath = join(o.dataDir, MARKER);
  if (existsSync(markerPath)) {
    const resumed = resume(o, markerPath);
    if (resumed !== null) return resumed;
  }

  const sealedRows = db.prepare("SELECT id, kind, paused, fields, sealed, app, last_seen FROM memory WHERE kind IN ('about', 'people', 'preference') AND sealed IS NOT NULL ORDER BY first_seen, id").all() as unknown as LegacyRow[];
  const skillRows = db.prepare("SELECT id, kind, paused, fields, sealed, app, last_seen FROM memory WHERE kind = 'skill' ORDER BY first_seen, id").all() as unknown as LegacyRow[];
  if (sealedRows.length === 0 && skillRows.length === 0) {
    setDocuments(db);
    return { outcome: "fresh", moved: 0, excluded: [], error: null };
  }
  const fail = (error: string): MigrationResult => ({ outcome: "failed", moved: 0, excluded: [], error: `memory migration: ${error}; the sealed store stays in use` });

  // 1. Read everything first: one entry that cannot be read stops the whole move.
  const records: MemoryRecord[] = [];
  const excluded: { id: string; why: string }[] = [];
  for (const r of sealedRows) {
    let json: unknown;
    try {
      json = JSON.parse(open(o.key, Buffer.from(r.sealed as Uint8Array)));
    } catch (e) {
      return fail(`entry ${r.id} (${r.kind}) cannot be decrypted: ${e instanceof Error ? e.message : String(e)}`);
    }
    const schema = r.kind === "about" ? AboutFields : r.kind === "people" ? PeopleFields : PreferenceFields;
    const parsed = schema.safeParse(json);
    if (!parsed.success) return fail(`entry ${r.id} (${r.kind}) does not read as a ${r.kind} entry: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    const rec = legacyRecord(r, parsed.data as never);
    const secret = rec.kind === "about" ? sensitiveKind(rec.fields.label, rec.fields.value) : rec.kind === "people" ? (valueKind(rec.fields.alias) ?? valueKind(rec.fields.name)) : null;
    if (secret !== null) excluded.push({ id: r.id, why: refusal(secret) });
    else records.push(rec);
  }
  for (const r of skillRows) {
    const f = SkillText.safeParse(JSON.parse(r.fields ?? "null"));
    if (!f.success) return fail(`skill ${r.id} has no name and trigger to write out: ${f.error.issues[0]?.message ?? "invalid"}`);
    records.push({ id: r.id, kind: "skill", status: r.paused !== 0 ? "paused" : "active", noticed: null, fields: f.data });
  }

  // The memory folder may exist empty; anything in it would be overwritten or merged, so that is refused.
  const present = filesIn(o.memoryDir);
  if (present.length > 0) return fail(`${o.memoryDir} already holds ${present.slice(0, 3).join(", ")}${present.length > 3 ? " and more" : ""}; not writing the sealed store over it`);

  // 2. Stage, then read back with the normal reader.
  const staging = join(dirname(o.memoryDir), `.${basename(o.memoryDir)}.staging-${randomBytes(6).toString("hex")}`);
  let renamed = false;
  let markerWritten = false;
  try {
    mkdirSync(join(staging, "skills"), { recursive: true, mode: 0o700 });
    const byDoc = new Map<DocId, MemoryRecord[]>();
    for (const r of records) {
      const doc: DocId = r.kind === "about" ? "about-me" : r.kind === "people" ? "people" : r.kind === "preference" ? "preferences" : `skills/${r.id}`;
      byDoc.set(doc, [...(byDoc.get(doc) ?? []), r]);
    }
    const files: Record<string, string> = {};
    for (const [doc, rs] of byDoc) {
      const text = newDocument(doc, rs);
      writeFileSync(join(staging, fileOf(doc)), text, { mode: 0o600, flag: "wx" });
      files[fileOf(doc)] = revisionOf(text);
    }
    const check = new MemoryDocumentStore(staging);
    try {
      const errors = [...ROOT_DOCS, ...records.filter((r) => r.kind === "skill").map((r) => `skills/${r.id}` as DocId)].flatMap((d) => check.info(d).diagnostics.filter((x) => x.severity === "error"));
      if (errors.length > 0) throw new Error(`the staged files do not read back cleanly: ${formatDiagnostic(errors[0] as (typeof errors)[number])}`);
      for (const r of records) {
        const back = check.record(r.id);
        if (back === null) throw new Error(`${r.kind} entry ${r.id} is missing when its file is read back`);
        if (recordDigest(back) !== recordDigest(r) || JSON.stringify(back) !== JSON.stringify(r)) throw new Error(`${r.kind} entry ${r.id} reads back different: ${JSON.stringify(diffKeys(r, back))}`);
      }
      const kinds = ["about", "people", "preference", "skill"] as const;
      const back = kinds.reduce((n, k) => n + check.records(k).length, 0);
      if (back !== records.length) throw new Error(`${back} records read back, ${records.length} written`);
    } finally {
      check.close();
    }

    // 4. Install.
    const marker: Marker = { state: "installing", staging, memoryDir: o.memoryDir, moved: records.map((r) => r.id), excluded: excluded.map((x) => x.id), files };
    writeAtomic(markerPath, JSON.stringify(marker));
    markerWritten = true;
    o.hooks?.beforeRename?.();
    if (existsSync(o.memoryDir)) removeEmptyTree(o.memoryDir);
    mkdirSync(dirname(o.memoryDir), { recursive: true, mode: 0o700 });
    renameSync(staging, o.memoryDir);
    renamed = true;
    o.hooks?.afterRename?.();
    finish(db, marker, o.now);
    unlinkSync(markerPath);
    return { outcome: "migrated", moved: records.length, excluded, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!renamed) {
      rmSync(staging, { recursive: true, force: true });
      if (markerWritten) rmSync(markerPath, { force: true });
      return { ...fail(message), excluded };
    }
    // Installed but not recorded: the marker stays, and the next start finishes or reports it.
    return { ...fail(`the files are installed but the database step failed (${message}); the next start finishes it`), excluded };
  }
}

/** Finishes or undoes an install a crash interrupted. Null: nothing was installed, so migrate from the start. */
function resume(o: { db: DatabaseSync; memoryDir: string; now: number }, markerPath: string): MigrationResult | null {
  let m: Marker;
  try {
    m = Marker.parse(JSON.parse(readFileSync(markerPath, "utf8")));
  } catch (e) {
    return { outcome: "failed", moved: 0, excluded: [], error: `memory migration: the marker ${markerPath} cannot be read (${e instanceof Error ? e.message : String(e)}); the sealed store stays in use` };
  }
  if (installedMatches(m)) {
    finish(o.db, m, o.now);
    unlinkSync(markerPath);
    return { outcome: "resumed", moved: m.moved.length, excluded: m.excluded.map((id) => ({ id, why: "left out at migration" })), error: null };
  }
  if (existsSync(m.staging) && filesIn(m.memoryDir).length === 0) {
    // The rename never happened: nothing was installed.
    rmSync(m.staging, { recursive: true, force: true });
    unlinkSync(markerPath);
    return null;
  }
  return { outcome: "failed", moved: 0, excluded: [], error: `memory migration: an interrupted move left ${m.memoryDir} different from what it installed; the sealed store stays in use and nothing was deleted` };
}

function installedMatches(m: Marker): boolean {
  if (!existsSync(m.memoryDir)) return false;
  for (const [rel, rev] of Object.entries(m.files)) {
    try {
      if (revisionOf(readFileSync(join(m.memoryDir, rel))) !== rev) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function finish(db: DatabaseSync, m: Marker, now: number): void {
  db.exec("BEGIN");
  try {
    const backup = db.prepare("INSERT OR REPLACE INTO memory_backup (id, kind, sealed, paused, at) SELECT id, kind, sealed, paused, ? FROM memory WHERE id = ? AND sealed IS NOT NULL");
    for (const id of [...m.moved, ...m.excluded]) backup.run(now, id);
    const clear = db.prepare("UPDATE memory SET sealed = NULL WHERE id = ?");
    for (const id of m.moved) clear.run(id);
    const drop = db.prepare("DELETE FROM memory WHERE id = ?");
    for (const id of m.excluded) drop.run(id);
    setDocuments(db);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function setDocuments(db: DatabaseSync): void {
  db.prepare("INSERT INTO meta (key, value) VALUES ('content', 'documents') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
}

/**
 * A sealed entry as a record. What the user typed, and a rule they set ("Don't offer this here"), are active;
 * what Caret learned from an edit or a Contacts card is noticed, in the app it was last seen in, at that time.
 */
function legacyRecord(r: LegacyRow, fields: MemoryRecord["fields"]): MemoryRecord {
  const told = (r.kind === "about" && (fields as { source: string }).source === "typed") || (r.kind === "preference" && (fields as { rule: string }).rule === "dontOffer");
  const noticed = told ? null : { app: r.kind === "about" && (fields as { source: string }).source === "contacts" ? "Contacts" : r.app, window: null, at: Number(r.last_seen) };
  const status = r.paused !== 0 ? "paused" : told ? "active" : "noticed";
  return { id: r.id, kind: r.kind, status, noticed, fields } as MemoryRecord;
}

/** Files under a folder (symlinks and special files count as files); none when it does not exist. */
function filesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const st = lstatSync(dir);
  if (!st.isDirectory()) return [dir];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return lstatSync(p).isDirectory() ? filesIn(p).map((x) => join(n, basename(x))) : [n];
  });
}

/** Removes a tree of empty folders; anything else in it throws. */
function removeEmptyTree(dir: string): void {
  for (const n of readdirSync(dir)) removeEmptyTree(join(dir, n));
  rmdirSync(dir);
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}

function diffKeys(a: MemoryRecord, b: MemoryRecord): string[] {
  const out: string[] = [];
  if (a.status !== b.status) out.push("status");
  if (JSON.stringify(a.noticed) !== JSON.stringify(b.noticed)) out.push("noticed");
  for (const k of new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])) {
    if ((a.fields as Record<string, unknown>)[k] !== (b.fields as Record<string, unknown>)[k]) out.push(`fields.${k}`);
  }
  return out;
}
