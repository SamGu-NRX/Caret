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
    private var listFrame: CGRect?
    private var listAbove = false
    private let list = HostedPanel(radius: 8)
    private var panel = HostedPanel(radius: 10)
    private var lastRead: FieldRead?
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

    func receive(_ offer: HelperOffer) {
        // `OfferField` names no window yet (B8 adds the reader's number and title); pass it here
        // when it does, and `FieldMatch` already compares it.
        machine.receive(offer, window: nil)
    }

    func withdrawn(_ message: OfferWithdrawn) { machine.withdrawn(message) }

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
        guard let caret = snapshot.caretRect ?? Self.derivedCaret(field: read.field, frame: read.frame, font: font) else { return .noCaret }
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
        case .accept(let accept): client.send(accept); return true
        case .stop(let stop): client.send(stop); return true
        case .control(let control): return client.send(control)
        }
    }

    // MARK: - Carrying out the machine's commands

    private func perform(_ command: SurfaceCommand) {
        switch command {
        case .drawAlternatives(let draw): drawAlternatives(draw)
        case .typedThrough(let offerID, let typed, let remainder, let caret): typedThrough(offerID: offerID, typed: typed, remainder: remainder, caret: caret)
        case .clearCaret: clearCaret()
        case .showPanel(let content, let text, let placement):
            switch content {
            case .line(let line): show(LineView(content: line, character: character), text: text, placement: placement)
            case .popup(let spec, let highlight): show(PopupView(spec: spec, highlight: highlight, character: character), text: text, placement: placement)
            }
        case .hidePanel(let exit): panel.exit(duration: exit)
        case .workingChanged(let working): onWorkingChanged?(working)
        case .toastSlotTaken: onToastChanged?()
        case .count(let name): status.increment(name)
        case .publish: publish()
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
        let decorView = HStack(alignment: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                if draw.quoted { UnevenUnderline(width: width, animated: draw.entering) }
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

        drawList(draw)
    }

    /// The open list sits below the field, clear of the next field and its label; it flips above
    /// only when below would cover something and above would not.
    private func drawList(_ draw: AlternativesDraw) {
        guard draw.ui.open else { return list.exit(duration: 0) }
        let candidates = draw.candidates
        let view = AlternativesListView(candidates: candidates, current: draw.ui.candidate)
        let size = list.measure(view)
        let x = draw.caret.minX - 12
        let below = CGRect(x: x, y: draw.field.maxY + 6, width: size.width, height: size.height)
        let above = CGRect(x: x, y: draw.field.minY - 6 - size.height, width: size.width, height: size.height)
        if !list.isVisible || listFrame == nil {
            let obstacles = ObstacleProbe.obstacles(pid: draw.pid, under: [below, above])
                .filter { !$0.insetBy(dx: -2, dy: -2).contains(draw.field) }
            let choice = PanelPlacement.choose([below, above], obstacles: obstacles, bounds: Screen.axVisibleFrame(around: draw.field))
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

    private func clearCaret() {
        listFrame = nil
        ghost.hide()
        ownGhost.exit(duration: 0)
        decor.exit(duration: 0)
        list.exit(duration: 0)
        drawn = nil
    }

    /// The offer line or pop-up at the caret: left edge 12 pt left of it, top 6 pt below, flipped
    /// above when there is no room; the panel scales in from the corner at the caret. A working or
    /// result line is redrawn where it stands.
    private func show<V: View>(_ view: V, text: String, placement: PanelPlacementRequest) {
        switch placement {
        case .inPlace:
            panel.setContent(view)
            panel.text = text
            if !panel.isVisible { panel.enter() }
        case .atCaret(let caret, let entering):
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
            let enter = entering || !panel.isVisible
            if enter { panel.pin(anchor) }
            panel.setContent(view)
            panel.text = text
            if enter { panel.enter() }
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
        info.decor = decor.debugInfo()
        info.list = list.debugInfo()
        info.character = character.rawValue
        if !headless { info.lineText = panel.isVisible ? panel.text : nil }
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
