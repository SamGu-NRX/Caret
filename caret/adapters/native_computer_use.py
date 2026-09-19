"""Accepted native workflows backed by the pinned computer-use-jev executable."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import tempfile
import time
from pathlib import Path
from uuid import uuid4

from ..context import ContextFrame
from ..registry import Availability, ExecutionResult, Preparation, WorkflowDescriptor, WorkflowError


class NativeComputerUseWorkflow:
    """A seeded Calendar navigation action, not an ambient free-form goal runner."""

    descriptor = WorkflowDescriptor(
        id="native-open-calendar",
        name="Open Calendar with Jev",
        description="Bring the already-running macOS Calendar app forward using Jev and native Accessibility.",
        required_inputs=("computer-use-jev executable", "TYPESAFE_API_KEY", "Calendar running", "Accessibility permission"),
        execution_method="computer-use-jev",
    )
    goal = "Activate the Calendar application."

    def __init__(self, *, environ=None, clock=time.monotonic, timeout=120.0):
        self.environ = dict(os.environ if environ is None else environ)
        self.binary = self.environ.get("CARET_COMPUTER_USE_JEV", "")
        self.clock = clock
        self.timeout = timeout
        self.pending = {}

    def availability(self, frame: ContextFrame) -> Availability:
        if not self.binary or not Path(self.binary).is_absolute():
            return Availability(False, "Set CARET_COMPUTER_USE_JEV to the absolute path of the built executable.")
        if not Path(self.binary).is_file() or not os.access(self.binary, os.X_OK):
            return Availability(False, "The configured computer-use-jev executable is missing or not executable.")
        if not self.environ.get("TYPESAFE_API_KEY"):
            return Availability(False, "TYPESAFE_API_KEY is missing. Native Jev execution needs its own API credential.")
        if not frame.permissions.accessibility:
            return Availability(False, "Accessibility permission is required.")
        snapshot = frame.snapshot
        if snapshot.secure or snapshot.ime_composing or snapshot.app_excluded:
            return Availability(False, "The current field does not permit an action.")
        return Availability(True)

    def prepare(self, frame: ContextFrame) -> Preparation:
        available = self.availability(frame)
        if not available.available:
            raise WorkflowError(available.reason)
        token = str(uuid4())
        preparation = Preparation(
            title="Open Calendar with Jev",
            effect="Bring the already-running Calendar app forward. This action does not schedule a meeting.",
            evidence=("Uses the native computer-use-jev executor and a live Jev decision.",
                      "Calendar must already be running; the upstream executor activates apps but cannot launch them."),
            payload={"token": token},
        )
        # Only the server-held goal is executed. Context, clipboard and returned
        # payload cannot replace it with an unreviewed free-form instruction.
        self.pending[token] = (self.clock(), frame.snapshot, preparation)
        self.pending = {key: value for key, value in self.pending.items() if self.clock() - value[0] <= 30}
        return preparation

    def execute(self, frame: ContextFrame, preparation: Preparation | None) -> ExecutionResult:
        token = preparation.payload.get("token") if preparation else None
        pending = self.pending.pop(token, None) if isinstance(token, str) else None
        if pending is None:
            return ExecutionResult(status="failed", summary="Native proposal is unknown, expired, cancelled or already accepted.")
        created, snapshot, original = pending
        if preparation != original or frame.snapshot != snapshot or self.clock() - created > 30:
            return ExecutionResult(status="failed", summary="The native proposal or its original field changed; nothing ran.")
        available = self.availability(frame)
        if not available.available:
            return ExecutionResult(status="failed", summary=available.reason)
        command = [self.binary, "-json", "-max-steps", "8", "-goal", self.goal]
        # Trace files are temporary. In particular, full AX snapshots are never
        # retained as workflow evidence or written into the repository.
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            try:
                process = subprocess.Popen(command, stdout=stdout, stderr=stderr, env=self.environ)
            except OSError as error:
                return ExecutionResult(status="failed", summary=f"Cannot start computer-use-jev: {error}")
            timed_out = False
            try:
                process.wait(timeout=self.timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                # The Go entry point handles SIGINT by cancelling its context
                # and closing its persistent Swift worker.
                process.send_signal(signal.SIGINT)
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            stdout.seek(0)
            trace = stdout.read(2_000_001)
            stderr.seek(0, 2)
            stderr.seek(max(0, stderr.tell() - 2000))
            diagnostic = stderr.read().decode("utf-8", errors="replace")
        diagnostic = diagnostic.replace(self.environ["TYPESAFE_API_KEY"], "[redacted]")
        if timed_out:
            return ExecutionResult(status="failed", summary="Native execution timed out. Some actions may already have occurred.")
        if len(trace) > 2_000_000:
            return ExecutionResult(status="failed", summary="Native trace exceeded the readback limit. Some actions may already have occurred.")
        try:
            records = [json.loads(line) for line in trace.splitlines() if line.strip()]
            if any(not isinstance(record, dict) for record in records):
                raise ValueError("trace records must be objects")
        except (ValueError, UnicodeError):
            return ExecutionResult(status="failed", summary="Native executor returned an invalid trace. Some actions may already have occurred.")
        steps = [record for record in records if isinstance(record.get("number"), int)]
        evidence = tuple(
            f"Step {step['number']}: {step.get('action', 'observation')}: {str(step.get('output', ''))[:300]}"
            for step in steps[-4:]
        )
        if process.returncode != 0:
            return ExecutionResult(status="failed", summary="Jev native execution did not complete. Some actions may already have occurred.",
                                   evidence=evidence + ((diagnostic,) if diagnostic else ()))
        if not steps or steps[-1].get("output") != "goal satisfied; no action taken":
            return ExecutionResult(status="failed", summary="Native executor exited without a completion trace.", evidence=evidence)
        return ExecutionResult(status="completed", summary="Jev reports Calendar is active.",
                               evidence=evidence, effects=("Native Calendar navigation",),
                               data={"executor": "computer-use-jev", "step_count": len(steps)})

    def cancel(self, preparation: Preparation | None) -> ExecutionResult:
        token = preparation.payload.get("token") if preparation else None
        if isinstance(token, str):
            self.pending.pop(token, None)
        return ExecutionResult(status="cancelled", summary="Native proposal discarded before execution.")
