"""Each app build's last privacy check verifies the finished app's PrivacyPromise.txt and never writes it.

The three verification calls (build-app.sh, the Xcode target's final phase, package_mac.py) are run as written, against
a copy of the gate with the required acceptances recorded, while CARET_PRIVACY_RESOURCE names the very file being
checked. A call that let that variable through would regenerate a missing or changed file and pass.
"""

import importlib.util
import os
import plistlib
from pathlib import Path
import re
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch

from tests.privacy_fixture import CHANGED, ROOT, app, clean_env, tree


class VerificationNeverWritesTests(unittest.TestCase):
    def setUp(self):
        self.root = tree(accepted=True)
        self.addCleanup(shutil.rmtree, self.root)
        self.build = self.root / "build"
        self.app = app(self.root, internal=False)
        self.resource = self.app / "Contents/Resources/PrivacyPromise.txt"
        self.approved = self.resource.read_text()

    def clean_env(self) -> dict:
        return clean_env()

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

    @unittest.skipUnless(sys.platform == "darwin", "the Xcode phase needs macOS's PlistBuddy")
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

    def test_package_mac_checks_the_apps_own_processed_plist(self):
        spec = importlib.util.spec_from_file_location("package_plist", ROOT / "scripts/package_mac.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.root = self.root
        (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps({"LSEnvironment": {"CARET_DEV_VERCEL_GEMINI": "1"}}))
        with self.assertRaises(SystemExit) as refused:
            module.verify_privacy_resource(self.app)
        self.assertIn("LSEnvironment", str(refused.exception))

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
