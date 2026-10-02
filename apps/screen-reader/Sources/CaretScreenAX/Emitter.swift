// Where the reader's messages go: the helper's Unix socket in normal use, a file for recordings.
import CaretScreenCore
import Darwin
import Foundation

public protocol Emitter: AnyObject, Sendable {
    func send(_ m: Message)
}

/// NDJSON client for the helper's socket. Writes happen on one serial queue. While the helper is
/// down, messages wait in a bounded backlog and the client reconnects every second; on reconnect it
/// sends hello and calls `onConnect`, so the reader can resend full state.
public final class SocketEmitter: Emitter, @unchecked Sendable {
    private let path: String
    private let hello: Hello
    private let queue = DispatchQueue(label: "caret.screen.socket")
    private var fd: Int32 = -1
    private var backlog: [Data] = []
    private var retryScheduled = false
    /// Messages kept while disconnected. Older ones are dropped first; a resync follows reconnection anyway.
    private let backlogLimit = 500
    public private(set) var dropped = 0
    public private(set) var sent = 0
    public var onConnect: (@Sendable () -> Void)?
    public var log: @Sendable (String) -> Void = { FileHandle.standardError.write(Data(("[caret-screen] " + $0 + "\n").utf8)) }

    public init(path: String, hello: Hello) {
        self.path = path
        self.hello = hello
    }

    public func start() { queue.async { self.connect() } }

    public func send(_ m: Message) {
        let data: Data
        do { data = try NDJSON.line(m) } catch {
            log("encode failed: \(error)")
            return
        }
        queue.async {
            if self.fd < 0 {
                self.enqueue(data)
                return
            }
            if !self.write(data) {
                self.disconnect("write failed: \(String(cString: strerror(errno)))")
                self.enqueue(data)
            }
        }
    }

    private func enqueue(_ d: Data) {
        backlog.append(d)
        if backlog.count > backlogLimit {
            backlog.removeFirst(backlog.count - backlogLimit)
            dropped += 1
        }
        scheduleRetry()
    }

    private func scheduleRetry() {
        guard !retryScheduled else { return }
        retryScheduled = true
        queue.asyncAfter(deadline: .now() + 1) {
            self.retryScheduled = false
            if self.fd < 0 { self.connect() }
        }
    }

    private func connect() {
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { log("socket(): \(String(cString: strerror(errno)))"); scheduleRetry(); return }
        var on: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            log("socket path too long: \(path)")
            close(s)
            return
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard ok == 0 else {
            close(s)
            scheduleRetry()
            return
        }
        fd = s
        log("connected to \(path)")
        guard let h = try? NDJSON.line(Message.hello(hello)), write(h) else {
            disconnect("hello failed")
            return
        }
        let pending = backlog
        backlog.removeAll()
        for d in pending where !write(d) {
            disconnect("write failed while flushing backlog")
            return
        }
        onConnect?()
    }

    private func write(_ d: Data) -> Bool {
        let ok = d.withUnsafeBytes { raw -> Bool in
            var off = 0
            while off < raw.count {
                let n = Darwin.write(fd, raw.baseAddress! + off, raw.count - off)
                if n < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                off += n
            }
            return true
        }
        if ok { sent += 1 }
        return ok
    }

    private func disconnect(_ why: String) {
        if fd >= 0 { close(fd) }
        fd = -1
        log("disconnected: \(why)")
        scheduleRetry()
    }
}

/// Writes every message as one NDJSON line to a file handle. Used for recordings and dumps.
public final class FileEmitter: Emitter, @unchecked Sendable {
    private let handle: FileHandle
    private let lock = NSLock()
    public init(handle: FileHandle) { self.handle = handle }
    public func send(_ m: Message) {
        guard let d = try? NDJSON.line(m) else { return }
        lock.lock(); handle.write(d); lock.unlock()
    }
}

/// Sends to several emitters, for recording a live session while the helper also receives it.
public final class TeeEmitter: Emitter, @unchecked Sendable {
    private let targets: [Emitter]
    public init(_ targets: [Emitter]) { self.targets = targets }
    public func send(_ m: Message) { for t in targets { t.send(m) } }
}
