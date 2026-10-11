import CoreGraphics

/// How an offer at the caret is drawn: as ghost text on the caret's line, or in a capsule off it.
public enum CaretPresentation: String, Codable, Sendable {
    case inline
    case capsule
}

/// Where a capsule at the caret goes. Alternatives and KeyType's ghost capsules share this rule
/// (V1a check 4: injected alternatives in a TextEdit document that filled its window were withdrawn
/// eleven times because the widest did not fit after the caret, and KeyType's capsule hung only
/// below the caret, so on the window's last line it was refused).
///
/// The capsule goes below the caret's line, else above it, centered on the caret and slid sideways
/// to stay inside the area. The caret's line itself is never covered: the capsule starts `gap`
/// under its bottom or ends `gap` over its top. The document's other lines are not obstacles; the
/// capsule lies over them, as KeyType's capsule always lay over the line below the caret.
///
/// The areas are tried in order (`areas(viewport:window:display:)`): the visible text viewport
/// clipped to the window and the display, then the window clipped to the display. A single-line
/// field's viewport is one line tall and holds no capsule, so its capsule lands under the field
/// inside the window, as A9's did.
///
/// A capsule wider than an area is bounded to the area's width (`Spot.bounded`); the caller shows a
/// shortened text (`truncated`) and keeps the whole one for Tab.
///
/// Rectangles are in any one space whose y grows downward (Accessibility's global top-left points).
/// AppKit callers flip theirs first (`flipped`).
public enum CaretLinePlacement {
    public enum Side: String, Codable, Sendable {
        case below, above
    }

    public struct Spot: Equatable, Sendable {
        public var frame: CGRect
        public var side: Side
        /// The index in `areas` of the area that held it.
        public var area: Int
        /// The capsule was narrowed to the area: what it shows must be shortened to `frame.width`.
        public var bounded: Bool
    }

    /// KeyType's gap between the caret and its capsule (`GhostTextOverlayWindow.capsuleGapBelowCaret`).
    public static let gap: CGFloat = 5

    /// The capsule's frame for a capsule of `size` at `caretLine` (the caret's rectangle, as tall as
    /// its line), or nil when no area has room for it on either side of the line.
    public static func place(size: CGSize, caretLine: CGRect, areas: [CGRect], gap: CGFloat = gap) -> Spot? {
        for (index, area) in areas.enumerated() where !area.isNull && !area.isEmpty {
            let width = min(size.width, area.width)
            var x = caretLine.midX - width / 2
            x = min(max(x, area.minX), area.maxX - width)
            let below = caretLine.maxY + gap
            if below + size.height <= area.maxY, below >= area.minY {
                return Spot(frame: CGRect(x: x, y: below, width: width, height: size.height), side: .below, area: index, bounded: width < size.width)
            }
            let above = caretLine.minY - gap - size.height
            if above >= area.minY, above + size.height <= area.maxY {
                return Spot(frame: CGRect(x: x, y: above, width: width, height: size.height), side: .above, area: index, bounded: width < size.width)
            }
        }
        return nil
    }

    /// The areas a capsule may use, in the order tried. Nil `window` gives none: nothing then says
    /// the capsule stays on the app's own window.
    public static func areas(viewport: CGRect?, window: CGRect?, display: CGRect?) -> [CGRect] {
        guard let window, !window.isEmpty else { return [] }
        let screen = display.map { window.intersection($0) } ?? window
        guard !screen.isNull, !screen.isEmpty else { return [] }
        var result: [CGRect] = []
        if let viewport {
            let visible = viewport.intersection(screen)
            if !visible.isNull, !visible.isEmpty { result.append(visible) }
        }
        if result.first != screen { result.append(screen) }
        return result
    }

    /// The same rectangle in a space whose y grows the other way (about y = 0). Its own inverse.
    public static func flipped(_ rect: CGRect) -> CGRect {
        CGRect(x: rect.minX, y: -rect.maxY, width: rect.width, height: rect.height)
    }

    /// `text` shortened at its end, with an ellipsis, until `measure` says it fits in `width`.
    /// The whole text when it already fits; nil when not even the ellipsis does.
    public static func truncated(_ text: String, toWidth width: CGFloat, measure: (String) -> CGFloat) -> String? {
        if measure(text) <= width { return text }
        let characters = Array(text)
        var low = 0, high = characters.count
        var best: String?
        while low <= high {
            let mid = (low + high) / 2
            let candidate = String(characters.prefix(mid)).trimmingTrailingSpaces() + "…"
            if measure(candidate) <= width {
                best = candidate
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        return best
    }
}

private extension String {
    func trimmingTrailingSpaces() -> String {
        var s = self
        while let last = s.last, last == " " { s.removeLast() }
        return s
    }
}
