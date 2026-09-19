import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from caret.gateway_env import inject_gateway_api_key_from_files


class GatewayEnvTests(unittest.TestCase):
    def test_inject_skipped_when_opt_out_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            key_path = Path(tmp) / "vercel-api-gateway-key"
            key_path.write_text("file-secret\n", encoding="utf-8")
            with patch.dict(
                os.environ,
                {
                    "CARET_SKIP_GATEWAY_KEY_INJECT": "1",
                    "CARET_SUPPORT_ROOT": tmp,
                },
                clear=True,
            ):
                inject_gateway_api_key_from_files()
                self.assertNotIn("VERCEL_API_GATEWAY_KEY", os.environ)


if __name__ == "__main__":
    unittest.main()
