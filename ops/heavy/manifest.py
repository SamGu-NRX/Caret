"""Content manifest of a job's inputs: recorded at enqueue, checked just before the recipe starts.

The queue pins one clean git checkout. A recipe also reads things git does not cover: ignored
binaries (the bridge build, Chrome for Testing), exports, staged VM payloads and held-out pages.
Each is recorded here by content, so a change between enqueue and execution refuses the job.

Entry kinds (all paths absolute):
  git      a checkout that must be clean at the recorded HEAD (same test as the queue's pin)
  file     one regular file, by SHA-256
  tree     a directory, by one SHA-256 over every entry's path, type, executable bit and content
           (symlinks by their target text, never followed)
  sealed   a tree nobody may read, such as held-out pages. Same digest; the record and every
           message carry only the digest, file count and byte count, never a name or content.
  payload  a tree that also holds a REV file, which must equal the job's pinned commit. Its top-level CONFIG and
           spend-control.json are left out: R2's feeder and recipe write them at run time, from the plan's
           arguments and the host's spend ledger, so their enqueue-time content says nothing about the run.
"""

import hashlib
import os
import stat
import subprocess

KINDS = ("git", "file", "tree", "sealed", "payload")
PAYLOAD_RUNTIME_FILES = ("CONFIG", "spend-control.json")


class ManifestError(Exception):
    """An input cannot be recorded, or no longer matches its record."""


def _git(repo, *args):
    # GIT_OPTIONAL_LOCKS=0 stops git status refreshing the index of a worktree someone else uses.
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    return subprocess.run(["git", "-C", repo, *args], env=env, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)


def clean_head(repo):
    """HEAD of *repo* if its checkout is clean (untracked files count), else ManifestError."""
    before = _git(repo, "rev-parse", "--verify", "HEAD^{commit}")
    if before.returncode != 0:
        raise ManifestError("cannot read HEAD of {}: {}".format(repo, before.stderr.strip()))
    status = _git(repo, "status", "--porcelain", "--untracked-files=normal")
    if status.returncode != 0:
        raise ManifestError("cannot read the status of {}: {}".format(repo, status.stderr.strip()))
    if status.stdout.strip():
        raise ManifestError("{} has uncommitted or untracked files".format(repo))
    after = _git(repo, "rev-parse", "--verify", "HEAD^{commit}")
    if after.stdout != before.stdout:
        raise ManifestError("HEAD of {} moved while checking it".format(repo))
    return after.stdout.strip()


def file_sha256(path):
    with open(path, "rb") as fh:
        return hashlib.file_digest(fh, "sha256").hexdigest()


def tree_digest(root, skip_top=()):
    """(sha256, files, bytes) over every entry under *root*, in a fixed order, except top-level *skip_top* names.

    Every directory is a line of its own, so an added empty directory changes the digest. A symlink is
    recorded by its target text and must resolve to an existing path inside *root*: a link out of the
    tree, or a dangling one, would let content the digest never read stand in for the input.
    """
    if not os.path.isdir(root) or os.path.islink(root):
        raise ManifestError("{} is not a directory".format(root))
    real_root = os.path.realpath(root)
    lines, files, total = [], 0, 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames.sort()
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir != ".":
            lines.append("d\0{}\n".format(os.path.normpath(rel_dir)))
        for name in sorted(filenames + [d for d in dirnames if os.path.islink(os.path.join(dirpath, d))]):
            path = os.path.join(dirpath, name)
            rel = os.path.normpath(os.path.join(rel_dir, name))
            if rel_dir == "." and name in skip_top:
                continue
            st = os.lstat(path)
            if stat.S_ISLNK(st.st_mode):
                resolved = os.path.realpath(path)
                if not resolved.startswith(real_root + os.sep) or not os.path.exists(resolved):
                    raise ManifestError("symlink {} under {} does not resolve inside it".format(rel, root))
                lines.append("l\0{}\0{}\n".format(rel, os.readlink(path)))
            elif stat.S_ISREG(st.st_mode):
                lines.append("f\0{}\0{}\0{}\n".format(rel, file_sha256(path), "x" if st.st_mode & 0o111 else "-"))
                files += 1
                total += st.st_size
            else:
                raise ManifestError("{} under {} is neither a file, a directory nor a symlink".format(rel, root))
        for d in list(dirnames):
            if os.path.islink(os.path.join(dirpath, d)):
                dirnames.remove(d)  # recorded above as a link; never followed
    digest = hashlib.sha256("".join(lines).encode("utf-8", "surrogateescape")).hexdigest()
    return digest, files, total


def record(name, kind, path, rev=None):
    """The manifest entry for one input, read now."""
    if kind not in KINDS:
        raise ManifestError("unknown input kind {}".format(kind))
    path = os.path.abspath(path)
    entry = {"name": name, "kind": kind, "path": path}
    if kind == "git":
        entry["head"] = clean_head(path)
        if rev is not None and entry["head"] != rev:
            raise ManifestError("{} is at {}, not the pinned {}".format(path, entry["head"], rev))
        return entry
    if kind == "file":
        if not os.path.isfile(path) or os.path.islink(path):
            raise ManifestError("{} ({}) is not a regular file".format(name, path))
        entry["sha256"] = file_sha256(path)
        return entry
    try:
        digest, files, total = tree_digest(path, PAYLOAD_RUNTIME_FILES if kind == "payload" else ())
    except ManifestError as ex:
        raise ManifestError("{}: {}".format(name, ex if kind != "sealed" else "sealed input is not a readable directory"))
    entry.update(sha256=digest, files=files, bytes=total)
    if kind == "payload":
        if rev is None:
            raise ManifestError("payload {} needs the job's pinned revision".format(name))
        try:
            with open(os.path.join(path, "REV"), encoding="utf-8") as fh:
                found = fh.read().strip()
        except OSError:
            raise ManifestError("payload {} has no REV file".format(name)) from None
        if found != rev:
            raise ManifestError("payload {} was built at {}, not the pinned {}".format(name, found, rev))
        entry["rev"] = rev
    return entry


def check(entries):
    """Problems with *entries* now, as sentences; empty when every input matches its record."""
    problems = []
    for entry in entries:
        name, kind, path = entry["name"], entry["kind"], entry["path"]
        try:
            now = record(name, kind, path, rev=entry.get("rev") if kind == "payload" else entry.get("head"))
        except ManifestError as ex:
            problems.append(str(ex) if kind != "sealed" else "sealed input {} is unreadable".format(name))
            continue
        if kind == "git":
            continue  # record() already compared HEAD with the recorded one
        if now["sha256"] != entry["sha256"]:
            if kind in ("file",):
                problems.append("{} ({}) changed since enqueue".format(name, path))
            else:
                problems.append("{} {} changed since enqueue ({} files, {} bytes recorded; {} files, {} bytes now)".format(
                    kind, name, entry["files"], entry["bytes"], now["files"], now["bytes"]))
    return problems
