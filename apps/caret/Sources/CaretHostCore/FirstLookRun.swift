import CaretScreenCore
import Foundation

/// The first look's offer, taken from onboarding. Tab, or the Command-digit an action is bound
/// to, sends `offerAccept` with the found offer's key; the run's `taskProgress` moves the line from
/// working to its result, and a fill's result takes ⌘Z as the real toast does. Every line is the
/// one the real surfaces draw (`WorkLines`), so onboarding shows exactly what Tab will do later.
public struct FirstLookRun: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case working
        /// `written` from the `done` progress; nil from a helper that sends none.
        case done(written: Int?)
        case stopped
        case handoff
        /// Real input in the target window paused it. As on the real surfaces the line goes; the
        /// activity list carries the run from here.
        case paused
        /// Esc after `StatusLine.stoppableAfter`.
        case stoppedByYou
        /// The helper was not connected; nothing ran.
        case unsent
        case undoing
        case undoUnsent
        case undone(OfferLifecycle.UndoCount?)

        public var name: String {
            switch self {
            case .working: return "working"
            case .done: return "done"
            case .stopped: return "stopped"
            case .handoff: return "handoff"
            case .paused: return "paused"
            case .stoppedByYou: return "stoppedByYou"
            case .unsent: return "unsent"
            case .undoing: return "undoing"
            case .undoUnsent: return "undoUnsent"
            case .undone: return "undone"
            }
        }
    }

    /// The task the run is: the found offer's key.
    public var offerKey: String
    public var actionId: String
    /// The app the work happens in: where the offer was found.
    public var app: String
    /// A fill's rows, for "Filling 4 fields"; nil for other offers.
    public var fillRows: Int?
    /// The source apps as the done line names them ("Mail").
    public var source: String?
    public var phase: Phase = .working
    public var startedAt: Date
    /// Whole seconds since Tab, ticked once a second while it works.
    public var seconds = 0
    /// The figure has looked away and left the working line (200 ms after Tab).
    public var figureLeft = false
    /// Steps the helper verified: the count when `done` carries none.
    public var verified = 0

    public init(offerKey: String, actionId: String, app: String, fillRows: Int?, source: String?, startedAt: Date) {
        self.offerKey = offerKey
        self.actionId = actionId
        self.app = app
        self.fillRows = fillRows
        self.source = source
        self.startedAt = startedAt
    }

    public var working: Bool { phase == .working }

    /// Esc stops it: it has run long enough to be worth stopping, as on the real working line.
    public var stoppable: Bool { working && Double(seconds) >= StatusLine.stoppableAfter }

    /// ⌘Z undoes it: a fill that wrote something.
    public var undoable: Bool {
        guard case .done(let written) = phase, fillRows != nil else { return false }
        return (written ?? verified) > 0
    }

    /// The line under the card, or nil when there is none (paused).
    public func line(character: FigureCharacter) -> WorkLine? {
        switch phase {
        case .working:
            return WorkLines.working(app: app, fillRows: fillRows, character: character, seconds: seconds, figureLeft: figureLeft)
        case .done(let written):
            let filled = written ?? verified
            if fillRows != nil, filled > 0 { return WorkLines.filled(filled, from: source) }
            return WorkLines.done(app: app, character: character)
        case .stopped: return WorkLines.stopped(app: app, character: character, fillFilled: fillRows.map { _ in verified })
        case .handoff: return WorkLines.handoff(app: app)
        case .paused: return nil
        case .stoppedByYou: return WorkLines.stoppedByYou
        case .unsent: return WorkLines.acceptUnsent
        case .undoing: return WorkLines.undoing
        case .undoUnsent: return WorkLines.undoUnsent
        case .undone(let count): return WorkLines.undone(count)
        }
    }
}

/// The keys the first look takes right now. Every other key keeps the window's meaning (Tab moves
/// focus between the buttons, Esc goes back), so a keyboard user is never trapped.
public struct FirstLookKeys: Equatable, Sendable {
    public var tab = false
    public var digits: Set<Int> = []
    public var undo = false
    public var stop = false

    public init(tab: Bool = false, digits: Set<Int> = [], undo: Bool = false, stop: Bool = false) {
        self.tab = tab
        self.digits = digits
        self.undo = undo
        self.stop = stop
    }

    public static let none = FirstLookKeys()
}

extension OnboardingFlow.State {
    /// What the first look's keys do now: a found offer not yet taken takes Tab and its digits;
    /// a fill's done line takes ⌘Z; a run past three seconds takes Esc.
    public var firstLookKeys: FirstLookKeys {
        guard step == .firstLook, case .found(let found) = firstLook else { return .none }
        if let run = firstLookRun { return FirstLookKeys(undo: run.undoable, stop: run.stoppable) }
        let takeable = found.takeable
        return FirstLookKeys(tab: takeable.contains { $0.key == .tab }, digits: Set(takeable.compactMap(\.key.digit)))
    }
}

extension OnboardingFlow {
    /// A key on the first look's screen.
    func firstLookKey(_ key: TryItKey) {
        let keys = state.firstLookKeys
        switch key {
        case .tab where keys.tab:
            take(state.firstLookFound?.takeable.first { $0.key == .tab })
        case .commandDigit(let n) where keys.digits.contains(n):
            take(state.firstLookFound?.takeable.first { $0.key.digit == n })
        case .undo where keys.undo:
            guard let run = state.firstLookRun else { return }
            state.firstLookRun?.phase = .undoing
            output(.undo(TaskControl(taskId: run.offerKey, action: .undo)))
        case .escape:
            guard keys.stop, let run = state.firstLookRun else { return back() }
            endRunTimers()
            state.firstLookRun?.phase = .stoppedByYou
            output(.stop(OfferStop(offerId: run.offerKey, at: nowMs)))
        case .returnKey:
            next()
        default:
            break
        }
    }

    func take(_ action: PopupSpec.Action?) {
        guard let action, case .found(let found) = state.firstLook, state.firstLookRun == nil else { return }
        let started = clock.now
        state.firstLookRun = FirstLookRun(
            offerKey: found.offerKey, actionId: action.id, app: found.window.appName, fillRows: found.fillRows,
            source: OfferLifecycle.sourcePhrase(found.sourceApps), startedAt: started
        )
        // The figure looks away (200 ms), then leaves; the seconds count once a second.
        runTimers = [
            clock.schedule(after: 0.2, repeats: false) { [weak self] in
                guard let self, self.state.firstLookRun?.working == true else { return }
                self.state.firstLookRun?.figureLeft = true
                self.output(.changed)
            },
            clock.schedule(after: 1, repeats: true) { [weak self] in
                guard let self, let run = self.state.firstLookRun, run.working else { return }
                self.state.firstLookRun?.seconds = Int(self.clock.now.timeIntervalSince(run.startedAt))
                self.output(.changed)
            },
        ]
        output(.accept(OfferAccept(offerId: found.offerKey, actionId: action.id, overrides: [:], at: nowMs)))
    }

    /// The run's progress, by its task id (the offer's key). A later phase replaces an earlier one.
    func firstLookProgress(_ progress: TaskProgress) {
        guard let run = state.firstLookRun, progress.taskId == run.offerKey else { return }
        switch progress.phase {
        case .verified where run.working:
            state.firstLookRun?.verified += 1
        case .done where run.working:
            endRunTimers()
            state.firstLookRun?.phase = .done(written: progress.written)
        case .stopped where run.working:
            endRunTimers()
            state.firstLookRun?.phase = .stopped
        case .handoff where run.working:
            endRunTimers()
            state.firstLookRun?.phase = .handoff
        case .paused where run.working:
            endRunTimers()
            state.firstLookRun?.phase = .paused
        case .undone where run.phase == .undoing:
            state.firstLookRun?.phase = .undone(OfferLifecycle.undoCount(progress))
        default:
            break
        }
    }

    /// The helper withdrew the found offer before it was taken, so Tab could no longer run it.
    /// `settings` (the menu's Pause, or a role or level turned off) and `reoffered` mean what the
    /// look found has changed, so it looks again with the settings as they are now; a paused Caret
    /// asks for no family and lands on "Nothing yet." Any other reason leaves nothing to take.
    /// Once taken, the run's own progress says what happened, and a withdrawal changes nothing.
    ///
    /// The work screen saved the flow's roles and level before the first look, so a `settings`
    /// withdrawal means they were changed elsewhere since: the flow takes the saved ones, or the
    /// new look would ask again for the family just turned off (A10 review).
    func firstLookWithdrawn(_ withdrawn: OfferWithdrawn) {
        guard state.step == .firstLook, state.firstLookRun == nil,
              case .found(let found) = state.firstLook, found.offerKey == withdrawn.id else { return }
        switch withdrawn.reason {
        case .settings:
            state.roles = base.roles
            state.level = base.level
            askFirstLook()
        case .reoffered: askFirstLook()
        case .taken, .dismissed, .diverged, .idle, .stale, .expired: state.firstLook = .nothing
        }
    }

    /// The accept or the undo could not be written: the helper is not connected.
    func firstLookUnsent(_ what: SendFailure) {
        guard let run = state.firstLookRun else { return }
        switch what {
        case .accept where run.working:
            endRunTimers()
            state.firstLookRun?.phase = .unsent
        case .undo where run.phase == .undoing:
            state.firstLookRun?.phase = .undoUnsent
        default:
            break
        }
    }

    func endRunTimers() {
        for timer in runTimers { timer.cancel() }
        runTimers = []
    }
}

extension OnboardingFlow.State {
    /// The found offer, while the first look shows one.
    public var firstLookFound: FirstLookReply.Found? {
        if case .found(let found) = firstLook { return found }
        return nil
    }
}
