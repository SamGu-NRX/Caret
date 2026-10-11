import Darwin
import Foundation

/// A Unix-domain socket that answers one request per connection with JSON.
///
/// Protocol: connect, optionally write one command line, read until EOF. An empty request means
/// `state`. Commands are handled by `respond`, on the socket's own thread, so the socket still
/// answers while the main thread is busy.
final class DebugStateSocket: @unchecked Sendable {
    enum SocketError: Error, CustomStringConvertible {
        case pathTooLong(String)
        case alreadyServed(String)
        case system(String, Int32)
        case notPrivate(String, String)

        var description: String {
            switch self {
            case .pathTooLong(let path): return "socket path too long: \(path)"
            case .alreadyServed(let path): return "another host is already answering on \(path)"
            case .notPrivate(let dir, let why): return "the debug socket's folder \(dir) is not Caret's own: \(why)"
            case .system(let call, let code): return "\(call) failed: \(String(cString: strerror(code)))"
            }
        }
    }

    let path: String
    /// The socket's folder is Caret's own (`CaretHome.socketsDirectory`), so the host makes sure it is a real folder of
    /// the user's, open to no one else (H12). False for a socket a run named, whose folder belongs to whoever named it.
    let privateDirectory: Bool
    private let respond: @Sendable (String) -> Data
    private var listener: Int32 = -1
    private var thread: Thread?

    init(path: String, privateDirectory: Bool = false, respond: @escaping @Sendable (String) -> Data) {
        self.path = path
        self.privateDirectory = privateDirectory
        self.respond = respond
    }

    func start() throws {
        // A client that hangs up before the reply must not kill the host. SO_NOSIGPIPE on each
        // connection covers writes; ignoring the signal covers everything else on the socket path.
        signal(SIGPIPE, SIG_IGN)
        let directory = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if privateDirectory { try Self.makePrivate(directory) }
        if Self.isServed(path) { throw SocketError.alreadyServed(path) }
        unlink(path)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketError.system("socket", errno) }
        var address = try Self.address(for: path)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0 else { let code = errno; close(fd); throw SocketError.system("bind", code) }
        chmod(path, 0o600)
        guard listen(fd, 8) == 0 else { let code = errno; close(fd); throw SocketError.system("listen", code) }
        listener = fd

        let thread = Thread { [weak self] in self?.acceptLoop(fd) }
        thread.name = "dev.caret.host.debug-socket"
        thread.qualityOfService = .utility
        self.thread = thread
        thread.start()
    }

    func stop() {
        if listener >= 0 {
            shutdown(listener, SHUT_RDWR)
            close(listener)
            listener = -1
        }
        unlink(path)
    }

    private func acceptLoop(_ fd: Int32) {
        while true {
            let client = accept(fd, nil, nil)
            if client < 0 {
                if errno == EINTR { continue }
                return
            }
            serve(client)
        }
    }

    private func serve(_ client: Int32) {
        defer { close(client) }
        var timeout = timeval(tv_sec: 0, tv_usec: 200_000)
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var noSigPipe: Int32 = 1
        setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))

        // One line, up to 64 KB (an injected pop-up spec runs to a few KB), ended by a newline or
        // by the client closing its side.
        var received = Data()
        var chunk = [UInt8](repeating: 0, count: 8192)
        while received.count < 65_536 {
            let count = read(client, &chunk, chunk.count)
            if count <= 0 { break }
            received.append(contentsOf: chunk[0..<count])
            if chunk[0..<count].contains(0x0A) { break }
        }
        let firstLine = String(decoding: received, as: UTF8.self)
            .split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let command = firstLine.trimmingCharacters(in: .whitespacesAndNewlines)
        let reply = respond(command.isEmpty ? "state" : command)
        reply.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = write(client, raw.baseAddress! + offset, raw.count - offset)
                if written <= 0 { return }
                offset += written
            }
        }
    }

    private static func address(for path: String) throws -> sockaddr_un {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard bytes.count < capacity else { throw SocketError.pathTooLong(path) }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        return address
    }

    /// `directory` must be a folder, not a link, owned by this user, and set to 0700; and every folder above it, once
    /// links are resolved, must be one no one else can change: owned by this user or root, and writable by others only
    /// with the sticky bit (/private/tmp). With a trusted chain, nobody else can swap the folder between this check and
    /// the bind that follows by path (H12 review). The final folder is tightened through a descriptor opened without
    /// following links, so the chmod cannot land anywhere else.
    static func makePrivate(_ directory: String) throws {
        var info = stat()
        guard lstat(directory, &info) == 0 else { throw SocketError.system("lstat \(directory)", errno) }
        guard (info.st_mode & S_IFMT) == S_IFDIR else { throw SocketError.notPrivate(directory, "it is not a folder") }
        guard let resolved = realpath(directory, nil) else { throw SocketError.system("realpath \(directory)", errno) }
        let real = String(cString: resolved)
        free(resolved)
        var ancestor = (real as NSString).deletingLastPathComponent
        while true {
            var a = stat()
            guard lstat(ancestor, &a) == 0 else { throw SocketError.system("lstat \(ancestor)", errno) }
            guard a.st_uid == getuid() || a.st_uid == 0 else { throw SocketError.notPrivate(directory, "\(ancestor) belongs to user \(a.st_uid)") }
            guard a.st_mode & 0o022 == 0 || a.st_mode & mode_t(S_ISVTX) != 0 else {
                throw SocketError.notPrivate(directory, "others can change \(ancestor)")
            }
            if ancestor == "/" { break }
            ancestor = (ancestor as NSString).deletingLastPathComponent
        }
        let fd = open(real, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw SocketError.system("open \(real)", errno) }
        defer { close(fd) }
        guard fstat(fd, &info) == 0 else { throw SocketError.system("fstat \(real)", errno) }
        guard info.st_uid == getuid() else { throw SocketError.notPrivate(directory, "it belongs to user \(info.st_uid)") }
        if info.st_mode & 0o777 != 0o700, fchmod(fd, 0o700) != 0 { throw SocketError.system("fchmod \(real)", errno) }
    }

    /// True when a live process accepts connections on `path`: a second host must not steal the
    /// socket (or run a second key tap).
    static func isServed(_ path: String) -> Bool {
        guard var address = try? address(for: path) else { return false }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        return result == 0
    }
}
