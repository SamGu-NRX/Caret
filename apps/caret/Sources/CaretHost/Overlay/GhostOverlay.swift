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
    /// What the capsule was drawn with, so typing through its head redraws the rest in place.
    private var capsuleShow: (placement: OverlayPlacement, style: OverlayTextStyle)?
    private let overflow: GhostFit.OverflowRule

    init(compatibilityStore: AppCompatibilityStore, overflow: GhostFit.OverflowRule = .capsule) {
        self.compatibilityStore = compatibilityStore
        self.placementResolver = OverlayPlacementResolver(compatibilityStore: compatibilityStore)
        self.overflow = overflow
    }

    /// Shows `text` at the snapshot's caret. Nil when there is no usable placement, in which case
    /// nothing is on screen and `lastFit` says why. `pid` owns the field: a capsule is drawn only
    /// where no other app's window lies over it.
    @discardableResult
    func show(_ text: String, at snapshot: FocusedFieldSnapshot, style: OverlayTextStyle, pid: Int32? = nil) -> Presentation? {
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
        case .capsule:
            placement.presentation = .capsule
            // KeyType hangs the capsule under the caret with no screen check; one that would fall
            // off the bottom of the display is not drawn, because an offer nobody can see must
            // not own Tab (A10 review).
            if !Self.capsuleFitsOnScreen(placement: placement, font: font) {
                lastFit = Self.record(.declined, .capsuleOffScreen, text: text, font: font, placement: placement, context: live)
                hide()
                return nil
            }
        case .decline(let cause):
            lastFit = Self.record(.declined, cause, text: text, font: font, placement: placement, context: live)
            hide()
            return nil
        }

        var capsuleAX: CGRect?
        if placement.presentation == .capsule {
            let kept = Self.keepCapsuleInWindow(&placement, text: text, font: font, window: snapshot.windowFrame, pid: pid)
            capsuleAX = kept.frame
            if let cause = kept.cause {
                lastFit = Self.record(.declined, cause, text: text, font: font, placement: placement, context: live, capsule: capsuleAX)
                hide()
                return nil
            }
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
        capsuleShow = shown == .capsule ? (placement, effective) : nil
        let outcome: GhostFit.Outcome = decision == .capsule ? .overflowCapsule : GhostFit.Outcome(rawValue: shown.rawValue) ?? .inline
        lastFit = Self.record(outcome, nil, text: text, font: font, placement: placement, context: live, capsule: capsuleAX)
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
        context: TextFieldContext, capsule: CGRect? = nil
    ) -> GhostFit.Record {
        let font = font ?? .systemFont(ofSize: NSFont.systemFontSize)
        let width = (text as NSString).size(withAttributes: [.font: font]).width
        let caret = placement?.cursorRect ?? context.geometry.cursorRect
        let field = placement?.fieldRect ?? context.geometry.fieldRect
        let room: Double? = {
            guard let caret, let field, !field.isEmpty else { return nil }
            return Double(context.geometry.isRightToLeft ? caret.minX - field.minX : field.maxX - caret.maxX)
        }()
        var record = GhostFit.Record(
            outcome: outcome, cause: cause, textWidth: Double(ceil(width)), room: room,
            fieldHeight: field.map { Double($0.height) }, caretQuality: context.geometry.cursorRectQuality.rawValue
        )
        record.capsule = capsule.map { [$0.minX, $0.minY, $0.width, $0.height].map(Double.init) }
        return record
    }

    /// Redraws the ghost text without its head right after the user typed it, before the AX
    /// snapshot arrives (ADR-054). KeyType's advance skips capsules, so the capsule is redrawn
    /// here with the rest, where it stands; otherwise it would show text Tab no longer inserts.
    func advance(typed: String, remainder: String) {
        guard shownText != nil else { return }
        if presentation == .capsule, let capsuleShow {
            guard !remainder.isEmpty else { return hide() }
            presenter.show(candidate: CompletionCandidate(text: remainder, mode: .prose), placement: capsuleShow.placement,
                           style: capsuleShow.style, mirrorContext: nil)
            shownText = remainder
            return
        }
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
        capsuleShow = nil
    }

    /// The capsule stays inside the focused window and off other apps' windows (A18, bug 6). Its
    /// field is clamped to the window first, so KeyType's layout slides it left to fit; what still
    /// leaves the window, or lies under another app's window, is not drawn, and neither is one whose
    /// window's frame is unknown. The cause is nil when it may be drawn; the frame (global
    /// top-left) is where it was laid out.
    static func keepCapsuleInWindow(_ placement: inout OverlayPlacement, text: String, font: NSFont, window: CGRect?, pid: Int32?) -> (cause: GhostFit.Cause?, frame: CGRect?) {
        guard let window, !window.isEmpty else { return (.capsuleNoWindow, nil) }
        let field = placement.fieldRect.map { $0.intersection(window) }
        placement.fieldRect = field.flatMap { $0.isNull || $0.isEmpty ? nil : $0 } ?? window
        let width = (text as NSString).size(withAttributes: [.font: font]).width
        let approximate = placement.cursorRectQuality == .derived || placement.cursorRectQuality == .estimated
        let laid = GhostFit.capsuleFrame(
            caret: placement.cursorRect, field: placement.fieldRect, textWidth: width,
            fontLineHeight: ceil(font.ascender - font.descender), approximateCaret: approximate
        )
        let frame = laid.frame.offsetBy(dx: CGFloat(placement.horizontalOffset), dy: -CGFloat(placement.verticalOffset(Double(laid.lineHeight))))
        let ax = Screen.ax(frame)
        if let cause = GhostFit.capsuleCause(frame: frame, window: window) { return (cause, ax) }
        guard let pid else { return (nil, ax) }
        let points = [CGPoint(x: ax.minX + 1, y: ax.minY + 1), CGPoint(x: ax.maxX - 1, y: ax.minY + 1),
                      CGPoint(x: ax.minX + 1, y: ax.maxY - 1), CGPoint(x: ax.maxX - 1, y: ax.maxY - 1), CGPoint(x: ax.midX, y: ax.midY)]
        let windows = Visibility.windows()
        let own = ProcessInfo.processInfo.processIdentifier
        let displays = NSScreen.screens.map { Screen.ax($0.frame) }
        let fieldAX = Screen.ax(placement.fieldRect ?? window)
        for point in points where SurfaceGate.topPID(at: point, windows: windows, ownPID: own, displays: displays, field: fieldAX) != pid {
            return (.capsuleCovered, ax)
        }
        return (nil, ax)
    }

    /// The capsule's bottom stays above the bottom of the caret's display. Its height is KeyType's
    /// (`capsuleLayout`: the line plus 4 pt above and below, 5 pt under the caret); the placement
    /// is in AppKit coordinates, where below means a smaller y.
    static func capsuleFitsOnScreen(placement: OverlayPlacement, font: NSFont, screens: [CGRect] = NSScreen.screens.map(\.visibleFrame)) -> Bool {
        let caret = placement.cursorRect
        let line = max(ceil(font.ascender - font.descender), min(caret.height, 48))
        let bottom = caret.minY - 5 - (line + 8)
        guard let screen = screens.first(where: { $0.contains(CGPoint(x: caret.midX, y: caret.midY)) }) else { return false }
        return bottom >= screen.minY
    }
}
