import Foundation

/// The Native Messaging host manifest that lets Caret for Chrome start caret-bridge (xpc-bridge-host spec, step 4).
/// Written only when the user chooses "Add to Chrome", never at first launch.
public struct NativeMessagingManifest: Codable, Equatable, Sendable {
    /// The name the extension passes to `chrome.runtime.connectNative` (extension/src, bridge README).
    public static let hostName = "ai.caret.bridge"
    /// Caret for Chrome's id, fixed by the public `key` in extension/manifest.json (extension/EXTENSION_ID).
    public static let extensionId = "idbkbnaepbamcdecogahbinlcodkbmmj"

    public let name: String
    public let description: String
    public let path: String
    public let type: String
    public let allowedOrigins: [String]

    enum CodingKeys: String, CodingKey {
        case name, description, path, type
        case allowedOrigins = "allowed_origins"
    }

    /// `bridgePath`: Caret.app/Contents/Helpers/caret-bridge, absolute.
    public init(bridgePath: String) {
        name = Self.hostName
        description = "Caret page bridge"
        path = bridgePath
        type = "stdio"
        allowedOrigins = ["chrome-extension://\(Self.extensionId)/"]
    }

    public var fileName: String { "\(Self.hostName).json" }

    public func encoded() -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        // Encoding a struct of strings cannot fail.
        return (try? encoder.encode(self)) ?? Data()
    }

    /// What installing into a directory would do, given what is there now. Pure, so the rules are tested alone.
    public enum Plan: Equatable, Sendable {
        /// No manifest by that name: write ours.
        case write
        /// Ours is already there, byte for byte.
        case unchanged
        /// A manifest by that name for caret-bridge at another path (an older or moved Caret.app): replace it.
        case replace(previousPath: String)
        /// A file by that name that is not a caret-bridge manifest: leave it and say so.
        case refuse(String)
    }

    /// `existing`: the bytes of `<dir>/ai.caret.bridge.json`, or nil when there is none.
    public func plan(existing: Data?) -> Plan {
        guard let existing else { return .write }
        if existing == encoded() { return .unchanged }
        guard let other = try? JSONDecoder().decode(NativeMessagingManifest.self, from: existing) else {
            return .refuse("\(fileName) is there and is not a Native Messaging manifest; Caret left it alone")
        }
        guard other.name == Self.hostName, (other.path as NSString).lastPathComponent == "caret-bridge" else {
            return .refuse("\(fileName) is there and starts \(other.path), not caret-bridge; Caret left it alone")
        }
        return other.path == path ? .write : .replace(previousPath: other.path)
    }
}

/// Known Chromium browsers. Installation does not imply that the bridge trusts a browser's signature.
public enum BridgeBrowser: String, CaseIterable, Sendable {
    case chrome, helium, brave, edge, vivaldi, chromium

    public var displayName: String {
        switch self {
        case .chrome: return "Google Chrome"
        case .helium: return "Helium"
        case .brave: return "Brave"
        case .edge: return "Microsoft Edge"
        case .vivaldi: return "Vivaldi"
        case .chromium: return "Chromium"
        }
    }

    /// Sources for Chrome, Brave, Edge, Vivaldi and Chromium IDs:
    /// bitwarden/clients fdc8b349e4b5e7e23cdc3296c37fdb55c240a1bb,
    /// apps/desktop/desktop_native/chromium_importer/src/chromium/platform/macos.rs SUPPORTED_BROWSERS.
    /// Helium's ID is the captured designated requirement in bridge/Sources/CaretBridgeXPC/Trust.swift.
    public var bundleIdentifier: String {
        switch self {
        case .chrome: return "com.google.Chrome"
        case .helium: return "net.imput.helium"
        case .brave: return "com.brave.Browser"
        case .edge: return "com.microsoft.edgemac"
        case .vivaldi: return "com.vivaldi.Vivaldi"
        case .chromium: return "org.chromium.Chromium"
        }
    }

    /// Only these browsers have captured requirements in BridgeTrust.browserRequirements.
    /// Do not enable another browser without reading its requirement from a real signed app.
    public var isTrustedByBridge: Bool {
        self == .chrome || self == .helium
    }

    public var extensionsPage: URL { URL(string: "chrome://extensions")! }

    /// macOS folder sources for Chrome, Brave, Edge, Vivaldi and Chromium:
    /// keepassxreboot/keepassxc 9e0f57a4a4c6c629fa6d0a593acb7d089b1d95cd,
    /// src/browser/NativeMessageInstaller.cpp Q_OS_MACOS TARGET_DIR_* constants.
    /// Helium: bitwarden/clients fdc8b349e4b5e7e23cdc3296c37fdb55c240a1bb,
    /// apps/desktop/src/main/native-messaging.main.ts getMacNMHS, with NativeMessagingHosts appended by install.
    public func nativeMessagingDirectory(userHome: String) -> String {
        switch self {
        case .chrome: return userHome + "/Library/Application Support/Google/Chrome/NativeMessagingHosts"
        case .helium: return userHome + "/Library/Application Support/net.imput.helium/NativeMessagingHosts"
        case .brave: return userHome + "/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
        case .edge: return userHome + "/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
        case .vivaldi: return userHome + "/Library/Application Support/Vivaldi/NativeMessagingHosts"
        case .chromium: return userHome + "/Library/Application Support/Chromium/NativeMessagingHosts"
        }
    }
}

/// A pure plan for the single-click install. The shell supplies LaunchServices' installed and default browsers.
public struct BrowserInstallPlan: Equatable, Sendable {
    public struct Target: Equatable, Sendable {
        /// Nil for an explicit --nmh-dir, which is not a browser installation.
        public let browser: BridgeBrowser?
        public let directory: String

        public init(browser: BridgeBrowser?, directory: String) {
            self.browser = browser
            self.directory = directory
        }
    }

    public enum Destination: Equatable, Sendable {
        case targets([Target])
        case refused(String)
    }

    /// The UI can display these after the click; the installer does not ask for a second confirmation.
    public static let manualSteps = [
        "Turn on Developer mode, at the top right of the Extensions page.",
        "Click Load unpacked.",
        "Drag the \"Caret for Chrome\" folder from Finder into the window that opens, then click Select.",
    ]

    public let installedBrowsers: [BridgeBrowser]
    public let untrustedBrowsers: [BridgeBrowser]
    public let destination: Destination
    public let pageBrowser: BridgeBrowser?

    public var notices: [String] {
        untrustedBrowsers.map { "Caret can't connect to \($0.displayName) yet" }
    }

    public init(homeIsOverride: Bool, manifestOverride: String?, userHome: String,
                installed: [BridgeBrowser], defaultBundleID: String?) {
        // Stable order and no duplicate writes, even if the caller supplies duplicates.
        installedBrowsers = BridgeBrowser.allCases.filter { installed.contains($0) }
        untrustedBrowsers = installedBrowsers.filter { !$0.isTrustedByBridge }
        if let manifestOverride {
            destination = manifestOverride.isEmpty
                ? .refused("the manifest directory given is empty")
                : .targets([Target(browser: nil, directory: manifestOverride)])
            pageBrowser = nil
        } else if homeIsOverride {
            destination = .refused("this run has its own Caret home; give it --nmh-dir to say where the manifest goes")
            pageBrowser = nil
        } else {
            let trusted = installedBrowsers.filter(\.isTrustedByBridge)
            if installedBrowsers.isEmpty {
                destination = .refused("Caret works with Google Chrome and Helium. Neither is installed on this Mac.")
            } else if trusted.isEmpty {
                destination = .refused("No installed browser is trusted by Caret's bridge. Install Google Chrome or Helium.")
            } else {
                destination = .targets(trusted.map { Target(browser: $0, directory: $0.nativeMessagingDirectory(userHome: userHome)) })
            }
            pageBrowser = Self.pageBrowser(among: trusted, defaultBundleID: defaultBundleID)
        }
    }

    public static func pageBrowser(among browsers: [BridgeBrowser], defaultBundleID: String?) -> BridgeBrowser? {
        let trusted = browsers.filter(\.isTrustedByBridge)
        return trusted.first { $0.bundleIdentifier == defaultBundleID } ?? trusted.first
    }
}
