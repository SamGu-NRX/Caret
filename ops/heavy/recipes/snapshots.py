"""Reference images a swift-tests run in record mode (CARET_RECORD_SNAPSHOTS=1) writes into its export.

  snapshots.py baseline SRC OUT-FILE PACKAGE...      sha256 of every file under SRC/PACKAGE, before the tests
  snapshots.py collect SRC BASELINE DEST REV PACKAGE...

collect compares the same files after the tests. Every image file added or modified is copied to DEST at its path in
the repository, so it can be reviewed and committed; DEST/manifest.json lists each with its sha256 and change. Any
other file added, modified or removed, and any symlink, is listed under other_changes and not copied. Nothing is read
outside the export (symlinks are never followed) and nothing in DEST is overwritten.
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


def inside(root, path):
    """Raises OSError unless *path* resolves to *root* or below it."""
    real = os.path.realpath(path)
    if real != root and not real.startswith(root + os.sep):
        raise OSError("{} resolves to {}, outside the export {}".format(path, real, root))


def open_file(path):
    """A read descriptor for the regular file *path* itself, never through a symlink."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise OSError("{} is not a regular file".format(path))
    return fd


def digest_fd(fd):
    h = hashlib.sha256()
    while True:
        block = os.read(fd, 1 << 20)
        if not block:
            return h.hexdigest()
        h.update(block)


def raise_error(error):
    raise error


def scan(src, packages):
    """{repository path: sha256, or "symlink:<target>" for a symlink} of every file under the packages. Symlinks are
    recorded, never followed, and one that resolves outside the export fails the scan; so does a directory that cannot
    be listed, which os.walk would otherwise skip."""
    root = os.path.realpath(src)
    found = {}
    for pkg in packages:
        top = os.path.join(root, pkg)
        inside(root, top)
        for dirpath, dirnames, filenames in os.walk(top, onerror=raise_error):
            inside(root, dirpath)
            for name in sorted(dirnames + filenames):
                path = os.path.join(dirpath, name)
                rel = os.path.relpath(path, root)
                mode = os.lstat(path).st_mode
                if stat.S_ISLNK(mode):
                    inside(root, path)
                    found[rel] = "symlink:" + os.readlink(path)
                elif stat.S_ISREG(mode):
                    fd = open_file(path)
                    try:
                        found[rel] = digest_fd(fd)
                    finally:
                        os.close(fd)
    return found


def make_dirs(dest, rel_dir):
    """dest/rel_dir, each component made here or already a real directory, never a symlink."""
    path = dest
    for part in [p for p in rel_dir.split(os.sep) if p]:
        path = os.path.join(path, part)
        try:
            os.mkdir(path, 0o755)
        except FileExistsError:
            if not stat.S_ISDIR(os.lstat(path).st_mode):
                raise OSError("{} exists and is not a directory".format(path)) from None
    return path


def create(path):
    """A new file at *path*: never an existing one, never through a symlink."""
    return os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)


def collect(src, baseline, dest, rev, packages):
    root = os.path.realpath(src)
    with open(baseline, encoding="utf-8") as fh:
        before = json.load(fh)
    after = scan(src, packages)
    images, other = [], []
    os.mkdir(dest, 0o755)  # a new directory: a DEST that exists already is refused
    for rel in sorted(set(before) | set(after)):
        old, new = before.get(rel), after.get(rel)
        if old == new:
            continue
        change = "added" if old is None else "removed" if new is None else "modified"
        if new is None or new.startswith("symlink:") or not rel.lower().endswith(IMAGE_SUFFIXES):
            other.append({"path": rel, "sha256": new, "change": change})
            continue
        source = os.path.join(root, rel)
        inside(root, os.path.dirname(source))
        target = os.path.join(make_dirs(dest, os.path.dirname(rel)), os.path.basename(rel))
        with os.fdopen(open_file(source), "rb") as src, os.fdopen(create(target), "wb") as dst:
            shutil.copyfileobj(src, dst)
        # The copy is what the manifest vouches for, so its hash is read back from DEST.
        fd = open_file(target)
        try:
            copied = digest_fd(fd)
        finally:
            os.close(fd)
        if copied != new:
            raise OSError("the copy of {} does not match the hash scanned after the tests".format(rel))
        images.append({"path": rel, "sha256": new, "change": change})
    out = create(os.path.join(dest, "manifest.json"))
    with os.fdopen(out, "w", encoding="utf-8") as fh:
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
