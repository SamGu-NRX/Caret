import AppKit
import SwiftUI

enum CaretPillMetrics {
    static let sparkleSize = NSSize(width: 40, height: 40)
    static let clusterHeight: CGFloat = 40
    static let pinIconCellWidth: CGFloat = 36
    static let clusterSpacing: CGFloat = 4
    static let stripCornerRadius: CGFloat = clusterHeight / 2
}

enum TriggerButtonGeometry {
    static func frame(avoiding textRect: CGRect, size: CGSize, visibleFrame: CGRect) -> CGRect? {
        guard !textRect.isNull, !textRect.isInfinite,
              size.width > 0, size.height > 0,
              size.width <= visibleFrame.width, size.height <= visibleFrame.height else { return nil }
        // Keep the entire cluster, including its shadow, out of the editable field.
        let protected = textRect.standardized.insetBy(dx: -8, dy: -8)
        let candidates = [
            CGPoint(x: protected.maxX, y: textRect.midY - size.height / 2),
            CGPoint(x: protected.minX - size.width, y: textRect.midY - size.height / 2),
            CGPoint(x: textRect.maxX - size.width, y: protected.minY - size.height),
            CGPoint(x: textRect.maxX - size.width, y: protected.maxY)
        ]
        for origin in candidates {
            let clamped = CGPoint(
                x: min(max(origin.x, visibleFrame.minX), visibleFrame.maxX - size.width),
                y: min(max(origin.y, visibleFrame.minY), visibleFrame.maxY - size.height)
            )
            let frame = CGRect(origin: clamped, size: size)
            if !frame.intersects(protected) { return frame }
        }
        // Clamping into a full-screen editor would cover text. Leave its shortcuts available.
        return nil
    }
}

struct PinnedActionChip: Identifiable, Equatable {
    let id: String
    let title: String
    let icon: String
    let slot: Int
}

final class TriggerButtonController {
    var onClick: (() -> Void)?
    var onPinnedAction: ((PinnedActionChip) -> Void)?

    var buttonFrame: CGRect { panel.frame }

    private let panel = TriggerButtonPanel()
    private var lastRect: CGRect = .zero
    private var lastTarget: SelectionTarget?
    private var pinnedActions: [PinnedActionChip] = []
    private weak var chordState: ModifierChordState?

    init(chordState: ModifierChordState) {
        self.chordState = chordState
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
        if let lastTarget { update(target: lastTarget) }
    }

    private func makeHostingView() -> NSHostingView<TriggerClusterView> {
        let hosting = NSHostingView(
            rootView: TriggerClusterView(
                pinnedActions: pinnedActions,
                chordState: chordState!,
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

        lastTarget = target
        let size = panel.frame.size.width > 1 ? panel.frame.size : CaretPillMetrics.sparkleSize
        var protected = target.screenRect
        var hasFieldBounds = false
        // A caret can be zero-width. Its mouse fallback is not a safe placement anchor.
        // The focused field also reserves space for text and selected inline completions.
        if let app = NSWorkspace.shared.frontmostApplication,
           app.processIdentifier == target.focusedProcessID,
           let element = AXHelpers.focusedTextElement(in: app),
           let field = AXHelpers.frame(element) {
            protected = protected.union(field)
            hasFieldBounds = true
        }
        let point = CGPoint(x: protected.midX, y: protected.midY)
        guard let screen = AXHelpers.screen(containing: point) else {
            panel.orderOut(nil)
            return
        }
        if !hasFieldBounds {
            guard protected.height > 2 else {
                panel.orderOut(nil)
                return
            }
            // Without field bounds, reserve the whole line for an inline completion.
            protected = CGRect(x: screen.visibleFrame.minX, y: protected.minY,
                               width: screen.visibleFrame.width, height: protected.height)
        }
        guard let frame = TriggerButtonGeometry.frame(avoiding: protected, size: size, visibleFrame: screen.visibleFrame)
        else {
            panel.orderOut(nil)
            lastRect = .zero
            return
        }

        if panel.isVisible, frame == lastRect { return }

        lastRect = frame
        panel.setFrame(frame, display: true)
        panel.orderFrontRegardless()
    }

    func hide() {
        lastTarget = nil
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
    @ObservedObject var chordState: ModifierChordState
    let onPinnedTap: (PinnedActionChip) -> Void
    let onSparkleTap: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: CaretPillMetrics.clusterSpacing) {
            TriggerButtonView(onClick: onSparkleTap)
            if !pinnedActions.isEmpty {
                PinnedGlassStrip(actions: pinnedActions, chordState: chordState, onTap: onPinnedTap)
            }
        }
        .frame(height: CaretPillMetrics.clusterHeight)
    }
}

private struct PinnedGlassStrip: View {
    let actions: [PinnedActionChip]
    @ObservedObject var chordState: ModifierChordState
    let onTap: (PinnedActionChip) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(actions.enumerated()), id: \.element.id) { index, chip in
                if index > 0 {
                    Rectangle()
                        .fill(.primary.opacity(0.12))
                        .frame(width: 1, height: 14)
                }
                PinnedStripCell(
                    chip: chip,
                    showShortcut: chordState.commandOptionHeld,
                    isFirst: index == 0,
                    isLast: index == actions.count - 1
                ) {
                    onTap(chip)
                }
            }
        }
        .frame(height: CaretPillMetrics.clusterHeight)
        .caretGlassCapsule()
    }
}

private struct PinnedStripCell: View {
    let chip: PinnedActionChip
    let showShortcut: Bool
    let isFirst: Bool
    let isLast: Bool
    let action: () -> Void
    @State private var isHovered = false

    private var hoverShape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: isFirst ? CaretPillMetrics.stripCornerRadius : 0,
            bottomLeadingRadius: isFirst ? CaretPillMetrics.stripCornerRadius : 0,
            bottomTrailingRadius: isLast ? CaretPillMetrics.stripCornerRadius : 0,
            topTrailingRadius: isLast ? CaretPillMetrics.stripCornerRadius : 0,
            style: .continuous
        )
    }

    var body: some View {
        Button(action: action) {
            Group {
                if showShortcut {
                    Text(PinnedShortcutFormatting.menuLabel(slot: chip.slot))
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                } else {
                    Image(systemName: chip.icon)
                        .font(.system(size: 14, weight: .semibold))
                        .symbolRenderingMode(.hierarchical)
                }
            }
            .foregroundStyle(.primary)
            // Keyboard hints must appear immediately when the modifier chord changes.
            .frame(width: showShortcut ? 44 : CaretPillMetrics.pinIconCellWidth)
            .padding(.horizontal, showShortcut ? 6 : 4)
            .frame(maxHeight: .infinity)
                .background {
                    if isHovered {
                        hoverShape.fill(Color.primary.opacity(0.1))
                    }
                }
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .accessibilityLabel(chip.title)
        .accessibilityHint("Opens actions for \(chip.title)")
        .help("\(chip.title) (\(PinnedShortcutFormatting.menuLabel(slot: chip.slot)))")
    }
}

private extension View {
    @ViewBuilder
    func caretGlassCapsule() -> some View {
        // `#available` is runtime-only. Xcode 16 still type-checks glassEffect
        // and fails. The modifier exists on Swift 6.2+ / Xcode 26 SDKs.
#if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            glassEffect(.regular.interactive(), in: .capsule)
        } else {
            caretMaterialCapsule()
        }
#else
        caretMaterialCapsule()
#endif
    }

    func caretMaterialCapsule() -> some View {
        background(Capsule(style: .continuous).fill(.ultraThinMaterial))
            .overlay {
                Capsule(style: .continuous)
                    .strokeBorder(.primary.opacity(0.08), lineWidth: 0.5)
            }
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
        .accessibilityLabel("Open Caret actions")
        .help("Open Caret actions")
        .frame(width: 40, height: 40)
    }
}
