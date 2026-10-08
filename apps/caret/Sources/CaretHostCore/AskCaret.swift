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
        /// Tab on a plan that attaches a file: the file the card proposed, for that run (H5).
        case confirmFile(FileConfirm)
        /// Tab on a question: the user's pick (B29).
        case answer(AskAnswer)
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
        // An attached file is not a field filled (H5 review #2).
        Set(card.steps.filter { !$0.yours && $0.state == .done && !isAttach($0, card) }.map { $0.field ?? $0.text }).count
    }

    static func isAttach(_ step: Step, _ card: Card) -> Bool {
        card.attach.map { $0.field == step.field } ?? false
    }

    /// Where a hand-off ends the card: the row it stopped at (a field handed over, or the attach step
    /// handed back, H5 review #2), and the line. Rows before that are done; that row stays to do.
    static func handoff(_ progress: TaskProgress, card: Card) -> (at: Int?, line: WorkLine) {
        if let a = card.attach, progress.step == a.step, let row = card.steps.firstIndex(where: { isAttach($0, card) }) {
            let line = progress.blocked.map(WorkLines.blocked) ?? AskCopy.attachHandedBack(a, app: card.app, filled: filled(card))
            return (row, line)
        }
        let field = HandedField.parse(progress.detail)
        let at = field == nil ? nil : progress.step.flatMap { cardIndex(ofPlanStep: $0, in: card) }
        return (at, progress.blocked.map(WorkLines.blocked) ?? AskCopy.handoff(press: card.press, app: card.app, filled: filled(card), field: field))
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
        /// H5: the plan attaches a file; the card's step for it, and the file it proposes when one was found.
        public var attach: Attach?

        public struct Attach: Equatable, Sendable, Codable {
            public var field: String
            public var wants: String
            public var file: ProposedFile?
            /// The plan step that attaches it (`PlanProposal.Attach.step`).
            public var step: Int
            public init(field: String, wants: String, file: ProposedFile?, step: Int = 0) { self.field = field; self.wants = wants; self.file = file; self.step = step }
        }

        public init(title: String, app: String, steps: [Step], more: Int, action: String, offerKey: String, actionId: String, writes: Int, press: String?, pid: Int32? = nil, attach: Attach? = nil) {
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
            self.attach = attach
        }
    }

    public enum Phase: Equatable, Sendable {
        /// The field alone, empty or holding what the user typed.
        case idle
        /// The instruction went out; the helper is planning.
        case asking(requestId: String)
        /// A plan to take with Tab or dismiss with Esc.
        case proposed(Card)
        /// B29: the helper asks which of its choices the user means. Tab answers with the highlighted
        /// choice, or with the ones Space selected; Esc dismisses it.
        case question(Question)
        /// No plan, and why in a sentence (`AskCopy.planError`).
        case failed(String)
        /// H11: the Ask was about a page, and its preview is in the page task panel at the form. The desk
        /// says so in one line and steps aside (`onAtForm`), so the browser has the keys again.
        case atForm
        /// Tab took the plan; the helper is running it.
        case running(Card)
        /// The run ended: the steps as they ended and the line that says how.
        case ended(Card, WorkLine)
    }

    /// An Ask's question as the desk shows it: the helper's question, the row the arrows moved to, and
    /// the rows Space selected (a fields question only).
    public struct Question: Equatable, Sendable {
        public var ask: AskQuestion
        public var highlight: Int
        public var selected: Set<String>

        public init(ask: AskQuestion, highlight: Int = 0, selected: Set<String> = []) {
            self.ask = ask
            self.highlight = highlight
            self.selected = selected
        }

        /// What Tab sends: the selected rows in the question's order, else the highlighted one.
        public var picks: [String] {
            let chosen = ask.options.map(\.id).filter(selected.contains)
            if !chosen.isEmpty { return chosen }
            return ask.options.indices.contains(highlight) ? [ask.options[highlight].id] : []
        }
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
    /// Tab sent the proposed file for the plan on the card; the run starts when the helper confirms it.
    private var confirming: String?

    /// No answer to a fileConfirm in this long fails the card. Assumed: the helper reads a file of at
    /// most 10 MB once, which takes well under a second on a Mac.
    public static let confirmWait: TimeInterval = 5

    /// A file the user picked for the plan's attach step; nil for none. Nothing in the app sets it: Caret never searches
    /// the disk for one (lead decision, H11, retiring H5's guess by name), so the card leaves the attach to the user.
    /// The user's own pick arrives on the goal path (P3, `goalAccept.confirmedFile`).
    public var likelyFile: (_ wants: String) -> ProposedFile? = { _ in nil }

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
    /// H11: the desk handed a page goal's preview to the panel at the form; the host closes the desk.
    public var onAtForm: () -> Void = {}

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
        case .asking, .proposed, .question, .failed, .ended, .atForm: settle(.idle)
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

    /// Tab: run the proposed plan. False when no card is waiting, so the key does what it would. A plan
    /// that attaches a file confirms the file the card proposed first (H5); the run starts on the
    /// helper's yes. Tab while that answer is on its way takes the key and does nothing more.
    @discardableResult
    public func tab() -> Bool {
        if case .question(let q) = phase { return answer(q) }
        // The preview is at the form, and Tab there is the panel's: the desk gets out of the way at once.
        if case .atForm = phase {
            onAtForm()
            return true
        }
        guard case .proposed(let card) = phase else { return false }
        if confirming != nil { return true }
        if let file = card.attach?.file {
            requests += 1
            let id = "file-\(requests)"
            guard send(.confirmFile(FileConfirm(requestId: id, at: nowMs, taskId: card.offerKey, path: file.path))) else {
                settle(.ended(card, WorkLines.acceptUnsent))
                return true
            }
            confirming = id
            waitTimer?.cancel()
            waitTimer = clock.schedule(after: Self.confirmWait, repeats: false) { [weak self] in
                guard let self, self.confirming == id else { return }
                self.settle(.failed(AskCopy.fileUnanswered))
            }
            onChange()
            return true
        }
        return run(card)
    }

    /// The helper's answer to the file Tab confirmed. Confirmed: the run starts. Refused: the card
    /// says why in the helper's words, and nothing runs.
    public func receive(_ reply: FileConfirmReply) {
        guard let id = confirming, reply.requestId == id, case .proposed(let card) = phase, reply.taskId == card.offerKey else { return }
        confirming = nil
        waitTimer?.cancel()
        waitTimer = nil
        switch reply.outcome {
        case .confirmed: run(card)
        case .refused: settle(.failed(reply.says.flatMap { AskCopy.showable($0) ? $0 : nil } ?? AskCopy.fileRefused))
        }
    }

    @discardableResult
    private func run(_ proposed: Card) -> Bool {
        var card = proposed
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

    /// Up or Down on a question moves the highlight, wrapping. False when no question shows.
    @discardableResult
    public func move(_ step: Int) -> Bool {
        guard case .question(var q) = phase else { return false }
        let n = q.ask.options.count
        q.highlight = ((q.highlight + step) % n + n) % n
        settle(.question(q))
        return true
    }

    /// Space on a question: selects or clears the highlighted row of a fields question. A question
    /// that takes one answer has nothing to select, and Space does nothing there. True while a
    /// question shows, so the space is not typed into the instruction.
    @discardableResult
    public func toggle() -> Bool {
        guard case .question(var q) = phase else { return false }
        guard q.ask.pick == .many, q.ask.options.indices.contains(q.highlight) else { return true }
        let id = q.ask.options[q.highlight].id
        if q.selected.remove(id) == nil { q.selected.insert(id) }
        settle(.question(q))
        return true
    }

    /// Sends the question's picks; the reply comes under a new request id, as a plan or another question.
    private func answer(_ q: Question) -> Bool {
        let picks = q.picks
        guard !picks.isEmpty else { return true }
        guard q.ask.expires > nowMs else {
            settle(.failed(AskCopy.planError(PlanProposal.Failure(code: .questionGone, detail: "the question expired"))))
            return true
        }
        requests += 1
        let id = "ask-\(requests)"
        guard send(.answer(AskAnswer(requestId: id, at: nowMs, questionId: q.ask.questionId, picks: picks))) else {
            settle(.failed(AskCopy.helperDown))
            return true
        }
        settle(.asking(requestId: id))
        waitTimer?.cancel()
        waitTimer = clock.schedule(after: Self.answerWait, repeats: false) { [weak self] in
            guard let self, case .asking(let pending) = self.phase, pending == id else { return }
            self.settle(.failed(AskCopy.noAnswer))
        }
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
        case .failed, .ended, .atForm:
            // One Esc puts away the answer and the instruction it answered (A18, bug 14).
            text = ""
            settle(.idle)
            return true
        case .asking, .proposed, .question:
            // The instruction stays to edit: the plan, the question, or the wait for one, is what goes.
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
        // The helper keeps a question for the connection that was asked it (B29).
        case .question: settle(.failed(AskCopy.planGone))
        // The panel at the form says what became of its task.
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

    /// B29: the helper asks one thing before it can plan. Only the answer to this field's own
    /// request, while it waits; the question lapses at its `expires`.
    public func receive(_ question: AskQuestion) {
        guard case .asking(let id) = phase, question.requestId == id else { return }
        settle(.question(Question(ask: question)))
        let qid = question.questionId
        let wait = max(0, Double(question.expires - nowMs) / 1000)
        waitTimer = clock.schedule(after: wait, repeats: false) { [weak self] in
            guard let self, case .question(let q) = self.phase, q.ask.questionId == qid else { return }
            self.settle(.failed(AskCopy.planError(PlanProposal.Failure(code: .questionGone, detail: "the question expired"))))
        }
    }

    /// The answer to a request this field sent. Any other answer, or one that comes after the
    /// field moved on, is not this field's and changes nothing.
    public func receive(_ proposal: PlanProposal) {
        guard case .asking(let id) = phase, proposal.requestId == id else { return }
        switch proposal.outcome {
        case .error:
            settle(.failed(AskCopy.planError(proposal.error)))
        case .proposed:
            guard let card = Self.card(proposal, file: proposal.attach.flatMap { likelyFile($0.wants) }, now: clock.now) else {
                return settle(.failed(AskCopy.planError(nil)))
            }
            settle(.proposed(card))
        }
    }

    /// H11: the answer to this desk's Ask came back as a goal, which only a page fill is since L1. Its
    /// preview goes to the panel at the form when `toForm` takes it, and the desk says so in one line; a
    /// stop is said in the helper's own words (a 402 says the account is out of credits). True when this
    /// was the desk's answer, so the caller does not treat it as anyone else's.
    @discardableResult
    public func receive(_ goal: GoalProgress, toForm: (GoalProgress) -> Bool) -> Bool {
        guard case .asking(let id) = phase, goal.requestId == id else { return false }
        switch goal.event {
        case .segment(let p):
            guard p.page != nil else {
                // A goal that is not a page's needs H9's goal card, which this host does not show yet. Only a
                // developer's plan writer makes one (L1): the helper plans a native Ask as before without one.
                settle(.failed(AskCopy.goalNotShown))
                return true
            }
            if toForm(goal) {
                settle(.atForm)
                onAtForm()
            } else {
                settle(.failed(AskCopy.pageBusy))
            }
        case .stopped(let stop):
            settle(.failed(AskCopy.showable(stop.says) ? stop.says : AskCopy.planError(nil)))
        case .step, .finished:
            settle(.failed(AskCopy.planError(nil)))
        }
        return true
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
                corrected = Self.handoff(progress, card: card).line
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
        case .idle, .asking, .proposed, .question, .failed, .atForm: return
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
            // A press is handed over after every write; a field handed over (B20, B23), or an attach
            // handed back, is the step the run stopped at, so only the rows before it are done.
            let handedAt = Self.handoff(progress, card: card).at
            for i in card.steps.indices where !card.steps[i].yours && handedAt.map({ i < $0 }) ?? true { card.steps[i].state = .done }
            if let handedAt { card.steps[handedAt].state = .pending }
            settle(.ended(card, Self.handoff(progress, card: card).line))
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

    /// The card for a proposal: each field write, then each control the user sets (H5: a fields row
    /// in the state `yours`, "Pizza size: Large"), then each field left to the user with the helper's
    /// reason (H1), then the press left to the user. Nil when the
    /// proposal has no spec or no Tab action, which the helper's schema never sends.
    public static func card(_ proposal: PlanProposal, file: ProposedFile? = nil, now: Date = Date(), calendar: Calendar = .current) -> Card? {
        guard let spec = proposal.spec, let key = proposal.offerKey,
              let tab = spec.actions.first(where: { $0.key == .tab }) else { return nil }
        var steps: [Step] = []
        var fields: [String] = []
        var controls: [Step] = []
        var toSet: [String] = []
        var more = 0
        var moreToSet = 0
        for block in spec.blocks {
            guard case .fields(let list) = block.content else { continue }
            // The helper puts controls in a block of their own, so a block's `more` is all writes or all controls.
            let yoursBlock = !list.rows.isEmpty && list.rows.allSatisfy { $0.state == .yours }
            if yoursBlock { moreToSet += list.more } else { more += list.more }
            for row in list.rows {
                if row.state == .yours {
                    toSet.append(row.destination.text)
                    controls.append(Step(text: AskCopy.set(row.value?.text ?? "", in: row.destination.text), yours: true, field: row.destination.text))
                } else {
                    fields.append(row.destination.text)
                    steps.append(Step(text: AskCopy.write(row.value?.text ?? "", into: row.destination.text), field: row.destination.text))
                }
            }
        }
        let writes = steps.count + more
        // H5: the attach step, after the writes. The helper's spec lists it as a ready row, which the
        // loop above read as a write; the card says it with the file it proposes, or as the user's.
        var attach: Card.Attach?
        var attachRow = 0
        if let a = proposal.attach {
            attach = Card.Attach(field: a.field, wants: a.wants, file: file, step: a.step)
            if let i = steps.firstIndex(where: { $0.field == a.field }) {
                steps.remove(at: i)
                fields.removeAll { $0 == a.field }
                attachRow = 1
            }
            steps.append(file.map { Step(text: AskCopy.attach($0, in: a.field, now: now, calendar: calendar), field: a.field) }
                ?? Step(text: AskCopy.set(a.wants, in: a.field), yours: true, field: a.field))
        }
        let writesNow = writes - attachRow
        if moreToSet > 0 { controls.append(Step(text: AskCopy.moreToSet(moreToSet), yours: true)) }
        steps += controls
        // H1: the fields the plan leaves to the user, each with the helper's reason (I3's "Left to you", B25's "You type"),
        // before the press, which stays last so the plan's hand-off step maps to it (`cardIndex`).
        steps += left(spec)
        if let handoff = proposal.handoff { steps.append(Step(text: AskCopy.press(handoff.label, why: handoff.why), yours: true)) }
        let app = proposal.window?.appName ?? "the app"
        let press = proposal.handoff.map { $0.label.isEmpty ? AskCopy.unlabelled : $0.label }
        let title = attach.map { AskCopy.attachTitle($0, writes: writesNow, fields: fields, app: app) }
            ?? AskCopy.title(fields: fields, writes: writes, press: press, app: app, toSet: toSet + Array(repeating: "", count: moreToSet))
        return Card(
            title: title, app: app, steps: steps, more: more,
            action: tab.label, offerKey: key, actionId: tab.id, writes: writesNow, press: press,
            pid: proposal.window.map { Int32(truncatingIfNeeded: $0.pid) }, attach: attach
        )
    }

    /// The steps for the fields a plan leaves to the user: every row of a facts block whose first row carries one of the
    /// helper's left-to-you labels (`AskCopy.leftLabels`). A row says the helper's sentence; its "and N more" row (the
    /// helper's `count` rule) says how many more. Each is the user's, so it never takes a mark or counts as filled.
    static func left(_ spec: PopupSpec) -> [Step] {
        spec.blocks.flatMap { block -> [Step] in
            guard case .facts(let facts) = block.content, let label = facts.rows.first?.label, AskCopy.leftLabels.contains(label) else { return [] }
            return facts.rows.map { row in
                if case .derived(let rule, let from) = row.value.ref, rule == AskCopy.countRule, !from.isEmpty {
                    return Step(text: AskCopy.moreLeft(from.count), yours: true)
                }
                return Step(text: AskCopy.left(row.value.text), yours: true)
            }
        }
    }

    /// The card's step for a plan step: the listed writes first, then the hand-off, which follows
    /// every write in the plan (helper/src/planner/validate.ts, stepAfterHandoff). Nil for a write
    /// the card did not list.
    static func cardIndex(ofPlanStep step: Int, in card: Card) -> Int? {
        // H5: the attach step has a row of its own wherever the plan puts it; the writes around it count
        // as if it were not there, and a write the card does not list maps to no row (review #3).
        if let a = card.attach, step == a.step { return card.steps.firstIndex { isAttach($0, card) } }
        let write = card.attach.map { step > $0.step ? step - 1 : step } ?? step
        if write < card.writes - card.more { return write }
        if write == card.writes, let last = card.steps.indices.last, card.steps[last].yours { return last }
        return nil
    }

    private func settle(_ next: Phase) {
        switch (phase, next) {
        // A question keeps its expiry while the arrows and Space move within it.
        case (.question(let a), .question(let b)) where a.ask.questionId == b.ask.questionId: break
        case (_, .asking): break
        default:
            waitTimer?.cancel()
            waitTimer = nil
        }
        // Any new line ends the card's wait for a stop's answer (`escape` sets it again after its own
        // settle); the stop's deadline goes on without it. And its wait for a file's confirmation.
        stopping = nil
        confirming = nil
        switch next {
        case .running, .ended: break
        case .idle, .asking, .proposed, .question, .failed, .atForm: tracking = nil
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
        /// B29: the question showing, its highlighted row and the rows Space selected.
        public var question: AskQuestion?
        public var highlight: Int?
        public var selected: [String]?
    }

    public var debugInfo: DebugInfo {
        var info = DebugInfo(text: text, phase: "idle", linked: linked)
        switch phase {
        case .idle: break
        case .asking(let id): info.phase = "asking"; info.requestId = id
        case .proposed(let card): info.phase = "proposed"; info.card = card
        case .question(let q):
            info.phase = "question"; info.question = q.ask; info.highlight = q.highlight
            info.selected = q.ask.options.map(\.id).filter(q.selected.contains)
        case .failed(let sentence): info.phase = "failed"; info.line = sentence
        case .atForm: info.phase = "atForm"; info.line = AskCopy.atForm
        case .running(let card): info.phase = "running"; info.card = card
        case .ended(let card, let line): info.phase = "ended"; info.card = card; info.line = line.text
        }
        return info
    }
}

/// The words of the ask field and its card. First person: the card is Caret's answer to what the
/// user asked it, as the brief's example reads ("I couldn't find the order number on screen").
public enum AskCopy {
    /// B29: one choice of a question, as its row reads: the main words, and the quieter words after
    /// them when there are any.
    public static func option(_ o: AskQuestion.Option) -> (title: String, detail: String?) {
        switch o {
        case .field(_, let label, let section): return (label, section)
        case .window(_, let app, let title):
            let t = title.trimmingCharacters(in: .whitespaces)
            return (app, t.isEmpty || t == app ? nil : t)
        // The helper's own words for a value from memory (helper/src/fill/about.ts ABOUT_SAYS).
        case .memory: return ("What you told Caret", nil)
        case .you: return ("You", "your own details")
        case .person(_, let name): return (name, nil)
        }
    }

    /// What Tab does on a question: answer with the highlighted row, or fill the fields Space selected.
    public static func answerLabel(_ q: AskCaret.Question) -> String {
        q.selected.isEmpty ? "Choose" : "Fill \(q.selected.count)"
    }

    /// What VoiceOver says the field does while a question shows.
    public static func questionHint(_ pick: AskQuestion.Pick) -> String {
        pick == .many
            ? "Up and Down move between the choices. Space selects one. Tab answers. Escape dismisses."
            : "Up and Down move between the choices. Tab answers. Escape dismisses."
    }

    public static let placeholder = "Ask Caret to do something"
    /// H11: the desk's one line when an Ask's preview is at the form.
    public static let atForm = "Preview at the form"
    public static let pageBusy = "Caret is still filling this page. Ask again when it's done."
    /// A goal that is not a page's: only with a developer's plan writer (--dev-writer), and this host shows page goals only.
    public static let goalNotShown = "Caret can't show a plan like that here yet."
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
    ///   You set Pizza size in Chrome      (an Ask whose results are only controls, H5)
    public static func title(fields: [String], writes: Int, press: String?, app: String, toSet: [String] = []) -> String {
        let names = fields.map(fieldName)
        let named = names.count == writes && !names.contains(where: \.isEmpty)
        switch writes {
        case 0 where press == nil && !toSet.isEmpty:
            let set = toSet.map(fieldName)
            let setNamed = !set.contains(where: \.isEmpty)
            switch set.count {
            case 1 where setNamed: return "You set \(set[0]) in \(app)"
            case 2 where setNamed: return "You set \(set[0]) and \(set[1]) in \(app)"
            default: return "You set \(Captions.fields(set.count)) in \(app)"
            }
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

    /// A control the user sets, with its value: Pizza size: Large. Caret never writes or presses it.
    public static func set(_ value: String, in field: String) -> String {
        let name = fieldName(field)
        return "\(name.isEmpty ? field.trimmingCharacters(in: .whitespacesAndNewlines) : name): \(value)"
    }

    /// The file a plan attaches, as the card proposes it: Resume/CV: Resume.pdf, edited Tue.
    public static func attach(_ file: ProposedFile, in field: String, now: Date, calendar: Calendar = .current) -> String {
        "\(set(file.name, in: field)), \(LikelyFile.edited(file.modified, now: now, calendar: calendar))"
    }

    /// The card's title for a plan that attaches a file: "Attach Resume.pdf in Google Chrome", or what
    /// the plan wants when no file was found; a plan that also fills says both.
    public static func attachTitle(_ a: AskCaret.Card.Attach, writes: Int, fields: [String], app: String) -> String {
        let what = a.file?.name ?? a.wants
        guard writes > 0 else { return "Attach \(what) in \(app)" }
        let names = fields.map(fieldName)
        let filled = writes == 1 && names.count == 1 && !names[0].isEmpty ? names[0] : Captions.fields(writes)
        return "Fill \(filled) and attach \(what) in \(app)"
    }

    /// The run handed the attach back (no file confirmed, or the file changed after Tab).
    public static func attachHandedBack(_ a: AskCaret.Card.Attach, app: String, filled: Int) -> WorkLine {
        let turn = "Your turn: attach \(a.file?.name ?? a.wants) to \(fieldName(a.field)) in \(app). Caret didn't attach it."
        let caption = filled > 0 ? "Filled \(Captions.fields(filled)). \(turn)" : turn
        return WorkLine(LineContent(figure: .needsYou, text: caption, emphasis: .plain), text: caption)
    }

    /// No answer came to the file Tab confirmed.
    public static let fileUnanswered = "My helper didn't answer about the file, so nothing ran."
    /// The helper refused the file and sent no sentence Caret may show.
    public static let fileRefused = "I couldn't use that file, so nothing ran."

    /// Controls past the listed ones: "and 2 more to set".
    public static func moreToSet(_ n: Int) -> String { "and \(n) more to set" }

    /// H1: the labels of the plan spec's facts blocks that name fields left to the user (helper/src/planner/proposal.ts
    /// YOU_TYPE_LABEL and LEFT_TO_YOU_LABEL). The helper writes them for this host to read, as it writes `eventCard`.
    public static let leftLabels: Set<String> = ["You type", "Left to you"]
    /// The rule of a row that counts what a list did not show ("and 3 more").
    static let countRule = "count"

    /// A field left to the user, in the helper's words, as a step says it: no closing period, as no other step has one.
    ///   Pizza Size: Caret wasn't sure your request asks for it
    ///   Social Security number is yours to type. Caret doesn't type Social Security numbers
    public static func left(_ says: String) -> String {
        let s = says.trimmingCharacters(in: .whitespacesAndNewlines)
        return s.hasSuffix(".") ? String(s.dropLast()) : s
    }

    /// The fields left to the user past the ones the card lists.
    public static func moreLeft(_ n: Int) -> String { "and \(n) more Caret wasn't sure about" }

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
        // H5: the helper's own sentence (B26), shown as it is sent. One that could carry an id or a
        // ref is not shown, and the code's sentence below stands in.
        if let says = failure.says, showable(says) { return says }
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
        // B29: says.ts's sentence, for a helper that sends none.
        case .questionGone: return "That question has expired. Ask again."
        // I2: says.ts's sentence for outOfScope, for a helper that sends none.
        case .outOfScope: return "The form changed while Caret worked on it. Ask again."
        }
    }

    /// Whether the helper's sentence may be shown as it is: one line of at most 400 characters with
    /// no window id ("5150-1", "page:e1:7") and no element key ("standard/textfield:email~0").
    /// helper/src/planner/says.ts writes none; this keeps a changed helper from putting one on screen.
    public static func showable(_ says: String) -> Bool {
        let trimmed = says.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 400, !trimmed.contains(where: \.isNewline) else { return false }
        let ids = [#"\b\d+-\d+\b"#, #"\bpage:"#, #"~\d+\b"#, #"/standard/"#, #"\b[a-z]+:[a-z]"#]
        return !ids.contains { trimmed.range(of: $0, options: .regularExpression) != nil }
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
