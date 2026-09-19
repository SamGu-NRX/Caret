import AppKit
import ApplicationServices
import SwiftUI

struct MemoryItem: Identifiable {
    let id: String
    let text: String
    let sourceApp: String?
}

struct CaretAction: Identifiable {
    let id: String
    let title: String
}

@MainActor
final class Model: ObservableObject {
    @Published var selectedText = ""
    @Published var sourceApp: String?
    var memories: [MemoryItem] = []
    var onRun: ((CaretAction) -> Void)?

    let actions: [CaretAction] = [
        CaretAction(id: "book-flight", title: "Action 1"),
        CaretAction(id: "book-calendar-link", title: "Action 2"),
        CaretAction(id: "revise", title: "Action 3"),
    ]

    func run(_ action: CaretAction) {
        NSLog(
            "[Caret] action=%@ memories=%d selection=%@ app=%@",
            action.id,
            memories.count,
            selectedText.replacingOccurrences(of: "\n", with: " "),
            sourceApp ?? "-"
        )
        onRun?(action)
    }
}

struct ActionsView: View {
    @ObservedObject var model: Model

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(model.actions) { action in
                ActionRow(title: action.title) {
                    model.run(action)
                }
            }
        }
        .padding(10)
        .frame(width: 220)
    }
}

private struct ActionRow: View {
    let title: String
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.body)
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.primary.opacity(isHovered ? 0.12 : 0))
                )
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }
}

final class CaretPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    func present(at point: CGPoint) {
        setFrame(frame(near: point), display: true)
        orderFrontRegardless()
        makeKey()
    }

    private func frame(near point: CGPoint) -> NSRect {
        let size = frame.size.width > 1 ? frame.size : CGSize(width: 280, height: 160)
        let screen = AXHelpers.screen(containing: point)
        let visible = screen?.visibleFrame ?? NSRect(origin: .zero, size: size)
        let margin: CGFloat = 12
        var origin = CGPoint(x: point.x + 16, y: point.y - size.height / 2)
        if origin.x + size.width > visible.maxX - margin {
            origin.x = point.x - size.width - 16
        }
        origin.x = min(max(origin.x, visible.minX + margin), visible.maxX - size.width - margin)
        origin.y = min(max(origin.y, visible.minY + margin), visible.maxY - size.height - margin)
        return NSRect(origin: origin, size: size)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var panel: CaretPanel?
    private var permissionPanel: NSPanel?
    private var model: Model?
    private var trustTimer: Timer?
    private var lastTarget: SelectionTarget?
    private var clickMonitor: Any?
    private var escapeMonitor: Any?
    private let hotKey = HotKeyManager()
    private let trigger = TriggerButtonController()
    private let monitor = SelectionMonitor()
    private let statusBar = StatusBarController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let model = Model()
        self.model = model

        let panel = CaretPanel(
            contentRect: NSRect(x: 0, y: 0, width: 280, height: 160),
            styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.isReleasedWhenClosed = false
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hidesOnDeactivate = false
        model.onRun = { [weak self] _ in
            self?.hidePanel()
        }
        let hosting = NSHostingView(rootView: ActionsView(model: model).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous)))
        hosting.sizingOptions = [.intrinsicContentSize]
        panel.contentView = hosting
        self.panel = panel

        statusBar.onOpen = { [weak self] in
            self?.togglePanel(at: NSEvent.mouseLocation)
        }
        statusBar.install()

        hotKey.onHotKey = { [weak self] point in
            Task { @MainActor in
                self?.togglePanel(at: point)
            }
        }
        hotKey.register()

        trigger.onClick = { [weak self] in
            guard let self else { return }
            self.togglePanel(at: CGPoint(x: self.trigger.buttonFrame.maxX, y: self.trigger.buttonFrame.midY))
        }

        monitor.onChange = { [weak self] target in
            Task { @MainActor in
                guard let self, let model = self.model else { return }
                self.lastTarget = target
                model.selectedText = target?.selectedText ?? ""
                model.sourceApp = target?.sourceApp
                if self.panel?.isVisible == true {
                    self.trigger.hide()
                } else {
                    self.trigger.update(target: target)
                }
            }
        }

        requestAccessibilityAndStart()
    }

    func togglePanel(at point: CGPoint) {
        if panel?.isVisible == true {
            hidePanel()
        } else {
            showPanel(at: point)
        }
    }

    private func showPanel(at point: CGPoint) {
        trigger.hide()
        panel?.present(at: point)
        installClickOutside()
    }

    private func hidePanel() {
        panel?.orderOut(nil)
        removeClickOutside()
        trigger.update(target: lastTarget)
    }

    private func installClickOutside() {
        removeClickOutside()
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            Task { @MainActor in
                self?.hidePanel()
            }
        }
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
            if event.keyCode == 53 {
                Task { @MainActor in
                    self?.hidePanel()
                }
                return nil
            }
            return event
        }
    }

    private func removeClickOutside() {
        if let clickMonitor {
            NSEvent.removeMonitor(clickMonitor)
            self.clickMonitor = nil
        }
        if let escapeMonitor {
            NSEvent.removeMonitor(escapeMonitor)
            self.escapeMonitor = nil
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        hotKey.unregister()
        monitor.stop()
        trustTimer?.invalidate()
        removeClickOutside()
    }

    private func requestAccessibilityAndStart() {
        AXHelpers.requestPermissions()
        if AXIsProcessTrusted() {
            monitor.start()
            return
        }
        showPermissionWindow()
        trustTimer?.invalidate()
        trustTimer = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: true) { [weak self] timer in
            guard AXIsProcessTrusted() else { return }
            timer.invalidate()
            Task { @MainActor in
                self?.trustTimer = nil
                self?.permissionPanel?.orderOut(nil)
                self?.permissionPanel = nil
                self?.monitor.start()
            }
        }
    }

    private func showPermissionWindow() {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 260),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        panel.title = "Caret"
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        panel.contentView = NSHostingView(rootView: PermissionView {
            AXHelpers.openAccessibilitySettings()
        })
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        permissionPanel = panel
    }
}

@main
struct CaretMain {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.setActivationPolicy(.accessory)
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}
