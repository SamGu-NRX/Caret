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
plist = bundle / "Contents" / "Info.plist"
if plist.is_file():
    subprocess.run(
        ["/usr/libexec/PlistBuddy", "-c", f"Set :CaretProjectRoot {root}", str(plist)],
        check=False,
    )
    subprocess.run(
        ["/usr/libexec/PlistBuddy", "-c", f"Add :CaretProjectRoot string {root}", str(plist)],
        check=False,
    )
sync_script = root / "scripts" / "sync_vercel_gateway_key.sh"
if sync_script.is_file() and "--build-only" not in sys.argv[1:]:
    subprocess.run(["/bin/bash", str(sync_script)], cwd=root, check=False)
if "--build-only" not in sys.argv[1:]:
    if "--install-applications" in sys.argv[1:] or "CARET_INSTALL_APPLICATIONS" in __import__(
        "os"
    ).environ:
        import shutil

        dest = Path("/Applications/Caret.app")
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(bundle, dest, symlinks=True)
        subprocess.run(["/usr/bin/pkill", "-x", "Caret"], check=False)
        subprocess.run(["open", str(dest)], check=False)
    else:
        subprocess.run(["open", str(bundle)], check=False)
