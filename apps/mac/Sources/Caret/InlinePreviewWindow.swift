import AppKit
import CoreText
import SwiftUI

/// The on-screen preview of a pending completion.
///
/// One reused panel. `show(_:)` and `hide()` both run to completion
/// synchronously on the main thread while the user is mid-keystroke in another
/// app, so neither one animates geometry or defers work.
@MainActor
final class InlinePreviewWindow {
    private let panel = InlinePreviewPanel()
    private let ghostView = InlineGhostTextView()
    private let cardHost: NSHostingView<InlineNearbyCard>

    init() {
        cardHost = NSHostingView(
            rootView: InlineNearbyCard(text: "", hint: "", fontSize: NSFont.systemFontSize)
        )
        cardHost.sizingOptions = [.intrinsicContentSize]
    }

    var isVisible: Bool { panel.isVisible }

    // MARK: - Presenting

    func show(_ presentation: InlinePreviewPresentation) {
        guard !presentation.text.isEmpty else {
            hide()
            return
        }

        let wasVisible = panel.isVisible

        // `.atCaret` can still fail here: the offer carried a caret rect, but
        // it may have no usable height by the time it is drawn. Falling through
        // to the labeled card is the honest outcome; drawing a continuation of
        // the user's line at a guessed position is not.
        let content: NSView
        let frame: CGRect
        let wantsShadow: Bool
        if presentation.placement == .atCaret, let ghostFrame = configureGhost(presentation) {
            content = ghostView
            frame = ghostFrame
            wantsShadow = false
        } else {
            content = cardHost
            frame = configureCard(presentation)
            wantsShadow = true
        }

        if panel.contentView !== content { panel.contentView = content }
        if panel.hasShadow != wantsShadow { panel.hasShadow = wantsShadow }
        content.frame = CGRect(origin: .zero, size: frame.size)

        // Position, size and text all change in place with no animation. This
        // call sits between two of the user's keystrokes: a rect that slides to
        // its new position reads as the app lagging behind the caret, not as
        // polish. `setFrame(_:display:)` is the non-animating overload.
        panel.setFrame(frame, display: true)
        if wantsShadow { panel.invalidateShadow() }

        if wasVisible {
            // Already on screen: no fade, no re-entrance. The offer is being
            // revised, not introduced.
            panel.alphaValue = 1
            panel.orderFrontRegardless()
            return
        }

        // First appearance of this offer. The text is at its final position and
        // size from the first frame; only alpha moves, and only for 90ms, which
        // covers the pop of unrequested text arriving under the cursor without
        // ever holding content back. Reduce Motion drops it entirely.
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        panel.alphaValue = reduceMotion ? 1 : 0
        // Never `makeKeyAndOrderFront`, never `activate`, never
        // `makeFirstResponder`. `orderFrontRegardless` is the ordering call
        // that does not activate: plain `orderFront(nil)` is a no-op for an
        // inactive app, and Caret is inactive the entire time this is on
        // screen, so it would show nothing at all.
        panel.orderFrontRegardless()

        guard !reduceMotion else { return }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = InlinePreviewMetrics.appearFadeDuration
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
        }
    }

    func hide() {
        guard panel.isVisible else { return }
        // Always instant. A fade-out leaves ghost text on screen after the user
        // has typed past it or pressed Escape, which reads as a suggestion that
        // will not go away.
        panel.orderOut(nil)
        // Replaces any in-flight appearance fade with a zero-duration one, so a
        // stale animation cannot drive alpha back down on the next show.
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0
            panel.animator().alphaValue = 1
        }
    }

    // MARK: - Layout

    /// Lays out ghost text so its first baseline lands on the caret's baseline
    /// and its left edge on `caretRect.maxX`. Returns the panel frame, or `nil`
    /// when the caret rect cannot support it.
    private func configureGhost(_ presentation: InlinePreviewPresentation) -> CGRect? {
        let caret = presentation.caretRect
        guard caret.height > 0, caret.origin.x.isFinite, caret.origin.y.isFinite else { return nil }

        // The presentation carries a point size but no family, so there is
        // nothing to match a monospaced host against. The system font is the
        // default rather than a guess that would be wrong in every
        // proportional field.
        let pointSize = presentation.fontPointSize ?? NSFont.systemFontSize
        let font = NSFont.systemFont(ofSize: min(max(pointSize, 6), 96))

        // Keep the offer inside the screen it starts on without moving it off
        // the caret: the width shrinks, the anchor does not.
        let screen = AXHelpers.screen(containing: CGPoint(x: caret.midX, y: caret.midY))
        let roomToRight = (screen?.visibleFrame.maxX).map { $0 - caret.maxX - InlinePreviewMetrics.edgeInset }
        let maxWidth = max(
            InlinePreviewMetrics.minGhostWidth,
            min(InlinePreviewMetrics.maxGhostWidth, roomToRight ?? InlinePreviewMetrics.maxGhostWidth)
        )

        guard let metrics = ghostView.configure(
            text: presentation.text,
            font: font,
            hint: presentation.acceptHint,
            maxWidth: maxWidth
        ) else { return nil }

        // The caret rect spans the host's line box, which can be taller than
        // ours when the host adds leading. Centre our line box inside the caret
        // rect before taking the baseline; when the two heights match this
        // reduces to "baseline sits one descender above the caret's foot".
        let slack = max(0, caret.height - (font.ascender - font.descender)) / 2
        let caretBaseline = caret.minY + slack - font.descender

        return CGRect(
            origin: CGPoint(x: caret.maxX, y: caretBaseline - metrics.firstBaselineFromBottom),
            size: metrics.size
        )
    }

    /// Fills and positions the labeled fallback card near the field.
    private func configureCard(_ presentation: InlinePreviewPresentation) -> CGRect {
        // The card is Caret's own surface, not the user's line, so it tracks
        // the host's size only within a range that stays readable. Matching an
        // 8pt field here would produce an unreadable card.
        let bodySize = presentation.fontPointSize.map { min(max($0, 11), 15) } ?? NSFont.systemFontSize
        cardHost.rootView = InlineNearbyCard(
            text: presentation.text,
            hint: presentation.acceptHint,
            fontSize: bodySize
        )
        let size = cardHost.fittingSize

        let anchor: CGRect? = presentation.fieldRect.isEmpty
            ? (presentation.caretRect.isEmpty ? nil : presentation.caretRect)
            : presentation.fieldRect
        let probe = anchor.map { CGPoint(x: $0.midX, y: $0.midY) } ?? NSEvent.mouseLocation
        let visible = (AXHelpers.screen(containing: probe) ?? NSScreen.main)?.visibleFrame
            ?? CGRect(origin: .zero, size: size)

        let gap = InlinePreviewMetrics.edgeInset
        let origin: CGPoint
        if let anchor {
            // Below the field when there is room, above it otherwise: the card
            // should not sit on top of the text it is describing.
            let below = anchor.minY - gap - size.height
            origin = below >= visible.minY
                ? CGPoint(x: anchor.minX, y: below)
                : CGPoint(x: anchor.minX, y: anchor.maxY + gap)
        } else {
            origin = CGPoint(x: visible.midX - size.width / 2, y: visible.minY + 64)
        }

        return AXHelpers.clamp(CGRect(origin: origin, size: size), to: visible)
    }
}

// MARK: - Panel

private final class InlinePreviewPanel: NSPanel {
    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 1, height: 1),
            styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        isReleasedWhenClosed = false
        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = true
        ignoresMouseEvents = true
        // AppKit's default window animations would fade and scale this panel on
        // every order-in and order-out. It sits under a caret the user is
        // typing at, so all of that is suppressed.
        animationBehavior = .none
    }

    // Belt and braces alongside `.nonactivatingPanel`: the user's keystrokes
    // must keep going to the app they are typing in.
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// MARK: - Ghost text

private struct InlineGhostMetrics {
    var size: CGSize
    /// Distance from the panel's bottom edge up to the first text baseline.
    var firstBaselineFromBottom: CGFloat
}

/// Draws the completion as text, not as a popup: no background, no border, no
/// shadow, positioned so it continues the user's own line.
///
/// CoreText rather than `NSAttributedString.draw`, because `CTLineDraw` takes
/// the baseline as its origin. Baseline alignment with the host's caret is the
/// entire point of this mode, and every other drawing API makes it an inference
/// from line-box geometry.
private final class InlineGhostTextView: NSView {
    private struct Layout {
        var lines: [CTLine]
        /// Per line, how far its baseline sits below the first line's.
        var baselineDrops: [CGFloat]
        var firstBaselineFromBottom: CGFloat
    }

    private var layout: Layout?
    private let hintHost = NSHostingView(rootView: InlineHintChip(label: "", fontSize: 10))
    private var measuredHint: (label: String, fontSize: CGFloat, size: CGSize)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        hintHost.sizingOptions = [.intrinsicContentSize]
        addSubview(hintHost)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("InlineGhostTextView is not loaded from a nib") }

    override var isFlipped: Bool { false }

    /// Typographic colour for ghost text.
    ///
    /// `secondaryLabelColor` is used on its own, with no extra opacity on top.
    /// Measured on this machine (macOS 26.5): `labelColor` is alpha 0.847,
    /// `secondaryLabelColor` 0.498 in Aqua and 0.549 in Dark Aqua,
    /// `tertiaryLabelColor` 0.26. So the semantic colour already lands in the
    /// 45–55% band the design calls for and reads at roughly 59% of the host's
    /// real text, while stacking another 0.5 on it would land near tertiary and
    /// fall below legibility. Using the semantic colour also means Increase
    /// Contrast and appearance switches are handled by AppKit.
    private let textColor = NSColor.secondaryLabelColor

    func configure(text: String, font: NSFont, hint: String, maxWidth: CGFloat) -> InlineGhostMetrics? {
        let chipFontSize = min(11, max(9, (font.pointSize * 0.75).rounded()))
        let chipSize = hint.isEmpty ? .zero : hintSize(label: hint, fontSize: chipFontSize)
        let reserve = hint.isEmpty ? 0 : chipSize.width + InlinePreviewMetrics.hintGap

        guard let text = Self.layoutText(
            text,
            font: font,
            width: max(InlinePreviewMetrics.minTextWidth, maxWidth - reserve),
            maxLines: InlinePreviewMetrics.maxGhostLines
        ) else { return nil }

        // Everything below is measured in points above the first baseline, so
        // the hint and the text can be combined without either one moving the
        // baseline the caller is about to align to the caret.
        let spread = text.baselineDrops.last ?? 0
        var contentTop = text.ascentFirst
        var contentBottom = -(spread + text.descentLast)

        var chipFrame = CGRect.zero
        if !hint.isEmpty {
            // Centred on the last line's cap band rather than its line box: the
            // chip reads as sitting on the same optical line as the letters
            // next to it. Placing it after the *last* line's advance, not after
            // the widest line, is what keeps it clear of the caret and of every
            // character of the ghost text.
            let chipCenter = -spread + font.capHeight / 2
            contentTop = max(contentTop, chipCenter + chipSize.height / 2)
            contentBottom = min(contentBottom, chipCenter - chipSize.height / 2)
            chipFrame = CGRect(
                x: (text.lastLineWidth + InlinePreviewMetrics.hintGap).rounded(),
                y: chipCenter - chipSize.height / 2,
                width: chipSize.width,
                height: chipSize.height
            )
        }

        // Round the baseline to a whole point so drawing inside the view is
        // stable; the fractional part of the caret's position is carried by the
        // panel origin instead, where it keeps the alignment exact.
        let baseline = (-contentBottom).rounded(.up)
        let height = contentTop.rounded(.up) + baseline
        let width = max(text.widestLineWidth, hint.isEmpty ? 0 : chipFrame.maxX).rounded(.up)

        hintHost.isHidden = hint.isEmpty
        if !hint.isEmpty {
            hintHost.rootView = InlineHintChip(label: hint, fontSize: chipFontSize)
            chipFrame.origin.y += baseline
            hintHost.frame = chipFrame
        }

        layout = Layout(
            lines: text.lines,
            baselineDrops: text.baselineDrops,
            firstBaselineFromBottom: baseline
        )
        needsDisplay = true

        return InlineGhostMetrics(
            size: CGSize(width: width, height: height),
            firstBaselineFromBottom: baseline
        )
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let layout, let context = NSGraphicsContext.current?.cgContext else { return }
        context.textMatrix = .identity
        // Resolved here rather than baked into the lines, so a light/dark
        // switch is picked up without relaying the text out.
        context.setFillColor(textColor.cgColor)
        for (index, line) in layout.lines.enumerated() {
            context.textPosition = CGPoint(x: 0, y: layout.firstBaselineFromBottom - layout.baselineDrops[index])
            CTLineDraw(line, context)
        }
    }

    /// SwiftUI measures the chip; the result is cached because the accept hint
    /// is the same string on almost every keystroke.
    private func hintSize(label: String, fontSize: CGFloat) -> CGSize {
        if let measuredHint, measuredHint.label == label, measuredHint.fontSize == fontSize {
            return measuredHint.size
        }
        hintHost.rootView = InlineHintChip(label: label, fontSize: fontSize)
        let size = hintHost.fittingSize
        measuredHint = (label, fontSize, size)
        return size
    }

    // MARK: Line breaking

    private struct TextLayout {
        var lines: [CTLine]
        var baselineDrops: [CGFloat]
        var ascentFirst: CGFloat
        var descentLast: CGFloat
        var widestLineWidth: CGFloat
        var lastLineWidth: CGFloat
    }

    private static func layoutText(_ text: String, font: NSFont, width: CGFloat, maxLines: Int) -> TextLayout? {
        guard !text.isEmpty, width > 1 else { return nil }

        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .paragraphStyle: paragraph,
            // Take the fill colour from the drawing context instead of baking a
            // resolved colour into the glyph runs.
            NSAttributedString.Key(kCTForegroundColorFromContextAttributeName as String): true,
        ]
        let attributed = NSAttributedString(string: text, attributes: attributes)

        let lineHeight = max(font.ascender - font.descender + font.leading, 1)
        let framesetter = CTFramesetterCreateWithAttributedString(attributed)
        let path = CGPath(
            rect: CGRect(x: 0, y: 0, width: width, height: lineHeight * CGFloat(maxLines + 2)),
            transform: nil
        )
        let frame = CTFramesetterCreateFrame(framesetter, CFRange(location: 0, length: 0), path, nil)
        guard let allLines = CTFrameGetLines(frame) as? [CTLine], !allLines.isEmpty else { return nil }

        var origins = [CGPoint](repeating: .zero, count: allLines.count)
        CTFrameGetLineOrigins(frame, CFRange(location: 0, length: 0), &origins)

        var lines = Array(allLines.prefix(maxLines))
        let keptOrigins = Array(origins.prefix(maxLines))

        // Whatever the kept lines did not consume is folded into an ellipsis on
        // the last one, so a long completion cannot paint down the screen.
        if let last = lines.last {
            let range = CTLineGetStringRange(last)
            let consumed = range.location + range.length
            if consumed < attributed.length {
                let tail = attributed.attributedSubstring(
                    from: NSRange(location: range.location, length: attributed.length - range.location)
                )
                let token = CTLineCreateWithAttributedString(
                    NSAttributedString(string: "\u{2026}", attributes: attributes)
                )
                if let truncated = CTLineCreateTruncatedLine(
                    CTLineCreateWithAttributedString(tail),
                    Double(width),
                    .end,
                    token
                ) {
                    lines[lines.count - 1] = truncated
                }
            }
        }

        var widest: CGFloat = 0
        var lastWidth: CGFloat = 0
        var ascentFirst: CGFloat = 0
        var descentLast: CGFloat = 0
        for (index, line) in lines.enumerated() {
            var ascent: CGFloat = 0
            var descent: CGFloat = 0
            var leading: CGFloat = 0
            let advance = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, &leading))
            widest = max(widest, advance)
            if index == 0 { ascentFirst = ascent }
            if index == lines.count - 1 {
                descentLast = descent
                lastWidth = advance
            }
        }

        return TextLayout(
            lines: lines,
            baselineDrops: keptOrigins.map { keptOrigins[0].y - $0.y },
            ascentFirst: ascentFirst,
            descentLast: descentLast,
            widestLineWidth: widest,
            lastLineWidth: lastWidth
        )
    }
}

// MARK: - SwiftUI pieces

/// The accept chord, in the same typographic token the pinned-action strip
/// already uses for chords: monospaced, medium, on a hairline-bordered
/// translucent capsule.
private struct InlineHintChip: View {
    let label: String
    let fontSize: CGFloat

    var body: some View {
        Text(label)
            .font(.system(size: fontSize, weight: .medium, design: .monospaced))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.horizontal, InlinePreviewMetrics.hintHorizontalPadding)
            .padding(.vertical, InlinePreviewMetrics.hintVerticalPadding)
            .background(Capsule(style: .continuous).fill(.ultraThinMaterial))
            .overlay {
                Capsule(style: .continuous)
                    .strokeBorder(
                        .primary.opacity(InlinePreviewMetrics.hairlineOpacity),
                        lineWidth: InlinePreviewMetrics.hairline
                    )
            }
    }
}

/// The `.nearbyFallback` card. Its first job is to say, in words, that this is
/// not inline text, so a bubble is never silently substituted for a completion
/// drawn at the caret.
private struct InlineNearbyCard: View {
    let text: String
    let hint: String
    let fontSize: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Suggestion")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                if !hint.isEmpty {
                    InlineHintChip(label: hint, fontSize: 10)
                }
            }
            Text(text)
                .font(.system(size: fontSize))
                .foregroundStyle(.primary)
                .lineLimit(InlinePreviewMetrics.maxGhostLines)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(InlineCaretGeometry.unsupportedCaretGeometryNote)
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(width: InlinePreviewMetrics.cardWidth, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: InlinePreviewMetrics.cardCornerRadius, style: .continuous)
                .fill(.ultraThinMaterial)
        }
        .overlay {
            RoundedRectangle(cornerRadius: InlinePreviewMetrics.cardCornerRadius, style: .continuous)
                .strokeBorder(
                    .primary.opacity(InlinePreviewMetrics.hairlineOpacity),
                    lineWidth: InlinePreviewMetrics.hairline
                )
        }
    }
}

// MARK: - Metrics

private enum InlinePreviewMetrics {
    /// A completion this long already spans a comfortable measure; past it the
    /// preview stops looking like the user's own line.
    static let maxGhostWidth: CGFloat = 420
    static let minGhostWidth: CGFloat = 160
    static let minTextWidth: CGFloat = 80
    static let maxGhostLines = 3
    static let hintGap: CGFloat = 6
    static let hintHorizontalPadding: CGFloat = 5
    static let hintVerticalPadding: CGFloat = 2
    static let edgeInset: CGFloat = 8

    /// Matches the skill picker panel in `CaretApp.swift`: 12pt continuous
    /// corners, ultra-thin material, 0.5pt border at 8% primary.
    static let cardWidth: CGFloat = 320
    static let cardCornerRadius: CGFloat = 12
    static let hairline: CGFloat = 0.5
    static let hairlineOpacity: Double = 0.08

    /// Opacity only, ease-out, first appearance only. Short enough to sit
    /// inside the gap between two keystrokes at a normal typing rate.
    static let appearFadeDuration: TimeInterval = 0.09
}
