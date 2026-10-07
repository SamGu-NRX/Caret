"""End-to-end tests of the supervisor through the real queue runner, with real light processes.

Each test builds a temporary world (support.World): its own queue state, HOLD path, lease
directory and zero-floor lease policy, heavy.lock, scratch worktree and a snapshot of this
ops/heavy tree. The probe recipe (tests/recipes/probe.sh) starts detached process groups, a
double-forked orphan, a child with an empty environment and a launchd job with the job's label
prefix. Run: python3.14 -m unittest discover -s ops/heavy/tests  (about two minutes).
"""

import calendar
import json
import os
import shutil
import signal
import subprocess
import time
import unittest
import uuid

from support import PY as PY_FOR_TESTS, World, profile  # first: puts ops/heavy on sys.path
import manifest  # noqa: E402
import procs  # noqa: E402


class Cancellation(World):
    def test_sigkill_of_the_queue_group_leaves_no_process_slot_lease_or_lock(self):
        job_id, _ = self.enqueue(["spawn", "600"], profile=profile(grace=3))
        self.run_queue("--once", "--max-wait", "10")
        out = os.path.join(self.run_root(job_id), "out")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(out, "ready")), 30), self.queue_log(job_id))
        spawned = self.spawned(job_id)
        self.assertEqual(set(spawned), {"detached-group", "empty-env-child", "launchd", "orphan"})
        for kind in ("detached-group", "empty-env-child", "orphan"):
            self.assertTrue(self.alive(spawned[kind]), kind)
        self.assertEqual(self.labels(job_id), [spawned["launchd"]])
        self.assertTrue(procs.lock_held(self.paths["slot_lock"]))
        self.assertTrue(procs.lock_held(self.paths["heavy_lock"]))
        self.assertEqual(len(self.leases()), 1)
        self.assertTrue(self.wait_for(lambda: self.job(job_id).get("pgid"), 10))
        pgid = self.job(job_id)["pgid"]

        os.killpg(pgid, signal.SIGKILL)  # the queue job's own group: the relay, which this test's runner started

        self.assertTrue(self.wait_for(lambda: self.outcome(job_id) and "exit" in self.outcome(job_id), 60),
                        self.queue_log(job_id))
        outcome = self.outcome(job_id)
        self.assertEqual(outcome["exit"], 143)
        self.assertIn("relay died", outcome["reason"])
        self.assertEqual(outcome["states"], {"executed": False, "validated": False, "accepted_by_lead": None})
        self.assertTrue(self.wait_for(lambda: not self.alive(outcome["supervisor_pid"]), 10))
        self.assertEqual(self.marked(job_id), [])
        self.assertEqual(self.labels(job_id), [])
        for kind in ("detached-group", "empty-env-child", "orphan"):
            self.assertFalse(self.alive(spawned[kind]), kind)
        self.assertFalse(procs.lock_held(self.paths["slot_lock"]))
        self.assertFalse(procs.lock_held(self.paths["heavy_lock"]))
        self.assertEqual(self.leases(), [])
        self.assertTrue(self.wait_for(lambda: self.job(job_id)["state"] == "failed", 20))
        self.assertEqual(self.job(job_id)["exit_code"], 137)

    def test_sigterm_during_slow_cleanup_completes_it_before_the_next_job_starts(self):
        # The recipe needs 15 s to clean up; the queue SIGKILLs the relay 10 s after its SIGTERM.
        first, _ = self.enqueue(["slow-cleanup", "15"], profile=profile(grace=30))
        second, _ = self.enqueue(["ok"])
        self.run_queue("--max-wait", "120")
        out = os.path.join(self.run_root(first), "out")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(out, "ready")), 30), self.queue_log(first))
        cancelled_at = time.time()
        self.assertEqual(self.queue("cancel", "--id", first).returncode, 0)
        self.assertTrue(self.wait_for(lambda: self.job(first)["state"] == "cancelled", 20))
        relay_gone_at = time.time()
        self.assertIn("SIGKILL", self.job(first)["outcome_reason"])  # the queue's 10 s grace ran out
        # The relay is dead, but the supervisor still holds the slot and the lease while the recipe cleans up.
        self.assertFalse(os.path.exists(os.path.join(out, "cleanup-done")))
        self.assertTrue(procs.lock_held(self.paths["slot_lock"]))
        self.assertEqual(len(self.leases()), 1)
        self.assertFalse(os.path.exists(self.run_root(second)))
        self.assertTrue(self.wait_for(lambda: self.outcome(second) and "exit" in self.outcome(second), 60))
        with open(os.path.join(out, "cleanup-done")) as fh:
            cleaned_at = int(fh.read())
        self.assertGreaterEqual(cleaned_at, int(cancelled_at) + 14)
        self.assertGreater(cleaned_at, relay_gone_at - 1)
        outcome = self.outcome(first)
        self.assertEqual(outcome["exit"], 143)
        self.assertIn("cancelled by the queue", outcome["reason"])
        with open(os.path.join(self.run_root(second), "supervisor.json")) as fh:
            second_started = calendar.timegm(time.strptime(json.load(fh)["started_utc"], "%Y-%m-%dT%H:%M:%SZ"))
        self.assertGreaterEqual(second_started, cleaned_at - 1)
        self.assertEqual(self.outcome(second)["exit"], 0)
        self.assertEqual(self.marked(first), [])

    def test_a_sigkilled_supervisor_leaves_the_slot_held_while_the_recipe_lives(self):
        job_id, _ = self.enqueue(["spawn", "600"], profile=profile(grace=3))
        self.run_queue("--once", "--max-wait", "10")
        out = os.path.join(self.run_root(job_id), "out")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(out, "ready")), 30), self.queue_log(job_id))
        with open(os.path.join(self.run_root(job_id), "supervisor.json")) as fh:
            supervisor = json.load(fh)["supervisor_pid"]
        os.kill(supervisor, signal.SIGKILL)  # the exact pid of this test's supervisor
        self.assertTrue(self.wait_for(lambda: self.job(job_id)["state"] == "failed", 20))  # the relay saw no status
        self.assertEqual(self.job(job_id)["exit_code"], 125)
        # The recipe inherited the slot and heavy.lock descriptors, so neither is free while it runs.
        self.assertTrue(procs.lock_held(self.paths["slot_lock"]))
        self.assertTrue(procs.lock_held(self.paths["heavy_lock"]))
        for pid in self.marked(job_id):
            os.kill(pid, signal.SIGKILL)
        for label in self.labels(job_id):
            procs.launchd_bootout(label)
        # The child with an empty environment carries no marker; only the dead supervisor's record knew it. It still
        # holds the inherited descriptors, so the queue stays blocked instead of starting beside it.
        empty_env_child = self.spawned(job_id)["empty-env-child"]
        time.sleep(1)
        self.assertTrue(self.alive(empty_env_child))
        self.assertTrue(procs.lock_held(self.paths["slot_lock"]))
        os.kill(empty_env_child, signal.SIGKILL)  # exact pid the probe recorded
        self.assertTrue(self.wait_for(lambda: not procs.lock_held(self.paths["slot_lock"]), 10))
        self.assertFalse(procs.lock_held(self.paths["heavy_lock"]))

    def test_leftovers_after_a_clean_exit_are_stopped_and_the_run_still_validates(self):
        job_id, _ = self.enqueue(["leftover"], profile=profile(grace=3))
        self.run_queue("--once", "--max-wait", "10").wait(timeout=90)
        outcome = self.outcome(job_id)
        self.assertEqual((outcome["exit"], outcome["states"]["validated"]), (0, True), outcome)
        spawned = self.spawned(job_id)
        self.assertTrue(any(e["event"].startswith("stopping: recipe exited") for e in outcome["events"]))
        self.assertEqual(self.marked(job_id), [])
        self.assertEqual(self.labels(job_id), [])
        for kind in ("detached-group", "empty-env-child", "orphan"):
            self.assertFalse(self.alive(spawned[kind]), kind)
        self.assertEqual(self.job(job_id)["state"], "succeeded")


class Lease(World):
    def test_owner_tied_lease_outlives_its_ttl_and_blocks_other_heavy_jobs(self):
        # TTL 1.2 s and no renewal: before the reaper change, lr-reap removed this lease mid-job.
        job_id, _ = self.enqueue(["spawn", "8"], lease_ttl_min=0.02, lease_renew_s=10000)
        self.run_queue("--once", "--max-wait", "10")
        self.assertTrue(self.wait_for(lambda: os.path.exists(os.path.join(self.run_root(job_id), "out", "ready")), 30))
        time.sleep(2)
        for args in ([], ["--run", "caret"]):
            subprocess.run([self.paths["lr_reap"], *args], env=self.env, check=True)
        [lease] = self.leases()
        self.assertLess(lease["expiresAt"], time.time() * 1000)  # expired, yet kept: its owner is alive
        with open(os.path.join(self.run_root(job_id), "supervisor.json")) as fh:
            self.assertEqual(lease["ownerPid"], json.load(fh)["supervisor_pid"])
        other = subprocess.run([self.paths["lr_lease"], "acquire", "--run", "rig", "--kind", "heavy", "--est-mem", "0",
                                "--est-disk", "0", "--owner-pid", str(os.getpid())], env=self.env,
                               capture_output=True, text=True)
        self.assertEqual(other.returncode, 75)
        self.assertIn("count limit", other.stdout)
        self.assertTrue(self.wait_for(lambda: self.outcome(job_id) and "exit" in self.outcome(job_id), 60))
        self.assertEqual(self.outcome(job_id)["exit"], 0)
        self.assertEqual(self.leases(), [])

    def test_renewal_keeps_the_expiry_ahead_for_mem_guard(self):
        job_id, _ = self.enqueue(["spawn", "6"], lease_ttl_min=0.05, lease_renew_s=1)
        self.run_queue("--once", "--max-wait", "10")
        self.assertTrue(self.wait_for(lambda: len(self.leases()) == 1, 30))
        seen = []
        for _ in range(4):
            time.sleep(1.5)
            leases = self.leases()
            if leases:
                seen.append(leases[0]["expiresAt"])
                self.assertGreater(leases[0]["expiresAt"], time.time() * 1000)
        self.assertEqual(seen, sorted(seen))
        self.assertGreater(seen[-1], seen[0])
        self.assertTrue(self.wait_for(lambda: self.outcome(job_id) and "exit" in self.outcome(job_id), 60))
        self.assertGreaterEqual(self.outcome(job_id)["lease"]["renewals"], 3)

    def test_lease_wait_is_bounded_apart_from_execution(self):
        holder = subprocess.run([self.paths["lr_lease"], "acquire", "--run", "rig", "--kind", "heavy", "--est-mem", "0",
                                 "--est-disk", "0", "--owner-pid", str(os.getpid())], env=self.env,
                                capture_output=True, text=True, check=True).stdout.strip()
        job_id, _ = self.enqueue(["ok"], profile=profile(lease_wait=4, exec_s=600))
        started = time.monotonic()
        self.run_queue("--once", "--max-wait", "10").wait(timeout=60)
        self.assertLess(time.monotonic() - started, 30)
        outcome = self.outcome(job_id)
        self.assertEqual(outcome["exit"], 75)
        self.assertIn("not admitted within the lease wait of 4 s: heavy lease: refused: count limit", outcome["reason"])
        self.assertFalse(os.path.exists(os.path.join(self.run_root(job_id), "recipe.log")))
        self.assertEqual([lease["id"] for lease in self.leases()], [holder])
        self.assertFalse(procs.lock_held(self.paths["heavy_lock"]))


class RunnerHeavyLock(World):
    """heavy.lock with today's queue (the supervisor takes it) and with a runner that holds it and passes its descriptor
    (the coordinator's proposal, simulated by tests/run_queue_holding_heavy_lock.py). Neither may deadlock, and in both
    the recipe gets a descriptor that rig-run's proof accepts."""

    def run_lock_proof(self, holding):
        job_id, _ = self.enqueue(["lock-proof", self.paths["heavy_lock"]])
        lease_only, _ = self.enqueue(["ok"], profile=profile(lease=False))
        self.assertEqual(self.run_queue("--max-wait", "10", holding_heavy_lock=holding).wait(timeout=120), 0)
        return job_id, lease_only

    def test_today_the_supervisor_takes_heavy_lock_itself(self):
        job_id, vm_like = self.run_lock_proof(holding=False)
        outcome = self.outcome(job_id)
        self.assertEqual(outcome["exit"], 0, outcome["reason"])
        admitted = next(e for e in outcome["events"] if e["event"] == "admitted")
        self.assertEqual(admitted["heavy_lock"], "taken")
        with open(os.path.join(self.run_root(job_id), "out", "lock-proof.txt")) as fh:
            self.assertEqual(fh.read().strip(), "held-through-fd")
        admitted = next(e for e in self.outcome(vm_like)["events"] if e["event"] == "admitted")
        self.assertEqual(admitted["heavy_lock"], "left to rig-run")
        self.assertFalse(procs.lock_held(self.paths["heavy_lock"]))

    def test_a_runner_holding_heavy_lock_hands_it_down_without_deadlock(self):
        job_id, vm_like = self.run_lock_proof(holding=True)
        outcome = self.outcome(job_id)
        self.assertEqual(outcome["exit"], 0, outcome["reason"])
        admitted = next(e for e in outcome["events"] if e["event"] == "admitted")
        self.assertEqual(admitted["heavy_lock"], "inherited from the queue runner")
        self.assertIn("holds the slot and the runner's heavy.lock", self.queue_log(job_id))
        with open(os.path.join(self.run_root(job_id), "out", "lock-proof.txt")) as fh:
            self.assertEqual(fh.read().strip(), "held-through-fd")
        admitted = next(e for e in self.outcome(vm_like)["events"] if e["event"] == "admitted")
        self.assertEqual(admitted["heavy_lock"], "inherited from the queue runner")
        self.assertEqual(self.leases(), [])
        self.assertFalse(procs.lock_held(self.paths["heavy_lock"]))  # the runner has exited

    def test_a_runner_holding_heavy_lock_without_passing_it_is_a_bounded_named_wait(self):
        holder = subprocess.Popen([PY_FOR_TESTS, "-c", "import fcntl, os, sys, time; fd = os.open(sys.argv[1], os.O_RDWR | "
                                   "os.O_CREAT); fcntl.flock(fd, fcntl.LOCK_EX); print(flush=True); time.sleep(120)",
                                   self.paths["heavy_lock"]], stdout=subprocess.PIPE)
        self.addCleanup(lambda: (holder.kill(), holder.wait(), holder.stdout.close()))
        holder.stdout.readline()
        job_id, _ = self.enqueue(["ok"], profile=profile(lease_wait=4))
        self.run_queue("--once", "--max-wait", "10").wait(timeout=60)
        outcome = self.outcome(job_id)
        self.assertEqual(outcome["exit"], 75)
        self.assertIn("must pass its descriptor to the job", outcome["reason"])
        self.assertEqual(self.leases(), [])


class PostLeaseRecheck(World):
    """The supervisor's admission step on its own: the real lr-lease and heavy.lock, injected disk and pressure readings
    (the queue admits on the same floor, so a low reading cannot be forced through the queue)."""

    class Readings:
        def __init__(self, pressure, free_gib):
            self.pressure, self.free = pressure, free_gib

        def pressure_level(self):
            return self.pressure

        def free_bytes(self, path):
            return self.free * (1 << 30)

    def supervisor(self, readings, floor=10):
        import caret_heavy
        import supervise
        plan = caret_heavy.build_plan(caret_heavy.RECIPES["canned-sets"], "caret-recheck", self.worktree, self.rev,
                                      [], [], {}, None, self.paths, ("/snap", {}, "/ops", "b" * 40),
                                      profile=profile(floor=floor))
        os.makedirs(self.paths["evidence_root"], exist_ok=True)
        return supervise.Supervisor("/plan", "d" * 64, plan, -1, -1, -1, probes=readings)

    def test_low_disk_or_pressure_after_the_lease_releases_it(self):
        old_home = os.environ["HOME"]
        os.environ["HOME"] = self.home  # lr-lease resolves its lease directory from HOME
        self.addCleanup(os.environ.__setitem__, "HOME", old_home)
        for readings, expected in ((self.Readings(1, 5), "5.0 GiB free on"), (self.Readings(2, 50), "memory pressure level 2")):
            with self.subTest(expected):
                sup = self.supervisor(readings)
                self.assertIn(expected, sup._try_admit())
                self.assertEqual(self.leases(), [])
                self.assertFalse(procs.lock_held(self.paths["heavy_lock"]))
                self.assertIsNone(sup.lease_id)
        sup = self.supervisor(self.Readings(1, 50))
        self.assertIsNone(sup._try_admit())
        self.assertEqual([lease["ownerPid"] for lease in self.leases()], [os.getpid()])
        self.assertTrue(procs.lock_held(self.paths["heavy_lock"]))
        sup._release()
        self.assertEqual(self.leases(), [])
        self.assertFalse(procs.lock_held(self.paths["heavy_lock"]))
        with open(self.paths["hold"], "w") as fh:
            fh.write("4102444800 test\n")
        self.assertIn("HOLD", self.supervisor(self.Readings(1, 50))._try_admit())
        self.assertEqual(self.leases(), [])


class Pins(World):
    def run_once(self, job_id):
        self.run_queue("--once", "--max-wait", "10").wait(timeout=90)
        return self.job(job_id)

    def make_writable(self, path):
        os.chmod(os.path.dirname(path), 0o755)
        os.chmod(path, 0o644)

    def test_a_changed_recipe_file_in_the_snapshot_is_refused(self):
        job_id, plan_path = self.enqueue(["ok"])
        with open(plan_path) as fh:
            snapshot = json.load(fh)["ops"]["snapshot"]
        target = os.path.join(snapshot, "ops/heavy/tests/recipes/probe.sh")
        self.make_writable(target)
        with open(target, "a") as fh:
            fh.write("# edited after enqueue\n")
        job = self.run_once(job_id)
        self.assertEqual((job["state"], job["exit_code"]), ("failed", 65))
        self.assertIn("snapshot file ops/heavy/tests/recipes/probe.sh changed since enqueue", self.queue_log(job_id))
        self.assertFalse(os.path.exists(self.run_root(job_id)))
        self.assertEqual(self.leases(), [])

    def test_an_extra_file_in_the_snapshot_is_refused(self):
        job_id, plan_path = self.enqueue(["ok"])
        with open(plan_path) as fh:
            snapshot = json.load(fh)["ops"]["snapshot"]
        folder = os.path.join(snapshot, "ops/heavy")
        os.chmod(folder, 0o755)
        with open(os.path.join(folder, "signal.py"), "w") as fh:
            fh.write("raise SystemExit('a shadowing module ran')\n")
        job = self.run_once(job_id)
        self.assertEqual(job["exit_code"], 65)
        self.assertIn("snapshot files differ from the plan", self.queue_log(job_id))

    def test_a_changed_plan_is_refused(self):
        job_id, plan_path = self.enqueue(["ok"])
        os.chmod(plan_path, 0o644)
        with open(plan_path, "a") as fh:
            fh.write(" ")
        job = self.run_once(job_id)
        self.assertEqual(job["exit_code"], 65)
        self.assertIn("changed since enqueue", self.queue_log(job_id))

    def test_a_changed_input_is_refused_before_any_lease(self):
        fixture = os.path.join(self.root, "fixture-binary")
        tree = os.path.join(self.root, "browsers")
        os.makedirs(tree)
        for path, text in ((fixture, "v1\n"), (os.path.join(tree, "chrome"), "c1\n")):
            with open(path, "w") as fh:
                fh.write(text)
        inputs = [manifest.record("bridge", "file", fixture), manifest.record("browsers", "tree", tree)]
        def append_fixture():
            with open(fixture, "a") as fh:
                fh.write("v2\n")

        def add_to_tree():
            with open(os.path.join(tree, "extra"), "w"):
                pass

        for mutate, expected in ((append_fixture, "bridge ({}) changed since enqueue".format(fixture)),
                                 (add_to_tree, "tree browsers changed")):
            with self.subTest(expected):
                inputs = [manifest.record("bridge", "file", fixture), manifest.record("browsers", "tree", tree)]
                job_id, _ = self.enqueue(["ok"], extra_inputs=inputs)
                mutate()
                job = self.run_once(job_id)
                self.assertEqual(job["exit_code"], 65)
                outcome = self.outcome(job_id)
                self.assertIn("inputs changed since enqueue", outcome["reason"])
                self.assertIn(expected, outcome["reason"])
                self.assertFalse(any(e["event"] == "admitted" for e in outcome["events"]))
                self.assertFalse(os.path.exists(os.path.join(self.run_root(job_id), "recipe.log")))
                self.assertEqual(self.leases(), [])

    def test_a_moved_worktree_is_refused_by_the_queue_at_release(self):
        job_id, _ = self.enqueue(["ok"])
        with open(os.path.join(self.worktree, "tracked"), "w") as fh:
            fh.write("two\n")
        job = self.run_once(job_id)
        self.assertEqual(job["state"], "refused")
        self.assertFalse(os.path.exists(self.run_root(job_id)))


class Adapters(World):
    def test_recipe_codes_and_evidence_checks(self):
        cases = {"wrong": (10, True), "suite-fail": (11, True), "no-result": (66, True), "foreign-result": (66, True),
                 "stale-evidence": (66, True), "ok": (0, True)}
        jobs = {mode: self.enqueue([mode])[0] for mode in cases}
        self.run_queue("--max-wait", "10").wait(timeout=180)
        for mode, (code, executed) in cases.items():
            with self.subTest(mode):
                outcome = self.outcome(jobs[mode])
                self.assertEqual(outcome["exit"], code, outcome["reason"])
                self.assertEqual(outcome["states"], {"executed": executed, "validated": code == 0,
                                                     "accepted_by_lead": None})
                self.assertEqual(self.job(jobs[mode])["state"], "succeeded" if code == 0 else "failed")
        self.assertIn("result.json is missing", self.outcome(jobs["no-result"])["reason"])
        self.assertIn("job_id is 'caret-someone-else'", self.outcome(jobs["foreign-result"])["reason"])
        self.assertIn("predates this run", self.outcome(jobs["stale-evidence"])["reason"])
        import caret_heavy
        with self.assertRaisesRegex(manifest.ManifestError, "not validated"):
            caret_heavy.accept(self.paths, jobs["wrong"], "no")
        caret_heavy.accept(self.paths, jobs["ok"], "lead read the sets")
        state = caret_heavy.outcome_of(self.paths, jobs["ok"])
        self.assertEqual((state["executed"], state["validated"], state["accepted_by_lead"]["by"]), (True, True, "lead"))


class Hold(World):
    def test_hold_keeps_a_job_queued_without_using_its_attempt(self):
        with open(self.paths["hold"], "w") as fh:
            fh.write("4102444800 held until explicit removal (test)\n")
        job_id, _ = self.enqueue(["ok"])
        runner = self.run_queue("--max-wait", "4")
        self.assertEqual(runner.wait(timeout=60), 75)
        job = self.job(job_id)
        self.assertEqual((job["state"], job["attempt"], job["pgid"]), ("queued", None, None))
        self.assertNotIn("launching", [h["state"] for h in job["history"]])
        self.assertFalse(os.path.exists(self.run_root(job_id)))
        os.unlink(self.paths["hold"])
        self.assertEqual(self.run_queue("--once", "--max-wait", "10").wait(timeout=90), 0)
        self.assertEqual(self.job(job_id)["state"], "succeeded")


class Credentials(World):
    def test_only_the_recorded_key_path_reaches_the_recipe(self):
        env_file = os.path.join(self.root, "synthetic.env")
        # Made here, so they appear in no source file the snapshot copies.
        file_secret = "synthetic-file-" + uuid.uuid4().hex
        inherited = "synthetic-inherited-" + uuid.uuid4().hex
        with open(env_file, "w") as fh:
            fh.write("TYPESAFE_API_KEY={}\n".format(file_secret))
        live, live_plan = self.enqueue(["env-dump"], live=True, env_file=env_file)
        offline, _ = self.enqueue(["env-dump"], env_file=env_file)
        self.run_queue("--max-wait", "10", env={"TYPESAFE_API_KEY": inherited, "GROQ_API_KEY": inherited,
                                                "OPENAI_API_KEY": inherited, "CARET_ENV_FILE": "/elsewhere/.env",
                                                "CARET_JEV_PROVIDER": "groq"}).wait(timeout=120)
        for job_id in (live, offline):
            self.assertEqual(self.outcome(job_id)["exit"], 0)
        with open(os.path.join(self.run_root(live), "out", "env.txt")) as fh:
            live_env = dict(line.rstrip("\n").split("=", 1) for line in fh if "=" in line)
        with open(os.path.join(self.run_root(offline), "out", "env.txt")) as fh:
            offline_env = dict(line.rstrip("\n").split("=", 1) for line in fh if "=" in line)
        self.assertEqual(live_env["CARET_ENV_FILE"], env_file)
        self.assertNotIn("CARET_ENV_FILE", offline_env)
        for env in (live_env, offline_env):
            for name in ("TYPESAFE_API_KEY", "GROQ_API_KEY", "OPENAI_API_KEY", "CARET_JEV_PROVIDER"):
                self.assertNotIn(name, env)
        hits = []
        for root, _, names in os.walk(self.root):
            for name in names:
                path = os.path.join(root, name)
                if path == env_file or os.path.islink(path):
                    continue
                with open(path, "rb") as fh:
                    data = fh.read()
                hits += [path for secret in (file_secret, inherited) if secret.encode() in data]
        self.assertEqual(hits, [])  # plans, job files, queue and runner logs, outcomes, evidence
        with open(live_plan) as fh:
            self.assertEqual(json.load(fh)["env_file"], env_file)


class VmPath(World):
    """rig-run's cleanup inside the slot, with a fake rig-run: real leases, real rig-stop, no Lume."""

    def fake_rig(self, mode, seconds):
        job_id, _ = self.enqueue(["rig", self.paths["rig_run"], mode, str(seconds)],
                                 profile=profile(lease=False, grace=20))
        self.run_queue("--once", "--max-wait", "10")
        self.assertTrue(self.wait_for(lambda: len(self.leases()) == 2, 30), self.queue_log(job_id))
        [clone] = os.listdir(self.paths["lume_clones"])
        return job_id, os.path.join(self.paths["lume_clones"], clone)

    def test_rig_run_cleanup_longer_than_the_queue_grace_finishes_inside_the_slot(self):
        job_id, clone = self.fake_rig("clean", 13)
        self.assertEqual(self.queue("cancel", "--id", job_id).returncode, 0)
        self.assertTrue(self.wait_for(lambda: self.job(job_id)["state"] == "cancelled", 20))
        # The queue has SIGKILLed the relay; the clone and leases are still being cleaned up, inside the slot.
        self.assertTrue(os.path.exists(clone))
        self.assertTrue(procs.lock_held(self.paths["slot_lock"]))
        self.assertTrue(self.wait_for(lambda: self.outcome(job_id) and "exit" in self.outcome(job_id), 60))
        outcome = self.outcome(job_id)
        self.assertTrue(any(e["event"] == "SIGTERM sent to rig-run first" for e in outcome["events"]))
        self.assertEqual(len(outcome["vm"]["rig_run_pids"]), 1)
        self.assertEqual((outcome["vm"]["clones_left"], outcome["vm"]["leases_left"]), ([], []))
        self.assertNotIn("rig_stop", outcome["vm"])  # rig-run's own trap did it
        self.assertFalse(os.path.exists(clone))
        self.assertEqual(self.leases(), [])
        self.assertTrue(self.wait_for(lambda: not procs.lock_held(self.paths["slot_lock"]), 10))
        self.assertEqual(self.marked(job_id), [])

    def test_a_rig_run_that_dies_without_cleanup_is_recovered_with_rig_stop(self):
        job_id, clone = self.fake_rig("crash", 0)
        self.assertEqual(self.queue("cancel", "--id", job_id).returncode, 0)
        self.assertTrue(self.wait_for(lambda: self.outcome(job_id) and "exit" in self.outcome(job_id), 90))
        vm = self.outcome(job_id)["vm"]
        self.assertTrue(vm["clones_after_stop"])
        self.assertEqual(len(vm["leases_after_stop"]), 2)
        self.assertTrue(vm["rig_stop"])
        self.assertEqual((vm["clones_left"], vm["leases_left"]), ([], []))
        self.assertNotIn("incomplete", vm)
        self.assertFalse(os.path.exists(clone))
        self.assertEqual(self.leases(), [])
        self.assertTrue(self.wait_for(lambda: not procs.lock_held(self.paths["slot_lock"]), 10))


@unittest.skipUnless(os.environ.get("CARET_HEAVY_VM_TEST") == "1",
                     "PENDING a VM slot: needs about 15 GiB free, HOLD released, and CARET_HEAVY_VM_TEST=1")
class RealVm(World):
    """Cancels a real rig-run VM mid-boot through the queue and checks the clone, leases and VM processes are gone.

    Uses the real rig (HOME, leases, heavy.lock, Lume, rig-golden) and the rig's own smoke job. Run it only when the
    coordinator has released HOLD and free disk clears the VM floor; it is a real heavy job.
    """

    def test_cancelling_a_booting_vm_cleans_up_inside_the_slot(self):
        real_home = os.path.expanduser("~")
        if os.path.exists(os.path.join(real_home, ".caret-run/HOLD")):
            self.skipTest("~/.caret-run/HOLD exists")
        if shutil.disk_usage(real_home).free < 15 * (1 << 30):
            self.skipTest("less than 15 GiB free")
        self.env = dict(self.env, HOME=real_home)
        rig = os.path.join(real_home, ".long-run")
        self.paths.update(lr_lease=os.path.join(rig, "bin/lr-lease"), lr_reap=os.path.join(rig, "bin/lr-reap"),
                          heavy_lock=os.path.join(rig, "locks/heavy.lock"), rig_run=os.path.join(rig, "rig/bin/rig-run"),
                          lume_clones=os.path.join(real_home, ".lume"))
        job_id, _ = self.enqueue(["rig", self.paths["rig_run"], os.path.join(rig, "rig/jobs/smoke"), "--wait", "600"],
                                 profile=profile(lease=False, grace=60, floor=15))
        self.run_queue("--once", "--max-wait", "60")
        clone = lambda: [d for d in os.listdir(self.paths["lume_clones"]) if d.startswith("rig-run-")]
        self.assertTrue(self.wait_for(lambda: clone(), 600))
        names = clone()
        self.assertEqual(self.queue("cancel", "--id", job_id).returncode, 0)
        self.assertTrue(self.wait_for(lambda: self.outcome(job_id) and "exit" in self.outcome(job_id), 300))
        vm = self.outcome(job_id)["vm"]
        self.assertNotIn("incomplete", vm)
        for name in names:
            self.assertFalse(os.path.exists(os.path.join(self.paths["lume_clones"], name)))
        self.assertFalse(any(rec.get("ownerPid") in vm["rig_run_pids"] for rec in self.leases_real()))
        self.assertFalse(procs.lock_held(self.paths["slot_lock"]))

    def leases_real(self):
        out = subprocess.run([self.paths["lr_lease"], "status"], env=self.env, capture_output=True, text=True).stdout
        return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


if __name__ == "__main__":
    unittest.main(verbosity=2)
