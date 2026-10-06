import AppKit
import CaretHostCore
import Foundation

/// "Add to your browser" (H4, lead decision 6; Helium since H12): the user starts it from onboarding or the menu, never
/// at first launch.
///
/// It writes the Native Messaging manifest that lets Caret for Chrome start Contents/Helpers/caret-bridge, into each
/// supported browser that is installed (`BridgeBrowser`). Until the Web Store listing exists, the extension itself is
/// the unpacked copy in Contents/Resources, which the user loads in developer mode; its id is fixed by the `key` in its
/// manifest, so the manifest's allowed origin matches in every browser.
///
/// Every manifest it writes is named ai.caret.bridge.json and starts this Caret.app's caret-bridge, which is how an
/// uninstall tells Caret's manifests from anything else in those folders.
public enum ChromeBridgeInstaller {
    /// What the user reads before Caret opens the browser. Three steps, each one action. The folder sits inside
    /// Caret.app, where the browser's file dialog does not browse, so step 3 drags it in from the Finder window Caret
    /// opens.
    static let steps = [
        "Turn on Developer mode, at the top right of the Extensions page.",
        "Click Load unpacked.",
        "Drag the “Caret for Chrome” folder from Finder into the window that opens, then click Select.",
    ]

    struct Bundled {
        let bridge: URL
        let extensionFolder: URL

        /// The bridge and the extension inside this Caret.app, or nil in a build without them.
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

    /// Writes the manifest into `directory`, by the rules of `NativeMessagingManifest.plan`. Creates the directory
    /// when the browser has not made it yet.
    static func writeManifest(bridgePath: String, directory: String) -> Outcome {
        let manifest = NativeMessagingManifest(bridgePath: bridgePath)
        let file = (directory as NSString).appendingPathComponent(manifest.fileName)
        let existing = FileManager.default.contents(atPath: file)
        // A file there that cannot be read is not ours to replace (H4 review).
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

    /// One place a manifest goes: a browser's folder, or the folder a test run named.
    struct Target: Equatable {
        /// Nil for a test run's `--nmh-dir`, which stands for no browser in particular.
        let browser: BridgeBrowser?
        let directory: String
    }

    /// Where the manifests go for this run. A run with its own Caret home is a test run: it writes only where it is
    /// told (`--nmh-dir`), never into the user's browsers.
    enum Destination: Equatable {
        case targets([Target])
        case refused(String)
    }

    /// `installed`: whether a browser is on this Mac (the app shell asks LaunchServices). Only installed browsers get a
    /// manifest; writing into a browser's folder before it exists would leave Caret's file behind for nothing.
    static func destination(home: CaretHome, override: String?, userHome: String, installed: (BridgeBrowser) -> Bool) -> Destination {
        if let override {
            return override.isEmpty ? .refused("the manifest directory given is empty") : .targets([Target(browser: nil, directory: override)])
        }
        if home.isOverride { return .refused("this run has its own Caret home; give it --nmh-dir to say where the manifest goes") }
        let targets = BridgeBrowser.allCases.filter(installed).map { Target(browser: $0, directory: $0.nativeMessagingDirectory(userHome: userHome)) }
        guard !targets.isEmpty else {
            return .refused("Caret works with \(names(BridgeBrowser.allCases)). Neither is installed on this Mac.")
        }
        return .targets(targets)
    }

    /// The manifest for each target, in order.
    static func install(bridgePath: String, targets: [Target]) -> [(Target, Outcome)] {
        targets.map { ($0, writeManifest(bridgePath: bridgePath, directory: $0.directory)) }
    }

    /// "Google Chrome and Helium".
    static func names(_ browsers: [BridgeBrowser]) -> String {
        let n = browsers.map(\.displayName)
        switch n.count {
        case 0: return ""
        case 1: return n[0]
        default: return n.dropLast().joined(separator: ", ") + " and " + n.last!
        }
    }

    /// The browser whose Extensions page opens: the user's default browser when Caret supports it, else the first.
    static func pageBrowser(among browsers: [BridgeBrowser], defaultBundleID: String?) -> BridgeBrowser? {
        browsers.first { $0.bundleIdentifier == defaultBundleID } ?? browsers.first
    }

    /// The whole step, from the menu or onboarding: explain, then on the user's yes write the manifests, open a
    /// browser's Extensions page and show the extension folder in Finder.
    @MainActor
    public static func run(home: CaretHome, manifestOverride: String?) {
        guard let bundled = Bundled.inMainBundle() else {
            return tell("Caret for Chrome isn’t in this build of Caret.", detail: "Build Caret.app with scripts/build-app.sh to include it.")
        }
        let workspace = NSWorkspace.shared
        let targets: [Target]
        switch destination(home: home, override: manifestOverride, userHome: FileManager.default.homeDirectoryForCurrentUser.path,
                           installed: { workspace.urlForApplication(withBundleIdentifier: $0.bundleIdentifier) != nil }) {
        case .refused(let why): return tell("Caret can’t add itself to a browser in this run.", detail: why)
        case .targets(let t): targets = t
        }
        let browsers = targets.compactMap(\.browser)
        let defaultBrowser = workspace.urlForApplication(toOpen: URL(string: "https://example.com")!).flatMap { Bundle(url: $0)?.bundleIdentifier }
        let page = pageBrowser(among: browsers, defaultBundleID: defaultBrowser)

        let alert = NSAlert()
        alert.messageText = "Add Caret to your browser"
        let into = browsers.isEmpty ? "this run’s manifest folder" : names(browsers)
        let opens = page.map { "\($0.displayName)’s Extensions page" } ?? "the Extensions page"
        alert.informativeText = "Caret connects itself to \(into). Caret for Chrome isn’t in the Chrome Web Store yet, so the browser loads it from a folder. Caret opens \(opens) and the folder. Then:\n\n"
            + steps.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
            + (browsers.count > 1 ? "\n\nTo use Caret in \(names(browsers.filter { $0 != page })) too, do the same on its Extensions page." : "")
        alert.addButton(withTitle: page.map { "Open \($0.displayName)" } ?? "Continue")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        let results = install(bridgePath: bundled.bridge.path, targets: targets)
        for (target, outcome) in results {
            let line: String
            switch outcome {
            case .installed(let what): line = what
            case .refused(let why): line = "refused: \(why)"
            }
            FileHandle.standardError.write(Data("caret: add to browser: \(target.browser?.displayName ?? "named folder"): \(line)\n".utf8))
        }
        let added = results.filter { if case .installed = $0.1 { return true } else { return false } }.compactMap(\.0.browser)
        let refused = results.compactMap { r -> String? in if case .refused(let why) = r.1 { return why } else { return nil } }
        if added.isEmpty, !refused.isEmpty {
            return tell("Caret couldn’t connect to your browser.", detail: refused.joined(separator: "\n"))
        }
        if !refused.isEmpty {
            tell("Caret connected to \(names(added)) only.", detail: refused.joined(separator: "\n"))
        }
        if let page, added.contains(page), let app = workspace.urlForApplication(withBundleIdentifier: page.bundleIdentifier) {
            workspace.open([page.extensionsPage], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
        }
        workspace.activateFileViewerSelecting([bundled.extensionFolder])
    }

    @MainActor
    private static func tell(_ message: String, detail: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = detail
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}
