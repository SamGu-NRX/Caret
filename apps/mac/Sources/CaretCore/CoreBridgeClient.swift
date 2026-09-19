import Foundation
import os

/// The app's side of the JSON-lines bridge.
///
/// One request carries an `id` and gets exactly one reply with that `id`;
/// evaluation results arrive separately as unsolicited event lines with no
/// `id`, because a provider call must not block input handling. Those two
/// paths are why this is a correlating client rather than a call-and-read
/// wrapper: a reply and an event can interleave on the same pipe at any time.
///
/// Thread safety: all mutable state sits behind one lock. Transport callbacks
/// arrive on the reader's thread; waiters are resumed outside the lock.
public final class CoreBridgeClient: @unchecked Sendable {
    public enum State: Equatable, Sendable {
        case idle
        case running
        case stopped(CoreTerminationReason)
    }

    private let transport: CoreTransport
    private let log = Logger(subsystem: "com.caret.app", category: "core-bridge")
    private let lock = NSLock()

    private var nextID = 1
    private var pending: [Int: (Result<Data, Error>) -> Void] = [:]
    private var state: State = .idle
    private var eventSink: ((CoreEvent) -> Void)?

    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return encoder
    }()
    private let decoder = JSONDecoder()

    public init(transport: CoreTransport) {
        self.transport = transport
    }

    public convenience init(configuration: CoreLaunchConfiguration) {
        self.init(transport: CoreProcessTransport(configuration: configuration))
    }

    public var currentState: State {
        lock.lock(); defer { lock.unlock() }
        return state
    }

    /// Unsolicited events. Installed before `start()` so no event is missed
    /// between launch and the first `hello`.
    public func onEvent(_ handler: @escaping (CoreEvent) -> Void) {
        lock.lock()
        eventSink = handler
        lock.unlock()
    }

    public func start() throws {
        lock.lock()
        guard state == .idle else {
            let running = state == .running
            lock.unlock()
            throw running ? BridgeError.alreadyRunning : BridgeError.notRunning
        }
        state = .running
        lock.unlock()

        do {
            try transport.start(
                onLine: { [weak self] line in self?.handle(line: line) },
                onTermination: { [weak self] reason in self?.handleTermination(reason) }
            )
        } catch {
            lock.lock()
            state = .stopped(.failed(String(describing: error)))
            lock.unlock()
            throw error
        }
    }

    /// Asks the core to stop, then tears the transport down. Safe to call twice
    /// and safe to call when the core already exited.
    public func shutdown() async {
        if currentState == .running {
            _ = try? await send(method: "shutdown", params: EmptyParams(), as: StoppedResult.self)
        }
        transport.stop()
        handleTermination(.stoppedByClient)
    }

    // MARK: - Methods

    public func hello() async throws -> HelloResult {
        try await send(method: "hello", params: EmptyParams(), as: HelloResult.self)
    }

    public func updateContext(_ frame: ContextFrame) async throws -> ContextUpdateResult {
        try await send(method: "context.update", params: FrameParams(frame: frame), as: ContextUpdateResult.self)
    }

    /// The core rechecks `target` and `revision` and refuses a stale, duplicate
    /// or expired acceptance, so a second keypress cannot execute twice.
    public func accept(proposalID: String, revision: Int, target: TargetIdentity) async throws -> AcceptResult {
        try await send(
            method: "offer.accept",
            params: AcceptParams(proposalID: proposalID, revision: revision, target: target),
            as: AcceptResult.self
        )
    }

    @discardableResult
    public func dismiss(proposalID: String) async throws -> Bool {
        try await send(method: "offer.dismiss", params: DismissParams(proposalID: proposalID), as: DismissResult.self)
            .dismissed
    }

    public func listWorkflows() async throws -> [WorkflowSummary] {
        try await send(method: "workflows.list", params: EmptyParams(), as: WorkflowList.self).workflows
    }

    // MARK: - Request plumbing

    private struct EmptyParams: Encodable {}
    private struct FrameParams: Encodable { let frame: ContextFrame }
    private struct StoppedResult: Decodable { let stopped: Bool }
    private struct WorkflowList: Decodable { let workflows: [WorkflowSummary] }
    private struct DismissParams: Encodable {
        let proposalID: String
        enum CodingKeys: String, CodingKey { case proposalID = "proposal_id" }
    }
    private struct AcceptParams: Encodable {
        let proposalID: String
        let revision: Int
        let target: TargetIdentity
        enum CodingKeys: String, CodingKey {
            case proposalID = "proposal_id"
            case revision, target
        }
    }
    private struct Envelope<P: Encodable>: Encodable {
        let id: Int
        let method: String
        let params: P
    }

    /// Reserves a request id, refusing when the core is not running. Kept
    /// synchronous so the lock is never held across a suspension point.
    private func reserveID() throws -> Int {
        lock.lock()
        defer { lock.unlock() }
        guard state == .running else {
            if case .stopped(let reason) = state, case .exited(let status) = reason {
                throw BridgeError.processExited(status: status, reason: "core already exited")
            }
            if case .stopped(.failed(let detail)) = state {
                throw BridgeError.processExited(status: -1, reason: detail)
            }
            throw BridgeError.notRunning
        }
        let id = nextID
        nextID += 1
        return id
    }

    private func register(id: Int, resume: @escaping (Result<Data, Error>) -> Void) {
        lock.lock()
        pending[id] = resume
        lock.unlock()
    }

    func send<P: Encodable, R: Decodable>(method: String, params: P, as: R.Type) async throws -> R {
        let id = try reserveID()

        let line = String(
            data: try encoder.encode(Envelope(id: id, method: method, params: params)),
            encoding: .utf8
        )
        guard let line else { throw BridgeError.malformedReply("request was not encodable as UTF-8") }

        let data: Data = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                register(id: id) { continuation.resume(with: $0) }
                do {
                    try transport.send(line: line)
                } catch {
                    if let resume = take(id: id) { resume(.failure(error)) }
                }
            }
        } onCancel: {
            // The core has no cancel verb: a reply may still arrive and is
            // dropped by the id lookup below.
            if let resume = take(id: id) { resume(.failure(BridgeError.cancelled)) }
        }

        do {
            let reply = try decoder.decode(Reply<R>.self, from: data)
            if let result = reply.result, reply.ok { return result }
            if let error = reply.error { throw BridgeError.core(code: error.code, message: error.message) }
            throw BridgeError.malformedReply("reply for '\(method)' carried neither result nor error")
        } catch let error as BridgeError {
            throw error
        } catch {
            throw BridgeError.malformedReply("could not decode the reply to '\(method)': \(error)")
        }
    }

    private struct Reply<R: Decodable>: Decodable {
        let id: Int?
        let ok: Bool
        let result: R?
        let error: CoreErrorPayload?
    }

    private func take(id: Int) -> ((Result<Data, Error>) -> Void)? {
        lock.lock(); defer { lock.unlock() }
        return pending.removeValue(forKey: id)
    }

    // MARK: - Line handling

    private struct LineHeader: Decodable {
        let id: Int?
        let event: String?
    }

    private func handle(line: String) {
        guard let data = line.data(using: .utf8) else {
            log.error("core sent a line that is not UTF-8")
            return
        }
        guard let header = try? decoder.decode(LineHeader.self, from: data) else {
            // Includes an id-less error line such as `invalid_json`, which has
            // no waiter to fail; surface it rather than swallowing it.
            log.error("core sent a line with neither 'id' nor 'event'")
            return
        }
        if let id = header.id {
            if let resume = take(id: id) {
                resume(.success(data))
            } else {
                log.error("core replied to an unknown or cancelled request id")
            }
            return
        }
        guard let name = header.event else {
            if let payload = try? decoder.decode(Reply<Empty>.self, from: data), let error = payload.error {
                log.error("core reported \(error.code, privacy: .public) with no request id")
            }
            return
        }
        deliver(event: decodeEvent(named: name, from: data))
    }

    private struct Empty: Decodable {}

    private struct EventLine: Decodable {
        let offer: Offer?
        let revision: Int?
        let reason: String?
        let proposalID: String?
        enum CodingKeys: String, CodingKey {
            case offer, revision, reason
            case proposalID = "proposal_id"
        }
    }

    private func decodeEvent(named name: String, from data: Data) -> CoreEvent {
        let line = try? decoder.decode(EventLine.self, from: data)
        let reason = line?.reason ?? ""
        let revision = line?.revision ?? -1
        switch name {
        case "offer":
            if let offer = line?.offer { return .offer(offer) }
            return .unknown(name: "offer(undecodable)")
        case "abstain": return .abstain(revision: revision, reason: reason)
        case "invalidated": return .invalidated(proposalID: line?.proposalID ?? "", reason: reason)
        case "discarded": return .discarded(revision: revision, reason: reason)
        case "failed": return .failed(revision: revision, reason: reason)
        default: return .unknown(name: name)
        }
    }

    private func deliver(event: CoreEvent) {
        lock.lock()
        let sink = eventSink
        lock.unlock()
        sink?(event)
    }

    private func handleTermination(_ reason: CoreTerminationReason) {
        lock.lock()
        if case .stopped = state {
            lock.unlock()
            return
        }
        state = .stopped(reason)
        let waiters = pending
        pending.removeAll()
        lock.unlock()

        let failure: BridgeError
        switch reason {
        case .exited(let status): failure = .processExited(status: status, reason: "core stdout reached EOF")
        case .stoppedByClient: failure = .notRunning
        case .failed(let detail): failure = .processExited(status: -1, reason: detail)
        }
        // Every in-flight request fails explicitly; none is left hanging.
        for (_, resume) in waiters { resume(.failure(failure)) }
        log.info("core bridge stopped")
    }
}
