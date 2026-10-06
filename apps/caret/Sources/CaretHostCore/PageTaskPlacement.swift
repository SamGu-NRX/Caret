import CoreGraphics
import Foundation

/// Where the page task panel stands (UI moment 1): beside the form's first field, or at the page's top edge
/// when there is no field to stand beside. Frames are global, top-left points.
///
/// Beside, not below: the panel lists the form's own fields, so below the first field it would cover the
/// ones it names. The host cannot hit-test web content (H10's probe: Chrome shows Accessibility none), so
/// the rule is geometric: right of the field inside the page, else left of it, else the page's top right
/// corner. The panel stays where it was first placed for the rest of the task.
public enum PageTaskPlacement {
    public static let gap: CGFloat = 12
    /// Inside the page and the screen.
    public static let margin: CGFloat = 8
    /// The panel's top sits this far above the field's, so its title lines up with the field.
    public static let lift: CGFloat = 6

    public enum Side: String, Codable, Sendable { case right, left, top }

    public struct Spot: Equatable, Sendable {
        /// The panel's top-left corner.
        public var origin: CGPoint
        public var side: Side
    }

    public static func place(size: CGSize, anchor: PageTaskAnchor, screen: CGRect) -> Spot {
        let page = anchor.viewport.map { $0.intersection(screen) }.flatMap { $0.isNull || $0.isEmpty ? nil : $0 } ?? screen
        if let field = anchor.field, page.intersects(field) {
            let y = clampY(field.minY - lift, height: size.height, in: screen)
            let right = field.maxX + gap
            if right + size.width <= page.maxX - margin { return Spot(origin: CGPoint(x: right, y: y), side: .right) }
            let left = field.minX - gap - size.width
            if left >= page.minX + margin { return Spot(origin: CGPoint(x: left, y: y), side: .left) }
        }
        let x = min(max(page.maxX - margin - size.width, screen.minX + margin), screen.maxX - margin - size.width)
        return Spot(origin: CGPoint(x: x, y: clampY(page.minY + margin, height: size.height, in: screen)), side: .top)
    }

    static func clampY(_ y: CGFloat, height: CGFloat, in screen: CGRect) -> CGFloat {
        min(max(y, screen.minY + margin), max(screen.maxY - margin - height, screen.minY + margin))
    }
}
