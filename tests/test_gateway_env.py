import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from caret.completions import VERCEL_API_GATEWAY_KEY_ENV, gateway_api_key


class GatewayEnvTests(unittest.TestCase):
    def test_loads_key_from_project_local_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            local_dir = Path(tmp) / ".local"
            local_dir.mkdir()
            (local_dir / "vercel-api-gateway-key").write_text("file-key\n", encoding="utf-8")
            with patch.dict(
                os.environ,
                {"CARET_PROJECT_ROOT": tmp, VERCEL_API_GATEWAY_KEY_ENV: ""},
                clear=True,
            ):
                self.assertEqual(gateway_api_key(), "file-key")


if __name__ == "__main__":
    unittest.main()
