"""Builders for the tests. Every value here is invented; nothing is observed."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from caret.context import (
    ClipboardContext,
    ContextFrame,
    HistoryItem,
    InputSnapshot,
    Permissions,
    SourceRecord,
    TargetIdentity,
    utf16_length,
)

T0 = datetime(2026, 9, 19, 12, 0, 0, tzinfo=timezone.utc)


class Clock:
    """A clock the tests move by hand, so cadence rules need no real waiting."""

    def __init__(self, start: datetime = T0) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> datetime:
        self.now = self.now + timedelta(seconds=seconds)
        return self.now


def target(element: str = "e1", revision: str = "r1", pid: int = 4242) -> TargetIdentity:
    return TargetIdentity(
        pid=pid,
        bundle_id="com.example.SyntheticEditor",
        window_id="w1",
        element_id=element,
        element_revision=revision,
    )


def frame(
    revision: int = 1,
    *,
    text: str = "I will send the ",
    caret: int | None = None,
    element: str = "e1",
    element_revision: str = "r1",
    pid: int = 4242,
    selection: tuple[int, int] | None = None,
    secure: bool = False,
    ime: bool = False,
    excluded: bool = False,
    accessibility: bool = True,
    workflow_active: bool = False,
    clipboard: bool = True,
    history_age: float = 10.0,
    source_age: float | None = None,
    captured_at: datetime = T0,
) -> ContextFrame:
    caret = utf16_length(text) if caret is None else caret
    start, end = selection if selection else (caret, caret)
    snapshot = InputSnapshot(
        revision=revision,
        captured_at=captured_at,
        target=target(element, element_revision, pid),
        role="AXTextArea",
        nearby_text=text,
        text_offset=0,
        caret=caret,
        selection_start=start,
        selection_end=end,
        secure=secure,
        ime_composing=ime,
        app_excluded=excluded,
    )
    return ContextFrame(
        snapshot=snapshot,
        permissions=Permissions(accessibility=accessibility),
        clipboard=(
            ClipboardContext(available=True, text="Austin to Dallas", captured_at=captured_at)
            if clipboard
            else ClipboardContext(available=False)
        ),
        history=(
            HistoryItem(
                source_id="h1",
                captured_at=captured_at - timedelta(seconds=history_age),
                text="Synthetic scheduling thread",
                app="com.example.SyntheticMail",
            ),
        ),
        sources=(
            SourceRecord(
                name="screenpipe",
                available=True,
                captured_at=captured_at - timedelta(seconds=source_age if source_age is not None else 10.0),
            ),
        ),
        workflow_active=workflow_active,
    )


class RecordingJudge:
    """Answers from a list and counts calls, so tests can assert on both."""

    def __init__(self, route: list | None = None, workflow: list | None = None) -> None:
        self.route = list(route or [])
        self.workflow = list(workflow or [])
        self.calls: list[str] = []

    def choose(self, question, frame):
        from caret.judge import validate_choice

        self.calls.append(question.key)
        answers = self.route if question.key == "route" else self.workflow
        if not answers:
            raise AssertionError(f"RecordingJudge ran out of '{question.key}' answers")
        answer = answers.pop(0) if len(answers) > 1 else answers[0]
        if isinstance(answer, Exception):
            raise answer
        return validate_choice(question, answer, frame.revision, model="recording")


class RecordingWriter:
    def __init__(self, text: str = " the team", error: Exception | None = None) -> None:
        self.text = text
        self.error = error
        self.calls = 0

    def complete(self, frame, instruction):
        self.calls += 1
        if self.error:
            raise self.error
        return self.text
