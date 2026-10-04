import CaretPageProtocol
import Darwin
import Foundation

/// What the host's relay needs: where the helper's page.sock is, the launch's page key, and whom to accept.
public struct HostRelayConfig: Sendable {
    public var socketPath: String
    /// Handshake.pageKey(launchSecret:), from the launch secret the host holds in memory. Never written to a file.
    public var pageKey: Data
    /// What every bridge's code must satisfy. BridgeTrust.bridgeRequirement in Caret.app.
    public var bridgeRequirement: String
    /// The browser that launched the bridge with this pid, or why it is refused (ProcessTrust.launchingBrowser).
    public var launchingBrowser: @Sendable (pid_t) -> Result<BrowserRef, BridgeRefusal>
    /// Time the helper has to challenge and then welcome. Assumed: both come from memory within milliseconds.
    public var handshakeSeconds: Int32

    public init(socketPath: String, pageKey: Data, bridgeRequirement: String = BridgeTrust.bridgeRequirement,
                launchingBrowser: @escaping @Sendable (pid_t) -> Result<BrowserRef, BridgeRefusal> = { ProcessTrust.launchingBrowser(of: $0, requirements: BridgeTrust.browserRequirements) },
                handshakeSeconds: Int32 = 5) {
        self.socketPath = socketPath
        self.pageKey = pageKey
        self.bridgeRequirement = bridgeRequirement
        self.launchingBrowser = launchingBrowser
        self.handshakeSeconds = handshakeSeconds
    }
}

/// The host's side of the bridge service. Every connection is held to the bridge requirement before any message
/// reaches its session; each session relays one bridge to one page.sock connection.
public final class BridgeListener: NSObject, NSXPCListenerDelegate, @unchecked Sendable {
    private let listener: NSXPCListener
    private let config: HostRelayConfig
    private let log: @Sendable (String) -> Void

    /// `listener`: NSXPCListener(machServiceName:) in the host, NSXPCListener.anonymous() in an in-process test.
    public init(listener: NSXPCListener, config: HostRelayConfig, log: @escaping @Sendable (String) -> Void) {
        self.listener = listener
        self.config = config
        self.log = log
        super.init()
        listener.delegate = self
    }

    public func resume() { listener.resume() }
    public func invalidate() { listener.invalidate() }
    public var endpoint: NSXPCListenerEndpoint { listener.endpoint }

    public func listener(_ listener: NSXPCListener, shouldAcceptNewConnection c: NSXPCConnection) -> Bool {
        // Checked by the system on every message: code that is not the bridge never reaches the session below.
        c.setCodeSigningRequirement(config.bridgeRequirement)
        let session = RelaySession(connection: c, config: config, log: log)
        c.exportedInterface = BridgeInterfaces.host()
        c.exportedObject = session
        c.remoteObjectInterface = BridgeInterfaces.client()
        c.invalidationHandler = { session.end("the bridge's connection ended") }
        c.interruptionHandler = { session.end("the bridge's connection was interrupted") }
        c.resume()
        return true
    }
}

/// One bridge's session: open checks the bridge's parent and does the helper's handshake for it; then lines flow
/// both ways, each direction limited to its own message types.
final class RelaySession: NSObject, CaretBridgeHost, @unchecked Sendable {
    private weak var connection: NSXPCConnection?
    private let pid: pid_t
    private let config: HostRelayConfig
    private let log: @Sendable (String) -> Void
    private let lock = NSLock()
    private var opened = false
    private var ended = false
    private var helper: LineSocket?

    init(connection: NSXPCConnection, config: HostRelayConfig, log: @escaping @Sendable (String) -> Void) {
        self.connection = connection
        self.pid = connection.processIdentifier
        self.config = config
        self.log = log
    }

    func open(extensionId: String, bridgeVersion: String, reply: @escaping @Sendable (String?, String?) -> Void) {
        let first = lock.withLock { () -> Bool in
            if opened || ended { return false }
            opened = true
            return true
        }
        guard first else { return reply(nil, "this connection already opened an engine, or ended") }
        let refuse = { (why: String) in
            self.log("refused the bridge, process \(self.pid): \(why)")
            reply(nil, why)
        }
        guard Relay.isExtensionId(extensionId) else { return refuse("'\(extensionId.prefix(40))' is not an extension id") }
        let browser: BrowserRef
        switch config.launchingBrowser(pid) {
        case let .failure(why): return refuse(why.description)
        case let .success(b): browser = b
        }
        let sock: LineSocket
        let engine: String
        switch handshake(browser: browser, extensionId: extensionId, bridgeVersion: bridgeVersion) {
        case let .failure(why): return refuse(why.description)
        case let .success((s, e)): (sock, engine) = (s, e)
        }
        let live = lock.withLock { () -> Bool in
            if ended { return false }
            helper = sock
            return true
        }
        guard live else {
            sock.close()
            Darwin.close(sock.fd)
            return refuse("the bridge left during the handshake")
        }
        log("engine \(engine) open for bridge process \(pid), \(browser.name) (\(browser.pid)), extension \(extensionId)")
        reply(engine, nil)
        let reader = Thread { [weak self] in self?.readLoop(sock) }
        reader.name = "caret-bridge-relay-\(pid)"
        reader.start()
    }

    func send(_ line: Data) {
        guard let h = lock.withLock({ helper }) else { return log("dropped a bridge line before its engine opened") }
        switch Relay.admit(line, .toHelper) {
        case let .failure(why): log("dropped a bridge line: \(why)")
        case .success: if !h.write(line: line) { end("the helper's socket closed") }
        }
    }

    /// Ends the session once: page.sock closes, so the helper ends the engine and the worker its grants.
    func end(_ why: String) {
        let (h, wasOpen, first) = lock.withLock { () -> (LineSocket?, Bool, Bool) in
            let first = !ended
            ended = true
            let h = helper
            helper = nil
            return (h, opened, first)
        }
        guard first else { return }
        h?.close()
        // A connection whose code fails the bridge requirement is invalidated before it can call open, so it ends here.
        log(wasOpen ? "bridge process \(pid): \(why)" : "a connection from process \(pid) ended before it opened an engine: \(why)")
    }

    private func readLoop(_ sock: LineSocket) {
        while let line = sock.next() {
            switch Relay.admit(line, .toExtension) {
            case let .failure(why): log("dropped a helper line: \(why)")
            case .success: (connection?.remoteObjectProxy as? CaretBridgeClient)?.receive(line)
            }
        }
        (connection?.remoteObjectProxy as? CaretBridgeClient)?.closed("the helper closed page.sock")
        end("the helper closed page.sock")
        // Only this thread reads the descriptor, so only it closes it, once the read has ended (end() shut it down).
        Darwin.close(sock.fd)
        connection?.invalidate()
    }

    /// Connects to page.sock as this launch's engine and completes the helper's handshake: the helper must be this
    /// user's (Peer.connect), prove the page key, and name its own pid, which must be the socket's peer.
    private func handshake(browser: BrowserRef, extensionId: String, bridgeVersion: String) -> Result<(LineSocket, String), BridgeRefusal> {
        let fd: Int32
        let peerPid: pid_t
        do {
            fd = try Peer.connect(path: config.socketPath)
            peerPid = try Peer.pid(of: fd)
        } catch {
            return .failure(.helper("cannot reach the helper: \(error)"))
        }
        let sock = LineSocket(fd: fd)
        let fail = { (why: String) -> Result<(LineSocket, String), BridgeRefusal> in
            sock.close()
            Darwin.close(fd)
            return .failure(.helper(why))
        }
        let decoder = JSONDecoder()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let challengeLine = sock.next(timeout: config.handshakeSeconds),
              case let .engineChallenge(challenge)? = try? decoder.decode(PageMessage.self, from: challengeLine) else { return fail("the helper sent no challenge") }
        let nonce = Handshake.nonce()
        let hello = EngineHello(browser: browser, extensionId: extensionId, bridgeVersion: bridgeVersion, nonce: nonce,
                                proof: Handshake.bridgeProof(secret: config.pageKey, challenge: challenge.nonce, nonce: nonce))
        guard let helloLine = try? encoder.encode(hello), sock.write(line: helloLine) else { return fail("cannot send the hello") }
        guard let welcomeLine = sock.next(timeout: config.handshakeSeconds),
              case let .engineWelcome(welcome)? = try? decoder.decode(PageMessage.self, from: welcomeLine) else { return fail("the helper did not welcome this engine (wrong page key?)") }
        guard welcome.pid == Int(peerPid) else { return fail("the helper's proof names process \(welcome.pid), but the socket's peer is \(peerPid)") }
        guard Handshake.matches(Handshake.helperProof(secret: config.pageKey, challenge: challenge.nonce, nonce: nonce, pid: welcome.pid), welcome.proof) else {
            return fail("the listener on \(config.socketPath) could not prove it holds this launch's page key")
        }
        return .success((sock, welcome.engine))
    }
}
