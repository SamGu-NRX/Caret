import AppCompatibility
import AppKit
import AutocompleteCore
import CaretHostCore
import CompletionUI
import MacContextCapture

/// KeyType's ghost-text renderer (`InlineGhostTextPresenter`) with KeyType's presentation rules:
/// inline at end of line, a capsule below the caret when text follows on the same line (ADR-048),
/// the TextKit mirror for `.textMirror` targets (ADR-091). A completion too wide for the caret's
/// line goes in the same capsule rather than nowhere (`GhostFit`).
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
    /// The last attempt to draw, shown or not, for the debug state.
    private(set) var lastFit: GhostFit.Record?
    private let overflow: GhostFit.OverflowRule

    init(compatibilityStore: AppCompatibilityStore, overflow: GhostFit.OverflowRule = .capsule) {
        self.compatibilityStore = compatibilityStore
        self.placementResolver = OverlayPlacementResolver(compatibilityStore: compatibilityStore)
        self.overflow = overflow
    }

    /// Shows `text` at the snapshot's caret. Nil when there is no usable placement, in which case
    /// nothing is on screen and `lastFit` says why.
    @discardableResult
    func show(_ text: String, at snapshot: FocusedFieldSnapshot, style: OverlayTextStyle) -> Presentation? {
        let live = snapshot.context
        guard !text.isEmpty else {
            lastFit = nil
            hide()
            return nil
        }
        guard var placement = placementResolver.placement(for: live) else {
            let cause: GhostFit.Cause = live.geometry.cursorRect == nil ? .noCaret : .resolverRefused
            lastFit = Self.record(.declined, cause, text: text, font: style.font, placement: nil, context: live)
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
        let decision = Self.decision(text, font: font, placement: placement, canMirror: canMirror, rule: overflow)
        switch decision {
        case .asPlaced: break
        case .capsule: placement.presentation = .capsule
        case .decline(let cause):
            lastFit = Self.record(.declined, cause, text: text, font: font, placement: placement, context: live)
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
            lastFit = Self.record(.declined, .windowDeclined, text: text, font: font, placement: placement, context: live)
            hide()
            return nil
        }
        let shown: Presentation = placement.presentation == .capsule ? .capsule : (canMirror ? .mirror : .inline)
        let outcome: GhostFit.Outcome = decision == .capsule ? .overflowCapsule : GhostFit.Outcome(rawValue: shown.rawValue) ?? .inline
        lastFit = Self.record(outcome, nil, text: text, font: font, placement: placement, context: live)
        presentation = shown
        shownText = text
        return shown
    }

    /// KeyType's two overflow tests, applied with Caret's rule for what overflows.
    static func decision(_ text: String, font: NSFont, placement: OverlayPlacement, canMirror: Bool, rule: GhostFit.OverflowRule) -> GhostFit.Decision {
        GhostFit.decide(
            inlineOverflows: GhostTextOverlayWindow.shouldSuppressInlineSingleLineOverflow(text: text, font: font, placement: placement),
            mirrorOverflows: GhostTextOverlayWindow.shouldSuppressMirrorOverflow(text: text, font: font, placement: placement),
            canMirror: canMirror, rule: rule
        )
    }

    private static func record(
        _ outcome: GhostFit.Outcome, _ cause: GhostFit.Cause?, text: String, font: NSFont?, placement: OverlayPlacement?,
        context: TextFieldContext
    ) -> GhostFit.Record {
        let font = font ?? .systemFont(ofSize: NSFont.systemFontSize)
        let width = (text as NSString).size(withAttributes: [.font: font]).width
        let caret = placement?.cursorRect ?? context.geometry.cursorRect
        let field = placement?.fieldRect ?? context.geometry.fieldRect
        let room: Double? = {
            guard let caret, let field, !field.isEmpty else { return nil }
            return Double(context.geometry.isRightToLeft ? caret.minX - field.minX : field.maxX - caret.maxX)
        }()
        return GhostFit.Record(
            outcome: outcome, cause: cause, textWidth: Double(ceil(width)), room: room,
            fieldHeight: field.map { Double($0.height) }, caretQuality: context.geometry.cursorRectQuality.rawValue
        )
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
