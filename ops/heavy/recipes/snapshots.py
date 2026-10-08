"""Reference images a swift-tests run in record mode (CARET_RECORD_SNAPSHOTS=1) writes into its export.

  snapshots.py baseline SRC OUT-FILE PACKAGE...      sha256 of every file under SRC/PACKAGE, before the tests
  snapshots.py collect SRC BASELINE DEST REV PACKAGE...

collect compares the same files after the tests. Every image file added or modified is copied to DEST at its path in
the repository, so it can be reviewed and committed; DEST/manifest.json lists each with its sha256 and change. Any
other file added, modified or removed is listed under other_changes (SwiftPM state, a text reference) and not copied.
Only the tested packages are scanned: that is where the snapshot tests keep their references, and the sealed keytype
copy beside them is large. Exits 1, saying why, when a path cannot be read or copied.
"""

import hashlib
import json
import os
import shutil
import stat
import sys

IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".heic", ".tif", ".tiff", ".pdf")


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def scan(src, packages):
    """{repository path: sha256, or "symlink:<target>" for a symlink} of every file under the packages."""
    found = {}
    for pkg in packages:
        for dirpath, dirnames, filenames in os.walk(os.path.join(src, pkg)):
            dirnames.sort()
            for name in sorted(filenames):
                path = os.path.join(dirpath, name)
                rel = os.path.relpath(path, src)
                mode = os.lstat(path).st_mode
                if stat.S_ISLNK(mode):
                    found[rel] = "symlink:" + os.readlink(path)
                elif stat.S_ISREG(mode):
                    found[rel] = digest(path)
    return found


def collect(src, baseline, dest, rev, packages):
    with open(baseline, encoding="utf-8") as fh:
        before = json.load(fh)
    after = scan(src, packages)
    images, other = [], []
    for rel in sorted(set(before) | set(after)):
        old, new = before.get(rel), after.get(rel)
        if old == new:
            continue
        change = "added" if old is None else "removed" if new is None else "modified"
        if new is not None and not new.startswith("symlink:") and rel.lower().endswith(IMAGE_SUFFIXES):
            target = os.path.join(dest, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copyfile(os.path.join(src, rel), target)
            if digest(target) != new:
                raise OSError("{} changed while it was copied".format(rel))
            images.append({"path": rel, "sha256": new, "change": change})
        else:
            other.append({"path": rel, "sha256": new, "change": change})
    os.makedirs(dest, exist_ok=True)
    with open(os.path.join(dest, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump({"rev": rev, "packages": packages, "images": images, "other_changes": other}, fh, indent=1)
    print("{} reference image(s) copied out, {} other change(s) listed".format(len(images), len(other)))


def main(argv):
    try:
        if argv[:1] == ["baseline"] and len(argv) >= 4:
            with open(argv[2], "w", encoding="utf-8") as fh:
                json.dump(scan(argv[1], argv[3:]), fh)
            return 0
        if argv[:1] == ["collect"] and len(argv) >= 6:
            collect(argv[1], argv[2], argv[3], argv[4], argv[5:])
            return 0
    except OSError as ex:
        print("snapshots: {}".format(ex), file=sys.stderr)
        return 1
    print(__doc__, file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
