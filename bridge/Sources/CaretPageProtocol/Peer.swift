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

/// NDJSON lines over a connected socket, with one reader thread and any number of writers.
///
/// The socket owns its descriptor (W3 review #3). Its state and a count of writers in flight sit behind one condition
/// lock that no I/O is done under, so `shutdown` takes effect at once even while a write is blocked on a full buffer:
/// the blocked write then fails (W3 second review #2). No write starts after shutdown began, and `closeDescriptor`
/// waits for the writers in flight before it closes, once, so no write ever reaches a recycled descriptor. Only the
/// thread that reads (or, before a reader exists, the thread that set the socket up) closes it, after its last read.
public final class LineSocket: @unchecked Sendable {
    public let fd: Int32
    private var buffer = Data()
    private let cond = NSCondition()
    private enum State { case open, shut, closed }
    private var state = State.open
    private var writers = 0
    /// Keeps each line whole among writers; never held by shutdown or close.
    private let order = NSLock()
    public init(fd: Int32) { self.fd = fd }

    private var isOpen: Bool {
        cond.lock(); defer { cond.unlock() }
        return state == .open
    }

    /// The next line without its newline; nil at end of stream, on error, after shutdown, or when `timeout` seconds
    /// pass first. The timeout is one deadline for the whole line, however it arrives (W3 review #12).
    public func next(timeout: Double? = nil) -> Data? {
        let end = timeout.map { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) + UInt64($0 * 1_000_000_000) }
        while true {
            if let nl = buffer.firstIndex(of: 0x0A) {
                let line = Data(buffer[buffer.startIndex..<nl])
                buffer = Data(buffer[(nl + 1)...])
                return line
            }
            if !isOpen { return nil }
            if let end {
                let now = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
                guard now < end else { return nil }
                var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                if poll(&p, 1, Int32(min((end - now) / 1_000_000 + 1, UInt64(Int32.max)))) <= 0 { return nil }
            }
            var chunk = [UInt8](repeating: 0, count: 65536)
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { return nil }
            buffer.append(contentsOf: chunk[0..<n])
            if buffer.count > 64 * 1024 * 1024 { return nil }
        }
    }

    /// Writes one line and its newline, whole; false once the socket is shut down or the write fails.
    public func write(line: Data) -> Bool {
        order.lock(); defer { order.unlock() }
        cond.lock()
        guard state == .open else { cond.unlock(); return false }
        writers += 1
        cond.unlock()
        defer {
            cond.lock()
            writers -= 1
            cond.broadcast()
            cond.unlock()
        }
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

    /// Ends both directions: a blocked read or write returns, and no later write starts. From any thread, any number of times.
    public func shutdown() {
        cond.lock(); defer { cond.unlock() }
        guard state == .open else { return }
        Darwin.shutdown(fd, SHUT_RDWR)
        state = .shut
    }

    /// Shuts down, waits for writers in flight, and closes the descriptor, once. Only the reading thread calls it, after its last read.
    public func closeDescriptor() {
        cond.lock(); defer { cond.unlock() }
        if state == .closed { return }
        if state == .open { Darwin.shutdown(fd, SHUT_RDWR) }
        state = .shut
        while writers > 0 { cond.wait() }
        Darwin.close(fd)
        state = .closed
    }
}
