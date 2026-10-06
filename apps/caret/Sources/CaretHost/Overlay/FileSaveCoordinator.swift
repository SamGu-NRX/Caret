import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

/// The screen side of `FileSaveMachine` (brief H14): the quiet line offering to keep a file the user attached, as a
/// slip under the page task panel it follows, left edges aligned. Every decision is the machine's (`FileSaveTests`).
@MainActor
final class FileSaveCoordinator {
    let machine: FileSaveMachine
    private let status: HostStatus
    private let panel = HostedPanel(radius: Tokens.Shape.slipRadius)
    private let drawsOnScreen: Bool
    var client: HelperClient?
    /// Where the page task panel stands now, or last stood (global, top-left points).
    var pageFrame: () -> CGRect? = { nil }
    /// The helper kept a file: the memory window's list is read again.
    var onSaved: () -> Void = {}

    /// The gap between the page task panel and the line under it: a slip's gap under its field.
    static let gap = FieldPanelPlacement.gap

    init(arbiter: OfferArbiter, status: HostStatus, drawsOnScreen: Bool) {
        self.status = status
        self.drawsOnScreen = drawsOnScreen
        machine = FileSaveMachine(arbiter: arbiter, clock: RunLoopClock())
        machine.output = { [weak self] command in MainActor.assumeIsolated { self?.perform(command) } }
    }

    func shutdown() { panel.exit(duration: 0) }

    private func perform(_ command: FileSaveMachine.Command) {
        defer {
            let info = DebugState.FileSaveInfo(phase: machine.phase.rawValue, panel: panel.debugInfo())
            status.update { $0.fileSave = info }
        }
        switch command {
        case .draw(let content, let enters, let keyed):
            panel.text = content.text
            guard drawsOnScreen, let page = pageFrame() else { return }
            let view = LineView(content: content, character: FigureSettings.shared.character, animated: !keyed && !Motion.reduceMotion)
            let size = panel.measure(view)
            let screen = Screen.axVisibleFrame(around: page)
            let x = min(max(page.minX, screen.minX + FieldPanelPlacement.margin), screen.maxX - FieldPanelPlacement.margin - size.width)
            let below = page.maxY + Self.gap
            let y = below + size.height <= screen.maxY - FieldPanelPlacement.margin ? below : page.minY - Self.gap - size.height
            let corner = Screen.cocoa(CGRect(x: x, y: y, width: 1, height: 1))
            panel.pin(HostedPanel.Anchor(corner: .topLeft, point: NSPoint(x: corner.minX, y: corner.maxY)))
            panel.setContent(view)
            if enters || !panel.isVisible { panel.enter() }
            // The sentence and its keys together: the panel takes no focus, so its hints are heard only here.
            AccessibilityNotification.Announcement(SlipSpeech.line(content)).post()
        case .hide(let fade): panel.exit(duration: fade)
        case .send(let save):
            if client?.send(save) != true { status.increment("fileSave.unsent") }
        case .saved: onSaved()
        case .count(let name): status.increment(name)
        }
    }
}
