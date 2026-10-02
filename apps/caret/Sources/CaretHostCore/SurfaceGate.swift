import CoreGraphics
import Foundation

/// Whether Caret may draw a surface for a field at all.
///
/// A surface (ghost text, a fill value, an offer line, alternatives, a pop-up, a toast) is drawn
/// only where the user is looking: the field's app is NSWorkspace's frontmost app, the field is
/// that app's focused element, and the point the surface anchors to is visibly inside one of that
/// app's windows. Otherwise the offer is held and nothing is drawn. On 2026-10-02 a test offer for
/// a background fixture drew its alternatives list over Sam's Messages window; this rule makes
/// that impossible for every producer, including the debug socket.
public enum SurfaceGate {
    public enum Hold: String, Codable, Sendable, Equatable {
        /// The field's app is not the frontmost app.
        case appNotFront
        /// The app is frontmost but the field is not its focused element.
        case fieldNotFocused
        /// Another window covers the anchor point.
        case covered
        /// No window of the field's app is under the anchor point (off screen, minimized).
        case notOnScreen
        /// The surface would leave the field and overlap the app's own text.
        case wouldOverlapText
    }

    /// One on-screen window, front to back as the window server lists them.
    public struct Window: Equatable, Sendable {
        public var pid: Int32
        /// Global points, top-left origin (the same space as Accessibility frames).
        public var bounds: CGRect
        public var layer: Int
        public var alpha: Double

        public init(pid: Int32, bounds: CGRect, layer: Int = 0, alpha: Double = 1) {
            self.pid = pid
            self.bounds = bounds
            self.layer = layer
            self.alpha = alpha
        }
    }

    /// The pid of the frontmost window under `point`, skipping Caret's own windows and windows
    /// that draw nothing. `windows` is front to back.
    ///
    /// A window above the normal layer that spans a whole display is skipped too: utilities draw
    /// transparent full-screen overlays there, and counting them would hide Caret everywhere.
    /// Assumed, not measured on this Mac; a real full-screen window at such a layer is rare.
    public static func topPID(at point: CGPoint, windows: [Window], ownPID: Int32, displays: [CGRect] = []) -> Int32? {
        for window in windows {
            guard window.pid != ownPID, window.alpha > 0.01, window.bounds.contains(point) else { continue }
            if window.layer > 0, displays.contains(where: { $0.equalTo(window.bounds) }) { continue }
            return window.pid
        }
        return nil
    }

    /// Nil when the surface may be drawn; otherwise why it is held.
    public static func check(
        targetPID: Int32,
        frontmostPID: Int32?,
        fieldIsFocused: Bool,
        anchors: [CGPoint],
        windows: [Window],
        ownPID: Int32,
        displays: [CGRect] = []
    ) -> Hold? {
        guard frontmostPID == targetPID else { return .appNotFront }
        guard fieldIsFocused else { return .fieldNotFocused }
        for anchor in anchors {
            guard let top = topPID(at: anchor, windows: windows, ownPID: ownPID, displays: displays) else { return .notOnScreen }
            if top != targetPID { return .covered }
        }
        return nil
    }

    /// Ghost text drawn by Caret at the caret must stay inside the field's text area, so it never
    /// overlaps text after the caret or a neighbor's label (`SURFACES.md` section 1: anything below
    /// or after the caret means no inline ghost).
    public static func fitsInField(ghost: CGRect, field: CGRect, textAfterCaret: Bool) -> Bool {
        !textAfterCaret && field.insetBy(dx: 1, dy: 0).contains(ghost.insetBy(dx: 0.5, dy: 0.5))
    }
}

/// Where a panel goes among candidate frames: the first that is on screen and covers nothing,
/// else the one covering least. Frames are global, top-left origin.
public enum PanelPlacement {
    public static func choose(_ candidates: [CGRect], obstacles: [CGRect], bounds: CGRect) -> (frame: CGRect, index: Int, overlap: CGFloat) {
        var best: (CGRect, Int, CGFloat)?
        for (i, frame) in candidates.enumerated() where bounds.contains(frame) {
            let overlap = obstacles.map { $0.intersection(frame) }.filter { !$0.isNull }.reduce(0) { $0 + $1.width * $1.height }
            if overlap == 0 { return (frame, i, 0) }
            if best == nil || overlap < best!.2 { best = (frame, i, overlap) }
        }
        if let best { return (best.0, best.1, best.2) }
        return (candidates[0], 0, .infinity)
    }
}
