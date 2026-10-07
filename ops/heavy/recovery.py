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
import re
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
# The process macOS's Virtualization framework runs each VM in. launchd starts it, not the job, so it is waited for and
# never signalled.
VZ_PATTERN = "com.apple.Virtualization.VirtualMachine"
VM_NAME = re.compile(r"^rig-run-[0-9]+$")
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


def test_raise(plan, name):
    """Tests only: plan["test"]["raise_at"] names a point where the supervisor raises, as an unexpected error would;
    with plan["test"]["raise_when"], only once that path under the run root exists."""
    test = plan.get("test") or {}
    if test.get("raise_at") != name:
        return
    if test.get("raise_when") and not os.path.exists(os.path.join(plan["run_root"], test["raise_when"])):
        return
    raise RuntimeError("test: raised at {}".format(name))


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


def close_all(fds):
    for fd in fds:
        try:
            os.close(fd)
        except OSError:
            pass


class Conn:
    """The owner's side of one connection: non-blocking, bounded, and the owner of every descriptor it receives.

    Descriptors arrive with the first byte of the message that carries them (one sendmsg per message) and belong to
    the first complete message in the buffer. Whatever a message does not claim, and everything on a malformed,
    oversized, truncated or unfinished frame, is closed.
    """

    MAX_FRAME = 65536

    def __init__(self, sock):
        sock.setblocking(False)
        self.sock, self.buf, self.fds = sock, b"", []

    def pump(self):
        """Complete messages now readable, as [(message or None if malformed, descriptors)]. Raises EOFError at end
        of file and ValueError on a frame that cannot be accepted; both after closing every held descriptor."""
        try:
            data, fds, flags, _addr = socket.recv_fds(self.sock, self.MAX_FRAME, 8)
        except BlockingIOError:
            return []
        self.fds += fds
        if flags & getattr(socket, "MSG_CTRUNC", 0):
            self.discard()
            raise ValueError("truncated descriptor data")
        if not data:
            self.discard()
            raise EOFError("connection closed")
        self.buf += data
        if len(self.buf) > self.MAX_FRAME:
            self.discard()
            raise ValueError("frame too long")
        out = []
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            fds, self.fds = self.fds, []
            try:
                msg = json.loads(line)
                if not isinstance(msg, dict):
                    raise ValueError("not an object")
            except ValueError:
                close_all(fds)
                msg, fds = None, []
            out.append((msg, fds))
        return out

    def discard(self):
        close_all(self.fds)
        self.fds = []


def peer(sock):
    """(uid, pid) of the process at the other end of a local socket, from the kernel."""
    pid = struct.unpack("i", sock.getsockopt(SOL_LOCAL, LOCAL_PEERPID, 4))[0]
    cred = sock.getsockopt(SOL_LOCAL, LOCAL_PEERCRED, 76)  # struct xucred: version, uid, ngroups, groups[16]
    return struct.unpack_from("I", cred, 4)[0], pid


class JournalCorrupt(Exception):
    """A record other than the last cannot be read: refuse to act on a history with a hole in it."""


class Journal:
    """Append-only, one JSON object per line, fsync'd before anything is acknowledged. Never holds the token.

    Only the owner holding owner.lock writes it. A crash can leave the last line incomplete; load(repair=True)
    truncates that torn tail before any further append, so a record acknowledged after a restart is never hidden
    behind it. An append that fails anywhere (a short write then an error, the file's fsync, or the directory's fsync
    that makes a new journal's name durable) is not acknowledged, so it cuts the file back to where it started. If
    that cut fails too, this Journal refuses every later append until the cut succeeds, so no record ever lands
    behind one that was refused. (A crash before the cut leaves the refused record for the restarted owner, which
    then knows of a change the supervisor was told failed. An adoption, lock, lease, registration or member record
    only makes the owner hold or clean up more; a CLEAN is appended only after a fresh inventory and the lease were
    ABSENT, so replaying one releases nothing that was still there.) An unreadable line anywhere else raises
    JournalCorrupt.
    """

    def __init__(self, path):
        self.path = path
        self.cut_to = None        # the start of a failed append whose bytes may still be in the file
        self.dir_synced = False   # whether this Journal has made the file's directory entry durable

    @staticmethod
    def _cut(fd, size):
        os.ftruncate(fd, size)
        os.fsync(fd)

    def append(self, record):
        if "token" in record:
            raise ValueError("the journal never holds the token")
        line = memoryview((json.dumps(dict(record, at=utc_now()), sort_keys=True) + "\n").encode())
        fd = os.open(self.path, os.O_RDWR | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            if self.cut_to is not None:
                self._cut(fd, self.cut_to)  # raises: nothing is appended behind a refused record
                self.cut_to = None
            size = os.fstat(fd).st_size
            if size and os.pread(fd, 1, size - 1) != b"\n":
                size = os.pread(fd, size, 0).rfind(b"\n") + 1  # a torn tail left by an earlier crash
                self._cut(fd, size)
            try:
                while line:
                    line = line[os.write(fd, line):]
                os.fsync(fd)
                if not self.dir_synced:
                    dfd = os.open(os.path.dirname(self.path), os.O_RDONLY)
                    try:
                        os.fsync(dfd)
                    finally:
                        os.close(dfd)
                    self.dir_synced = True
            except BaseException:
                self.cut_to = size
                try:
                    self._cut(fd, size)
                    self.cut_to = None
                except OSError:
                    pass
                raise
        finally:
            os.close(fd)

    def load(self, repair=False):
        try:
            with open(self.path, "rb") as fh:
                data = fh.read()
        except FileNotFoundError:
            return []
        lines = data.split(b"\n")
        complete, tail = lines[:-1], lines[-1]
        out = []
        for n, line in enumerate(complete):
            try:
                out.append(json.loads(line))
            except ValueError:
                raise JournalCorrupt("{} line {} is unreadable".format(self.path, n + 1)) from None
        if tail and repair:
            fd = os.open(self.path, os.O_WRONLY)
            try:
                os.ftruncate(fd, len(data) - len(tail))
                os.fsync(fd)
            finally:
                os.close(fd)
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
    elif kind == "vm":
        # Registered by rig-run in managed mode before it clones; since is the job's start (the owner fills it in).
        if not VM_NAME.match(str(resource.get("name", ""))) or not isinstance(resource.get("since"), int):
            raise ValueError("a vm needs a rig-run-<pid> name and since (mach absolute time)")
    elif kind == "marker":
        if not str(resource.get("mark", "")).startswith(job_id + ".") or not isinstance(resource.get("since"), int):
            raise ValueError("a marker needs this job's mark and since (mach absolute time)")
    else:
        raise ValueError("unknown resource type {!r}".format(kind))
    return resource


def marked_state(probes, resource):
    """(state, [(pid, start)] or detail) of live processes started since the job that carry its marker.

    Only this user's processes can carry it, and the kernel's per-user list says which those are. One of them that
    cannot be read (usage denied, arguments unreadable while it lives) makes the answer UNKNOWN."""
    entry = "{}={}".format(procs.MARK_VAR, resource["mark"])
    found, unreadable = [], []
    try:
        for pid in probes.user_pids(os.getuid()):
            if pid == os.getpid():
                continue
            try:
                usage = probes.usage(pid)
            except PermissionError:
                unreadable.append(pid)
                continue
            if usage is None or usage[1] < resource["since"]:
                continue
            got = probes.procargs(pid)
            if got is None:
                if probes.usage(pid) is not None:
                    unreadable.append(pid)
            elif entry in got[1]:
                found.append((pid, usage[1]))
    except OSError as ex:
        return procs.UNKNOWN, "process scan failed: {}".format(ex)
    if unreadable:
        return procs.UNKNOWN, "processes of this user that cannot be read: {}".format(unreadable)
    return (procs.PRESENT, found) if found else (procs.ABSENT, [])


def vm_processes(probes, resource):
    """(state, {"lume": [(pid, start)], "virtualization": [(pid, start)]} or detail) for one rig VM.

    lume: this user's processes running `lume run NAME`. virtualization: this user's Virtualization processes started
    since the job began. During the job its cleanup-required vm lease (lr-lease vm maxCount 1) and heavy.lock keep any
    other rig VM from starting, so those are this VM's. A process of this user started since then that cannot be read
    makes the answer UNKNOWN."""
    found, unreadable = {"lume": [], "virtualization": []}, []
    try:
        for pid in probes.user_pids(os.getuid()):
            if pid == os.getpid():
                continue
            try:
                usage = probes.usage(pid)
            except PermissionError:
                unreadable.append(pid)
                continue
            if usage is None:
                continue
            got = probes.procargs(pid)
            if got is None:
                if usage[1] >= resource["since"] and probes.usage(pid) is not None:
                    unreadable.append(pid)
                continue
            argv = got[0]
            # Lume itself, or a lume script run through its interpreter (argv[1]), running this VM.
            if any(os.path.basename(arg) == "lume" for arg in argv[:2]) and "run" in argv and resource["name"] in argv:
                found["lume"].append((pid, usage[1]))
            elif argv and VZ_PATTERN in argv[0] and usage[1] >= resource["since"]:
                found["virtualization"].append((pid, usage[1]))
    except OSError as ex:
        return procs.UNKNOWN, "process scan failed: {}".format(ex)
    if unreadable:
        return procs.UNKNOWN, "processes of this user that cannot be read: {}".format(unreadable)
    return (procs.PRESENT if found["lume"] or found["virtualization"] else procs.ABSENT), found


def vm_state(probes, resource, clones_dir):
    """(ABSENT|PRESENT|UNKNOWN, detail): the VM's clone directory, its Lume process and its Virtualization processes."""
    state, found = vm_processes(probes, resource)
    if state == procs.UNKNOWN:
        return state, found
    clone = os.path.join(clones_dir, resource["name"])
    if os.path.lexists(clone) or state == procs.PRESENT:
        return procs.PRESENT, "clone {} {}; lume {}; Virtualization {}".format(
            clone, "present" if os.path.lexists(clone) else "gone", found["lume"], found["virtualization"])
    return procs.ABSENT, "no clone, Lume or Virtualization process"


def attempt_leases(lr_lease, attempt, env=None):
    """Every lease that names this attempt: obliged or taken cleanup-required for it. Raises OSError."""
    return [r for r in procs.lease_records(lr_lease, env=env) if r.get("attempt") == attempt]


def settle_attempt_leases(lr_lease, attempt, token, env=None):
    """Acknowledge every lease of this attempt (the queue's, obliged, and rig-run's vm lease in managed mode) with the
    token. (ABSENT|PRESENT|UNKNOWN, detail)."""
    try:
        leases = attempt_leases(lr_lease, attempt, env=env)
    except OSError as ex:
        return procs.UNKNOWN, str(ex)
    left = {}
    for lease in leases:
        state, detail = settle_lease(lr_lease, {"id": lease["id"], "cleanup": True}, token, attempt, env=env)
        if state != procs.ABSENT:
            left[lease["id"]] = [state, detail]
    if left:
        return (procs.UNKNOWN if any(v[0] == procs.UNKNOWN for v in left.values()) else procs.PRESENT), str(left)
    return procs.ABSENT, "settled {}".format([lease["id"] for lease in leases])


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
    try:
        if lease.get("cleanup"):
            if token is None:
                return procs.UNKNOWN, "a cleanup-required lease needs the token, which this process does not hold"
            done = subprocess.run([lr_lease, "ack", lease["id"], "--attempt", attempt], input=token + "\n",
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env, timeout=60)
        else:
            done = subprocess.run([lr_lease, "release", lease["id"]], stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env, timeout=60)
    except (OSError, subprocess.SubprocessError) as ex:
        return procs.UNKNOWN, "lease settlement failed: {!r}".format(ex)
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
        # When the supervisor was adopted and when it was seen dead (epoch ms): the window in which a lease of its
        # run, owned by it, can only have been taken for this attempt.
        self.adopted_ms = self.dead_ms = None
        self.resources, self.watches = {}, {}
        self.state = "waiting"
        self.term_at = self.next_kill = self.next_retry = None
        self.lease_renewed = time.monotonic()
        self.clients = {}

    def log(self, message):
        say("recovery", message)

    def _restore(self):
        self.adopted_ms = self.dead_ms = None
        for rec in self.journal.load(repair=True):
            ev = rec.get("event")
            if ev == "adopted":
                self.supervisor = rec["supervisor"]
                self.adopted_ms = self.adopted_ms or rec.get("since_ms")
                self.state = "custody" if self.state == "waiting" else self.state
            elif ev == "lease":
                self.lease = {"id": rec["id"], "cleanup": rec["cleanup"]}
            elif ev == "register":
                self._track(rec["resource"])
            elif ev == "members" and rec["id"] in self.watches:
                self.watches[rec["id"]].identities.update({int(p): s for p, s in rec["add"]})
            elif ev == "stopping":
                self.dead_ms = rec.get("dead_ms")
                self.state = "cleanup"
            elif ev in ("quarantined", "clean"):
                self.state = {"quarantined": "quarantined", "clean": "clean"}[ev]

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
        self._restore()  # only the holder of owner.lock reads (and may repair) the journal
        self.finished = False
        if self.state == "clean":
            if self.supervisor is None or same_process(self.probes, self.supervisor) is not True:
                self.log("journal says CLEAN; nothing to hold")
                self._bootout_self()
                return 0
            # The CLEAN reply may have died with the previous owner: answer the living supervisor again.
            self.log("journal says CLEAN; replaying it to supervisor {}".format(self.supervisor))
        if os.path.lexists(self.sock_path):
            os.unlink(self.sock_path)  # owner.lock is ours, so no live owner is listening on it
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(self.sock_path)
        os.chmod(self.sock_path, 0o600)
        listener.listen(8)
        # Only the journal's CLEAN ends custody, so a TERM does not stop the owner. But launchd's bootout sends one before
        # its SIGKILL: from then on the owner says it is terminating, so nobody hands custody to it.
        self.terminating = False

        def on_term(_signum, _frame):
            self.terminating = True
            self.log("received SIGTERM; reporting terminating until launchd stops this process")
        signal.signal(signal.SIGTERM, on_term)
        self.log("listening on {} (state {})".format(self.sock_path, self.state))
        while not self.finished:
            # Custody ends only with CLEAN: any other failure is logged and the loop carries on, holding the locks.
            try:
                readable, _, _ = select.select([listener, *self.clients], [], [], TICK)
                for sock in readable:
                    if sock is listener:
                        conn, _ = listener.accept()
                        self.clients[conn] = Conn(conn)
                    else:
                        self._serve(sock)
                self._tick()
            except Exception as ex:  # noqa: BLE001
                self.log("loop error, retrying: {!r}".format(ex))
                time.sleep(TICK)
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
        conn = self.clients[sock]
        try:
            messages = conn.pump()
        except (OSError, ValueError, EOFError) as ex:
            if not isinstance(ex, EOFError):
                self.log("dropped a connection: {!r}".format(ex))
            conn.discard()
            del self.clients[sock]
            sock.close()
            return
        for msg, fds in messages:
            claimed = []
            try:
                if msg is None:
                    raise ValueError("malformed message")
                if fds and msg.get("op") not in ("adopt", "lock"):
                    raise ValueError("{} takes no descriptors".format(msg.get("op")))
                kept = self.state != "clean"  # a CLEAN owner keeps no descriptor
                reply = self._handle(sock, msg, fds)
                claimed = fds if kept else []
            except (ValueError, KeyError, TypeError, OSError, procs.Refusal) as ex:
                reply = {"ok": False, "error": str(ex)[:500]}
            close_all([fd for fd in fds if fd not in claimed])
            try:
                sock.setblocking(True)
                sock.settimeout(5)
                send(sock, reply)
            except OSError:
                pass
            finally:
                sock.setblocking(False)

    def _from_supervisor(self, sock):
        uid, pid = peer(sock)
        return uid == os.getuid() and self.supervisor is not None and pid == self.supervisor[0]

    def _tick_groups(self):
        """Ticks every group watch and journals each newly learned identity before anything acts on it, so a
        restarted owner knows every process this one knew. Returns ({verified pids}, {resource: probe error})."""
        verified, failed = set(), {}
        # Identities a watch learned whose record has not been written yet: kept until an append succeeds, since the
        # watch reports each identity once.
        pending = self.__dict__.setdefault("pending_members", {})
        for rid, watch in self.watches.items():
            try:
                added = watch.tick()
            except OSError as ex:
                failed[rid] = ex
                continue
            if added:
                pending.setdefault(rid, []).extend(added)
            verified.update(watch.live_verified)
        for rid in list(pending):
            self.journal.append({"event": "members", "id": rid, "add": pending[rid]})
            del pending[rid]
        return verified, failed

    def _verified(self):
        """Every live process of the job's registered groups, by verified identity."""
        return self._tick_groups()[0]

    def _from_member(self, sock):
        uid, pid = peer(sock)
        return uid == os.getuid() and pid in self._verified()

    def _check_locks(self, names, fds):
        """Every descriptor is checked before any is kept: on a refusal the caller closes them all."""
        if len(names) != len(fds) or len(set(names)) != len(names):
            raise ValueError("{} lock names for {} descriptors".format(len(names), len(fds)))
        for name, fd in zip(names, fds):
            procs.inherited_lock_fd(self.paths[LOCK_PATHS[name]], fd)  # same file, and this open file holds it

    def _adopt_locks(self, names, fds):
        self._check_locks(names, fds)
        self._keep_locks(names, fds)

    def _keep_locks(self, names, fds):
        for name, fd in zip(names, fds):
            old = self.fds.pop(name, None)
            if old is not None:
                os.close(old)
            self.fds[name] = fd

    def _handle(self, sock, msg, fds):
        op = msg.get("op")
        if self.state == "clean":
            return self._replay(sock, msg)
        # Each change below is journalled first and made in memory only once that record is durable: a failed append
        # leaves the owner as it was, and _serve closes every descriptor received with the request.
        if op == "adopt":
            uid, pid = peer(sock)
            sup = msg["supervisor"]
            if uid != os.getuid() or pid != sup[0] or same_process(self.probes, sup) is not True:
                raise ValueError("adopt must come from the supervisor process it names")
            if msg["attempt"] != self.attempt:
                raise ValueError("this owner serves attempt {}".format(self.attempt))
            if self.supervisor is not None and self.supervisor != sup:
                raise ValueError("this attempt already has supervisor {}".format(self.supervisor))
            self._check_locks(msg["locks"], fds)
            since = self.adopted_ms or int(time.time() * 1000)
            self.journal.append({"event": "adopted", "supervisor": sup, "locks": sorted(set(self.fds) | set(msg["locks"])),
                                 "since_ms": since})
            self._keep_locks(msg["locks"], fds)
            self.token, self.supervisor, self.adopted_ms = msg["token"], sup, since
            if self.state == "waiting":
                self.state = "custody"
            test_point(self.plan, "recovery:after-adopt")
            return {"ok": True, "state": self.state}
        if not self._from_supervisor(sock):
            if op == "register" and self._from_member(sock):
                resource = dict(msg["resource"])
                if resource.get("type") == "vm":
                    resource["since"] = self._job_since()
                resource = check_resource(resource, self.plan["job_id"])
                if resource["type"] == "group":
                    # Only a group whose leader is a live child of one of the job's verified processes (rig.ts's
                    # held Chrome, a sibling of the register.py that asks): never a stranger's, which this owner
                    # would otherwise stop.
                    leader = resource["leader"]
                    parents = [v for v in self._verified() if leader[0] in self.probes.children(v)]
                    if same_process(self.probes, leader) is not True or not parents:
                        raise ValueError("group {} was not started by this job (its leader is no live child of the "
                                         "job's processes)".format(resource["pgid"]))
                elif resource["type"] == "vm":
                    pass  # since was filled in from the job's marker above
                elif resource["type"] != "launchd":
                    raise ValueError("a recipe registers launchd jobs, its own process groups and rig VMs only")
                return self._register(resource)
            raise ValueError("{} must come from the adopting supervisor".format(op))
        if op == "lock":
            self._check_locks([msg["name"]], fds)
            self.journal.append({"event": "lock", "name": msg["name"]})
            self._keep_locks([msg["name"]], fds)
            return {"ok": True}
        if op == "lease":
            self.journal.append({"event": "lease", "id": msg["id"], "cleanup": bool(msg["cleanup"])})
            self.lease = {"id": msg["id"], "cleanup": bool(msg["cleanup"])}
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
            if lease[0] == procs.ABSENT:
                try:
                    left = [r["id"] for r in attempt_leases(self.paths["lr_lease"], self.attempt)]
                except OSError as ex:
                    lease = (procs.UNKNOWN, str(ex))
                else:
                    lease = (procs.PRESENT, "leases of this attempt {}".format(left)) if left else lease
            if all(r[0] == procs.ABSENT for r in results.values()) and lease[0] == procs.ABSENT:
                self.journal.append({"event": "clean", "by": "supervisor", "results": results})
                self.state = "clean"
                test_point(self.plan, "recovery:after-clean")
                self.finished = True
                return {"ok": True}
            return {"ok": False, "results": results, "lease": lease}
        if op == "status":
            return {"ok": True, "state": self.state, "locks": sorted(self.fds), "token": self.token is not None,
                    "terminating": getattr(self, "terminating", False)}
        raise ValueError("unknown op {!r}".format(op))

    def _replay(self, sock, msg):
        """CLEAN is journalled: no custody is needed any more. The same attempt's supervisor may adopt (_serve closes
        its descriptors rather than keeping them), ask for an inventory of the journalled resources, and ask for
        `clean` again; that answer ends the replay. Every reply says the state is clean."""
        uid, pid = peer(sock)
        if uid != os.getuid() or self.supervisor is None or pid != self.supervisor[0]:
            raise ValueError("only this attempt's supervisor may talk to a CLEAN owner")
        if msg.get("op") == "adopt" and msg.get("attempt") != self.attempt:
            raise ValueError("this owner serves attempt {}".format(self.attempt))
        if msg.get("op") == "clean":
            self.finished = True
        if msg.get("op") == "inventory":
            return {"ok": True, "state": "clean", "results": self.inventory()}
        if msg.get("op") in ("adopt", "clean", "status"):
            return {"ok": True, "state": "clean"}
        raise ValueError("{} after CLEAN".format(msg.get("op")))

    def _job_since(self):
        """When the job's processes began (the marker's since), which bounds a VM's Virtualization processes."""
        for resource in self.resources.values():
            if resource["type"] == "marker":
                return resource["since"]
        raise ValueError("a vm can only be registered once the job's marker is")

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
        _verified, failed = self._tick_groups()
        results = {}
        for rid, resource in self.resources.items():
            kind = resource["type"]
            if kind == "group":
                results[rid] = list(self.watches[rid].state(failed.get(rid)))
            elif kind == "launchd":
                results[rid] = list(procs.launchd_state(resource["label"]))
            elif kind == "launchd-prefix":
                results[rid] = list(launchd_prefix_state(resource["prefix"]))
            elif kind == "vm":
                results[rid] = list(vm_state(self.probes, resource, self.paths["lume_clones"]))
            else:
                state, pids = marked_state(self.probes, resource)
                results[rid] = [state, pids if isinstance(pids, str) else "pids {}".format([p for p, _ in pids])]
        return results

    def _tick(self):
        if self.state == "clean":
            if self.supervisor is None or same_process(self.probes, self.supervisor) is False:
                self.finished = True
            return
        self._tick_groups()
        if self.state == "custody" and self.supervisor is not None \
                and same_process(self.probes, self.supervisor) is False:
            self.dead_ms = int(time.time() * 1000)
            self.journal.append({"event": "stopping", "reason": "the supervisor died", "dead_ms": self.dead_ms})
            self.state = "cleanup"
            self.log("the supervisor {} died; adopting cleanup".format(self.supervisor))
        if self.state in ("cleanup", "quarantined") and (self.supervisor is None
                                                          or same_process(self.probes, self.supervisor) is False):
            self._cleanup_step()
        self._renew_if_due()

    def _stop(self, sig):
        """One stop pass over every resource. A failure stops nothing else: it is logged, and the inventory that
        follows reports what is still there (UNKNOWN when it cannot tell)."""
        for rid, resource in self.resources.items():
            kind = resource["type"]
            try:
                if kind == "group":
                    self.watches[rid].signal(sig)
                elif kind == "marker":
                    state, found = marked_state(self.probes, resource)
                    if state == procs.PRESENT:
                        signal_identities(self.probes, found, sig)
                elif kind == "vm":
                    self._stop_vm(resource, sig)
                else:
                    labels = [resource["label"]] if kind == "launchd" else \
                        [label for label, _ in procs.launchd_jobs(resource["prefix"])]
                    for label in labels:
                        procs.launchd_bootout(label)
            except Exception as ex:  # noqa: BLE001 - the owner must outlive any one failed stop
                self.log("stopping {} failed: {!r}".format(rid, ex))

    def _stop_vm(self, resource, sig):
        """Its Lume process by verified identity; never Virtualization (launchd's). A clone left once Lume is gone goes
        to the rig's own recovery, rig-stop --orphans, on the SIGKILL rounds."""
        state, found = vm_processes(self.probes, resource)
        if state == procs.PRESENT:
            signal_identities(self.probes, found["lume"], sig)
        if sig == signal.SIGKILL and state != procs.UNKNOWN and not found["lume"] \
                and os.path.lexists(os.path.join(self.paths["lume_clones"], resource["name"])):
            done = subprocess.run([self.paths["rig_stop"], "--orphans", "--grace", "15"], stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)
            self.log("rig-stop --orphans for {} exited {}: {}".format(resource["name"], done.returncode,
                                                                    done.stdout.strip()[-300:]))

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
            settled, reconciled = self._settle_all()
            if all(state == procs.ABSENT for state, _ in settled.values()):
                self.journal.append({"event": "clean", "by": "recovery", "results": results,
                                     "lease": list(settled.get(self.lease["id"], ["ABSENT", "none"]) if self.lease
                                                   else ["ABSENT", "no lease"]),
                                     "reconciled": reconciled})
                self.state = "clean"
                self.finished = True
                return
            results.update({"lease " + lid: list(v) for lid, v in settled.items()})
        if now - self.term_at >= grace and (self.next_kill is None or now >= self.next_kill):
            self._stop(signal.SIGKILL)
            self.next_kill = now + (1.0 if self.state == "cleanup" else RETRY_QUARANTINE_S)
        if self.state == "cleanup" and now - self.term_at >= grace + QUARANTINE_AFTER_S:
            self.journal.append({"event": "quarantined", "by": "recovery", "results": results})
            self.state = "quarantined"
            self.log("QUARANTINED: {}".format(results))

    def _orphan_leases(self):
        """Leases this attempt took that the owner was never told about: the supervisor died between lr-lease
        creating one and the owner journalling it. With the vendored lr-lease a lease names its attempt; otherwise it
        is one of this job's run, owned by the dead supervisor, created between its adoption and its death. Raises
        OSError when lr-lease status cannot say."""
        known = {self.lease["id"]} if self.lease else set()
        out = []
        for rec in procs.lease_records(self.paths["lr_lease"]):
            if rec["id"] in known:
                continue
            if rec.get("attempt") == self.attempt:
                out.append({"id": rec["id"], "cleanup": True})
            elif (self.supervisor is not None and rec.get("ownerPid") == self.supervisor[0]
                  and rec.get("run") == self.plan["lease"]["run"] and not rec.get("cleanupRequired")
                  and self.adopted_ms is not None and self.dead_ms is not None
                  and self.adopted_ms <= rec.get("createdAt", -1) <= self.dead_ms):
                out.append({"id": rec["id"], "cleanup": False})
        return out

    def _settle_all(self):
        """{lease id: (state, detail)} after settling this job's lease and any it never heard of, and the ids of the
        latter. An unreadable lease list is UNKNOWN."""
        leases = [self.lease] if self.lease else []
        try:
            extra = self._orphan_leases()
        except OSError as ex:
            return {"(lease list)": (procs.UNKNOWN, str(ex))}, []
        settled = {lease["id"]: settle_lease(self.paths["lr_lease"], lease, self.token, self.attempt)
                   for lease in leases + extra}
        return settled, [lease["id"] for lease in extra]

    def _renew_if_due(self):
        """Alone, a cleanup-required lease is renewed by token, so mem-guard keeps seeing it while cleanup runs."""
        if not self.lease or not self.lease["cleanup"] or self.token is None or self.state == "custody":
            return
        if time.monotonic() - self.lease_renewed < self.plan["lease"]["renew_s"]:
            return
        self.lease_renewed = time.monotonic()
        try:
            subprocess.run([self.paths["lr_lease"], "renew", self.lease["id"], "--attempt", self.attempt,
                            "--ttl", str(self.plan["lease"]["ttl_min"])], input=self.token + "\n",
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True, timeout=60)
        except (OSError, subprocess.SubprocessError) as ex:
            self.log("lease renewal failed: {!r}".format(ex))


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
        self.io_timeout = 10.0  # a stalled owner is UNKNOWN, never a hang of the supervisor's watch
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
        self.plist = os.path.join(self.dir, self.label + ".plist")
        with open(self.plist, "wb") as fh:
            plistlib.dump(plist, fh)
        self._bootstrap()
        self.locks = dict(locks)
        self._connect_and_adopt(deadline=30)

    def _bootstrap(self):
        done = subprocess.run(["/bin/launchctl", "bootstrap", "gui/{}".format(os.getuid()), self.plist],
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                              timeout=60)
        if done.returncode != 0:
            raise CustodyError("launchctl bootstrap {} exited {}: {}".format(self.label, done.returncode, done.stdout.strip()))

    def _ensure_loaded(self):
        """An owner whose launchd job is gone (booted out, not just crashed) is started again from its plist."""
        if procs.launchd_state(self.label)[0] == procs.ABSENT:
            self.log("the recovery owner {} is not loaded; starting it again".format(self.label))
            self._bootstrap()

    def _agent_pid(self):
        """The agent's pid as launchd reports it, or None (also when launchctl fails or takes over 20 s)."""
        try:
            out = subprocess.run(["/bin/launchctl", "print", "gui/{}/{}".format(os.getuid(), self.label)],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                                 timeout=20).stdout
        except (OSError, subprocess.SubprocessError):
            return None
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
                sock.settimeout(self.io_timeout)
                sock.connect(self.sock_path)
                uid, pid = peer(sock)
                if uid != os.getuid() or pid != self._agent_pid():
                    sock.close()
                    raise CustodyError("the socket's peer {} is not the {} agent".format(pid, self.label))
                self._attach(sock)
                names = sorted(self.locks)
                reply = self._exchange({"op": "adopt", "attempt": self.attempt, "token": self.token,
                                        "supervisor": self.me, "locks": names}, [self.locks[n] for n in names])
                if not reply.get("ok"):
                    raise CustodyError("adoption refused: {}".format(reply.get("error")))
                return reply
            except (OSError, CustodyError) as ex:
                last = ex
                self.sock = self.reader = None
                try:
                    self._ensure_loaded()
                except (OSError, CustodyError, subprocess.SubprocessError) as again:
                    last = again
                time.sleep(0.2)
        raise CustodyError("no adoption by {} within {} s: {!r}".format(self.label, deadline, last))

    def _attach(self, sock):
        sock.settimeout(self.io_timeout)
        self.sock, self.reader = sock, Reader(sock)

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
