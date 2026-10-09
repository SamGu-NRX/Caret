import CoreGraphics

/// Where the one-time coach slip goes beside the first ghost text in another app (HANDOFF §3, After): under the line
/// being typed, never over it. The first capture put it on the line itself and hid the words the person was typing
/// (shots/done-first-ghost-light.png).
///
/// Cocoa screen coordinates (origin bottom left). `line` is the typed line's box: from the caret's x, the line's
/// bottom to its top.
public enum CoachSlipPlacement {
    public static let gap: CGFloat = 6
    /// The slip's left edge sits this far left of the caret, so its first word lines up under the words just typed.
    public static let lead: CGFloat = 8

    public static func frame(line: CGRect, slip: CGSize, visible: CGRect) -> CGRect {
        var x = line.minX - lead
        x = min(max(x, visible.minX + 4), visible.maxX - slip.width - 4)
        let below = line.minY - gap - slip.height
        // No room under the line (the field is at the screen's foot): above it instead, still clear of it.
        let y = below >= visible.minY + 4 ? below : line.maxY + gap
        return CGRect(x: x, y: y, width: slip.width, height: slip.height)
    }
}
