"""The shared queue's real runner, as it would run if it held heavy.lock for its jobs.

The coordinator asked the queue's owner to make the runner hold ~/.long-run/locks/heavy.lock, so
queue jobs and other heavy work exclude each other through that one lock. This stands in for that
change until it lands: it takes heavy.lock, then runs the queue's own main() with one addition,
the locked heavy.lock descriptor joins every job's inherited descriptors, as slot.lock's already
does. Admission, the slot, the trampoline and the watch are the queue's unchanged code.

  run_queue_holding_heavy_lock.py QUEUE-SCRIPT HEAVY-LOCK [queue arguments...]
"""

import fcntl
import importlib.util
import os
import subprocess
import sys

queue_script, heavy_lock = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("heavy_job_queue", queue_script)
hjq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hjq)

held = os.open(heavy_lock, os.O_RDWR | os.O_CREAT, 0o644)
fcntl.flock(held, fcntl.LOCK_EX)
print("runner holds heavy.lock through fd {}".format(held), flush=True)

_Popen = subprocess.Popen


class PassHeavyLock(_Popen):
    def __init__(self, args, *rest, **kw):
        if hjq.TRAMPOLINE in args:  # the queue launching a job: hand it the lock as it hands it the slot
            kw["pass_fds"] = tuple(kw.get("pass_fds", ())) + (held,)
        super().__init__(args, *rest, **kw)


subprocess.Popen = PassHeavyLock
sys.exit(hjq.main(sys.argv[3:]))
