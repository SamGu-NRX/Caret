import AppCompatibility
import AppKit
import CaretHostCore
import Foundation

/// Builds and owns the host's parts and wires them together. The app shell creates one, calls
/// `start`, and awaits `shutdown` before exit.
@MainActor
public final class HostRuntime {
    public struct Configuration {
        public var socketPath: String
        public var helperSocketPath: String
        public var modelURL: URL
        /// When set, offers are made only in these apps. For test runs on a shared Mac, so the host
        /// never draws over or takes Tab from windows it did not create. Nil means every app.
        public var allowedBundleIDs: Set<String>?
        /// When set, offers are made and writes go only to these pids (`CARET_ALLOW_PIDS`).
        public var allowedPIDs: Set<Int32>?
        /// False skips loading the model: fill only (`--no-ghost`, `CARET_GHOST=off`).
        public var ghostEnabled: Bool
        /// After a verified fill, post Tab to the form so its focus moves on (SURFACES.md section 5).
        public var fillAdvances: Bool

        public init(
            socketPath: String = HostRuntime.defaultSocketPath,
            helperSocketPath: String = HostRuntime.defaultHelperSocketPath,
            modelURL: URL = EngineLoader.defaultModelURL,
            allowedBundleIDs: Set<String>? = HostRuntime.allowedBundleIDsFromEnvironment,
            allowedPIDs: Set<Int32>? = HostRuntime.pids(ProcessInfo.processInfo.environment["CARET_ALLOW_PIDS"]),
            ghostEnabled: Bool = ProcessInfo.processInfo.environment["CARET_GHOST"] != "off",
            fillAdvances: Bool = ProcessInfo.processInfo.environment["CARET_FILL_ADVANCE"] != "off"
        ) {
            self.socketPath = socketPath
            self.helperSocketPath = helperSocketPath
            self.modelURL = modelURL
            self.allowedBundleIDs = allowedBundleIDs
            self.allowedPIDs = allowedPIDs
            self.ghostEnabled = ghostEnabled
            self.fillAdvances = fillAdvances
        }
    }

    public nonisolated static var defaultSocketPath: String {
        if let override = ProcessInfo.processInfo.environment["CARET_HOST_SOCKET"], !override.isEmpty {
            return override
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".caret-run/sockets/host.sock").path
    }

    /// The helper's socket: `CARET_SCREEN_SOCKET`, else `~/.caret-run/sockets/screen.sock`.
    public nonisolated static var defaultHelperSocketPath: String { HelperClient.defaultPath }

    /// Comma-separated pids, as `CARET_ALLOW_PIDS` and `--allow-pids` take them.
    public nonisolated static func pids(_ raw: String?) -> Set<Int32>? { TargetPolicy.pids(from: raw) }

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
    private let fill: FillCoordinator
    private let helper: HelperClient
    private let executor: InsertionExecutor
    private let tap: TapThread
    private let socket: DebugStateSocket
    private var engineTask: Task<Void, Never>?

    public init(configuration: Configuration = Configuration()) {
        self.configuration = configuration
        let arbiter = self.arbiter
        let status = self.status
        let policy = TargetPolicy(allowedBundleIDs: configuration.allowedBundleIDs, allowedPIDs: configuration.allowedPIDs)
        engine = GhostTextEngine(compatibilityStore: compatibilityStore)
        overlay = GhostOverlay(compatibilityStore: compatibilityStore)
        let coordinator = HostCoordinator(arbiter: arbiter, status: status, engine: engine, overlay: overlay, policy: policy)
        self.coordinator = coordinator
        let fill = FillCoordinator(arbiter: arbiter, status: status, overlay: FillOverlay(), watcher: FillTargetWatcher(), policy: policy)
        self.fill = fill
        let executor = InsertionExecutor(
            arbiter: arbiter, status: status, compatibilityStore: compatibilityStore, policy: policy,
            advanceAfterFill: configuration.fillAdvances,
            onFinished: { result in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        coordinator.insertionFinished(result)
                        fill.insertionFinished(result)
                    }
                }
            },
            onUndone: { result in
                DispatchQueue.main.async { MainActor.assumeIsolated { fill.undoFinished(result) } }
            }
        )
        self.executor = executor
        coordinator.executor = executor
        fill.executor = executor
        helper = HelperClient(path: configuration.helperSocketPath) { message in
            let at = DispatchTime.now().uptimeNanoseconds
            DispatchQueue.main.async { MainActor.assumeIsolated { fill.receive(message, at: at) } }
        }
        fill.client = helper
        tap = TapThread(arbiter: arbiter, callbacks: TapThread.Callbacks(
            claimed: { claim in
                executor.submit(claim)
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        coordinator.claimed(claim)
                        fill.claimed(claim)
                    }
                }
            },
            offerChanged: { reason, key in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        coordinator.offerChanged(reason, key: key)
                        fill.offerChanged(reason)
                    }
                }
            },
            undo: { grant in
                executor.submitUndo(grant)
                DispatchQueue.main.async { MainActor.assumeIsolated { fill.undoStarted(grant) } }
            },
            keyDown: { status.noteKeyDown($0) }
        ))
        let tap = self.tap
        let helper = self.helper
        let writeMethods = executor.writeMethods
        socket = DebugStateSocket(path: configuration.socketPath) { command in
            Self.respond(to: command, arbiter: arbiter, status: status, tap: tap, helper: helper, writeMethods: writeMethods)
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
        helper.start()
        let modelFile = configuration.modelURL.lastPathComponent
        guard configuration.ghostEnabled else {
            engine.disable()
            status.update { $0.engine = DebugState.Engine(state: "disabled", modelFile: modelFile) }
            return
        }
        status.update { $0.engine = DebugState.Engine(state: "loading", modelFile: modelFile) }
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
        helper.stop()
        fill.shutdown()
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

    private nonisolated static func respond(
        to command: String, arbiter: OfferArbiter, status: HostStatus, tap: TapThread,
        helper: HelperClient, writeMethods: WriteMethodTable
    ) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let words = command.split(separator: " ").map(String.init)
        switch words.first ?? "state" {
        case "ping":
            return Data("{\"ok\":true}\n".utf8)
        case "latency-reset":
            status.latency.reset()
            status.proposalToOffer.reset()
            status.focusToOffer.reset()
            return Data("{\"ok\":true}\n".utf8)
        case "key":
            // Test hook: `key <name> <pid>` routes a constructed key-down, headed for <pid>, through
            // the same arbiter and callbacks as the event tap. No event is posted anywhere.
            guard words.count == 3, let pid = Int32(words[2]), let key = TestKeys.key(words[1], pid: pid) else {
                return Data("{\"error\":\"usage: key tab|esc|cmd-z|cmd-1|cmd-2|cmd-3|char:<c> <pid>\"}\n".utf8)
            }
            let consumed = tap.route(key)
            return Data("{\"ok\":true,\"consumed\":\(consumed)}\n".utf8)
        case "state":
            let state = makeState(arbiter: arbiter, status: status, tap: tap, helper: helper, writeMethods: writeMethods)
            return ((try? encoder.encode(state)) ?? Data("{}".utf8)) + Data("\n".utf8)
        default:
            return Data("{\"error\":\"unknown command\"}\n".utf8)
        }
    }

    private nonisolated static func makeState(
        arbiter: OfferArbiter, status: HostStatus, tap: TapThread, helper: HelperClient, writeMethods: WriteMethodTable
    ) -> DebugState {
        let fields = status.read()
        let arbiterState = arbiter.snapshot()
        let tapState = tap.debugState()
        let offer = arbiterState.current.map { offer in
            var info = DebugState.OfferInfo(
                id: offer.id,
                text: String(offer.text.dropFirst(arbiterState.typedSinceOffer.count)),
                typedSinceOffer: arbiterState.typedSinceOffer,
                ageMs: Date().timeIntervalSince(offer.createdAt) * 1_000,
                pid: offer.target.pid,
                bundleID: offer.target.bundleID,
                caretUTF16: offer.caretUTF16,
                elementRevision: offer.target.elementRevision,
                presentation: offer.kind == .ghost ? fields.presentation : "fill"
            )
            info.kind = offer.kind.name
            info.fill = offer.kind.fillOrigin.map {
                DebugState.FillInfo(proposalId: $0.proposalID, windowId: $0.windowID, fieldKey: $0.fieldKey, source: $0.sourceCaption)
            }
            return info
        }
        var counters = fields.counters
        counters["offers.published"] = arbiterState.publishedCount
        counters["offers.claimed"] = arbiterState.claimCount
        counters["offers.refused"] = arbiterState.refusedPublishCount
        var state = DebugState(
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
        var fill = fields.fill
        fill.proposalToOffer = status.proposalToOffer.summary()
        fill.focusToOffer = status.focusToOffer.summary()
        state.fill = fill
        state.helper = helper.snapshot()
        state.lastUndo = fields.lastUndo
        state.writeMethods = writeMethods.snapshot()
        return state
    }
}

/// Keys the debug socket's test hook can route.
enum TestKeys {
    static func key(_ name: String, pid: Int32) -> KeyStroke? {
        switch name {
        case "tab": return .tab(to: pid)
        case "esc": return KeyStroke(keyCode: KeyStroke.escapeKeyCode, targetPID: pid)
        case "cmd-z": return KeyStroke(keyCode: KeyStroke.zKeyCode, command: true, targetPID: pid)
        case "cmd-1": return KeyStroke(keyCode: 18, command: true, targetPID: pid)
        case "cmd-2": return KeyStroke(keyCode: 19, command: true, targetPID: pid)
        case "cmd-3": return KeyStroke(keyCode: 20, command: true, targetPID: pid)
        default:
            guard name.hasPrefix("char:"), name.count == 6 else { return nil }
            return KeyStroke(keyCode: 0, text: String(name.suffix(1)), targetPID: pid)
        }
    }
}
