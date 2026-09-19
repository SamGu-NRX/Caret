import AppKit
import SwiftUI

enum CaretPillMetrics {
    static let size = NSSize(width: 40, height: 40)
}

final class TriggerButtonController {
    var onClick: (() -> Void)?

    var buttonFrame: CGRect { panel.frame }

    private let panel = TriggerButtonPanel()
    private var lastRect: CGRect = .zero

    init() {
        let hosting = NSHostingView(
            rootView: TriggerButtonView { [weak self] in
                self?.onClick?()
            }
        )
        hosting.sizingOptions = [.intrinsicContentSize]
        panel.contentView = hosting
        panel.setContentSize(CaretPillMetrics.size)
    }

    func update(target: SelectionTarget?) {
        guard let target else {
            hide()
            return
        }

        let size = CaretPillMetrics.size
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
            contentRect: NSRect(origin: .zero, size: CaretPillMetrics.size),
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
