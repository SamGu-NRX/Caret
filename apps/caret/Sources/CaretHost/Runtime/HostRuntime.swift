import AppCompatibility
import CaretHostCore
import Foundation

/// Builds and owns the host's parts and wires them together. The app shell creates one, calls
/// `start`, and awaits `shutdown` before exit.
@MainActor
public final class HostRuntime {
    public struct Configuration {
        public var socketPath: String
        public var modelURL: URL
        /// When set, offers are made only in these apps. For test runs on a shared Mac, so the host
        /// never draws over or takes Tab from windows it did not create. Nil means every app.
        public var allowedBundleIDs: Set<String>?

        public init(
            socketPath: String = HostRuntime.defaultSocketPath,
            modelURL: URL = EngineLoader.defaultModelURL,
            allowedBundleIDs: Set<String>? = HostRuntime.allowedBundleIDsFromEnvironment
        ) {
            self.socketPath = socketPath
            self.modelURL = modelURL
            self.allowedBundleIDs = allowedBundleIDs
        }
    }

    public nonisolated static var defaultSocketPath: String {
        if let override = ProcessInfo.processInfo.environment["CARET_HOST_SOCKET"], !override.isEmpty {
            return override
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".caret-run/sockets/host.sock").path
    }

    /// `CARET_ALLOW_BUNDLES`, comma-separated bundle identifiers.
    public nonisolated static var allowedBundleIDsFromEnvironment: Set<String>? {
        guard let raw = ProcessInfo.processInfo.environment["CARET_ALLOW_BUNDLES"], !raw.isEmpty else { return nil }
        return Set(raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
    }

    private let configuration: Configuration
    private let arbiter = OfferArbiter()
    private let status = HostStatus()
    private let compatibilityStore = AppCompatibilityStore()
    private let engine: GhostTextEngine
    private let overlay: GhostOverlay
    private let focus = FocusObserver()
    private let coordinator: HostCoordinator
    private let executor: InsertionExecutor
    private let tap: TapThread
    private let socket: DebugStateSocket
    private var engineTask: Task<Void, Never>?

    public init(configuration: Configuration = Configuration()) {
        self.configuration = configuration
        let arbiter = self.arbiter
        let status = self.status
        engine = GhostTextEngine(compatibilityStore: compatibilityStore)
        overlay = GhostOverlay(compatibilityStore: compatibilityStore)
        let coordinator = HostCoordinator(
            arbiter: arbiter, status: status, engine: engine, overlay: overlay,
            allowedBundleIDs: configuration.allowedBundleIDs
        )
        self.coordinator = coordinator
        let executor = InsertionExecutor(arbiter: arbiter, status: status, compatibilityStore: compatibilityStore) { result in
            DispatchQueue.main.async { MainActor.assumeIsolated { coordinator.insertionFinished(result) } }
        }
        self.executor = executor
        coordinator.executor = executor
        tap = TapThread(arbiter: arbiter, callbacks: TapThread.Callbacks(
            claimed: { claim in
                executor.submit(claim)
                DispatchQueue.main.async { MainActor.assumeIsolated { coordinator.claimed(claim) } }
            },
            offerChanged: { reason, key in
                DispatchQueue.main.async { MainActor.assumeIsolated { coordinator.offerChanged(reason, key: key) } }
            },
            keyDown: { status.noteKeyDown($0) }
        ))
        let tap = self.tap
        socket = DebugStateSocket(path: configuration.socketPath) { command in
            Self.respond(to: command, arbiter: arbiter, status: status, tap: tap)
        }
    }

    /// Throws when another host already serves the socket; the caller should exit rather than run
    /// a second key tap.
    public func start() throws {
        try socket.start()
        AXRead.setGlobalMessagingTimeout(seconds: 0.25)
        if !tap.start() { status.increment("tap.createFailed") }
        focus.onChange = { [coordinator] change in coordinator.handle(change) }
        focus.start()
        status.update { $0.engine = DebugState.Engine(state: "loading", modelFile: self.configuration.modelURL.lastPathComponent) }
        let modelURL = configuration.modelURL
        engineTask = Task { [weak self] in
            guard let self else { return }
            await self.engine.load(modelURL: modelURL)
            self.publishEngineState()
            self.focus.requestRead()
        }
    }

    /// Stops input first, then joins model work and frees llama/Metal resources. Must finish
    /// before the process exits (ggml-metal aborts otherwise; KeyType ADR-021/132).
    public func shutdown() async {
        tap.stop()
        focus.stop()
        overlay.hide()
        arbiter.invalidate()
        // A paste in progress must finish and put the user's clipboard back before exit.
        await executor.waitUntilIdle()
        await engineTask?.value
        // No generation may still be inside llama when its resources are freed.
        await coordinator.drain()
        await engine.shutdown()
        socket.stop()
    }

    public var engineSummary: String {
        switch engine.state {
        case .loading: return "Loading model"
        case .ready: return "Ready"
        case .unavailable(let reason): return "Unavailable: \(reason)"
        }
    }

    private func publishEngineState() {
        let state: DebugState.Engine
        switch engine.state {
        case .loading: state = .init(state: "loading", modelFile: configuration.modelURL.lastPathComponent)
        case .ready: state = .init(state: "ready", modelFile: configuration.modelURL.lastPathComponent)
        case .unavailable(let reason): state = .init(state: "unavailable", detail: reason, modelFile: configuration.modelURL.lastPathComponent)
        }
        status.update { $0.engine = state }
    }

    // MARK: - Debug socket (socket thread)

    private nonisolated static func respond(to command: String, arbiter: OfferArbiter, status: HostStatus, tap: TapThread) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        switch command {
        case "ping":
            return Data("{\"ok\":true}\n".utf8)
        case "latency-reset":
            status.latency.reset()
            return Data("{\"ok\":true}\n".utf8)
        case "state":
            let state = makeState(arbiter: arbiter, status: status, tap: tap)
            return ((try? encoder.encode(state)) ?? Data("{}".utf8)) + Data("\n".utf8)
        default:
            return Data("{\"error\":\"unknown command\"}\n".utf8)
        }
    }

    private nonisolated static func makeState(arbiter: OfferArbiter, status: HostStatus, tap: TapThread) -> DebugState {
        let fields = status.read()
        let arbiterState = arbiter.snapshot()
        let tapState = tap.debugState()
        let offer = arbiterState.current.map { offer in
            DebugState.OfferInfo(
                id: offer.id,
                text: String(offer.text.dropFirst(arbiterState.typedSinceOffer.count)),
                typedSinceOffer: arbiterState.typedSinceOffer,
                ageMs: Date().timeIntervalSince(offer.createdAt) * 1_000,
                pid: offer.target.pid,
                bundleID: offer.target.bundleID,
                caretUTF16: offer.caretUTF16,
                elementRevision: offer.target.elementRevision,
                presentation: fields.presentation
            )
        }
        var counters = fields.counters
        counters["offers.published"] = arbiterState.publishedCount
        counters["offers.claimed"] = arbiterState.claimCount
        counters["offers.refused"] = arbiterState.refusedPublishCount
        return DebugState(
            pid: ProcessInfo.processInfo.processIdentifier,
            uptimeSeconds: Date().timeIntervalSince(status.startedAt),
            trust: TrustProbe.current(eventTapEnabled: tapState.enabled),
            engine: fields.engine,
            focus: fields.focus,
            offer: offer,
            lastClaim: arbiterState.lastClaim,
            lastInsertion: fields.lastInsertion,
            tap: tapState,
            latency: status.latency.summary(),
            counters: counters
        )
    }
}
