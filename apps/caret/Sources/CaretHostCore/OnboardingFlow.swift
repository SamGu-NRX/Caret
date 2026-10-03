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

/// What a key does in the staged field. Only the keys the step cares about are named.
public enum TryItKey: Equatable, Sendable {
    case tab
    case character(String)
    case delete
    case returnKey
    case escape
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
        /// The request could not be written: the helper is not connected.
        case firstLookUnsent
        case lookAgain
    }

    public enum Pane: String, Codable, Sendable { case accessibility, inputMonitoring }

    public enum Command: Equatable, Sendable {
        /// Write the choices to settings (`SettingsStore`, source `onboarding`).
        case saveChoices(roles: Set<CaretRole>, level: CaretLevel, onboarded: Bool)
        case openSystemSettings(Pane)
        case askFirstLook(FirstLookRequest)
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
    public private(set) var state: State
    public var output: (Command) -> Void = { _ in }
    private var advanceTimer: SurfaceTimer?
    private var firstLookTimer: SurfaceTimer?
    private var requests = 0
    private var asked: FirstLookRequest?

    public init(settings: CaretSettings, permissions: OnboardingPermissions, clock: SurfaceClock) {
        self.clock = clock
        state = State(roles: settings.roles, level: settings.level, permissions: permissions)
    }

    var nowMs: Int64 { Int64((clock.now.timeIntervalSince1970 * 1000).rounded()) }

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
        case .key(let key): tryItKey(key)
        case .firstLookReply(let reply): firstLookReplied(reply)
        case .firstLookUnsent:
            guard case .asking = state.firstLook else { return }
            failFirstLook("helperNotConnected")
        case .lookAgain:
            guard state.step == .firstLook, case .failed = state.firstLook else { return }
            askFirstLook()
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
            // A reply after leaving is for a look nobody is watching.
            firstLookTimer?.cancel()
            firstLookTimer = nil
            asked = nil
            state.firstLook = .idle
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
        if !p.accessibility {
            // A grant taken back while the screen is up: stay.
            advanceTimer?.cancel()
            advanceTimer = nil
            state.advancingAfterGrant = false
            return
        }
        guard appeared, allShownOn, advanceTimer == nil else { return }
        state.advancingAfterGrant = true
        advanceTimer = clock.schedule(after: Self.advanceAfterGrant, repeats: false) { [weak self] in
            guard let self, self.state.step == .permissions, self.state.permissions.accessibility else { return }
            self.advanceTimer = nil
            self.state.advancingAfterGrant = false
            self.go(to: .tryIt, .forward)
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
        case .other: break
        }
    }

    // MARK: - First look

    func askFirstLook() {
        firstLookTimer?.cancel()
        requests += 1
        var settings = CaretSettings()
        settings.roles = state.roles
        settings.level = state.level
        let request = FirstLookRequest(
            requestId: "first-look-\(requests)", at: nowMs,
            families: FirstLookRequest.families(for: settings), level: state.level
        )
        asked = request
        state.firstLook = .asking(requestId: request.requestId)
        guard !request.families.isEmpty else {
            // Words only: there is nothing for the helper to run.
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
        case .nothing: info.firstLook = "nothing"
        case .failed(let reason): info.firstLook = "failed"; info.firstLookError = reason
        }
        return info
    }
}
