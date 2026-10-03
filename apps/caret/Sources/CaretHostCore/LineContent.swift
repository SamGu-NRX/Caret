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

    public enum Emphasis: Equatable, Sendable {
        case endState, plain, secondary
    }

    public init(
        figure: FigureState, app: String? = nil, lead: String? = nil, text: String, emphasis: Emphasis = .endState,
        hints: [Hint] = [], appGlyphOnly: Bool = false
    ) {
        self.figure = figure
        self.app = app
        self.lead = lead
        self.text = text
        self.emphasis = emphasis
        self.hints = hints
        self.appGlyphOnly = appGlyphOnly
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

    public static let stopped = "Stopped"

    /// What stopped a run, as the end of "Stopped because …", one clause per helper reason
    /// (protocol.ts StopReason). Says what happened, in the user's terms, without blame.
    public static func stopCause(_ reason: TaskProgress.StopReason, app: String) -> String {
        switch reason {
        case .you: return "you stopped it"
        case .changed: return "\(app) changed while Caret was working"
        case .sheet: return "a dialog opened in \(app)"
        case .windowGone: return "the \(app) window closed"
        case .ambiguous: return "more than one \(app) window matched"
        case .readerRestarted: return "Caret lost its view of the screen"
        case .reader: return "Caret couldn't read or change \(app)"
        case .mismatch: return "\(app) didn't take the change"
        case .unreachable: return "Caret couldn't find the spot in \(app)"
        case .notConfigured: return "Caret isn't set up for this yet"
        case .refused: return "the offer had already closed"
        case .error: return "something unexpected happened"
        }
    }

    /// The run stopped where the user stopped it: "Stopped before step 2 of 3". `next` is the
    /// zero-based step not yet done; a one-step run, or one with no step known, just stopped.
    public static func stoppedByYou(next: Int?, of steps: Int) -> String {
        guard let next, steps > 1, next < steps else { return stopped }
        return "Stopped before step \(next + 1) of \(steps)"
    }

    /// A run the helper stopped for `reason`. A fill says what it filled first.
    public static func stopped(_ reason: TaskProgress.StopReason, app: String, next: Int?, steps: Int, fillFilled: Int?) -> String {
        if reason == .you { return stoppedByYou(next: next, of: steps) }
        if reason == .refused { return "That offer had already closed, so nothing ran." }
        let cause = stopCause(reason, app: app)
        switch fillFilled {
        case .some(0): return "Filled nothing, because \(cause)."
        case .some(let n): return "Filled \(fields(n)), then stopped because \(cause)."
        case .none: return "Stopped because \(cause)."
        }
    }

    /// "1 field", "3 fields".
    public static func fields(_ count: Int) -> String { count == 1 ? "1 field" : "\(count) fields" }

    /// The working line of a fill pop-up.
    public static func filling(_ count: Int) -> String { "Filling \(fields(count))" }

    /// The run reached a send, submit, delete or pay step and left the press to the user.
    public static func handoff(app: String) -> String { "Your turn in \(app)" }

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
