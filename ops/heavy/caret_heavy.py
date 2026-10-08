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
EXIT_UNREADABLE = 4  # the queue's status listing has a line this parser does not know
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
        # Owns the vm floor a caret-vm job's queue wait is derived from (vm_admission).
        "lease_policy": os.path.join(HOME, ".long-run/lease-policy.json"),
        # Node tarballs fetched by `caret-heavy fetch-node`, each kept only when it matches its pin (fetch_node).
        "node_cache": os.path.join(HOME, ".caret-run/inputs/node-dist"),
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
    # 0: no cap. Otherwise the supervisor stops the job (exit 76) once the summed physical footprint of its processes
    # goes over this many GiB. Every job's peak is recorded either way (outcome.json "memory").
    mem_cap_gib: float = 0.0
    # "vm": no disk floor of its own. The queue waits at lease-policy.json's vm floor + est_mem_gib + est_disk_gib
    # (vm_admission, recorded in the plan); under the lock the supervisor checks lr-lease's vm decision read-only
    # (supervise.vm_check) and ends the job with 75 if it would refuse.
    admit_kind: str = ""
    # The queue lane and lr-lease kind (heavy-job-queue --lease-kind): "heavy", or "browser" for a headless browser
    # batch that runs beside builds in a browser slot, with a browser lease and never heavy.lock.
    lease_kind: str = "heavy"

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
    # Coordinator, 2026-10-07: no 20 GiB gate; lr-lease's heavy floor (8 GiB, lease-policy.json) and estimates charged
    # by the lease, as for the other profiles. No Swift build or test run has a measured memory or disk peak:
    # - memory 6 GiB: H11's own estimate for its build (evidence/host/h11/harness/go.sh, `heavy.sh 6 6`); D1 used 3,
    #   then 2 only to get admitted at 12 GiB free (dogfood/CHECKLIST.md 18:1xZ). Unmeasured.
    # - disk 2 GiB: the one figure on record, 1.5 GB of apps/caret/.build plus Caret.app pruned from caret-v2-host
    #   (STATE.md, line 264). D1's free-disk readings (dogfood/logs/build-run-*.out, at most 0.3 GiB less at the end)
    #   are taken after its scratch export is deleted, so they say nothing of the peak.
    # Every job records its peak footprint now (outcome.json "memory"); a swift-tests run replaces the guess.
    "caret-swift": Profile(
        "caret-swift", 8, 6, 2, True, 1800, 7200, 60,
        "Floor: lr-lease's heavy floor. Memory 6 GiB is H11's build estimate, unmeasured; disk 2 GiB from the 1.5 GB "
        "build output pruned on record (STATE.md), peak unmeasured. Compiler time alone summed 124 s "
        "(dogfood build-2eea5cf.log); 7200 s is a default."),
    "caret-laya": Profile(
        "caret-laya", 12, 3.5, 0.1, True, 1800, 7200, 30,
        "Unmeasured. Estimates 3.5 + 0.1 are LY1's own (queue.sh); the lead's Q1 amendment set 8 + 3.6, rounded up to "
        "12 GiB. No run of the three checkpoints and the scoring has completed; 7200 s is a default. It downloads each "
        "checkpoint's weights (0.64-0.84 GB) from Hugging Face into memory."),
    # No floor of its own (coordinator, 2026-10-07). The 15 GiB that was here was stale: ~/.long-run/lease-policy.json's
    # vm entry records that Sam said on 2026-10-05 to run the VM at about 14.9 GiB free, and the vm floor came down the
    # same day, 15 -> 7 -> 4 GiB, over the measured worst case (VM peak 5.65 GiB charged to disk as swap, clone at most
    # 0.51 GiB, rig-run's estimates 6 + 2). Two thresholds owned one fact. Now: the queue waits, before heavy.lock, at a
    # floor derived at enqueue from that file (vm_admission); under the lock the supervisor makes one read-only check of
    # lr-lease's vm decision (supervise.vm_check) and ends the job with 75 if it would refuse, never waiting there; and
    # rig-run keeps its own clone gate (free > 12 GiB, strict), so at exactly 12.0 GiB lr-lease grants and rig-run does
    # not (VmAdmissionTest pins it).
    "caret-vm": Profile(
        "caret-vm", 0, 6, 2, False, 0, 10800, 60,
        "No floor of its own: admission is lr-lease's vm decision for 6 + 2 GiB (lease-policy.json's vm floor) plus "
        "rig-run's clone gate (free > 12 GiB, strict). "
        "rig-run takes the vm 6/2 lease (measured: VM peak RSS 5.65 GiB "
        "over 54 runs, clone at most 0.51 GiB). The job's one heavy lease is 0/0: the queue's, obliged and handed to "
        "rig-run (RIG_HEAVY_LEASE_ID, managed mode) on a queue that leases per job, else rig-run's own. Execution 10800 s covers the feeder's 3600 s rig-run wait and H11's 3500 s guest limit; "
        "unmeasured. Grace 60 s covers rig-run's documented cleanup budget of 45 s.",
        wait_flock=("ios_qa_lock",), admit_kind="vm"),
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
W4 = os.path.join(HOME, ".caret-run/evidence/browser/w4")


def spec(name, kind, path, dest, rev=None, expect_sha256=None):
    """One input to seal: cloned to <job>/inputs/<dest> at enqueue, and only that copy is used and checked. With
    expect_sha256, a file is sealed only when its content has that hash."""
    out = {"name": name, "kind": kind, "path": os.path.realpath(path), "dest": dest}
    if rev is not None:
        out["rev"] = rev
    if expect_sha256 is not None:
        out["expect_sha256"] = expect_sha256
    return out


def _browser_inputs(source, w4=False):
    # The ignored binaries the eval loads: the signed bridge and its test host, and Chrome for Testing. The recipe
    # clones the sealed copies into the pinned worktree, where the eval looks for them.
    specs = [spec("bridge", "file", os.path.join(source, BRIDGE, "caret-bridge"), "bridge/caret-bridge"),
             spec("bridge-testhost", "file", os.path.join(source, BRIDGE, "caret-bridge-testhost"),
                  "bridge/caret-bridge-testhost"),
             spec("chrome-for-testing", "tree", os.path.join(source, BROWSERS), "browsers")]
    if w4:
        # The corpus set also reads W4's saved pages, answer key, note and owners from ~/.caret-run (page-loop-eval.ts
        # --w4-*); the recipe passes the sealed copies explicitly.
        specs += [spec("w4-pages", "tree", os.path.join(W4, "real"), "w4/real"),
                  spec("w4-key", "file", os.path.join(W4, "replay/key.json"), "w4/replay/key.json"),
                  spec("w4-note", "file", os.path.join(W4, "replay/note.txt"), "w4/replay/note.txt")]
        if os.path.exists(os.path.join(W4, "replay/owners.json")):
            specs.append(spec("w4-owners", "file", os.path.join(W4, "replay/owners.json"), "w4/replay/owners.json"))
    return specs


def _binaries_from(parser):
    parser.add_argument("--binaries-from", metavar="WORKTREE",
                        help="seal the bridge, its test host and Chrome for Testing from this worktree instead of the "
                             "pinned one (a measurement worktree or W1's baseline has no bridge build of its own)")


def _canned_options(parser):
    _tag(parser)
    _binaries_from(parser)


def _canned_plan(args, worktree, rev, paths):
    source = os.path.realpath(args.binaries_from) if args.binaries_from else worktree
    return [args.tag], _browser_inputs(source, w4=True), {}


def _live_options(parser):
    _tag(parser)
    parser.add_argument("--spend-limit", type=float, required=True,
                        help="the eval's own --spend-limit, and the most the day's Jev ledger may grow (USD)")
    parser.add_argument("--heldout", metavar="DIR",
                        help="run the held-out task pages in DIR (sealed: recorded by digest only)")
    _binaries_from(parser)


def _live_plan(args, worktree, rev, paths):
    if not 0 < args.spend_limit <= 0.25:
        raise manifest.ManifestError("--spend-limit must be above 0 and at most $0.25")
    inputs = _browser_inputs(os.path.realpath(args.binaries_from) if args.binaries_from else worktree)
    argv = [args.tag, "{:.4f}".format(args.spend_limit)]
    if args.heldout:
        inputs.append(spec("heldout-pages", "sealed", args.heldout, "heldout"))
        argv.append("heldout")
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
    parser.add_argument("--inputs-from", metavar="WORKTREE",
                        help="seal keytype's llama.xcframework and helper and extension node_modules from this "
                             "worktree (its keytype checkout at the pin's gitlink, its lockfiles the pin's) instead "
                             "of the pinned one's")
    parser.add_argument("--work", required=True, metavar="DIR", help="export, logs and vm/ go here")
    parser.add_argument("--pages", type=_list_of(H11_PAGES), default="wizard-1", help="H11 only")
    parser.add_argument("--sources", choices=H11_SOURCES, default="note", help="H11 only")
    parser.add_argument("--next-page", choices=("0", "1"), default="0", help="H11 only")
    parser.add_argument("--scenarios", type=_list_of(H11_SCENARIOS), default="page_task", help="H11 only")


CFT_APP = os.path.join(HOME, "Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app")
NODE_BASE_URL = "https://nodejs.org/dist"
BUILD_APP = "apps/caret/scripts/build-app.sh"


def node_tarball(version):
    return "node-v{}-darwin-arm64.tar.gz".format(version)


def node_pin(worktree, rev):
    """(version, SHA-256) of the Node tarball build-app.sh pins at *rev*: its NODE_VERSION and NODE_SHA256, which
    build-app.sh's comment traces to nodejs.org's signed SHASUMS256.txt. D1 and H11 got the tarball the same way:
    build-app.sh downloaded it into apps/caret/.build/node-dist and checked this hash."""
    shown = _git(worktree, "show", "{}:{}".format(rev, BUILD_APP))
    if shown.returncode != 0:
        raise manifest.ManifestError("{} has no {}".format(rev, BUILD_APP))
    text = shown.stdout.decode()
    version = re.search(r"^NODE_VERSION=([0-9][0-9.]*)$", text, re.M)
    digest = re.search(r"^NODE_SHA256=([0-9a-f]{64})$", text, re.M)
    if not (version and digest):
        raise manifest.ManifestError("{} at {} pins no NODE_VERSION and NODE_SHA256".format(BUILD_APP, rev))
    return version.group(1), digest.group(1)


def fetch_node(worktree, rev, cache, base_url=NODE_BASE_URL):
    """The pinned Node tarball in *cache*, downloading it if absent; a file is kept only when its SHA-256 is the
    pin's, and a cached one is checked again. Returns its path."""
    version, digest = node_pin(worktree, rev)
    name = node_tarball(version)
    path = os.path.join(cache, name)
    if os.path.isfile(path):
        if manifest.file_sha256(path) == digest:
            return path
        raise manifest.ManifestError("{} does not match the pinned SHA-256 {}; remove it and fetch again".format(path, digest))
    os.makedirs(cache, mode=0o700, exist_ok=True)
    part = path + ".part"
    try:
        done = subprocess.run(["curl", "-fsSL", "--proto", "=https,file", "-o", part,
                               "{}/v{}/{}".format(base_url, version, name)], stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        if done.returncode != 0:
            raise manifest.ManifestError("downloading {} failed: {}".format(name, done.stdout.strip()[-300:]))
        got = manifest.file_sha256(part)
        if got != digest:
            raise manifest.ManifestError("downloaded {} has SHA-256 {}; it does not match the pinned SHA-256 {}".format(
                name, got, digest))
        os.replace(part, path)
    finally:
        if os.path.exists(part):
            os.unlink(part)
    return path


def _r2_prepare_plan(args, worktree, rev, paths):
    # The inputs build.sh puts into its export (recipes/r2/<harness>/build.sh, INPUTS): keytype as an archive of the
    # pin's gitlinked commit with its llama.xcframework, the Node tarball checked against build-app.sh's pin, and
    # node_modules from a worktree whose lockfiles are the pin's.
    source = os.path.realpath(getattr(args, "inputs_from", None) or worktree)
    for d in ("helper", "extension"):
        pinned = _git(worktree, "show", "{}:{}/pnpm-lock.yaml".format(rev, d)).stdout
        try:
            with open(os.path.join(source, d, "pnpm-lock.yaml"), "rb") as fh:
                theirs = fh.read()
        except OSError:
            theirs = None
        if not pinned or theirs != pinned:
            raise manifest.ManifestError("{}/pnpm-lock.yaml in {} is not {}'s, so its node_modules may not be that "
                                         "commit's".format(d, source, rev))
    version, digest = node_pin(worktree, rev)
    tarball = os.path.join(paths["node_cache"], node_tarball(version))
    if not os.path.isfile(tarball):
        raise manifest.ManifestError("no {} in {}: run `caret-heavy fetch-node --worktree {} --rev {}` first".format(
            node_tarball(version), paths["node_cache"], worktree, rev))
    inputs = keytype_inputs(worktree, rev, source) + [
        spec("node-dist", "file", tarball, "node-dist/" + node_tarball(version), expect_sha256=digest),
        spec("helper-node_modules", "tree", os.path.join(source, "helper/node_modules"), "helper-node_modules"),
        spec("extension-node_modules", "tree", os.path.join(source, "extension/node_modules"), "extension-node_modules"),
        spec("chrome-for-testing-app", "tree", CFT_APP, "Google Chrome for Testing.app"),
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
    # The rig job runs from its sealed copy, <job>/inputs/vm-job; rig-run writes its runs/ there.
    inputs = [spec("payload", "payload", os.path.join(job, "payload"), "vm-job/payload", rev=rev),
              spec("job.sh", "file", os.path.join(job, "job.sh"), "vm-job/job.sh"),
              spec("tcc.txt", "file", os.path.join(job, "tcc.txt"), "vm-job/tcc.txt")]
    if os.path.exists(os.path.join(job, "display")):
        inputs.append(spec("display", "file", os.path.join(job, "display"), "vm-job/display"))
    recorded = {}
    if args.harness == "h11":
        # The stage options the payload was built with, recorded in the plan; the payload digest pins the file.
        try:
            with open(os.path.join(job, "payload", "h11-options.json"), encoding="utf-8") as fh:
                recorded["H11_OPTIONS"] = json.dumps(json.load(fh), sort_keys=True, separators=(",", ":"))
        except (OSError, ValueError) as ex:
            raise manifest.ManifestError("payload has no readable h11-options.json: {}".format(ex)) from None
    argv = [args.harness, str(args.rig_wait), "{:.4f}".format(args.allowance), "{:.4f}".format(args.prior_spend),
            args.config or "-"]
    return argv, inputs, recorded


# LY1's environment (~/.caret-run/evidence/screen/ly1/run-env.sh), sealed piece by piece: a Codex runtime's Python 3.12
# (the binary and its standard library only; its pkgconfig and man links dangle), the sg-voice MLX venv's packages,
# LY1's tokenizers wheel (abi3), and laya_mlx from its ghq clone, which ~/ghq sweeps after 30 days.
LAYA_PYTHON = os.path.join(HOME, ".cache/codex-runtimes/codex-primary-runtime/dependencies/python")
LAYA_SITE = os.path.join(HOME, "Programming Projects/sg-voice/private/runtime/f5-tts-mlx-v026/venv/lib/python3.12/site-packages")
LAYA_TOKENIZERS = os.path.join(HOME, ".caret-run/models/laya/venv/lib/python3.14/site-packages")
LAYA_MLX = os.path.join(HOME, "ghq/github.com/mizorewww/laya-mlx/laya_mlx")
LAYA_SRC = os.path.join(HOME, ".caret-run/models/laya/src")
LAYA_DATA = os.path.join(HOME, ".caret-run/evidence/screen/ly1")


def keytype_inputs(worktree, rev, source):
    """Sealed inputs for a build of *rev* that needs packages/keytype: an archive of the submodule's gitlinked commit,
    and llama.xcframework (gitignored) from *source*'s keytype checkout, which must be at that commit. The pinned
    worktree need not have the submodule checked out (caret-v2-hostint does not)."""
    listing = _git(worktree, "ls-tree", rev, "packages/keytype").stdout.decode().split()
    if len(listing) < 3 or listing[1] != "commit":
        raise manifest.ManifestError("packages/keytype is not a submodule at {}".format(rev))
    gitlink = listing[2]
    repo = os.path.join(os.path.realpath(source), "packages/keytype")
    head = _git(repo, "rev-parse", "HEAD") if os.path.isdir(repo) else None
    if head is None or head.returncode != 0:
        raise manifest.ManifestError("no keytype checkout at {}".format(repo))
    head = head.stdout.decode().strip()
    if head != gitlink:
        raise manifest.ManifestError("{} is at {}, not the gitlink {} of {}: its llama.xcframework may not be that "
                                     "commit's".format(repo, head, gitlink, rev))
    return [spec("keytype", "git-archive", repo, "keytype", rev=gitlink),
            spec("llama.xcframework", "tree", os.path.join(repo, "Packages/ModelRuntime/Vendor/llama.xcframework"),
                 "llama.xcframework")]


SWIFT_PACKAGES = ("apps/caret", "apps/screen-reader", "bridge")


def _swift_tests_options(parser):
    _tag(parser)
    parser.add_argument("--packages", default=",".join(SWIFT_PACKAGES),
                        help="comma-separated Swift package directories of the pinned commit (default: %(default)s)")
    parser.add_argument("--inputs-from", metavar="WORKTREE",
                        help="seal keytype (at the pinned gitlink) and llama.xcframework from this worktree's keytype "
                             "checkout instead of the pinned one's; apps/caret needs them")


def _swift_tests_plan(args, worktree, rev, paths):
    packages = [p for p in args.packages.split(",") if p]
    if not packages or len(set(packages)) != len(packages):
        raise manifest.ManifestError("--packages needs distinct package directories")
    for pkg in packages:
        if os.path.isabs(pkg) or os.path.normpath(pkg) != pkg or pkg.startswith(".."):
            raise manifest.ManifestError("--packages: {} is not a plain path inside the worktree".format(pkg))
        if _git(worktree, "cat-file", "-e", "{}:{}/Package.swift".format(rev, pkg)).returncode != 0:
            raise manifest.ManifestError("{} has no Package.swift at {}".format(pkg, rev))
    inputs = keytype_inputs(worktree, rev, args.inputs_from or worktree) if "apps/caret" in packages else []
    return [args.tag, *packages], inputs, {}


RIG_SMOKE_JOB = os.path.join(HOME, ".long-run/rig/jobs/smoke")


def _vm_cancel_proof_options(parser):
    parser.add_argument("--job-dir", default=RIG_SMOKE_JOB, metavar="DIR",
                        help="the rig job to boot (job.sh, optional tcc.txt and display); default the rig's smoke job")
    parser.add_argument("--rig-wait", type=int, default=3600, help="rig-run --wait for its leases (seconds)")
    parser.add_argument("--boot-timeout", type=int, default=900,
                        help="seconds after the lease wait for the guest to be ready before the proof gives up")
    parser.add_argument("--vz-grace", type=int, default=60,
                        help="seconds the Virtualization processes get to exit after rig-run's cleanup")


def _vm_cancel_proof_plan(args, worktree, rev, paths):
    if not 0 <= args.rig_wait <= 7200 or not 60 <= args.boot_timeout <= 3600 or not 1 <= args.vz_grace <= 600:
        raise manifest.ManifestError("--rig-wait 0..7200, --boot-timeout 60..3600 and --vz-grace 1..600 seconds")
    job = os.path.realpath(args.job_dir)
    inputs = [spec("job.sh", "file", os.path.join(job, "job.sh"), "vm-job/job.sh")]
    for name in ("tcc.txt", "display", "no-reboot"):
        if os.path.exists(os.path.join(job, name)):
            inputs.append(spec(name, "file", os.path.join(job, name), "vm-job/" + name))
    return [str(args.rig_wait), str(args.boot_timeout), str(args.vz_grace)], inputs, {}


def _laya_options(parser):
    # Required, with no default: Laya's peak has never been measured, and the 17:31Z near-miss on 2026-10-07 (0.40 GiB
    # free, swap 22.19 of 22.28 GB) stopped its first run. Whoever commissions it chooses the cap.
    parser.add_argument("--mem-cap-gib", type=float, required=True,
                        help="stop the run once its processes' physical footprint exceeds this many GiB (exit 76)")


MAX_MEM_CAP_GIB = 64


def capped_profile(recipe, profile, mem_cap_gib):
    """The profile to plan with: *profile* or the recipe's, with mem_cap_gib when given. Laya needs one."""
    profile = profile or PROFILES[recipe.profile]
    if mem_cap_gib is not None:
        if not 0 < mem_cap_gib <= MAX_MEM_CAP_GIB:
            raise manifest.ManifestError("--mem-cap-gib must be above 0 and at most {}".format(MAX_MEM_CAP_GIB))
        profile = dataclasses.replace(profile, mem_cap_gib=float(mem_cap_gib))
    if recipe.name == "laya" and not profile.mem_cap_gib > 0:
        raise manifest.ManifestError("laya needs --mem-cap-gib: its peak memory is unmeasured")
    return profile


def _laya_plan(args, worktree, rev, paths):
    inputs = [spec("python", "file", os.path.join(LAYA_PYTHON, "bin/python3.12"), "laya-python/bin/python3.12"),
              spec("python-stdlib", "tree", os.path.join(LAYA_PYTHON, "lib/python3.12"), "laya-python/lib/python3.12"),
              spec("mlx-venv-packages", "tree", LAYA_SITE, "laya-site"),
              spec("tokenizers-packages", "tree", LAYA_TOKENIZERS, "laya-tokenizers"),
              spec("laya_mlx", "tree", LAYA_MLX, "laya-mlx/laya_mlx"),
              spec("laya-model-config", "tree", LAYA_SRC, "laya-src")]
    for name in ("questions.jsonl", "narrowed.jsonl", "jev-fields.jsonl", "weights-sha256.txt"):
        inputs.append(spec("laya-data/" + name, "file", os.path.join(LAYA_DATA, name), "laya-data/" + name))
    return [], inputs, {}


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
    "laya": Recipe("laya", "caret-laya", "recipes/laya.sh", False, _laya_options, _laya_plan),
    "vm-cancel-proof": Recipe("vm-cancel-proof", "caret-vm", "recipes/vm-cancel-proof.sh", False,
                              _vm_cancel_proof_options, _vm_cancel_proof_plan),
    "swift-tests": Recipe("swift-tests", "caret-swift", "recipes/swift-tests.sh", False, _swift_tests_options,
                          _swift_tests_plan),
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


def extract_ops(repo, commit, job_dir):
    """ops/heavy at *commit*, extracted into this job's own directory. Returns its files' digests."""
    archive = _git(repo, "archive", "--format=tar", commit, "ops/heavy")
    if archive.returncode != 0:
        raise manifest.ManifestError("git archive failed: {}".format(archive.stderr.decode().strip()))
    tar_path = os.path.join(job_dir, ".archive.tar")
    with open(tar_path, "wb") as fh:
        fh.write(archive.stdout)
    with tarfile.open(tar_path) as tar:
        tar.extractall(job_dir, filter="data")
    os.unlink(tar_path)
    return snapshot_files(job_dir)


def _seal_git_archive(item, dest):
    """A git-archive input: the tree of one commit of a repository, extracted into *dest* (its ignored files, such as
    llama.xcframework, are not in it). Recorded as a tree with the commit it came from."""
    os.makedirs(dest, mode=0o700)
    archive = subprocess.Popen(["git", "-C", item["path"], "archive", item["rev"]], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    untar = subprocess.run(["tar", "-x", "-C", dest], stdin=archive.stdout, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, text=True)
    archive.stdout.close()
    err = archive.stderr.read().decode(errors="replace")
    if archive.wait() != 0 or untar.returncode != 0:
        raise manifest.ManifestError("cannot archive {} at {}: {}".format(item["name"], item["rev"], (err or untar.stdout).strip()[:300]))
    return dict(manifest.record(item["name"], "tree", dest), git_rev=item["rev"])


def seal_inputs(specs, inputs_dir):
    """Clone each input into *inputs_dir* (APFS clonefile: no extra disk until a source changes) and record the copy.

    The copy's digest must equal the source's, read just before cloning, so the job's record is of exactly what it
    will use. The job then never reads the shared source again."""
    entries = []
    for item in specs:
        dest = os.path.join(inputs_dir, item["dest"])
        if os.path.lexists(dest):
            raise manifest.ManifestError("two inputs seal to {}".format(item["dest"]))
        os.makedirs(os.path.dirname(dest), mode=0o700, exist_ok=True)
        if item["kind"] == "git-archive":
            entries.append(dict(_seal_git_archive(item, dest), source=item["path"], dest=item["dest"]))
            continue
        source = manifest.record(item["name"], item["kind"], item["path"], rev=item.get("rev"))
        if item.get("expect_sha256") and source.get("sha256") != item["expect_sha256"]:
            raise manifest.ManifestError("input {} ({}) has SHA-256 {}, not the pinned SHA-256 {}".format(
                item["name"], item["path"], source.get("sha256"), item["expect_sha256"]))
        done = subprocess.run(["/bin/cp", "-c", "-R", "-p", item["path"], dest], stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if done.returncode != 0:
            raise manifest.ManifestError("cannot clone input {}: {}".format(
                item["name"], done.stdout.strip() if item["kind"] != "sealed" else "cp exited {}".format(done.returncode)))
        sealed = manifest.record(item["name"], item["kind"], dest, rev=item.get("rev"))
        if sealed.get("sha256") != source.get("sha256"):
            raise manifest.ManifestError("input {} changed while it was being sealed".format(item["name"]))
        entries.append(dict(sealed, source=item["path"], dest=item["dest"]))
    return entries


def _read_only(root):
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        for name in filenames:
            path = os.path.join(dirpath, name)
            if not os.path.islink(path):
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
               ops, profile=None, python=PYTHON, lease_renew_s=300, lease_ttl_min=15, test=None):
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
        "inputs": inputs, "inputs_dir": os.path.join(snapshot, "inputs"), "env": dict(recorded_env),
        "env_file": env_file,
        "run_root": os.path.join(paths["evidence_root"], job_id),
        "paths": dict(paths), "python": python,
        "lease": {"run": "caret", "ttl_min": lease_ttl_min, "renew_s": lease_renew_s},
        **({"admission": vm_admission(paths, profile)} if profile.admit_kind == "vm" else {}),
        # The lane only: the slot lock comes from the job (HEAVY_JOB_QUEUE_SLOT_LOCK), as the queue runs it.
        "lane": profile.lease_kind,
        # Tests only (recovery.test_point); the CLI never sets it.
        **({"test": dict(test)} if test else {}),
    }


def write_plan(plan, job_dir):
    path = os.path.join(job_dir, "plan.json")
    data = (json.dumps(plan, indent=1, sort_keys=True) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    return path, hashlib.sha256(data).hexdigest()


def rig_run_takes_lease(rig_run):
    """Whether this rig-run accepts the job's heavy lease (RIG_HEAVY_LEASE_ID) and has the managed cleanup mode."""
    try:
        with open(rig_run, encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return False
    return "RIG_HEAVY_LEASE_ID" in text and "RIG_RUN_MANAGED" in text


def vm_admission(paths, profile):
    """The queue's wait for a vm-admitted profile: lease-policy.json's vm floor plus the profile's estimates, the free
    disk lr-lease's vm decision needs under normal pressure, read now from the file that owns it."""
    try:
        with open(paths["lease_policy"], "rb") as fh:
            data = fh.read()
        vm_floor = json.loads(data)["kinds"]["vm"]["diskFloorGB"]
    except (OSError, ValueError, KeyError, TypeError) as ex:
        raise manifest.ManifestError("cannot read the vm floor from {}: {!r}".format(paths["lease_policy"], ex)) from None
    if not isinstance(vm_floor, (int, float)) or vm_floor < 0:
        raise manifest.ManifestError("{} has no usable vm diskFloorGB".format(paths["lease_policy"]))
    return {"kind": "vm", "queue_min_free_gib": vm_floor + profile.est_mem_gib + profile.est_disk_gib,
            "vm_floor_gib": vm_floor, "est_mem_gib": profile.est_mem_gib, "est_disk_gib": profile.est_disk_gib,
            # The supervisor's check reads this file and refuses if its digest has changed (supervise.vm_check).
            "source": paths["lease_policy"], "policy_sha256": hashlib.sha256(data).hexdigest()}


def queue_takes_lease_kind(queue_script):
    """Whether this queue has lanes (heavy-job-queue feat/queue-lanes): enqueue --lease-kind."""
    with open(queue_script, encoding="utf-8") as fh:
        return "--lease-kind" in fh.read()


def queue_takes_leases(queue_script):
    """Whether this queue takes an lr-lease per job (heavy-job-queue 401c4d1 and later): it then needs estimates."""
    with open(queue_script, encoding="utf-8") as fh:
        return "--est-mem-gib" in fh.read()


def _plain(number):
    # The queue passes estimates to lr-lease, whose parser takes no exponents.
    return "{:f}".format(float(number)).rstrip("0").rstrip(".")


def queue_enqueue_argv(plan, plan_path, plan_digest):
    profile, paths = plan["profile"], plan["paths"]
    argv = [plan["python"], paths["queue_script"], "--state-dir", paths["queue_state"], "enqueue",
            "--id", plan["job_id"], "--timeout", str(profile["queue_timeout_s"]),
            "--cwd", plan["worktree"], "--repo", plan["worktree"], "--expect-rev", plan["rev"],
            # A vm-admitted profile waits at the floor derived from lease-policy.json, recorded in the plan.
            "--min-free-gib", _plain(plan["admission"]["queue_min_free_gib"]) if "admission" in plan
            else str(profile["floor_gib"]), "--wait-absent", paths["hold"]]
    for key in profile["wait_flock"]:
        argv += ["--wait-flock", paths[key]]
    if queue_takes_leases(paths["queue_script"]):
        # A VM job's queue lease is the heavy lease rig-run is handed, 0/0 as rig-run's own heavy lease was: its vm
        # lease carries the VM's estimates, which would otherwise count twice.
        est = (profile["est_mem_gib"], profile["est_disk_gib"]) if profile["lease"] else (0, 0)
        argv += ["--est-mem-gib", _plain(est[0]), "--est-disk-gib", _plain(est[1])]
    if queue_takes_lease_kind(paths["queue_script"]):
        argv += ["--lease-kind", plan["lane"]]
    return argv + ["--", *boot_argv(plan["python"], plan_path, plan_digest, "relay")]


class QueueRefused(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def enqueue(recipe_name, job_id, worktree, rev, recipe_args, paths, env_file=None, ops_repo=None,
            profile=None, lease_renew_s=300, lease_ttl_min=15, python=PYTHON, test=None):
    """Snapshot, record and enqueue one job. Returns (plan path, digest, queue stdout)."""
    recipe = RECIPES[recipe_name] if isinstance(recipe_name, str) else recipe_name
    profile = capped_profile(recipe, profile, getattr(recipe_args, "mem_cap_gib", None))
    if profile.lease_kind != "heavy" and not queue_takes_lease_kind(paths["queue_script"]):
        raise manifest.ManifestError("{} runs in the {} lane, which this queue does not have (no --lease-kind)".format(
            profile.name, profile.lease_kind))
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
    if not (profile or PROFILES[recipe.profile]).lease and queue_takes_leases(paths["queue_script"]) \
            and not rig_run_takes_lease(paths["rig_run"]):
        # The queue holds the job's one heavy lease (heavy maxCount 1); rig-run must be handed it (coordinator's
        # option b, 2026-10-07), which this rig-run cannot.
        raise manifest.ManifestError("VM jobs need a rig-run that is handed the queue's heavy lease "
                                     "(RIG_HEAVY_LEASE_ID); {} would take its own beside it".format(paths["rig_run"]))
    recipe_argv, specs, recorded = recipe.plan_args(recipe_args, worktree, rev, paths)
    repo, commit = ops_repo_and_commit(ops_repo)
    run_root = os.path.join(paths["evidence_root"], job_id)
    if os.path.exists(run_root):
        raise manifest.ManifestError("evidence directory {} already exists; choose a new job ID".format(run_root))
    # Everything the job runs and reads is sealed in its own directory: the ops/heavy files, the input copies and the
    # plan. Its existence also reserves the job ID.
    job_dir = os.path.join(paths["ops_root"], "jobs", job_id)
    os.makedirs(os.path.dirname(job_dir), mode=0o700, exist_ok=True)
    try:
        os.mkdir(job_dir, 0o700)
    except FileExistsError:
        raise manifest.ManifestError("job {} already exists ({}); choose a new job ID".format(job_id, job_dir)) from None
    try:
        files = extract_ops(repo, commit, job_dir)
        inputs = seal_inputs(specs, os.path.join(job_dir, "inputs"))
        plan = build_plan(recipe, job_id, worktree, rev, recipe_argv, inputs, recorded, env_file, paths,
                          (job_dir, files, repo, commit), profile=profile, python=python,
                          lease_renew_s=lease_renew_s, lease_ttl_min=lease_ttl_min, test=test)
        plan_path, digest = write_plan(plan, job_dir)
        _read_only(job_dir)
        vm_job = os.path.join(job_dir, "inputs", "vm-job")
        if os.path.isdir(vm_job):
            # rig-run writes runs/<id>/ into its job directory; only that subdirectory is writable.
            os.chmod(vm_job, 0o755)
            os.mkdir(os.path.join(vm_job, "runs"), 0o700)
            os.chmod(vm_job, 0o555)
        argv = queue_enqueue_argv(plan, plan_path, digest)
        if "--unpinned" in argv:
            raise AssertionError("--unpinned is never passed")
        done = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if done.returncode != 0:
            raise QueueRefused(done.returncode, done.stderr.strip())
    except BaseException:
        _writable(job_dir)
        shutil.rmtree(job_dir, ignore_errors=True)  # nothing was enqueued; the ID stays free
        raise
    return plan_path, digest, done.stdout.strip()


def prune(paths, job_id):
    """Remove a finished job's sealed input copies (clones share blocks with their sources until those change)."""
    done = subprocess.run([PYTHON, paths["queue_script"], "--state-dir", paths["queue_state"], "show", "--id", job_id],
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if done.returncode != 0:
        raise manifest.ManifestError("the queue has no job {}: {}".format(job_id, done.stderr.strip()))
    state = json.loads(done.stdout)["state"]
    if state in ("queued", "launching", "running", "blocked"):
        raise manifest.ManifestError("job {} is {}; prune only a finished job".format(job_id, state))
    inputs = os.path.join(paths["ops_root"], "jobs", job_id, "inputs")
    if os.path.isdir(inputs):
        _writable(inputs)
        shutil.rmtree(inputs)
    return inputs


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


class QueueStatusUnreadable(Exception):
    """The queue's `status` text has a line this parser does not know, or lacks one it needs."""


# The queue's `status` listing, the only one it prints, in its two formats. Pre-lanes (401c4d1) prints "slot: S" and
# rows "seq state job-id command"; lanes (e21588d) prints "slot NAME: S, runner R" per slot, "next LANE:" for lanes
# other than heavy, and rows "seq state lane job-id command". The slot lines decide the format: a lanes row read as a
# pre-lanes one is a job named after its lane, a legal ID, so the rows alone cannot tell them apart. The patterns follow
# _status in those commits; tests/fixtures/queue-status holds what each printed. A line matching none of them stops
# the command, because a row skipped as unknown would hide a job.
QUEUE_STATES = ("queued", "launching", "running", "blocked", "succeeded", "failed", "timed_out", "cancelled",
                "interrupted", "refused", "lost", "abandoned")
QUEUE_LANES = ("heavy", "browser")
_QUEUE_ID = r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}"
_HELD = r"(?:held|free)"
_STATUS_LINES = {
    "runner": re.compile(r"runner: (?:none|pid \d+(?: \([a-z0-9-]+\))?(?:, pid \d+ \([a-z0-9-]+\))*)\Z"),
    "pre-lanes slot": re.compile(r"slot: " + _HELD + r"\Z"),
    "lanes slot": re.compile(r"slot (?:heavy|browser-\d+): " + _HELD + r", runner (?:none|pid \d+)\Z"),
    "heavy lock": re.compile(r"heavy lock: " + _HELD + r" \(.+\)\Z"),
    "next": re.compile(r"next(?: (?P<lane>{}))?: (?P<id>{}) \(.*\)\Z".format(
        "|".join(lane for lane in QUEUE_LANES if lane != "heavy"), _QUEUE_ID)),
}
_ROW = {
    "pre-lanes": re.compile(r" *(?P<seq>\d+) (?P<state>{}) +(?P<id>{})(?: .*)?\Z".format(
        "|".join(QUEUE_STATES), _QUEUE_ID)),
    "lanes": re.compile(r" *(?P<seq>\d+) (?P<state>{}) +(?P<lane>{}) +(?P<id>{})(?: .*)?\Z".format(
        "|".join(QUEUE_STATES), "|".join(QUEUE_LANES), _QUEUE_ID)),
}


def parse_queue_status(text):
    """The queue's `status` text as {"format", "header" (runner, slot and heavy-lock lines), "next" ((lane, id, line)
    per lane head), "jobs" ({"seq", "state", "lane", "id"} per row)}. Pre-lanes jobs are heavy-lane jobs, as the
    lanes queue reads records from before lanes. Raises QueueStatusUnreadable naming the first line not understood."""
    fmt, header, nexts, jobs, seen = None, [], [], [], set()

    def unreadable(number, line, why):
        return QueueStatusUnreadable("the queue's status line {} is not understood ({}): {!r}".format(number, why, line))

    for number, line in enumerate(text.splitlines(), 1):
        kind = next((k for k, pattern in _STATUS_LINES.items() if pattern.match(line)), None)
        if kind is None:
            if fmt is None:
                raise unreadable(number, line, "not a header line, and no slot line has set the format yet")
            row = _ROW[fmt].match(line)
            if row is None:
                raise unreadable(number, line, "not a {} job row".format(fmt))
            jobs.append({"seq": int(row["seq"]), "state": row["state"], "lane": row.groupdict().get("lane") or "heavy",
                         "id": row["id"]})
            continue
        if jobs:
            raise unreadable(number, line, "a header line after the job rows")
        if kind.endswith(" slot"):
            line_fmt = kind[:-len(" slot")]
            if fmt not in (None, line_fmt):
                raise unreadable(number, line, "a {} slot line in {} output".format(line_fmt, fmt))
            fmt = line_fmt
        if kind == "next":
            match = _STATUS_LINES["next"].match(line)
            if match["lane"] and fmt != "lanes":
                raise unreadable(number, line, "a lane's next line in {} output".format(fmt))
            nexts.append((match["lane"] or "heavy", match["id"], line))
        else:
            header.append(line)
        seen.add("slot" if kind.endswith(" slot") else kind)
    missing = [k for k in ("runner", "slot", "heavy lock") if k not in seen]
    if missing:
        raise QueueStatusUnreadable("the queue's status is missing its {} line{}".format(
            ", ".join(missing), "s" if len(missing) > 1 else ""))
    return {"format": fmt, "header": header, "next": nexts, "jobs": jobs}


def _queue_status(paths):
    """(exit code, stdout) of the queue's `status`; its stderr passes through."""
    done = subprocess.run([PYTHON, paths["queue_script"], "--state-dir", paths["queue_state"], "status"],
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, text=True)
    return done.returncode, done.stdout


def queue_row(paths, job_id):
    """The queue's row for *job_id* ({"seq", "state", "lane", "id"}), or None when the queue lists no such job."""
    code, out = _queue_status(paths)
    if code != 0:
        raise QueueStatusUnreadable("the queue's status exited {}: {!r}".format(code, out.strip()))
    return next((job for job in parse_queue_status(out)["jobs"] if job["id"] == job_id), None)


def status(paths):
    """The queue's runner, slot and heavy-lock lines, its next lines for Caret's jobs, then Caret's jobs with their
    lane and three states, and a count of the other jobs. A failed queue status passes through unparsed."""
    code, out = _queue_status(paths)
    if code != 0:
        return code, out.rstrip("\n")
    parsed = parse_queue_status(out)
    lines = list(parsed["header"]) + [line for _, job_id, line in parsed["next"] if job_id.startswith("caret-")]
    others = 0
    for job in parsed["jobs"]:
        if not job["id"].startswith("caret-"):
            others += 1
            continue
        state = outcome_of(paths, job["id"])
        lines.append("{:>4} {:<12} {:<8} {:<28} executed={} validated={} accepted={}".format(
            job["seq"], job["state"], job["lane"], job["id"], state["executed"], state["validated"],
            None if state["accepted_by_lead"] is None else True))
    lines.append("other jobs: {}".format(others))
    return 0, "\n".join(lines)


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
    fetch = sub.add_parser("fetch-node", help="download the Node tarball build-app.sh pins at REV, kept only if its "
                                             "SHA-256 matches, into the cache r2-prepare seals it from")
    fetch.add_argument("--worktree", required=True)
    fetch.add_argument("--rev", required=True, help="full commit SHA whose build-app.sh pins the tarball")
    sub.add_parser("status")
    show = sub.add_parser("show")
    show.add_argument("job_id")
    pr = sub.add_parser("prune", help="remove a finished job's sealed input copies")
    pr.add_argument("job_id")
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
        if args.action == "fetch-node":
            if not SHA_PATTERN.match(args.rev):
                raise manifest.ManifestError("--rev must be a full 40-character commit SHA")
            print(fetch_node(os.path.realpath(args.worktree), args.rev, paths["node_cache"]))
            return 0
        if args.action == "status":
            code, text = status(paths)
            print(text)
            return code
        if args.action == "show":
            shown = outcome_of(paths, args.job_id) | {"evidence": os.path.join(paths["evidence_root"], args.job_id),
                                                      "queue": queue_row(paths, args.job_id)}
            print(json.dumps(shown, indent=1))
            return 0
        if args.action == "prune":
            print(prune(paths, args.job_id))
            return 0
        if args.action == "accept":
            print(accept(paths, args.job_id, args.note))
            return 0
    except QueueRefused as ex:
        print("caret-heavy: the queue refused: {}".format(ex), file=sys.stderr)
        return ex.code
    except QueueStatusUnreadable as ex:
        print("caret-heavy: {}".format(ex), file=sys.stderr)
        return EXIT_UNREADABLE
    except manifest.ManifestError as ex:
        print("caret-heavy: {}".format(ex), file=sys.stderr)
        return EXIT_CONFLICT
    return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
