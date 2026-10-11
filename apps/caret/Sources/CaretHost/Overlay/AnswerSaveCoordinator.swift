import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

/// The screen side of `AnswerSaveMachine`: the quiet save line under the page field the user is in, as a
/// slip (DIRECTION.md 5.3). Every decision is the machine's (`AnswerSaveTests`).
@MainActor
final class AnswerSaveCoordinator {
    let machine: AnswerSaveMachine
    private let status: HostStatus
    private let panel = HostedPanel(radius: Tokens.Shape.slipRadius)
    private let drawsOnScreen: Bool
    var client: HelperClient?

    init(arbiter: OfferArbiter, status: HostStatus, drawsOnScreen: Bool) {
        self.status = status
        self.drawsOnScreen = drawsOnScreen
        machine = AnswerSaveMachine(arbiter: arbiter, clock: RunLoopClock())
        machine.output = { [weak self] command in MainActor.assumeIsolated { self?.perform(command) } }
    }

    /// The helper's offer, under the field the page says has focus now.
    func receive(_ offer: AnswerSaveOffer) {
        machine.receive(offer, focus: PageFocusSource.book.field(windowId: offer.windowId))
    }

    func shutdown() { panel.exit(duration: 0) }

    private func perform(_ command: AnswerSaveMachine.Command) {
        switch command {
        case .draw(let content, let field, let enters, let keyed):
            panel.text = content.text
            guard drawsOnScreen else { return }
            let view = LineView(content: content, character: FigureSettings.shared.character, animated: !keyed && !Motion.reduceMotion)
            let size = panel.measure(view)
            // Under the field, its left edge where a slip's figure stands under the field's start.
            let screen = Screen.axVisibleFrame(around: field)
            let x = min(max(field.minX - FieldPanelPlacement.caretInset, screen.minX + FieldPanelPlacement.margin), screen.maxX - FieldPanelPlacement.margin - size.width)
            let below = field.maxY + FieldPanelPlacement.gap
            let y = below + size.height <= screen.maxY - FieldPanelPlacement.margin ? below : field.minY - FieldPanelPlacement.gap - size.height
            let corner = Screen.cocoa(CGRect(x: x, y: y, width: 1, height: 1))
            panel.pin(HostedPanel.Anchor(corner: .topLeft, point: NSPoint(x: corner.minX, y: corner.maxY)))
            panel.setContent(view)
            if enters || !panel.isVisible { panel.enter() }
            // The sentence and its keys together: the panel takes no focus, so its hints are heard only here.
            AccessibilityNotification.Announcement(SlipSpeech.line(content)).post()
        case .hide(let fade): panel.exit(duration: fade)
        case .send(let save):
            if client?.send(save) != true { status.increment("answerSave.unsent") }
        case .count(let name): status.increment(name)
        }
    }
}
