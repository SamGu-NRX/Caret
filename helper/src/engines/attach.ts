// The file a page attach may read (lead decision 7 in ~/.caret-run/plans/action-engine-v2.md): Caret proposes the
// likely file in the slip, the user confirms it for that run, and a saved path never implies consent. So the helper
// reads a file only through a confirmation the host recorded for one task, used once, within GRANT_MAX_MS of it, and
// only when the bytes it reads are the bytes that were there at the confirmation: the confirmation keeps the file's
// identity (device and inode) and SHA-256, and the read checks both, plus that nothing changed while it read (W2
// review #6). Nothing here takes a path from memory, a plan or a page: `read` has no path parameter.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
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
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  sha256: string;
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

type Opened = { bytes: Buffer; st: Stats } | { refused: string };

/**
 * Opens `path` without following a final symlink, reads it whole, and checks the file did not change while it was
 * read (the same size and modification time before and after).
 */
function readWhole(path: string): Opened {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { refused: "the confirmed file cannot be opened" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { refused: "the confirmed path is not a file" };
    if (st.size > MAX_ATTACH_BYTES) return { refused: `the file is ${st.size} bytes; Caret attaches files up to ${MAX_ATTACH_BYTES}` };
    const bytes = Buffer.alloc(st.size);
    for (let off = 0; off < st.size; ) {
      const n = readSync(fd, bytes, off, st.size - off, off);
      if (n === 0) return { refused: "the file ended early while Caret read it" };
      off += n;
    }
    const after = fstatSync(fd);
    if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) return { refused: "the file changed while Caret read it" };
    return { bytes, st };
  } finally {
    closeSync(fd);
  }
}

const digest = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

export class ConfirmedFiles {
  private readonly byTask = new Map<string, Confirmation>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * The user confirmed `path` in the slip for `taskId`. Called only by the code that handles that confirmation. The
   * file must be a regular file under MAX_ATTACH_BYTES now; it is read once here, so the confirmation holds its
   * digest. A second confirmation for the task replaces the first.
   */
  confirm(taskId: string, path: string): { ok: true } | { refused: string } {
    if (!isAbsolute(path)) return { refused: "the confirmed file has no absolute path" };
    let real: string;
    try {
      // The file the user saw, with any alias resolved now; read() then refuses a symlink put in its place later.
      real = realpathSync(path);
    } catch {
      return { refused: "the confirmed file cannot be read" };
    }
    const got = readWhole(real);
    if ("refused" in got) return got;
    this.byTask.set(taskId, { path: real, name: basename(path), dev: got.st.dev, ino: got.st.ino, size: got.st.size, mtimeMs: got.st.mtimeMs, sha256: digest(got.bytes), at: this.now() });
    return { ok: true };
  }

  /** Drops the task's confirmation: the run ended, or the user took it back. */
  forget(taskId: string): void {
    this.byTask.delete(taskId);
  }

  /**
   * Reads the file confirmed for `taskId`, once. Refused without a confirmation, after GRANT_MAX_MS, or when the file
   * is not the one confirmed: another file at the path, or the same file with other bytes.
   */
  read(taskId: string): ReadFile | { refused: string } {
    const c = this.byTask.get(taskId);
    this.byTask.delete(taskId);
    if (c === undefined) return { refused: `no file was confirmed for task ${taskId}` };
    if (this.now() - c.at > GRANT_MAX_MS) return { refused: "the confirmation of the file expired" };
    const got = readWhole(c.path);
    if ("refused" in got) return got;
    const { bytes, st } = got;
    if (st.dev !== c.dev || st.ino !== c.ino || st.size !== c.size || st.mtimeMs !== c.mtimeMs) return { refused: "the file changed after you confirmed it" };
    const sha256 = digest(bytes);
    if (sha256 !== c.sha256) return { refused: "the file changed after you confirmed it" };
    return { name: c.name, type: TYPES[extname(c.name).toLowerCase()] ?? "application/octet-stream", size: st.size, sha256, data: bytes.toString("base64") };
  }
}
