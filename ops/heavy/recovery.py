"""The recovery owner: a launchd agent that holds copies of a job's locked descriptors and its
resource inventory, so that cleanup survives the death of the supervisor (Astra's design,
~/.caret-run/design/ops/ASTRA-Q3-design.md, section 2).

Why a launchd agent. It must live outside both the queue's process group and the supervisor's
process tree, so that neither the queue's SIGKILL nor mem-guard's tree escalation reaches it. One
agent runs per job attempt, labelled caret-heavy-recovery.<job>.<attempt prefix>, with KeepAlive on
an unsuccessful exit, so launchd restarts it within about a second after a crash.

Custody. The supervisor starts the agent, connects to its Unix socket, and sends copies of the
locked slot.lock and heavy.lock descriptors with SCM_RIGHTS, plus the attempt's secret token,
before any workload starts. The agent checks each descriptor holds its lock and replies only after
the adoption is in its journal. Reopening the lock files would not be a transfer, so nothing else
counts. A restarted agent has lost its descriptors and token; the supervisor, if alive, adopts it
again. If every holder dies while a resource survives, nothing here keeps the kernel locks; the
cleanup-required lease (vendor/long-run, pending install) is what keeps the exclusion rule then.

Resources are registered explicitly, before each is started, and the agent journals each
registration (fsync) before it acknowledges. Group resources are tracked by identity
(procs.GroupWatch); launchd resources by exact label, which must start with the job's own prefix.
With the recipe's group the supervisor also registers the job's environment marker and its launchd
label prefix, so a process that left the group and lost its parent, or a launchd job nobody
registered, still counts as PRESENT and is stopped. The journal never holds the token.

The supervisor alive: it stops what it started, asks the agent for an inventory, settles the lease
when every resource is ABSENT, and tells the agent `clean`; the agent checks again, journals CLEAN,
closes its descriptors and exits 0. The supervisor dead (its identity gone): the agent stops the
registered resources itself (SIGTERM, the grace, then SIGKILL every second, by verified identity
only; launchd jobs are booted out), inventories them, settles the lease and exits CLEAN. Anything
PRESENT or UNKNOWN after the grace and a further minute is QUARANTINED: journalled, the
descriptors kept, the stop and inventory retried every 15 s. A deadline decides when to quarantine,
never when to release.
"""

import fcntl
import hashlib
import json
import os
import plistlib
import select
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time

import procs

SOL_LOCAL, LOCAL_PEERCRED, LOCAL_PEERPID = 0, 0x001, 0x002
TICK = 0.5
QUARANTINE_AFTER_S = 60
RETRY_QUARANTINE_S = 15
LOCK_PATHS = {"slot": "slot_lock", "heavy": "heavy_lock"}


def utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def say(role, message):
    print("{} caret-heavy {}: {}".format(utc_now(), role, message), file=sys.stderr, flush=True)


def label_for(job_id, attempt):
    return "caret-heavy-recovery.{}.{}".format(job_id, attempt[:8])


def test_point(plan, name):
    """Tests only: plan["test"]["kill_at"] names a point where this process SIGKILLs itself, once per job (a
    restarted recovery owner passes the same point again)."""
    if (plan.get("test") or {}).get("kill_at") != name:
        return
    fired = os.path.join(plan["run_root"], "test-point-fired")
    try:
        os.close(os.open(fired, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
    except FileExistsError:
        return
    say("test", "SIGKILL at {}".format(name))
    os.kill(os.getpid(), signal.SIGKILL)


def identity(probes, pid):
    usage = probes.usage(pid)
    return None if usage is None else [pid, usage[1]]


def same_process(probes, ident):
    """True, False, or None when a permission error hides it."""
    try:
        usage = probes.usage(ident[0])
    except PermissionError:
        return None
    return usage is not None and usage[1] == ident[1]


# Wire: one JSON object per line. Descriptors ride on the message that needs them (SCM_RIGHTS).


def send(sock, obj, fds=()):
    data = (json.dumps(obj) + "\n").encode()
    if fds:
        socket.send_fds(sock, [data], list(fds))
    else:
        sock.sendall(data)


class Reader:
    def __init__(self, sock):
        self.sock, self.buf, self.fds = sock, b"", []

    def read(self):
        """(message, descriptors), or None at end of file."""
        while b"\n" not in self.buf:
            data, fds, _flags, _addr = socket.recv_fds(self.sock, 65536, 8)
            self.fds += fds
            if not data:
                return None
            self.buf += data
        line, self.buf = self.buf.split(b"\n", 1)
        fds, self.fds = self.fds, []
        return json.loads(line), fds


def peer(sock):
    """(uid, pid) of the process at the other end of a local socket, from the kernel."""
    pid = struct.unpack("i", sock.getsockopt(SOL_LOCAL, LOCAL_PEERPID, 4))[0]
    cred = sock.getsockopt(SOL_LOCAL, LOCAL_PEERCRED, 76)  # struct xucred: version, uid, ngroups, groups[16]
    return struct.unpack_from("I", cred, 4)[0], pid


class Journal:
    """Append-only, one JSON object per line, fsync'd before anything is acknowledged. Never holds the token."""

    def __init__(self, path):
        self.path = path

    def append(self, record):
        if "token" in record:
            raise ValueError("the journal never holds the token")
        line = (json.dumps(dict(record, at=utc_now()), sort_keys=True) + "\n").encode()
        new = not os.path.exists(self.path)
        fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, line)
            os.fsync(fd)
        finally:
            os.close(fd)
        if new:
            dfd = os.open(os.path.dirname(self.path), os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)

    def load(self):
        try:
            with open(self.path, "rb") as fh:
                lines = fh.read().split(b"\n")
        except FileNotFoundError:
            return []
        out = []
        for line in lines:
            if line.strip():
                try:
                    out.append(json.loads(line))
                except ValueError:
                    break  # a torn last line from a crash mid-append: everything before it stands
        return out


def check_resource(resource, job_id):
    """The resource dict, validated; raises ValueError."""
    kind = resource.get("type")
    if not isinstance(resource.get("id"), str) or not resource["id"]:
        raise ValueError("a resource needs an id")
    if kind == "group":
        pgid, leader = resource.get("pgid"), resource.get("leader")
        if not (isinstance(pgid, int) and pgid > 1 and isinstance(leader, list) and len(leader) == 2
                and leader[0] == pgid and isinstance(leader[1], int)):
            raise ValueError("a group needs pgid and leader [pgid, start]")
    elif kind == "launchd":
        prefix = "caret-heavy.{}.".format(job_id)
        if not str(resource.get("label", "")).startswith(prefix):
            raise ValueError("a launchd label must start with {}".format(prefix))
    elif kind == "launchd-prefix":
        if resource.get("prefix") != "caret-heavy.{}.".format(job_id):
            raise ValueError("the launchd prefix must be this job's own")
    elif kind == "marker":
        if not str(resource.get("mark", "")).startswith(job_id + ".") or not isinstance(resource.get("since"), int):
            raise ValueError("a marker needs this job's mark and since (mach absolute time)")
    else:
        raise ValueError("unknown resource type {!r}".format(kind))
    return resource


def marked_state(probes, resource):
    """(state, [(pid, start)] or detail) of live processes started since the job that carry its marker."""
    entry = "{}={}".format(procs.MARK_VAR, resource["mark"])
    found = []
    try:
        for pid in probes.all_pids():
            if pid == os.getpid():
                continue
            try:
                usage = probes.usage(pid)
            except PermissionError:
                continue  # another user's process cannot carry an environment this job set
            if usage is None or usage[1] < resource["since"]:
                continue
            got = probes.procargs(pid)
            if got is not None and entry in got[1]:
                found.append((pid, usage[1]))
    except OSError as ex:
        return procs.UNKNOWN, "process scan failed: {}".format(ex)
    return (procs.PRESENT, found) if found else (procs.ABSENT, [])


def signal_identities(probes, identities, sig):
    sent = []
    for pid, start in identities:
        if same_process(probes, [pid, start]) is True:
            try:
                os.kill(pid, sig)
                sent.append(pid)
            except OSError:
                pass
    return sent


def launchd_prefix_state(prefix):
    try:
        labels = [label for label, _ in procs.launchd_jobs(prefix)]
    except (OSError, subprocess.SubprocessError) as ex:
        return procs.UNKNOWN, "launchctl print failed: {!r}".format(ex)
    return (procs.PRESENT, "labels {}".format(labels)) if labels else (procs.ABSENT, "no labels")


def settle_lease(lr_lease, lease, token, attempt, env=None):
    """Release or acknowledge the job's lease, then confirm it is gone. (ABSENT|PRESENT|UNKNOWN, detail)."""
    if lease is None:
        return procs.ABSENT, "no lease"
    state, detail = procs.lease_state(lr_lease, lease["id"], env=env)
    if state != procs.PRESENT:
        return state, detail
    if lease.get("cleanup"):
        if token is None:
            return procs.UNKNOWN, "a cleanup-required lease needs the token, which this process does not hold"
        done = subprocess.run([lr_lease, "ack", lease["id"], "--attempt", attempt], input=token + "\n",
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    else:
        done = subprocess.run([lr_lease, "release", lease["id"]], stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    if done.returncode != 0:
        return procs.UNKNOWN, "lease settlement exited {}: {}".format(done.returncode, done.stdout.strip()[:200])
    return procs.lease_state(lr_lease, lease["id"], env=env)


# The agent


class Owner:
    def __init__(self, plan, attempt, sock_path, probes=None):
        self.plan, self.attempt, self.sock_path = plan, attempt, sock_path
        self.paths, self.profile = plan["paths"], plan["profile"]
        self.probes = probes or procs.DarwinProbes()
        self.dir = os.path.join(plan["run_root"], "recovery")
        self.journal = Journal(os.path.join(self.dir, "journal.ndjson"))
        self.label = label_for(plan["job_id"], attempt)
        self.fds, self.token = {}, None
        self.lease, self.supervisor = None, None
        self.resources, self.watches = {}, {}
        self.state = "waiting"
        self.term_at = self.next_kill = self.next_retry = None
        self.lease_renewed = time.monotonic()
        self.clients = {}
        self._restore()

    def log(self, message):
        say("recovery", message)

    def _restore(self):
        for rec in self.journal.load():
            ev = rec.get("event")
            if ev == "adopted":
                self.supervisor = rec["supervisor"]
                self.state = "custody" if self.state == "waiting" else self.state
            elif ev == "lease":
                self.lease = {"id": rec["id"], "cleanup": rec["cleanup"]}
            elif ev == "register":
                self._track(rec["resource"])
            elif ev == "members" and rec["id"] in self.watches:
                self.watches[rec["id"]].identities.update({int(p): s for p, s in rec["add"]})
            elif ev in ("stopping", "quarantined", "clean"):
                self.state = {"stopping": "cleanup", "quarantined": "quarantined", "clean": "clean"}[ev]

    def _track(self, resource):
        self.resources[resource["id"]] = resource
        if resource["type"] == "group":
            self.watches[resource["id"]] = procs.GroupWatch(self.probes, resource["pgid"], resource["leader"])

    def run(self):
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        lock = os.open(os.path.join(self.dir, "owner.lock"), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.log("another recovery owner holds this job; exiting")
            return 0
        if self.state == "clean":
            self.log("journal says CLEAN; nothing to hold")
            self._bootout_self()
            return 0
        if os.path.lexists(self.sock_path):
            os.unlink(self.sock_path)  # owner.lock is ours, so no live owner is listening on it
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(self.sock_path)
        os.chmod(self.sock_path, 0o600)
        listener.listen(8)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)  # only the journal's CLEAN ends custody, never a stray TERM
        self.log("listening on {} (state {})".format(self.sock_path, self.state))
        while self.state != "clean":
            readable, _, _ = select.select([listener, *self.clients], [], [], TICK)
            for sock in readable:
                if sock is listener:
                    conn, _ = listener.accept()
                    self.clients[conn] = Reader(conn)
                else:
                    self._serve(sock)
            self._tick()
        for fd in self.fds.values():
            os.close(fd)
        self.fds = {}
        listener.close()
        os.unlink(self.sock_path)
        try:
            os.rmdir(os.path.dirname(self.sock_path))  # the supervisor's private directory for this socket
        except OSError:
            pass
        self.log("CLEAN; descriptors closed")
        if self.supervisor is None or same_process(self.probes, self.supervisor) is not True:
            self._bootout_self()
        return 0

    def _bootout_self(self):
        subprocess.Popen(["/bin/launchctl", "bootout", "gui/{}/{}".format(os.getuid(), self.label)],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)

    # Requests

    def _serve(self, sock):
        try:
            got = self.clients[sock].read()
        except (OSError, ValueError) as ex:
            got = None
            self.log("dropped a connection: {!r}".format(ex))
        if got is None:
            del self.clients[sock]
            sock.close()
            return
        msg, fds = got
        try:
            reply = self._handle(sock, msg, fds)
        except (ValueError, KeyError, TypeError, OSError, procs.Refusal) as ex:
            for fd in fds:
                os.close(fd)
            reply = {"ok": False, "error": str(ex)[:500]}
        try:
            send(sock, reply)
        except OSError:
            pass

    def _from_supervisor(self, sock):
        uid, pid = peer(sock)
        return uid == os.getuid() and self.supervisor is not None and pid == self.supervisor[0]

    def _verified(self):
        """Every live process of the job's registered groups, by verified identity."""
        verified = set()
        for watch in self.watches.values():
            try:
                watch.tick()
            except OSError:
                continue
            verified.update(watch.live_verified)
        return verified

    def _from_member(self, sock):
        uid, pid = peer(sock)
        return uid == os.getuid() and pid in self._verified()

    def _adopt_locks(self, names, fds):
        if len(names) != len(fds) or len(set(names)) != len(names):
            raise ValueError("{} lock names for {} descriptors".format(len(names), len(fds)))
        # Every descriptor is checked before any is kept: on a refusal the caller closes them all.
        for name, fd in zip(names, fds):
            procs.inherited_lock_fd(self.paths[LOCK_PATHS[name]], fd)  # same file, and this open file holds it
        for name, fd in zip(names, fds):
            old = self.fds.pop(name, None)
            if old is not None:
                os.close(old)
            self.fds[name] = fd

    def _handle(self, sock, msg, fds):
        op = msg.get("op")
        if op == "adopt":
            uid, pid = peer(sock)
            sup = msg["supervisor"]
            if uid != os.getuid() or pid != sup[0] or same_process(self.probes, sup) is not True:
                raise ValueError("adopt must come from the supervisor process it names")
            if msg["attempt"] != self.attempt:
                raise ValueError("this owner serves attempt {}".format(self.attempt))
            if self.supervisor is not None and self.supervisor != sup:
                raise ValueError("this attempt already has supervisor {}".format(self.supervisor))
            self._adopt_locks(msg["locks"], fds)
            self.token, self.supervisor = msg["token"], sup
            self.journal.append({"event": "adopted", "supervisor": sup, "locks": sorted(self.fds)})
            if self.state == "waiting":
                self.state = "custody"
            test_point(self.plan, "recovery:after-adopt")
            return {"ok": True, "state": self.state}
        if not self._from_supervisor(sock):
            if op == "register" and self._from_member(sock):
                resource = check_resource(dict(msg["resource"]), self.plan["job_id"])
                if resource["type"] == "group":
                    # Only a group whose leader is a live child of one of the job's verified processes (rig.ts's
                    # held Chrome, a sibling of the register.py that asks): never a stranger's, which this owner
                    # would otherwise stop.
                    leader = resource["leader"]
                    parents = [v for v in self._verified() if leader[0] in self.probes.children(v)]
                    if same_process(self.probes, leader) is not True or not parents:
                        raise ValueError("group {} was not started by this job (its leader is no live child of the "
                                         "job's processes)".format(resource["pgid"]))
                elif resource["type"] != "launchd":
                    raise ValueError("a recipe registers launchd jobs and its own process groups only")
                return self._register(resource)
            raise ValueError("{} must come from the adopting supervisor".format(op))
        if op == "lock":
            self._adopt_locks([msg["name"]], fds)
            self.journal.append({"event": "lock", "name": msg["name"]})
            return {"ok": True}
        if op == "lease":
            self.lease = {"id": msg["id"], "cleanup": bool(msg["cleanup"])}
            self.journal.append({"event": "lease", "id": msg["id"], "cleanup": bool(msg["cleanup"])})
            return {"ok": True}
        if op == "register":
            return self._register(check_resource(dict(msg["resource"]), self.plan["job_id"]))
        if op == "inventory":
            return {"ok": True, "results": self.inventory()}
        if op == "quarantine":
            if self.state != "quarantined":
                self.journal.append({"event": "quarantined", "by": "supervisor", "results": msg.get("results")})
                self.state = "quarantined"
            return {"ok": True}
        if op == "clean":
            results = self.inventory()
            lease = procs.lease_state(self.paths["lr_lease"], self.lease["id"]) if self.lease else (procs.ABSENT, "none")
            if all(r[0] == procs.ABSENT for r in results.values()) and lease[0] == procs.ABSENT:
                self.journal.append({"event": "clean", "by": "supervisor", "results": results})
                self.state = "clean"
                return {"ok": True}
            return {"ok": False, "results": results, "lease": lease}
        if op == "status":
            return {"ok": True, "state": self.state, "locks": sorted(self.fds), "token": self.token is not None}
        raise ValueError("unknown op {!r}".format(op))

    def _register(self, resource):
        if resource["id"] in self.resources:
            if self.resources[resource["id"]] != resource:
                raise ValueError("resource {} is already registered differently".format(resource["id"]))
            return {"ok": True, "duplicate": True}
        if self.state not in ("custody",):
            raise ValueError("no new resources while {}".format(self.state))
        self.journal.append({"event": "register", "resource": resource})
        self._track(resource)
        test_point(self.plan, "recovery:after-register")
        return {"ok": True}

    # Inventory and cleanup

    def inventory(self):
        results = {}
        for rid, resource in self.resources.items():
            kind = resource["type"]
            if kind == "group":
                results[rid] = list(self.watches[rid].inventory())
            elif kind == "launchd":
                results[rid] = list(procs.launchd_state(resource["label"]))
            elif kind == "launchd-prefix":
                results[rid] = list(launchd_prefix_state(resource["prefix"]))
            else:
                state, pids = marked_state(self.probes, resource)
                results[rid] = [state, pids if isinstance(pids, str) else "pids {}".format([p for p, _ in pids])]
        return results

    def _tick(self):
        for rid, watch in self.watches.items():
            try:
                added = watch.tick()
            except OSError:
                continue
            if added:
                self.journal.append({"event": "members", "id": rid, "add": added})
        if self.state == "custody" and self.supervisor is not None \
                and same_process(self.probes, self.supervisor) is False:
            self.journal.append({"event": "stopping", "reason": "the supervisor died"})
            self.state = "cleanup"
            self.log("the supervisor {} died; adopting cleanup".format(self.supervisor))
        if self.state in ("cleanup", "quarantined") and (self.supervisor is None
                                                          or same_process(self.probes, self.supervisor) is False):
            self._cleanup_step()
        self._renew_if_due()

    def _stop(self, sig):
        for rid, resource in self.resources.items():
            kind = resource["type"]
            if kind == "group":
                self.watches[rid].signal(sig)
            elif kind == "marker":
                state, found = marked_state(self.probes, resource)
                if state == procs.PRESENT:
                    signal_identities(self.probes, found, sig)
            else:
                labels = [resource["label"]] if kind == "launchd" else \
                    [label for label, _ in procs.launchd_jobs(resource["prefix"])]
                for label in labels:
                    procs.launchd_bootout(label)

    def _cleanup_step(self):
        now = time.monotonic()
        grace = self.profile["term_grace_s"]
        if self.term_at is None:
            self.term_at = now
            self._stop(signal.SIGTERM)
            self.log("SIGTERM sent to registered resources")
            return
        results = self.inventory()
        if all(r[0] == procs.ABSENT for r in results.values()):
            lease = settle_lease(self.paths["lr_lease"], self.lease, self.token, self.attempt)
            if lease[0] == procs.ABSENT:
                self.journal.append({"event": "clean", "by": "recovery", "results": results, "lease": list(lease)})
                self.state = "clean"
                return
            results["lease"] = list(lease)
        if now - self.term_at >= grace and (self.next_kill is None or now >= self.next_kill):
            self._stop(signal.SIGKILL)
            self.next_kill = now + (1.0 if self.state == "cleanup" else RETRY_QUARANTINE_S)
        if self.state == "cleanup" and now - self.term_at >= grace + QUARANTINE_AFTER_S:
            self.journal.append({"event": "quarantined", "by": "recovery", "results": results})
            self.state = "quarantined"
            self.log("QUARANTINED: {}".format(results))

    def _renew_if_due(self):
        """Alone, a cleanup-required lease is renewed by token, so mem-guard keeps seeing it while cleanup runs."""
        if not self.lease or not self.lease["cleanup"] or self.token is None or self.state == "custody":
            return
        if time.monotonic() - self.lease_renewed < self.plan["lease"]["renew_s"]:
            return
        self.lease_renewed = time.monotonic()
        subprocess.run([self.paths["lr_lease"], "renew", self.lease["id"], "--attempt", self.attempt,
                        "--ttl", str(self.plan["lease"]["ttl_min"])], input=self.token + "\n",
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)


def main(plan, argv):
    import argparse
    parser = argparse.ArgumentParser(prog="recover")
    parser.add_argument("--socket", required=True)
    parser.add_argument("--attempt", required=True)
    args = parser.parse_args(argv)
    return Owner(plan, args.attempt, args.socket).run()


# The supervisor's side


class CustodyError(Exception):
    pass


class Custody:
    """The supervisor's connection to its recovery owner."""

    def __init__(self, plan, plan_path, plan_digest, attempt, token, probes, log):
        self.plan, self.plan_path, self.plan_digest = plan, plan_path, plan_digest
        self.attempt, self.token, self.probes, self.log = attempt, token, probes, log
        self.label = label_for(plan["job_id"], attempt)
        self.dir = os.path.join(plan["run_root"], "recovery")
        # A socket path must fit sun_path (104 bytes): a private directory under /tmp.
        self.sock_dir = tempfile.mkdtemp(prefix="chr.", dir="/tmp")
        self.sock_path = os.path.join(self.sock_dir, "s")
        self.sock = self.reader = None
        self.locks = {}  # name -> fd, resent on every adoption
        self.me = identity(probes, os.getpid())

    def start(self, locks):
        import caret_heavy
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        argv = caret_heavy.boot_argv(self.plan["python"], self.plan_path, self.plan_digest, "recover",
                                     "--socket", self.sock_path, "--attempt", self.attempt)
        plist = {"Label": self.label, "ProgramArguments": argv, "RunAtLoad": True,
                 "KeepAlive": {"SuccessfulExit": False}, "ThrottleInterval": 1,
                 "EnvironmentVariables": {"HOME": os.path.expanduser("~"),
                                          "PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"},
                 "StandardErrorPath": os.path.join(self.dir, "recovery.log"),
                 "StandardOutPath": os.path.join(self.dir, "recovery.log"),
                 "WorkingDirectory": self.dir, "ProcessType": "Background"}
        path = os.path.join(self.dir, self.label + ".plist")
        with open(path, "wb") as fh:
            plistlib.dump(plist, fh)
        done = subprocess.run(["/bin/launchctl", "bootstrap", "gui/{}".format(os.getuid()), path],
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if done.returncode != 0:
            raise CustodyError("launchctl bootstrap {} exited {}: {}".format(self.label, done.returncode, done.stdout.strip()))
        self.locks = dict(locks)
        self._connect_and_adopt(deadline=30)

    def _agent_pid(self):
        out = subprocess.run(["/bin/launchctl", "print", "gui/{}/{}".format(os.getuid(), self.label)],
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True).stdout
        for line in out.splitlines():
            if line.strip().startswith("pid = "):
                return int(line.split("=")[1])
        return None

    def _connect_and_adopt(self, deadline):
        end = time.monotonic() + deadline
        last = None
        while time.monotonic() < end:
            try:
                sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                sock.connect(self.sock_path)
                uid, pid = peer(sock)
                if uid != os.getuid() or pid != self._agent_pid():
                    sock.close()
                    raise CustodyError("the socket's peer {} is not the {} agent".format(pid, self.label))
                self.sock, self.reader = sock, Reader(sock)
                names = sorted(self.locks)
                reply = self._exchange({"op": "adopt", "attempt": self.attempt, "token": self.token,
                                        "supervisor": self.me, "locks": names}, [self.locks[n] for n in names])
                if not reply.get("ok"):
                    raise CustodyError("adoption refused: {}".format(reply.get("error")))
                return reply
            except (OSError, CustodyError) as ex:
                last = ex
                self.sock = self.reader = None
                time.sleep(0.2)
        raise CustodyError("no adoption by {} within {} s: {!r}".format(self.label, deadline, last))

    def _exchange(self, msg, fds=()):
        send(self.sock, msg, fds)
        got = self.reader.read()
        if got is None:
            raise ConnectionError("the recovery owner closed the connection")
        return got[0]

    def request(self, msg, fds=(), reconnect_s=30):
        """One request. If the agent died (launchd restarts it), adopt the new one and send the request again."""
        for attempt in (1, 2):
            try:
                if self.sock is None:
                    raise ConnectionError("not connected")
                return self._exchange(msg, fds)
            except (OSError, ValueError) as ex:
                if attempt == 2:
                    raise CustodyError("the recovery owner is unavailable: {!r}".format(ex))
                self.log("recovery owner connection lost ({!r}); adopting again".format(ex))
                self.sock = self.reader = None
                self._connect_and_adopt(deadline=reconnect_s)

    def add_lock(self, name, fd):
        self.locks[name] = fd
        reply = self.request({"op": "lock", "name": name}, [fd])
        if not reply.get("ok"):
            raise CustodyError("lock {} not adopted: {}".format(name, reply.get("error")))

    def must(self, msg):
        reply = self.request(msg)
        if not reply.get("ok"):
            raise CustodyError("{} refused: {}".format(msg.get("op"), reply.get("error") or reply))
        return reply

    def finish(self):
        """After the agent has journalled CLEAN: remove its launchd job and the socket directory."""
        if self.sock is not None:
            self.sock.close()
            self.sock = None
        subprocess.run(["/bin/launchctl", "bootout", "gui/{}/{}".format(os.getuid(), self.label)],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            os.rmdir(self.sock_dir)
        except OSError:
            pass


def token_sha256(token):
    return hashlib.sha256(token.encode()).hexdigest()
