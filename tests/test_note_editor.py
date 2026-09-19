"""Exercise the native note editor's save ownership without launching the app."""
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("swiftc"), "requires the Mac Swift compiler")
class NoteEditorTests(unittest.TestCase):
    def test_save_ownership_and_failure_recovery(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            executable = pathlib.Path(directory) / "note-editor-checks"
            compiled = subprocess.run(
                ["swiftc", "-parse-as-library",
                 str(root / "apps/mac/Sources/Caret/NoteEditorSession.swift"),
                 str(root / "scripts/tests/NoteEditorSessionChecks.swift"),
                 "-o", str(executable)], capture_output=True, text=True,
            )
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            checked = subprocess.run([str(executable)], capture_output=True, text=True)
            self.assertEqual(checked.returncode, 0, checked.stderr)
