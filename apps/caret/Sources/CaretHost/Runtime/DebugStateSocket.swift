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

        var description: String {
            switch self {
            case .pathTooLong(let path): return "socket path too long: \(path)"
            case .alreadyServed(let path): return "another host is already answering on \(path)"
            case .system(let call, let code): return "\(call) failed: \(String(cString: strerror(code)))"
            }
        }
    }

    let path: String
    private let respond: @Sendable (String) -> Data
    private var listener: Int32 = -1
    private var thread: Thread?

    init(path: String, respond: @escaping @Sendable (String) -> Data) {
        self.path = path
        self.respond = respond
    }

    func start() throws {
        // A client that hangs up before the reply must not kill the host. SO_NOSIGPIPE on each
        // connection covers writes; ignoring the signal covers everything else on the socket path.
        signal(SIGPIPE, SIG_IGN)
        try FileManager.default.createDirectory(
            atPath: (path as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
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
