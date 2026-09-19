"""Deterministic demo judge: meeting phrases -> ACTION, otherwise ABSTAIN.

This exists so the demo can run without a live provider. It is pattern
matching over the supplied context, labeled as such in every Verdict
(``model="pattern-demo"``), selected only by an explicit ``--judge pattern``,
and never a fallback for a missing key. It implements the same
:class:`caret.judge.Judge` interface the Jev and Gateway clients do, so the
router, the acceptance rules and the workflow seam are exercised unchanged; the
only thing replaced is the model's opinion.

Route question: ACTION when the field text, selection or clipboard contains a
scheduling phrase, else ABSTAIN. It never answers INLINE, because there is no
writer behind a pattern and an empty inline offer would be a fake result.
Workflow question: ``book-calendar-link`` when that ID is among the offered
choices, else NONE.
"""

from __future__ import annotations

import re

from .context import ContextFrame
from .judge import ABSTAIN, ACTION, NONE, Question, Verdict, validate_choice

MEETING_WORKFLOW = "book-calendar-link"

# Phrases a scheduling request tends to contain. Case-insensitive, whole words.
# This list is a demo heuristic, not a measured classifier.
MEETING_PATTERNS = (
    r"\bmeet(?:ing)?\b",
    r"\bschedule\b",
    r"\bcalendar\b",
    r"\b(?:find|send|propose|suggest)\s+(?:a\s+|some\s+|three\s+)?times?\b",
    r"\bavailab(?:le|ility)\b",
    r"\bwhen\s+(?:are|would)\s+you\s+free\b",
    r"\bcatch\s*up\b",
    r"\bcall\b.*\b(?:next|this)\s+(?:week|monday|tuesday|wednesday|thursday|friday)\b",
)
_MATCHER = re.compile("|".join(f"(?:{p})" for p in MEETING_PATTERNS), re.IGNORECASE)


def match_meeting(text: str) -> str | None:
    """The first scheduling phrase found in ``text``, or None."""
    found = _MATCHER.search(text or "")
    return found.group(0) if found else None


class PatternJudge:
    """Answers both judge questions from the phrase list above."""

    def choose(self, question: Question, frame: ContextFrame) -> Verdict:
        if question.key == "route":
            return self._route(question, frame)
        if question.key == "workflow":
            choice = MEETING_WORKFLOW if MEETING_WORKFLOW in question.choice_ids else NONE
            return validate_choice(
                question, choice, frame.revision, reason="pattern-demo", model="pattern-demo"
            )
        return validate_choice(question, question.choice_ids[-1], frame.revision, model="pattern-demo")

    def _route(self, question: Question, frame: ContextFrame) -> Verdict:
        snapshot = frame.snapshot
        sources = [("field", snapshot.nearby_text)]
        if snapshot.has_selection:
            sources.append(("selection", snapshot.selected_text()))
        if frame.clipboard.available:
            sources.append(("clipboard", frame.clipboard.text))
        for name, text in sources:
            phrase = match_meeting(text)
            if phrase:
                return validate_choice(
                    question,
                    ACTION,
                    frame.revision,
                    reason=f"pattern-demo: matched '{phrase}' in {name}",
                    model="pattern-demo",
                )
        return validate_choice(
            question, ABSTAIN, frame.revision, reason="pattern-demo: no scheduling phrase", model="pattern-demo"
        )
