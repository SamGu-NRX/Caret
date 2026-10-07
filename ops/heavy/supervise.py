"""Run one Caret heavy job for the shared queue: a relay in the queue's process group, and a
supervisor outside it that owns the slot, the lease and every process the job starts.

Why two processes. The queue stops a job by signalling its process group: SIGTERM, then SIGKILL
10 s later. A recipe's cleanup can take longer than that (rig-run's VM teardown budget is 45 s),
and a SIGKILL of a supervisor inside that group would orphan whatever it was tracking. So the
queue's command is a small relay. The relay starts the supervisor in a new session and hands it
the inherited slot.lock descriptor; the slot stays held while the supervisor keeps that open
file, whatever happens to the relay. The relay forwards a stop signal as one byte on a pipe; the
supervisor also reads end-of-file on that pipe as the relay's death. Either way it stops the
recipe, waits for cleanup, and only then releases the lease and exits, which frees the slot.

Ownership is explicit (procs.Tracker): the recipe's process group, every descendant by pid and
start time, every process started since the job whose environment carries the job's marker, and
every launchd job whose label starts with the job's prefix. Stopping sends SIGTERM to all of them
and boots out the launchd jobs, waits the profile's grace, then sends SIGKILL every second, with
a fresh full scan each time, until nothing owned is left. The lease, heavy.lock and slot are held
until then; a process that cannot be killed keeps them held, which blocks the queue.

Order of a run: inputs checked against the plan's manifest (65 on any change); HOLD, lease and
heavy.lock, then free disk and memory pressure rechecked under the lease, all within the
profile's lease wait (75 if not admitted); the recipe, bounded by the profile's execution limit
(124); cleanup; VM postconditions for rig-run jobs; the evidence adapter (results.py, 66 when a
recipe that exited 0 left missing, stale or foreign evidence); lease release; outcome.json.

Custody (Astra's design, recovery.py). Before any lease or workload, the supervisor starts a
launchd recovery owner and hands it copies of the locked descriptors and the attempt's token. It
registers the recipe's process group with the owner before releasing the recipe (the queue's own
trampoline pattern), and releases its locks and lease only after a fresh inventory says every
registered resource is ABSENT. Otherwise the job is QUARANTINED: the descriptors stay held and the
stop and inventory are retried until they succeed. If the supervisor dies, the recovery owner
finishes the cleanup. If the queue's runner dies, the supervisor cancels the workload.

Exit status (the relay exits with the supervisor's): the recipe's own (ops/heavy/README.md), 65
refused, 66 evidence rejected, 75 not admitted, 124 execution limit, 125 supervisor error, 143
cancelled by the queue, the relay's death or the runner's.
"""

import argparse
import fcntl
import json
import os
import pwd
import secrets
import signal
import subprocess
import sys
import threading
import time
import traceback
import uuid

import manifest
import procs
import recovery
import results

EXIT_REFUSED, EXIT_EVIDENCE, EXIT_NOT_ADMITTED = 65, 66, 75
EXIT_TIMEOUT, EXIT_ERROR, EXIT_CANCELLED = 124, 125, 143
POLL = 0.25
FULL_SCAN_EVERY = 1.0
KILL_EVERY = 1.0
CUSTODY_PING_S = 5.0
QUARANTINE_AFTER_S = 60.0
# Retries while quarantined: every second for the first minute, then every 15 s.
QUARANTINE_RETRY = (1.0, 15.0)
TRAMPOLINE = """\
import os, sys
go = int(sys.argv[1])
byte = os.read(go, 1)
os.close(go)
if byte != b"G":
    os._exit(97)
os.execv(sys.argv[2], sys.argv[2:])
"""
VZ_PATTERN = "com.apple.Virtualization.VirtualMachine"


def utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def say(role, message):
    print("{} caret-heavy {}: {}".format(utc_now(), role, message), file=sys.stderr, flush=True)


def main(plan_path, plan_digest, plan, argv):
    if argv[:1] == ["relay"]:
        return relay(plan_path, plan_digest, plan)
    if argv[:1] == ["recover"]:
        return recovery.main(plan, argv[1:])
    if argv[:1] == ["supervise"]:
        parser = argparse.ArgumentParser(prog="supervise")
        for name in ("--slot-fd", "--life-fd", "--status-fd", "--runner-pid", "--runner-start"):
            parser.add_argument(name, type=int, required=True)
        parser.add_argument("--heavy-fd", type=int)
        args = parser.parse_args(argv[1:])
        return Supervisor(plan_path, plan_digest, plan, args.slot_fd, args.life_fd, args.status_fd,
                          heavy_fd=args.heavy_fd, runner=[args.runner_pid, args.runner_start]).run()
    say("boot", "expected relay or supervise, got {}".format(argv[:1]))
    return 2


# Relay: the queue's process group


def relay(plan_path, plan_digest, plan):
    import caret_heavy  # from the same verified snapshot
    try:
        slot_fd = procs.inherited_lock_fd(plan["paths"]["slot_lock"])
        # A runner that holds heavy.lock for the job passes its descriptor, as it passes the slot's.
        heavy_fd = procs.inherited_lock_fd_if_any(plan["paths"]["heavy_lock"])
    except procs.Refusal as ex:
        say("relay", "refused: {}".format(ex))
        return EXIT_REFUSED
    life_r, life_w = os.pipe()       # relay -> supervisor: b"C" to cancel; end-of-file when the relay dies
    status_r, status_w = os.pipe()   # supervisor -> relay: the final exit status, after all cleanup
    # The queue's runner is this relay's parent. The supervisor watches its identity, because the relay can outlive
    # it: a runner killed while the job runs leaves the relay waiting, with nothing to deliver a cancellation.
    runner = recovery.identity(procs.DarwinProbes(), os.getppid())
    if runner is None:
        say("relay", "refused: the queue runner that started this job is gone")
        return EXIT_REFUSED
    argv = caret_heavy.boot_argv(plan["python"], plan_path, plan_digest, "supervise", "--slot-fd", str(slot_fd),
                                 "--life-fd", str(life_r), "--status-fd", str(status_w),
                                 "--runner-pid", str(runner[0]), "--runner-start", str(runner[1]))
    passed = (slot_fd, life_r, status_w)
    if heavy_fd is not None:
        argv += ["--heavy-fd", str(heavy_fd)]
        passed += (heavy_fd,)
    try:
        proc = subprocess.Popen(argv, start_new_session=True, pass_fds=passed, stdin=subprocess.DEVNULL)
    except OSError as ex:
        say("relay", "could not start the supervisor: {}".format(ex))
        return EXIT_ERROR
    # The supervisor now holds the slot; this copy and the pipe ends it owns are closed here.
    for fd in passed:
        os.close(fd)
    say("relay", "supervisor pid {} (session {}) holds the slot{}".format(
        proc.pid, proc.pid, " and the runner's heavy.lock" if heavy_fd is not None else ""))
    forwarded = []

    def forward(signum, _frame):
        if not forwarded:
            forwarded.append(signum)
            try:
                os.write(life_w, b"C")
            except OSError:
                pass

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, forward)
    data = b""
    while True:
        chunk = os.read(status_r, 4096)
        if not chunk:
            break
        data += chunk
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        pass
    try:
        code = int(json.loads(data)["exit"])
    except (ValueError, KeyError, TypeError):
        say("relay", "the supervisor ended without a status (exit {})".format(proc.returncode))
        return EXIT_ERROR
    if forwarded:
        say("relay", "forwarded signal {}; supervisor finished cleanup".format(forwarded[0]))
    return code


# Supervisor: its own session


class Supervisor:
    def __init__(self, plan_path, plan_digest, plan, slot_fd, life_fd, status_fd, probes=None, heavy_fd=None,
                 runner=None):
        self.plan_path, self.plan_digest, self.plan = plan_path, plan_digest, plan
        self.runner = runner
        self.attempt = uuid.uuid4().hex
        # The secret that acknowledges a clean (lr-lease ack, recovery adoption). Memory only: never argv, logs,
        # journal, plan or outcome.
        self.token = secrets.token_hex(32)
        self.custody = None
        self.launched = False
        self.concluded = False
        self.slot_fd, self.life_fd, self.status_fd = slot_fd, life_fd, status_fd
        # heavy.lock held through the queue runner's descriptor, or None (today's queue): then the supervisor
        # takes heavy.lock itself, and for VM jobs rig-run does.
        self.heavy_fd = heavy_fd
        self.profile, self.paths = plan["profile"], plan["paths"]
        self.probes = probes or procs.DarwinProbes()
        self.pid = os.getpid()
        self.run_root = plan["run_root"]
        self.out = os.path.join(self.run_root, "out")
        self.mark = "{}.{}".format(plan["job_id"], uuid.uuid4().hex[:12])
        self.launchd_prefix = "caret-heavy.{}.".format(plan["job_id"])
        self.tracker = None
        self.cancel = threading.Event()
        self.cancel_reason, self.cancel_code = None, None
        self.lease_id, self.lock_fd, self.queue_lease = None, None, None
        self.lease_cleanup = self._lease_supports_cleanup()
        self.record = {"job_id": plan["job_id"], "plan": plan_path, "plan_sha256": plan_digest,
                       "supervisor_pid": self.pid, "mark": self.mark, "launchd_prefix": self.launchd_prefix,
                       "started_utc": utc_now(), "events": [], "states": {"executed": False, "validated": False,
                                                                          "accepted_by_lead": None}}

    def log(self, message, **fields):
        say("supervisor", message)
        self.record["events"].append(dict({"at": utc_now(), "event": message}, **fields))

    # Entry

    def _lease_supports_cleanup(self):
        """Whether this lr-lease takes --cleanup-attempt (the vendored version, pending install)."""
        try:
            with open(os.path.join(os.path.dirname(self.paths["lr_lease"]), "lr-lease-cli.mjs"), encoding="utf-8") as fh:
                return "--cleanup-token-sha256" in fh.read()
        except OSError:
            return False

    def run(self):
        code, reason = EXIT_ERROR, "supervisor error"
        try:
            # The slot must be the queue's, held through this exact open file.
            procs.inherited_lock_fd(self.paths["slot_lock"], self.slot_fd)
            if self.heavy_fd is not None:
                procs.inherited_lock_fd(self.paths["heavy_lock"], self.heavy_fd)
            if signal.getsignal(signal.SIGCHLD) not in (signal.SIG_DFL, None):
                raise procs.Refusal("SIGCHLD must have its default disposition")
            for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                signal.signal(sig, self._on_signal)
            threading.Thread(target=self._watch_relay, name="relay-watch", daemon=True).start()
            code, reason = self._run()
        except procs.Refusal as ex:
            code, reason = EXIT_REFUSED, "refused: {}".format(ex)
        except Exception as ex:
            code, reason = EXIT_ERROR, "supervisor error: {!r}".format(ex)
            traceback.print_exc()
        finally:
            if self.launched and not self.concluded:
                # Something was started and its absence is not confirmed: keep the lease and locks, which the
                # recovery owner holds too; it finishes the cleanup once this process is gone.
                reason += "; cleanup left to the recovery owner {}".format(self.custody.label if self.custody else "")
                self.record["cleanup"] = "left to the recovery owner"
            else:
                self._release()
                if self.custody is not None and not self.concluded:
                    self._conclude_unlaunched()
            self.record.update(exit=code, reason=reason, ended_utc=utc_now())
            self._write_outcome()
            self._send_status(code)
            say("supervisor", "exit {}: {}".format(code, reason))
        return code

    def _on_signal(self, signum, _frame):
        self._request_cancel("supervisor received signal {}".format(procs.signal_name(signum)), 128 + signum)

    def _watch_relay(self):
        try:
            byte = os.read(self.life_fd, 1)
        except OSError:
            byte = b""
        if byte == b"C":
            self._request_cancel("cancelled by the queue (timeout or cancel)", EXIT_CANCELLED)
        else:
            self._request_cancel("the queue's relay died (its process group was killed)", EXIT_CANCELLED)

    def _request_cancel(self, reason, code):
        if not self.cancel.is_set():
            self.cancel_reason, self.cancel_code = reason, code
            self.cancel.set()

    # The job

    def _run(self):
        try:
            os.makedirs(os.path.dirname(self.run_root), mode=0o700, exist_ok=True)
            os.mkdir(self.run_root, 0o700)  # never reused: evidence in it is this run's
        except FileExistsError:
            return EXIT_REFUSED, "run directory {} already exists".format(self.run_root)
        os.mkdir(self.out, 0o700)
        self._write_json("supervisor.json", {k: self.record[k] for k in (
            "job_id", "supervisor_pid", "mark", "launchd_prefix", "started_utc")})
        problems = self._sealed_problems()
        if problems:
            return EXIT_REFUSED, "inputs changed since enqueue: " + "; ".join(problems)
        self.log("inputs match the plan's manifest ({} entries)".format(len(self.plan["inputs"])))
        self._start_custody()
        admitted = self._admit()
        if admitted is not True:
            return admitted
        # Again, immediately before the spawn: the lease wait can take up to the profile's lease_wait_s.
        problems = self._sealed_problems()
        if problems:
            return EXIT_REFUSED, "inputs changed since enqueue (found after admission): " + "; ".join(problems)
        return self._run_recipe()

    def _sealed_problems(self):
        """What no longer matches the plan: the job's sealed ops/heavy files, its sealed inputs, the pinned worktree."""
        import caret_heavy
        problems = []
        try:
            files = caret_heavy.snapshot_files(self.plan["ops"]["snapshot"])
        except manifest.ManifestError as ex:
            files, problems = None, [str(ex)]
        if files is not None and files != self.plan["ops"]["files"]:
            changed = sorted(k for k in set(files) | set(self.plan["ops"]["files"])
                             if files.get(k) != self.plan["ops"]["files"].get(k))
            problems.append("sealed ops/heavy files changed: {}".format(changed[:5]))
        problems += manifest.check(self.plan["inputs"])
        try:
            manifest.record("worktree", "git", self.plan["worktree"], rev=self.plan["rev"])
        except manifest.ManifestError as ex:
            problems.append(str(ex))
        return problems

    # Custody

    def _start_custody(self):
        locks = {"slot": self.slot_fd}
        if self.heavy_fd is not None:
            locks["heavy"] = self.heavy_fd
        self.custody = recovery.Custody(self.plan, self.plan_path, self.plan_digest, self.attempt, self.token,
                                        self.probes, self.log)
        self.record["recovery"] = {"label": self.custody.label, "attempt": self.attempt,
                                   "socket": self.custody.sock_path}
        self._write_json("supervisor.json", {k: self.record[k] for k in (
            "job_id", "supervisor_pid", "mark", "launchd_prefix", "started_utc", "recovery")})
        self.custody.start(locks)
        self.log("the recovery owner {} holds copies of {}".format(self.custody.label, sorted(locks)))
        recovery.test_point(self.plan, "supervisor:after-adopt")

    def _conclude_unlaunched(self):
        """Nothing was started: the owner's inventory is empty, so it can be told clean at once."""
        try:
            self.custody.must({"op": "clean"})
            self.custody.finish()
            self.concluded = True
        except recovery.CustodyError as ex:
            self.log("the recovery owner could not be released: {}".format(ex))

    # Admission under the lease

    def _admit(self):
        deadline = time.monotonic() + self.profile["lease_wait_s"]
        delay, last = 2.0, None
        while True:
            if self.cancel.is_set():
                return self.cancel_code, "cancelled before start: {}".format(self.cancel_reason)
            why = self._try_admit()
            if why is None:
                return True
            if why != last:
                self.log("waiting: {}".format(why))
                last = why
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return EXIT_NOT_ADMITTED, "not admitted within the lease wait of {:.0f} s: {}".format(
                    self.profile["lease_wait_s"], why)
            self.cancel.wait(min(delay, remaining))
            delay = min(delay * 2, 30.0)

    def _try_admit(self):
        if os.path.lexists(self.paths["hold"]):
            return "HOLD {} exists".format(self.paths["hold"])
        self.queue_lease = self._queue_lease()
        if self.profile["lease"] and self.queue_lease is None:
            subprocess.run([self.paths["lr_reap"], "--run", self.plan["lease"]["run"]], stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            cleanup = ["--cleanup-attempt", self.attempt, "--cleanup-token-sha256",
                       recovery.token_sha256(self.token)] if self.lease_cleanup else []
            got = self._lease_cmd("acquire", "--run", self.plan["lease"]["run"], "--kind", "heavy",
                                  "--est-mem", str(self.profile["est_mem_gib"]),
                                  "--est-disk", str(self.profile["est_disk_gib"]),
                                  "--ttl", str(self.plan["lease"]["ttl_min"]), "--owner-pid", str(self.pid), *cleanup)
            if got.returncode != 0:
                return "heavy lease: {}".format(got.stdout.strip() or got.returncode)
            self.lease_id = got.stdout.strip()
            self.lease_renewed = time.monotonic()
        if self.profile["lease"]:
            if self.heavy_fd is None:
                os.makedirs(os.path.dirname(self.paths["heavy_lock"]), exist_ok=True)
                self.lock_fd = os.open(self.paths["heavy_lock"], os.O_RDWR | os.O_CREAT, 0o644)
                try:
                    fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    self._release()
                    return ("heavy.lock is held by another heavy job (a queue runner that holds it must pass its "
                            "descriptor to the job)")
        # Rechecked under the lease, just before the heavy work: the queue's admission was a while ago.
        level = self.probes.pressure_level()
        problem = None
        if level != procs.PRESSURE_NORMAL:
            problem = "memory pressure level {} (1 is normal)".format(level)
        else:
            for path in {self.plan["worktree"], os.path.dirname(self.run_root)}:
                free = self.probes.free_bytes(path) / (1 << 30)
                if free < self.profile["floor_gib"]:
                    problem = "{:.1f} GiB free on {}, the profile needs {}".format(free, path, self.profile["floor_gib"])
                    break
        if problem is None and os.path.lexists(self.paths["hold"]):
            problem = "HOLD {} exists".format(self.paths["hold"])
        if problem:
            self._release()
            return problem
        # The recovery owner holds the lock and knows the lease before anything starts.
        try:
            if self.lock_fd is not None:
                self.custody.add_lock("heavy", self.lock_fd)
            if self.lease_id:
                self.custody.must({"op": "lease", "id": self.lease_id, "cleanup": self.lease_cleanup})
        except recovery.CustodyError:
            self._release()
            raise
        self.log("admitted", lease=self.lease_id, queue_lease=self.queue_lease, lease_cleanup_required=self.lease_cleanup,
                 heavy_lock="inherited from the queue runner" if self.heavy_fd is not None
                 else "taken" if self.lock_fd is not None else "left to rig-run")
        self.record["lease"] = {"id": self.lease_id, "cleanup_required": self.lease_cleanup, "renewals": 0,
                                "renew_failures": [], "queue_lease": self.queue_lease}
        return None

    def _queue_lease(self):
        """The heavy lease the queue took for this job (heavy-job-queue 401c4d1 and later), when it is live.

        Such a queue holds the single heavy lease for the job's whole life (owner: its runner), so the supervisor
        takes none of its own, which lr-lease's count limit would refuse. The queue releases it once the job's
        process group is empty; see README, "Leases"."""
        try:
            with open(os.path.join(self.paths["queue_state"], "jobs", self.plan["job_id"] + ".json"),
                      encoding="utf-8") as fh:
                lease_id = json.load(fh).get("lease_id")
        except (OSError, ValueError):
            return None
        if not lease_id:
            return None
        state, detail = procs.lease_state(self.paths["lr_lease"], lease_id)
        if state != procs.PRESENT:
            raise procs.Refusal("the queue recorded lease {} for this job, but it is {}: {}".format(lease_id, state, detail))
        return lease_id

    def _lease_cmd(self, *args):
        return subprocess.run([self.paths["lr_lease"], *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True)

    def _hold_reservation(self):
        """The queue's lease is released once the relay's group is empty, which the queue's SIGKILL of the relay
        makes true while cleanup may still be running. Then the supervisor takes the job's heavy lease itself (the
        count limit is free again) and keeps it until the cleanup is confirmed. If another run took it first,
        exclusion still rests on the locks this job holds."""
        if not self.queue_lease or self.lease_id or not self.profile["lease"] or self.concluded:
            return
        if time.monotonic() - getattr(self, "queue_lease_checked", 0) < 2:
            return
        self.queue_lease_checked = time.monotonic()
        if procs.lease_state(self.paths["lr_lease"], self.queue_lease)[0] != procs.ABSENT:
            return
        cleanup = ["--cleanup-attempt", self.attempt, "--cleanup-token-sha256",
                   recovery.token_sha256(self.token)] if self.lease_cleanup else []
        got = self._lease_cmd("acquire", "--run", self.plan["lease"]["run"], "--kind", "heavy",
                              "--est-mem", str(self.profile["est_mem_gib"]), "--est-disk", str(self.profile["est_disk_gib"]),
                              "--ttl", str(self.plan["lease"]["ttl_min"]), "--owner-pid", str(self.pid), *cleanup)
        if got.returncode != 0:
            if not getattr(self, "takeover_refused", False):
                self.takeover_refused = True
                self.log("the queue released its lease before cleanup was confirmed; taking it over was refused: {}"
                         .format(got.stdout.strip()[:200]))
            return
        self.lease_id, self.lease_renewed = got.stdout.strip(), time.monotonic()
        self.record.setdefault("lease", {}).update(id=self.lease_id, taken_over_from=self.queue_lease)
        try:
            self.custody.must({"op": "lease", "id": self.lease_id, "cleanup": self.lease_cleanup})
        except recovery.CustodyError as ex:
            self.log("the recovery owner did not record the lease: {}".format(ex))
        self.log("the queue released its lease before cleanup was confirmed; holding lease {} until it is".format(
            self.lease_id))

    def _renew_if_due(self):
        self._hold_reservation()
        if not self.lease_id or time.monotonic() - self.lease_renewed < self.plan["lease"]["renew_s"]:
            return
        self.lease_renewed = time.monotonic()
        got = self._lease_cmd("renew", self.lease_id, "--owner-pid", str(self.pid),
                              "--ttl", str(self.plan["lease"]["ttl_min"]))
        if got.returncode == 0:
            self.record["lease"]["renewals"] += 1
        else:
            self.record["lease"]["renew_failures"].append({"at": utc_now(), "why": got.stdout.strip()[:300]})
            self.log("lease renewal failed: {}".format(got.stdout.strip()[:300]))

    # The recipe

    def _recipe_env(self):
        user = pwd.getpwuid(os.getuid())
        home = os.path.expanduser("~")
        env = {
            "HOME": home, "USER": user.pw_name, "LOGNAME": user.pw_name, "SHELL": "/bin/bash",
            "PATH": ":".join(["/opt/homebrew/bin", os.path.join(home, ".npm-global/bin"),
                              "/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
            "LANG": "en_US.UTF-8", "TMPDIR": os.environ.get("TMPDIR", "/tmp"), "TERM": "dumb",
            # Any Python the recipe starts without -I neither writes bytecode nor reads it from beside a module.
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPYCACHEPREFIX": "/var/empty",
            procs.MARK_VAR: self.mark,
            "CARET_HEAVY_LAUNCHD_PREFIX": self.launchd_prefix,
            "CARET_HEAVY_JOB_ID": self.plan["job_id"], "CARET_HEAVY_PLAN_SHA256": self.plan_digest,
            "CARET_HEAVY_RECIPE": self.plan["recipe"]["name"], "CARET_HEAVY_OUT": self.out,
            "CARET_HEAVY_PY": self.plan["python"], "CARET_HEAVY_REV": self.plan["rev"],
            "CARET_HEAVY_RECIPES": os.path.join(self.plan["ops"]["snapshot"], "ops/heavy/recipes"),
            "CARET_HEAVY_INPUTS": self.plan["inputs_dir"],
            # A recipe registers any launchd job it starts, before starting it (register.py).
            "CARET_HEAVY_RECOVERY_SOCKET": self.custody.sock_path,
            "CARET_HEAVY_REGISTER": " ".join([self.plan["python"], *("-I", "-B", "-X", "pycache_prefix=/var/empty"),
                                              os.path.join(self.plan["ops"]["snapshot"], "ops/heavy/register.py")]),
        }
        held = self._held_heavy_fd()
        if held is not None:
            # heavy.lock is held for this job; Caret's scripts would otherwise wait on it from a child, and rig-run
            # proves the descriptor holds it (flock through it) before using it instead of taking its own.
            env.update(CARET_HEAVY_LOCK_HELD="1", CARET_NO_LOCK="1", RIG_HEAVY_LOCK_FD=str(held))
        if not self.profile["lease"]:
            # VM jobs: rig-run rechecks free disk against this floor once it holds its leases, before any clone.
            env["RIG_RUN_MIN_FREE_GIB"] = str(int(-(-self.profile["floor_gib"] // 1)))
        env.update(self.plan["env"])
        if self.plan["recipe"]["live"]:
            env["CARET_ENV_FILE"] = self.plan["env_file"]
        return env

    def _held_heavy_fd(self):
        return self.heavy_fd if self.heavy_fd is not None else self.lock_fd

    def _run_recipe(self):
        started_abstime = self.probes.now_abstime()
        self.tracker = procs.Tracker(self.probes, self.mark, self.launchd_prefix, started_abstime)
        vz_before = set(self._vz_pids())
        started_wall = time.time()
        log = open(os.path.join(self.run_root, "recipe.log"), "ab")
        # The recipe inherits the slot and heavy.lock descriptors as the queue intends: if this supervisor is
        # SIGKILLed, the slot and lock stay held while a recipe process that kept them is alive.
        held = tuple(fd for fd in (self.slot_fd, self._held_heavy_fd()) if fd is not None)
        go_r, go_w = os.pipe()
        try:
            # Held back by the trampoline until its group is registered with the recovery owner (the queue's own
            # pattern): a cancellation that arrives first denies the release for good.
            proc = subprocess.Popen([self.plan["python"], "-I", "-S", "-c", TRAMPOLINE, str(go_r), "/bin/bash",
                                     self.plan["recipe"]["script"], *self.plan["recipe"]["args"]],
                                    cwd=self.plan["worktree"], env=self._recipe_env(), stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                                    pass_fds=(go_r, *held))
        finally:
            log.close()
            os.close(go_r)
        self.launched = True
        self.tracker.add_leader(proc.pid)
        leader = recovery.identity(self.probes, proc.pid)
        released = False
        try:
            if leader is not None and not self.cancel.is_set():
                self.custody.must({"op": "register", "resource": {"id": "recipe", "type": "group", "pgid": proc.pid,
                                                                  "leader": leader}})
                self.custody.must({"op": "register", "resource": {"id": "marker", "type": "marker", "mark": self.mark,
                                                                  "since": started_abstime}})
                self.custody.must({"op": "register", "resource": {"id": "launchd-prefix", "type": "launchd-prefix",
                                                                  "prefix": self.launchd_prefix}})
                recovery.test_point(self.plan, "supervisor:after-register")
                if not self.cancel.is_set():
                    os.write(go_w, b"G")
                    released = True
        except recovery.CustodyError as ex:
            self.log("the recipe was not registered, so it is never released: {}".format(ex))
        finally:
            os.close(go_w)
        if released:
            recovery.test_point(self.plan, "supervisor:after-release")
            self.log("recipe started", pid=proc.pid, pgid=proc.pid)
        else:
            self.log("recipe never released", pid=proc.pid)
            self._request_cancel(self.cancel_reason or "the recipe could not be registered", self.cancel_code or EXIT_ERROR)
        stop = self._watch(proc)
        proc.wait()
        self._conclude()
        recipe_exit = proc.returncode if proc.returncode >= 0 else 128 - proc.returncode
        self.record["recipe"] = {"pid": proc.pid, "exit": recipe_exit, "owned_seen": sorted(self.tracker.tracked),
                                 "launchd_labels_seen": sorted(self.tracker.labels)}
        vm = self._vm_postconditions(vz_before) if not self.profile["lease"] else None
        if stop is not None and stop[0] != "leftover":
            kind, code, reason = stop
            if vm and vm.get("incomplete"):
                return EXIT_ERROR, "{}; VM cleanup incomplete: {}".format(reason, vm["incomplete"])
            return code, reason
        self.record["states"]["executed"] = True
        if vm and vm.get("incomplete"):
            return EXIT_ERROR, "recipe exited {}; VM cleanup incomplete: {}".format(recipe_exit, vm["incomplete"])
        problems = results.validate(self.plan, self.plan_digest, self.out, started_wall, recipe_exit)
        self.record["evidence_problems"] = problems
        if recipe_exit != 0:
            return recipe_exit, "recipe exited {}{}".format(recipe_exit, "; evidence: " + "; ".join(problems)
                                                           if problems else "")
        if problems:
            return EXIT_EVIDENCE, "recipe exited 0 but its evidence was rejected: " + "; ".join(problems)
        self.record["states"]["validated"] = True
        return 0, "recipe exited 0 and its evidence matches this job"

    def _runner_gone(self):
        return self.runner is not None and recovery.same_process(self.probes, self.runner) is False

    def _ping_custody(self, now):
        if now - getattr(self, "custody_pinged", 0) < CUSTODY_PING_S:
            return
        self.custody_pinged = now
        try:
            self.custody.must({"op": "status"})  # re-adopts a restarted owner
        except recovery.CustodyError as ex:
            self.log("recovery owner unavailable: {}".format(ex))

    def _watch(self, proc):
        """Run until the recipe and everything it owns are gone. Returns None, or (kind, code, reason) of a stop."""
        start = last_full = time.monotonic()
        stop = None
        while True:
            now = time.monotonic()
            if self._runner_gone():
                self._request_cancel("the queue runner {} died".format(self.runner), EXIT_CANCELLED)
            self._ping_custody(now)
            leader_done = os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
            full = leader_done or now - last_full >= FULL_SCAN_EVERY
            if full:
                last_full = now
            try:
                owned = self.tracker.owned(full=full)
                labels = self.tracker.live_labels() if leader_done else []
            except OSError as ex:
                self.log("process or launchd probe failed: {}".format(ex))
                owned, labels = None, None
            if leader_done and owned == {} and labels == []:
                return stop
            owned = owned or {}
            if stop is None:
                if self.cancel.is_set():
                    stop = ("cancel", self.cancel_code, self.cancel_reason)
                elif now - start >= self.profile["exec_s"]:
                    stop = ("timeout", EXIT_TIMEOUT, "execution limit of {:.0f} s reached".format(self.profile["exec_s"]))
                elif leader_done:
                    stop = ("leftover", None, "recipe exited; stopping what it left running")
                if stop is not None:
                    self.log("stopping: {}".format(stop[2]), owned=sorted(owned))
                    return self._finish_stop(stop, owned)
            self._renew_if_due()
            time.sleep(POLL)

    def _finish_stop(self, stop, owned):
        self._stop_all(stop[2], owned)
        return stop

    def _is_rig_run(self, pid):
        argv = self.tracker.argv_seen.get(pid) or []
        return len(argv) >= 2 and argv[0] == "/bin/bash" and argv[1] == self.paths["rig_run"]

    def _wait_gone(self, pids, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self._renew_if_due()
            if not any(procs.alive(self.probes, p) for p in pids):
                return True
            time.sleep(POLL)
        return False

    def _stop_all(self, why, owned=None):
        """SIGTERM and bootout, the grace, then SIGKILL every second until nothing owned is left, or until a further
        minute has passed: what is left then is the quarantine's (see _conclude), which keeps everything held.

        A rig-run is asked first and alone, as rig-stop and mem-guard do: its trap stops the VM, deletes
        the clone and releases its leases. Then the recipe gets the same grace to finish by itself (R2's
        feeder leak-scans the copied-back run), and only then is everything else signalled.
        """
        if owned is None:
            try:
                owned = self.tracker.owned(full=True)
            except OSError:
                owned = {}
        grace = self.profile["term_grace_s"]
        rig = [p for p in owned if self._is_rig_run(p)]
        if rig:
            sent = self.tracker.signal_all(signal.SIGTERM, rig)
            self.log("SIGTERM sent to rig-run first", pids=sent)
            self._wait_gone(rig, grace)
            self._wait_gone(sorted(self.tracker.leaders), grace)
            owned = self.tracker.owned(full=True)
        sent = self.tracker.signal_all(signal.SIGTERM, owned)
        try:
            labels = self.tracker.bootout_all()
        except OSError:
            labels = None
        self.log("SIGTERM sent", pids=sent, launchd_bootout=labels)
        term_at = time.monotonic()
        killed_logged = 0.0
        while True:
            self._renew_if_due()
            try:
                owned = self.tracker.owned(full=True)
                labels = self.tracker.live_labels()
            except OSError as ex:
                # Unknown is not empty: keep escalating against what is known, and let the time limit hand
                # the rest to the quarantine.
                self.log("process or launchd probe failed: {}".format(ex))
                owned, labels = self.tracker.found_last or {}, ["(unknown)"]
            else:
                self.tracker.found_last = owned
            leaders_alive = [p for p in self.tracker.leaders if procs.alive(self.probes, p)]
            if not owned and not labels and not leaders_alive:
                self.log("nothing owned is left")
                return
            if time.monotonic() - term_at >= self.profile["term_grace_s"] + QUARANTINE_AFTER_S:
                self.log("still present, or unknown, after SIGKILL", pids=sorted(owned), launchd=labels)
                return
            if time.monotonic() - term_at >= self.profile["term_grace_s"]:
                sent = self.tracker.signal_all(signal.SIGKILL, owned)
                try:
                    labels = self.tracker.bootout_all()
                except OSError:
                    labels = None
                if time.monotonic() - killed_logged >= 30:
                    killed_logged = time.monotonic()
                    self.log("SIGKILL sent", pids=sent, launchd_bootout=labels)
                time.sleep(KILL_EVERY)
            else:
                time.sleep(POLL)

    # VM jobs: rig-run owns the clone and its leases; check they are gone, or recover them.

    def _vz_pids(self):
        found = []
        for pid in self.probes.all_pids():
            got = self.probes.procargs(pid)
            if got and got[0] and VZ_PATTERN in got[0][0]:
                found.append(pid)
        return found

    def _vm_leftovers(self, rig_pids):
        clones = [os.path.join(self.paths["lume_clones"], "rig-run-{}".format(p)) for p in rig_pids]
        clones = [c for c in clones if os.path.exists(c)]
        status = self._lease_cmd("status").stdout
        leases = []
        for line in status.splitlines():
            if line.startswith("{"):
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if rec.get("ownerPid") in rig_pids:
                    leases.append(rec.get("id"))
        return clones, leases

    def _vm_postconditions(self, vz_before):
        rig_pids = sorted(pid for pid, argv in self.tracker.argv_seen.items()
                          if len(argv) >= 2 and argv[0] == "/bin/bash" and argv[1] == self.paths["rig_run"])
        report = {"rig_run_pids": rig_pids}
        self.record["vm"] = report
        if not rig_pids:
            return report
        clones, leases = self._vm_leftovers(rig_pids)
        report.update(clones_after_stop=clones, leases_after_stop=leases)
        for attempt in range(3):
            if not clones and not leases:
                break
            # Every rig-run pid is gone by now, so these are orphans: rig-stop stops the VM, deletes the
            # clone and releases the leases; lr-reap removes leases of a dead owner.
            done = subprocess.run([self.paths["rig_stop"], "--orphans", "--grace", "15"], stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)
            subprocess.run([self.paths["lr_reap"], "--run", "rig"], stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            report.setdefault("rig_stop", []).append({"exit": done.returncode, "output": done.stdout[-2000:]})
            clones, leases = self._vm_leftovers(rig_pids)
        # The VM's Virtualization service is launchd's child, not ours, so it is only waited for, never signalled.
        deadline = time.monotonic() + 30
        vz_left = [p for p in self._vz_pids() if p not in vz_before]
        while vz_left and time.monotonic() < deadline:
            time.sleep(1)
            vz_left = [p for p in self._vz_pids() if p not in vz_before]
        report.update(clones_left=clones, leases_left=leases, virtualization_left=vz_left)
        incomplete = []
        if clones:
            incomplete.append("clone directories {}".format(clones))
        if leases:
            incomplete.append("leases {}".format(leases))
        if vz_left:
            incomplete.append("Virtualization processes {} started during the job".format(vz_left))
        if incomplete:
            report["incomplete"] = "; ".join(incomplete)
        self.log("VM postconditions", **report)
        return report

    # Conclusion: release only on a fresh, complete ABSENT

    def _inventory(self):
        """{resource: [state, detail]} from the recovery owner, plus this supervisor's own scan."""
        try:
            results = self.custody.must({"op": "inventory"})["results"]
        except recovery.CustodyError as ex:
            results = {"recovery-owner": [procs.UNKNOWN, str(ex)]}
        try:
            owned = self.tracker.owned(full=True)
            labels = self.tracker.live_labels()
        except OSError as ex:
            results["supervisor-scan"] = [procs.UNKNOWN, "probe failed: {}".format(ex)]
        else:
            if owned or labels:
                results["supervisor-scan"] = [procs.PRESENT, "pids {} launchd {}".format(sorted(owned), labels)]
        return results

    def _conclude(self):
        """Settle the lease and release custody once every resource is ABSENT; until then, QUARANTINED."""
        quarantined_at = None
        while True:
            results = self._inventory()
            if all(state == procs.ABSENT for state, _ in results.values()):
                recovery.test_point(self.plan, "supervisor:before-settle")
                lease = recovery.settle_lease(self.paths["lr_lease"], {"id": self.lease_id, "cleanup": self.lease_cleanup}
                                              if self.lease_id else None, self.token, self.attempt)
                recovery.test_point(self.plan, "supervisor:after-settle")
                if lease[0] == procs.ABSENT:
                    self.lease_id = None
                    try:
                        self.custody.must({"op": "clean"})
                    except recovery.CustodyError as ex:
                        results["recovery-owner"] = [procs.UNKNOWN, str(ex)]
                    else:
                        self.custody.finish()
                        self.concluded = True
                        self.record["inventory"] = results
                        self.record["cleanup"] = "clean"
                        self.log("inventory ABSENT; lease settled; the recovery owner released its copies")
                        return
                else:
                    results["lease"] = list(lease)
            if quarantined_at is None:
                quarantined_at = time.monotonic()
                self.record["cleanup"] = "quarantined"
                self.record["quarantine"] = results
                self._write_outcome()
                self.log("QUARANTINED", results=results)
                try:
                    self.custody.must({"op": "quarantine", "results": results})
                except recovery.CustodyError as ex:
                    self.log("could not tell the recovery owner: {}".format(ex))
            try:
                self.tracker.signal_all(signal.SIGKILL, self.tracker.owned(full=True))
                self.tracker.bootout_all()
            except OSError:
                pass
            self._renew_if_due()
            elapsed = time.monotonic() - quarantined_at
            time.sleep(QUARANTINE_RETRY[0] if elapsed < 60 else QUARANTINE_RETRY[1])

    def _release(self):
        """Before anything was launched (or after a confirmed clean): heavy.lock, then the lease."""
        if self.lock_fd is not None:
            os.close(self.lock_fd)  # heavy.lock first, so a job admitted by the lease never finds it taken
            self.lock_fd = None
        if self.lease_id:
            state, detail = recovery.settle_lease(self.paths["lr_lease"], {"id": self.lease_id,
                                                  "cleanup": self.lease_cleanup}, self.token, self.attempt)
            if state != procs.ABSENT:
                self.log("lease settlement not confirmed: {}".format(detail))
            self.lease_id = None

    def _write_json(self, name, obj):
        if not os.path.isdir(self.run_root):
            return
        path = os.path.join(self.run_root, name)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, indent=1, default=str)
        os.replace(tmp, path)

    def _write_outcome(self):
        try:
            self._write_json("outcome.json", self.record)
        except OSError:
            traceback.print_exc()

    def _send_status(self, code):
        try:
            os.write(self.status_fd, json.dumps({"exit": code}).encode())
        except OSError:
            pass  # the relay is gone; the queue already settled the job from its side
        finally:
            os.close(self.status_fd)
