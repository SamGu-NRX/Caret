import CaretScreenCore
import CoreGraphics
import Foundation

/// What `SurfaceMachine` tells the drawing layer to do. Each is a plain value; CaretHost's
/// `SurfaceCoordinator` carries them out on screen, and tests read them.
public enum SurfaceCommand: Equatable, Sendable {
    /// The user typed the head of the top candidate: draw the rest after what they typed. The
    /// underline and the list go, because the other candidates no longer fit.
    case typedThrough(offerID: UInt64, typed: String, remainder: String, caret: CGRect)
    /// Take down what an offer drew at the caret: its ghost text, underline, tag and list. The
    /// panel is separate.
    case clearCaret(offerID: UInt64)
    /// Show the one panel (an offer line, a pop-up, a working or result line).
    case showPanel(PanelContent, text: String, placement: PanelPlacementRequest)
    /// Take the panel down over `exit` seconds.
    case hidePanel(exit: TimeInterval)
    /// Accepted work started or ended (the menu bar glyph tints Carrot while it runs).
    case workingChanged(Bool)
    /// A stop could not be delivered or was never confirmed: close the connection to the helper,
    /// which revokes the work the session accepted (B22), then reconnect.
    case dropHelperSession
    /// This machine's toast took the arbiter's one toast slot; the fill line's toast must give way.
    case toastSlotTaken
    /// H8: an event card was accepted while Caret had never asked for Calendar access. Ask macOS now
    /// (its prompt), then call `SurfaceMachine.calendarAccessAnswered()`, whatever the answer.
    case askCalendarAccess
    /// Count an event in the host status (`surface.*` counters).
    case count(String)
    /// The debug state changed; republish it.
    case publish
    /// One line for the host's log (stderr): something a run must be able to find afterwards.
    case log(String)
}

public struct AlternativesDraw: Equatable, Sendable {
    public var offerID: UInt64
    /// The field read the offer was drawn from (`FocusedField.readID`).
    public var readID: UInt64
    public var candidates: [String]
    public var ui: OfferUI
    /// First draw of this offer: the ghost text appears and the underline draws in once.
    public var entering: Bool
    public var quoted: Bool
    /// Global, top-left points.
    public var caret: CGRect
    public var field: CGRect
    public var pid: Int32
    /// Inline after the caret, or in a capsule off its line: decided once per offer from the widest
    /// candidate (`SurfaceGate.fitsInField`), so the arrows never move it.
    public var presentation: CaretPresentation

    public var currentText: String { candidates[min(ui.candidate, candidates.count - 1)] }
}

/// What the renderer drew for alternatives: where their capsule is, when they are in one.
public struct AlternativesDrawn: Equatable, Sendable {
    /// Global top-left points; nil inline.
    public var capsule: CGRect?

    public init(capsule: CGRect?) {
        self.capsule = capsule
    }
}

public enum PanelContent: Equatable, Sendable {
    case line(LineContent)
    case popup(PopupSpec, highlight: Int?)
    /// The 20 pt line an offer falls back to when its panel has no clear spot (`CompactOffer`).
    case compactLine(LineContent)
}

public enum PanelPlacementRequest: Equatable, Sendable {
    /// Placed around the field by `FieldPanelPlacement` (below it, 12 pt left of the caret, unless
    /// that covers another of the app's elements) when `entering` or when the panel is down;
    /// otherwise redrawn where it stands. Frames are global, top-left; `pid` owns the field.
    case atField(field: CGRect, caret: CGRect, pid: Int32, entering: Bool)
    /// Redrawn where it stands, entering only if it is down: the working line becoming its result.
    case inPlace
}

/// What `SurfaceMachine` sends the helper.
public enum SurfaceSend: Equatable, Sendable {
    case accept(OfferAccept)
    case stop(OfferStop)
    case control(TaskControl)
    /// The answer to a keep or promote question (B19 `skillAnswer`).
    case skillAnswer(SkillAnswer)
}
