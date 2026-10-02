import AppKit
import CaretHostCore
import CompletionUI
import QuartzCore
import SwiftUI

/// What a fill looks like on screen (`SURFACES.md` sections 3, 5 and 6; tokens from `IDENTITY.md`).
///
/// - The value sits in the empty field itself, in the field's font at Ghost opacity.
/// - The source is named once, in an offer line by the field's right edge, with the figure and a
///   Tab keycap. `LinePlacement` picks above, below or a compact line, whichever covers nothing.
/// - After Tab the same line, in place, becomes the result toast with ⌘Z Undo.
/// - One line at a time: while a toast lives, the next field's line waits or replaces it
///   (`FillLineRule`).
///
/// Every panel is borderless, non-activating and click-through, and never becomes key, so the
/// form keeps focus and the user's keys keep going to it.
@MainActor
final class FillOverlay {
    enum ToastKind: String {
        case done, undone, error
    }

    private enum Role { case offer, toast }

    private struct LineState {
        let panel: HostedPanel
        var role: Role
        var choice: LinePlacement.Choice
        /// The field the line describes, Accessibility frame.
        var field: CGRect
        /// The offer's source caption; for a toast, the source of the fill it reports.
        var source: String
    }

    private struct Deferred {
        let caption: String
        let field: CGRect
        let pid: pid_t
    }

    private let ghost = OverlayPanel.make()
    private let ghostLabel = NSTextField(labelWithString: "")
    private var line: LineState?
    private var deferred: Deferred?
    private var toastTimer: Timer?
    private var character: FigureCharacter { FigureSettings.shared.character }

    var isShowingOffer: Bool { line?.role == .offer }
    var isShowingToast: Bool { line?.role == .toast }
    /// Called after every change of what is shown, including the toast's own timeout.
    var onChange: (() -> Void)?

    init() {
        ghostLabel.lineBreakMode = .byClipping
        ghostLabel.maximumNumberOfLines = 1
        ghost.contentView?.addSubview(ghostLabel)
    }

    func debugInfo() -> DebugState.Overlay {
        let lineInfo = line.flatMap { $0.panel.debugInfo() }
        var overlay = DebugState.Overlay(
            ghost: ghost.isVisible ? Self.panel(ghost, text: ghostLabel.stringValue) : nil,
            line: line?.role == .offer ? lineInfo : nil,
            toast: line?.role == .toast ? lineInfo : nil
        )
        overlay.placement = line.map { "\($0.choice.side.rawValue)\($0.choice.compact ? ",compact" : "")" }
        overlay.lineDeferred = deferred != nil
        return overlay
    }

    private static func panel(_ window: NSWindow, text: String?) -> DebugState.Panel {
        let f = window.frame
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        return DebugState.Panel(
            windowNumber: window.windowNumber,
            frame: [f.minX, primaryHeight - f.maxY, f.width, f.height].map { Double($0) },
            isKey: window.isKeyWindow,
            text: text
        )
    }

    // MARK: - Offer

    /// Draws the value in the field and names its source. Returns what happened to a toast that
    /// was still up; on `.replaceToast` the caller drops the toast's undo grant.
    @discardableResult
    func showOffer(
        value: String, fieldFrame: CGRect, style: OverlayTextStyle, caption: String, pid: pid_t, hasPlaceholder: Bool = false
    ) -> FillLineRule.Outcome {
        drawGhost(value: value, fieldFrame: fieldFrame, style: style, masksPlaceholder: hasPlaceholder)
        let toastSource = line?.role == .toast ? line?.source : nil
        let outcome = FillLineRule.resolve(toastSource: toastSource, offerSource: caption)
        switch outcome {
        case .deferLine:
            deferred = Deferred(caption: caption, field: fieldFrame, pid: pid)
        case .replaceToast:
            endToast(exit: 0.10)
            showLine(caption: caption, field: fieldFrame, pid: pid)
        case .showLine:
            showLine(caption: caption, field: fieldFrame, pid: pid)
        }
        onChange?()
        return outcome
    }

    /// `masksPlaceholder`: the field shows placeholder text where the value goes, and the two
    /// overlapped into an unreadable smear (A3 run, Phone: "+1 (512) 555-0142" over
    /// "(555) 555-5555"). The ghost then sits on the system text background, which hides the
    /// placeholder; an AppKit field's background is that color. Untested on fields drawn with
    /// another background.
    private func drawGhost(value: String, fieldFrame: CGRect, style: OverlayTextStyle, masksPlaceholder: Bool) {
        let frame = Screen.cocoa(fieldFrame)
        let font = style.font ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)
        let isDark = ghost.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        let ink = (style.textColor ?? .labelColor).withAlphaComponent(isDark ? 0.50 : 0.45)
        ghostLabel.attributedStringValue = NSAttributedString(string: value, attributes: [.font: font, .foregroundColor: ink])
        // NSTextField's bezel and cell padding put the first glyph about 4 pt in; the field's own
        // inset is not exposed through Accessibility.
        let textHeight = ceil(font.ascender - font.descender + font.leading)
        let inset: CGFloat = 4
        ghost.setFrame(frame.insetBy(dx: inset, dy: 0), display: false)
        ghostLabel.frame = NSRect(x: 0, y: (frame.height - textHeight) / 2, width: frame.width - inset * 2, height: textHeight)
        ghostLabel.drawsBackground = masksPlaceholder
        ghostLabel.backgroundColor = .textBackgroundColor
        // 0 to Ghost opacity over 60 ms, linear: below perception as motion, it only removes flicker.
        ghost.alphaValue = 0
        ghost.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.06
            context.timingFunction = CAMediaTimingFunction(name: .linear)
            ghost.animator().alphaValue = 1
        }
    }

    private func showLine(caption: String, field: CGRect, pid: pid_t) {
        deferred = nil
        let content = LineContent(figure: .offering, text: caption, emphasis: .secondary, hints: [Hint(key: "Tab")])
        if var current = line, current.role == .offer, current.field == field, current.source == caption {
            current.panel.text = caption + " Tab"
            line = current
            return
        }
        line.map { $0.panel.exit(duration: 0) }
        let panel = HostedPanel(radius: 8)
        let choice = place(panel, content: content, field: field, pid: pid)
        panel.text = caption + " Tab"
        line = LineState(panel: panel, role: .offer, choice: choice, field: field, source: caption)
        panel.enter()
    }

    /// Measures both sizes, asks the app what each candidate spot would cover, and pins the panel
    /// at the chosen spot's corner nearest the field.
    @discardableResult
    private func place(_ panel: HostedPanel, content: LineContent, field: CGRect, pid: pid_t) -> LinePlacement.Choice {
        let standard = panel.measure(LineView(content: content, character: character))
        let compact = panel.measure(LineView(content: content, character: character, compact: true))
        let bounds = Screen.axVisibleFrame(around: field)
        let spots = LinePlacement.candidates(field: field, width: standard.width, compactWidth: compact.width, bounds: bounds).map(\.0)
        let obstacles = ObstacleProbe.obstacles(pid: pid, under: spots)
        let choice = LinePlacement.choose(field: field, width: standard.width, compactWidth: compact.width, obstacles: obstacles, bounds: bounds)
        let frame = Screen.cocoa(choice.frame)
        // Above the field: pin the bottom right; below it: the top right.
        panel.pin(HostedPanel.Anchor(
            corner: choice.side == .above ? .bottomRight : .topRight,
            point: NSPoint(x: frame.maxX, y: choice.side == .above ? frame.minY : frame.maxY)
        ))
        panel.setContent(LineView(content: content, character: character, compact: choice.compact))
        return choice
    }

    /// Tab was taken: the real text is on its way, so the ghost goes; the line stays for the result.
    func markWorking() {
        ghost.orderOut(nil)
        deferred = nil
        onChange?()
    }

    func hideOffer(byTyping: Bool) {
        ghost.orderOut(nil)
        deferred = nil
        if let current = line, current.role == .offer {
            current.panel.exit(duration: byTyping ? 0.08 : 0.10)
            line = nil
        }
        onChange?()
    }

    // MARK: - Toast

    /// Turns the offer line into the result toast where it stands. A line already reporting an
    /// earlier field gives way to one at this field.
    func showToast(
        _ kind: ToastKind, lead: String?, text: String, keycap: Hint?, lifetime: TimeInterval,
        field: CGRect?, pid: pid_t, source: String
    ) {
        ghost.orderOut(nil)
        toastTimer?.invalidate()
        let content = LineContent(
            figure: kind == .error ? .error : .done, lead: lead, text: text, emphasis: .plain,
            hints: keycap.map { [$0] } ?? []
        )
        if var current = line, current.role == .offer || field == nil || current.field == field {
            current.panel.setContent(LineView(content: content, character: character, compact: current.choice.compact))
            current.panel.text = [lead, text, keycap.map { "\($0.key) \($0.label ?? "")" }].compactMap { $0 }.joined(separator: " ")
            current.role = .toast
            current.source = source
            line = current
        } else if let field {
            line.map { $0.panel.exit(duration: 0) }
            let panel = HostedPanel(radius: 8)
            let choice = place(panel, content: content, field: field, pid: pid)
            panel.text = [lead, text].compactMap { $0 }.joined(separator: " ")
            line = LineState(panel: panel, role: .toast, choice: choice, field: field, source: source)
            panel.enter()
        }
        toastTimer = Timer.scheduledTimer(withTimeInterval: lifetime, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.hideToast(byTyping: false) }
        }
        onChange?()
    }

    /// Typing: 80 ms. Timeout: 200 ms. A waiting offer line takes the stage after it.
    func hideToast(byTyping: Bool) {
        endToast(exit: byTyping ? 0.08 : 0.20)
        if let waiting = deferred, ghost.isVisible {
            showLine(caption: waiting.caption, field: waiting.field, pid: waiting.pid)
        }
        onChange?()
    }

    private func endToast(exit duration: TimeInterval) {
        toastTimer?.invalidate()
        toastTimer = nil
        guard let current = line, current.role == .toast else { return }
        current.panel.exit(duration: duration)
        line = nil
    }

    func hideAll() {
        hideOffer(byTyping: false)
        endToast(exit: 0)
        deferred = nil
        onChange?()
    }
}
