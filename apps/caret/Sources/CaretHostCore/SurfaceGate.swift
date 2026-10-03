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
        /// The owner runs as a background agent (no Dock icon: LSUIElement or background-only),
        /// as writing aids do. A regular app's palette over a field is never taken for a decoration.
        public var agent: Bool

        public init(pid: Int32, bounds: CGRect, layer: Int = 0, alpha: Double = 1, agent: Bool = false) {
            self.pid = pid
            self.bounds = bounds
            self.layer = layer
            self.alpha = alpha
            self.agent = agent
        }
    }

    /// The pid of the frontmost window under `point`, skipping Caret's own windows and windows
    /// that draw nothing. `windows` is front to back.
    ///
    /// A window above the normal layer that covers a whole display is skipped too: utilities draw
    /// transparent full-screen overlays there, and counting them would hide Caret everywhere.
    /// Measured on 2026-10-03: Snipaste keeps one window at layer 25, alpha 1, at
    /// [-1977, -1207, 5168, 3188]. It contains the 2560 x 1440 main display but not the second
    /// display below it ([541, 1440, 1512, 982] in these coordinates), and A10's surface runs held
    /// every offer as `covered` under it, both with the old rule (equal to a display) and with a
    /// narrower one tried after review (containing every display). So any elevated window that
    /// contains a whole display is skipped. Nothing here proves it transparent: an opaque one is
    /// assumed rare, and one covering only part of a display still counts.
    ///
    /// So is an elevated window that a background agent draws around the app's focused field
    /// (`ringsField`): writing aids decorate the focused field from a window of their own. Measured
    /// on 2026-10-03: Grammarly Desktop (ApplicationType UIElement) keeps one at layer 1, alpha 1, at
    /// TextEdit's focused text area grown by exactly 64 pt on every side (field [309, 203, 586,
    /// 382], window [245, 139, 714, 510]), and A12's desktop runs held every TextEdit offer as
    /// `covered` under it. Geometry alone cannot prove such a window transparent, so a regular
    /// app's window, or one at the normal layer, always counts.
    public static func topPID(at point: CGPoint, windows: [Window], ownPID: Int32, displays: [CGRect] = [], field: CGRect? = nil) -> Int32? {
        for window in windows {
            guard window.pid != ownPID, window.alpha > 0.01, window.bounds.contains(point) else { continue }
            if window.layer > 0, displays.contains(where: { window.bounds.contains($0) }) { continue }
            if window.layer > 0, window.agent, let field, ringsField(window.bounds, field) { continue }
            return window.pid
        }
        return nil
    }

    /// The largest even margin, in points, a window drawn around a field may have and still count
    /// as the field's decoration. Assumed: Grammarly's measured 64, with room for a larger one.
    public static let ringMargin: CGFloat = 96

    /// True when `bounds` is `field` grown by one margin, the same on all four sides (within 1 pt)
    /// and no larger than `ringMargin`. A palette or popover that happens to lie over the field is
    /// not centered on it this way, so it still covers.
    public static func ringsField(_ bounds: CGRect, _ field: CGRect) -> Bool {
        let margins = [field.minX - bounds.minX, field.minY - bounds.minY, bounds.maxX - field.maxX, bounds.maxY - field.maxY]
        guard let low = margins.min(), let high = margins.max() else { return false }
        return low >= 0 && high <= ringMargin && high - low <= 1
    }

    /// Nil when the surface may be drawn; otherwise why it is held.
    public static func check(
        targetPID: Int32,
        frontmostPID: Int32?,
        fieldIsFocused: Bool,
        anchors: [CGPoint],
        windows: [Window],
        ownPID: Int32,
        displays: [CGRect] = [],
        field: CGRect? = nil
    ) -> Hold? {
        guard frontmostPID == targetPID else { return .appNotFront }
        guard fieldIsFocused else { return .fieldNotFocused }
        for anchor in anchors {
            guard let top = topPID(at: anchor, windows: windows, ownPID: ownPID, displays: displays, field: field) else { return .notOnScreen }
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
