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

/// The browsers Caret can add itself to, and where each reads Native Messaging manifests for the user's own profile.
/// Both run the same build of Caret for Chrome under the same extension id, so one manifest content serves both, and
/// both are in `BridgeTrust.browserRequirements`, so the bridge accepts either as its parent.
public enum BridgeBrowser: String, CaseIterable, Sendable {
    case chrome
    /// Helium (imput), a Chromium browser; it reads manifests from its own Application Support folder (H12).
    case helium

    public var displayName: String {
        switch self {
        case .chrome: return "Google Chrome"
        case .helium: return "Helium"
        }
    }

    public var bundleIdentifier: String {
        switch self {
        case .chrome: return "com.google.Chrome"
        case .helium: return "net.imput.helium"
        }
    }

    /// The page Caret opens so the user can load the extension. Helium is Chromium and takes Chromium's address.
    public var extensionsPage: URL { URL(string: "chrome://extensions")! }

    /// Where the browser reads Native Messaging manifests for the user `userHome`.
    public func nativeMessagingDirectory(userHome: String) -> String {
        switch self {
        case .chrome: return userHome + "/Library/Application Support/Google/Chrome/NativeMessagingHosts"
        case .helium: return userHome + "/Library/Application Support/net.imput.helium/NativeMessagingHosts"
        }
    }
}
