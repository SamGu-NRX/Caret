// Saved files (P3): files.md, beside answers.md. Each record is a file the user attached once, confirmed in a goal's
// preview, and then said yes to keeping for that question (goals/saved-files.ts makes the offer and takes the yes):
//
//   ## Resume <!-- caret:id=file-1a2b3c4d kind=file -->
//   - Question: Resume
//   - Normalized: resume
//   - Site: https://jobs.example.com/acme/apply
//   - Path: /Users/someone/Documents/Resume.pdf
//   - Saved on: 2026-10-05T10:00:00.000Z
//   - Status: active
//
// The path is only ever one the user chose. Nothing here opens it; saved-files.ts checks it is still a regular file
// (lstat, never following a link) before offering it.
import { randomUUID } from "node:crypto";
import type { FileFields } from "../protocol.ts";
import { siteKey } from "../fill/answers.ts";
import type { MemoryDocumentStore } from "./documents.ts";
import { recordDigest, type MemoryRecord } from "./parse.ts";

export type SavedFile = { id: string; status: "active" | "paused"; fields: FileFields };

/** The longest question kept, after spaces are collapsed. Matches FileFields.question. */
export const MAX_FILE_QUESTION_CHARS = 300;

/** A field's label as files.md keeps it: one line, spaces collapsed and trimmed, cut to MAX_FILE_QUESTION_CHARS. Null when empty. */
export function fileQuestion(label: string): string | null {
  const t = label.replace(/\s+/gu, " ").trim();
  if (t === "") return null;
  return t.length <= MAX_FILE_QUESTION_CHARS ? t : t.slice(0, MAX_FILE_QUESTION_CHARS).trimEnd();
}

/** The form a question is compared by: lower case, every digit "#", spacing collapsed ("Résumé  (CV) 2" → "résumé (cv) #"). */
export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/\p{Nd}/gu, "#").replace(/\s+/gu, " ").trim();
}

const toSaved = (r: MemoryRecord): SavedFile | null => (r.kind === "file" ? { id: r.id, status: r.status === "paused" ? "paused" : "active", fields: r.fields } : null);

/** Every usable saved file in files.md, active and paused, read fresh by stat. */
export function savedFiles(store: MemoryDocumentStore): SavedFile[] {
  store.refresh("file");
  return store.records("file").flatMap((r) => toSaved(r) ?? []);
}

/** The saved file with this id as files.md holds it now (checked by content), or null when it is gone or broken. */
export function fileNow(store: MemoryDocumentStore, id: string): SavedFile | null {
  store.refresh("file", true);
  const r = store.record(id);
  return r === null ? null : toSaved(r);
}

/** The saved file for this question on this site: the same normalized question and the same siteKey. Null when none. */
export function fileFor(store: MemoryDocumentStore, normalized: string, site: string | null): SavedFile | null {
  const s = siteKey(site);
  return savedFiles(store).find((f) => f.fields.normalized === normalized && siteKey(f.fields.site) === s) ?? null;
}

/**
 * Writes a file the user agreed to keep and returns its id: over the record `replaces` names when files.md still holds
 * it (as it was read here: an edit between the read and the write is a MemoryConflictError), else as a new record.
 * Active either way: the user just said to use it next time. documents.ts refuses a record holding what Caret never
 * keeps (MemoryDocumentError).
 */
export function saveFile(store: MemoryDocumentStore, fields: FileFields, replaces: string | null = null): string {
  const was = replaces === null ? null : fileNow(store, replaces);
  const r: MemoryRecord = { id: was?.id ?? `file-${randomUUID().slice(0, 8)}`, kind: "file", status: "active", noticed: null, fields };
  store.put(r, was === null ? null : recordDigest({ id: was.id, kind: "file", status: was.status, noticed: null, fields: was.fields }));
  return r.id;
}
