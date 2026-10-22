import AppKit
import ApplicationServices
import CaretHostCore
import CaretScreenCore
import SwiftUI

/// A borderless panel that takes clicks but never becomes key or main, and never activates
/// Caret: clicking the perch leaves the app being typed in frontmost.
final class PerchPanel: NSPanel {
    static func make() -> PerchPanel {
        let panel = PerchPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        return panel
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Main-thread owner of Caret's work in other windows and of the desk.
///
/// Work in another window (DIRECTION.md 5.7): while a task runs, waits or needs the user
/// (`Perch.subject`), a warm rim goes around the window it works in, the figure perches on that
/// window's top edge, and a caption sits at its bottom-left. Only while that window is on screen and
/// uncovered (H3, `Rim.seen`); otherwise nothing is drawn there and the menu bar glyph, lit while any
/// of this is going on (`onLitChanged`), carries it. The rim follows the window, read from the window
/// list four times a second while shown. Nothing is ever on screen idle.
///
/// The desk (5.6) opens from the menu bar or a click on the perch: under the menu bar of the screen
/// holding the window in front, centered over that window (A18).
///
/// `drawsOnScreen: false` computes all of it and orders nothing front, for socket-only test runs
/// while someone is using the Mac.
@MainActor
final class PerchController {
    let model = PerchModel()
    private let center: ActivityCenter
    private let drawsOnScreen: Bool
    private let panel = PerchPanel.make()
    private let rimPanel = OverlayPanel.make()
    private let rimModel = RimModel()
    private let caption = HostedPanel(radius: 8)
    private let list = HostedPanel(radius: ActivityListView.radius, interactive: true)
    private let locator = WindowLocator()
    /// The ask field at the top of the desk (brief A13): its decisions, and what the view draws.
    let ask = AskCaret(clock: RunLoopClock())
    private let askModel = AskModel()
    /// The ask phase last drawn into the desk, so a change of phase resizes it and typing does not.
    private var drawnAsk: AskCaret.Phase = .idle
    /// Whether the drawn desk shows the Return hint, which appears with the first character typed:
    /// the desk is measured again only when that changes.
    private var drawnHint = false
    /// "What Caret knows" at the foot of the desk.
    var onOpenMemory: (() -> Void)?
    /// The desk opened (true) or closed (false).
    var onListChanged: ((Bool) -> Void)?
    /// Work runs, waits or needs the user somewhere: the menu bar glyph is Carrot.
    var onLitChanged: ((Bool) -> Void)?
    /// "Not right" on the plan's noticed fact (`MemoryBook.notRight`): false when nothing was sent.
    var sendNotRight: (_ memoryId: String, _ offerKey: String, _ correction: String?, _ answered: @escaping (String?) -> Void) -> Bool = { _, _, _, _ in false }

    /// The menu bar's "Show Perch" choice. Hidden stops drawing the rim and the perch; the desk
    /// still opens from the menu.
    var hidden: Bool {
        get { UserDefaults.standard.bool(forKey: Self.hiddenKey) }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.hiddenKey)
            refresh()
        }
    }
    static let hiddenKey = "perchHidden"

    private var subject: Perch.Subject?
    private(set) var lit = false
    /// The window the subject's task acts in: its frame as Accessibility last found it, and its
    /// window-server number once matched in the window list.
    private var target: (taskId: String, frame: CGRect?, number: Int?)?
    private var seen: Rim.Seen = .notFound
    /// The target is the window in front: the slip at the caret already says what Caret does there,
    /// so the corner caption would say it twice.
    private var targetInFront = false
    /// Where the parts went, global top-left.
    private var layout: Rim.Layout?
    private var drawnCaption: RimCaption?
    private var stopped = false
    private var expiryTimer: Timer?
    private var trackTimer: Timer?
    private var locateTimer: Timer?
    private var fadeWork: DispatchWorkItem?
    /// The rim, perch and caption are on their way out.
    private var leaving = false
    private var clickMonitor: Any?
    private(set) var listOpen = false
    /// Pages of Done rows the open desk shows; "and N more" adds one, closing the desk resets it.
    private(set) var donePages = 1
    private var stats = Stats()

    struct Stats: Codable, Equatable {
        var shows = 0
        var leaves = 0
        /// Times the rim was held back because the window was covered or not on screen (H3).
        var covered = 0
        var notFound = 0
        /// The desk was marked open but was not on screen when Ask Caret was chosen.
        var reopened = 0
        /// Where the desk last opened: over the window in front, or under the menu bar's right end.
        var listAnchor: String?
    }

    init(center: ActivityCenter, drawsOnScreen: Bool) {
        self.center = center
        self.drawsOnScreen = drawsOnScreen
        let host = FirstMouseHostingView(rootView: AnyView(PerchView(model: model)))
        host.frame = NSRect(origin: .zero, size: PerchModel.size)
        panel.contentView = host
        rimPanel.contentView = NSHostingView(rootView: RimView(model: rimModel, radius: RimView.windowRadius))
        model.character = FigureSettings.shared.character
        model.animated = !Motion.reduceMotion
        model.onTap = { [weak self] in self?.toggleList() }
        list.panel.keyable = true
        list.panel.interceptKey = { [weak self] event in
            MainActor.assumeIsolated { self?.listKey(event) ?? false }
        }
        askModel.edit = { [weak self] text in self?.ask.edit(text) }
        askModel.submit = { [weak self] in self?.ask.submit() }
        askModel.run = { [weak self] in self?.ask.tab() }
        askModel.escape = { [weak self] in self?.ask.escape() }
        askModel.undo = { [weak self] in self?.ask.undo() }
        askModel.select = { [weak self] in self?.ask.toggle(option: $0) }
        askModel.choose = { [weak self] in self?.ask.choose(option: $0) }
        askModel.goalDraft = { [weak self] in self?.ask.goalDraftChanged($0) }
        askModel.editGoal = { [weak self] in self?.ask.editGoal() }
        askModel.keepGoalEdit = { [weak self] in self?.ask.commitGoalEdit() }
        askModel.notRightAction = { [weak self] in self?.deskNotRight($0) }
        ask.onChange = { [weak self] in self?.askChanged() }
        ask.onAtForm = { [weak self] in self?.stepAside() }
    }

    // MARK: - The ask field

    private func askChanged() {
        let before = askModel.phase
        if askModel.text != ask.text { askModel.text = ask.text }
        if askModel.phase != ask.phase { askModel.phase = ask.phase }
        let rowBefore = askModel.notRight
        syncDeskNotRight()
        let newlyFailed: Bool = { if case .failed = ask.phase, drawnAsk != ask.phase { return true } else { return false } }()
        // A new phase can change the desk's height; typing alone does not, and redrawing the panel
        // on each key would cost a measure per keystroke.
        if listOpen, Self.layout(drawnAsk) != Self.layout(ask.phase) || drawnHint != AskSection.showsHint(text: ask.text, phase: ask.phase) || rowBefore != askModel.notRight {
            renderList()
        }
        // The goal card's edit field closed: the keys go back to the ask field.
        if Self.goalEditing(before) && !Self.goalEditing(ask.phase) { askModel.focusToken &+= 1 }
        if newlyFailed { selectFailedInstruction() }
    }

    /// The phase as far as the desk's size goes: typing in the goal card's edit field redraws inside SwiftUI, as typing
    /// in the ask field does, and the panel is measured again only when the words may have wrapped to another line
    /// (every 40 characters or a new line; an estimate of the 13.5 pt field's line at the desk's width, not measured).
    static func layout(_ phase: AskCaret.Phase) -> AskCaret.Phase {
        guard case .goal(var card) = phase, case .editing(let step, let text) = card.stage else { return phase }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map { $0.count / 40 + 1 }.reduce(0, +)
        card.stage = .editing(step: step, text: String(repeating: "\n", count: lines))
        return .goal(card)
    }

    static func goalEditing(_ phase: AskCaret.Phase) -> Bool {
        if case .goal(let card) = phase, case .editing = card.stage { return true }
        return false
    }

    /// A failed ask's instruction is selected, so the field shows that typing replaces it (A18,
    /// bug 14; `AskCaret.edit` replaces it either way). After the redraw has given the field back
    /// its focus, which happens on the next turn of the run loop.
    private func selectFailedInstruction() {
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self, case .failed = self.ask.phase, self.list.panel.isKeyWindow,
                      let editor = self.list.panel.firstResponder as? NSTextView else { return }
                editor.selectAll(nil)
            }
        }
    }

    /// The plan's noticed fact (M1): a row on the card with "Not right" while the plan waits for Tab.
    private func syncDeskNotRight() {
        guard let p = ask.shownProvenance, let fact = p.facts.first else {
            askModel.notRight = nil
            return
        }
        if askModel.notRight == nil || askModel.notRight?.says != fact.says {
            askModel.notRight = NotRightRow(says: fact.says, more: p.facts.count - 1, correctable: fact.correctable)
        }
    }

    private func deskNotRight(_ action: DeskNotRight) {
        guard var row = askModel.notRight, let p = ask.shownProvenance, let fact = p.facts.first else { return }
        switch action {
        case .open where row.phase == .shown:
            row.phase = .correcting
        case .edit(let text) where row.phase == .correcting:
            row.text = text
            row.problem = nil
        case .cancel where row.phase == .correcting:
            row.phase = .shown
            row.problem = nil
        case .save, .forget:
            guard row.phase == .correcting else { return }
            let forget = action == .forget
            let text = row.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !forget, let problem = MemoryCheck.correctionProblem(text, correctable: row.correctable) {
                row.problem = problem
                break
            }
            let key = p.offerKey
            let memoryId = fact.memoryId
            let sent = sendNotRight(memoryId, key, forget ? nil : text) { [weak self] problem in
                // Only the plan it was said on: a newer card's row is not this answer's (review finding 3).
                guard let self, var now = self.askModel.notRight, let shown = self.ask.shownProvenance,
                      shown.offerKey == key, shown.facts.first?.memoryId == memoryId else { return }
                if let problem {
                    now.phase = .correcting
                    now.problem = problem
                } else {
                    now.phase = .answered(forget ? NotRightRow.forgotten : NotRightRow.corrected)
                    AccessibilityNotification.Announcement(forget ? NotRightRow.forgotten : NotRightRow.corrected).post()
                }
                self.askModel.notRight = now
                if self.listOpen { self.renderList() }
            }
            if sent { row.phase = .sending } else { row.problem = MemoryCheck.offline }
        default:
            return
        }
        let phaseChanged = row.phase != askModel.notRight?.phase || row.problem != askModel.notRight?.problem
        askModel.notRight = row
        if listOpen, phaseChanged { renderList() }
    }

    /// Return, Tab, Esc and ⌘Z while the desk is key, before the field editor sees them. ⌘Z undoes an
    /// ended run that wrote. Return plans what the field holds; Tab takes a plan; Esc first closes an
    /// open "Not right", then stops a run, puts away a card or an answer, then empties the field,
    /// then closes the desk. While an Ask's question shows (B29), Up and Down move between its
    /// choices, Space selects one of several, and Tab answers. True when the key was used.
    private func listKey(_ event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection([.command, .control, .option, .shift])
        // ⌘Z on a run that wrote undoes it (q1 bug 8); otherwise the field editor's own undo.
        if modifiers == .command, event.keyCode == 6, ask.undo() { return true }
        // ⌘E on a goal card opens its drafted row for the user's own words.
        if modifiers == .command, event.keyCode == 14, ask.editGoal() { return true }
        let plain = modifiers.isEmpty
        guard plain else { return false }
        // An input method composing text owns Return and Esc until it commits or cancels.
        if let editor = list.panel.firstResponder as? NSTextView, editor.hasMarkedText() { return false }
        let editing = list.panel.firstResponder is NSTextView
        let correcting = askModel.notRight?.phase == .correcting
        // The goal card's edit field: Return keeps the words, Esc closes it, Tab does nothing there.
        if ask.goalEditing, editing {
            switch Int64(event.keyCode) {
            case KeyStroke.returnKeyCode, 76: return ask.commitGoalEdit()
            case KeyStroke.tabKeyCode: return true
            default: break
            }
        }
        if case .question = ask.phase, editing {
            switch Int64(event.keyCode) {
            case KeyStroke.downKeyCode: return ask.move(1)
            case KeyStroke.upKeyCode: return ask.move(-1)
            case KeyStroke.spaceKeyCode: return ask.toggle()
            // Return would plan the instruction again over the question; the question wants Tab.
            case KeyStroke.returnKeyCode, 76: return true
            default: break
            }
        }
        switch Int64(event.keyCode) {
        case KeyStroke.returnKeyCode, 76:
            // The "Not right" field's Return is its own (Save).
            return editing && !correcting && ask.submit()
        case KeyStroke.tabKeyCode:
            // Only from the ask field: with Full Keyboard Access, Tab from a row's button moves on.
            return editing && !correcting && ask.tab()
        case KeyStroke.escapeKeyCode:
            if correcting {
                deskNotRight(.cancel)
                return true
            }
            // A key closes the desk at once: keyboard-initiated changes do not animate.
            if !ask.escape() { closeList(exit: 0) }
            return true
        default:
            return false
        }
    }

    /// The menu's Ask Caret: the desk opens with the field focused, Caret still behind the app the
    /// user is in.
    ///
    /// Opened whenever it is not on screen, whatever `listOpen` says (A18, bug 15: right after
    /// onboarding the first press did nothing), and placed again when it is, so it opens near the
    /// window in front now rather than where it last was.
    func openAsk() {
        if listOpen, drawsOnScreen, !list.isVisible {
            stats.reopened += 1
            listOpen = false
        }
        if listOpen { anchorList() } else { openList() }
        guard drawsOnScreen else { return }
        list.panel.orderFrontRegardless()
        list.panel.makeKey()
        askModel.focusToken &+= 1
    }

    // MARK: - Inputs

    /// The activity feed or the acknowledgement changed.
    func refresh() {
        // After shutdown, a late change from the feed or the hidden setter would schedule timers and
        // move panels again (CodeRabbit on PR #9).
        guard !stopped else { return }
        let now = Date()
        model.character = FigureSettings.shared.character
        let next = center.subject(now: now)
        scheduleExpiry(now: now)
        if next?.taskId != subject?.taskId { target = nil }
        subject = next
        // Lit while any task runs, waits or needs the user, not only the one the perch reports on: a
        // newer finished task must not put the glyph out while an older one still runs (review finding 5).
        let nowLit = center.records.contains { r in Perch.mood(for: r.state).map { [.working, .waiting, .needsYou].contains($0) } ?? false }
        if nowLit != lit {
            lit = nowLit
            onLitChanged?(nowLit)
        }
        if let next {
            model.mood = next.mood
            model.summary = Self.summary(next)
            if target == nil { locate() }
            track()
            startTimers()
        } else {
            leave(stopped: false)
            // Nothing left to follow: the window-list timers stop (review finding 8).
            stopTimers()
        }
        if listOpen { renderList() }
    }

    // MARK: - The window it works in

    /// Finds the subject's window through Accessibility (by the frame and title the helper recorded),
    /// then tracks it in the window list by number.
    private func locate() {
        guard let subject, let pid = subject.pid else { return track() }
        let taskId = subject.taskId
        if target?.taskId != taskId { target = (taskId, subject.windowFrame, nil) }
        locator.locate(pid: pid, title: subject.windowTitle, frame: subject.windowFrame) { [weak self] found in
            guard let self, self.subject?.taskId == taskId else { return }
            // A frame found is the window as it is now; the number is matched again from it.
            if let found, found != self.target?.frame { self.target = (taskId, found, nil) }
            self.track()
        }
    }

    /// Reads the window list once: is the window still there, has it moved, does anything cover it.
    /// Then shows, moves or takes down the rim, the perch and the caption.
    private func track() {
        guard let subject else { return }
        let next: Rim.Seen
        if let pid = subject.pid, let target, target.taskId == subject.taskId {
            let own = ProcessInfo.processInfo.processIdentifier
            let windows = Self.windows()
            next = Rim.seen(pid: pid, number: target.number, frame: target.frame, windows: windows, ownPID: own)
            if case .clear(let number, _) = next {
                targetInFront = windows.first { $0.pid != own && $0.layer == 0 && $0.alpha > 0.01 && $0.bounds.width >= Rim.minimumCover.width }?.number == number
            }
        } else {
            next = .notFound
        }
        if case .clear(let number, let frame) = next { target = (subject.taskId, frame, number) }
        if case .covered(let number, let frame, _) = next { target = (subject.taskId, frame, number) }
        if !next.isClear, seen.isClear || seen == .notFound {
            switch next {
            case .covered: if seen.isClear { stats.covered += 1 }
            case .notFound: if seen.isClear { stats.notFound += 1 }
            case .clear: break
            }
        }
        seen = next
        draw()
    }

    private func draw() {
        guard let subject, !stopped else { return }
        let showsHere = !hidden && drawsOnScreen
        switch subject.mood {
        case .working, .waiting, .needsYou:
            guard case .clear(_, let frame) = seen, showsHere else { return leave(stopped: false) }
            show(at: frame, subject: subject)
        case .done:
            // Done: the figure hops off, the ring goes with it (the slip at the caret says Added).
            leave(stopped: false)
        case .error:
            // The ring goes Graphite and fades where the user can see it; anywhere else it goes at once.
            leave(stopped: seen.isClear && showsHere)
        }
    }

    private func show(at window: CGRect, subject: Perch.Subject) {
        fadeWork?.cancel()
        fadeWork = nil
        leaving = false
        let visible = Screen.axVisibleFrame(around: window)
        let layout = Rim.layout(window: window, perchHeight: PerchModel.figureHeight, visible: visible)
        let moved = layout != self.layout
        self.layout = layout
        let entering = !rimModel.shown
        if moved || entering {
            rimPanel.setFrame(Screen.cocoa(layout.ring), display: true)
            // The view stands the figure on its panel's bottom edge, centered; the panel's extra room
            // above and beside it is for the squash and the bob.
            let perch = CGRect(x: layout.perch.midX - PerchModel.size.width / 2, y: layout.perch.maxY - PerchModel.size.height,
                               width: PerchModel.size.width, height: PerchModel.size.height)
            panel.setFrame(Screen.cocoa(perch), display: false)
        }
        let row = center.rows().first { $0.id == subject.taskId }
        let words = RimCaption.words(mood: subject.mood, row: row)
        let view = RimCaption(text: words.text, detail: words.detail)
        if targetInFront {
            if caption.isVisible { caption.exit(duration: Motion.Duration.fade) }
            drawnCaption = nil
        } else if moved || entering || !caption.isVisible || drawnCaption?.text != view.text || drawnCaption?.detail != view.detail {
            let entersNow = !caption.isVisible
            drawnCaption = view
            caption.pin(.init(corner: .topLeft, point: NSPoint(x: layout.caption.x, y: Screen.cocoa(CGRect(origin: layout.caption, size: .zero)).maxY)))
            caption.setContent(view)
            caption.text = words.text
            if entersNow { caption.enter() }
        }
        rimModel.graphite = false
        if !entering, !model.presented {
            // Work came back while the rim was on its way out: the figure returns as well.
            panel.orderFrontRegardless()
            withAnimation(Motion.reduceMotion ? .linear(duration: Motion.Duration.reduced) : Motion.curve(Motion.easeOut, Motion.Duration.figureEnter)) { model.presented = true }
        }
        guard entering else { return }
        stats.shows += 1
        let reduce = Motion.reduceMotion
        rimModel.animated = !reduce
        model.animated = !reduce
        rimPanel.orderFrontRegardless()
        panel.orderFrontRegardless()
        rimModel.shown = true
        withAnimation(reduce ? .linear(duration: Motion.Duration.reduced) : Motion.curve(Motion.easeOut, Motion.Duration.figureEnter)) { model.presented = true }
    }

    /// Takes everything down. `stopped`: the run ended badly or was stopped, so the ring turns
    /// Graphite over 220 ms and fades after 900 ms while the figure hops off at once.
    private func leave(stopped: Bool) {
        // Once on its way out it is left alone: the window list is read four times a second, and each
        // read asking again would push the fade back for good (review finding 4). A stopped ring whose
        // window became covered meanwhile goes at once.
        if leaving {
            if !stopped, rimModel.graphite { finishLeaving() }
            return
        }
        guard rimModel.shown || model.presented || caption.isVisible else { return }
        leaving = true
        stats.leaves += 1
        let reduce = Motion.reduceMotion
        withAnimation(reduce ? .linear(duration: Motion.Duration.reduced) : Motion.curve(Motion.easeOut, Motion.Duration.figureLeave)) { model.presented = false }
        caption.exit(duration: Motion.Duration.fade)
        layout = nil
        drawnCaption = nil
        let hold: TimeInterval
        if stopped {
            rimModel.graphite = true
            hold = reduce ? 0.12 : 0.9
        } else {
            hold = 0
        }
        fadeWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.finishLeaving() }
        }
        fadeWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + hold, execute: work)
    }

    /// The ring fades (its 220 ms), then the panels go, unless something was shown again meanwhile.
    private func finishLeaving() {
        fadeWork?.cancel()
        fadeWork = nil
        rimModel.shown = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.rimModel.shown else { return }
                self.leaving = false
                self.rimModel.graphite = false
                self.rimPanel.orderOut(nil)
                self.panel.orderOut(nil)
            }
        }
    }

    /// While there is a subject: the window list four times a second (the rim follows a dragged
    /// window within a quarter second; one list read costs about a millisecond) and Accessibility
    /// every 2 s (a window that was replaced or a document that changed title). Assumed intervals;
    /// nothing measured them against what a user notices. The figure blinks on its own, at
    /// irregular intervals (`FigureIdle`), so the perch keeps no blink timer.
    private func startTimers() {
        if trackTimer == nil {
            trackTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.track() }
            }
        }
        if locateTimer == nil {
            locateTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { if self?.seen.isClear == false { self?.locate() } }
            }
        }
    }

    private func stopTimers() {
        trackTimer?.invalidate()
        trackTimer = nil
        locateTimer?.invalidate()
        locateTimer = nil
    }

    private func scheduleExpiry(now: Date) {
        expiryTimer?.invalidate()
        expiryTimer = nil
        guard let at = Perch.nextExpiry(center.records, now: now, acknowledgedAt: center.acknowledgedAt) else {
            if subject == nil { stopTimers() }
            return
        }
        expiryTimer = Timer.scheduledTimer(withTimeInterval: max(0.05, at.timeIntervalSince(now) + 0.05), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    /// On-screen windows, front to back, with their numbers. Window-server only.
    static func windows() -> [Rim.Window] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        return list.compactMap { info in
            guard let number = info[kCGWindowNumber as String] as? Int, let pid = info[kCGWindowOwnerPID as String] as? Int32,
                  let raw = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary) else { return nil }
            return Rim.Window(number: number, pid: pid, bounds: bounds, layer: info[kCGWindowLayer as String] as? Int ?? 0,
                              alpha: info[kCGWindowAlpha as String] as? Double ?? 1)
        }
    }

    // MARK: - The desk

    func toggleList() {
        listOpen ? closeList() : openList()
    }

    func openList() {
        listOpen = true
        defer { onListChanged?(true) }
        center.acknowledge()
        renderList()
        anchorList()
        if drawsOnScreen { list.enter() }
        if clickMonitor == nil {
            // A click in another app closes the desk; clicks in Caret's own panels do not reach a
            // global monitor.
            clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                MainActor.assumeIsolated { self?.closeList() }
            }
        }
    }

    /// "and N more" under Done: the next page of rows.
    func showMore() {
        guard listOpen else { return }
        donePages += 1
        renderList()
    }

    /// H11: an Ask's preview went to the panel at the form. The desk shows its one line long enough to read,
    /// then closes, so the browser has its keys for the panel's Tab; a second call (Tab or Esc in the desk)
    /// closes it at once.
    private var stepAsideTimer: DispatchWorkItem?
    static let stepAsideAfter: TimeInterval = 0.6

    func stepAside() {
        if let pending = stepAsideTimer {
            pending.cancel()
            stepAsideTimer = nil
            closeList(exit: 0)
            return
        }
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, case .atForm = self.ask.phase else { return }
                self.stepAsideTimer = nil
                self.closeList(exit: Motion.exit(Motion.Duration.fade, reduce: Motion.reduceMotion))
            }
        }
        stepAsideTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.stepAsideAfter, execute: work)
    }

    func closeList(exit: TimeInterval = 0.1) {
        guard listOpen else { return }
        listOpen = false
        // A card nobody can see takes no Tab, so it goes; a run goes on and the desk still reports
        // it, and a half-typed request stays for the next opening.
        switch ask.phase {
        case .running, .idle: break
        // A goal that runs goes on as a plan's run does; a preview or an ending goes with the desk.
        case .goal(let card):
            switch card.stage {
            case .running, .stopping: break
            case .ended(let e) where e.kind == .undoing: break
            default: ask.escape()
            }
        case .asking, .proposed, .question, .failed, .ended, .atForm: ask.escape()
        }
        donePages = 1
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
        clickMonitor = nil
        list.exit(duration: exit)
        onListChanged?(false)
    }

    private func renderList() {
        // A new root view loses the field's keyboard focus; give it back if it had it. An open "Not
        // right" holds its own field, which takes focus as it appears; the ask field must not take it.
        // The goal card's edit field takes focus as it appears, as "Not right" does.
        let fieldHadFocus = list.panel.isKeyWindow && list.panel.firstResponder is NSTextView && askModel.notRight?.phase != .correcting && !Self.goalEditing(ask.phase)
        defer { if fieldHadFocus { askModel.focusToken &+= 1 } }
        let page = center.page(pages: donePages)
        drawnAsk = ask.phase
        drawnHint = AskSection.showsHint(text: ask.text, phase: ask.phase)
        let character = FigureSettings.shared.character
        let view = ActivityListView(
            rows: page.rows, more: page.more, incomplete: center.feed.incomplete, mood: subject?.mood,
            character: character, busy: center.busy, animated: !Motion.reduceMotion,
            onMore: { [weak self] in self?.showMore() },
            onKnows: { [weak self] in
                self?.closeList()
                self?.onOpenMemory?()
            },
            onAction: { [weak self] taskId, action in self?.center.control(taskId, action) },
            ask: AnyView(AskLiveSection(model: askModel, character: character, animated: !Motion.reduceMotion)),
            askActive: ask.phase != .idle,
            askHeader: ask.phase.header { id in page.rows.contains { $0.id == id } }
        )
        list.text = view.title
        list.setContent(view)
    }

    /// The desk: under the menu bar of the screen holding the window in front, centered over that
    /// window (`DeskPlacement`, A18 bug 13). It no longer hangs from the perch: the perch sits on a
    /// window now, and a 460 pt desk hung from it would cover that window's work.
    private func anchorList() {
        let window = Self.frontWindow()
        let screens = NSScreen.screens.map { Screen.ax($0.visibleFrame) }
        let fallback = Screen.ax(NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900))
        let visible = DeskPlacement.screen(for: window, screens: screens, fallback: fallback)
        let p = DeskPlacement.topLeft(width: list.size.width, visible: visible, window: window)
        stats.listAnchor = window == nil ? "desk" : "desk.window"
        list.pin(.init(corner: .topLeft, point: NSPoint(x: p.x, y: Screen.cocoa(CGRect(origin: p, size: .zero)).maxY)))
    }

    /// The frontmost ordinary window of another app, global top-left points: what the desk opens
    /// over. Window-server order, so it is right even when Caret itself is the active app (after
    /// onboarding). Tiny windows (a status item's, a tooltip) are skipped.
    static func frontWindow() -> CGRect? {
        let own = ProcessInfo.processInfo.processIdentifier
        return Visibility.windows().first { w in
            w.pid != own && w.layer == 0 && w.alpha > 0.01 && w.bounds.width >= 120 && w.bounds.height >= 80
        }?.bounds
    }

    /// Any of the perch's timers is scheduled; for tests.
    var timersPending: Bool { [expiryTimer, trackTimer, locateTimer].contains { $0 != nil } }

    func shutdown() {
        stopped = true
        fadeWork?.cancel()
        expiryTimer?.invalidate()
        expiryTimer = nil
        stopTimers()
        closeList()
        caption.exit(duration: 0)
        rimPanel.orderOut(nil)
        panel.orderOut(nil)
    }

    // MARK: - Debug socket

    struct DebugInfo: Codable, Equatable {
        /// The figure is on the task's window.
        var presented: Bool
        var onScreen: Bool
        var drawsOnScreen: Bool
        var hidden: Bool
        var subject: Perch.Subject?
        var figure: String?
        /// The menu bar glyph is lit.
        var lit: Bool
        /// `clear`, `covered` or `notFound` (H3), and the window it is about.
        var seen: String
        var targetWindow: [Double]?
        var targetNumber: Int?
        /// Global, top-left: the perched figure's slot, the ring's panel, the caption's corner.
        var frame: [Double]?
        var rim: [Double]?
        var rimShown: Bool
        var rimGraphite: Bool
        var caption: String?
        var captionFrame: [Double]?
        var isKey: Bool
        /// The desk is key and the ask field holds the keyboard (its field editor is first responder).
        var askEditing: Bool
        /// The window server's numbers, for window-only screenshots.
        var windowNumber: Int
        var rimWindowNumber: Int
        var captionWindowNumber: Int
        var listWindowNumber: Int
        var listOpen: Bool
        var listOnScreen: Bool
        /// The desk's frame while on screen, global top-left points.
        var listFrame: [Double]?
        var rows: [ActivityRow]
        /// Done rows behind "and N more", and the pages shown.
        var more: Int
        var donePages: Int
        /// The last list reply was truncated at the helper's cap.
        var incomplete: Bool
        var feedSeq: Int
        var listed: Bool
        var pausable: [String: [String]]
        var activity: ActivityCenter.DebugActivity
        var stats: Stats
        /// The plan's noticed fact on the desk card, and its "Not right" state.
        var deskNotRight: String?
    }

    func debugInfo() -> DebugInfo {
        func box(_ r: CGRect?) -> [Double]? { r.map { [$0.minX, $0.minY, $0.width, $0.height].map(Double.init) } }
        let pause = center.pauseGate.snapshot()
        let seenWords: String
        switch seen {
        case .clear: seenWords = "clear"
        case .covered: seenWords = "covered"
        case .notFound: seenWords = "notFound"
        }
        let deskNotRight: String? = askModel.notRight.map { row in
            switch row.phase {
            case .shown: return "shown: \(row.says)"
            case .correcting: return "correcting"
            case .sending: return "sending"
            case .answered(let s): return s
            }
        }
        return DebugInfo(
            presented: model.presented, onScreen: panel.isVisible, drawsOnScreen: drawsOnScreen, hidden: hidden,
            subject: subject, figure: subject.map { $0.mood.figure.rawValue }, lit: lit, seen: seenWords,
            targetWindow: box(target?.frame), targetNumber: target?.number, frame: box(layout?.perch), rim: box(layout?.ring),
            rimShown: rimModel.shown, rimGraphite: rimModel.graphite, caption: caption.isVisible ? caption.text : nil,
            captionFrame: caption.isVisible ? box(Screen.ax(caption.contentFrame(size: caption.size))) : nil,
            isKey: panel.isKeyWindow || list.panel.isKeyWindow,
            askEditing: list.panel.isKeyWindow && list.panel.firstResponder is NSTextView,
            windowNumber: panel.windowNumber, rimWindowNumber: rimPanel.windowNumber, captionWindowNumber: caption.panel.windowNumber,
            listWindowNumber: list.panel.windowNumber, listOpen: listOpen, listOnScreen: list.panel.isVisible,
            listFrame: list.panel.isVisible ? box(Screen.ax(list.contentFrame(size: list.size))) : nil,
            rows: center.page(pages: donePages).rows, more: center.page(pages: donePages).more, donePages: donePages,
            incomplete: center.feed.incomplete, feedSeq: center.feed.seq, listed: center.feed.listed,
            pausable: Dictionary(uniqueKeysWithValues: pause.running.map { (String($0.key), $0.value.sorted()) }),
            activity: center.stats, stats: stats, deskNotRight: deskNotRight
        )
    }

    static func summary(_ s: Perch.Subject) -> String {
        let app = s.app.map { " in \($0)" } ?? ""
        switch s.mood {
        case .working: return "Working\(app)"
        case .waiting: return "Paused\(app), waiting for you to continue"
        case .needsYou: return s.needsYou > 1 ? "\(s.needsYou) items need you" : "Needs you\(app)"
        case .done: return "Done\(app)"
        case .error: return "Didn't finish\(app)"
        }
    }
}

/// Finds the screen frame of the window a task acts in, among the app's windows: by the frame the
/// helper recorded, then by title (`TaskWindow`; the helper's window ids are its own, so they do
/// not name a window-server window). Falls back to the app's main window, then its first. One
/// Accessibility read per call, off the main thread.
final class WindowLocator: @unchecked Sendable {
    private let queue = DispatchQueue(label: "dev.caret.host.window-locator", qos: .utility)

    func locate(pid: Int32, title: String?, frame: CGRect?, completion: @escaping @MainActor (CGRect?) -> Void) {
        queue.async {
            let found = Self.frame(pid: pid, title: title, recorded: frame)
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(found) } }
        }
    }

    static func frame(pid: Int32, title: String?, recorded: CGRect?) -> CGRect? {
        let app = AXUIElementCreateApplication(pid)
        let windows = AXRead.elements(kAXWindowsAttribute, on: app)
        let candidates = windows.map { TaskWindow.Candidate(frame: AXRead.frame(of: $0), title: AXRead.string(kAXTitleAttribute, on: $0)) }
        if let i = TaskWindow.pick(frame: recorded, title: title, among: candidates) {
            return candidates[i].frame
        }
        if let main = AXRead.element(kAXMainWindowAttribute, on: app) { return AXRead.frame(of: main) }
        return windows.first.flatMap { AXRead.frame(of: $0) }
    }
}
