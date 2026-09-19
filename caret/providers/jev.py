"""Jev judge client, verified against the pinned computer-use-jev Go client.

Jev takes a free-form ``state`` object plus a map of typed questions and
returns one answer per question. Caret asks one Choice question at a time: the
route question always, and the workflow question only after ACTION wins.

Wire contract (POST https://api.typesafe.ai/v1/systemone, bearer auth):

    {"state": {...}, "model": "jev-latest",
     "questions": {"route": {"type": "choice",
                             "instructions": "...",
                             "criteria": {"ABSTAIN": "...", "INLINE": "...", "ACTION": "..."}}}}
    -> {"model": "jev-1.x", "answers": {"route": {"type": "choice", "choice": "INLINE",
                                                  "probabilities": {...}, "confidence": 0.59}},
        "usage": {"input_tokens": n, "output_tokens": n}}

The answer's ``choice`` is an option key, so the criteria keys are Caret's own
choice IDs and :func:`caret.judge.validate_choice` rejects anything else.
``confidence`` is recorded for telemetry and is not used as a gate: no
task-specific evaluation exists that would make a cutoff meaningful.

References: typesafe/client.go:17-20, 74-93, 126-149, 172-194 at pinned commit
ff0ad8ba8e25755d37fb8d93718144c4568a596b; https://docs.typesafe.ai/api.
"""

from __future__ import annotations

import os
import time

from ..context import ContextFrame
from ..judge import Question, Verdict, frame_state, validate_choice
from ..judge import JudgeError
from .http import ProviderHTTPError, post_json

DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
DEFAULT_MODEL = "jev-latest"
API_KEY_ENV = "TYPESAFE_API_KEY"
ENDPOINT_ENV = "TYPESAFE_ENDPOINT"
MODEL_ENV = "TYPESAFE_MODEL"


class JevJudge:
    """Real Jev client. Construct it only when a key is configured."""

    def __init__(
        self,
        api_key: str,
        endpoint: str = DEFAULT_ENDPOINT,
        model: str = DEFAULT_MODEL,
        timeout: float = 8.0,
    ) -> None:
        if not api_key:
            raise JudgeError(f"A Jev API key is required; set {API_KEY_ENV}")
        self._api_key = api_key
        self.endpoint = endpoint
        self.model = model
        self.timeout = timeout
        """Bounded per-request duration. The upstream Go client allows 60s; an
        ambient loop on a two-second cadence cannot wait that long, so this is
        deliberately shorter."""

    @classmethod
    def from_env(cls, timeout: float = 8.0) -> "JevJudge":
        """Build from configuration. Raises when unset; never falls back to a mock."""
        key = os.environ.get(API_KEY_ENV, "")
        if not key:
            raise JudgeError(
                f"{API_KEY_ENV} is not set. Configure a Jev key, or select a scripted judge "
                "explicitly for offline work."
            )
        return cls(
            api_key=key,
            endpoint=os.environ.get(ENDPOINT_ENV, DEFAULT_ENDPOINT),
            model=os.environ.get(MODEL_ENV, DEFAULT_MODEL),
            timeout=timeout,
        )

    def choose(self, question: Question, frame: ContextFrame) -> Verdict:
        payload = {
            "state": frame_state(frame),
            "model": self.model,
            "questions": {
                question.key: {
                    "type": "choice",
                    "instructions": question.prompt,
                    "criteria": {choice.id: choice.detail or choice.label for choice in question.choices},
                }
            },
        }
        started = time.monotonic()
        try:
            body = post_json(
                self.endpoint,
                payload,
                {"Authorization": f"Bearer {self._api_key}"},
                self.timeout,
            )
        except ProviderHTTPError as error:
            raise JudgeError(str(error)) from None
        latency_ms = (time.monotonic() - started) * 1000

        answers = body.get("answers")
        if not isinstance(answers, dict) or question.key not in answers:
            raise JudgeError(
                f"Jev response has no answer for '{question.key}'; keys were "
                f"{sorted(answers) if isinstance(answers, dict) else type(answers).__name__}"
            )
        answer = answers[question.key]
        if not isinstance(answer, dict):
            raise JudgeError(f"Jev answer for '{question.key}' is {type(answer).__name__}, expected an object")
        if answer.get("type") != "choice":
            raise JudgeError(f"Jev answered '{question.key}' with type '{answer.get('type')}', expected 'choice'")

        confidence = answer.get("confidence")
        reason = f"confidence={confidence}" if isinstance(confidence, (int, float)) else ""
        return validate_choice(
            question,
            answer.get("choice"),
            frame.revision,
            reason=reason,
            latency_ms=latency_ms,
            model=str(body.get("model", self.model)),
        )
