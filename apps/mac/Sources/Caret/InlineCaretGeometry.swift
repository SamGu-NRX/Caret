import AppKit
import ApplicationServices
import CoreGraphics

/// Screen geometry for the inline preview: where the host field's insertion
/// point is, and how large its text is. No UI; every value here is read from
/// the accessibility API or is `nil`.
///
/// ## Which apps can support `.atCaret`
///
/// The whole inline path rests on one parameterized accessibility attribute,
/// `AXBoundsForRange`. An app has to implement it; nothing obliges it to.
///
/// - Native Cocoa text views and fields (`NSTextView`, `NSTextField`) inherit
///   AppKit's own accessibility implementation, which answers text-range
///   queries. TextEdit, Notes, Mail and Xcode are in this family.
/// - Chromium- and Electron-hosted fields build their accessibility tree
///   themselves, and parameterized text-range attributes are frequently absent
///   or answer with an empty rect. Browsers, Slack, VS Code and Discord are in
///   this family.
///
/// That split is read off the documented behaviour of the AX text APIs. **No
/// app was measured in this pass**, so treat the two lists as the shape of the
/// problem rather than as results. Nothing downstream depends on the lists
/// being right: `placement(caretRect:fieldRect:)` decides per field, at the
/// moment an offer is shown, from geometry that was actually returned.
enum InlineCaretGeometry {

    // MARK: - Caret

    /// Screen rect of the insertion point in Cocoa coordinates (bottom-left
    /// origin), or `nil` when the field will not say where its caret is.
    ///
    /// Never fabricates a rect. A caller that gets `nil` is expected to take
    /// `.nearbyFallback`, not to invent a position.
    static func caretRect(for element: AXUIElement, caretUTF16: Int) -> CGRect? {
        guard caretUTF16 >= 0 else { return nil }

        // A zero-length range is the direct question: "where is the caret?".
        // Cocoa text answers with a zero-width rect that still carries the
        // line's height, so width 0 is a correct answer and height is the only
        // usable-or-not test.
        if let axRect = boundsForRange(element, location: caretUTF16, length: 0), axRect.height > 0 {
            return AXHelpers.cocoaRect(fromAX: axRect)
        }

        // Some fields reject a collapsed range but will measure one character.
        // Measure the character the caret sits against and collapse to the edge
        // the caret is on.
        let probeLocation = max(0, caretUTF16 - 1)
        if let axRect = boundsForRange(element, location: probeLocation, length: 1), axRect.height > 0 {
            // At offset 0 there is no preceding character, so the probe measured
            // the character *after* the caret and the caret is on its leading
            // edge. Anywhere else the probe measured the character before the
            // caret, so the caret is on its trailing edge.
            let edgeX = caretUTF16 == 0 ? axRect.minX : axRect.maxX
            let collapsed = CGRect(x: edgeX, y: axRect.minY, width: 0, height: axRect.height)
            return AXHelpers.cocoaRect(fromAX: collapsed)
        }

        return nil
    }

    /// Raw `AXBoundsForRange` answer, still in AX (top-left origin) coordinates.
    private static func boundsForRange(_ element: AXUIElement, location: Int, length: Int) -> CGRect? {
        var range = CFRange(location: location, length: length)
        guard let rangeValue = AXValueCreate(.cfRange, &range) else { return nil }

        var boundsRef: CFTypeRef?
        let status = AXUIElementCopyParameterizedAttributeValue(
            element,
            kAXBoundsForRangeParameterizedAttribute as CFString,
            rangeValue,
            &boundsRef
        )
        guard status == .success, let boundsRef else { return nil }

        // The value comes from another process and can be anything. This runs
        // on the keystroke path, so an unchecked cast here would turn a
        // misbehaving app into a crash in Caret.
        guard CFGetTypeID(boundsRef) == AXValueGetTypeID() else { return nil }

        var rect = CGRect.zero
        guard AXValueGetValue(boundsRef as! AXValue, .cgRect, &rect) else { return nil }
        guard rect.origin.x.isFinite, rect.origin.y.isFinite,
              rect.size.width.isFinite, rect.size.height.isFinite
        else { return nil }
        return rect
    }

    // MARK: - Font

    /// Point size of the host field's text, or `nil` when the field does not
    /// expose it.
    ///
    /// Ghost text set at a guessed size reads as another app's text dropped
    /// into the user's line, which is worse than the caller's documented
    /// default, so an unreadable field returns `nil` rather than an estimate.
    static func fontPointSize(for element: AXUIElement) -> CGFloat? {
        // `AXAttributedStringForRange` is the only standard route to the host's
        // font, and it needs a character to describe. An empty field therefore
        // has no answer at all.
        var range = CFRange(location: 0, length: 1)
        guard let rangeValue = AXValueCreate(.cfRange, &range) else { return nil }

        var result: CFTypeRef?
        let status = AXUIElementCopyParameterizedAttributeValue(
            element,
            kAXAttributedStringForRangeParameterizedAttribute as CFString,
            rangeValue,
            &result
        )
        guard status == .success,
              let attributed = result as? NSAttributedString,
              attributed.length > 0
        else { return nil }

        guard let raw = attributed.attribute(fontAttributeKey, at: 0, effectiveRange: nil) else { return nil }

        // `AXFont` is documented as a dictionary keyed by `AXFontSize` and
        // friends, but AppKit hands back a real `NSFont` for its own views.
        let size: CGFloat?
        switch raw {
        case let font as NSFont:
            size = font.pointSize
        case let descriptor as [String: Any]:
            size = (descriptor[fontSizeKey] as? NSNumber).map { CGFloat($0.doubleValue) }
        default:
            size = nil
        }

        // Out-of-range answers come from apps reporting in the wrong unit or
        // reporting nothing useful. Either way `nil` beats a bad number.
        guard let size, size.isFinite, size >= 4, size <= 200 else { return nil }
        return size
    }

    /// `kAXFontTextAttribute`, which the AX headers define as a `CFSTR` macro
    /// and Swift therefore imports as `Unmanaged<CFString>`.
    private static let fontAttributeKey = NSAttributedString.Key(
        kAXFontTextAttribute.takeUnretainedValue() as String
    )

    private static let fontSizeKey = kAXFontSizeKey.takeUnretainedValue() as String

    // MARK: - Placement

    /// Whether the preview can be drawn as a continuation of the user's line.
    ///
    /// `fieldRect` is accepted because the caller has it, but it deliberately
    /// does not affect the answer: knowing where a field is does not say where
    /// inside it the caret sits, and ghost text at a guessed position is
    /// exactly the failure the labeled fallback exists to prevent.
    static func placement(caretRect: CGRect?, fieldRect: CGRect?) -> InlinePreviewPresentation.Placement {
        guard let caretRect,
              caretRect.height > 0,
              caretRect.origin.x.isFinite,
              caretRect.origin.y.isFinite
        else { return .nearbyFallback }
        return .atCaret
    }

    /// Shown to the user whenever `.nearbyFallback` is in effect: one sentence
    /// that names the limit and says what Caret did instead of inline text.
    static let unsupportedCaretGeometryNote =
        "This field doesn't report where its cursor is, so Caret shows the suggestion beside it instead of inline."
}
