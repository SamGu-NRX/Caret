#!/usr/bin/env python3
"""Enqueue Caret's heavy jobs on the shared heavy-job queue, and report on them.

  caret-heavy [--state-dir DIR] enqueue RECIPE JOB-ID --worktree PATH --rev SHA [recipe options]
  caret-heavy [--state-dir DIR] status | show JOB-ID | accept JOB-ID --note TEXT

Enqueue records a plan and returns; the queue's runner, started separately, runs it. The plan is
one read-only JSON file holding everything the job does: the recipe and its arguments, the
profile's floor, estimates and timeouts, a content manifest of the job's inputs, and the SHA-256
of every file in a read-only snapshot of ops/heavy at one commit. The queue job's argv carries
the plan's SHA-256 and a short inline check (BOOT), so the queue's immutable job spec pins the
plan, the plan pins the snapshot, and the snapshot holds the supervisor and the recipes. A
changed plan, snapshot file or extra file in the snapshot refuses the job with exit 65 before
anything runs; a changed input refuses it the same way just before the recipe starts.

Every job gets --wait-absent on the lead's HOLD file, so a held job stays queued and an expired
admission wait returns 75 with the job still queued (no attempt used). The queue pins the
worktree (--repo, --expect-rev, never --unpinned) and admits on the profile's floor.

The key for live recipes is only ever a path, CARET_ENV_FILE, recorded in the plan. Nothing here
opens it. The recipe's environment is built from an allowlist (supervise.py), so key variables
in the runner's environment never reach it.
"""

import argparse
import dataclasses
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import manifest  # noqa: E402

HOME = os.path.expanduser("~")
PYTHON = "/opt/homebrew/opt/python@3.14/bin/python3.14"
# Isolated, writes no bytecode, and reads none from beside a module: with pycache_prefix at /var/empty (root-owned, empty)
# Python looks for .pyc files only there, so a .pyc planted next to a sealed module can never run in its place.
PY_FLAGS = ("-I", "-B", "-X", "pycache_prefix=/var/empty")
QUEUE = "/Users/samgu/Programming Projects/agent-heavy-job-queue-20261001/scripts/heavy-job-queue.py"
QUEUE_DEFAULT_STATE = os.path.join(HOME, "Library/Application Support/AgentSetup/heavy-job-queue")
SCHEMA = 1
EXIT_USAGE, EXIT_CONFLICT, EXIT_REFUSED = 2, 3, 65
ID_PATTERN = re.compile(r"caret-[A-Za-z0-9._-]{1,70}\Z")
SHA_PATTERN = re.compile(r"[0-9a-f]{40}\Z")


def default_paths(state_dir=None):
    """Where a production job reads and writes. Tests pass their own (temporary) paths."""
    state = os.path.abspath(state_dir or os.environ.get("HEAVY_JOB_QUEUE_DIR") or QUEUE_DEFAULT_STATE)
    return {
        "queue_script": QUEUE,
        "queue_state": state,
        "slot_lock": os.path.join(state, "slot.lock"),
        "ops_root": os.path.join(HOME, ".caret-run/queue/ops"),
        "evidence_root": os.path.join(HOME, ".caret-run/evidence/ops/jobs"),
        "hold": os.path.join(HOME, ".caret-run/HOLD"),
        "lr_lease": os.path.join(HOME, ".long-run/bin/lr-lease"),
        "lr_reap": os.path.join(HOME, ".long-run/bin/lr-reap"),
        "heavy_lock": os.path.join(HOME, ".long-run/locks/heavy.lock"),
        "rig_stop": os.path.join(HOME, ".long-run/rig/bin/rig-stop"),
        "rig_run": os.path.join(HOME, ".long-run/rig/bin/rig-run"),
        "lume_clones": os.path.join(HOME, ".lume"),
        "ios_qa_lock": os.path.join(HOME, ".codex/local-ios-qa.lock"),
    }


# Profiles. Every floor and estimate here is unmeasured unless its evidence line says otherwise.
# A floor is the queue's free-disk admission and the supervisor's recheck after the lease; it must
# cover the lease's own floor plus the estimates, because the queue does not charge estimates.


@dataclasses.dataclass(frozen=True)
class Profile:
    name: str
    floor_gib: float
    est_mem_gib: float
    est_disk_gib: float
    lease: bool            # the supervisor takes the heavy lease and heavy.lock; False when the recipe's rig-run does
    lease_wait_s: float    # bound on waiting for the lease and the post-lease recheck, apart from execution
    exec_s: float          # bound on the recipe itself, from the moment it starts
    term_grace_s: float    # SIGTERM to SIGKILL for the recipe's processes on cancellation or timeout
    evidence: str
    wait_flock: tuple = ()

    @property
    def queue_timeout_s(self):
        # The queue's own limit is the backstop: lease wait + execution + grace + 300 s for the
        # supervisor's input check, VM postconditions and lease release.
        return self.lease_wait_s + self.exec_s + self.term_grace_s + 300


PROFILES = {
    "caret-browser-eval": Profile(
        "caret-browser-eval", 11, 2.5, 0.5, True, 1800, 3600, 30,
        "Unmeasured. Floor = heavy lease floor 8 + estimates 3 (Brief Q1). Execution 3600 s is a default: no "
        "whole three-set or live run has been timed (Q1's PROFILES.md)."),
    "caret-helper-suite": Profile(
        "caret-helper-suite", 12, 3, 0.5, True, 1800, 3600, 30,
        "Unmeasured. Estimates 3 + 0.5 are I1's own; the lead set the floor to 12 GiB, the higher of 8 + 3.5 and "
        "Q1's 11 (STATE 11:18Z). W2's window step took 52 s; 3600 s is a default."),
    "caret-swift": Profile(
        "caret-swift", 20, 6, 6, True, 1800, 7200, 60,
        "Unmeasured. Estimates 6 + 6 as h11/heavy.sh uses; floor 8 + 12. Compiler time alone summed 124 s "
        "(dogfood build-2eea5cf.log); 7200 s is a default."),
    "caret-vm": Profile(
        "caret-vm", 15, 6, 2, False, 0, 10800, 60,
        "Floor 15 GiB is Sam's figure (Brief Q1). rig-run takes its own heavy 0/0 and vm 6/2 leases (measured: "
        "VM peak RSS 5.65 GiB over 54 runs, clone at most 0.51 GiB) and heavy.lock, so the supervisor takes "
        "none. Execution 10800 s covers the feeder's 3600 s rig-run wait and H11's 3500 s guest limit; "
        "unmeasured. Grace 60 s covers rig-run's documented cleanup budget of 45 s.",
        wait_flock=("ios_qa_lock",)),
}


# Recipes. Each is a committed script under recipes/, run from the snapshot, with the exit codes in
# ops/heavy/README.md. Its inputs are recorded in the plan's content manifest.


@dataclasses.dataclass(frozen=True)
class Recipe:
    name: str
    profile: str
    script: str            # relative to ops/heavy
    live: bool             # needs CARET_ENV_FILE
    add_options: object    # fn(argparse.ArgumentParser)
    plan_args: object      # fn(args, worktree, rev, paths) -> (argv after the script, inputs, recorded env)


def _tag(parser):
    parser.add_argument("--tag", required=True, help="names the evidence sets, e.g. q2")


def _helper_window_plan(args, worktree, rev, paths):
    return [args.tag], [], {}


BRIDGE = "bridge/.build/release"
BROWSERS = "fixtures/web-form/.browsers"


def _browser_inputs(source):
    # The ignored binaries the eval loads: the signed bridge and its test host, and Chrome for Testing.
    return [manifest.record("bridge", "file", os.path.join(source, BRIDGE, "caret-bridge")),
            manifest.record("bridge-testhost", "file", os.path.join(source, BRIDGE, "caret-bridge-testhost")),
            manifest.record("chrome-for-testing", "tree", os.path.join(source, BROWSERS))]


def _canned_options(parser):
    _tag(parser)
    parser.add_argument("--binaries-from", metavar="WORKTREE",
                        help="clone the bridge and Chrome for Testing from this worktree into the pinned one "
                             "(W1's baseline has none of its own); default: the pinned worktree's own")


def _canned_plan(args, worktree, rev, paths):
    source = os.path.realpath(args.binaries_from) if args.binaries_from else worktree
    argv = [args.tag] + ([source] if args.binaries_from else [])
    return argv, _browser_inputs(source), {}


def _live_options(parser):
    _tag(parser)
    parser.add_argument("--spend-limit", type=float, required=True,
                        help="the eval's own --spend-limit, and the most the day's Jev ledger may grow (USD)")
    parser.add_argument("--heldout", metavar="DIR",
                        help="run the held-out task pages in DIR (sealed: recorded by digest only)")


def _live_plan(args, worktree, rev, paths):
    if not 0 < args.spend_limit <= 0.25:
        raise manifest.ManifestError("--spend-limit must be above 0 and at most $0.25")
    inputs = _browser_inputs(worktree)
    argv = [args.tag, "{:.4f}".format(args.spend_limit)]
    if args.heldout:
        heldout = os.path.realpath(args.heldout)
        inputs.append(manifest.record("heldout-pages", "sealed", heldout))
        argv.append(heldout)
    return argv, inputs, {}


H11_PAGES = ("wizard-1", "reveal")
H11_SOURCES = ("note", "all")
H11_SCENARIOS = ("page_task", "h10")


def _list_of(allowed):
    def parse(text):
        items = [x for x in text.split(",") if x]
        if not items or any(x not in allowed for x in items):
            raise argparse.ArgumentTypeError("choose from {}".format(", ".join(allowed)))
        return ",".join(items)
    return parse


def _r2_prepare_options(parser):
    parser.add_argument("--harness", choices=("h11", "h14"), required=True)
    parser.add_argument("--work", required=True, metavar="DIR", help="export, logs and vm/ go here")
    parser.add_argument("--pages", type=_list_of(H11_PAGES), default="wizard-1", help="H11 only")
    parser.add_argument("--sources", choices=H11_SOURCES, default="note", help="H11 only")
    parser.add_argument("--next-page", choices=("0", "1"), default="0", help="H11 only")
    parser.add_argument("--scenarios", type=_list_of(H11_SCENARIOS), default="page_task", help="H11 only")


CFT_APP = os.path.join(HOME, "Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app")


def _r2_prepare_plan(args, worktree, rev, paths):
    inputs = [
        manifest.record("llama.xcframework", "tree",
                        os.path.join(worktree, "packages/keytype/Packages/ModelRuntime/Vendor/llama.xcframework")),
        manifest.record("node-dist", "file",
                        os.path.join(worktree, "apps/caret/.build/node-dist/node-v26.5.0-darwin-arm64.tar.gz")),
        manifest.record("helper-node_modules", "tree", os.path.join(worktree, "helper/node_modules")),
        manifest.record("extension-node_modules", "tree", os.path.join(worktree, "extension/node_modules")),
        manifest.record("chrome-for-testing-app", "tree", CFT_APP),
    ]
    argv = [args.harness, os.path.realpath(args.work), rev]
    if args.harness == "h11":
        # Stage options travel in argv, so the plan records them; stage.sh writes them into the payload.
        argv += ["--pages", args.pages, "--sources", args.sources, "--next-page", args.next_page,
                 "--scenarios", args.scenarios]
    return argv, inputs, {}


def _r2_vm_options(parser):
    parser.add_argument("--harness", choices=("h11", "h14"), required=True)
    parser.add_argument("--job-dir", required=True, metavar="DIR", help="the staged rig job: job.sh, payload/")
    parser.add_argument("--config", choices=("off", "on"), help="H11 only, required there")
    parser.add_argument("--rig-wait", type=int, default=3600, help="rig-run --wait for its leases (seconds)")
    parser.add_argument("--allowance", type=float, default=0.20,
                        help="R2's shared Jev allowance in USD (the coordinator's $0.20)")
    parser.add_argument("--prior-spend", type=float, default=0.0,
                        help="what earlier R2 lanes already spent from the allowance (H11's actual spend, for H14)")


def _r2_vm_plan(args, worktree, rev, paths):
    job = os.path.realpath(args.job_dir)
    if args.harness == "h11" and args.config is None:
        raise manifest.ManifestError("--config off|on is required for h11")
    if not 0 <= args.rig_wait <= 7200:
        raise manifest.ManifestError("--rig-wait must be 0..7200 seconds")
    if not 0 < args.allowance <= 0.20 or not 0 <= args.prior_spend < args.allowance:
        raise manifest.ManifestError("--allowance must be above 0 and at most $0.20, and --prior-spend below it")
    inputs = [manifest.record("payload", "payload", os.path.join(job, "payload"), rev=rev),
              manifest.record("job.sh", "file", os.path.join(job, "job.sh")),
              manifest.record("tcc.txt", "file", os.path.join(job, "tcc.txt"))]
    if os.path.exists(os.path.join(job, "display")):
        inputs.append(manifest.record("display", "file", os.path.join(job, "display")))
    recorded = {}
    if args.harness == "h11":
        # The stage options the payload was built with, recorded in the plan; the payload digest pins the file.
        try:
            with open(os.path.join(job, "payload", "h11-options.json"), encoding="utf-8") as fh:
                recorded["H11_OPTIONS"] = json.dumps(json.load(fh), sort_keys=True, separators=(",", ":"))
        except (OSError, ValueError) as ex:
            raise manifest.ManifestError("payload has no readable h11-options.json: {}".format(ex)) from None
    argv = [args.harness, job, str(args.rig_wait), "{:.4f}".format(args.allowance), "{:.4f}".format(args.prior_spend),
            args.config or "-"]
    return argv, inputs, recorded


RECIPES = {
    "helper-window": Recipe("helper-window", "caret-helper-suite", "recipes/helper-window.sh", False,
                            _tag, _helper_window_plan),
    "canned-sets": Recipe("canned-sets", "caret-browser-eval", "recipes/canned-sets.sh", False,
                          _canned_options, _canned_plan),
    "live-tasks": Recipe("live-tasks", "caret-browser-eval", "recipes/live-tasks.sh", True,
                         _live_options, _live_plan),
    "r2-prepare": Recipe("r2-prepare", "caret-swift", "recipes/r2/prepare.sh", False,
                         _r2_prepare_options, _r2_prepare_plan),
    "r2-vm": Recipe("r2-vm", "caret-vm", "recipes/r2/vm.sh", True, _r2_vm_options, _r2_vm_plan),
}


# Snapshot


def _git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=False, env=dict(os.environ, GIT_OPTIONAL_LOCKS="0"))


def ops_repo_and_commit(repo=None):
    """The ops checkout this file belongs to, and its HEAD, refusing uncommitted changes under ops/heavy."""
    repo = repo or _git(HERE, "rev-parse", "--show-toplevel").stdout.decode().strip()
    status = _git(repo, "status", "--porcelain", "--untracked-files=normal", "--", "ops/heavy")
    if status.returncode != 0 or status.stdout.strip():
        raise manifest.ManifestError("ops/heavy in {} has uncommitted changes; commit them first".format(repo))
    head = _git(repo, "rev-parse", "--verify", "HEAD^{commit}").stdout.decode().strip()
    if not SHA_PATTERN.match(head):
        raise manifest.ManifestError("cannot read HEAD of {}".format(repo))
    return repo, head


def snapshot_files(root):
    """{path relative to root: sha256} of every file under root/ops/heavy."""
    files = {}
    for dirpath, dirnames, filenames in os.walk(os.path.join(root, "ops/heavy")):
        dirnames.sort()
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            if os.path.islink(path) or not os.path.isfile(path):
                raise manifest.ManifestError("snapshot holds a non-file {}".format(path))
            files[os.path.relpath(path, root)] = manifest.file_sha256(path)
    return files


def make_snapshot(repo, commit, ops_root):
    """A read-only copy of ops/heavy at *commit*, made once and reused. Returns (dir, files)."""
    final = os.path.join(ops_root, "snapshots", commit)
    os.makedirs(os.path.dirname(final), mode=0o700, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix=".snapshot-", dir=os.path.dirname(final))
    try:
        archive = _git(repo, "archive", "--format=tar", commit, "ops/heavy")
        if archive.returncode != 0:
            raise manifest.ManifestError("git archive failed: {}".format(archive.stderr.decode().strip()))
        tar_path = os.path.join(tmp, ".archive.tar")
        with open(tar_path, "wb") as fh:
            fh.write(archive.stdout)
        with tarfile.open(tar_path) as tar:
            tar.extractall(tmp, filter="data")
        os.unlink(tar_path)
        files = snapshot_files(tmp)
        if os.path.isdir(final):
            if snapshot_files(final) != files:
                raise manifest.ManifestError("snapshot {} no longer matches commit {}; it was modified".format(final, commit))
            return final, files
        _read_only(tmp)
        os.rename(tmp, final)
        tmp = None
        return final, files
    finally:
        if tmp is not None:
            _writable(tmp)
            shutil.rmtree(tmp, ignore_errors=True)


def _read_only(root):
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        for name in filenames:
            path = os.path.join(dirpath, name)
            os.chmod(path, 0o555 if os.stat(path).st_mode & 0o111 else 0o444)
        os.chmod(dirpath, 0o555)


def _writable(root):
    for dirpath, dirnames, filenames in os.walk(root):
        os.chmod(dirpath, 0o755)


# The queue job's whole command. It checks the plan against the digest in argv and every snapshot
# file against the plan, refuses any extra file (it could shadow a module), then hands over to
# supervise.py from the snapshot. Kept short because it lives in the queue's job spec.
BOOT = r"""
import hashlib, json, os, sys
plan_path, plan_digest = sys.argv[1], sys.argv[2]
def refuse(msg):
    sys.stderr.write("caret-heavy: refused before start: %s\n" % msg); sys.exit(65)
try: data = open(plan_path, "rb").read()
except OSError as ex: refuse("plan unreadable: %s" % ex)
if hashlib.sha256(data).hexdigest() != plan_digest: refuse("plan %s changed since enqueue" % plan_path)
plan = json.loads(data); root = plan["ops"]["snapshot"]; files = plan["ops"]["files"]
found = set()
for d, _, names in os.walk(os.path.join(root, "ops/heavy")):
    found.update(os.path.relpath(os.path.join(d, n), root) for n in names)
if found != set(files): refuse("snapshot files differ from the plan: %s" % sorted(found ^ set(files))[:5])
for rel, digest in files.items():
    if hashlib.sha256(open(os.path.join(root, rel), "rb").read()).hexdigest() != digest:
        refuse("snapshot file %s changed since enqueue" % rel)
sys.path.insert(0, os.path.join(root, "ops/heavy"))
import supervise
sys.exit(supervise.main(plan_path, plan_digest, plan, sys.argv[3:]))
"""


def boot_argv(python, plan_path, plan_digest, *rest):
    return [python, *PY_FLAGS, "-c", BOOT, plan_path, plan_digest, *rest]


# Plans


def build_plan(recipe, job_id, worktree, rev, recipe_argv, inputs, recorded_env, env_file, paths,
               ops, profile=None, python=PYTHON, lease_renew_s=300, lease_ttl_min=15):
    """The plan dict. *profile* defaults to the recipe's; tests pass synthetic profiles."""
    profile = profile or PROFILES[recipe.profile]
    snapshot, files, ops_repo, ops_commit = ops
    return {
        "schema": SCHEMA, "job_id": job_id, "enqueued_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "profile": dataclasses.asdict(profile) | {"queue_timeout_s": profile.queue_timeout_s},
        "recipe": {"name": recipe.name, "script": os.path.join(snapshot, "ops/heavy", recipe.script),
                   "args": list(recipe_argv), "live": recipe.live},
        "worktree": worktree, "rev": rev,
        "ops": {"repo": ops_repo, "commit": ops_commit, "snapshot": snapshot, "files": files},
        "inputs": inputs, "env": dict(recorded_env), "env_file": env_file,
        "run_root": os.path.join(paths["evidence_root"], job_id),
        "paths": dict(paths), "python": python,
        "lease": {"run": "caret", "ttl_min": lease_ttl_min, "renew_s": lease_renew_s},
    }


def write_plan(plan, plans_dir):
    os.makedirs(plans_dir, mode=0o700, exist_ok=True)
    path = os.path.join(plans_dir, plan["job_id"] + ".json")
    data = (json.dumps(plan, indent=1, sort_keys=True) + "\n").encode()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
    except FileExistsError:
        raise manifest.ManifestError("job {} already has a plan ({}); choose a new job ID".format(
            plan["job_id"], path)) from None
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    return path, hashlib.sha256(data).hexdigest()


def queue_enqueue_argv(plan, plan_path, plan_digest):
    profile, paths = plan["profile"], plan["paths"]
    argv = [plan["python"], paths["queue_script"], "--state-dir", paths["queue_state"], "enqueue",
            "--id", plan["job_id"], "--timeout", str(profile["queue_timeout_s"]),
            "--cwd", plan["worktree"], "--repo", plan["worktree"], "--expect-rev", plan["rev"],
            "--min-free-gib", str(profile["floor_gib"]), "--wait-absent", paths["hold"]]
    for key in profile["wait_flock"]:
        argv += ["--wait-flock", paths[key]]
    return argv + ["--", *boot_argv(plan["python"], plan_path, plan_digest, "relay")]


class QueueRefused(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def enqueue(recipe_name, job_id, worktree, rev, recipe_args, paths, env_file=None, ops_repo=None,
            profile=None, lease_renew_s=300, lease_ttl_min=15, python=PYTHON):
    """Snapshot, record and enqueue one job. Returns (plan path, digest, queue stdout)."""
    recipe = RECIPES[recipe_name] if isinstance(recipe_name, str) else recipe_name
    if not ID_PATTERN.match(job_id):
        raise manifest.ManifestError("job ID must match {}".format(ID_PATTERN.pattern))
    if not SHA_PATTERN.match(rev):
        raise manifest.ManifestError("--rev must be a full 40-character commit SHA")
    worktree = os.path.realpath(worktree)
    manifest.record("worktree", "git", worktree, rev=rev)  # refuse now rather than at release
    if recipe.live:
        if not env_file:
            raise manifest.ManifestError("{} needs CARET_ENV_FILE (or --env-file): the path of the .env holding "
                                         "the key".format(recipe.name))
        if not os.path.isabs(env_file) or not os.path.isfile(env_file):
            raise manifest.ManifestError("CARET_ENV_FILE must name an existing absolute file")
    else:
        env_file = None  # an offline recipe gets no key path at all
    recipe_argv, inputs, recorded = recipe.plan_args(recipe_args, worktree, rev, paths)
    repo, commit = ops_repo_and_commit(ops_repo)
    snapshot, files = make_snapshot(repo, commit, paths["ops_root"])
    plan = build_plan(recipe, job_id, worktree, rev, recipe_argv, inputs, recorded, env_file, paths,
                      (snapshot, files, repo, commit), profile=profile, python=python,
                      lease_renew_s=lease_renew_s, lease_ttl_min=lease_ttl_min)
    if os.path.exists(plan["run_root"]):
        raise manifest.ManifestError("evidence directory {} already exists; choose a new job ID".format(plan["run_root"]))
    plan_path, digest = write_plan(plan, os.path.join(paths["ops_root"], "plans"))
    argv = queue_enqueue_argv(plan, plan_path, digest)
    if "--unpinned" in argv:
        raise AssertionError("--unpinned is never passed")
    done = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if done.returncode != 0:
        os.unlink(plan_path)  # nothing was enqueued; the ID stays free
        raise QueueRefused(done.returncode, done.stderr.strip())
    return plan_path, digest, done.stdout.strip()


# Reports


def outcome_of(paths, job_id):
    root = os.path.join(paths["evidence_root"], job_id)
    result = {"executed": None, "validated": None, "accepted_by_lead": None, "exit": None, "reason": "no outcome yet"}
    try:
        with open(os.path.join(root, "outcome.json"), encoding="utf-8") as fh:
            outcome = json.load(fh)
        result.update(outcome["states"], exit=outcome.get("exit"), reason=outcome.get("reason"))
    except (OSError, ValueError, KeyError):
        pass
    try:
        with open(os.path.join(root, "accepted.json"), encoding="utf-8") as fh:
            result["accepted_by_lead"] = json.load(fh)
    except (OSError, ValueError):
        pass
    return result


def accept(paths, job_id, note):
    """Record the lead's acceptance. Only a validated outcome can be accepted."""
    state = outcome_of(paths, job_id)
    if state.get("validated") is not True:
        raise manifest.ManifestError("job {} is not validated ({}); nothing to accept".format(job_id, state.get("reason")))
    path = os.path.join(paths["evidence_root"], job_id, "accepted.json")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)
    with os.fdopen(fd, "w") as fh:
        json.dump({"by": "lead", "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "note": note}, fh)
    return path


def status(paths):
    """The queue's runner and slot lines, then Caret's jobs with their three states."""
    done = subprocess.run([PYTHON, paths["queue_script"], "--state-dir", paths["queue_state"], "status"],
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, text=True)
    lines = []
    for line in done.stdout.splitlines():
        fields = line.split()
        if line.startswith(("runner: ", "slot: ", "heavy lock: ", "next: caret-")):
            lines.append(line)
        elif len(fields) >= 3 and fields[0].isdigit() and fields[2].startswith("caret-"):
            state = outcome_of(paths, fields[2])
            lines.append("{:>4} {:<12} {:<28} executed={} validated={} accepted={}".format(
                fields[0], fields[1], fields[2], state["executed"], state["validated"],
                None if state["accepted_by_lead"] is None else True))
    return done.returncode, "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="caret-heavy", description=__doc__.split("\n\n")[0])
    parser.add_argument("--state-dir", help="the queue's state directory (default: the queue's own default)")
    sub = parser.add_subparsers(dest="action", required=True)
    add = sub.add_parser("enqueue")
    recipes = add.add_subparsers(dest="recipe", required=True)
    for recipe in RECIPES.values():
        p = recipes.add_parser(recipe.name, help="profile {}".format(recipe.profile))
        p.add_argument("job_id")
        p.add_argument("--worktree", required=True)
        p.add_argument("--rev", required=True, help="full commit SHA the worktree must be at")
        p.add_argument("--env-file", help="path of the .env holding the key (default: $CARET_ENV_FILE)")
        recipe.add_options(p)
    sub.add_parser("status")
    show = sub.add_parser("show")
    show.add_argument("job_id")
    acc = sub.add_parser("accept")
    acc.add_argument("job_id")
    acc.add_argument("--note", required=True)
    args = parser.parse_args(argv)
    paths = default_paths(args.state_dir)
    try:
        if args.action == "enqueue":
            env_file = args.env_file or os.environ.get("CARET_ENV_FILE")
            plan_path, digest, out = enqueue(args.recipe, args.job_id, args.worktree, args.rev, args, paths,
                                             env_file=env_file)
            print(json.dumps({"plan": plan_path, "plan_sha256": digest, "queue": json.loads(out)}))
            return 0
        if args.action == "status":
            code, text = status(paths)
            print(text)
            return code
        if args.action == "show":
            shown = outcome_of(paths, args.job_id) | {"evidence": os.path.join(paths["evidence_root"], args.job_id)}
            print(json.dumps(shown, indent=1))
            return 0
        if args.action == "accept":
            print(accept(paths, args.job_id, args.note))
            return 0
    except QueueRefused as ex:
        print("caret-heavy: the queue refused: {}".format(ex), file=sys.stderr)
        return ex.code
    except manifest.ManifestError as ex:
        print("caret-heavy: {}".format(ex), file=sys.stderr)
        return EXIT_CONFLICT
    return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
