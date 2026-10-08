"""Release launchers strip opt-ins from merged process and env-file configuration."""
from pathlib import Path
import re
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
        # Release children get only the allow-list, so no dev or gateway prefix needs filtering here; the executed test
        # below checks that none arrives.
        for key in ("CARET_RELEASE_HOST", "CARET_ENV_FILE"):
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
        host_source = (ROOT / "apps/caret/Sources/CaretHost/Services/ServiceLauncher.swift").read_text()
        host = function(host_source, "static func childEnvironment")
        constants = []
        for name in ("typeSafeEnvironmentKeys", "developmentEnvironmentKeys"):
            declaration = re.search(rf"static let {name} = \[[^\]]*\]", host_source)
            self.assertIsNotNone(declaration, f"missing launcher constant {name}")
            constants.append(declaration.group(0))
        constants = "\n".join(constants)
        launch_error = function(host_source, "struct LaunchError")
        load_file = function((ROOT / "apps/mac/Sources/Caret/CoreLaunchSettings.swift").read_text(), "static func environment(fromEnvFileAt")
        with tempfile.TemporaryDirectory() as directory:
            envfile = Path(directory) / "developer.env"
            envfile.write_text("CARET_JEV_PROVIDER=typesafe\nCARET_JEV_MODEL=jev-1.13.0\nCARET_JEV_DAILY_CAP=1.25\nCARET_DEV_VERCEL_GEMINI=1\nAI_GATEWAY_API_KEY=fixture\nVERCEL_API_GATEWAY_KEY=fixture\nCARET_RELEASE_HOST=0\nTYPESAFE_API_KEY=direct-fixture\n")
            (Path(directory) / "dev.json").write_text('{"envFile": "developer.env"}')
            script = Path(directory) / "filters.swift"
            script.write_text('import Foundation\nimport os\nenum File {\nstatic let log = Logger(subsystem: "dev.caret.test", category: "privacy")\n' + load_file + '\n}\nenum Mac {\n' + mac + '\n}\nenum Host {\n' + constants + '\n' + launch_error + '\n' + host + '\n}\n' + '''
let file = CommandLine.arguments[1]
let inherited = ["CARET_DEV_VERCEL_GEMINI": "1", "AI_GATEWAY_API_KEY": "fixture", "VERCEL_API_GATEWAY_KEY": "fixture", "CARET_RELEASE_HOST": "1", "CARET_ENV_FILE": file]
let configURL = URL(fileURLWithPath: file).deletingLastPathComponent().appendingPathComponent("dev.json")
let devJSON = try! JSONSerialization.jsonObject(with: Data(contentsOf: configURL)) as! [String: String]
let configuredFile = configURL.deletingLastPathComponent().appendingPathComponent(devJSON["envFile"]!).path
let mergedDevJSONEnvironment = File.environment(fromEnvFileAt: configuredFile).merging(inherited) { _, parent in parent }
for value in [Mac.childEnvironment(mergedDevJSONEnvironment), try Host.childEnvironment(inherited, passesJevKey: true)] {
  precondition(value["CARET_RELEASE_HOST"] == "1")
  precondition(value["CARET_ENV_FILE"] == nil)
  precondition(!value.keys.contains { $0.hasPrefix("CARET_DEV_") || $0.hasPrefix("AI_GATEWAY_") || $0.hasPrefix("VERCEL_") })
}
if CommandLine.arguments[2] == "preserve" {
  let safe = try Host.childEnvironment(inherited, passesJevKey: true)
  precondition(safe["TYPESAFE_API_KEY"] == "direct-fixture")
  precondition(safe["CARET_JEV_PROVIDER"] == "typesafe")
  precondition(safe["CARET_JEV_MODEL"] == "jev-1.13.0")
  precondition(safe["CARET_JEV_DAILY_CAP"] == "1.25")
  let override = try Host.childEnvironment(inherited.merging(["CARET_JEV_MODEL": "jev-direct"]) { _, direct in direct }, passesJevKey: true)
  precondition(override["CARET_JEV_MODEL"] == "jev-direct")
} else {
  for provider in ["gateway", "vercel"] {
    for fromFile in [false, true] {
      var unsafe = inherited
      if fromFile {
        let url = URL(fileURLWithPath: file).deletingLastPathComponent().appendingPathComponent("unsafe.env")
        try "CARET_JEV_PROVIDER=\\(provider)\\nTYPESAFE_API_KEY=fixture\\n".write(to: url, atomically: true, encoding: .utf8)
        unsafe["CARET_ENV_FILE"] = url.path
      } else {
        unsafe["CARET_JEV_PROVIDER"] = provider
      }
      var refused = false
      do { _ = try Host.childEnvironment(unsafe, passesJevKey: true) }
      catch { refused = String(describing: error).contains("CARET_JEV_PROVIDER must be typesafe under a release host") }
      precondition(refused, "release must refuse gateway selection, not silently switch to typesafe")
      let reader = try Host.childEnvironment(unsafe, passesJevKey: false)
      precondition(reader["CARET_JEV_PROVIDER"] == nil)
    }
  }
}
#if DEBUG
precondition(Mac.childEnvironment(["CARET_DEV_VERCEL_GEMINI": "1"])["CARET_DEV_VERCEL_GEMINI"] == "1")
let debugHost = try Host.childEnvironment(["CARET_DEV_VERCEL_GEMINI": "1"], passesJevKey: true)
precondition(debugHost["CARET_DEV_VERCEL_GEMINI"] == "1")
#else
precondition(Mac.childEnvironment([:])["CARET_RELEASE_HOST"] == "1")
let releaseHost = try Host.childEnvironment([:], passesJevKey: true)
precondition(releaseHost["CARET_RELEASE_HOST"] == "1")
#endif
print("filters passed")
''')
            for flags in ([], ["-D", "DEBUG"]):
                for case in ("preserve", "refuse"):
                    with self.subTest(flags=flags, case=case):
                        result = subprocess.run(["swift", *flags, str(script), str(envfile), case], capture_output=True, text=True, timeout=45)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertIn("filters passed", result.stdout)
