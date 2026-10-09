import AppCompatibility
import AppKit
import ApplicationServices
import AutocompleteCore
import Carbon
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
        /// The field's visible text area when it was read, for the capsule's placement on redraws.
        let viewport: CGRect?
        /// The capsule as last laid out, global top-left points; nil inline.
        var capsule: CGRect?
        /// The area the capsule was kept in, for the tag after it.
        var area: CGRect?
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
    private let list = HostedPanel(radius: Tokens.Shape.popupRadius, popup: true)
    /// H2's list, on with `CARET_ALTERNATIVES_LIST=list` so the lead can compare it with cycling in
    /// place. It shows only once the user is clearly browsing: after the second ↓ of an offer.
    static let alternativesList = ProcessInfo.processInfo.environment["CARET_ALTERNATIVES_LIST"] == "list"
    /// The offer whose candidates the user has moved through twice, which earns H2's list.
    private var browsed: (offerID: UInt64, moves: Int, last: Int)?
    private var panel = HostedPanel(radius: Tokens.Shape.slipRadius)
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
    /// H10: the last page field read (`PageFocusSource`), which has no element: its read id and frame.
    private var lastPageRead: (id: UInt64, frame: CGRect)?
    private var drawn: Drawn?
    private var activation: NSObjectProtocol?
    var executor: InsertionExecutor?
    var client: HelperClient?
    /// Called with true while accepted work runs, so the menu bar glyph can tint Carrot.
    var onWorkingChanged: ((Bool) -> Void)?
    /// Called when this coordinator's toast took the arbiter's one toast slot, so the fill line's
    /// own toast can take itself down (they share the slot).
    var onToastChanged: (() -> Void)?
    /// H8: where accepted events go, and the one place that asks macOS for Calendar access.
    private let calendars = EventKitCalendars.shared
    private var character: FigureCharacter { FigureSettings.shared.character }
    /// M1: the row under the slip naming where the offer's noticed fact came from, and its "Not
    /// right", for the offer on screen (`NotRight.swift`).
    private var notRight: (offerKey: String, memoryId: String, row: NotRightRow)?
    private let notRightTarget = NotRightTarget()
    /// The last panel drawn, so the row can redraw it in place when it changes.
    private var lastShown: (content: PanelContent, text: String, placement: PanelPlacementRequest)?
    /// Sends "Not right" for the fact behind an offer (`MemoryBook.notRight`): false when nothing
    /// was sent; `answered` hears nil when the helper made the change.
    var sendNotRight: (_ memoryId: String, _ offerKey: String, _ correction: String?, _ answered: @escaping (String?) -> Void) -> Bool = { _, _, _, _ in false }

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
        machine.calendarAccessUndetermined = { EventKitCalendars.shared.access == .notDetermined }
        notRightTarget.onClick = { [weak self] in self?.beginNotRight() }
        panel.panel.interceptKey = { [weak self] event in
            MainActor.assumeIsolated { self?.slipKey(event) ?? false }
        }
        // A shown surface is rechecked as soon as another app activates, not only every half second.
        activation = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.machine.recheckVisibility() }
        }
    }

    // MARK: - Events in, forwarded to the machine

    /// macOS's Calendar prompt takes the foreground, and closing it left the app the user accepted the
    /// card in inactive (VM runs 4 and 5: the fixture's title greyed after Allow, Setup Assistant in front
    /// in run 5), so the working and done lines, which show only over the app in front, never came back
    /// and ⌘Z went unclaimed. The answer comes only when the user clicks one of the prompt's buttons, so
    /// that click is the last thing they did: the app they accepted the card in gets the front back.
    static func giveBackFront(before: NSRunningApplication?, after: NSRunningApplication?) {
        guard let before, !before.isTerminated, before.processIdentifier != after?.processIdentifier,
              before.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
        _ = before.activate(options: [])
    }

    /// The calendar choice as the reader will read it at the add: from the settings file, not the
    /// in-memory settings, which keep a change whose save failed (review finding 2). Unreadable, the
    /// reader refuses the add; the card then names the in-memory choice.
    static func savedCalendarChoice() -> String? {
        (try? CalendarChoiceFile.read(SettingsStore.shared.path)) ?? SettingsStore.shared.settings.eventCalendar
    }

    /// An event card arrives naming where Tab would put the event (`EventCardCopy.destined`).
    func receive(_ offer: HelperOffer) {
        guard case .action(let m) = offer, EventCardCopy.isEvent(m) else {
            machine.receive(offer)
            return
        }
        let destination = calendars.destination(choice: Self.savedCalendarChoice())
        machine.receive(.action(EventCardCopy.destined(m, line: EventCalendarCopy.cardLine(destination))))
    }
    func provenance(_ p: MemoryProvenance) { machine.provenance(p) }
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
        if headless { return policy.allows(pid: pid, bundleID: nil) }
        // Secure Event Input silences every offer surface, as it does ghost text (ExcludedApps.allowsOffers): the event
        // tap may not see Tab meanwhile, and the field behind may be a password field the app did not mark.
        guard ExcludedApps.allowsOffers(secureInputEnabled: IsSecureEventInputEnabled()) else { return false }
        return policy.allowsLive(pid: pid)
    }

    fileprivate func readField(pid: Int32) -> FocusedField? {
        // H10: in a browser, the page field the page engine says has focus; Accessibility sees no web content there.
        if let page = PageFocusSource.current(pid: pid), let identity = page.identity {
            let id = nextReadID
            nextReadID &+= 1
            lastPageRead = page.rect.map { (id, $0) }
            lastVisible = page.rect.map { ($0, $0) }
            return FocusedField(
                identity: identity, value: page.empty ? "" : "\u{FFFC}", selection: .caret(0), frame: page.rect,
                window: WindowIdentity(number: nil, title: page.title), readID: id
            )
        }
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
        // A page field: where an empty field's caret sits, at its start, in the system font (the page's is unknown).
        if let page = lastPageRead, page.id == field.readID {
            let font = NSFont.systemFont(ofSize: NSFont.systemFontSize)
            let empty = FieldState(identity: field.identity, value: "", selection: .caret(0), role: nil, secure: false)
            return Self.derivedCaret(field: empty, frame: page.frame, font: font).map { .at($0) } ?? .noCaret
        }
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
        case .typedThrough(let offerID, let typed, let remainder, let caret): typedThrough(offerID: offerID, typed: typed, remainder: remainder, caret: caret)
        case .clearCaret: clearCaret()
        case .showPanel(let content, let text, let placement):
            // The glass grows over 200 ms only when a result gains its question; every other
            // change of size comes from a key or a result and lands at once.
            let gainsQuestion = Self.question(content) && !shownQuestion
            shownQuestion = Self.question(content)
            lastShown = (content, text, placement)
            syncNotRight()
            show(view(content), narrows: Self.narrows(content), text: text, placement: placement, content: content, growing: gainsQuestion)
            placeNotRightTarget()
            announce(content)
        case .hidePanel(let exit):
            endNotRight(keepRow: false)
            panel.exit(duration: exit)
            lastShown = nil
            announced = nil
            announcedPopup = nil
            shownQuestion = false
        case .workingChanged(let working): onWorkingChanged?(working)
        case .dropHelperSession: client?.dropSession()
        case .toastSlotTaken: onToastChanged?()
        case .askCalendarAccess:
            let before = NSWorkspace.shared.frontmostApplication
            calendars.requestAccess { [weak self] access in
                let after = NSWorkspace.shared.frontmostApplication
                FileHandle.standardError.write(Data("caret: calendar: access \(access.rawValue) after asking; front \(after?.bundleIdentifier ?? "none"), was \(before?.bundleIdentifier ?? "none")\n".utf8))
                Self.giveBackFront(before: before, after: after)
                self?.machine.calendarAccessAnswered()
            }
        case .count(let name): status.increment(name)
        case .publish: publish()
        case .log(let line): FileHandle.standardError.write(Data("caret: surface: \(line)\n".utf8))
        }
    }

    /// Ghost text with alternatives: the top one faint, the uneven underline under it while
    /// closed; once open, the current one in place, the figure and "2 of 4" after it, and the
    /// numbered list below. Every change here comes from a key, so none of it animates except the
    /// underline drawing in once with the offer.
    ///
    /// In a capsule (`AlternativesDraw.presentation`), the text sits in KeyType's capsule off the
    /// caret's line, the underline under the capsule's text, the figure and count after its edge,
    /// and the list opens around the capsule rather than the field. True only when the candidate is
    /// on screen, with the capsule's frame when it is in one; the machine withdraws the offer
    /// otherwise (V1a check 4).
    fileprivate func drawAlternatives(_ draw: AlternativesDraw) -> AlternativesDrawn? {
        let text = draw.currentText
        let capsule = draw.presentation == .capsule
        if draw.entering {
            guard let read = lastRead, read.id == draw.readID, let snapshot = read.snapshot, let style = read.style, let font = read.font else { return nil }
            let viewport = lastVisible.flatMap { $0.field == read.frame ? $0.visible : nil }
            let usesKeyTypeGhost = ghost.show(text, at: snapshot, style: style, pid: draw.pid, capsule: capsule, viewport: { viewport }) != nil
            if !usesKeyTypeGhost {
                // Caret's own ghost stands in only for inline text KeyType had no caret for (an empty
                // AppKit field reports none): the machine measured that text against the field from
                // a derived caret. Nothing stands in for a capsule KeyType could not place.
                guard !capsule, let cause = ghost.lastFit?.cause, cause == .noCaret || cause == .resolverRefused else {
                    status.increment("surface.ghost.notDrawn")
                    return nil
                }
                drawOwnGhost(text, caret: draw.caret, font: font, color: style.textColor)
            }
            executor?.remember(offerID: draw.offerID, context: snapshot.context)
            status.increment(usesKeyTypeGhost ? "surface.ghost.keytype" : "surface.ghost.own")
            drawn = Drawn(offerID: draw.offerID, snapshot: usesKeyTypeGhost ? snapshot : nil, style: style, font: font, viewport: viewport)
        } else if let current = drawn, current.offerID == draw.offerID {
            if let snapshot = current.snapshot {
                guard ghost.show(text, at: snapshot, style: current.style, pid: draw.pid, capsule: capsule, viewport: { current.viewport }) != nil else {
                    status.increment("surface.ghost.notDrawn")
                    return nil
                }
            } else {
                drawOwnGhost(text, caret: draw.caret, font: current.font, color: current.style.textColor)
            }
        } else {
            return nil
        }
        if capsule {
            guard var current = drawn,
                  let c = ghost.lastFit?.capsule, c.count == 4 else { return nil }
            current.capsule = CGRect(x: c[0], y: c[1], width: c[2], height: c[3])
            // The tag after the capsule stays inside the visible text area, else the field.
            current.area = current.viewport ?? draw.field
            drawn = current
        }
        let candidates = draw.candidates
        let ui = draw.ui
        guard candidates.count > 1 else {
            decor.exit(duration: 0)
            list.exit(duration: 0)
            return AlternativesDrawn(capsule: capsule ? drawn?.capsule : nil)
        }
        let font = drawn?.font ?? NSFont.systemFont(ofSize: 13)
        let width = ceil((text as NSString).size(withAttributes: [.font: font]).width)
        let tagWidth = { (caretHeight: CGFloat) in
            NSHostingView(rootView: AlternativesTag(current: ui.candidate, count: candidates.count, character: self.character,
                                                    figureSize: Tokens.FigureSize.inText(caretHeight: caretHeight), animated: false)).fittingSize.width
        }
        let layout: AlternativesLayout
        let caret: CGRect
        if capsule, let frame = drawn?.capsule {
            // The capsule may show a shortened text; the underline spans what it shows.
            let shownWidth = min(width, frame.width - GhostFit.capsuleHorizontalPadding * 2 - 2)
            let placed = AlternativesLayout.capsule(
                frame, area: drawn?.area ?? frame, padding: GhostFit.capsuleHorizontalPadding, verticalPadding: GhostFit.capsuleVerticalPadding,
                textWidth: shownWidth, fontSize: font.pointSize, tagWidth: tagWidth(frame.height - GhostFit.capsuleVerticalPadding * 2), open: ui.open
            )
            layout = placed.layout
            caret = placed.caret
        } else {
            caret = draw.caret
            layout = AlternativesLayout(caret: caret, field: draw.field, textWidth: width, fontSize: font.pointSize,
                                        tagWidth: tagWidth(caret.height), open: ui.open)
        }
        let tag = AlternativesTag(current: ui.candidate, count: candidates.count, character: character, figureSize: layout.figureSize)
        // Collapsed, one mark at most: the faint value, underlined only when it is quoted from a
        // source. The figure and the ticks come with the down arrow, and only where they fit on
        // the caret's line after the text (or after the capsule): they never wrap to a line of their own.
        guard draw.quoted || layout.showsTag else {
            decor.exit(duration: 0)
            drawList(draw)
            return AlternativesDrawn(capsule: capsule ? drawn?.capsule : nil)
        }
        let decorView = HStack(alignment: .bottom, spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                if draw.quoted {
                    UnevenUnderline(width: layout.underlineWidth, animated: draw.entering)
                        .padding(.top, layout.underlineTop)
                }
                Spacer(minLength: 0)
            }
            .frame(width: layout.textSpan, height: layout.decorHeight, alignment: .leading)
            if layout.showsTag {
                tag
                    .padding(.leading, layout.tagGap)
                    .padding(.bottom, layout.tagBottom)
            }
        }
        .fixedSize()
        // The decor's top left sits on the caret's top left: the underline lands at the baseline
        // plus 2 pt (baseline estimated at 0.78 of the caret height).
        // The marks stand on the host's document, not on glass: they take the field's theme, read
        // from its text color, so a dark Caret over a white page still draws marks for white. In a
        // capsule they stand on KeyType's capsule, which follows the system's appearance.
        decor.panel.appearance = capsule ? nil : drawn?.style.textColor.map { NSAppearance(named: FillOverlay.isLight($0) ? .darkAqua : .aqua) } ?? nil
        decor.pin(HostedPanel.Anchor(corner: .topLeft, point: NSPoint(x: caret.maxX, y: Screen.cocoa(caret).maxY)))
        decor.setContent(decorView)
        decor.text = ui.open ? "\(ui.candidate + 1) of \(candidates.count)" : "underline"
        if !decor.panel.isVisible || decor.isExiting { decor.panel.alphaValue = 1; decor.panel.orderFrontRegardless() }

        drawList(draw)
        return AlternativesDrawn(capsule: capsule ? drawn?.capsule : nil)
    }

    /// The open list goes where a pop-up would (`FieldPanelPlacement`): below the field, clear of
    /// the next field and its label; else above, else beside the field. Chosen once per opening, so
    /// the arrows never move it. A10's filled-field run showed the old below-or-above choice over
    /// the first field putting the list on the window's title bar.
    private func drawList(_ draw: AlternativesDraw) {
        guard draw.ui.open, Self.alternativesList, countBrowse(draw) >= 2 else { return list.exit(duration: 0) }
        let candidates = draw.candidates
        let view = AlternativesListView(candidates: candidates, current: draw.ui.candidate, font: drawn?.font ?? .systemFont(ofSize: 13))
        if !list.isVisible || listSpot == nil {
            let probe = ObstacleProbe.Session(pid: draw.pid, until: DispatchTime.now().uptimeNanoseconds + Self.probeBudget)
            // A capsule is what the list belongs to: it opens around the capsule, not the whole field.
            let anchor = draw.presentation == .capsule ? drawn?.capsule ?? draw.field : draw.field
            let choice = FieldPanelPlacement.choose(
                field: anchor, caret: draw.presentation == .capsule ? anchor : draw.caret, size: list.measure(view), narrow: nil,
                bounds: Screen.axVisibleFrame(around: anchor), obstacles: { probe.under([$0]) }
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

    /// How many times ↓ or ↑ moved this offer's candidate.
    private func countBrowse(_ draw: AlternativesDraw) -> Int {
        guard let seen = browsed, seen.offerID == draw.offerID else {
            browsed = (draw.offerID, draw.ui.candidate == 0 ? 0 : 1, draw.ui.candidate)
            return browsed!.moves
        }
        if draw.ui.candidate != seen.last { browsed = (seen.offerID, seen.moves + 1, draw.ui.candidate) }
        return browsed!.moves
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

    /// The panel is another app's window and never takes focus, so VoiceOver hears each slip and
    /// pop-up as it enters and again on each change of state (`SlipSpeech`); the working line's
    /// seconds are not a change.
    private var announced: String?
    /// The pop-up last announced whole: a highlight moving on it says only the new choice.
    private var announcedPopup: String?
    /// The slip on screen shows a question under its result.
    private var shownQuestion = false

    private func announce(_ content: PanelContent) {
        guard let words = SlipAnnouncer.next(Self.spoken(content), last: announced) else { return }
        announced = words
        var said = words
        if case .popup(let spec, let highlight) = content {
            if announcedPopup == spec.id, let moved = SlipSpeech.popupHighlight(spec, highlight: highlight) { said = moved }
            announcedPopup = spec.id
        } else {
            announcedPopup = nil
        }
        SlipAnnouncer.post(said)
    }

    static func question(_ content: PanelContent) -> Bool {
        if case .line(let line) = content { return line.question != nil }
        return false
    }

    static func spoken(_ content: PanelContent) -> String {
        switch content {
        case .line(let line), .compactLine(let line): return SlipSpeech.line(line)
        case .popup(let spec, let highlight): return SlipSpeech.popup(spec, highlight: highlight)
        }
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
    /// How `content` is drawn, at an optional narrow width (pop-ups only). `under`: the row naming
    /// where a noticed fact came from, inside the same glass (not on the compact line, which has
    /// no room; its fact is still in What Caret knows).
    static func view(_ content: PanelContent, character: FigureCharacter, under: ((CGFloat) -> AnyView)? = nil, interactive: Bool = false,
                     onNotRight: (() -> Void)? = nil) -> (CGFloat?) -> AnyView {
        switch content {
        case .line(let line):
            return { _ in AnyView(LineView(content: line, character: character, under: under?(LineView.textIndent(compact: false)),
                                           underInteractive: interactive, onNotRight: under == nil ? nil : onNotRight)) }
        case .compactLine(let line): return { _ in AnyView(LineView(content: line, character: character, compact: true)) }
        case .popup(let spec, let highlight):
            return { width in AnyView(PopupView(spec: spec, highlight: highlight, character: character, width: width,
                                                under: under?(12 + PopupView.indent), underInteractive: interactive, onNotRight: under == nil ? nil : onNotRight)) }
        }
    }

    /// `view(content)` with this offer's "Not right" row, when it has one.
    private func view(_ content: PanelContent) -> (CGFloat?) -> AnyView {
        guard let row = notRight?.row else { return Self.view(content, character: character) }
        let under: (CGFloat) -> AnyView = { [weak self] indent in
            AnyView(NotRightRowView(
                row: row, indent: indent,
                onEdit: { self?.editNotRight($0) }, onSave: { self?.sendNotRight(forget: false) },
                onForget: { self?.sendNotRight(forget: true) }, onCancel: { self?.cancelNotRight() }
            ))
        }
        let interactive = row.phase != .shown
        return Self.view(content, character: character, under: under, interactive: interactive, onNotRight: { [weak self] in self?.beginNotRight() })
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
        let placed = place(view(content), narrows: Self.narrows(content), field: field, caret: caret, pid: pid, counts: false, content: content)
        fitted = (content, field, caret, pid, placed)
        return placed.choice.overlap == 0
    }

    private func show(_ view: (CGFloat?) -> AnyView, narrows: Bool, text: String, placement: PanelPlacementRequest, content: PanelContent? = nil, growing: Bool = false) {
        let fit = fitted
        fitted = nil
        switch content {
        case .popup?: panel.radius = Tokens.Shape.popupRadius; panel.popup = true
        case .compactLine?: panel.radius = Tokens.Shape.compactRadius; panel.popup = false
        case .line?, nil: panel.radius = Tokens.Shape.slipRadius; panel.popup = false
        }
        switch placement {
        case .inPlace:
            panel.setContent(typing(view(placed?.choice.spot.isNarrow == true ? PopupView.minWidth : nil), content: content, placing: false), growing: growing)
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
            panel.setContent(typing(view(chosen.spot.isNarrow ? PopupView.minWidth : nil), content: content, placing: true), growing: growing)
            panel.text = text
            if enter { panel.enter() }
        }
    }

    /// Tells the panel's figure where the caret is from its seat, so its rest glances go to the
    /// typing (`FigureIdle`). Content swapped in place keeps the pinned corner but not the placed
    /// frame's size, so its frame is measured and pinned again, as the growth check does; a line
    /// whose figure is away (the working line, every second while work counts up) has nothing to
    /// glance with and is not measured.
    private func typing(_ view: AnyView, content: PanelContent?, placing: Bool) -> AnyView {
        guard let placed else { return view }
        var frame = placed.choice.frame
        if !placing {
            switch content {
            case .line(let line)?, .compactLine(let line)?:
                guard FigureIdle.allowance(state: line.figure, size: Tokens.FigureSize.line) != nil else {
                    return AnyView(view.environment(\.figureTyping, nil))
                }
            case .popup?, nil:
                break
            }
            frame = Self.frame(pinnedAt: placed.choice, size: panel.measure(view))
        }
        let direction = FigureIdle.typingDirection(panel: frame, seat: Self.seat(content), caret: placed.caret)
        return AnyView(view.environment(\.figureTyping, direction))
    }

    /// The middle of the figure's seat from the panel's top-left corner.
    private static func seat(_ content: PanelContent?) -> CGPoint {
        switch content {
        case .popup?: return CGPoint(x: 12 + PopupView.figureSize / 2, y: 20)
        case .compactLine?: return CGPoint(x: 5 + Tokens.FigureSize.compact / 2, y: Tokens.Shape.compactHeight / 2)
        case .line?, nil: return CGPoint(x: Tokens.Shape.slipLeading + Tokens.FigureSize.line / 2, y: Tokens.Shape.slipHeight / 2)
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
            .foregroundStyle(Color(nsColor: color ?? .labelColor).opacity(Tokens.ghostOpacity(dark: color.map(FillOverlay.isLight) ?? false)))
            .fixedSize()
            .frame(height: caret.height)
        ownGhost.pin(HostedPanel.Anchor(corner: .topLeft, point: NSPoint(x: caret.maxX, y: Screen.cocoa(caret).maxY)))
        ownGhost.setContent(view)
        ownGhost.text = text
        ownGhost.panel.alphaValue = 1
        ownGhost.panel.orderFrontRegardless()
    }

    // MARK: - Not right (M1)

    /// The row follows the offer on screen: a new offer, one with no noticed fact, or the compact
    /// line (no room for it) ends it.
    private func syncNotRight() {
        let compact: Bool = { if case .compactLine? = lastShown?.content { return true } else { return false } }()
        guard !compact, let p = machine.shownProvenance, let fact = p.facts.first else {
            if notRight != nil { endNotRight(keepRow: false) }
            return
        }
        keepOrStart(p, fact)
    }

    private func keepOrStart(_ p: MemoryProvenance, _ fact: MemoryProvenance.Fact) {
        if notRight?.offerKey == p.offerKey, notRight?.memoryId == fact.memoryId { return }
        if notRight != nil { endNotRight(keepRow: false) }
        notRight = (p.offerKey, fact.memoryId, NotRightRow(says: fact.says, more: p.facts.count - 1, correctable: fact.correctable))
    }

    /// The click target sits over the row while it shows "Not right"; it goes once the row is a field.
    private func placeNotRightTarget() {
        guard let row = notRight?.row, row.phase == .shown, panel.isVisible, !headless else { return notRightTarget.hide() }
        let content = panel.contentFrame(size: panel.size)
        notRightTarget.show(over: NSRect(x: content.minX, y: content.minY, width: content.width, height: NotRightRow.rowHeight))
    }

    /// The click: the row becomes a field with Forget and Save, and the slip takes the keyboard
    /// without bringing Caret forward (a non-activating panel). The offer stays: Tab in the app it
    /// is about still takes it once the user goes back.
    private func beginNotRight() {
        guard var current = notRight, current.row.phase == .shown else { return }
        current.row.phase = .correcting
        notRight = current
        status.increment("surface.notRight.opened")
        redraw()
        panel.panel.ignoresMouseEvents = false
        panel.panel.keyable = true
        panel.panel.makeKey()
    }

    private func editNotRight(_ text: String) {
        guard notRight?.row.phase == .correcting else { return }
        notRight?.row.text = text
        notRight?.row.problem = nil
        redraw()
    }

    private func sendNotRight(forget: Bool) {
        guard let current = notRight, current.row.phase == .correcting else { return }
        let text = current.row.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !forget, let problem = MemoryCheck.correctionProblem(text, correctable: current.row.correctable) {
            notRight?.row.problem = problem
            return redraw()
        }
        let key = current.offerKey
        let sent = sendNotRight(current.memoryId, key, forget ? nil : text) { [weak self] problem in
            self?.notRightAnswered(offerKey: key, forget: forget, problem: problem)
        }
        if sent {
            notRight?.row.phase = .sending
            status.increment(forget ? "surface.notRight.forget" : "surface.notRight.correct")
        } else {
            notRight?.row.problem = MemoryCheck.offline
        }
        redraw()
    }

    /// The helper's answer. It also withdraws every offer that used the fact, which takes this slip
    /// down; until then the row says what happened, and VoiceOver hears it.
    private func notRightAnswered(offerKey: String, forget: Bool, problem: String?) {
        guard notRight?.offerKey == offerKey else { return }
        if let problem {
            notRight?.row.phase = .correcting
            notRight?.row.problem = problem
            return redraw()
        }
        let sentence = forget ? NotRightRow.forgotten : NotRightRow.corrected
        notRight?.row.phase = .answered(sentence)
        SlipAnnouncer.post(sentence)
        giveKeysBack()
        redraw()
    }

    private func cancelNotRight() {
        guard notRight?.row.phase == .correcting else { return }
        notRight?.row.phase = .shown
        notRight?.row.problem = nil
        giveKeysBack()
        redraw()
    }

    /// Esc while the slip holds the keyboard puts the row back; Return is the field's.
    private func slipKey(_ event: NSEvent) -> Bool {
        guard notRight?.row.phase == .correcting, Int64(event.keyCode) == KeyStroke.escapeKeyCode,
              event.modifierFlags.intersection([.command, .control, .option, .shift]).isEmpty else { return false }
        if let editor = panel.panel.firstResponder as? NSTextView, editor.hasMarkedText() { return false }
        cancelNotRight()
        return true
    }

    /// The slip goes back to click-through and gives up the keyboard: ordered out and in again in
    /// one turn of the run loop, which hands key back to the app being typed in (it never stopped
    /// being the active app).
    private func giveKeysBack() {
        panel.panel.ignoresMouseEvents = true
        let wasKey = panel.panel.isKeyWindow
        panel.panel.keyable = false
        if wasKey, panel.isVisible {
            panel.panel.orderOut(nil)
            panel.panel.orderFrontRegardless()
        }
    }

    private func endNotRight(keepRow: Bool) {
        notRightTarget.hide()
        guard notRight != nil else { return }
        giveKeysBack()
        if !keepRow { notRight = nil }
    }

    /// Draws the last panel again where it stands, with the row as it is now.
    private func redraw() {
        guard let last = lastShown else { return }
        var placement = last.placement
        if case .atField(let field, let caret, let pid, _) = placement { placement = .atField(field: field, caret: caret, pid: pid, entering: false) }
        show(view(last.content), narrows: Self.narrows(last.content), text: last.text, placement: placement, content: last.content)
        placeNotRightTarget()
        publish()
    }

    // MARK: - Debug state

    /// The machine's state plus what only the screen knows: the panels and the ghost text drawn.
    func debugInfo() -> DebugState.SurfaceInfo {
        var info = machine.debugInfo()
        info.ghost = ghost.shownText ?? (ownGhost.isVisible ? ownGhost.text : nil)
        info.ghostPanel = ownGhost.debugInfo()
        if info.caretPresentation == CaretPresentation.capsule.rawValue, let c = drawn?.capsule {
            info.capsule = [c.minX, c.minY, c.width, c.height].map(Double.init)
            info.capsuleSide = ghost.lastFit?.capsuleSide
        }
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
        if let row = notRight?.row {
            switch row.phase {
            case .shown: info.notRight = notRightTarget.isVisible ? "shown" : "shown-no-target"
            case .correcting: info.notRight = "correcting"
            case .sending: info.notRight = "sending"
            case .answered(let sentence): info.notRight = sentence
            }
        }
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
    func focusedIdentity(pid: Int32) -> TargetIdentity? {
        MainActor.assumeIsolated { PageFocusSource.current(pid: pid)?.identity } ?? FieldReader.readFocused(pid: pid)?.field.identity
    }
    func focusedFrame(pid: Int32) -> CGRect? {
        if let page = MainActor.assumeIsolated({ PageFocusSource.current(pid: pid) }) { return page.rect }
        return AXRead.focusedElement(pid: pid).flatMap(AXRead.frame(of:))
    }

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
    func drawAlternatives(_ draw: AlternativesDraw) -> AlternativesDrawn? {
        MainActor.assumeIsolated { owner?.drawAlternatives(draw) }
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
