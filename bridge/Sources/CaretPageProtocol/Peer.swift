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

/// The helper's per-start secret (helper/src/engines/auth.ts writeSecret), read only from a file and directory that
/// nobody but this user could have written.
public enum SecretFile {
    public static func path(forSocket socket: String) -> String { socket + ".key" }

    public static func read(path: String) throws -> Data {
        let dir = (path as NSString).deletingLastPathComponent
        var ds = stat()
        guard lstat(dir, &ds) == 0 else { throw PeerError.socket("lstat \(dir)", errno) }
        guard ds.st_mode & S_IFMT == S_IFDIR else { throw PeerError.unsafe("\(dir) is not a directory") }
        guard ds.st_uid == getuid() else { throw PeerError.unsafe("\(dir) belongs to uid \(ds.st_uid)") }
        guard ds.st_mode & 0o022 == 0 else { throw PeerError.unsafe("\(dir) is writable by group or others") }
        let fd = open(path, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { throw PeerError.socket("open \(path)", errno) }
        defer { close(fd) }
        var fs = stat()
        guard fstat(fd, &fs) == 0 else { throw PeerError.socket("fstat \(path)", errno) }
        guard fs.st_mode & S_IFMT == S_IFREG else { throw PeerError.unsafe("\(path) is not a regular file") }
        guard fs.st_uid == getuid() else { throw PeerError.unsafe("\(path) belongs to uid \(fs.st_uid)") }
        guard fs.st_mode & 0o777 == 0o600 else { throw PeerError.unsafe("\(path) has mode \(String(fs.st_mode & 0o777, radix: 8)), not 600") }
        var buf = [UInt8](repeating: 0, count: 128)
        let n = Darwin.read(fd, &buf, buf.count)
        guard n == 64, let secret = Data(hex: String(decoding: buf[0..<n], as: UTF8.self)), secret.count == 32 else {
            throw PeerError.unsafe("\(path) does not hold a 32-byte hex secret")
        }
        return secret
    }
}
