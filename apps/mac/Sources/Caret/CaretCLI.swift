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
        guard let root = CaretPaths.projectRoot else {
            throw Error.missingProjectRoot
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.currentDirectoryURL = root
        var environment = ProcessInfo.processInfo.environment
        environment["CARET_PROJECT_ROOT"] = root.path
        environment["CARET_NOTES_ROOT"] = CaretPaths.notesRoot.path
        environment["CARET_SUPPORT_ROOT"] = CaretPaths.applicationSupportRoot.path
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
            throw Error.nonZeroExit(process.terminationStatus, err.isEmpty ? out : err)
        }
        let trimmed = out.trimmingCharacters(in: .newlines)
        guard !trimmed.isEmpty else {
            throw Error.emptyResponse
        }
        return trimmed
    }

    private static let gatewayKeyFileName = "vercel-api-gateway-key"

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
