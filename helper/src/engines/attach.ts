// The file a page attach may read (lead decision 7 in ~/.caret-run/plans/action-engine-v2.md): Caret proposes the
// likely file in the slip, the user confirms it for that run, and a saved path never implies consent. So the helper
// reads a file only through a confirmation the host recorded for one task, with the size and modification time the
// file had when the user confirmed it, used once, and within GRANT_MAX_MS of the confirmation. Nothing here takes a
// path from memory, a plan or a page: `read` has no path parameter.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";
import { GRANT_MAX_MS, MAX_ATTACH_BYTES } from "../protocol.ts";

/** Content types for the files job forms take; anything else goes as application/octet-stream. */
const TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".rtf": "application/rtf",
  ".txt": "text/plain",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

interface Confirmation {
  /** The resolved path read() opens. */
  path: string;
  /** The name as the user saw it, which the page gets. */
  name: string;
  size: number;
  mtimeMs: number;
  at: number;
}

export interface ReadFile {
  name: string;
  type: string;
  size: number;
  sha256: string;
  /** The bytes, base64. */
  data: string;
}

export class ConfirmedFiles {
  private readonly byTask = new Map<string, Confirmation>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * The user confirmed `path` in the slip for `taskId`. Called only by the code that handles that confirmation. The
   * file must exist as a regular file under MAX_ATTACH_BYTES now; its size and modification time are kept, so a file
   * changed after the confirmation is refused. A second confirmation for the task replaces the first.
   */
  confirm(taskId: string, path: string): { ok: true } | { refused: string } {
    if (!isAbsolute(path)) return { refused: "the confirmed file has no absolute path" };
    let real: string;
    let st;
    try {
      // The file the user saw, with any alias resolved now; read() then refuses a symlink put in its place later.
      real = realpathSync(path);
      st = statSync(real);
    } catch {
      return { refused: "the confirmed file cannot be read" };
    }
    if (!st.isFile()) return { refused: "the confirmed path is not a file" };
    if (st.size > MAX_ATTACH_BYTES) return { refused: `the file is ${st.size} bytes; Caret attaches files up to ${MAX_ATTACH_BYTES}` };
    this.byTask.set(taskId, { path: real, name: basename(path), size: st.size, mtimeMs: st.mtimeMs, at: this.now() });
    return { ok: true };
  }

  /** Drops the task's confirmation: the run ended, or the user took it back. */
  forget(taskId: string): void {
    this.byTask.delete(taskId);
  }

  /**
   * Reads the file confirmed for `taskId`, once. Refused without a confirmation, after GRANT_MAX_MS, or when the
   * file's size or modification time changed since the confirmation (it is then not the file the user saw).
   */
  read(taskId: string): ReadFile | { refused: string } {
    const c = this.byTask.get(taskId);
    this.byTask.delete(taskId);
    if (c === undefined) return { refused: `no file was confirmed for task ${taskId}` };
    if (this.now() - c.at > GRANT_MAX_MS) return { refused: "the confirmation of the file expired" };
    let fd: number;
    try {
      // O_NOFOLLOW: a symlink planted at the path after the confirmation is not followed.
      fd = openSync(c.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return { refused: "the confirmed file cannot be opened" };
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size !== c.size || st.mtimeMs !== c.mtimeMs) return { refused: "the file changed after you confirmed it" };
      const bytes = Buffer.alloc(st.size);
      for (let off = 0; off < st.size; ) {
        const n = readSync(fd, bytes, off, st.size - off, off);
        if (n === 0) return { refused: "the file ended early while Caret read it" };
        off += n;
      }
      return {
        name: c.name,
        type: TYPES[extname(c.name).toLowerCase()] ?? "application/octet-stream",
        size: st.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        data: bytes.toString("base64"),
      };
    } finally {
      closeSync(fd);
    }
  }
}
