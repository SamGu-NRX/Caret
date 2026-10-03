import CaretHostCore
import CaretScreenCore
import Darwin
import Foundation
import os

/// The host's connection to the helper's socket, as a consumer.
///
/// One thread connects, says hello, and reads NDJSON until the connection drops, then reconnects
/// with backoff; a helper started after the host is picked up within `maxBackoff`. Decoded
/// messages go to `onMessage` on that thread, which must only enqueue. `send` writes from any
/// thread under a lock, so a `fillResult` line is never interleaved with another.
final class HelperClient: @unchecked Sendable {
    typealias Stats = DebugState.HelperLink

    static var defaultPath: String {
        if let override = ProcessInfo.processInfo.environment["CARET_SCREEN_SOCKET"], !override.isEmpty {
            return override
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".caret-run/sockets/screen.sock").path
    }

    let path: String
    private let onMessage: @Sendable (HelperInbound) -> Void
    /// Called on the client thread with true after each hello, and false when the connection
    /// drops. Must only enqueue. The activity feed lists on connect and resets on disconnect,
    /// because the helper's task registry lives in its memory.
    private let onLink: @Sendable (Bool) -> Void
    private let stats = OSAllocatedUnfairLock(initialState: Stats())
    /// The connected descriptor (-1 when there is none) and the settings the helper's gate should
    /// hold. One lock for both, so a change made while the client connects is either in the line
    /// sent after hello or sent on its own afterwards, never lost. Writers hold it for the whole line.
    private struct Link {
        var fd: Int32 = -1
        var settings: GateSettings?
    }
    private let connection = OSAllocatedUnfairLock(initialState: Link())
    private let running = OSAllocatedUnfairLock(initialState: false)
    private let minBackoff: TimeInterval = 0.25
    private let maxBackoff: TimeInterval = 2

    init(
        path: String = HelperClient.defaultPath,
        onMessage: @escaping @Sendable (HelperInbound) -> Void,
        onLink: @escaping @Sendable (Bool) -> Void = { _ in }
    ) {
        self.path = path
        self.onMessage = onMessage
        self.onLink = onLink
    }

    func start() {
        let alreadyRunning = running.withLock { r -> Bool in
            defer { r = true }
            return r
        }
        guard !alreadyRunning else { return }
        let thread = Thread { [self] in runLoop() }
        thread.name = "dev.caret.host.helper-client"
        thread.qualityOfService = .userInitiated
        thread.start()
    }

    func stop() {
        running.withLock { $0 = false }
        connection.withLock { link in
            if link.fd >= 0 { shutdown(link.fd, SHUT_RDWR) }
        }
    }

    func snapshot() -> Stats { stats.withLock { $0 } }

    /// Writes one message. Dropped (and counted) when the helper is not connected: a result for a
    /// write the helper cannot hear about is not worth queueing across a reconnect, because the
    /// new helper session has forgotten the proposal.
    func send(_ result: FillResult) {
        sendLine(try? NDJSON.line(result))
    }

    /// `offerAccept` for an action line or pop-up the helper offered. Counted with the results.
    /// True when written.
    @discardableResult
    func send(_ accept: OfferAccept) -> Bool {
        let sent = sendLine(try? NDJSON.line(accept))
        if sent { stats.withLock { $0.accepts &+= 1 } }
        return sent
    }

    /// `offerStop`: Esc on the working line of an offer the helper offered. True when written.
    @discardableResult
    func send(_ stop: OfferStop) -> Bool {
        let sent = sendLine(try? NDJSON.line(stop))
        if sent { stats.withLock { $0.stops &+= 1 } }
        return sent
    }

    /// `taskControl` from the activity list or the input pause. True when written; a control for
    /// a helper that is not connected is dropped, since its task is gone with it.
    @discardableResult
    func send(_ control: TaskControl) -> Bool {
        sendLine(try? NDJSON.line(control))
    }

    /// `activityRequest`; the reply comes back to this connection only.
    @discardableResult
    func send(_ request: ActivityRequest) -> Bool {
        sendLine(try? NDJSON.line(request))
    }

    /// `firstLook`; the reply comes back to this connection only. False when the helper is not
    /// connected, which the first look reports as an error rather than waiting out its deadline.
    @discardableResult
    func send(_ request: FirstLookRequest) -> Bool {
        sendLine(try? request.line())
    }

    /// `memoryRequest`; the reply comes back to this connection only. False when the helper is not
    /// connected: the memory window then shows what it knew last, read only.
    @discardableResult
    func send(_ request: HelperMemory.Request) -> Bool {
        sendLine(try? request.line())
    }

    /// The user's settings for the helper's gate (B10). Sent now when connected and the roles,
    /// level or pause changed, and again after every hello, so a helper that restarts hears them
    /// before anything else the host writes. Any thread.
    ///
    /// A write that fails on a live connection shuts it down: the reconnect sends these settings
    /// after its hello. Otherwise the same settings asked for again would be dropped as no change
    /// while the helper still held the old ones (A10 review).
    func update(_ settings: GateSettings) {
        let sent = connection.withLock { link -> Bool? in
            if let previous = link.settings, previous.sameGate(as: settings) { return nil }
            link.settings = settings
            guard link.fd >= 0, let line = try? NDJSON.line(settings) else { return false }
            let written = Self.writeAll(link.fd, line)
            if !written { shutdown(link.fd, SHUT_RDWR) }
            return written
        }
        if sent == true { stats.withLock { $0.settingsSent &+= 1 } }
    }

    @discardableResult
    private func sendLine(_ line: Data?) -> Bool {
        guard let line else { return false }
        let sent = connection.withLock { link -> Bool in
            guard link.fd >= 0 else { return false }
            return Self.writeAll(link.fd, line)
        }
        stats.withLock { s in
            if sent { s.resultsSent &+= 1 } else { s.resultsDropped &+= 1 }
        }
        return sent
    }

    // MARK: - Client thread

    private func runLoop() {
        var backoff = minBackoff
        while running.withLock({ $0 }) {
            if let fd = connect() {
                backoff = minBackoff
                onLink(true)
                readUntilClosed(fd)
                connection.withLock { link in
                    if link.fd == fd { link.fd = -1 }
                }
                close(fd)
                stats.withLock { $0.connected = false }
                onLink(false)
            }
            guard running.withLock({ $0 }) else { break }
            Thread.sleep(forTimeInterval: backoff)
            backoff = min(maxBackoff, backoff * 2)
        }
    }

    private func connect() -> Int32? {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return nil }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var noSigPipe: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard result == 0 else {
            close(fd)
            return nil
        }
        let hello = Hello(role: .consumer, mode: .live, pid: Int(getpid()), version: "caret-host 0.2.0")
        guard let line = try? NDJSON.line(hello), Self.writeAll(fd, line) else {
            close(fd)
            return nil
        }
        // Settings go right after hello, restamped now: the helper's gate applies them to its next
        // decision, which may be the first thing it says to this connection.
        let settingsSent = connection.withLock { link -> Bool? in
            link.fd = fd
            guard var settings = link.settings else { return nil }
            settings.at = Int64((Date().timeIntervalSince1970 * 1000).rounded())
            link.settings = settings
            guard let line = try? NDJSON.line(settings) else { return false }
            return Self.writeAll(fd, line)
        }
        stats.withLock {
            $0.connected = true
            $0.connects &+= 1
            if settingsSent == true { $0.settingsSent &+= 1 }
        }
        return fd
    }

    private func readUntilClosed(_ fd: Int32) {
        var framer = LineFramer()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while running.withLock({ $0 }) {
            let count = read(fd, &buffer, buffer.count)
            if count <= 0 {
                if count < 0, errno == EINTR { continue }
                return
            }
            for item in framer.append(Data(buffer[0..<count])) {
                switch item {
                case .oversized:
                    stats.withLock { $0.undecodable &+= 1 }
                case .line(let line):
                    handle(line)
                }
            }
        }
    }

    private func handle(_ line: Data) {
        let message: HelperInbound
        do {
            message = try HelperInbound.decode(line)
        } catch {
            stats.withLock { $0.undecodable &+= 1 }
            return
        }
        stats.withLock { s in
            switch message {
            case .fillProposal: s.proposals &+= 1
            case .activity, .activityReply: s.activity &+= 1
            case .alternatives, .action, .popup: s.offers &+= 1
            case .offerWithdrawn: s.withdrawals &+= 1
            case .taskProgress: s.progress &+= 1
            case .firstLookReply: s.firstLookReplies &+= 1
            case .memoryReply: s.memoryReplies &+= 1
            case .error(let e):
                s.errors &+= 1
                // The helper answers a message it cannot parse with this error; until its schema
                // has fillResult, every result the host writes is rejected (see the A2 report).
                if e.message.hasPrefix("invalid consumer message") { s.resultsRejected &+= 1 }
                // The helper's error text names windows and reasons, never screen text.
                s.lastError = String(e.message.prefix(200))
            case .notForConsumer(let type), .unknown(let type): s.skipped[type, default: 0] &+= 1
            }
        }
        onMessage(message)
    }

    private static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = write(fd, raw.baseAddress! + offset, raw.count - offset)
                if written < 0, errno == EINTR { continue }
                if written <= 0 { return false }
                offset += written
            }
            return true
        }
    }
}
