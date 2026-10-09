import CaretScreenCore
import Foundation

/// The desk's card for a goal that is not a page fill (design CU-COUNSEL-20261009, slice 1): a reply drafted in Mail, an
/// event for the calendar, a native form. Before it, the desk said "Caret can't show a plan like that here yet." for
/// every such goal (`AskCaret.receive(_:toForm:)`); a page fill still goes to the panel at the form (H11).
///
/// One card shows one segment, the part of the goal that acts in one place. Its rows are the segment's steps in order,
/// each with the trust tier the helper gave it (protocol.ts GoalStepView.tier). A press handed to the user (`yours`:
/// send, submit, delete, pay) is not one of the rows: it is the card's last line, set apart, saying what it sends, to
/// whom, and why (R8: data, recipient, purpose), and Caret never makes it.
///
/// Keys: Tab accepts the segment as previewed (`goalAccept` with its digest); Esc puts the card away, or stops a run;
/// ⌘E edits the first drafted row, and Return sends the words as `goalEdit`, which the helper previews again under a
/// new digest that needs its own Tab. ⌘Z after a run undoes every task that wrote, newest first. A value type: it
/// decides, `AskCaret` sends and keeps time.
public struct GoalCard: Equatable, Sendable {
    public typealias Tier = GoalProgress.Step.Tier

    public struct Row: Equatable, Sendable {
        public enum State: String, Codable, Sendable { case pending, running, done, skipped, failed }
        public var step: Int
        public var kind: GoalProgress.Step.Kind
        public var tier: Tier
        public var says: String
        /// The whole text Caret composed for this write, shown as Caret's; nil for a copied value or the user's words.
        public var drafted: String?
        public var state: State

        /// The field a write names before its value ("Message: Thursday…" is Message), or nil.
        public var field: String? { GoalCopy.split(says)?.field }
        /// The value after the field's name, or nil.
        public var value: String? { GoalCopy.split(says)?.value }
        /// Caret makes this step; a hand-off is the user's.
        public var caretDoes: Bool { kind != .handoff }
    }

    public enum Stage: Equatable, Sendable {
        /// Waiting for Tab.
        case preview
        /// ⌘E opened the drafted row at `step`; `text` is what the field holds.
        case editing(step: Int, text: String)
        /// Return sent the words; the helper's new preview answers.
        case editSent(step: Int)
        case running
        /// Esc asked the run to stop; the helper's ending says where it stopped.
        case stopping
        case ended(Ending)
    }

    public struct Ending: Equatable, Sendable {
        public enum Kind: String, Sendable { case done, handoff, partial, stopped, notRun, undoing, undone }
        public var kind: Kind
        public var line: String
    }

    public var goalId: String
    public var segment: Int
    public var segments: Int
    public var digest: String
    public var expires: Int64
    public var place: GoalProgress.Place
    public var rows: [Row]
    public var warnings: [String]
    /// What the user asked, for the hand-off line's "For".
    public var instruction: String
    public var stage: Stage
    /// A note under the rows after the helper turned an edit down; cleared by the next preview.
    public var note: String?
    /// The executor task the running segment reports under (a receipt's `taskId`).
    public var taskId: String?
    /// Tasks that wrote (a field or a calendar event), oldest first: what ⌘Z undoes.
    public var tasks: [String] = []
    /// Steps whose words are the user's own, from an edit of Caret's draft: the card says so beside them.
    public var edited: Set<Int> = []
    /// What the undos answered so far: changes put back, and changes the helper could not put back.
    public var restored = 0
    public var notRestored = 0

    /// The card for a goal's first preview. Nil for a page segment, which is the panel's at the form.
    public init?(preview p: GoalProgress.Preview, goalId: String, instruction: String) {
        guard p.page == nil else { return nil }
        self.goalId = goalId
        segment = p.segment
        segments = p.segments
        digest = p.digest
        expires = p.expires
        place = p.place
        rows = p.steps.map(Self.row)
        warnings = p.warnings
        self.instruction = instruction
        stage = .preview
    }

    static func row(_ s: GoalProgress.Step) -> Row {
        Row(step: s.index, kind: s.kind, tier: s.tier ?? Self.tierBefore(s), says: s.says, drafted: s.drafted, state: .pending)
    }

    /// A helper before tiers: what its step kind says. A hand-off of a press reads "you press"; any other hand-off is a
    /// field the user sets.
    static func tierBefore(_ s: GoalProgress.Step) -> Tier {
        switch s.kind {
        case .write, .calendar: return .write
        case .attach: return .attach
        case .press: return .navigate
        case .handoff: return s.says.range(of: "press", options: .caseInsensitive) == nil ? .write : .yours
        }
    }

    // MARK: - What the card shows

    /// The press handed to the user that the card draws last and set apart: the last `yours` row.
    public var consequential: Row? { rows.last { $0.tier == .yours } }

    /// Every row but the consequential one, in the segment's order.
    public var listed: [Row] {
        guard let c = consequential else { return rows }
        return rows.filter { $0.step != c.step }
    }

    /// The drafted row ⌘E edits: the first one still drafted.
    public var editable: Row? { rows.first { $0.drafted != nil } }

    /// Steps Caret makes in this segment.
    public var caretSteps: Int { rows.filter(\.caretDoes).count }

    // MARK: - Keys

    /// Tab: the acceptance of the segment as previewed. Nil unless it waits for Tab and has not expired.
    public mutating func accept(nowMs: Int64) -> GoalAccept? {
        guard stage == .preview, expires > nowMs, caretSteps > 0 else { return nil }
        stage = .running
        note = nil
        if let first = rows.firstIndex(where: \.caretDoes) { rows[first].state = .running }
        return GoalAccept(goalId: goalId, segment: segment, digest: digest, at: nowMs)
    }

    /// ⌘E: opens the first drafted row with its text. False when nothing is drafted or the card is not a preview.
    public mutating func startEdit() -> Bool {
        guard stage == .preview, let row = editable, let text = row.drafted else { return false }
        stage = .editing(step: row.step, text: text)
        note = nil
        return true
    }

    /// The edit field's text changed.
    public mutating func editText(_ text: String) {
        guard case .editing(let step, _) = stage else { return }
        stage = .editing(step: step, text: text)
    }

    /// Return in the edit field: the words for the helper, or nil when they are empty, too long or unchanged (an
    /// unchanged draft goes back to the preview with nothing sent).
    public mutating func commitEdit(nowMs: Int64) -> GoalEdit? {
        guard case .editing(let step, let text) = stage else { return nil }
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if words == rows.first(where: { $0.step == step })?.drafted?.trimmingCharacters(in: .whitespacesAndNewlines) {
            stage = .preview
            return nil
        }
        guard !words.isEmpty, words.count <= GoalEdit.maxText else {
            note = words.isEmpty ? GoalCopy.editEmpty : GoalCopy.editTooLong
            return nil
        }
        stage = .editSent(step: step)
        edited.insert(step)
        return GoalEdit(goalId: goalId, segment: segment, digest: digest, step: step, text: words, at: nowMs)
    }

    public enum EscapeResult: Equatable, Sendable {
        /// The card goes; nothing ran or the run is over.
        case putAway
        /// Back to the preview from the edit field.
        case editClosed
        case stop(TaskControl)
        /// A stop is on its way.
        case held
    }

    public mutating func escape() -> EscapeResult {
        switch stage {
        case .editing:
            stage = .preview
            return .editClosed
        case .running:
            stage = .stopping
            return .stop(TaskControl(taskId: taskId ?? "\(goalId):s\(segment)", action: .stop))
        case .stopping:
            return .held
        case .preview, .editSent, .ended:
            return .putAway
        }
    }

    /// ⌘Z after the run: an undo for every task that wrote, newest first. Empty when there is nothing to undo.
    public mutating func undo() -> [TaskControl] {
        guard case .ended(let e) = stage, e.kind != .undoing, e.kind != .undone, !tasks.isEmpty else { return [] }
        let order = Array(tasks.reversed())
        restored = 0
        notRestored = 0
        stage = .ended(Ending(kind: .undoing, line: GoalCopy.undoing(place)))
        return order.map { TaskControl(taskId: $0, action: .undo) }
    }

    /// Whether ⌘Z has anything to take back now.
    public var undoable: Bool {
        guard case .ended(let e) = stage else { return false }
        return !tasks.isEmpty && e.kind != .undoing && e.kind != .undone
    }

    // MARK: - From the helper

    public enum Received: Equatable, Sendable {
        case ignored
        case applied
        /// A new segment, or a new preview of this one, waits for Tab.
        case preview
    }

    /// A later message of this card's goal: a new preview (after an edit, or the next segment once this one ran), a
    /// step's receipt, the stop, or the end.
    public mutating func receive(_ g: GoalProgress) -> Received {
        guard g.goalId == goalId else { return .ignored }
        switch g.event {
        case .segment(let p):
            guard p.page == nil else { return .ignored }
            let again = p.segment == segment && (stage == .preview || isEditSent || isEditing)
            let next = p.segment == segment + 1 && (stage == .running || isDone)
            guard again || next else { return .ignored }
            if next { edited = [] }
            segment = p.segment
            segments = p.segments
            digest = p.digest
            expires = p.expires
            place = p.place
            rows = p.steps.map(Self.row)
            warnings = p.warnings
            stage = .preview
            note = nil
            taskId = nil
            return .preview
        case .step(let r):
            guard r.segment == segment, stage == .running || stage == .stopping else { return .ignored }
            taskId = r.taskId
            guard let i = rows.firstIndex(where: { $0.step == r.step }) else { return .applied }
            switch r.phase {
            case .verified:
                rows[i].state = .done
                if rows[i].kind == .write || rows[i].kind == .attach || rows[i].kind == .calendar, !tasks.contains(r.taskId) { tasks.append(r.taskId) }
            case .skipped: rows[i].state = .skipped
            case .handoff: rows[i].state = .pending
            }
            if stage == .running, let next = rows.indices.first(where: { $0 > i && rows[$0].caretDoes && rows[$0].state == .pending }) {
                for k in rows.indices where rows[k].state == .running { rows[k].state = .pending }
                rows[next].state = .running
            }
            return .applied
        case .stopped(let s):
            if case .ended = stage { return .ignored }
            for k in rows.indices where rows[k].state == .running { rows[k].state = s.reason == .you ? .pending : .failed }
            stage = .ended(Ending(kind: s.segment == nil || stage == .preview ? .notRun : .stopped, line: GoalCopy.stopped(s, place: place)))
            return .applied
        case .finished(let e):
            if case .ended = stage { return .ignored }
            for k in rows.indices where rows[k].state == .running { rows[k].state = .pending }
            let kind: Ending.Kind = e.outcome == .done ? .done : e.outcome == .handoff ? .handoff : .partial
            stage = .ended(Ending(kind: kind, line: GoalCopy.finished(e, place: place, yours: consequential)))
            return .applied
        }
    }

    /// The helper's word that one undo finished, with what it put back and what it could not. True when it was one this
    /// card waited on. The rows go back to undone only when every change came back; otherwise the line says what is left.
    public mutating func undone(taskId: String, restored put: Int, notRestored left: Int) -> Bool {
        guard case .ended(let e) = stage, e.kind == .undoing, let i = tasks.firstIndex(of: taskId) else { return false }
        tasks.remove(at: i)
        restored += put
        notRestored += left
        if tasks.isEmpty {
            if notRestored == 0 {
                for k in rows.indices where rows[k].state == .done && rows[k].kind != .handoff { rows[k].state = .pending }
                stage = .ended(Ending(kind: .undone, line: GoalCopy.undone(place)))
            } else {
                stage = .ended(Ending(kind: .partial, line: GoalCopy.undonePartly(place, left: notRestored)))
            }
        }
        return true
    }

    /// The helper turned down the edit or the acceptance (protocol `error`, "goalEdit refused: …" or "goalAccept
    /// refused: …"). True when the card was waiting on one.
    public mutating func refused(_ message: String) -> Bool {
        if case .editSent(let step) = stage, message.hasPrefix("goalEdit refused: ") {
            edited.remove(step)
            stage = .preview
            note = GoalCopy.editRefused
            return true
        }
        if stage == .running, taskId == nil, message.hasPrefix("goalAccept refused: ") {
            for k in rows.indices where rows[k].state == .running { rows[k].state = .pending }
            stage = .ended(Ending(kind: .notRun, line: PageTaskCopy.acceptRefused(String(message.dropFirst("goalAccept refused: ".count)))))
            return true
        }
        return false
    }

    /// The preview waited past its time: nothing ran.
    public mutating func expired() {
        guard stage == .preview || isEditing || isEditSent else { return }
        stage = .ended(Ending(kind: .notRun, line: PageTaskCopy.expired))
    }

    /// The helper's connection went.
    public mutating func lostTouch() {
        switch stage {
        case .running, .stopping: stage = .ended(Ending(kind: .stopped, line: PageTaskCopy.lostTouch))
        case .preview, .editing, .editSent: stage = .ended(Ending(kind: .notRun, line: PageTaskCopy.helperGone))
        case .ended(let e) where e.kind == .undoing: stage = .ended(Ending(kind: .stopped, line: PageTaskCopy.undoUnanswered))
        case .ended: tasks = []
        }
    }

    private var isEditing: Bool { if case .editing = stage { return true } else { return false } }
    private var isEditSent: Bool { if case .editSent = stage { return true } else { return false } }
    private var isDone: Bool { if case .ended(let e) = stage { return e.kind == .done || e.kind == .handoff } else { return false } }
}

/// The goal card's words. Caret's voice, first person where Caret speaks, sentence case, no ids.
public enum GoalCopy {
    /// A step's words split at its field name: "Message: Thursday at 3" is (Message, Thursday at 3). Nil when the words
    /// name no field ("Add 'Planning review' to your Caret calendar…", "Press Next").
    public static func split(_ says: String) -> (field: String, value: String)? {
        guard let colon = says.range(of: ": ") else { return nil }
        let field = String(says[..<colon.lowerBound])
        guard !field.isEmpty, field.count <= 60, !field.contains("'") else { return nil }
        return (field, String(says[colon.upperBound...]))
    }

    /// The quiet line over the title: the app, or the calendar, and which part of the goal this is.
    public static func eyebrow(_ card: GoalCard) -> String {
        let where_: String
        switch card.place {
        case .window(let app, _): where_ = app
        case .calendar: where_ = "Calendar"
        }
        return card.segments > 1 ? "\(where_) · part \(card.segment + 1) of \(card.segments)" : where_
    }

    /// The title: the window the segment acts in, or the calendar.
    public static func title(_ card: GoalCard) -> String {
        switch card.place {
        case .window(let app, let title):
            let t = title.trimmingCharacters(in: .whitespaces)
            return t.isEmpty ? app : t
        case .calendar(let name): return "Your \(name) calendar"
        }
    }

    /// Tab's label: what Caret does when it takes the segment.
    public static func action(_ card: GoalCard) -> String {
        let does = card.rows.filter(\.caretDoes)
        let n = does.count
        if does.allSatisfy({ $0.kind == .calendar }) { return n == 1 ? "Add the event" : "Add \(n) events" }
        if does.allSatisfy({ $0.kind == .write }) { return n == 1 ? "Fill 1 field" : "Fill \(n) fields" }
        return n == 1 ? "Do 1 step" : "Do \(n) steps"
    }

    /// The name of the press handed to the user: "'Send' reads as outbound; you press it" is Send, "You press Submit
    /// Application" is Submit Application.
    public static func pressName(_ says: String) -> String? {
        if let open = says.firstIndex(of: "'"), let close = says[says.index(after: open)...].firstIndex(of: "'") {
            let name = says[says.index(after: open)..<close]
            if !name.isEmpty { return String(name) }
        }
        if let r = says.range(of: "you press ", options: .caseInsensitive) {
            let name = says[r.upperBound...].trimmingCharacters(in: CharacterSet(charactersIn: " ."))
            if !name.isEmpty { return name }
        }
        return nil
    }

    /// The hand-off line's parts (R8: what it sends, to whom, and why). `press` names the press ("You press Send");
    /// `sends` the fields the segment fills, `to` the recipient a To row names, `purpose` the user's own request, quoted.
    /// Nil parts are left out.
    public struct HandOff: Equatable, Sendable {
        public var press: String
        public var sends: String?
        public var to: String?
        public var purpose: String?
    }

    static let recipientFields: Set<String> = ["to", "recipient", "recipients", "send to"]

    public static func handOff(_ card: GoalCard) -> HandOff? {
        guard let c = card.consequential else { return nil }
        let name = pressName(c.says)
        let press = name.map { "You press \($0)" } ?? "The last step is yours"
        let written = card.listed.filter { $0.kind == .write }
        let to = written.first { recipientFields.contains(($0.field ?? "").lowercased()) }?.value
        let fields = written.compactMap(\.field).filter { !recipientFields.contains($0.lowercased()) }
        let sends = fields.isEmpty ? nil : list(fields)
        let ask = card.instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        let purpose = ask.isEmpty ? nil : "\u{201C}\(ask.count > 90 ? String(ask.prefix(89)) + "\u{2026}" : ask)\u{201D}"
        return HandOff(press: press, sends: sends, to: to, purpose: purpose)
    }

    /// The hand-off line as VoiceOver reads it, one sentence.
    public static func spokenHandOff(_ h: HandOff) -> String {
        var words = "\(h.press). Caret never presses it."
        if let sends = h.sends { words += " It sends \(sends)" + (h.to.map { " to \($0)" } ?? "") + "." } else if let to = h.to { words += " It goes to \(to)." }
        if let purpose = h.purpose { words += " For \(purpose)." }
        return words
    }

    static func list(_ names: [String]) -> String {
        guard names.count > 1 else { return names.first ?? "" }
        return names.dropLast().joined(separator: ", ") + " and " + (names.last ?? "")
    }

    public static let draftedBy = "Caret's draft"
    public static let yourWords = "Your words"
    public static let editEmpty = "Type what goes there, or Esc to keep Caret's draft."
    public static let editTooLong = "That's longer than Caret writes in one field. Shorten it."
    public static let editRefused = "Caret couldn't use that edit, so the draft is as it was."
    public static let editing = "Return keeps your words. Nothing runs until you press Tab."

    public static func working(_ place: GoalProgress.Place) -> String {
        switch place {
        case .window(let app, _): return "Working in \(app)"
        case .calendar: return "Adding to your calendar"
        }
    }

    public static func undoing(_ place: GoalProgress.Place) -> String {
        switch place {
        case .window(let app, _): return "Putting \(app) back"
        case .calendar: return "Taking the event back off"
        }
    }

    public static func undonePartly(_ place: GoalProgress.Place, left: Int) -> String {
        "Caret put back what it could. \(left == 1 ? "1 change" : "\(left) changes") couldn't be put back, so check \(place.where_)."
    }

    public static func undone(_ place: GoalProgress.Place) -> String {
        switch place {
        case .window: return "Put back as it was."
        case .calendar: return "Taken off your calendar."
        }
    }

    /// How a run ended, in the helper's sentence when the desk may show it, with the user's press named once more.
    public static func finished(_ e: GoalProgress.End, place: GoalProgress.Place, yours: GoalCard.Row?) -> String {
        if AskCopy.showable(e.says, limit: GoalProgress.maxSays) { return e.says }
        let press = yours.flatMap { pressName($0.says) }
        switch e.outcome {
        case .done, .handoff: return press.map { "Done. \($0) is yours." } ?? "Done."
        case .partial: return "Partly done. Check what's left."
        }
    }

    public static func stopped(_ s: GoalProgress.Stop, place: GoalProgress.Place) -> String {
        if AskCopy.showable(s.says, limit: GoalProgress.maxSays) { return s.says }
        return s.reason == .you ? "Stopped." : "Caret stopped before the end. Check what's left."
    }
}

extension GoalProgress.Place {
    /// Where to look after a partial undo: the app, or the calendar.
    var where_: String {
        switch self {
        case .window(let app, _): return app
        case .calendar: return "your calendar"
        }
    }
}
