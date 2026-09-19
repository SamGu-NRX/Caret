"""Typed records the app boundary sends in, and the helpers that validate them.

The app observes macOS; this module never does. Every field here is supplied by
the caller, including whether a field is secure, whether an input method is
composing and whether Accessibility is still granted. The core decides what to
do with those facts and refuses to guess when one is missing.

Text offsets are UTF-16 code units because that is what the Accessibility API
returns for ``kAXSelectedTextRange``. Python strings index by code point, so
call :func:`utf16_length` and :func:`utf16_slice` rather than using ``len()``
when a number will cross the boundary back to the app.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

# Bounds. The app is expected to send a window around the caret, not a whole
# document. Exceeding a bound is an error rather than a silent truncation:
# truncating text would shift the UTF-16 offsets that an edit is applied at.
MAX_NEARBY_TEXT = 4000
MAX_CLIPBOARD_TEXT = 2000
MAX_HISTORY_ITEMS = 20
MAX_HISTORY_TEXT = 1000
MAX_OBSERVATIONS = 10
MAX_OBSERVATION_TEXT = 1000


class ContextError(ValueError):
    """A context record was missing, malformed or out of bounds."""


def utf16_length(text: str) -> int:
    """Length in UTF-16 code units, matching Accessibility range arithmetic."""
    return len(text.encode("utf-16-le")) // 2


def utf16_slice(text: str, start: int, end: int) -> str:
    """Slice by UTF-16 code units. Raises on a split surrogate pair."""
    if start < 0 or end < start:
        raise ContextError(f"Invalid UTF-16 range [{start}, {end})")
    units = text.encode("utf-16-le")
    if end * 2 > len(units):
        raise ContextError(f"UTF-16 range [{start}, {end}) exceeds text of {utf16_length(text)} units")
    try:
        return units[start * 2 : end * 2].decode("utf-16-le")
    except UnicodeDecodeError as error:
        raise ContextError(f"UTF-16 range [{start}, {end}) splits a surrogate pair") from error


def digest(text: str) -> str:
    """Short content digest. Logs and wire records carry this, never the text."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _require(payload: Any, key: str, kind: type, where: str) -> Any:
    if not isinstance(payload, dict):
        raise ContextError(f"{where} must be an object")
    if key not in payload:
        raise ContextError(f"{where} is missing required field '{key}'")
    value = payload[key]
    if kind is int and isinstance(value, bool):
        raise ContextError(f"{where}.{key} must be {kind.__name__}, got bool")
    if not isinstance(value, kind):
        raise ContextError(f"{where}.{key} must be {kind.__name__}, got {type(value).__name__}")
    return value


def _require_time(payload: Any, key: str, where: str) -> datetime:
    raw = _require(payload, key, str, where)
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as error:
        raise ContextError(f"{where}.{key} must be an ISO 8601 timestamp") from error
    if parsed.tzinfo is None:
        raise ContextError(f"{where}.{key} must include a timezone offset")
    return parsed


def _bounded(text: str, limit: int, where: str) -> str:
    if utf16_length(text) > limit:
        raise ContextError(f"{where} exceeds the {limit} UTF-16 unit bound; the app must send a bounded window")
    return text


@dataclass(frozen=True)
class TargetIdentity:
    """Which field an offer belongs to. An edit is rechecked against this."""

    pid: int
    bundle_id: str
    window_id: str
    element_id: str
    element_revision: str
    """Caller's change token for the element's value. Two snapshots with the same
    element_revision describe the same underlying text."""

    @classmethod
    def from_dict(cls, payload: Any, where: str = "target") -> "TargetIdentity":
        return cls(
            pid=_require(payload, "pid", int, where),
            bundle_id=_require(payload, "bundle_id", str, where),
            window_id=_require(payload, "window_id", str, where),
            element_id=_require(payload, "element_id", str, where),
            element_revision=_require(payload, "element_revision", str, where),
        )

    def to_dict(self) -> dict:
        return {
            "pid": self.pid,
            "bundle_id": self.bundle_id,
            "window_id": self.window_id,
            "element_id": self.element_id,
            "element_revision": self.element_revision,
        }


@dataclass(frozen=True)
class Permissions:
    """What the app reports macOS currently grants it."""

    accessibility: bool
    screen_recording: bool = False
    input_monitoring: bool = False

    @classmethod
    def from_dict(cls, payload: Any, where: str = "permissions") -> "Permissions":
        return cls(
            accessibility=_require(payload, "accessibility", bool, where),
            screen_recording=bool(payload.get("screen_recording", False)),
            input_monitoring=bool(payload.get("input_monitoring", False)),
        )

    def to_dict(self) -> dict:
        return {
            "accessibility": self.accessibility,
            "screen_recording": self.screen_recording,
            "input_monitoring": self.input_monitoring,
        }


@dataclass(frozen=True)
class InputSnapshot:
    """One reading of the focused field, as the app saw it.

    ``nearby_text`` is a bounded window, not the whole value. ``text_offset`` is
    where that window starts inside the full value, and ``caret``/``selection``
    are absolute offsets in the full value. Keeping them absolute means an
    accepted edit names a range the app can apply without re-deriving the window.
    """

    revision: int
    captured_at: datetime
    target: TargetIdentity
    role: str
    nearby_text: str
    text_offset: int
    caret: int
    selection_start: int
    selection_end: int
    secure: bool = False
    ime_composing: bool = False
    app_excluded: bool = False
    value_length: int | None = None

    def __post_init__(self) -> None:
        if self.revision < 0:
            raise ContextError("snapshot.revision must be nonnegative")
        _bounded(self.nearby_text, MAX_NEARBY_TEXT, "snapshot.nearby_text")
        window = utf16_length(self.nearby_text)
        if self.text_offset < 0:
            raise ContextError("snapshot.text_offset must be nonnegative")
        if self.selection_end < self.selection_start:
            raise ContextError("snapshot.selection_end must not precede selection_start")
        for name, value in (("caret", self.caret), ("selection_start", self.selection_start)):
            if value < 0:
                raise ContextError(f"snapshot.{name} must be nonnegative")
        window_end = self.text_offset + window
        for name, value in (
            ("caret", self.caret),
            ("selection_start", self.selection_start),
            ("selection_end", self.selection_end),
        ):
            if not self.text_offset <= value <= window_end:
                raise ContextError(
                    f"snapshot.{name}={value} falls outside the supplied window "
                    f"[{self.text_offset}, {window_end}]; send a window that contains the caret"
                )
        if self.value_length is not None and self.value_length < window_end:
            raise ContextError("snapshot.value_length is shorter than the supplied window")

    @property
    def text_digest(self) -> str:
        return digest(self.nearby_text)

    @property
    def has_selection(self) -> bool:
        return self.selection_end > self.selection_start

    def selected_text(self) -> str:
        """The selection, resolved inside the supplied window."""
        return utf16_slice(
            self.nearby_text,
            self.selection_start - self.text_offset,
            self.selection_end - self.text_offset,
        )

    @classmethod
    def from_dict(cls, payload: Any, where: str = "snapshot") -> "InputSnapshot":
        nearby = _require(payload, "nearby_text", str, where)
        selection = payload.get("selection") or {}
        if not isinstance(selection, dict):
            raise ContextError(f"{where}.selection must be an object")
        caret = _require(payload, "caret", int, where)
        value_length = payload.get("value_length")
        if value_length is not None and (isinstance(value_length, bool) or not isinstance(value_length, int)):
            raise ContextError(f"{where}.value_length must be an integer or null")
        return cls(
            revision=_require(payload, "revision", int, where),
            captured_at=_require_time(payload, "captured_at", where),
            target=TargetIdentity.from_dict(payload.get("target"), f"{where}.target"),
            role=_require(payload, "role", str, where),
            nearby_text=nearby,
            text_offset=_require(payload, "text_offset", int, where),
            caret=caret,
            selection_start=int(selection.get("start", caret)),
            selection_end=int(selection.get("end", caret)),
            secure=bool(payload.get("secure", False)),
            ime_composing=bool(payload.get("ime_composing", False)),
            app_excluded=bool(payload.get("app_excluded", False)),
            value_length=value_length,
        )

    def to_dict(self) -> dict:
        return {
            "revision": self.revision,
            "captured_at": self.captured_at.isoformat(),
            "target": self.target.to_dict(),
            "role": self.role,
            "text_offset": self.text_offset,
            "caret": self.caret,
            "selection": {"start": self.selection_start, "end": self.selection_end},
            "secure": self.secure,
            "ime_composing": self.ime_composing,
            "app_excluded": self.app_excluded,
            "value_length": self.value_length,
            "text_digest": self.text_digest,
        }


@dataclass(frozen=True)
class SourceRecord:
    """One supplied context source, present or explicitly absent.

    ``available=False`` is a first-class state. An unavailable clipboard or
    history provider stays visibly empty; it never becomes invented context.
    """

    name: str
    available: bool
    captured_at: datetime | None = None
    detail: str = ""

    def age_seconds(self, now: datetime) -> float | None:
        if self.captured_at is None:
            return None
        return (now - self.captured_at).total_seconds()

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "available": self.available,
            "captured_at": self.captured_at.isoformat() if self.captured_at else None,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class ClipboardContext:
    """Clipboard text the app has decided Caret may read. Observation only."""

    available: bool
    text: str = ""
    captured_at: datetime | None = None

    def __post_init__(self) -> None:
        _bounded(self.text, MAX_CLIPBOARD_TEXT, "clipboard.text")

    @property
    def text_digest(self) -> str:
        return digest(self.text)

    @classmethod
    def from_dict(cls, payload: Any, where: str = "clipboard") -> "ClipboardContext":
        if payload is None:
            return cls(available=False)
        available = _require(payload, "available", bool, where)
        if not available:
            return cls(available=False)
        return cls(
            available=True,
            text=_require(payload, "text", str, where),
            captured_at=_require_time(payload, "captured_at", where),
        )

    def to_dict(self) -> dict:
        return {
            "available": self.available,
            "captured_at": self.captured_at.isoformat() if self.captured_at else None,
            "text_digest": self.text_digest if self.available else None,
        }


@dataclass(frozen=True)
class HistoryItem:
    """One Screenpipe result, supplied by the context owner with its provenance."""

    source_id: str
    captured_at: datetime
    text: str
    app: str = ""

    def __post_init__(self) -> None:
        _bounded(self.text, MAX_HISTORY_TEXT, "history.text")

    @classmethod
    def from_dict(cls, payload: Any, where: str = "history[]") -> "HistoryItem":
        return cls(
            source_id=_require(payload, "source_id", str, where),
            captured_at=_require_time(payload, "captured_at", where),
            text=_require(payload, "text", str, where),
            app=str(payload.get("app", "")),
        )

    def to_dict(self) -> dict:
        return {
            "source_id": self.source_id,
            "captured_at": self.captured_at.isoformat(),
            "app": self.app,
            "text": self.text,
        }


@dataclass(frozen=True)
class Observation:
    """A recent computer-use observation or the result of a finished step."""

    source_id: str
    captured_at: datetime
    kind: str
    summary: str
    status: str = "ok"

    def __post_init__(self) -> None:
        if self.kind not in ("observation", "result"):
            raise ContextError("observation.kind must be 'observation' or 'result'")
        _bounded(self.summary, MAX_OBSERVATION_TEXT, "observation.summary")

    @classmethod
    def from_dict(cls, payload: Any, where: str = "observations[]") -> "Observation":
        return cls(
            source_id=_require(payload, "source_id", str, where),
            captured_at=_require_time(payload, "captured_at", where),
            kind=_require(payload, "kind", str, where),
            summary=_require(payload, "summary", str, where),
            status=str(payload.get("status", "ok")),
        )

    def to_dict(self) -> dict:
        return {
            "source_id": self.source_id,
            "captured_at": self.captured_at.isoformat(),
            "kind": self.kind,
            "summary": self.summary,
            "status": self.status,
        }


@dataclass(frozen=True)
class ContextFrame:
    """Everything one evaluation may look at.

    ``workflow_active`` and ``permissions`` are here rather than on the snapshot
    because they describe the session, not the field.
    """

    snapshot: InputSnapshot
    permissions: Permissions
    clipboard: ClipboardContext = ClipboardContext(available=False)
    history: tuple[HistoryItem, ...] = ()
    observations: tuple[Observation, ...] = ()
    sources: tuple[SourceRecord, ...] = ()
    workflow_active: bool = False

    def __post_init__(self) -> None:
        if len(self.history) > MAX_HISTORY_ITEMS:
            raise ContextError(f"history holds at most {MAX_HISTORY_ITEMS} items")
        if len(self.observations) > MAX_OBSERVATIONS:
            raise ContextError(f"observations holds at most {MAX_OBSERVATIONS} items")

    @property
    def revision(self) -> int:
        return self.snapshot.revision

    def signature(self) -> str:
        """Stable identity of this frame's content, for same-snapshot dedupe.

        Two frames sharing a signature would produce the same question, so the
        second one does not earn another model call.

        Every ``TargetIdentity`` field is included, PID among them. A relaunched
        application can reuse its bundle ID, window ID and element ID, so leaving
        the PID out let a new process inherit the previous one's signature and
        keep an offer built for a window that no longer exists.
        """
        parts = [
            str(self.snapshot.target.pid),
            self.snapshot.target.bundle_id,
            self.snapshot.target.window_id,
            self.snapshot.target.element_id,
            self.snapshot.target.element_revision,
            self.snapshot.role,
            self.snapshot.text_digest,
            str(self.snapshot.caret),
            f"{self.snapshot.selection_start}:{self.snapshot.selection_end}",
            self.clipboard.text_digest if self.clipboard.available else "-",
            ",".join(item.source_id for item in self.history),
            ",".join(item.source_id for item in self.observations),
        ]
        return digest("\x1f".join(parts))

    def stale_sources(self, now: datetime, max_age_seconds: float) -> tuple[str, ...]:
        """Named sources whose capture time is older than the caller's bound."""
        late = []
        for record in self.sources:
            age = record.age_seconds(now)
            if record.available and age is not None and age > max_age_seconds:
                late.append(record.name)
        return tuple(late)

    @classmethod
    def from_dict(cls, payload: Any, where: str = "frame") -> "ContextFrame":
        if not isinstance(payload, dict):
            raise ContextError(f"{where} must be an object")
        history = payload.get("history") or []
        observations = payload.get("observations") or []
        sources = payload.get("sources") or []
        if not isinstance(history, list) or not isinstance(observations, list) or not isinstance(sources, list):
            raise ContextError(f"{where}.history, .observations and .sources must be arrays")
        return cls(
            snapshot=InputSnapshot.from_dict(payload.get("snapshot"), f"{where}.snapshot"),
            permissions=Permissions.from_dict(payload.get("permissions"), f"{where}.permissions"),
            clipboard=ClipboardContext.from_dict(payload.get("clipboard"), f"{where}.clipboard"),
            history=tuple(HistoryItem.from_dict(item, f"{where}.history[]") for item in history),
            observations=tuple(Observation.from_dict(item, f"{where}.observations[]") for item in observations),
            sources=tuple(
                SourceRecord(
                    name=_require(item, "name", str, f"{where}.sources[]"),
                    available=_require(item, "available", bool, f"{where}.sources[]"),
                    captured_at=_require_time(item, "captured_at", f"{where}.sources[]")
                    if item.get("captured_at")
                    else None,
                    detail=str(item.get("detail", "")),
                )
                for item in sources
            ),
            workflow_active=bool(payload.get("workflow_active", False)),
        )

    def to_dict(self) -> dict:
        return {
            "snapshot": self.snapshot.to_dict(),
            "permissions": self.permissions.to_dict(),
            "clipboard": self.clipboard.to_dict(),
            "history": [item.to_dict() for item in self.history],
            "observations": [item.to_dict() for item in self.observations],
            "sources": [item.to_dict() for item in self.sources],
            "workflow_active": self.workflow_active,
            "signature": self.signature(),
        }


def now_utc() -> datetime:
    return datetime.now(timezone.utc)
