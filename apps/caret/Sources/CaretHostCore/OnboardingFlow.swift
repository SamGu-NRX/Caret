import CaretScreenCore
import Foundation

/// The five screens of onboarding, in order (`SURFACES.md` section 7, reordered by the A7 brief:
/// how you want to work comes before permissions, so the permission screen can say what the
/// chosen help needs).
public enum OnboardingStep: String, CaseIterable, Codable, Sendable {
    case welcome, work, permissions, tryIt, firstLook

    public var index: Int { Self.allCases.firstIndex(of: self)! }
}

/// The grants onboarding asks for, as the host reads them.
public struct OnboardingPermissions: Codable, Equatable, Sendable {
    /// `AXIsProcessTrusted()`: required. Caret reads the field and the windows around it, and the
    /// key tap that takes Tab needs it.
    public var accessibility: Bool
    /// `CGPreflightListenEventAccess()`: the listen-only mouse tap that pauses Caret's work on a
    /// click. Optional; asked only when it is missing.
    public var inputMonitoring: Bool

    public init(accessibility: Bool, inputMonitoring: Bool) {
        self.accessibility = accessibility
        self.inputMonitoring = inputMonitoring
    }
}

/// The staged try-it: a sample source window Caret draws itself, and one empty field it offers a
/// value for. Synthetic content only.
public enum TryItSample {
    public static let sourceApp = "Mail"
    public static let sourceTitle = "Invoice 2041"
    public static let sender = "Northline"
    public static let fieldLabel = "Amount"
    public static let value = "$1,240.00"
    /// The line by the field, as a real fill names its source (`FillOrigin.sourceCaption`).
    public static var caption: String { "from \(sourceApp), \(sourceTitle)" }
}

/// A key on an onboarding screen that takes keys: the try-it's staged field, and the first look's
/// offer and its line. Only the keys a step cares about are named.
public enum TryItKey: Equatable, Sendable {
    case tab
    case character(String)
    case delete
    case returnKey
    case escape
    /// ⌘1 to ⌘3: the first look's action bound to that digit.
    case commandDigit(Int)
    /// ⌘Z on the first look's fill result.
    case undo
    case other
}

/// Onboarding as a pure state machine: each screen's transitions, the choices it writes to
/// settings, the try-it that completes only on a real Tab, and the first look's request, reply
/// and timeout. The window (`OnboardingWindow`) draws `state` and turns clicks and keys into
/// `Event`s; the debug socket sends the same events while the window is hidden. Time comes from a
/// `SurfaceClock`, so the auto-advance and the first look's deadline take no real time in tests.
///
/// Not thread-safe: the app calls it on the main thread only, and its clock fires there.
public final class OnboardingFlow {
    public enum Direction: String, Codable, Sendable { case forward, back }

    public enum FirstLookState: Equatable, Sendable {
        /// Not asked yet in this visit to the step.
        case idle
        case asking(requestId: String)
        case found(FirstLookReply.Found)
        case nothing
        /// The look could not run, timed out or came back malformed; the reason is for the debug
        /// state, never shown as is.
        case failed(String)
    }

    public struct TryIt: Equatable, Sendable {
        /// What the staged field holds.
        public var value = ""
        /// A Tab took the offer. Sticky: typing afterwards does not undo it.
        public var completed = false
        /// The user typed while the offer was up, so it went away ("typing says no").
        public var declined = false
        /// Tab presses that reached the field, taken or not.
        public var tabs = 0

        /// The ghost value shows while the field is empty and nothing has been taken.
        public var offerVisible: Bool { !completed && value.isEmpty }
    }

    public struct State: Equatable, Sendable {
        public var step: OnboardingStep = .welcome
        public var direction: Direction = .forward
        public var roles: Set<CaretRole>
        public var level: CaretLevel
        public var permissions: OnboardingPermissions
        /// The Input Monitoring row: shown when it was missing as the screen opened, and kept
        /// (reading On) once granted, so the screen does not jump.
        public var showsInputMonitoring = false
        /// A grant appeared and every shown row is on: the screen moves on by itself shortly.
        public var advancingAfterGrant = false
        public var tryIt = TryIt()
        public var firstLook: FirstLookState = .idle
        /// The first look's offer, taken: its work and result (`FirstLookRun`).
        public var firstLookRun: FirstLookRun?
        public var finished = false

        public var canContinue: Bool {
            switch step {
            case .welcome: return true
            case .work: return !roles.isEmpty
            case .permissions: return permissions.accessibility
            case .tryIt: return tryIt.completed
            case .firstLook: return true
            }
        }

        public var canGoBack: Bool { step != .welcome }
    }

    public enum Event: Equatable, Sendable {
        /// Continue, or Return.
        case next
        /// Back, or Esc.
        case back
        case toggleRole(CaretRole)
        case setRole(CaretRole, Bool)
        case setLevel(CaretLevel)
        /// The host read the grants again (it polls while the window is up).
        case permissions(OnboardingPermissions)
        case openSystemSettings(Pane)
        case key(TryItKey)
        case firstLookReply(FirstLookReply)
        /// Progress of the first look's taken offer, whose task id is its key.
        case taskProgress(TaskProgress)
        /// A message for the taken offer could not be written: the helper is not connected.
        case sendFailed(SendFailure)
        /// The request could not be written: the helper is not connected.
        case firstLookUnsent
        case lookAgain
        /// The settings changed outside the flow (the menu's Pause). Roles and level stay the
        /// flow's own; the rest applies to what it asks for next.
        case settingsChanged(CaretSettings)
    }

    public enum Pane: String, Codable, Sendable { case accessibility, inputMonitoring }

    public enum SendFailure: Equatable, Sendable { case accept, undo }

    public enum Command: Equatable, Sendable {
        /// Write the choices to settings (`SettingsStore`, source `onboarding`).
        case saveChoices(roles: Set<CaretRole>, level: CaretLevel, onboarded: Bool)
        case openSystemSettings(Pane)
        case askFirstLook(FirstLookRequest)
        /// Take the first look's offer: the helper runs it as the task named by its key.
        case accept(OfferAccept)
        case stop(OfferStop)
        /// ⌘Z on the first look's fill result.
        case undo(TaskControl)
        /// The staged value went in: the field flashes the Carrot wash once.
        case filled
        /// The flow is done; close the window.
        case close
        /// The state changed; redraw and republish.
        case changed
    }

    /// How long the screen shows the new check mark before it moves on. Assumed: long enough to
    /// read "On", short enough not to wait on it.
    public static let advanceAfterGrant: TimeInterval = 0.6
    /// Grace after the request's own deadline before the host gives up on the reply.
    public static let firstLookGrace: TimeInterval = 1

    let clock: SurfaceClock
    /// The settings the flow started from: pause and anything else it does not ask about still
    /// apply to what it requests (the first look's families).
    private(set) var base: CaretSettings
    /// Names this flow in its first-look request ids, so a late reply to an earlier flow (closed
    /// and opened again) never matches a request of this one.
    let token: String
    public internal(set) var state: State
    public var output: (Command) -> Void = { _ in }
    private var advanceTimer: SurfaceTimer?
    /// The taken offer's figure and seconds timers.
    var runTimers: [SurfaceTimer] = []
    private var firstLookTimer: SurfaceTimer?
    private var requests = 0
    private var asked: FirstLookRequest?

    public init(settings: CaretSettings, permissions: OnboardingPermissions, clock: SurfaceClock, token: String = "1") {
        self.clock = clock
        base = settings
        self.token = token
        state = State(roles: settings.roles, level: settings.level, permissions: permissions)
    }

    var nowMs: Int64 { Int64((clock.now.timeIntervalSince1970 * 1000).rounded()) }

    /// Cancels every timer the flow has scheduled. The window calls it when it drops an unfinished
    /// flow, whose repeating timers would otherwise outlive it.
    public func cancelTimers() {
        advanceTimer?.cancel()
        advanceTimer = nil
        firstLookTimer?.cancel()
        firstLookTimer = nil
        endRunTimers()
    }

    // MARK: - Events

    public func send(_ event: Event) {
        guard !state.finished else { return }
        switch event {
        case .next: next()
        case .back: back()
        case .toggleRole(let role):
            guard state.step == .work else { return }
            if state.roles.contains(role) { state.roles.remove(role) } else { state.roles.insert(role) }
        case .setRole(let role, let on):
            guard state.step == .work else { return }
            if on { state.roles.insert(role) } else { state.roles.remove(role) }
        case .setLevel(let level):
            guard state.step == .work else { return }
            state.level = level
        case .permissions(let p): permissionsChanged(p)
        case .openSystemSettings(let pane):
            guard state.step == .permissions else { return }
            output(.openSystemSettings(pane))
        case .key(let key):
            switch state.step {
            case .tryIt: tryItKey(key)
            case .firstLook: firstLookKey(key)
            case .welcome, .work, .permissions: return
            }
        case .firstLookReply(let reply): firstLookReplied(reply)
        case .taskProgress(let progress): firstLookProgress(progress)
        case .sendFailed(let what): firstLookUnsent(what)
        case .firstLookUnsent:
            guard case .asking = state.firstLook else { return }
            failFirstLook("helperNotConnected")
        case .lookAgain:
            guard state.step == .firstLook, case .failed = state.firstLook else { return }
            askFirstLook()
        case .settingsChanged(let settings):
            base = settings
        }
        output(.changed)
    }

    func next() {
        guard state.canContinue else { return }
        switch state.step {
        case .welcome: go(to: .work, .forward)
        case .work:
            // The choices count from here, even if onboarding stops before its end.
            output(.saveChoices(roles: state.roles, level: state.level, onboarded: false))
            go(to: .permissions, .forward)
        case .permissions: go(to: .tryIt, .forward)
        case .tryIt: go(to: .firstLook, .forward)
        case .firstLook: finish()
        }
    }

    func back() {
        switch state.step {
        case .welcome: return
        case .work: go(to: .welcome, .back)
        case .permissions: go(to: .work, .back)
        case .tryIt: go(to: .permissions, .back)
        case .firstLook: go(to: .tryIt, .back)
        }
    }

    func go(to step: OnboardingStep, _ direction: Direction) {
        leave(state.step)
        state.step = step
        state.direction = direction
        switch step {
        case .permissions:
            state.showsInputMonitoring = state.showsInputMonitoring || !state.permissions.inputMonitoring
        case .firstLook:
            askFirstLook()
        case .welcome, .work, .tryIt:
            break
        }
    }

    func leave(_ step: OnboardingStep) {
        switch step {
        case .permissions:
            advanceTimer?.cancel()
            advanceTimer = nil
            state.advancingAfterGrant = false
        case .firstLook:
            // A reply after leaving is for a look nobody is watching. A taken offer's run goes on
            // in the helper; the activity list reports it from here.
            firstLookTimer?.cancel()
            firstLookTimer = nil
            asked = nil
            state.firstLook = .idle
            endRunTimers()
            state.firstLookRun = nil
        case .welcome, .work, .tryIt:
            break
        }
    }

    func finish() {
        leave(state.step)
        state.finished = true
        output(.saveChoices(roles: state.roles, level: state.level, onboarded: true))
        output(.close)
    }

    // MARK: - Permissions

    func permissionsChanged(_ p: OnboardingPermissions) {
        let before = state.permissions
        state.permissions = p
        guard state.step == .permissions else { return }
        let appeared = (p.accessibility && !before.accessibility) || (p.inputMonitoring && !before.inputMonitoring)
        let allShownOn = p.accessibility && (!state.showsInputMonitoring || p.inputMonitoring)
        let revoked = (!p.accessibility && before.accessibility) || (!p.inputMonitoring && before.inputMonitoring && state.showsInputMonitoring)
        if !p.accessibility || (revoked && !allShownOn) {
            // A grant taken back while the screen is up: stay.
            advanceTimer?.cancel()
            advanceTimer = nil
            state.advancingAfterGrant = false
            return
        }
        guard appeared, allShownOn, advanceTimer == nil else { return }
        state.advancingAfterGrant = true
        advanceTimer = clock.schedule(after: Self.advanceAfterGrant, repeats: false) { [weak self] in
            guard let self else { return }
            self.advanceTimer = nil
            self.state.advancingAfterGrant = false
            let now = self.state.permissions
            if self.state.step == .permissions, now.accessibility, !self.state.showsInputMonitoring || now.inputMonitoring {
                self.go(to: .tryIt, .forward)
            }
            self.output(.changed)
        }
    }

    // MARK: - Try it

    /// Only a Tab takes the offer, and only while it is visible: Return, Continue, typing and
    /// clicks never complete the step.
    func tryItKey(_ key: TryItKey) {
        guard state.step == .tryIt else { return }
        switch key {
        case .tab:
            state.tryIt.tabs += 1
            guard state.tryIt.offerVisible else { return }
            state.tryIt.value = TryItSample.value
            state.tryIt.completed = true
            output(.filled)
        case .character(let text):
            if state.tryIt.offerVisible { state.tryIt.declined = true }
            state.tryIt.value += text
        case .delete:
            if !state.tryIt.value.isEmpty { state.tryIt.value.removeLast() }
        case .returnKey: next()
        case .escape: back()
        case .commandDigit, .undo, .other: break
        }
    }

    // MARK: - First look

    func askFirstLook() {
        firstLookTimer?.cancel()
        requests += 1
        var settings = base
        settings.roles = state.roles
        settings.level = state.level
        let request = FirstLookRequest(
            requestId: "first-look-\(token)-\(requests)", at: nowMs,
            families: FirstLookRequest.families(for: settings), level: state.level
        )
        asked = request
        state.firstLook = .asking(requestId: request.requestId)
        guard !request.families.isEmpty else {
            // Words only, or paused: there is nothing for the helper to run.
            asked = nil
            state.firstLook = .nothing
            return
        }
        let wait = Double(request.deadlineMs) / 1000 + Self.firstLookGrace
        firstLookTimer = clock.schedule(after: wait, repeats: false) { [weak self] in
            guard let self, case .asking(let id) = self.state.firstLook, id == request.requestId else { return }
            self.firstLookTimer = nil
            self.failFirstLook("timedOut")
            self.output(.changed)
        }
        output(.askFirstLook(request))
    }

    func firstLookReplied(_ reply: FirstLookReply) {
        guard let asked, case .asking(let id) = state.firstLook, id == reply.requestId, id == asked.requestId else { return }
        firstLookTimer?.cancel()
        firstLookTimer = nil
        self.asked = nil
        switch reply.outcome {
        case .found:
            guard let found = reply.found, asked.families.contains(found.family) else {
                return failFirstLook("familyNotRequested")
            }
            state.firstLook = .found(found)
        case .nothing:
            state.firstLook = .nothing
        case .error:
            state.firstLook = .failed(reply.error ?? "error")
        }
    }

    func failFirstLook(_ reason: String) {
        firstLookTimer?.cancel()
        firstLookTimer = nil
        asked = nil
        state.firstLook = .failed(reason)
    }

    // MARK: - Debug state

    public func debugInfo() -> DebugState.OnboardingInfo {
        var info = DebugState.OnboardingInfo(
            step: state.step.rawValue, stepIndex: state.step.index, roles: CaretRole.allCases.filter(state.roles.contains).map(\.rawValue),
            level: state.level.rawValue, canContinue: state.canContinue, finished: state.finished
        )
        info.permissions = state.permissions
        info.showsInputMonitoring = state.showsInputMonitoring
        info.advancingAfterGrant = state.advancingAfterGrant ? true : nil
        info.tryIt = DebugState.OnboardingInfo.TryItInfo(
            value: state.tryIt.value, offerVisible: state.tryIt.offerVisible, completed: state.tryIt.completed,
            declined: state.tryIt.declined, tabs: state.tryIt.tabs
        )
        switch state.firstLook {
        case .idle: info.firstLook = "idle"
        case .asking(let id): info.firstLook = "asking"; info.firstLookRequest = id
        case .found(let found):
            info.firstLook = "found"
            info.firstLookKind = found.kind.rawValue
            info.firstLookTitle = found.title
            let keys = state.firstLookKeys
            info.firstLookKeys = (keys.tab ? ["tab"] : []) + keys.digits.sorted().map { "cmd-\($0)" }
                + (keys.undo ? ["cmd-z"] : []) + (keys.stop ? ["esc"] : [])
            if let run = state.firstLookRun {
                info.firstLookRun = run.phase.name
                info.firstLookLine = run.line(character: .pebble)?.text
            }
        case .nothing: info.firstLook = "nothing"
        case .failed(let reason): info.firstLook = "failed"; info.firstLookError = reason
        }
        return info
    }
}
