import AppCompatibility
import AppKit
import AutocompleteCore
import CompletionUI
import MacContextCapture

/// KeyType's ghost-text renderer (`InlineGhostTextPresenter`) with KeyType's presentation rules:
/// inline at end of line, a capsule below the caret when text follows on the same line (ADR-048),
/// the TextKit mirror for `.textMirror` targets (ADR-091), and the mirror-overflow suppression.
///
/// `hide` is synchronous: it orders the panel out on the call, so a dismissal posted from the tap
/// reaches the screen on the main thread's next turn, ahead of the AX snapshot for that key
/// (ADR-037).
@MainActor
final class GhostOverlay {
    enum Presentation: String {
        case inline
        case capsule
        case mirror
    }

    private let presenter = InlineGhostTextPresenter()
    private let placementResolver: OverlayPlacementResolver
    private let compatibilityStore: AppCompatibilityStore
    private(set) var presentation: Presentation?
    private(set) var shownText: String?

    init(compatibilityStore: AppCompatibilityStore) {
        self.compatibilityStore = compatibilityStore
        self.placementResolver = OverlayPlacementResolver(compatibilityStore: compatibilityStore)
    }

    /// Shows `text` at the snapshot's caret. Nil when there is no usable placement, in which case
    /// nothing is on screen.
    @discardableResult
    func show(_ text: String, at snapshot: FocusedFieldSnapshot, style: OverlayTextStyle) -> Presentation? {
        let live = snapshot.context
        guard !text.isEmpty, var placement = placementResolver.placement(for: live) else {
            hide()
            return nil
        }
        if placement.mode == .inline, GhostTextEngine.shouldUseCapsule(for: live) {
            placement.presentation = .capsule
        }
        let policy = compatibilityStore.policy(for: live)
        var effective = style
        if effective.font == nil, let fallback = policy.overlayFontFallback {
            switch fallback.design {
            case .monospaced:
                effective.font = NSFont.monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
            }
            placement.fontSizeAdjustmentFactor *= fallback.sizeAdjustmentFactor
        }

        let mirrorContext: TextMirrorOverlayContext?
        if placement.mode == .mirror, placement.presentation == .inlineGhost, placement.fieldRect?.isEmpty == false {
            mirrorContext = TextMirrorOverlayContext(beforeCursor: live.beforeCursor, afterCursor: live.afterCursor)
        } else {
            mirrorContext = nil
        }
        let canMirror = GhostTextOverlayWindow.canUseTextMirror(placement: placement, mirrorContext: mirrorContext)
        let font = InlineGhostTextPresenter.resolveFont(effective.font, placement: placement)
        if !canMirror, GhostTextOverlayWindow.shouldSuppressMirrorOverflow(text: text, font: font, placement: placement) {
            hide()
            return nil
        }

        presenter.show(
            candidate: CompletionCandidate(text: text, mode: .prose),
            placement: placement,
            style: effective,
            mirrorContext: mirrorContext
        )
        // The window can decline to draw (for example single-line overflow). The caller must then
        // withdraw the offer, so report what is really on screen.
        guard presenter.isVisible else {
            hide()
            return nil
        }
        let shown: Presentation = placement.presentation == .capsule ? .capsule : (canMirror ? .mirror : .inline)
        presentation = shown
        shownText = text
        return shown
    }

    /// Redraws the inline ghost text without its head right after the user typed it, before the AX
    /// snapshot arrives (ADR-054). No-op for capsule and mirror presentations.
    func advance(typed: String, remainder: String) {
        guard shownText != nil else { return }
        presenter.advanceAfterAccepting(
            head: typed,
            remainder: remainder.isEmpty ? nil : CompletionCandidate(text: remainder, mode: .prose)
        )
        shownText = remainder.isEmpty ? nil : remainder
        if remainder.isEmpty { presentation = nil }
    }

    func hide() {
        presenter.hide()
        presentation = nil
        shownText = nil
    }
}
