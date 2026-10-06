import AppKit
import CaretHostCore
import SwiftUI

/// How a crop sets the source's text (v41 DIRECTION 2.2, 3.1): in the source's own type, not Caret's. A note or a mail
/// in SF 12.5/19, a tab in SF 12/17, what the user told Caret in SF 12.5/18 behind a quote rule, a PDF in a serif.
struct CropStyle: Equatable {
    var size: CGFloat
    var lineHeight: CGFloat
    var serif: Bool
    var top: CGFloat
    var leading: CGFloat
    var trailing: CGFloat
    /// Memory: a 2 pt Ink 3 rule at the left of the user's words.
    var quote: Bool

    static func of(kind: RowSource.Kind?, pdf: Bool) -> CropStyle {
        if pdf { return CropStyle(size: 11, lineHeight: 16, serif: true, top: 10, leading: 14, trailing: 14, quote: false) }
        switch kind {
        case .tab?: return CropStyle(size: 12, lineHeight: 17, serif: false, top: 8, leading: 12, trailing: 12, quote: false)
        case .memory?: return CropStyle(size: 12.5, lineHeight: 18, serif: false, top: 11, leading: 22, trailing: 12, quote: true)
        case .window?, .request?, nil: return CropStyle(size: 12.5, lineHeight: 19, serif: false, top: 9, leading: 12, trailing: 12, quote: false)
        }
    }

    var nsFont: NSFont {
        let base = NSFont.systemFont(ofSize: size)
        guard serif, let d = base.fontDescriptor.withDesign(.serif) else { return base }
        return NSFont(descriptor: d, size: size) ?? base
    }

    var font: Font { .system(size: size, design: serif ? .serif : .default) }
}

/// The source's text laid out at the crop's width by TextKit, line by line, so the views can set each line where TextKit
/// put it and mark a span exactly: SwiftUI's `Text` says nothing of where a phrase falls. Computed once per drawing.
struct CropLayout {
    struct Line: Equatable {
        var text: String
        /// The line's top in the drawing.
        var top: CGFloat
        /// The line's characters, UTF-16, in the excerpt's text.
        var range: NSRange
    }

    var style: CropStyle
    var width: CGFloat
    var lines: [Line]
    var height: CGFloat
    /// From a line's top to its baseline when SwiftUI centers one line in `lineHeight`.
    var baseline: CGFloat
    /// The glyph box SwiftUI sets a line in (ascender to descender), and the ascender within it.
    var box: CGFloat
    var ascender: CGFloat
    private var rectsByRange: [NSRange: [CGRect]]

    /// Lays `text` out at `width` and finds the rectangles of each of `spans` (UTF-16 ranges).
    init(text: String, spans: [NSRange], style: CropStyle, width: CGFloat) {
        self.style = style
        self.width = width
        let font = style.nsFont
        let para = NSMutableParagraphStyle()
        para.minimumLineHeight = style.lineHeight
        para.maximumLineHeight = style.lineHeight
        para.lineBreakMode = .byWordWrapping
        let storage = NSTextStorage(string: text, attributes: [.font: font, .paragraphStyle: para])
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: max(1, width - style.leading - style.trailing), height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        manager.ensureLayout(for: container)

        var lines: [Line] = []
        let ns = text as NSString
        manager.enumerateLineFragments(forGlyphRange: NSRange(location: 0, length: manager.numberOfGlyphs)) { rect, _, _, glyphs, _ in
            let chars = manager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
            let s = ns.substring(with: chars).trimmingCharacters(in: .newlines)
            lines.append(Line(text: s, top: style.top + rect.minY, range: chars))
        }
        // An empty trailing line (text ending in "\n") has no fragment; nothing is drawn there anyway.
        self.lines = lines
        let used = manager.usedRect(for: container)
        height = style.top + used.height + style.top
        box = ceil(font.ascender - font.descender)
        ascender = font.ascender
        baseline = (style.lineHeight - box) / 2 + font.ascender

        var rects: [NSRange: [CGRect]] = [:]
        for span in spans where NSMaxRange(span) <= ns.length && span.length > 0 {
            let glyphs = manager.glyphRange(forCharacterRange: span, actualCharacterRange: nil)
            var found: [CGRect] = []
            manager.enumerateEnclosingRects(forGlyphRange: glyphs, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0), in: container) { r, _ in
                found.append(CGRect(x: style.leading + r.minX, y: style.top + r.minY, width: r.width, height: style.lineHeight))
            }
            rects[span] = found
        }
        rectsByRange = rects
    }

    /// The span's rectangles, one per line it covers, in the drawing (each a whole line tall).
    func rects(_ span: NSRange) -> [CGRect] { rectsByRange[span] ?? [] }

    /// The line the span starts on.
    func line(of span: NSRange) -> Int? { lines.lastIndex { $0.range.location <= span.location } }

    /// The window's pan to show the span (`PageTaskLook.pan`).
    func pan(to span: NSRange, window: CGFloat) -> CGFloat {
        guard let i = line(of: span) else { return 0 }
        // Panned to a line, that line keeps the drawing's top padding above it, as the first line does unpanned.
        return PageTaskLook.pan(lineTops: lines.map { $0.top - style.top }, spanLine: i, drawingHeight: height, window: window)
    }
}

extension SourceExcerpt {
    /// The span as an `NSRange` (UTF-16), as TextKit counts.
    var nsSpan: NSRange { NSRange(location: start, length: end - start) }
}
