import CaretScreenCore
import Foundation

/// Onboarding's four steps (~/.caret-run/design/onboard2/HANDOFF.md §1). Everything before the switch needs no
/// permission, and everything after it happens by itself:
/// - `hello`: the person types into Caret's own field and the local model offers the next words. Turn on Caret.
/// - `access`: System Settings is open, with the panel to drag Caret into its list; the flow waits for the switch.
/// - `browser`: optional, "Add Caret to your browser": the native host is written and the extension's page opened;
///   the first connection from the extension moves the flow on by itself.
/// - `on`: what is now on, and, before anything leaves the Mac, the lines a first look may send. Send, or keep.
/// - `first`: what the first look found, taken with Tab, or nothing.
public enum OnboardingStep: String, CaseIterable, Codable, Sendable {
    case hello, access, browser, on, first

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

/// When onboarding opens at launch (H12, lead decision 2), and where.
public enum OnboardingLaunch {
    /// What `--onboarding` or `CARET_ONBOARDING` gives when neither is set: `auto` for the user's own Caret, `off` for
    /// a run that named its own home or settings, which is a test run (scripts that predate H12 name neither flag
    /// and must not get a window on a shared Mac).
    public static func defaultMode(homeOverridden: Bool, settingsNamed: Bool) -> String {
        homeOverridden || settingsNamed ? "off" : "auto"
    }

    public struct Opening: Equatable, Sendable {
        public var step: OnboardingStep
        /// Caret opened again partway through (`OnboardingProgress`): the switch step says the switch is still off
        /// rather than introducing itself.
        public var reopened: Bool
        /// The flow is this one step and finishes when it is done: a person who finished onboarding and later lost
        /// Accessibility, or the menu's "Jev is off".
        public var alone: Bool

        public init(step: OnboardingStep, reopened: Bool = false, alone: Bool = false) {
            self.step = step
            self.reopened = reopened
            self.alone = alone
        }
    }

    /// `auto` at launch. Not finished: Accessibility already on opens at `on` (granted earlier, or Caret relaunched
    /// after the grant, so no welcome again); a recorded step past `hello` (a relaunch, or Set up later) reopens at the
    /// switch; else `hello`. Finished: only the switch, alone, while Accessibility is off. Input Monitoring is not
    /// asked here at all.
    public static func auto(onboarded: Bool, permissions: OnboardingPermissions, progress: OnboardingProgress?) -> Opening? {
        if onboarded { return permissions.accessibility ? nil : Opening(step: .access, alone: true) }
        if permissions.accessibility {
            // Relaunched on the browser step: back there; otherwise straight to what is on.
            return Opening(step: progress?.step == .browser ? .browser : .on, reopened: progress != nil)
        }
        if let progress, progress.step != .hello { return Opening(step: .access, reopened: true) }
        return Opening(step: .hello)
    }
}

/// How far onboarding got, written at every step change so a relaunch (macOS's own, a crash, or the person quitting
/// halfway) resumes where it was. One small file in Caret's home; no settings key, so the settings schema is untouched.
public struct OnboardingProgress: Codable, Equatable, Sendable {
    public var step: OnboardingStep
    /// Milliseconds since the epoch.
    public var at: Int64
    /// The one-time coach slip at the first ghost text in another app has been shown (HANDOFF §3, After).
    public var coachShown: Bool
    /// The roles the person had before onboarding held the cloud ones (`CaretRole` raw values), until they send the
    /// first look or keep everything on the Mac. Nil when nothing is held.
    public var heldRoles: [String]?

    public init(step: OnboardingStep, at: Int64, coachShown: Bool = false, heldRoles: [String]? = nil) {
        self.step = step
        self.at = at
        self.coachShown = coachShown
        self.heldRoles = heldRoles
    }

    /// A file that is missing, unreadable or of another shape reads as no progress: onboarding starts at the
    /// beginning, which is safe.
    public static func decode(_ data: Data?) -> OnboardingProgress? {
        guard let data else { return nil }
        return try? JSONDecoder().decode(OnboardingProgress.self, from: data)
    }

    public func encoded() -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(self)) ?? Data()
    }
}

/// The grants onboarding reads. Only Accessibility moves the flow; Input Monitoring is read for the host's own tap
/// retry and is asked for, if ever, at first need (v2/access).
public struct OnboardingPermissions: Codable, Equatable, Sendable {
    /// `AXIsProcessTrusted()`.
    public var accessibility: Bool
    /// `CGPreflightListenEventAccess()`.
    public var inputMonitoring: Bool

    public init(accessibility: Bool, inputMonitoring: Bool) {
        self.accessibility = accessibility
        self.inputMonitoring = inputMonitoring
    }
}

/// Whether the local writing model can answer the Hello field yet.
public enum ModelReadiness: Equatable, Sendable {
    case ready
    /// Loading; the fraction done when the loader reports one.
    case loading(Double?)
    /// No model on this Mac, or it failed to load: the field is off and says so.
    case unavailable

    public var name: String {
        switch self {
        case .ready: return "ready"
        case .loading: return "loading"
        case .unavailable: return "unavailable"
        }
    }
}

/// An app the Hello line names (`HelloApps`).
public struct HelloApp: Equatable, Sendable {
    public var bundleId: String
    public var name: String

    public init(bundleId: String, name: String) {
        self.bundleId = bundleId
        self.name = name
    }
}

/// What the `on` step shows before anything leaves the Mac: per window, the lines the first look may send and
/// placeholders for the lines that stay. The host builds it from the helper's `FirstLookPreview`; placeholders carry no
/// text, so this type cannot show what stays.
public struct OnboardingPreview: Equatable, Sendable {
    public struct Line: Equatable, Sendable {
        /// Nil for a line that stays on the Mac; the screen draws it as a hatch bar.
        public var text: String?

        public init(text: String?) { self.text = text }
    }

    public struct Window: Equatable, Sendable {
        public var bundleId: String
        public var appName: String
        public var title: String
        public var lines: [Line]
        public var chars: Int

        public init(bundleId: String, appName: String, title: String, lines: [Line], chars: Int) {
            self.bundleId = bundleId
            self.appName = appName
            self.title = title
            self.lines = lines
            self.chars = chars
        }
    }

    public var previewId: String
    public var windows: [Window]
    /// At most this many characters may go (the helper's allow-list; a look may send fewer).
    public var chars: Int

    public init(previewId: String, windows: [Window], chars: Int) {
        self.previewId = previewId
        self.windows = windows
        self.chars = chars
    }
}

/// A key on an onboarding screen that takes keys: the Hello field and the first step's offer and its line. Only the keys
/// a step cares about are named.
public enum TryItKey: Equatable, Sendable {
    case tab
    case returnKey
    case escape
    /// ⌘1 to ⌘3: the first look's action bound to that digit.
    case commandDigit(Int)
    /// ⌘Z on the first look's result.
    case undo
    case other
}

/// Onboarding as a pure state machine. The window (`OnboardingWindow`) draws `state` and turns clicks and keys into
/// `Event`s; the debug socket sends the same events while the window is hidden. Time comes from a `SurfaceClock`, so
/// the Hello field's idle wait, the grant's landing and the first look's deadline take no real time in tests.
///
/// Not thread-safe: the app calls it on the main thread only, and its clock fires there.
public final class OnboardingFlow {
    public enum Direction: String, Codable, Sendable { case forward, back }

    /// The window's frame: the main 640×660 window, or the 420×392 guide beside System Settings on `access`.
    public enum Frame: String, Sendable { case main, guide }

    public enum FirstLookState: Equatable, Sendable {
        case idle
        case asking(requestId: String)
        case found(FirstLookReply.Found)
        case nothing
        /// The look could not run, timed out or came back malformed; the reason is for the debug state only.
        case failed(String)
    }

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
        /// Continue presses that sent a check or found the text was no key: each gives the field focus again.
        public var submits = 0
        /// A key was in the keychain when the flow opened, or the check saved one.
        public var stored = false

        public init(stored: Bool = false) { self.stored = stored }
    }

    public struct Hello: Equatable, Sendable {
        /// The field's text. Never logged or sent to the debug socket (its length is).
        public var text = ""
        /// The local model's next words for `text`, shown after the caret; nil while none.
        public var ghost: String?
        public var model: ModelReadiness = .loading(nil)
        public var apps: [HelloApp] = []
        /// A Tab took a ghost here: the coach line says so, and the `first` step's nothing state does not ask for
        /// typing again.
        public var taken = false
        /// The completion asked for and not yet answered; a later answer for an older id is dropped.
        public var asking: String?
    }

    public struct Access: Equatable, Sendable {
        public var granted = false
        /// Caret opened again with the switch still off.
        public var reopened = false
        /// "Caret isn't in the list?" is open.
        public var helpOpen = false
        /// System Settings was opened for the switch (`openSystemSettings`).
        public var alertShown = false
    }

    public enum PreviewState: Equatable, Sendable {
        case idle
        case building(requestId: String)
        case ready(OnboardingPreview)
        /// Nothing on screen may go.
        case empty
        case failed(String)
    }

    public enum Decision: String, Equatable, Sendable { case pending, sent, kept }

    public struct On: Equatable, Sendable {
        public var preview: PreviewState = .idle
        public var decision: Decision = .pending
        /// The preview the person sent: a look asked again (the offer was withdrawn) stays inside it.
        public var sentPreviewId: String?
        /// The cloud model needs a key and Caret has none (H12's draft, unchanged).
        public var needsKey = false
        public var jevKey = JevKeyDraft()
    }

    /// macOS's Calendar prompt around the first event accepted here (H8).
    public enum CalendarAsk: Equatable, Sendable { case asking, denied }

    public struct First: Equatable, Sendable {
        public var look: FirstLookState = .idle
        /// The found offer, taken: its work and result (`FirstLookRun`).
        public var run: FirstLookRun?
        public var calendar: CalendarAsk?
        /// Esc or Not now on the found offer.
        public var declined = false
    }

    /// The browser step: which installed browsers Caret's bridge can serve, whether the extension's page was opened,
    /// and whether the extension has connected.
    public struct Browser: Equatable, Sendable {
        /// Installed browsers the bridge trusts, by name, the default browser first.
        public var trusted: [String] = []
        /// Installed Chromium browsers the bridge does not trust yet, by name.
        public var untrusted: [String] = []
        public var opened = false
        public var connected = false

        public var target: String? { trusted.first }
    }

    public struct State: Equatable, Sendable {
        public var step: OnboardingStep
        public var direction: Direction = .forward
        public var hello = Hello()
        public var access = Access()
        public var browser = Browser()
        public var on = On()
        public var first = First()
        public var permissions: OnboardingPermissions
        /// Settings' roles and level: not asked in onboarding any more; they decide the first look's families.
        public var roles: Set<CaretRole>
        public var level: CaretLevel
        /// Running apps that also take Tab (`OtherTabOwners`): their Tab can reach the Hello field first.
        public var otherTabOwners: [String] = []
        /// This step only; finishing it finishes the flow (`OnboardingLaunch.Opening.alone`).
        public var alone = false
        public var finished = false

        public var frame: Frame { step == .access ? .guide : .main }

        /// The primary button is enabled.
        public var canContinue: Bool {
            switch step {
            case .hello: return true
            // The switch moves the flow by itself; the guide has no primary.
            case .access: return false
            case .browser: return true
            case .on:
                if on.jevKey.phase == .checking { return false }
                // With a key needed, the primary checks a pasted key first; it waits for text.
                let keyReady = !on.needsKey || on.jevKey.stored
                if alone { return keyReady || !on.jevKey.text.isEmpty }
                switch on.decision {
                case .sent: return false
                case .kept: return true
                case .pending:
                    switch on.preview {
                    case .idle, .building: return false
                    case .ready: return keyReady || !on.jevKey.text.isEmpty
                    case .empty, .failed: return true
                    }
                }
            case .first:
                // Done closes the window even while a taken offer works: the run goes on in the helper and the
                // activity list reports it.
                if case .asking = first.look { return false }
                return true
            }
        }

        public var steps: [OnboardingStep] { alone ? [step] : OnboardingStep.allCases }
        public var stepIndex: Int { steps.firstIndex(of: step) ?? step.index }
    }

    public enum Event: Equatable, Sendable {
        /// The primary: Turn on Caret, Send these and look, Done; or Return.
        case next
        /// Set up later, on `hello` and `access`.
        case setUpLater
        /// The Hello field's whole text after a change.
        case typed(String)
        /// The local model answered the completion asked as `requestId`; nil for no offer.
        case ghost(requestId: String, text: String?)
        case model(ModelReadiness)
        case apps([HelloApp])
        case key(TryItKey)
        /// The host read the grants again (it polls while the flow runs).
        case permissions(OnboardingPermissions)
        /// "Caret isn't in the list?"
        case toggleHelp
        /// Open the pane again (the guide's link, when System Settings was closed).
        case openSystemSettings
        case previewReady(requestId: String, OnboardingPreview)
        case previewFailed(requestId: String, String)
        /// Keep everything on this Mac.
        case keep
        case setJevKey(String)
        case jevKeyChecked(JevKeyCheck.Outcome, saved: Bool)
        case firstLookReply(FirstLookReply)
        case taskProgress(TaskProgress)
        case sendFailed(SendFailure)
        case firstLookUnsent
        case offerWithdrawn(OfferWithdrawn)
        /// The found offer's primary button, as Tab would take it.
        case accept
        /// Not now on the found offer, as Esc.
        case notNow
        /// The host is asking macOS for Calendar access before the accept goes (H8).
        case calendarAsking
        case calendarAnswered(Bool)
        case settingsChanged(CaretSettings)
        case otherTabOwners([String])
        /// The host read the installed Chromium browsers: those the bridge trusts and those it does not.
        case browsers(trusted: [String], untrusted: [String])
        /// The extension's engine said hello through the bridge (the helper's `pageEngine` connected).
        case browserConnected
        /// Skip on the browser step.
        case skipBrowser
    }

    public enum SendFailure: Equatable, Sendable { case accept, undo }

    public enum Command: Equatable, Sendable {
        /// Onboarding finished: settings' `onboarded` (roles and level stay as they are).
        case finished
        /// Write `OnboardingProgress` for this step.
        case saveProgress(OnboardingStep)
        /// Open Privacy & Security, Accessibility, with the panel to drag Caret into its list (no macOS alert).
        case openSystemSettings
        /// Write the native host for the trusted browsers and open the extension's page (`ChromeBridgeInstaller`).
        case addToBrowser
        /// The grant landed and the flow moved on: Caret takes the focus back from System Settings, once.
        case bringForward
        /// Ask the local model for the next words after `text`.
        case complete(requestId: String, text: String)
        /// Ask the helper which lines a first look may send.
        case askPreview(requestId: String, families: [String], level: CaretLevel)
        /// Check this key with Jev; on an answer that keeps it, save it and restart the helper (H12).
        case checkJevKey(SecretText)
        /// The look itself, limited to the preview the person saw.
        case askFirstLook(FirstLookRequest, previewId: String?)
        /// The person decided about the cloud model: `sent` gives the held roles back, kept leaves them off.
        case consent(sent: Bool)
        case accept(OfferAccept)
        case stop(OfferStop)
        case undo(TaskControl)
        /// The flow is done or set aside; close the window.
        case close
        /// The state changed; redraw and republish.
        case changed
    }

    /// How long Hello waits after the last keystroke before asking the model (HANDOFF §1).
    public static let completionIdle: TimeInterval = 0.45
    /// How long "Caret is on." stays on the guide before the window grows back and moves on (HANDOFF §4).
    public static let grantLanding: TimeInterval = 0.9
    /// Grace after the request's own deadline before the host gives up on the reply.
    public static let firstLookGrace: TimeInterval = 1
    /// The preview is local work; past this the screen offers to go on without it. Assumed, not measured.
    public static let previewDeadline: TimeInterval = 10
    /// The helper is not connected yet (Caret just started, or it restarted with a new key): ask again each second, this
    /// many times, before saying the preview failed.
    public static let previewRetries = 15

    let clock: SurfaceClock
    private(set) var base: CaretSettings
    /// Names this flow in its request ids, so a late reply to an earlier flow never matches this one.
    let token: String
    public internal(set) var state: State
    public var output: (Command) -> Void = { _ in }
    private var idleTimer: SurfaceTimer?
    private var landingTimer: SurfaceTimer?
    private var previewTimer: SurfaceTimer?
    private var previewRetry: SurfaceTimer?
    private var previewAttempts = 0
    private var firstLookTimer: SurfaceTimer?
    var runTimers: [SurfaceTimer] = []
    private var requests = 0
    private var asked: FirstLookRequest?

    /// `jevKeyAvailable`: the helper has a key from anywhere; without one the `on` step shows the key field.
    public init(settings: CaretSettings, permissions: OnboardingPermissions, clock: SurfaceClock, token: String = "1",
                opening: OnboardingLaunch.Opening = OnboardingLaunch.Opening(step: .hello),
                jevKeyAvailable: Bool = true, jevKeyStored: Bool = false) {
        self.clock = clock
        base = settings
        self.token = token
        state = State(step: opening.step, permissions: permissions, roles: settings.roles, level: settings.level)
        state.alone = opening.alone
        state.access.reopened = opening.reopened && opening.step == .access
        state.on.needsKey = !jevKeyAvailable
        state.on.jevKey = JevKeyDraft(stored: jevKeyStored)
    }

    /// Starts what the opening step does on its own (the preview on `on`). The window calls it once it is wired.
    public func start() {
        enter(state.step)
        output(.changed)
    }

    var nowMs: Int64 { Int64((clock.now.timeIntervalSince1970 * 1000).rounded()) }

    /// Cancels every timer. The window calls it when it drops an unfinished flow.
    public func cancelTimers() {
        for t in [idleTimer, landingTimer, previewTimer, previewRetry, firstLookTimer] { t?.cancel() }
        idleTimer = nil
        landingTimer = nil
        previewTimer = nil
        previewRetry = nil
        firstLookTimer = nil
        endRunTimers()
    }

    // MARK: - Events

    public func send(_ event: Event) {
        guard !state.finished else { return }
        switch event {
        case .next: next()
        case .setUpLater:
            guard state.step == .hello || state.step == .access else { return }
            // The next launch reopens at the switch (`OnboardingLaunch.auto`).
            output(.saveProgress(.access))
            cancelTimers()
            output(.close)
        case .typed(let text): typed(text)
        case .ghost(let id, let text):
            guard state.step == .hello, state.hello.asking == id else { return }
            state.hello.asking = nil
            state.hello.ghost = text.flatMap { $0.isEmpty ? nil : $0 }
        case .model(let readiness):
            state.hello.model = readiness
            if readiness != .ready { state.hello.ghost = nil }
        case .apps(let apps): state.hello.apps = apps
        case .key(let key): self.key(key)
        case .permissions(let p): permissionsChanged(p)
        case .toggleHelp:
            guard state.step == .access else { return }
            state.access.helpOpen.toggle()
        case .openSystemSettings:
            guard state.step == .access else { return }
            output(.openSystemSettings)
        case .previewReady(let id, let preview):
            guard case .building(let asking) = state.on.preview, asking == id else { return }
            previewTimer?.cancel()
            previewTimer = nil
            state.on.preview = preview.windows.isEmpty ? .empty : .ready(preview)
        case .previewFailed(let id, let why):
            guard case .building(let asking) = state.on.preview, asking == id else { return }
            previewTimer?.cancel()
            previewTimer = nil
            if why == "helperNotConnected", previewAttempts < Self.previewRetries {
                previewAttempts += 1
                previewRetry = clock.schedule(after: 1, repeats: false) { [weak self] in
                    guard let self, self.state.step == .on, case .building = self.state.on.preview else { return }
                    self.previewRetry = nil
                    self.askPreview()
                    self.output(.changed)
                }
                return output(.changed)
            }
            state.on.preview = .failed(why)
        case .keep:
            guard state.step == .on, state.on.decision == .pending else { return }
            state.on.decision = .kept
            output(.consent(sent: false))
        case .setJevKey(let text):
            guard state.step == .on, state.on.needsKey, state.on.jevKey.phase != .checking else { return }
            state.on.jevKey.text = SecretText(text)
            state.on.jevKey.phase = .editing
        case .jevKeyChecked(let outcome, let saved): jevKeyChecked(outcome, saved: saved)
        case .firstLookReply(let reply): firstLookReplied(reply)
        case .taskProgress(let progress): firstLookProgress(progress)
        case .sendFailed(let what): firstLookUnsent(what)
        case .firstLookUnsent:
            guard asked != nil else { return }
            failFirstLook("helperNotConnected")
        case .offerWithdrawn(let withdrawn): firstLookWithdrawn(withdrawn)
        case .accept:
            guard state.step == .first else { return }
            take(state.firstLookFound?.takeable.first { $0.key == .tab } ?? state.firstLookFound?.takeable.first)
        case .notNow: notNow()
        case .calendarAsking:
            guard state.step == .first else { return }
            state.first.calendar = .asking
        case .calendarAnswered(let granted):
            guard state.first.calendar == .asking else { return }
            state.first.calendar = granted ? nil : .denied
            if !granted {
                endRunTimers()
                state.first.run = nil
            }
        case .settingsChanged(let settings):
            base = settings
        case .otherTabOwners(let names):
            state.otherTabOwners = names
        case .browsers(let trusted, let untrusted):
            state.browser.trusted = trusted
            state.browser.untrusted = untrusted
        case .browserConnected:
            guard !state.browser.connected else { break }
            state.browser.connected = true
            guard state.step == .browser, landingTimer == nil else { break }
            // As the switch lands: "Caret is in Chrome." for a moment, then on by itself.
            landingTimer = clock.schedule(after: Self.grantLanding, repeats: false) { [weak self] in
                guard let self else { return }
                self.landingTimer = nil
                guard self.state.step == .browser else { return }
                self.go(to: .on)
                self.output(.bringForward)
                self.output(.changed)
            }
        case .skipBrowser:
            guard state.step == .browser else { break }
            go(to: .on)
        }
        output(.changed)
    }

    func next() {
        guard state.canContinue else { return }
        switch state.step {
        case .hello:
            state.access.alertShown = true
            output(.openSystemSettings)
            go(to: .access)
        case .access:
            break
        case .browser:
            // The first press adds Caret to the browser; after that (or with no browser to add to) it goes on.
            if state.browser.target != nil, !state.browser.opened, !state.browser.connected {
                state.browser.opened = true
                output(.addToBrowser)
            } else {
                go(to: .on)
            }
        case .on:
            if state.alone {
                // The menu's key item: check a pasted key, or close once one is saved.
                if state.on.needsKey, !state.on.jevKey.stored { return checkKey() }
                return finish()
            }
            switch (state.on.decision, state.on.preview) {
            case (.pending, .ready(let preview)): send(preview: preview)
            case (.pending, .building), (.pending, .idle), (.sent, _): break
            case (.pending, .empty), (.pending, .failed), (.kept, _): finish()
            }
        case .first:
            // The primary is the offer's own button while it can be taken (Add to Calendar, Fill 4 fields).
            if let found = state.firstLookFound, state.first.run == nil, !state.first.declined, state.first.calendar == nil {
                return take(found.takeable.first { $0.key == .tab } ?? found.takeable.first)
            }
            finish()
        }
    }

    func go(to step: OnboardingStep, _ direction: Direction = .forward) {
        leave(state.step)
        state.step = step
        state.direction = direction
        output(.saveProgress(step))
        enter(step)
    }

    private func enter(_ step: OnboardingStep) {
        switch step {
        case .on:
            if case .idle = state.on.preview { askPreview() }
        case .access:
            // Granted before the guide opened (in System Settings, or by an earlier run): land it now.
            if state.permissions.accessibility { land() }
        case .hello, .first, .browser:
            break
        }
    }

    private func leave(_ step: OnboardingStep) {
        switch step {
        case .hello:
            idleTimer?.cancel()
            idleTimer = nil
            state.hello.asking = nil
        case .access, .browser:
            landingTimer?.cancel()
            landingTimer = nil
        case .on:
            // A key is held here only until it is saved or the step is left.
            state.on.jevKey.text = SecretText("")
        case .first:
            break
        }
    }

    func finish() {
        cancelTimers()
        state.finished = true
        output(.finished)
        output(.close)
    }

    // MARK: - Hello

    /// Any typing clears the ghost at once; the model is asked again after `completionIdle` of quiet, for text of two
    /// or more words that does not end a sentence.
    func typed(_ text: String) {
        guard state.step == .hello else { return }
        state.hello.text = text
        state.hello.ghost = nil
        state.hello.asking = nil
        idleTimer?.cancel()
        idleTimer = nil
        guard Self.asksCompletion(after: text), state.hello.model == .ready else { return }
        idleTimer = clock.schedule(after: Self.completionIdle, repeats: false) { [weak self] in
            guard let self, self.state.step == .hello, self.state.hello.text == text else { return }
            self.idleTimer = nil
            self.requests += 1
            let id = "hello-\(self.token)-\(self.requests)"
            self.state.hello.asking = id
            self.output(.complete(requestId: id, text: text))
            self.output(.changed)
        }
    }

    /// Two or more words, and no closing punctuation at the end.
    public static func asksCompletion(after text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = trimmed.last, !".!?…".contains(last) else { return false }
        return trimmed.split(whereSeparator: \.isWhitespace).count >= 2
    }

    // MARK: - Keys

    func key(_ key: TryItKey) {
        switch state.step {
        case .hello:
            switch key {
            case .tab:
                guard let ghost = state.hello.ghost else { return }
                state.hello.text += ghost
                state.hello.ghost = nil
                state.hello.taken = true
            case .returnKey: next()
            case .escape, .commandDigit, .undo, .other: break
            }
        case .access:
            break
        case .browser, .on:
            if key == .returnKey { next() }
        case .first:
            firstLookKey(key)
        }
    }

    // MARK: - Access

    /// The switch. A grant shows "Caret is on." on the guide for `grantLanding`, then the window grows back and the
    /// flow moves to `on` (or finishes, when the switch was all it had to do). A grant taken back before that stays.
    func permissionsChanged(_ p: OnboardingPermissions) {
        let before = state.permissions
        state.permissions = p
        guard state.step == .access else { return }
        if !p.accessibility {
            landingTimer?.cancel()
            landingTimer = nil
            state.access.granted = false
            return
        }
        guard !before.accessibility || !state.access.granted else { return }
        land()
    }

    private func land() {
        guard landingTimer == nil else { return }
        state.access.granted = true
        landingTimer = clock.schedule(after: Self.grantLanding, repeats: false) { [weak self] in
            guard let self else { return }
            self.landingTimer = nil
            guard self.state.step == .access, self.state.permissions.accessibility else { return }
            if self.state.alone { return self.finish() }
            self.go(to: .browser)
            self.output(.bringForward)
            self.output(.changed)
        }
    }

    // MARK: - On

    func askPreview() {
        previewTimer?.cancel()
        previewTimer = nil
        requests += 1
        let id = "preview-\(token)-\(requests)"
        let families = FirstLookRequest.families(for: settingsForLook)
        guard !families.isEmpty else {
            // Words only, or paused: nothing would be looked for, so nothing would go.
            state.on.preview = .empty
            return
        }
        state.on.preview = .building(requestId: id)
        previewTimer = clock.schedule(after: Self.previewDeadline, repeats: false) { [weak self] in
            guard let self, case .building(let asking) = self.state.on.preview, asking == id else { return }
            self.previewTimer = nil
            self.state.on.preview = .failed("timedOut")
            self.output(.changed)
        }
        output(.askPreview(requestId: id, families: families, level: state.level))
    }

    /// The person saw the preview and pressed Send: a key typed into the key field is checked first.
    func send(preview: OnboardingPreview) {
        if state.on.needsKey, !state.on.jevKey.stored { return checkKey() }
        state.on.decision = .sent
        state.on.sentPreviewId = preview.previewId
        output(.consent(sent: true))
        askFirstLook(previewId: preview.previewId)
    }

    func checkKey() {
        state.on.jevKey.submits += 1
        guard let key = JevKeyCheck.cleaned(state.on.jevKey.text.reveal) else {
            state.on.jevKey.phase = .malformed
            return
        }
        state.on.jevKey.phase = .checking
        output(.checkJevKey(SecretText(key)))
    }

    func jevKeyChecked(_ outcome: JevKeyCheck.Outcome, saved: Bool) {
        guard state.step == .on, state.on.jevKey.phase == .checking else { return }
        state.on.jevKey.phase = .checked(outcome, saved: saved)
        guard outcome.keepsKey, saved else { return }
        state.on.jevKey.stored = true
        state.on.jevKey.text = SecretText("")
        // A key with no credits is kept, and the step stays so its line can be read (the coordinator's rule,
        // 2026-10-05). A key that works: the key alone (the menu's "Jev is off") is done; otherwise the person pressed
        // Send, so the look goes with no second press.
        guard outcome == .works else { return }
        if state.alone { return finish() }
        // Saving the key restarts the helper, which forgets every preview it minted: build it again, and the person
        // sends what the new one shows.
        if state.on.decision == .pending {
            previewTimer?.cancel()
            previewTimer = nil
            previewAttempts = 0
            askPreview()
        }
    }

    var settingsForLook: CaretSettings {
        var settings = base
        settings.roles = state.roles
        settings.level = state.level
        return settings
    }

    func askFirstLook(previewId: String?) {
        firstLookTimer?.cancel()
        requests += 1
        let request = FirstLookRequest(
            requestId: "first-look-\(token)-\(requests)", at: nowMs,
            families: FirstLookRequest.families(for: settingsForLook), level: state.level
        )
        guard !request.families.isEmpty else {
            // Paused, or words only: nothing to look for.
            asked = nil
            state.first.look = .nothing
            if state.step == .on { go(to: .first) }
            return
        }
        asked = request
        state.first.look = .asking(requestId: request.requestId)
        let wait = Double(request.deadlineMs) / 1000 + Self.firstLookGrace
        firstLookTimer = clock.schedule(after: wait, repeats: false) { [weak self] in
            guard let self, case .asking(let id) = self.state.first.look, id == request.requestId else { return }
            self.firstLookTimer = nil
            self.failFirstLook("timedOut")
            self.output(.changed)
        }
        output(.askFirstLook(request, previewId: previewId))
    }

    // MARK: - First

    func firstLookReplied(_ reply: FirstLookReply) {
        guard let asked, case .asking(let id) = state.first.look, id == reply.requestId, id == asked.requestId else { return }
        firstLookTimer?.cancel()
        firstLookTimer = nil
        self.asked = nil
        switch reply.outcome {
        case .found:
            guard let found = reply.found, asked.families.contains(found.family) else { return failFirstLook("familyNotRequested") }
            state.first.look = .found(found)
        case .nothing:
            state.first.look = .nothing
        case .error:
            state.first.look = .failed(reply.error ?? "error")
        }
        if state.step == .on { go(to: .first) }
    }

    func failFirstLook(_ reason: String) {
        firstLookTimer?.cancel()
        firstLookTimer = nil
        asked = nil
        state.first.look = .failed(reason)
        if state.step == .on { go(to: .first) }
    }

    /// Esc or Not now on a found offer nobody took: an event is left alone with its own line; a fill closes.
    func notNow() {
        guard state.step == .first, case .found(let found) = state.first.look, state.first.run == nil else { return }
        state.first.declined = true
        if found.kind == .fill { finish() }
    }

    // MARK: - Debug state

    public func debugInfo() -> DebugState.OnboardingInfo {
        var info = DebugState.OnboardingInfo(step: state.step.rawValue, stepIndex: state.stepIndex, canContinue: state.canContinue, finished: state.finished)
        info.stepCount = state.steps.count
        info.frame = state.frame.rawValue
        info.permissions = state.permissions
        info.alone = state.alone ? true : nil
        info.otherTabOwners = state.otherTabOwners.isEmpty ? nil : state.otherTabOwners
        info.hello = DebugState.OnboardingInfo.HelloInfo(
            textLength: state.hello.text.utf16.count, ghostLength: state.hello.ghost?.utf16.count, model: state.hello.model.name,
            apps: state.hello.apps.map(\.name), taken: state.hello.taken
        )
        info.access = DebugState.OnboardingInfo.AccessInfo(granted: state.access.granted, reopened: state.access.reopened, helpOpen: state.access.helpOpen)
        switch state.on.preview {
        case .idle: info.preview = "idle"
        case .building: info.preview = "building"
        case .ready(let p): info.preview = "ready"; info.previewWindows = p.windows.count; info.previewChars = p.chars
        case .empty: info.preview = "empty"
        case .failed: info.preview = "failed"
        }
        info.decision = state.on.decision.rawValue
        info.browsers = state.browser.trusted
        info.browserOpened = state.browser.opened
        info.browserConnected = state.browser.connected
        if state.on.needsKey {
            info.jevKey = state.on.jevKey.phase.name
            info.jevKeyLength = state.on.jevKey.text.utf16Count
            info.jevKeyStored = state.on.jevKey.stored
        }
        switch state.first.look {
        case .idle: info.firstLook = "idle"
        case .asking(let id): info.firstLook = "asking"; info.firstLookRequest = id
        case .found(let found):
            info.firstLook = "found"
            info.firstLookKind = found.kind.rawValue
            info.firstLookTitle = found.title
            let keys = state.firstLookKeys
            info.firstLookKeys = (keys.tab ? ["tab"] : []) + keys.digits.sorted().map { "cmd-\($0)" }
                + (keys.undo ? ["cmd-z"] : []) + (keys.stop ? ["esc"] : [])
            if let run = state.first.run {
                info.firstLookRun = run.phase.name
                info.firstLookLine = run.line()?.text
            }
        case .nothing: info.firstLook = "nothing"
        case .failed(let reason): info.firstLook = "failed"; info.firstLookError = reason
        }
        info.declined = state.first.declined ? true : nil
        info.calendar = state.first.calendar.map { $0 == .asking ? "asking" : "denied" }
        return info
    }
}

/// The apps the Hello line names (HANDOFF §2): the default mail app and browser first, then running apps, then a short
/// list of installed ones; never Caret, terminals, password managers or System Settings (`excluded`); at most four;
/// at least three, which Notes, Mail and Safari guarantee on any Mac.
public enum HelloApps {
    /// The installed apps looked for, in order.
    public static let wellKnown = [
        "com.apple.mail", "com.apple.Notes", "com.apple.Safari", "com.google.Chrome", "com.tinyspeck.slackmacgap",
        "com.hnc.Discord", "notion.id", "com.microsoft.VSCode", "com.apple.MobileSMS", "us.zoom.xos",
    ]
    /// Always present on macOS, so the line never has fewer than three names.
    public static let fallback = [
        HelloApp(bundleId: "com.apple.Notes", name: "Notes"), HelloApp(bundleId: "com.apple.mail", name: "Mail"),
        HelloApp(bundleId: "com.apple.Safari", name: "Safari"),
    ]

    public static func pick(defaultMail: HelloApp?, defaultBrowser: HelloApp?, running: [HelloApp], installed: [HelloApp],
                            excluded: (String) -> Bool, limit: Int = 4) -> [HelloApp] {
        var out: [HelloApp] = []
        for app in [defaultMail, defaultBrowser].compactMap({ $0 }) + running + installed + fallback {
            guard out.count < limit, !app.name.isEmpty, !excluded(app.bundleId),
                  !out.contains(where: { $0.bundleId == app.bundleId || $0.name == app.name }) else { continue }
            out.append(app)
        }
        return out
    }

    /// "Mail, Slack, Notes and Chrome".
    public static func list(_ apps: [HelloApp]) -> String {
        let names = apps.map(\.name)
        switch names.count {
        case 0: return ""
        case 1: return names[0]
        default: return names.dropLast().joined(separator: ", ") + " and " + names.last!
        }
    }
}
