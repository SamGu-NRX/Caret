import CoreGraphics
import Foundation

/// Working in another window (DIRECTION.md 5.7): a warm rim around the window Caret is working in,
/// the figure perched on its top edge, and a caption at its bottom-left. This file decides whether
/// they may be drawn and where; `PerchController` draws them.
///
/// H3's rule: only while the target window is on screen and nothing covers it. A ring drawn around a
/// window that another window sits over would be drawn over that other window, around content that
/// isn't Caret's. Covered or not found, nothing is drawn there; the menu bar glyph stays lit, and the
/// slip at the caret, when the user started the work there, carries the caption.
///
/// Frames are global, top-left origin (the window server's and Accessibility's).
public enum Rim {
    /// A window as the window server lists it, front to back.
    public struct Window: Equatable, Sendable {
        public var number: Int
        public var pid: Int32
        public var bounds: CGRect
        public var layer: Int
        public var alpha: Double

        public init(number: Int, pid: Int32, bounds: CGRect, layer: Int, alpha: Double) {
            self.number = number
            self.pid = pid
            self.bounds = bounds
            self.layer = layer
            self.alpha = alpha
        }
    }

    public enum Seen: Equatable, Sendable {
        /// On screen with nothing in front of it: its window number and frame now.
        case clear(number: Int, frame: CGRect)
        /// Another window covers part of it.
        case covered(number: Int, frame: CGRect, by: Int32)
        /// Not on screen: closed, minimized, on another Space, or never matched.
        case notFound

        public var isClear: Bool { if case .clear = self { return true } else { return false } }
    }

    /// How far a window's listed bounds may be from the frame Accessibility gave for it and still be
    /// the same window. Assumed: both are global points for the same frame, so they agree to the
    /// point for ordinary windows; 4 allows for rounding and a shadowless edge.
    public static let matchTolerance: CGFloat = 4
    /// Smaller windows in front don't count as covering: a tooltip, a status item's window. The same
    /// floor the desk uses for "the window in front" (`PerchController.frontWindow`).
    public static let minimumCover = CGSize(width: 40, height: 40)

    /// Finds the task's window: by `number` once matched (it follows the window as it moves), else
    /// the app's ordinary window at `frame`. Then decides whether anything covers it.
    public static func seen(pid: Int32, number: Int?, frame: CGRect?, windows: [Window], ownPID: Int32) -> Seen {
        let index: Int? = {
            if let number, let i = windows.firstIndex(where: { $0.number == number && $0.pid == pid }) { return i }
            guard let frame else { return nil }
            return windows.firstIndex { w in
                w.pid == pid && w.layer == 0 && w.alpha > 0.01 && near(w.bounds, frame)
            }
        }()
        guard let index else { return .notFound }
        let target = windows[index]
        // Ordinary windows of other apps in front of it. Caret's own panels (the slip, the desk, this
        // rim) are never cover; panels above layer 0 (menus, the Dock, notifications) come and go
        // over everything and would leave the rim off most of the time.
        for w in windows[..<index] where w.pid != ownPID && w.layer == 0 && w.alpha > 0.01 {
            guard w.bounds.width >= minimumCover.width, w.bounds.height >= minimumCover.height else { continue }
            if w.bounds.intersects(target.bounds) { return .covered(number: target.number, frame: target.bounds, by: w.pid) }
        }
        return .clear(number: target.number, frame: target.bounds)
    }

    static func near(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) <= matchTolerance && abs(a.minY - b.minY) <= matchTolerance
            && abs(a.width - b.width) <= matchTolerance && abs(a.height - b.height) <= matchTolerance
    }

    // MARK: - Geometry

    /// The ring is 1.5 pt, one point outside the window, with a 16 pt bloom of Glow beyond it.
    public static let ringWidth: CGFloat = 1.5
    public static let bloom: CGFloat = 16
    /// The perched figure: 22 wide, its right edge 18 in from the window's right, its top 13 above
    /// the window's top edge, so it straddles the edge.
    public static let perchWidth: CGFloat = 22
    public static let perchRight: CGFloat = 18
    public static let perchAbove: CGFloat = 13
    /// The caption: 26 tall, 12 in from the window's left, its bottom 15 below the window's bottom.
    public static let captionHeight: CGFloat = 26
    public static let captionInset: CGFloat = 12
    public static let captionBelow: CGFloat = 15

    public struct Layout: Equatable, Sendable {
        /// The panel holding the ring and its bloom: the window's frame grown by the bloom.
        public var ring: CGRect
        /// The perched figure's frame.
        public var perch: CGRect
        /// The caption's top-left corner; its width follows its words.
        public var caption: CGPoint
    }

    /// Where each part goes around `window`, kept on `visible` (the screen's visible frame): a window
    /// whose top is right under the menu bar gets its figure moved down onto the window rather than
    /// under the bar, and one at the bottom of the screen gets its caption lifted inside it.
    public static func layout(window: CGRect, perchHeight: CGFloat, visible: CGRect) -> Layout {
        let ring = window.insetBy(dx: -bloom, dy: -bloom)
        var perchTop = window.minY - perchAbove
        if perchTop < visible.minY { perchTop = window.minY + 4 }
        let perch = CGRect(x: window.maxX - perchRight - perchWidth, y: perchTop, width: perchWidth, height: perchHeight)
        var captionTop = window.maxY + captionBelow - captionHeight
        if captionTop + captionHeight > visible.maxY { captionTop = window.maxY - captionHeight - 8 }
        let caption = CGPoint(x: max(window.minX + captionInset, visible.minX + 8), y: captionTop)
        return Layout(ring: ring, perch: perch, caption: caption)
    }

    /// "2 of 3" from a row's "Step 2 of 3" or "Stopped before step 3 of 3"; nil when it names no step.
    public static func stepCount(_ progress: String?) -> String? {
        guard let progress, let range = progress.range(of: #"\d+ of \d+"#, options: .regularExpression) else { return nil }
        return String(progress[range])
    }
}
