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
    }

    /// One step of a proposed plan, as the card lists it.
    public struct Step: Equatable, Sendable, Codable {
        public enum State: String, Codable, Sendable { case pending, running, done, failed }
        /// "Put “Priya Raman” in Name", "Press Send".
        public var text: String
        /// A press the plan leaves to the user: the card marks it "You do this", and Caret never makes it.
        public var yours: Bool
        public var state: State

        public init(text: String, yours: Bool = false, state: State = .pending) {
            self.text = text
            self.yours = yours
            self.state = state
        }
    }

    /// The helper's proposal, reduced to what the card shows and what Tab sends.
    public struct Card: Equatable, Sendable, Codable {
        /// The spec's header: "2 fields in 'Caret Fixture — Executor'".
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

        public init(title: String, app: String, steps: [Step], more: Int, action: String, offerKey: String, actionId: String, writes: Int, press: String?) {
            self.title = title
            self.app = app
            self.steps = steps
            self.more = more
            self.action = action
            self.offerKey = offerKey
            self.actionId = actionId
            self.writes = writes
            self.press = press
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
    private var waitTimer: SurfaceTimer?
    private var requests = 0
    /// The first step of a running plan not yet done, and its step count, from its progress.
    private var nextStep: Int?
    private var steps = 0

    private let clock: SurfaceClock
    private let character: () -> FigureCharacter
    /// Writes one message to the helper; false when it is not connected.
    public var send: (Send) -> Bool = { _ in false }
    /// Called after every change, for the view and the debug socket.
    public var onChange: () -> Void = {}

    public init(clock: SurfaceClock, character: @escaping () -> FigureCharacter = { .pebble }) {
        self.clock = clock
        self.character = character
    }

    var nowMs: Int64 { Int64((clock.now.timeIntervalSince1970 * 1000).rounded()) }

    // MARK: - From the user

    /// The field's text changed. A new instruction replaces a card that is not running, and an
    /// answer still on its way is no longer wanted.
    public func edit(_ text: String) {
        guard text != self.text else { return }
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
        nextStep = nil
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
            _ = send(.stop(OfferStop(offerId: card.offerKey, at: nowMs)))
            stopping = card.offerKey
            for i in card.steps.indices where card.steps[i].state == .running { card.steps[i].state = .pending }
            settle(.ended(card, WorkLines.stoppedByYou(next: nextStep ?? (steps > 0 ? 0 : nil), of: steps)))
            return true
        case .asking, .proposed, .failed, .ended:
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
        switch phase {
        case .asking: settle(.failed(AskCopy.helperDown))
        case .running(let card):
            let didSome = card.steps.contains { $0.state == .done }
            settle(.ended(card, didSome ? WorkLines.helperStopped : WorkLines.acceptUnsent))
        default: onChange()
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
            guard let card = Self.card(proposal) else { return settle(.failed(AskCopy.planError(nil))) }
            settle(.proposed(card))
        }
    }

    public func receive(_ progress: TaskProgress) {
        if case .ended(var card, let line) = phase, stopping == progress.taskId, card.offerKey == progress.taskId {
            // The helper's own ending for a run Esc stopped: the step it stopped before, or Done when
            // it finished first. The line says it once; nothing else the run reports changes it.
            let corrected: WorkLine
            switch progress.phase {
            case .stopped:
                corrected = WorkLines.stopped(app: card.app, reason: progress.stopReason ?? .error, next: progress.step, steps: progress.steps, fillFilled: nil)
            case .done:
                for i in card.steps.indices where !card.steps[i].yours { card.steps[i].state = .done }
                corrected = WorkLines.done(app: card.app, character: character())
            default:
                return
            }
            stopping = nil
            if corrected != line { settle(.ended(card, corrected)) }
            return
        }
        guard case .running(var card) = phase, progress.taskId == card.offerKey else { return }
        if progress.steps > 0 { steps = progress.steps }
        let index = progress.step.flatMap { Self.cardIndex(ofPlanStep: $0, in: card) }
        switch progress.phase {
        case .acting:
            nextStep = progress.step
            if let index { card.steps[index].state = .running }
            settle(.running(card))
        case .verified, .skipped:
            if let step = progress.step { nextStep = step + 1 }
            if let index { card.steps[index].state = .done }
            if let index, index + 1 < card.steps.count, !card.steps[index + 1].yours, card.steps[index + 1].state == .pending {
                card.steps[index + 1].state = .running
            }
            settle(.running(card))
        case .done:
            for i in card.steps.indices where !card.steps[i].yours { card.steps[i].state = .done }
            settle(.ended(card, WorkLines.done(app: card.app, character: character())))
        case .stopped:
            for i in card.steps.indices where card.steps[i].state == .running { card.steps[i].state = .failed }
            let reason = progress.stopReason ?? .error
            settle(.ended(card, WorkLines.stopped(app: card.app, reason: reason, next: progress.step ?? nextStep, steps: steps, fillFilled: nil)))
        case .handoff:
            for i in card.steps.indices where !card.steps[i].yours { card.steps[i].state = .done }
            let line = progress.blocked.map(WorkLines.blocked) ?? AskCopy.handoff(press: card.press, app: card.app, filled: card.writes)
            settle(.ended(card, line))
        case .paused:
            for i in card.steps.indices where card.steps[i].state == .running { card.steps[i].state = .pending }
            settle(.ended(card, AskCopy.paused(app: card.app)))
        case .started, .undone:
            settle(.running(card))
        }
    }

    // MARK: - The card

    /// The card for a proposal: each field write, then the press left to the user. Nil when the
    /// proposal has no spec or no Tab action, which the helper's schema never sends.
    public static func card(_ proposal: PlanProposal) -> Card? {
        guard let spec = proposal.spec, let key = proposal.offerKey,
              let tab = spec.actions.first(where: { $0.key == .tab }) else { return nil }
        var steps: [Step] = []
        var more = 0
        for block in spec.blocks {
            if case .fields(let fields) = block.content {
                more = fields.more
                for row in fields.rows {
                    steps.append(Step(text: AskCopy.write(row.value?.text ?? "", into: row.destination.text)))
                }
            }
        }
        let writes = steps.count + more
        if let handoff = proposal.handoff { steps.append(Step(text: AskCopy.press(handoff.label), yours: true)) }
        return Card(
            title: spec.header?.title.text ?? "", app: proposal.window?.appName ?? "the app", steps: steps, more: more,
            action: tab.label, offerKey: key, actionId: tab.id, writes: writes,
            press: proposal.handoff.map { $0.label.isEmpty ? AskCopy.unlabelled : $0.label }
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
        if case .ended = next {} else { stopping = nil }
        phase = next
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
    public static let yours = "You do this"

    /// A field write in plain words: Put “Priya Raman” in Name.
    public static func write(_ value: String, into field: String) -> String {
        "Put \u{201C}\(value)\u{201D} in \(field)"
    }

    static let unlabelled = "the unlabelled button"

    /// A press left to the user: Press Send.
    public static func press(_ label: String) -> String {
        "Press \(label.isEmpty ? unlabelled : label)"
    }

    /// The plan reached the press it leaves to the user.
    public static func handoff(press label: String?, app: String, filled: Int) -> WorkLine {
        let turn = label.map { "Your turn: press \($0) in \(app)" } ?? Captions.handoff(app: app)
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
        case .ambiguousWindow: return "More than one window matches. Click into the one you mean and ask again."
        case .unknownTarget: return "A field I planned for changed or disappeared while I planned. Ask again."
        case .ambiguousTarget: return "More than one field matches. Name the one you mean."
        case .notEditable:
            if failure.detail.contains("password") { return "That's a password field, which I leave to you." }
            return q.map { "I can't write in \u{201C}\($0)\u{201D}." } ?? "I can't write in that field."
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
        case .untracedValue: return between(detail, opener: "'): '", marker: "' is not in any window")
        case .notEditable: return between(detail, opener: "'): '", marker: "' is not a field")
        case .nothingToDo: return detail.hasPrefix("'") ? between(detail, opener: "'", marker: "' has no field") : nil
        case .unknownWindow:
            guard let r = detail.range(of: "): no open window matches '"), detail.hasSuffix("'") else { return nil }
            let value = String(detail[r.upperBound...].dropLast())
            return value.isEmpty ? nil : value
        default: return nil
        }
    }

    /// The text between the last `opener` before the first `marker`, and that marker.
    private static func between(_ text: String, opener: String, marker: String) -> String? {
        guard let end = text.range(of: marker),
              let open = text[..<end.lowerBound].range(of: opener, options: .backwards) else { return nil }
        let value = String(text[open.upperBound..<end.lowerBound])
        return value.isEmpty ? nil : value
    }
}
