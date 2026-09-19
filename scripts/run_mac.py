"""Build a development app bundle; keep its machine-specific paths out of Git."""

from pathlib import Path
import plistlib
import shutil
import subprocess
import sys


root = Path(__file__).resolve().parent.parent
if sys.version_info < (3, 11):
    raise SystemExit("Caret requires Python 3.11 or newer. Run this script with a supported interpreter.")
subprocess.run(["swift", "build", "--package-path", str(root / "apps/mac")], check=True)
binary_dir = subprocess.check_output(
    ["swift", "build", "--package-path", str(root / "apps/mac"), "--show-bin-path"], text=True
).strip()
bundle = root / "dist/Caret.app"
executable_dir = bundle / "Contents/MacOS"
executable_dir.mkdir(parents=True, exist_ok=True)
shutil.copy2(Path(binary_dir) / "Caret", executable_dir / "Caret")
with (bundle / "Contents/Info.plist").open("wb") as stream:
    plistlib.dump({
        "CFBundleName": "Caret", "CFBundleDisplayName": "Caret",
        "CFBundleIdentifier": "dev.caret.hackathon", "CFBundleExecutable": "Caret",
        "CFBundlePackageType": "APPL", "CFBundleVersion": "1",
        "CFBundleShortVersionString": "0.1.0", "LSMinimumSystemVersion": "14.0",
        "LSUIElement": True, "CaretProjectRoot": str(root), "CaretPythonExecutable": sys.executable,
    }, stream)
if "--build-only" not in sys.argv[1:]:
    subprocess.run(["open", str(bundle)], check=True)
