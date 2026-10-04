// Memory you can see and edit (plan section 4). Typed entries, never prose a model wrote, in six kinds:
// about you, people, preferences, routines, permissions and skills (B19: routines the user kept). Each
// entry's sentence is rendered by code from its fields. Recognizers, fills and the gate read memory on
// every use, so an edit, pause or forget takes effect at the next offer.
//
// M1: the personal content of about, people, preference and skill entries is markdown the user can open
// and edit (memory/documents.ts, in ~/Library/Application Support/Caret/Memory for the app). This class is
// the facade its consumers already call. The database keeps each entry's index row (its lookup key, a
// keyed hash; its counts and when it was last seen) and everything that grants or limits what Caret does:
// permissions, a skill's runs, clean-run count, approval to run on its own and hand-off, and routines,
// which hold only labels, app names and hashes. A file edit can change a value or pause an entry; it can
// never grant authority, and an edited skill goes back on Tab.
//
// Status: active (you told Caret, or confirmed it), noticed (Caret saw it; used at once, and offers built
// from it say where it came from) or paused. A store opened on sealed data migrates it once (memory/
// migrate.ts); if that fails, the sealed columns stay in use unchanged (memory/content.ts SealedContent).
//
// The same database holds the gate's decision log, the user's reactions to offers and permission uses.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import * as z from "zod";
import { fieldKinds } from "../fill/kinds.ts";
import { LEVELS } from "../offers/settings.ts";
import { DocumentContent, SealedContent, type Content } from "../memory/content.ts";
import { MemoryDocumentError, MemoryDocumentStore, type DocumentInfo, type RecordChange } from "../memory/documents.ts";
import { contentMode, migrateSealedMemory, type MigrationHooks, type MigrationResult } from "../memory/migrate.ts";
import { recordDigest, type DocId, type MemoryRecord, type Noticed, type RecordKind, type RecordStatus } from "../memory/parse.ts";
import { refusal, sensitiveKind, valueKind } from "../memory/sensitive.ts";
import { loadKey, open, seal } from "../sealed.ts";
import {
  AboutFields,
  PeopleFields,
  PermissionFields,
  PreferenceFields,
  PressRisk,
  RoutineFields,
  SkillFields,
  type ActionType,
  type MemoryEntry,
  type MemoryKind,
  type MemoryStatus,
  type OfferKind,
  type PermissionRule,
  type PermissionUse,
  MAX_PERMISSION_USES,
  UseOutcome,
} from "../protocol.ts";

/** A routine forgotten by the user is not relearned for this long (plan section 4, assumed). */
export const FORGET_BLOCK_MS = 30 * 24 * 60 * 60 * 1000;
/** Share of silent predictions that must have matched. No measurement behind the number. */
export const ROUTINE_MIN_PRECISION = 0.8;

export type AboutFields = z.infer<typeof AboutFields>;
export type PeopleFields = z.infer<typeof PeopleFields>;
export type PreferenceFields = z.infer<typeof PreferenceFields>;
export type PermissionFields = z.infer<typeof PermissionFields>;

/** One step of a routine: a transfer shape, stored as keyed hashes plus the app and window kinds. */
export const RoutineStep = z.object({
  shapeHash: z.string(),
  srcBundle: z.string(),
  srcApp: z.string(),
  srcWindowKind: z.string(),
  srcTemplateHash: z.string(),
  srcPos: z.number().int().nonnegative(),
  part: z.string(),
  dstBundle: z.string(),
  dstApp: z.string(),
  dstWindowKind: z.string(),
  dstTemplateHash: z.string(),
  dstPos: z.number().int().nonnegative(),
});
export type RoutineStep = z.infer<typeof RoutineStep>;

/**
 * The press that ended a routine's occurrences and that Caret leaves to the user (B19): a button in the
 * destination window whose label reads as outbound, destructive or money (executor/risk.ts), found by
 * template and position like a step's field. Learned from the user's own click on it when the reader saw
 * one (B20), else from the window's buttons when the destination window closes after the values went in
 * (routines.ts finishPressed, finishOf).
 */
export const RoutineFinish = z.object({
  label: z.string().min(1),
  why: PressRisk,
  templateHash: z.string(),
  pos: z.number().int().nonnegative(),
  /**
   * The window held several such buttons ("Send" and "Send later") and code cannot tell which the user
   * presses: `label` names them all, no plan hands one of them off, and the skill is never run on its own.
   */
  ambiguous: z.boolean().optional(),
  /**
   * How it was learned: the user's own press of it, which the reader observed, by a click (B20) or a key
   * (Return, Enter or Space, B21), or the window's buttons when no press was seen. Absent on rows from
   * before B20, which were all learned from buttons.
   */
  by: z.enum(["click", "key", "buttons"]).optional(),
});
export type RoutineFinish = z.infer<typeof RoutineFinish>;

/** Where the "Keep this as a skill?" offer stands for a routine: never made or expired unanswered (null), out now, declined, or kept. */
export const KeepState = z.enum(["offered", "declined", "kept"]).nullable();
export type KeepState = z.infer<typeof KeepState>;

/** What a routine row's JSON holds beside its steps. Every key is optional so rows written before B19 still read. */
const RoutineJson = z.object({
  steps: z.array(RoutineStep).optional(),
  name: z.string().nullable().optional(),
  /** Who named it: Jev's pick of code's candidates, code's own fallback, or the user. */
  nameBy: z.enum(["jev", "code", "you"]).nullable().optional(),
  /** Naming was started once; it is never asked again, even across restarts. */
  namingAsked: z.boolean().optional(),
  keep: KeepState.optional(),
  finish: RoutineFinish.nullable().optional(),
});
type RoutineJson = z.infer<typeof RoutineJson>;

export interface RoutineRecord {
  id: string;
  sig: string;
  steps: RoutineStep[];
  count: number;
  hits: number;
  misses: number;
  paused: boolean;
  name: string | null;
  nameBy: "jev" | "code" | "you" | null;
  namingAsked: boolean;
  keep: KeepState;
  finish: RoutineFinish | null;
  /** The user paused the skill made from this routine, which pauses its offers too. */
  skillPaused: boolean;
}

/** A skill's stored fields: what the host sees (SkillFields), plus the promote offer's state and the action types its runs wrote under. */
const SkillJson = SkillFields.extend({
  /** The "on its own" offer: never made or expired unanswered (null), out now, or declined, which is never asked again. */
  promote: z.enum(["offered", "declined"]).nullable(),
  /**
   * The user put it back on Tab (B22 lead decision): Caret never makes the promote offer for it on its own
   * again; only the user's request from the skill's row (memoryRequest offerOnItsOwn) does. Absent on rows
   * written before B22.
   */
  putBack: z.boolean().optional(),
});
export type SkillRecord = z.infer<typeof SkillJson> & { id: string; paused: boolean };

/**
 * Plan section 3's table: where each action type starts and whether the user may change it.
 * "Can become" is enforced on edit.
 */
const PERMISSIONS: Record<ActionType, { rule: PermissionRule; allowed: PermissionRule[]; says: string }> = {
  read: { rule: "act", allowed: ["act"], says: "Read and prepare" },
  show: { rule: "act", allowed: ["act"], says: "Show in Caret's UI" },
  writeHere: { rule: "ask", allowed: ["ask", "act"], says: "Write where you are" },
  writeElsewhere: { rule: "ask", allowed: ["ask", "actIfApproved"], says: "Reversible write elsewhere" },
  outbound: { rule: "handoff", allowed: ["handoff", "ask"], says: "Send, submit, post" },
  destructive: { rule: "handoff", allowed: ["handoff", "ask"], says: "Delete, overwrite" },
  sensitive: { rule: "handoff", allowed: ["handoff"], says: "Money, passwords, system dialogs" },
};
const RULE_SAYS: Record<PermissionRule, string> = { act: "act", actIfApproved: "act if pre-approved", ask: "ask first", handoff: "hand off to you" };
const OFFER_SAYS: Record<OfferKind, string> = { loopNext: "next-row predictions", loopFinish: "Finish the rest", routine: "routines" };

/** Sample digits for showing a phone format without showing anyone's number. */
const SAMPLE_PHONE = "5125550100";

export class MemoryError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  -- Lookup key: a keyed hash, a routine signature, or a permission's action. Never plain screen text.
  match TEXT NOT NULL,
  -- JSON fields for routines and permissions; NULL for sealed kinds.
  fields TEXT,
  -- AES-256-GCM of the JSON fields (iv | tag | ciphertext) for about, people and preference.
  sealed BLOB,
  count INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  app TEXT,
  hits INTEGER NOT NULL DEFAULT 0,
  misses INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS memory_match ON memory (kind, match);
CREATE TABLE IF NOT EXISTS forgotten (
  kind TEXT NOT NULL,
  match TEXT NOT NULL,
  until INTEGER NOT NULL,
  PRIMARY KEY (kind, match)
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  offer_kind TEXT NOT NULL,
  pattern TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  speak INTEGER NOT NULL,
  reasons TEXT NOT NULL,
  p_show REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_at ON decisions (at);
CREATE TABLE IF NOT EXISTS reactions (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  day TEXT NOT NULL,
  offer_kind TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  action TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reactions_day ON reactions (day, offer_kind, bundle_id);
-- A permission's last uses (B17): AES-256-GCM of the JSON {says, app, outcome}, since a use names a
-- field and an app. At most MAX_PERMISSION_USES rows per action.
CREATE TABLE IF NOT EXISTS uses (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,
  at INTEGER NOT NULL,
  sealed BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS uses_action ON uses (action, at);
`;

interface Row {
  id: string;
  kind: MemoryKind;
  paused: number;
  match: string;
  fields: string | null;
  sealed: Uint8Array | null;
  count: number;
  first_seen: number;
  last_seen: number;
  app: string | null;
  hits: number;
  misses: number;
}

export interface DecisionRow {
  at: number;
  offerKind: OfferKind;
  pattern: string;
  bundleId: string;
  speak: boolean;
  reasons: string[];
  showProbability: number;
}

export interface MemoryOptions {
  /**
   * The markdown memory folder. Defaults to "Memory" inside `dir`, so a store opened on a temporary directory never
   * touches the user's real folder; main.ts passes ~/Library/Application Support/Caret/Memory for the app.
   */
  documents?: string;
  /** Watch the folder for edits, as a hint to look sooner (reads check revisions anyway). */
  watch?: boolean;
  /** Where a failed migration or an unreadable file is reported. */
  warn?: (line: string) => void;
  /** For migration tests: hooks around the install. */
  migrationHooks?: MigrationHooks;
}

/** Where a noticed fact came from, as an offer that used it says so. */
export interface NoticedUse {
  id: string;
  kind: "about" | "people" | "preference";
  label: string;
  noticed: Noticed;
}

const DOC_KINDS: ReadonlySet<MemoryKind> = new Set(["about", "people", "preference", "skill"]);

export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  /** Where about, people, preference and skill content lives: markdown, or the sealed columns when migration failed. */
  private readonly content: Content;
  /** What migration did when the store opened. */
  readonly migration: MigrationResult;
  /** The markdown memory folder, for Show in Finder (whether or not migration has moved anything there yet). */
  readonly folder: string;
  /** Record changes made outside Caret (an editor, the host's memory window), not yet handed to onOutsideChange. */
  private outside: RecordChange[] = [];
  private notifyQueued = false;
  /**
   * Told of record changes made outside Caret, after the store has applied what it owns (a changed skill goes back
   * on Tab). The helper withdraws offers and revokes tasks that used them. Called on a microtask, never inside a read.
   */
  onOutsideChange: ((changes: RecordChange[]) => void) | null = null;
  private readonly warn: (line: string) => void;
  /**
   * Decisions not yet written. The gate runs on the event path and a SQLite write there stalled for
   * 11 ms once on a loaded disk (patterns-eval, 2026-10-02), so decisions are written on the tick.
   */
  private pendingDecisions: DecisionRow[] = [];
  /** Permission uses not yet written, for the same reason: an offer shown on the event path is a use. */
  private pendingUses: { action: ActionType; use: Required<PermissionUse> }[] = [];
  /** Every routine with its steps, read once per change: window openings consult it on the event path. */
  private routineCache: RoutineRecord[] | null = null;
  /**
   * Silent hits a routine needs before it is active, at the user's level (offers/settings.ts LEVELS).
   * The helper sets it from each settings message; at a level with routines off the memory view still
   * describes proof by the Balanced number.
   */
  routineSightings: number = LEVELS.balanced.routineSightings ?? 3;

  constructor(dir: string, opts: MemoryOptions = {}) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.warn = opts.warn ?? (() => undefined);
    this.key = loadKey(join(dir, "memory.key"));
    const path = join(dir, "memory.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    this.seedPermissions();
    const memoryDir = resolve(opts.documents ?? join(dir, "Memory"));
    this.folder = memoryDir;
    this.migration = migrateSealedMemory({ db: this.db, key: this.key, dataDir: dir, memoryDir, now: Date.now(), ...(opts.migrationHooks === undefined ? {} : { hooks: opts.migrationHooks }) });
    if (this.migration.error !== null) this.warn(this.migration.error);
    for (const x of this.migration.excluded) this.warn(`memory migration: ${x.id} was not written to markdown: ${x.why}; it stays only in the encrypted backup`);
    if (contentMode(this.db) === "documents") {
      const docs = new MemoryDocumentStore(memoryDir);
      this.content = new DocumentContent(docs);
      if (opts.watch === true) docs.watch(() => this.sync("all"));
      this.adopt();
    } else this.content = new SealedContent(this.db, this.key);
  }

  close(): void {
    this.flushDecisions();
    this.content.close();
    this.db.close();
  }

  private readonly statements = new Map<string, StatementSync>();

  /** Prepared once and reused: compiling SQL on every call was the bulk of a cold bundle close. */
  private stmt(sql: string): StatementSync {
    let st = this.statements.get(sql);
    if (st === undefined) this.statements.set(sql, (st = this.db.prepare(sql)));
    return st;
  }

  // MARK: - markdown content

  /** The markdown document store, or null while a failed migration keeps the sealed store in use. */
  get files(): MemoryDocumentStore | null {
    return this.content.documents;
  }

  /** "documents" when memory is the markdown folder; "sealed" while a failed migration keeps the old store in use. */
  get contentMode(): "documents" | "sealed" {
    return this.content.mode;
  }

  /**
   * Brings the content of `kind` up to date with its files (by stat; by content with `verify`). A change made
   * outside Caret is applied and queued for onOutsideChange; records the user added with ids of their own get index rows.
   */
  private sync(kind: MemoryKind | "all", verify = false): void {
    if (kind !== "all" && !DOC_KINDS.has(kind)) return;
    let moved: boolean;
    try {
      moved = this.content.sync(kind as RecordKind | "all", verify);
    } catch (e) {
      // A folder that cannot be read at all: what was read before stays, and the reason is said once per failure.
      this.warn(`memory: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!moved) return;
    this.adopt();
    const changes = this.content.takeChanges();
    if (changes.length === 0) return;
    this.applyOutside(changes);
    this.outside.push(...changes);
    if (!this.notifyQueued && this.onOutsideChange !== null) {
      this.notifyQueued = true;
      queueMicrotask(() => {
        this.notifyQueued = false;
        const c = this.takeOutsideChanges();
        if (c.length > 0) this.onOutsideChange?.(c);
      });
    }
  }

  /** Checks every file by content now, as acceptance does, and returns the changes found outside Caret not yet handed on. */
  verify(): RecordChange[] {
    this.sync("all", true);
    return this.takeOutsideChanges();
  }

  /** Changes found outside Caret and not yet handed to onOutsideChange; taking them means the caller handles them. */
  takeOutsideChanges(): RecordChange[] {
    const out = this.outside;
    this.outside = [];
    return out;
  }

  /**
   * What the store itself owns when a record changes outside Caret. An edited skill goes back on Tab, its clean
   * runs start again and its name follows the file (plan section 6: an edited recipe invalidates its promotions):
   * a file edit can take autonomy away, never give it.
   */
  private applyOutside(changes: readonly RecordChange[]): void {
    for (const c of changes) {
      if (c.kind !== "skill") continue;
      const r = this.stmt("SELECT * FROM memory WHERE id = ? AND kind = 'skill'").get(c.id) as Row | undefined;
      if (r === undefined) continue;
      const s = SkillJson.parse(JSON.parse(r.fields ?? "null"));
      const text = c.after?.kind === "skill" ? c.after.fields : { name: s.name, trigger: s.trigger };
      const next = SkillJson.parse({ ...s, ...text, cleanRuns: 0, onItsOwn: false, wrote: [], promote: s.promote === "declined" ? "declined" : null });
      this.stmt("UPDATE memory SET fields = ? WHERE id = ?").run(JSON.stringify(next), c.id);
    }
    this.routineCache = null;
  }

  /** Gives an index row to each record a user wrote with an id of their own, so it is listed and used like any other. */
  private adopt(): void {
    const known = new Set((this.stmt("SELECT id FROM memory").all() as { id: string }[]).map((x) => x.id));
    const now = Date.now();
    for (const kind of ["about", "people", "preference"] as const) {
      for (const r of this.content.records(kind)) {
        if (known.has(r.id)) continue;
        this.stmt("INSERT INTO memory (id, kind, match, count, first_seen, last_seen, app) VALUES (?, ?, ?, 1, ?, ?, NULL)").run(r.id, kind, `doc:${r.id}`, now, now);
      }
    }
  }

  /** The record behind an about, people, preference or skill row, or null when it is not there or not usable. */
  private record(r: Row): MemoryRecord | null {
    return this.content.get(r);
  }

  /** The record, or a MemoryError saying why it cannot be used. */
  private mustRecord(r: Row): MemoryRecord {
    const rec = this.record(r);
    if (rec === null) throw new MemoryError(this.content.why(r.id, r.kind as RecordKind));
    return rec;
  }

  /** Writes a record's content, turning a file problem into a MemoryError the socket reply carries. */
  private put(rec: MemoryRecord, expect?: string | null): void {
    try {
      this.content.put(rec, expect);
    } catch (e) {
      if (e instanceof MemoryDocumentError) throw new MemoryError(e.message);
      throw e;
    }
  }

  private removeContent(id: string, kind: RecordKind): void {
    try {
      this.content.remove(id, kind);
    } catch (e) {
      if (e instanceof MemoryDocumentError) throw new MemoryError(e.message);
      throw e;
    }
  }

  /**
   * The noticed facts among `ids`, with where Caret saw each: what an offer built from them shows ("from what
   * Caret noticed in Mail, Tue"). Ids of other kinds, or not noticed, are left out.
   */
  noticedAmong(ids: Iterable<string>): NoticedUse[] {
    const out: NoticedUse[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const r = this.stmt("SELECT * FROM memory WHERE id = ?").get(id) as Row | undefined;
      if (r === undefined || (r.kind !== "about" && r.kind !== "people" && r.kind !== "preference")) continue;
      const rec = this.record(r);
      if (rec === null || rec.kind === "skill" || rec.status !== "noticed" || rec.noticed === null) continue;
      const label = rec.kind === "about" ? rec.fields.label : rec.kind === "people" ? rec.fields.alias : rec.fields.rule === "useInstead" ? rec.fields.field : rec.fields.rule === "format" ? "Phone format" : rec.fields.appName;
      out.push({ id, kind: rec.kind, label, noticed: rec.noticed });
    }
    return out;
  }

  /**
   * The user took an offer built from these facts: each one that was noticed is now confirmed (lead decision 3).
   * Returns the ids it confirmed. A record the user changed in the meantime is left as they wrote it.
   */
  confirm(ids: Iterable<string>): string[] {
    this.sync("all");
    const out: string[] = [];
    for (const id of new Set(ids)) {
      const r = this.stmt("SELECT * FROM memory WHERE id = ?").get(id) as Row | undefined;
      if (r === undefined) continue;
      const rec = this.record(r);
      if (rec === null || rec.status !== "noticed") continue;
      try {
        this.put({ ...rec, status: "active" }, recordDigest(rec));
        out.push(id);
      } catch (e) {
        if (!(e instanceof MemoryError)) throw e;
        this.warn(`memory: not confirming ${id}: ${e.message}`);
      }
    }
    return out;
  }

  /**
   * "Not right" on an offer, about a fact it used (lead decision 3): with no correction the fact is forgotten; with
   * one, an about value or a person's name becomes the user's correction, active. A preference can only be
   * forgotten this way. Returns the entry after the change, or null when it was forgotten.
   */
  notRight(id: string, correction: string | null, now: number): MemoryEntry | null {
    const r = this.row(id);
    if (r.kind !== "about" && r.kind !== "people" && r.kind !== "preference") throw new MemoryError(`Not right is for what Caret knows about you and people, not a ${r.kind}`);
    if (correction === null) {
      this.forget(id, now);
      return null;
    }
    this.sync(r.kind);
    const rec = this.mustRecord(r);
    const value = correction.trim();
    if (value === "") throw new MemoryError("the correction is blank; leave it out to forget the fact instead");
    if (ONE_LINE_BREAKS.test(value)) throw new MemoryError("the correction must be one line of text");
    let next: MemoryRecord;
    if (rec.kind === "about") {
      if (rec.fields.source === "typed") checkTyped("edit", rec.fields.label, value);
      next = { ...rec, status: "active", noticed: null, fields: AboutFields.parse({ ...rec.fields, value }) };
    } else if (rec.kind === "people") next = { ...rec, status: "active", noticed: null, fields: PeopleFields.parse({ ...rec.fields, name: value }) };
    else throw new MemoryError("a preference can only be forgotten from Not right; edit it in Caret's memory window instead");
    checkSecret(next);
    this.put(next, recordDigest(rec));
    this.stmt("UPDATE memory SET last_seen = ? WHERE id = ?").run(now, id);
    return this.get(id);
  }

  /** The memory documents, for the host's memory window: each file's path, revision and problems. */
  documents(): DocumentInfo[] {
    return this.documentStore().documents();
  }

  /** One document's text and revision. */
  readDocument(doc: DocId): { text: string; info: DocumentInfo } {
    try {
      return this.documentStore().read(doc);
    } catch (e) {
      if (e instanceof MemoryDocumentError) throw new MemoryError(e.message);
      throw e;
    }
  }

  /**
   * The host's save of a document from its editor, only from the revision it was showing (a MemoryConflictError
   * otherwise, nothing written). The user's edits in it are changes made outside Caret, handled as an editor's are.
   */
  saveDocument(doc: DocId, base: string | null, text: string): DocumentInfo {
    const store = this.documentStore();
    const info = store.saveDocument(doc, base, text);
    // Picked up now, so offers and tasks that used what changed are withdrawn before the reply goes out.
    const changes = store.takeChanges();
    if (changes.length > 0) {
      this.adopt();
      this.applyOutside(changes);
      this.outside.push(...changes);
    }
    return info;
  }

  private documentStore(): MemoryDocumentStore {
    if (this.content.documents === null) throw new MemoryError(`memory is still in the sealed store${this.migration.error === null ? "" : `: ${this.migration.error}`}`);
    return this.content.documents;
  }

  // MARK: - the socket API

  list(kind?: MemoryKind): MemoryEntry[] {
    this.sync(kind ?? "all");
    const rows = (kind === undefined
      ? this.stmt("SELECT * FROM memory ORDER BY kind, last_seen DESC").all()
      : this.stmt("SELECT * FROM memory WHERE kind = ? ORDER BY last_seen DESC").all(kind)) as unknown as Row[];
    // An about, people or preference row whose record is gone or broken in its file is not shown: the file says why.
    return rows.flatMap((r) => (r.kind === "about" || r.kind === "people" || r.kind === "preference") && this.record(r) === null ? [] : [this.entry(r)]);
  }

  get(id: string): MemoryEntry {
    const r = this.row(id);
    this.sync(r.kind);
    return this.entry(this.row(id));
  }

  /** Changes what the user may change in an entry. Anything else is refused with the reason. */
  edit(id: string, raw: Record<string, unknown>, now: number): MemoryEntry {
    const r0 = this.row(id);
    this.sync(r0.kind);
    const r = this.row(id);
    this.routineCache = null;
    switch (r.kind) {
      case "about":
      case "people":
      case "preference": {
        const rec = this.mustRecord(r);
        let fields: MemoryRecord["fields"];
        if (rec.kind === "about") {
          const a = { ...rec.fields, ...parseEdit(z.strictObject({ label: AboutFields.shape.label.optional(), value: AboutFields.shape.value.optional() }), raw) };
          // A typed entry stays one the user could have typed: trimmed, one line, an address under an email label.
          if (a.source === "typed") {
            a.label = a.label.trim();
            a.value = a.value.trim();
            checkTyped("edit", a.label, a.value);
          }
          fields = a;
        } else if (rec.kind === "people") {
          fields = { ...rec.fields, ...parseEdit(z.strictObject({ alias: PeopleFields.shape.alias.optional(), name: PeopleFields.shape.name.optional() }), raw) };
        } else {
          const p = rec.fields as PreferenceFields;
          if (p.rule !== "format") throw new MemoryError(`a ${p.rule} preference has nothing to edit; forget it instead`);
          const e = parseEdit(z.strictObject({ template: z.string() }), raw);
          checkTemplate(e.template);
          fields = { ...p, template: e.template };
        }
        // The user's own edit: no longer something Caret only noticed.
        const next = { ...rec, status: rec.status === "paused" ? "paused" : "active", noticed: null, fields } as MemoryRecord;
        checkSecret(next);
        this.put(next, recordDigest(rec));
        break;
      }
      case "routine": {
        // The same check as a skill's name (CodeRabbit on PR #5): a routine's name becomes the skill's when it is kept.
        const e = parseEdit(z.strictObject({ name: z.string().trim().min(1).max(80).nullable() }), raw);
        if (e.name !== null && ONE_LINE_BREAKS.test(e.name)) throw new MemoryError("invalid edit: a routine's name must be one line of text");
        this.stmt("UPDATE memory SET fields = ? WHERE id = ?").run(JSON.stringify({ ...routineJson(r), name: e.name, nameBy: e.name === null ? null : "you" }), id);
        break;
      }
      case "skill": {
        // The user can always take a skill's autonomy back (the host's "Put back on Tab": onItsOwn false), never
        // grant it here: running on its own comes only from accepting Caret's promote offer (B21).
        if (raw.onItsOwn === true) throw new MemoryError("a skill runs on its own only after you accept Caret's offer; an edit can only put it back on Tab");
        const e = parseEdit(
          z.strictObject({ name: z.string().trim().min(1).max(80).optional(), onItsOwn: z.literal(false).optional() }).refine((x) => x.name !== undefined || x.onItsOwn !== undefined, "a skill edit changes its name or puts it back on Tab"),
          raw,
        );
        if (e.name !== undefined && ONE_LINE_BREAKS.test(e.name)) throw new MemoryError("invalid edit: a skill's name must be one line of text");
        const s = this.toSkill(r);
        // Back on Tab as after a failed run (skills.ts reset): the clean count starts again, and a declined promote
        // offer stays declined. Unlike after a failed run, Caret never offers it again on its own (B22 lead
        // decision): the user asks for the offer from the skill's row (memoryRequest offerOnItsOwn).
        const back = e.onItsOwn === false ? { onItsOwn: false, cleanRuns: 0, wrote: [], promote: s.promote === "declined" ? ("declined" as const) : null, putBack: true } : {};
        this.updateSkill(id, { ...(e.name === undefined ? {} : { name: e.name }), ...back }, now);
        break;
      }
      case "permission": {
        const p = PermissionFields.parse(JSON.parse(r.fields ?? "null"));
        const e = parseEdit(z.strictObject({ rule: PermissionFields.shape.rule }), raw);
        const allowed = PERMISSIONS[p.action].allowed;
        if (!allowed.includes(e.rule)) throw new MemoryError(`${p.action} can be ${allowed.join(" or ")}, not ${e.rule}`);
        this.stmt("UPDATE memory SET fields = ? WHERE id = ?").run(JSON.stringify({ ...p, rule: e.rule }), id);
        break;
      }
    }
    this.stmt("UPDATE memory SET last_seen = ? WHERE id = ?").run(now, id);
    return this.get(id);
  }

  setPaused(id: string, paused: boolean): MemoryEntry {
    const r = this.row(id);
    if (r.kind === "permission") throw new MemoryError("a permission cannot be paused; change its rule instead");
    this.sync(r.kind);
    if (r.kind === "about" || r.kind === "people" || r.kind === "preference") {
      const rec = this.mustRecord(r);
      this.put({ ...rec, status: paused ? "paused" : "active" }, recordDigest(rec));
    } else if (r.kind === "skill") {
      // Pausing always works: a skill whose file cannot be read is already off. Resuming needs the file readable.
      const rec = this.record(r);
      if (rec !== null) this.put({ ...rec, status: paused ? "paused" : "active" }, recordDigest(rec));
      else if (!paused) throw new MemoryError(this.content.why(r.id, "skill"));
    }
    this.stmt("UPDATE memory SET paused = ? WHERE id = ?").run(paused ? 1 : 0, id);
    this.routineCache = null;
    return this.get(id);
  }

  /**
   * Deletes an entry, its content and its sealed backup. A forgotten routine is not relearned for FORGET_BLOCK_MS,
   * and its skill goes with it. A forgotten skill leaves its routine, marked declined, so Caret does not ask to keep
   * it again.
   */
  forget(id: string, now: number): void {
    const r = this.row(id);
    this.routineCache = null;
    if (r.kind === "permission") throw new MemoryError("a permission cannot be forgotten; change its rule instead");
    if (DOC_KINDS.has(r.kind)) this.sync(r.kind);
    if (r.kind === "routine") {
      this.db
        .prepare("INSERT INTO forgotten (kind, match, until) VALUES (?, ?, ?) ON CONFLICT(kind, match) DO UPDATE SET until = excluded.until")
        .run(r.kind, r.match, now + FORGET_BLOCK_MS);
      for (const s of this.stmt("SELECT id FROM memory WHERE kind = 'skill' AND match = ?").all(id) as { id: string }[]) {
        this.removeContent(s.id, "skill");
        this.stmt("DELETE FROM memory WHERE id = ?").run(s.id);
      }
    }
    if (r.kind === "skill") {
      this.removeContent(id, "skill");
      const routineId = r.match;
      if (this.routine(routineId) !== null) this.setRoutineKeep(routineId, "declined");
    }
    if (r.kind === "about" || r.kind === "people" || r.kind === "preference") this.removeContent(id, r.kind);
    if (r.kind === "about") {
      // A preference that pointed at this value would otherwise point at nothing.
      for (const p of this.rows("preference")) {
        const f = this.record(p);
        if (f?.kind === "preference" && f.fields.rule === "useInstead" && f.fields.aboutId === id) {
          this.removeContent(p.id, "preference");
          this.stmt("DELETE FROM memory WHERE id = ?").run(p.id);
          this.stmt("DELETE FROM memory_backup WHERE id = ?").run(p.id);
        }
      }
    }
    this.stmt("DELETE FROM memory WHERE id = ?").run(id);
    this.stmt("DELETE FROM memory_backup WHERE id = ?").run(id);
  }

  /**
   * Keeps an About entry the user typed into Caret (memoryRequest op `add`): "remember this", active at once, in
   * about-me.md. `match` is the keyed hash of its label (typedAboutMatch), so typing a Name again replaces the Name
   * entry rather than adding a second one. Refuses anything but {label, value, source: "typed"}, saying what was wrong.
   */
  addTyped(raw: Record<string, unknown>, match: (label: string) => string, at: number): MemoryEntry {
    const r = TypedAbout.safeParse(raw);
    if (!r.success) throw new MemoryError(`invalid add: ${r.error.issues.map((i) => `${i.path.join(".") || "fields"}: ${i.message}`).join("; ")}`);
    const label = r.data.label.trim();
    const value = r.data.value.trim();
    checkTyped("add", label, value);
    this.routineCache = null;
    return this.get(this.upsert("about", match(label), { label, value, source: "typed" }, at, null));
  }

  /** "Remember this" for a person: `alias` means `name`, active at once, in people.md. A second add of the alias replaces it. */
  addPerson(raw: Record<string, unknown>, match: (alias: string) => string, at: number): MemoryEntry {
    const r = TypedPerson.safeParse(raw);
    if (!r.success) throw new MemoryError(`invalid add: ${r.error.issues.map((i) => `${i.path.join(".") || "fields"}: ${i.message}`).join("; ")}`);
    const alias = r.data.alias.trim();
    const name = r.data.name.trim();
    if (alias === "" || name === "") throw new MemoryError("invalid add: a person needs an alias and a name");
    if (ONE_LINE_BREAKS.test(alias) || ONE_LINE_BREAKS.test(name)) throw new MemoryError("invalid add: an alias and a name are each one line of text");
    return this.get(this.upsert("people", match(alias), { alias, name }, at, null));
  }

  /** The text an active About or people entry gives a plan or fill: its value or the person's name; null when gone, paused or another kind. Checked by content, as before an act. */
  text(id: string): string | null {
    const r0 = this.stmt("SELECT * FROM memory WHERE id = ?").get(id) as Row | undefined;
    if (r0 === undefined) return null;
    this.sync(r0.kind, true);
    const r = this.stmt("SELECT * FROM memory WHERE id = ?").get(id) as Row | undefined;
    if (r === undefined) return null;
    const rec = this.record(r);
    if (rec === null || rec.status === "paused") return null;
    if (rec.kind === "about") return rec.fields.value;
    if (rec.kind === "people") return rec.fields.name;
    return null;
  }

  /** The entry of this kind with this match key, or null; an about, people or preference entry only while its record is readable. */
  owner(kind: MemoryKind, match: string): string | null {
    this.sync(kind);
    const r = this.stmt("SELECT * FROM memory WHERE kind = ? AND match = ?").get(kind, match) as Row | undefined;
    if (r === undefined) return null;
    if ((kind === "about" || kind === "people" || kind === "preference") && this.record(r) === null) return null;
    return r.id;
  }

  /** Moves an entry to another match key: a typed About entry whose label the user edited. */
  rekey(id: string, match: string): void {
    this.stmt("UPDATE memory SET match = ? WHERE id = ?").run(match, id);
  }

  // MARK: - for recognizers, fills and the gate

  /**
   * Adds an entry, or counts another sighting of the entry with the same kind and match key. With `noticed`, the
   * fact is one Caret saw itself (lead decision 3): it goes straight into its file marked noticed, with where and
   * when, and is used at once. Without, it is the user's own and active. A sighting never turns the user's active
   * value back into a noticed one, and a paused entry stays paused.
   */
  upsert(kind: "about" | "people" | "preference", match: string, fields: AboutFields | PeopleFields | PreferenceFields, at: number, app: string | null, noticed: Noticed | null = null): string {
    // Checked on the way in, so an entry that list() could not render is never stored.
    const schema = kind === "about" ? AboutFields : kind === "people" ? PeopleFields : PreferenceFields;
    const valid = schema.safeParse(fields);
    if (!valid.success) throw new MemoryError(`not storing a ${kind} entry: ${valid.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    this.sync(kind);
    const hit = this.stmt("SELECT * FROM memory WHERE kind = ? AND match = ?").get(kind, match) as Row | undefined;
    if (hit !== undefined) {
      const cur = this.record(hit);
      const same = cur !== null && sameFields(cur.fields, valid.data);
      let status: RecordStatus = noticed === null ? "active" : "noticed";
      let provenance = noticed;
      if (cur?.status === "paused") status = "paused";
      else if (same && cur.status === "active" && noticed !== null) {
        status = "active";
        provenance = cur.noticed;
      }
      const next = { id: hit.id, kind, status, noticed: provenance, fields: valid.data } as MemoryRecord;
      checkSecret(next);
      if (cur === null || recordDigest(cur) !== recordDigest(next)) this.put(next, cur === null ? null : recordDigest(cur));
      this.stmt("UPDATE memory SET count = count + 1, last_seen = ?, app = COALESCE(?, app) WHERE id = ?").run(at, app, hit.id);
      return hit.id;
    }
    const id = `${kind}-${randomUUID().slice(0, 8)}`;
    const next = { id, kind, status: noticed === null ? "active" : "noticed", noticed, fields: valid.data } as MemoryRecord;
    checkSecret(next);
    this.batch(() => {
      this.db.prepare("INSERT INTO memory (id, kind, match, count, first_seen, last_seen, app) VALUES (?, ?, ?, 1, ?, ?, ?)").run(id, kind, match, at, at, app);
      // The file is written inside the transaction: a refused write leaves no index row behind.
      this.put(next, null);
    });
    return id;
  }

  /** Active and noticed (not paused) entries of a kind with their fields, for applying rules. */
  active<K extends "about" | "people" | "preference">(kind: K): { id: string; match: string; fields: K extends "about" ? AboutFields : K extends "people" ? PeopleFields : PreferenceFields }[] {
    this.sync(kind);
    return this.rows(kind).flatMap((r) => {
      const rec = this.record(r);
      return rec === null || rec.status === "paused" ? [] : [{ id: r.id, match: r.match, fields: rec.fields as never }];
    });
  }

  about(id: string): AboutFields | null {
    this.sync("about");
    const r = this.stmt("SELECT * FROM memory WHERE id = ? AND kind = 'about'").get(id) as Row | undefined;
    if (r === undefined) return null;
    const rec = this.record(r);
    return rec === null || rec.status === "paused" || rec.kind !== "about" ? null : rec.fields;
  }

  /**
   * Counts a completed bundle with this signature. Null when the user forgot this routine recently.
   * `finish` is the press the occurrence ended with, when it was learned; undefined keeps the one known.
   */
  recordRoutine(sig: string, steps: RoutineStep[], at: number, finish?: RoutineFinish | null): RoutineRecord | null {
    this.routineCache = null;
    const block = this.stmt("SELECT until FROM forgotten WHERE kind = 'routine' AND match = ?").get(sig) as { until: number } | undefined;
    if (block !== undefined && block.until > at) return null;
    const hit = this.stmt("SELECT id FROM memory WHERE kind = 'routine' AND match = ?").get(sig) as { id: string } | undefined;
    if (hit !== undefined) {
      // The latest occurrence's positions are the best guess for the next one; the rest of the row stays.
      const f = routineJson(this.row(hit.id));
      // A guess from the window's buttons never replaces a press the user was seen making (B20).
      const seen = (by: RoutineFinish["by"]): boolean => by === "click" || by === "key";
      if (!seen(finish?.by) && seen(f.finish?.by)) finish = undefined;
      this.stmt("UPDATE memory SET count = count + 1, last_seen = ?, fields = ? WHERE id = ?").run(at, JSON.stringify({ ...f, steps, ...(finish === undefined ? {} : { finish }) }), hit.id);
      // A press learned after the routine was kept holds its skill on Tab from now on.
      const skill = finish === undefined || finish === null ? null : this.skillFor(hit.id);
      if (skill !== null && finish !== undefined && finish !== null && (skill.handsOff?.label !== finish.label || skill.onItsOwn)) {
        this.updateSkill(skill.id, { handsOff: { label: finish.label, why: finish.why }, onItsOwn: false }, at);
      }
      return this.routine(hit.id);
    }
    const id = `routine-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare("INSERT INTO memory (id, kind, match, fields, count, first_seen, last_seen, app) VALUES (?, 'routine', ?, ?, 1, ?, ?, ?)")
      .run(id, sig, JSON.stringify({ steps, name: null, finish: finish ?? null }), at, at, steps[0]?.dstApp ?? null);
    return this.routine(id);
  }

  /** Changes keys of a routine's JSON other than its steps. */
  private patchRoutine(id: string, patch: Partial<RoutineJson>): void {
    const r = this.stmt("SELECT * FROM memory WHERE id = ? AND kind = 'routine'").get(id) as Row | undefined;
    if (r === undefined) throw new MemoryError(`no routine ${id}`);
    this.routineCache = null;
    this.stmt("UPDATE memory SET fields = ? WHERE id = ?").run(JSON.stringify({ ...routineJson(r), ...patch }), id);
  }

  /** Records that naming started for this routine, so it is asked once only. */
  markNamingAsked(id: string): void {
    this.patchRoutine(id, { namingAsked: true });
  }

  /**
   * Names a routine that has no name yet. The first name stays: one the user gave, or code's fallback that a
   * keep offer already showed while Jev's answer was still on its way (B19 live eval), is never replaced.
   */
  setRoutineName(id: string, name: string, by: "jev" | "code"): void {
    const r = this.routine(id);
    if (r === null || r.name !== null) return;
    this.patchRoutine(id, { name, nameBy: by });
  }

  setRoutineKeep(id: string, keep: KeepState): void {
    this.patchRoutine(id, { keep });
  }

  // MARK: - skills (B19)

  /** Keep and promote offers live in memory only; one marked out when the helper stopped is not out any more. */
  clearOfferedSkillStates(): void {
    this.batch(() => {
      for (const r of this.rows("routine")) if (routineJson(r).keep === "offered") this.patchRoutine(r.id, { keep: null });
      for (const r of this.rows("skill")) {
        const s = this.toSkill(r);
        if (s.promote === "offered") this.updateSkill(s.id, { promote: null }, Number(r.last_seen));
      }
    });
  }

  /**
   * Makes a routine a skill, in the learning state: on Tab, no runs counted yet. The routine is marked
   * kept. A routine that is already a skill keeps the one it has. Its name and trigger go to skills/<id>.md;
   * its counts and approvals stay here.
   */
  addSkill(routineId: string, fields: Pick<SkillRecord, "name" | "trigger" | "needed" | "handsOff">, at: number): SkillRecord {
    const routine = this.routine(routineId);
    if (routine === null) throw new MemoryError(`no routine ${routineId}`);
    const have = this.skillFor(routineId);
    if (have !== null) return have;
    const id = `skill-${randomUUID().slice(0, 8)}`;
    const json = SkillJson.parse({ routineId, ...fields, runs: 0, cleanRuns: 0, onItsOwn: false, promote: null, wrote: [] });
    this.batch(() => {
      this.db
        .prepare("INSERT INTO memory (id, kind, match, fields, count, first_seen, last_seen, app) VALUES (?, 'skill', ?, ?, 0, ?, ?, ?)")
        .run(id, routineId, JSON.stringify(json), at, at, routine.steps[0]?.dstApp ?? null);
      this.setRoutineKeep(routineId, "kept");
      this.put({ id, kind: "skill", status: "active", noticed: null, fields: { name: json.name, trigger: json.trigger } }, null);
    });
    return this.skill(id) as SkillRecord;
  }

  skill(id: string): SkillRecord | null {
    this.sync("skill");
    const r = this.stmt("SELECT * FROM memory WHERE id = ? AND kind = 'skill'").get(id) as Row | undefined;
    return r === undefined ? null : this.toSkill(r);
  }

  /** The skill made from this routine, paused or not; null when it was never kept or was forgotten. */
  skillFor(routineId: string): SkillRecord | null {
    this.sync("skill");
    const r = this.stmt("SELECT * FROM memory WHERE kind = 'skill' AND match = ?").get(routineId) as Row | undefined;
    return r === undefined ? null : this.toSkill(r);
  }

  /** Changes a skill's counts and state. The entry's evidence count is its runs. A new name goes to its file first. */
  updateSkill(id: string, patch: Partial<Omit<SkillRecord, "id" | "paused" | "routineId">>, at: number): SkillRecord {
    const r = this.stmt("SELECT * FROM memory WHERE id = ? AND kind = 'skill'").get(id) as Row | undefined;
    if (r === undefined) throw new MemoryError(`no skill ${id}`);
    const cur = SkillJson.parse(JSON.parse(r.fields ?? "null"));
    const next = SkillJson.parse({ ...cur, ...patch });
    if ((patch.name !== undefined && patch.name !== cur.name) || (patch.trigger !== undefined && patch.trigger !== cur.trigger)) {
      const rec = this.mustRecord(r);
      if (rec.kind === "skill") this.put({ ...rec, fields: { name: next.name, trigger: next.trigger } }, recordDigest(rec));
    }
    this.routineCache = null;
    this.stmt("UPDATE memory SET fields = ?, last_seen = ?, count = ? WHERE id = ?").run(JSON.stringify(next), at, next.runs, id);
    return this.skill(id) as SkillRecord;
  }

  routine(id: string): RoutineRecord | null {
    const r = this.stmt("SELECT * FROM memory WHERE id = ? AND kind = 'routine'").get(id) as Row | undefined;
    return r === undefined ? null : toRoutine(r, this.skillPausedFor());
  }

  /** Routines whose skill is paused, in the database or its file, or whose file cannot be read. */
  private skillPausedFor(): Set<string> {
    this.sync("skill");
    return new Set(this.rows("skill").flatMap((r) => (this.toSkill(r).paused ? [r.match] : [])));
  }

  /** Routines whose steps all write into windows of this app and kind. */
  routinesInto(bundleId: string, windowKind: string): RoutineRecord[] {
    this.sync("skill");
    if (this.routineCache === null) {
      const paused = this.skillPausedFor();
      this.routineCache = this.rows("routine").map((r) => toRoutine(r, paused));
    }
    return this.routineCache.filter((r) => r.steps.length > 0 && r.steps.every((s) => s.dstBundle === bundleId && s.dstWindowKind === windowKind));
  }

  scoreRoutine(id: string, hit: boolean): void {
    this.routineCache = null;
    this.stmt(`UPDATE memory SET ${hit ? "hits = hits + 1" : "misses = misses + 1"} WHERE id = ? AND kind = 'routine'`).run(id);
  }

  permission(action: ActionType): PermissionRule {
    const r = this.stmt("SELECT * FROM memory WHERE kind = 'permission' AND match = ?").get(action) as Row | undefined;
    return r === undefined ? PERMISSIONS[action].rule : PermissionFields.parse(JSON.parse(r.fields ?? "null")).rule;
  }

  logDecision(d: DecisionRow): void {
    this.pendingDecisions.push(d);
  }

  /** Runs `f` in one transaction, so several writes on the event path cost one commit. Nested calls join the outer one. */
  batch<T>(f: () => T): T {
    if (this.db.isTransaction) return f();
    this.db.exec("BEGIN");
    try {
      const out = f();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Records one use of a permission (B17): what Caret did under it, where, when and how it ended. Buffered
   * like decisions and written on the tick; each action keeps its last MAX_PERMISSION_USES.
   */
  recordUse(action: ActionType, use: Required<PermissionUse>): void {
    this.pendingUses.push({ action, use });
  }

  /** Writes buffered uses, then trims each action they touched to its last MAX_PERMISSION_USES. */
  private flushUses(): void {
    if (this.pendingUses.length === 0) return;
    const insert = this.stmt("INSERT INTO uses (action, at, sealed) VALUES (?, ?, ?)");
    const trim = this.stmt("DELETE FROM uses WHERE action = ? AND id NOT IN (SELECT id FROM uses WHERE action = ? ORDER BY at DESC, id DESC LIMIT ?)");
    this.batch(() => {
      for (const { action, use } of this.pendingUses) insert.run(action, use.at, seal(this.key, JSON.stringify({ says: use.says, app: use.app, outcome: use.outcome })));
      for (const action of new Set(this.pendingUses.map((u) => u.action))) trim.run(action, action, MAX_PERMISSION_USES);
    });
    this.pendingUses = [];
  }

  /** A permission's last uses, newest first. */
  uses(action: ActionType): Required<PermissionUse>[] {
    this.flushUses();
    const rows = this.stmt("SELECT at, sealed FROM uses WHERE action = ? ORDER BY at DESC, id DESC LIMIT ?").all(action, MAX_PERMISSION_USES) as { at: number; sealed: Uint8Array }[];
    return rows.map((r) => {
      const f = UseFields.parse(JSON.parse(open(this.key, Buffer.from(r.sealed))));
      return { at: Number(r.at), ...f };
    });
  }

  /** Writes buffered decisions and permission uses, each in one transaction. Called on the helper's tick and at close. */
  flushDecisions(): void {
    this.flushUses();
    if (this.pendingDecisions.length === 0) return;
    const stmt = this.stmt("INSERT INTO decisions (at, offer_kind, pattern, bundle_id, speak, reasons, p_show) VALUES (?, ?, ?, ?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const d of this.pendingDecisions) stmt.run(d.at, d.offerKind, d.pattern, d.bundleId, d.speak ? 1 : 0, d.reasons.join(","), d.showProbability);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.pendingDecisions = [];
  }

  decisions(): DecisionRow[] {
    this.flushDecisions();
    return (this.stmt("SELECT * FROM decisions ORDER BY id").all() as Record<string, unknown>[]).map((r) => ({
      at: Number(r.at),
      offerKind: r.offer_kind as OfferKind,
      pattern: String(r.pattern),
      bundleId: String(r.bundle_id),
      speak: r.speak === 1,
      reasons: String(r.reasons) === "" ? [] : String(r.reasons).split(","),
      showProbability: Number(r.p_show),
    }));
  }

  /** A dismissal, a "Don't offer this here", or an offer withdrawn because the user did something else. */
  recordReaction(offerKind: OfferKind, bundleId: string, action: "dismiss" | "dontOfferHere" | "ignored" | "take", at: number): void {
    this.stmt("INSERT INTO reactions (at, day, offer_kind, bundle_id, action) VALUES (?, ?, ?, ?, ?)").run(at, localDay(at), offerKind, bundleId, action);
  }

  /** Offers of this kind in this app that the user dismissed or ignored on `at`'s day. */
  ignoredOn(offerKind: OfferKind, bundleId: string, at: number): number {
    return Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM reactions WHERE day = ? AND offer_kind = ? AND bundle_id = ? AND action IN ('dismiss', 'ignored')")
          .get(localDay(at), offerKind, bundleId) as { n: number }
      ).n,
    );
  }

  /** By match key, which for these rules is plain kind and bundle id; the record decides whether it is paused. */
  dontOffer(offerKind: OfferKind, bundleId: string): boolean {
    this.sync("preference");
    const r = this.stmt("SELECT * FROM memory WHERE kind = 'preference' AND match = ?").get(dontOfferMatch(offerKind, bundleId)) as Row | undefined;
    if (r === undefined) return false;
    const rec = this.record(r);
    return rec !== null && rec.status !== "paused";
  }

  /** The raw rows, for tests that check nothing personal is stored in the clear. */
  rawRows(): Row[] {
    return this.stmt("SELECT * FROM memory").all() as unknown as Row[];
  }

  // MARK: - internals

  private seedPermissions(): void {
    const now = Date.now();
    for (const [action, p] of Object.entries(PERMISSIONS) as [ActionType, (typeof PERMISSIONS)[ActionType]][]) {
      const fields: PermissionFields = { action, rule: p.rule, fixed: p.allowed.length === 1 };
      this.db
        .prepare("INSERT INTO memory (id, kind, match, fields, count, first_seen, last_seen) SELECT ?, 'permission', ?, ?, 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM memory WHERE kind = 'permission' AND match = ?)")
        .run(`permission-${action}`, action, JSON.stringify(fields), now, now, action);
    }
  }

  private row(id: string): Row {
    const r = this.stmt("SELECT * FROM memory WHERE id = ?").get(id) as Row | undefined;
    if (r === undefined) throw new MemoryError(`no memory entry ${id}`);
    return r;
  }

  private rows(kind: MemoryKind): Row[] {
    return this.stmt("SELECT * FROM memory WHERE kind = ?").all(kind) as unknown as Row[];
  }

  /**
   * A skill: its protected fields from the database, its name and trigger from its file. It counts as paused when
   * either says so, or when its file cannot be read: a broken or missing file turns a skill off, never on.
   */
  private toSkill(r: Row): SkillRecord {
    const s = SkillJson.parse(JSON.parse(r.fields ?? "null"));
    const rec = this.record(r);
    const text = rec?.kind === "skill" ? rec.fields : { name: s.name, trigger: s.trigger };
    return { ...s, ...text, id: r.id, paused: r.paused !== 0 || rec === null || rec.status === "paused" };
  }

  private entry(r: Row): MemoryEntry {
    const evidence = { count: Number(r.count), lastSeen: Number(r.last_seen), app: r.app };
    const paused = r.paused !== 0;
    switch (r.kind) {
      case "about":
      case "people":
      case "preference": {
        const rec = this.mustRecord(r);
        const noticed = rec.noticed === null ? {} : { noticed: { app: rec.noticed.app, windowTitle: rec.noticed.window, at: rec.noticed.at } };
        if (rec.kind === "about") {
          const f = rec.fields;
          return { kind: "about", id: r.id, status: rec.status, evidence, ...noticed, fields: f, says: `${f.label}: ${f.value} (${ABOUT_SOURCE[f.source]})` };
        }
        if (rec.kind === "people") {
          const f = rec.fields;
          const app = r.app === null ? "" : ` in ${r.app}`;
          return { kind: "people", id: r.id, status: rec.status, evidence, ...noticed, fields: f, says: `"${f.alias}"${app} usually means ${f.name} (chosen ${times(r.count)})` };
        }
        const f = rec.fields as PreferenceFields;
        return { kind: "preference", id: r.id, status: rec.status, evidence, ...noticed, fields: f, says: this.preferenceSays(f, Number(r.count)) };
      }
      case "routine": {
        const rec = toRoutine(r);
        const status: MemoryStatus = paused ? "paused" : offerable(rec, this.routineSightings) ? "active" : "learning";
        const srcApps = [...new Set(rec.steps.map((s) => s.srcApp))];
        const dstApp = rec.steps[0]?.dstApp ?? "";
        const f = { srcApps, dstApp, steps: Math.max(1, rec.steps.length), name: rec.name, silent: { hits: rec.hits, misses: rec.misses } };
        const what = rec.name ?? `${rec.steps.length} values from ${srcApps.join(" and ")} to ${dstApp}`;
        const how = status === "active" ? "asks first" : status === "paused" ? "paused" : `learning, ${rec.hits} of ${this.routineSightings} silent predictions right`;
        return { kind: "routine", id: r.id, status, evidence, fields: f, says: `${what} (seen ${times(r.count)}; ${how})` };
      }
      case "permission": {
        const f = PermissionFields.parse(JSON.parse(r.fields ?? "null"));
        return { kind: "permission", id: r.id, status: "active", evidence, fields: f, says: `${PERMISSIONS[f.action].says}: ${RULE_SAYS[f.rule]}`, uses: this.uses(f.action) };
      }
      case "skill": {
        // `wrote` goes to the host too, for its permissions page (A16); the promote state and putBack stay here.
        const { promote: _p, putBack: _b, id: _i, paused: skillPaused, ...f } = this.toSkill(r);
        const status: MemoryStatus = skillPaused ? "paused" : f.onItsOwn ? "active" : "learning";
        const how = skillPaused
          ? "paused"
          : f.onItsOwn
            ? "runs on its own, with undo"
            : f.handsOff !== null
              ? `asks first; you press '${f.handsOff.label}' yourself`
              : `asks first; ${f.cleanRuns} of ${f.needed} clean runs in a row`;
        return { kind: "skill", id: r.id, status, evidence, fields: f, says: `${f.name}: when ${f.trigger} (ran ${times(f.runs)}; ${how})` };
      }
    }
  }

  private preferenceSays(f: PreferenceFields, count: number): string {
    switch (f.rule) {
      case "format":
        return `Phone numbers go in as ${formatDigits(f.template, SAMPLE_PHONE) ?? f.template} (you changed this ${times(count)})`;
      case "useInstead": {
        const a = this.about(f.aboutId);
        return `${f.field} gets your ${a === null ? "missing value" : `${a.label}, ${a.value}`} (you changed this ${times(count)})`;
      }
      case "dontOffer":
        return `Don't offer ${OFFER_SAYS[f.offerKind]} in ${f.appName}`;
    }
  }
}

const ABOUT_SOURCE: Record<AboutFields["source"], string> = { contacts: "from your Contacts card", typed: "you typed this", edit: "from your edit" };

/** A use's sealed fields, checked when read back. */
const UseFields = z.object({ says: z.string().min(1), app: z.string().nullable(), outcome: UseOutcome });

/** What an `add` may carry: an About entry the user typed, nothing else. */
const TypedAbout = z.strictObject({ label: AboutFields.shape.label, value: AboutFields.shape.value, source: z.literal("typed") });

/** What a people `add` may carry: who an alias means. */
const TypedPerson = z.strictObject({ alias: PeopleFields.shape.alias, name: PeopleFields.shape.name });

/** Refuses a record holding what Caret never keeps in memory (memory/sensitive.ts), by its label and value. */
function checkSecret(r: MemoryRecord): void {
  const s =
    r.kind === "about"
      ? sensitiveKind(r.fields.label, r.fields.value)
      : r.kind === "people"
        ? (valueKind(r.fields.alias) ?? valueKind(r.fields.name))
        : r.kind === "skill"
          ? (valueKind(r.fields.name) ?? valueKind(r.fields.trigger))
          : null;
  if (s !== null) throw new MemoryError(refusal(s));
}

/** The same fields, whatever order their keys are in. */
function sameFields(a: object, b: object): boolean {
  const canon = (o: object): string => JSON.stringify(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return canon(a) === canon(b);
}

/** One address, as a typed Email entry must hold: no spaces, one @, a dot in the domain. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * Checks a typed label and value after trimming. A typed value is one line, since fills copy it into
 * one field; a label that names an email holds one address, so a typo is caught where the user typed
 * it rather than written into a form later.
 */
function checkTyped(op: "add" | "edit", label: string, value: string): void {
  if (label === "") throw new MemoryError(`invalid ${op}: the label is blank`);
  if (value === "") throw new MemoryError(`invalid ${op}: ${label} is blank`);
  if (ONE_LINE_BREAKS.test(label) || ONE_LINE_BREAKS.test(value)) throw new MemoryError(`invalid ${op}: ${label} must be one line of text`);
  if (fieldKinds([label]).has("email") && !EMAIL.test(value)) throw new MemoryError(`invalid ${op}: ${label} must be one email address, like name@example.com`);
}

/** Control characters, and the Unicode line and paragraph separators. */
const ONE_LINE_BREAKS = /[\p{Cc}\u2028\u2029]/u;

/** The text a typed About entry's match key hashes: its label, so one label holds one typed value. */
export const typedAboutKey = (label: string): string => `about-typed\u0000${label.trim().toLowerCase()}`;

/** A routine's silent predictions have matched often enough for it to be offered: `sightings` hits at ROUTINE_MIN_PRECISION or better. */
export function routineProven(hits: number, misses: number, sightings: number): boolean {
  const n = hits + misses;
  return hits >= sightings && n > 0 && hits / n >= ROUTINE_MIN_PRECISION;
}

export function offerable(r: RoutineRecord, sightings: number): boolean {
  return !r.paused && !r.skillPaused && routineProven(r.hits, r.misses, sightings);
}

/** Writes the last digits of `value` into the "#" slots of `template`; null when there are too few digits. */
export function formatDigits(template: string, value: string): string | null {
  const slots = [...template].filter((c) => c === "#").length;
  const digits = value.replace(/\D/g, "");
  if (slots === 0 || digits.length < slots) return null;
  const use = digits.slice(digits.length - slots);
  let i = 0;
  return [...template].map((c) => (c === "#" ? use[i++] : c)).join("");
}

function checkTemplate(t: string): void {
  const slots = [...t].filter((c) => c === "#").length;
  if (slots < 7 || slots > 15) throw new MemoryError(`a phone format needs 7 to 15 "#" digits, and "${t}" has ${slots}`);
  if (/\d/.test(t)) throw new MemoryError(`a phone format uses "#" for each digit and holds no digits itself`);
}

function parseEdit<T extends z.ZodType>(schema: T, raw: Record<string, unknown>): z.infer<T> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new MemoryError(`invalid edit: ${r.error.issues.map((i) => `${i.path.join(".") || "fields"}: ${i.message}`).join("; ")}`);
  return r.data;
}

/** A routine row's JSON, checked: a row this code cannot read is an error, not a guess. */
function routineJson(r: Row): RoutineJson {
  const parsed = RoutineJson.safeParse(JSON.parse(r.fields ?? "{}"));
  if (!parsed.success) throw new MemoryError(`routine ${r.id} has fields this helper cannot read: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

function toRoutine(r: Row, skillPaused: ReadonlySet<string> = new Set()): RoutineRecord {
  const f = routineJson(r);
  return {
    id: r.id,
    sig: r.match,
    steps: f.steps ?? [],
    count: Number(r.count),
    hits: Number(r.hits),
    misses: Number(r.misses),
    paused: r.paused !== 0,
    name: f.name ?? null,
    nameBy: f.nameBy ?? null,
    namingAsked: f.namingAsked ?? false,
    keep: f.keep ?? null,
    finish: f.finish ?? null,
    skillPaused: skillPaused.has(r.id),
  };
}


export const dontOfferMatch = (offerKind: OfferKind, bundleId: string): string => `dontOffer:${offerKind}:${bundleId}`;

const times = (n: number): string => (n === 1 ? "once" : `${n} times`);

export function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
