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
    private let list = HostedPanel(radius: 8)
    private var panel = HostedPanel(radius: 10)
    var executor: InsertionExecutor?
    var client: HelperClient?
    /// Called with true while accepted work runs, so the menu bar glyph can tint Carrot.
    var onWorkingChanged: ((Bool) -> Void)?

    private var shown: Shown?
    private var work: Work?
    private var resultTimer: Timer?
    private var resultStatusID: UInt64?
    /// The figure has looked away and left the working line.
    private var figureLeft = false
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
        case .alternatives(let pid, let candidates):
            return present(pid: pid) { field in
                Offer(text: candidates[0], moreCandidates: Array(candidates.dropFirst()), source: .debug,
                      target: field.identity, fieldValue: field.value, caretUTF16: field.selection.start, maxAgeSeconds: 120)
            }
        case .action(let pid, let line):
            return present(pid: pid) { field in
                Offer(text: "", source: .debug, kind: .action(line), target: field.identity,
                      fieldValue: field.value, caretUTF16: field.selection.start, maxAgeSeconds: 120)
            }
        case .popup(let pid, let popup):
            return present(pid: pid) { field in
                Offer(text: "", source: .debug, kind: .popup(popup), target: field.identity,
                      fieldValue: field.value, caretUTF16: field.selection.start, maxAgeSeconds: 120)
            }
        case .helperLine:
            return #"{"error":"helperLine is handled by the runtime"}"#
        }
    }

    private func present(pid: Int32, make: (FieldState) -> Offer) -> String {
        guard policy.allowsLive(pid: pid) else { return #"{"error":"pid not allowed"}"# }
        guard let (element, field) = FieldReader.readFocused(pid: pid) else { return #"{"error":"no focused text field in pid"}"# }
        guard let snapshot = reader.snapshot(of: element), let caret = snapshot.caretRect ?? AXRead.frame(of: element) else {
            return #"{"error":"no caret"}"#
        }
        clear(exit: 0)
        let offer = make(field)
        guard let offerID = arbiter.publish(offer) else { return #"{"error":"arbiter refused (an insertion is running)"}"# }
        let stamped = arbiter.snapshot().current.flatMap { $0.id == offerID ? $0 : nil } ?? offer
        let style = FieldStyleProbe.style(of: element)
        var ghostFont: NSFont?
        if case .ghost = offer.kind {
            guard ghost.show(offer.text, at: snapshot, style: style) != nil else {
                arbiter.invalidate(offerID: offerID)
                return #"{"error":"no ghost placement"}"#
            }
            executor?.remember(offerID: offerID, context: snapshot.context)
            ghostFont = style.font ?? NSFont.systemFont(ofSize: max(11, caret.height * 0.78))
        }
        shown = Shown(offerID: offerID, offer: stamped, caret: caret, snapshot: snapshot, style: style, ghostFont: ghostFont)
        draw(ui: arbiter.snapshot().ui, entering: true)
        status.increment("surface.injected.\(offer.kind.name)")
        return #"{"ok":true,"offerId":\#(offerID)}"#
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
        if let snapshot = shown.snapshot, let style = shown.style, !entering {
            ghost.show(text, at: snapshot, style: style)
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
        let decorView = HStack(alignment: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                UnevenUnderline(width: width, animated: entering)
            }
            .frame(width: width, height: caret.height + 4)
            if ui.open {
                AlternativesTag(current: ui.candidate, count: candidates.count, character: character, figureHeight: figureHeight)
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

        if ui.open {
            list.pin(HostedPanel.Anchor(corner: .topLeft, point: NSPoint(x: caret.maxX - 12, y: Screen.cocoa(caret).minY - 6)))
            list.setContent(AlternativesListView(candidates: candidates, current: ui.candidate))
            list.text = candidates.prefix(3).enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: " | ")
            if !list.panel.isVisible || list.isExiting { list.panel.alphaValue = 1; list.panel.orderFrontRegardless() }
        } else {
            list.exit(duration: 0)
        }
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

    func claimed(_ claim: Claim) {
        guard let shown, claim.offer.id == shown.offerID else { return }
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
        decor.exit(duration: 0)
        list.exit(duration: 0)
        self.shown = nil
        startWork(claim, offerKey: accept?.offerId ?? "?", caret: shown.caret)
        publish()
    }

    func insertionFinished(_ result: InsertionExecutor.Result) {
        guard result.claim.offer.source == .debug, case .ghost = result.claim.offer.kind else { return }
        status.increment(result.insertion.ok ? "surface.insertion.ok" : "surface.insertion.failed")
    }

    // MARK: - Work after Tab

    /// The line, in place, becomes the working caption; the figure looks away and leaves.
    private func startWork(_ claim: Claim, offerKey: String, caret: CGRect) {
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
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                MainActor.assumeIsolated {
                    self?.figureLeft = true
                    self?.renderWorking()
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

    private func endWork() {
        work?.timer?.invalidate()
        if let work { arbiter.clearStatus(id: work.statusID) }
        work = nil
        onWorkingChanged?(false)
    }

    /// The working line becomes the result where it stands, and leaves after `lifetime`.
    private func showResult(_ content: LineContent, text: String, lifetime: TimeInterval) {
        panel.setContent(LineView(content: content, character: character))
        panel.text = text
        figureState = content.figure
        if !panel.isVisible { panel.enter() }
        resultTimer?.invalidate()
        resultTimer = Timer.scheduledTimer(withTimeInterval: lifetime, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
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
        if shown != nil, case .ghost? = shown?.offer.kind { ghost.hide() }
        decor.exit(duration: 0)
        list.exit(duration: 0)
        if shown != nil, work == nil, resultTimer == nil { panel.exit(duration: duration) }
        shown = nil
        figureState = nil
    }

    func shutdown() {
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
        info.ghost = ghost.shownText
        info.panel = panel.debugInfo()
        info.decor = decor.debugInfo()
        info.list = list.debugInfo()
        info.figure = figureState?.rawValue
        info.character = character.rawValue
        info.lineText = panel.isVisible ? panel.text : nil
        info.working = work.map { Date().timeIntervalSince($0.startedAt) }
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
