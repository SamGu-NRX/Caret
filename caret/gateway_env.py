"""Load Vercel AI Gateway credentials for local Caret runs (CLI and Mac app subprocess)."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from caret.completions import AI_GATEWAY_API_KEY_ENV, VERCEL_API_GATEWAY_KEY_ENV

_KEY_FILE_NAME = "vercel-api-gateway-key"


def _key_from_file(path: Path) -> str:
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8").strip()


def _try_sync_from_github_secret() -> None:
    if os.environ.get("CARET_SKIP_GITHUB_SECRET_SYNC", "").strip():
        return
    root = os.environ.get("CARET_PROJECT_ROOT", "").strip()
    if not root:
        return
    script = Path(root) / "scripts" / "sync_vercel_gateway_key.sh"
    if not script.is_file():
        return
    try:
        subprocess.run(
            ["/bin/bash", str(script)],
            cwd=root,
            check=False,
            timeout=180,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.TimeoutExpired):
        return


def inject_gateway_api_key_from_files() -> None:
    """Set gateway env vars from disk when not already in the process environment."""
    if os.environ.get("CARET_SKIP_GATEWAY_KEY_INJECT", "").strip():
        return
    for name in (VERCEL_API_GATEWAY_KEY_ENV, AI_GATEWAY_API_KEY_ENV):
        if os.environ.get(name, "").strip():
            return

    candidates: list[Path] = []
    support = os.environ.get("CARET_SUPPORT_ROOT", "").strip()
    if support:
        candidates.append(Path(support) / _KEY_FILE_NAME)
    project = os.environ.get("CARET_PROJECT_ROOT", "").strip()
    if project:
        candidates.append(Path(project) / ".local" / _KEY_FILE_NAME)

    home = Path.home()
    candidates.append(home / "Library" / "Application Support" / "Caret" / _KEY_FILE_NAME)

    for path in candidates:
        key = _key_from_file(path)
        if key:
            os.environ[VERCEL_API_GATEWAY_KEY_ENV] = key
            return

    _try_sync_from_github_secret()

    for path in candidates:
        key = _key_from_file(path)
        if key:
            os.environ[VERCEL_API_GATEWAY_KEY_ENV] = key
            return
