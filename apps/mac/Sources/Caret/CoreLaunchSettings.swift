import Foundation
import CaretCore
import os

/// Where the Python core lives and how to run it.
///
/// Nothing here is hardcoded to one machine. Values come from, in order, the
/// process environment, then a developer config file, then a conservative
/// guess relative to the repository. A missing interpreter or root is reported
/// rather than defaulted, because a wrong guess would launch the wrong process.
///
/// Provider keys are read from an env file and passed to the child's
/// environment. They are never logged and never written back to disk.
enum CoreLaunchSettings {
    private static let log = Logger(subsystem: "com.caret.app", category: "core-launch")

    /// `~/.config/caret/dev.json`, or `CARET_DEV_CONFIG`. Git-ignored by
    /// living outside the repository.
    struct DeveloperConfig: Decodable {
        var python: String?
        var root: String?
        var arguments: [String]?
        var envFile: String?

        static func load() -> DeveloperConfig {
            let explicit = ProcessInfo.processInfo.environment["CARET_DEV_CONFIG"]
            let url = explicit.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) }
                ?? FileManager.default.homeDirectoryForCurrentUser
                    .appendingPathComponent(".config/caret/dev.json")
            guard let data = try? Data(contentsOf: url),
                  let config = try? JSONDecoder().decode(DeveloperConfig.self, from: data)
            else { return DeveloperConfig() }
            return config
        }
    }

    enum Unavailable: Error, Equatable {
        case noInterpreter
        case noRoot(String)

        var reason: InlineDisabledReason { .noProvider }

        var statusText: String {
            switch self {
            case .noInterpreter:
                return "No Python interpreter configured. Set \"python\" in ~/.config/caret/dev.json."
            case .noRoot(let path):
                return "Core not found at \(path). Set \"root\" in ~/.config/caret/dev.json."
            }
        }
    }

    /// Reads `KEY=value` lines. Values are returned for the child's
    /// environment only; this never logs or echoes them.
    static func environment(fromEnvFileAt path: String?) -> [String: String] {
        guard let path else { return [:] }
        let expanded = (path as NSString).expandingTildeInPath
        guard let text = try? String(contentsOfFile: expanded, encoding: .utf8) else { return [:] }
        var result: [String: String] = [:]
        for line in text.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.hasPrefix("#"), let eq = trimmed.firstIndex(of: "=") else { continue }
            let key = String(trimmed[trimmed.startIndex..<eq]).trimmingCharacters(in: .whitespaces)
            var value = String(trimmed[trimmed.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
            if value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") {
                value = String(value.dropFirst().dropLast())
            }
            guard !key.isEmpty, !value.isEmpty else { continue }
            result[key] = value
        }
        if !result.isEmpty {
            // Names only. Printing a value here would put a live API key in
            // the system log.
            log.info("core env supplied: \(result.keys.sorted().joined(separator: ","), privacy: .public)")
        }
        return result
    }

    static func resolve() -> Result<CoreLaunchConfiguration, Unavailable> {
        let env = ProcessInfo.processInfo.environment
        let config = DeveloperConfig.load()

        let pythonPath = env["CARET_PYTHON"] ?? config.python
        guard let pythonPath, FileManager.default.isExecutableFile(atPath: (pythonPath as NSString).expandingTildeInPath) else {
            return .failure(.noInterpreter)
        }

        let rootPath = env["CARET_CORE_ROOT"] ?? config.root ?? CaretPaths.projectRoot?.path ?? ""
        let expandedRoot = (rootPath as NSString).expandingTildeInPath
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: expandedRoot + "/caret", isDirectory: &isDirectory),
              isDirectory.boolValue
        else { return .failure(.noRoot(expandedRoot)) }

        // The user's current choice: gateway judge, Groq inline writer.
        let arguments = config.arguments
            ?? env["CARET_CORE_ARGS"]?.split(separator: " ").map(String.init)
            ?? ["--judge", "gateway", "--writer", "groq"]

        let envFile = env["CARET_ENV_FILE"] ?? config.envFile
        var overrides = environment(fromEnvFileAt: envFile)
        for key in ["GROQ_API_KEY", "AI_GATEWAY_API_KEY", "TYPESAFE_API_KEY"] {
            if let value = env[key] { overrides[key] = value }
        }

        return .success(
            CoreLaunchConfiguration(
                rootURL: URL(fileURLWithPath: expandedRoot),
                pythonURL: URL(fileURLWithPath: (pythonPath as NSString).expandingTildeInPath),
                arguments: arguments,
                environmentOverrides: overrides
            )
        )
    }
}
