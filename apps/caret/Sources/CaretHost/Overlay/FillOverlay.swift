import AppKit
import CompletionUI
import QuartzCore

/// What a fill looks like on screen (`SURFACES.md` sections 3, 5 and 6; tokens from `IDENTITY.md`).
///
/// - The value sits in the empty field itself, in the field's font at Ghost opacity.
/// - The source is named once, in an offer line 6 pt above the field's top right corner, with the
///   figure and a Tab keycap.
/// - After Tab the same line, in place, becomes the result toast with ⌘Z Undo.
///
/// Every panel is borderless, non-activating and click-through, and never becomes key, so the
/// form keeps focus and the user's keys keep going to it.
@MainActor
final class FillOverlay {
    enum ToastKind: String {
        case done, undone, error
    }

    private let ghost = OverlayPanel.make()
    private let ghostLabel = NSTextField(labelWithString: "")
    private var offerLine: OfferLine?
    private var toastLine: OfferLine?
    private var toastTimer: Timer?

    var isShowingOffer: Bool { offerLine != nil }
    var isShowingToast: Bool { toastLine != nil }

    init() {
        ghostLabel.lineBreakMode = .byClipping
        ghostLabel.maximumNumberOfLines = 1
        ghost.contentView?.addSubview(ghostLabel)
    }

    /// `fieldFrame` is the field's Accessibility frame: global points, top-left origin.
    func showOffer(value: String, fieldFrame: CGRect, style: OverlayTextStyle, caption: String) {
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
        Motion.fadeIn(ghost, duration: 0.06, timing: CAMediaTimingFunction(name: .linear))

        let line = offerLine ?? OfferLine()
        line.setContent(figure: .offering, lead: nil, text: caption, keycap: "Tab", secondary: true)
        line.place(aboveRightOf: frame)
        if offerLine == nil { line.enter() }
        offerLine = line
    }

    /// Tab was taken: the real text is on its way, so the ghost goes; the line stays for the result.
    func markWorking() {
        ghost.orderOut(nil)
    }

    func hideOffer(byTyping: Bool) {
        ghost.orderOut(nil)
        offerLine?.exit(duration: byTyping ? 0.08 : 0.10)
        offerLine = nil
    }

    /// Turns the offer line into the result toast where it stands, or shows a toast at `anchor` if
    /// the offer line is already gone.
    func showToast(_ kind: ToastKind, lead: String?, text: String, keycap: String?, lifetime: TimeInterval, anchor: CGRect?) {
        ghost.orderOut(nil)
        toastTimer?.invalidate()
        let line: OfferLine
        if let offerLine {
            line = offerLine
            self.offerLine = nil
        } else if let toastLine {
            line = toastLine
        } else {
            line = OfferLine()
            if let anchor { line.place(aboveRightOf: Screen.cocoa(anchor)) }
            line.enter()
        }
        if let old = toastLine, old !== line { old.exit(duration: 0) }
        line.setContent(figure: kind == .error ? .error : .done, lead: lead, text: text, keycap: keycap, secondary: false)
        toastLine = line
        toastTimer = Timer.scheduledTimer(withTimeInterval: lifetime, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.hideToast(byTyping: false) }
        }
    }

    func hideToast(byTyping: Bool) {
        toastTimer?.invalidate()
        toastTimer = nil
        toastLine?.exit(duration: byTyping ? 0.08 : 0.20)
        toastLine = nil
    }

    func hideAll() {
        hideOffer(byTyping: false)
        hideToast(byTyping: false)
    }
}

// MARK: - Offer line

/// One offer line: figure, optional Carrot lead word, text, optional keycap. 28 pt tall, radius 8.
@MainActor
private final class OfferLine {
    let panel = OverlayPanel.make()
    private let surface = NSVisualEffectView()
    private let figure = FigureView()
    private let label = NSTextField(labelWithString: "")
    private let keycap = Keycap()

    init() {
        surface.material = .popover
        surface.blendingMode = .behindWindow
        surface.state = .active
        surface.wantsLayer = true
        surface.layer?.cornerRadius = 8
        surface.layer?.masksToBounds = true
        surface.layer?.borderWidth = 1
        panel.contentView = surface
        panel.hasShadow = true
        label.lineBreakMode = .byTruncatingTail
        for view in [figure, label, keycap] as [NSView] { surface.addSubview(view) }
    }

    func setContent(figure state: FigureView.State, lead: String?, text: String, keycap cap: String?, secondary: Bool) {
        let isDark = panel.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        surface.layer?.borderColor = (isDark ? NSColor(white: 1, alpha: 0.10) : NSColor(white: 0, alpha: 0.08)).cgColor
        figure.state = state
        let body = NSMutableAttributedString()
        if let lead {
            body.append(NSAttributedString(string: lead + " ", attributes: [
                .font: NSFont.systemFont(ofSize: 13, weight: .semibold), .foregroundColor: Tokens.carrotText,
            ]))
        }
        body.append(NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: 13),
            .foregroundColor: secondary ? NSColor.secondaryLabelColor : NSColor.labelColor,
        ]))
        label.attributedStringValue = body
        keycap.isHidden = cap == nil
        keycap.text = cap ?? ""
        layout()
    }

    /// Right edge on the field's right edge, bottom 6 pt above the field's top (Cocoa coordinates).
    func place(aboveRightOf field: NSRect) {
        let size = panel.frame.size
        var origin = NSPoint(x: field.maxX - size.width, y: field.maxY + 6)
        if let screen = Screen.containing(field) {
            let bounds = screen.visibleFrame.insetBy(dx: 8, dy: 8)
            origin.x = min(max(origin.x, bounds.minX), bounds.maxX - size.width)
            // No room above: flip below the field.
            if origin.y + size.height > bounds.maxY { origin.y = field.minY - 6 - size.height }
        }
        panel.setFrameOrigin(origin)
        anchorRight = origin.x + size.width
        anchorTop = origin.y
    }

    private var anchorRight: CGFloat?
    private var anchorTop: CGFloat?

    private func layout() {
        let height: CGFloat = 28
        let figureSize = FigureView.size
        let labelSize = label.attributedStringValue.size()
        var x: CGFloat = 9
        figure.frame = NSRect(x: x, y: (height - figureSize.height) / 2, width: figureSize.width, height: figureSize.height)
        x += figureSize.width + 8
        let labelWidth = min(ceil(labelSize.width) + 2, 320)
        label.frame = NSRect(x: x, y: (height - 16) / 2, width: labelWidth, height: 16)
        x += labelWidth
        if !keycap.isHidden {
            x += 12
            let capWidth = keycap.fittingWidth
            keycap.frame = NSRect(x: x, y: (height - 16) / 2, width: capWidth, height: 16)
            x += capWidth
        }
        x += 10
        let old = panel.frame
        // Keep the right edge where it was, so a toast that is longer or shorter than the offer
        // does not jump away from the field it describes.
        let right = anchorRight ?? old.maxX
        panel.setFrame(NSRect(x: right - x, y: anchorTop ?? old.minY, width: x, height: height), display: true)
    }

    func enter() {
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        Motion.offerLineEnter(panel, view: surface)
    }

    func exit(duration: TimeInterval) {
        Motion.fadeOut(panel, duration: duration)
    }
}

// MARK: - Pieces

/// A borderless, non-activating, click-through panel that never becomes key.
private final class OverlayPanel: NSPanel {
    static func make() -> OverlayPanel {
        let panel = OverlayPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .transient, .ignoresCycle, .fullScreenAuxiliary]
        panel.contentView = NSView()
        return panel
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class Keycap: NSView {
    private let label = NSTextField(labelWithString: "")
    var text: String {
        get { label.stringValue }
        set {
            label.attributedStringValue = NSAttributedString(string: newValue, attributes: [
                .font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor,
            ])
            needsLayout = true
        }
    }

    var fittingWidth: CGFloat { ceil(label.attributedStringValue.size().width) + 12 }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 4
        layer?.borderWidth = 1
        addSubview(label)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layout() {
        super.layout()
        let isDark = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        layer?.borderColor = (isDark ? NSColor(white: 1, alpha: 0.16) : NSColor(white: 0, alpha: 0.12)).cgColor
        label.frame = NSRect(x: 5, y: 1, width: bounds.width - 10, height: 14)
    }
}

/// The pebble (`IDENTITY.md`): a soft bun with two eyes, Carrot body, no mouth.
private final class FigureView: NSView {
    enum State { case offering, done, error }
    static let size = NSSize(width: 12, height: 10)

    var state: State = .offering { didSet { needsDisplay = true } }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        // viewBox 0 0 12 10, drawn 1:1.
        let body = NSBezierPath()
        body.move(to: NSPoint(x: 6, y: 0.7))
        body.curve(to: NSPoint(x: 11.6, y: 5.6), controlPoint1: NSPoint(x: 9.5, y: 0.7), controlPoint2: NSPoint(x: 11.6, y: 2.7))
        body.curve(to: NSPoint(x: 6, y: 9.6), controlPoint1: NSPoint(x: 11.6, y: 8.3), controlPoint2: NSPoint(x: 9.3, y: 9.6))
        body.curve(to: NSPoint(x: 0.4, y: 5.6), controlPoint1: NSPoint(x: 2.7, y: 9.6), controlPoint2: NSPoint(x: 0.4, y: 8.3))
        body.curve(to: NSPoint(x: 6, y: 0.7), controlPoint1: NSPoint(x: 0.4, y: 2.7), controlPoint2: NSPoint(x: 2.5, y: 0.7))
        body.close()
        (state == .error ? NSColor.systemGray : Tokens.carrot).setFill()
        body.fill()

        // Offering: the eyes glance 1.1 px toward the field, which is below and to the right of the
        // line's left end. Error: they look down.
        let dx: CGFloat = state == .offering ? 1.1 : 0
        let dy: CGFloat = state == .error ? 0.8 : (state == .offering ? 0.4 : 0)
        Tokens.eye.setFill()
        for cx in [4.1, 7.9] as [CGFloat] {
            NSBezierPath(ovalIn: NSRect(x: cx + dx - 0.95, y: 4.9 + dy - 0.95, width: 1.9, height: 1.9)).fill()
        }
    }
}

private enum Tokens {
    static let carrot = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(srgbRed: 0xF4 / 255, green: 0x9A / 255, blue: 0x5B / 255, alpha: 1)
            : NSColor(srgbRed: 0xD9 / 255, green: 0x64 / 255, blue: 0x1E / 255, alpha: 1)
    }
    static let carrotText = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(srgbRed: 0xF4 / 255, green: 0x9A / 255, blue: 0x5B / 255, alpha: 1)
            : NSColor(srgbRed: 0xB2 / 255, green: 0x4F / 255, blue: 0x12 / 255, alpha: 1)
    }
    static let eye = NSColor(srgbRed: 0x1D / 255, green: 0x1D / 255, blue: 0x1F / 255, alpha: 1)
}

enum Screen {
    /// Accessibility frames are global, top-left origin on the primary display; AppKit's are
    /// bottom-left.
    static func cocoa(_ ax: CGRect) -> NSRect {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        return NSRect(x: ax.minX, y: primaryHeight - ax.maxY, width: ax.width, height: ax.height)
    }

    static func containing(_ rect: NSRect) -> NSScreen? {
        NSScreen.screens.first { $0.frame.intersects(rect) } ?? NSScreen.main
    }
}

/// The motion tokens: `--ease-out` is `cubic-bezier(.23, 1, .32, 1)` (`IDENTITY.md`).
@MainActor
private enum Motion {
    static let easeOut = CAMediaTimingFunction(controlPoints: 0.23, 1, 0.32, 1)

    static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    static func fadeIn(_ panel: NSPanel, duration: TimeInterval, timing: CAMediaTimingFunction) {
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            context.timingFunction = timing
            panel.animator().alphaValue = 1
        }
    }

    /// Opacity 0 to 1, scale 0.96 to 1 and a 2 pt settle toward the field, 160 ms `--ease-out`,
    /// origin at the corner nearest the field. Reduced motion keeps the fade and drops the movement.
    static func offerLineEnter(_ panel: NSPanel, view: NSView) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = reduceMotion ? 0.12 : 0.16
            context.timingFunction = easeOut
            panel.animator().alphaValue = 1
        }
        guard !reduceMotion, let layer = view.layer else { return }
        // Scale about the bottom right corner, the one nearest the field, without moving the
        // layer's anchor (AppKit owns a backing layer's geometry). Layer space is not flipped, so
        // starting 2 pt up is +2 in y.
        let width = view.bounds.width
        let start = CATransform3DConcat(
            CATransform3DMakeTranslation(-width, 0, 0),
            CATransform3DConcat(CATransform3DMakeScale(0.96, 0.96, 1), CATransform3DMakeTranslation(width, 2, 0))
        )
        let animation = CABasicAnimation(keyPath: "transform")
        animation.fromValue = NSValue(caTransform3D: start)
        animation.toValue = NSValue(caTransform3D: CATransform3DIdentity)
        animation.duration = 0.16
        animation.timingFunction = easeOut
        layer.add(animation, forKey: "enter")
    }

    static func fadeOut(_ panel: NSPanel, duration: TimeInterval) {
        guard duration > 0, panel.isVisible else {
            panel.orderOut(nil)
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            context.timingFunction = CAMediaTimingFunction(name: .linear)
            panel.animator().alphaValue = 0
        } completionHandler: {
            MainActor.assumeIsolated { panel.orderOut(nil) }
        }
    }
}
