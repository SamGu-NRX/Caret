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
        /// Replaces the judge/writer defaults outright. Prefer `adapters` for
        /// the demo flags; see `resolve()` for why replacing is a footgun.
        var arguments: [String]?
        /// Appended, never replacing. Each entry becomes
        /// `--adapter <entry>`, e.g. "caret.live_workflows:MeetingDraftWorkflow".
        var adapters: [String]?
        var envFile: String?
        var demoMeeting: Bool?

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

    static var demoMeetingEnabled: Bool {
        demoMeetingEnabled(environment: ProcessInfo.processInfo.environment, config: DeveloperConfig.load())
    }

    static func demoMeetingEnabled(environment: [String: String], config: DeveloperConfig) -> Bool {
        // An explicit environment value overrides the developer file, including disabling it.
        if let value = environment["CARET_DEMO_MEETING"] { return value == "1" }
        return config.demoMeeting == true
    }

    enum Unavailable: Error, Equatable {
        case noInterpreter
        case noRoot(String)
        /// The provider the arguments select needs a key that is not set.
        /// Carries the variable name, which is actionable and is not a secret.
        case missingKey(variable: String, provider: String)
        /// The arguments do not select a judge, so the core would silently use
        /// its own default rather than the one intended.
        case judgeNotSelected

        var reason: InlineDisabledReason { .noProvider }

        var statusText: String {
            switch self {
            case .noInterpreter:
                return "No Python interpreter configured. Set \"python\" in ~/.config/caret/dev.json."
            case .noRoot(let path):
                return "Core not found at \(path). Set \"root\" in ~/.config/caret/dev.json."
            case .missingKey(let variable, let provider):
                return "\(variable) is not set, which the \(provider) provider needs. Add it to the env file in ~/.config/caret/dev.json."
            case .judgeNotSelected:
                return "No --judge in the configured arguments. The core defaults to jev, which needs a different key."
            }
        }
    }

    /// Which environment variable each provider reads.
    ///
    /// Checked before launching rather than after. The core does report the
    /// missing name on stderr and exit, but CaretCore's transport counts
    /// stderr and never logs it -- deliberately, so upstream text cannot leak
    /// into our logs. That means the name would never reach the user, and they
    /// would see only a process that died. Preflighting here recovers the one
    /// actionable fact without weakening that rule or reading the child's
    /// output. A variable NAME is not a secret; no value is ever read here.
    static func requiredKey(forProvider provider: String) -> String? {
        // Neither replays nor pattern-matches against a provider, so neither
        // reads a key. Returning a name here would block a working demo on a
        // variable nothing consumes.
        if provider.hasPrefix("scripted:") { return nil }
        switch provider {
        case "pattern": return nil
        case "gateway": return "AI_GATEWAY_API_KEY"
        case "groq": return "GROQ_API_KEY"
        case "jev": return "TYPESAFE_API_KEY"
        default: return nil
        }
    }

    /// The provider named by `flag`, or nil when the flag is absent.
    static func provider(named flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
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

        // Deterministic pattern judge, Groq inline writer.
        //
        // `gateway` was the default until the core owner ran it live on Sam's
        // team and got HTTP 403 customer_verification_required -- the Vercel
        // AI Gateway account needs a card on file. The core reports that as a
        // failed tick with no offer and no fallback, so a gateway default
        // would have produced an app that silently never completes anything.
        // `pattern` is the deterministic classifier the demo uses: meeting
        // phrases resolve to book-calendar-link, everything else abstains, and
        // every verdict is labelled pattern-demo so it cannot be mistaken for
        // a model result. Groq remains the real writer, so inline completions
        // are genuinely generated.
        //
        // Gateway stays reachable by putting it in the "arguments" key once
        // the account is verified. The core's own default judge is jev and
        // nothing falls back, so --judge is always passed explicitly.
        var arguments = config.arguments
            ?? env["CARET_CORE_ARGS"]?.split(separator: " ").map(String.init)
            ?? ["--judge", "pattern", "--writer", "groq"]

        // Adapters append. Putting them in `arguments` would replace the
        // defaults and silently drop --judge, leaving the core on jev with a
        // key that is not set -- a failure that looks nothing like its cause.
        for adapter in config.adapters ?? [] {
            arguments.append(contentsOf: ["--adapter", adapter])
        }

        guard let judge = provider(named: "--judge", in: arguments) else {
            return .failure(.judgeNotSelected)
        }

        let envFile = env["CARET_ENV_FILE"] ?? config.envFile
        var overrides = environment(fromEnvFileAt: envFile)
        for key in ["GROQ_API_KEY", "AI_GATEWAY_API_KEY", "TYPESAFE_API_KEY"] {
            if let value = env[key] { overrides[key] = value }
        }

        // Preflight every provider the arguments select, so a missing key is
        // named instead of surfacing as a dead process.
        for (flag, provider) in [("--judge", judge), ("--writer", provider(named: "--writer", in: arguments))].compactMap({ pair in
            pair.1.map { (pair.0, $0) }
        }) {
            guard let variable = requiredKey(forProvider: provider) else { continue }
            let present = overrides[variable]?.isEmpty == false || env[variable]?.isEmpty == false
            guard present else {
                return .failure(.missingKey(variable: variable, provider: "\(flag.dropFirst(2)) \(provider)"))
            }
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
