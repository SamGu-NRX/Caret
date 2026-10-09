import AppCompatibility
import AutocompleteCore
import AppKit
import CaretHostCore
import CaretScreenCore
import Foundation
import os

/// Builds and owns the host's parts and wires them together. The app shell creates one, calls
/// `start`, and awaits `shutdown` before exit.
@MainActor
public final class HostRuntime {
    public struct Configuration {
        public var socketPath: String
        public var helperSocketPath: String
        public var modelURL: URL
        /// Where the engine keeps its token profiles (`CaretHome.profilesDirectory`): a run with its own `--home`
        /// keeps them there, not in the user's Library.
        public var profileDirectory: URL = EngineLoader.profileDirectory
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
        /// Test hook (`--ghost-replay <file>`, `CARET_GHOST_REPLAY`, with `--test-hooks` only): ghost
        /// text comes from outcomes recorded with the model elsewhere (`GhostReplay`); the model is
        /// not loaded. For the rig's VM, which has no room for it.
        public var ghostReplayPath: String?
        /// When onboarding opens (`--onboarding`, `CARET_ONBOARDING`): `off` (the menu opens it),
        /// `auto` (at launch until finished once, or while Accessibility is off), `show`, or `hidden`
        /// (no window; socket only). Nil when neither names it: main.swift then picks
        /// `OnboardingLaunch.defaultMode` (H12: `auto` for the user's own Caret).
        public var onboarding: String?
        /// What the debug socket answers (`DebugSocketAccess`, H12). main.swift decides from the build and
        /// `CARET_DEBUG_SOCKET`; a test that builds a runtime gets `full`, as before.
        public var socketAccess: DebugSocketAccess = .full
        /// The socket sits in Caret's own sockets folder rather than one a run named, so the host makes that folder
        /// private (`DebugStateSocket.makePrivate`).
        public var socketInCaretsFolder = false
        /// `CARET_TEST_RESTORE_DELAY_MS`, used only with test hooks: how long a paste holds Caret's item
        /// on the pasteboard after the field settles, so an acceptance run can copy in the middle of a
        /// paste on cue. Ignored in normal use.
        public var pasteRestoreDelay: TimeInterval

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
            onboarding: String? = ProcessInfo.processInfo.environment["CARET_ONBOARDING"].flatMap { $0.isEmpty ? nil : $0 },
            ghostOverflow: GhostFit.OverflowRule = ProcessInfo.processInfo.environment["CARET_GHOST_OVERFLOW"] == "drop" ? .drop : .capsule
        ) {
            self.ghostOverflow = ghostOverflow
            self.ghostReplayPath = ProcessInfo.processInfo.environment["CARET_GHOST_REPLAY"]
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
            let delayMs = Double(ProcessInfo.processInfo.environment["CARET_TEST_RESTORE_DELAY_MS"] ?? "") ?? 0
            self.pasteRestoreDelay = min(max(delayMs, 0), 2000) / 1000
        }
    }

    /// `CARET_HOST_SOCKET`, else Caret's own sockets folder (`CaretHome.hostSocket`). Before H12 the default was
    /// `~/.caret-run/sockets/host.sock`, a development path, even in the shipped app.
    public nonisolated static var defaultSocketPath: String {
        if let override = ProcessInfo.processInfo.environment["CARET_HOST_SOCKET"], !override.isEmpty {
            return override
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/CaretV2/sockets/host.sock").path
    }

    /// The helper's socket: `CARET_SCREEN_SOCKET`, else `~/.caret-run/sockets/screen.sock`.
    public nonisolated static var defaultHelperSocketPath: String { HelperClient.defaultPath }

    /// Comma-separated pids, as `CARET_ALLOW_PIDS` and `--allow-pids` take them.
    public nonisolated static func pids(_ raw: String?) -> Set<Int32>? { TargetPolicy.pids(from: raw) }

    /// The same list, strictly: every entry a positive pid. The error says what is wrong with it.
    public nonisolated static func allowedPIDs(_ raw: String?) throws -> Set<Int32> {
        try TargetPolicy.strictPids(raw).get()
    }

    /// `CARET_ALLOW_BUNDLES`, comma-separated bundle identifiers.
    public nonisolated static var allowedBundleIDsFromEnvironment: Set<String>? {
        guard let raw = ProcessInfo.processInfo.environment["CARET_ALLOW_BUNDLES"], !raw.isEmpty else { return nil }
        return Set(raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
    }

    private let configuration: Configuration
    private let arbiter = OfferArbiter(aboveTabKeyCode: KeyboardLayout.aboveTabKeyCode())
    private let status = HostStatus()
    private let compatibilityStore = AppCompatibilityStore()
    private let engine: GhostTextEngine
    private let overlay: GhostOverlay
    private let focus = FocusObserver()
    private let coordinator: HostCoordinator
    private let fill: FillCoordinator
    private let surface: SurfaceCoordinator
    /// H11: the page task panel at the form.
    private let pageTask: PageTaskCoordinator
    /// H11: the quiet offer to keep an answer the user typed (S1).
    private let answerSave: AnswerSaveCoordinator
    /// H14: the quiet offer to keep a file the user attached (P3).
    private let fileSave: FileSaveCoordinator
    /// H13: inline text in web page fields, from the same ghost engine.
    private let pageInline: PageInlineCoordinator
    private let writing: WritingCoordinator
    private let helper: HelperClient
    private let activity: ActivityCenter
    private let perch: PerchController
    private let executor: InsertionExecutor
    private let tap: TapThread
    private let socket: DebugStateSocket
    private let onboarding: OnboardingController
    private let memory: MemoryController
    /// Brief item 8: the model file in use and Caret's own copy's download.
    private let modelKeeper: ModelKeeper
    private let pageSight: PageSightCoordinator
    /// H6: the helper's router, as ghost text and the writing line follow it.
    private let routeLink: RouteLink
    /// Looks again at a re-hello the routing setting asked for while work was live.
    private var rehelloTimer: Timer?
    /// How long after this host sent an accept the session counts as owning a run, before the run's
    /// activity record arrives. Assumed: activity follows an accept within a second on this Mac.
    static let rehelloAcceptGrace: TimeInterval = 30
    private var engineTask: Task<Void, Never>?
    private var trustPoll: Timer?
    private let servicesBox = ServicesBox()
    private var sessionLock: SessionLockWatch?

    /// The helper and reader the app shell started, and the bridge service (H4), for the debug socket's `services`.
    public var services: CaretServices? {
        get { servicesBox.services }
        set { servicesBox.services = newValue }
    }

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
        let pageTask = PageTaskCoordinator(arbiter: arbiter, status: status, drawsOnScreen: !configuration.surfacesHeadless)
        self.pageTask = pageTask
        let answerSave = AnswerSaveCoordinator(arbiter: arbiter, status: status, drawsOnScreen: !configuration.surfacesHeadless)
        self.answerSave = answerSave
        let fileSave = FileSaveCoordinator(arbiter: arbiter, status: status, drawsOnScreen: !configuration.surfacesHeadless)
        self.fileSave = fileSave
        fileSave.pageFrame = { [weak pageTask] in pageTask?.lastFrame }
        let pageInline = PageInlineCoordinator(arbiter: arbiter, status: status, engine: engine, policy: policy, drawsOnScreen: !configuration.surfacesHeadless)
        self.pageInline = pageInline
        pageInline.wordsAllowed = { MainActor.assumeIsolated { HostGate.allowsGhostText(SettingsStore.shared.settings) } }
        // Brief item 4: the user's personal instructions in every completion prompt; a page's site from the page path.
        engine.instructions = { context, origin in
            SettingsStore.shared.settings.instructions.lines(bundleID: context.target.bundleIdentifier, origin: origin)
        }
        let writing = WritingCoordinator(arbiter: arbiter, status: status, policy: policy)
        self.writing = writing
        let routeLink = RouteLink(status: status, enabled: SettingsStore.shared.settings.routing)
        self.routeLink = routeLink
        coordinator.route = routeLink
        writing.route = routeLink
        routeLink.onChange = [{ coordinator.routeChanged() }, { writing.routeChanged() }]
        writing.allowed = { MainActor.assumeIsolated { HostGate.allowsGhostText(SettingsStore.shared.settings) } }
        // List mode: the blind judge preferred its rewrites 11 to 4 over sampled ones, which changed
        // the meaning of 16 of 41 (rewrite probe 02f3cda9; judge verdicts in the PR).
        let rewriteEngine = engine
        writing.rewriter = { text in try? await rewriteEngine.rewrites(of: text, mode: .list)?.rewrites }
        // Every host write asks this right before it acts; pause, stop, take over and the helper's
        // connection closing end it (S1 audit #2).
        let authority = HostAuthority()
        let keyHold = KeyHold()
        let executor = InsertionExecutor(
            arbiter: arbiter, status: status, compatibilityStore: compatibilityStore, policy: policy,
            authority: authority, advanceAfterFill: configuration.fillAdvances, pasteRestoreDelay: configuration.testHooks ? configuration.pasteRestoreDelay : 0,
            keyHold: keyHold,
            onFinished: { result in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        coordinator.insertionFinished(result)
                        fill.insertionFinished(result)
                        surface.insertionFinished(result)
                        writing.insertionFinished(result)
                    }
                }
            },
            onUndone: { result in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        fill.undoFinished(result)
                        writing.undoFinished(result)
                    }
                }
            }
        )
        self.executor = executor
        coordinator.executor = executor
        fill.executor = executor
        surface.executor = executor
        coordinator.onFocus = { identity in surface.focusChanged(identity) }
        coordinator.wordsAllowed = { MainActor.assumeIsolated { HostGate.allowsGhostText(SettingsStore.shared.settings) } }
        // H13 review: a page's inline text takes no key while an input method composes (Pinyin's Tab is its own).
        arbiter.composing = { InputMethodState.shared.composes }
        // Publishing happens on the main thread, so the displaced offer's owner hears at once.
        arbiter.onDisplaced = { offer in
            MainActor.assumeIsolated {
                coordinator.displaced(offer)
                fill.displaced(offer)
                surface.displaced(offer)
                pageTask.machine.displaced(offer)
                answerSave.machine.displaced(offer)
                fileSave.machine.displaced(offer)
                pageInline.displaced(offer)
                writing.displaced(offer)
            }
        }
        // Progress sits beside the settings file, so a test run with its own settings never touches the user's.
        let progressPath = ((SettingsStore.path as NSString).deletingLastPathComponent as NSString).appendingPathComponent("onboarding-progress.json")
        let onboarding = OnboardingController(mode: OnboardingController.Mode(rawValue: configuration.onboarding ?? "off") ?? .off,
                                              testHooks: configuration.testHooks, progressPath: progressPath)
        self.onboarding = onboarding
        let activity = ActivityCenter()
        self.activity = activity
        let memory = MemoryController(testHooks: configuration.testHooks)
        let modelKeeper = ModelKeeper(configured: configuration.modelURL)
        self.modelKeeper = modelKeeper
        let showModel: () -> Void = { [weak memory, unowned modelKeeper] in
            memory?.showModel(WritingPage.ModelPanel(line: modelKeeper.line, action: modelKeeper.action(menu: false), status: modelKeeper.status))
        }
        modelKeeper.observe(showModel)
        showModel()
        memory.onModel = { [unowned modelKeeper] in modelKeeper.toggle() }
        self.memory = memory
        let perch = PerchController(center: activity, drawsOnScreen: configuration.perchDrawsOnScreen)
        self.perch = perch
        activity.onChange = { perch.refresh() }
        let pageSight = PageSightCoordinator(draws: !configuration.surfacesHeadless)
        self.pageSight = pageSight
        pageSight.paused = { MainActor.assumeIsolated { SettingsStore.shared.settings.paused } }
        pageSight.appOff = { pid in
            NSRunningApplication(processIdentifier: pid)?.bundleIdentifier.map { AppSwitch.shared.isOff(bundleID: $0) } ?? false
        }
        pageSight.sight.onChange = { [weak pageSight] line in
            pageSight?.redraw(line)
            status.update { $0.pageSight = pageSight?.sight.debugInfo }
        }
        // Every helper message takes this route, on main: a line from the helper's socket, and one the
        // debug socket injects (`inject helperLine`), so an injected offer is taken, accepted and
        // reported exactly as a real one.
        let linkedClient = ClientBox()
        let route: @MainActor (HelperInbound, UInt64) -> Void = { message, at in
            activity.receive(message)
            // Where a skill's run with no Tab acts, and which skill it is, come from its record.
            switch message {
            case .activity(let a): surface.activity(a.task)
            case .activityReply(let r): for task in r.tasks { surface.activity(task) }
            default: break
            }
            // Memory is the user's to see and change whatever the gate holds.
            if case .memoryReply(let reply) = message {
                return memory.receive(reply)
            }
            if case .memoryDocumentReply(let reply) = message { return memory.receive(reply) }
            if case .savedFilesReply(let reply) = message { return memory.receive(reply) }
            // A decision is no offer: it says when ambient help may show, which the pause already stops.
            if case .routeDecision(let decision) = message { return routeLink.receive(decision) }
            if case .spend(let spend) = message { return status.update { $0.spend = spend } }
            // L1: this host serves no local model (`LocalText`); every request is answered at once.
            if case .localTextRequest(let request) = message {
                if linkedClient.client?.send(LocalText.unavailable(request)) != true { status.increment("localText.replyUnsent") }
                return
            }
            // H10: which page field the user is in, which the host cannot read itself. Kept whatever the gate says, so a
            // fill that opens later finds the field the user is in now.
            if case .pageField(let field) = message {
                PageFocusSource.book.receive(field)
                fill.pageField(field, at: at)
                // H13: inline text in the field, which follows its own gate (`PageInlineCoordinator.gate`).
                return pageInline.pageField(field)
            }
            if case .pageInsertReply(let reply) = message { return pageInline.replied(reply) }
            // Pause and the roles the host can tell apart (`HostGate`); the perch still
            // hears about work, which the user asked to see.
            guard HostGate.allows(message, SettingsStore.shared.settings) else {
                return status.increment("gate.refused.\(message.typeName)")
            }
            fill.receive(message, at: at)
            switch message {
            case .alternatives, .action, .popup: if let offer = HelperOffer(message) { surface.receive(offer) }
            case .offerWithdrawn(let withdrawn):
                memory.book.withdrawn(withdrawn)
                surface.withdrawn(withdrawn)
                onboarding.receive(withdrawn)
                perch.ask.withdrawn(withdrawn)
            case .taskProgress(let progress):
                surface.taskProgress(progress)
                onboarding.receive(progress)
                perch.ask.receive(progress)
                pageTask.machine.taskProgress(progress)
            // H11: an Ask about a page comes back as a goal; its preview goes to the panel at the form. Every
            // later goal message is the panel's.
            case .goalProgress(let goal):
                if !perch.ask.receive(goal, toForm: { pageTask.machine.start($0) }) { pageTask.machine.receive(goal) }
            case .error(let e):
                pageTask.machine.helperError(e)
                // H13: a fill found nothing because the tab left is a Google editor whose text is off: say so at the field.
                if let app = e.sourceOff { pageInline.sourceOff(app, says: e.message) }
            // S1: keep an answer the user typed; only ⌘1 on the line says yes.
            case .answerSaveOffer(let offer): answerSave.receive(offer)
            case .answerSaveReply(let reply): answerSave.machine.receive(reply)
            // H14: keep a file the user attached; only ⌘1 on the line under the page task panel says yes.
            case .fileSaveOffer(let offer): fileSave.machine.receive(offer, place: pageTask.machine.place(forGoal: offer.goalId))
            case .fileSaveReply(let reply): fileSave.machine.receive(reply)
            case .planProposal(let proposal): perch.ask.receive(proposal)
            case .askQuestion(let question): perch.ask.receive(question)
            case .fileConfirmReply(let reply): perch.ask.receive(reply)
            // An offer the memory row asked for ("Let it run on its own…") is shown there, not at the caret.
            case .skillOffer(let offer): if !memory.book.claim(offer) { surface.skillOffer(offer) }
            case .firstLookReply(let reply): onboarding.receive(reply)
            case .firstLookPreview(let preview): onboarding.receive(preview)
            // Where the noticed facts behind an offer or a plan came from, for its "Not right".
            case .memoryProvenance(let provenance):
                surface.provenance(provenance)
                perch.ask.provenance(provenance)
            // W2: whether Caret can see the front browser's pages.
            case .pageEngine(let m):
                if m.state == .connected { onboarding.browserConnected() }
                pageSight.receive(m)
                status.update { $0.pageSight = pageSight.sight.debugInfo }
            default: break
            }
        }
        // The client reads this on its own thread at each connect, for its hello's capabilities.
        let wantsRouting = OSAllocatedUnfairLock(initialState: SettingsStore.shared.settings.routing)
        // H14: the hello names goalFiles only when this host can fill an attach row both ways (`filesWired`).
        let filesWired = pageTask.machine.filesWired
        helper = HelperClient(path: configuration.helperSocketPath, onMessage: { message in
            let at = DispatchTime.now().uptimeNanoseconds
            DispatchQueue.main.async {
                MainActor.assumeIsolated { route(message, at) }
            }
        }, onLink: { up in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    activity.linkChanged(up)
                    routeLink.linkChanged(up: up, routing: up && (linkedClient.client?.declaresRouting ?? false))
                    memory.linkChanged(up)
                    perch.ask.linkChanged(up)
                    pageTask.machine.linkChanged(up: up)
                    if !up {
                        surface.helperGone()
                        pageSight.sight.helperGone()
                    }
                }
            }
        }, authority: authority, wantsRouting: { wantsRouting.withLock { $0 } }, goalFiles: { filesWired })
        linkedClient.client = helper
        let routeClient = helper
        routeLink.send = { routeClient.send($0) }
        fill.client = helper
        pageTask.client = helper
        answerSave.client = helper
        fileSave.client = helper
        fileSave.onSaved = { memory.savedFiles.refresh() }
        pageInline.client = helper
        pageTask.onToastTaken = {
            surface.toastChanged()
            fill.toastChanged()
            writing.toastChanged()
        }
        // The one-time coach slip under the first ghost text in another app, once onboarding is done.
        let coach = CoachSlip()
        coach.eligible = { [weak onboarding] in SettingsStore.shared.settings.onboarded && onboarding?.coachShown == false }
        coach.onShown = { [weak onboarding] in onboarding?.markCoachShown() }
        overlay.onShown = { caret in coach.ghostShown(caret: caret) }
        overlay.onHidden = { coach.dismiss() }
        let firstLookClient = helper
        let ghostEngine = engine
        onboarding.complete = { text in
            let context = TextFieldContext(beforeCursor: text, afterCursor: "", target: AppTarget(bundleIdentifier: "dev.caret.host", appName: "Caret"))
            guard case .suggestion(let s)? = try? await ghostEngine.suggest(for: context) else { return nil }
            return s.text
        }
        onboarding.modelReadiness = {
            switch ghostEngine.state {
            case .ready: return .ready
            case .loading: return .loading(nil)
            case .unavailable: return .unavailable
            }
        }
        onboarding.sendFirstLook = { firstLookClient.send($0) }
        onboarding.sendPreview = { id, families, level in
            firstLookClient.send(FirstLookPreviewRequest(requestId: id, at: Int64(Date().timeIntervalSince1970 * 1000), families: families, level: level))
        }
        onboarding.sendAccept = { firstLookClient.send($0) }
        onboarding.sendStop = { firstLookClient.send($0) }
        onboarding.sendControl = { firstLookClient.send($0) }
        // Weak across the client: its callbacks hold the memory controller.
        let memoryClient = helper
        memory.send = { [weak memoryClient] in memoryClient?.send($0) ?? false }
        memory.book.sendAnswer = { [weak memoryClient] in memoryClient?.send($0) ?? false }
        memory.sendNotRight = { [weak memoryClient] in memoryClient?.send($0) ?? false }
        memory.sendDocuments = { [weak memoryClient] in memoryClient?.send($0) ?? false }
        memory.sendSavedFiles = { [weak memoryClient] in memoryClient?.send($0) ?? false }
        memory.savedFiles.enabled = { [weak memoryClient] in memoryClient?.declaresGoalFiles ?? false }
        surface.sendNotRight = { [weak memory] id, key, correction, answered in
            memory?.book.notRight(memoryId: id, offerKey: key, correction: correction, answered: answered) ?? false
        }
        perch.onOpenMemory = { [weak memory] in memory?.open() }
        perch.sendNotRight = { [weak memory] id, key, correction, answered in
            memory?.book.notRight(memoryId: id, offerKey: key, correction: correction, answered: answered) ?? false
        }
        memory.book.onEntryChanged = { id in fill.memoryChanged(id) }
        let askClient = helper
        perch.ask.send = { [weak askClient] message in
            guard let askClient else { return false }
            switch message {
            case .plan(let request): return askClient.send(request)
            case .accept(let accept): return askClient.send(accept)
            case .stop(let stop): return askClient.send(stop)
            case .control(let control): return askClient.send(control)
            case .confirmFile(let confirm): return askClient.send(confirm)
            case .answer(let answer): return askClient.send(answer)
            }
        }
        // Caret never searches the disk for a file (lead decision, H11): H5's guess by name in Documents, Downloads and
        // Desktop is gone, so the desk's card leaves an attach to the user. A file comes only from the user's own pick.
        perch.ask.dropSession = { [weak askClient] in askClient?.dropSession() }
        // ⌘Z in the app an Ask run acted in, while its card offers it on screen, as a fill's toast does
        // (q1 bug 8). A run that ends while the list is closed shows no card, so it takes no ⌘Z there
        // (A17 review); closing the list puts an ended card away, which withdraws its offer.
        let askToast = AskToast()
        // Matches the toast to the card's offer and the list's visibility; both can change.
        let syncAskToast = { [weak perch] in
            if let id = askToast.id { arbiter.dismissToast(grantID: id) }
            askToast.id = nil
            guard let perch, let offer = perch.ask.undoOffer, perch.listOpen else { return }
            let target = TargetIdentity(pid: offer.pid, bundleID: "", windowID: "", elementID: "", elementRevision: "")
            askToast.id = arbiter.showToast(UndoGrant.task(offer.taskId, target: target))
            // The arbiter has one toast slot: a fill's or a line's toast that held it is gone now.
            surface.toastChanged()
            fill.toastChanged()
            writing.toastChanged()
            pageTask.machine.toastChanged()
        }
        perch.ask.onUndoChanged = { _ in syncAskToast() }
        perch.onListChanged = { _ in syncAskToast() }
        // The helper's gate holds the same roles, level and pause: sent after every hello and on
        // every change (B10). The client drops a change that leaves all three as they were.
        let gateClient = helper
        gateClient.update(HostSettings(SettingsStore.shared.settings, at: Self.nowMs()))
        arbiter.setGhostKeys(SettingsStore.shared.settings.ghostKeys)
        AppSwitch.shared.update(SettingsStore.shared.settings)
        var appsOff = SettingsStore.shared.settings.appsOff
        // A setting that closes the gate takes down what it no longer allows at once, not only
        // what arrives next (A7 review).
        SettingsStore.shared.observe { settings in
            gateClient.update(HostSettings(settings, at: Self.nowMs()))
            arbiter.setGhostKeys(settings.ghostKeys)
            AppSwitch.shared.update(settings)
            // An app just turned off: what Caret shows there goes now, not at the next keystroke.
            if settings.appsOff != appsOff {
                appsOff = settings.appsOff
                coordinator.gateClosed()
                writing.gateClosed()
                pageInline.gateClosed()
                fill.gateClosed()
                surface.gateClosed()
                pageSight.appSwitchChanged()
            }
            if !HostGate.allowsGhostText(settings) {
                coordinator.gateClosed()
                writing.gateClosed()
                pageInline.gateClosed()
            }
            if !settings.gate.allows(family: "fill") { fill.gateClosed() }
            if settings.paused {
                authority.revokeAll("paused")
                surface.gateClosed()
                pageSight.sight.paused()
            }
        }
        surface.client = helper
        // The fill line, the fill pop-up and a writing fix share the arbiter's one toast slot.
        surface.onToastChanged = {
            fill.toastChanged()
            writing.toastChanged()
            pageTask.machine.toastChanged()
        }
        fill.onToastShown = {
            surface.toastChanged()
            writing.toastChanged()
            pageTask.machine.toastChanged()
        }
        writing.onToastShown = {
            surface.toastChanged()
            fill.toastChanged()
            pageTask.machine.toastChanged()
        }
        activity.client = helper
        let pauseClient = helper
        let writesNothing = configuration.surfacesHeadless
        let pauser = InputPauser(gate: activity.pauseGate) { taskIds, kind in
            for control in InputPause.controls(for: taskIds) { pauseClient.send(control) }
            activity.notePause(taskIds, kind: kind)
        }
        let focusObserver = focus
        tap = TapThread(arbiter: arbiter, callbacks: TapThread.Callbacks(
            claimed: { claim in
                // Before the Tab returns: no key typed after it reaches the app while Caret writes there (a
                // word selected for a fix, offsets approved for an insert). The executor ends the hold.
                if claim.insertsText, !writesNothing { keyHold.begin(pid: claim.offer.target.pid) }
                if claim.insertsText {
                    // A headless host writes nothing: the claim is decided and recorded, never applied.
                    if writesNothing { arbiter.abandon(claimID: claim.claimID, reason: "headless") } else { executor.submit(claim) }
                }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        coordinator.claimed(claim)
                        fill.claimed(claim)
                        surface.claimed(claim)
                        pageTask.machine.claimed(claim)
                        answerSave.machine.claimed(claim)
                        fileSave.machine.claimed(claim)
                        pageInline.claimed(claim)
                        writing.claimed(claim)
                    }
                }
            },
            offerChanged: { reason, key in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        coordinator.offerChanged(reason, key: key)
                        fill.offerChanged(reason)
                        surface.offerChanged(reason)
                        pageTask.machine.offerChanged(reason)
                        answerSave.machine.offerChanged(reason)
                        fileSave.machine.offerChanged(reason)
                        pageInline.offerChanged(reason)
                        writing.offerChanged(reason)
                    }
                }
            },
            undo: { grant in
                if let taskID = grant.taskID {
                    // The helper's executor made these writes and keeps their ledger; it undoes them.
                    // The request goes from main, never from the tap thread, which only enqueues.
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated {
                            // H10: a fill the helper ran for a Tab on a page field, or for ⌘1, is the fill line's.
                            // H11: the page task panel's ⌘Z undoes every task on its page.
                            if pageTask.machine.ownsTask(taskID) { pageTask.machine.undoStarted(grant) } else if perch.ask.ownsUndo(taskID) { perch.ask.undo() } else if fill.ownsTask(taskID) { fill.undoStarted(grant) } else { surface.undoStarted(grant) }
                        }
                    }
                } else {
                    // The same for Caret's own Undo: keys after the ⌘Z wait until its "" is written.
                    if !writesNothing { keyHold.begin(pid: grant.target.pid) }
                    executor.submitUndo(grant)
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated {
                            fill.undoStarted(grant)
                            writing.undoStarted(grant)
                        }
                    }
                }
            },
            keyDown: { status.noteKeyDown($0) },
            navigated: { offerID, ui in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        surface.navigated(offerID: offerID, ui: ui)
                        writing.navigated(offerID: offerID, ui: ui)
                        pageInline.navigated(offerID: offerID, ui: ui)
                    }
                }
            },
            stopWork: { line in
                DispatchQueue.main.async { MainActor.assumeIsolated { if !pageTask.machine.stopWork(line) { surface.stopWork(line) } } }
            },
            realKey: { pid in pauser.key(pid: pid) },
            mouseDown: { point in
                status.noteMouseDown()
                pauser.click(at: point)
            },
            closedOffer: { offerID in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        surface.offerClosed(offerID)
                        writing.offerClosed(offerID)
                        pageTask.machine.offerClosed(offerID)
                        answerSave.machine.offerClosed(offerID)
                        fileSave.machine.offerClosed(offerID)
                        pageInline.offerChanged(.closed)
                    }
                }
            },
            typed: { pid in
                DispatchQueue.main.async { MainActor.assumeIsolated { focusObserver.keyTyped(pid: pid) } }
            },
            rewrite: { pid in
                DispatchQueue.main.async { MainActor.assumeIsolated { writing.requestRewrite(pid: pid) } }
            }
        ), keyHold: keyHold)
        let fixMethods = executor.writeMethods
        writing.fixesStopped = { pid in fixMethods.fixesStopped(pid: pid) }
        let tap = self.tap
        // Accessibility granted in onboarding: a key tap the system refused at launch is made now.
        onboarding.onPermissionsChanged = { granted in
            // Never before the grant: an active tap asked for without it raises macOS's alert (startTapWhenTrusted).
            if granted.accessibility, AXIsProcessTrusted(), !tap.restartIfRefused() { status.increment("tap.createFailed") }
        }
        let helper = self.helper
        let writeMethods = executor.writeMethods
        let testHooks = configuration.testHooks
        let servicesBox = self.servicesBox
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
            memory: { words in MainActor.assumeIsolated { memory.command(words) } },
            services: { words in MainActor.assumeIsolated { Self.servicesCommand(words, services: servicesBox.services, testHooks: testHooks) } },
            pageSight: { words in
                MainActor.assumeIsolated {
                    // `pagesight front <pid>`: as if <pid> came to the front, for a headless run with no window (test hooks).
                    if words.count == 3, words[1] == "front" {
                        guard testHooks else { return #"{"error":"pagesight front is a test hook: start the host with --test-hooks"}"# }
                        guard let pid = Int32(words[2]), pid > 0 else { return #"{"error":"usage: pagesight front <pid>"}"# }
                        pageSight.frontmostChanged(pid)
                    } else if words.count != 1 {
                        return #"{"error":"usage: pagesight | pagesight front <pid>"}"#
                    }
                    let encoder = JSONEncoder()
                    encoder.outputFormatting = [.sortedKeys]
                    var info = (try? String(decoding: encoder.encode(pageSight.sight.debugInfo), as: UTF8.self)) ?? "{}"
                    if info.hasSuffix("}") { info.removeLast(); info += ",\"onScreen\":\(pageSight.onScreen)}" }
                    return info
                }
            },
            pageTask: { json in
                MainActor.assumeIsolated {
                    if let json {
                        guard testHooks else { return #"{"error":"pagetask start is a test hook: start the host with --test-hooks"}"# }
                        do {
                            let goal = try JSONDecoder().decode(GoalProgress.self, from: Data(json.utf8))
                            guard pageTask.machine.start(goal) else { return #"{"error":"not a page goal's preview, or a page task is running"}"# }
                        } catch {
                            return "{\"error\":\(Self.jsonString(String(describing: error)))}"
                        }
                    }
                    pageTask.publish()
                    let encoder = JSONEncoder()
                    encoder.outputFormatting = [.sortedKeys]
                    return (try? String(decoding: encoder.encode(status.read().pageTask), as: UTF8.self)) ?? "{}"
                }
            },
            pageTaskClicks: { gated in
                MainActor.assumeIsolated {
                    guard testHooks else { return #"{"error":"pagetask clicks is a test hook: start the host with --test-hooks"}"# }
                    pageTask.setGatesPointer(gated)
                    return #"{"ok":true}"#
                }
            },
            testHooks: testHooks,
            access: configuration.socketAccess
        )
        socket = DebugStateSocket(path: configuration.socketPath, privateDirectory: configuration.socketInCaretsFolder) { command in
            Self.respond(to: command, arbiter: arbiter, status: status, tap: tap, helper: helper, writeMethods: writeMethods, hooks: hooks)
        }
        surface.onWorkingChanged = { [weak self] working in
            guard let self else { return }
            self.surfaceWorking = working
            self.onWorkingChanged?(working || self.perch.lit)
            self.rehelloForRouting()
        }
        perch.onLitChanged = { [weak self] lit in
            guard let self else { return }
            self.onWorkingChanged?(self.surfaceWorking || lit)
            self.rehelloForRouting()
        }
        // "Caret decides when to help" (H6): ghost text and the writing line follow the change at
        // once; the helper hears it with the next hello.
        SettingsStore.shared.observe { [weak self] settings in
            guard let self, settings.routing != self.routeLink.follower.enabled else { return }
            wantsRouting.withLock { $0 = settings.routing }
            self.routeLink.setEnabled(settings.routing)
            self.rehelloForRouting()
        }
    }

    /// Throws when another host already serves the socket; the caller should exit rather than run
    /// a second key tap.
    /// True while accepted work runs at the caret, or work runs, waits or needs the user in another
    /// window (the perch's subject): the menu bar glyph is Carrot (DIRECTION.md 5.10).
    /// The helper's connection says hello again when its `routing` no longer matches the setting:
    /// at once when no work Caret accepted is live, else when it ends (closing the connection
    /// revokes what the session accepted, B22).
    private func rehelloForRouting() {
        guard helper.snapshot().connected, helper.declaresRouting != routeLink.follower.enabled else {
            rehelloTimer?.invalidate()
            rehelloTimer = nil
            return
        }
        // Work at the caret, or a task in the activity list (an Ask's run included), lights one of
        // these. Work accepted moments ago may not have its activity record yet (H6 review): it
        // counts as live for `rehelloAcceptGrace` seconds. Looked at again every few seconds.
        let justAccepted = helper.lastAcceptAt.map { Date().timeIntervalSince($0) < Self.rehelloAcceptGrace } ?? false
        if surfaceWorking || perch.lit || justAccepted {
            status.increment("routing.rehelloDeferred")
            if rehelloTimer == nil {
                rehelloTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated { self?.rehelloForRouting() }
                }
            }
            return
        }
        rehelloTimer?.invalidate()
        rehelloTimer = nil
        status.increment("routing.rehello")
        helper.dropSession()
    }

    public var onWorkingChanged: ((Bool) -> Void)? {
        didSet { onWorkingChanged?(surfaceWorking || perch.lit) }
    }
    private var surfaceWorking = false

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

    /// The menu's "Turn on Accessibility…": the switch step on its own, with the panel in System Settings.
    public func openAccessSwitch() { onboarding.openAccess() }

    /// The menu's "Jev is off. Add a key…": the key step on its own.
    public func openJevKeyStep() { onboarding.openKey() }

    /// The key step's keychain, check and helper restart (H12), from the app shell's services. Set before `start`, which
    /// is when onboarding first opens.
    public func useJevKeys(_ services: CaretServices, transport: JevKeyTransport = URLSessionJevKeyTransport()) {
        let keys = services.jevKeys
        onboarding.jevKey = OnboardingController.JevKeyHooks(
            available: { [weak services] in services?.jevKeyAvailable ?? true },
            stored: { keys?.exists() ?? false },
            check: { await JevKeyCheck.check($0, transport: transport) },
            save: { key in
                guard let keys else { return false }
                do {
                    try keys.save(key)
                    return true
                } catch {
                    FileHandle.standardError.write(Data("caret: \(error)\n".utf8))
                    return false
                }
            },
            saved: { [weak services] in services?.reloadJevKey() }
        )
    }

    /// Add to your browser, which the app shell runs (`ChromeBridgeInstaller`), from the page line ("Caret can't see
    /// this page yet"). Onboarding no longer asks for it; it is offered at first need.
    /// The login item waits for the end of onboarding (`CaretServices.registersAfterOnboarding`); `due` hands off.
    public func deferLoginItem(_ later: @escaping () -> Bool, due: @escaping () -> Void) {
        onboarding.registersLoginItemLater = later
        onboarding.onLoginItemDue = due
    }

    public var onAddToChrome: () -> Void {
        get { pageSight.onAddToChrome }
        set {
            pageSight.onAddToChrome = newValue
            onboarding.onAddToBrowser = newValue
        }
    }

    /// The menu's What Caret Knows: the memory window.
    public func openMemory() { memory.open() }

    /// Brief item 8, for the menu: the line naming the model file in use, the download's item (nil when there is
    /// nothing to offer) and its status.
    public var modelLine: String { modelKeeper.line }
    public var modelAction: String? { modelKeeper.action(menu: true) }
    public var modelStatus: String? { modelKeeper.status }
    /// Starts Caret's model download, or stops the one running. Only ever from a user's choice.
    public func toggleModelDownload() { modelKeeper.toggle() }

    /// The key tap is made only once Caret has Accessibility. Asking macOS for an active keyboard tap without it raises
    /// the "would like to control this computer" alert by itself, before onboarding has said a word (PX1's VM baseline,
    /// ~/.caret-run/evidence/access/p1-run/out/shots/009-stuck-welcome.png).
    ///
    /// Trust is watched for the whole run, not only during onboarding: Sam's beta ran 3.5 hours untrusted with its tap
    /// refused and said nothing. Every 2 s (and 250 ms after macOS announces an Accessibility change) the host reads
    /// `AXIsProcessTrusted`. When it turns true, the tap is made again; while trusted but the tap is still missing or
    /// disabled, it retries on each read. The menu shows both states (`accessibilityTrusted`, `keyTapHealthy`).
    public private(set) var accessibilityTrusted = false
    public private(set) var keyTapHealthy = true
    /// Called on main when either of the two changes.
    public var onTrustChanged: (() -> Void)?
    private var axObserver: NSObjectProtocol?

    private func startTapWhenTrusted() {
        checkTrust()
        trustPoll = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkTrust() }
        }
        axObserver = DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.apple.accessibility.api"), object: nil, queue: .main) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { MainActor.assumeIsolated { self?.checkTrust() } }
        }
    }

    private func checkTrust() {
        let trusted = AXIsProcessTrusted()
        let wasTrusted = accessibilityTrusted
        accessibilityTrusted = trusted
        var healthy = keyTapHealthy
        if trusted {
            if !wasTrusted {
                // A grant given (or given back): a tap refused or disabled while untrusted is made afresh.
                tap.stop()
            }
            if !tap.isEnabled {
                if tap.restartIfRefused(), tap.isEnabled {
                    healthy = true
                } else {
                    tap.stop()
                    healthy = tap.start() && tap.isEnabled
                    if !healthy { status.increment("tap.createFailed") }
                }
            } else {
                healthy = true
            }
        }
        if trusted != wasTrusted || healthy != keyTapHealthy {
            keyTapHealthy = healthy
            onTrustChanged?()
        }
    }

    public func start() throws {
        try socket.start()
        AXRead.setGlobalMessagingTimeout(seconds: 0.25)
        startTapWhenTrusted()
        InputMethodState.shared.start()
        // The perch no longer follows focus: it sits on the task's window (v3 rim and perch).
        focus.onNote = { [status] in status.increment($0) }
        focus.onChange = { [coordinator, writing] change in
            coordinator.handle(change)
            writing.handle(change)
        }
        focus.start()
        helper.start()
        let lockClient = helper
        sessionLock = SessionLockWatch { lockClient.send(SessionLocked(at: Self.nowMs(), why: $0)) }
        onboarding.launch()
        let modelFile = configuration.modelURL.lastPathComponent
        guard configuration.ghostEnabled else {
            engine.disable()
            status.update { $0.engine = DebugState.Engine(state: "disabled", modelFile: modelFile) }
            return
        }
        if configuration.testHooks, let path = configuration.ghostReplayPath {
            do {
                let replay = try JSONDecoder().decode(GhostReplay.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
                engine.useReplay(replay)
                status.update { $0.engine = DebugState.Engine(state: "replay", modelFile: URL(fileURLWithPath: path).lastPathComponent) }
                focus.requestRead()
            } catch {
                engine.disable()
                status.update { $0.engine = DebugState.Engine(state: "replayUnreadable", modelFile: path) }
            }
            return
        }
        status.update { $0.engine = DebugState.Engine(state: "loading", modelFile: modelFile) }
        let modelURL = configuration.modelURL
        let profileDirectory = configuration.profileDirectory
        engineTask = Task { [weak self] in
            guard let self else { return }
            await self.engine.load(modelURL: modelURL, profileDirectory: profileDirectory)
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
        pageTask.shutdown()
        answerSave.shutdown()
        fileSave.shutdown()
        pageInline.shutdown()
        writing.shutdown()
        perch.shutdown()
        pageSight.shutdown()
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
        /// `services` and `services restart` (`servicesCommand`).
        let services: @Sendable ([String]) -> String
        /// `pagesight` and `pagesight front <pid>` (H5: "Caret can't see this page yet").
        let pageSight: @Sendable ([String]) -> String
        /// H14: `pagetask` reads the page task panel; `pagetask start <goalProgress json>` starts it from a preview as the
        /// desk's Ask would (test hooks), for a run with no model to plan the page.
        let pageTask: @Sendable (String?) -> String
        /// `pagetask clicks gated|always` (test hooks): `HostedPanel.gatesPointer`.
        let pageTaskClicks: @Sendable (Bool) -> String
        /// The host was started with `--test-hooks`.
        let testHooks: Bool
        /// What the socket answers at all; checked before anything else (H12).
        let access: DebugSocketAccess
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
            case "cmd-z": return state(["consumed": ask.undo()])
            default: return #"{"error":"usage: ask key tab|esc|cmd-z"}"#
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
    ///   perch-avoid                    refused: v3 has no corner perch to move aside (it sits on the task's window)
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
            // v3 (U2): the perch sits on the window its task works in, never in a screen corner by the
            // caret, so there is no field for it to avoid. Said, rather than accepted and ignored.
            return #"{"error":"perch-avoid no longer applies: the perch sits on the task's window (rim and perch, v3)"}"#
        default:
            return #"{"error":"unknown command"}"#
        }
    }

    /// The services, over the debug socket. Main thread.
    ///
    ///   services            the helper's and the reader's state, restarts and the bridge (`CaretServices.report`)
    ///   services restart    the menu's Restart after Caret stopped (test hooks)
    static func servicesCommand(_ words: [String], services: CaretServices?, testHooks: Bool) -> String {
        guard let services else { return #"{"error":"no services: the app shell did not start any"}"# }
        guard words.count > 1 else { return services.report() }
        guard words[1] == "restart" else { return #"{"error":"usage: services [restart]"}"# }
        guard testHooks else { return #"{"error":"services restart is a test hook: start the host with --test-hooks"}"# }
        guard services.stoppedReason != nil else { return #"{"error":"the services are not stopped"}"# }
        services.restart()
        return services.report()
    }

    /// Why the debug socket refuses `words`, or nil. Commands that act for the user need `--test-hooks`: `key` routes a
    /// key through the tap to the claim and undo callbacks, `control` presses a row's button, `click` clicks in an app,
    /// and `settings set` changes the user's settings. The socket is the user's own (mode 0600), but any process of the
    /// user's can open it, and the host now runs at every login (CodeRabbit on PR #9). Reads stay open.
    nonisolated static func testHookRefusal(_ words: [String], testHooks: Bool) -> String? {
        guard !testHooks, let verb = words.first else { return nil }
        let name: String
        switch verb {
        case "key", "control", "click": name = verb
        case "settings" where words.count > 1 && words[1] == "set": name = "settings set"
        default: return nil
        }
        return "{\"error\":\"\(name) is a test hook: start the host with --test-hooks\"}"
    }

    /// A release build's whole socket (H12): `state` as `ReleaseState`, `spend`, and a refusal for everything else.
    /// `state` and `spend` are read only when asked for. Socket thread.
    nonisolated static func releaseReply(to words: [String], state: () -> DebugState, spend: () -> HelperSpend?) -> Data {
        if let refusal = DebugSocketAccess.release.refusal(words) { return Data((refusal + "\n").utf8) }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let body: Data?
        switch words.first ?? "state" {
        case "spend": body = spend().flatMap { try? encoder.encode($0) }
        default: body = try? encoder.encode(ReleaseState(state()))
        }
        return (body ?? Data("{}".utf8)) + Data("\n".utf8)
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
        if hooks.access == .release {
            return releaseReply(to: words, state: {
                var state = makeState(arbiter: arbiter, status: status, tap: tap, helper: helper, writeMethods: writeMethods)
                let running = DispatchQueue.main.sync { NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier) }
                let others = OtherTabOwners.running(in: running)
                state.otherTabOwners = others.isEmpty ? nil : others
                return state
            }, spend: { status.read().spend })
        }
        if let refusal = testHookRefusal(words, testHooks: hooks.testHooks) { return Data((refusal + "\n").utf8) }
        switch words.first ?? "state" {
        case "ping":
            return Data("{\"ok\":true}\n".utf8)
        case "latency-reset":
            status.latency.reset()
            status.breakpointLatency.reset()
            status.proposalToOffer.reset()
            status.focusToOffer.reset()
            return Data("{\"ok\":true}\n".utf8)
        case "key":
            // Test hook: `key <name> <pid>` routes a constructed key-down, headed for <pid>, through
            // the same arbiter and callbacks as the event tap. No event is posted anywhere.
            guard words.count == 3, let pid = Int32(words[2]), let key = TestKeys.key(words[1], pid: pid) else {
                return Data("{\"error\":\"usage: key \(TestKeys.names) <pid>\"}\n".utf8)
            }
            let disposition = tap.routeKey(key, fromHook: true)
            // The tap's callbacks post to main; wait for them, so the next read sees their effect.
            DispatchQueue.main.sync {}
            // plainTab: the tap would pass this key on as a plain Tab (Cotypist's ⌥Tab).
            return Data("{\"ok\":true,\"consumed\":\(disposition == .consume),\"plainTab\":\(disposition == .passAsPlainTab)}\n".utf8)
        case "writemethod":
            // Test hook: `writemethod <pid> pastePid|axSelectedText` sets how that app takes writes,
            // so an acceptance run can drive the pasteboard route in an app that takes AX writes.
            guard hooks.testHooks else { return Data("{\"error\":\"writemethod is a test hook: start the host with --test-hooks\"}\n".utf8) }
            guard words.count == 3, let pid = Int32(words[1]), let method = WriteMethodTable.Method(rawValue: words[2]) else {
                return Data("{\"error\":\"usage: writemethod <pid> pastePid|axSelectedText\"}\n".utf8)
            }
            writeMethods.record(method, for: WriteMethodTable.appKey(pid: pid))
            return Data("{\"ok\":true}\n".utf8)
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
        case "services":
            let reply = DispatchQueue.main.sync { hooks.services(words) }
            return Data((reply + "\n").utf8)
        case "pagesight":
            let reply = DispatchQueue.main.sync { hooks.pageSight(words) }
            return Data((reply + "\n").utf8)
        case "pagetask" where words.count == 3 && words[1] == "clicks" && ["gated", "always"].contains(words[2]):
            let reply = DispatchQueue.main.sync { hooks.pageTaskClicks(words[2] == "gated") }
            return Data((reply + "\n").utf8)
        case "pagetask":
            // `pagetask start <json>` carries JSON with spaces; keep it whole after the verb.
            let parts = command.split(separator: " ", maxSplits: 2).map(String.init)
            guard words.count == 1 || (parts.count == 3 && parts[1] == "start") else { return Data("{\"error\":\"usage: pagetask | pagetask start <goalProgress json>\"}\n".utf8) }
            let reply = DispatchQueue.main.sync { hooks.pageTask(parts.count == 3 ? parts[2] : nil) }
            return Data((reply + "\n").utf8)
        case "placement-bounds":
            let reply = DispatchQueue.main.sync { hooks.placementBounds(words) }
            return Data((reply + "\n").utf8)
        case "perch", "activity", "control", "click", "perch-avoid":
            let reply = DispatchQueue.main.sync { hooks.perch(words) }
            return Data((reply + "\n").utf8)
        case "spend":
            // H8's ledger as the helper last sent it: counts, tokens and dollars only.
            let spend = status.read().spend
            return ((spend.flatMap { try? encoder.encode($0) }) ?? Data("{}".utf8)) + Data("\n".utf8)
        case "state":
            var state = makeState(arbiter: arbiter, status: status, tap: tap, helper: helper, writeMethods: writeMethods)
            state.surface = DispatchQueue.main.sync { hooks.surface() }
            state.calendar = DispatchQueue.main.sync {
                MainActor.assumeIsolated {
                    let calendars = EventKitCalendars.shared
                    return DebugState.CalendarInfo(calendars.destination(choice: SurfaceCoordinator.savedCalendarChoice()), access: calendars.access)
                }
            }
            let running = DispatchQueue.main.sync { NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier) }
            let others = OtherTabOwners.running(in: running)
            state.otherTabOwners = others.isEmpty ? nil : others
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
            // H13: a page field's inline text and what was typed through it are the page's text; never shown here.
            let shown = PageInline.debugText(offer, typed: arbiterState.typedSinceOffer)
            var info = DebugState.OfferInfo(
                id: offer.id,
                text: shown.text,
                typedSinceOffer: shown.typed,
                ageMs: Date().timeIntervalSince(offer.createdAt) * 1_000,
                pid: offer.target.pid,
                bundleID: offer.target.bundleID,
                caretUTF16: offer.caretUTF16,
                elementRevision: shown.revision,
                presentation: offer.kind == .ghost && offer.source == .engine ? fields.presentation : offer.kind.name
            )
            info.kind = offer.kind.name
            info.fill = offer.kind.fillOrigin.map {
                DebugState.FillInfo(proposalId: $0.proposalID, windowId: $0.windowID, fieldKey: $0.fieldKey, source: $0.sourceCaption)
            }
            info.writing = offer.kind.writing.map(DebugState.WritingOfferInfo.init)
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
        if let authority = helper.authority {
            let info = authority.debugInfo
            state.authorityRevokes = info.revokes
            state.authorityLastRevoke = info.lastReason
        }
        state.ghostFits = fields.ghostFits
        state.ghostHold = fields.ghostHold
        state.writing = fields.writing
        state.pageSight = fields.pageSight
        state.routing = fields.routing
        state.spend = fields.spend
        state.pageInline = fields.pageInline
        state.pageTask = fields.pageTask
        state.fileSave = fields.fileSave
        state.breakpointLatency = status.breakpointLatency.summary()
        return state
    }
}

/// The helper client, for callbacks made before the runtime holds it.
private final class ClientBox: @unchecked Sendable {
    weak var client: HelperClient?
}

/// Keys the debug socket's test hook can route.
enum TestKeys {
    static let names = "tab|shift-tab|opt-right|opt-tab|above-tab|esc|up|down|left|right|return|space|cmd-z|cmd-1|cmd-2|cmd-3|char:<c>"

    static func key(_ name: String, pid: Int32) -> KeyStroke? {
        switch name {
        case "tab": return .tab(to: pid)
        case "shift-tab": return KeyStroke(keyCode: KeyStroke.tabKeyCode, shift: true, targetPID: pid)
        case "opt-right": return KeyStroke(keyCode: KeyStroke.rightKeyCode, option: true, targetPID: pid)
        case "opt-tab": return KeyStroke(keyCode: KeyStroke.tabKeyCode, option: true, targetPID: pid)
        // The ANSI key above Tab; the hook does not ask which keyboard this Mac has.
        case "above-tab": return KeyStroke(keyCode: KeyStroke.graveKeyCode, text: "`", targetPID: pid)
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

/// The arbiter's toast an Ask run's ⌘Z holds, if any.
@MainActor
private final class AskToast {
    var id: UInt64?
}

/// Holds the app shell's services for the debug socket hook, which is built before the shell sets them. Main thread.
final class ServicesBox: @unchecked Sendable {
    var services: CaretServices?
}
