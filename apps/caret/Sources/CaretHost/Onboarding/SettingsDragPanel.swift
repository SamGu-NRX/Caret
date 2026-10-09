import AppKit
import QuartzCore
import CaretHostCore
import SwiftUI

/// "Drag Caret into the list above": a small panel that sits inside System Settings' Accessibility pane while the
/// switch is off, with one row the person drags into the list (T3 Code's way in, which Sam asked for on 2026-10-09).
/// Dropping the app there adds it with its switch on; macOS asks for the password or Touch ID itself.
///
/// The panel never takes focus (non-activating, `orderFrontRegardless`), floats above System Settings, follows its
/// window (polled every 0.5 s while System Settings is in front, 1 s otherwise), hides while System Settings is not in
/// front, and reports when System Settings closes after it was found. Window bounds and owners come from
/// `CGWindowListCopyWindowInfo`, which needs no permission for them. Placement is `SettingsDragPanelPlacement`.
@MainActor
final class SettingsDragPanel {
    /// System Settings closed after the panel had found it: the caller falls back to its own window.
    var onSettingsClosed: () -> Void = {}

    private var panel: DragPanelWindow?
    private var model = SettingsDragPanelModel()
    private var timer: Timer?
    private var found = false
    private(set) var isShown = false

    var landed: Bool {
        get { model.landed }
        set { model.landed = newValue }
    }

    /// Where the panel's first appearance travels from (Caret's own window, in AppKit coordinates), if anywhere.
    private var source: NSRect?
    private var flight: Timer?

    func start(from source: NSRect? = nil) {
        guard timer == nil else { return }
        found = false
        self.source = source
        track()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        flight?.invalidate()
        flight = nil
        panel?.orderOut(nil)
        panel = nil
        isShown = false
        found = false
        model.landed = false
    }

    private func schedule(_ interval: TimeInterval) {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.track() }
        }
    }

    private func track() {
        let settingsApp = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").first
        let frontmost = NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.systempreferences"
        guard let settingsApp, let frame = Self.settingsFrame(pid: settingsApp.processIdentifier) else {
            hide()
            if found {
                stop()
                return onSettingsClosed()
            }
            return schedule(1)
        }
        found = true
        if frontmost { show(at: SettingsDragPanelPlacement.frame(settings: frame)) } else { hide() }
        // Kept on System Settings' window while it is moved: a short interval while it is in front (Permiso uses 0.15 s).
        schedule(frontmost ? 0.15 : 1)
    }

    private static func settingsFrame(pid: pid_t) -> CGRect? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        let windows = list.compactMap { info -> SettingsDragPanelPlacement.Window? in
            guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, let layer = info[kCGWindowLayer as String] as? Int,
                  let b = info[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
            return .init(ownerPid: owner, layer: layer, bounds: CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0))
        }
        return SettingsDragPanelPlacement.settingsWindow(in: windows, settingsPid: pid)
    }

    private func show(at topLeft: CGRect) {
        let primary = NSScreen.screens.first?.frame.height ?? 0
        let frame = NSRect(x: topLeft.minX, y: primary - topLeft.maxY, width: topLeft.width, height: topLeft.height)
        let panel = self.panel ?? makePanel()
        target = frame
        if flight == nil, panel.frame != frame { panel.setFrame(frame, display: true) }
        guard !isShown else { return }
        isShown = true
        panel.orderFrontRegardless()
        NSAccessibility.post(element: panel, notification: .created)
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if let source, !reduce {
            // The first time, the row travels from Caret's window into System Settings along a short arc, so the eye
            // follows it to where it is needed (spatial continuity). Critically damped spring, no bounce; it retargets
            // each frame if System Settings moves meanwhile.
            self.source = nil
            fly(panel, from: source)
        } else {
            // Reduce Motion, or no window to come from: a fade in place.
            panel.alphaValue = 0
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = reduce ? 0.12 : 0.16
                ctx.timingFunction = Motion.caCurve(OnboardingMotion.out)
                panel.animator().alphaValue = 1
            }
        }
    }

    private var target: NSRect = .zero
    /// The spring's response: about 0.55 s to settle, which reads as one deliberate move.
    static let response: Double = 0.55

    private func fly(_ panel: NSPanel, from start: NSRect) {
        flight?.invalidate()
        let began = CACurrentMediaTime()
        panel.alphaValue = 0.9
        panel.setFrame(start, display: true)
        flight = Timer.scheduledTimer(withTimeInterval: 1.0 / 120, repeats: true) { [weak self] t in
            MainActor.assumeIsolated {
                guard let self else { return t.invalidate() }
                let p = Self.springProgress(CACurrentMediaTime() - began)
                panel.setFrame(Self.arc(from: start, to: self.target, progress: p), display: true)
                panel.alphaValue = 0.9 + 0.1 * p
                if p >= 0.999 {
                    t.invalidate()
                    self.flight = nil
                    panel.setFrame(self.target, display: true)
                    panel.alphaValue = 1
                }
            }
        }
    }

    /// A critically damped spring's progress (0 to 1) at `t` seconds: 1 − e^(−ωt)(1 + ωt), ω = 2π / response.
    static func springProgress(_ t: Double) -> CGFloat {
        let w = 2 * Double.pi / response
        return CGFloat(min(1, max(0, 1 - exp(-w * t) * (1 + w * t))))
    }

    /// The frame `progress` of the way from `a` to `b`: size eases straight across, the centre follows a quadratic arc
    /// that lifts by a fraction of the distance (44 to 140 pt), so the move reads as a toss rather than a slide.
    static func arc(from a: NSRect, to b: NSRect, progress p: CGFloat) -> NSRect {
        let w = a.width + (b.width - a.width) * p, h = a.height + (b.height - a.height) * p
        let s = CGPoint(x: a.midX, y: a.midY), e = CGPoint(x: b.midX, y: b.midY)
        let lift = min(140, max(44, hypot(e.x - s.x, e.y - s.y) * 0.18))
        let c = CGPoint(x: (s.x + e.x) / 2, y: max(s.y, e.y) + lift)
        let q = 1 - p
        let x = q * q * s.x + 2 * q * p * c.x + p * p * e.x
        let y = q * q * s.y + 2 * q * p * c.y + p * p * e.y
        return NSRect(x: x - w / 2, y: y - h / 2, width: w, height: h)
    }

    private func hide() {
        guard isShown else { return }
        isShown = false
        panel?.orderOut(nil)
    }

    private func makePanel() -> DragPanelWindow {
        let p = DragPanelWindow(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isFloatingPanel = true
        // Above System Settings' own sheets and popovers, as the Codex and Permiso panels sit.
        p.level = .statusBar
        p.backgroundColor = .clear
        p.isOpaque = false
        p.hasShadow = true
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        p.contentView = NSHostingView(rootView: SettingsDragPanelView(model: model) { [weak self] in self?.dismissed() })
        panel = p
        return p
    }

    private func dismissed() {
        // The close button: the panel goes for this visit to System Settings; the onboarding window still waits.
        timer?.invalidate()
        timer = nil
        panel?.orderOut(nil)
        isShown = false
    }
}

/// Never key or main, so System Settings keeps the focus and the drop lands in its list.
final class DragPanelWindow: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class SettingsDragPanelModel: ObservableObject {
    /// The switch is on: the header says so for the moment before the panel closes.
    @Published var landed = false
}

/// The card: a header and one row to drag. Caret's tokens, light and dark.
struct SettingsDragPanelView: View {
    @ObservedObject var model: SettingsDragPanelModel
    var close: () -> Void
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(model.landed ? OnboardingCopy.Access.landedTitle : OnboardingCopy.Drag.header)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color(token: Tokens.ink))
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                if hovering, !model.landed {
                    Button(action: close) {
                        Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Color(token: Tokens.ink2))
                            .frame(width: 20, height: 20)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(PressStyle())
                    .accessibilityLabel(OnboardingCopy.Drag.close)
                }
            }
            DragRow().frame(height: 52)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(token: Tokens.window), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Color(token: Tokens.rule), lineWidth: 1) }
        .onHover { hovering = $0 }
        .accessibilityElement(children: .contain)
    }
}

/// The row: Caret's icon (Pebble) and name. Dragging it drags Caret.app; a click shows Caret.app in Finder.
struct DragRow: NSViewRepresentable {
    func makeNSView(context: Context) -> DragRowView { DragRowView() }
    func updateNSView(_ view: DragRowView, context: Context) { view.needsDisplay = true }
}

final class DragRowView: NSView, NSDraggingSource {
    private var downAt: NSPoint?
    private var dragging = false
    private var hosting: NSHostingView<DragRowContent>?

    override init(frame: NSRect) {
        super.init(frame: frame)
        let content = NSHostingView(rootView: DragRowContent())
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: leadingAnchor), content.trailingAnchor.constraint(equalTo: trailingAnchor),
            content.topAnchor.constraint(equalTo: topAnchor), content.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        hosting = content
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(OnboardingCopy.Drag.voiceOver)
    }

    required init?(coder: NSCoder) { nil }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }

    override func mouseDown(with event: NSEvent) {
        downAt = event.locationInWindow
        dragging = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard !dragging, let downAt else { return }
        let p = event.locationInWindow
        guard hypot(p.x - downAt.x, p.y - downAt.y) > 3 else { return }
        dragging = true
        let url = Bundle.main.bundleURL as NSURL
        let item = NSDraggingItem(pasteboardWriter: url)
        let icon = NSApp.applicationIconImage ?? NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)
        let local = convert(downAt, from: nil)
        item.setDraggingFrame(NSRect(x: local.x - 32, y: local.y - 32, width: 64, height: 64), contents: icon)
        beginDraggingSession(with: [item], event: event, source: self)
    }

    override func mouseUp(with event: NSEvent) {
        defer { downAt = nil }
        guard !dragging else { return }
        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
    }

    override func accessibilityPerformPress() -> Bool {
        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
        return true
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        context == .outsideApplication ? [.copy, .link, .generic] : []
    }

    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        dragging = false
    }
}

struct DragRowContent: View {
    var body: some View {
        HStack(spacing: 10) {
            // This exact bundle, by its icon, name and folder, so it can't be mistaken for another Caret in the list.
            Image(nsImage: NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)).resizable().frame(width: 32, height: 32)
            VStack(alignment: .leading, spacing: 1) {
                Text(FileManager.default.displayName(atPath: Bundle.main.bundlePath).replacingOccurrences(of: ".app", with: ""))
                    .font(.system(size: 13)).foregroundStyle(Color(token: Tokens.ink))
                Text("in \(Bundle.main.bundleURL.deletingLastPathComponent().path)")
                    .font(.system(size: 11)).foregroundStyle(Color(token: Tokens.ink2)).lineLimit(1).truncationMode(.middle)
            }
            Spacer()
            Image(systemName: "hand.draw").font(.system(size: 13)).foregroundStyle(Color(token: Tokens.ink2))
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .quaternaryLabelColor), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityHidden(true)
    }
}
