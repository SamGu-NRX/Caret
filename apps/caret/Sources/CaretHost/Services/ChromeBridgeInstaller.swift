import AppKit
import CaretHostCore
import Foundation

/// The user's click writes manifests only for installed browsers whose signatures the bridge accepts.
/// An isolated Caret home writes only to the explicit --nmh-dir. No install runs at first launch.
public enum ChromeBridgeInstaller {
    public static let steps = BrowserInstallPlan.manualSteps

    /// Status and instructions for the calling UI. No modal confirmation or result alert.
    public struct Result: Equatable, Sendable {
        public let message: String
        public let detail: String
        public let manualSteps: [String]
        /// False when nothing was installed: onboarding keeps its Add button so the person can try again.
        public var ok = true
        /// The browser whose Extensions page was opened (its display name): with one browser's manifest refused, another
        /// is opened instead, and onboarding waits for that one's extension.
        public var opened: String? = nil
    }

    struct Bundled {
        let bridge: URL
        let extensionFolder: URL

        static func inMainBundle() -> Bundled? {
            let contents = Bundle.main.bundleURL.appendingPathComponent("Contents")
            let bridge = contents.appendingPathComponent("Helpers/caret-bridge")
            let ext = contents.appendingPathComponent("Resources/Caret for Chrome")
            let fm = FileManager.default
            guard fm.isExecutableFile(atPath: bridge.path), fm.fileExists(atPath: ext.appendingPathComponent("manifest.json").path) else { return nil }
            return Bundled(bridge: bridge, extensionFolder: ext)
        }
    }

    enum Outcome: Equatable {
        case installed(String)
        case refused(String)
    }

    /// An unreadable or foreign manifest is never overwritten.
    static func writeManifest(bridgePath: String, directory: String) -> Outcome {
        let manifest = NativeMessagingManifest(bridgePath: bridgePath)
        let file = (directory as NSString).appendingPathComponent(manifest.fileName)
        let existing = FileManager.default.contents(atPath: file)
        if existing == nil, FileManager.default.fileExists(atPath: file) {
            return .refused("\(file) is there but Caret can't read it; Caret left it alone")
        }
        switch manifest.plan(existing: existing) {
        case .refuse(let why):
            return .refused(why)
        case .unchanged:
            return .installed("\(file) already starts \(bridgePath)")
        case .write, .replace:
            do {
                try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
                try manifest.encoded().write(to: URL(fileURLWithPath: file), options: .atomic)
                return .installed("wrote \(file)")
            } catch {
                return .refused("could not write \(file): \(error.localizedDescription)")
            }
        }
    }

    typealias Target = BrowserInstallPlan.Target
    typealias Destination = BrowserInstallPlan.Destination

    /// Kept for existing host checks; all planning rules live in the pure core plan.
    static func destination(home: CaretHome, override: String?, userHome: String, installed: (BridgeBrowser) -> Bool) -> Destination {
        BrowserInstallPlan(homeIsOverride: home.isOverride, manifestOverride: override, userHome: userHome,
                           installed: BridgeBrowser.allCases.filter(installed), defaultBundleID: nil).destination
    }

    static func install(bridgePath: String, targets: [Target]) -> [(Target, Outcome)] {
        targets.map { ($0, writeManifest(bridgePath: bridgePath, directory: $0.directory)) }
    }

    static func names(_ browsers: [BridgeBrowser]) -> String {
        let n = browsers.map(\.displayName)
        switch n.count {
        case 0: return ""
        case 1: return n[0]
        default: return n.dropLast().joined(separator: ", ") + " and " + n.last!
        }
    }

    static func pageBrowser(among browsers: [BridgeBrowser], defaultBundleID: String?) -> BridgeBrowser? {
        BrowserInstallPlan.pageBrowser(among: browsers, defaultBundleID: defaultBundleID)
    }

    /// One click installs, opens the default installed trusted browser's Extensions page and reveals the extension.
    /// If a browser's manifest could not be installed, open another successful browser instead.
    @MainActor
    public static func run(home: CaretHome, manifestOverride: String?) -> Result {
        guard let bundled = Bundled.inMainBundle() else {
            return Result(message: "Caret for Chrome isn't in this build of Caret.",
                          detail: "Build Caret.app with scripts/build-app.sh to include it.", manualSteps: steps, ok: false)
        }
        let workspace = NSWorkspace.shared
        let defaultBrowser = workspace.urlForApplication(toOpen: URL(string: "https://example.com")!).flatMap { Bundle(url: $0)?.bundleIdentifier }
        let plan = BrowserInstallPlan(homeIsOverride: home.isOverride, manifestOverride: manifestOverride,
                                     userHome: FileManager.default.homeDirectoryForCurrentUser.path,
                                     installed: BridgeBrowser.allCases.filter { workspace.urlForApplication(withBundleIdentifier: $0.bundleIdentifier) != nil },
                                     defaultBundleID: defaultBrowser)
        let targets: [Target]
        switch plan.destination {
        case .refused(let why):
            return Result(message: "Caret can't add itself to a browser in this run.",
                          detail: ([why] + plan.notices).joined(separator: "\n"), manualSteps: steps, ok: false)
        case .targets(let t): targets = t
        }
        let results = install(bridgePath: bundled.bridge.path, targets: targets)
        for (target, outcome) in results {
            let line: String
            switch outcome {
            case .installed(let what): line = what
            case .refused(let why): line = "refused: \(why)"
            }
            FileHandle.standardError.write(Data("caret: add to browser: \(target.browser?.displayName ?? "named folder"): \(line)\n".utf8))
        }
        let successful = results.filter { if case .installed = $0.1 { return true } else { return false } }
        let added = successful.compactMap(\.0.browser)
        let refused = results.compactMap { r -> String? in if case .refused(let why) = r.1 { return why } else { return nil } }
        guard !successful.isEmpty else {
            return Result(message: "Caret couldn't install its browser connection.",
                          detail: (refused + plan.notices).joined(separator: "\n"), manualSteps: steps, ok: false)
        }
        var opened: String?
        if let page = pageBrowser(among: added, defaultBundleID: defaultBrowser),
           let app = workspace.urlForApplication(withBundleIdentifier: page.bundleIdentifier) {
            opened = page.displayName
            // The store listing when there is one; until then the Extensions page and the folder to load unpacked.
            workspace.open([BrowserExtension.storeURL ?? page.extensionsPage], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
        }
        if BrowserExtension.storeURL == nil { workspace.activateFileViewerSelecting([bundled.extensionFolder]) }
        let message = added.isEmpty ? "Caret wrote this run's browser manifest." : "Caret's manifest is installed for \(names(added))."
        return Result(message: message, detail: (refused + plan.notices).joined(separator: "\n"), manualSteps: steps, opened: opened)
    }
}
