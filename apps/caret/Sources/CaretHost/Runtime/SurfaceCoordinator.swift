import AppCompatibility
import AppKit
import ApplicationServices
import AutocompleteCore
import CaretHostCore
import CaretScreenCore
import CompletionUI
import MacContextCapture
import SwiftUI

/// The screen side of `SurfaceMachine`, which decides alternatives at the caret, action lines,
/// pop-ups, and the working, result and error lines after Tab (`SURFACES.md` sections 2 to 4
/// and 6). This class answers the machine's questions from NSWorkspace, Accessibility and the
/// window server, carries out its commands with the panels and KeyType's ghost renderer, and
/// sends its messages to the helper. Every decision is the machine's and is tested there
/// (`SurfaceMachineTests`); what stays here is reading the system and drawing.
@MainActor
final class SurfaceCoordinator {
    /// What was read with a field: the element, and once its caret was asked for, what the ghost
    /// renderer needs to draw in it.
    private struct FieldRead {
        let id: UInt64
        let element: AXUIElement
        let field: FieldState
        let frame: CGRect?
        var snapshot: FocusedFieldSnapshot?
        var style: OverlayTextStyle?
        var font: NSFont?
    }

    /// The alternatives drawn at the caret, and with what.
    private struct Drawn {
        let offerID: UInt64
        /// Set when KeyType's renderer placed the ghost text; nil when Caret drew its own.
        let snapshot: FocusedFieldSnapshot?
        let style: OverlayTextStyle
        let font: NSFont
    }

    private let machine: SurfaceMachine
    private let world: World
    private let status: HostStatus
    private let policy: TargetPolicy
    private let headless: Bool
    private let ghost: GhostOverlay
    private let reader = FocusedFieldReader()
    private let decor = HostedPanel(radius: 0, material: false)
    private let ownGhost = HostedPanel(radius: 0, material: false)
    /// Where the open list went for the shown offer, chosen once so the arrows never move it.
    private var listSpot: FieldPanelPlacement.Choice?
    private let list = HostedPanel(radius: 8)
    private var panel = HostedPanel(radius: 10)
    /// Where the panel was placed around its field, and with what it was measured, so a redraw
    /// that grows it can check it still covers nothing.
    private struct Placed {
        var choice: FieldPanelPlacement.Choice
        let field: CGRect
        let caret: CGRect
        let pid: Int32
        var milliseconds: Double
    }
    private var placed: Placed?
    /// The placement `panelIsClear` just measured, so the draw that follows does not probe the same
    /// ground twice. Used once, and only for the same content around the same field.
    private var fitted: (content: PanelContent, field: CGRect, caret: CGRect, pid: Int32, placed: Placed)?
    /// The debug socket's stand-in for a small screen (`placement-bounds`, test hooks only): panels
    /// are placed within it instead of the screen's visible frame. Global, top-left origin.
    var placementBounds: CGRect?
    private var lastRead: FieldRead?
    /// The on-screen part of the last field read, for the compact line in a text view
    /// (`FieldPanelPlacement.caretLineSpot`). Keyed by the field's frame, as placements are.
    private var lastVisible: (field: CGRect, visible: CGRect)?
    private var nextReadID: UInt64 = 1
    private var drawn: Drawn?
    private var activation: NSObjectProtocol?
    var executor: InsertionExecutor?
    var client: HelperClient?
    /// Called with true while accepted work runs, so the menu bar glyph can tint Carrot.
    var onWorkingChanged: ((Bool) -> Void)?
    /// Called when this coordinator's toast took the arbiter's one toast slot, so the fill line's
    /// own toast can take itself down (they share the slot).
    var onToastChanged: (() -> Void)?
    private var character: FigureCharacter { FigureSettings.shared.character }

    init(arbiter: OfferArbiter, status: HostStatus, policy: TargetPolicy, compatibilityStore: AppCompatibilityStore, headless: Bool = false) {
        self.status = status
        self.policy = policy
        self.headless = headless
        ghost = GhostOverlay(compatibilityStore: compatibilityStore)
        let world = World()
        self.world = world
        machine = SurfaceMachine(arbiter: arbiter, world: world, clock: RunLoopClock(), headless: headless)
        world.owner = self
        machine.output = { [weak self] command in MainActor.assumeIsolated { self?.perform(command) } }
        machine.sendToHelper = { [weak self] message in MainActor.assumeIsolated { self?.send(message) ?? false } }
        // A shown surface is rechecked as soon as another app activates, not only every half second.
        activation = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.machine.recheckVisibility() }
        }
    }

    // MARK: - Events in, forwarded to the machine

    func receive(_ offer: HelperOffer) { machine.receive(offer) }
    func withdrawn(_ message: OfferWithdrawn) { machine.withdrawn(message) }
    func helperGone() { machine.helperGone() }

    /// Publishes and draws an injected offer for the focused field of `pid`. Returns a JSON reply.
    func inject(_ injection: SurfaceInjection) -> String { machine.inject(injection) }

    func navigated(offerID: UInt64, ui: OfferUI) { machine.navigated(offerID: offerID, ui: ui) }
    func offerChanged(_ reason: OfferArbiter.PassReason) { machine.offerChanged(reason) }
    func displaced(_ offer: Offer) { machine.displaced(offer) }
    func focusChanged(_ identity: TargetIdentity?) { machine.focusChanged(identity) }
    func claimed(_ claim: Claim) { machine.claimed(claim) }
    func taskProgress(_ progress: TaskProgress) { machine.taskProgress(progress) }
    func progress(_ phase: String) -> String { machine.progress(phase) }
    func undoStarted(_ grant: UndoGrant) { machine.undoStarted(grant) }
    func toastChanged() { machine.toastChanged() }
    func gateClosed() { machine.gateClosed() }
    func stopWork(_ line: StatusLine) { machine.stopWork(line) }
    func skillOffer(_ offer: SkillOffer) { machine.skillOffer(offer) }
    func offerClosed(_ offerID: UInt64) { machine.offerClosed(offerID) }
    func activity(_ record: TaskRecord) { machine.activity(record) }

    func insertionFinished(_ result: InsertionExecutor.Result) {
        guard result.claim.offer.source != .engine, case .ghost = result.claim.offer.kind else { return }
        status.increment(result.insertion.ok ? "surface.insertion.ok" : "surface.insertion.failed")
    }

    func shutdown() {
        if let activation { NSWorkspace.shared.notificationCenter.removeObserver(activation) }
        activation = nil
        machine.shutdown()
        panel.exit(duration: 0)
    }

    // MARK: - Reading the system (the machine's `SurfaceWorld`)

    fileprivate func allows(pid: Int32) -> Bool {
        headless ? policy.allows(pid: pid, bundleID: nil) : policy.allowsLive(pid: pid)
    }

    fileprivate func readField(pid: Int32) -> FocusedField? {
        guard let (element, field) = FieldReader.readFocused(pid: pid) else { return nil }
        let frame = AXRead.frame(of: element)
        let id = nextReadID
        nextReadID &+= 1
        lastRead = FieldRead(id: id, element: element, field: field, frame: frame)
        lastVisible = frame.flatMap { f in
            AXRead.visibleFrame(of: element, frame: f, screen: bounds(around: f)).map { (f, $0) }
        }
        return FocusedField(
            identity: field.identity, value: field.value, selection: field.selection, frame: frame,
            window: AXRead.windowIdentity(of: element), readID: id
        )
    }

    fileprivate func caret(of field: FocusedField) -> CaretRead {
        guard var read = lastRead, read.id == field.readID else { return .noSnapshot }
        guard let snapshot = reader.snapshot(of: read.element) else { return .noSnapshot }
        let style = FieldStyleProbe.style(of: read.element)
        let font = style.font ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)
        read.snapshot = snapshot
        read.style = style
        read.font = font
        lastRead = read
        guard let caret = snapshot.caretRectAX ?? Self.derivedCaret(field: read.field, frame: read.frame, font: font) else { return .noCaret }
        return .at(caret)
    }

    fileprivate func textWidth(_ text: String, readID: UInt64) -> CGFloat {
        let font = lastRead.flatMap { $0.id == readID ? $0.font : nil } ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)
        return (text as NSString).size(withAttributes: [.font: font]).width
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

    private func send(_ message: SurfaceSend) -> Bool {
        guard let client else { return false }
        switch message {
        case .accept(let accept): return client.send(accept)
        case .stop(let stop): return client.send(stop)
        case .control(let control): return client.send(control)
        case .skillAnswer(let answer): return client.send(answer)
        }
    }

    // MARK: - Carrying out the machine's commands

    private func perform(_ command: SurfaceCommand) {
        switch command {
        case .drawAlternatives(let draw): drawAlternatives(draw)
        case .typedThrough(let offerID, let typed, let remainder, let caret): typedThrough(offerID: offerID, typed: typed, remainder: remainder, caret: caret)
        case .clearCaret: clearCaret()
        case .showPanel(let content, let text, let placement):
            show(Self.view(content, character: character), narrows: Self.narrows(content), text: text, placement: placement, content: content)
            announce(content)
        case .hidePanel(let exit): panel.exit(duration: exit)
        case .workingChanged(let working): onWorkingChanged?(working)
        case .toastSlotTaken: onToastChanged?()
        case .count(let name): status.increment(name)
        case .publish: publish()
        case .log(let line): FileHandle.standardError.write(Data("caret: surface: \(line)\n".utf8))
        }
    }

    /// Ghost text with alternatives: the top one faint, the uneven underline under it while
    /// closed; once open, the current one in place, the figure and "2 of 4" after it, and the
    /// numbered list below. Every change here comes from a key, so none of it animates except the
    /// underline drawing in once with the offer.
    private func drawAlternatives(_ draw: AlternativesDraw) {
        let text = draw.currentText
        if draw.entering {
            guard let read = lastRead, read.id == draw.readID, let snapshot = read.snapshot, let style = read.style, let font = read.font else { return }
            let usesKeyTypeGhost = ghost.show(text, at: snapshot, style: style) != nil
            if !usesKeyTypeGhost { drawOwnGhost(text, caret: draw.caret, font: font, color: style.textColor) }
            executor?.remember(offerID: draw.offerID, context: snapshot.context)
            status.increment(usesKeyTypeGhost ? "surface.ghost.keytype" : "surface.ghost.own")
            drawn = Drawn(offerID: draw.offerID, snapshot: usesKeyTypeGhost ? snapshot : nil, style: style, font: font)
        } else if let drawn, drawn.offerID == draw.offerID {
            if let snapshot = drawn.snapshot {
                ghost.show(text, at: snapshot, style: drawn.style)
            } else {
                drawOwnGhost(text, caret: draw.caret, font: drawn.font, color: drawn.style.textColor)
            }
        }
        let candidates = draw.candidates
        let ui = draw.ui
        guard candidates.count > 1 else {
            decor.exit(duration: 0)
            list.exit(duration: 0)
            return
        }
        let caret = draw.caret
        let font = drawn?.font ?? NSFont.systemFont(ofSize: 13)
        let width = ceil((text as NSString).size(withAttributes: [.font: font]).width)
        let figureHeight = min(max((caret.height * 0.6).rounded(), 9), 14)
        let tag = AlternativesTag(current: ui.candidate, count: candidates.count, character: character, figureHeight: figureHeight)
        // Collapsed, one mark at most: the faint value, underlined only when it is quoted from a
        // source. The figure and the count come with the down arrow, and only where they fit
        // inside the field after the text.
        let tagWidth = NSHostingView(rootView: tag).fittingSize.width + font.pointSize * 0.3
        let showTag = ui.open && caret.maxX + width + tagWidth <= draw.field.maxX - 2
        guard draw.quoted || showTag else {
            decor.exit(duration: 0)
            drawList(draw)
            return
        }
        // The underline sits at the decor's bottom, up to 4 pt under the caret, but never below
        // the field: KeyType estimates a single-line field's caret flush with its bottom edge.
        let decorHeight = max(caret.height, min(caret.height + 4, draw.field.maxY - caret.minY))
        let decorView = HStack(alignment: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                if draw.quoted { UnevenUnderline(width: width, animated: draw.entering) }
            }
            .frame(width: width, height: decorHeight)
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

        drawList(draw)
    }

    /// The open list goes where a pop-up would (`FieldPanelPlacement`): below the field, clear of
    /// the next field and its label; else above, else beside the field. Chosen once per opening, so
    /// the arrows never move it. A10's filled-field run showed the old below-or-above choice over
    /// the first field putting the list on the window's title bar.
    private func drawList(_ draw: AlternativesDraw) {
        guard draw.ui.open else { return list.exit(duration: 0) }
        let candidates = draw.candidates
        let view = AlternativesListView(candidates: candidates, current: draw.ui.candidate)
        if !list.isVisible || listSpot == nil {
            let probe = ObstacleProbe.Session(pid: draw.pid, until: DispatchTime.now().uptimeNanoseconds + Self.probeBudget)
            let choice = FieldPanelPlacement.choose(
                field: draw.field, caret: draw.caret, size: list.measure(view), narrow: nil,
                bounds: Screen.axVisibleFrame(around: draw.field), obstacles: { probe.under([$0]) }
            )
            listSpot = choice
            status.increment("surface.list.\(choice.spot.rawValue)")
        }
        guard let spot = listSpot else { return }
        list.pin(HostedPanel.Anchor(corner: Self.corner(spot.spot.corner), point: Self.cocoaPoint(spot)))
        list.setContent(view)
        list.text = candidates.prefix(3).enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: " | ")
        if !list.panel.isVisible || list.isExiting { list.panel.alphaValue = 1; list.panel.orderFrontRegardless() }
    }

    private func typedThrough(offerID: UInt64, typed: String, remainder: String, caret: CGRect) {
        decor.exit(duration: 0)
        list.exit(duration: 0)
        guard let drawn, drawn.offerID == offerID else { return }
        if drawn.snapshot != nil {
            ghost.advance(typed: typed, remainder: remainder)
        } else {
            let shift = (typed as NSString).size(withAttributes: [.font: drawn.font]).width
            drawOwnGhost(remainder, caret: caret.offsetBy(dx: shift, dy: 0), font: drawn.font, color: drawn.style.textColor)
        }
    }

    /// The panel is another app's window and never takes focus, so VoiceOver hears what needs the
    /// user once: a skill's run with no Tab starting, and a question under a result or its answer.
    private var announced: String?
    private func announce(_ content: PanelContent) {
        guard let words = Self.spoken(content), words != announced else { return }
        announced = words
        AccessibilityNotification.Announcement(words).post()
    }

    /// What VoiceOver hears for a line, or nil when the line is not announced. Each part is a
    /// sentence of its own, ended once: A16's live log heard "Keep this as …?. Caret will offer it
    /// when you start it again.." when the parts were joined with ". ".
    static func spoken(_ content: PanelContent) -> String? {
        guard case .line(let line) = content else { return nil }
        let parts: [String]
        if let q = line.question {
            let keys = q.hints.map { h in h.label.map { "\(h.key): \($0)" } ?? h.key }
            parts = [q.text] + (q.detail.map { [$0] } ?? []) + keys
        } else if line.lead == "On its own:" {
            parts = ["\(line.lead ?? "") \(line.text)", "Esc takes over"]
        } else {
            return nil
        }
        return parts.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            .map { [".", "?", "!"].contains($0.last.map(String.init) ?? "") ? $0 : $0 + "." }
            .joined(separator: " ")
    }

    private func clearCaret() {
        listSpot = nil
        ghost.hide()
        ownGhost.exit(duration: 0)
        decor.exit(duration: 0)
        list.exit(duration: 0)
        drawn = nil
    }

    /// The offer line or pop-up around its field (`FieldPanelPlacement`): below it, 12 pt left of
    /// the caret, unless that covers another of the app's fields or labels; then above, narrower,
    /// or beside the field. The panel scales in from the corner nearest the field. A redraw keeps
    /// the spot unless the panel grew onto something; a working or result line is redrawn where
    /// it stands.
    /// How `content` is drawn, at an optional narrow width (pop-ups only).
    static func view(_ content: PanelContent, character: FigureCharacter) -> (CGFloat?) -> AnyView {
        switch content {
        case .line(let line): return { _ in AnyView(LineView(content: line, character: character)) }
        case .compactLine(let line): return { _ in AnyView(LineView(content: line, character: character, compact: true)) }
        case .popup(let spec, let highlight): return { width in AnyView(PopupView(spec: spec, highlight: highlight, character: character, width: width)) }
        }
    }

    static func narrows(_ content: PanelContent) -> Bool {
        if case .popup = content { return true }
        return false
    }

    /// Where panels around `field` may go: the screen's visible frame, or the test hook's bounds.
    private func bounds(around field: CGRect) -> CGRect {
        placementBounds ?? Screen.axVisibleFrame(around: field)
    }

    /// The machine asks before it publishes an action line or pop-up: does `content` have a spot
    /// around the field that covers none of the app's own elements? The probe is the one the draw
    /// would make, and its answer is kept for that draw.
    fileprivate func panelIsClear(_ content: PanelContent, field: CGRect, caret: CGRect, pid: Int32) -> Bool {
        let placed = place(Self.view(content, character: character), narrows: Self.narrows(content), field: field, caret: caret, pid: pid, counts: false, content: content)
        fitted = (content, field, caret, pid, placed)
        return placed.choice.overlap == 0
    }

    private func show(_ view: (CGFloat?) -> AnyView, narrows: Bool, text: String, placement: PanelPlacementRequest, content: PanelContent? = nil) {
        let fit = fitted
        fitted = nil
        switch placement {
        case .inPlace:
            panel.setContent(view(placed?.choice.spot.isNarrow == true ? PopupView.minWidth : nil))
            panel.text = text
            if !panel.isVisible { panel.enter() }
        case .atField(let field, let caret, let pid, let entering):
            let enter = entering || !panel.isVisible || placed == nil
            if let fit, fit.content == content, fit.field == field, fit.caret == caret, fit.pid == pid {
                // The machine probed this very content around this field just now: that spot, also
                // for an offer swapped in place without an entrance (review A13, finding 5).
                placed = fit.placed
                countPlacement(fit.placed.choice)
            } else if enter {
                placed = place(view, narrows: narrows, field: field, caret: caret, pid: pid, content: content)
            } else if var current = placed {
                // Content grew or shrank about the pinned corner (a reveal, the highlight moving).
                // Only the area it grew into is probed; if that covers something, runs off the
                // screen, or could not be probed in time, it is placed again: a spot is never kept
                // over ground nobody checked (A10 review).
                let width: CGFloat? = current.choice.spot.isNarrow ? PopupView.minWidth : nil
                let size = panel.measure(view(width))
                let grown = Self.frame(pinnedAt: current.choice, size: size)
                if grown.size != current.choice.frame.size {
                    let usable = bounds(around: field).insetBy(dx: FieldPanelPlacement.margin, dy: FieldPanelPlacement.margin)
                    let added = FieldPanelPlacement.added(grown, beyond: current.choice.frame)
                    let under = added.isEmpty ? [] : ObstacleProbe.Session(pid: pid, until: DispatchTime.now().uptimeNanoseconds + Self.probeBudget)
                        .under(added)?.filter { !$0.insetBy(dx: -2, dy: -2).contains(field) }
                    if !usable.contains(grown) || under.map({ $0.contains(where: { $0.intersects(grown) }) }) ?? true {
                        placed = place(view, narrows: narrows, field: field, caret: caret, pid: pid, content: content)
                    } else {
                        current.choice.frame = grown
                        placed = current
                    }
                }
            }
            let chosen = placed!.choice
            if enter || panel.anchor.point != Self.cocoaPoint(chosen) || panel.anchor.corner != Self.corner(chosen.spot.corner) {
                panel.pin(HostedPanel.Anchor(corner: Self.corner(chosen.spot.corner), point: Self.cocoaPoint(chosen)))
            }
            panel.setContent(view(chosen.spot.isNarrow ? PopupView.minWidth : nil))
            panel.text = text
            if enter { panel.enter() }
        }
    }

    private func place(
        _ view: (CGFloat?) -> AnyView, narrows: Bool, field: CGRect, caret: CGRect, pid: Int32, counts: Bool = true, content: PanelContent? = nil
    ) -> Placed {
        let started = DispatchTime.now().uptimeNanoseconds
        let size = panel.measure(view(nil))
        // The compact line in a text view hangs from the caret's line inside the view's visible
        // part, unprobed (A18, bug 2).
        if case .compactLine? = content, let seen = lastVisible, seen.field == field,
           let spot = FieldPanelPlacement.caretLineSpot(field: field, caret: caret, size: size, visible: seen.visible) {
            if counts { countPlacement(spot) }
            let ms = Double(DispatchTime.now().uptimeNanoseconds &- started) / 1_000_000
            return Placed(choice: spot, field: field, caret: caret, pid: pid, milliseconds: ms)
        }
        let narrow = narrows && size.width > PopupView.minWidth ? panel.measure(view(PopupView.minWidth)) : nil
        let probe = ObstacleProbe.Session(pid: pid, until: started + Self.probeBudget)
        let choice = FieldPanelPlacement.choose(
            field: field, caret: caret, size: size, narrow: narrow, bounds: bounds(around: field),
            obstacles: { probe.under([$0]) }
        )
        if counts { countPlacement(choice) }
        let ms = Double(DispatchTime.now().uptimeNanoseconds &- started) / 1_000_000
        return Placed(choice: choice, field: field, caret: caret, pid: pid, milliseconds: ms)
    }

    /// A placement that is drawn, counted by spot; one covering something is counted apart (after
    /// A13 only the full card a user opened with ↓ can be, and only on a screen with no clear spot).
    private func countPlacement(_ choice: FieldPanelPlacement.Choice) {
        status.increment("surface.placed.\(choice.spot.rawValue)")
        // Only `caretLineSpot` answers with nothing probed and nothing covered.
        if choice.probed == 0, choice.overlap == 0 { status.increment("surface.placed.caretLine") }
        if choice.overlap ?? 0 > 0 { status.increment("surface.placed.covering") }
    }

    /// Hit-testing for one placement stops after this long on the main thread; a spot not fully
    /// probed by then is not taken. Assumed, from A10's on-screen runs in the claim form: 9 to 49
    /// ms for three to five spots at the coarser grid, 42 to 105 ms at this one with other runs
    /// loading the Mac, before points outside the app's windows were skipped. An unresponsive app
    /// could otherwise cost 50 ms per point.
    static let probeBudget: UInt64 = 200_000_000

    /// The frame a panel of `size` takes when pinned at `choice`'s corner.
    static func frame(pinnedAt choice: FieldPanelPlacement.Choice, size: CGSize) -> CGRect {
        let p = choice.cornerPoint
        switch choice.spot.corner {
        case .topLeft: return CGRect(x: p.x, y: p.y, width: size.width, height: size.height)
        case .topRight: return CGRect(x: p.x - size.width, y: p.y, width: size.width, height: size.height)
        case .bottomLeft: return CGRect(x: p.x, y: p.y - size.height, width: size.width, height: size.height)
        case .bottomRight: return CGRect(x: p.x - size.width, y: p.y - size.height, width: size.width, height: size.height)
        }
    }

    /// The pinned corner in Cocoa coordinates: Accessibility's top edge is Cocoa's maxY.
    private static func cocoaPoint(_ choice: FieldPanelPlacement.Choice) -> NSPoint {
        let p = choice.cornerPoint
        return NSPoint(x: p.x, y: Screen.cocoa(CGRect(x: p.x, y: p.y, width: 0, height: 0)).maxY)
    }

    /// Accessibility's top-left corner is Cocoa's top-left too; only the y axis flips.
    private static func corner(_ corner: FieldPanelPlacement.Corner) -> HostedPanel.Corner {
        switch corner {
        case .topLeft: return .topLeft
        case .topRight: return .topRight
        case .bottomLeft: return .bottomLeft
        case .bottomRight: return .bottomRight
        }
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

    // MARK: - Debug state

    /// The machine's state plus what only the screen knows: the panels and the ghost text drawn.
    func debugInfo() -> DebugState.SurfaceInfo {
        var info = machine.debugInfo()
        info.ghost = ghost.shownText ?? (ownGhost.isVisible ? ownGhost.text : nil)
        info.ghostPanel = ownGhost.debugInfo()
        info.panel = panel.debugInfo()
        if info.panel != nil, let placed {
            info.panelPlacement = DebugState.PanelPlacementInfo(
                spot: placed.choice.spot.rawValue, overlap: placed.choice.overlap.map(Double.init), probed: placed.choice.probed,
                milliseconds: placed.milliseconds, field: [placed.field.minX, placed.field.minY, placed.field.width, placed.field.height].map(Double.init)
            )
        }
        info.decor = decor.debugInfo()
        info.list = list.debugInfo()
        info.character = character.rawValue
        if !headless {
            info.lineText = panel.isVisible ? panel.text : nil
            info.reduceMotion = Motion.reduceMotion
        }
        return info
    }

    private func publish() {
        let info = debugInfo()
        status.update { $0.surface = info }
    }
}

/// The machine's questions, answered by the coordinator on the main thread.
private final class World: SurfaceWorld {
    weak var owner: SurfaceCoordinator?

    func allows(pid: Int32) -> Bool { MainActor.assumeIsolated { owner?.allows(pid: pid) ?? false } }
    var frontmostPID: Int32? { MainActor.assumeIsolated { NSWorkspace.shared.frontmostApplication?.processIdentifier } }
    func focusedField(pid: Int32) -> FocusedField? { MainActor.assumeIsolated { owner?.readField(pid: pid) } }
    func caret(of field: FocusedField) -> CaretRead { MainActor.assumeIsolated { owner?.caret(of: field) ?? .noSnapshot } }
    func focusedIdentity(pid: Int32) -> TargetIdentity? { FieldReader.readFocused(pid: pid)?.field.identity }
    func focusedFrame(pid: Int32) -> CGRect? { AXRead.focusedElement(pid: pid).flatMap(AXRead.frame(of:)) }

    func windowStack() -> WindowStack {
        MainActor.assumeIsolated {
            WindowStack(
                windows: Visibility.windows(), ownPID: ProcessInfo.processInfo.processIdentifier,
                displays: NSScreen.screens.map { Screen.ax($0.frame) }
            )
        }
    }

    func textWidth(_ text: String, readID: UInt64) -> CGFloat {
        MainActor.assumeIsolated { owner?.textWidth(text, readID: readID) ?? 0 }
    }

    func appName(pid: Int32) -> String? { NSRunningApplication(processIdentifier: pid)?.localizedName }
    func panelIsClear(_ content: PanelContent, field: CGRect, caret: CGRect, pid: Int32) -> Bool {
        MainActor.assumeIsolated { owner?.panelIsClear(content, field: field, caret: caret, pid: pid) ?? false }
    }
    var character: FigureCharacter { MainActor.assumeIsolated { FigureSettings.shared.character } }
    var reduceMotion: Bool { MainActor.assumeIsolated { Motion.reduceMotion } }
}

/// `SurfaceMachine`'s timers on the main run loop.
final class RunLoopClock: SurfaceClock {
    private final class Token: SurfaceTimer {
        let timer: Timer
        init(_ timer: Timer) { self.timer = timer }
        func cancel() { timer.invalidate() }
    }

    var now: Date { Date() }

    func schedule(after seconds: TimeInterval, repeats: Bool, _ fire: @escaping () -> Void) -> SurfaceTimer {
        Token(Timer.scheduledTimer(withTimeInterval: seconds, repeats: repeats) { _ in fire() })
    }
}
