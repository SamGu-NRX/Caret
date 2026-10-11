import AppCompatibility
import AppKit
import AutocompleteCore
import CaretHostCore
import CompletionUI
import MacContextCapture

/// KeyType's ghost-text renderer (`InlineGhostTextPresenter`) with KeyType's presentation rules:
/// inline at end of line, a capsule off the caret's line when text follows on the same line
/// (ADR-048), the TextKit mirror for `.textMirror` targets (ADR-091). A completion too wide for the
/// caret's line goes in the same capsule rather than nowhere (`GhostFit`). Caret, not KeyType, says
/// where the capsule goes (`CaretLinePlacement`): below the caret's line, else above it.
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
    /// What the capsule was drawn with, so typing through its head places the rest again by the
    /// same rule: the placement before `keepCapsuleInWindow` set its offsets, and the areas' inputs.
    private var capsuleShow: CapsuleShow?

    private struct CapsuleShow {
        var base: OverlayPlacement
        var drawn: OverlayPlacement
        var style: OverlayTextStyle
        var font: NSFont
        var window: CGRect?
        var viewport: CGRect?
    }
    private let overflow: GhostFit.OverflowRule

    init(compatibilityStore: AppCompatibilityStore, overflow: GhostFit.OverflowRule = .capsule) {
        self.compatibilityStore = compatibilityStore
        self.placementResolver = OverlayPlacementResolver(compatibilityStore: compatibilityStore)
        self.overflow = overflow
    }

    /// Shows `text` at the snapshot's caret. Nil when there is no usable placement, in which case
    /// nothing is on screen and `lastFit` says why. `pid` owns the field: a capsule is drawn only
    /// where no other app's window lies over it.
    ///
    /// `capsule`: the caller already found the text does not fit inline (alternatives,
    /// `SurfaceMachine.presentation`), so it goes in the capsule whatever KeyType would choose.
    /// `viewport`: reads the field's visible text area, global top-left points
    /// (`AXRead.visibleFrame`); the capsule stays inside it when it can. Asked only for a capsule,
    /// because it walks the element's ancestors and ghost text is drawn on every key.
    @discardableResult
    func show(_ text: String, at snapshot: FocusedFieldSnapshot, style: OverlayTextStyle, pid: Int32? = nil,
              capsule forced: Bool = false, viewport: () -> CGRect? = { nil }) -> Presentation? {
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
        let decision = forced ? .capsule : Self.decision(text, font: font, placement: placement, canMirror: canMirror, rule: overflow)
        switch decision {
        case .asPlaced: break
        case .capsule: placement.presentation = .capsule
        case .decline(let cause):
            lastFit = Self.record(.declined, cause, text: text, font: font, placement: placement, context: live)
            hide()
            return nil
        }

        var capsuleAX: CGRect?
        var drawnText = text
        var side: CaretLinePlacement.Side?
        let base = placement
        var viewportCocoa: CGRect?
        if placement.presentation == .capsule {
            viewportCocoa = viewport().map(Screen.cocoa)
            let kept = Self.keepCapsuleInWindow(&placement, text: text, font: font, window: snapshot.windowFrame, pid: pid, viewport: viewportCocoa)
            capsuleAX = kept.frame
            if let cause = kept.cause {
                lastFit = Self.record(.declined, cause, text: text, font: font, placement: placement, context: live, capsule: capsuleAX)
                hide()
                return nil
            }
            drawnText = kept.text
            side = kept.side
        }

        presenter.show(
            candidate: CompletionCandidate(text: drawnText, mode: .prose),
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
        capsuleShow = shown == .capsule
            ? CapsuleShow(base: base, drawn: placement, style: effective, font: font, window: snapshot.windowFrame, viewport: viewportCocoa)
            : nil
        let outcome: GhostFit.Outcome = decision == .capsule ? .overflowCapsule : GhostFit.Outcome(rawValue: shown.rawValue) ?? .inline
        lastFit = Self.record(outcome, nil, text: text, font: font, placement: placement, context: live, capsule: capsuleAX)
        lastFit?.capsuleSide = side?.rawValue
        if drawnText != text { lastFit?.truncated = true }
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
    /// here with the rest, placed again by the same rule; otherwise it would show text Tab no
    /// longer inserts. The rest is narrower than the whole, centered on the same caret and on the
    /// same side, so it lies inside the frame already checked against other apps' windows; that
    /// check is not repeated on this key. If the rule finds no spot all the same, the capsule
    /// stays where it stood.
    func advance(typed: String, remainder: String) {
        guard shownText != nil else { return }
        if presentation == .capsule, var show = capsuleShow {
            guard !remainder.isEmpty else { return hide() }
            var placement = show.base
            let kept = Self.keepCapsuleInWindow(&placement, text: remainder, font: show.font, window: show.window, pid: nil, viewport: show.viewport)
            if kept.cause == nil { show.drawn = placement }
            presenter.show(candidate: CompletionCandidate(text: kept.cause == nil ? kept.text : remainder, mode: .prose), placement: show.drawn,
                           style: show.style, mirrorContext: nil)
            capsuleShow = show
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

    /// Where the capsule goes, by the caret-line rule (`CaretLinePlacement`): below the caret's
    /// line, else above it, inside the visible text area (`viewport`) when it has room, else inside
    /// the window, always on the caret's display. It sets the placement's offsets so KeyType's own
    /// layout lands on that spot, and returns the text to show there: `text`, or a shortened one
    /// when the capsule had to be narrowed to the area (Tab still takes the whole text).
    ///
    /// What lies under another app's window is not drawn (A18, bug 6: Q1's capsule drew past
    /// TextEdit's right edge, over other apps), and neither is a capsule whose window's frame is
    /// unknown. The cause is nil when it may be drawn; the frame (global top-left) is where it was
    /// laid out. `window`, `viewport`, `displays` and the placement are AppKit coordinates.
    static func keepCapsuleInWindow(
        _ placement: inout OverlayPlacement, text: String, font: NSFont, window: CGRect?, pid: Int32?, viewport: CGRect? = nil,
        displays: [CGRect] = NSScreen.screens.map(\.visibleFrame)
    ) -> (cause: GhostFit.Cause?, frame: CGRect?, text: String, side: CaretLinePlacement.Side?) {
        guard let window, !window.isEmpty else { return (.capsuleNoWindow, nil, text, nil) }
        let approximate = placement.cursorRectQuality == .derived || placement.cursorRectQuality == .estimated
        let fontLine = ceil(font.ascender - font.descender)
        let cursor = placement.cursorRect, field = placement.fieldRect
        // KeyType's capsule for a text, before offsets (`GhostTextOverlayWindow.capsuleLayout`).
        func laid(_ shown: String) -> (frame: CGRect, lineHeight: CGFloat) {
            GhostFit.capsuleFrame(caret: cursor, field: field, textWidth: (shown as NSString).size(withAttributes: [.font: font]).width,
                                  fontLineHeight: fontLine, approximateCaret: approximate)
        }
        let whole = laid(text)
        // The caret's line where the app's own offsets put the caret, as tall as KeyType's line.
        let dx = CGFloat(placement.horizontalOffset), dy = CGFloat(placement.verticalOffset(Double(whole.lineHeight)))
        let caret = cursor.offsetBy(dx: dx, dy: -dy)
        let line = CGRect(x: caret.minX, y: caret.minY, width: max(caret.width, 1), height: whole.lineHeight)
        let display = displays.first { $0.contains(CGPoint(x: line.midX, y: line.midY)) }
        if !displays.isEmpty, display == nil { return (.capsuleNoRoom, nil, text, nil) }
        let areas = CaretLinePlacement.areas(viewport: viewport, window: window, display: display).map(CaretLinePlacement.flipped)
        let caretLine = CaretLinePlacement.flipped(line)
        guard var spot = CaretLinePlacement.place(size: whole.frame.size, caretLine: caretLine, areas: areas) else {
            return (.capsuleNoRoom, nil, text, nil)
        }
        var shown = text
        if spot.bounded {
            let capsuleWidth = { (s: String) in laid(s).frame.width }
            guard let short = CaretLinePlacement.truncated(text, toWidth: spot.frame.width, measure: capsuleWidth),
                  let again = CaretLinePlacement.place(size: laid(short).frame.size, caretLine: caretLine, areas: areas)
            else { return (.capsuleNoRoom, nil, text, nil) }
            shown = short
            spot = again
        }
        let target = CaretLinePlacement.flipped(spot.frame)
        let theirs = laid(shown).frame
        placement.horizontalOffset = Double(target.minX - theirs.minX)
        let lift = Double(theirs.minY - target.minY)
        placement.verticalOffset = { _ in lift }
        let ax = Screen.ax(target)
        guard let pid else { return (nil, ax, shown, spot.side) }
        let points = [CGPoint(x: ax.minX + 1, y: ax.minY + 1), CGPoint(x: ax.maxX - 1, y: ax.minY + 1),
                      CGPoint(x: ax.minX + 1, y: ax.maxY - 1), CGPoint(x: ax.maxX - 1, y: ax.maxY - 1), CGPoint(x: ax.midX, y: ax.midY)]
        let windows = Visibility.windows()
        let own = ProcessInfo.processInfo.processIdentifier
        let screens = NSScreen.screens.map { Screen.ax($0.frame) }
        let fieldAX = Screen.ax(field.map { $0.intersection(window) }.flatMap { $0.isNull || $0.isEmpty ? nil : $0 } ?? window)
        for point in points where SurfaceGate.topPID(at: point, windows: windows, ownPID: own, displays: screens, field: fieldAX) != pid {
            return (.capsuleCovered, ax, shown, spot.side)
        }
        return (nil, ax, shown, spot.side)
    }
}
