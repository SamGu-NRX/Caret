import CaretScreenCore
import Foundation

/// The six screens of onboarding, in order (`SURFACES.md` section 7, reordered by the A7 brief:
/// how you want to work comes before permissions, so the permission screen can say what the
/// chosen help needs). `know` is the Fable plan's minute two, "What I know so far" (A11): the
/// first view of memory, typed by hand. It is shown only when the helper says it keeps typed
/// values (`State.showsKnow`); until then nothing would keep them, so the step is skipped.
/// `jevKey` (H12) asks for the key of Jev, the cloud model the helper asks; it shows when Caret has no key yet
/// (`State.showsJevKey`), and the menu's "Jev is off" opens it on its own.
public enum OnboardingStep: String, CaseIterable, Codable, Sendable {
    case welcome, work, know, permissions, jevKey, tryIt, firstLook

    public var index: Int { Self.allCases.firstIndex(of: self)! }
}

/// Text that must not reach a log or a debug reply by accident: printing it, interpolating it or dumping the value
/// that holds it shows only its length. `reveal` is the one way to read it.
public struct SecretText: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    private let value: String
    public init(_ value: String) { self.value = value }
    public var reveal: String { value }
    public var isEmpty: Bool { value.isEmpty }
    public var utf16Count: Int { value.utf16.count }
    public var description: String { "<secret, \(value.utf16.count) chars>" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: ["length": value.utf16.count]) }
}

/// When onboarding opens at launch (H12, lead decision 2).
public enum OnboardingLaunch {
    /// What `--onboarding` or `CARET_ONBOARDING` gives when neither is set: `auto` for the user's own Caret, `off` for
    /// a run that named its own home or settings, which is a test run (scripts that predate H12 name neither flag
    /// and must not get a window on a shared Mac).
    public static func defaultMode(homeOverridden: Bool, settingsNamed: Bool) -> String {
        homeOverridden || settingsNamed ? "off" : "auto"
    }

    public enum Opening: Equatable, Sendable {
        /// Every step, from the first.
        case all
        /// One step on its own: Continue on it finishes.
        case only(OnboardingStep)
    }

    /// `auto` at launch: the whole flow until it has been finished once; after that only the permissions step, and only
    /// while Accessibility, which Caret cannot work without, is off. Input Monitoring is optional, so its absence alone
    /// opens nothing.
    public static func auto(onboarded: Bool, permissions: OnboardingPermissions) -> Opening? {
        if !onboarded { return .all }
        return permissions.accessibility ? nil : .only(.permissions)
    }
}

/// The two values onboarding asks for by hand (no Contacts in A11).
public enum AboutField: String, CaseIterable, Codable, Sendable {
    case name, email

    /// The About-you label the helper stores it under.
    public var label: String {
        switch self {
        case .name: return "Name"
        case .email: return "Email"
        }
    }
}

/// What the user typed on the `know` screen.
public struct AboutDraft: Equatable, Sendable {
    public var name = ""
    public var email = ""
    /// Continue was pressed with a problem; the problem shows until the next keystroke.
    public var showsProblem = false
    /// What Continue last handed to memory, by label, so Back and Continue again sends only a
    /// change.
    public var kept: [String: String] = [:]

    public init() {}

    public subscript(field: AboutField) -> String {
        get { field == .name ? name : email }
        set { if field == .name { name = newValue } else { email = newValue } }
    }

    /// Why Continue cannot keep these, in words; nil when it can. Empty is fine: the step can be
    /// skipped. Lengths follow the helper's About value limit (500).
    public var problem: String? { check?.text }

    /// The field the problem is about, so focus can go there.
    public var problemField: AboutField? { check?.field }

    private var check: (field: AboutField, text: String)? {
        let n = name.trimmed, e = email.trimmed
        if n.utf16.count > 500 { return (.name, "That name is too long.") }
        if !e.isEmpty && !Self.looksLikeEmail(e) { return (.email, "That email looks incomplete.") }
        if e.utf16.count > 500 { return (.email, "That email is too long.") }
        return nil
    }

    /// Something@something.something, no spaces. A check for typos, not a validator.
    static func looksLikeEmail(_ s: String) -> Bool {
        guard !s.contains(where: \.isWhitespace) else { return false }
        let parts = s.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty else { return false }
        let domain = parts[1]
        guard let dot = domain.lastIndex(of: "."), dot != domain.startIndex, domain.index(after: dot) != domain.endIndex else { return false }
        return true
    }

    /// The values Continue would keep that differ from what was kept already.
    public var toKeep: [TypedAbout] {
        AboutField.allCases.compactMap { f in
            let v = self[f].trimmed
            guard !v.isEmpty, kept[f.label] != v else { return nil }
            return TypedAbout(label: f.label, value: v)
        }
    }
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

    /// The key step's field and what the check said. The pasted text is held only until it is saved: a saved key lives
    /// in the login keychain, not here.
    public struct JevKeyDraft: Equatable, Sendable {
        public enum Phase: Equatable, Sendable {
            case editing
            /// The text has spaces inside it, so it is not a key; nothing was sent.
            case malformed
            case checking
            /// What Jev's answer meant, and, for an answer that keeps the key, whether the keychain took it.
            case checked(JevKeyCheck.Outcome, saved: Bool)

            public var name: String {
                switch self {
                case .editing: return "editing"
                case .malformed: return "malformed"
                case .checking: return "checking"
                case .checked(let outcome, let saved):
                    switch outcome {
                    case .works: return saved ? "works" : "notSaved"
                    case .noCredits: return saved ? "noCredits" : "notSaved"
                    case .rejected: return "rejected"
                    case .unreachable: return "unreachable"
                    case .unclear(let status): return "unclear\(status)"
                    }
                }
            }

            /// The key is in the keychain after this check.
            public var saved: Bool {
                if case .checked(let outcome, let saved) = self { return saved && outcome.keepsKey }
                return false
            }
        }

        public var text = SecretText("")
        public var phase = Phase.editing
        /// Continue presses that sent a check or found the text was no key: each one gives the field focus again.
        public var submits = 0
        /// A key was in the keychain when the flow opened, or the check saved one.
        public var stored = false

        public init(stored: Bool = false) { self.stored = stored }
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
        public var about = AboutDraft()
        /// The `know` step is in the flow: the helper said it accepts `memoryRequest` op `add`
        /// (`MemoryBook.State.acceptsAdd`). Without that, what is typed there would be kept by nothing.
        public var showsKnow = false
        public var tryIt = TryIt()
        /// Running apps that also take Tab for their own completions (`OtherTabOwners`), by name.
        /// The try-it step says so, since their Tab can reach the app before Caret's does.
        public var otherTabOwners: [String] = []
        public var firstLook: FirstLookState = .idle
        /// The first look's offer, taken: its work and result (`FirstLookRun`).
        public var firstLookRun: FirstLookRun?
        public var finished = false
        /// The `jevKey` step is in the flow: Caret had no Jev key when the flow opened.
        public var showsJevKey = false
        public var jevKey = JevKeyDraft()
        /// The flow shows this one step and finishes when it is done (`OnboardingLaunch.Opening.only`).
        public var only: OnboardingStep?

        public var canContinue: Bool {
            switch step {
            case .welcome: return true
            case .work: return !roles.isEmpty
            // A problem is shown when Continue is pressed, not by greying the button while the
            // user is still typing.
            case .know: return true
            case .permissions: return permissions.accessibility
            // An empty field continues without a key; a filled one is checked first.
            case .jevKey: return jevKey.phase != .checking
            case .tryIt: return tryIt.completed
            case .firstLook: return true
            }
        }

        public var canGoBack: Bool { step != .welcome && only == nil }

        /// The steps this flow shows, in order: every step but `know` while the helper keeps no
        /// typed values, and but `jevKey` while Caret has a key. The step dots count these.
        public var steps: [OnboardingStep] {
            if let only { return [only] }
            return OnboardingStep.allCases.filter {
                ($0 != .know || showsKnow || step == .know) && ($0 != .jevKey || showsJevKey || step == .jevKey)
            }
        }

        /// The current step's place among `steps`.
        public var stepIndex: Int { steps.firstIndex(of: step) ?? step.index }
    }

    public enum Event: Equatable, Sendable {
        /// Continue, or Return.
        case next
        /// Back, or Esc.
        case back
        case toggleRole(CaretRole)
        case setRole(CaretRole, Bool)
        case setLevel(CaretLevel)
        /// A keystroke in the name or email field: the field's whole text.
        case setAbout(AboutField, String)
        /// Skip on the `know` screen: what was typed is not kept.
        case skip
        /// The host read the grants again (it polls while the window is up).
        case permissions(OnboardingPermissions)
        case openSystemSettings(Pane)
        /// Add to Chrome on the permissions screen (H4): the host explains, then installs on the user's yes.
        case addToChrome
        case key(TryItKey)
        case firstLookReply(FirstLookReply)
        /// Progress of the first look's taken offer, whose task id is its key.
        case taskProgress(TaskProgress)
        /// A message for the taken offer could not be written: the helper is not connected.
        case sendFailed(SendFailure)
        /// The request could not be written: the helper is not connected.
        case firstLookUnsent
        case lookAgain
        /// The helper withdrew an offer (`offerWithdrawn`); the flow acts on its found one only.
        case offerWithdrawn(OfferWithdrawn)
        /// The settings changed outside the flow (the menu's Pause). Roles and level stay the
        /// flow's own; the rest applies to what it asks for next.
        case settingsChanged(CaretSettings)
        /// What the helper's last memory list said about keeping typed values. The `know` step
        /// joins or leaves the flow; a user already on it stays there.
        case knowAvailable(Bool)
        /// The host read the running apps that also take Tab (`OtherTabOwners.running`).
        case otherTabOwners([String])
        /// A change in the key field: its whole text.
        case setJevKey(String)
        /// The host checked the key with Jev and, when the answer keeps it, tried to save it (`saved`).
        case jevKeyChecked(JevKeyCheck.Outcome, saved: Bool)
    }

    public enum Pane: String, Codable, Sendable { case accessibility, inputMonitoring }

    public enum SendFailure: Equatable, Sendable { case accept, undo }

    public enum Command: Equatable, Sendable {
        /// Write the choices to settings (`SettingsStore`, source `onboarding`).
        case saveChoices(roles: Set<CaretRole>, level: CaretLevel, onboarded: Bool)
        /// Hand typed values to memory (`MemoryBook.remember`), which keeps them through the helper.
        case remember([TypedAbout])
        /// Skip after an earlier Continue: drop the values for these labels not kept yet
        /// (`MemoryBook.dropTyped(labels:)`).
        case forgetTyped([String])
        case openSystemSettings(Pane)
        /// Start Add to your browser (`ChromeBridgeInstaller`). Never sent at launch, only on the user's click.
        case addToChrome
        /// Check this key with Jev; on an answer that keeps it, save it to the keychain and start the helper again with
        /// it. The host answers with `jevKeyChecked`.
        case checkJevKey(SecretText)
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

    /// `jevKeyStored`: a key is in the keychain. `jevKeyAvailable`: the helper has a key from anywhere (the keychain, or
    /// a development run's environment); without one the flow shows the key step. `only`: show that step alone.
    public init(settings: CaretSettings, permissions: OnboardingPermissions, clock: SurfaceClock, token: String = "1", showsKnow: Bool = false,
                jevKeyAvailable: Bool = true, jevKeyStored: Bool = false, only: OnboardingStep? = nil) {
        self.clock = clock
        base = settings
        self.token = token
        state = State(roles: settings.roles, level: settings.level, permissions: permissions)
        state.showsKnow = showsKnow
        state.showsJevKey = !jevKeyAvailable
        state.jevKey = JevKeyDraft(stored: jevKeyStored)
        state.only = only
        if let only { go(to: only, .forward) }
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
        case .setAbout(let field, let text):
            guard state.step == .know else { return }
            state.about[field] = text
            state.about.showsProblem = false
        case .skip where state.step == .jevKey:
            guard state.jevKey.phase != .checking else { return }
            state.jevKey.text = SecretText("")
            state.jevKey.phase = .editing
            leaveJevKey()
        case .skip:
            guard state.step == .know else { return }
            state.about.name = ""
            state.about.email = ""
            state.about.showsProblem = false
            // An earlier Continue may have handed values over: Skip means keep none of them.
            if !state.about.kept.isEmpty {
                output(.forgetTyped(Array(state.about.kept.keys).sorted()))
                state.about.kept = [:]
            }
            go(to: .permissions, .forward)
        case .permissions(let p): permissionsChanged(p)
        case .openSystemSettings(let pane):
            guard state.step == .permissions else { return }
            output(.openSystemSettings(pane))
        case .addToChrome:
            guard state.step == .permissions else { return }
            output(.addToChrome)
        case .key(let key):
            switch state.step {
            case .tryIt: tryItKey(key)
            case .firstLook: firstLookKey(key)
            case .welcome, .work, .know, .permissions, .jevKey: return
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
        case .offerWithdrawn(let withdrawn): firstLookWithdrawn(withdrawn)
        case .settingsChanged(let settings):
            base = settings
        case .knowAvailable(let available):
            state.showsKnow = available
        case .otherTabOwners(let names):
            guard state.otherTabOwners != names else { return }
            state.otherTabOwners = names
        case .setJevKey(let text):
            // The field is disabled while a check runs; a change that arrives anyway waits for the answer.
            guard state.step == .jevKey, state.jevKey.phase != .checking else { return }
            state.jevKey.text = SecretText(text)
            state.jevKey.phase = .editing
        case .jevKeyChecked(let outcome, let saved):
            jevKeyChecked(outcome, saved: saved)
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
            go(to: state.showsKnow ? .know : .permissions, .forward)
        case .know:
            guard state.about.problem == nil else {
                state.about.showsProblem = true
                return
            }
            let keep = state.about.toKeep
            if !keep.isEmpty {
                for item in keep { state.about.kept[item.label] = item.value }
                output(.remember(keep))
            }
            go(to: .permissions, .forward)
        case .permissions: leavePermissions()
        case .jevKey: jevKeyNext()
        case .tryIt: go(to: .firstLook, .forward)
        case .firstLook: finish()
        }
    }

    func back() {
        guard state.only == nil else { return }
        switch state.step {
        case .welcome: return
        case .work: go(to: .welcome, .back)
        case .know: go(to: .work, .back)
        case .permissions: go(to: state.showsKnow ? .know : .work, .back)
        case .jevKey:
            guard state.jevKey.phase != .checking else { return }
            go(to: .permissions, .back)
        case .tryIt: go(to: state.showsJevKey ? .jevKey : .permissions, .back)
        case .firstLook: go(to: .tryIt, .back)
        }
    }

    /// Past the permissions step: the key step when Caret has no key, else the try-it; a flow showing the permissions
    /// step alone finishes.
    func leavePermissions() {
        if state.only == .permissions { return finish() }
        go(to: state.showsJevKey ? .jevKey : .tryIt, .forward)
    }

    func leaveJevKey() {
        if state.only == .jevKey { return finish() }
        go(to: .tryIt, .forward)
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
        case .welcome, .work, .know, .jevKey, .tryIt:
            break
        }
    }

    func leave(_ step: OnboardingStep) {
        switch step {
        case .permissions, .jevKey:
            advanceTimer?.cancel()
            advanceTimer = nil
            state.advancingAfterGrant = false
            guard step == .jevKey else { break }
            // A key is held here only until it is saved or the step is left.
            state.jevKey.text = SecretText("")
            if !state.jevKey.phase.saved { state.jevKey.phase = .editing }
        case .firstLook:
            // A reply after leaving is for a look nobody is watching. A taken offer's run goes on
            // in the helper; the activity list reports it from here.
            firstLookTimer?.cancel()
            firstLookTimer = nil
            asked = nil
            state.firstLook = .idle
            endRunTimers()
            state.firstLookRun = nil
        case .welcome, .work, .know, .tryIt:
            break
        }
    }

    // MARK: - Jev key

    /// Continue on the key step. An empty field goes on without a key (Caret runs without Jev and the menu says so); a
    /// saved key goes on; anything else is checked first, and the host's answer decides.
    func jevKeyNext() {
        let draft = state.jevKey
        if draft.phase.saved || draft.text.isEmpty { return leaveJevKey() }
        switch draft.phase {
        case .checking: return
        case .editing, .malformed, .checked:
            state.jevKey.submits += 1
            guard let key = JevKeyCheck.cleaned(draft.text.reveal) else {
                state.jevKey.phase = .malformed
                return
            }
            state.jevKey.phase = .checking
            output(.checkJevKey(SecretText(key)))
        }
    }

    func jevKeyChecked(_ outcome: JevKeyCheck.Outcome, saved: Bool) {
        guard state.step == .jevKey, state.jevKey.phase == .checking else { return }
        state.jevKey.phase = .checked(outcome, saved: saved)
        guard outcome.keepsKey, saved else { return }
        state.jevKey.stored = true
        state.jevKey.text = SecretText("")
        // A key that works moves on by itself, as a grant does; one with no credits stays so its line can be read.
        guard outcome == .works, advanceTimer == nil else { return }
        state.advancingAfterGrant = true
        advanceTimer = clock.schedule(after: Self.advanceAfterGrant, repeats: false) { [weak self] in
            guard let self else { return }
            self.advanceTimer = nil
            self.state.advancingAfterGrant = false
            if self.state.step == .jevKey, self.state.jevKey.phase.saved { self.leaveJevKey() }
            self.output(.changed)
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
                self.leavePermissions()
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
            step: state.step.rawValue, stepIndex: state.stepIndex, roles: CaretRole.allCases.filter(state.roles.contains).map(\.rawValue),
            level: state.level.rawValue, canContinue: state.canContinue, finished: state.finished
        )
        info.permissions = state.permissions
        info.showsKnow = state.showsKnow
        info.stepCount = state.steps.count
        info.about = Dictionary(uniqueKeysWithValues: AboutField.allCases.map { ($0.rawValue, state.about[$0].utf16.count) })
        info.aboutProblem = state.about.showsProblem ? state.about.problem : nil
        info.showsInputMonitoring = state.showsInputMonitoring
        info.advancingAfterGrant = state.advancingAfterGrant ? true : nil
        info.otherTabOwners = state.otherTabOwners.isEmpty ? nil : state.otherTabOwners
        info.showsJevKey = state.showsJevKey
        info.only = state.only?.rawValue
        if state.steps.contains(.jevKey) {
            info.jevKey = state.jevKey.phase.name
            info.jevKeyLength = state.jevKey.text.utf16Count
            info.jevKeyStored = state.jevKey.stored
        }
        info.tryIt = DebugState.OnboardingInfo.TryItInfo(
            valueLength: state.tryIt.value.utf16.count, isSample: state.tryIt.value == TryItSample.value, offerVisible: state.tryIt.offerVisible, completed: state.tryIt.completed,
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
                info.firstLookLine = run.line()?.text
            }
        case .nothing: info.firstLook = "nothing"
        case .failed(let reason): info.firstLook = "failed"; info.firstLookError = reason
        }
        return info
    }
}
