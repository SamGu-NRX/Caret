import AppCompatibility
import AppKit
import CaretHostCore
import CaretScreenCore
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
        /// False computes the perch and the activity list and reports them on the debug socket
        /// without drawing them (`--perch hidden`, `CARET_PERCH=hidden`), for test runs while
        /// someone is using the Mac.
        public var perchDrawsOnScreen: Bool

        public init(
            socketPath: String = HostRuntime.defaultSocketPath,
            helperSocketPath: String = HostRuntime.defaultHelperSocketPath,
            modelURL: URL = EngineLoader.defaultModelURL,
            allowedBundleIDs: Set<String>? = HostRuntime.allowedBundleIDsFromEnvironment,
            allowedPIDs: Set<Int32>? = HostRuntime.pids(ProcessInfo.processInfo.environment["CARET_ALLOW_PIDS"]),
            ghostEnabled: Bool = ProcessInfo.processInfo.environment["CARET_GHOST"] != "off",
            fillAdvances: Bool = ProcessInfo.processInfo.environment["CARET_FILL_ADVANCE"] != "off",
            perchDrawsOnScreen: Bool = ProcessInfo.processInfo.environment["CARET_PERCH"] != "hidden"
        ) {
            self.perchDrawsOnScreen = perchDrawsOnScreen
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
    private let surface: SurfaceCoordinator
    private let helper: HelperClient
    private let activity: ActivityCenter
    private let perch: PerchController
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
        let surface = SurfaceCoordinator(arbiter: arbiter, status: status, policy: policy, compatibilityStore: compatibilityStore)
        self.surface = surface
        let executor = InsertionExecutor(
            arbiter: arbiter, status: status, compatibilityStore: compatibilityStore, policy: policy,
            advanceAfterFill: configuration.fillAdvances,
            onFinished: { result in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        coordinator.insertionFinished(result)
                        fill.insertionFinished(result)
                        surface.insertionFinished(result)
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
        surface.executor = executor
        coordinator.onFocus = { identity in surface.focusChanged(identity) }
        // Publishing happens on the main thread, so the displaced offer's owner hears at once.
        arbiter.onDisplaced = { offer in
            MainActor.assumeIsolated {
                coordinator.displaced(offer)
                fill.displaced(offer)
                surface.displaced(offer)
            }
        }
        let activity = ActivityCenter()
        self.activity = activity
        let perch = PerchController(center: activity, drawsOnScreen: configuration.perchDrawsOnScreen)
        self.perch = perch
        activity.onChange = { perch.refresh() }
        helper = HelperClient(path: configuration.helperSocketPath, onMessage: { message in
            let at = DispatchTime.now().uptimeNanoseconds
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    fill.receive(message, at: at)
                    activity.receive(message)
                }
            }
        }, onLink: { up in
            DispatchQueue.main.async { MainActor.assumeIsolated { activity.linkChanged(up) } }
        })
        fill.client = helper
        surface.client = helper
        activity.client = helper
        let pauseClient = helper
        let pauser = InputPauser(gate: activity.pauseGate) { taskIds, kind in
            for id in taskIds { pauseClient.send(TaskControl(taskId: id, action: .pause)) }
            activity.notePause(taskIds, kind: kind)
        }
        tap = TapThread(arbiter: arbiter, callbacks: TapThread.Callbacks(
            claimed: { claim in
                if claim.insertsText { executor.submit(claim) }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        coordinator.claimed(claim)
                        fill.claimed(claim)
                        surface.claimed(claim)
                    }
                }
            },
            offerChanged: { reason, key in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        coordinator.offerChanged(reason, key: key)
                        fill.offerChanged(reason)
                        surface.offerChanged(reason)
                    }
                }
            },
            undo: { grant in
                executor.submitUndo(grant)
                DispatchQueue.main.async { MainActor.assumeIsolated { fill.undoStarted(grant) } }
            },
            keyDown: { status.noteKeyDown($0) },
            navigated: { offerID, ui in
                DispatchQueue.main.async { MainActor.assumeIsolated { surface.navigated(offerID: offerID, ui: ui) } }
            },
            stopWork: { line in
                DispatchQueue.main.async { MainActor.assumeIsolated { surface.stopWork(line) } }
            },
            realKey: { pid in pauser.key(pid: pid) },
            mouseDown: { point in pauser.click(at: point) }
        ))
        let tap = self.tap
        let helper = self.helper
        let writeMethods = executor.writeMethods
        let hooks = MainHooks(
            inject: { data in
                MainActor.assumeIsolated {
                    do {
                        let injection = try SurfaceInjection.decode(data)
                        if case .helperLine(let line) = injection {
                            let message = try HelperInbound.decode(line)
                            fill.receive(message, at: DispatchTime.now().uptimeNanoseconds)
                            return #"{"ok":true}"#
                        }
                        return surface.inject(injection)
                    } catch {
                        return "{\"error\":\(Self.jsonString(String(describing: error)))}"
                    }
                }
            },
            progress: { phase in MainActor.assumeIsolated { surface.progress(phase) } },
            surface: { MainActor.assumeIsolated { surface.debugInfo() } },
            perch: { words in MainActor.assumeIsolated { Self.perchCommand(words, perch: perch, activity: activity, pauser: pauser) } }
        )
        socket = DebugStateSocket(path: configuration.socketPath) { command in
            Self.respond(to: command, arbiter: arbiter, status: status, tap: tap, helper: helper, writeMethods: writeMethods, hooks: hooks)
        }
    }

    /// Throws when another host already serves the socket; the caller should exit rather than run
    /// a second key tap.
    /// True while accepted work runs (the menu bar glyph tints Carrot).
    public var onWorkingChanged: ((Bool) -> Void)? {
        get { surface.onWorkingChanged }
        set { surface.onWorkingChanged = newValue }
    }

    /// The menu bar's "Show Perch" choice, kept in user defaults.
    public var perchHidden: Bool {
        get { perch.hidden }
        set { perch.hidden = newValue }
    }

    public func toggleActivityList() { perch.toggleList() }

    public func start() throws {
        try socket.start()
        AXRead.setGlobalMessagingTimeout(seconds: 0.25)
        if !tap.start() { status.increment("tap.createFailed") }
        focus.onChange = { [coordinator, perch] change in
            coordinator.handle(change)
            perch.focusChanged(caret: change.snapshot?.caretRect, element: change.element)
        }
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
        surface.shutdown()
        perch.shutdown()
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

    /// Socket-thread entry points that must run on the main thread. Each call blocks the socket
    /// thread until main has run it, so a reply reflects what is on screen.
    struct MainHooks: Sendable {
        let inject: @Sendable (Data) -> String
        let progress: @Sendable (String) -> String
        let surface: @Sendable () -> DebugState.SurfaceInfo
        /// `perch`, `activity`, `control`, `click` and `perch-avoid` (`perchCommand`).
        let perch: @Sendable ([String]) -> String
    }

    /// Debug socket commands for the perch and the activity list. Main thread.
    ///
    ///   perch                          the perch's state, the rows, the pause table
    ///   activity open|close            opens or closes the list, as a click on the perch does
    ///   control <taskId> <action>      presses a row's button (takeOver, resume, undo)
    ///   click <pid>                    a real click in <pid>, through the input pause
    ///   perch-avoid x y w h | clear    stands in for a focused field there (global, top-left)
    static func perchCommand(_ words: [String], perch: PerchController, activity: ActivityCenter, pauser: InputPauser) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        func ok(_ extra: String = "") -> String { "{\"ok\":true\(extra)}" }
        switch words.first {
        case "perch":
            return (try? String(decoding: encoder.encode(perch.debugInfo()), as: UTF8.self)) ?? "{}"
        case "activity":
            switch words.dropFirst().first {
            case "open": perch.openList()
            case "close": perch.closeList()
            default: return #"{"error":"usage: activity open|close"}"#
            }
            return ok()
        case "control":
            guard words.count == 3, let action = RowAction(rawValue: words[2]) else {
                return #"{"error":"usage: control <taskId> takeOver|resume|undo"}"#
            }
            return ok(",\"sent\":\(activity.control(words[1], action))")
        case "click":
            guard words.count == 2, let pid = Int32(words[1]) else { return #"{"error":"usage: click <pid>"}"# }
            pauser.click(pid: pid)
            return ok()
        case "perch-avoid":
            if words.count == 2, words[1] == "clear" {
                perch.avoid(caret: nil, field: nil)
                return ok()
            }
            let n = words.dropFirst().compactMap(Double.init)
            guard n.count == 4 else { return #"{"error":"usage: perch-avoid x y w h | clear"}"# }
            let rect = CGRect(x: n[0], y: n[1], width: n[2], height: n[3])
            perch.avoid(caret: CGRect(x: rect.maxX - 2, y: rect.minY, width: 2, height: min(rect.height, 18)), field: rect)
            return ok()
        default:
            return #"{"error":"unknown command"}"#
        }
    }

    nonisolated static func jsonString(_ text: String) -> String {
        (try? String(decoding: JSONEncoder().encode(text), as: UTF8.self)) ?? "\"\""
    }

    private nonisolated static func respond(
        to command: String, arbiter: OfferArbiter, status: HostStatus, tap: TapThread,
        helper: HelperClient, writeMethods: WriteMethodTable, hooks: MainHooks
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
                return Data("{\"error\":\"usage: key \(TestKeys.names) <pid>\"}\n".utf8)
            }
            let consumed = tap.route(key)
            // The tap's callbacks post to main; wait for them, so the next read sees their effect.
            DispatchQueue.main.sync {}
            return Data("{\"ok\":true,\"consumed\":\(consumed)}\n".utf8)
        case "inject":
            // `inject <json>`: an offer for the focused field of the pid it names (SurfaceInjection).
            let json = command.dropFirst("inject".count).trimmingCharacters(in: .whitespaces)
            let reply = DispatchQueue.main.sync { hooks.inject(Data(json.utf8)) }
            return Data((reply + "\n").utf8)
        case "progress":
            guard words.count == 2 else { return Data("{\"error\":\"usage: progress done|error\"}\n".utf8) }
            let reply = DispatchQueue.main.sync { hooks.progress(words[1]) }
            return Data((reply + "\n").utf8)
        case "perch", "activity", "control", "click", "perch-avoid":
            let reply = DispatchQueue.main.sync { hooks.perch(words) }
            return Data((reply + "\n").utf8)
        case "state":
            var state = makeState(arbiter: arbiter, status: status, tap: tap, helper: helper, writeMethods: writeMethods)
            state.surface = DispatchQueue.main.sync { hooks.surface() }
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
                presentation: offer.kind == .ghost && offer.source == .engine ? fields.presentation : offer.kind.name
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
    static let names = "tab|shift-tab|esc|up|down|left|right|return|space|cmd-z|cmd-1|cmd-2|cmd-3|char:<c>"

    static func key(_ name: String, pid: Int32) -> KeyStroke? {
        switch name {
        case "tab": return .tab(to: pid)
        case "shift-tab": return KeyStroke(keyCode: KeyStroke.tabKeyCode, shift: true, targetPID: pid)
        case "up": return KeyStroke(keyCode: KeyStroke.upKeyCode, targetPID: pid)
        case "down": return KeyStroke(keyCode: KeyStroke.downKeyCode, targetPID: pid)
        case "left": return KeyStroke(keyCode: KeyStroke.leftKeyCode, targetPID: pid)
        case "right": return KeyStroke(keyCode: KeyStroke.rightKeyCode, targetPID: pid)
        case "return": return KeyStroke(keyCode: KeyStroke.returnKeyCode, targetPID: pid)
        case "space": return KeyStroke(keyCode: KeyStroke.spaceKeyCode, text: " ", targetPID: pid)
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
