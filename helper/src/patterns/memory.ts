// Memory you can see and edit (plan section 4). Typed entries in SQLite, never prose a model wrote,
// in five kinds: about you, people, preferences, routines and permissions. Each entry's sentence is
// rendered by code from its fields. Recognizers, fills and the gate read memory on every use, so an
// edit, pause or forget takes effect at the next offer.
//
// About-you, people and preference entries hold real values, so their fields are sealed with
// AES-256-GCM under a local key file (mode 0600) beside the store's salt. This is the plan's answer
// to its question 3 for Sam, taken provisionally: the build order otherwise persists only counts and
// hashes. Lookups use keyed hashes, never plain values. Routines and permissions hold no screen text.
//
// The same database holds the gate's decision log and the user's reactions to offers.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import * as z from "zod";
import { LEVELS } from "../offers/settings.ts";
import {
  AboutFields,
  PeopleFields,
  PermissionFields,
  PreferenceFields,
  RoutineFields,
  type ActionType,
  type MemoryEntry,
  type MemoryKind,
  type MemoryStatus,
  type OfferKind,
  type PermissionRule,
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

export interface RoutineRecord {
  id: string;
  sig: string;
  steps: RoutineStep[];
  count: number;
  hits: number;
  misses: number;
  paused: boolean;
  name: string | null;
}

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
`;

const SEALED: ReadonlySet<MemoryKind> = new Set(["about", "people", "preference"]);

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

export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  /**
   * Decisions not yet written. The gate runs on the event path and a SQLite write there stalled for
   * 11 ms once on a loaded disk (patterns-eval, 2026-10-02), so decisions are written on the tick.
   */
  private pendingDecisions: DecisionRow[] = [];
  /** Every routine with its steps, read once per change: window openings consult it on the event path. */
  private routineCache: RoutineRecord[] | null = null;
  /**
   * Silent hits a routine needs before it is active, at the user's level (offers/settings.ts LEVELS).
   * The helper sets it from each settings message; at a level with routines off the memory view still
   * describes proof by the Balanced number.
   */
  routineSightings: number = LEVELS.balanced.routineSightings ?? 3;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.key = loadKey(join(dir, "memory.key"));
    const path = join(dir, "memory.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    this.seedPermissions();
  }

  close(): void {
    this.flushDecisions();
    this.db.close();
  }

  private readonly statements = new Map<string, StatementSync>();

  /** Prepared once and reused: compiling SQL on every call was the bulk of a cold bundle close. */
  private stmt(sql: string): StatementSync {
    let st = this.statements.get(sql);
    if (st === undefined) this.statements.set(sql, (st = this.db.prepare(sql)));
    return st;
  }

  // MARK: - the socket API

  list(kind?: MemoryKind): MemoryEntry[] {
    const rows = (kind === undefined
      ? this.stmt("SELECT * FROM memory ORDER BY kind, last_seen DESC").all()
      : this.stmt("SELECT * FROM memory WHERE kind = ? ORDER BY last_seen DESC").all(kind)) as unknown as Row[];
    return rows.map((r) => this.entry(r));
  }

  get(id: string): MemoryEntry {
    return this.entry(this.row(id));
  }

  /** Changes what the user may change in an entry. Anything else is refused with the reason. */
  edit(id: string, raw: Record<string, unknown>, now: number): MemoryEntry {
    const r = this.row(id);
    this.routineCache = null;
    const fields = this.fields(r);
    let next: unknown;
    switch (r.kind) {
      case "about":
        next = { ...(fields as AboutFields), ...parseEdit(z.strictObject({ label: AboutFields.shape.label.optional(), value: AboutFields.shape.value.optional() }), raw) };
        break;
      case "people":
        next = { ...(fields as PeopleFields), ...parseEdit(z.strictObject({ alias: PeopleFields.shape.alias.optional(), name: PeopleFields.shape.name.optional() }), raw) };
        break;
      case "preference": {
        const p = fields as PreferenceFields;
        if (p.rule !== "format") throw new MemoryError(`a ${p.rule} preference has nothing to edit; forget it instead`);
        const e = parseEdit(z.strictObject({ template: z.string() }), raw);
        checkTemplate(e.template);
        next = { ...p, template: e.template };
        break;
      }
      case "routine": {
        const e = parseEdit(z.strictObject({ name: z.string().min(1).max(80).nullable() }), raw);
        next = { ...(fields as { steps: RoutineStep[] }), name: e.name };
        break;
      }
      case "permission": {
        const p = fields as PermissionFields;
        const e = parseEdit(z.strictObject({ rule: PermissionFields.shape.rule }), raw);
        const allowed = PERMISSIONS[p.action].allowed;
        if (!allowed.includes(e.rule)) throw new MemoryError(`${p.action} can be ${allowed.join(" or ")}, not ${e.rule}`);
        next = { ...p, rule: e.rule };
        break;
      }
    }
    this.write(r.kind, id, next);
    this.stmt("UPDATE memory SET last_seen = ? WHERE id = ?").run(now, id);
    return this.get(id);
  }

  setPaused(id: string, paused: boolean): MemoryEntry {
    const r = this.row(id);
    if (r.kind === "permission") throw new MemoryError("a permission cannot be paused; change its rule instead");
    this.stmt("UPDATE memory SET paused = ? WHERE id = ?").run(paused ? 1 : 0, id);
    this.routineCache = null;
    return this.get(id);
  }

  /** Deletes an entry. A forgotten routine is not relearned for FORGET_BLOCK_MS. */
  forget(id: string, now: number): void {
    const r = this.row(id);
    this.routineCache = null;
    if (r.kind === "permission") throw new MemoryError("a permission cannot be forgotten; change its rule instead");
    if (r.kind === "routine") {
      this.db
        .prepare("INSERT INTO forgotten (kind, match, until) VALUES (?, ?, ?) ON CONFLICT(kind, match) DO UPDATE SET until = excluded.until")
        .run(r.kind, r.match, now + FORGET_BLOCK_MS);
    }
    if (r.kind === "about") {
      // A preference that pointed at this value would otherwise point at nothing.
      for (const p of this.rows("preference")) {
        const f = this.fields(p) as PreferenceFields;
        if (f.rule === "useInstead" && f.aboutId === id) this.stmt("DELETE FROM memory WHERE id = ?").run(p.id);
      }
    }
    this.stmt("DELETE FROM memory WHERE id = ?").run(id);
  }

  // MARK: - for recognizers, fills and the gate

  /** Adds an entry, or counts another sighting of the entry with the same kind and match key. */
  upsert(kind: Exclude<MemoryKind, "routine" | "permission">, match: string, fields: AboutFields | PeopleFields | PreferenceFields, at: number, app: string | null): string {
    // Checked on the way in, so an entry that list() could not render is never stored.
    const schema = kind === "about" ? AboutFields : kind === "people" ? PeopleFields : PreferenceFields;
    const valid = schema.safeParse(fields);
    if (!valid.success) throw new MemoryError(`not storing a ${kind} entry: ${valid.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const hit = this.stmt("SELECT id FROM memory WHERE kind = ? AND match = ?").get(kind, match) as { id: string } | undefined;
    if (hit !== undefined) {
      this.write(kind, hit.id, fields);
      this.stmt("UPDATE memory SET count = count + 1, last_seen = ?, app = COALESCE(?, app) WHERE id = ?").run(at, app, hit.id);
      return hit.id;
    }
    const id = `${kind}-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare("INSERT INTO memory (id, kind, match, count, first_seen, last_seen, app) VALUES (?, ?, ?, 1, ?, ?, ?)")
      .run(id, kind, match, at, at, app);
    this.write(kind, id, fields);
    return id;
  }

  /** Active (not paused) entries of a kind with their fields, for applying rules. */
  active<K extends "about" | "people" | "preference">(kind: K): { id: string; match: string; fields: K extends "about" ? AboutFields : K extends "people" ? PeopleFields : PreferenceFields }[] {
    return this.rows(kind)
      .filter((r) => r.paused === 0)
      .map((r) => ({ id: r.id, match: r.match, fields: this.fields(r) as never }));
  }

  about(id: string): AboutFields | null {
    const r = this.stmt("SELECT * FROM memory WHERE id = ? AND kind = 'about'").get(id) as Row | undefined;
    if (r === undefined || r.paused !== 0) return null;
    return this.fields(r) as AboutFields;
  }

  /** Counts a completed bundle with this signature. Null when the user forgot this routine recently. */
  recordRoutine(sig: string, steps: RoutineStep[], at: number): RoutineRecord | null {
    this.routineCache = null;
    const block = this.stmt("SELECT until FROM forgotten WHERE kind = 'routine' AND match = ?").get(sig) as { until: number } | undefined;
    if (block !== undefined && block.until > at) return null;
    const hit = this.stmt("SELECT id FROM memory WHERE kind = 'routine' AND match = ?").get(sig) as { id: string } | undefined;
    if (hit !== undefined) {
      // The latest occurrence's positions are the best guess for the next one.
      const f = JSON.parse(this.row(hit.id).fields ?? "{}") as { name?: string | null };
      this.stmt("UPDATE memory SET count = count + 1, last_seen = ?, fields = ? WHERE id = ?").run(at, JSON.stringify({ steps, name: f.name ?? null }), hit.id);
      return this.routine(hit.id);
    }
    const id = `routine-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare("INSERT INTO memory (id, kind, match, fields, count, first_seen, last_seen, app) VALUES (?, 'routine', ?, ?, 1, ?, ?, ?)")
      .run(id, sig, JSON.stringify({ steps, name: null }), at, at, steps[0]?.dstApp ?? null);
    return this.routine(id);
  }

  routine(id: string): RoutineRecord | null {
    const r = this.stmt("SELECT * FROM memory WHERE id = ? AND kind = 'routine'").get(id) as Row | undefined;
    return r === undefined ? null : toRoutine(r);
  }

  /** Routines whose steps all write into windows of this app and kind. */
  routinesInto(bundleId: string, windowKind: string): RoutineRecord[] {
    this.routineCache ??= this.rows("routine").map(toRoutine);
    return this.routineCache.filter((r) => r.steps.length > 0 && r.steps.every((s) => s.dstBundle === bundleId && s.dstWindowKind === windowKind));
  }

  scoreRoutine(id: string, hit: boolean): void {
    this.routineCache = null;
    this.stmt(`UPDATE memory SET ${hit ? "hits = hits + 1" : "misses = misses + 1"} WHERE id = ? AND kind = 'routine'`).run(id);
  }

  permission(action: ActionType): PermissionRule {
    const r = this.stmt("SELECT * FROM memory WHERE kind = 'permission' AND match = ?").get(action) as Row | undefined;
    return r === undefined ? PERMISSIONS[action].rule : (this.fields(r) as PermissionFields).rule;
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

  /** Writes buffered decisions in one transaction. Called on the helper's tick and at close. */
  flushDecisions(): void {
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

  /** By match key, which for these rules is plain kind and bundle id, so nothing is decrypted on the event path. */
  dontOffer(offerKind: OfferKind, bundleId: string): boolean {
    return this.stmt("SELECT 1 FROM memory WHERE kind = 'preference' AND match = ? AND paused = 0").get(dontOfferMatch(offerKind, bundleId)) !== undefined;
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

  private fields(r: Row): unknown {
    if (SEALED.has(r.kind)) {
      if (r.sealed === null) throw new MemoryError(`entry ${r.id} has no sealed fields`);
      return JSON.parse(open(this.key, Buffer.from(r.sealed)));
    }
    return JSON.parse(r.fields ?? "null");
  }

  private write(kind: MemoryKind, id: string, fields: unknown): void {
    if (SEALED.has(kind)) this.stmt("UPDATE memory SET sealed = ?, fields = NULL WHERE id = ?").run(seal(this.key, JSON.stringify(fields)), id);
    else this.stmt("UPDATE memory SET fields = ? WHERE id = ?").run(JSON.stringify(fields), id);
  }

  private entry(r: Row): MemoryEntry {
    const evidence = { count: Number(r.count), lastSeen: Number(r.last_seen), app: r.app };
    const paused = r.paused !== 0;
    switch (r.kind) {
      case "about": {
        const f = AboutFields.parse(this.fields(r));
        return { kind: "about", id: r.id, status: paused ? "paused" : "active", evidence, fields: f, says: `${f.label}: ${f.value} (${ABOUT_SOURCE[f.source]})` };
      }
      case "people": {
        const f = PeopleFields.parse(this.fields(r));
        const app = r.app === null ? "" : ` in ${r.app}`;
        return { kind: "people", id: r.id, status: paused ? "paused" : "active", evidence, fields: f, says: `"${f.alias}"${app} usually means ${f.name} (chosen ${times(r.count)})` };
      }
      case "preference": {
        const f = PreferenceFields.parse(this.fields(r));
        return { kind: "preference", id: r.id, status: paused ? "paused" : "active", evidence, fields: f, says: this.preferenceSays(f, Number(r.count)) };
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
        const f = PermissionFields.parse(this.fields(r));
        return { kind: "permission", id: r.id, status: "active", evidence, fields: f, says: `${PERMISSIONS[f.action].says}: ${RULE_SAYS[f.rule]}` };
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

/** A routine's silent predictions have matched often enough for it to be offered: `sightings` hits at ROUTINE_MIN_PRECISION or better. */
export function routineProven(hits: number, misses: number, sightings: number): boolean {
  const n = hits + misses;
  return hits >= sightings && n > 0 && hits / n >= ROUTINE_MIN_PRECISION;
}

export function offerable(r: RoutineRecord, sightings: number): boolean {
  return !r.paused && routineProven(r.hits, r.misses, sightings);
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

function toRoutine(r: Row): RoutineRecord {
  const f = JSON.parse(r.fields ?? "{}") as { steps?: unknown; name?: string | null };
  return {
    id: r.id,
    sig: r.match,
    steps: z.array(RoutineStep).parse(f.steps ?? []),
    count: Number(r.count),
    hits: Number(r.hits),
    misses: Number(r.misses),
    paused: r.paused !== 0,
    name: f.name ?? null,
  };
}

export const dontOfferMatch = (offerKind: OfferKind, bundleId: string): string => `dontOffer:${offerKind}:${bundleId}`;

const times = (n: number): string => (n === 1 ? "once" : `${n} times`);

function seal(key: Buffer, text: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

function open(key: Buffer, b: Buffer): string {
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

function loadKey(path: string): Buffer {
  if (!existsSync(path)) {
    try {
      // Exclusive create: two helpers starting at once must not each write a different key.
      writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  chmodSync(path, 0o600);
  const b = readFileSync(path);
  if (b.length !== 32) throw new Error(`memory key ${path} is ${b.length} bytes, expected 32; refusing to use it`);
  return b;
}

export function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
