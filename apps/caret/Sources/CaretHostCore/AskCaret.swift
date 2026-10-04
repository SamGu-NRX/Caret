import CaretScreenCore
import Foundation

/// Asking Caret to do something (brief A13, part 1): the field at the top of the activity list, the
/// helper's plan as a card, and the run that Tab starts.
///
/// Sam's bar is that help is offered where you are and never forced, and that asking must not hang
/// on remembering a shortcut, so the field lives where Caret already is: the list the perch opens,
/// which the menu bar's Ask Caret also opens. Return sends `planRequest`. The helper answers with
/// `planProposal`: a card listing each step in plain words, the presses it leaves to the user marked
/// as theirs. Tab sends `offerAccept`, and the helper runs the plan under A12's act grant (granted,
/// acted, revoked); its `taskProgress` marks the steps and ends the card with a line that says how
/// the run ended and who stopped it. Esc dismisses the card, or stops the run.
///
/// Like `SurfaceMachine`, this decides and the host draws: it holds plain values, sends through
/// `send`, and keeps time on a `SurfaceClock`, so every transition is tested without a screen.
/// Main thread only.
public final class AskCaret {
    public enum Send: Equatable, Sendable {
        case plan(PlanRequest)
        case accept(OfferAccept)
        case stop(OfferStop)
        /// ⌘Z on a run that wrote: `taskControl undo`, which restores what the helper's ledger recorded.
        case control(TaskControl)
    }

    /// A run's writes that ⌘Z may undo, for the arbiter's toast in the app it acted in.
    public struct UndoOffer: Equatable, Sendable {
        public var taskId: String
        public var pid: Int32
    }

    /// One step of a proposed plan, as the card lists it.
    public struct Step: Equatable, Sendable, Codable {
        public enum State: String, Codable, Sendable { case pending, running, done, failed }
        /// "Put “Priya Raman” in Name", "Press Send".
        public var text: String
        /// A press the plan leaves to the user: the card marks it "You do this", and Caret never makes it.
        public var yours: Bool
        public var state: State
        /// The field a write step writes, so "Filled N fields" counts each field once.
        public var field: String?

        public init(text: String, yours: Bool = false, state: State = .pending, field: String? = nil) {
            self.text = text
            self.yours = yours
            self.state = state
            self.field = field
        }
    }

    /// The fields the card shows written: its done write steps, each field once (A17 review: two
    /// writes to one field are one field filled).
    static func filled(_ card: Card) -> Int {
        Set(card.steps.filter { !$0.yours && $0.state == .done }.map { $0.field ?? $0.text }).count
    }

    /// The helper's proposal, reduced to what the card shows and what Tab sends.
    public struct Card: Equatable, Sendable, Codable {
        /// What the plan does, as a sentence: "Fill Reference in Caret Fixture" (`AskCopy.title`).
        public var title: String
        /// The app the plan acts in, for the lines after it ends.
        public var app: String
        public var steps: [Step]
        /// Field writes the spec did not list ("and 2 more").
        public var more: Int
        /// The Tab action's label from the spec ("Fill 2 fields").
        public var action: String
        public var offerKey: String
        public var actionId: String
        /// Field writes in the plan, listed or not: the index of the hand-off step, if there is one.
        public var writes: Int
        /// The press the plan leaves to the user ("Send"), if any.
        public var press: String?
        /// The process of the window the plan acts in, where ⌘Z undoes the run once it wrote.
        public var pid: Int32?

        public init(title: String, app: String, steps: [Step], more: Int, action: String, offerKey: String, actionId: String, writes: Int, press: String?, pid: Int32? = nil) {
            self.title = title
            self.app = app
            self.steps = steps
            self.more = more
            self.action = action
            self.offerKey = offerKey
            self.actionId = actionId
            self.writes = writes
            self.press = press
            self.pid = pid
        }
    }

    public enum Phase: Equatable, Sendable {
        /// The field alone, empty or holding what the user typed.
        case idle
        /// The instruction went out; the helper is planning.
        case asking(requestId: String)
        /// A plan to take with Tab or dismiss with Esc.
        case proposed(Card)
        /// No plan, and why in a sentence (`AskCopy.planError`).
        case failed(String)
        /// Tab took the plan; the helper is running it.
        case running(Card)
        /// The run ended: the steps as they ended and the line that says how.
        case ended(Card, WorkLine)
    }

    /// No answer to a planRequest in this long ends the wait. Assumed: B16's live planner passes
    /// took two Jev asks at 200 to 520 ms each, so 30 s is far past a slow answer.
    public static let answerWait: TimeInterval = 30

    public private(set) var text = ""
    public private(set) var phase: Phase = .idle
    /// The helper's connection is up. Without it Return says so rather than wait.
    public private(set) var linked = false
    /// Where the helper's ending for a run Esc stopped can still correct the line (`SurfaceMachine.confirmStop`).
    private var stopping: String?
    /// Each delivered stop's deadline, by task, independent of the card (A17 review): if no ending
    /// answers it within `SurfaceMachine.stopConfirmWait`, the session closes, even after the card
    /// was put away or another run was stopped since.
    private var stopDeadlines: [String: SurfaceTimer] = [:]
    /// Fields the run verified, from its progress, so its ending knows whether ⌘Z has anything to undo.
    private var wrote = 0
    /// The ended run's writes ⌘Z may undo; nil once undone, asked or put away.
    public private(set) var undoOffer: UndoOffer?
    private var undoTimer: SurfaceTimer?
    /// A failed ask is showing: the next keys typed start a new instruction (`edit`).
    public private(set) var replacesOnType = false
    /// The task Tab started, followed while its card is up: a paused run resumed from the activity
    /// list, or undone there, moves the same card. Nil once the card is put away.
    private var tracking: String?
    private var waitTimer: SurfaceTimer?
    private var requests = 0
    /// The first step of a running plan not yet done, and its step count, from its progress.
    private var nextStep: Int?
    private var steps = 0

    private let clock: SurfaceClock
    /// Writes one message to the helper; false when it is not connected.
    public var send: (Send) -> Bool = { _ in false }
    /// A stop could not be delivered or was never confirmed: close the helper connection, which
    /// revokes what this session accepted (B22).
    public var dropSession: () -> Void = {}
    /// The run's undo became available (an offer) or went (nil), for the toast in the app it acted in.
    public var onUndoChanged: (UndoOffer?) -> Void = { _ in }
    /// Called after every change, for the view and the debug socket.
    public var onChange: () -> Void = {}

    public init(clock: SurfaceClock) {
        self.clock = clock
    }

    var nowMs: Int64 { Int64((clock.now.timeIntervalSince1970 * 1000).rounded()) }

    // MARK: - From the user

    /// The field's text changed. A new instruction replaces a card that is not running, and an
    /// answer still on its way is no longer wanted. The first keys typed after a failed ask start
    /// a new instruction rather than add to the one that failed (A18, bug 14): typed onto the end
    /// of it, they replace it. Any other edit (deleting, or the view's own select-all being
    /// typed over) is taken as it is.
    public func edit(_ text: String) {
        guard text != self.text else { return }
        var text = text
        if replacesOnType {
            replacesOnType = false
            if !self.text.isEmpty, text.count > self.text.count, text.hasPrefix(self.text) { text = String(text.dropFirst(self.text.count)) }
        }
        self.text = text
        switch phase {
        case .asking, .proposed, .failed, .ended: settle(.idle)
        case .idle, .running: onChange()
        }
    }

    /// Return: plan what the field says. False when there is nothing to send or a run is going.
    @discardableResult
    public func submit() -> Bool {
        let instruction = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instruction.isEmpty else { return false }
        if case .running = phase { return false }
        // protocol.ts caps an instruction at 500 code points; the field says so rather than send one the helper refuses.
        guard instruction.unicodeScalars.count <= 500 else {
            settle(.failed(AskCopy.tooLong))
            return true
        }
        requests += 1
        let id = "ask-\(requests)"
        guard send(.plan(PlanRequest(requestId: id, at: nowMs, instruction: instruction))) else {
            settle(.failed(AskCopy.helperDown))
            return true
        }
        settle(.asking(requestId: id))
        waitTimer = clock.schedule(after: Self.answerWait, repeats: false) { [weak self] in
            guard let self, case .asking(let pending) = self.phase, pending == id else { return }
            self.settle(.failed(AskCopy.noAnswer))
        }
        return true
    }

    /// Tab: run the proposed plan. False when no card is waiting, so the key does what it would.
    @discardableResult
    public func tab() -> Bool {
        guard case .proposed(var card) = phase else { return false }
        let accept = OfferAccept(offerId: card.offerKey, actionId: card.actionId, overrides: [:], at: nowMs)
        guard send(.accept(accept)) else {
            settle(.ended(card, WorkLines.acceptUnsent))
            return true
        }
        // The instruction is done with; the next one starts from an empty field.
        text = ""
        tracking = card.offerKey
        nextStep = nil
        wrote = 0
        steps = card.steps.count
        if let first = card.steps.indices.first, !card.steps[first].yours { card.steps[first].state = .running }
        settle(.running(card))
        return true
    }

    /// Esc: stop a run, or put away whatever the field shows. False when there is nothing to put
    /// away, so the caller closes the list.
    @discardableResult
    public func escape() -> Bool {
        switch phase {
        case .running(var card):
            // Not delivered: the helper may still be running it, so the card says only what is
            // known, and the connection closes so the helper revokes the run (S1 audit #17).
            guard send(.stop(OfferStop(offerId: card.offerKey, at: nowMs))) else {
                dropSession()
                settle(.ended(card, WorkLines.stopUnreached))
                return true
            }
            for i in card.steps.indices where card.steps[i].state == .running { card.steps[i].state = .pending }
            // "Stopping…" until the helper's own ending says where it stopped.
            settle(.ended(card, WorkLines.stopping))
            stopping = card.offerKey
            let key = card.offerKey
            stopDeadlines[key]?.cancel()
            stopDeadlines[key] = clock.schedule(after: SurfaceMachine.stopConfirmWait, repeats: false) { [weak self] in
                guard let self, self.stopDeadlines.removeValue(forKey: key) != nil else { return }
                self.dropSession()
                if self.stopping == key, case .ended(let card, _) = self.phase { self.settle(.ended(card, WorkLines.stopUnreached)) }
            }
            return true
        case .failed, .ended:
            // One Esc puts away the answer and the instruction it answered (A18, bug 14).
            text = ""
            settle(.idle)
            return true
        case .asking, .proposed:
            // The instruction stays to edit: the plan, or the wait for one, is what goes.
            settle(.idle)
            return true
        case .idle:
            guard !text.isEmpty else { return false }
            text = ""
            onChange()
            return true
        }
    }

    // MARK: - From the helper

    public func linkChanged(_ up: Bool) {
        linked = up
        guard !up else { return onChange() }
        // The closed connection makes the helper revoke this session's work (B22): nothing waits on it.
        for timer in stopDeadlines.values { timer.cancel() }
        stopDeadlines.removeAll()
        switch phase {
        case .asking: settle(.failed(AskCopy.helperDown))
        // Its offer went with the helper: Tab could only send a key nobody holds.
        case .proposed: settle(.failed(AskCopy.planGone))
        // A run in flight, or one whose stop has not been answered: losing the connection says
        // nothing about how far the helper got, so the card does not guess.
        case .running(let card): settle(.ended(card, AskCopy.lostTouch))
        case .ended(let card, _) where stopping != nil: settle(.ended(card, WorkLines.stopUnreached))
        // An undo asked for and not answered: nothing says whether the fields came back.
        case .ended(let card, _) where undoTimer != nil:
            undoTimer?.cancel()
            undoTimer = nil
            settle(.ended(card, AskCopy.lostTouch))
        // The helper's ledger went with it: there is nothing left for ⌘Z to ask for.
        case .ended(let card, var line) where undoOffer != nil:
            wrote = 0
            line.content.hints.removeAll { $0.key == "⌘Z" }
            settle(.ended(card, line))
        default: onChange()
        }
    }

    /// M1: where the noticed facts behind the plan on the card came from; the desk shows the first
    /// with "Not right". The helper sends it to the asker right after the proposal.
    public private(set) var provenance: MemoryProvenance?

    public func provenance(_ p: MemoryProvenance) {
        guard case .proposed(let card) = phase, card.offerKey == p.offerKey else { return }
        provenance = p
        onChange()
    }

    /// The provenance of the plan on the card now; nil once the card is taken, put away or replaced.
    public var shownProvenance: MemoryProvenance? {
        guard case .proposed(let card) = phase, let provenance, provenance.offerKey == card.offerKey else { return nil }
        return provenance
    }

    /// The helper took back the proposal on the card (it expired, Caret was paused, the screen
    /// reader restarted): Tab must not send its key. A run's own `taken` withdrawal changes nothing.
    public func withdrawn(_ message: OfferWithdrawn) {
        guard case .proposed(let card) = phase, card.offerKey == message.id else { return }
        settle(.failed(AskCopy.withdrawn(message.reason)))
    }

    /// The answer to a request this field sent. Any other answer, or one that comes after the
    /// field moved on, is not this field's and changes nothing.
    public func receive(_ proposal: PlanProposal) {
        guard case .asking(let id) = phase, proposal.requestId == id else { return }
        switch proposal.outcome {
        case .error:
            settle(.failed(AskCopy.planError(proposal.error)))
        case .proposed:
            guard let card = Self.card(proposal) else { return settle(.failed(AskCopy.planError(nil))) }
            settle(.proposed(card))
        }
    }

    public func receive(_ progress: TaskProgress) {
        // Any ending answers a stop sent for this task, whether or not its card still shows.
        if [.stopped, .done, .paused, .handoff].contains(progress.phase) { stopDeadlines.removeValue(forKey: progress.taskId)?.cancel() }
        guard let tracking, progress.taskId == tracking else { return }
        if case .ended(var card, let line) = phase, stopping == tracking {
            // The helper's own ending for a run Esc stopped: the step it stopped before, or Done when
            // it finished first. The line says it once; nothing else the run reports changes it.
            if progress.phase == .verified { wrote += 1 }
            let corrected: WorkLine
            switch progress.phase {
            case .stopped:
                corrected = WorkLines.stopped(app: card.app, reason: progress.stopReason ?? .error, next: progress.step ?? nextStep, steps: progress.steps > 0 ? progress.steps : steps, fillFilled: nil)
            case .done:
                for i in card.steps.indices where !card.steps[i].yours { card.steps[i].state = .done }
                if let written = progress.written { wrote = written }
                corrected = WorkLines.done(app: card.app)
            case .paused:
                corrected = WorkLines.stoppedByYou(next: progress.step ?? nextStep, of: progress.steps > 0 ? progress.steps : steps)
            case .handoff:
                corrected = progress.blocked.map(WorkLines.blocked) ?? AskCopy.handoff(press: card.press, app: card.app, filled: Self.filled(card), field: HandedField.parse(progress.detail))
            default:
                return
            }
            stopping = nil
            if corrected != line { settle(.ended(card, corrected)) }
            return
        }
        var card: Card
        switch phase {
        case .running(let c), .ended(let c, _): card = c
        case .idle, .asking, .proposed, .failed: return
        }
        if progress.steps > 0 { steps = progress.steps }
        let index = progress.step.flatMap { Self.cardIndex(ofPlanStep: $0, in: card) }
        switch progress.phase {
        case .acting:
            // Also a paused run continued from the activity list: the card runs again.
            nextStep = progress.step
            if let index { card.steps[index].state = .running }
            settle(.running(card))
        case .verified, .skipped:
            if progress.phase == .verified { wrote += 1 }
            if let step = progress.step { nextStep = step + 1 }
            if let index { card.steps[index].state = .done }
            if let index, index + 1 < card.steps.count, !card.steps[index + 1].yours, card.steps[index + 1].state == .pending {
                card.steps[index + 1].state = .running
            }
            settle(.running(card))
        case .done:
            for i in card.steps.indices where !card.steps[i].yours { card.steps[i].state = .done }
            // `written` counts each field once; an older helper sends none, and the verified steps stand in.
            if let written = progress.written { wrote = written }
            settle(.ended(card, WorkLines.done(app: card.app)))
        case .stopped:
            for i in card.steps.indices where card.steps[i].state == .running { card.steps[i].state = .failed }
            let reason = progress.stopReason ?? .error
            settle(.ended(card, WorkLines.stopped(app: card.app, reason: reason, next: progress.step ?? nextStep, steps: steps, fillFilled: nil)))
        case .handoff:
            let field = HandedField.parse(progress.detail)
            // A press is handed over after every write; a field handed over (B20, B23) is the step
            // the run stopped at, so only the writes before it are done.
            let handedAt = field == nil ? nil : progress.step.flatMap { Self.cardIndex(ofPlanStep: $0, in: card) }
            for i in card.steps.indices where !card.steps[i].yours && handedAt.map({ i < $0 }) ?? true { card.steps[i].state = .done }
            if let handedAt { card.steps[handedAt].state = .pending }
            let line = progress.blocked.map(WorkLines.blocked) ?? AskCopy.handoff(press: card.press, app: card.app, filled: Self.filled(card), field: field)
            settle(.ended(card, line))
        case .paused:
            for i in card.steps.indices where card.steps[i].state == .running { card.steps[i].state = .pending }
            settle(.ended(card, AskCopy.paused(app: card.app)))
        case .undone:
            // Undo from ⌘Z or the activity list: what Caret wrote is back as it was.
            undoTimer?.cancel()
            undoTimer = nil
            wrote = 0
            for i in card.steps.indices where !card.steps[i].yours && card.steps[i].state == .done { card.steps[i].state = .pending }
            settle(.ended(card, WorkLines.undone(OfferLifecycle.undoCount(progress))))
        case .started:
            if case .running = phase { settle(.running(card)) }
        }
    }

    // MARK: - Undo

    /// ⌘Z on a run that wrote (q1 bug 8), in the list or, through the arbiter's toast, in the app the
    /// run acted in: the helper undoes the task, and its `undone` progress ends the card. False when
    /// there is nothing to undo, so the key does what it would.
    @discardableResult
    public func undo() -> Bool {
        guard let offer = undoOffer, case .ended(let card, _) = phase else { return false }
        guard send(.control(TaskControl(taskId: offer.taskId, action: .undo))) else {
            settle(.ended(card, WorkLines.undoUnsent))
            return true
        }
        settle(.ended(card, WorkLines.undoing))
        undoTimer = clock.schedule(after: SurfaceMachine.stopConfirmWait, repeats: false) { [weak self] in
            guard let self, self.undoTimer != nil, case .ended(let card, _) = self.phase else { return }
            self.undoTimer = nil
            self.settle(.ended(card, AskCopy.undoUnanswered))
        }
        return true
    }

    /// Whether the arbiter's toast for this task is this card's.
    public func ownsUndo(_ taskId: String) -> Bool { undoOffer?.taskId == taskId }

    // MARK: - The card

    /// The card for a proposal: each field write, then the press left to the user. Nil when the
    /// proposal has no spec or no Tab action, which the helper's schema never sends.
    public static func card(_ proposal: PlanProposal) -> Card? {
        guard let spec = proposal.spec, let key = proposal.offerKey,
              let tab = spec.actions.first(where: { $0.key == .tab }) else { return nil }
        var steps: [Step] = []
        var fields: [String] = []
        var more = 0
        for block in spec.blocks {
            if case .fields(let list) = block.content {
                more = list.more
                for row in list.rows {
                    fields.append(row.destination.text)
                    steps.append(Step(text: AskCopy.write(row.value?.text ?? "", into: row.destination.text), field: row.destination.text))
                }
            }
        }
        let writes = steps.count + more
        if let handoff = proposal.handoff { steps.append(Step(text: AskCopy.press(handoff.label, why: handoff.why), yours: true)) }
        let app = proposal.window?.appName ?? "the app"
        let press = proposal.handoff.map { $0.label.isEmpty ? AskCopy.unlabelled : $0.label }
        return Card(
            title: AskCopy.title(fields: fields, writes: writes, press: press, app: app), app: app, steps: steps, more: more,
            action: tab.label, offerKey: key, actionId: tab.id, writes: writes, press: press,
            pid: proposal.window.map { Int32(truncatingIfNeeded: $0.pid) }
        )
    }

    /// The card's step for a plan step: the listed writes first, then the hand-off, which follows
    /// every write in the plan (helper/src/planner/validate.ts, stepAfterHandoff). Nil for a write
    /// the card did not list.
    static func cardIndex(ofPlanStep step: Int, in card: Card) -> Int? {
        let listed = card.steps.filter { !$0.yours }.count
        if step < listed { return step }
        if step == card.writes, let last = card.steps.indices.last, card.steps[last].yours { return last }
        return nil
    }

    private func settle(_ next: Phase) {
        if case .asking = next {} else {
            waitTimer?.cancel()
            waitTimer = nil
        }
        // Any new line ends the card's wait for a stop's answer (`escape` sets it again after its own
        // settle); the stop's deadline goes on without it.
        stopping = nil
        switch next {
        case .running, .ended: break
        case .idle, .asking, .proposed, .failed: tracking = nil
        }
        var shown = next
        var offer: UndoOffer?
        // An ending of a run that wrote, other than an undo's own lines, offers ⌘Z.
        if case .ended(let card, var line) = next, wrote > 0, let task = tracking, let pid = card.pid, undoTimer == nil,
           line != WorkLines.stopping, line != WorkLines.undoing, line != WorkLines.undoUnsent, line != AskCopy.undoUnanswered {
            offer = UndoOffer(taskId: task, pid: pid)
            if !line.content.hints.contains(where: { $0.key == "⌘Z" }) { line.content.hints.append(Hint(key: "⌘Z", label: "Undo")) }
            shown = .ended(card, line)
        }
        // An undo still waiting for its answer keeps its timer only while the card shows.
        if case .ended = next {} else {
            undoTimer?.cancel()
            undoTimer = nil
        }
        if case .failed = next { replacesOnType = true } else { replacesOnType = false }
        phase = shown
        if offer != undoOffer {
            undoOffer = offer
            onUndoChanged(offer)
        }
        onChange()
    }

    // MARK: - Debug socket

    public struct DebugInfo: Codable, Equatable, Sendable {
        public var text: String
        public var phase: String
        public var requestId: String?
        public var card: Card?
        /// The failure sentence, or the ending line.
        public var line: String?
        public var linked: Bool
    }

    public var debugInfo: DebugInfo {
        var info = DebugInfo(text: text, phase: "idle", linked: linked)
        switch phase {
        case .idle: break
        case .asking(let id): info.phase = "asking"; info.requestId = id
        case .proposed(let card): info.phase = "proposed"; info.card = card
        case .failed(let sentence): info.phase = "failed"; info.line = sentence
        case .running(let card): info.phase = "running"; info.card = card
        case .ended(let card, let line): info.phase = "ended"; info.card = card; info.line = line.text
        }
        return info
    }
}

/// The words of the ask field and its card. First person: the card is Caret's answer to what the
/// user asked it, as the brief's example reads ("I couldn't find the order number on screen").
public enum AskCopy {
    public static let placeholder = "Ask Caret to do something"
    public static let planning = "Planning"
    public static let helperDown = "My helper isn't running, so I can't plan that."
    public static let noAnswer = "I didn't hear back in time, so nothing was planned."
    public static let tooLong = "That's longer than I can plan from. Try it in fewer words."
    public static let planGone = "My helper stopped, so this plan can't run now."

    /// ⌘Z went to the helper, and no word came back that the fields were restored.
    public static let undoUnanswered: WorkLine = {
        let caption = "My helper didn't confirm the undo, so check the fields."
        return WorkLine(LineContent(figure: .error, text: caption, emphasis: .plain), text: caption)
    }()

    /// The connection to the helper dropped while a run was going or its stop was unanswered.
    /// Nothing says how far the helper got, so the line claims nothing about it.
    public static let lostTouch: WorkLine = {
        let caption = "I lost touch with my helper, so I can't say how far this got."
        return WorkLine(LineContent(figure: .error, text: caption, emphasis: .plain), text: caption)
    }()

    /// The helper took the proposal back before Tab.
    public static func withdrawn(_ reason: OfferWithdrawn.Reason) -> String {
        switch reason {
        case .expired: return "That plan expired before it ran. Ask again."
        case .settings: return "Caret was paused, so that plan won't run."
        case .stale, .diverged: return "The window changed, so that plan no longer fits. Ask again."
        case .taken, .dismissed, .idle, .reoffered: return "That plan was put away before it ran. Ask again."
        }
    }
    public static let yours = "You do this"

    /// The card's title: what the plan does, in the app it does it in. The helper's header echoes
    /// the window title ("1 field in 'Caret Fixture — Executor'"), which says where but not what;
    /// the steps under it carry the values. Two fields are named, more are counted, so the title
    /// stays one line at the list's 320 pt.
    ///   Fill Reference in Caret Fixture
    ///   Fill Name and Email in Caret Fixture
    ///   Fill 3 fields in Caret Fixture
    ///   You press Send in Mail            (a plan that only hands a press over)
    public static func title(fields: [String], writes: Int, press: String?, app: String) -> String {
        let names = fields.map(fieldName)
        let named = names.count == writes && !names.contains(where: \.isEmpty)
        switch writes {
        case 0: return press.map { "You press \($0) in \(app)" } ?? "Nothing to fill in \(app)"
        case 1 where named: return "Fill \(names[0]) in \(app)"
        case 2 where named: return "Fill \(names[0]) and \(names[1]) in \(app)"
        default: return "Fill \(Captions.fields(writes)) in \(app)"
        }
    }

    /// A field write in plain words: Put “Priya Raman” in Name.
    public static func write(_ value: String, into field: String) -> String {
        let name = fieldName(field)
        return "Put \u{201C}\(value)\u{201D} in \(name.isEmpty ? field.trimmingCharacters(in: .whitespacesAndNewlines) : name)"
    }

    /// A field's label as a title names it: without the marker a form puts after a required
    /// field's label. Q1 (A18, bug 16) showed "Fill Email * in Google Chrome" with the asterisk
    /// wrapped onto its own line. Strips trailing asterisks (ASCII, full-width, heavy), a trailing
    /// "(required)" in any case, and a colon left before them. A label that is only a marker comes
    /// back empty, so a title counts that field rather than naming it.
    public static func fieldName(_ label: String) -> String {
        var name = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let markers: Set<Character> = ["*", "\u{FF0A}", "\u{2731}", "\u{2217}"]
        while true {
            let before = name
            while let last = name.last, markers.contains(last) { name.removeLast() }
            if name.lowercased().hasSuffix("(required)") { name.removeLast("(required)".count) }
            name = name.trimmingCharacters(in: .whitespacesAndNewlines)
            if name.hasSuffix(":") { name.removeLast() }
            name = name.trimmingCharacters(in: .whitespacesAndNewlines)
            if name == before { break }
        }
        return name
    }

    static let unlabelled = "the unlabelled button"

    /// A press left to the user: Press Send. A press in a permission dialog or system prompt (B22's
    /// `system`) says where it is, since the button alone ("Allow") does not say what it grants.
    public static func press(_ label: String, why: PlanProposal.HandoffWhy) -> String {
        let name = label.isEmpty ? unlabelled : label
        switch why {
        case .outbound, .destructive, .money, .unverifiable: return "Press \(name)"
        case .system: return "Press \(name) in the system prompt"
        }
    }

    /// The plan reached the press it leaves to the user.
    public static func handoff(press label: String?, app: String, filled: Int, field: HandedField? = nil) -> WorkLine {
        // A field handed over instead of written (B20, B23) comes before any press: it is the step
        // the run stopped at.
        let turn = field.map { Captions.handedField($0, app: app) } ?? label.map { "Your turn: press \($0) in \(app)" } ?? Captions.handoff(app: app)
        let caption = filled > 0 ? "Filled \(Captions.fields(filled)). \(turn)" : turn
        return WorkLine(LineContent(figure: .needsYou, text: caption, emphasis: .plain), text: caption)
    }

    /// Real input in the window paused the run; the activity list carries Continue.
    public static func paused(app: String) -> WorkLine {
        let caption = "Paused because you worked in \(app). Continue it from the list below."
        return WorkLine(LineContent(figure: .needsYou, text: caption, emphasis: .plain), text: caption)
    }

    /// Why no plan was proposed, naming what is missing where the helper's detail names it. The
    /// detail is the helper's sentence for people (helper/src/planner/validate.ts and planner.ts);
    /// only the formats listed in `quoted` are read for a value, and anything else gets the code's
    /// sentence alone, so a changed detail can lose the value but never put a wrong one on screen.
    public static func planError(_ failure: PlanProposal.Failure?) -> String {
        guard let failure else { return "Something went wrong while I planned, so nothing will run." }
        let q = quoted(failure)
        switch failure.code {
        case .untracedValue:
            return q.map { "I couldn't find \u{201C}\($0)\u{201D} on screen, in what I remember, or in what you asked." }
                ?? "I couldn't find that value on screen, in what I remember, or in what you asked."
        case .nothingToDo:
            return q.map { "I couldn't find anything to fill or press in \u{201C}\($0)\u{201D}." } ?? "I couldn't find anything to fill or press for that."
        case .noWindow: return "I couldn't find an open window that can do that."
        case .unknownWindow: return q.map { "I couldn't find a window called \u{201C}\($0)\u{201D}." } ?? "The window I planned for closed while I planned."
        // B21: the window the request named is one the reader has not read (closed, never walked,
        // or an app it skips).
        case .unseenWindow: return "I haven't read that window, so I can't plan in it. Click into it and ask again."
        case .ambiguousWindow: return "More than one window matches. Click into the one you mean and ask again."
        case .unknownTarget: return "A field I planned for changed or disappeared while I planned. Ask again."
        case .ambiguousTarget: return "More than one field matches. Name the one you mean."
        case .notEditable:
            if failure.detail.contains("password") { return "That's a password field, which I leave to you." }
            return q.map { "I can't write in \u{201C}\($0)\u{201D}." } ?? "I can't write in that field."
        case .wrongKind: return misfit(failure.detail) ?? "That value doesn't fit the field it would go in, so I didn't plan it."
        case .unsure: return "I wasn't sure enough which field or window you meant. Try naming it."
        case .multipleWindows: return "That needs more than one window, and I act in one at a time."
        case .unsupportedStep: return "That needs a step I don't take: I fill fields and leave buttons to you."
        case .schema, .stepAfterHandoff, .riskMismatch: return "My plan for that didn't pass its checks, so I won't run it."
        case .unavailable: return "I can't plan right now. Check that Caret isn't paused and its helper is running."
        case .jevFailed: return "I couldn't reach the model I plan with. Try again in a moment."
        case .privacy: return "Planning that would send too much of a window off this Mac, so I didn't."
        case .internal: return "Something went wrong while I planned, so nothing will run."
        }
    }

    /// The single-quoted value in a detail whose format is known to carry one, as the helper writes
    /// them (validate.ts prefixes a step as `step 1 ('<says>')`): `step 1 ('…'): 'ORD-1' is not in any
    /// window…`, `step 1 ('…'): 'Label' is not a field…`, `step 1 ('…'): no open window matches
    /// 'Title'`, and planner.ts's `'Title' has no field…`. Nil for any other shape.
    static func quoted(_ failure: PlanProposal.Failure) -> String? {
        let detail = failure.detail
        switch failure.code {
        // A value that itself holds the step prefix's closing "'): '" makes the split ambiguous;
        // then no value is named rather than a wrong one.
        case .untracedValue: return once(detail, "'): '") ? between(detail, opener: "'): '", marker: "' is not in any window") : nil
        case .notEditable: return once(detail, "'): '") ? between(detail, opener: "'): '", marker: "' is not a field") : nil
        case .nothingToDo: return detail.hasPrefix("'") ? between(detail, opener: "'", marker: "' has no field") : nil
        case .unknownWindow:
            guard let r = detail.range(of: "): no open window matches '"), detail.hasSuffix("'") else { return nil }
            let value = String(detail[r.upperBound...].dropLast())
            return value.isEmpty ? nil : value
        default: return nil
        }
    }

    /// What the helper says a value is (helper/src/fill/kinds.ts KIND_SAYS, plus misfit's "text with
    /// digits") and what a field takes (FIT_SAYS). The sentence uses only these words, so a detail in
    /// another shape gives the plain sentence rather than whatever text it carries.
    static let valueKinds: Set<String> = [
        "an email address", "a web link", "a phone number", "an amount", "a whole address", "a street line", "plain text", "text with digits",
    ]
    static let fieldKinds: Set<String> = [
        "an email address", "a phone number", "a web link", "a city", "a street line", "an address", "a name", "a date", "a time", "an amount",
    ]

    /// `wrongKind` as validate.ts writes it: `step 1 ('City holds 455 Congress Ave, Austin'): '455
    /// Congress Ave, Austin' is a whole address, and the field takes a city`. Gives "City takes a
    /// city, not a whole address.", or "That field takes …" when the step names no field. Nil when
    /// either kind is not one the helper writes.
    static func misfit(_ detail: String) -> String? {
        let takes = ", and the field takes "
        guard let t = detail.range(of: takes, options: .backwards),
              let i = detail[..<t.lowerBound].range(of: "' is ", options: .backwards) else { return nil }
        let kind = String(detail[i.upperBound..<t.lowerBound])
        let fits = detail[t.upperBound...].components(separatedBy: " or ")
        guard valueKinds.contains(kind), !fits.isEmpty, fits.allSatisfy(fieldKinds.contains) else { return nil }
        // The step's field, from planner.ts's `<field> holds <value>`; a value can hold anything, so
        // the name ends at the first " holds ".
        var field = "That field"
        if detail.hasPrefix("step "), let open = detail.range(of: " ('"), let holds = detail[open.upperBound...].range(of: " holds ") {
            let name = String(detail[open.upperBound..<holds.lowerBound]).trimmingCharacters(in: .whitespaces)
            if !name.isEmpty, !name.contains("'") { field = name }
        }
        return "\(field) takes \(fits.joined(separator: " or ")), not \(kind)."
    }

    private static func once(_ text: String, _ part: String) -> Bool {
        text.components(separatedBy: part).count == 2
    }

    /// The text between the last `opener` before the first `marker`, and that marker.
    private static func between(_ text: String, opener: String, marker: String) -> String? {
        guard let end = text.range(of: marker),
              let open = text[..<end.lowerBound].range(of: opener, options: .backwards) else { return nil }
        let value = String(text[open.upperBound..<end.lowerBound])
        return value.isEmpty ? nil : value
    }
}
