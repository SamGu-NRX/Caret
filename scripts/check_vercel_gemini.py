"""Check gateway build configuration without importing code or loading credentials."""

import ast
import os
from pathlib import Path
import plistlib


def refusals(root: Path) -> list[str]:
    reasons = []
    # Parse rather than import: checking a default must not execute it or inject local keys.
    tree = ast.parse((root / "caret/completions.py").read_text())
    assignments = [
        node for node in ast.walk(tree)
        if isinstance(node, (ast.Assign, ast.AnnAssign))
        and any(isinstance(target, ast.Name) and target.id == "VERCEL_GEMINI_ENABLED"
                for target in (node.targets if isinstance(node, ast.Assign) else [node.target]))
    ]
    if (len(assignments) != 1 or assignments[0] not in tree.body
            or not isinstance(assignments[0].value, ast.Constant)
            or assignments[0].value.value is not False):
        reasons.append("VERCEL_GEMINI_ENABLED must default to False in caret/completions.py; the Vercel Gemini route cannot ship")
    if os.environ.get("CARET_DEV_VERCEL_GEMINI") == "1":
        reasons.append("CARET_DEV_VERCEL_GEMINI=1 enables a development-only route; unset it before building Caret")
    known_plists = [root / "apps/mac/Sources/Caret/Info.plist", root / "apps/caret/Bundle/Info.plist"]
    configured = os.environ.get("INFOPLIST_FILE")
    if configured and (root / configured).resolve() not in [path.resolve() for path in known_plists]:
        reasons.append(f"INFOPLIST_FILE points outside the reviewed plists: {configured}")
    effective = os.environ.get("CARET_BUILD_PLIST")
    target, relative = os.environ.get("TARGET_BUILD_DIR"), os.environ.get("INFOPLIST_PATH")
    if not effective and target and relative and (Path(target) / relative).is_file():
        effective = str(Path(target) / relative)
    plist_path = Path(effective) if effective else root / "apps/mac/Sources/Caret/Info.plist"
    with plist_path.open("rb") as stream:
        plist = plistlib.load(stream)
    launch_env = plist.get("LSEnvironment", {})
    if not isinstance(launch_env, dict):
        reasons.append("Info.plist LSEnvironment must be a dictionary")
    elif str(launch_env.get("CARET_DEV_VERCEL_GEMINI", "")) == "1":
        reasons.append("Info.plist LSEnvironment enables CARET_DEV_VERCEL_GEMINI=1; packaged config cannot enable Vercel Gemini")
    return reasons


if __name__ == "__main__":
    try:
        reasons = refusals(Path(__file__).resolve().parents[1])
    except (OSError, SyntaxError, ValueError, plistlib.InvalidFileException) as error:
        raise SystemExit(f"Cannot verify Vercel Gemini build configuration: {error}") from None
    if reasons:
        raise SystemExit("\n".join(reasons))
