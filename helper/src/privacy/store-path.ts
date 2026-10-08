// Where a store may write (OUTPUT-LEDGER-SPEC section 6, the coordinator's store boundary, 2026-10-07). A store does
// not carry the per-window budget because a local file is not a provider disclosure: the bytes stay on the Mac. That
// holds only while the file cannot leave the Mac on its own. A folder that a sync client or File Provider uploads
// (iCloud Drive, ~/Library/Mobile Documents, ~/Library/CloudStorage for Dropbox, OneDrive, Google Drive and Box, or
// their older home-folder mounts) sends what is written there to a provider with no request ever being made. So every
// store path must resolve, after symlinks, under a local root:
// - ~/.caret-run, the evidence, cache, socket and run root;
// - the system temporary directory (tests, caches of one run);
// - this repository's checkout, where captures write fixtures that are committed.
// A path anywhere else, or under a synced location even inside a root (a symlink can put ~/.caret-run inside Dropbox),
// throws SyncedStorePath before anything is written. There is no budgeted store path yet; one would have to seal its
// bytes as a provider request is sealed.
import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, openSync, readlinkSync, realpathSync, renameSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** A store path outside the local roots, or in a location that syncs. Names the path, which is the caller's own. */
export class SyncedStorePath extends Error {
  constructor(path: string, why: string) {
    super(`a store may not write ${path}: ${why}; nothing was written`);
    this.name = "SyncedStorePath";
  }
}

/** At most this many symlinks are followed resolving one path (the kernel's own MAXSYMLINKS is 32). */
const MAX_LINKS = 32;

/**
 * Where a path really lands, and whether its last component is itself a symlink. Components are walked from the root:
 * each existing one is checked with lstat and a symlink is replaced by its target before anything after it, `..`
 * included, is applied, so `link/../rows.json` is judged under the link's target, not beside the link (INT1 review 2).
 * A link whose target does not exist is followed all the same: the write would create its target.
 */
export function landing(path: string): { real: string; finalLink: boolean } {
  // A relative path follows the working folder as written: path.join would collapse `link/..` before the link is read.
  const parts = (isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`).split(sep).filter((c) => c !== "" && c !== ".");
  // Each component, and whether it is the path's own last one (a link target's components never are).
  const queue = parts.map((c, i) => ({ c, last: i === parts.length - 1 }));
  let at: string = sep;
  let hops = 0;
  let finalLink = false;
  while (queue.length > 0) {
    const { c, last } = queue.shift() as { c: string; last: boolean };
    if (c === "" || c === ".") continue;
    if (c === "..") {
      at = dirname(at);
      continue;
    }
    const next = join(at, c);
    let link = false;
    try {
      link = lstatSync(next).isSymbolicLink();
    } catch {
      link = false;
    }
    if (link) {
      if (++hops > MAX_LINKS) throw new SyncedStorePath(path, "it goes through too many symbolic links");
      if (last) finalLink = true;
      const target = readlinkSync(next);
      queue.unshift(...target.split(sep).map((t) => ({ c: t, last: false })));
      if (isAbsolute(target)) at = sep;
      continue;
    }
    at = next;
  }
  return { real: at, finalLink };
}

/** A path with every symlink resolved, for a file that may not exist yet (landing). */
export function resolvedPath(path: string): string {
  return landing(path).real;
}

const home = (): string => realpathSync(homedir());

/** Folders a sync client or File Provider uploads from, below the home folder (macOS). */
function syncedRoots(): string[] {
  const h = home();
  return [join(h, "Library", "Mobile Documents"), join(h, "Library", "CloudStorage")];
}

/** A home-folder entry an older sync client mounts directly: Dropbox, Google Drive, OneDrive, Box, iCloud Drive. */
const SYNCED_HOME_ENTRY = /^(?:Dropbox|Google Drive|GoogleDrive|OneDrive|Box|Box Sync|iCloud Drive)(?:\b|[ (-])/iu;

const under = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** The repository checkout this module belongs to (helper/src/privacy/ is three levels below it). */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The local roots a store may write under, resolved. */
export function localStoreRoots(): string[] {
  // The app's own data and memory folders (main.ts DEFAULT_DATA_DIR and the memory folder; lead decision 1: Application
  // Support, not Documents, which may sync to iCloud), the evidence and run root, the temporary directory and the checkout.
  const support = join(home(), "Library", "Application Support");
  const roots = [join(support, "CaretV2"), join(support, "Caret"), join(home(), ".caret-run"), tmpdir(), "/tmp", REPO];
  return [...new Set(roots.map((r) => resolvedPath(r)))];
}

/** Why `path` may not be a store's, or null when it may. */
export function storePathRefusal(path: string): string | null {
  return refusalOf(resolvedPath(path));
}

/** Why a resolved path may not be a store's, or null. */
function refusalOf(real: string): string | null {
  for (const r of syncedRoots()) if (under(real, r)) return "it is in a folder that syncs to a provider";
  const h = home();
  if (under(real, h)) {
    const first = real.slice(h.length + 1).split(sep)[0] ?? "";
    if (SYNCED_HOME_ENTRY.test(first)) return "it is in a folder that syncs to a provider";
  }
  if (!localStoreRoots().some((r) => under(real, r))) return "it is outside the local store roots (~/.caret-run, the temporary directory, the repository)";
  return null;
}

/**
 * Throws SyncedStorePath unless `path` resolves under a local, non-synced store root and its last component is not a
 * symbolic link (a write through one goes wherever the link points when it is opened, so none is followed). Returns the
 * resolved path, which has no symbolic link in it: the one to open.
 */
export function assertLocalStorePath(path: string): string {
  // Resolved once: the path judged is the path a caller opens (INT1 review 3: resolving again could land elsewhere).
  const l = landing(path);
  const why = refusalOf(l.real);
  if (why !== null) throw new SyncedStorePath(path, why);
  if (l.finalLink) throw new SyncedStorePath(path, "its last component is a symbolic link, which a store does not follow");
  return l.real;
}

/**
 * macOS O_NOFOLLOW_ANY (sys/fcntl.h, 0x20000000): open(2) fails with ELOOP if any component of the path is a symbolic
 * link. Node passes it through (test/store-path.test.ts). Elsewhere there is no such flag: there only the last component
 * is held (O_NOFOLLOW), and an ancestor swapped for a link between the check and the open is not caught.
 */
const O_NOFOLLOW_ANY = process.platform === "darwin" ? 0x20000000 : 0;

/**
 * Opens a store file for writing, the one way a helper store does (INT1 reviews 2 and 3). The path is checked
 * (assertLocalStorePath) and resolved to where it lands; that resolved path, which has no symbolic link in it, is opened
 * with O_NOFOLLOW_ANY, so an ancestor swapped for a link after the check makes the open fail rather than follow it
 * (macOS; see O_NOFOLLOW_ANY). The open file must be a regular file with one link: a hard link to it elsewhere would
 * carry what is written there too. It is truncated only after that check (not by O_TRUNC), and `mode`, when given, is set
 * on the open file before anything is written. `exclusive` refuses an existing file (O_EXCL). Returns the descriptor.
 */
export function openLocalFile(path: string, o: { append?: boolean; exclusive?: boolean; mode?: number } = {}): number {
  const real = assertLocalStorePath(path);
  // O_NOFOLLOW_ANY covers the last component too, and macOS refuses it beside O_NOFOLLOW (EINVAL): one or the other.
  const flags = constants.O_WRONLY | constants.O_CREAT | (O_NOFOLLOW_ANY !== 0 ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW) | (o.append === true ? constants.O_APPEND : 0) | (o.exclusive === true ? constants.O_EXCL : 0);
  let fd: number;
  try {
    fd = openSync(real, flags, o.mode ?? 0o666);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw new SyncedStorePath(path, "a symbolic link appeared in it after it was checked");
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SyncedStorePath(path, "it is not a regular file");
    if (st.nlink > 1) throw new SyncedStorePath(path, "the file has another hard link, which would carry what is written");
    if (o.mode !== undefined) fchmodSync(fd, o.mode);
    if (o.append !== true) ftruncateSync(fd, 0);
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/** Writes a store file through openLocalFile: all of `data`, then closed. */
export function writeLocalFile(path: string, data: string | Uint8Array, o: { append?: boolean; exclusive?: boolean; mode?: number } = {}): void {
  const fd = openLocalFile(path, o);
  try {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } finally {
    closeSync(fd);
  }
}

/**
 * Renames a store file or folder (a temporary file into place, a staged folder into the memory folder), both paths
 * checked and resolved first. Node has no rename that refuses a link in an ancestor (macOS renameatx_np's
 * RENAME_NOFOLLOW_ANY is not exposed), so an ancestor swapped between the check and the rename is not caught here; the
 * file renamed was written through openLocalFile, which holds the bytes themselves to the roots.
 */
export function renameLocal(from: string, to: string): void {
  renameSync(assertLocalStorePath(from), assertLocalStorePath(to));
}
