import Darwin
import Foundation
import Security
import Testing
@testable import CaretBridgeXPC
@testable import CaretPageProtocol

// W3: the bridge's XPC trust, in one process over an anonymous listener. The same requirement checks and relay run
// here as between a real bridge and host; what one process cannot show (a bridge signed by another team, an ad hoc
// one, a real browser parent) the acceptance run shows with signed binaries (fixtures/web-form/accept.ts).

/// This test process's own designated requirement: a requirement both ends here satisfy.
private func ownRequirement() throws -> String {
    var me: SecCode?
    #expect(SecCodeCopySelf([], &me) == errSecSuccess)
    var stat: SecStaticCode?
    #expect(SecCodeCopyStaticCode(me!, [], &stat) == errSecSuccess)
    var req: SecRequirement?
    #expect(SecCodeCopyDesignatedRequirement(stat!, [], &req) == errSecSuccess)
    var text: CFString?
    #expect(SecRequirementCopyString(req!, [], &text) == errSecSuccess)
    return text! as String
}

private let X = "kcmlnoabcdefghijklmnopabcdefghij"
private let launch = Data(repeating: 0x5A, count: 32)

/// A helper's page.sock: challenges, checks the page key's proof, welcomes with its pid, then records what arrives
/// and sends what the test queues.
private final class FakeHelper: @unchecked Sendable {
    let dir: String
    let path: String
    private let listenFd: Int32
    private let lock = NSLock()
    private var got: [Data] = []
    private var client: LineSocket?
    private(set) var connections = 0

    init(key: Data) throws {
        dir = NSTemporaryDirectory() + "cw3-\(UUID().uuidString.prefix(8))"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        path = dir + "/page.sock"
        listenFd = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in path.utf8.enumerated() { raw[i] = b }
        }
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listenFd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        precondition(bound == 0 && listen(listenFd, 4) == 0)
        let fd = listenFd
        Thread { [weak self] in
            while true {
                let c = accept(fd, nil, nil)
                if c < 0 { return }
                self?.serve(LineSocket(fd: c), key: key)
            }
        }.start()
    }

    private func serve(_ s: LineSocket, key: Data) {
        lock.withLock { connections += 1 }
        let challenge = Handshake.nonce()
        _ = s.write(line: Data(#"{"type":"engineChallenge","v":1,"nonce":"\#(challenge)"}"#.utf8))
        guard let line = s.next(timeout: 5), case let .engineHello(h)? = try? JSONDecoder().decode(PageMessage.self, from: line),
              Handshake.matches(Handshake.bridgeProof(secret: key, challenge: challenge, nonce: h.nonce, helperPid: Int(getpid())), h.proof) else { s.closeDescriptor(); return }
        let pid = Int(getpid())
        _ = s.write(line: Data(#"{"type":"engineWelcome","v":1,"engine":"eng-test","pid":\#(pid),"proof":"\#(Handshake.helperProof(secret: key, challenge: challenge, nonce: h.nonce, pid: pid))"}"#.utf8))
        lock.withLock { client = s; got.append(line) }
        while let l = s.next() { lock.withLock { got.append(l) } }
        s.closeDescriptor()
    }

    var received: [String] { lock.withLock { got.map { String(decoding: $0, as: UTF8.self) } } }
    func send(_ s: String) { _ = lock.withLock { client }?.write(line: Data(s.utf8)) }

    func stop() {
        close(listenFd)
        lock.withLock { client }?.shutdown()
        try? FileManager.default.removeItem(atPath: dir)
    }
}

private final class Lines: @unchecked Sendable {
    private let lock = NSLock()
    private var all: [String] = []
    private var why: String?
    func add(_ d: Data) { lock.withLock { all.append(String(decoding: d, as: UTF8.self)) } }
    func close(_ s: String) { lock.withLock { why = why ?? s } }
    var lines: [String] { lock.withLock { all } }
    var closedWhy: String? { lock.withLock { why } }
}

private func waitUntil(_ cond: () -> Bool, seconds: Double = 5) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
        if cond() { return true }
        usleep(20_000)
    }
    return cond()
}

@Suite(.serialized) struct BridgeXPCTrust {
    private func host(_ helper: FakeHelper, bridgeRequirement: String, parent: @escaping @Sendable (pid_t) -> Result<BrowserRef, BridgeRefusal> = { _ in .success(BrowserRef(pid: 4100, bundleId: "com.google.chrome.for.testing", name: "Google Chrome for Testing")) }) -> (BridgeListener, Lines) {
        let logs = Lines()
        let config = HostRelayConfig(socketPath: helper.path, pageKey: Handshake.pageKey(launchSecret: launch), bridgeRequirement: bridgeRequirement, launchingBrowser: parent, handshakeSeconds: 2)
        let l = BridgeListener(listener: NSXPCListener.anonymous(), config: config, log: { logs.add(Data($0.utf8)) })
        l.resume()
        return (l, logs)
    }

    @Test func opensAnEngineAndRelaysEachDirectionsOwnTypesWhenBothRequirementsHold() throws {
        let me = try ownRequirement()
        let helper = try FakeHelper(key: Handshake.pageKey(launchSecret: launch)); defer { helper.stop() }
        let (listener, _) = host(helper, bridgeRequirement: me); defer { listener.invalidate() }
        let got = Lines()
        let link = XPCHostLink(endpoint: listener.endpoint, hostRequirement: me, onLine: got.add, onClose: got.close); defer { link.close() }
        #expect(link.open(extensionId: X, bridgeVersion: "t", timeout: 5) == .success("eng-test"))
        // The hello the host sent names the browser the host found, not one the bridge claimed, and proves the page key.
        #expect(helper.received.first?.contains("\"bundleId\":\"com.google.chrome.for.testing\"") == true)
        link.send(Data(#"{"type":"pageHello","v":1}"#.utf8))
        link.send(Data(#"{"type":"scopedActGrant","v":1}"#.utf8))
        #expect(waitUntil { helper.received.count == 2 })
        #expect(helper.received.last == #"{"type":"pageHello","v":1}"#)
        helper.send(#"{"type":"pageResult","v":1}"#)
        helper.send(#"{"type":"actRevoke","v":1,"taskId":"t","at":1}"#)
        #expect(waitUntil { got.lines.count == 1 })
        usleep(200_000)
        #expect(got.lines == [#"{"type":"actRevoke","v":1,"taskId":"t","at":1}"#])
        #expect(helper.received.count == 2)
    }

    @Test func refusesABridgeWhoseCodeFailsTheBridgeRequirementBeforeItReachesTheHelper() throws {
        let me = try ownRequirement()
        let helper = try FakeHelper(key: Handshake.pageKey(launchSecret: launch)); defer { helper.stop() }
        // The test process is not the Caret team's dev.caret.bridge.
        let (listener, logs) = host(helper, bridgeRequirement: BridgeTrust.bridgeRequirement); defer { listener.invalidate() }
        let got = Lines()
        let link = XPCHostLink(endpoint: listener.endpoint, hostRequirement: me, onLine: got.add, onClose: got.close); defer { link.close() }
        let r = link.open(extensionId: X, bridgeVersion: "t", timeout: 5)
        guard case let .failure(why) = r else { Issue.record("opened: \(r)"); return }
        #expect(!why.description.contains("refused:"), "\(why)")
        #expect(helper.connections == 0)
        #expect(waitUntil { logs.lines.contains { $0.contains("ended before it opened an engine") } })
    }

    @Test func refusesAHostWhoseCodeFailsTheHostRequirement() throws {
        let me = try ownRequirement()
        let helper = try FakeHelper(key: Handshake.pageKey(launchSecret: launch)); defer { helper.stop() }
        let (listener, _) = host(helper, bridgeRequirement: me); defer { listener.invalidate() }
        let got = Lines()
        // The test process is not the Caret team's dev.caret.host.
        let link = XPCHostLink(endpoint: listener.endpoint, hostRequirement: BridgeTrust.hostRequirement, onLine: got.add, onClose: got.close); defer { link.close() }
        let r = link.open(extensionId: X, bridgeVersion: "t", timeout: 5)
        guard case let .failure(why) = r else { Issue.record("opened: \(r)"); return }
        #expect(why == .xpc("the service is not the Caret host: its code signature fails the host requirement"), "\(why)")
        // The requirement guards what the bridge receives: the wrong host's reply never arrives. The bridge's own first
        // call (open: an extension id and a version) does reach it, so the link sends nothing more until that reply is
        // verified. This host relays with the right key, so its open reached the helper; an impostor has no key.
        let opened = helper.received.count
        link.send(Data(#"{"type":"pageHello","v":1}"#.utf8))
        helper.send(#"{"type":"actRevoke","v":1,"taskId":"t","at":1}"#)
        usleep(300_000)
        #expect(got.lines.isEmpty)
        #expect(helper.received.count == opened)
    }

    @Test func refusesABridgeWhoseParentIsNotABrowserItKnowsAndNeverReachesTheHelper() throws {
        let me = try ownRequirement()
        let helper = try FakeHelper(key: Handshake.pageKey(launchSecret: launch)); defer { helper.stop() }
        let (listener, logs) = host(helper, bridgeRequirement: me, parent: { ProcessTrust.launchingBrowser(of: $0, requirements: BridgeTrust.browserRequirements) }); defer { listener.invalidate() }
        let got = Lines()
        let link = XPCHostLink(endpoint: listener.endpoint, hostRequirement: me, onLine: got.add, onClose: got.close); defer { link.close() }
        let r = link.open(extensionId: X, bridgeVersion: "t", timeout: 5)
        guard case let .failure(.host(why)) = r else { Issue.record("expected the host's refusal: \(r)"); return }
        #expect(why.contains("not a browser Caret knows"), "\(why)")
        #expect(helper.connections == 0)
        #expect(logs.lines.contains { $0.contains("refused the bridge") })
    }

    @Test func refusesAHostWithTheWrongPageKeyAndABadExtensionId() throws {
        let me = try ownRequirement()
        let helper = try FakeHelper(key: Handshake.pageKey(launchSecret: Data(repeating: 1, count: 32))); defer { helper.stop() }
        let (listener, _) = host(helper, bridgeRequirement: me); defer { listener.invalidate() }
        let link = XPCHostLink(endpoint: listener.endpoint, hostRequirement: me, onLine: { _ in }, onClose: { _ in }); defer { link.close() }
        guard case let .failure(.host(why)) = link.open(extensionId: X, bridgeVersion: "t", timeout: 5) else { Issue.record("opened with the wrong key"); return }
        #expect(why.contains("did not welcome"), "\(why)")
        let other = XPCHostLink(endpoint: listener.endpoint, hostRequirement: me, onLine: { _ in }, onClose: { _ in }); defer { other.close() }
        guard case let .failure(.host(bad)) = other.open(extensionId: "not-an-id", bridgeVersion: "t", timeout: 5) else { Issue.record("opened for a bad id"); return }
        #expect(bad.contains("not an extension id"))
    }
}

@Suite struct ProcessTrustChecks {
    @Test func checksARunningProcessAgainstARequirement() {
        // launchd is Apple's code and not the Caret team's.
        #expect(ProcessTrust.satisfies(pid: 1, requirement: "anchor apple"))
        #expect(!ProcessTrust.satisfies(pid: 1, requirement: BridgeTrust.bridgeRequirement))
        #expect(!ProcessTrust.satisfies(pid: 1, requirement: "not a requirement ("))
        #expect(ProcessTrust.parent(of: getpid()) == getppid())
        #expect(ProcessTrust.parses(BridgeTrust.bridgeRequirement) && ProcessTrust.parses(BridgeTrust.hostRequirement))
        #expect(BridgeTrust.browserRequirements.allSatisfy(ProcessTrust.parses))
        #expect(BridgeTrust.bridgeRequirement == #"anchor apple generic and identifier "dev.caret.bridge" and certificate leaf[subject.OU] = "DWGXWVUR2B""#)
    }
}

// W3 review: lifetimes and deadlines.

/// A page.sock that sends its challenge one byte every 200 ms and never ends the line.
private final class Trickler: @unchecked Sendable {
    let dir: String
    let path: String
    private let listenFd: Int32
    init() throws {
        dir = NSTemporaryDirectory() + "cw3t-\(UUID().uuidString.prefix(8))"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        path = dir + "/page.sock"
        listenFd = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in path.utf8.enumerated() { raw[i] = b }
        }
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listenFd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        precondition(bound == 0 && listen(listenFd, 4) == 0)
        let fd = listenFd
        Thread {
            let c = accept(fd, nil, nil)
            if c < 0 { return }
            for b in Array(#"{"type":"engineChallenge","v":1,"nonce":"aaaa"#.utf8) {
                var x = b
                if write(c, &x, 1) != 1 { break }
                usleep(200_000)
            }
            close(c)
        }.start()
    }
    func stop() {
        close(listenFd)
        try? FileManager.default.removeItem(atPath: dir)
    }
}

/// A host that replies to open and drops the connection at once.
private final class ReplyThenDrop: NSObject, NSXPCListenerDelegate, CaretBridgeHost, @unchecked Sendable {
    let listener = NSXPCListener.anonymous()
    private var conn: NSXPCConnection?
    override init() {
        super.init()
        listener.delegate = self
        listener.resume()
    }
    func listener(_ l: NSXPCListener, shouldAcceptNewConnection c: NSXPCConnection) -> Bool {
        c.exportedInterface = BridgeInterfaces.host()
        c.exportedObject = self
        c.remoteObjectInterface = BridgeInterfaces.client()
        conn = c
        c.resume()
        return true
    }
    func open(extensionId: String, bridgeVersion: String, reply: @escaping @Sendable (String?, String?) -> Void) {
        reply("eng-dropped", nil)
        conn?.invalidate()
    }
    func send(_ line: Data) {}
}

@Suite(.serialized) struct BridgeLifetimes {
    @Test func writesNothingAfterShutdownAndClosesItsDescriptorOnce() {
        var fds: [Int32] = [0, 0]
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
        defer { close(fds[1]) }
        let a = LineSocket(fd: fds[0])
        #expect(a.write(line: Data("x".utf8)))
        a.shutdown()
        a.shutdown()
        #expect(!a.write(line: Data("y".utf8)))
        #expect(a.next(timeout: 0.2) == nil)
        a.closeDescriptor()
        a.closeDescriptor()
        #expect(!a.write(line: Data("z".utf8)))
    }

    @Test func shutdownEndsAWriteBlockedOnAPeerThatStoppedReading() {
        var fds: [Int32] = [0, 0]
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
        var one: Int32 = 1
        setsockopt(fds[0], SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        defer { close(fds[1]) }
        let a = LineSocket(fd: fds[0])
        let result = Locked<Bool?>(nil)
        // Far past any socket buffer, and the other end never reads: the write blocks.
        let big = Data(repeating: 0x61, count: 16 * 1024 * 1024)
        Thread { result.set(a.write(line: big)) }.start()
        usleep(300_000)
        #expect(result.value == nil, "the write did not block")
        let start = Date()
        a.shutdown()
        #expect(Date().timeIntervalSince(start) < 1, "shutdown waited on the blocked write")
        #expect(waitUntil({ result.value == false }, seconds: 3), "the blocked write did not fail after shutdown")
        a.closeDescriptor()
    }

    @Test func aHelperThatTricklesItsChallengeIsCutOffAtTheDeadline() throws {
        let me = try ownRequirement()
        let t = try Trickler(); defer { t.stop() }
        let config = HostRelayConfig(socketPath: t.path, pageKey: Handshake.pageKey(launchSecret: launch), bridgeRequirement: me,
                                     launchingBrowser: { _ in .success(BrowserRef(pid: 1, bundleId: "b", name: "B")) }, handshakeSeconds: 1)
        let listener = BridgeListener(listener: NSXPCListener.anonymous(), config: config, log: { _ in }); listener.resume(); defer { listener.invalidate() }
        let link = XPCHostLink(endpoint: listener.endpoint, hostRequirement: me, onLine: { _ in }, onClose: { _ in }); defer { link.close() }
        let start = Date()
        let r = link.open(extensionId: X, bridgeVersion: "t", timeout: 8)
        let took = Date().timeIntervalSince(start)
        guard case let .failure(.host(why)) = r else { Issue.record("expected the host's refusal: \(r)"); return }
        #expect(why.contains("sent no challenge"), "\(why)")
        // One second for the whole line, though a byte came every 200 ms.
        #expect(took < 3, "took \(took) s")
    }

    @Test func aCloseRightAfterASuccessfulOpenIsNeverALiveLookingLink() throws {
        let me = try ownRequirement()
        for _ in 0..<5 {
            let host = ReplyThenDrop()
            let closed = Lines()
            let link = XPCHostLink(endpoint: host.listener.endpoint, hostRequirement: me, onLine: { _ in }, onClose: closed.close)
            switch link.open(extensionId: X, bridgeVersion: "t", timeout: 5) {
            case .success:
                // Opened before the drop was seen: the drop must then reach onClose.
                #expect(waitUntil({ closed.closedWhy != nil }, seconds: 2), "opened, and the close never reached onClose")
            case let .failure(why):
                #expect(closed.closedWhy == nil, "a close while opening reached onClose: \(why)")
            }
            link.close()
            host.listener.invalidate()
        }
    }
}
