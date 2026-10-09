import Foundation

/// Where the services Caret.app starts keep their sockets and data. One directory holds all of it, so a test run
/// given its own (`--home DIR`, `CARET_HOME`) never touches the user's.
///
///   <root>/sockets/screen.sock   the helper's socket (reader and host connect here)
///   <root>/sockets/page.sock     the helper's page socket (the host's bridge relay connects here)
///   <root>/                      the helper's data (`--data-dir`), as before H4
///   <root>/deny-apps.txt         apps the reader never reads (it writes the default list when missing)
///
/// The default root is the helper's own default data directory, so data a helper kept before H4 stays in use.
public struct CaretHome: Equatable, Sendable {
    public enum Problem: Error, Equatable, CustomStringConvertible {
        case notAbsolute(String)
        case socketPathTooLong(path: String, bytes: Int)

        public var description: String {
            switch self {
            case .notAbsolute(let p): return "the Caret home must be an absolute path, not '\(p)'"
            case .socketPathTooLong(let p, let n):
                return "the socket path \(p) is \(n) bytes; a Unix socket path holds at most \(CaretHome.socketPathLimit). Choose a shorter --home"
            }
        }
    }

    /// sockaddr_un.sun_path is 104 bytes on macOS, one of them the terminating NUL.
    public static let socketPathLimit = 103

    public let root: String
    /// True when the run named its own home: a test or development run, never the user's Caret.
    public let isOverride: Bool

    public var socketsDirectory: String { root + "/sockets" }
    public var screenSocket: String { socketsDirectory + "/screen.sock" }
    public var pageSocket: String { socketsDirectory + "/page.sock" }
    public var dataDirectory: String { root }
    public var denyList: String { root + "/deny-apps.txt" }
    /// The host's debug socket and settings move into an overridden home, so a test run reads and writes only its own.
    public var hostSocket: String { socketsDirectory + "/host.sock" }
    public var settingsFile: String { root + "/host-settings.json" }

    /// Where the engine keeps its token profiles. The user's Caret keeps the folder it has always used, so no profile
    /// is rebuilt; a run with its own home keeps its profiles there, and writes nothing into the user's Library.
    public func profilesDirectory(userHome: String) -> String {
        isOverride ? root + "/Profiles" : Self.trimmed(userHome) + "/Library/Application Support/Caret/v2-host/Profiles"
    }
    /// The helper and reader this home's Caret started, so the next Caret can stop any a killed one left running.
    public var childrenFile: String { root + "/services-children.json" }

    /// `override` is `--home` or `CARET_HOME`; `userHome` is the user's home directory.
    public static func resolve(override: String?, userHome: String) throws -> CaretHome {
        let home: CaretHome
        if let override {
            // An empty --home or CARET_HOME is a mistake, not a request for the user's real home (H4 review).
            home = CaretHome(root: Self.trimmed(override), isOverride: true)
        } else {
            home = CaretHome(root: Self.trimmed(userHome) + "/Library/Application Support/CaretV2", isOverride: false)
        }
        try home.validate()
        return home
    }

    private init(root: String, isOverride: Bool) {
        self.root = root
        self.isOverride = isOverride
    }

    private static func trimmed(_ path: String) -> String {
        var p = path
        while p.count > 1 && p.hasSuffix("/") { p.removeLast() }
        return p
    }

    private func validate() throws {
        guard root.hasPrefix("/") else { throw Problem.notAbsolute(root) }
        for path in [screenSocket, pageSocket, hostSocket] where path.utf8.count > Self.socketPathLimit {
            throw Problem.socketPathTooLong(path: path, bytes: path.utf8.count)
        }
    }
}
