"""Vercel AI Gateway presets: an inline writer and an LLM classifier.

Neither is a default. Jev (TypeSafe) remains Caret's product judge; these exist
so the whole loop can be exercised with one Gateway key when no Jev key is
available, and they are selected only by an explicit ``--judge gateway`` or
``--writer gateway``.

Wire contract, from Vercel's current public documentation:

    POST https://ai-gateway.vercel.sh/v1/chat/completions
    Content-Type: application/json
    Authorization: Bearer $AI_GATEWAY_API_KEY
    {"model": "creator/model-name", "messages": [...], "max_tokens": n, ...}
    -> {"id": ..., "object": "chat.completion", "model": ...,
        "choices": [{"message": {"content": "..."}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": n, "completion_tokens": n, "total_tokens": n}}

Documented details this module depends on:

* ``AI_GATEWAY_API_KEY`` is the documented variable for a raw client. A Vercel
  OIDC token works in the same ``Bearer`` header, but an API key takes
  precedence over an OIDC token even when the key is invalid, so a stale key
  cannot be recovered from by also supplying a token.
* Model IDs are ``creator/model-name``. The catalog and
  ``GET /v1/models`` list the available IDs.
* ``max_tokens`` is the documented maximum-generation request parameter.
  ``max_completion_tokens`` is not listed as a request parameter, so this preset
  sends ``max_tokens``.
* Structured output uses the OpenAI ``response_format`` ``json_schema`` shape.
  The documented examples use required properties and
  ``additionalProperties: false`` and do not show ``strict: true``, so this
  module sends the schema without ``strict``. Vercel states the selected model
  and provider must accept the format; the capability metadata for the cheap
  models below does not list ``response_format``, and Vercel treats that
  metadata as optional rather than authoritative, so support per model is
  unconfirmed here. The documented positive example uses ``openai/gpt-6-astra``,
  which is the override to reach for if a chosen model rejects the format.
* Errors use ``{"error": {"message": ..., "type": ...}}``, with 401 for a bad or
  missing key, 404 for an unknown model or endpoint, 403 for a model blocked by
  free-tier or allowlist rules, and 429 for a rate limit. Vercel does not
  publish the exact bad-key or bad-model bodies, so nothing here matches on
  message text.

Sources (read 2026-09-19):
https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions,
.../chat-completions, .../structured-outputs, .../rest-api,
https://vercel.com/docs/ai-gateway/getting-started,
https://vercel.com/docs/ai-gateway/models-and-providers,
https://vercel.com/docs/ai-gateway/rate-limits,
https://vercel.com/docs/ai-gateway/faq,
https://vercel.com/ai-gateway/models and the per-model pages for
amazon/nova-micro, anthropic/claude-3-haiku, google/gemini-2.5-flash-lite and
google/gemini-3.1-flash-lite.

No call has been made to this service from this branch. Everything above is the
published contract, and the tests below use a fake transport.
"""

from __future__ import annotations

import json
import os

from ..context import ContextFrame
from ..engine import ProviderFailure
from ..judge import JudgeError, Question, Verdict, describe_frame, validate_choice
from .http import post_json
from .openai_chat import (
    MAX_TOKENS_FIELD,
    ChatError,
    OpenAIChatClient,
    inline_completion,
)

DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v1"
DEFAULT_ENDPOINT = f"{DEFAULT_BASE_URL}/chat/completions"

# amazon/nova-micro is the cheapest model among the fast text models in the
# dossier: $0.035 per 1M input and $0.14 per 1M output tokens, against $0.10/
# $0.40 for google/gemini-2.5-flash-lite and $0.25/$1.25 for
# anthropic/claude-3-haiku. Its model page names "Autocomplete and inline
# suggestion features" and "Text classification, sentiment analysis, and entity
# extraction at scale", which are exactly the two jobs here, so the same default
# serves the writer and the judge. This is a documented price-and-fit choice,
# not a measured latency or quality result for Caret's inputs.
DEFAULT_MODEL = "amazon/nova-micro"
DEFAULT_JUDGE_MODEL = "amazon/nova-micro"

API_KEY_ENV = "AI_GATEWAY_API_KEY"
ENDPOINT_ENV = "AI_GATEWAY_ENDPOINT"
MODEL_ENV = "AI_GATEWAY_MODEL"
JUDGE_MODEL_ENV = "AI_GATEWAY_JUDGE_MODEL"

MISSING_KEY = (
    f"{API_KEY_ENV} is not set. Configure a Vercel AI Gateway key, or select a scripted "
    "provider explicitly for offline work."
)

JUDGE_SYSTEM_PROMPT = (
    "You are a strict classifier inside a text-input assistant. Choose exactly one of the "
    "option IDs you are given. Reply with only a JSON object of the form "
    '{"choice": "<one of the given IDs>", "reason": "<short justification>"}. '
    "Never invent an ID, never choose more than one, never add commentary and never wrap the "
    "JSON in markdown."
)

MAX_REASON_CHARS = 200
"""The reason is telemetry shown in logs, so a long one is truncated rather than
carried around whole."""


def choice_response_format(choice_ids: tuple[str, ...]) -> dict:
    """The ``json_schema`` response format for one question's choice IDs.

    The enum is Caret's own list, so a schema-honouring model cannot name
    anything else. :func:`caret.judge.validate_choice` still rechecks the answer,
    because the schema is a request and not a guarantee.
    """
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "caret_choice",
            "description": "Exactly one of the supplied choice IDs, with a short reason.",
            "schema": {
                "type": "object",
                "properties": {
                    "choice": {"type": "string", "enum": list(choice_ids)},
                    "reason": {"type": "string"},
                },
                "required": ["choice", "reason"],
                "additionalProperties": False,
            },
        },
    }


class GatewayWriter:
    """Inline text through Vercel AI Gateway. Construct it only with a key.

    Configuration lives on :attr:`client`.
    """

    def __init__(
        self,
        api_key: str,
        model: str = DEFAULT_MODEL,
        endpoint: str = DEFAULT_ENDPOINT,
        timeout: float = 4.0,
        max_output_tokens: int = 64,
        temperature: float = 0.2,
    ) -> None:
        if not api_key:
            raise ProviderFailure(f"An AI Gateway API key is required; set {API_KEY_ENV}")
        self.client = OpenAIChatClient(
            service="AI Gateway",
            endpoint=endpoint,
            api_key=api_key,
            model=model,
            timeout=timeout,
            max_output_tokens=max_output_tokens,
            # Vercel documents max_tokens and does not list
            # max_completion_tokens as a request parameter.
            max_tokens_field=MAX_TOKENS_FIELD,
            temperature=temperature,
        )

    @classmethod
    def from_env(cls, timeout: float = 4.0) -> "GatewayWriter":
        """Build from configuration. Raises when unset; never falls back to a mock."""
        key = os.environ.get(API_KEY_ENV, "")
        if not key:
            raise ProviderFailure(MISSING_KEY)
        return cls(
            api_key=key,
            model=os.environ.get(MODEL_ENV, DEFAULT_MODEL),
            endpoint=os.environ.get(ENDPOINT_ENV, DEFAULT_ENDPOINT),
            timeout=timeout,
        )

    def complete(self, frame: ContextFrame, instruction: str) -> str:
        try:
            reply = inline_completion(self.client, frame, instruction, post_json)
        except ChatError as error:
            raise ProviderFailure(str(error)) from None
        return reply.content


class GatewayJudge:
    """An LLM classifier reached through Vercel AI Gateway. This is not Jev.

    Jev is a typed decision service whose answer is an option key. This asks a
    general chat model to emit JSON naming one option, which is a different and
    weaker thing: it can ignore the schema, and its answer is only as good as the
    prompt. It exists so the two-decision loop can be exercised with a Gateway
    key, and it is selected only when a caller asks for it by name. Nothing
    falls back to it.

    An answer is accepted only after :func:`caret.judge.validate_choice` matches
    it against the choice IDs Caret supplied, so a model that invents a label or
    answers in prose produces a :class:`caret.judge.JudgeError` rather than a
    decision.
    """

    def __init__(
        self,
        api_key: str,
        model: str = DEFAULT_JUDGE_MODEL,
        endpoint: str = DEFAULT_ENDPOINT,
        timeout: float = 8.0,
        max_output_tokens: int = 200,
        temperature: float = 0.0,
    ) -> None:
        if not api_key:
            raise JudgeError(f"An AI Gateway API key is required; set {API_KEY_ENV}")
        self.client = OpenAIChatClient(
            service="AI Gateway",
            endpoint=endpoint,
            api_key=api_key,
            model=model,
            timeout=timeout,
            max_output_tokens=max_output_tokens,
            max_tokens_field=MAX_TOKENS_FIELD,
            # A classifier wants the least sampling variation the API allows.
            temperature=temperature,
        )

    @classmethod
    def from_env(cls, timeout: float = 8.0) -> "GatewayJudge":
        """Build from configuration. Raises when unset; never falls back to a mock."""
        key = os.environ.get(API_KEY_ENV, "")
        if not key:
            raise JudgeError(MISSING_KEY)
        return cls(
            api_key=key,
            model=os.environ.get(JUDGE_MODEL_ENV, DEFAULT_JUDGE_MODEL),
            endpoint=os.environ.get(ENDPOINT_ENV, DEFAULT_ENDPOINT),
            timeout=timeout,
        )

    def choose(self, question: Question, frame: ContextFrame) -> Verdict:
        options = "\n".join(
            f"- {choice.id}: {choice.detail or choice.label}" for choice in question.choices
        )
        messages = [
            {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"{question.prompt}\n\nOptions:\n{options}\n\n"
                    f"Current context:\n{describe_frame(frame)}"
                ),
            },
        ]
        try:
            reply = self.client.send(
                messages,
                post_json,
                choice_response_format(question.choice_ids),
            )
        except ChatError as error:
            raise JudgeError(str(error)) from None

        try:
            answer = json.loads(reply.content)
        except json.JSONDecodeError:
            raise JudgeError(
                f"AI Gateway answered '{question.key}' with content that is not JSON: "
                f"{reply.content[:120]!r}"
            ) from None
        if not isinstance(answer, dict):
            raise JudgeError(
                f"AI Gateway answered '{question.key}' with a JSON "
                f"{type(answer).__name__}, expected an object"
            )
        reason = answer.get("reason")
        return validate_choice(
            question,
            answer.get("choice"),
            frame.revision,
            reason=reason[:MAX_REASON_CHARS] if isinstance(reason, str) else "",
            latency_ms=reply.latency_ms,
            model=reply.model,
        )
