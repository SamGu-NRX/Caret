import Foundation

/// The bridge's way to the helper, through the Caret host. caret-bridge's main speaks only this, so its framing and
/// relay rules are tested against a fake, and the XPC transport (XPCHostLink) is the one production implementation.
public protocol HostLink: AnyObject, Sendable {
    /// Opens the engine session for `extensionId`; the engine session id, or why the host refused. Blocks up to `timeout`.
    func open(extensionId: String, bridgeVersion: String, timeout: TimeInterval) -> Result<String, BridgeRefusal>
    /// One extension message for the helper.
    func send(_ line: Data)
}

/// The bridge's XPC connection to the host's Mach service, held to the host's code-signing requirement
/// (NSXPCConnection.setCodeSigningRequirement, macOS 13): nothing from a peer that does not satisfy it is delivered,
/// open's reply included. The requirement does not hold back what the bridge sends first, so whatever owns the service
/// name sees open's arguments (the extension id and the bridge's version, nothing secret); caret-bridge sends nothing
/// else until open's reply has arrived, which only a host that satisfies the requirement can deliver. Measured in
/// BridgeXPCTests.refusesAHostWhoseCodeFailsTheHostRequirement.
public final class XPCHostLink: NSObject, HostLink, CaretBridgeClient, @unchecked Sendable {
    private let connection: NSXPCConnection
    private let onLine: @Sendable (Data) -> Void
    private let onClose: @Sendable (String) -> Void
    /// Set only by a verified open reply: until then `send` passes nothing to whatever owns the service name.
    private let isOpen = Locked(false)

    /// `onLine` gets each helper line, in order, on the connection's queue; `onClose` when the session ends.
    public convenience init(service: String, hostRequirement: String, onLine: @escaping @Sendable (Data) -> Void, onClose: @escaping @Sendable (String) -> Void) {
        self.init(connection: NSXPCConnection(machServiceName: service, options: []), hostRequirement: hostRequirement, onLine: onLine, onClose: onClose)
    }

    /// Over a listener endpoint, for in-process tests of the same rules.
    public convenience init(endpoint: NSXPCListenerEndpoint, hostRequirement: String, onLine: @escaping @Sendable (Data) -> Void, onClose: @escaping @Sendable (String) -> Void) {
        self.init(connection: NSXPCConnection(listenerEndpoint: endpoint), hostRequirement: hostRequirement, onLine: onLine, onClose: onClose)
    }

    private init(connection: NSXPCConnection, hostRequirement: String, onLine: @escaping @Sendable (Data) -> Void, onClose: @escaping @Sendable (String) -> Void) {
        self.connection = connection
        self.onLine = onLine
        self.onClose = onClose
        super.init()
        connection.setCodeSigningRequirement(hostRequirement)
        connection.remoteObjectInterface = BridgeInterfaces.host()
        connection.exportedInterface = BridgeInterfaces.client()
        connection.exportedObject = self
        connection.invalidationHandler = { onClose("the connection to the Caret host ended") }
        connection.interruptionHandler = { onClose("the Caret host went away") }
        connection.resume()
    }

    public func open(extensionId: String, bridgeVersion: String, timeout: TimeInterval) -> Result<String, BridgeRefusal> {
        let done = DispatchSemaphore(value: 0)
        let answer = Locked<Result<String, BridgeRefusal>?>(nil)
        let settle: @Sendable (Result<String, BridgeRefusal>) -> Void = { r in
            if answer.setIfNil(r) { done.signal() }
        }
        let proxy = connection.remoteObjectProxyWithErrorHandler { e in
            let ns = e as NSError
            // 4102 is NSXPCConnectionCodeSigningRequirementFailure: the service's code is not the Caret host.
            settle(.failure(.xpc(ns.code == 4102 ? "the service is not the Caret host: its code signature fails the host requirement" : "no Caret host answered: \(ns.localizedDescription) (\(ns.domain) \(ns.code))")))
        } as? CaretBridgeHost
        guard let proxy else { return .failure(.xpc("the host's proxy has the wrong interface")) }
        proxy.open(extensionId: extensionId, bridgeVersion: bridgeVersion) { engine, why in
            settle(engine.map { .success($0) } ?? .failure(.host(why ?? "the host refused without a reason")))
        }
        if done.wait(timeout: .now() + timeout) == .timedOut { return .failure(.timeout("the Caret host did not answer within \(Int(timeout)) s")) }
        let r = answer.value ?? .failure(.timeout("no answer"))
        if case .success = r { isOpen.set(true) }
        return r
    }

    /// Passes a line to the host once open succeeded; before that, or after a refused open, drops it.
    public func send(_ line: Data) {
        guard isOpen.value else { return }
        (connection.remoteObjectProxy as? CaretBridgeHost)?.send(line)
    }

    public func close() { connection.invalidate() }

    // CaretBridgeClient
    public func receive(_ line: Data) { onLine(line) }
    public func closed(_ why: String) { onClose(why) }
}

/// A value behind a lock.
final class Locked<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T
    init(_ v: T) { self.v = v }
    var value: T { lock.withLock { v } }
    func set(_ new: T) { lock.withLock { v = new } }
    /// Sets the value when it is nil (for an optional T); true when this call set it.
    func setIfNil<U>(_ new: U) -> Bool where T == U? {
        lock.withLock {
            if v != nil { return false }
            v = new
            return true
        }
    }
}
