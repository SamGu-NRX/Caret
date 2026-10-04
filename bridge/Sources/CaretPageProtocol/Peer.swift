import Darwin
import Foundation

public enum PeerError: Error, Equatable, CustomStringConvertible {
    case pathTooLong(String)
    case socket(String, Int32)
    case wrongPeer(uid_t)
    case unsafe(String)

    public var description: String {
        switch self {
        case let .pathTooLong(p): "socket path too long: \(p)"
        case let .socket(what, e): "\(what): \(String(cString: strerror(e)))"
        case let .wrongPeer(uid): "the socket's peer is uid \(uid), not this user"
        case let .unsafe(why): why
        }
    }
}

public enum Peer {
    /// The uid of the process on the other end of a connected Unix socket.
    public static func uid(of fd: Int32) throws -> uid_t {
        var uid: uid_t = 0
        var gid: gid_t = 0
        guard getpeereid(fd, &uid, &gid) == 0 else { throw PeerError.socket("getpeereid", errno) }
        return uid
    }

    /// The pid of the process on the other end of a connected Unix socket (LOCAL_PEERPID), as the kernel recorded it
    /// at connect: for page.sock, the helper that listens. The reader checks the helper the same way (Emitter.swift).
    public static func pid(of fd: Int32) throws -> pid_t {
        var pid: pid_t = 0
        var len = socklen_t(MemoryLayout<pid_t>.size)
        guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &len) == 0 else { throw PeerError.socket("LOCAL_PEERPID", errno) }
        guard pid > 0 else { throw PeerError.unsafe("the socket's peer has no process id") }
        return pid
    }

    /// Connects to a Unix socket and refuses it unless the listener runs as this user.
    public static func connect(path: String) throws -> Int32 {
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { throw PeerError.pathTooLong(path) }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in bytes.enumerated() { raw[i] = b }
            raw[bytes.count] = 0
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw PeerError.socket("socket", errno) }
        let ok = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard ok == 0 else {
            let e = errno
            close(fd)
            throw PeerError.socket("connect \(path)", e)
        }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        do {
            let peer = try uid(of: fd)
            guard peer == getuid() else { throw PeerError.wrongPeer(peer) }
        } catch {
            close(fd)
            throw error
        }
        return fd
    }
}

/// NDJSON lines over a connected socket, read with a deadline during a handshake and without one after.
public final class LineSocket: @unchecked Sendable {
    public let fd: Int32
    private var buffer = Data()
    private let writeLock = NSLock()
    public init(fd: Int32) { self.fd = fd }

    /// The next line without its newline; nil at end of stream, on error, or when `timeout` (seconds) passes first.
    public func next(timeout: Int32? = nil) -> Data? {
        while true {
            if let nl = buffer.firstIndex(of: 0x0A) {
                let line = Data(buffer[buffer.startIndex..<nl])
                buffer = Data(buffer[(nl + 1)...])
                return line
            }
            if let t = timeout {
                var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                if poll(&p, 1, t * 1000) <= 0 { return nil }
            }
            var chunk = [UInt8](repeating: 0, count: 65536)
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { return nil }
            buffer.append(contentsOf: chunk[0..<n])
            if buffer.count > 64 * 1024 * 1024 { return nil }
        }
    }

    /// Writes one line and its newline, whole, from any thread.
    public func write(line: Data) -> Bool {
        writeLock.lock(); defer { writeLock.unlock() }
        var d = line
        d.append(0x0A)
        return d.withUnsafeBytes { raw -> Bool in
            var off = 0
            while off < raw.count {
                let n = Darwin.write(fd, raw.baseAddress! + off, raw.count - off)
                if n < 0 { if errno == EINTR { continue }; return false }
                off += n
            }
            return true
        }
    }

    public func close() { shutdown(fd, SHUT_RDWR) }
}
