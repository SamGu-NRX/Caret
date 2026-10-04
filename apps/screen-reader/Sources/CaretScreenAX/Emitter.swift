// Where the reader's messages go: the helper's Unix socket in normal use, a file for recordings.
import CaretScreenCore
import Darwin
import Foundation

public protocol Emitter: AnyObject, Sendable {
    func send(_ m: Message)
}

/// NDJSON client for the helper's socket. While the helper is down, messages wait in a bounded backlog and the
/// client reconnects every second; on reconnect it sends hello and calls `onConnect`, so the reader can resend
/// full state.
///
/// Writing never blocks (S1 audit #9). Before B22 one serial queue both wrote, with blocking writes, and read the
/// helper's lines; a helper that stopped reading filled the socket, the queue stuck in write(), and a revoke
/// already waiting on the socket was never applied while queued commands still acted under the old grant. Now
/// the socket is non-blocking, lines wait in a buffer that a write source drains as the helper reads, and the
/// helper's lines are read on a queue of their own: act grants and revokes go straight into `grants` there, in
/// socket order, so a grant is in place before any command that follows it is handed on, and a revoke takes
/// effect however much output is waiting. A helper that stops reading fails closed: past `stallBytes` waiting,
/// or no progress for `stallAfter` seconds, every grant ends and the connection is dropped and made again.
///
/// The helper proves itself first (B23, CodeRabbit on PR #4). Before connecting, the socket's directory must be a
/// directory this user owns that no one else may enter, and the socket this user's; after connecting, the peer's
/// effective uid must be this user's. Each connection's hello carries a fresh challenge, and the helper's first line
/// must be helperAuth with the HMAC of it under the launch secret both processes got from the launcher (HelperProof).
/// Until that checks out the reader sends nothing but its hello, keeps every other message in the backlog, and applies
/// no grant, revoke or command; a wrong or missing proof, or none within `authTimeout`, drops the connection.
public final class SocketEmitter: Emitter, @unchecked Sendable {
    private let path: String
    private let hello: Hello
    private let secret: Data
    /// The connection, the outbound buffer and the backlog. Nothing on it blocks.
    private let queue = DispatchQueue(label: "caret.screen.socket")
    /// The helper's lines: read, decoded and applied here, never behind outbound writes.
    private let controlQueue = DispatchQueue(label: "caret.screen.socket.control", qos: .userInitiated)
    private var conn: Connection?
    private var backlog: [Data] = []
    private var retryScheduled = false
    /// Messages kept while disconnected. Older ones are dropped first; a resync follows reconnection anyway.
    private let backlogLimit = 500
    private let statsLock = NSLock()
    private var droppedCount = 0
    private var sentCount = 0
    /// Messages dropped from the backlog since the last connection was authenticated: the helper never got them, so
    /// the first connection must resync too (CodeRabbit on PR #4).
    private var backlogDropped = false
    public var dropped: Int { stat { droppedCount } }
    public var sent: Int { stat { sentCount } }
    private func stat<T>(_ f: () -> T) -> T {
        statsLock.lock(); defer { statsLock.unlock() }
        return f()
    }
    /// After the helper proved itself on a new connection. The argument is true when messages were dropped from the
    /// backlog while no proven helper was connected, so the screen must be sent again even on the first connection.
    public var onConnect: (@Sendable (_ lostMessages: Bool) -> Void)?
    /// After snapshots were dropped and the buffer drained: the same helper still holds its state, so only the
    /// screen is sent again (B20 review: the press watch must survive this, and must not survive a new helper).
    public var onResync: (@Sendable () -> Void)?
    public var onCommand: (@Sendable (ReaderCommand) -> Void)?
    /// Set before start(). Only the helper's connection writes it, so only the helper can grant.
    public var grants: GrantTable?
    /// A line longer than this from the helper is a bug; the connection is dropped. Commands are small.
    private let maxInboundLine = 1 << 20
    /// Bytes waiting for the helper past which snapshots are dropped, and a resync is sent once the buffer is
    /// down to a quarter of it. Assumed, not measured: a large window's snapshot is a few hundred kilobytes.
    public var snapshotDropBytes = 4 << 20
    /// Bytes waiting past which the helper counts as stalled (fail closed). Assumed, not measured.
    public var stallBytes = 32 << 20
    /// Seconds with bytes waiting and none taken past which the helper counts as stalled. Assumed, not measured:
    /// the helper's own command timeouts are 5 s, so by 10 s nothing it asked for is still awaited.
    public var stallAfter: TimeInterval = 10
    /// Seconds a new connection has to prove itself before it is dropped. Assumed: a helper answers in milliseconds.
    public var authTimeout: TimeInterval = 5
    private var resyncAfterDrain = false
    public var log: @Sendable (String) -> Void = { FileHandle.standardError.write(Data(("[caret-screen] " + $0 + "\n").utf8)) }
    /// Every line goes to `log` on this queue, never on the socket or control queue: a stderr nobody drains must
    /// not hold up a revoke (B22 review).
    private let logQueue = DispatchQueue(label: "caret.screen.socket.log", qos: .utility)
    private func note(_ line: String) {
        let log = self.log
        logQueue.async { log(line) }
    }

    /// `secret` is the launch secret, HelperProof.bytes long, from the descriptor the launcher handed over.
    public init(path: String, hello: Hello, secret: Data) {
        self.path = path
        self.hello = hello
        self.secret = secret
    }

    public func start() { queue.async { self.connect() } }

    /// Whether a connection to the helper is up, for tests.
    public var isConnected: Bool { queue.sync { conn != nil } }
    /// Whether a connection is up and its helper has proven itself, for tests.
    public var isAuthenticated: Bool { queue.sync { conn?.ready == true } }

    /// One connection: its descriptor, the outbound buffer as chunks with an offset into the first, and the two
    /// sources. The buffer and the write source are the main queue's; the read source and inbox are the control
    /// queue's. The descriptor is closed once both sources have been cancelled.
    private final class Connection: @unchecked Sendable {
        let fd: Int32
        /// Lines waiting, from `first` on; `head` bytes of `chunks[first]` are already written. The array is
        /// compacted now and then rather than shifted per line, so a long drain stays linear.
        var chunks: [Data] = []
        var first = 0
        var head = 0
        var bytes = 0
        var writeSource: DispatchSourceWrite?
        var writeArmed = false
        var readSource: DispatchSourceRead?
        var stallTimer: DispatchSourceTimer?
        var inbox = Data()
        /// When the helper last took bytes, or when the buffer last went from empty to not, on the monotonic
        /// uptime clock, so a wall clock set back cannot postpone the stall cutoff.
        var lastProgress = ProcessInfo.processInfo.systemUptime
        let sourcesDone = DispatchGroup()
        /// This connection's challenge, in its hello.
        let challenge: String
        /// The control queue's: the helper's proof checked out, so its lines are applied. Read and set under `closeLock`.
        private var proven = false
        /// The main queue's: the proof checked out and the backlog was handed over, so messages go straight out.
        var ready = false
        var authTimer: DispatchSourceTimer?
        /// Set once the connection is being dropped. A line the control queue applies is applied under the same
        /// lock, so a grant cannot land after the drop has cleared the table.
        private let closeLock = NSLock()
        private var closed = false
        init(fd: Int32, challenge: String) {
            self.fd = fd
            self.challenge = challenge
        }

        /// Runs `f` unless the connection was closed; nothing closes it meanwhile.
        func ifOpen(_ f: () -> Void) {
            closeLock.lock(); defer { closeLock.unlock() }
            if !closed { f() }
        }

        /// Runs `f` with whether the helper has proven itself, unless the connection was closed.
        func withProof(_ f: (_ proven: inout Bool) -> Void) {
            closeLock.lock(); defer { closeLock.unlock() }
            if !closed { f(&proven) }
        }

        /// Marks it closed, then runs `f` (which clears the grants) under the same lock.
        func close(then f: () -> Void) {
            closeLock.lock(); defer { closeLock.unlock() }
            closed = true
            f()
        }
    }

    public func send(_ m: Message) {
        let data: Data
        do { data = try NDJSON.line(m) } catch {
            note("encode failed: \(error)")
            return
        }
        let snapshot: Bool
        if case .snapshot = m { snapshot = true } else { snapshot = false }
        queue.async { self.enqueue(data, snapshot: snapshot) }
    }

    private func enqueue(_ d: Data, snapshot: Bool) {
        // No connection, or one whose helper has not proven itself: the message waits in the backlog.
        guard let c = conn, c.ready else {
            backlog.append(d)
            if backlog.count > backlogLimit {
                backlog.removeFirst(backlog.count - backlogLimit)
                stat { droppedCount += 1 }
                backlogDropped = true
            }
            if conn == nil { scheduleRetry() }
            return
        }
        // Over the bound, snapshots are dropped and a full resync follows once the buffer drains. Small event
        // messages (focus, switches, closes, verb results) still go in.
        if snapshot && c.bytes >= snapshotDropBytes {
            stat { droppedCount += 1 }
            resyncAfterDrain = true
            return
        }
        if c.bytes + d.count > stallBytes {
            failClosed(c, "the helper is not reading: \(c.bytes) bytes are waiting")
            return
        }
        append(d, to: c)
        // While the socket is full the write source drains the buffer; writing here would only meet EAGAIN.
        if !c.writeArmed { flush(c) }
    }

    private func append(_ d: Data, to c: Connection) {
        if c.bytes == 0 { c.lastProgress = ProcessInfo.processInfo.systemUptime }
        c.chunks.append(d)
        c.bytes += d.count
    }

    /// Writes what the socket takes now; the rest waits for the write source. Never blocks.
    private func flush(_ c: Connection) {
        defer {
            if c.first > 1024 && c.first * 2 > c.chunks.count {
                c.chunks.removeFirst(c.first)
                c.first = 0
            }
        }
        while c.first < c.chunks.count {
            let line = c.chunks[c.first]
            let n = line.withUnsafeBytes { raw in Darwin.write(c.fd, raw.baseAddress! + c.head, raw.count - c.head) }
            if n < 0 {
                if errno == EINTR { continue }
                if errno == EAGAIN || errno == EWOULDBLOCK { armWrite(c); return }
                disconnect(c, "write failed: \(String(cString: strerror(errno)))")
                return
            }
            c.lastProgress = ProcessInfo.processInfo.systemUptime
            c.bytes -= n
            c.head += n
            if c.head == line.count {
                c.first += 1
                c.head = 0
                stat { sentCount += 1 }
            }
        }
        c.chunks.removeAll(keepingCapacity: true)
        c.first = 0
        if c.writeArmed {
            c.writeSource?.suspend()
            c.writeArmed = false
        }
        if resyncAfterDrain && c.bytes < snapshotDropBytes / 4 {
            resyncAfterDrain = false
            note("output drained after drops; resyncing")
            onResync?()
        }
    }

    private func armWrite(_ c: Connection) {
        guard !c.writeArmed else { return }
        c.writeArmed = true
        c.writeSource?.resume()
    }

    private func scheduleRetry() {
        guard !retryScheduled else { return }
        retryScheduled = true
        queue.asyncAfter(deadline: .now() + 1) {
            self.retryScheduled = false
            if self.conn == nil { self.connect() }
        }
    }

    private func connect() {
        if let no = SocketPathCheck.refusal(path: path) {
            note("not connecting: \(no)")
            scheduleRetry()
            return
        }
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { note("socket(): \(String(cString: strerror(errno)))"); scheduleRetry(); return }
        var on: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            note("socket path too long: \(path)")
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
        guard ok == 0, fcntl(s, F_SETFL, fcntl(s, F_GETFL) | O_NONBLOCK) == 0 else {
            close(s)
            scheduleRetry()
            return
        }
        // The listener must run as this user; another user's process at the path gets nothing, not even a hello.
        var euid: uid_t = 0, egid: gid_t = 0
        guard getpeereid(s, &euid, &egid) == 0, euid == geteuid() else {
            note("not connecting: the process listening at \(path) does not run as this user")
            close(s)
            scheduleRetry()
            return
        }
        var h = hello
        h.challenge = HelperProof.challenge()
        let c = Connection(fd: s, challenge: h.challenge ?? "")
        conn = c
        note("connected to \(path); waiting for the helper to prove itself")
        startSources(c)
        guard let line = try? NDJSON.line(Message.hello(h)) else {
            disconnect(c, "hello failed")
            return
        }
        // Only the hello goes now; the backlog waits for the proof.
        append(line, to: c)
        flush(c)
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + authTimeout)
        t.setEventHandler { [weak self] in
            guard let self, self.conn === c, !c.ready else { return }
            self.failClosed(c, "the helper did not prove itself within \(self.authTimeout) s")
        }
        t.resume()
        c.authTimer = t
    }

    /// On the main queue, once the control queue checked the helper's proof: the backlog goes out and the reader resyncs.
    private func proven(_ c: Connection) {
        guard conn === c, !c.ready else { return }
        c.ready = true
        c.authTimer?.cancel()
        c.authTimer = nil
        note("the helper proved itself")
        for d in backlog { append(d, to: c) }
        backlog.removeAll()
        let lost = backlogDropped
        backlogDropped = false
        flush(c)
        if conn === c { onConnect?(lost) }
    }

    private func startSources(_ c: Connection) {
        let w = DispatchSource.makeWriteSource(fileDescriptor: c.fd, queue: queue)
        w.setEventHandler { [weak self] in
            guard let self, self.conn === c else { return }
            self.flush(c)
        }
        c.sourcesDone.enter()
        w.setCancelHandler { c.sourcesDone.leave() }
        // Created suspended; armWrite resumes it while the socket is full.
        c.writeSource = w

        let r = DispatchSource.makeReadSource(fileDescriptor: c.fd, queue: controlQueue)
        r.setEventHandler { [weak self] in
            guard let self else { return }
            var buf = [UInt8](repeating: 0, count: max(1, Int(r.data)))
            let n = Darwin.read(c.fd, &buf, buf.count)
            if n <= 0 {
                if n == 0 || (errno != EINTR && errno != EAGAIN) { self.lost(c, "helper closed the connection") }
                return
            }
            c.inbox.append(contentsOf: buf[0..<n])
            self.drainInbox(c)
        }
        c.sourcesDone.enter()
        r.setCancelHandler { c.sourcesDone.leave() }
        r.resume()
        c.readSource = r

        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(200))
        t.setEventHandler { [weak self] in
            guard let self, self.conn === c, c.bytes > 0 else { return }
            let quiet = ProcessInfo.processInfo.systemUptime - c.lastProgress
            if quiet > self.stallAfter { self.failClosed(c, "the helper has taken nothing for \(Int(quiet)) s with \(c.bytes) bytes waiting") }
        }
        t.resume()
        c.stallTimer = t
        // Dispatch requires the descriptor to stay open until every source on it is cancelled.
        c.sourcesDone.notify(queue: queue) { close(c.fd) }
    }

    /// On the control queue: every whole line the helper sent, in order.
    private func drainInbox(_ c: Connection) {
        while let nl = c.inbox.firstIndex(of: 0x0A) {
            let line = c.inbox[c.inbox.startIndex..<nl]
            c.inbox.removeSubrange(c.inbox.startIndex...nl)
            guard !line.isEmpty else { continue }
            do {
                let m = try JSONDecoder().decode(Message.self, from: Data(line))
                // Until the helper proves itself its lines are not applied: the first must be a proof that checks out.
                var trusted = false
                var refused: String?
                c.withProof { (proven: inout Bool) in
                    if proven { trusted = true; return }
                    guard case .helperAuth(let a) = m else { refused = "the helper's first line was not its proof"; return }
                    guard HelperProof.verify(a.proof, secret: secret, challenge: c.challenge) else { refused = "the helper's proof did not check out"; return }
                    proven = true
                    queue.async { self.proven(c) }
                }
                if let why = refused {
                    lost(c, why)
                    return
                }
                guard trusted else { continue }
                // A connection being dropped hands on nothing more: no command, and no grant after its grants were cleared.
                c.ifOpen {
                    switch m {
                    case .readerCommand(let cmd): onCommand?(cmd)
                    case .actGrant(let g):
                        grants?.issue(g, uptimeMs: uptimeMs())
                        note("act grant: task \(g.taskId), process \(g.pid), window \(g.windowId), for \(g.expires - g.at) ms")
                    case .calendarGrant(let g):
                        grants?.issueCalendar(g, uptimeMs: uptimeMs())
                        note("calendar grant: task \(g.taskId), for \(g.expires - g.at) ms")
                    case .actRevoke(let r):
                        grants?.revoke(taskId: r.taskId)
                        note("act grant revoked: task \(r.taskId)")
                    default: break
                    }
                }
            } catch {
                // The helper also sends error lines for bad input; anything else undecodable is logged and skipped.
                if !(String(decoding: line, as: UTF8.self).contains(#""type":"error""#)) { note("cannot decode a helper line: \(error)") }
                // Before the proof, a line that is not one means the peer is not a helper this reader trusts.
                var proven = true
                c.withProof { (p: inout Bool) in proven = p }
                if !proven {
                    lost(c, "the helper's first line was not its proof")
                    return
                }
            }
        }
        if c.inbox.count > maxInboundLine {
            c.inbox.removeAll()
            lost(c, "helper line over \(maxInboundLine) bytes")
        }
    }

    /// On the control queue: the connection is gone. Grants end here at once; the rest is the main queue's.
    private func lost(_ c: Connection, _ why: String) {
        c.close { clearGrants() }
        queue.async { self.disconnect(c, why) }
    }

    private func failClosed(_ c: Connection, _ why: String) {
        disconnect(c, "failing closed: \(why)")
    }

    private func clearGrants() {
        if let g = grants, g.count > 0 {
            g.clear()
            note("act grants cleared with the connection")
        }
    }

    /// On the main queue. Every grant ends with the connection; what was waiting for the helper is dropped, since
    /// the next connection begins with hello and a full resync.
    private func disconnect(_ c: Connection, _ why: String) {
        guard conn === c else { return }
        c.close { clearGrants() }
        conn = nil
        if !c.writeArmed { c.writeSource?.resume() }
        c.writeSource?.cancel()
        c.readSource?.cancel()
        c.stallTimer?.cancel()
        c.authTimer?.cancel()
        if c.bytes > 0 {
            stat { droppedCount += c.chunks.count - c.first }
            // Lines a proven helper never read: the next connection resyncs.
            if c.ready { backlogDropped = true }
        }
        c.chunks.removeAll()
        c.first = 0
        c.bytes = 0
        resyncAfterDrain = false
        note("disconnected: \(why)")
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

/// Where the reader may connect (B23, CodeRabbit on PR #4): the socket's directory must be a real directory (not a
/// link) owned by this user with no access for group or others, and the socket itself must be this user's. A same-user
/// process can still replace the socket, which is what the helper's proof is for; this keeps other users out.
public enum SocketPathCheck {
    /// Nil when the reader may connect to `path`; otherwise why not.
    public static func refusal(path: String) -> String? {
        let dir = (path as NSString).deletingLastPathComponent
        var st = stat()
        guard lstat(dir, &st) == 0 else { return "cannot read the socket directory \(dir)" }
        guard (st.st_mode & S_IFMT) == S_IFDIR else { return "the socket directory \(dir) is not a directory" }
        guard st.st_uid == geteuid() else { return "the socket directory \(dir) belongs to another user" }
        guard st.st_mode & 0o077 == 0 else { return "the socket directory \(dir) is open to other users (mode \(String(st.st_mode & 0o777, radix: 8)))" }
        guard lstat(path, &st) == 0 else { return "no socket at \(path)" }
        guard (st.st_mode & S_IFMT) == S_IFSOCK else { return "\(path) is not a socket" }
        guard st.st_uid == geteuid() else { return "the socket \(path) belongs to another user" }
        return nil
    }
}
