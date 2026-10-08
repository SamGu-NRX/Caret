// MemoryDocumentStore (plan section 6): the markdown files that hold personal memory, and the records parsed
// from them. It owns reading, compare-and-swap saving, parsing and the record index. It does not decide what a
// record may do: permissions, approvals, clean-run counts and in-progress markers stay in the helper's
// database (patterns/memory.ts), and nothing read here can change them.
//
// Files live in one folder (by default ~/Library/Application Support/Caret/Memory, set by main.ts):
//   about-me.md, people.md, preferences.md, answers.md, files.md, skills/<id>.md
// files.md (P3 saved files) is read and written by the helper only: the memory window lists ROOT_DOCS, which omit it.
// The folder is 0700 and files 0600. That keeps other users out, not other software running as this user,
// and the files are plaintext to editors, Spotlight and backups: the reason sensitive.ts refuses secrets.
//
// Safety:
//   - Only those names are opened; a document is named by DocId, never by a path from outside.
//   - The folder, the skills folder and every file are checked with lstat and opened with O_NOFOLLOW and
//     O_NONBLOCK: a symlink, a FIFO, a device or a directory in a file's place is refused, naming it.
//   - 256 KiB per file and 2 MiB for the folder, provisional limits from the plan; larger files are refused.
//   - Text must be UTF-8. A file that is not is refused rather than read with replacement characters.
//
// Compare-and-swap save (save): the new text goes to a sibling temporary file first. The current file is then
// renamed aside, which atomically takes whatever is at the path at that instant; its bytes are compared with the
// revision the caller started from. On a match the temporary file is linked into place with link(2), which fails
// if anything created the path in between. Either way a mismatch is a MemoryConflictError and nothing the user
// wrote is overwritten. An editor that writes in place through a descriptor it opened before the rename writes
// into the aside file instead: its bytes are compared once more before the aside file goes, and if they moved it
// is kept as "<name> (conflict <time>).md" beside the document and the save reports a conflict. What remains is
// a write landing between that last compare and the unlink, a few microseconds. A crash between the rename and
// the link leaves the aside file: open() puts it back, or keeps it as a conflict copy if the path was taken.
//
// Change detection: every read checks each file it needs by lstat (inode, size, times), and rereads and hashes
// a file whose stamp moved; `verify` rehashes regardless, for the check right before acceptance. A record whose
// meaning changed when Caret did not write it is an external change, reported through takeChanges(). The
// watcher (watch) is only a hint to look sooner.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  watch,
  writeSync,
  type FSWatcher,
  type Stats,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  applyRecord,
  docFor,
  docKind,
  fileOf,
  formatDiagnostic,
  ID_RE,
  isDocId,
  newDocument,
  parseDocument,
  recordDigest,
  recordSecret,
  removeRecord,
  HELPER_DOCS,
  ROOT_DOCS,
  type Diagnostic,
  type DocId,
  type MemoryRecord,
  type ParsedDocument,
  type ParsedRecord,
  type RecordKind,
} from "./parse.ts";
import { refusal, sensitiveKind, valueKind } from "./sensitive.ts";
import { WITHHELD, WITHHELD_SAYS } from "../privacy/exclude.ts";
import { assertLocalStorePath } from "../privacy/store-path.ts";

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
/** Record-level saves retry this many times when only other parts of the file changed underneath them. */
const SAVE_TRIES = 3;
const TEMP_TAG = ".caret-";

export class MemoryDocumentError extends Error {
  readonly file: string;
  constructor(file: string, message: string) {
    super(message);
    this.file = file;
  }
}

/** The file is not at the revision the save started from. Nothing was written. */
export class MemoryConflictError extends MemoryDocumentError {
  /** The file's revision now; null when it is gone. */
  readonly current: string | null;
  constructor(file: string, message: string, current: string | null) {
    super(file, message);
    this.current = current;
  }
}

/** A record whose meaning changed when Caret did not write it: added, edited, broken or removed in an editor. */
export interface RecordChange {
  id: string;
  kind: RecordKind;
  before: MemoryRecord | null;
  after: MemoryRecord | null;
}

interface Loaded {
  doc: DocId;
  /** lstat stamp; "missing" when there is no file. */
  stamp: string;
  revision: string | null;
  bytes: number;
  parsed: ParsedDocument | null;
  /** Why the file was not read, when it was refused. */
  refused: string | null;
}

export interface DocumentInfo {
  doc: DocId;
  file: string;
  path: string;
  revision: string | null;
  bytes: number;
  diagnostics: Diagnostic[];
}

export interface StoreHooks {
  /** Runs between writing the temporary file and installing it: tests use it to play an editor saving at that moment. */
  beforeInstall?: (doc: DocId) => void;
  /** Runs right after the current file is renamed aside, before its bytes are compared: the narrowest window. */
  afterAside?: (doc: DocId) => void;
  /** Runs after the compare, before the aside file is dropped: an editor writing in place through an open descriptor. */
  beforeDrop?: (aside: string) => void;
  /** Runs right after Caret's file is installed, before the cache records it: an editor replacing it at once. */
  afterInstall?: (doc: DocId) => void;
}

export const revisionOf = (b: Buffer | string): string => `sha256:${createHash("sha256").update(b).digest("hex")}`;

export class MemoryDocumentStore {
  readonly root: string;
  readonly hooks: StoreHooks = {};
  private readonly loaded = new Map<DocId, Loaded>();
  /** Valid records that no other record shares an id with, across files. */
  private index = new Map<string, { doc: DocId; parsed: ParsedRecord }>();
  /** Ids used by records in more than one file: disabled in all of them. */
  private crossDuplicates = new Map<string, DocId[]>();
  private readonly changes = new Map<string, RecordChange>();
  private watcher: FSWatcher | null = null;

  constructor(root: string) {
    this.root = resolve(root);
    // A memory folder that is a symlink keeps its own refusal, which says what to do; then the folder is held to the
    // store path policy at start and at every save (INT1 review 2).
    if (existsSync(this.root) && lstatSync(this.root).isSymbolicLink()) checkDir(this.root);
    assertLocalStorePath(this.root);
    ensureDir(this.root);
    ensureDir(join(this.root, "skills"));
    this.recoverSaves(this.root);
    this.recoverSaves(join(this.root, "skills"));
    this.refresh("all", true);
    // What is on disk at start is where Caret starts from, not a change.
    this.changes.clear();
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  path(doc: DocId): string {
    const p = resolve(this.root, fileOf(doc));
    if (!p.startsWith(this.root + sep)) throw new MemoryDocumentError(fileOf(doc), `${fileOf(doc)} is outside the memory folder`);
    return p;
  }

  // MARK: - records

  record(id: string): MemoryRecord | null {
    return this.index.get(id)?.parsed.record ?? null;
  }

  digest(id: string): string | null {
    return this.index.get(id)?.parsed.digest ?? null;
  }

  records(kind: RecordKind): MemoryRecord[] {
    return [...this.index.values()].filter((x) => x.parsed.record.kind === kind).map((x) => x.parsed.record);
  }

  /** Why a record with this id is not usable now, or null: an error in its block, its file refused or unreadable. */
  disabledWhy(id: string, kind: RecordKind): string | null {
    if (this.index.has(id)) return null;
    const docs = this.crossDuplicates.get(id);
    if (docs !== undefined) return `the id ${id} is used in ${docs.map(fileOf).join(" and ")}; neither record is used`;
    const doc = docFor({ id, kind });
    const l = this.loaded.get(doc);
    if (l === undefined || l.parsed === null) return l?.refused ?? `${fileOf(doc)} is missing`;
    const d = l.parsed.diagnostics.find((x) => x.id === id && x.severity === "error");
    if (d !== undefined) return formatDiagnostic(d);
    return l.parsed.blocks.has(id) ? `${fileOf(doc)}: the record ${id} cannot be read` : `${fileOf(doc)} has no record ${id}`;
  }

  /** External changes found since the last call, by record id. */
  takeChanges(): RecordChange[] {
    const out = [...this.changes.values()];
    this.changes.clear();
    return out;
  }

  /**
   * Brings the cache up to date with the files for `scope`: lstat each, reread and reparse those whose stamp moved
   * (every one with `verify`). Differences from what Caret last read or wrote are recorded as external changes.
   */
  refresh(scope: RecordKind | "all", verify = false): boolean {
    const docs: DocId[] = scope === "all" ? [...ROOT_DOCS, ...HELPER_DOCS, ...this.skillDocs()] : scope === "skill" ? this.skillDocs() : [docFor({ id: "x", kind: scope })];
    return this.sync(docs, verify);
  }

  /** Loads `docs` and records how the usable records differ from before: what someone other than Caret changed. */
  private sync(docs: readonly DocId[], verify: boolean): boolean {
    const before = new Map(this.index);
    let moved = false;
    for (const doc of docs) moved = this.load(doc, verify) || moved;
    if (!moved) return false;
    this.reindex();
    for (const id of new Set([...before.keys(), ...this.index.keys()])) {
      const x = before.get(id)?.parsed;
      const y = this.index.get(id)?.parsed;
      if (x?.digest === y?.digest) continue;
      const prior = this.changes.get(id);
      const was = prior !== undefined ? prior.before : (x?.record ?? null);
      const kind = ((y ?? x) as ParsedRecord).record.kind;
      if (was !== null && y !== undefined && recordDigest(was) === y.digest) this.changes.delete(id);
      else this.changes.set(id, { id, kind, before: was, after: y?.record ?? null });
    }
    return true;
  }

  /**
   * Writes one record: in place when its file holds it, else appended (a skill gets its own file). `expect` is the
   * digest of the record the caller's change starts from (null: it must not exist yet; undefined: no check). The
   * file is read fresh; a record the user changed since the caller read it is a MemoryConflictError, and the user's
   * text stays. A change elsewhere in the file is kept: the record's lines are applied to the newest text.
   */
  put(r: MemoryRecord, expect?: string | null): void {
    checkRecord(r);
    const doc = docFor(r);
    this.mutate(doc, r.id, expect, (p) => (p === null ? newDocument(doc, [r]) : applyRecord(p, r)));
  }

  /** Removes a record's block (a skill's whole file), under the same check as put. */
  remove(id: string, kind: RecordKind, expect?: string | null): void {
    const doc = docFor({ id, kind });
    this.mutate(doc, id, expect, (p) => (p === null ? null : kind === "skill" ? null : removeRecord(p, id)));
  }

  private mutate(doc: DocId, id: string, expect: string | null | undefined, next: (p: ParsedDocument | null) => string | null): void {
    const file = fileOf(doc);
    // A retry must still find the record as the first attempt did: a change to it in between is the user's edit.
    let want = expect;
    for (let attempt = 0; attempt < SAVE_TRIES; attempt++) {
      this.sync([doc], true);
      const l = this.loaded.get(doc) as Loaded;
      if (l.refused !== null) throw new MemoryDocumentError(file, l.refused);
      const now = this.digest(id);
      if (want === undefined) want = now;
      const expect = want;
      if (now !== expect) {
        const why = now === null ? "it was removed or has errors" : expect === null ? "a record with this id appeared" : "it was edited";
        throw new MemoryConflictError(file, `${file}: the record ${id} changed outside Caret (${why}); keeping that version`, l.revision);
      }
      if (this.crossDuplicates.has(id)) throw new MemoryConflictError(file, this.disabledWhy(id, docKind(doc)) ?? `${id} is duplicated`, l.revision);
      if (l.parsed?.broken.has(id) === true) throw new MemoryConflictError(file, this.disabledWhy(id, docKind(doc)) ?? `${file}: ${id} has errors`, l.revision);
      const text = next(l.parsed);
      if (text !== null && l.parsed !== null && text === l.parsed.text) return;
      try {
        if (text === null) {
          if (l.revision !== null) this.removeFile(doc, l.revision);
          this.setLoaded(doc, null);
        } else {
          this.checkTotal(doc, Buffer.byteLength(text));
          this.save(doc, l.revision, text);
          this.setLoaded(doc, text);
        }
        this.reindex();
        return;
      } catch (e) {
        // Someone wrote the file between the read and the install: read it again and reapply.
        if (!(e instanceof MemoryConflictError)) throw e;
      }
    }
    throw new MemoryConflictError(file, `${file} kept changing while Caret saved; nothing was written`, this.loaded.get(doc)?.revision ?? null);
  }

  // MARK: - documents, for the host's memory window

  documents(): DocumentInfo[] {
    this.refresh("all");
    return [...ROOT_DOCS, ...this.skillDocs()].map((doc) => this.info(doc));
  }

  info(doc: DocId): DocumentInfo {
    const l = this.loaded.get(doc);
    const diagnostics = [...(l?.parsed?.diagnostics ?? [])];
    if (l?.refused != null) diagnostics.unshift({ file: fileOf(doc), line: 1, field: null, severity: "error", message: l.refused, id: null });
    for (const [id, docs] of this.crossDuplicates) {
      if (!docs.includes(doc)) continue;
      const b = l?.parsed?.blocks.get(id);
      diagnostics.push({ file: fileOf(doc), line: (b?.start ?? 0) + 1, field: null, severity: "error", message: `the id ${id} is also used in ${docs.filter((d) => d !== doc).map(fileOf).join(", ")}; neither record is used`, id });
    }
    return { doc, file: fileOf(doc), path: this.path(doc), revision: l?.revision ?? null, bytes: l?.bytes ?? 0, diagnostics };
  }

  /** The document's text as the user would see it in an editor; empty for a missing one. */
  read(doc: DocId): { text: string; info: DocumentInfo } {
    this.sync([doc], true);
    const l = this.loaded.get(doc) as Loaded;
    if (l.refused !== null) throw new MemoryDocumentError(fileOf(doc), l.refused);
    return { text: l.parsed?.text ?? "", info: this.info(doc) };
  }

  /**
   * The host's save of a whole document, from its editor. Refused when the text holds what Caret never keeps (by
   * line). A skill's file can be edited but not created here: a skill exists only when Caret learned it. The save is
   * the user's own edit, so its record changes are reported like an editor's.
   */
  saveDocument(doc: DocId, base: string | null, text: string): DocumentInfo {
    if (!isDocId(doc)) throw new MemoryDocumentError(String(doc), `no memory document named ${String(doc)}`);
    const file = fileOf(doc);
    if (docKind(doc) === "skill" && base === null) throw new MemoryDocumentError(file, `${file}: a skill's file is made by Caret when you keep a skill`);
    const bad = sensitiveLine(doc, text);
    if (bad !== null) throw new MemoryDocumentError(file, bad);
    this.checkTotal(doc, Buffer.byteLength(text));
    this.save(doc, base, text);
    // Read back as anyone else's edit would be, so its changes reach offers and tasks.
    this.sync([doc], true);
    return this.info(doc);
  }

  // MARK: - files

  /**
   * Installs `text` as the document if the file is still at `base` (null: absent). Throws MemoryConflictError
   * otherwise, having written nothing over the file.
   */
  save(doc: DocId, base: string | null, text: string): string {
    const file = fileOf(doc);
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MAX_FILE_BYTES) throw new MemoryDocumentError(file, `${file} would be ${bytes.length} bytes; the limit is ${MAX_FILE_BYTES}`);
    const target = this.path(doc);
    assertLocalStorePath(target);
    const dir = resolve(target, "..");
    // A folder the user deleted is made again; a symlink or another user's folder is refused.
    ensureDir(this.root);
    ensureDir(dir);
    const tmp = join(dir, `.${baseName(target)}${TEMP_TAG}${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeAll(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      this.hooks.beforeInstall?.(doc);
      if (base === null) {
        if (!tryLink(tmp, target)) throw new MemoryConflictError(file, `${file} was created outside Caret while it saved; keeping that file`, this.revisionNow(target));
      } else {
        const aside = join(dir, `.${baseName(target)}${TEMP_TAG}${process.pid}-${randomBytes(6).toString("hex")}.old`);
        try {
          renameSync(target, aside);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new MemoryConflictError(file, `${file} was removed outside Caret while it saved`, null);
          throw e;
        }
        this.hooks.afterAside?.(doc);
        let current: string | null;
        try {
          current = readRegular(aside, file).revision;
        } catch (e) {
          // Not a plain file any more (a symlink or FIFO put in its place), or unreadable: give it back and refuse.
          renameBackIfFree(aside, target);
          if (existsAt(aside)) keepAsConflict(aside);
          throw e;
        }
        if (current !== base) {
          if (tryLink(aside, target)) tryUnlink(aside);
          else tryUnlink(aside); // A newer file took the path: it is the user's latest.
          throw new MemoryConflictError(file, `${file} changed outside Caret while it saved; keeping that version`, current);
        }
        if (!tryLink(tmp, target)) {
          this.dropAside(aside, current, file);
          throw new MemoryConflictError(file, `${file} was written outside Caret while it saved; keeping that version`, this.revisionNow(target));
        }
        this.hooks.afterInstall?.(doc);
        this.dropAside(aside, current, file);
      }
      syncDir(dir);
      return revisionOf(bytes);
    } finally {
      tryUnlink(tmp);
    }
  }

  /**
   * Removes the file a save renamed aside, unless its bytes changed since they were compared: an editor wrote into it
   * in place. Then it is kept as a conflict copy beside the document and the change is reported, never dropped.
   */
  private dropAside(aside: string, compared: string | null, file: string): void {
    this.hooks.beforeDrop?.(aside);
    if (!existsAt(aside)) return;
    let now: string | null;
    try {
      now = readRegular(aside, file).revision;
    } catch {
      // Too large, not UTF-8 any more, or no longer a plain file: not provably what was compared, so kept.
      now = null;
    }
    if (now !== null && now === compared) {
      tryUnlink(aside);
      return;
    }
    const copy = keepAsConflict(aside);
    throw new MemoryConflictError(file, `${file} was edited outside Caret while it saved; that version is kept as ${copy}`, now);
  }

  private removeFile(doc: DocId, base: string): void {
    const file = fileOf(doc);
    const target = this.path(doc);
    const aside = join(resolve(target, ".."), `.${baseName(target)}${TEMP_TAG}${process.pid}-${randomBytes(6).toString("hex")}.old`);
    this.hooks.beforeInstall?.(doc);
    try {
      renameSync(target, aside);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    const current = (() => {
      try {
        return readRegular(aside, file).revision;
      } catch {
        return null;
      }
    })();
    if (current !== base) {
      renameBackIfFree(aside, target);
      if (existsAt(aside)) keepAsConflict(aside);
      throw new MemoryConflictError(file, `${file} changed outside Caret while it was being removed; keeping it`, current);
    }
    this.dropAside(aside, current, file);
  }

  private revisionNow(path: string): string | null {
    try {
      return readRegular(path, baseName(path)).revision;
    } catch {
      return null;
    }
  }

  /** Puts back a file a crash left renamed aside, and removes temporary files of saves that never finished. */
  private recoverSaves(dir: string): void {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(".") || !name.includes(TEMP_TAG)) continue;
      const p = join(dir, name);
      if (name.endsWith(".old")) {
        const target = join(dir, name.slice(1, name.indexOf(TEMP_TAG)));
        if (tryLink(p, target)) tryUnlink(p);
        // The path is taken: the save finished, or the user wrote a newer file. Caret cannot tell whether the aside
        // copy took an edit before the crash, so it is kept where the user can see it rather than deleted.
        else if (sameBytes(p, target)) tryUnlink(p);
        else keepAsConflict(p);
      } else if (name.endsWith(".tmp")) tryUnlink(p);
    }
  }

  private skillDocs(): DocId[] {
    const dir = join(this.root, "skills");
    const loaded = [...this.loaded.keys()].filter((d) => docKind(d) === "skill");
    // A skills folder that is gone or refused: every skill read before is read again, and so turned off.
    if (parentProblem(this.root) !== null || parentProblem(dir) !== null) return loaded;
    const out: DocId[] = [];
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".md") || name.startsWith(".")) continue;
      const id = name.slice(0, -3);
      if (ID_RE.test(id)) out.push(`skills/${id}`);
    }
    // A skill file deleted since the last look is a change too.
    for (const doc of this.loaded.keys()) if (docKind(doc) === "skill" && !out.includes(doc)) out.push(doc);
    return out;
  }

  /** Reads `doc` if its stamp moved (always with `verify`); returns whether its records may have changed. */
  private load(doc: DocId, verify: boolean): boolean {
    const path = this.path(doc);
    const file = fileOf(doc);
    const prev = this.loaded.get(doc);
    let stamp: string;
    let st: Stats | null = null;
    // O_NOFOLLOW guards the file's own name only: a folder above it swapped for a symlink is refused here.
    const parents = docKind(doc) === "skill" ? [this.root, join(this.root, "skills")] : [this.root];
    const badParent = parents.map(parentProblem).find((x) => x !== null) ?? null;
    if (badParent !== null) {
      const refusedNow = badParent === "missing" ? null : badParent;
      if (prev !== undefined && prev.refused === refusedNow && prev.parsed === null && prev.stamp === `parent:${badParent}`) return false;
      this.loaded.set(doc, { doc, stamp: `parent:${badParent}`, revision: null, bytes: 0, parsed: null, refused: refusedNow });
      return true;
    }
    try {
      st = lstatSync(path);
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}`;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      stamp = "missing";
    }
    if (!verify && prev !== undefined && prev.stamp === stamp) return false;
    let next: Loaded;
    if (st === null) next = { doc, stamp, revision: null, bytes: 0, parsed: null, refused: null };
    else {
      try {
        const r = readRegular(path, file);
        const otherBytes = [...this.loaded.values()].filter((x) => x.doc !== doc).reduce((n, x) => n + x.bytes, 0);
        if (otherBytes + r.bytes.length > MAX_TOTAL_BYTES) throw new MemoryDocumentError(file, `the memory folder is over ${MAX_TOTAL_BYTES} bytes; ${file} is not read`);
        if (prev !== undefined && prev.revision === r.revision && prev.refused === null) {
          prev.stamp = stamp;
          return false;
        }
        next = { doc, stamp, revision: r.revision, bytes: r.bytes.length, parsed: parseDocument(doc, r.text), refused: null };
      } catch (e) {
        if (!(e instanceof MemoryDocumentError)) throw e;
        next = { doc, stamp, revision: null, bytes: 0, parsed: null, refused: e.message };
      }
    }
    this.loaded.set(doc, next);
    return true;
  }

  /**
   * What Caret just wrote: the cache follows without reporting it as a change. The stamp matches no file, so the next
   * read hashes the file: an editor that replaced it right after the install is seen then, not hidden behind it.
   */
  private setLoaded(doc: DocId, text: string | null): void {
    const stamp = "unverified";
    this.loaded.set(doc, text === null ? { doc, stamp, revision: null, bytes: 0, parsed: null, refused: null } : { doc, stamp, revision: revisionOf(text), bytes: Buffer.byteLength(text), parsed: parseDocument(doc, text), refused: null });
  }

  private reindex(): void {
    const where = new Map<string, DocId[]>();
    for (const l of this.loaded.values()) for (const p of l.parsed?.records ?? []) where.set(p.record.id, [...(where.get(p.record.id) ?? []), l.doc]);
    const index = new Map<string, { doc: DocId; parsed: ParsedRecord }>();
    const dups = new Map<string, DocId[]>();
    for (const l of this.loaded.values()) {
      for (const p of l.parsed?.records ?? []) {
        const docs = where.get(p.record.id) as DocId[];
        if (docs.length > 1) dups.set(p.record.id, docs);
        else index.set(p.record.id, { doc: l.doc, parsed: p });
      }
    }
    this.index = index;
    this.crossDuplicates = dups;
  }

  private checkTotal(doc: DocId, bytes: number): void {
    const other = [...this.loaded.values()].filter((x) => x.doc !== doc).reduce((n, x) => n + x.bytes, 0);
    if (other + bytes > MAX_TOTAL_BYTES) throw new MemoryDocumentError(fileOf(doc), `saving ${fileOf(doc)} would put the memory folder over ${MAX_TOTAL_BYTES} bytes`);
  }

  /** Calls `onHint` (debounced) when anything in the folder changes. A hint only: reads check revisions anyway. */
  watch(onHint: () => void): void {
    if (this.watcher !== null) return;
    let timer: NodeJS.Timeout | null = null;
    this.watcher = watch(this.root, { recursive: true, persistent: false }, () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        onHint();
      }, 50);
      timer.unref();
    });
    this.watcher.on("error", () => this.close());
  }
}

/** The first line of a document that holds what Caret never keeps, as an error naming file, line and field. */
export function sensitiveLine(doc: DocId, text: string): string | null {
  const p = parseDocument(doc, text);
  // Records already flag their own values (parse.ts); prose is checked by shape only, since a word like
  // "password" in a sentence is not a secret.
  const flagged = p.diagnostics.find((d) => d.severity === "error" && d.message.startsWith("Caret doesn't keep"));
  if (flagged !== undefined) return formatDiagnostic(flagged);
  for (let i = 0; i < p.lines.length; i++) {
    const line = p.lines[i] as string;
    // A "- Password: …" line outside any record is a labelled secret too.
    const f = /^[-*+][ \t]+([A-Za-z][A-Za-z ']{0,30}?)[ \t]*:[ \t]*(.*)$/.exec(line);
    const s = (f === null ? null : sensitiveKind(f[1], f[2] ?? "")) ?? valueKind(line);
    if (s !== null) return `${p.file}:${i + 1}: ${refusal(s)}`;
    // SC1 2a: a text read from the screen with a secret-format value withheld from it.
    if (line.includes(WITHHELD)) return `${p.file}:${i + 1}: ${WITHHELD_SAYS} in memory`;
  }
  return null;
}

/** Refuses a record Caret is about to write that holds what it never keeps, in any field it writes. */
function checkRecord(r: MemoryRecord): void {
  const bad = recordSecret(r);
  if (bad !== null) throw new MemoryDocumentError(fileOf(docFor(r)), `${bad.field}: ${refusal(bad.kind)}`);
}

/** Why a folder on a document's path cannot be used, "missing" when it is not there, or null when it is fine. */
function parentProblem(dir: string): string | null {
  try {
    checkDir(dir);
    return null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Keeps a displaced file beside its document as "<name> (conflict <time>).md"; returns that name. The copy is made by
 * link(2), which never replaces a file already there. Something that is not a plain file (a symlink, a FIFO) cannot be
 * linked safely, so it is left where it is, under its hidden name, and that name is returned.
 */
function keepAsConflict(p: string): string {
  const dir = resolve(p, "..");
  const name = baseName(p);
  if (!lstatSync(p).isFile()) return name;
  const stem = name.slice(1, name.indexOf(TEMP_TAG)).replace(/\.md$/, "");
  const when = new Date().toISOString().replace(/[-:]/g, "").replace("T", " ").slice(0, 15);
  for (let n = 1; ; n++) {
    const copy = `${stem} (conflict ${when}${n === 1 ? "" : ` ${n}`}).md`;
    if (tryLink(p, join(dir, copy))) {
      tryUnlink(p);
      return copy;
    }
  }
}

function sameBytes(a: string, b: string): boolean {
  try {
    return readRegular(a, baseName(a)).revision === readRegular(b, baseName(b)).revision;
  } catch {
    return false;
  }
}

function existsAt(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  checkDir(dir);
  const st = lstatSync(dir);
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

function checkDir(dir: string): void {
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) throw new MemoryDocumentError(dir, `${dir} is a symlink; Caret keeps memory only in a real folder`);
  if (!st.isDirectory()) throw new MemoryDocumentError(dir, `${dir} is not a folder`);
  if (process.getuid !== undefined && st.uid !== process.getuid()) throw new MemoryDocumentError(dir, `${dir} belongs to another user`);
}

/** Reads a regular file, refusing anything else by what it is. */
function readRegular(path: string, file: string): { bytes: Buffer; text: string; revision: string } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") throw new MemoryDocumentError(file, `${file} is a symlink; Caret reads only real files in the memory folder`);
    if (code === "ENOENT") throw new MemoryDocumentError(file, `${file} is missing`);
    throw new MemoryDocumentError(file, `${file} cannot be opened: ${code ?? String(e)}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new MemoryDocumentError(file, `${file} is ${st.isDirectory() ? "a folder" : st.isFIFO() ? "a FIFO" : st.isSocket() ? "a socket" : "a device or special file"}, not a markdown file`);
    if (st.size > MAX_FILE_BYTES) throw new MemoryDocumentError(file, `${file} is ${st.size} bytes; the limit is ${MAX_FILE_BYTES}`);
    if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
    const bytes = Buffer.alloc(st.size);
    let n = 0;
    while (n < bytes.length) {
      const k = readSync(fd, bytes, n, bytes.length - n, n);
      if (k === 0) break;
      n += k;
    }
    const body = bytes.subarray(0, n);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      throw new MemoryDocumentError(file, `${file} is not UTF-8 text`);
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { bytes: body, text, revision: revisionOf(body) };
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, b: Buffer): void {
  let n = 0;
  while (n < b.length) n += writeSync(fd, b, n, b.length - n);
}

function tryLink(from: string, to: string): boolean {
  try {
    linkSync(from, to);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

function tryUnlink(p: string): void {
  try {
    unlinkSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** A symlink or special file can't be hard-linked portably; rename it back if nothing took the path. */
function renameBackIfFree(from: string, to: string): void {
  try {
    lstatSync(to);
  } catch {
    renameSync(from, to);
  }
}

function syncDir(dir: string): void {
  try {
    const fd = openSync(dir, constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Best effort: the rename is atomic either way; this only hurries it to disk.
  }
}

const baseName = (p: string): string => p.slice(p.lastIndexOf(sep) + 1);
