import AppKit
import SwiftUI

enum CaretPillMetrics {
    static let sparkleSize = NSSize(width: 40, height: 40)
    static let pinChipHeight: CGFloat = 28
    static let pinChipMinWidth: CGFloat = 28
    static let pinChipMaxWidth: CGFloat = 120
    static let clusterSpacing: CGFloat = 6
}

struct PinnedActionChip: Identifiable, Equatable {
    let id: String
    let title: String
    let slot: Int
}

final class TriggerButtonController {
    var onClick: (() -> Void)?
    var onPinnedAction: ((PinnedActionChip) -> Void)?

    var buttonFrame: CGRect { panel.frame }

    private let panel = TriggerButtonPanel()
    private var lastRect: CGRect = .zero
    private var pinnedActions: [PinnedActionChip] = []

    init() {
        panel.contentView = makeHostingView()
        panel.setContentSize(CaretPillMetrics.sparkleSize)
    }

    func setPinnedActions(_ actions: [PinnedActionChip]) {
        pinnedActions = actions
        panel.contentView = makeHostingView()
        panel.layoutIfNeeded()
        if let size = panel.contentView?.fittingSize, size.width > 1 {
            panel.setContentSize(NSSize(width: size.width, height: max(size.height, CaretPillMetrics.sparkleSize.height)))
        }
    }

    private func makeHostingView() -> NSHostingView<TriggerClusterView> {
        let hosting = NSHostingView(
            rootView: TriggerClusterView(
                pinnedActions: pinnedActions,
                onPinnedTap: { [weak self] chip in
                    self?.onPinnedAction?(chip)
                },
                onSparkleTap: { [weak self] in
                    self?.onClick?()
                }
            )
        )
        hosting.sizingOptions = [.intrinsicContentSize]
        return hosting
    }

    func update(target: SelectionTarget?) {
        guard let target else {
            hide()
            return
        }

        let size = panel.frame.size.width > 1 ? panel.frame.size : CaretPillMetrics.sparkleSize
        let point = target.anchor
        var origin = CGPoint(x: point.x + 10, y: point.y - size.height / 2)
        var frame = CGRect(origin: origin, size: size)

        if let screen = AXHelpers.screen(containing: point) {
            if frame.maxX > screen.visibleFrame.maxX {
                origin.x = point.x - size.width - 10
            }
            frame = AXHelpers.clamp(CGRect(origin: origin, size: size), to: screen.visibleFrame)
        }

        if panel.isVisible, hypot(frame.midX - lastRect.midX, frame.midY - lastRect.midY) < 3 {
            return
        }

        lastRect = frame
        panel.setFrame(frame, display: true)
        panel.orderFrontRegardless()
    }

    func hide() {
        lastRect = .zero
        panel.orderOut(nil)
    }
}

final class TriggerButtonPanel: NSPanel {
    init() {
        super.init(
            contentRect: NSRect(origin: .zero, size: CaretPillMetrics.sparkleSize),
            styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        isReleasedWhenClosed = false
        isFloatingPanel = true
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = true
        animationBehavior = .none
        ignoresMouseEvents = false
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

struct TriggerClusterView: View {
    let pinnedActions: [PinnedActionChip]
    let onPinnedTap: (PinnedActionChip) -> Void
    let onSparkleTap: () -> Void

    private let blue = Color(red: 0.26, green: 0.52, blue: 0.98)

    var body: some View {
        HStack(spacing: CaretPillMetrics.clusterSpacing) {
            ForEach(pinnedActions) { chip in
                PinnedChipView(chip: chip, blue: blue) {
                    onPinnedTap(chip)
                }
            }
            TriggerButtonView(onClick: onSparkleTap)
        }
        .padding(.horizontal, 2)
        .padding(.vertical, 2)
    }
}

private struct PinnedChipView: View {
    let chip: PinnedActionChip
    let blue: Color
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Text(chip.title)
                .font(.system(size: 11, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(.white)
                .padding(.horizontal, 8)
                .frame(minWidth: CaretPillMetrics.pinChipMinWidth, maxWidth: CaretPillMetrics.pinChipMaxWidth)
                .frame(height: CaretPillMetrics.pinChipHeight)
                .background(
                    Capsule()
                        .fill(blue.opacity(isHovered ? 0.95 : 0.82))
                )
                .shadow(color: .black.opacity(0.12), radius: 4, y: 1)
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help("\(chip.title) (\(PinnedShortcutFormatting.menuLabel(slot: chip.slot)))")
    }
}

struct TriggerButtonView: View {
    let onClick: () -> Void
    @State private var isHovered = false

    private let blue = Color(red: 0.26, green: 0.52, blue: 0.98)

    var body: some View {
        Button(action: onClick) {
            Image(systemName: "sparkle")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(Circle().fill(blue.opacity(isHovered ? 1 : 0.96)))
                .shadow(color: .black.opacity(0.18), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help("Caret")
        .frame(width: 40, height: 40)
    }
}
