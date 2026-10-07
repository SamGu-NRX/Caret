"""A temporary world for the supervisor's tests, built from real parts.

Real: the shared queue script and its runner, the supervisor and relay from a snapshot of this
ops/heavy tree committed to a scratch repository, lr-lease and lr-reap (copied into a temporary
HOME, so leases live in a temporary directory under a zero-floor policy), launchd, and every
process the probe recipe starts. Synthetic: the profile (floor 0, small estimates, short waits),
the worktree (a scratch repository) and the recipe's evidence. Nothing here reads or writes the
real queue state, ~/.caret-run/HOLD, ~/.long-run/leases or heavy.lock, and no floor in the real
lease policy changes. Processes are stopped only by exact pid, process group or the job's own
marker, and only those this test started.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HEAVY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HEAVY)

import caret_heavy  # noqa: E402
import manifest  # noqa: E402
import procs  # noqa: E402

PY = caret_heavy.PYTHON
REAL_LONG_RUN = os.path.expanduser("~/.long-run")
# The shared queue at a fixed commit, so the tests do not follow its owner's uncommitted work. 7ef4ccb: the runner holds
# heavy.lock and passes it to each job. Raise this deliberately when the queue's interface changes.
QUEUE_REPO = os.path.dirname(os.path.dirname(caret_heavy.QUEUE))
QUEUE_TEST_REV = "7ef4ccba3f71704bd8ca065c92b4beeb03c640cf"
GIT_ENV = {"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                           "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args],
                          env=dict(os.environ, **GIT_ENV), capture_output=True, text=True, check=True)


def probe_recipe(live=False, extra_inputs=None):
    """The test recipe: tests/recipes/probe.sh with the test's arguments, run from the snapshot. extra_inputs are
    caret_heavy.spec() dicts, sealed into the job like a real recipe's."""
    def plan_args(args, worktree, rev, paths):
        return list(args), list(extra_inputs or []), {}
    return caret_heavy.Recipe("probe", "test", "tests/recipes/probe.sh", live, None, plan_args)


def profile(lease=True, lease_wait=60, exec_s=120, grace=5.0, floor=0):
    # lease_wait 60 s rides out this shared Mac's brief warning-pressure readings at admission.
    return caret_heavy.Profile("caret-test", floor, 0.1, 0.1, lease, lease_wait, exec_s, grace,
                               "Synthetic test profile; not a Caret floor.")


class World(unittest.TestCase):
    """Per-test temporary world. Subclasses call self.enqueue(...) and self.run_queue(...)."""

    maxDiff = None

    def setUp(self):
        probes = procs.DarwinProbes()
        if not self.wait_for(lambda: probes.pressure_level() == procs.PRESSURE_NORMAL, 90, 1.0):
            self.skipTest("memory pressure stayed above normal for 90 s (the supervisor admits only at 1, normal)")
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="caret-heavy-test-"))
        self.addCleanup(self._teardown)
        self.home = os.path.join(self.root, "home")
        bin_dir = os.path.join(self.home, ".long-run/bin")
        os.makedirs(bin_dir)
        for name in ("lr-lease", "lr-reap", "lr-lease-cli.mjs", "lr-lease-core.mjs"):
            shutil.copy2(os.path.join(REAL_LONG_RUN, "bin", name), bin_dir)
        with open(os.path.join(REAL_LONG_RUN, "lease-policy.json")) as fh:
            policy = json.load(fh)
        for rule in policy["kinds"].values():
            rule["diskFloorGB"] = 0  # synthetic test policy; the real one is never written
        policy["kinds"]["heavy"]["maxCount"] = policy["kinds"]["vm"]["maxCount"] = 1
        with open(os.path.join(self.home, ".long-run/lease-policy.json"), "w") as fh:
            json.dump(policy, fh)
        os.makedirs(os.path.join(self.home, ".long-run/leases"))
        os.makedirs(os.path.join(self.home, ".long-run/locks"))
        queue_script = os.path.join(self.root, "queue", "heavy-job-queue.py")
        os.makedirs(os.path.dirname(queue_script))
        with open(queue_script, "wb") as fh:
            fh.write(subprocess.run(["git", "-C", QUEUE_REPO, "show", QUEUE_TEST_REV + ":scripts/heavy-job-queue.py"],
                                    capture_output=True, check=True).stdout)
        self.paths = {
            "queue_script": queue_script,
            "queue_state": os.path.join(self.root, "queue-state"),
            "slot_lock": os.path.join(self.root, "queue-state", "slot.lock"),
            "ops_root": os.path.join(self.root, "ops"),
            "evidence_root": os.path.join(self.root, "evidence"),
            "hold": os.path.join(self.root, "HOLD"),
            "lr_lease": os.path.join(bin_dir, "lr-lease"),
            "lr_reap": os.path.join(bin_dir, "lr-reap"),
            "heavy_lock": os.path.join(self.home, ".long-run/locks/heavy.lock"),
            "rig_stop": os.path.join(REAL_LONG_RUN, "rig/bin/rig-stop"),
            "rig_run": os.path.join(self.root, "fake-rig", "rig-run"),
            "lume_clones": os.path.join(self.home, ".lume"),
            "ios_qa_lock": os.path.join(self.root, "local-ios-qa.lock"),
        }
        os.makedirs(os.path.dirname(self.paths["rig_run"]))
        shutil.copy2(os.path.join(HEAVY, "tests/fake-rig-run.sh"), self.paths["rig_run"])
        # The ops checkout: this ops/heavy tree as it is now, committed to a scratch repository.
        self.ops_repo = os.path.join(self.root, "ops-repo")
        shutil.copytree(HEAVY, os.path.join(self.ops_repo, "ops/heavy"),
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        git(self.ops_repo, "init", "-q")
        git(self.ops_repo, "add", "-A")
        git(self.ops_repo, "commit", "-q", "-m", "ops snapshot for tests")
        # The pinned worktree.
        self.worktree = os.path.join(self.root, "worktree")
        os.makedirs(self.worktree)
        git(self.worktree, "init", "-q")
        with open(os.path.join(self.worktree, "tracked"), "w") as fh:
            fh.write("one\n")
        git(self.worktree, "add", "tracked")
        git(self.worktree, "commit", "-q", "-m", "scratch")
        self.rev = git(self.worktree, "rev-parse", "HEAD").stdout.strip()
        self.env = dict(os.environ, HOME=self.home)
        self.env.pop("HEAVY_JOB_QUEUE_DIR", None)
        self.runners = []
        self.jobs = []

    def _teardown(self):
        for runner in self.runners:
            if runner.poll() is None:
                os.killpg(runner.pid, signal.SIGKILL)  # the runner's own session, started by this test
            runner.wait()
        for job_id in self.jobs:
            self.wait_for(lambda: not self.marked(job_id) and not self.labels(job_id), 30)
            for pid in self.marked(job_id):
                os.kill(pid, signal.SIGKILL)
            for label in self.labels(job_id):
                procs.launchd_bootout(label)
            outcome = self.outcome(job_id)
            if outcome:
                pid = outcome.get("supervisor_pid")
                self.wait_for(lambda: pid is None or procs.DarwinProbes().usage(pid) is None, 30)
        for dirpath, dirnames, filenames in os.walk(self.root):
            os.chmod(dirpath, 0o755)
        shutil.rmtree(self.root, ignore_errors=True)

    # Jobs

    def enqueue(self, args, job_id=None, live=False, env_file=None, extra_inputs=None, **kw):
        job_id = job_id or "caret-test-{}-{}".format(os.getpid(), len(self.jobs))
        self.jobs.append(job_id)
        plan_path, digest, out = caret_heavy.enqueue(
            probe_recipe(live, extra_inputs), job_id, self.worktree, self.rev, args, self.paths,
            env_file=env_file, ops_repo=self.ops_repo, profile=kw.pop("profile", profile()), **kw)
        return job_id, plan_path

    def run_queue(self, *args, env=None, runner_holds_heavy_lock=True):
        """Starts the real queue runner in its own session; returns the Popen.

        Since the queue's 366e9c2 the runner takes heavy.lock as its last admission step and passes the locked
        descriptor to the job. runner_holds_heavy_lock=False points it at an unrelated lock file instead, which is
        how an older runner (one that never held Caret's heavy.lock) looks to the job.
        """
        log = open(os.path.join(self.root, "runner-{}.log".format(len(self.runners))), "ab")
        lock = self.paths["heavy_lock"] if runner_holds_heavy_lock else os.path.join(self.root, "unrelated.lock")
        runner = subprocess.Popen([PY, self.paths["queue_script"], "--state-dir", self.paths["queue_state"],
                                   "--heavy-lock", lock, "run", *args],
                                  env=dict(self.env, **(env or {})), stdin=subprocess.DEVNULL, stdout=log,
                                  stderr=subprocess.STDOUT, start_new_session=True)
        log.close()
        self.runners.append(runner)
        return runner

    def queue(self, *args):
        return subprocess.run([PY, self.paths["queue_script"], "--state-dir", self.paths["queue_state"], *args],
                              env=self.env, capture_output=True, text=True)

    def job(self, job_id):
        with open(os.path.join(self.paths["queue_state"], "jobs", job_id + ".json")) as fh:
            return json.load(fh)

    def queue_log(self, job_id):
        try:
            with open(os.path.join(self.paths["queue_state"], "logs", job_id + ".log"), errors="replace") as fh:
                return fh.read()
        except FileNotFoundError:
            return ""

    def run_root(self, job_id):
        return os.path.join(self.paths["evidence_root"], job_id)

    def outcome(self, job_id):
        try:
            with open(os.path.join(self.run_root(job_id), "outcome.json")) as fh:
                return json.load(fh)
        except (FileNotFoundError, ValueError):
            return None

    # Observations

    @staticmethod
    def wait_for(predicate, seconds, step=0.2):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(step)
        return bool(predicate())

    @staticmethod
    def marked(job_id):
        """Live pids whose environment carries this job's marker (any run of it)."""
        probes = procs.DarwinProbes()
        prefix = "{}={}.".format(procs.MARK_VAR, job_id)
        found = []
        for pid in probes.all_pids():
            if pid == os.getpid() or probes.usage(pid) is None:
                continue
            got = probes.procargs(pid)
            if got and any(e.startswith(prefix) for e in got[1]):
                found.append(pid)
        return found

    @staticmethod
    def labels(job_id):
        return [label for label, _ in procs.launchd_jobs("caret-heavy.{}.".format(job_id))]

    def leases(self):
        folder = os.path.join(self.home, ".long-run/leases")
        out = []
        for name in os.listdir(folder):
            if name.endswith(".json") and not name.startswith("."):
                with open(os.path.join(folder, name)) as fh:
                    out.append(json.load(fh))
        return out

    def alive(self, pid):
        return procs.DarwinProbes().usage(pid) is not None

    def spawned(self, job_id):
        """{kind: pid or label} the probe recorded."""
        out = {}
        try:
            with open(os.path.join(self.run_root(job_id), "out", "spawned.txt")) as fh:
                for line in fh:
                    kind, value = line.split()
                    out[kind] = int(value) if value.isdigit() else value
            with open(os.path.join(self.run_root(job_id), "out", "orphan.pid")) as fh:
                out["orphan"] = int(fh.read())
        except FileNotFoundError:
            pass
        return out
