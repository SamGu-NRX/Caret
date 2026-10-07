"""Astra's design, section 4, tests 1-6 and 8-10, for the group-contained profiles (phase A).

End-to-end tests run the real queue runner, relay, supervisor and a real launchd recovery agent in a
temporary world (support.World). Exclusion is checked by a separate contender that tries to lock
slot.lock and heavy.lock, not by a recorded status. Probe failures and pid reuse are also checked
in isolation with fake probes and fake commands. Test 7 (a fake VM leaving a Virtualization
process) belongs to phase C.
"""

import hashlib
import json
import os
import re
import signal
import subprocess
import time
import unittest
from unittest import mock

from support import QUEUE_LEGACY_REV, HEAVY, PY, World, profile  # first: puts ops/heavy on sys.path
import procs  # noqa: E402
import recovery  # noqa: E402


def finished(world, job_id):
    outcome = world.outcome(job_id)
    return outcome is not None and "exit" in outcome


class Custody(World):
    def wait_clean(self, job_id, by, seconds=90):
        ok = self.wait_for(lambda: any(r["event"] == "clean" for r in self.journal(job_id)), seconds)
        self.assertTrue(ok, (self.journal(job_id), self.queue_log(job_id)))
        self.assertEqual([r["by"] for r in self.journal(job_id) if r["event"] == "clean"], [by])

    def assert_all_released(self, job_id):
        # The live queue leaves a dead runner's lease for lr-lease's reaper (heavy-job-queue 401c4d1).
        subprocess.run([self.paths["lr_reap"]], env=self.env, stdout=subprocess.DEVNULL, check=True)
        self.assertTrue(self.wait_for(self.both_free, 20), "a lock is still held")
        self.assertTrue(self.wait_for(lambda: not self.recovery_agents(job_id), 20), self.recovery_agents(job_id))
        self.assertEqual(self.marked(job_id), [])
        self.assertEqual(self.labels(job_id), [])
        self.assertEqual(self.leases(), [])


class Test1ChildrenOutliveTheirParent(Custody):
    def test_a_child_that_closed_its_descriptors_and_ignores_sigterm_keeps_the_job_held(self):
        job_id, _ = self.enqueue(["stubborn"], profile=profile(grace=4))
        self.run_queue("--once", "--max-wait", "120")
        out = os.path.join(self.run_root(job_id), "out")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(out, "stubborn.pid")), 120))
        with open(os.path.join(out, "stubborn.pid")) as fh:
            child = int(fh.read())
        self.assertTrue(self.wait_for(lambda: "stopping: recipe exited" in self.queue_log(job_id), 30))
        # The parent is gone and the child holds no descriptor, but the job still excludes everyone.
        self.assertTrue(self.alive(child))
        self.assertTrue(self.contender_blocked())
        self.assertTrue(self.wait_for(lambda: finished(self, job_id), 60), self.queue_log(job_id))
        self.assertFalse(self.alive(child))  # SIGTERM ignored, so SIGKILL after the grace
        outcome = self.outcome(job_id)
        self.assertEqual((outcome["exit"], outcome["cleanup"]), (0, "clean"), outcome["reason"])
        self.wait_clean(job_id, "supervisor")
        self.assert_all_released(job_id)


class Test2CleanupLongerThanTheQueueGrace(Custody):
    def test_the_queue_sigkills_the_relay_while_cleanup_takes_15_s(self):
        job_id, _ = self.enqueue(["slow-cleanup", "15"], profile=profile(grace=30))
        self.run_queue("--once", "--max-wait", "120")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(self.run_root(job_id), "out", "ready")), 120))
        self.assertEqual(self.queue("cancel", "--id", job_id).returncode, 0)
        self.assertTrue(self.wait_for(lambda: self.job(job_id)["state"] == "cancelled", 25))
        self.assertIn("SIGKILL", self.job(job_id)["outcome_reason"])  # the queue's 10 s ran out
        self.assertTrue(self.contender_blocked())
        self.assertTrue(self.wait_for(lambda: finished(self, job_id), 60))
        self.assertTrue(os.path.exists(os.path.join(self.run_root(job_id), "out", "cleanup-done")))
        self.wait_clean(job_id, "supervisor")
        self.assert_all_released(job_id)


class Test3KillEachHolderAtEachBoundary(Custody):
    SUPERVISOR_POINTS = ("supervisor:after-adopt", "supervisor:after-register", "supervisor:after-release",
                         "supervisor:before-settle", "supervisor:after-settle")

    def run_killed(self, point, args=("ok",)):
        job_id, _ = self.enqueue(list(args), test={"kill_at": point}, profile=profile(grace=3))
        self.run_queue("--once", "--max-wait", "120").wait(timeout=300)
        return job_id

    def test_supervisor_death_at_each_boundary_is_finished_by_the_recovery_owner(self):
        for point in self.SUPERVISOR_POINTS:
            with self.subTest(point):
                job_id = self.run_killed(point, ("spawn", "3") if point == "supervisor:after-release" else ("ok",))
                self.assertTrue(os.path.exists(os.path.join(self.run_root(job_id), "test-point-fired")))
                self.wait_clean(job_id, "recovery")
                if point == "supervisor:after-release":
                    for kind, pid in self.spawned(job_id).items():
                        if isinstance(pid, int):
                            self.assertFalse(self.alive(pid), kind)
                self.assert_all_released(job_id)

    def test_recovery_owner_death_at_each_boundary_is_survived(self):
        for point in ("recovery:after-adopt", "recovery:after-register"):
            with self.subTest(point):
                job_id = self.run_killed(point)
                outcome = self.outcome(job_id)
                self.assertEqual((outcome["exit"], outcome["cleanup"]), (0, "clean"), outcome["reason"])
                self.assertTrue(os.path.exists(os.path.join(self.run_root(job_id), "test-point-fired")))
                adopted = [r for r in self.journal(job_id) if r["event"] == "adopted"]
                self.assertGreaterEqual(len(adopted), 2)  # the restarted owner was adopted again
                self.wait_clean(job_id, "supervisor")
                self.assert_all_released(job_id)

    def test_queue_runner_death_cancels_the_workload(self):
        job_id, _ = self.enqueue(["spawn", "600"], profile=profile(grace=3))
        runner = self.run_queue("--once", "--max-wait", "120")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(self.run_root(job_id), "out", "ready")), 120))
        os.kill(runner.pid, signal.SIGKILL)  # this test's own runner, by exact pid
        runner.wait()
        self.assertTrue(self.wait_for(lambda: finished(self, job_id), 60), self.queue_log(job_id))
        outcome = self.outcome(job_id)
        self.assertEqual(outcome["exit"], 143)
        self.assertIn("queue runner", outcome["reason"])
        for kind, pid in self.spawned(job_id).items():
            if isinstance(pid, int):
                self.assertFalse(self.alive(pid), kind)
        self.wait_clean(job_id, "supervisor")
        self.assert_all_released(job_id)


class Test4RecoveryRestartAndDuplicates(Custody):
    def test_a_restarted_recovery_owner_is_adopted_again_and_a_duplicate_owner_steps_aside(self):
        job_id, plan_path = self.enqueue(["spawn", "15"], profile=profile(grace=3))
        self.run_queue("--once", "--max-wait", "120")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(self.run_root(job_id), "out", "ready")), 120))
        with open(os.path.join(self.run_root(job_id), "supervisor.json")) as fh:
            rec = json.load(fh)["recovery"]
        pid = self.agent_pid(rec["label"])
        os.kill(pid, signal.SIGKILL)  # this test's own agent, by exact pid
        self.assertTrue(self.wait_for(lambda: self.agent_pid(rec["label"]) not in (None, pid), 10))
        self.assertTrue(self.wait_for(lambda: len([r for r in self.journal(job_id) if r["event"] == "adopted"]) >= 2, 20))
        # A second owner for the same attempt finds the first one's lock and exits without touching anything.
        import caret_heavy
        with open(plan_path, "rb") as fh:
            digest = hashlib.sha256(fh.read()).hexdigest()
        dup = subprocess.run(caret_heavy.boot_argv(PY, plan_path, digest, "recover", "--socket", rec["socket"],
                                                   "--attempt", rec["attempt"]),
                             env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(dup.returncode, 0, dup.stderr)
        self.assertIn("another recovery owner holds this job", dup.stderr)
        self.assertTrue(self.wait_for(lambda: finished(self, job_id), 90), self.queue_log(job_id))
        self.assertEqual(self.outcome(job_id)["exit"], 0, self.outcome(job_id)["reason"])
        self.wait_clean(job_id, "supervisor")
        self.assert_all_released(job_id)

    def agent_pid(self, label):
        out = subprocess.run(["/bin/launchctl", "print", "gui/{}/{}".format(os.getuid(), label)],
                             capture_output=True, text=True).stdout
        m = re.search(r"^\s*pid = (\d+)", out, re.M)
        return int(m.group(1)) if m else None


class Test5LaunchdResource(Custody):
    def test_a_registered_launchd_job_is_booted_out_when_its_caller_and_supervisor_die(self):
        job_id, _ = self.enqueue(["launchd-up"], profile=profile(grace=3))
        self.run_queue("--once", "--max-wait", "120")
        ready = os.path.join(self.run_root(job_id), "out", "ready")
        self.assertTrue(self.wait_for(lambda: os.path.exists(ready), 120), self.queue_log(job_id))
        with open(ready) as fh:
            label = fh.read().strip()
        self.assertTrue(any(r["event"] == "register" and r["resource"].get("label") == label
                            for r in self.journal(job_id)))
        self.assertEqual(procs.launchd_state(label)[0], procs.PRESENT)
        with open(os.path.join(self.run_root(job_id), "supervisor.json")) as fh:
            supervisor = json.load(fh)["supervisor_pid"]
        # The caller dies before reporting success, and the supervisor with it: only the journal knows the job.
        for pid in self.marked(job_id):
            os.kill(pid, signal.SIGKILL)
        os.kill(supervisor, signal.SIGKILL)
        self.wait_clean(job_id, "recovery")
        self.assertEqual(procs.launchd_state(label)[0], procs.ABSENT)
        self.assert_all_released(job_id)

    def test_a_recipe_registers_a_group_it_started_but_not_a_strangers(self):
        """Phase B's path: rig.ts registers Chrome's own process group before releasing it."""
        stranger = subprocess.Popen(["/bin/sleep", "600"], start_new_session=True)
        self.addCleanup(lambda: (stranger.kill(), stranger.wait()))
        job_id, _ = self.enqueue(["group-held", str(stranger.pid)], profile=profile(grace=3))
        self.run_queue("--once", "--max-wait", "120")
        out = os.path.join(self.run_root(job_id), "out")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(out, "ready")), 120), self.queue_log(job_id))
        with open(os.path.join(out, "held.pid")) as fh:
            held = int(fh.read())
        with open(os.path.join(out, "register-group.txt")) as fh:
            self.assertIn("exit 0", fh.read())
        with open(os.path.join(out, "register-stranger.txt")) as fh:
            text = fh.read()
        self.assertIn("exit 1", text)
        self.assertIn("was not started by this job", text)
        groups = [r["resource"]["pgid"] for r in self.journal(job_id)
                  if r["event"] == "register" and r["resource"]["type"] == "group"]
        self.assertIn(held, groups)
        self.assertNotIn(stranger.pid, groups)
        with open(os.path.join(self.run_root(job_id), "supervisor.json")) as fh:
            os.kill(json.load(fh)["supervisor_pid"], signal.SIGKILL)
        self.wait_clean(job_id, "recovery")
        self.assertFalse(self.alive(held))
        self.assertTrue(self.alive(stranger.pid))  # never touched
        self.assert_all_released(job_id)

    def test_registration_outside_the_jobs_prefix_is_refused(self):
        job_id, _ = self.enqueue(["register-bad"])
        self.run_queue("--once", "--max-wait", "120").wait(timeout=300)
        with open(os.path.join(self.run_root(job_id), "out", "register-bad.txt")) as fh:
            text = fh.read()
        self.assertIn("exit 1", text)
        self.assertIn("must start with caret-heavy.{}.".format(job_id), text)
        self.assertFalse(any(r["event"] == "register" and r["resource"]["type"] == "launchd"
                             for r in self.journal(job_id)))


class Test6ProbeFailures(unittest.TestCase):
    """Every probe failure is UNKNOWN, never an empty answer."""

    def script(self, body):
        import tempfile
        d = tempfile.mkdtemp(prefix="caret-heavy-probe-")
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", d]))
        path = os.path.join(d, "tool")
        with open(path, "w") as fh:
            fh.write("#!/bin/sh\n" + body + "\n")
        os.chmod(path, 0o755)
        return path

    def test_lease_status_nonzero_malformed_unexpected_or_slow_is_unknown(self):
        good = "echo 'Readings x'; echo 'Quiet until: none'; echo 'Leases: 1'; echo '{\"id\": \"L1\"}'"
        self.assertEqual(procs.lease_state(self.script(good), "L1")[0], procs.PRESENT)
        self.assertEqual(procs.lease_state(self.script(good), "L2")[0], procs.ABSENT)
        for body in ("echo 'Readings x'; echo 'Leases: 0'; exit 75",
                     "echo 'Readings x'; echo 'Leases: 1'; echo '{not json'",
                     "echo 'something else entirely'",
                     "echo 'Readings x'; echo 'Leases: 1'; echo '[1, 2]'",
                     "sleep 5"):
            with self.subTest(body):
                self.assertEqual(procs.lease_state(self.script(body), "L1", timeout=1)[0], procs.UNKNOWN)

    def test_launchd_print_failure_or_timeout_is_unknown(self):
        self.assertEqual(procs.launchd_state("x", launchctl=self.script("exit 113"))[0], procs.ABSENT)
        self.assertEqual(procs.launchd_state("x", launchctl=self.script("exit 0"))[0], procs.PRESENT)
        self.assertEqual(procs.launchd_state("x", launchctl=self.script("exit 5"))[0], procs.UNKNOWN)
        self.assertEqual(procs.launchd_state("x", launchctl=self.script("sleep 5"), timeout=1)[0], procs.UNKNOWN)

    def test_permission_denied_or_a_failed_listing_is_unknown(self):
        class Probes:
            def group(self, pgid):
                return [500]

            def usage(self, pid):
                raise PermissionError(1, "denied")

            def children(self, pid):
                return []
        self.assertEqual(procs.GroupWatch(Probes(), 500, [500, 1]).inventory()[0], procs.UNKNOWN)

        class Failing(Probes):
            def group(self, pgid):
                raise OSError(5, "proc_listpids failed")
        self.assertEqual(procs.GroupWatch(Failing(), 500, [500, 1]).inventory()[0], procs.UNKNOWN)
        self.assertTrue(procs.alive(Probes(), 500))  # a permission error never means dead


class Test6And9QuarantineHoldsEverything(Custody):
    QUEUE_REV = QUEUE_LEGACY_REV  # the supervisor's own lease, and rig-run's for VM jobs

    def test_an_unknown_lease_status_quarantines_and_blocks_the_next_job_until_it_clears(self):
        flaky = os.path.join(self.home, ".long-run/flaky-status")
        self.paths["lr_lease"] = os.path.join(self.home, ".long-run/bin/lr-lease-flaky")
        first, _ = self.enqueue(["ok"], profile=profile(grace=3))
        second, _ = self.enqueue(["ok"])
        open(flaky, "w").close()
        runner = self.run_queue("--max-wait", "6")
        self.assertTrue(self.wait_for(lambda: any(r["event"] == "quarantined" for r in self.journal(first)), 60),
                        self.queue_log(first))
        self.assertTrue(self.contender_blocked())
        # The queue gives up on the quarantined job (cancel: its relay is SIGKILLed 10 s later) and turns to the next,
        # which cannot get the slot: the supervisor and the recovery owner still hold it.
        self.assertEqual(self.queue("cancel", "--id", first).returncode, 0)
        self.assertEqual(runner.wait(timeout=90), 75)
        self.assertEqual(self.job(first)["state"], "cancelled")
        self.assertEqual(self.job(second)["state"], "queued")
        self.assertTrue(self.contender_blocked())
        self.assertFalse(os.path.exists(self.run_root(second)))
        with open(os.path.join(self.run_root(first), "outcome.json")) as fh:
            self.assertEqual(json.load(fh)["cleanup"], "quarantined")
        os.unlink(flaky)  # the probe recovers; the quarantine clears on a fresh, complete ABSENT
        self.wait_clean(first, "supervisor")
        self.assertTrue(self.wait_for(lambda: finished(self, first) and self.outcome(first)["cleanup"] == "clean", 60))
        self.assertEqual(self.run_queue("--once", "--max-wait", "120").wait(timeout=300), 0)
        self.assertEqual(self.job(second)["state"], "succeeded")
        self.assert_all_released(first)


class JournalReplay(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.dir = tempfile.mkdtemp(prefix="caret-journal-")
        self.addCleanup(subprocess.run, ["rm", "-rf", self.dir])
        self.path = os.path.join(self.dir, "journal.ndjson")

    def test_a_torn_tail_is_repaired_before_the_next_append_survives_replay(self):
        j = recovery.Journal(self.path)
        j.append({"event": "adopted"})
        with open(self.path, "ab") as fh:
            fh.write(b'{"event": "regis')  # a crash mid-append
        self.assertEqual([r["event"] for r in j.load(repair=True)], ["adopted"])
        j.append({"event": "register"})  # acknowledged after the restart
        self.assertEqual([r["event"] for r in recovery.Journal(self.path).load()], ["adopted", "register"])

    def test_interior_corruption_is_refused_not_skipped(self):
        with open(self.path, "wb") as fh:
            fh.write(b'{"event": "adopted"}\nnot json\n{"event": "register"}\n')
        with self.assertRaises(recovery.JournalCorrupt):
            recovery.Journal(self.path).load(repair=True)

    def test_short_writes_are_completed(self):
        real = os.write
        with mock.patch.object(recovery.os, "write", side_effect=lambda fd, data: real(fd, bytes(data[:3]))):
            recovery.Journal(self.path).append({"event": "adopted", "supervisor": [1, 2]})
        self.assertEqual(recovery.Journal(self.path).load()[0]["supervisor"], [1, 2])


class DiscoveryIsJournalled(unittest.TestCase):
    def test_an_identity_learned_while_answering_is_journalled_before_the_reply(self):
        import tempfile
        d = tempfile.mkdtemp(prefix="caret-discover-")
        self.addCleanup(subprocess.run, ["rm", "-rf", d])
        probes = Test8PidReuseAndStaleRecords.Probes()
        probes.procs[500] = (100, 1, 500, [])
        owner = recovery.Owner.__new__(recovery.Owner)
        owner.probes, owner.journal = probes, recovery.Journal(os.path.join(d, "journal.ndjson"))
        owner.resources, owner.watches = {}, {}
        owner._track({"id": "recipe", "type": "group", "pgid": 500, "leader": [500, 100]})
        probes.procs[501] = (110, 500, 500, [])  # a child, seen first by the inventory below
        results = owner.inventory()
        self.assertEqual(results["recipe"][0], procs.PRESENT)
        members = [r for r in owner.journal.load() if r["event"] == "members"]
        self.assertEqual([tuple(m) for r in members for m in r["add"]], [(501, 110)])
        owner._tick_groups()  # a later tick must not be the first to journal it, nor journal it twice
        self.assertEqual(len([r for r in owner.journal.load() if r["event"] == "members"]), 1)


class OwnerSurvivesCleanupFailures(unittest.TestCase):
    def test_a_launchctl_timeout_during_cleanup_is_unknown_and_the_descriptors_stay(self):
        import tempfile
        d = tempfile.mkdtemp(prefix="caret-owner-")
        self.addCleanup(subprocess.run, ["rm", "-rf", d])
        probes = Test8PidReuseAndStaleRecords.Probes()
        owner = recovery.Owner.__new__(recovery.Owner)
        owner.probes, owner.journal = probes, recovery.Journal(os.path.join(d, "journal.ndjson"))
        owner.plan = {"lease": {"renew_s": 300, "ttl_min": 15}, "test": {}}
        owner.paths, owner.profile = {"lr_lease": "/nonexistent/lr-lease"}, {"term_grace_s": 0}
        owner.resources, owner.watches, owner.fds = {}, {}, {"slot": 99}
        owner.lease, owner.token, owner.attempt = None, None, "a" * 32
        owner.supervisor, owner.state = [424242, 1], "cleanup"  # the supervisor is gone
        owner.term_at = owner.next_kill = None
        owner.lease_renewed = 0
        owner._track({"id": "launchd-prefix", "type": "launchd-prefix", "prefix": "caret-heavy.caret-x."})
        timeout = subprocess.TimeoutExpired(["launchctl"], 20)
        with mock.patch.object(procs, "launchd_jobs", side_effect=timeout), \
                mock.patch.object(procs, "launchd_bootout", side_effect=timeout):
            for _ in range(3):
                owner._tick()  # must not raise
            self.assertEqual(owner.inventory()["launchd-prefix"][0], procs.UNKNOWN)
        self.assertIn(owner.state, ("cleanup", "quarantined"))
        self.assertEqual(owner.fds, {"slot": 99})


class WireDescriptorsAndDeadlines(unittest.TestCase):
    """Received descriptors are owned by the connection and closed on every failure path; framing never blocks the
    owner; the supervisor's side has an I/O deadline."""

    def owner(self):
        import tempfile
        d = tempfile.mkdtemp(prefix="caret-wire-")
        self.addCleanup(subprocess.run, ["rm", "-rf", d])
        owner = recovery.Owner.__new__(recovery.Owner)
        owner.journal = recovery.Journal(os.path.join(d, "journal.ndjson"))
        owner.supervisor, owner.watches, owner.clients, owner.fds = None, {}, {}, {}
        owner.plan, owner.paths = {"job_id": "caret-x", "test": {}}, {}
        return owner

    def copies(self, target):
        """How many of this process's descriptors refer to *target*'s file."""
        want = os.fstat(target)
        n = 0
        for name in os.listdir("/dev/fd"):
            try:
                st = os.fstat(int(name))
            except OSError:
                continue
            n += (st.st_dev, st.st_ino) == (want.st_dev, want.st_ino)
        return n

    def serve(self, owner, payload, fds=(), close=False):
        import socket
        a, b = socket.socketpair()
        self.addCleanup(a.close)
        owner.clients[b] = recovery.Conn(b)
        if fds:
            socket.send_fds(a, [payload], list(fds))
        else:
            a.sendall(payload)
        if close:
            a.shutdown(socket.SHUT_WR)
        before = time.monotonic()
        owner._serve(b)
        self.assertLess(time.monotonic() - before, 1.0)  # never waits for the rest of a frame
        return a, b

    def test_rejected_frames_close_every_received_descriptor(self):
        import tempfile
        owner = self.owner()
        f = tempfile.TemporaryFile()
        self.addCleanup(f.close)
        for payload, close in ((b"not json\n", False), (b'{"op": "sta', True), (b'{"op": "status"}\n', False)):
            with self.subTest(payload):
                a, b = self.serve(owner, payload, fds=[f.fileno()], close=close)
                if close:
                    self.assertEqual(self.copies(f.fileno()), 2)  # an unfinished frame holds it until its end...
                    owner._serve(b)  # ...which the owner's loop reads next
                    self.assertNotIn(b, owner.clients)
                self.assertEqual(self.copies(f.fileno()), 1)  # only the test's own: the received copy was closed
                if b in owner.clients:
                    owner.clients.pop(b).discard()
                b.close()

    def test_a_partial_frame_waits_for_more_without_blocking(self):
        owner = self.owner()
        a, b = self.serve(owner, b'{"op": "sta')
        self.assertIn(b, owner.clients)  # kept, still waiting for the rest
        a.sendall(b'tus"}\n')
        owner._serve(b)
        reply = recovery.Reader(a).read()[0]
        self.assertEqual(reply["ok"], False)  # status from a stranger is refused, but it was parsed and answered
        b.close()

    def test_a_stalled_owner_times_the_supervisor_out(self):
        import socket
        a, b = socket.socketpair()
        self.addCleanup(a.close)
        self.addCleanup(b.close)
        c = recovery.Custody.__new__(recovery.Custody)
        c.io_timeout = 1.0
        c._attach(a)
        started = time.monotonic()
        with self.assertRaises(OSError):
            c._exchange({"op": "status"})  # b never answers
        self.assertLess(time.monotonic() - started, 5)


class AdoptionIsAllOrNothing(unittest.TestCase):
    def test_a_refused_descriptor_leaves_none_of_the_others_kept(self):
        import fcntl
        import tempfile
        d = tempfile.mkdtemp(prefix="caret-adopt-")
        self.addCleanup(subprocess.run, ["rm", "-rf", d])
        slot, heavy = os.path.join(d, "slot.lock"), os.path.join(d, "heavy.lock")
        good = os.open(slot, os.O_RDWR | os.O_CREAT)
        fcntl.flock(good, fcntl.LOCK_EX)
        unlocked = os.open(heavy, os.O_RDWR | os.O_CREAT)  # holds no lock: refused
        self.addCleanup(os.close, unlocked)
        owner = recovery.Owner.__new__(recovery.Owner)
        owner.paths, owner.fds = {"slot_lock": slot, "heavy_lock": heavy}, {}
        with self.assertRaises(procs.Refusal):
            owner._adopt_locks(["slot", "heavy"], [good, unlocked])
        self.assertEqual(owner.fds, {})
        os.close(good)


class Test8PidReuseAndStaleRecords(unittest.TestCase):
    class Probes:
        def __init__(self):
            self.procs = {}  # pid -> (start, ppid, pgid, env)

        def group(self, pgid):
            return [p for p, v in self.procs.items() if v[2] == pgid]

        def usage(self, pid):
            return None if pid not in self.procs else (1, self.procs[pid][0])

        def children(self, pid):
            return [p for p, v in self.procs.items() if v[1] == pid]

        def all_pids(self):
            return list(self.procs)

        def procargs(self, pid):
            return ["x"], self.procs[pid][3]

    def test_never_signals_a_reused_pid_an_untraceable_member_or_an_old_marked_process(self):
        probes = self.Probes()
        probes.procs[500] = (100, 1, 500, [])
        probes.procs[501] = (110, 500, 500, [])
        watch = procs.GroupWatch(probes, 500, [500, 100])
        self.assertEqual(watch.inventory()[0], procs.PRESENT)
        # Everything exits; pid 501 comes back as a stranger in another group, and an orphan nobody traced joins 500.
        probes.procs = {501: (300, 1, 777, []), 502: (310, 1, 500, [])}
        state, detail = watch.inventory()
        self.assertEqual(state, procs.UNKNOWN)
        self.assertIn("502", detail)
        with mock.patch.object(os, "kill") as kill:
            self.assertEqual(watch.signal(signal.SIGKILL), [])
        kill.assert_not_called()
        # A stale journal record (restarted owner) naming 501 with its old start time is not 501 now.
        restored = procs.GroupWatch(probes, 500, [500, 100], identities=[(501, 110)])
        restored.tick()
        self.assertNotIn(501, restored.live_verified)
        # A process carrying the marker but started before the job is not the job's.
        probes.procs = {600: (50, 1, 600, ["CARET_HEAVY_MARK=caret-x.n"]), 601: (200, 1, 601, ["CARET_HEAVY_MARK=caret-x.n"])}
        state, found = recovery.marked_state(probes, {"mark": "caret-x.n", "since": 100})
        self.assertEqual((state, found), (procs.PRESENT, [(601, 200)]))
        with mock.patch.object(os, "kill") as kill, mock.patch.object(recovery, "same_process", return_value=False):
            self.assertEqual(recovery.signal_identities(probes, found, signal.SIGKILL), [])
        kill.assert_not_called()


class Test10ReservationsAndCredentials(Custody):
    """With the vendored lr-lease (cleanup-required leases, pending install)."""

    QUEUE_REV = QUEUE_LEGACY_REV  # the supervisor's own lease, and rig-run's for VM jobs

    LEASE_SOURCE = os.path.join(HEAVY, "vendor/long-run/bin")

    def test_owner_death_and_expiry_keep_the_reservation_until_the_recovery_owner_acknowledges(self):
        job_id, _ = self.enqueue(["spawn", "600"], profile=profile(grace=3), lease_ttl_min=0.02, lease_renew_s=10000)
        self.run_queue("--once", "--max-wait", "120")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(self.run_root(job_id), "out", "ready")), 120))
        [lease] = self.leases()
        self.assertTrue(lease["cleanupRequired"])
        time.sleep(2)  # the TTL has passed; the owner is alive
        subprocess.run([self.paths["lr_reap"]], env=self.env, check=True)
        self.assertEqual([l["id"] for l in self.leases()], [lease["id"]])
        with open(os.path.join(self.run_root(job_id), "supervisor.json")) as fh:
            supervisor = json.load(fh)["supervisor_pid"]
        os.kill(supervisor, signal.SIGKILL)
        subprocess.run([self.paths["lr_reap"]], env=self.env, check=True)  # the owner is dead: quarantined, kept
        kept = self.leases()
        self.assertEqual([(l["id"], l.get("state")) for l in kept], [(lease["id"], "quarantined")])
        other = subprocess.run([self.paths["lr_lease"], "acquire", "--run", "rig", "--kind", "heavy", "--est-mem", "0",
                                "--est-disk", "0", "--owner-pid", str(os.getpid())], env=self.env,
                               capture_output=True, text=True)
        self.assertEqual(other.returncode, 75)
        self.assertIn("quarantined lease", other.stdout)
        self.wait_clean(job_id, "recovery")  # the recovery owner acknowledged with the token
        self.assert_all_released(job_id)
        self.assert_no_token_anywhere(lease["tokenSha256"])

    def assert_no_token_anywhere(self, token_sha256):
        """No file this world wrote holds a string whose SHA-256 is the lease's token digest."""
        hexes = set()
        for root, _, names in os.walk(self.root):
            for name in names:
                path = os.path.join(root, name)
                if os.path.islink(path):
                    continue
                with open(path, "rb") as fh:
                    hexes.update(re.findall(rb"[0-9a-f]{64}", fh.read()))
        self.assertTrue(hexes)
        self.assertFalse([h for h in hexes if hashlib.sha256(h).hexdigest() == token_sha256])


if __name__ == "__main__":
    unittest.main(verbosity=2)
