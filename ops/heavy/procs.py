"""Process probes and ownership tracking for the Caret heavy-job supervisor.

The probes (DarwinProbes, lock_held, inherited_lock_fd) and the start-time-checked descendant walk
are adapted from OpenInstinct's scripts/acceptance/supervise.py (Merit-Systems/OpenInstinct,
commit 0124d0f), which runs under the same shared heavy-job queue. Changes: the descendant walk
covers several process groups, not just the supervisor's own; procargs() reads a process's
environment as well as its argv; Tracker adds the job's environment marker and launchd label
prefix, so processes that left every tracked group and lost their parent are still found.

A process is owned by the job when any of these holds:
- it is a member of a process group the supervisor created for the job (recorded pgids);
- it is a child of an owned process (walked every sample, recorded by pid and start time);
- it started after the job and its environment carries the job's marker (CARET_HEAVY_MARK);
- it is the pid of a launchd job whose label starts with the job's prefix.
A recorded pid only counts while its start time is unchanged, so a reused pid is never signalled.
"""

import ctypes
import errno
import fcntl
import json
import os
import re
import shutil
import signal
import struct
import subprocess
import sys

PRESSURE_NORMAL = 1
MARK_VAR = "CARET_HEAVY_MARK"


class Refusal(Exception):
    """A precondition for starting is not met. Nothing was spawned."""


class _RUsageInfoV0(ctypes.Structure):
    # struct rusage_info_v0 from <sys/resource.h>.
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins",
        "wired_size", "resident_size", "phys_footprint", "proc_start_abstime", "proc_exit_abstime")]


def _errno_error(what):
    err = ctypes.get_errno() or errno.EIO
    return OSError(err, "{}: {}".format(what, os.strerror(err)))


class DarwinProbes:
    """macOS kernel counters read in-process through libproc and sysctl."""

    PROC_ALL_PIDS = 1
    PROC_PGRP_ONLY = 2
    PROC_PPID_ONLY = 6
    RUSAGE_INFO_V0 = 0
    CTL_KERN, KERN_ARGMAX, KERN_PROCARGS2 = 1, 8, 49

    def __init__(self):
        if sys.platform != "darwin":
            raise OSError(errno.ENOSYS, "the supervisor reads processes through macOS libproc only")
        libc = ctypes.CDLL(None, use_errno=True)
        self._listpids = libc.proc_listpids
        self._listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
        self._listpids.restype = ctypes.c_int
        self._rusage = libc.proc_pid_rusage
        self._rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        self._rusage.restype = ctypes.c_int
        self._sysctlbyname = libc.sysctlbyname
        self._sysctlbyname.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                                       ctypes.c_void_p, ctypes.c_size_t]
        self._sysctlbyname.restype = ctypes.c_int
        self._sysctl = libc.sysctl
        self._abstime = libc.mach_absolute_time
        self._abstime.restype = ctypes.c_uint64
        argmax = ctypes.c_int(0)
        size = ctypes.c_size_t(ctypes.sizeof(argmax))
        if self._sysctl((ctypes.c_int * 2)(self.CTL_KERN, self.KERN_ARGMAX), 2, ctypes.byref(argmax),
                        ctypes.byref(size), None, 0) != 0:
            raise _errno_error("sysctl kern.argmax")
        # One buffer reused for every KERN_PROCARGS2 read: a full scan reads several hundred processes.
        self._args_buf = ctypes.create_string_buffer(argmax.value)

    def now_abstime(self):
        """The clock proc_start_abstime is measured on."""
        return self._abstime()

    def pressure_level(self):
        value = ctypes.c_int(0)
        size = ctypes.c_size_t(ctypes.sizeof(value))
        if self._sysctlbyname(b"kern.memorystatus_vm_pressure_level", ctypes.byref(value), ctypes.byref(size), None, 0):
            raise _errno_error("sysctl kern.memorystatus_vm_pressure_level")
        return value.value

    def free_bytes(self, path):
        return shutil.disk_usage(path).free

    def _list(self, kind, arg):
        capacity = 1024
        while True:
            buf = (ctypes.c_int * capacity)()
            ctypes.set_errno(0)
            used = self._listpids(kind, arg, buf, ctypes.sizeof(buf))
            # A short buffer is reported as 0 bytes with errno set, which would read as no processes.
            if used < 0 or (used == 0 and ctypes.get_errno() != 0):
                raise _errno_error("proc_listpids")
            if used < ctypes.sizeof(buf):
                return [pid for pid in buf[: used // ctypes.sizeof(ctypes.c_int)] if pid > 0]
            capacity *= 4

    def all_pids(self):
        return self._list(self.PROC_ALL_PIDS, 0)

    def group(self, pgid):
        """PIDs whose process group is *pgid*, zombies included."""
        return self._list(self.PROC_PGRP_ONLY, pgid)

    def children(self, pid):
        return self._list(self.PROC_PPID_ONLY, pid)

    def usage(self, pid):
        """(resident bytes, start time) of a live process; None once it has exited or is a zombie.

        Only "no such process" means gone. A permission error raises PermissionError: a process this user
        cannot inspect is not known to be dead (Astra's design, section 2: a permission error never means dead).
        """
        info = _RUsageInfoV0()
        ctypes.set_errno(0)
        if self._rusage(pid, self.RUSAGE_INFO_V0, ctypes.byref(info)) != 0:
            err = ctypes.get_errno()
            if err == errno.ESRCH:
                return None
            if err == errno.EPERM:
                raise PermissionError(err, "proc_pid_rusage({}): {}".format(pid, os.strerror(err)))
            raise _errno_error("proc_pid_rusage({})".format(pid))
        if info.proc_exit_abstime:
            return None
        return info.resident_size, info.proc_start_abstime

    def procargs(self, pid):
        """(argv, environment strings) of a process this user may read, else None."""
        size = ctypes.c_size_t(len(self._args_buf))
        if self._sysctl((ctypes.c_int * 3)(self.CTL_KERN, self.KERN_PROCARGS2, pid), 3, self._args_buf,
                        ctypes.byref(size), None, 0) != 0:
            return None
        data = self._args_buf.raw[: size.value]
        if len(data) < 4:
            return None
        argc = struct.unpack_from("i", data, 0)[0]
        rest = data[4:]
        end = rest.find(b"\0")
        if end < 0:
            return None
        parts = rest[end:].lstrip(b"\0").split(b"\0")
        argv = [p.decode(errors="replace") for p in parts[:argc]]
        env = []
        for p in parts[argc:]:
            if not p:
                break
            env.append(p.decode(errors="replace"))
        return argv, env


# Locks

# struct flock on Darwin: off_t l_start, off_t l_len, pid_t l_pid, short l_type, short l_whence.
_FLOCK_STRUCT = "qqihh"


def lock_held(path):
    """True when some open file holds a lock on *path*. F_GETLK reports flock() locks on macOS and takes nothing."""
    try:
        fd = os.open(path, os.O_RDONLY)
    except FileNotFoundError:
        return False
    try:
        query = struct.pack(_FLOCK_STRUCT, 0, 0, 0, fcntl.F_WRLCK, os.SEEK_SET)
        return struct.unpack(_FLOCK_STRUCT, fcntl.fcntl(fd, fcntl.F_GETLK, query))[3] != fcntl.F_UNLCK
    finally:
        os.close(fd)


def inherited_lock_fd(path, fd=None):
    """The inherited descriptor for *path*, checked to be the one holding its lock.

    With *fd* None, the one inheritable descriptor referring to *path* is found (the queue passes
    the slot without saying its number). A free file is refused before the LOCK_EX probe, so the
    probe never takes a lock the parent did not hold. Re-locking through the open file that already
    holds an exclusive flock changes nothing; through any other open file it fails at once.
    """
    try:
        target = os.stat(path)
    except FileNotFoundError:
        raise Refusal("slot lock {} does not exist".format(path)) from None
    if fd is None:
        matches = []
        for name in os.listdir("/dev/fd"):
            candidate = int(name)
            if candidate <= 2:
                continue
            try:
                if os.path.samestat(os.fstat(candidate), target) and os.get_inheritable(candidate):
                    matches.append(candidate)
            except OSError:
                continue  # the directory handle os.listdir used, closed by now
        if len(matches) != 1:
            raise Refusal("expected exactly one inherited descriptor for {}, found {}".format(path, matches or "none"))
        fd = matches[0]
    else:
        try:
            if not os.path.samestat(os.fstat(fd), target):
                raise Refusal("descriptor {} is not {}".format(fd, path))
        except OSError as ex:
            raise Refusal("descriptor {} is unusable: {}".format(fd, ex)) from None
    if not lock_held(path):
        raise Refusal("{} is not locked, so inherited descriptor {} carries no slot".format(path, fd))
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise Refusal("inherited descriptor {} for {} does not hold its lock; another open file does".format(
            fd, path)) from None
    return fd


def inherited_lock_fd_if_any(path):
    """inherited_lock_fd(path) when this process inherited a descriptor for *path*, else None.

    The shared queue's runner may hold heavy.lock for each job and hand the job its descriptor, as
    it does slot.lock. Holding that same open file is the only proof the lock is this job's: a
    LOCK_EX through it is a no-op, and through any other open file it fails.
    """
    try:
        target = os.stat(path)
    except FileNotFoundError:
        return None
    for name in os.listdir("/dev/fd"):
        candidate = int(name)
        try:
            if candidate > 2 and os.path.samestat(os.fstat(candidate), target) and os.get_inheritable(candidate):
                return inherited_lock_fd(path)
        except OSError:
            continue
    return None


# Inventory: every probe answers ABSENT, PRESENT or UNKNOWN. A failed, slow or unreadable probe is UNKNOWN, never
# an empty answer, and only a fresh ABSENT for every registered resource lets a job release its locks.

ABSENT, PRESENT, UNKNOWN = "ABSENT", "PRESENT", "UNKNOWN"


class GroupWatch:
    """The processes of one registered process group, known by identity (pid and start time).

    The leader's identity is registered before it is released, so every later process descends from
    something known. Each tick records the known identities still alive and every descendant reachable
    from them. A group member nobody can trace (orphaned before a tick saw it) is unverified: never
    signalled, and reported UNKNOWN. A recorded pid whose start time changed is a reused pid and is not
    ours. The group's id is never signalled as a whole (no killpg): each verified identity, by pid.
    """

    def __init__(self, probes, pgid, leader, identities=()):
        self.probes = probes
        self.pgid = int(pgid)
        self.identities = {int(leader[0]): leader[1]}
        self.identities.update({int(p): s for p, s in identities})
        self.unverified = []
        self.live_verified = []

    def tick(self):
        """Walk the group and known descendants. Returns newly recorded identities. A failed probe raises OSError
        (PermissionError included), which the caller reports as UNKNOWN."""
        added = []
        members = self.probes.group(self.pgid)
        verified = set()
        for pid in set(members) | set(self.identities):
            usage = self.probes.usage(pid)
            if usage is not None and self.identities.get(pid) == usage[1]:
                verified.add(pid)
        frontier = list(verified)
        while frontier:
            for child in self.probes.children(frontier.pop()):
                if child in verified:
                    continue
                usage = self.probes.usage(child)
                if usage is None:
                    continue
                self.identities[child] = usage[1]  # a child of a verified identity is ours
                added.append((child, usage[1]))
                verified.add(child)
                frontier.append(child)
        unverified = []
        for pid in members:
            if pid not in verified and self.probes.usage(pid) is not None:
                unverified.append(pid)
        self.unverified = sorted(unverified)
        self.live_verified = sorted(verified)
        return added

    def inventory(self):
        """(ABSENT|PRESENT|UNKNOWN, detail), after a fresh tick."""
        try:
            self.tick()
        except OSError as ex:
            return UNKNOWN, "probe failed: {}".format(ex)
        return self.state()

    def state(self, error=None):
        """(ABSENT|PRESENT|UNKNOWN, detail) as of the last tick; *error* is that tick's failure, if any."""
        if error is not None:
            return UNKNOWN, "probe failed: {}".format(error)
        if self.unverified:
            return UNKNOWN, "group {} has members of unverified identity {}".format(self.pgid, self.unverified)
        if self.live_verified:
            return PRESENT, "pids {}".format(self.live_verified)
        return ABSENT, "group {} and its descendants are gone".format(self.pgid)

    def signal(self, sig):
        """Signal each verified identity by pid, rechecking its start time first. Returns the pids signalled."""
        sent = []
        for pid in self.live_verified:
            try:
                usage = self.probes.usage(pid)
            except PermissionError:
                continue
            if usage is None or self.identities.get(pid) != usage[1]:
                continue
            try:
                os.kill(pid, sig)
                sent.append(pid)
            except OSError:
                continue
        return sent


def launchd_state(label, uid=None, launchctl="/bin/launchctl", timeout=20):
    """(ABSENT|PRESENT|UNKNOWN, detail) of one gui-domain launchd job. launchctl print exits 113 for no such job."""
    uid = os.getuid() if uid is None else uid
    try:
        done = subprocess.run([launchctl, "print", "gui/{}/{}".format(uid, label)], stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as ex:
        return UNKNOWN, "launchctl print failed: {!r}".format(ex)
    if done.returncode == 0:
        return PRESENT, "loaded"
    if done.returncode == 113:
        return ABSENT, "no such job"
    return UNKNOWN, "launchctl print exited {}: {}".format(done.returncode, done.stderr.strip()[:200])


def lease_state(lr_lease, lease_id, env=None, timeout=60):
    """(ABSENT|PRESENT|UNKNOWN, detail) of one lr-lease record, from `lr-lease status`."""
    try:
        done = subprocess.run([lr_lease, "status"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, timeout=timeout, env=env)
    except (OSError, subprocess.TimeoutExpired) as ex:
        return UNKNOWN, "lr-lease status failed: {!r}".format(ex)
    if done.returncode != 0:
        return UNKNOWN, "lr-lease status exited {}: {}".format(done.returncode, done.stdout.strip()[:200])
    if not done.stdout.startswith("Readings ") or "\nLeases: " not in done.stdout:
        return UNKNOWN, "lr-lease status output is not the expected report"
    lines = done.stdout.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.startswith("Leases: "))
        count = int(lines[start][len("Leases: "):])
    except (StopIteration, ValueError):
        return UNKNOWN, "lr-lease status has no lease count"
    # Exactly that many lines follow, each one lease object (lr-lease-cli.mjs status).
    found = None
    for line in lines[start + 1:start + 1 + count]:
        try:
            record = json.loads(line)
        except ValueError:
            return UNKNOWN, "lr-lease status printed a malformed lease line"
        if not isinstance(record, dict) or "id" not in record:
            return UNKNOWN, "lr-lease status printed a lease line that is not a lease"
        if record["id"] == lease_id:
            found = record
    if len(lines) < start + 1 + count:
        return UNKNOWN, "lr-lease status listed fewer leases than its count"
    if found is None:
        return ABSENT, "no lease {}".format(lease_id)
    return PRESENT, "lease {} is {}".format(lease_id, found.get("state", "active"))


# launchd

_SERVICE = re.compile(r"^\s+(-|\d+)\s+(\S+)\s+(\S+)\s*$")


def launchd_jobs(prefix, uid=None):
    """[(label, pid or None)] of the user's gui-domain launchd jobs whose label starts with *prefix*."""
    uid = os.getuid() if uid is None else uid
    done = subprocess.run(["/bin/launchctl", "print", "gui/{}".format(uid)], stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=20)
    out = done.stdout
    # A failed or unrecognised listing is not an empty one.
    if done.returncode != 0 or "\tservices = {" not in out:
        raise OSError("launchctl print gui/{} exited {} or listed no services block".format(uid, done.returncode))
    jobs, inside = [], False
    for line in out.splitlines():
        if line.strip() == "services = {":
            inside = True
            continue
        if inside and line.strip() == "}":
            break
        if inside:
            m = _SERVICE.match(line)
            if m and m.group(3).startswith(prefix):
                pid = int(m.group(1)) if m.group(1).isdigit() and int(m.group(1)) > 0 else None
                jobs.append((m.group(3), pid))
    return jobs


def launchd_bootout(label, uid=None):
    uid = os.getuid() if uid is None else uid
    return subprocess.run(["/bin/launchctl", "bootout", "gui/{}/{}".format(uid, label)], stdin=subprocess.DEVNULL,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60).returncode


# Ownership


class Tracker:
    """Everything one job started, found by inherited markers. See the module docstring."""

    def __init__(self, probes, mark, launchd_prefix, started_abstime):
        self.probes = probes
        self.mark_entry = "{}={}".format(MARK_VAR, mark)
        self.launchd_prefix = launchd_prefix
        self.started_abstime = started_abstime
        self.pgids = set()
        self.leaders = set()     # direct children of the supervisor, unreaped until the end
        self.tracked = {}        # pid -> start time of every owned process seen
        self.argv_seen = {}      # pid -> argv, for postconditions (rig-run pids)
        self.labels = set()      # launchd labels seen with the job's prefix
        self.uninspectable = set()  # owned pids whose state a permission error hid
        self.found_last = None      # the last complete owned() answer, for when a probe fails
        self.me = os.getpid()

    def add_leader(self, pid):
        self.leaders.add(pid)
        self.pgids.add(pid)

    def _remember(self, pid, started):
        self.tracked[pid] = started
        if pid not in self.argv_seen:
            got = self.probes.procargs(pid)
            if got is not None:
                self.argv_seen[pid] = got[0]

    def owned(self, full=False):
        """Live owned processes as {pid: resident bytes}.

        A light sample walks the recorded groups, recorded pids and their children. A full sample
        also reads every process started since the job began for the marker, and lists launchd.
        """
        frontier = []
        for pgid in self.pgids:
            frontier += [(p, True) for p in self.probes.group(pgid)]
        frontier += [(p, False) for p in list(self.tracked)]
        frontier += [(p, True) for p in self.leaders]
        if full:
            frontier += [(p, True) for p in self._marked()]
            for label, pid in launchd_jobs(self.launchd_prefix):
                self.labels.add(label)
                if pid:
                    frontier.append((pid, True))
        found = {}
        while frontier:
            pid, related = frontier.pop()
            if pid in found or pid == self.me:
                continue
            try:
                usage = self.probes.usage(pid)
            except PermissionError:
                if related:
                    found[pid] = 0  # ours by group or parentage, but not inspectable: still present, never assumed dead
                    self.uninspectable.add(pid)
                continue
            if usage is None:
                continue
            rss, started = usage
            if not related and self.tracked.get(pid) != started:
                continue  # the pid now belongs to an unrelated process
            self._remember(pid, started)
            found[pid] = rss
            frontier.extend((child, True) for child in self.probes.children(pid))
        return found

    def _marked(self):
        hits = []
        for pid in self.probes.all_pids():
            if pid == self.me:
                continue
            try:
                usage = self.probes.usage(pid)
            except PermissionError:
                continue  # another user's process: it cannot carry this job's marker in an environment we set
            if usage is None or usage[1] < self.started_abstime:
                continue
            if self.tracked.get(pid) == usage[1]:
                continue  # already walked from the tracked set; a reused pid (other start) is read again
            got = self.probes.procargs(pid)
            if got is not None and self.mark_entry in got[1]:
                hits.append(pid)
        return hits

    def live_labels(self):
        """Labels with the job's prefix still loaded in launchd."""
        labels = [label for label, _ in launchd_jobs(self.launchd_prefix)]
        self.labels.update(labels)
        return labels

    def signal_all(self, sig, owned):
        """Signal each owned process by pid after rechecking its start time. Returns the pids signalled."""
        sent = []
        for pid in sorted(owned):
            if pid == self.me:
                continue
            try:
                usage = self.probes.usage(pid)
            except PermissionError:
                continue
            if usage is None or self.tracked.get(pid) not in (None, usage[1]):
                continue
            try:
                os.kill(pid, sig)
                sent.append(pid)
            except OSError:
                continue  # exited since the listing; a zombie answers EPERM on macOS
        return sent

    def bootout_all(self):
        """Unload every launchd job with the job's prefix; launchd stops its processes. Returns the labels."""
        labels = self.live_labels()
        for label in labels:
            launchd_bootout(label)
        return labels


def alive(probes, pid):
    """True while *pid* exists; a process hidden by a permission error counts as alive."""
    try:
        return probes.usage(pid) is not None
    except PermissionError:
        return True


def signal_name(sig):
    try:
        return signal.Signals(sig).name
    except ValueError:
        return str(sig)
