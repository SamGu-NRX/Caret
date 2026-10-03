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
        /// True decides helper offers without drawing them or writing anything (`--surfaces
        /// headless`, `CARET_SURFACES=headless`), for socket-level runs while someone is using the Mac.
        public var surfacesHeadless: Bool
        /// The debug socket accepts `inject` and `progress`, which fake offers and their results
        /// (`--test-hooks`, `CARET_TEST_HOOKS=1`). Off in normal use: real offers come from the helper.
        public var testHooks: Bool
        /// What a ghost completion too wide for its line does (`--ghost-overflow`,
        /// `CARET_GHOST_OVERFLOW`): `capsule`, or `drop` to measure KeyType's behavior.
        public var ghostOverflow: GhostFit.OverflowRule
        /// When onboarding opens (`--onboarding`, `CARET_ONBOARDING`): `off` (the menu opens it),
        /// `auto` (at launch until finished once), `show`, or `hidden` (no window; socket only).
        public var onboarding: String

        public init(
            socketPath: String = HostRuntime.defaultSocketPath,
            helperSocketPath: String = HostRuntime.defaultHelperSocketPath,
            modelURL: URL = EngineLoader.defaultModelURL,
            allowedBundleIDs: Set<String>? = HostRuntime.allowedBundleIDsFromEnvironment,
            allowedPIDs: Set<Int32>? = HostRuntime.pids(ProcessInfo.processInfo.environment["CARET_ALLOW_PIDS"]),
            ghostEnabled: Bool = ProcessInfo.processInfo.environment["CARET_GHOST"] != "off",
            fillAdvances: Bool = ProcessInfo.processInfo.environment["CARET_FILL_ADVANCE"] != "off",
            perchDrawsOnScreen: Bool = ProcessInfo.processInfo.environment["CARET_PERCH"] != "hidden",
            surfacesHeadless: Bool = ProcessInfo.processInfo.environment["CARET_SURFACES"] == "headless",
            testHooks: Bool = ProcessInfo.processInfo.environment["CARET_TEST_HOOKS"] == "1",
            onboarding: String = ProcessInfo.processInfo.environment["CARET_ONBOARDING"] ?? "off",
            ghostOverflow: GhostFit.OverflowRule = ProcessInfo.processInfo.environment["CARET_GHOST_OVERFLOW"] == "drop" ? .drop : .capsule
        ) {
            self.ghostOverflow = ghostOverflow
            self.onboarding = onboarding
            self.perchDrawsOnScreen = perchDrawsOnScreen
            self.surfacesHeadless = surfacesHeadless
            self.testHooks = testHooks
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
    private let onboarding: OnboardingController
    private let memory: MemoryController
    private var engineTask: Task<Void, Never>?

    public init(configuration: Configuration = Configuration()) {
        self.configuration = configuration
        let arbiter = self.arbiter
        let status = self.status
        let policy = TargetPolicy(allowedBundleIDs: configuration.allowedBundleIDs, allowedPIDs: configuration.allowedPIDs)
        engine = GhostTextEngine(compatibilityStore: compatibilityStore)
        overlay = GhostOverlay(compatibilityStore: compatibilityStore, overflow: configuration.ghostOverflow)
        let coordinator = HostCoordinator(arbiter: arbiter, status: status, engine: engine, overlay: overlay, policy: policy)
        self.coordinator = coordinator
        let fill = FillCoordinator(arbiter: arbiter, status: status, overlay: FillOverlay(), watcher: FillTargetWatcher(), policy: policy)
        self.fill = fill
        let surface = SurfaceCoordinator(
            arbiter: arbiter, status: status, policy: policy, compatibilityStore: compatibilityStore,
            headless: configuration.surfacesHeadless
        )
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
        coordinator.wordsAllowed = { MainActor.assumeIsolated { HostGate.allowsGhostText(SettingsStore.shared.settings) } }
        // Publishing happens on the main thread, so the displaced offer's owner hears at once.
        arbiter.onDisplaced = { offer in
            MainActor.assumeIsolated {
                coordinator.displaced(offer)
                fill.displaced(offer)
                surface.displaced(offer)
            }
        }
        let onboarding = OnboardingController(mode: OnboardingController.Mode(rawValue: configuration.onboarding) ?? .off, testHooks: configuration.testHooks)
        self.onboarding = onboarding
        let activity = ActivityCenter()
        self.activity = activity
        let memory = MemoryController(testHooks: configuration.testHooks)
        self.memory = memory
        let perch = PerchController(center: activity, drawsOnScreen: configuration.perchDrawsOnScreen)
        self.perch = perch
        activity.onChange = { perch.refresh() }
        // Every helper message takes this route, on main: a line from the helper's socket, and one the
        // debug socket injects (`inject helperLine`), so an injected offer is taken, accepted and
        // reported exactly as a real one.
        let route: @MainActor (HelperInbound, UInt64) -> Void = { message, at in
            activity.receive(message)
            // Memory is the user's to see and change whatever the gate holds.
            if case .memoryReply(let reply) = message {
                memory.receive(reply)
                return onboarding.knowAvailableChanged(memory.book.state.acceptsAdd)
            }
            // Pause and the roles the host can tell apart (`HostGate`); the perch still
            // hears about work, which the user asked to see.
            guard HostGate.allows(message, SettingsStore.shared.settings) else {
                return status.increment("gate.refused.\(message.typeName)")
            }
            fill.receive(message, at: at)
            switch message {
            case .alternatives, .action, .popup: if let offer = HelperOffer(message) { surface.receive(offer) }
            case .offerWithdrawn(let withdrawn):
                surface.withdrawn(withdrawn)
                onboarding.receive(withdrawn)
                perch.ask.withdrawn(withdrawn)
            case .taskProgress(let progress):
                surface.taskProgress(progress)
                onboarding.receive(progress)
                perch.ask.receive(progress)
            case .planProposal(let proposal): perch.ask.receive(proposal)
            case .firstLookReply(let reply): onboarding.receive(reply)
            default: break
            }
        }
        helper = HelperClient(path: configuration.helperSocketPath, onMessage: { message in
            let at = DispatchTime.now().uptimeNanoseconds
            DispatchQueue.main.async {
                MainActor.assumeIsolated { route(message, at) }
            }
        }, onLink: { up in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    activity.linkChanged(up)
                    memory.linkChanged(up)
                    perch.ask.linkChanged(up)
                    if !up { surface.helperGone() }
                }
            }
        })
        fill.client = helper
        let firstLookClient = helper
        onboarding.sendFirstLook = { firstLookClient.send($0) }
        onboarding.sendAccept = { firstLookClient.send($0) }
        onboarding.sendStop = { firstLookClient.send($0) }
        onboarding.sendControl = { firstLookClient.send($0) }
        // Weak across the client: its callbacks hold the memory controller.
        let memoryClient = helper
        memory.send = { [weak memoryClient] in memoryClient?.send($0) ?? false }
        onboarding.onRemember = { [weak memory] in memory?.remember($0) }
        onboarding.onForgetTyped = { [weak memory] in memory?.forgetTyped(labels: $0) }
        onboarding.knowAvailable = { [weak memory] in memory?.book.state.acceptsAdd ?? false }
        perch.onOpenMemory = { [weak memory] in memory?.open() }
        memory.book.onEntryChanged = { id in fill.memoryChanged(id) }
        let askClient = helper
        perch.ask.send = { [weak askClient] message in
            guard let askClient else { return false }
            switch message {
            case .plan(let request): return askClient.send(request)
            case .accept(let accept): return askClient.send(accept)
            case .stop(let stop): return askClient.send(stop)
            }
        }
        // The helper's gate holds the same roles, level and pause: sent after every hello and on
        // every change (B10). The client drops a change that leaves all three as they were.
        let gateClient = helper
        gateClient.update(GateSettings(SettingsStore.shared.settings, at: Self.nowMs()))
        // A setting that closes the gate takes down what it no longer allows at once, not only
        // what arrives next (A7 review).
        SettingsStore.shared.observe { settings in
            gateClient.update(GateSettings(settings, at: Self.nowMs()))
            if !HostGate.allowsGhostText(settings) { coordinator.gateClosed() }
            if !settings.gate.allows(family: "fill") { fill.gateClosed() }
            if settings.paused { surface.gateClosed() }
        }
        surface.client = helper
        // The fill line and the fill pop-up share the arbiter's one toast slot.
        surface.onToastChanged = { fill.toastChanged() }
        fill.onToastShown = { surface.toastChanged() }
        activity.client = helper
        let pauseClient = helper
        let writesNothing = configuration.surfacesHeadless
        let pauser = InputPauser(gate: activity.pauseGate) { taskIds, kind in
            for control in InputPause.controls(for: taskIds) { pauseClient.send(control) }
            activity.notePause(taskIds, kind: kind)
        }
        tap = TapThread(arbiter: arbiter, callbacks: TapThread.Callbacks(
            claimed: { claim in
                if claim.insertsText {
                    // A headless host writes nothing: the claim is decided and recorded, never applied.
                    if writesNothing { arbiter.abandon(claimID: claim.claimID, reason: "headless") } else { executor.submit(claim) }
                }
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
                if grant.taskID != nil {
                    // The helper's executor made these writes and keeps their ledger; it undoes them.
                    // The request goes from main, never from the tap thread, which only enqueues.
                    DispatchQueue.main.async { MainActor.assumeIsolated { surface.undoStarted(grant) } }
                } else {
                    executor.submitUndo(grant)
                    DispatchQueue.main.async { MainActor.assumeIsolated { fill.undoStarted(grant) } }
                }
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
        // Accessibility granted in onboarding: a key tap the system refused at launch is made now.
        onboarding.onPermissionsChanged = { granted in
            if granted.accessibility, !tap.restartIfRefused() { status.increment("tap.createFailed") }
        }
        let helper = self.helper
        let writeMethods = executor.writeMethods
        let testHooks = configuration.testHooks
        let hooks = MainHooks(
            inject: { data in
                MainActor.assumeIsolated {
                    guard testHooks else { return #"{"error":"inject is a test hook: start the host with --test-hooks"}"# }
                    do {
                        let injection = try SurfaceInjection.decode(data)
                        if case .helperLine(let line) = injection {
                            route(try HelperInbound.decode(line), DispatchTime.now().uptimeNanoseconds)
                            return #"{"ok":true}"#
                        }
                        return surface.inject(injection)
                    } catch {
                        return "{\"error\":\(Self.jsonString(String(describing: error)))}"
                    }
                }
            },
            progress: { phase in
                MainActor.assumeIsolated {
                    testHooks ? surface.progress(phase) : #"{"error":"progress is a test hook: start the host with --test-hooks"}"#
                }
            },
            surface: { MainActor.assumeIsolated { surface.debugInfo() } },
            perch: { words in MainActor.assumeIsolated { Self.perchCommand(words, perch: perch, activity: activity, pauser: pauser) } },
            ask: { words in MainActor.assumeIsolated { Self.askCommand(words, ask: perch.ask, perch: perch, testHooks: testHooks) } },
            placementBounds: { words in
                MainActor.assumeIsolated {
                    guard testHooks else { return #"{"error":"placement-bounds is a test hook: start the host with --test-hooks"}"# }
                    if words.count == 2, words[1] == "clear" {
                        surface.placementBounds = nil
                        return #"{"ok":true}"#
                    }
                    let n = words.dropFirst().compactMap(Double.init)
                    guard n.count == 4 else { return #"{"error":"usage: placement-bounds x y w h | clear"}"# }
                    surface.placementBounds = CGRect(x: n[0], y: n[1], width: n[2], height: n[3])
                    return #"{"ok":true}"#
                }
            },
            settings: { words in MainActor.assumeIsolated { Self.settingsCommand(words) } },
            onboarding: { words in MainActor.assumeIsolated { onboarding.command(words) } },
            memory: { words in MainActor.assumeIsolated { memory.command(words) } }
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

    /// The menu's Ask Caret: the activity list, its ask field focused.
    public func askCaret() { perch.openAsk() }

    /// The menu's Set Up Caret: onboarding in its window.
    public func openOnboarding() { onboarding.open(drawing: true) }

    /// The menu's What Caret Knows: the memory window.
    public func openMemory() { memory.open() }

    public func start() throws {
        try socket.start()
        AXRead.setGlobalMessagingTimeout(seconds: 0.25)
        if !tap.start() { status.increment("tap.createFailed") }
        focus.onChange = { [coordinator, perch] change in
            coordinator.handle(change)
            perch.focusChanged(caret: change.snapshot?.caretRectAX, element: change.element)
        }
        focus.start()
        helper.start()
        onboarding.launch()
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
        onboarding.close()
        memory.close()
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
        /// `ask ...` (`askCommand`).
        let ask: @Sendable ([String]) -> String
        /// `placement-bounds x y w h | clear`: places panels as on a screen that small (test hooks).
        let placementBounds: @Sendable ([String]) -> String
        /// `settings` and `settings set ...` (`settingsCommand`).
        let settings: @Sendable ([String]) -> String
        /// `onboarding ...` (`OnboardingController.command`).
        let onboarding: @Sendable ([String]) -> String
        /// `memory ...` (`MemoryController.command`).
        let memory: @Sendable ([String]) -> String
    }

    /// The ask field, over the debug socket. Main thread.
    ///
    ///   ask                       the field, the phase, the card and its line
    ///   ask type <text>           sets the field's text, as typing does (test hooks)
    ///   ask submit                Return (test hooks)
    ///   ask key tab|esc           Tab or Esc in the field (test hooks)
    ///   ask open                  the list with the field focused, as the menu's Ask Caret (test hooks)
    static func askCommand(_ words: [String], ask: AskCaret, perch: PerchController, testHooks: Bool) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        func state(_ extra: [String: Bool] = [:]) -> String {
            var reply = (try? String(decoding: encoder.encode(ask.debugInfo), as: UTF8.self)) ?? "{}"
            if let (k, v) = extra.first { reply = "{\"\(k)\":\(v)," + reply.dropFirst() }
            return reply
        }
        guard words.count > 1 else { return state() }
        guard testHooks else { return #"{"error":"ask \#(words[1]) is a test hook: start the host with --test-hooks"}"# }
        switch words[1] {
        case "type":
            ask.edit(words.count > 2 ? words[2] : "")
            return state()
        case "submit":
            return state(["sent": ask.submit()])
        case "key":
            switch words.count > 2 ? words[2] : "" {
            case "tab": return state(["consumed": ask.tab()])
            case "esc": return state(["consumed": ask.escape()])
            default: return #"{"error":"usage: ask key tab|esc"}"#
            }
        case "open":
            perch.openAsk()
            return state()
        default:
            return #"{"error":"usage: ask | ask type <text> | ask submit | ask key tab|esc | ask open"}"#
        }
    }

    /// `settings` reads the settings file, the choices and the gate they make; `settings set
    /// <name> <value>` changes one as the menu bar would (`SettingsStore.set`). Main thread.
    static func settingsCommand(_ words: [String]) -> String {
        let store = SettingsStore.shared
        if words.count > 1 {
            guard words[1] == "set" else { return #"{"error":"usage: settings | settings set <name> <value>"}"# }
            if let usage = store.set(Array(words.dropFirst(2))) { return "{\"error\":\(jsonString(usage))}" }
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? String(decoding: encoder.encode(store.debugInfo()), as: UTF8.self)) ?? "{}"
    }

    /// Debug socket commands for the perch and the activity list. Main thread.
    ///
    ///   perch                          the perch's state, the rows, the pause table
    ///   activity open|close            opens or closes the list, as a click on the perch does
    ///   activity more                  presses "and N more" under Done
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
            case "more": perch.showMore()
            default: return #"{"error":"usage: activity open|close|more"}"#
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

    nonisolated static func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }

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
        case "settings":
            let reply = DispatchQueue.main.sync { hooks.settings(words) }
            return Data((reply + "\n").utf8)
        case "onboarding":
            // `onboarding reply <json>` carries JSON with spaces; keep the line whole after the verb.
            let parts = command.split(separator: " ", maxSplits: 2).map(String.init)
            let args = parts.count == 3 && parts[1] == "reply" ? parts : words
            let reply = DispatchQueue.main.sync { hooks.onboarding(args) }
            return Data((reply + "\n").utf8)
        case "memory":
            // `memory draft <key> <text>` and `memory remember <label> <value>` keep their spaces.
            let reply = DispatchQueue.main.sync { hooks.memory(words) }
            return Data((reply + "\n").utf8)
        case "ask":
            // `ask type <text>` keeps the text's spaces.
            let parts = command.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true).map(String.init)
            let reply = DispatchQueue.main.sync { hooks.ask(parts.count == 3 && parts[1] == "type" ? parts : words) }
            return Data((reply + "\n").utf8)
        case "placement-bounds":
            let reply = DispatchQueue.main.sync { hooks.placementBounds(words) }
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
        state.ghostFits = fields.ghostFits
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
