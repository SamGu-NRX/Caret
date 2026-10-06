import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

/// The screen side of `PageTaskMachine` (brief H11): draws the page task panel at the form, moves it as the
/// machine says, and sends what its keys took. Every decision is the machine's and is tested there
/// (`PageTaskTests`); this class only carries the commands out.
@MainActor
final class PageTaskCoordinator {
    let machine: PageTaskMachine
    private let status: HostStatus
    private let panel = HostedPanel(radius: Tokens.Shape.popupRadius, popup: true)
    private let model = PageTaskModel()
    private let drawsOnScreen: Bool
    private var placed = false
    private var announced = ""
    private var activationObserver: NSObjectProtocol?
    var client: HelperClient?
    /// The panel's toast took the arbiter's slot from another surface's.
    var onToastTaken: (() -> Void)?

    init(arbiter: OfferArbiter, status: HostStatus, drawsOnScreen: Bool) {
        self.status = status
        self.drawsOnScreen = drawsOnScreen
        machine = PageTaskMachine(arbiter: arbiter, clock: RunLoopClock())
        machine.output = { [weak self] command in MainActor.assumeIsolated { self?.perform(command) } }
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            let pid = app.processIdentifier
            MainActor.assumeIsolated { self?.machine.appActivated(pid: pid) }
        }
    }

    func shutdown() {
        if let activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(activationObserver) }
        activationObserver = nil
        panel.exit(duration: 0)
    }

    private func perform(_ command: PageTaskCommand) {
        switch command {
        case .draw(let content, let motion, let anchor): draw(content, motion: motion, anchor: anchor)
        case .hide(let motion):
            placed = false
            // A panel shown again is announced again, even with the same words (prep-for-prod H11-5).
            announced = ""
            panel.exit(duration: motion == .exit ? Motion.Duration.toastExit : 0)
        case .send(.accept(let accept)):
            if client?.send(accept) != true { status.increment("pageTask.acceptUnsent") }
        case .send(.control(let control)):
            if client?.send(control) != true { status.increment("pageTask.controlUnsent") }
        case .count(let name): status.increment(name)
        case .toastTaken: onToastTaken?()
        }
    }

    private func draw(_ content: PageTaskPanel, motion: PageTaskMotion, anchor: PageTaskAnchor) {
        let reduce = Motion.reduceMotion
        let first = !placed || !panel.isVisible
        switch motion {
        case .reveal where !first:
            withAnimation(Motion.curve(Motion.easeOut, reduce ? Motion.Duration.reduced : Motion.Duration.enter)) { model.animated = true; model.panel = content }
        case .crossfade where !first:
            withAnimation(Motion.curve(Motion.easeOut, reduce ? Motion.Duration.reduced : Self.crossfade)) { model.animated = true; model.panel = content }
        default:
            var t = Transaction()
            t.disablesAnimations = true
            withTransaction(t) {
                model.animated = motion != .none
                model.panel = content
            }
        }
        panel.text = content.spoken
        guard drawsOnScreen else { return }
        let character = FigureSettings.shared.character
        let view = PageTaskLiveView(model: model, character: character, animated: !reduce)
        if first {
            let size = panel.measure(PageTaskView(panel: content, character: character, animated: false))
            // Placed once, beside the form's first field or at the page's top edge; it stays there for the task.
            let screen = Screen.axVisibleFrame(around: anchor.field ?? anchor.viewport ?? CGRect(x: 0, y: 0, width: 1, height: 1))
            let spot = PageTaskPlacement.place(size: size, anchor: anchor, screen: screen)
            let topLeft = Screen.cocoa(CGRect(origin: spot.origin, size: CGSize(width: 1, height: 1)))
            panel.pin(HostedPanel.Anchor(corner: .topLeft, point: NSPoint(x: topLeft.minX, y: topLeft.maxY)))
            placed = true
        }
        panel.setContent(view)
        if first || motion == .enter { panel.enter(scales: false, rises: true) }
        // VoiceOver hears the panel's sentence and keys when they change, not each row as it resolves.
        if content.announcement != announced {
            announced = content.announcement
            AccessibilityNotification.Announcement(content.announcement).post()
        }
    }

    /// UI moment 5: the next page's content crosses over 200 ms.
    static let crossfade: Double = 0.2
}
