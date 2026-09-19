"""Run Caret skill actions (rewrite selection) via Vercel AI Gateway."""

from __future__ import annotations

import os
from pathlib import Path

from caret.completions import ChatMessage, complete_text
from caret.notes import parse_note

GATEWAY_SKILL_ACTION_IDS = frozenset(
    {
        "extract-tasks",
        "tone-polite",
        "revise",
        "summarize",
        "translate",
    }
)


def skills_notes_dir(repo_root: Path | None = None) -> Path:
    override = os.environ.get("CARET_NOTES_ROOT", "").strip()
    if override:
        return Path(override) / "skills"
    base = repo_root if repo_root is not None else Path(__file__).resolve().parent
    return base / "notes" / "skills"


def load_action_instructions(action_id: str, repo_root: Path | None = None) -> tuple[str, str]:
    path = skills_notes_dir(repo_root) / f"{action_id}.md"
    if not path.is_file():
        raise ValueError(f"Missing skill note for action {action_id!r}: {path}")
    note = parse_note(path)
    title = str(note["title"]).strip() or action_id
    body = str(note["body"]).strip()
    if not body:
        raise ValueError(f"Skill note body is empty: {path}")
    return title, body


def build_skill_messages(
    *,
    instructions: str,
    input_text: str,
) -> list[ChatMessage]:
    system_parts = [
        instructions.strip(),
        "",
        "Apply the instructions to the user's text.",
        "Return ONLY the transformed text.",
        "Do not wrap the answer in quotes or markdown fences.",
        "Do not add a preamble or explanation unless the instructions require a specific format.",
    ]
    system = "\n".join(system_parts)
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": input_text},
    ]


def normalize_skill_output(raw: str) -> str:
    text = raw.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'`":
        text = text[1:-1].strip()
    return text


def complete_skill_action(
    action_id: str,
    input_text: str,
    *,
    instructions_override: str | None = None,
    model: str | None = None,
    max_tokens: int = 2048,
    repo_root: Path | None = None,
) -> str:
    action = action_id.strip()
    if action not in GATEWAY_SKILL_ACTION_IDS:
        raise ValueError(f"Action {action!r} is not a Vercel gateway skill action.")
    source = input_text.strip("\n")
    if not source.strip():
        raise ValueError("Input text is empty.")

    override = (instructions_override or "").strip()
    if override:
        instructions = override
    else:
        _title, instructions = load_action_instructions(action, repo_root=repo_root)
    if not instructions.strip():
        raise ValueError(
            f"Skill instructions for {action!r} are empty. Edit Instructions in Caret Settings."
        )
    messages = build_skill_messages(
        instructions=instructions,
        input_text=source,
    )
    kwargs: dict = {"max_tokens": max_tokens, "temperature": 0.35}
    if model:
        kwargs["model"] = model
    raw = complete_text(
        messages[1]["content"],
        system=messages[0]["content"],
        **kwargs,
    )
    result = normalize_skill_output(raw)
    if not result:
        raise ValueError("Model returned empty text.")
    return result
