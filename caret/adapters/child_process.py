"""Wait on an adapter's child process while honouring the engine's cancellation token."""

from __future__ import annotations

import signal
import subprocess
import threading
import time

EXITED = "exited"
CANCELLED = "cancelled"
TIMED_OUT = "timed-out"

POLL_SECONDS = 0.05
"""How often a running child is checked for exit. Cancellation wakes the wait
immediately; this only bounds how late a normal exit is noticed."""


def wait_or_stop(
    process: subprocess.Popen, *, cancelled: threading.Event, timeout: float, grace: float
) -> str:
    """Wait for ``process`` to exit, or stop it on cancellation or timeout.

    Stopping sends SIGINT, waits ``grace`` seconds, then kills. Returns
    :data:`EXITED`, :data:`CANCELLED` or :data:`TIMED_OUT`. A stopped child may
    already have acted; the caller must say so rather than report completion.
    """
    deadline = time.monotonic() + timeout
    while process.poll() is None:
        if cancelled.wait(POLL_SECONDS):
            outcome = CANCELLED
            break
        if time.monotonic() >= deadline:
            outcome = TIMED_OUT
            break
    else:
        return EXITED
    process.send_signal(signal.SIGINT)
    try:
        process.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    return outcome
