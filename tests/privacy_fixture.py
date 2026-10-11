"""A copy of the privacy gate and the files it reads, in a temporary tree, for tests that run it end to end."""

import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    "helper/scripts/privacy-gate.ts", "scripts/privacy_gate.sh", "scripts/check_vercel_gemini.py", "scripts/check_onboarding_privacy.py",
    "apps/mac/Sources/Caret/PermissionView.swift", "apps/mac/Sources/Caret/Info.plist", "apps/caret/Bundle/Info.plist", "caret/completions.py",
    "apps/caret/Sources/CaretHost/Onboarding/OnboardingView.swift",
]
ACCEPTED = ('export const PRIVACY_ACCEPTANCES = { "pv2-sites-send": { commit: "0123456789abcdef0123456789abcdef01234567", by: "fixture", '
            'at: "2026-10-07T00:00:00Z" }, "ha2-copied-conversation": { commit: "0123456789abcdef0123456789abcdef01234567", by: "fixture", '
            'at: "2026-10-07T00:00:00Z" } };\n')
UNACCEPTED = "export const PRIVACY_ACCEPTANCES = {};\n"
CHANGED = "What Caret sends\n\nA sentence nobody approved.\n"
# Variables a caller's environment could carry into the gate; each test sets the ones it means.
GATE_ENV = {"CARET_PRIVACY_RESOURCE", "CARET_VERIFY_PRIVACY_RESOURCE", "CARET_BUILD_PLIST", "CARET_REQUIRE_PROCESSED_PLIST", "CARET_SOURCE_PLIST",
            "INFOPLIST_FILE", "TARGET_BUILD_DIR", "INFOPLIST_PATH", "CARET_DEV_VERCEL_GEMINI", "CARET_INTERNAL_BUILD"}


def tree(accepted: bool) -> Path:
    root = Path(tempfile.mkdtemp(prefix="caret-gate-"))
    shutil.copytree(ROOT / "helper/src", root / "helper/src")
    for file in FILES:
        (root / file).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / file, root / file)
    (root / "helper/src/privacy/accepted.ts").write_text(ACCEPTED if accepted else UNACCEPTED)
    return root


def clean_env(**extra: str) -> dict:
    return {**{k: v for k, v in os.environ.items() if k not in GATE_ENV}, **extra}


def gate(root: Path, **extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(["/bin/sh", str(root / "scripts/privacy_gate.sh")], capture_output=True, text=True, env=clean_env(**extra))


def app(root: Path, internal: bool) -> Path:
    """An assembled Caret.app holding the generated promise, stamped as build-app.sh stamps an internal build."""
    bundle = root / "build/Caret.app"
    (bundle / "Contents").mkdir(parents=True)
    (bundle / "Contents/Info.plist").write_bytes(plistlib.dumps({"CaretInternalBuild": True} if internal else {}))
    resource = bundle / "Contents/Resources/PrivacyPromise.txt"
    generated = gate(root, CARET_PRIVACY_RESOURCE=str(resource), **({"CARET_INTERNAL_BUILD": "1"} if internal else {}))
    assert generated.returncode == 0, generated.stderr
    return bundle
