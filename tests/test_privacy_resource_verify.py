"""Each app build's last privacy check verifies the finished app's PrivacyPromise.txt and never writes it.

The three verification calls (build-app.sh, the Xcode target's final phase, package_mac.py) are run as written, against
a copy of the gate with the required acceptances recorded, while CARET_PRIVACY_RESOURCE names the very file being
checked. A call that let that variable through would regenerate a missing or changed file and pass.
"""

import importlib.util
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    "helper/scripts/privacy-gate.ts", "scripts/privacy_gate.sh", "scripts/check_vercel_gemini.py", "scripts/check_onboarding_privacy.py",
    "apps/mac/Sources/Caret/PermissionView.swift", "apps/mac/Sources/Caret/Info.plist", "apps/caret/Bundle/Info.plist", "caret/completions.py",
    "apps/caret/Sources/CaretHost/Onboarding/OnboardingView.swift", "apps/caret/Sources/CaretHost/Onboarding/OnboardingController.swift",
    "apps/caret/Sources/CaretHostCore/PrivacyPromise.swift", "apps/caret/Sources/CaretHost/Design/WindowParts.swift",
]
ACCEPTED = ('export const PRIVACY_ACCEPTANCES = { "pv2-sites-send": { commit: "0123456789abcdef0123456789abcdef01234567", by: "fixture", '
            'at: "2026-10-07T00:00:00Z" }, "ha2-copied-conversation": { commit: "0123456789abcdef0123456789abcdef01234567", by: "fixture", '
            'at: "2026-10-07T00:00:00Z" } };\n')
CHANGED = "What Caret sends\n\nA sentence nobody approved.\n"


class VerificationNeverWritesTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="caret-verify-"))
        self.addCleanup(shutil.rmtree, self.root)
        shutil.copytree(ROOT / "helper/src", self.root / "helper/src")
        for file in FILES:
            (self.root / file).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(ROOT / file, self.root / file)
        (self.root / "helper/src/privacy/accepted.ts").write_text(ACCEPTED)
        self.build = self.root / "build"
        self.app = self.build / "Caret.app"
        self.resource = self.app / "Contents/Resources/PrivacyPromise.txt"
        (self.app / "Contents").mkdir(parents=True)
        (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps({}))
        generated = subprocess.run(["/bin/sh", str(self.root / "scripts/privacy_gate.sh")], capture_output=True, text=True,
                                   env={**self.clean_env(), "CARET_PRIVACY_RESOURCE": str(self.resource)})
        self.assertEqual(generated.returncode, 0, generated.stderr)
        self.approved = self.resource.read_text()

    def clean_env(self) -> dict:
        drop = {"CARET_PRIVACY_RESOURCE", "CARET_VERIFY_PRIVACY_RESOURCE", "CARET_BUILD_PLIST", "CARET_REQUIRE_PROCESSED_PLIST",
                "CARET_SOURCE_PLIST", "INFOPLIST_FILE", "TARGET_BUILD_DIR", "INFOPLIST_PATH", "CARET_DEV_VERCEL_GEMINI"}
        return {k: v for k, v in os.environ.items() if k not in drop}

    def damages(self):
        yield "missing", lambda: self.resource.unlink(), "is missing"
        yield "changed", lambda: self.resource.write_text(CHANGED), "differs from PRIVACY_PROMISE"

    def check_route(self, run):
        # The approved file passes: the route verifies rather than refusing everything.
        self.assertEqual(run().returncode, 0)
        for name, damage, why in self.damages():
            with self.subTest(name):
                self.resource.write_text(self.approved)
                damage()
                before = self.resource.read_text() if self.resource.exists() else None
                result = run()
                self.assertNotEqual(result.returncode, 0, name)
                self.assertIn(why, result.stderr)
                self.assertEqual(self.resource.read_text() if self.resource.exists() else None, before, "verification wrote the file")

    def test_build_app_sh(self):
        script = (ROOT / "apps/caret/scripts/build-app.sh").read_text()
        line = next(l for l in script.splitlines() if "CARET_VERIFY_PRIVACY_RESOURCE=" in l)
        body = f'set -euo pipefail\nroot="$1"\ncontents="Caret.app/Contents"\n{line}\n'

        def run():
            return subprocess.run(["/bin/bash", "-c", body, "verify", str(self.root)], cwd=self.build, capture_output=True, text=True,
                                  env={**self.clean_env(), "CARET_PRIVACY_RESOURCE": str(self.resource)})
        self.check_route(run)

    def test_xcode_final_phase(self):
        text = (ROOT / "Caret.xcodeproj/project.pbxproj").read_text()
        phase = re.search(r'/\* Processed privacy gate \*/ = \{.*?shellScript = "((?:[^"\\]|\\.)*)";', text, re.S)
        script = phase.group(1).replace('\\"', '"').replace("\\n", "\n")

        def run():
            return subprocess.run(["/bin/sh", "-c", script], capture_output=True, text=True, env={
                **self.clean_env(), "SRCROOT": str(self.root), "TARGET_BUILD_DIR": str(self.build),
                "INFOPLIST_PATH": "Caret.app/Contents/Info.plist", "UNLOCALIZED_RESOURCES_FOLDER_PATH": "Caret.app/Contents/Resources",
                "CARET_PRIVACY_RESOURCE": str(self.resource),
            })
        self.check_route(run)

    def test_package_mac(self):
        spec = importlib.util.spec_from_file_location("package_verify", ROOT / "scripts/package_mac.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.root = self.root

        def run():
            def runner(command, **kwargs):
                return subprocess.run(command, **kwargs)
            with patch.dict(os.environ, {"CARET_PRIVACY_RESOURCE": str(self.resource)}):
                try:
                    module.verify_privacy_resource(self.app, runner=runner)
                except SystemExit as refused:
                    return subprocess.CompletedProcess([], 1, "", str(refused))
            return subprocess.CompletedProcess([], 0, "", "")
        self.check_route(run)


if __name__ == "__main__":
    unittest.main()
