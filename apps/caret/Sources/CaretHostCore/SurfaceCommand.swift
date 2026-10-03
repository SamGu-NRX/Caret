import CaretScreenCore
import CoreGraphics
import Foundation

/// What `SurfaceMachine` tells the drawing layer to do. Each is a plain value; CaretHost's
/// `SurfaceCoordinator` carries them out on screen, and tests read them.
public enum SurfaceCommand: Equatable, Sendable {
    /// Ghost text with alternatives at the caret: the current candidate, its underline and tag, and
    /// the list once open (`SURFACES.md` section 2).
    case drawAlternatives(AlternativesDraw)
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
    /// This machine's toast took the arbiter's one toast slot; the fill line's toast must give way.
    case toastSlotTaken
    /// Count an event in the host status (`surface.*` counters).
    case count(String)
    /// The debug state changed; republish it.
    case publish
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

    public var currentText: String { candidates[min(ui.candidate, candidates.count - 1)] }
}

public enum PanelContent: Equatable, Sendable {
    case line(LineContent)
    case popup(PopupSpec, highlight: Int?)
}

public enum PanelPlacementRequest: Equatable, Sendable {
    /// Pinned at the caret (left edge 12 pt left of it, top 6 pt below, flipped above when there is
    /// no room) when `entering` or when the panel is down; otherwise redrawn where it stands.
    case atCaret(CGRect, entering: Bool)
    /// Redrawn where it stands, entering only if it is down: the working line becoming its result.
    case inPlace
}

/// What `SurfaceMachine` sends the helper.
public enum SurfaceSend: Equatable, Sendable {
    case accept(OfferAccept)
    case stop(OfferStop)
    case control(TaskControl)
}
