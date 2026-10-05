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
    /// From the caret's top to the underline's 3 pt frame, so its middle sits 2 pt under the
    /// baseline (baseline estimated at 0.78 of the caret's height), whatever room is below.
    public var underlineTop: CGFloat

    /// The underline's frame height, and how far under the baseline its middle sits.
    public static let underlineHeight: CGFloat = 3
    public static let belowBaseline: CGFloat = 2

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
        underlineTop = caret.height * 0.78 + Self.belowBaseline - Self.underlineHeight / 2
    }

    /// The marks for an alternative drawn in a capsule (`CaretLinePlacement`), and the caret they
    /// hang from: a one-point caret at the start of the capsule's text, as tall as its line, so the
    /// decor is pinned at its top right exactly as for ghost text on the caret's line. The underline
    /// runs under the capsule's text; the figure and the ticks stand after the capsule's trailing
    /// edge, and only where they fit inside `area` (the capsule's own area).
    ///
    /// `padding` and `verticalPadding` are the capsule's (KeyType's `CapsuleCompletionView`: 10 and 4).
    /// KeyType adds 2 pt to the measured text width and centers the text, so it starts 1 pt after
    /// the padding.
    public static func capsule(
        _ capsule: CGRect, area: CGRect, padding: CGFloat, verticalPadding: CGFloat, textWidth: CGFloat, fontSize: CGFloat,
        tagWidth: CGFloat, open: Bool
    ) -> (layout: AlternativesLayout, caret: CGRect) {
        let caret = CGRect(x: capsule.minX + padding, y: capsule.minY + verticalPadding, width: 1, height: max(1, capsule.height - verticalPadding * 2))
        var layout = AlternativesLayout(caret: caret, field: capsule, textWidth: textWidth, fontSize: fontSize, tagWidth: 0, open: false)
        layout.showsTag = open && capsule.maxX + layout.tagGap + tagWidth <= area.maxX - Self.edge
        // With the tag, the span reaches the capsule's edge so the tag's gap is measured from there.
        layout.textSpan = layout.showsTag ? capsule.maxX - caret.maxX : layout.underlineWidth
        return (layout, caret)
    }

    /// The tag's frame for a tag `width` wide and `height` tall, global top-left, or nil when it is
    /// not drawn.
    public func tagFrame(caret: CGRect, width: CGFloat, height: CGFloat) -> CGRect? {
        guard showsTag else { return nil }
        let baseline = caret.minY + caret.height * 0.78
        return CGRect(x: caret.maxX + textSpan + tagGap, y: baseline - height, width: width, height: height)
    }
}
