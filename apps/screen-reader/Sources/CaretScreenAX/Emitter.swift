// Where the reader's messages go: the helper's Unix socket in normal use, a file for recordings.
import CaretScreenCore
import Darwin
import Foundation

public protocol Emitter: AnyObject, Sendable {
    func send(_ m: Message)
}

/// NDJSON client for the helper's socket. Writes happen on one serial queue. While the helper is
/// down, messages wait in a bounded backlog and the client reconnects every second; on reconnect it
/// sends hello and calls `onConnect`, so the reader can resend full state. Lines the helper sends
/// back (the executor's readerCommands) are decoded on the same queue and handed to `onCommand`.
/// Act grants and revokes go straight into `grants` on that queue, so a grant is in place before any
/// command that follows it on the socket is handed on, and every grant ends when the connection does.
public final class SocketEmitter: Emitter, @unchecked Sendable {
    private let path: String
    private let hello: Hello
    private let queue = DispatchQueue(label: "caret.screen.socket")
    private var fd: Int32 = -1
    private var backlog: [Data] = []
    private var retryScheduled = false
    /// Messages kept while disconnected. Older ones are dropped first; a resync follows reconnection anyway.
    private let backlogLimit = 500
    public private(set) var dropped = 0 // guarded by flightLock or the queue
    public private(set) var sent = 0
    public var onConnect: (@Sendable () -> Void)?
    /// After snapshots were dropped and the queue drained: the same helper still holds its state, so only the
    /// screen is sent again (B20 review: the press watch must survive this, and must not survive a new helper).
    public var onResync: (@Sendable () -> Void)?
    public var onCommand: (@Sendable (ReaderCommand) -> Void)?
    /// Set before start(). Only the helper's connection writes it, so only the helper can grant.
    public var grants: GrantTable?
    private var readSource: DispatchSourceRead?
    private var inbox = Data()
    /// A line longer than this from the helper is a bug; the connection is dropped. Commands are small.
    private let maxInboundLine = 1 << 20
    public var log: @Sendable (String) -> Void = { FileHandle.standardError.write(Data(("[caret-screen] " + $0 + "\n").utf8)) }

    public init(path: String, hello: Hello) {
        self.path = path
        self.hello = hello
    }

    public func start() { queue.async { self.connect() } }

    /// Messages handed to the write queue and not yet written. Writes block while the helper is not
    /// reading, so without this bound a stalled helper would let snapshots pile up in memory.
    private let flightLock = NSLock()
    private var inFlight = 0
    private var resyncAfterDrain = false
    private let flightLimit = 300

    public func send(_ m: Message) {
        let data: Data
        do { data = try NDJSON.line(m) } catch {
            log("encode failed: \(error)")
            return
        }
        flightLock.lock()
        // Over the bound, snapshots are dropped and a full resync follows once the queue drains.
        // Small event messages (focus, switches, closes) still go through.
        if inFlight >= flightLimit, case .snapshot = m {
            dropped += 1
            resyncAfterDrain = true
            flightLock.unlock()
            return
        }
        inFlight += 1
        flightLock.unlock()
        queue.async {
            defer { self.landed() }
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

    private func landed() {
        flightLock.lock()
        inFlight -= 1
        let resync = resyncAfterDrain && inFlight < flightLimit / 4
        if resync { resyncAfterDrain = false }
        flightLock.unlock()
        if resync {
            log("write queue drained after drops; resyncing")
            onResync?()
        }
    }

    private func enqueue(_ d: Data) {
        backlog.append(d)
        if backlog.count > backlogLimit {
            backlog.removeFirst(backlog.count - backlogLimit)
            flightLock.lock(); dropped += 1; flightLock.unlock()
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
        startReading(s)
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

    private func startReading(_ s: Int32) {
        inbox.removeAll()
        let src = DispatchSource.makeReadSource(fileDescriptor: s, queue: queue)
        src.setEventHandler { [weak self] in
            guard let self else { return }
            var buf = [UInt8](repeating: 0, count: max(1, Int(src.data)))
            let n = Darwin.read(s, &buf, buf.count)
            if n <= 0 {
                if n == 0 || (errno != EINTR && errno != EAGAIN) { self.disconnect("helper closed the connection") }
                return
            }
            self.inbox.append(contentsOf: buf[0..<n])
            self.drainInbox()
        }
        // Dispatch requires the descriptor to stay open until the source is cancelled, so it is closed here.
        src.setCancelHandler { close(s) }
        src.resume()
        readSource = src
    }

    private func drainInbox() {
        while let nl = inbox.firstIndex(of: 0x0A) {
            let line = inbox[inbox.startIndex..<nl]
            inbox.removeSubrange(inbox.startIndex...nl)
            guard !line.isEmpty else { continue }
            do {
                switch try JSONDecoder().decode(Message.self, from: Data(line)) {
                case .readerCommand(let c): onCommand?(c)
                case .actGrant(let g):
                    grants?.issue(g, uptimeMs: uptimeMs())
                    log("act grant: task \(g.taskId), process \(g.pid), window \(g.windowId), for \(g.expires - g.at) ms")
                case .calendarGrant(let g):
                    grants?.issueCalendar(g, uptimeMs: uptimeMs())
                    log("calendar grant: task \(g.taskId), for \(g.expires - g.at) ms")
                case .actRevoke(let r):
                    grants?.revoke(taskId: r.taskId)
                    log("act grant revoked: task \(r.taskId)")
                default: break
                }
            } catch {
                // The helper also sends error lines for bad input; anything else undecodable is logged and skipped.
                if !(String(decoding: line, as: UTF8.self).contains(#""type":"error""#)) { log("cannot decode a helper line: \(error)") }
            }
        }
        if inbox.count > maxInboundLine {
            inbox.removeAll()
            disconnect("helper line over \(maxInboundLine) bytes")
        }
    }

    private func disconnect(_ why: String) {
        if let g = grants, g.count > 0 {
            g.clear()
            log("act grants cleared with the connection")
        }
        if let src = readSource {
            src.cancel()
            readSource = nil
        } else if fd >= 0 {
            close(fd)
        }
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
