"""Build and open the same Caret.app Xcode produces, so Accessibility stays one entry."""

from pathlib import Path
import subprocess
import sys


root = Path(__file__).resolve().parent.parent
if sys.version_info < (3, 11):
    raise SystemExit("Caret requires Python 3.11 or newer. Run this script with a supported interpreter.")

subprocess.run(
    [
        "xcodebuild",
        "-project",
        str(root / "Caret.xcodeproj"),
        "-scheme",
        "Caret",
        "-configuration",
        "Debug",
        "-destination",
        "platform=macOS",
        "CODE_SIGN_IDENTITY=-",
        "build",
    ],
    check=True,
)
bundle = root / ".local/build/Debug/Caret.app"
if "--build-only" not in sys.argv[1:]:
    subprocess.run(["open", str(bundle)], check=True)
