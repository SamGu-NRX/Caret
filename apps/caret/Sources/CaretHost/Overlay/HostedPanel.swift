import AppKit
import ApplicationServices
import CaretHostCore
import MacContextCapture
import SwiftUI

/// A borderless, non-activating, click-through panel that never becomes key or main, so the app
/// being typed in keeps focus and every key keeps going to it.
final class OverlayPanel: NSPanel {
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

    /// The activity list holds the ask field, so it may become key while that field is used. It
    /// stays non-activating: the app the user was in keeps the foreground (`.nonactivatingPanel`).
    var keyable = false
    /// Keys the ask field's owner takes before the field editor does: Return, Tab and Esc inside a
    /// text field are otherwise consumed by AppKit (Tab moves focus, Esc cancels). True: handled.
    var interceptKey: ((NSEvent) -> Bool)?

    override var canBecomeKey: Bool { keyable }
    override var canBecomeMain: Bool { false }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown, isKeyWindow, let interceptKey, interceptKey(event) { return }
        super.sendEvent(event)
    }
}

/// Takes the first click in a window that is not key, so a button in a panel that never becomes
/// key works on the first press.
extension FocusedFieldSnapshot {
    /// The caret in Accessibility coordinates (global, top-left origin), the space the visibility
    /// gate, the surfaces and the perch work in. KeyType's resolver returns `caretRect` in AppKit
    /// coordinates (bottom-left; AXCaretGeometryResolver converts with `cocoaRect`), which only
    /// its own ghost renderer should read. A9: passed unconverted, the gate tested a point mirrored
    /// across the main display, found another app's window there, and held every ghost offer in a
    /// field with text as `covered`.
    var caretRectAX: CGRect? { caretRect.map { Screen.ax($0) } }
}

final class FirstMouseHostingView: NSHostingView<AnyView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

enum Screen {
    /// Accessibility frames are global, top-left origin on the primary display; AppKit's are
    /// bottom-left.
    static func cocoa(_ ax: CGRect) -> NSRect {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        return NSRect(x: ax.minX, y: primaryHeight - ax.maxY, width: ax.width, height: ax.height)
    }

    static func ax(_ cocoa: NSRect) -> CGRect {
        ax(cocoa, primaryHeight: NSScreen.screens.first?.frame.height ?? 0)
    }

    static func ax(_ cocoa: NSRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: cocoa.minX, y: primaryHeight - cocoa.maxY, width: cocoa.width, height: cocoa.height)
    }

    static func containing(_ rect: NSRect) -> NSScreen? {
        NSScreen.screens.first { $0.frame.intersects(rect) } ?? NSScreen.main
    }

    /// The visible frame of the screen holding an Accessibility rect, in Accessibility coordinates.
    static func axVisibleFrame(around ax: CGRect) -> CGRect {
        let screen = containing(cocoa(ax))
        return Self.ax(screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900))
    }
}

/// The one panel every at-caret surface uses (DIRECTION.md section 7, "Panels"): a borderless,
/// non-activating, click-through `OverlayPanel` holding one SwiftUI view over glass.
///
/// - Material: on macOS 26 the system glass (`NSGlassEffectView`); below it `NSVisualEffectView`
///   (`.popover` light, `.hudWindow` dark). Either way the view lays the glass color over it
///   (`drawsGlassTint`), so text contrast does not depend on what is behind the panel.
/// - Shadow: drawn here, outside the shape only, so it never darkens the glass; the window's own
///   shadow is off. The window is `Tokens.Shape.shadowMargin` larger than the content on every side
///   to hold it. Every frame this class takes or reports is the content's, not the window's.
///   An interactive panel (the desk) has no margin and keeps the system's window shadow: a window
///   that takes clicks takes them across its whole frame, transparent margin included.
/// - Anchor: one corner stays pinned (the corner nearest what the panel describes), so content
///   that grows or shrinks (a result replacing an offer, the question growing the slip) never moves
///   away from it, and the entrance scales from that corner.
@MainActor
final class HostedPanel {
    enum Corner { case topLeft, topRight, bottomLeft, bottomRight }

    struct Anchor: Equatable {
        var corner: Corner
        /// Cocoa coordinates.
        var point: NSPoint
    }

    let panel = OverlayPanel.make()
    private let container = NSView()
    private let shadow = PanelShadowView()
    private let material: NSView?
    private let host: NSHostingView<AnyView> = FirstMouseHostingView(rootView: AnyView(EmptyView()))
    /// The glass's corner radius: 9 for a slip, 12 for a pop-up, 6 for the compact slip. One panel
    /// shows each of these in turn, so it follows its content.
    var radius: CGFloat { didSet { if radius != oldValue { applyRadius() } } }
    private let margin: CGFloat
    /// The view lays the glass color over the material.
    private let tints: Bool
    /// Pop-ups enter a little larger than slips (scale 0.96, 180 ms).
    var popup: Bool
    private(set) var anchor = Anchor(corner: .topLeft, point: .zero)
    private(set) var size: NSSize = .zero
    /// What the panel says, for the debug socket.
    var text = ""
    private(set) var isExiting = false
    /// The view last set, unwrapped, so a new anchor corner can re-pin it.
    private var shown: AnyView?

    /// H14: a click-through panel that takes clicks on its content and never on the margin around it, which holds the
    /// drawn shadow and would otherwise swallow clicks meant for the page under it (the page task panel's attach
    /// rows). The window takes mouse events only while the pointer is over the content, read from mouse-moved events
    /// in Caret and in other apps; mouse-moved monitors need no permission.
    var clickableContent = false {
        didSet { if clickableContent != oldValue { trackPointer() } }
    }
    /// The monitors are up only while the panel shows and takes clicks (prep-for-prod H14-5).
    private var wantsPointer: Bool { clickableContent && panel.isVisible && !isExiting }
    /// Test hook (`pagetask clicks`): false takes every click over the whole window while the content is clickable,
    /// with no pointer gating, to tell a gating fault from a panel that takes no click at all.
    var gatesPointer = true {
        didSet { if gatesPointer != oldValue { pointerMoved() } }
    }
    private var pointerMonitors: [Any] = []
    /// Mouse moves the monitors have seen, for the debug socket.
    private var pointerMoves = 0

    /// `material: false` for decoration drawn straight over the app (the underline, the figure and
    /// ticks after an alternative, Caret's own ghost text), which has no glass, shadow or margin.
    /// `interactive: true` for a panel with buttons: it takes clicks, still never becoming key.
    init(radius: CGFloat, material hasMaterial: Bool = true, interactive: Bool = false, popup: Bool = false) {
        self.radius = radius
        self.popup = popup
        let drawsShadow = hasMaterial && !interactive
        margin = drawsShadow ? Tokens.Shape.shadowMargin : 0
        panel.ignoresMouseEvents = !interactive
        host.sizingOptions = []
        container.wantsLayer = true
        panel.contentView = container
        panel.hasShadow = hasMaterial && interactive
        if hasMaterial {
            if #available(macOS 26.0, *) {
                let glass = NSGlassEffectView()
                glass.style = .regular
                material = glass
            } else {
                material = FallbackMaterial()
            }
            tints = true
            if drawsShadow { container.addSubview(shadow) }
            container.addSubview(material!)
        } else {
            material = nil
            tints = false
        }
        host.wantsLayer = true
        container.addSubview(host)
        applyRadius()
    }

    private func applyRadius() {
        if #available(macOS 26.0, *), let glass = material as? NSGlassEffectView { glass.cornerRadius = radius }
        material?.layer?.cornerRadius = radius
        shadow.radius = radius
    }

    var isVisible: Bool { panel.isVisible && !isExiting }

    /// The view as this panel shows it: pinned to the anchored corner, so a size change animated
    /// inside the view grows away from the corner, and tinted where the material is not.
    private func hosted<V: View>(_ view: V) -> AnyView {
        AnyView(view
            .environment(\.drawsGlassTint, tints)
            .environment(\.reducesMotion, Motion.reduceMotion)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment))
    }

    private var alignment: Alignment {
        switch anchor.corner {
        case .topLeft: return .topLeading
        case .topRight: return .topTrailing
        case .bottomLeft: return .bottomLeading
        case .bottomRight: return .bottomTrailing
        }
    }

    /// Replaces the content and resizes about the anchor. Content changes come from keys (an
    /// arrow, a reveal) or from results, which land at once. `growing`: the slip is gaining the
    /// skill question, and its glass grows over 200 ms with the view (`Motion.Duration.grow`).
    func setContent<V: View>(_ view: V, growing: Bool = false) {
        let next = measure(view)
        let grows = growing && isVisible && size != .zero && next.height > size.height && !Motion.reduceMotion
        let from = size
        shown = AnyView(view)
        host.rootView = hosted(view)
        setFrame(size: next)
        if grows, let material { growMaterial(material, from: from, to: next) }
    }

    /// The content's size without placing it, for choosing among placements. Measured on a fresh
    /// hosting view: the panel's own host has no sizing constraints (so AppKit never resizes the
    /// panel behind our back), and so reports no fitting size.
    func measure<V: View>(_ view: V) -> NSSize {
        NSHostingView(rootView: view.environment(\.drawsGlassTint, tints)).fittingSize
    }

    func pin(_ anchor: Anchor) {
        let turned = anchor.corner != self.anchor.corner
        self.anchor = anchor
        if turned, let shown { host.rootView = hosted(shown) }
        setFrame(size: size)
    }

    /// Slides the panel to a new anchor over `duration` with `ease-out`: the fill slip moving to
    /// the next field. Only the origin changes, so the content does not lag a resize. At once
    /// under Reduce Motion.
    func move(to anchor: Anchor, duration: Double) {
        let turned = anchor.corner != self.anchor.corner
        self.anchor = anchor
        if turned, let shown { host.rootView = hosted(shown) }
        let target = contentFrame(size: size).insetBy(dx: -margin, dy: -margin)
        guard !Motion.reduceMotion, duration > 0, panel.isVisible else { return setFrame(size: size) }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            context.timingFunction = Motion.caCurve(Motion.easeOut)
            panel.animator().setFrame(target, display: true)
        }
    }

    /// The content's frame in Cocoa coordinates for `size` at the anchor.
    func contentFrame(size: NSSize) -> NSRect {
        var origin = anchor.point
        switch anchor.corner {
        case .topLeft: origin.y -= size.height
        case .topRight: origin.x -= size.width; origin.y -= size.height
        case .bottomLeft: break
        case .bottomRight: origin.x -= size.width
        }
        return NSRect(origin: origin, size: size)
    }

    private func trackPointer() {
        guard wantsPointer != !pointerMonitors.isEmpty else { return pointerMoved() }
        for m in pointerMonitors { NSEvent.removeMonitor(m) }
        pointerMonitors = []
        panel.acceptsMouseMovedEvents = wantsPointer
        guard wantsPointer else {
            panel.ignoresMouseEvents = true
            return
        }
        let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] _ in
            MainActor.assumeIsolated {
                self?.pointerMoves &+= 1
                self?.pointerMoved()
            }
        }) { pointerMonitors.append(global) }
        if let local = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            MainActor.assumeIsolated {
                self?.pointerMoves &+= 1
                self?.pointerMoved()
            }
            return event
        }) { pointerMonitors.append(local) }
        pointerMoved()
    }

    /// Takes mouse events while the pointer is over the content of a shown panel; passes them through otherwise.
    private func pointerMoved() {
        guard clickableContent else { return }
        let over = panel.isVisible && !isExiting && (!gatesPointer || contentFrame(size: size).contains(NSEvent.mouseLocation))
        if panel.ignoresMouseEvents == over { panel.ignoresMouseEvents = !over }
    }

    private func setFrame(size: NSSize) {
        self.size = size
        let content = contentFrame(size: size)
        panel.setFrame(content.insetBy(dx: -margin, dy: -margin), display: true)
        let inner = NSRect(x: margin, y: margin, width: size.width, height: size.height)
        container.frame = NSRect(origin: .zero, size: panel.frame.size)
        material?.frame = inner
        shadow.frame = container.bounds
        shadow.shape = inner
        host.frame = inner
        pointerMoved()
    }

    /// The glass grows from the old height to the new about the pinned edge, with the view's own
    /// 200 ms `ease-out`. The window took its new size at once (`DIRECTION.md`: never animate an
    /// `NSWindow`'s frame), so only the material moves.
    private func growMaterial(_ material: NSView, from: NSSize, to: NSSize) {
        let end = NSRect(x: margin, y: margin, width: to.width, height: to.height)
        var start = end
        start.size.height = from.height
        if anchor.corner == .topLeft || anchor.corner == .topRight { start.origin.y = end.maxY - from.height }
        material.frame = start
        NSAnimationContext.runAnimationGroup { context in
            context.duration = Motion.Duration.grow
            context.timingFunction = Motion.caCurve(Motion.easeOut)
            context.allowsImplicitAnimation = true
            material.animator().frame = end
        }
    }

    /// Opacity 0 to 1, scale 0.97 (pop-ups 0.96) to 1 and a 2 pt settle toward the anchor, 160 ms
    /// (pop-ups 180 ms) `ease-out`, about the anchored corner. Reduce Motion keeps a 0.12 s fade
    /// and drops the movement (`Motion.Entrance`).
    /// `scales: false, rises: true` (H11's page task panel): opacity and a 2 pt rise from below, as the memo
    /// specifies, whichever corner is pinned.
    func enter(scales: Bool = true, rises: Bool = false) {
        isExiting = false
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        trackPointer()
        var entrance = Motion.Entrance.panel(popup: popup, reduce: Motion.reduceMotion)
        if !scales, entrance.scale != nil { entrance.scale = 1 }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = entrance.duration
            context.timingFunction = Motion.caCurve(Motion.easeOut)
            panel.animator().alphaValue = 1
        }
        guard let scale = entrance.scale, let layer = container.layer else { return }
        // Layer space is bottom-left; the pivot is the content's anchored corner.
        let right = anchor.corner == .topRight || anchor.corner == .bottomRight
        let top = anchor.corner == .topLeft || anchor.corner == .topRight
        let px = margin + (right ? size.width : 0)
        let py = margin + (top ? size.height : 0)
        // Settle toward the anchor: from above when pinned at the top, from below otherwise.
        let settle = rises ? -entrance.settle : (top ? entrance.settle : -entrance.settle)
        let start = CATransform3DConcat(
            CATransform3DMakeTranslation(-px, -py, 0),
            CATransform3DConcat(CATransform3DMakeScale(scale, scale, 1), CATransform3DMakeTranslation(px, py + settle, 0))
        )
        let animation = CABasicAnimation(keyPath: "transform")
        animation.fromValue = NSValue(caTransform3D: start)
        animation.toValue = NSValue(caTransform3D: CATransform3DIdentity)
        animation.duration = entrance.duration
        animation.timingFunction = Motion.caCurve(Motion.easeOut)
        layer.add(animation, forKey: "enter")
    }

    /// At once, with nothing moving: a panel a key or a click brought back.
    func show() {
        isExiting = false
        container.layer?.removeAnimation(forKey: "enter")
        panel.alphaValue = 1
        panel.orderFrontRegardless()
        trackPointer()
    }

    /// Opacity to 0 with `ease-out`: 100 ms on Esc, 80 ms on typing, 220 ms for a result that
    /// timed out, 0 for at once; 120 ms for any of them under Reduce Motion.
    func exit(duration: TimeInterval) {
        let duration = Motion.exit(duration, reduce: Motion.reduceMotion)
        guard duration > 0, panel.isVisible else {
            isExiting = false
            panel.orderOut(nil)
            trackPointer()
            return
        }
        isExiting = true
        // A leaving panel takes no click.
        trackPointer()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            context.timingFunction = Motion.caCurve(Motion.easeOut)
            panel.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.isExiting else { return }
                self.isExiting = false
                self.panel.orderOut(nil)
            }
        }
    }

    /// The content's frame, global top-left (the window's margin excluded).
    func debugInfo() -> DebugState.Panel? {
        guard panel.isVisible else { return nil }
        let f = contentFrame(size: size)
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        return DebugState.Panel(
            windowNumber: panel.windowNumber,
            frame: [f.minX, primaryHeight - f.maxY, f.width, f.height].map { Double($0) },
            isKey: panel.isKeyWindow,
            text: isExiting ? "(exiting) " + text : text,
            takesClicks: clickableContent ? !panel.ignoresMouseEvents : nil,
            pointerMonitors: clickableContent ? pointerMonitors.count : nil,
            pointerMoves: clickableContent ? pointerMoves : nil
        )
    }
}

/// The panel's shadow, drawn only outside its shape (a CSS box-shadow, not a drop shadow under
/// translucent glass): two layers, `Tokens.Shadow`'s near and far, masked to everything but the
/// shape. Colors follow the appearance.
final class PanelShadowView: NSView {
    var radius: CGFloat = 9 { didSet { needsLayout = true } }
    var shape: NSRect = .zero { didSet { needsLayout = true } }
    private let near = CALayer()
    private let far = CALayer()
    private let mask = CAShapeLayer()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.addSublayer(far)
        layer?.addSublayer(near)
        mask.fillRule = .evenOdd
        layer?.mask = mask
    }

    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { false }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let dark = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        let path = CGPath(roundedRect: shape, cornerWidth: radius, cornerHeight: radius, transform: nil)
        let specs = Tokens.Shadow.panel(dark: dark)
        // Layer space is bottom-left, so the downward offset is negated. CSS blur is twice a
        // layer's shadow radius.
        for (layer, spec) in [(near, specs.near), (far, specs.far)] {
            layer.frame = bounds
            layer.shadowPath = path
            layer.shadowColor = Tokens.srgb(spec.color).cgColor
            layer.shadowOpacity = Float(spec.opacity)
            layer.shadowRadius = spec.blur / 2
            layer.shadowOffset = CGSize(width: 0, height: -spec.y)
        }
        let outside = CGMutablePath()
        outside.addRect(bounds)
        outside.addPath(path)
        mask.path = outside
        CATransaction.commit()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsLayout = true
    }
}

/// Glass before macOS 26: `.popover` in light, `.hudWindow` in dark, behind the window, always
/// active, clipped to the panel's radius.
final class FallbackMaterial: NSVisualEffectView {
    init() {
        super.init(frame: .zero)
        blendingMode = .behindWindow
        state = .active
        wantsLayer = true
        layer?.cornerCurve = .continuous
        layer?.masksToBounds = true
        choose()
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        choose()
    }

    private func choose() {
        material = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? .hudWindow : .popover
    }
}

/// What a panel would cover: the frames of the app's own elements under each candidate spot,
/// found by Accessibility hit-testing a grid of points per candidate. Containers (groups, scroll
/// areas) are empty space; anything else (a field, a label, a button) is in the way, and so is a
/// window's title bar, which hit-tests as the window itself.
///
/// The grid has a row every `rowPitch` points and a column every `columnPitch`, at least two rows
/// and four columns, so a 28 pt line is probed on its two rows as before and a 170 pt card has no
/// gap a 16 pt tall or 20 pt wide label could hide in; a narrower label still can. A point inside
/// an element already found is not asked again, so a wide field costs one hit per row, and a point
/// outside every one of the app's windows is not asked at all: nothing of the app is there, and in
/// A10's on-screen run asking about the empty space beside a form cost a full 150 ms grid.
enum ObstacleProbe {
    static let rowPitch: CGFloat = 14
    static let columnPitch: CGFloat = 20
    /// Per hit-test: an app that does not answer in time is treated as empty there, so a hung app
    /// cannot stall the main thread for AX's default six seconds.
    static let messagingTimeout: Float = 0.05

    /// A standard macOS title bar. Assumed: Accessibility exposes no title bar frame, and windows
    /// with a toolbar or a hidden title bar differ.
    static let titleBarHeight: CGFloat = 28

    static let containerRoles: Set<String> = ["AXWindow", "AXGroup", "AXScrollArea", "AXSplitGroup", "AXLayoutArea", "AXUnknown", "AXSheet"]

    /// Fractions across a span of `length`, the outer two `edge` in from each end and no two more
    /// than `pitch` points apart.
    static func fractions(length: CGFloat, pitch: CGFloat, minimum: Int, edge: CGFloat) -> [CGFloat] {
        let count = max(minimum, Int((length * (1 - 2 * edge) / pitch).rounded(.up)) + 1)
        return (0..<count).map { edge + (1 - 2 * edge) * CGFloat($0) / CGFloat(count - 1) }
    }

    static func points(in rect: CGRect) -> [CGPoint] {
        let columns = fractions(length: rect.width, pitch: columnPitch, minimum: 4, edge: 0.04)
        // A line keeps the two rows, 20% in, the probe has always used for it.
        let rows = rect.height > 2 * rowPitch ? fractions(length: rect.height, pitch: rowPitch, minimum: 2, edge: 0.04) : [0.2, 0.8]
        return rows.flatMap { fy in columns.map { fx in CGPoint(x: rect.minX + rect.width * fx, y: rect.minY + rect.height * fy) } }
    }

    /// One placement's probing: the app's window frames are read once, and every hit-test stops
    /// at `until` (uptime nanoseconds).
    final class Session {
        let pid: pid_t
        let deadline: UInt64?
        private let app: AXUIElement
        /// Points outside these frames are not asked. Nil when the list could not be read whole,
        /// within the deadline: then every point is asked, as before.
        private lazy var windows: [CGRect]? = readWindows()

        init(pid: pid_t, until deadline: UInt64?) {
            self.pid = pid
            self.deadline = deadline
            app = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(app, messagingTimeout)
        }

        private var expired: Bool { deadline.map { DispatchTime.now().uptimeNanoseconds > $0 } ?? false }

        private func readWindows() -> [CGRect]? {
            var frames: [CGRect] = []
            for window in AXRead.elements(kAXWindowsAttribute, on: app) {
                // A window whose frame cannot be read could hold the point: skip no point then.
                guard !expired, let frame = AXRead.frame(of: window) else { return nil }
                frames.append(frame)
            }
            return frames.isEmpty ? nil : frames
        }

        /// The frames of the app's elements under `candidates`; nil when some point was never
        /// asked, so a slow app's half-probed spot is not taken for a clear one.
        func under(_ candidates: [CGRect]) -> [CGRect]? {
            if expired { return nil }
            let windows = self.windows
            var found: [CGRect] = []
            for rect in candidates {
                for point in points(in: rect) where !found.contains(where: { $0.contains(point) }) {
                    if let windows, !windows.contains(where: { $0.contains(point) }) { continue }
                    if expired { return nil }
                    var hit: AXUIElement?
                    guard AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &hit) == .success,
                          let hit, AXRead.pid(of: hit) == pid else { continue }
                    let role = AXRead.string(kAXRoleAttribute, on: hit) ?? "AXUnknown"
                    if role == "AXWindow", let window = AXRead.frame(of: hit), point.y < window.minY + titleBarHeight {
                        let bar = CGRect(x: window.minX, y: window.minY, width: window.width, height: titleBarHeight)
                        if !found.contains(bar) { found.append(bar) }
                        continue
                    }
                    guard !containerRoles.contains(role), let frame = AXRead.frame(of: hit) else { continue }
                    if !found.contains(frame) { found.append(frame) }
                }
            }
            return found
        }
    }
}
