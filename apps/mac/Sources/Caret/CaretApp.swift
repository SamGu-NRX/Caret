import AppKit
import ApplicationServices
import SwiftUI

struct MemoryItem: Identifiable {
    let id: String
    let text: String
    let sourceApp: String?
}

struct CaretAction: Identifiable, Equatable {
    let id: String
    let title: String
}

@MainActor
final class Model: ObservableObject {
    @Published var selectedText = ""
    @Published var sourceApp: String?
    @Published private(set) var pinStore: PinnedActionsStore

    var memories: [MemoryItem] = []
    var onRun: ((CaretAction) -> Void)?
    var onPinsChanged: (() -> Void)?

    let actions: [CaretAction] = [
        CaretAction(id: "book-flight", title: "Book flight"),
        CaretAction(id: "book-calendar-link", title: "Calendar link"),
        CaretAction(id: "revise", title: "Revise draft"),
        CaretAction(id: "summarize", title: "Summarize"),
        CaretAction(id: "translate", title: "Translate"),
        CaretAction(id: "follow-up", title: "Draft follow-up"),
        CaretAction(id: "extract-tasks", title: "Extract tasks"),
        CaretAction(id: "tone-polite", title: "Make polite"),
    ]

    init(pinStore: PinnedActionsStore = .load()) {
        self.pinStore = pinStore
    }

    func action(id: String) -> CaretAction? {
        actions.first { $0.id == id }
    }

    var pinnedActions: [CaretAction] {
        pinStore.orderedActionIDs.compactMap { action(id: $0) }
    }

    var pinnedChips: [PinnedActionChip] {
        pinnedActions.compactMap { action in
            guard let slot = pinStore.slot(for: action.id) else { return nil }
            return PinnedActionChip(id: action.id, title: action.title, slot: slot)
        }
    }

    func shortcutLabel(for action: CaretAction) -> String? {
        guard let slot = pinStore.slot(for: action.id) else { return nil }
        return PinnedShortcutFormatting.menuLabel(slot: slot)
    }

    func canPin(_ action: CaretAction) -> Bool {
        pinStore.isPinned(action.id) || pinStore.orderedActionIDs.count < PinnedActionsStore.maxPinned
    }

    func togglePin(_ action: CaretAction) {
        let changed = pinStore.togglePin(actionID: action.id)
        if changed || pinStore.isPinned(action.id) {
            pinStore.save()
            objectWillChange.send()
            onPinsChanged?()
        }
    }

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

    func runPinnedSlot(_ slot: Int) {
        guard let id = pinStore.actionID(forSlot: slot), let action = action(id: id) else { return }
        run(action)
    }
}

struct ActionsView: View {
    @ObservedObject var model: Model

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(model.actions) { action in
                ActionRow(
                    title: action.title,
                    shortcut: model.shortcutLabel(for: action),
                    isPinned: model.pinStore.isPinned(action.id),
                    canPin: model.canPin(action),
                    onPin: { model.togglePin(action) },
                    onRun: { model.run(action) }
                )
            }
        }
        .padding(.vertical, 4)
        .frame(width: 260)
    }
}

private struct ActionRow: View {
    let title: String
    let shortcut: String?
    let isPinned: Bool
    let canPin: Bool
    let onPin: () -> Void
    let onRun: () -> Void
    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 6) {
            Button(action: onRun) {
                HStack(spacing: 8) {
                    Text(title)
                        .font(.system(size: 13))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let shortcut {
                        Text(shortcut)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                }
                .padding(.leading, 12)
                .padding(.trailing, 8)
                .frame(maxWidth: .infinity, minHeight: 22, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button(action: onPin) {
                Image(systemName: isPinned ? "pin.fill" : "pin")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(isPinned ? Color.accentColor : .secondary)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!canPin && !isPinned)
            .help(isPinned ? "Unpin" : (canPin ? "Pin next to Caret icon" : "Unpin one action first (max 3)"))
            .padding(.trailing, 6)
        }
        .frame(height: 24)
        .background(
            Rectangle()
                .fill(Color.primary.opacity(isHovered ? 0.08 : 0))
        )
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
        model.onPinsChanged = { [weak self] in
            self?.syncPinnedTriggerUI()
        }
        let hosting = NSHostingView(rootView: ActionsView(model: model).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous)))
        hosting.sizingOptions = [.intrinsicContentSize]
        panel.contentView = hosting
        self.panel = panel

        statusBar.onOpen = { [weak self] in
            self?.togglePanel(at: NSEvent.mouseLocation)
        }
        statusBar.onFixAccessibility = { [weak self] in
            self?.showPermissionWindow()
        }
        statusBar.install()

        hotKey.onHotKey = { [weak self] point in
            Task { @MainActor in
                self?.togglePanel(at: point)
            }
        }
        hotKey.onPinnedHotKey = { [weak self] slot in
            Task { @MainActor in
                self?.runPinnedAction(slot: slot)
            }
        }
        hotKey.register()

        trigger.onClick = { [weak self] in
            guard let self else { return }
            self.togglePanel(at: CGPoint(x: self.trigger.buttonFrame.maxX, y: self.trigger.buttonFrame.midY))
        }
        trigger.onPinnedAction = { [weak self] chip in
            Task { @MainActor in
                self?.runPinnedAction(id: chip.id)
            }
        }

        syncPinnedTriggerUI()

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

    private func syncPinnedTriggerUI() {
        trigger.setPinnedActions(model?.pinnedChips ?? [])
        if panel?.isVisible != true {
            trigger.update(target: lastTarget)
        }
    }

    private func runPinnedAction(slot: Int) {
        guard let model else { return }
        model.runPinnedSlot(slot)
    }

    private func runPinnedAction(id: String) {
        guard let model, let action = model.action(id: id) else { return }
        model.run(action)
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
        if AXHelpers.isTrusted() {
            AccessibilityTrust.noteTrustedIfNeeded()
            monitor.start()
            return
        }

        if AccessibilityTrust.needsRepairPrompt() {
            showPermissionWindow()
        }

        trustTimer?.invalidate()
        trustTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] timer in
            guard AXHelpers.isTrusted() else { return }
            timer.invalidate()
            Task { @MainActor in
                AccessibilityTrust.noteTrustedIfNeeded()
                self?.trustTimer = nil
                self?.permissionPanel?.orderOut(nil)
                self?.permissionPanel = nil
                self?.monitor.start()
            }
        }
    }

    func showPermissionWindow() {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 320),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        panel.title = "Caret"
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        panel.contentView = NSHostingView(rootView: PermissionView(
            executablePath: AccessibilityTrust.executablePath,
            onOpenSettings: { AXHelpers.openAccessibilitySettings() },
            onDismiss: { [weak self] in
                AccessibilityTrust.dismissRepairPromptForCurrentBuild()
                self?.permissionPanel?.orderOut(nil)
                self?.permissionPanel = nil
            }
        ))
        panel.center()
        panel.makeKeyAndOrderFront(nil)
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
