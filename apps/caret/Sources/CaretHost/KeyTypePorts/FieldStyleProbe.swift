//  Adapted from KeyType's app target, `KeyType/Logic/Completion/FieldFontResolver.swift`
//  (MIT, see packages/keytype/LICENSE). That file lives in KeyType's app, not a package, so the
//  host carries a trimmed copy: same 1-character attributed-string probe at the caret and the same
//  font/colour/paragraph extraction. Dropped: the browser descendant search and Microsoft Word's
//  bundled-font registration.

import AppKit
import ApplicationServices
import CompletionUI

/// Reads the text attributes at the caret of a field, so ghost text can match its typeface and
/// colour. Every value may be nil when the app does not expose it through AX; the presenter then
/// sizes a system font from the caret height.
@MainActor
enum FieldStyleProbe {
    private static let axFontAttribute = NSAttributedString.Key("AXFont")
    private static let axForegroundColorAttribute = NSAttributedString.Key("AXForegroundColor")

    static func style(of field: AXUIElement) -> OverlayTextStyle {
        guard let string = attributedProbe(field) else { return OverlayTextStyle(font: nil, textColor: nil) }
        let font = font(from: string)
        let paragraph = string.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
        return OverlayTextStyle(
            font: font,
            textColor: color(from: string),
            paragraphStyle: paragraph,
            baselineOffset: cgFloat(.baselineOffset, from: string) ?? 0,
            lineHeight: lineHeight(font: font, paragraphStyle: paragraph)
        )
    }

    /// The attributed string for a length-1 range at (or just before) the caret. AX returns
    /// nothing for a zero-length range.
    private static func attributedProbe(_ field: AXUIElement) -> NSAttributedString? {
        guard let selected = AXRead.range(kAXSelectedTextRangeAttribute, on: field) else { return nil }
        var probe: CFRange
        if selected.length > 0 {
            probe = CFRange(location: selected.location, length: 1)
        } else if selected.location > 0 {
            probe = CFRange(location: selected.location - 1, length: 1)
        } else {
            probe = CFRange(location: 0, length: 1)
        }
        guard let axRange = AXValueCreate(.cfRange, &probe) else { return nil }
        var attributed: AnyObject?
        guard AXUIElementCopyParameterizedAttributeValue(
            field,
            kAXAttributedStringForRangeParameterizedAttribute as CFString,
            axRange,
            &attributed
        ) == .success, let string = attributed as? NSAttributedString, string.length > 0
        else { return nil }
        return string
    }

    private static func font(from string: NSAttributedString) -> NSFont? {
        if let font = string.attribute(.font, at: 0, effectiveRange: nil) as? NSFont { return font }
        guard let info = string.attribute(axFontAttribute, at: 0, effectiveRange: nil) as? [String: Any] else {
            return nil
        }
        let size = (info["AXFontSize"] as? CGFloat)
            ?? (info["AXFontSize"] as? Double).map { CGFloat($0) }
            ?? NSFont.systemFontSize
        let candidates = [
            info["AXFontName"] as? String,
            info["AXVisibleName"] as? String,
            info["AXFontFamily"] as? String,
        ]
        for case let name? in candidates where !name.isEmpty {
            if let font = NSFont(name: name, size: size) { return font }
        }
        return NSFont.systemFont(ofSize: size)
    }

    /// AX gives a `CGColor`; AppKit-backed strings may give an `NSColor`.
    private static func color(from string: NSAttributedString) -> NSColor? {
        if let color = string.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor { return color }
        guard let raw = string.attribute(axForegroundColorAttribute, at: 0, effectiveRange: nil) else { return nil }
        let cf = raw as CFTypeRef
        guard CFGetTypeID(cf) == CGColor.typeID else { return nil }
        return NSColor(cgColor: unsafeBitCast(cf, to: CGColor.self))
    }

    private static func lineHeight(font: NSFont?, paragraphStyle: NSParagraphStyle?) -> CGFloat? {
        if let paragraphStyle {
            if paragraphStyle.maximumLineHeight > 0 { return paragraphStyle.maximumLineHeight }
            if paragraphStyle.minimumLineHeight > 0 { return paragraphStyle.minimumLineHeight }
        }
        guard let font else { return nil }
        let natural = ceil(font.ascender - font.descender + font.leading)
        return natural > 0 ? natural : nil
    }

    private static func cgFloat(_ key: NSAttributedString.Key, from string: NSAttributedString) -> CGFloat? {
        let value = string.attribute(key, at: 0, effectiveRange: nil)
        if let value = value as? CGFloat { return value }
        if let value = value as? Double { return CGFloat(value) }
        if let value = value as? NSNumber { return CGFloat(truncating: value) }
        return nil
    }
}
