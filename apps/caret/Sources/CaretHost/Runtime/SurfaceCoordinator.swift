import AppCompatibility
import AppKit
import ApplicationServices
import AutocompleteCore
import CaretHostCore
import CaretScreenCore
import CompletionUI
import MacContextCapture
import SwiftUI

/// Main-thread owner of the offers that are not the engine's ghost text or a fill: alternatives
/// at the caret, action lines and pop-ups, and the working, result and error lines that follow an
/// accepted action (`SURFACES.md` sections 2 to 4 and 6).
///
/// Offers come from the helper (`alternatives`, `action`, `popup`), or from the debug socket's
/// `inject` in tests. Same invariant as the other coordinators: what is on screen is exactly what
/// the arbiter holds. The arbiter decides every key; this class draws the result.
///
/// `headless` (`--surfaces headless`) is for socket-level tests while someone is using the Mac:
/// helper offers are bound to the field the helper names instead of the one Accessibility reports,
/// the arbiter decides keys from the debug socket's `key` hook as usual, and nothing is drawn. The
/// runtime also refuses every host write in that mode.
@MainActor
final class SurfaceCoordinator {
    private struct Shown {
        let offerID: UInt64
        let offer: Offer
        /// The helper's key for the offer. Nil for injected alternatives, which have none.
        let offerKey: String?
        /// The field's caret, Accessibility coordinates, where panels are anchored.
        let caret: CGRect
        /// Alternatives only: what the ghost renderer needs to redraw a different candidate.
        let snapshot: FocusedFieldSnapshot?
        let style: OverlayTextStyle?
        let ghostFont: NSFont?
        /// The field's frame, Accessibility coordinates.
        let field: CGRect
        let quoted: Bool
    }

    /// An offer to show: one the helper sent, or one the debug socket injected.
    private enum Incoming {
        case helper(HelperOffer)
        case injected(SurfaceInjection)

        var pid: Int32? {
            switch self {
            case .helper(let offer): return offer.pid
            case .injected(.alternatives(let pid, _, _)), .injected(.action(let pid, _)), .injected(.popup(let pid, _)): return pid
            case .injected(.helperLine): return nil
            }
        }

        var offerKey: String? {
            switch self {
            case .helper(let offer): return offer.offerKey
            case .injected(.action(_, let line)): return line.offerKey
            case .injected(.popup(_, let popup)): return popup.offerKey
            case .injected: return nil
            }
        }

        /// The helper's key, for withdrawal. Injected offers are never withdrawn by the helper.
        var helperKey: String? {
            if case .helper(let offer) = self { return offer.offerKey }
            return nil
        }

        /// Alternatives' texts, for the check that the widest fits in the field.
        var candidates: [String] {
            switch self {
            case .helper(let offer): return offer.candidateTexts
            case .injected(.alternatives(_, let candidates, _)): return candidates
            case .injected: return []
            }
        }

        var quoted: Bool {
            switch self {
            case .helper(let offer): return offer.quoted
            case .injected(.alternatives(_, _, let quoted)): return quoted
            case .injected: return false
            }
        }

        func offer(for field: FieldState) -> Offer? {
            switch self {
            case .helper(let offer):
                return offer.offer(target: field.identity, fieldValue: field.value, caretUTF16: field.selection.start)
            case .injected(.alternatives(_, let candidates, _)):
                return Offer(text: candidates[0], moreCandidates: Array(candidates.dropFirst()), source: .debug,
                             target: field.identity, fieldValue: field.value, caretUTF16: field.selection.start, maxAgeSeconds: 120)
            case .injected(.action(_, let line)):
                return Offer(text: "", source: .debug, kind: .action(line), target: field.identity,
                             fieldValue: field.value, caretUTF16: field.selection.start, maxAgeSeconds: 120)
            case .injected(.popup(_, let popup)):
                return Offer(text: "", source: .debug, kind: .popup(popup), target: field.identity,
                             fieldValue: field.value, caretUTF16: field.selection.start, maxAgeSeconds: 120)
            case .injected(.helperLine):
                return nil
            }
        }
    }

    private struct Work {
        let offerKey: String
        let app: String
        let pid: Int32
        let statusID: UInt64
        let startedAt: Date
        let source: OfferSource
        /// The field the offer was taken in: a fill's undo grant is bound to it.
        let target: TargetIdentity
        /// A fill pop-up: the fields its Tab writes and where the values came from.
        let fill: FillWork?
        /// Steps the helper verified so far, for the fill toast's count.
        var verified = 0
        var timer: Timer?
    }

    private struct FillWork {
        let rows: Int
        let source: String?
    }

    struct Accepted: Codable, Equatable {
        var offerKey: String?
        var actionId: String?
        var candidate: Int?
        var row: Int?
        var overrides: [String: Int]?
        var source: String
        var kind: String
    }

    private let arbiter: OfferArbiter
    private let status: HostStatus
    private let policy: TargetPolicy
    private let headless: Bool
    private let ghost: GhostOverlay
    private let reader = FocusedFieldReader()
    private let decor = HostedPanel(radius: 0, material: false)
    private let ownGhost = HostedPanel(radius: 0, material: false)
    /// Where the open list went for the shown offer, chosen once so the arrows never move it.
    private var listFrame: CGRect?
    private var listAbove = false
    private let list = HostedPanel(radius: 8)
    private var panel = HostedPanel(radius: 10)
    var executor: InsertionExecutor?
    var client: HelperClient?
    /// Called with true while accepted work runs, so the menu bar glyph can tint Carrot.
    var onWorkingChanged: ((Bool) -> Void)?

    private var shown: Shown?
    /// An offer held by `SurfaceGate`, retried until it may be drawn, it is withdrawn, or 30 s pass.
    private var pending: (incoming: Incoming, since: Date, hold: SurfaceGate.Hold)?
    private var pendingTimer: Timer?
    private let watch = VisibilityWatch()
    private var work: Work?
    private var resultTimer: Timer?
    private var resultStatusID: UInt64?
    /// The fill toast's undo grant while ⌘Z can still take it.
    private var toastGrantID: UInt64?
    /// The task ⌘Z asked the helper to undo; its `undone` progress gets the last word.
    private var undoing: String?
    private var toastInfo: DebugState.Toast?
    /// The figure has looked away and left the working line.
    private var figureLeft = false
    /// The working or result line was taken down because its app went behind or was covered; it
    /// stays down until the next offer.
    private var lineSuppressed = false
    private(set) var lastAccepted: Accepted?
    private var lineText: String?
    private var figureState: FigureState?
    private var character: FigureCharacter { FigureSettings.shared.character }

    init(arbiter: OfferArbiter, status: HostStatus, policy: TargetPolicy, compatibilityStore: AppCompatibilityStore, headless: Bool = false) {
        self.arbiter = arbiter
        self.status = status
        self.policy = policy
        self.headless = headless
        ghost = GhostOverlay(compatibilityStore: compatibilityStore)
    }

    // MARK: - Offers in

    /// An offer from the helper: shown in its field if that field is where the user is looking,
    /// otherwise held and retried.
    func receive(_ offer: HelperOffer) {
        status.increment("surface.helper.\(offer.kindName)")
        _ = present(.helper(offer))
    }

    /// The helper withdrew an offer: take it down if it is shown, forget it if it is held. Work
    /// already accepted from it goes on.
    func withdrawn(_ message: OfferWithdrawn) {
        let shownKey = shown.flatMap { $0.offer.source == .helper ? $0.offerKey : nil }
        let effect = OfferLifecycle.withdrawal(of: message.id, shownKey: shownKey, heldKey: pending?.incoming.helperKey)
        if effect.removeShown, let shown {
            arbiter.invalidate(offerID: shown.offerID)
            clear(exit: 0.10)
            status.increment("surface.withdrawn.helper.\(message.reason.rawValue)")
        }
        if effect.dropHeld { cancelPending() }
        publish()
    }

    /// Publishes and draws an injected offer for the focused field of `pid`. Returns a JSON reply.
    func inject(_ injection: SurfaceInjection) -> String {
        if case .helperLine = injection { return #"{"error":"helperLine is handled by the runtime"}"# }
        return present(.injected(injection))
    }

    private func present(_ incoming: Incoming) -> String {
        // A headless host reads and writes nothing, so its pids need not be live processes: socket
        // runs use the recordings' synthetic pids.
        guard let pid = incoming.pid, headless ? policy.allows(pid: pid, bundleID: nil) : policy.allowsLive(pid: pid) else {
            status.increment("surface.refused.pidNotAllowed")
            return #"{"error":"pid not allowed"}"#
        }
        if headless {
            guard case .helper(let helperOffer) = incoming else { return #"{"error":"a headless host draws no injected offer"}"# }
            return presentHeadless(helperOffer)
        }
        // Gate first, before any Accessibility read of a background app (SurfaceGate).
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return hold(incoming, .appNotFront) }
        guard let (element, field) = FieldReader.readFocused(pid: pid) else { return hold(incoming, .fieldNotFocused) }
        let fieldFrame = AXRead.frame(of: element)
        // A helper offer is for one field, named by its frame; any other focused field waits.
        if case .helper(let helperOffer) = incoming, !helperOffer.isFor(focusedFrame: fieldFrame) {
            return hold(incoming, .fieldNotFocused)
        }
        guard let snapshot = reader.snapshot(of: element) else { return #"{"error":"no snapshot of the field"}"# }
        let style = FieldStyleProbe.style(of: element)
        let font = style.font ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)
        guard let caret = snapshot.caretRect ?? Self.derivedCaret(field: field, frame: fieldFrame, font: font) else {
            return #"{"error":"no caret"}"#
        }
        let anchors = [CGPoint(x: caret.midX, y: caret.midY)]
        if let held = Visibility.hold(for: field.identity, anchors: anchors) { return hold(incoming, held) }
        let candidates = incoming.candidates
        if !candidates.isEmpty {
            // Ghost text and its underline stay inside the field, clear of the app's own text:
            // the widest candidate must fit after the caret with nothing after it.
            let widest = candidates.map { ($0 as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0
            let ghostRect = CGRect(x: caret.maxX, y: caret.minY, width: widest, height: caret.height + 3)
            let textAfter = field.selection.end < UTF16Text.length(field.value)
            if let fieldFrame, !SurfaceGate.fitsInField(ghost: ghostRect, field: fieldFrame, textAfterCaret: textAfter) {
                return hold(incoming, .wouldOverlapText, retry: false)
            }
        }
        guard let offer = incoming.offer(for: field) else { return #"{"error":"nothing to show"}"# }
        cancelPending()
        makeRoom(for: offer)
        guard let offerID = arbiter.publish(offer) else { return #"{"error":"arbiter refused (an insertion is running)"}"# }
        let stamped = arbiter.snapshot().current.flatMap { $0.id == offerID ? $0 : nil } ?? offer
        var ghostFont: NSFont?
        var usesKeyTypeGhost = false
        if case .ghost = offer.kind {
            usesKeyTypeGhost = ghost.show(offer.text, at: snapshot, style: style) != nil
            if !usesKeyTypeGhost { drawOwnGhost(offer.text, caret: caret, font: font, color: style.textColor) }
            executor?.remember(offerID: offerID, context: snapshot.context)
            ghostFont = font
            status.increment(usesKeyTypeGhost ? "surface.ghost.keytype" : "surface.ghost.own")
        }
        shown = Shown(
            offerID: offerID, offer: stamped, offerKey: incoming.offerKey, caret: caret, snapshot: usesKeyTypeGhost ? snapshot : nil,
            style: style, ghostFont: ghostFont, field: fieldFrame ?? caret, quoted: incoming.quoted
        )
        draw(ui: arbiter.snapshot().ui, entering: true)
        let target = field.identity
        watch.start(check: { Visibility.hold(for: target, anchors: anchors) }, onLost: { [weak self] hold in
            guard let self, let shown = self.shown, shown.offerID == offerID else { return }
            self.arbiter.invalidate(offerID: offerID)
            self.clear(exit: 0)
            self.status.increment("surface.withdrawn.\(hold.rawValue)")
            self.publish()
        })
        status.increment("surface.shown.\(offer.source.rawValue).\(offer.kind.name)")
        return #"{"ok":true,"offerId":\#(offerID)}"#
    }

    /// The headless path: the offer is bound to the field the helper names and published, and
    /// nothing is read or drawn.
    private func presentHeadless(_ helperOffer: HelperOffer) -> String {
        cancelPending()
        let offer = helperOffer.offer(target: helperOffer.declaredTarget, fieldValue: "", caretUTF16: 0)
        makeRoom(for: offer)
        guard let offerID = arbiter.publish(offer) else { return #"{"error":"arbiter refused (an insertion is running)"}"# }
        let stamped = arbiter.snapshot().current.flatMap { $0.id == offerID ? $0 : nil } ?? offer
        let frame = helperOffer.field.frame.map { CGRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height) } ?? .zero
        shown = Shown(
            offerID: offerID, offer: stamped, offerKey: helperOffer.offerKey, caret: frame, snapshot: nil, style: nil,
            ghostFont: nil, field: frame, quoted: helperOffer.quoted
        )
        draw(ui: arbiter.snapshot().ui, entering: true)
        status.increment("surface.shown.headless.\(offer.kind.name)")
        return #"{"ok":true,"offerId":\#(offerID)}"#
    }

    /// A new offer takes the one panel: whatever offer, work line, result or toast was on it ends.
    /// Work goes on unseen and its progress is ignored; the activity list still reports it.
    private func makeRoom(for offer: Offer) {
        clear(exit: 0)
        endWork()
        endResult()
        // Alternatives draw at the caret, not on the panel, so a line left there goes now.
        if case .ghost = offer.kind { takeLineDown(duration: 0) }
    }

    /// Nothing is drawn; the offer waits, and is tried again every half second for 30 s (or not at
    /// all when only the field's own content could change the answer).
    private func hold(_ incoming: Incoming, _ reason: SurfaceGate.Hold, retry: Bool = true) -> String {
        status.increment("surface.held.\(reason.rawValue)")
        if retry {
            // The same offer keeps its first hold time; a different one starts over.
            let since = pending.flatMap { $0.incoming.offerKey == incoming.offerKey ? $0.since : nil } ?? Date()
            pending = (incoming, since, reason)
            if pendingTimer == nil {
                pendingTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated { self?.retryPending() }
                }
            }
        }
        publish()
        return #"{"held":"\#(reason.rawValue)"}"#
    }

    private func retryPending() {
        guard let pending else { return cancelPending() }
        if Date().timeIntervalSince(pending.since) > 30 { return cancelPending() }
        _ = present(pending.incoming)
    }

    private func cancelPending() {
        pendingTimer?.invalidate()
        pendingTimer = nil
        pending = nil
        publish()
    }

    // MARK: - Drawing

    private func draw(ui: OfferUI, entering: Bool) {
        guard let shown else { return }
        switch shown.offer.kind {
        case .ghost where headless:
            lineText = shown.offer.candidates[min(ui.candidate, shown.offer.candidates.count - 1)]
        case .ghost:
            drawAlternatives(shown, ui: ui, entering: entering)
        case .action(let line):
            if ui.expanded, let variants = line.variants {
                show(PopupView(spec: variants, highlight: ui.highlight, character: character), text: variants.header?.title.text,
                     figure: .needsYou, at: shown.caret, entering: entering)
            } else {
                let content = LineContent(figure: .offering, app: line.app, text: line.endState.text, hints: Self.hints(line.actions))
                show(LineView(content: content, character: character), text: "\(line.app) \(line.endState.text)",
                     figure: .offering, at: shown.caret, entering: entering)
            }
        case .popup:
            guard let spec = shown.offer.visibleSpec(ui: ui) else { return }
            show(PopupView(spec: spec, highlight: ui.highlight, character: character), text: spec.header?.title.text,
                 figure: spec.figure == .needsYou ? .needsYou : .offering, at: shown.caret, entering: entering)
        case .fill:
            break
        }
        publish()
    }

    /// Ghost text with alternatives: the top one faint, the uneven underline under it while
    /// closed; once open, the current one in place, the figure and "2 of 4" after it, and the
    /// numbered list below. Every change here comes from a key, so none of it animates except the
    /// underline drawing in once with the offer.
    private func drawAlternatives(_ shown: Shown, ui: OfferUI, entering: Bool) {
        let candidates = shown.offer.candidates
        let text = candidates[min(ui.candidate, candidates.count - 1)]
        if !entering {
            if let snapshot = shown.snapshot, let style = shown.style {
                ghost.show(text, at: snapshot, style: style)
            } else if let font = shown.ghostFont {
                drawOwnGhost(text, caret: shown.caret, font: font, color: shown.style?.textColor)
            }
        }
        guard candidates.count > 1 else {
            decor.exit(duration: 0)
            list.exit(duration: 0)
            return
        }
        let caret = shown.caret
        let font = shown.ghostFont ?? NSFont.systemFont(ofSize: 13)
        let width = ceil((text as NSString).size(withAttributes: [.font: font]).width)
        let figureHeight = min(max((caret.height * 0.6).rounded(), 9), 14)
        let tag = AlternativesTag(current: ui.candidate, count: candidates.count, character: character, figureHeight: figureHeight)
        // Collapsed, one mark at most: the faint value, underlined only when it is quoted from a
        // source. The figure and the count come with the down arrow, and only where they fit
        // inside the field after the text.
        let tagWidth = NSHostingView(rootView: tag).fittingSize.width + font.pointSize * 0.3
        let showTag = ui.open && caret.maxX + width + tagWidth <= shown.field.maxX - 2
        guard shown.quoted || showTag else {
            decor.exit(duration: 0)
            drawList(shown, ui: ui)
            return
        }
        let decorView = HStack(alignment: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                if shown.quoted { UnevenUnderline(width: width, animated: entering) }
            }
            .frame(width: width, height: caret.height + 4)
            if showTag {
                tag
                    .padding(.leading, font.pointSize * 0.3)
                    .padding(.bottom, caret.height * 0.22 + 4)
            }
        }
        .fixedSize()
        // The decor's top left sits on the caret's top left: the underline lands at the baseline
        // plus 2 pt (baseline estimated at 0.78 of the caret height).
        decor.pin(HostedPanel.Anchor(corner: .topLeft, point: NSPoint(x: caret.maxX, y: Screen.cocoa(caret).maxY)))
        decor.setContent(decorView)
        decor.text = ui.open ? "\(ui.candidate + 1) of \(candidates.count)" : "underline"
        if !decor.panel.isVisible || decor.isExiting { decor.panel.alphaValue = 1; decor.panel.orderFrontRegardless() }

        drawList(shown, ui: ui)
    }

    /// The open list sits below the field, clear of the next field and its label; it flips above
    /// only when below would cover something and above would not.
    private func drawList(_ shown: Shown, ui: OfferUI) {
        guard ui.open else { return list.exit(duration: 0) }
        let candidates = shown.offer.candidates
        let view = AlternativesListView(candidates: candidates, current: ui.candidate)
        let size = list.measure(view)
        let x = shown.caret.minX - 12
        let below = CGRect(x: x, y: shown.field.maxY + 6, width: size.width, height: size.height)
        let above = CGRect(x: x, y: shown.field.minY - 6 - size.height, width: size.width, height: size.height)
        if !list.isVisible || listFrame == nil {
            let obstacles = ObstacleProbe.obstacles(pid: shown.offer.target.pid, under: [below, above])
                .filter { !$0.insetBy(dx: -2, dy: -2).contains(shown.field) }
            let choice = PanelPlacement.choose([below, above], obstacles: obstacles, bounds: Screen.axVisibleFrame(around: shown.field))
            listFrame = choice.frame
            listAbove = choice.index == 1
        }
        let frame = Screen.cocoa(listFrame ?? below)
        list.pin(HostedPanel.Anchor(
            corner: listAbove ? .bottomLeft : .topLeft,
            point: NSPoint(x: frame.minX, y: listAbove ? frame.minY : frame.maxY)
        ))
        list.setContent(view)
        list.text = candidates.prefix(3).enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: " | ")
        if !list.panel.isVisible || list.isExiting { list.panel.alphaValue = 1; list.panel.orderFrontRegardless() }
    }

    /// The offer line or pop-up: left edge 12 pt left of the caret, top 6 pt below it, flipped
    /// above when there is no room; the panel scales in from the corner at the caret.
    private func show<V: View>(_ view: V, text: String?, figure: FigureState, at caret: CGRect, entering: Bool) {
        lineText = text
        figureState = figure
        guard !headless else { return }
        let size = panel.measure(view)
        let bounds = Screen.axVisibleFrame(around: caret)
        var x = caret.minX - 12
        x = min(max(x, bounds.minX + 8), bounds.maxX - 8 - size.width)
        let below = caret.maxY + 6 + size.height <= bounds.maxY - 8
        let anchor: HostedPanel.Anchor
        if below {
            anchor = HostedPanel.Anchor(corner: .topLeft, point: NSPoint(x: x, y: Screen.cocoa(CGRect(x: x, y: caret.maxY + 6, width: 0, height: 0)).maxY))
        } else {
            anchor = HostedPanel.Anchor(corner: .bottomLeft, point: NSPoint(x: x, y: Screen.cocoa(CGRect(x: x, y: caret.minY - 6, width: 0, height: 0)).minY))
        }
        if entering || !panel.isVisible { panel.pin(anchor) }
        panel.setContent(view)
        panel.text = text ?? ""
        if entering || !panel.isVisible { panel.enter() }
    }

    /// Ghost text drawn by Caret when KeyType's renderer finds no placement (it needs the caret's
    /// bounds, which an empty AppKit field does not report): the field's font at Ghost opacity,
    /// starting at the caret.
    private func drawOwnGhost(_ text: String, caret: CGRect, font: NSFont, color: NSColor?) {
        let view = Text(text)
            .font(Font(font))
            .foregroundStyle(Color(nsColor: color ?? .labelColor).opacity(0.45))
            .fixedSize()
            .frame(height: caret.height)
        ownGhost.pin(HostedPanel.Anchor(corner: .topLeft, point: NSPoint(x: caret.maxX, y: Screen.cocoa(caret).maxY)))
        ownGhost.setContent(view)
        ownGhost.text = text
        ownGhost.panel.alphaValue = 1
        ownGhost.panel.orderFrontRegardless()
    }

    /// Where the caret is when Accessibility gives no bounds for it: after the text before it, at
    /// the field's text inset (about 4 pt for an AppKit field), centered on one line.
    static func derivedCaret(field: FieldState, frame: CGRect?, font: NSFont) -> CGRect? {
        guard let frame else { return nil }
        let before = UTF16Text.slice(field.value, start: 0, end: field.selection.start) ?? ""
        let width = (before as NSString).size(withAttributes: [.font: font]).width
        let line = ceil(font.ascender - font.descender + font.leading)
        return CGRect(x: frame.minX + 4 + width, y: frame.minY + (frame.height - line) / 2, width: 1, height: line)
    }

    static func hints(_ actions: [PopupSpec.Action]) -> [Hint] {
        actions.map { Hint(key: Hint.key($0.key), label: $0.key == .tab ? nil : $0.label) }
    }

    // MARK: - Keys (posted to main by the tap thread)

    func navigated(offerID: UInt64, ui: OfferUI) {
        guard let shown, shown.offerID == offerID else { return }
        draw(ui: ui, entering: false)
    }

    func offerChanged(_ reason: OfferArbiter.PassReason) {
        let snapshot = arbiter.snapshot()
        if reason == .typedThrough, let shown, snapshot.current?.id == shown.offerID {
            // The user typed the head of the top candidate: the rest stays as ghost text, and the
            // other candidates no longer fit, so their underline and list go.
            let typed = snapshot.typedSinceOffer
            let remainder = String(shown.offer.text.dropFirst(typed.count))
            decor.exit(duration: 0)
            list.exit(duration: 0)
            if shown.snapshot != nil {
                ghost.advance(typed: typed, remainder: remainder)
            } else if let font = shown.ghostFont {
                let shift = (typed as NSString).size(withAttributes: [.font: font]).width
                drawOwnGhost(remainder, caret: shown.caret.offsetBy(dx: shift, dy: 0), font: font, color: shown.style?.textColor)
            }
            publish()
            return
        }
        if let shown, snapshot.current?.id != shown.offerID {
            // Typing: 80 ms (the text itself at once). Esc: 100 ms.
            clear(exit: reason == .closed ? 0.10 : 0.08)
        }
        if let work, snapshot.statusLine?.id != work.statusID, panel.isVisible {
            // A key passed through and dismissed the working line; the work goes on unseen and
            // its result still reports.
            panel.exit(duration: 0.08)
        }
        if let toastGrantID, snapshot.toast?.id != toastGrantID {
            // Esc closed the fill toast, or a key passed through and dismissed it; ⌘Z is the
            // app's again.
            self.toastGrantID = nil
            toastInfo = nil
            resultTimer?.invalidate()
            resultTimer = nil
            takeLineDown(duration: 0.08)
        } else if resultTimer != nil, undoing == nil, snapshot.statusLine?.id != resultStatusID {
            resultTimer?.invalidate()
            resultTimer = nil
            takeLineDown(duration: 0.08)
        }
        publish()
    }

    /// Another producer's offer replaced this one in the arbiter.
    func displaced(_ offer: Offer) {
        guard let shown, offer.id == shown.offerID else { return }
        clear(exit: 0.10)
        publish()
    }

    /// The frontmost app's focused field changed. An offer bound to another field of that app is
    /// withdrawn: its panel describes a field the user has left.
    func focusChanged(_ identity: TargetIdentity?) {
        guard let shown, let identity, identity.pid == shown.offer.target.pid,
              identity.elementID != shown.offer.target.elementID else { return }
        arbiter.invalidate(offerID: shown.offerID)
        clear(exit: 0.10)
        status.increment("surface.withdrawn.focusMoved")
        publish()
    }

    func claimed(_ claim: Claim) {
        guard let shown, claim.offer.id == shown.offerID else { return }
        // An action is about the field it was offered in. Revalidate that field before handing
        // the action on: focus may have moved in an app that posts no focus notification. A
        // headless host reads no field; its offers are bound to the field the helper named.
        if !claim.insertsText, !headless {
            let live = FieldReader.readFocused(pid: claim.offer.target.pid)?.field.identity
            if live?.elementID != claim.offer.target.elementID || live?.windowID != claim.offer.target.windowID {
                arbiter.abandon(claimID: claim.claimID, reason: "targetMoved")
                clear(exit: 0.10)
                status.increment("surface.refused.targetMoved")
                publish()
                return
            }
        }
        if claim.insertsText {
            // Alternatives: the chosen text is on its way into the field; nothing animates. The
            // helper sees the value arrive as a transfer, so nothing is sent.
            clear(exit: 0)
            lastAccepted = Accepted(
                offerKey: shown.offerKey, candidate: claim.choice.candidate, source: claim.offer.source.rawValue, kind: claim.offer.kind.name
            )
            publish()
            return
        }
        let accept = OfferAccept.from(claim, at: Self.nowMs())
        lastAccepted = Accepted(
            offerKey: accept?.offerId, actionId: accept?.actionId, row: claim.choice.row,
            overrides: accept?.overrides, source: claim.offer.source.rawValue, kind: claim.offer.kind.name
        )
        if claim.offer.source == .helper, let accept { client?.send(accept) }
        ghost.hide()
        ownGhost.exit(duration: 0)
        decor.exit(duration: 0)
        list.exit(duration: 0)
        watch.stop()
        self.shown = nil
        startWork(claim, offerKey: accept?.offerId ?? "?")
        guard !headless else { return publish() }
        // The working line and its result follow the same rule as the offer: the app in front and
        // the line's anchor uncovered. Focus may move; the line reports on work, not on a field.
        let target = claim.offer.target
        let anchor = CGPoint(x: shown.caret.midX, y: shown.caret.midY)
        watch.start(check: { Visibility.hold(for: target, anchors: [anchor], requireFocus: false) }, onLost: { [weak self] hold in
            guard let self else { return }
            self.lineSuppressed = true
            self.panel.exit(duration: 0)
            self.status.increment("surface.lineHidden.\(hold.rawValue)")
            self.publish()
        })
        publish()
    }

    func insertionFinished(_ result: InsertionExecutor.Result) {
        guard result.claim.offer.source != .engine, case .ghost = result.claim.offer.kind else { return }
        status.increment(result.insertion.ok ? "surface.insertion.ok" : "surface.insertion.failed")
    }

    // MARK: - Work after Tab

    /// The line, in place, becomes the working caption; the figure looks away and leaves.
    private func startWork(_ claim: Claim, offerKey: String) {
        endWork()
        endResult()
        lineSuppressed = false
        let pid = claim.offer.target.pid
        var fill: FillWork?
        let app: String
        switch claim.offer.kind {
        case .action(let line):
            app = line.app
        case .popup(let popup):
            app = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "the app"
            let spec = claim.choice.revealed.map { popup.spec.applyingReveal(of: $0) } ?? popup.spec
            if let rows = spec.fillRows { fill = FillWork(rows: rows, source: spec.sourceText) }
        case .ghost, .fill:
            app = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "the app"
        }
        let statusID = arbiter.showStatus(StatusLine(pid: pid, kind: .working(startedAt: Date()), offerKey: offerKey))
        work = Work(
            offerKey: offerKey, app: app, pid: pid, statusID: statusID, startedAt: Date(),
            source: claim.offer.source, target: claim.offer.target, fill: fill
        )
        // The figure looks away (160 ms), then leaves; under Reduce Motion it is simply gone.
        figureLeft = Motion.reduceMotion
        renderWorking()
        if !figureLeft {
            let statusID = statusID
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.work?.statusID == statusID else { return }
                    self.figureLeft = true
                    self.renderWorking()
                }
            }
        }
        work?.timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.renderWorking() }
        }
        onWorkingChanged?(true)
    }

    private func renderWorking() {
        guard let work else { return }
        let seconds = Int(Date().timeIntervalSince(work.startedAt))
        let stoppable = Double(seconds) >= StatusLine.stoppableAfter
        var caption = work.fill.map { Captions.filling($0.rows) } ?? Captions.working(character, app: work.app)
        if stoppable { caption += ", \(seconds) s" }
        let content = LineContent(
            figure: figureLeft ? .absent : .working, app: work.app, text: caption, emphasis: .plain,
            hints: stoppable ? [Hint(key: "Esc", label: "Stop")] : [], appGlyphOnly: true
        )
        guard arbiter.snapshot().statusLine?.id == work.statusID else { return }
        guard !lineSuppressed else { return }
        lineText = caption
        figureState = .working
        if !headless {
            panel.setContent(LineView(content: content, character: character))
            panel.text = caption
            if !panel.isVisible { panel.enter() }
        }
        publish()
    }

    /// The helper's progress on a task. The work an accepted offer started runs as the task whose
    /// id is the offer's key; its last phase (done, stopped, handoff or paused) ends the line.
    func taskProgress(_ progress: TaskProgress) {
        if progress.phase == .undone, undoing == progress.taskId {
            return finishUndo(progress)
        }
        if progress.phase == .verified, work?.offerKey == progress.taskId { work?.verified += 1 }
        guard let ending = OfferLifecycle.ending(of: progress, workKey: work?.offerKey) else { return publish() }
        status.increment("surface.progress.\(progress.phase.rawValue)")
        end(with: ending)
    }

    /// `progress done|error` on the debug socket (test hooks only): ends the line as a run would.
    func progress(_ phase: String) -> String {
        guard work != nil else { return #"{"error":"no work running"}"# }
        switch phase {
        case "done": end(with: .done)
        case "error": end(with: .stopped(detail: "debug socket"))
        default: return #"{"error":"phase is done or error"}"#
        }
        return #"{"ok":true}"#
    }

    private func end(with ending: OfferLifecycle.Ending) {
        guard let work else { return }
        endWork()
        switch ending {
        case .done:
            if let fill = work.fill, work.verified > 0 { return showFillToast(work, fill) }
            let done = Captions.done(character, app: work.app)
            resultStatusID = arbiter.showStatus(StatusLine(pid: work.pid, kind: .result, offerKey: work.offerKey))
            showResult(LineContent(figure: .done, lead: done.lead, text: done.rest, emphasis: .plain), text: "\(done.lead) \(done.rest)", lifetime: 5)
        case .stopped:
            resultStatusID = arbiter.showStatus(StatusLine(pid: work.pid, kind: .error, offerKey: work.offerKey))
            let caption = work.fill.map { _ in Captions.fillStopped(filled: work.verified) } ?? Captions.error(character, app: work.app)
            showResult(LineContent(figure: .error, text: caption, emphasis: .plain), text: caption, lifetime: 6)
        case .handoff:
            resultStatusID = arbiter.showStatus(StatusLine(pid: work.pid, kind: .result, offerKey: work.offerKey))
            let caption = Captions.handoff(app: work.app)
            showResult(LineContent(figure: .needsYou, text: caption, emphasis: .plain), text: caption, lifetime: 6)
        case .paused:
            // The input pause stopped the run; the perch and the activity list carry it from here.
            takeLineDown(duration: 0.08)
            publish()
        }
    }

    /// "Filled 3 fields from Mail  ⌘Z Undo": ⌘Z belongs to Caret while it shows, and asks the
    /// helper to undo the task (`SURFACES.md` section 6).
    private func showFillToast(_ work: Work, _ fill: FillWork) {
        let grant = UndoGrant.task(work.offerKey, target: work.target)
        let id = arbiter.showToast(grant)
        toastGrantID = id
        let rest = Captions.fields(work.verified) + (fill.source.map { " from \($0)" } ?? "")
        toastInfo = DebugState.Toast(kind: "done", caption: "Filled \(rest)", grantID: id)
        status.increment("surface.toast.fill")
        showResult(
            LineContent(figure: .done, lead: "Filled", text: rest, emphasis: .plain, hints: [Hint(key: "⌘Z", label: "Undo")]),
            text: "Filled \(rest)", lifetime: grant.lifetimeSeconds
        )
    }

    /// ⌘Z took the fill toast; the runtime has sent `taskControl undo`. The line says so until the
    /// helper reports the undo, or for 10 s.
    func undoStarted(_ grant: UndoGrant) {
        guard let taskID = grant.taskID else { return }
        toastGrantID = nil
        undoing = taskID
        toastInfo = DebugState.Toast(kind: "undoing", caption: "Undoing", grantID: nil)
        status.increment("surface.undo.sent")
        showResult(LineContent(figure: .working, text: "Undoing", emphasis: .plain), text: "Undoing", lifetime: 10)
    }

    private func finishUndo(_ progress: TaskProgress) {
        undoing = nil
        let count = OfferLifecycle.undoCount(progress.detail)
        let caption: String
        let figure: FigureState
        if let count, count.notRestored > 0 {
            caption = Captions.undoPartial(notRestored: count.notRestored)
            figure = .error
            toastInfo = DebugState.Toast(kind: "error", caption: caption, grantID: nil)
        } else {
            caption = count.map { "Cleared \(Captions.fields($0.restored))" } ?? "Undone"
            figure = .done
            toastInfo = DebugState.Toast(kind: "undone", caption: caption, grantID: nil)
        }
        status.increment("surface.undo.\(figure == .error ? "partial" : "done")")
        showResult(LineContent(figure: figure, text: caption, emphasis: .plain), text: caption, lifetime: figure == .error ? 6 : 2)
    }

    /// Esc on a working line after 3 s: stop, and say so for 2 s. Work the helper runs is stopped
    /// there too (`offerStop`); what it already wrote stays, as the activity list's undo can restore.
    func stopWork(_ line: StatusLine) {
        guard let work, work.statusID == line.id else { return }
        if work.source == .helper { client?.send(OfferStop(offerId: work.offerKey, at: Self.nowMs())) }
        endWork()
        status.increment("surface.workStopped")
        resultStatusID = arbiter.showStatus(StatusLine(pid: line.pid, kind: .result, offerKey: line.offerKey))
        showResult(LineContent(figure: .done, text: Captions.stopped, emphasis: .plain), text: Captions.stopped, lifetime: 2)
    }

    private func endResult() {
        resultTimer?.invalidate()
        resultTimer = nil
        if let id = resultStatusID { arbiter.clearStatus(id: id) }
        resultStatusID = nil
        if let id = toastGrantID { arbiter.dismissToast(grantID: id) }
        toastGrantID = nil
        undoing = nil
        toastInfo = nil
    }

    private func endWork() {
        work?.timer?.invalidate()
        if let work { arbiter.clearStatus(id: work.statusID) }
        work = nil
        onWorkingChanged?(false)
    }

    /// The working line becomes the result where it stands, and leaves after `lifetime`.
    private func showResult(_ content: LineContent, text: String, lifetime: TimeInterval) {
        lineText = text
        figureState = content.figure
        if !headless, !lineSuppressed {
            panel.setContent(LineView(content: content, character: character))
            panel.text = text
            if !panel.isVisible { panel.enter() }
        }
        resultTimer?.invalidate()
        let statusID = resultStatusID
        let grantID = toastGrantID
        resultTimer = Timer.scheduledTimer(withTimeInterval: lifetime, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.resultStatusID == statusID, self.toastGrantID == grantID else { return }
                self.resultTimer = nil
                self.endResult()
                self.takeLineDown(duration: 0.20)
                self.publish()
            }
        }
        publish()
    }

    private func takeLineDown(duration: TimeInterval) {
        if !headless { panel.exit(duration: duration) }
        lineText = nil
        figureState = nil
    }

    private static func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }

    // MARK: -

    private func clear(exit duration: TimeInterval) {
        watch.stop()
        listFrame = nil
        if shown != nil, case .ghost? = shown?.offer.kind {
            ghost.hide()
            ownGhost.exit(duration: 0)
        }
        decor.exit(duration: 0)
        list.exit(duration: 0)
        if shown != nil, work == nil, resultTimer == nil { takeLineDown(duration: duration) }
        shown = nil
    }

    func shutdown() {
        cancelPending()
        watch.stop()
        endWork()
        endResult()
        clear(exit: 0)
        panel.exit(duration: 0)
    }

    /// Recomputed on every change and on each socket read, from what is on screen.
    func debugInfo() -> DebugState.SurfaceInfo {
        let snapshot = arbiter.snapshot()
        var info = DebugState.SurfaceInfo()
        info.headless = headless
        if let shown {
            info.offerId = shown.offerID
            info.offerKey = shown.offerKey
            info.kind = shown.offer.kind.name
            info.source = shown.offer.source.rawValue
            info.candidates = shown.offer.candidates.count > 1 || shown.offer.kind == .ghost ? shown.offer.candidates : nil
            info.ui = snapshot.current?.id == shown.offerID ? snapshot.ui : nil
        }
        info.ghost = ghost.shownText ?? (ownGhost.isVisible ? ownGhost.text : nil)
        info.ghostPanel = ownGhost.debugInfo()
        info.panel = panel.debugInfo()
        info.decor = decor.debugInfo()
        info.list = list.debugInfo()
        info.figure = figureState?.rawValue
        info.character = character.rawValue
        info.lineText = headless ? lineText : (panel.isVisible ? panel.text : nil)
        info.working = work.map { Date().timeIntervalSince($0.startedAt) }
        info.workingOn = work?.offerKey
        info.toast = toastInfo
        info.held = pending?.hold.rawValue
        info.lastAccepted = lastAccepted.map {
            DebugState.AcceptInfo(offerKey: $0.offerKey, actionId: $0.actionId, candidate: $0.candidate, row: $0.row, overrides: $0.overrides, source: $0.source, kind: $0.kind)
        }
        return info
    }

    private func publish() {
        let info = debugInfo()
        status.update { $0.surface = info }
    }
}
