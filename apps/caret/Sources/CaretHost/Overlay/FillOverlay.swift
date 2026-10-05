import AppKit
import CaretHostCore
import CompletionUI
import QuartzCore
import SwiftUI

/// What a fill looks like on screen (v3 DIRECTION.md section 5.5).
///
/// - The value sits in the empty field itself, in the field's font at Ghost opacity.
/// - The source is named once, in a slip right-aligned 6 pt above the field: the figure looking
///   down at the field, the source app's glyph, "from Mail, Invoice 2041" and `Tab Fill`.
///   `LinePlacement` picks above, below or a compact slip, whichever covers nothing. `⌘1 Fill all`
///   follows when the helper fills the form in one run (`FillOrigin.fillAll`, D2-04).
/// - After Tab the field flashes the Carrot wash for 400 ms and the same slip, in place, becomes
///   the result with ⌘Z Undo. The next field's slip is the same panel, moved there over 140 ms.
/// - One slip at a time: while a result lives, the next field's slip waits or replaces it
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
        let sourceApp: String?
        let fillAll: Bool
        let field: CGRect
        let pid: pid_t
    }

    private let ghost = OverlayPanel.make()
    private let ghostLabel = NSTextField(labelWithString: "")
    private let wash = HostedPanel(radius: 0, material: false)
    private var line: LineState?
    /// What was last announced for the slip, so a redraw with the same words says nothing.
    private var announced: String?
    private var deferred: Deferred?
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

    /// Draws the value in the field and names its source. `outcome` is `FillMachine`'s decision
    /// about a toast still up (`FillLineRule`): wait behind it, replace it, or nothing in the way.
    func showOffer(
        value: String, fieldFrame: CGRect, style: OverlayTextStyle, caption: String, sourceApp: String? = nil, fillAll: Bool = false, pid: pid_t,
        outcome: FillLineRule.Outcome, hasPlaceholder: Bool = false
    ) {
        drawGhost(value: value, fieldFrame: fieldFrame, style: style, masksPlaceholder: hasPlaceholder)
        switch outcome {
        case .deferLine:
            deferred = Deferred(caption: caption, sourceApp: sourceApp, fillAll: fillAll, field: fieldFrame, pid: pid)
        case .replaceToast, .showLine:
            // A result still up gives its panel to the next field's slip, which moves there.
            showLine(caption: caption, sourceApp: sourceApp, fillAll: fillAll, field: fieldFrame, pid: pid)
        }
        onChange?()
    }

    /// The source slip's content.
    static func offerContent(caption: String, sourceApp: String?, fillAll: Bool = false) -> LineContent {
        let hints = [Hint(key: "Tab", label: "Fill")] + (fillAll ? [Hint(key: "⌘1", label: "Fill all")] : [])
        return LineContent(figure: .offering, app: sourceApp, text: caption, emphasis: .secondary, hints: hints)
    }

    /// The figure in the fill slip looks down at the field it would fill.
    static let lookAtField = CGVector(dx: 0, dy: 1)

    /// `masksPlaceholder`: the field shows placeholder text where the value goes, and the two
    /// overlapped into an unreadable smear (A3 run, Phone: "+1 (512) 555-0142" over
    /// "(555) 555-5555"). The ghost then sits on the system text background, which hides the
    /// placeholder; an AppKit field's background is that color. Untested on fields drawn with
    /// another background.
    private func drawGhost(value: String, fieldFrame: CGRect, style: OverlayTextStyle, masksPlaceholder: Bool) {
        let frame = Screen.cocoa(fieldFrame)
        let font = style.font ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)
        // The field's theme, not Caret's: an app can run light while the system runs dark. Read
        // it from the field's own text color when the probe found one.
        let isDark = style.textColor.map(Self.isLight) ?? (ghost.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua)
        let ink = (style.textColor ?? .labelColor).withAlphaComponent(Tokens.ghostOpacity(dark: isDark))
        var mask = NSColor.textBackgroundColor
        NSAppearance(named: isDark ? .darkAqua : .aqua)?.performAsCurrentDrawingAppearance {
            mask = NSColor.textBackgroundColor.usingColorSpace(.sRGB) ?? mask
        }
        ghostLabel.attributedStringValue = NSAttributedString(string: value, attributes: [.font: font, .foregroundColor: ink])
        // NSTextField's bezel and cell padding put the first glyph about 4 pt in; the field's own
        // inset is not exposed through Accessibility.
        let textHeight = ceil(font.ascender - font.descender + font.leading)
        let inset: CGFloat = 4
        ghost.setFrame(frame.insetBy(dx: inset, dy: 0), display: false)
        ghostLabel.frame = NSRect(x: 0, y: (frame.height - textHeight) / 2, width: frame.width - inset * 2, height: textHeight)
        ghostLabel.drawsBackground = masksPlaceholder
        ghostLabel.backgroundColor = mask
        // 0 to Ghost opacity over 60 ms, linear: below perception as motion, it only removes flicker.
        ghost.alphaValue = 0
        ghost.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.06
            context.timingFunction = CAMediaTimingFunction(name: .linear)
            ghost.animator().alphaValue = 1
        }
    }

    /// Light text means a dark field.
    static func isLight(_ color: NSColor) -> Bool {
        guard let c = color.usingColorSpace(.sRGB) else { return false }
        return 0.2126 * c.redComponent + 0.7152 * c.greenComponent + 0.0722 * c.blueComponent > 0.5
    }

    private func showLine(caption: String, sourceApp: String?, fillAll: Bool = false, field: CGRect, pid: pid_t) {
        deferred = nil
        let content = Self.offerContent(caption: caption, sourceApp: sourceApp, fillAll: fillAll)
        if var current = line, current.role == .offer, current.field == field, current.source == caption {
            current.panel.text = caption + " Tab Fill"
            line = current
            return
        }
        if var current = line {
            // The slip moves to this field rather than leave and re-enter.
            let choice = place(current.panel, content: content, field: field, pid: pid, moving: true)
            current.panel.text = caption + " Tab Fill"
            current.role = .offer
            current.choice = choice
            current.field = field
            current.source = caption
            line = current
            announce(content)
            return
        }
        let panel = HostedPanel(radius: Tokens.Shape.slipRadius)
        let choice = place(panel, content: content, field: field, pid: pid, moving: false)
        panel.text = caption + " Tab Fill"
        line = LineState(panel: panel, role: .offer, choice: choice, field: field, source: caption)
        panel.enter()
        announce(content)
    }

    private func view(_ content: LineContent, compact: Bool) -> LineView {
        LineView(content: content, character: character, compact: compact, figureGaze: content.figure == .offering ? Self.lookAtField : nil)
    }

    /// Measures both sizes, asks the app what each candidate spot would cover, and pins the panel
    /// at the chosen spot's corner nearest the field; `moving` slides a panel already on screen
    /// there over 140 ms (at once under Reduce Motion).
    @discardableResult
    private func place(_ panel: HostedPanel, content: LineContent, field: CGRect, pid: pid_t, moving: Bool) -> LinePlacement.Choice {
        let standard = panel.measure(view(content, compact: false))
        let compact = panel.measure(view(content, compact: true))
        let bounds = Screen.axVisibleFrame(around: field)
        let spots = LinePlacement.candidates(field: field, width: standard.width, compactWidth: compact.width, bounds: bounds).map(\.0)
        // Hit-testing stops at the budget the other surfaces use, so a hung app cannot hold the main
        // thread for seconds at 50 ms a point (CodeRabbit on PR #9).
        let probe = ObstacleProbe.Session(pid: pid, until: DispatchTime.now().uptimeNanoseconds + SurfaceCoordinator.probeBudget)
        let obstacles = LinePlacement.obstacles(over: spots, probe: { probe.under([$0]) })
        let choice = LinePlacement.choose(field: field, width: standard.width, compactWidth: compact.width, obstacles: obstacles, bounds: bounds)
        let frame = Screen.cocoa(choice.frame)
        // Above the field: pin the bottom right; below it: the top right.
        let anchor = HostedPanel.Anchor(
            corner: choice.side == .above ? .bottomRight : .topRight,
            point: NSPoint(x: frame.maxX, y: choice.side == .above ? frame.minY : frame.maxY)
        )
        panel.radius = choice.compact ? Tokens.Shape.compactRadius : Tokens.Shape.slipRadius
        panel.setContent(view(content, compact: choice.compact))
        if moving, panel.isVisible {
            panel.move(to: anchor, duration: Motion.Duration.move)
        } else {
            panel.pin(anchor)
        }
        return choice
    }

    private func announce(_ content: LineContent) {
        guard let words = SlipAnnouncer.next(SlipSpeech.line(content), last: announced) else { return }
        announced = words
        SlipAnnouncer.post(words)
    }

    /// The field just filled flashes the Carrot wash and fades to its own background over 400 ms,
    /// so the change is seen where it happened. Dropped under Reduce Motion.
    private func flashWash(_ field: CGRect) {
        guard !Motion.reduceMotion else { return }
        wash.pin(HostedPanel.Anchor(corner: .topLeft, point: NSPoint(x: field.minX, y: Screen.cocoa(field).maxY)))
        wash.setContent(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(Color(token: Tokens.carrotWash))
            .frame(width: field.width, height: field.height))
        wash.text = "wash"
        wash.panel.alphaValue = 1
        wash.panel.orderFrontRegardless()
        wash.exit(duration: Motion.Duration.wash)
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
            current.panel.exit(duration: byTyping ? Motion.Duration.typed : Motion.Duration.fade)
            line = nil
            announced = nil
        }
        onChange?()
    }

    // MARK: - Toast

    /// Turns the offer line into the result toast where it stands. A line already reporting an
    /// earlier field gives way to one at this field. `FillMachine` ends it (`hideToast`).
    func showToast(
        _ kind: ToastKind, lead: String?, text: String, keycap: Hint?,
        field: CGRect?, pid: pid_t, source: String
    ) {
        ghost.orderOut(nil)
        let content = LineContent(
            figure: kind == .error ? .error : kind == .undone ? .still : .done, lead: lead, text: text, emphasis: .plain,
            hints: keycap.map { [$0] } ?? []
        )
        if kind == .done, let field { flashWash(field) }
        if var current = line, current.role == .offer || field == nil || current.field == field {
            current.panel.setContent(view(content, compact: current.choice.compact))
            current.panel.text = [lead, text, keycap.map { "\($0.key) \($0.label ?? "")" }].compactMap { $0 }.joined(separator: " ")
            current.role = .toast
            current.source = source
            line = current
        } else if let field {
            line.map { $0.panel.exit(duration: 0) }
            let panel = HostedPanel(radius: Tokens.Shape.slipRadius)
            let choice = place(panel, content: content, field: field, pid: pid, moving: false)
            panel.text = [lead, text].compactMap { $0 }.joined(separator: " ")
            line = LineState(panel: panel, role: .toast, choice: choice, field: field, source: source)
            panel.enter()
        }
        announce(content)
        onChange?()
    }

    /// Typing: 80 ms. Timeout: 220 ms. A slip waiting behind it takes its panel and moves there,
    /// rather than the result fading while a new slip enters.
    func hideToast(byTyping: Bool) {
        if let waiting = deferred, ghost.isVisible, line?.role == .toast {
            showLine(caption: waiting.caption, sourceApp: waiting.sourceApp, fillAll: waiting.fillAll, field: waiting.field, pid: waiting.pid)
        } else {
            endToast(exit: byTyping ? Motion.Duration.typed : Motion.Duration.toastExit)
        }
        onChange?()
    }

    private func endToast(exit duration: TimeInterval) {
        guard let current = line, current.role == .toast else { return }
        current.panel.exit(duration: duration)
        line = nil
        announced = nil
    }

    func hideAll() {
        hideOffer(byTyping: false)
        endToast(exit: 0)
        deferred = nil
        onChange?()
    }
}
