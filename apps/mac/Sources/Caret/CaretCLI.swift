import Foundation

enum CaretCLI {
    enum Error: Swift.Error {
        case missingProjectRoot
        case launchFailed(Swift.Error)
        case nonZeroExit(Int32, String)
        case emptyResponse
    }

    static func autoExpand(prefix: String, instructions: String) async throws -> String {
        try await Task.detached(priority: .userInitiated) {
            var args = ["--prefix", prefix]
            if !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                args.append(contentsOf: ["--instructions", instructions])
            }
            return try runCommand(subcommand: "auto-expand", arguments: args)
        }.value
    }

    static func runAction(actionID: String, text: String, instructions: String) async throws -> String {
        let trimmed = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw Error.emptyResponse
        }
        return try await Task.detached(priority: .userInitiated) {
            let args = ["--action", actionID, "--text", text, "--instructions", trimmed]
            return try runCommand(subcommand: "run-action", arguments: args)
        }.value
    }

    private static func runCommand(subcommand: String, arguments: [String]) throws -> String {
        let config = CoreLaunchSettings.DeveloperConfig.load()
        let parentEnvironment = ProcessInfo.processInfo.environment
        let configuredRoot = parentEnvironment["CARET_CORE_ROOT"] ?? config.root
        guard let root = configuredRoot.map({ URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) })
            ?? CaretPaths.projectRoot else { throw Error.missingProjectRoot }
        let python = parentEnvironment["CARET_PYTHON"] ?? config.python ?? Self.pythonExecutable()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: (python as NSString).expandingTildeInPath)
        process.currentDirectoryURL = root
        var environment = CoreLaunchSettings.environment(
            fromEnvFileAt: parentEnvironment["CARET_ENV_FILE"] ?? config.envFile
        )
        environment.merge(parentEnvironment) { _, parent in parent }
        environment["CARET_PROJECT_ROOT"] = root.path
        environment["CARET_NOTES_ROOT"] = CaretPaths.notesRoot.path
        environment["CARET_SUPPORT_ROOT"] = CaretPaths.applicationSupportRoot.path
        environment["PYTHONPATH"] = root.path
        Self.injectGatewayAPIKey(into: &environment, projectRoot: root)
        process.environment = environment
        process.arguments = ["-m", "caret", subcommand] + arguments

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        do {
            try process.run()
        } catch {
            throw Error.launchFailed(error)
        }
        process.waitUntilExit()

        let outData = stdout.fileHandleForReading.readDataToEndOfFile()
        let errData = stderr.fileHandleForReading.readDataToEndOfFile()
        let out = String(data: outData, encoding: .utf8) ?? ""
        let err = String(data: errData, encoding: .utf8) ?? ""

        guard process.terminationStatus == 0 else {
            let payload = err.isEmpty ? out : err
            throw Error.nonZeroExit(process.terminationStatus, Self.parseCLIErrorPayload(payload))
        }
        let trimmed = out.trimmingCharacters(in: .newlines)
        guard !trimmed.isEmpty else {
            throw Error.emptyResponse
        }
        return trimmed
    }

    private static let gatewayKeyFileName = "vercel-api-gateway-key"

    private static func pythonExecutable() -> String {
        let candidates = [
            "/opt/homebrew/bin/python3.14",
            "/opt/homebrew/bin/python3.13",
            "/opt/homebrew/bin/python3.12",
            "/usr/local/bin/python3.12",
            "/usr/bin/python3",
        ]
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        return "/usr/bin/python3"
    }

    static func userFacingMessage(for error: Swift.Error) -> String {
        switch error {
        case Error.missingProjectRoot:
            return "Caret cannot find the project folder. Rebuild with make app from the hackathon repo."
        case Error.emptyResponse:
            return "The model returned no text. Try again or shorten the selection."
        case Error.launchFailed(let underlying):
            return "Could not run Caret CLI: \(underlying.localizedDescription)"
        case Error.nonZeroExit(_, let message):
            return message
        default:
            return String(describing: error)
        }
    }

    private static func parseCLIErrorPayload(_ payload: String) -> String {
        let trimmed = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        if let data = trimmed.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let error = object["error"] as? String {
            return humanizeGatewayError(error)
        }
        return humanizeGatewayError(trimmed)
    }

    private static func humanizeGatewayError(_ raw: String) -> String {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            return "Translation failed. Check Console.app for Caret logs."
        }
        if text.localizedCaseInsensitiveContains("credit card")
            || text.contains("customer_verification_required") {
            return """
            Vercel AI Gateway is blocked until you add a card on your Vercel team (free tier credits still apply).

            Vercel dashboard → Team → AI → add billing, then try Translate again.
            """
        }
        if text.localizedCaseInsensitiveContains("Missing API key") {
            return """
            Missing Vercel API key for Caret.

            Put the key in:
            ~/Library/Application Support/Caret/vercel-api-gateway-key
            """
        }
        if text.hasPrefix("Gateway HTTP") {
            return text.replacingOccurrences(of: "\\n", with: "\n")
        }
        return text
    }

    private static func injectGatewayAPIKey(into environment: inout [String: String], projectRoot: URL) {
        if let existing = environment["VERCEL_API_GATEWAY_KEY"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !existing.isEmpty {
            return
        }
        if let existing = environment["AI_GATEWAY_API_KEY"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !existing.isEmpty {
            return
        }
        let candidates = [
            CaretPaths.applicationSupportRoot.appendingPathComponent(gatewayKeyFileName),
            projectRoot.appendingPathComponent(".local/\(gatewayKeyFileName)"),
        ]
        for url in candidates {
            guard let key = try? String(contentsOf: url, encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines),
                !key.isEmpty
            else { continue }
            environment["VERCEL_API_GATEWAY_KEY"] = key
            return
        }
    }
}
