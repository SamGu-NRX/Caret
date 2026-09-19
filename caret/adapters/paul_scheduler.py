"""Opt-in adapter for Paul Gettel's jev-scheduler, run as a sample workflow.

His `runPipeline()` takes no arguments, resolves its inputs from the process
working directory, and posts to `SCHEDULE_WEBHOOK_URL` when that variable is
set. Two consequences follow, and both are visible in what this adapter does:

* It cannot be ambient preparation. Preparing a proposal has to stay read-only,
  and the only way to learn what his pipeline would produce is to run the whole
  thing. So :meth:`prepare` describes the run without performing it, and the
  pipeline executes only after the user accepts.
* It cannot process live Caret context. It reads its own bundled sample thread
  and synthetic computer history, and there is no parameter to hand it the
  current field, clipboard or Screenpipe results. The proposal says so.

What runs is his code, unmodified, in a separate Node process whose environment
this adapter controls: no webhook variable, so the POST branch is unreachable;
`JEV_MOCK=1` and no API key, so his Jev client stays in its own deterministic
mock mode; and his checkout as the working directory, which his loader requires
and which `runPipeline()` never writes to. The wrapper is
``scripts/paul_scheduler_bridge.mjs``. His directory is not copied here and his
planner is not reimplemented.

Because Jev is mocked, a successful run proves the process boundary and his
pipeline's own logic. It is not evidence about the live Jev service.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

from ..context import ContextFrame
from ..registry import (
    Availability,
    ExecutionResult,
    Preparation,
    WorkflowDescriptor,
    WorkflowError,
)

WRAPPER = Path(__file__).resolve().parent.parent.parent / "scripts" / "paul_scheduler_bridge.mjs"

# Node runs TypeScript sources without a build step from 22.18 and 23.6 onward.
# jev-scheduler ships .ts with `noEmit` and no compiled entry point, so an older
# Node cannot import it at all. Refuse clearly instead of failing mid-run.
MIN_NODE = (22, 18)

DESCRIPTOR = WorkflowDescriptor(
    id="jev-scheduler-sample",
    name="Run the jev-scheduler sample (Paul)",
    description=(
        "Runs Paul's meeting-scheduler pipeline over its own bundled sample thread and "
        "synthetic history. It does not read the current context."
    ),
    required_inputs=("jev-scheduler checkout",),
    execution_method="node-subprocess-sample",
    sample_only=True,
)


class PaulSchedulerWorkflow:
    def __init__(
        self,
        root: Path,
        node_executable: str = "node",
        timeout: float = 60.0,
    ) -> None:
        self.root = Path(root)
        self.node_executable = node_executable
        self.timeout = timeout

    @property
    def descriptor(self) -> WorkflowDescriptor:
        return DESCRIPTOR

    # -- Availability ----------------------------------------------------

    def availability(self, frame: ContextFrame | None = None) -> Availability:
        pipeline = self.root / "lib" / "pipeline.ts"
        if not pipeline.exists():
            return Availability(False, f"No jev-scheduler pipeline at {pipeline}")
        if not WRAPPER.exists():  # pragma: no cover - shipped alongside this file
            return Availability(False, f"Missing wrapper script at {WRAPPER}")
        version = self._node_version()
        if version is None:
            return Availability(False, f"'{self.node_executable}' is not runnable")
        if version < MIN_NODE:
            return Availability(
                False,
                f"Node {version[0]}.{version[1]} cannot import TypeScript sources; "
                f"jev-scheduler ships .ts with no compiled entry point and needs "
                f"Node {MIN_NODE[0]}.{MIN_NODE[1]} or newer",
            )
        return Availability(True, f"Node {version[0]}.{version[1]} at {self.root}")

    def _node_version(self) -> tuple[int, int] | None:
        try:
            completed = subprocess.run(
                [self.node_executable, "--version"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        match = re.search(r"v?(\d+)\.(\d+)", completed.stdout.strip())
        return (int(match.group(1)), int(match.group(2))) if match else None

    # -- Proposal --------------------------------------------------------

    def prepare(self, frame: ContextFrame) -> Preparation:
        """Describe the run. Deliberately does not start it.

        Running his pipeline is the only way to see its output, and that is more
        than preparation is allowed to do, so the proposal states the effect and
        waits for an acceptance.
        """
        available = self.availability(frame)
        if not available.available:
            raise WorkflowError(f"jev-scheduler is unavailable: {available.reason}")
        return Preparation(
            title="Run the jev-scheduler sample pipeline",
            effect=(
                "Starts a separate Node process that runs Paul's pipeline over its own sample "
                "files. Its webhook is disabled and its Jev client runs in mock mode, so nothing "
                "is sent and no network call is made. Nothing is written outside Caret."
            ),
            evidence=(
                f"jev-scheduler checkout: {self.root}",
                "Inputs are its own bundled sample thread, timetable and synthetic computer history.",
                "This workflow does not receive Caret's current context: runPipeline() takes no "
                "arguments and loads fixed files.",
                "Jev is forced into its mock mode, so the result is not evidence about the live service.",
            ),
            missing_inputs=(),
            payload={"root": str(self.root)},
        )

    # -- Execution -------------------------------------------------------

    def execute(self, frame: ContextFrame, preparation: Preparation | None) -> ExecutionResult:
        environment = {key: value for key, value in os.environ.items()}
        # Both removals are load-bearing: the first makes his webhook branch
        # unreachable, the second keeps his Jev client off the network.
        environment.pop("SCHEDULE_WEBHOOK_URL", None)
        environment.pop("TYPESAFE_API_KEY", None)
        environment["JEV_MOCK"] = "1"

        try:
            completed = subprocess.run(
                [self.node_executable, str(WRAPPER), str(self.root)],
                capture_output=True,
                text=True,
                timeout=self.timeout,
                env=environment,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return ExecutionResult(
                status="failed",
                summary=f"jev-scheduler did not finish within {self.timeout:.0f}s and was stopped",
            )
        except OSError as error:
            return ExecutionResult(status="failed", summary=f"Could not start Node: {error}")

        stdout = completed.stdout.strip()
        if not stdout:
            return ExecutionResult(
                status="failed",
                summary=f"jev-scheduler exited {completed.returncode} with no output",
                evidence=(_tail(completed.stderr),),
            )
        try:
            payload = json.loads(stdout.splitlines()[-1])
        except json.JSONDecodeError:
            return ExecutionResult(
                status="failed",
                summary="jev-scheduler produced output that is not JSON",
                evidence=(_tail(stdout),),
            )
        if not payload.get("ok"):
            return ExecutionResult(
                status="failed",
                summary=f"jev-scheduler reported: {payload.get('error', 'unknown error')}",
            )

        return _summarize(payload["result"], preparation, self.root)

    def cancel(self, preparation: Preparation | None) -> ExecutionResult:
        return ExecutionResult(status="cancelled", summary="jev-scheduler was never started")


def _summarize(result: dict, preparation: Preparation | None, root: Path) -> ExecutionResult:
    """Map his return value onto Caret's result shape.

    His pipeline has three outcomes: `scheduled`, `no_options` and `stopped`.
    Only `scheduled` produced a plan; the other two are real completions that
    proposed nothing, so neither is reported as a failure and neither is
    reported as a success that produced holds.
    """
    status = result.get("status")
    holds = result.get("holds") or []
    if result.get("webhook"):  # pragma: no cover - the wrapper makes this unreachable
        raise WorkflowError("jev-scheduler reported a webhook POST; the environment guard failed")

    if status == "scheduled":
        summary = f"jev-scheduler proposed {len(holds)} tentative hold(s) from its sample inputs"
    elif status == "no_options":
        summary = "jev-scheduler found no candidate that survived its own timetable checks"
    elif status == "stopped":
        summary = f"jev-scheduler stopped before planning: {result.get('reason', 'no reason given')}"
    else:
        return ExecutionResult(
            status="failed", summary=f"jev-scheduler returned an unrecognized status '{status}'"
        )

    evidence = tuple(preparation.evidence) if preparation else ()
    notice = result.get("notice")
    if notice:
        evidence = evidence + (f"jev-scheduler notice: {notice}",)

    return ExecutionResult(
        status="completed",
        summary=summary,
        effects=(f"jev-scheduler run {result.get('run_id')} (in-process only, nothing sent)",),
        evidence=evidence,
        data={
            "run_id": result.get("run_id"),
            "pipeline_status": status,
            "jev_mode": result.get("mode"),
            "skill": result.get("skill"),
            "window": result.get("window"),
            "holds": holds,
            "dropped": result.get("dropped"),
            "draft_reply": result.get("draft_reply"),
            "notice": notice,
            "source": str(root),
        },
    )


def _tail(text: str, limit: int = 400) -> str:
    text = (text or "").strip()
    return text[-limit:] if text else "<no output>"
