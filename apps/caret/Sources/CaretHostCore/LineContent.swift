import CaretScreenCore
import Foundation

// The values a line or toast is drawn from, with no drawing code: `SurfaceMachine` decides them
// and CaretHost's `LineView` and `FigureView` draw them. They live here so the decision of what a
// line says can be tested without a screen.

/// The figure's states (`IDENTITY.md`, "States, side by side").
public enum FigureState: String, CaseIterable, Codable, Sendable {
    /// Enters, already looking at what it noticed.
    case noticed
    /// Turns toward the offer and breathes.
    case offering
    /// Looks away, then leaves; the menu bar glyph tints Carrot.
    case working
    /// Returns with one gesture of relief.
    case done
    /// Faces you; two small signals. Nothing happens until you answer.
    case needsYou
    /// Goes graphite; posture drops.
    case error
    /// Not drawn.
    case absent
}

/// The three characters. Pebble is the default; seed and wren are kept selectable until Sam picks
/// (`OPEN-QUESTIONS.md` 1). Each one is a drawing plus a pose per state (CaretHost's
/// `FigureCharacter.drawing`), so adding a fourth is one more case here and one more drawing.
public enum FigureCharacter: String, CaseIterable, Sendable {
    case pebble, seed, wren

    public var displayName: String { rawValue.capitalized }
}

/// A keycap and what it does: "Tab Add", "⌘Z Undo".
public struct Hint: Equatable, Sendable {
    public var key: String
    public var label: String?

    public init(key: String, label: String? = nil) {
        self.key = key
        self.label = label
    }

    public static func key(_ key: PopupSpec.Action.Key) -> String {
        switch key {
        case .tab: return "Tab"
        case .cmd1: return "⌘1"
        case .cmd2: return "⌘2"
        case .cmd3: return "⌘3"
        case .down: return "↓"
        }
    }

    /// The hints after an action line: every action's key, and its label except Tab's.
    public static func hints(_ actions: [PopupSpec.Action]) -> [Hint] {
        actions.map { Hint(key: key($0.key), label: $0.key == .tab ? nil : $0.label) }
    }
}

/// What an offer line shows: the figure, an optional app, an optional Carrot lead word, the text,
/// and trailing key hints.
public struct LineContent: Equatable, Sendable {
    public var figure: FigureState
    public var app: String?
    public var lead: String?
    public var text: String
    /// Secondary for a source line ("from Mail, Invoice 2041"); Ink semibold for an end state.
    public var emphasis: Emphasis
    public var hints: [Hint]
    /// The working line names the app in its caption, so it shows only the app's glyph, standing
    /// where the figure stood before it left.
    public var appGlyphOnly: Bool
    /// A question under the line about the run it reports on (B19 keep or promote), or its answer.
    public var question: Question?

    public enum Emphasis: Equatable, Sendable {
        case endState, plain, secondary
    }

    /// The second row of a result line: the helper's question and its two answers' keys, or, once
    /// answered, what the answer did.
    public struct Question: Equatable, Sendable {
        public var text: String
        public var detail: String?
        public var hints: [Hint]

        public init(text: String, detail: String? = nil, hints: [Hint] = []) {
            self.text = text
            self.detail = detail
            self.hints = hints
        }
    }

    public init(
        figure: FigureState, app: String? = nil, lead: String? = nil, text: String, emphasis: Emphasis = .endState,
        hints: [Hint] = [], appGlyphOnly: Bool = false, question: Question? = nil
    ) {
        self.figure = figure
        self.app = app
        self.lead = lead
        self.text = text
        self.emphasis = emphasis
        self.hints = hints
        self.appGlyphOnly = appGlyphOnly
        self.question = question
    }
}

/// The captions per character (`IDENTITY.md`, "Captions while working and when done"). No
/// exclamation marks, no "I think", no probabilities, no em dashes.
public enum Captions {
    public static func working(_ character: FigureCharacter, app: String) -> String {
        switch character {
        case .seed: return "Adding to \(app)"
        case .pebble: return "On it, \(app)"
        case .wren: return "Off to \(app)"
        }
    }

    /// The lead word (set in Carrot) and the rest.
    public static func done(_ character: FigureCharacter, app: String) -> (lead: String, rest: String) {
        switch character {
        case .seed: return ("Added", "to \(app)")
        case .pebble: return ("Done,", "in \(app)")
        case .wren: return ("Back,", "added to \(app)")
        }
    }

    /// What stopped a run, as the clause after "Stopped …:", one per helper reason (protocol.ts
    /// StopReason). It names who or what stopped it, in the user's terms, without blame. A stop the
    /// user made has its own sentence (`stoppedByYou`), so `.you` is only here for completeness.
    public static func stopCause(_ reason: TaskProgress.StopReason, app: String) -> String {
        switch reason {
        case .you: return "you stopped it"
        case .changed: return "\(app) changed while Caret worked"
        case .sheet: return "a dialog opened in \(app)"
        // The helper's windowGone covers a window that closed and one that never matched, so the
        // line claims neither alone. No app name: with one ("Google Chrome") the line ran past
        // the offer line's 520 pt and was cut.
        case .windowGone: return "the window closed or wasn't found"
        case .ambiguous: return "more than one \(app) window matched"
        case .readerRestarted: return "Caret lost its view of the screen"
        case .reader: return "Caret couldn't read or change \(app)"
        case .mismatch: return "\(app) didn't take the change"
        case .unreachable: return "Caret couldn't reach the spot in \(app)"
        case .notConfigured: return "Caret isn't set up for this yet"
        case .refused: return "Caret couldn't run that offer"
        case .error: return "something unexpected happened"
        }
    }

    /// Where a run stopped: "before step 2 of 3". Nil for a one-step run or one with no step known,
    /// where a step number says nothing. `next` is the zero-based step not yet done.
    static func place(next: Int?, of steps: Int) -> String? {
        guard let next, steps > 1, next >= 0, next < steps else { return nil }
        return "before step \(next + 1) of \(steps)"
    }

    /// The user stopped the run, with Esc or Take over: "You stopped it before step 2 of 3", or
    /// "You stopped it" when no step says more. Brief A13: the line says who stopped it.
    public static func stoppedByYou(next: Int?, of steps: Int) -> String {
        place(next: next, of: steps).map { "You stopped it \($0)" } ?? "You stopped it"
    }

    /// A run the helper stopped for `reason`: "Stopped before step 2 of 3: a dialog opened in
    /// Mail", or "Stopped: …" with no step. A fill says what it filled first.
    public static func stopped(_ reason: TaskProgress.StopReason, app: String, next: Int?, steps: Int, fillFilled: Int?) -> String {
        if reason == .you { return stoppedByYou(next: next, of: steps) }
        // The helper refuses an accept for an offer that closed, ran already, or asked for an
        // action it does not have; in every case nothing ran.
        if reason == .refused { return "Caret couldn't run that offer, so nothing changed" }
        let cause = stopCause(reason, app: app)
        switch fillFilled {
        case .some(0): return "Stopped before filling anything: \(cause)"
        case .some(let n): return "Filled \(fields(n)), then stopped: \(cause)"
        case .none: return place(next: next, of: steps).map { "Stopped \($0): \(cause)" } ?? "Stopped: \(cause)"
        }
    }

    /// "1 field", "3 fields".
    public static func fields(_ count: Int) -> String { count == 1 ? "1 field" : "\(count) fields" }

    /// The working line of a fill pop-up.
    public static func filling(_ count: Int) -> String { "Filling \(fields(count))" }

    /// The run reached a send, submit, delete or pay step and left the press to the user.
    public static func handoff(app: String) -> String { "Your turn in \(app)" }

    /// A calendar step the user must enable first (B16 `blocked`). Names what is missing; Caret
    /// never asks for Calendar access itself, so the line says where the user can give it.
    public static func blocked(_ reason: CalendarBlock) -> String {
        switch reason {
        // One line of at most about 68 characters: the A13 render of a longer one was cut at 520 pt.
        case .tcc: return "Nothing was added: Caret needs Calendar access in Privacy & Security."
        case .noLocalSource: return "Nothing was added: Caret adds events only to an On My Mac calendar."
        }
    }

    /// ⌘Z on the fill toast while the helper is not connected.
    public static let undoUnsent = "Caret's helper isn't running, so nothing was undone."

    /// Tab on an offer while the helper is not connected: nothing ran.
    public static let acceptUnsent = "Caret's helper isn't running, so nothing was done."

    /// The helper's connection dropped after the run had verified a step: something was done, so
    /// `acceptUnsent` would not be true.
    public static let helperStopped = "Caret's helper stopped, so the rest wasn't done."

    /// An undo that could not restore every field.
    public static func undoPartial(notRestored: Int) -> String {
        notRestored == 1
            ? "1 field changed after the fill, so it was left as it is."
            : "\(notRestored) fields changed after the fill, so they were left as they are."
    }
}

/// A line that reports on accepted work, and what the panel says for it (its accessibility text
/// and the debug state's `lineText`).
public struct WorkLine: Equatable, Sendable {
    public var content: LineContent
    public var text: String

    public init(_ content: LineContent, text: String) {
        self.content = content
        self.text = text
    }
}

/// The working, result and undo lines after Tab, in one place so every surface that runs work
/// draws the same ones: the action lines and pop-ups at the caret (`SurfaceMachine`) and the first
/// look in onboarding (`OnboardingFlow`).
public enum WorkLines {
    /// While the run works. The figure looks away and leaves (`figureLeft`); once it has run
    /// `StatusLine.stoppableAfter`, the seconds and "Esc Stop" join it.
    public static func working(app: String, fillRows: Int?, character: FigureCharacter, seconds: Int, figureLeft: Bool) -> WorkLine {
        let stoppable = Double(seconds) >= StatusLine.stoppableAfter
        var caption = fillRows.map { Captions.filling($0) } ?? Captions.working(character, app: app)
        if stoppable { caption += ", \(seconds) s" }
        return WorkLine(LineContent(
            figure: figureLeft ? .absent : .working, app: app, text: caption, emphasis: .plain,
            hints: stoppable ? [Hint(key: "Esc", label: "Stop")] : [], appGlyphOnly: true
        ), text: caption)
    }

    /// Done. `undo`: the run wrote something its task can restore, so ⌘Z takes it while it shows.
    public static func done(app: String, character: FigureCharacter, undo: Bool = false) -> WorkLine {
        let done = Captions.done(character, app: app)
        return WorkLine(
            LineContent(figure: .done, lead: done.lead, text: done.rest, emphasis: .plain, hints: undo ? [Hint(key: "⌘Z", label: "Undo")] : []),
            text: "\(done.lead) \(done.rest)"
        )
    }

    /// "Filled 3 fields from Mail  ⌘Z Undo": a fill that wrote something.
    public static func filled(_ count: Int, from source: String?) -> WorkLine {
        let rest = Captions.fields(count) + (source.map { " from \($0)" } ?? "")
        return WorkLine(
            LineContent(figure: .done, lead: "Filled", text: rest, emphasis: .plain, hints: [Hint(key: "⌘Z", label: "Undo")]),
            text: "Filled \(rest)"
        )
    }

    /// The helper stopped the run, and why in plain words. A fill says what it filled first. A stop
    /// the user asked for is not an error, so its figure is calm.
    public static func stopped(app: String, reason: TaskProgress.StopReason, next: Int?, steps: Int, fillFilled: Int?) -> WorkLine {
        let caption = Captions.stopped(reason, app: app, next: next, steps: steps, fillFilled: fillFilled)
        return WorkLine(LineContent(figure: reason == .you ? .done : .error, text: caption, emphasis: .plain), text: caption)
    }

    /// The next step reads as send, submit, delete or pay; the press is left to the user.
    public static func handoff(app: String) -> WorkLine {
        let caption = Captions.handoff(app: app)
        return WorkLine(LineContent(figure: .needsYou, text: caption, emphasis: .plain), text: caption)
    }

    /// A calendar step that needs Calendar access or a local calendar from the user.
    public static func blocked(_ reason: CalendarBlock) -> WorkLine {
        let caption = Captions.blocked(reason)
        return WorkLine(LineContent(figure: .needsYou, text: caption, emphasis: .plain), text: caption)
    }

    // MARK: Skills (B19)

    /// A skill working with no Tab. It names the skill and that nobody asked, and Esc hands it back
    /// from the first moment. The figure stays on the line, working: this run was not the user's
    /// request, so the line does not look away as a Tab'd one does.
    public static func onItsOwn(_ name: String, app: String) -> WorkLine {
        let caption = "\(name), on its own"
        return WorkLine(LineContent(
            figure: .working, app: app, text: caption, emphasis: .plain, hints: [Hint(key: "Esc", label: "Take over")], appGlyphOnly: true
        ), text: caption)
    }

    /// A skill's run with no Tab finished and wrote something: ⌘Z takes it while the line shows.
    public static func doneOnItsOwn(_ name: String) -> WorkLine {
        let rest = "\(name), on its own"
        return WorkLine(
            LineContent(figure: .done, lead: "Done:", text: rest, emphasis: .plain, hints: [Hint(key: "⌘Z", label: "Undo")]),
            text: "Done: \(rest)"
        )
    }

    /// Esc took over a skill's run: "You took over before step 2 of 3".
    public static func tookOver(next: Int?, of steps: Int) -> WorkLine {
        let caption = Captions.place(next: next, of: steps).map { "You took over \($0)" } ?? "You took over"
        return WorkLine(LineContent(figure: .done, text: caption, emphasis: .plain), text: caption)
    }

    /// The keep or promote question under a run's result line, in the helper's words: its sentence,
    /// its detail, and its two answers on Tab and Esc.
    public static func question(_ offer: SkillOffer) -> LineContent.Question {
        LineContent.Question(text: offer.says, detail: offer.detail, hints: [
            Hint(key: "Tab", label: offer.actions.first?.label), Hint(key: "Esc", label: offer.actions.last?.label),
        ])
    }

    /// Tab said yes and the helper has not confirmed it yet.
    public static func answering(_ offer: SkillOffer) -> LineContent.Question {
        LineContent.Question(text: offer.kind == .keep ? "Keeping it as \(offer.name)" : "Letting \(offer.name) run on its own")
    }

    /// Tab's yes did not reach the helper.
    public static let answerUnsent = LineContent.Question(text: "Caret's helper isn't running, so nothing changed.")
    /// The helper withdrew the question another way than taking it (it expired, or its routine or
    /// skill was forgotten meanwhile): it applied nothing.
    public static let answerNotTaken = LineContent.Question(text: "Caret couldn't save that, so nothing changed.")
    /// No word from the helper in time: whether it took the answer is not known here.
    public static let answerUnconfirmed = LineContent.Question(text: "Caret didn't confirm that.", detail: "Skills in What Caret knows says where it stands.")

    /// What Tab on the question did, once the helper confirmed it. No keys: the row now reports.
    public static func answered(_ offer: SkillOffer) -> LineContent.Question {
        switch offer.kind {
        case .keep: return LineContent.Question(text: "Kept as \(offer.name)", detail: "Caret will offer it when you start it again.")
        case .promote: return LineContent.Question(text: "\(offer.name) runs on its own from now on", detail: "You'll see each run, and ⌘Z undoes it.")
        }
    }

    /// Esc stopped it: the line names the step it stopped before.
    public static func stoppedByYou(next: Int?, of steps: Int) -> WorkLine {
        let caption = Captions.stoppedByYou(next: next, of: steps)
        return WorkLine(LineContent(figure: .done, text: caption, emphasis: .plain), text: caption)
    }

    public static let undoing = WorkLine(LineContent(figure: .working, text: "Undoing", emphasis: .plain), text: "Undoing")

    public static let undoUnsent = WorkLine(LineContent(figure: .error, text: Captions.undoUnsent, emphasis: .plain), text: Captions.undoUnsent)

    public static let acceptUnsent = WorkLine(LineContent(figure: .error, text: Captions.acceptUnsent, emphasis: .plain), text: Captions.acceptUnsent)

    public static let helperStopped = WorkLine(LineContent(figure: .error, text: Captions.helperStopped, emphasis: .plain), text: Captions.helperStopped)

    /// The undo's answer: what it cleared, or that some fields were left because they changed.
    public static func undone(_ count: OfferLifecycle.UndoCount?) -> WorkLine {
        if let count, count.notRestored > 0 {
            let caption = Captions.undoPartial(notRestored: count.notRestored)
            return WorkLine(LineContent(figure: .error, text: caption, emphasis: .plain), text: caption)
        }
        let caption = count.map { "Cleared \(Captions.fields($0.restored))" } ?? "Undone"
        return WorkLine(LineContent(figure: .done, text: caption, emphasis: .plain), text: caption)
    }
}
