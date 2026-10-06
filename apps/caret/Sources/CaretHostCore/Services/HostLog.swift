import Darwin
import Foundation

/// The host's log file, `~/Library/Logs/Caret/host.log` (H12, lead decision 6).
///
/// The host points its own standard output and error at the file at startup (`redirect`), because launchd does not
/// expand `~` in a bundled agent plist, so the plist cannot name a path in the user's home. The helper and the reader
/// inherit descriptors 1 and 2 (`ServiceLauncher.spawnWithSecret`), so their lines land in the same file.
///
/// Size: `rotateIfNeeded` keeps at most one older file, `host.log.1`. It copies the log there and truncates the log in
/// place rather than renaming it, because every writer holds its own descriptor to the file: a renamed log would keep
/// receiving the children's lines until they restart. The file is opened with O_APPEND, so after the truncation each
/// writer's next line goes to the new end. Lines written between the copy and the truncation are lost; at this file's
/// rate that is rare and costs a line, not the log.
///
/// What goes in follows the debug socket's privacy rule: no field contents, typed text or model output. The host's own
/// lines carry ids, counts, bundle ids, app names and reasons (`HostLogTests` seeds content through the paths that log
/// and checks none of it arrives).
public struct HostLog: Sendable {
    public let path: String
    /// Bytes past which `rotateIfNeeded` rotates. There is no measurement behind 4 MiB: it holds days of the lines the
    /// host writes in a session (a few per minute) and stays small next to the rest of Caret's data.
    public let cap: Int

    public static let defaultCap = 4 * 1024 * 1024
    /// How often the running host checks the size. Between checks the file can grow past the cap by whatever is
    /// written in that time.
    public static let checkInterval: TimeInterval = 30

    public init(path: String, cap: Int = HostLog.defaultCap) {
        self.path = path
        self.cap = cap
    }

    /// `~/Library/Logs/Caret/host.log` for the user `userHome`.
    public static func `default`(userHome: String) -> HostLog {
        HostLog(path: userHome + "/Library/Logs/Caret/host.log")
    }

    public var rotatedPath: String { path + ".1" }
    var directory: String { (path as NSString).deletingLastPathComponent }

    /// Whether this run writes the file. The user's own Caret does; a run with its own `--home` keeps its standard
    /// error for whoever started it (every acceptance script reads it), and so does a run whose standard error is a
    /// terminal. `CARET_HOST_LOG=off` keeps standard error as it is in any run.
    public static func redirects(homeOverridden: Bool, stderrIsTerminal: Bool, environment: [String: String]) -> Bool {
        guard environment["CARET_HOST_LOG"] != "off" else { return false }
        return !homeOverridden && !stderrIsTerminal
    }

    public struct Problem: Error, CustomStringConvertible {
        public let description: String
    }

    /// Opens the log for appending (creating its folder 0700 and the file 0600), rotating first if it is already past
    /// the cap. Returns the descriptor; the caller decides what to point at it.
    public func open() throws -> Int32 {
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        rotateIfNeeded()
        let fd = Darwin.open(path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Problem(description: "could not open \(path): \(String(cString: strerror(errno)))") }
        return fd
    }

    /// Points standard output and error at the log. After this, `FileHandle.standardError` writes, the system's own
    /// stderr messages and every child Caret starts write here.
    public func redirect() throws {
        let fd = try open()
        defer { close(fd) }
        // dup2 clears close-on-exec on the new descriptors, so the children inherit them.
        guard dup2(fd, STDOUT_FILENO) >= 0, dup2(fd, STDERR_FILENO) >= 0 else {
            throw Problem(description: "could not point standard error at \(path): \(String(cString: strerror(errno)))")
        }
    }

    /// When the log is past the cap: copies it to `host.log.1`, replacing an older one, then truncates it. Returns true
    /// when it rotated.
    @discardableResult
    public func rotateIfNeeded() -> Bool {
        var info = stat()
        guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, Int(info.st_size) > cap else { return false }
        guard let data = FileManager.default.contents(atPath: path) else { return false }
        let staging = rotatedPath + ".partial"
        guard FileManager.default.createFile(atPath: staging, contents: data, attributes: [.posixPermissions: 0o600]),
              rename(staging, rotatedPath) == 0 else {
            unlink(staging)
            return false
        }
        return truncate(path, 0) == 0
    }
}
