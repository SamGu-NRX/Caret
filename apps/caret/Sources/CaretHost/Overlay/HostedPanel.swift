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

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
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

/// One SwiftUI surface in an `OverlayPanel` over the system popover material.
///
/// The panel keeps one corner pinned (`Anchor`), the corner nearest what it describes, so content
/// that grows or shrinks (a toast replacing an offer, a reveal adding rows) never moves away from
/// it, and the entrance scales from that corner.
@MainActor
final class HostedPanel {
    enum Corner { case topLeft, topRight, bottomLeft, bottomRight }

    struct Anchor: Equatable {
        var corner: Corner
        /// Cocoa coordinates.
        var point: NSPoint
    }

    let panel = OverlayPanel.make()
    private let material = NSVisualEffectView()
    private let host: NSHostingView<AnyView> = FirstMouseHostingView(rootView: AnyView(EmptyView()))
    private(set) var anchor = Anchor(corner: .topLeft, point: .zero)
    /// What the panel says, for the debug socket.
    var text = ""
    private(set) var isExiting = false

    /// `material: false` for decoration drawn straight over the app (the underline and count),
    /// which has no surface, blur or shadow of its own. `interactive: true` for a panel with
    /// buttons (the activity list): it takes clicks, still without ever becoming key.
    init(radius: CGFloat, material hasMaterial: Bool = true, interactive: Bool = false) {
        panel.ignoresMouseEvents = !interactive
        host.autoresizingMask = [.width, .height]
        // The panel sizes the host from its fitting size; no constraints of its own.
        host.sizingOptions = []
        if hasMaterial {
            material.material = .popover
            material.blendingMode = .behindWindow
            material.state = .active
            material.wantsLayer = true
            material.layer?.cornerRadius = radius
            material.layer?.cornerCurve = .continuous
            material.layer?.masksToBounds = true
            material.autoresizingMask = [.width, .height]
            material.addSubview(host)
            panel.contentView = material
            panel.hasShadow = true
        } else {
            host.wantsLayer = true
            panel.contentView = host
            bare = true
        }
    }

    /// True for a panel with no material: `host` sits directly in the content view.
    private var bare = false

    var isVisible: Bool { panel.isVisible && !isExiting }

    /// Replaces the content and resizes about the anchor. No animation: content changes come from
    /// keys (an arrow, a reveal) or from results, which should land at once.
    func setContent<V: View>(_ view: V) {
        // Measured on a fresh hosting view: the panel's own host has no sizing constraints (so
        // AppKit never resizes the panel behind our back), and so reports no fitting size.
        let size = measure(view)
        host.rootView = AnyView(view)
        setFrame(size: size)
    }

    var size: NSSize { panel.frame.size }

    /// The content's size without placing it, for choosing among placements.
    func measure<V: View>(_ view: V) -> NSSize {
        let probe = NSHostingView(rootView: view)
        return probe.fittingSize
    }

    func pin(_ anchor: Anchor) {
        self.anchor = anchor
        setFrame(size: panel.frame.size)
    }

    private func setFrame(size: NSSize) {
        var origin = anchor.point
        switch anchor.corner {
        case .topLeft: origin.y -= size.height
        case .topRight: origin.x -= size.width; origin.y -= size.height
        case .bottomLeft: break
        case .bottomRight: origin.x -= size.width
        }
        panel.setFrame(NSRect(origin: origin, size: size), display: true)
        material.frame = NSRect(origin: .zero, size: size)
        host.frame = NSRect(origin: .zero, size: size)
    }

    /// Opacity 0 to 1, scale 0.96 to 1 and a 2 pt settle toward the anchor, 160 ms `--ease-out`,
    /// scaled about the anchored corner. Reduce Motion keeps a 120 ms fade and drops the movement.
    func enter() {
        isExiting = false
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        let reduce = Motion.reduceMotion
        NSAnimationContext.runAnimationGroup { context in
            context.duration = reduce ? 0.12 : 0.16
            context.timingFunction = Motion.caCurve(Motion.easeOut)
            panel.animator().alphaValue = 1
        }
        guard !reduce, let layer = (bare ? host : material).layer else { return }
        let w = panel.frame.width, h = panel.frame.height
        // Layer space is bottom-left; the pivot is the anchored corner.
        let px: CGFloat = (anchor.corner == .topRight || anchor.corner == .bottomRight) ? w : 0
        let py: CGFloat = (anchor.corner == .topLeft || anchor.corner == .topRight) ? h : 0
        // Settle 2 pt toward the anchor: from above when pinned at the top, from below otherwise.
        let settle: CGFloat = py == h ? 2 : -2
        let start = CATransform3DConcat(
            CATransform3DMakeTranslation(-px, -py, 0),
            CATransform3DConcat(CATransform3DMakeScale(0.96, 0.96, 1), CATransform3DMakeTranslation(px, py + settle, 0))
        )
        let animation = CABasicAnimation(keyPath: "transform")
        animation.fromValue = NSValue(caTransform3D: start)
        animation.toValue = NSValue(caTransform3D: CATransform3DIdentity)
        animation.duration = 0.16
        animation.timingFunction = Motion.caCurve(Motion.easeOut)
        layer.add(animation, forKey: "enter")
    }

    /// Opacity to 0, linear: 100 ms on Esc or timeout, 80 ms on typing, 0 for at once.
    func exit(duration: TimeInterval) {
        guard duration > 0, panel.isVisible else {
            isExiting = false
            panel.orderOut(nil)
            return
        }
        isExiting = true
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            context.timingFunction = CAMediaTimingFunction(name: .linear)
            panel.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.isExiting else { return }
                self.isExiting = false
                self.panel.orderOut(nil)
            }
        }
    }

    func debugInfo() -> DebugState.Panel? {
        guard panel.isVisible else { return nil }
        let f = panel.frame
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        return DebugState.Panel(
            windowNumber: panel.windowNumber,
            frame: [f.minX, primaryHeight - f.maxY, f.width, f.height].map { Double($0) },
            isKey: panel.isKeyWindow,
            text: isExiting ? "(exiting) " + text : text
        )
    }
}

/// What a line would cover: the frames of the app's own elements under each candidate spot,
/// found by Accessibility hit-testing a few points per candidate. Containers (groups, scroll
/// areas) are empty space; anything else (a field, a label, a button) is in the way, and so is a
/// window's title bar, which hit-tests as the window itself.
enum ObstacleProbe {
    /// A standard macOS title bar. Assumed: Accessibility exposes no title bar frame, and windows
    /// with a toolbar or a hidden title bar differ.
    static let titleBarHeight: CGFloat = 28

    static let containerRoles: Set<String> = ["AXWindow", "AXGroup", "AXScrollArea", "AXSplitGroup", "AXLayoutArea", "AXUnknown", "AXSheet"]

    static func obstacles(pid: pid_t, under candidates: [CGRect]) -> [CGRect] {
        let app = AXUIElementCreateApplication(pid)
        var found: [CGRect] = []
        for rect in candidates {
            for fx in [0.04, 0.35, 0.65, 0.96] as [CGFloat] {
                for fy in [0.2, 0.8] as [CGFloat] {
                    let point = CGPoint(x: rect.minX + rect.width * fx, y: rect.minY + rect.height * fy)
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
        }
        return found
    }
}
