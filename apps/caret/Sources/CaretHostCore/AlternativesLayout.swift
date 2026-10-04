import CoreGraphics

/// Where the marks after an alternative go (v3 DIRECTION.md section 5.2), from the caret, the
/// field and the measured widths. Global, top-left points; offsets are from the caret's top right.
///
/// - The underline runs under the ghost text and stops at its end, and never past the field: the
///   prototype's ran past its window when the text wrapped (LEAD-REVIEW defect 2).
/// - The figure and the ticks stand 0.35 em after the text with their bottom on the baseline, and
///   only where they fit on the caret's line inside the field. They never wrap onto a second line
///   (defect 2); where they do not fit they are not drawn, and the text alone is the offer.
public struct AlternativesLayout: Equatable, Sendable {
    /// The figure's width: 0.6 of the caret's height, 12 to 14.
    public var figureSize: CGFloat
    /// The underline's length.
    public var underlineWidth: CGFloat
    /// The span the decor reserves for the text before the tag.
    public var textSpan: CGFloat
    public var showsTag: Bool
    /// 0.35 em between the text and the figure.
    public var tagGap: CGFloat
    /// The decor's height: the caret's line plus up to 4 pt for the underline, never below the field.
    public var decorHeight: CGFloat
    /// From the decor's bottom up to the baseline, where the tag's bottom sits.
    public var tagBottom: CGFloat

    /// The space kept free at the field's right edge.
    public static let edge: CGFloat = 2

    public init(caret: CGRect, field: CGRect, textWidth: CGFloat, fontSize: CGFloat, tagWidth: CGFloat, open: Bool) {
        figureSize = min(max((caret.height * 0.6).rounded(), 12), 14)
        let room = max(0, field.maxX - Self.edge - caret.maxX)
        underlineWidth = min(textWidth, room)
        tagGap = (fontSize * 0.35).rounded()
        showsTag = open && textWidth + tagGap + tagWidth <= room
        textSpan = showsTag ? textWidth : underlineWidth
        decorHeight = max(caret.height, min(caret.height + 4, field.maxY - caret.minY))
        tagBottom = max(0, decorHeight - caret.height * 0.78)
    }

    /// The tag's frame for a tag `width` wide and `height` tall, global top-left, or nil when it is
    /// not drawn.
    public func tagFrame(caret: CGRect, width: CGFloat, height: CGFloat) -> CGRect? {
        guard showsTag else { return nil }
        let baseline = caret.minY + caret.height * 0.78
        return CGRect(x: caret.maxX + textSpan + tagGap, y: baseline - height, width: width, height: height)
    }
}
