"""The acceptance scripts' launch secret (apps/caret/scripts/launch_secret.py): the host key it derives is the helper's,
and popen_caret hands it to the child on the descriptor CARET_HOST_KEY_FD names, never on argv or in the environment.
"""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("launch_secret", ROOT / "apps/caret/scripts/launch_secret.py")
launch_secret = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch_secret)

VECTOR = json.loads((ROOT / "helper/fixtures/golden/host-auth.json").read_text())

# Reads 32 bytes from the descriptor the variable names, as HostAuth.readInheritedKey does, and reports what it saw.
CHILD = r"""
import json, os, sys
fd = int(os.environ["CARET_HOST_KEY_FD"])
key = b""
while len(key) < 32:
    chunk = os.read(fd, 32 - len(key))
    if not chunk:
        break
    key += chunk
rest = os.read(fd, 1)
os.close(fd)
exposed = any(k in v for k in (key.hex(), key.hex().upper()) for v in list(os.environ.values()) + sys.argv)
print(json.dumps({"fd": fd, "key": key.hex(), "eof": rest == b"", "exposed": exposed}))
"""


class LaunchSecretTests(unittest.TestCase):
    def test_host_key_matches_the_helpers_golden_vector(self):
        secret = bytes.fromhex(VECTOR["launchSecret"])
        self.assertEqual(launch_secret.host_key(secret).hex(), VECTOR["hostKey"])

    def test_a_secret_that_is_not_32_bytes_is_refused(self):
        with self.assertRaisesRegex(ValueError, "32 bytes, not 5"):
            launch_secret.host_key(b"short")

    def test_popen_caret_hands_the_key_on_the_named_descriptor_only(self):
        secret = bytes.fromhex(VECTOR["launchSecret"])
        before = set(os.listdir("/dev/fd"))
        proc = launch_secret.popen_caret([sys.executable, "-I", "-c", CHILD], secret=secret, env={"PATH": os.environ.get("PATH", "")},
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, err = proc.communicate(timeout=30)
        self.assertEqual(proc.returncode, 0, err.decode())
        report = json.loads(out)
        self.assertEqual(report["key"], VECTOR["hostKey"])
        self.assertTrue(report["eof"], "the write end is closed before Caret starts, so a read past the key ends")
        self.assertFalse(report["exposed"], "the key is never on argv or in the environment")
        self.assertGreaterEqual(report["fd"], 3)
        self.assertEqual(set(os.listdir("/dev/fd")) - before, set(), "the parent keeps neither end of the pipe")

    def test_popen_with_secret_writes_the_secret_to_standard_input_and_closes_it(self):
        proc = launch_secret.popen_with_secret([sys.executable, "-I", "-c", "import sys; print(sys.stdin.buffer.read().hex())"],
                                               secret=b"s" * 32, stdout=subprocess.PIPE)
        out, _ = proc.communicate(timeout=30)
        self.assertEqual(out.decode().strip(), (b"s" * 32).hex())


if __name__ == "__main__":
    unittest.main()
