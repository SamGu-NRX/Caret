// Where the content of about, people, preference and skill entries lives, behind patterns/memory.ts. The
// database always keeps each entry's index row (its lookup key, counts, the time it was last seen) and every
// protected field (a skill's runs, approvals and hand-off); only the personal content moves.
//
//   DocumentContent  markdown files (documents.ts): the normal case once migration has run.
//   SealedContent    the sealed columns of the database, as before M1. Used only when migration failed, so the
//                    helper keeps working on the old store unchanged until the next start tries again. It has
//                    no `noticed` status: a noticed fact is kept as active there.
import type { DatabaseSync } from "node:sqlite";
import { AboutFields, PeopleFields, PreferenceFields, type MemoryKind } from "../protocol.ts";
import { open, seal } from "../sealed.ts";
import { MemoryDocumentStore, type DocumentInfo, type RecordChange } from "./documents.ts";
import { SkillText, type DocId, type MemoryRecord, type RecordKind } from "./parse.ts";

export interface IndexRow {
  id: string;
  kind: MemoryKind;
  paused: number;
  fields: string | null;
  sealed: Uint8Array | null;
}

export interface Content {
  readonly mode: "documents" | "sealed";
  /** The record for an index row; null when it is not there or cannot be used (an error in its file). */
  get(row: IndexRow): MemoryRecord | null;
  put(r: MemoryRecord, expect?: string | null): void;
  remove(id: string, kind: RecordKind, expect?: string | null): void;
  /** Checks the files of `kind` (all with "all"); with `verify`, by content rather than by stat. Returns whether anything moved. */
  sync(kind: RecordKind | "all", verify: boolean): boolean;
  /** Every usable record of a kind, for records the user added by hand with an id of their own. */
  records(kind: RecordKind): MemoryRecord[];
  takeChanges(): RecordChange[];
  /** Why the record with this id is not usable, for an error message. */
  why(id: string, kind: RecordKind): string;
  readonly documents: MemoryDocumentStore | null;
  close(): void;
}

export class DocumentContent implements Content {
  readonly mode = "documents";
  readonly documents: MemoryDocumentStore;
  constructor(store: MemoryDocumentStore) {
    this.documents = store;
  }
  get(row: IndexRow): MemoryRecord | null {
    const r = this.documents.record(row.id);
    return r !== null && r.kind === row.kind ? r : null;
  }
  put(r: MemoryRecord, expect?: string | null): void {
    this.documents.put(r, expect);
  }
  remove(id: string, kind: RecordKind, expect?: string | null): void {
    this.documents.remove(id, kind, expect);
  }
  sync(kind: RecordKind | "all", verify: boolean): boolean {
    return this.documents.refresh(kind, verify);
  }
  records(kind: RecordKind): MemoryRecord[] {
    return this.documents.records(kind);
  }
  takeChanges(): RecordChange[] {
    return this.documents.takeChanges();
  }
  why(id: string, kind: RecordKind): string {
    return this.documents.disabledWhy(id, kind) ?? `${id} cannot be read`;
  }
  close(): void {
    this.documents.close();
  }
}

export class SealedContent implements Content {
  readonly mode = "sealed";
  readonly documents = null;
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  constructor(db: DatabaseSync, key: Buffer) {
    this.db = db;
    this.key = key;
  }
  get(row: IndexRow): MemoryRecord | null {
    const status = row.paused !== 0 ? "paused" : "active";
    switch (row.kind) {
      case "about":
      case "people":
      case "preference": {
        if (row.sealed === null) return null;
        const json: unknown = JSON.parse(open(this.key, Buffer.from(row.sealed)));
        const fields = (row.kind === "about" ? AboutFields : row.kind === "people" ? PeopleFields : PreferenceFields).parse(json);
        return { id: row.id, kind: row.kind, status, noticed: null, fields } as MemoryRecord;
      }
      case "skill": {
        const f = SkillText.safeParse(JSON.parse(row.fields ?? "null"));
        return f.success ? { id: row.id, kind: "skill", status, noticed: null, fields: f.data } : null;
      }
      default:
        return null;
    }
  }
  put(r: MemoryRecord, _expect?: string | null): void {
    const paused = r.status === "paused" ? 1 : 0;
    if (r.kind === "skill") {
      const cur = this.db.prepare("SELECT fields FROM memory WHERE id = ?").get(r.id) as { fields: string | null } | undefined;
      const json = { ...(JSON.parse(cur?.fields ?? "{}") as object), name: r.fields.name, trigger: r.fields.trigger };
      this.db.prepare("UPDATE memory SET fields = ?, paused = ? WHERE id = ?").run(JSON.stringify(json), paused, r.id);
      return;
    }
    this.db.prepare("UPDATE memory SET sealed = ?, fields = NULL, paused = ? WHERE id = ?").run(seal(this.key, JSON.stringify(r.fields)), paused, r.id);
  }
  remove(): void {
    // The index row is the record here; patterns/memory.ts deletes it.
  }
  sync(): boolean {
    return false;
  }
  records(): MemoryRecord[] {
    return [];
  }
  takeChanges(): RecordChange[] {
    return [];
  }
  why(id: string): string {
    return `${id} cannot be read from the sealed store`;
  }
  close(): void {}
}

export type { DocId, DocumentInfo };
