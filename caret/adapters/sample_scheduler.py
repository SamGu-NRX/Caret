"""The existing Caret planner, exposed through the workflow seam.

This adapter runs `caret.planner.plan` over a labeled synthetic fixture and
records local SQLite holds. It is the proof that the registry contract reaches
real code and returns a real structured result.

It is not a live scheduling integration and does not claim to be. It reads a
fixture file, not the user's mail or calendar; `plan()` still refuses anything
whose ``mode`` is not ``"sample"``; and executing it writes rows to a local
database and nothing else. The effect string the user sees says exactly that.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from ..context import ContextFrame
from ..planner import plan
from ..registry import (
    Availability,
    ExecutionResult,
    Preparation,
    WorkflowDescriptor,
    WorkflowError,
)
from ..store import Store

DESCRIPTOR = WorkflowDescriptor(
    id="book-calendar-link",
    name="Propose meeting times",
    description=(
        "Reads a scheduling thread, removes times that conflict after travel buffers, "
        "and proposes up to three options with their sources."
    ),
    required_inputs=("thread", "calendar", "travel_buffers"),
    execution_method="local-sample-planner",
    sample_only=True,
)


class SampleSchedulerWorkflow:
    """Availability depends on a configured sample fixture, not on the context."""

    def __init__(self, fixture_path: Path, database_path: Path) -> None:
        self.fixture_path = Path(fixture_path)
        self.database_path = Path(database_path)

    @property
    def descriptor(self) -> WorkflowDescriptor:
        return DESCRIPTOR

    def availability(self, frame: ContextFrame) -> Availability:
        if not self.fixture_path.exists():
            return Availability(False, f"No sample fixture at {self.fixture_path}")
        return Availability(True, "Labeled sample fixture is configured")

    def _load(self) -> dict:
        try:
            fixture = json.loads(self.fixture_path.read_text())
        except (OSError, json.JSONDecodeError) as error:
            raise WorkflowError(f"Cannot read sample fixture: {error}") from error
        if fixture.get("mode") != "sample":
            raise WorkflowError("This adapter accepts labeled sample fixtures only")
        return fixture

    def prepare(self, frame: ContextFrame) -> Preparation:
        """Plan from the fixture. Reads a file; sends nothing, writes nothing."""
        try:
            preview = plan(self._load())
        except (ValueError, KeyError) as error:
            raise WorkflowError(f"Planning failed: {error}") from error

        options = preview["options"]
        if not options:
            # Every candidate's source failed or conflicted. There is nothing to
            # offer, and inventing a time is exactly what must not happen here.
            raise WorkflowError("No candidate survived its source checks; there is nothing to propose")

        return Preparation(
            title=f"Propose {len(options)} meeting times",
            effect=(
                "Records tentative holds in Caret's local SQLite database. "
                "Sends no message and creates no external calendar event."
            ),
            evidence=tuple(preview["evidence"])
            + (
                f"Sample fixture: {self.fixture_path}",
                f"Dropped candidates: {', '.join(preview['dropped']) or 'none'}",
                "Synthetic development data. These times are not a real offer.",
            ),
            missing_inputs=(),
            payload={"preview": preview},
        )

    def execute(self, frame: ContextFrame, preparation: Preparation | None) -> ExecutionResult:
        if preparation is None or "preview" not in preparation.payload:
            raise WorkflowError("Execution needs the preview produced by prepare()")
        preview = preparation.payload["preview"]
        # Opening the database is as failure-prone as writing to it: the path may
        # be unwritable or hold a file that is not a database. Both paths raise
        # WorkflowError so the bridge answers the acceptance with a coded error
        # instead of letting an OSError or sqlite3.Error escape.
        try:
            store = Store(self.database_path)
        except (OSError, sqlite3.Error) as error:
            raise WorkflowError(
                f"Cannot open the local hold database at {self.database_path}: {error}"
            ) from error
        try:
            run_id = store.save_preview(preview)
            holds = store.hold(run_id)
        except (ValueError, OSError, sqlite3.Error) as error:
            raise WorkflowError(f"Local hold failed: {error}") from error
        finally:
            store.close()
        return ExecutionResult(
            status="completed",
            summary=f"Recorded {len(holds)} tentative local holds for run {run_id}",
            effects=(f"sqlite:{self.database_path}#run={run_id}",),
            evidence=preparation.evidence,
            data={
                "run_id": run_id,
                "holds": holds,
                "options": preview["options"],
                "draft": preview["draft"],
                "notice": preview["notice"],
            },
        )

    def cancel(self, preparation: Preparation | None) -> ExecutionResult:
        return ExecutionResult(status="cancelled", summary="Proposal discarded before any local write")
