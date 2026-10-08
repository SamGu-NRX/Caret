"""Release launchers strip opt-ins from merged process and env-file configuration."""
from pathlib import Path
import unittest
ROOT = Path(__file__).resolve().parents[1]


class ReleaseHostEnvironmentTests(unittest.TestCase):
    def test_mac_all_python_launchers_sanitize_merged_environment(self):
        for file in ("CaretCLI.swift", "HistoryDebug.swift"):
            text = (ROOT / "apps/mac/Sources/Caret" / file).read_text()
            self.assertIn("CoreProcessTransport.childEnvironment(environment)", text)
        text = (ROOT / "apps/mac/Sources/CaretCore/CoreProcessTransport.swift").read_text()
        self.assertIn("process.environment = Self.childEnvironment(environment)", text)
        for key in ("CARET_RELEASE_HOST", "CARET_DEV_", "AI_GATEWAY_", "VERCEL_", "CARET_ENV_FILE"):
            self.assertIn(key, text)
        self.assertIn("#if DEBUG", text)

    def test_v2_helper_launcher_marks_release_and_filters_env_file(self):
        text = (ROOT / "apps/caret/Sources/CaretHost/Services/ServiceLauncher.swift").read_text()
        for key in ("CARET_RELEASE_HOST", "CARET_DEV_", "AI_GATEWAY_", "VERCEL_", "CARET_ENV_FILE"):
            self.assertIn(key, text)
        self.assertIn("#if DEBUG", text)
        self.assertIn('env.removeValue(forKey: "CARET_ENV_FILE")', text)

    def test_environment_filters_execute_in_release_and_debug_without_app_build(self):
        import shutil
        import subprocess
        import tempfile
        if shutil.which("swift") is None:
            self.skipTest("Swift is unavailable; environment behavior cannot be executed")

        def function(text, signature):
            start = text.index(signature)
            opening = text.index("{", start)
            depth = 1
            end = opening + 1
            while depth:
                depth += (text[end] == "{") - (text[end] == "}")
                end += 1
            return text[start:end]

        mac = function((ROOT / "apps/mac/Sources/CaretCore/CoreProcessTransport.swift").read_text(), "public static func childEnvironment")
        host = function((ROOT / "apps/caret/Sources/CaretHost/Services/ServiceLauncher.swift").read_text(), "static func childEnvironment")
        load_file = function((ROOT / "apps/mac/Sources/Caret/CoreLaunchSettings.swift").read_text(), "static func environment(fromEnvFileAt")
        with tempfile.TemporaryDirectory() as directory:
            envfile = Path(directory) / "developer.env"
            envfile.write_text("CARET_DEV_VERCEL_GEMINI=1\nAI_GATEWAY_API_KEY=fixture\nVERCEL_API_GATEWAY_KEY=fixture\nCARET_RELEASE_HOST=0\nTYPESAFE_API_KEY=direct-fixture\n")
            (Path(directory) / "dev.json").write_text('{"envFile": "developer.env"}')
            script = Path(directory) / "filters.swift"
            script.write_text('import Foundation\nimport os\nenum File {\nstatic let log = Logger(subsystem: "dev.caret.test", category: "privacy")\n' + load_file + '\n}\nenum Mac {\n' + mac + '\n}\nenum Host {\nstatic let jevKeyNames = ["TYPESAFE_API_KEY", "CARET_ENV_FILE"]\n' + host + '\n}\n' + '''
let file = CommandLine.arguments[1]
let inherited = ["CARET_DEV_VERCEL_GEMINI": "1", "AI_GATEWAY_API_KEY": "fixture", "VERCEL_API_GATEWAY_KEY": "fixture", "CARET_RELEASE_HOST": "1", "CARET_ENV_FILE": file]
let configURL = URL(fileURLWithPath: file).deletingLastPathComponent().appendingPathComponent("dev.json")
let devJSON = try! JSONSerialization.jsonObject(with: Data(contentsOf: configURL)) as! [String: String]
let configuredFile = configURL.deletingLastPathComponent().appendingPathComponent(devJSON["envFile"]!).path
let mergedDevJSONEnvironment = File.environment(fromEnvFileAt: configuredFile).merging(inherited) { _, parent in parent }
for value in [Mac.childEnvironment(mergedDevJSONEnvironment), Host.childEnvironment(inherited, passesJevKey: true)] {
  precondition(value["CARET_RELEASE_HOST"] == "1")
  precondition(value["CARET_ENV_FILE"] == nil)
  precondition(!value.keys.contains { $0.hasPrefix("CARET_DEV_") || $0.hasPrefix("AI_GATEWAY_") || $0.hasPrefix("VERCEL_") })
}
precondition(Host.childEnvironment(inherited, passesJevKey: true)["TYPESAFE_API_KEY"] == "direct-fixture")
#if DEBUG
precondition(Mac.childEnvironment(["CARET_DEV_VERCEL_GEMINI": "1"])["CARET_DEV_VERCEL_GEMINI"] == "1")
precondition(Host.childEnvironment(["CARET_DEV_VERCEL_GEMINI": "1"], passesJevKey: true)["CARET_DEV_VERCEL_GEMINI"] == "1")
#else
precondition(Mac.childEnvironment([:])["CARET_RELEASE_HOST"] == "1")
precondition(Host.childEnvironment([:], passesJevKey: true)["CARET_RELEASE_HOST"] == "1")
#endif
print("filters passed")
''')
            for flags in ([], ["-D", "DEBUG"]):
                result = subprocess.run(["swift", *flags, str(script), str(envfile)], capture_output=True, text=True, timeout=45)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("filters passed", result.stdout)
