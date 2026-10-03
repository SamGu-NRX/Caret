import CoreGraphics
import Foundation

/// Where an offer line, a pop-up or a card goes around the field it is about.
///
/// A3's rule, which the open alternatives list already follows: below the field without covering
/// another field or its label; above when below has no room or covers something; otherwise
/// narrower, or beside the field. A9's `card-2-change-time.png` shows why panels need it too: the
/// event card hung 6 pt under Phone's caret covered Order number, Order total and their labels.
///
/// The panel hangs from the field when the field is one line tall, so it never covers the field's
/// own text; in a taller field (a text view) it hangs from the caret's line, as `SURFACES.md`
/// section 3 places the offer line. What counts as covering something is what `obstacles`
/// returns for a frame: the host hit-tests the app's own elements there (`ObstacleProbe`), and is
/// asked only as far down the list as it needs to go.
///
/// Frames are global, top-left origin (Accessibility's coordinates).
public enum FieldPanelPlacement {
    public static let gap: CGFloat = 6
    /// Panels stay this far inside the screen.
    public static let margin: CGFloat = 8
    /// The panel's left edge sits this far left of the caret (`SURFACES.md` section 3).
    public static let caretInset: CGFloat = 12

    public enum Spot: String, Codable, Sendable {
        case below, above, belowNarrow, aboveNarrow, right, left

        /// The corner the panel stays pinned at when its content grows or shrinks: the corner
        /// nearest the field, so growth moves away from it.
        public var corner: Corner {
            switch self {
            case .below, .belowNarrow, .right: return .topLeft
            case .above, .aboveNarrow: return .bottomLeft
            case .left: return .topRight
            }
        }

        public var isNarrow: Bool { self == .belowNarrow || self == .aboveNarrow }
    }

    public enum Corner: String, Codable, Sendable { case topLeft, topRight, bottomLeft, bottomRight }

    public struct Choice: Equatable, Sendable {
        public var frame: CGRect
        public var spot: Spot
        /// Square points of the app's elements under the frame; zero when it covers nothing. Nil
        /// when no candidate fit on screen and nothing was measured.
        public var overlap: CGFloat?
        /// Frames asked of `obstacles`, for the debug state.
        public var probed: Int

        public init(frame: CGRect, spot: Spot, overlap: CGFloat?, probed: Int) {
            self.frame = frame
            self.spot = spot
            self.overlap = overlap
            self.probed = probed
        }

        /// The pinned corner's point, global top-left.
        public var cornerPoint: CGPoint {
            switch spot.corner {
            case .topLeft: return CGPoint(x: frame.minX, y: frame.minY)
            case .topRight: return CGPoint(x: frame.maxX, y: frame.minY)
            case .bottomLeft: return CGPoint(x: frame.minX, y: frame.maxY)
            case .bottomRight: return CGPoint(x: frame.maxX, y: frame.maxY)
            }
        }
    }

    /// What the panel hangs from: the field when it holds one line (shorter than two caret lines
    /// plus padding), else the caret's own line.
    public static func anchor(field: CGRect, caret: CGRect) -> CGRect {
        let line = max(caret.height, 12)
        guard field.height > line * 2 + 8 else { return field }
        return CGRect(x: field.minX, y: caret.minY, width: field.width, height: caret.height)
    }

    /// The candidate frames in the order they are tried. `narrow` is the panel's size at its
    /// narrowest width, when that is narrower than `size`; a line has none.
    public static func candidates(field: CGRect, caret: CGRect, size: CGSize, narrow: CGSize?, bounds: CGRect) -> [(Spot, CGRect)] {
        let hang = anchor(field: field, caret: caret)
        let usable = bounds.insetBy(dx: margin, dy: margin)
        func clampX(_ x: CGFloat, _ w: CGFloat) -> CGFloat { min(max(x, usable.minX), usable.maxX - w) }
        func vertical(_ spot: Spot, _ s: CGSize) -> (Spot, CGRect) {
            let x = clampX(caret.minX - caretInset, s.width)
            let y = spot == .below || spot == .belowNarrow ? hang.maxY + gap : hang.minY - gap - s.height
            return (spot, CGRect(x: x, y: y, width: s.width, height: s.height))
        }
        // Beside the field, top-aligned with what it hangs from, moved up only as far as the
        // screen's bottom edge needs.
        func beside(_ spot: Spot) -> (Spot, CGRect) {
            let x = spot == .right ? field.maxX + gap : field.minX - gap - size.width
            let y = max(min(hang.minY, usable.maxY - size.height), usable.minY)
            return (spot, CGRect(x: x, y: y, width: size.width, height: size.height))
        }
        var list = [vertical(.below, size), vertical(.above, size)]
        if let narrow, narrow.width < size.width { list += [vertical(.belowNarrow, narrow), vertical(.aboveNarrow, narrow)] }
        list += [beside(.right), beside(.left)]
        return list
    }

    /// The first candidate on screen that covers nothing; else the one on screen covering least,
    /// earlier ones winning ties; else below, clamped. `obstacles(frame)` returns the frames of
    /// what lies under `frame`; the field and anything containing it are never obstacles.
    public static func choose(
        field: CGRect, caret: CGRect, size: CGSize, narrow: CGSize?, bounds: CGRect,
        obstacles: (CGRect) -> [CGRect]
    ) -> Choice {
        let usable = bounds.insetBy(dx: margin, dy: margin)
        // Never over the line it hangs from. Inside a tall field the rest of the field is fair
        // game, as the offer line has always been.
        let hang = anchor(field: field, caret: caret)
        let all = candidates(field: field, caret: caret, size: size, narrow: narrow, bounds: bounds)
        var known: [CGRect] = []
        var probed = 0
        var best: Choice?
        for (spot, frame) in all where usable.contains(frame) && !frame.intersects(hang) {
            probed += 1
            for found in obstacles(frame) where !found.insetBy(dx: -2, dy: -2).contains(field) && !known.contains(found) {
                known.append(found)
            }
            let overlap = known.reduce(CGFloat(0)) { sum, o in
                let i = o.intersection(frame)
                return i.isNull ? sum : sum + i.width * i.height
            }
            let choice = Choice(frame: frame, spot: spot, overlap: overlap, probed: probed)
            if overlap == 0 { return choice }
            if let current = best?.overlap, current <= overlap { continue }
            best = choice
        }
        if var best {
            best.probed = probed
            return best
        }
        let (spot, frame) = all[0]
        return Choice(frame: frame, spot: spot, overlap: nil, probed: probed)
    }
}
