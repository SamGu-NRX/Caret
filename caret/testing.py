"""Scripted stand-ins for the two providers.

These exist so tests and the integration example can exercise the real bridge
process without a network call. They are never selected implicitly: the bridge
only builds one when a caller passes ``scripted:<path>``, and a missing API key
produces an error rather than quietly landing here.

A script is a JSON object whose values are lists consumed in order::

    {"route":    ["ACTION", "ABSTAIN"],
     "workflow": ["book-calendar-link"],
     "inline":   ["rest of the sentence"]}

A list entry is either a literal answer or ``{"error": "message"}`` to make the
provider fail on that call. The last entry repeats once the list runs out, so a
script does not have to predict how many ticks a session will take.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

from .context import ContextFrame
from .engine import ProviderFailure
from .judge import JudgeError, Question, Verdict, validate_choice


class ScriptExhausted(RuntimeError):
    """A scripted provider was asked something its script does not cover."""


class _Tape:
    """Reads a list once through, then repeats its last entry."""

    def __init__(self, entries: list, name: str) -> None:
        if not entries:
            raise ScriptExhausted(f"Script section '{name}' is empty")
        self._entries = entries
        self._name = name
        self._index = 0
        self._lock = threading.Lock()

    def next(self):
        with self._lock:
            entry = self._entries[min(self._index, len(self._entries) - 1)]
            self._index += 1
            return entry


def _load(path: Path) -> dict:
    data = json.loads(Path(path).read_text())
    if not isinstance(data, dict):
        raise ScriptExhausted(f"{path} must contain a JSON object")
    return data


class ScriptedJudge:
    """Answers the route and workflow questions from a script."""

    def __init__(self, script: dict) -> None:
        self._tapes = {
            key: _Tape(value, key) for key, value in script.items() if key in ("route", "workflow")
        }

    @classmethod
    def from_file(cls, path: Path) -> "ScriptedJudge":
        return cls(_load(path))

    def choose(self, question: Question, frame: ContextFrame) -> Verdict:
        tape = self._tapes.get(question.key)
        if tape is None:
            raise ScriptExhausted(f"Script has no '{question.key}' section")
        entry = tape.next()
        if isinstance(entry, dict) and "error" in entry:
            raise JudgeError(str(entry["error"]))
        return validate_choice(question, entry, frame.revision, model="scripted")


class ScriptedWriter:
    """Returns inline text from a script."""

    def __init__(self, script: dict) -> None:
        self._tape = _Tape(script.get("inline", []), "inline") if script.get("inline") else None

    @classmethod
    def from_file(cls, path: Path) -> "ScriptedWriter":
        return cls(_load(path))

    def complete(self, frame: ContextFrame, instruction: str) -> str:
        if self._tape is None:
            raise ProviderFailure("Script has no 'inline' section")
        entry = self._tape.next()
        if isinstance(entry, dict) and "error" in entry:
            raise ProviderFailure(str(entry["error"]))
        return str(entry)
