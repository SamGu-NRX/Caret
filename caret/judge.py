"""The one judge interface every decision point goes through.

Context in, an explicit list of allowed choices in, one validated choice out.
The app and individual workflows share this rather than each growing a private
router. The judge never returns code, a path, a command or a free-form target:
whatever comes back is matched against the choice IDs the caller supplied, and
anything else is a :class:`JudgeError`.

Two questions use it. :data:`ROUTE_CHOICES` decides whether Caret has anything
to offer at all. The workflow question runs only after ACTION wins, and its
choices are the workflows the registry reports as available right now.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from .context import ContextFrame, InputSnapshot, utf16_length, utf16_slice

ABSTAIN = "ABSTAIN"
INLINE = "INLINE"
ACTION = "ACTION"
NONE = "NONE"


class JudgeError(RuntimeError):
    """The judge was unreachable, or answered with something unusable."""


@dataclass(frozen=True)
class Choice:
    id: str
    label: str
    detail: str = ""

    def to_dict(self) -> dict:
        return {"id": self.id, "label": self.label, "detail": self.detail}


@dataclass(frozen=True)
class Question:
    """A decision point. ``key`` names it for logs and telemetry."""

    key: str
    prompt: str
    choices: tuple[Choice, ...]

    def __post_init__(self) -> None:
        if not self.choices:
            raise JudgeError(f"Question '{self.key}' has no choices; do not ask")
        ids = [choice.id for choice in self.choices]
        if len(set(ids)) != len(ids):
            raise JudgeError(f"Question '{self.key}' has duplicate choice IDs")

    @property
    def choice_ids(self) -> tuple[str, ...]:
        return tuple(choice.id for choice in self.choices)


@dataclass(frozen=True)
class Verdict:
    """One validated choice, tagged with the snapshot it was asked about."""

    question_key: str
    choice_id: str
    revision: int
    reason: str = ""
    latency_ms: float = 0.0
    model: str = ""

    def to_dict(self) -> dict:
        return {
            "question": self.question_key,
            "choice": self.choice_id,
            "revision": self.revision,
            "reason": self.reason,
            "latency_ms": round(self.latency_ms, 1),
            "model": self.model,
        }


ROUTE_CHOICES = (
    Choice(ABSTAIN, "Stay quiet", "Nothing useful to offer for this context."),
    Choice(
        INLINE,
        "Offer inline text",
        "A short continuation or a simple correction the user can accept with Tab.",
    ),
    Choice(
        ACTION,
        "Offer an action",
        "A larger rewrite, navigation or cross-application task that a workflow performs.",
    ),
)


def route_question() -> Question:
    return Question(
        key="route",
        prompt=(
            "Decide what Caret should do about the user's current typing context. "
            "Choose ABSTAIN unless an offer would clearly help right now."
        ),
        choices=ROUTE_CHOICES,
    )


def workflow_question(choices: tuple[Choice, ...]) -> Question:
    """Ask which registered workflow fits. NONE is always available."""
    return Question(
        key="workflow",
        prompt=(
            "An action is worth offering. Choose the single registered workflow that matches "
            "the user's context, or NONE if no listed workflow fits."
        ),
        choices=choices + (Choice(NONE, "No workflow fits", "Offer nothing rather than a poor match."),),
    )


def validate_choice(question: Question, raw_choice: object, revision: int, **extra) -> Verdict:
    """Accept a provider's answer only when it names one of our own choices."""
    if not isinstance(raw_choice, str):
        raise JudgeError(
            f"Question '{question.key}' expected a choice ID string, got {type(raw_choice).__name__}"
        )
    choice = raw_choice.strip()
    if choice not in question.choice_ids:
        raise JudgeError(
            f"Question '{question.key}' answered '{choice[:64]}', which is not one of "
            f"{list(question.choice_ids)}"
        )
    return Verdict(question_key=question.key, choice_id=choice, revision=revision, **extra)


class Judge(Protocol):
    """What the router needs. Implemented by the Jev client and by test fakes."""

    def choose(self, question: Question, frame: ContextFrame) -> Verdict:  # pragma: no cover - protocol
        ...


class Writer(Protocol):
    """Generates inline text. Separate from the judge on purpose: Jev classifies,
    it does not write the user's prose."""

    def complete(self, frame: ContextFrame, instruction: str) -> str:  # pragma: no cover - protocol
        ...


def _split_at_caret(snapshot: InputSnapshot) -> tuple[str, str]:
    """The window's text before and after the caret.

    The split counts UTF-16 code units, not Python code points, because ``caret``
    is a UTF-16 offset. Indexing the Python string instead puts the caret past
    every astral character that precedes it: with "a🌊b" and the caret at UTF-16
    offset 3, code-point indexing reports the whole string as "before" and
    nothing as "after", which tells the model the caret is in the wrong place.
    """
    window = utf16_length(snapshot.nearby_text)
    caret_in_window = min(max(0, snapshot.caret - snapshot.text_offset), window)
    return (
        utf16_slice(snapshot.nearby_text, 0, caret_in_window),
        utf16_slice(snapshot.nearby_text, caret_in_window, window),
    )


def describe_frame(frame: ContextFrame, *, include_text: bool = True) -> str:
    """Render a frame as the compact block both providers receive.

    Unavailable sources are stated as unavailable rather than omitted, so the
    model cannot read silence as "nothing was happening".
    """
    snapshot = frame.snapshot
    before, after = _split_at_caret(snapshot) if include_text else ("", "")
    lines = [
        f"Application: {snapshot.target.bundle_id} (window {snapshot.target.window_id})",
        f"Field role: {snapshot.role}",
        f"Caret at UTF-16 offset {snapshot.caret}; "
        + (
            f"selection [{snapshot.selection_start}, {snapshot.selection_end})"
            if snapshot.has_selection
            else "no selection"
        ),
    ]
    if include_text:
        lines.append(f"Text before caret: {before!r}")
        lines.append(f"Text after caret: {after!r}")
        if snapshot.has_selection:
            lines.append(f"Selected text: {snapshot.selected_text()!r}")

    if frame.clipboard.available:
        lines.append(
            f"Clipboard ({utf16_length(frame.clipboard.text)} UTF-16 units): {frame.clipboard.text!r}"
            if include_text
            else "Clipboard: available"
        )
    else:
        lines.append("Clipboard: unavailable")

    if frame.history:
        lines.append("Recent history:")
        lines.extend(
            f"  - [{item.source_id} @ {item.captured_at.isoformat()}] {item.app}: {item.text}"
            for item in frame.history
        )
    else:
        lines.append("Recent history: none supplied")

    if frame.observations:
        lines.append("Computer-use observations and results:")
        lines.extend(
            f"  - [{item.source_id} @ {item.captured_at.isoformat()}] {item.kind}/{item.status}: {item.summary}"
            for item in frame.observations
        )
    else:
        lines.append("Computer-use observations: none supplied")

    unavailable = [record.name for record in frame.sources if not record.available]
    if unavailable:
        lines.append(f"Unavailable sources: {', '.join(unavailable)}")
    return "\n".join(lines)


def frame_state(frame: ContextFrame) -> dict:
    """The structured ``state`` object Jev receives.

    Same content as :func:`describe_frame`, shaped as JSON because Jev takes a
    free-form state object rather than a prompt string. Absent sources appear
    as ``{"available": false}`` rather than being dropped, so a quiet clipboard
    cannot be read as an empty one.
    """
    snapshot = frame.snapshot
    before, after = _split_at_caret(snapshot)
    return {
        "application": {
            "bundle_id": snapshot.target.bundle_id,
            "window_id": snapshot.target.window_id,
            "field_role": snapshot.role,
        },
        "field": {
            "text_before_caret": before,
            "text_after_caret": after,
            "selected_text": snapshot.selected_text() if snapshot.has_selection else "",
            "caret_offset_utf16": snapshot.caret,
            "has_selection": snapshot.has_selection,
        },
        "clipboard": (
            {"available": True, "text": frame.clipboard.text}
            if frame.clipboard.available
            else {"available": False}
        ),
        "history": [
            {
                "source_id": item.source_id,
                "captured_at": item.captured_at.isoformat(),
                "application": item.app,
                "text": item.text,
            }
            for item in frame.history
        ],
        "computer_use": [
            {
                "source_id": item.source_id,
                "captured_at": item.captured_at.isoformat(),
                "kind": item.kind,
                "status": item.status,
                "summary": item.summary,
            }
            for item in frame.observations
        ],
        "sources": [record.to_dict() for record in frame.sources],
    }
