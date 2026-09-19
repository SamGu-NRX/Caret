import Foundation

/// Pull VERCEL_API_GATEWAY_KEY via GitHub Actions artifact (`export-gateway-key.yml`).
enum GatewayKeySync {
    private static let keyFileName = "vercel-api-gateway-key"

    static func hasCachedKey(projectRoot: URL?) -> Bool {
        if let key = ProcessInfo.processInfo.environment["VERCEL_API_GATEWAY_KEY"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !key.isEmpty {
            return true
        }
        for url in keyFileURLs(projectRoot: projectRoot) {
            if let text = try? String(contentsOf: url, encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !text.isEmpty {
                return true
            }
        }
        return false
    }

    /// Runs `scripts/sync_vercel_gateway_key.sh` (gh workflow dispatch + artifact download).
    static func syncFromGitHubIfNeeded(projectRoot: URL?) async {
        guard let root = projectRoot else { return }
        if hasCachedKey(projectRoot: root) { return }

        let script = root.appendingPathComponent("scripts/sync_vercel_gateway_key.sh")
        guard FileManager.default.isExecutableFile(atPath: script.path)
            || FileManager.default.fileExists(atPath: script.path)
        else { return }

        await Task.detached(priority: .utility) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = [script.path]
            process.currentDirectoryURL = root
            var environment = ProcessInfo.processInfo.environment
            environment["CARET_PROJECT_ROOT"] = root.path
            environment["CARET_SUPPORT_ROOT"] = CaretPaths.applicationSupportRoot.path
            process.environment = environment
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try? process.run()
            process.waitUntilExit()
        }.value
    }

    private static func keyFileURLs(projectRoot: URL?) -> [URL] {
        var urls = [CaretPaths.applicationSupportRoot.appendingPathComponent(keyFileName)]
        if let root = projectRoot {
            urls.append(root.appendingPathComponent(".local/\(keyFileName)"))
        }
        return urls
    }
}
