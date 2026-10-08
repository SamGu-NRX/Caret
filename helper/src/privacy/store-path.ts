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
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** A store path outside the local roots, or in a location that syncs. Names the path, which is the caller's own. */
export class SyncedStorePath extends Error {
  constructor(path: string, why: string) {
    super(`a store may not write ${path}: ${why}; nothing was written`);
    this.name = "SyncedStorePath";
  }
}

/** A path with symlinks resolved, for a file that may not exist yet: its nearest existing ancestor resolved, the rest kept. */
export function resolvedPath(path: string): string {
  const abs = resolve(path);
  const rest: string[] = [];
  let at = abs;
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) break;
    rest.unshift(basename(at));
    at = up;
  }
  return join(realpathSync(at), ...rest);
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
  const roots = [join(home(), ".caret-run"), tmpdir(), "/tmp", REPO];
  return [...new Set(roots.map((r) => resolvedPath(r)))];
}

/** Why `path` may not be a store's, or null when it may. */
export function storePathRefusal(path: string): string | null {
  const real = resolvedPath(path);
  for (const r of syncedRoots()) if (under(real, r)) return "it is in a folder that syncs to a provider";
  const h = home();
  if (under(real, h)) {
    const first = real.slice(h.length + 1).split(sep)[0] ?? "";
    if (SYNCED_HOME_ENTRY.test(first)) return "it is in a folder that syncs to a provider";
  }
  if (!localStoreRoots().some((r) => under(real, r))) return "it is outside the local store roots (~/.caret-run, the temporary directory, the repository)";
  return null;
}

/** Throws SyncedStorePath unless `path` resolves under a local, non-synced store root. */
export function assertLocalStorePath(path: string): void {
  const why = storePathRefusal(path);
  if (why !== null) throw new SyncedStorePath(path, why);
}
