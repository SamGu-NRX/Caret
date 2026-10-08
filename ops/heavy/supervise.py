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
import hashlib
import json
import os
import pwd
import secrets
import shutil
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
# The profile's memory cap (mem_cap_gib): exceeding it stops the job with this code, after this short grace (a job
# still growing must not get the profile's full grace), and the footprint series is written this often.
EXIT_MEMORY_CAP = 76
# A browser-lane job (lr-lease's browser kind: headless only) whose process owns an on-screen window.
EXIT_WINDOW = 77
MEMORY_CAP_GRACE_S = 2.0
MEMORY_SERIES_EVERY = 5.0
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
        parser.add_argument("--slot-path", help="the slot lock the relay found the descriptor for (lane_slot_lock)")
        args = parser.parse_args(argv[1:])
        return Supervisor(plan_path, plan_digest, plan, args.slot_fd, args.life_fd, args.status_fd,
                          heavy_fd=args.heavy_fd, runner=[args.runner_pid, args.runner_start],
                          slot_path=args.slot_path).run()
    say("boot", "expected relay or supervise, got {}".format(argv[:1]))
    return 2


# Relay: the queue's process group


def lane_slot_lock(plan, env):
    """The slot lock this job holds, from the queue. A queue with lanes sets HEAVY_JOB_QUEUE_LEASE_KIND and
    HEAVY_JOB_QUEUE_SLOT_LOCK together: the kind must be the plan's lane, and the path one of that lane's slot locks in
    the queue's state directory (procs.slot_lock_problem). An older queue sets neither and runs only the heavy lane,
    with the plan's slot.lock. One without the other is refused rather than guessed from. Raises procs.Refusal."""
    lane = plan.get("lane", "heavy")
    kind = env.get("HEAVY_JOB_QUEUE_LEASE_KIND")
    path = env.get("HEAVY_JOB_QUEUE_SLOT_LOCK")
    if (kind is None) != (path is None):
        raise procs.Refusal("HEAVY_JOB_QUEUE_LEASE_KIND and HEAVY_JOB_QUEUE_SLOT_LOCK come together from a queue with "
                            "lanes, but only {} is set".format("HEAVY_JOB_QUEUE_LEASE_KIND" if path is None
                                                                else "HEAVY_JOB_QUEUE_SLOT_LOCK"))
    if kind is None:
        if lane != "heavy":
            raise procs.Refusal("an older queue without lanes cannot run a {}-lane job".format(lane))
        return plan["paths"]["slot_lock"]
    if kind != lane:
        raise procs.Refusal("HEAVY_JOB_QUEUE_LEASE_KIND is {}, but this job's plan is for the {} lane".format(kind, lane))
    problem = procs.slot_lock_problem(path, plan["paths"]["queue_state"], lane)
    if problem:
        raise procs.Refusal("HEAVY_JOB_QUEUE_SLOT_LOCK: {}".format(problem))
    return path


def relay(plan_path, plan_digest, plan):
    import caret_heavy  # from the same verified snapshot
    try:
        slot_path = lane_slot_lock(plan, os.environ)
        slot_fd = procs.inherited_lock_fd(slot_path)
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
                                 "--runner-pid", str(runner[0]), "--runner-start", str(runner[1]),
                                 "--slot-path", slot_path)
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
        status = json.loads(data)
        code = int(status["exit"])
    except (ValueError, KeyError, TypeError):
        say("relay", "the supervisor ended without a status (exit {})".format(proc.returncode))
        say("relay", await_recovery(plan))
        return EXIT_ERROR
    if status.get("cleanup") == HANDED_OVER:
        # The supervisor left an unconfirmed cleanup to the recovery owner: the queue's lease stays until CLEAN.
        say("relay", await_recovery(plan))
    if forwarded:
        say("relay", "forwarded signal {}; supervisor finished cleanup".format(forwarded[0]))
    return code


# The run name heavy-job-queue gives the lease it takes for each job (its _acquire_lease), used when the queue does not
# pass HEAVY_JOB_QUEUE_LEASE_RUN (before ac3e70c). oblige checks it, so a wrong lease ID cannot make another run's lease
# cleanup-required.
QUEUE_LEASE_RUN = "heavy-job-queue"

# lr-lease's own vm decision, read-only: no lease is taken. It runs the lr-lease-core.mjs beside the lr-lease the plan
# names, with the readers, leases, snapshot and decision() its `status` uses, on the lease-policy.json recorded at
# enqueue, for kind vm and the profile's estimates. Before decision() the leases are put in the state reap() would
# leave them in, by reap()'s own test (not exported by lr-lease-core, so mirrored here): a lease rig-run's own
# `lr-reap --run rig` removes first (run "rig", not quarantined, not cleanup-required, owner dead or its pid reused) is
# left out, and a cleanup-required lease whose owner is dead or reused counts as quarantined, which blocks its kind.
# reap()'s complete source, with its START_TOLERANCE_MS line, must hash to a pinned digest, so any change to the test
# mirrored here is "admission unknown". A missing export or another arity fails loudly too (exit 3).
REAP_SOURCE_SHA256 = (
    # ~/.long-run/bin/lr-lease-core.mjs as installed 2026-10-07, before and after the stop-target patch (installed
    # 22:17Z, vendored in ops/heavy/vendor/long-run): that patch leaves reap() and START_TOLERANCE_MS byte for byte.
    "bcab31fcaeb7e954572248320bc88bdf4b6d05ce3a5003d0d6daf9c5ae51f1c9",
)
VM_CHECK_JS = r"""
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [core, root, policyFile, mem, disk, pinned] = process.argv.slice(1);
const fail = (why) => { console.log(JSON.stringify({ error: why })); process.exit(3); };
const m = await import(pathToFileURL(core).href);
const arity = { machineReaders: 1, readPolicy: 1, readLeases: 1, snapshot: 1, decision: 6 };
for (const [name, n] of Object.entries(arity)) {
  if (typeof m[name] !== 'function' || m[name].length !== n) fail(`lr-lease-core.mjs: ${name} is not a function of ${n} arguments`);
}
const src = readFileSync(core, 'utf8');
const tolerance = /^const START_TOLERANCE_MS = (\d+);$/m.exec(src);
const start = src.indexOf('\nexport function reap(');
const end = start < 0 ? -1 : src.indexOf('\n}\n', start + 1);
if (!tolerance || start < 0 || end < 0) fail("lr-lease-core.mjs: no reap() or START_TOLERANCE_MS to check");
const digest = createHash('sha256').update(tolerance[0] + '\n' + src.slice(start + 1, end + 2)).digest('hex');
if (!pinned.split(',').includes(digest)) fail(`lr-lease-core.mjs: reap() is not a pinned version (sha256 ${digest}), so its owner test cannot be mirrored`);
const readers = m.machineReaders(root);
if (typeof readers.pidAlive !== 'function' || typeof readers.pidStartedAt !== 'function') fail('lr-lease-core.mjs: readers lack pidAlive or pidStartedAt');
const policy = m.readPolicy(policyFile);
const leases = m.readLeases(path.join(root, 'leases'));
const readings = m.snapshot(readers);
const ownerGone = (l) => {
  if (!readers.pidAlive(l.ownerPid)) return true;
  const started = readers.pidStartedAt(l.ownerPid);
  return started !== null && started > l.createdAt + Number(tolerance[1]);
};
const removedFirst = (l) => l.run === 'rig' && l.state !== 'quarantined' && !l.cleanupRequired && ownerGone(l);
const excluded = leases.filter(removedFirst).map((l) => l.id);
const asReaped = leases.filter((l) => !excluded.includes(l.id))
  .map((l) => (l.cleanupRequired && l.state !== 'quarantined' && ownerGone(l) ? { ...l, state: 'quarantined' } : l));
const reason = m.decision('vm', Number(mem), Number(disk), asReaped, policy, readings);
console.log(JSON.stringify({ grant: !reason, reason: reason || null, excluded }));
"""
POLICY_CHANGED = "lease-policy.json changed since enqueue; re-enqueue"


def _file_sha256(path):
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        return None


def vm_check(lr_lease, profile, admission, env=None, timeout=60):
    """None when lr-lease's vm decision would grant the profile's estimates now, on the lease-policy.json the plan
    recorded at enqueue, else why not, without taking any lease (VM_CHECK_JS). A policy file whose digest is no longer
    the recorded one refuses (POLICY_CHANGED); a timeout or any failure is an explicit "admission unknown" refusal,
    never an exception."""
    if not isinstance(admission, dict) or not admission.get("source") or not admission.get("policy_sha256"):
        return "admission unknown: the plan records no lease-policy.json and digest; re-enqueue"
    policy = admission["source"]
    if _file_sha256(policy) != admission["policy_sha256"]:
        return POLICY_CHANGED
    env = dict(os.environ if env is None else env)
    node = shutil.which("node", path=env.get("PATH", "") + ":/opt/homebrew/bin:/usr/local/bin")
    core = os.path.join(os.path.dirname(lr_lease), "lr-lease-core.mjs")
    root = os.path.join(env.get("HOME", os.path.expanduser("~")), ".long-run")
    if node is None:
        return "admission unknown: no node to run lr-lease's vm decision"
    try:
        got = subprocess.run([node, "--input-type=module", "-e", VM_CHECK_JS, core, root, policy,
                              str(profile["est_mem_gib"]), str(profile["est_disk_gib"]), ",".join(REAP_SOURCE_SHA256)],
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                             env=env, timeout=timeout)
        answer = json.loads(got.stdout.strip().splitlines()[-1]) if got.stdout.strip() else {}
    except subprocess.TimeoutExpired:
        return "admission unknown: lr-lease's vm decision did not answer within {} s".format(timeout)
    except (OSError, ValueError) as ex:
        return "admission unknown: lr-lease's vm decision failed: {!r}".format(ex)
    if _file_sha256(policy) != admission["policy_sha256"]:
        return POLICY_CHANGED  # changed while it was being read
    if got.returncode != 0 or "grant" not in answer:
        return "admission unknown: lr-lease's vm decision exited {}: {}".format(
            got.returncode, answer.get("error") or got.stdout.strip()[-300:])
    if answer["grant"]:
        return None
    return "lr-lease would not grant vm ({} + {} GiB): {}".format(profile["est_mem_gib"], profile["est_disk_gib"],
                                                                answer["reason"])


# outcome.json's "cleanup" when the supervisor left before the cleanup was confirmed; also sent to the relay.
HANDED_OVER = "left to the recovery owner"


def await_recovery(plan, poll=1.0):
    """After a supervisor died without a status: wait until its recovery owner journals CLEAN, and say why the wait
    ended. A queue that leases per job releases the lease once this relay's process group is empty, so the relay stays
    while the owner may still be cleaning up. A journal without an adoption means the supervisor died before custody
    held anything, and custody comes before the lease and the workload. A quarantine is waited out like any other
    unfinished cleanup; the queue's own timeout is what ends that wait."""
    journal = recovery.Journal(os.path.join(plan["run_root"], "recovery", "journal.ndjson"))
    said = None
    while True:
        try:
            events = [r.get("event") for r in journal.load()]
        except (recovery.JournalCorrupt, OSError) as ex:
            events, why = None, "the recovery journal is unreadable ({}); waiting".format(ex)
        else:
            if "adopted" not in events:
                return "no recovery owner ever held this job; nothing to wait for"
            if "clean" in events:
                return "the recovery owner journalled CLEAN"
            why = "waiting for the recovery owner to journal CLEAN ({})".format(
                "quarantined" if "quarantined" in events else "cleaning up")
        if why != said:
            say("relay", why)
            said = why
        time.sleep(poll)


# Supervisor: its own session


class Supervisor:
    def __init__(self, plan_path, plan_digest, plan, slot_fd, life_fd, status_fd, probes=None, heavy_fd=None,
                 runner=None, slot_path=None):
        self.plan_path, self.plan_digest, self.plan = plan_path, plan_digest, plan
        # The slot lock the queue gave this job: its lane's, named by the queue, or the plan's slot.lock on an older one.
        self.slot_path = slot_path or plan["paths"]["slot_lock"]
        self.lane = plan.get("lane", "heavy")
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
        self.vz_before = set()
        self.lease_cleanup = self._lease_supports("--cleanup-token-sha256")
        # Whether lr-lease can make the queue's lease cleanup-required (`oblige`, the vendored version, pending install).
        self.lease_oblige = self.lease_cleanup and self._lease_supports("verb === 'oblige' && rest.length === 7")
        self.lease_obliged = False
        self.record = {"job_id": plan["job_id"], "plan": plan_path, "plan_sha256": plan_digest,
                       "supervisor_pid": self.pid, "mark": self.mark, "launchd_prefix": self.launchd_prefix,
                       "started_utc": utc_now(), "events": [], "states": {"executed": False, "validated": False,
                                                                          "accepted_by_lead": None}}

    def log(self, message, **fields):
        say("supervisor", message)
        self.record["events"].append(dict({"at": utc_now(), "event": message}, **fields))

    # Entry

    def _hand_over(self):
        """True once the recovery owner confirms it holds every lock this process holds and the token. Until then this
        process keeps its own copies and keeps cleaning; if it finishes the cleanup itself, it returns False with
        self.concluded set."""
        need = {"slot"} | ({"heavy"} if self._held_heavy_fd() is not None else set())
        terminating_since = None
        while True:
            try:
                reply = self.custody.must({"op": "status"})  # re-adopts, and restarts a missing owner
                if reply.get("terminating"):
                    # Being booted out: its SIGKILL follows within launchd's exit timeout. Wait for the replacement.
                    terminating_since = terminating_since or time.monotonic()
                    if time.monotonic() - terminating_since < 120:
                        time.sleep(1)
                        continue
                elif need <= set(reply.get("locks", [])) and reply.get("token"):
                    self.log("the recovery owner holds {} and the token; leaving the cleanup to it".format(sorted(need)))
                    return True
                else:
                    terminating_since = None
                self.log("the recovery owner does not confirm custody: {}".format(reply))
            except recovery.CustodyError as ex:
                self.log("no confirmed recovery owner ({}); cleaning up here".format(ex))
            try:
                if self.tracker is not None:
                    self._stop_all("supervisor error")
                self._conclude()
                return False
            except Exception as ex:  # noqa: BLE001 - keep holding, and try again
                self.log("cleanup attempt failed: {!r}".format(ex))
            time.sleep(QUARANTINE_RETRY[1])

    def _lease_supports(self, feature):
        """Whether this lr-lease's CLI source has *feature* (the vendored version's cleanup-required leases)."""
        try:
            with open(os.path.join(os.path.dirname(self.paths["lr_lease"]), "lr-lease-cli.mjs"), encoding="utf-8") as fh:
                return feature in fh.read()
        except OSError:
            return False

    def run(self):
        code, reason = EXIT_ERROR, "supervisor error"
        try:
            # The slot must be the queue's, held through this exact open file: a lane's slot lock is re-checked to be
            # the regular file in the queue's state directory, and the descriptor bound to its (st_dev, st_ino).
            identity = None
            if self.slot_path != self.plan["paths"]["slot_lock"]:
                identity = procs.slot_lock_identity(self.slot_path, self.plan["paths"]["queue_state"], self.lane)
            procs.inherited_lock_fd(self.slot_path, self.slot_fd, identity)
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
            # Something was started and its absence is not confirmed: leave only once the recovery owner is confirmed
            # to hold every lock this process holds, and the token. _hand_over cleans up here until then.
            if self.launched and not self.concluded and self._hand_over():
                reason += "; cleanup left to the recovery owner {}".format(self.custody.label)
                self.record["cleanup"] = HANDED_OVER
            else:  # nothing was started, or this process confirmed the clean itself
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
                                        self.probes, self.log, slot_path=self.slot_path)
        self.record.update(lane=self.lane, slot_lock=self.slot_path)
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

    def _admission_lost(self):
        """Why a just-made admission no longer holds (HOLD, cancellation, the runner's death), or None. Checked after the
        admission checks and again immediately before the workload is released."""
        if os.path.lexists(self.paths["hold"]):
            return "HOLD {} appeared".format(self.paths["hold"])
        if self.cancel.is_set():
            return "cancelled: {}".format(self.cancel_reason)
        if self._runner_gone():
            return "the queue runner {} died".format(self.runner)
        return None

    def _admit(self):
        deadline = time.monotonic() + self.profile["lease_wait_s"]
        delay, last = 2.0, None
        while True:
            if self.cancel.is_set():
                return self.cancel_code, "cancelled before start: {}".format(self.cancel_reason)
            if self._runner_gone():
                return EXIT_CANCELLED, "the queue runner {} died before admission".format(self.runner)
            why = self._try_admit()
            if why is None and self.profile["lease_wait_s"] > 0 and time.monotonic() > deadline:
                self._release()
                why = "admitted only after the lease wait of {:.0f} s ran out".format(self.profile["lease_wait_s"])
            if why is None:
                return True
            if self.cancel.is_set():
                return self.cancel_code, "cancelled before start: {}".format(self.cancel_reason)
            if self._runner_gone():
                return EXIT_CANCELLED, "the queue runner {} died during admission".format(self.runner)
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
            got = self._acquire_lease()
            if got.returncode != 0:
                return "{} lease: {}".format(self.lane, got.stdout.strip() or got.returncode)
            self.lease_id = got.stdout.strip()
            self.lease_renewed = time.monotonic()
            recovery.test_point(self.plan, "supervisor:after-lease-acquire")
        if self.profile["lease"] and self.lane != "browser":  # a browser-lane job never takes heavy.lock
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
        if problem is None and self.profile.get("admit_kind") == "vm":
            problem = vm_check(self.paths["lr_lease"], self.profile, self.plan.get("admission"))
        if problem is None:
            problem = self._admission_lost()
        if problem:
            self._release()
            return problem
        if self.queue_lease and not self.profile["lease"] and not self.lease_oblige:
            raise procs.Refusal("a VM job under the queue's lease needs an lr-lease with oblige, so the lease rig-run is "
                                "handed outlives the queue's release until this attempt's cleanup is confirmed")
        if self.queue_lease and self.lease_oblige:
            # The queue releases its lease once the relay's group is empty, which its SIGKILL of the relay after 10 s
            # makes true while cleanup may still run. Obliged, that release quarantines the lease instead, until this
            # attempt's token acknowledges the clean (the vendored lr-lease; with the live one, _hold_reservation).
            got = self._lease_cmd("oblige", self.queue_lease, "--run", self._queue_lease_run(), "--attempt", self.attempt,
                                  "--cleanup-token-sha256", recovery.token_sha256(self.token))
            if got.returncode != 0:
                self._release()
                return "obliging the queue's lease {}: {}".format(self.queue_lease, got.stdout.strip()[:200])
            self.lease_id, self.lease_obliged, self.lease_renewed = self.queue_lease, True, time.monotonic()
            recovery.test_point(self.plan, "supervisor:after-oblige")
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
        self.record["lease"] = {"id": self.lease_id, "cleanup_required": self.lease_cleanup,
                                "obliged": self.lease_obliged, "renewals": 0,
                                "renew_failures": [], "queue_lease": self.queue_lease}
        return None

    def _queue_lease_run(self):
        """The run name to oblige the queue's lease with. A queue from ac3e70c on passes HEAVY_JOB_QUEUE_LEASE_RUN, which
        is used, and must be the lease record's own run: a disagreement refuses rather than oblige the wrong lease. An
        older queue passes nothing, and names every lease QUEUE_LEASE_RUN."""
        named = os.environ.get("HEAVY_JOB_QUEUE_LEASE_RUN")
        if not named:
            return QUEUE_LEASE_RUN
        try:
            record = next((r for r in procs.lease_records(self.paths["lr_lease"]) if r["id"] == self.queue_lease), None)
        except OSError as ex:
            raise procs.Refusal("cannot read the queue's lease {} to check HEAVY_JOB_QUEUE_LEASE_RUN: {}".format(
                self.queue_lease, ex)) from None
        if record is None:
            raise procs.Refusal("the queue's lease {} is not listed by lr-lease".format(self.queue_lease))
        if record.get("run") != named:
            raise procs.Refusal("HEAVY_JOB_QUEUE_LEASE_RUN is {} but the queue's lease {} is run {}".format(
                named, self.queue_lease, record.get("run")))
        return named

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

    def _acquire_lease(self):
        """lr-lease acquire for this job, owned by this supervisor, of its lane's kind (heavy, or browser for a
        browser-lane job: lr-lease's browser kind, the one the queue's browser runners take)."""
        cleanup = ["--cleanup-attempt", self.attempt, "--cleanup-token-sha256",
                   recovery.token_sha256(self.token)] if self.lease_cleanup else []
        return self._lease_cmd("acquire", "--run", self.plan["lease"]["run"], "--kind", self.lane,
                               "--est-mem", str(self.profile["est_mem_gib"]), "--est-disk", str(self.profile["est_disk_gib"]),
                               "--ttl", str(self.plan["lease"]["ttl_min"]), "--owner-pid", str(self.pid), *cleanup)

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
        got = self._acquire_lease()
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
        if self.lease_obliged:
            # The queue's runner owns this lease; this attempt renews it by its token, until the queue releases it
            # (then it is quarantined, which keeps it without renewal).
            got = subprocess.run([self.paths["lr_lease"], "renew", self.lease_id, "--attempt", self.attempt,
                                  "--ttl", str(self.plan["lease"]["ttl_min"])], input=self.token + "\n",
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            if "is quarantined" in got.stdout:
                return
        else:
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
            if self.lease_obliged:
                # The queue's lease, obliged to this attempt, is the job's one heavy lease: rig-run uses it instead of
                # taking its own (heavy maxCount 1). Managed mode: rig-run registers its VM with the recovery owner
                # before cloning and takes its vm lease cleanup-required for this attempt, leaving its settlement to
                # this job's custody. The token's digest is not a secret; the token never leaves custody.
                env.update(RIG_HEAVY_LEASE_ID=self.lease_id, RIG_RUN_MANAGED="1", CARET_HEAVY_ATTEMPT=self.attempt,
                           CARET_HEAVY_TOKEN_SHA256=recovery.token_sha256(self.token))
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
        # Referenced until this process exits: a Popen dropped while its child is unreaped (an exception unwinding
        # this frame) is reaped by the next Popen anywhere, which would free the leader's pid while the job is held.
        self.recipe_proc = proc
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
                lost = self._admission_lost()
                if lost is not None and not self.cancel.is_set():
                    # Denied for good; the watch loop stops what was started (only the held trampoline).
                    self._request_cancel("not released: " + lost, EXIT_CANCELLED if "runner" in lost else EXIT_NOT_ADMITTED)
                if not self.cancel.is_set():
                    os.write(go_w, b"G")
                    released = True
        except recovery.CustodyError as ex:
            self.log("the recipe was not registered, so it is never released: {}".format(ex))
        finally:
            os.close(go_w)
        if released:
            recovery.test_point(self.plan, "supervisor:after-release")
            if (self.plan.get("test") or {}).get("bootout_owner"):
                procs.launchd_bootout(self.custody.label)  # tests only: the recovery owner is gone
            recovery.test_raise(self.plan, "supervisor:after-release")
            self.log("recipe started", pid=proc.pid, pgid=proc.pid)
        else:
            self.log("recipe never released", pid=proc.pid)
            self._request_cancel(self.cancel_reason or "the recipe could not be registered", self.cancel_code or EXIT_ERROR)
        stop = self._watch(proc)
        # The leader stays unreaped until the conclusion: as a zombie it keeps its pid, so neither that pid nor its
        # process group's id can be reissued to an unrelated process while a quarantine is still stopping things.
        status = os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOWAIT)
        recipe_exit = status.si_status if status.si_code == os.CLD_EXITED else 128 + status.si_status
        self.record["recipe"] = {"pid": proc.pid, "exit": recipe_exit, "owned_seen": sorted(self.tracker.tracked),
                                 "launchd_labels_seen": sorted(self.tracker.labels)}
        # VM jobs: rig-run's clone, leases and Virtualization processes are part of the inventory that gates the
        # release, so their recovery comes first and anything left keeps the job quarantined.
        self.vz_before = vz_before
        vm = self._vm_postconditions(vz_before) if not self.profile["lease"] else None
        self._conclude()
        proc.wait()  # reaped only now
        if vm and vm.get("incomplete"):
            vm["cleared_in_quarantine"] = True
        if stop is not None and stop[0] != "leftover":
            kind, code, reason = stop
            return code, reason
        self.record["states"]["executed"] = True
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
            recovery.test_raise(self.plan, "supervisor:watching")
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
                if self.lane == "browser" and stop is None:
                    # The completion return is a window check too: nothing is left to stop, but a window list that
                    # cannot be read here is the same missing evidence as during the run.
                    window = self._window_stop(self.tracker.tracked)
                    if window is not None:
                        self.log("stopping: {}".format(window[2]))
                        return window
                return stop
            if owned is None and full and self.lane == "browser" and stop is None:
                # A failed process probe is unknown ownership. Read as nothing owned, it would also read as no window.
                unknown = ("window", EXIT_WINDOW, "this browser-lane job's processes cannot be listed, so whether one "
                           "owns an on-screen window is unknown")
                self.log("stopping: {}".format(unknown[2]))
                return self._finish_stop(unknown, None)
            owned = owned or {}
            # Sampled first, so a scan that stops for a window still records the job's memory, and a job over its cap
            # as well keeps the cap's short grace.
            memory_stop = self._sample_memory(owned, start)
            if full and self.lane == "browser" and stop is None:
                window = self._window_stop(owned)
                if window is not None:
                    if memory_stop is not None:
                        window = self._both_stops(window, memory_stop)
                    self.log("stopping: {}".format(window[2]), owned=sorted(owned))
                    return self._finish_stop(window, owned)
            if stop is None:
                if memory_stop is not None:
                    stop = memory_stop
                elif self.cancel.is_set():
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

    def _both_stops(self, window, memory):
        """One stop for a scan where a browser-lane job owns a window and is over its memory cap. It exits 77, the
        lane's own violation, which no rerun with more memory fixes; it takes the cap's short grace, because a job
        still growing must not get the profile's full one; and outcome.json keeps both reasons."""
        self.record["stop_reasons"] = [{"kind": k, "exit": c, "reason": r} for k, c, r in (window, memory)]
        return ("window+memory", window[1], "{}; and {}".format(window[2], memory[2]))

    def _finish_stop(self, stop, owned):
        short = "memory" in stop[0].split("+")
        self._stop_all(stop[2], owned, grace=MEMORY_CAP_GRACE_S if short else None)
        return stop

    def _window_owners(self):
        """Pids owning an on-screen window. Tests only: plan["test"]["window_owners_file"] lists them instead."""
        fake = (self.plan.get("test") or {}).get("window_owners_file")
        if fake:
            try:
                with open(fake, encoding="utf-8") as fh:
                    return {int(x) for x in fh.read().split()}
            except FileNotFoundError:
                return set()
        return self.probes.window_owner_pids()

    def _window_stop(self, owned):
        """A stop when a process of this browser-lane job owns an on-screen window, or when the window list cannot be
        read (the evidence the lane needs would be missing): lr-lease's browser kind is for headless batches only."""
        try:
            windowed = sorted(self._window_owners() & set(owned))
        except OSError as ex:
            return ("window", EXIT_WINDOW, "the on-screen window list cannot be read for this browser-lane job: {}".format(ex))
        if windowed:
            return ("window", EXIT_WINDOW, "process(es) {} of this browser-lane job own an on-screen window; the "
                    "browser lane is for headless batches only".format(windowed))
        return None

    def _sample_memory(self, owned, start):
        """Adds one sample of the owned processes' summed physical footprint to outcome.json's "memory", and returns
        a stop when the profile's cap is exceeded, or when a cap is set and some owned process cannot be read."""
        mem = self.record.setdefault("memory", {
            "cap_gib": self.profile.get("mem_cap_gib") or None,
            "metric": "physical footprint (proc_pid_rusage), summed over the job's owned processes",
            "peak_total_bytes": 0, "peak_at_s": None, "process_lifetime_max_bytes": {}, "samples": 0,
            "unreadable_pids": []})
        total, unreadable = 0, []
        for pid in owned:
            try:
                got = self.probes.footprint(pid)
            except (PermissionError, OSError):
                unreadable.append(pid)
                continue
            if got is None:
                continue
            total += got[0]
            key = str(pid)
            mem["process_lifetime_max_bytes"][key] = max(got[1], mem["process_lifetime_max_bytes"].get(key, 0))
        now = time.monotonic() - start
        mem["samples"] += 1
        if total > mem["peak_total_bytes"]:
            mem["peak_total_bytes"], mem["peak_at_s"] = total, round(now, 2)
        mem["unreadable_pids"] = sorted(set(mem["unreadable_pids"]) | set(unreadable))
        if now - getattr(self, "memory_written", -MEMORY_SERIES_EVERY) >= MEMORY_SERIES_EVERY:
            self.memory_written = now
            try:
                with open(os.path.join(self.run_root, "memory.ndjson"), "a", encoding="utf-8") as fh:
                    fh.write(json.dumps({"t": round(now, 1), "total_bytes": total, "processes": len(owned)}) + "\n")
            except OSError:
                pass
        cap = mem["cap_gib"]
        if not cap:
            return None
        if total > cap * (1 << 30):
            return ("memory", EXIT_MEMORY_CAP, "memory cap of {} GiB exceeded: {:.2f} GiB across {} processes".format(
                cap, total / (1 << 30), len(owned)))
        if unreadable:
            return ("memory", EXIT_MEMORY_CAP, "memory cap of {} GiB cannot be enforced: the footprint of pids {} "
                    "cannot be read".format(cap, sorted(unreadable)))
        return None

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

    def _stop_all(self, why, owned=None, grace=None):
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
        grace = self.profile["term_grace_s"] if grace is None else grace
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
            if time.monotonic() - term_at >= grace + QUARANTINE_AFTER_S:
                self.log("still present, or unknown, after SIGKILL", pids=sorted(owned), launchd=labels)
                return
            if time.monotonic() - term_at >= grace:
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
        """Clone directories and leases the job's rig-runs left. Raises OSError when lr-lease status cannot say."""
        clones = [os.path.join(self.paths["lume_clones"], "rig-run-{}".format(p)) for p in rig_pids]
        clones = [c for c in clones if os.path.lexists(c)]
        status = self._lease_cmd("status")
        if status.returncode != 0 or not status.stdout.startswith("Readings "):
            raise OSError("lr-lease status exited {}".format(status.returncode))
        leases = []
        for line in status.stdout.splitlines():
            if line.startswith("{"):
                try:
                    rec = json.loads(line)
                except ValueError:
                    raise OSError("lr-lease status printed a malformed lease line") from None
                # A lease of this attempt (rig-run's vm lease in managed mode) is settled with the token at conclusion.
                if rec.get("ownerPid") in rig_pids and rec.get("attempt") != self.attempt:
                    leases.append(rec.get("id"))
        return clones, leases

    def _vm_recover(self):
        """rig-stop for orphans, then lr-reap for dead owners' leases: the rig's own recovery, never Lume directly."""
        done = subprocess.run([self.paths["rig_stop"], "--orphans", "--grace", "15"], stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)
        subprocess.run([self.paths["lr_reap"], "--run", "rig"], stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {"exit": done.returncode, "output": done.stdout[-2000:]}

    def _vm_postconditions(self, vz_before):
        rig_pids = sorted(pid for pid, argv in self.tracker.argv_seen.items()
                          if len(argv) >= 2 and argv[0] == "/bin/bash" and argv[1] == self.paths["rig_run"])
        report = {"rig_run_pids": rig_pids}
        self.record["vm"] = report
        if not rig_pids:
            return report
        try:
            clones, leases = self._vm_leftovers(rig_pids)
        except OSError as ex:
            clones, leases = None, None
            report["probe_error"] = str(ex)
        report.update(clones_after_stop=clones, leases_after_stop=leases)
        for attempt in range(3):
            if clones == [] and leases == []:
                break
            # Every rig-run pid is gone by now, so these are orphans: rig-stop stops the VM, deletes the
            # clone and releases the leases; lr-reap removes leases of a dead owner.
            report.setdefault("rig_stop", []).append(self._vm_recover())
            try:
                clones, leases = self._vm_leftovers(rig_pids)
            except OSError as ex:
                clones, leases = None, None
                report["probe_error"] = str(ex)
        # The VM's Virtualization service is launchd's child, not ours, so it is only waited for, never signalled.
        deadline = time.monotonic() + 30
        vz_left = [p for p in self._vz_pids() if p not in vz_before]
        while vz_left and time.monotonic() < deadline:
            time.sleep(1)
            vz_left = [p for p in self._vz_pids() if p not in vz_before]
        report.update(clones_left=clones, leases_left=leases, virtualization_left=vz_left)
        incomplete = []
        if clones is None:
            incomplete.append("lr-lease status unavailable")
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
            if self.tracker.unverified:
                results["supervisor-scan-unreadable"] = [procs.UNKNOWN, "this user's pids {} started during the job "
                                                         "could not be read for the marker".format(sorted(self.tracker.unverified))]
        if self.record.get("vm", {}).get("rig_run_pids"):
            results["vm"] = list(self._vm_state())
        return results

    def _vm_state(self):
        """(ABSENT|PRESENT|UNKNOWN, detail) of what this job's rig-runs left: clones, leases, Virtualization processes."""
        try:
            clones, leases = self._vm_leftovers(self.record["vm"]["rig_run_pids"])
            vz_left = [p for p in self._vz_pids() if p not in self.vz_before]
        except OSError as ex:
            return procs.UNKNOWN, "VM probe failed: {}".format(ex)
        if clones or leases or vz_left:
            return procs.PRESENT, "clones {} leases {} Virtualization {}".format(clones, leases, vz_left)
        return procs.ABSENT, "no clone, lease or Virtualization process left"

    def _conclude(self):
        """Settle the lease and release custody once every resource is ABSENT; until then, QUARANTINED."""
        quarantined_at = None
        while True:
            results = self._inventory()
            if all(state == procs.ABSENT for state, _ in results.values()):
                recovery.test_point(self.plan, "supervisor:before-settle")
                lease = recovery.settle_lease(self.paths["lr_lease"], {"id": self.lease_id, "cleanup": self.lease_cleanup}
                                              if self.lease_id else None, self.token, self.attempt)
                if lease[0] == procs.ABSENT:
                    lease = recovery.settle_attempt_leases(self.paths["lr_lease"], self.attempt, self.token)
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
            if "vm" in results and results["vm"][0] != procs.ABSENT and \
                    time.monotonic() - getattr(self, "vm_recovered_at", 0) >= QUARANTINE_RETRY[1]:
                self.vm_recovered_at = time.monotonic()
                self.record["vm"].setdefault("rig_stop", []).append(self._vm_recover())
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
            os.write(self.status_fd, json.dumps({"exit": code, "cleanup": self.record.get("cleanup")}).encode())
        except OSError:
            pass  # the relay is gone; the queue already settled the job from its side
        finally:
            os.close(self.status_fd)
