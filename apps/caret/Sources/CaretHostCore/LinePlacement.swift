import CoreGraphics
import Foundation

/// Where a fill's offer line or toast goes (`SURFACES.md` section 5: 6 pt above the field's top
/// right corner, right-aligned to the field).
///
/// A2's screenshots showed the standard spot failing in tight forms: with about 27 pt between
/// fields, a 28 pt line 6 pt above a field covers the right end of the field above it. So the
/// standard spot is one of four candidates, tried in order, and the first that covers nothing
/// wins: above, below, then a compact 20 pt line above, then below. When all four cover
/// something, the compact candidate covering the least area wins: a smaller line over a sliver of
/// the neighbor is better than a full one over its text.
///
/// Frames are global, top-left origin (Accessibility's coordinates).
public enum LinePlacement {
    public static let height: CGFloat = 28
    public static let compactHeight: CGFloat = 20
    public static let gap: CGFloat = 6
    public static let compactGap: CGFloat = 3
    /// Panels stay this far inside the screen.
    public static let margin: CGFloat = 8

    public enum Side: String, Codable, Sendable { case above, below }

    public struct Choice: Equatable, Sendable {
        public var frame: CGRect
        public var side: Side
        public var compact: Bool
        /// Points of overlap with what was on screen; zero when it covers nothing.
        public var overlap: CGFloat
    }

    /// The four candidate frames for a line `width` wide (standard height; a compact line is
    /// narrower, `compactWidth`).
    public static func candidates(field: CGRect, width: CGFloat, compactWidth: CGFloat, bounds: CGRect) -> [(CGRect, Side, Bool)] {
        func frame(_ side: Side, compact: Bool) -> CGRect {
            let h = compact ? compactHeight : height
            let g = compact ? compactGap : gap
            let w = compact ? compactWidth : width
            var x = field.maxX - w
            x = min(max(x, bounds.minX + margin), bounds.maxX - margin - w)
            let y = side == .above ? field.minY - g - h : field.maxY + g
            return CGRect(x: x, y: y, width: w, height: h)
        }
        return [
            (frame(.above, compact: false), .above, false),
            (frame(.below, compact: false), .below, false),
            (frame(.above, compact: true), .above, true),
            (frame(.below, compact: true), .below, true),
        ]
    }

    /// Picks a frame. `obstacles` are the frames of whatever the candidates would cover (other
    /// fields, labels, the title bar); the field itself is never an obstacle.
    public static func choose(
        field: CGRect, width: CGFloat, compactWidth: CGFloat, obstacles: [CGRect], bounds: CGRect
    ) -> Choice {
        let usable = bounds.insetBy(dx: margin, dy: margin)
        var best: Choice?
        for (frame, side, compact) in candidates(field: field, width: width, compactWidth: compactWidth, bounds: bounds) {
            guard usable.contains(frame) else { continue }
            let overlap = obstacles
                .filter { !$0.equalTo(field) }
                .map { $0.intersection(frame) }
                .filter { !$0.isNull }
                .reduce(0) { $0 + $1.width * $1.height }
            let choice = Choice(frame: frame, side: side, compact: compact, overlap: overlap)
            if overlap == 0 { return choice }
            // Among covering candidates prefer the compact ones, then the least overlap.
            if let current = best {
                if (compact && !current.compact) || (compact == current.compact && overlap < current.overlap) {
                    best = choice
                }
            } else {
                best = choice
            }
        }
        if let best { return best }
        // Off every edge (a field at the very top of a small screen): the standard spot, clamped.
        let fallback = candidates(field: field, width: width, compactWidth: compactWidth, bounds: bounds)[1]
        return Choice(frame: fallback.0, side: fallback.1, compact: false, overlap: 0)
    }
}

/// When a fill's result toast is still up and the next field's offer arrives, one of them gives
/// way, so the two never stack (A2, run 6: "Filled 1 field" above "from caret-fixture, Reference").
///
/// The toast is the answer to what the user just did and carries the only undo, so it keeps the
/// line while it lives if the new offer names the same source: the source is already on screen,
/// and the next field's value is drawn in the field itself, so Tab still sees what it takes. When
/// the toast ends, the line returns for the offer. A new offer from a different source must name
/// its source before Tab can take it, so it wins and the toast goes, taking its undo with it
/// (`SURFACES.md` section 8: ⌘Z is Caret's only while the toast is visible).
public enum FillLineRule {
    public enum Outcome: Equatable, Sendable {
        /// Nothing in the way: show the offer's line.
        case showLine
        /// Keep the toast; the offer shows its ghost value only, and its line after the toast.
        case deferLine
        /// Dismiss the toast and its undo; show the offer's line.
        case replaceToast
    }

    public static func resolve(toastSource: String?, offerSource: String) -> Outcome {
        guard let toastSource else { return .showLine }
        return toastSource == offerSource ? .deferLine : .replaceToast
    }
}
