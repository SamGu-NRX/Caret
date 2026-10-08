"""Run R2 staging with synthetic build output and no Swift compilation."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HEAVY = Path(__file__).resolve().parents[1]
PY = "/opt/homebrew/opt/python@3.14/bin/python3.14"


class R2Stage(unittest.TestCase):
    def test_stage_syntax_check_under_job_python_isolation(self):
        with tempfile.TemporaryDirectory(prefix="caret-r2-stage-") as tmp:
            root = Path(tmp)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            for name, text in {
                "swiftc": '#!/bin/bash\nwhile [ "$1" != -o ]; do shift; done\ntouch "$2"\n',
                "python3": f'#!/bin/bash\nexec "{PY}" -I -B -X pycache_prefix=/var/empty "$@"\n',
            }.items():
                tool = bin_dir / name
                tool.write_text(text)
                tool.chmod(0o755)
            env = dict(os.environ, PATH=f"{bin_dir}:/usr/bin:/bin", HOME=str(root), TMPDIR=str(root),
                       PYTHONDONTWRITEBYTECODE="1", PYTHONPYCACHEPREFIX="/var/empty")
            for harness in ("h11", "h14"):
                with self.subTest(harness=harness):
                    work = root / harness
                    payload = work / "vm/payload"
                    (payload / "acc/Caret.app").mkdir(parents=True)
                    (payload / "apps/Google Chrome for Testing.app").mkdir(parents=True)
                    fixture = work / "src/fixtures/web-form"
                    for rel in ("server.ts", "oracle.ts", "package.json", "tasks/site.ts",
                                "tasks/expect/wizard-1.json", "public/tasks/wizard-3.html",
                                "public/tasks/tasks.css", "public/tasks/options.js",
                                "public/tasks/pages.js", "public/tasks/probe.js"):
                        dest = fixture / rel
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        dest.write_text("{}\n")
                    (work / "src/.REV").write_text("synthetic\n")
                    (payload / "REV").write_text("synthetic\n")
                    stage = HEAVY / "recipes/r2" / harness / "stage.sh"
                    done = subprocess.run(["/bin/bash", str(stage), str(work)], env=env,
                                          capture_output=True, text=True)
                    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                    self.assertIn("staged synthetic", done.stdout)
                    self.assertEqual(list(work.rglob("*.pyc")), [])
                    if harness == "h11":
                        options = json.loads((payload / "h11-options.json").read_text())
                        self.assertEqual(options["pages"], ["wizard-1"])
                    recipe = root / (harness + "-recipe")
                    shutil.copytree(stage.parent, recipe)
                    shutil.copyfile(stage.parent.parent / "leakscan.py", root / "leakscan.py")
                    source = recipe / ("q2.py" if harness == "h11" else "tools/h14.py")
                    source.write_text("def invalid(:\n")
                    done = subprocess.run(["/bin/bash", str(recipe / "stage.sh"), str(work)], env=env,
                                          capture_output=True, text=True)
                    self.assertNotEqual(done.returncode, 0)
                    self.assertIn("SyntaxError", done.stderr)
                    self.assertNotIn("Permission denied", done.stderr)
                    self.assertEqual(list(work.rglob("*.pyc")), [])
                    subprocess.run(["chmod", "-R", "u+w", str(work)], check=True)
