import AppKit
import CaretHostCore
import SwiftUI

/// What the writing checks draw over another app: an underline under each mark, and one panel
/// under the active mark that is the correction line, the open alternatives, or the result after
/// Tab or ⌘Z. Every panel is an `OverlayPanel`: click-through, never key, so keys keep going to
/// the field.
///
/// Motion (`animate` gate): the line appears at a sentence boundary, tens of times a day, so it
/// fades in over 120 ms with the shared ease-out and no movement; that keeps the line from popping
/// in under the text being read. Everything a key does (↓, ↑, ⌘1 to 3, Tab's result, ⌘Z's result)
/// redraws at once, and underlines never animate (`action-engine-v2.md` section 7). Typing takes
/// the line down in 80 ms and a timed-out result in 100 ms, as the other lines do. The fade is
/// opacity only, so Reduce Motion keeps it.
@MainActor
final class WritingOverlay {
    enum Role: String {
        case line, expanded, toast, error
    }

    /// Where the panel goes: under `under` (a line of text, or the caret), its left edge at `x`;
    /// above it when there is no room below.
    struct Placement: Equatable {
        /// Accessibility coordinates (global, top-left origin).
        var under: CGRect
        var x: CGFloat
        /// `bounds` (the error's own text rect) or `caret`.
        var anchoredBy: String
    }

    /// An underline: the mark's text rect, Accessibility coordinates.
    struct Underline: Equatable {
        var rect: CGRect
        var active: Bool
    }

    static let gap: CGFloat = 4
    static let fadeIn: TimeInterval = 0.12

    private var underlinePanels: [HostedPanel] = []
    private var shownUnderlines: [Underline] = []
    private let panel = HostedPanel(radius: 8)
    private(set) var role: Role?
    private(set) var placement: Placement?
    private var character: FigureCharacter { FigureSettings.shared.character }

    // MARK: - Underlines

    /// Draws exactly `underlines`, reusing panels; nothing moves when nothing changed.
    func showUnderlines(_ underlines: [Underline]) {
        guard underlines != shownUnderlines else { return }
        shownUnderlines = underlines
        while underlinePanels.count < underlines.count { underlinePanels.append(HostedPanel(radius: 0, material: false)) }
        for (i, panel) in underlinePanels.enumerated() {
            guard i < underlines.count else {
                panel.exit(duration: 0)
                continue
            }
            let u = underlines[i]
            panel.setContent(WritingMark(width: max(u.rect.width, 4), active: u.active).frame(width: max(u.rect.width, 4), height: 3))
            // The wave's top 2 pt above the line box's bottom: under the descenders, inside the
            // line's own leading.
            panel.pin(HostedPanel.Anchor(corner: .topLeft, point: Screen.cocoa(CGRect(x: u.rect.minX, y: u.rect.maxY - 2, width: 0, height: 0)).origin))
            panel.text = u.active ? "mark active" : "mark"
            panel.panel.alphaValue = 1
            panel.panel.orderFrontRegardless()
        }
    }

    func hideUnderlines() { showUnderlines([]) }

    // MARK: - The panel

    /// The correction line, or the open list when the offer is expanded. `entering` fades it in;
    /// a redraw after a key does not.
    func showOffer(_ offer: WritingOffer, at placement: Placement, entering: Bool) {
        let role: Role = offer.presentation == .expanded ? .expanded : .line
        switch role {
        case .expanded:
            panel.setContent(WritingAlternativesView(offer: offer))
            panel.text = "writing list"
        default:
            panel.setContent(CorrectionLineView(
                preview: offer.linePreview, hints: offer.lineHints, spoken: offer.spokenLine, character: character, choices: offer.lineChoices
            ))
            panel.text = "writing line"
        }
        place(placement, role: role, enteringFade: entering && !panel.isVisible)
    }

    /// A result line: after Tab (with ⌘Z Undo), after ⌘Z, or why nothing changed. At once: a key
    /// caused it.
    func showResult(_ content: LineContent, at placement: Placement, role: Role) {
        panel.setContent(LineView(content: content, character: character, animated: false))
        panel.text = role.rawValue
        place(placement, role: role, enteringFade: false)
    }

    func hidePanel(exit: TimeInterval) {
        role = nil
        placement = nil
        panel.exit(duration: exit)
    }

    func hideAll() {
        hideUnderlines()
        hidePanel(exit: 0)
    }

    private func place(_ placement: Placement, role: Role, enteringFade: Bool) {
        // A panel still fading out would be ordered out when its fade ends; end that fade now.
        if panel.panel.isVisible, !panel.isVisible { panel.exit(duration: 0) }
        self.role = role
        self.placement = placement
        let size = panel.size
        let screen = Screen.axVisibleFrame(around: placement.under)
        let x = min(max(placement.x, screen.minX + LinePlacement.margin), screen.maxX - LinePlacement.margin - size.width)
        let below = placement.under.maxY + Self.gap
        let anchor: HostedPanel.Anchor
        if below + size.height <= screen.maxY - LinePlacement.margin {
            anchor = HostedPanel.Anchor(corner: .topLeft, point: Screen.cocoa(CGRect(x: x, y: below, width: 0, height: 0)).origin)
        } else {
            // No room under the text: above it, the panel's bottom edge on the line's top.
            let above = placement.under.minY - Self.gap
            anchor = HostedPanel.Anchor(corner: .bottomLeft, point: Screen.cocoa(CGRect(x: x, y: above, width: 0, height: 0)).origin)
        }
        panel.pin(anchor)
        guard enteringFade else {
            panel.panel.alphaValue = 1
            panel.panel.orderFrontRegardless()
            return
        }
        panel.panel.alphaValue = 0
        panel.panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = Self.fadeIn
            context.timingFunction = Motion.caCurve(Motion.easeOut)
            panel.panel.animator().alphaValue = 1
        }
    }

    // MARK: - Debug

    func debugInfo() -> (underlines: [DebugState.Panel], panel: DebugState.Panel?) {
        (underlinePanels.compactMap { $0.debugInfo() }, panel.debugInfo())
    }
}
