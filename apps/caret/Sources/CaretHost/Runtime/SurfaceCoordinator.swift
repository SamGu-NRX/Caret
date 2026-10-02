import AppCompatibility
import AppKit
import ApplicationServices
import AutocompleteCore
import CaretHostCore
import CompletionUI
import MacContextCapture
import SwiftUI

/// Main-thread owner of the offers that are not the engine's ghost text or a fill: alternatives
/// at the caret, action lines and pop-ups, and the working, result and error lines that follow an
/// accepted action (`SURFACES.md` sections 2 to 4 and 6).
///
/// Same invariant as the other coordinators: what is on screen is exactly what the arbiter holds.
/// The arbiter decides every key; this class draws the result.
@MainActor
final class SurfaceCoordinator {
    private struct Shown {
        let offerID: UInt64
        let offer: Offer
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

    private struct Work {
        let offerKey: String
        let app: String
        let pid: Int32
        let statusID: UInt64
        let startedAt: Date
        var timer: Timer?
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
    /// An injected offer held by `SurfaceGate`, retried until it may be drawn or 30 s pass.
    private var pending: (injection: SurfaceInjection, since: Date, hold: SurfaceGate.Hold)?
    private var pendingTimer: Timer?
    private let watch = VisibilityWatch()
    private var work: Work?
    private var resultTimer: Timer?
    private var resultStatusID: UInt64?
    /// The figure has looked away and left the working line.
    private var figureLeft = false
    /// The working or result line was taken down because its app went behind or was covered; it
    /// stays down until the next offer.
    private var lineSuppressed = false
    private(set) var lastAccepted: Accepted?
    private var lineText: String?
    private var figureState: FigureState?
    private var character: FigureCharacter { FigureSettings.shared.character }

    init(arbiter: OfferArbiter, status: HostStatus, policy: TargetPolicy, compatibilityStore: AppCompatibilityStore) {
        self.arbiter = arbiter
        self.status = status
        self.policy = policy
        ghost = GhostOverlay(compatibilityStore: compatibilityStore)
    }

    // MARK: - Injection (debug socket)

    /// Publishes and draws an injected offer for the focused field of `pid`. Returns a JSON reply.
    func inject(_ injection: SurfaceInjection) -> String {
        switch injection {
        case .alternatives(let pid, let candidates, _):
            return present(pid: pid, injection: injection) { field in
                Offer(text: candidates[0], moreCandidates: Array(candidates.dropFirst()), source: .debug,
                      target: field.identity, fieldValue: field.value, caretUTF16: field.selection.start, maxAgeSeconds: 120)
            }
        case .action(let pid, let line):
            return present(pid: pid, injection: injection) { field in
                Offer(text: "", source: .debug, kind: .action(line), target: field.identity,
                      fieldValue: field.value, caretUTF16: field.selection.start, maxAgeSeconds: 120)
            }
        case .popup(let pid, let popup):
            return present(pid: pid, injection: injection) { field in
                Offer(text: "", source: .debug, kind: .popup(popup), target: field.identity,
                      fieldValue: field.value, caretUTF16: field.selection.start, maxAgeSeconds: 120)
            }
        case .helperLine:
            return #"{"error":"helperLine is handled by the runtime"}"#
        }
    }

    private func present(pid: Int32, injection: SurfaceInjection, make: (FieldState) -> Offer) -> String {
        guard policy.allowsLive(pid: pid) else { return #"{"error":"pid not allowed"}"# }
        // Gate first, before any Accessibility read of a background app (SurfaceGate).
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return hold(injection, .appNotFront) }
        guard let (element, field) = FieldReader.readFocused(pid: pid) else { return #"{"error":"no focused text field in pid"}"# }
        guard let snapshot = reader.snapshot(of: element) else { return #"{"error":"no snapshot of the field"}"# }
        let style = FieldStyleProbe.style(of: element)
        let font = style.font ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)
        let fieldFrame = AXRead.frame(of: element)
        guard let caret = snapshot.caretRect ?? Self.derivedCaret(field: field, frame: fieldFrame, font: font) else {
            return #"{"error":"no caret"}"#
        }
        let anchors = [CGPoint(x: caret.midX, y: caret.midY)]
        if let held = Visibility.hold(for: field.identity, anchors: anchors) { return hold(injection, held) }
        var quoted = false
        if case .alternatives(_, let candidates, let q) = injection {
            quoted = q
            // Ghost text and its underline stay inside the field, clear of the app's own text:
            // the widest candidate must fit after the caret with nothing after it.
            let widest = candidates.map { ($0 as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0
            let ghostRect = CGRect(x: caret.maxX, y: caret.minY, width: widest, height: caret.height + 3)
            let textAfter = field.selection.end < UTF16Text.length(field.value)
            if let fieldFrame, !SurfaceGate.fitsInField(ghost: ghostRect, field: fieldFrame, textAfterCaret: textAfter) {
                return hold(injection, .wouldOverlapText, retry: false)
            }
        }
        cancelPending()
        clear(exit: 0)
        // A new offer takes the one panel: whatever work line or result was on it ends.
        endWork()
        endResult()
        let offer = make(field)
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
            offerID: offerID, offer: stamped, caret: caret, snapshot: usesKeyTypeGhost ? snapshot : nil, style: style,
            ghostFont: ghostFont, field: fieldFrame ?? caret, quoted: quoted
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
        status.increment("surface.injected.\(offer.kind.name)")
        return #"{"ok":true,"offerId":\#(offerID)}"#
    }

    /// Nothing is drawn; the offer waits, and is tried again every half second for 30 s (or not at
    /// all when only the field's own content could change the answer).
    private func hold(_ injection: SurfaceInjection, _ reason: SurfaceGate.Hold, retry: Bool = true) -> String {
        status.increment("surface.held.\(reason.rawValue)")
        if retry {
            let since = pending?.since ?? Date()
            pending = (injection, since, reason)
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
        _ = inject(pending.injection)
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
        lineText = text
        figureState = figure
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
        if resultTimer != nil, snapshot.statusLine?.id != resultStatusID {
            resultTimer?.invalidate()
            resultTimer = nil
            panel.exit(duration: 0.08)
            figureState = nil
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
        // the action on: focus may have moved in an app that posts no focus notification.
        if !claim.insertsText {
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
            // Alternatives: the chosen text is on its way into the field; nothing animates.
            clear(exit: 0)
            lastAccepted = Accepted(candidate: claim.choice.candidate, source: claim.offer.source.rawValue, kind: claim.offer.kind.name)
            publish()
            return
        }
        let accept = OfferAccept.from(claim, at: Int64((Date().timeIntervalSince1970 * 1000).rounded()))
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
        startWork(claim, offerKey: accept?.offerId ?? "?", caret: shown.caret)
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
        guard result.claim.offer.source == .debug, case .ghost = result.claim.offer.kind else { return }
        status.increment(result.insertion.ok ? "surface.insertion.ok" : "surface.insertion.failed")
    }

    // MARK: - Work after Tab

    /// The line, in place, becomes the working caption; the figure looks away and leaves.
    private func startWork(_ claim: Claim, offerKey: String, caret: CGRect) {
        endWork()
        endResult()
        lineSuppressed = false
        let app: String
        switch claim.offer.kind {
        case .action(let line): app = line.app
        default: app = "Calendar"
        }
        let statusID = arbiter.showStatus(StatusLine(pid: claim.offer.target.pid, kind: .working(startedAt: Date()), offerKey: offerKey))
        work = Work(offerKey: offerKey, app: app, pid: claim.offer.target.pid, statusID: statusID, startedAt: Date())
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
        var caption = Captions.working(character, app: work.app)
        if stoppable { caption += ", \(seconds) s" }
        let content = LineContent(
            figure: figureLeft ? .absent : .working, app: work.app, text: caption, emphasis: .plain,
            hints: stoppable ? [Hint(key: "Esc", label: "Stop")] : [], appGlyphOnly: true
        )
        guard arbiter.snapshot().statusLine?.id == work.statusID else { return }
        guard !lineSuppressed else { return }
        panel.setContent(LineView(content: content, character: character))
        panel.text = caption
        figureState = .working
        if !panel.isVisible { panel.enter() }
        publish()
    }

    /// `progress done|error` on the debug socket, or the helper's task progress once it exists.
    func progress(_ phase: String) -> String {
        guard let work else { return #"{"error":"no work running"}"# }
        endWork()
        switch phase {
        case "done":
            let done = Captions.done(character, app: work.app)
            resultStatusID = arbiter.showStatus(StatusLine(pid: work.pid, kind: .result, offerKey: work.offerKey))
            showResult(LineContent(figure: .done, lead: done.lead, text: done.rest, emphasis: .plain), text: "\(done.lead) \(done.rest)", lifetime: 5)
        case "error":
            resultStatusID = arbiter.showStatus(StatusLine(pid: work.pid, kind: .error, offerKey: work.offerKey))
            let caption = Captions.error(character, app: work.app)
            showResult(LineContent(figure: .error, text: caption, emphasis: .plain), text: caption, lifetime: 6)
        default:
            return #"{"error":"phase is done or error"}"#
        }
        return #"{"ok":true}"#
    }

    /// Esc on a working line after 3 s: stop, and say so for 2 s.
    func stopWork(_ line: StatusLine) {
        guard let work, work.statusID == line.id else { return }
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
    }

    private func endWork() {
        work?.timer?.invalidate()
        if let work { arbiter.clearStatus(id: work.statusID) }
        work = nil
        onWorkingChanged?(false)
    }

    /// The working line becomes the result where it stands, and leaves after `lifetime`.
    private func showResult(_ content: LineContent, text: String, lifetime: TimeInterval) {
        guard !lineSuppressed else { return }
        panel.setContent(LineView(content: content, character: character))
        panel.text = text
        figureState = content.figure
        if !panel.isVisible { panel.enter() }
        resultTimer?.invalidate()
        let statusID = resultStatusID
        resultTimer = Timer.scheduledTimer(withTimeInterval: lifetime, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.resultStatusID == statusID else { return }
                self.resultTimer = nil
                if let id = self.resultStatusID { self.arbiter.clearStatus(id: id) }
                self.resultStatusID = nil
                self.panel.exit(duration: 0.20)
                self.figureState = nil
                self.publish()
            }
        }
        publish()
    }

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
        if shown != nil, work == nil, resultTimer == nil { panel.exit(duration: duration) }
        shown = nil
        figureState = nil
    }

    func shutdown() {
        cancelPending()
        watch.stop()
        endWork()
        resultTimer?.invalidate()
        clear(exit: 0)
        panel.exit(duration: 0)
    }

    /// Recomputed on every change and on each socket read, from what is on screen.
    func debugInfo() -> DebugState.SurfaceInfo {
        let snapshot = arbiter.snapshot()
        var info = DebugState.SurfaceInfo()
        if let shown {
            info.offerId = shown.offerID
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
        info.lineText = panel.isVisible ? panel.text : nil
        info.working = work.map { Date().timeIntervalSince($0.startedAt) }
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
