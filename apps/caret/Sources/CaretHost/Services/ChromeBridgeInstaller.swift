import AppKit
import CaretHostCore
import Foundation

/// "Add to Chrome" (H4, lead decision 6): the user starts it from onboarding or the menu, never at first launch.
///
/// It writes the Native Messaging manifest that lets Caret for Chrome start Contents/Helpers/caret-bridge. Until the
/// Web Store listing exists, the extension itself is the unpacked copy in Contents/Resources/extension, which the user
/// loads in developer mode; its id is fixed by the `key` in its manifest, so the manifest's allowed origin matches.
public enum ChromeBridgeInstaller {
    /// What the user reads before Caret opens Chrome. Three steps, each one action. The folder sits inside Caret.app,
    /// where Chrome's file dialog does not browse, so step 3 drags it in from the Finder window Caret opens.
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
    /// when Chrome has not made it yet.
    static func writeManifest(bridgePath: String, directory: String) -> Outcome {
        let manifest = NativeMessagingManifest(bridgePath: bridgePath)
        let file = (directory as NSString).appendingPathComponent(manifest.fileName)
        let existing = FileManager.default.contents(atPath: file)
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

    /// Where the manifest goes for this run. A run with its own Caret home is a test run: it writes only where it is
    /// told (`--nmh-dir`), never into the user's browser.
    enum Destination: Equatable {
        case directory(String)
        case refused(String)
    }

    static func manifestDirectory(home: CaretHome, override: String?, userHome: String) -> Destination {
        if let override, !override.isEmpty { return .directory(override) }
        if home.isOverride { return .refused("this run has its own Caret home; give it --nmh-dir to say where the manifest goes") }
        return .directory(BridgeBrowser.chrome.nativeMessagingDirectory(userHome: userHome))
    }

    /// The whole step, from the menu or onboarding: explain, then on the user's yes write the manifest, open Chrome's
    /// Extensions page and show the extension folder in Finder.
    @MainActor
    public static func run(home: CaretHome, manifestOverride: String?) {
        guard let bundled = Bundled.inMainBundle() else {
            return tell("Caret for Chrome isn’t in this build of Caret.", detail: "Build Caret.app with scripts/build-app.sh to include it.")
        }
        let directory: String
        switch manifestDirectory(home: home, override: manifestOverride, userHome: FileManager.default.homeDirectoryForCurrentUser.path) {
        case .refused(let why): return tell("Caret can’t add itself to Chrome in this run.", detail: why)
        case .directory(let d): directory = d
        }
        let alert = NSAlert()
        alert.messageText = "Add Caret to Chrome"
        alert.informativeText = "Caret for Chrome isn’t in the Chrome Web Store yet, so Chrome loads it from a folder. Caret will open Chrome’s Extensions page and the folder. Then:\n\n"
            + steps.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
        alert.addButton(withTitle: "Open Chrome")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        if case .refused(let why) = writeManifest(bridgePath: bundled.bridge.path, directory: directory) {
            return tell("Caret couldn’t connect to Chrome.", detail: why)
        }
        if let chrome = NSWorkspace.shared.urlForApplication(withBundleIdentifier: BridgeBrowser.chrome.bundleIdentifier),
           let extensions = URL(string: "chrome://extensions") {
            NSWorkspace.shared.open([extensions], withApplicationAt: chrome, configuration: NSWorkspace.OpenConfiguration())
        } else {
            return tell("Chrome isn’t installed.", detail: "Install Google Chrome, then choose Add to Chrome again.")
        }
        NSWorkspace.shared.activateFileViewerSelecting([bundled.extensionFolder])
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
