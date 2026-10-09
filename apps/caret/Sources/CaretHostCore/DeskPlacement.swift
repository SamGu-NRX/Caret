import CoreGraphics
import Foundation

/// Where the activity list with the ask field (v3's desk) opens when no perch is on screen to
/// hang from: under the menu bar of the screen that holds the window in front, centered over that
/// window.
///
/// Q1 (A18, bug 13) had it open from the screen's bottom-right corner, about 1,000 pt from the
/// Chrome window the ask was about on a 2560-wide display. v3's desk sits under the menu bar glyph,
/// which on a wide screen is just as far from the work. Under the menu bar keeps the desk off the
/// window's fields (it covers at most the window's title bar and toolbar, which sit at its top),
/// and centering it over the window keeps it where the user is looking. Anchoring it inside the
/// window was the other choice the brief offered; it would cover the form the plan is about.
///
/// Frames are global, top-left origin (Accessibility's coordinates).
public enum DeskPlacement {
    /// Below the menu bar, as v3 places the desk.
    public static let gap: CGFloat = 10
    /// Kept clear at the screen's sides.
    public static let margin: CGFloat = 8

    /// The screen to open on: the one holding most of `window`; with no window, `fallback`'s.
    public static func screen(for window: CGRect?, screens: [CGRect], fallback: CGRect) -> CGRect {
        guard let window else { return fallback }
        let best = screens.max { area($0.intersection(window)) < area($1.intersection(window)) }
        guard let best, area(best.intersection(window)) > 0 else { return fallback }
        return best
    }

    /// The desk's top-left corner on `visible`, the visible frame of its screen (below the menu
    /// bar, above the Dock), for a desk `width` wide. Centered over the part of `window` on that
    /// screen, else at the screen's right, under where the menu bar glyph sits.
    public static func topLeft(width: CGFloat, visible: CGRect, window: CGRect?) -> CGPoint {
        let usable = visible.insetBy(dx: margin, dy: 0)
        let onScreen = window.map { $0.intersection(visible) }.flatMap { $0.isNull || $0.isEmpty ? nil : $0 }
        let center = onScreen?.midX ?? (usable.maxX - width / 2)
        let x = min(max(center - width / 2, usable.minX), max(usable.minX, usable.maxX - width))
        return CGPoint(x: x, y: visible.minY + gap)
    }

    private static func area(_ r: CGRect) -> CGFloat { r.isNull ? 0 : r.width * r.height }
}
