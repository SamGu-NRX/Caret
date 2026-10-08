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

    def check_plist(path: Path, kind: str) -> None:
        with path.open("rb") as stream:
            plist = plistlib.load(stream)
        launch_env = plist.get("LSEnvironment", {})
        if not isinstance(launch_env, dict):
            reasons.append(f"{kind} Info.plist {path}: LSEnvironment must be a dictionary")
        elif str(launch_env.get("CARET_DEV_VERCEL_GEMINI", "")) == "1":
            reasons.append(f"{kind} Info.plist {path}: LSEnvironment enables CARET_DEV_VERCEL_GEMINI=1; packaged config cannot enable Vercel Gemini")

    # A previous build's safe output cannot vouch for a source changed since that build.
    sources = [(name, os.environ[name]) for name in ("INFOPLIST_FILE", "CARET_SOURCE_PLIST") if os.environ.get(name)]
    if not sources:
        sources = [("INFOPLIST_FILE", str(known_plists[0]))]
    for name, configured in sources:
        source = (root / configured).resolve()
        if source not in [path.resolve() for path in known_plists]:
            reasons.append(f"{name} points outside the reviewed plists: {configured}")
        else:
            check_plist(source, "source")

    # Only the final phase may read Xcode's output: before processing it can be stale.
    effective = os.environ.get("CARET_BUILD_PLIST")
    requires_processed = os.environ.get("CARET_REQUIRE_PROCESSED_PLIST") == "1"
    if requires_processed or effective:
        target, relative = os.environ.get("TARGET_BUILD_DIR"), os.environ.get("INFOPLIST_PATH")
        if not effective and target and relative:
            effective = str(Path(target) / relative)
        if effective and Path(effective).is_file():
            check_plist(Path(effective), "processed")
        else:
            reasons.append(f"processed Info.plist is missing: {effective or 'no bundle plist path was supplied'}")
    return reasons


if __name__ == "__main__":
    try:
        reasons = refusals(Path(__file__).resolve().parents[1])
    except (OSError, SyntaxError, ValueError, plistlib.InvalidFileException) as error:
        raise SystemExit(f"Cannot verify Vercel Gemini build configuration: {error}") from None
    if reasons:
        raise SystemExit("\n".join(reasons))
