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

/// Main-thread owner of the perch and the activity list.
///
/// The perch is on screen only while there is something to report (`Perch.subject`), so it is
/// never idle on screen. It sits in a corner of the visible frame of the screen the user is
/// typing on, looks toward the window its task acts in, and moves to another corner when the
/// focused field or the caret comes near (`PerchPlacement`). `drawsOnScreen: false` computes all
/// of it and orders nothing front, for socket-only test runs while someone is using the Mac.
@MainActor
final class PerchController {
    let model = PerchModel()
    private let center: ActivityCenter
    private let drawsOnScreen: Bool
    private let panel = PerchPanel.make()
    private let list = HostedPanel(radius: 12, interactive: true)
    private let locator = WindowLocator()
    /// The ask field at the top of the list (brief A13): its decisions, and what the view draws.
    let ask = AskCaret(clock: RunLoopClock(), character: { MainActor.assumeIsolated { FigureSettings.shared.character } })
    private let askModel = AskModel()
    /// The ask phase last drawn into the list, so a change of phase resizes it and typing does not.
    private var drawnAsk: AskCaret.Phase = .idle
    /// Whether the drawn list shows the Return hint under the field, which appears with the first
    /// character typed and adds a row: the list is measured again only when that changes.
    private var drawnHint = false
    /// "What Caret knows" at the foot of the list.
    var onOpenMemory: (() -> Void)?
    /// The list opened (true) or closed (false).
    var onListChanged: ((Bool) -> Void)?

    /// The menu bar's "Show Perch" choice. Hidden stops drawing; the list still opens from the menu.
    var hidden: Bool {
        get { UserDefaults.standard.bool(forKey: Self.hiddenKey) }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.hiddenKey)
            refresh()
        }
    }
    static let hiddenKey = "perchHidden"

    private var subject: Perch.Subject?
    private var home: PerchPlacement.Home?
    private var frame: CGRect?
    private var choice: PerchPlacement.Choice?
    private var field: CGRect?
    private var caret: CGRect?
    /// The focused field, kept so its frame can be read when the perch first gets something to
    /// show; its frame is not read while the perch is idle.
    private var focusedElement: AXUIElement?
    private var hopWork: DispatchWorkItem?
    private var stopped = false
    /// The window the subject's task acts in, as last located; global, top-left origin.
    private var target: (taskId: String, frame: CGRect?)?
    private var expiryTimer: Timer?
    private var gazeTimer: Timer?
    private var blinkTimer: Timer?
    private var orderOutWork: DispatchWorkItem?
    private var relocating = false
    private var clickMonitor: Any?
    private(set) var listOpen = false
    /// The open list was placed as the desk (Ask Caret), so a perch move does not re-hang it.
    private var listIsDesk = false
    /// Pages of Done rows the open list shows; "and N more" adds one, closing the list resets it.
    private(set) var donePages = 1
    private var stats = Stats()

    struct Stats: Codable, Equatable {
        var moves = 0
        var shows = 0
        var leaves = 0
        var lastMoveReason: String?
        /// The list was marked open but was not on screen when Ask Caret was chosen.
        var reopened = 0
        /// Where the list last opened: under the perch, or as the desk under the menu bar.
        var listAnchor: String?
    }

    init(center: ActivityCenter, drawsOnScreen: Bool) {
        self.center = center
        self.drawsOnScreen = drawsOnScreen
        let host = FirstMouseHostingView(rootView: AnyView(PerchView(model: model)))
        host.frame = NSRect(origin: .zero, size: PerchModel.size)
        panel.contentView = host
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
        ask.onChange = { [weak self] in self?.askChanged() }
    }

    // MARK: - The ask field

    private func askChanged() {
        if askModel.text != ask.text { askModel.text = ask.text }
        if askModel.phase != ask.phase { askModel.phase = ask.phase }
        let newlyFailed: Bool = { if case .failed = ask.phase, drawnAsk != ask.phase { return true } else { return false } }()
        // A new phase can change the list's height; typing alone does not, and redrawing the panel
        // on each key would cost a measure per keystroke.
        if listOpen, drawnAsk != ask.phase || drawnHint != AskSection.showsHint(text: ask.text, phase: ask.phase) { renderList() }
        if newlyFailed { selectFailedInstruction() }
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

    /// Return, Tab, Esc and ⌘Z while the list is key, before the field editor sees them. ⌘Z undoes an
    /// ended run that wrote. Return plans
    /// what the field holds; Tab takes a plan; Esc stops a run, puts away a card or an answer, then
    /// empties the field, then closes the list. True when the key was used.
    private func listKey(_ event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection([.command, .control, .option, .shift])
        // ⌘Z on a run that wrote undoes it (q1 bug 8); otherwise the field editor's own undo.
        if modifiers == .command, event.keyCode == 6, ask.undo() { return true }
        let plain = modifiers.isEmpty
        guard plain else { return false }
        // An input method composing text owns Return and Esc until it commits or cancels.
        if let editor = list.panel.firstResponder as? NSTextView, editor.hasMarkedText() { return false }
        let editing = list.panel.firstResponder is NSTextView
        switch Int64(event.keyCode) {
        case KeyStroke.returnKeyCode, 76:
            return editing && ask.submit()
        case KeyStroke.tabKeyCode:
            // Only from the ask field: with Full Keyboard Access, Tab from a row's button moves on.
            return editing && ask.tab()
        case KeyStroke.escapeKeyCode:
            // A key closes the list at once: keyboard-initiated changes do not animate.
            if !ask.escape() { closeList(exit: 0) }
            return true
        default:
            return false
        }
    }

    /// The menu's Ask Caret: the list opens with the field focused, Caret still behind the app the
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
        if listOpen { anchorList(desk: true) } else { openList(desk: true) }
        guard drawsOnScreen else { return }
        list.panel.orderFrontRegardless()
        list.panel.makeKey()
        askModel.focusToken &+= 1
    }

    // MARK: - Inputs

    /// The activity feed or the acknowledgement changed.
    func refresh() {
        let now = Date()
        model.character = FigureSettings.shared.character
        let next = center.subject(now: now)
        scheduleExpiry(now: now)
        if next?.taskId != subject?.taskId { target = nil }
        if subject == nil, next != nil { field = focusedElement.flatMap { AXRead.frame(of: $0) } }
        subject = next
        if let next {
            model.mood = next.mood
            model.needsYou = next.needsYou
            model.summary = Self.summary(next)
            place(reason: nil)
            updateGaze(locate: target == nil)
            show()
        } else {
            leave()
        }
        if listOpen { renderList() }
    }

    /// The focused text field changed or its caret moved. The field's frame is read only while
    /// the perch has something to show, so focus changes cost nothing extra the rest of the day.
    func focusChanged(caret: CGRect?, element: AXUIElement?) {
        self.caret = caret
        focusedElement = element
        field = subject == nil ? nil : element.flatMap { AXRead.frame(of: $0) }
        guard subject != nil else { return }
        place(reason: "focus")
    }

    /// The debug socket's stand-in for a focused field: global, top-left-origin rects.
    func avoid(caret: CGRect?, field: CGRect?) {
        focusedElement = nil
        self.caret = caret
        self.field = field
        place(reason: "avoid")
    }

    // MARK: - Placement and gaze

    private func screenFrame() -> CGRect {
        let anchor = caret ?? field ?? target?.frame
        let screen = anchor.map { Screen.containing(Screen.cocoa($0)) } ?? NSScreen.main
        return Screen.ax(screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900))
    }

    /// Picks a home and moves there. A move while the perch is on screen is a hop: out in 120 ms,
    /// in at the new corner with the normal entrance, so it never slides across the user's work.
    private func place(reason: String?) {
        let choice = PerchPlacement.choose(visible: screenFrame(), size: PerchModel.size, field: field, caret: caret, current: home)
        self.choice = choice
        guard choice.frame != frame else { return }
        let moving = frame != nil && home != choice.home
        home = choice.home
        frame = choice.frame
        if moving {
            stats.moves += 1
            stats.lastMoveReason = reason
        }
        if moving, model.presented, drawsOnScreen, panel.isVisible, !hidden {
            hop(to: choice.frame)
        } else {
            panel.setFrame(Screen.cocoa(choice.frame), display: false)
        }
        updateGaze(locate: false)
        if listOpen { anchorList() }
    }

    private func hop(to axFrame: CGRect) {
        relocating = true
        hopWork?.cancel()
        withAnimation(Motion.curve(Motion.easeOut, 0.12)) { model.presented = false }
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.stopped else { return }
                self.relocating = false
                self.hopWork = nil
                self.panel.setFrame(Screen.cocoa(axFrame), display: false)
                if self.subject != nil { self.show() } else { self.panel.orderOut(nil) }
            }
        }
        hopWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.13, execute: work)
    }

    /// Looks again for the subject's window when `locate` is set or the subject changed, and
    /// re-aims at the last frame found (the perch may have moved).
    private func updateGaze(locate: Bool) {
        guard let subject else { return }
        let changed = target?.taskId != subject.taskId
        if changed { target = (subject.taskId, nil) }
        if locate || changed, let pid = subject.pid {
            let taskId = subject.taskId
            locator.locate(pid: pid, title: subject.windowTitle, frame: subject.windowFrame) { [weak self] found in
                guard let self, self.subject?.taskId == taskId else { return }
                let screenWas = self.screenFrame()
                self.target = (taskId, found)
                // With no field focused, the perch belongs on the screen of the window it watches
                // (the first on-screen run put it on another display).
                if self.caret == nil, self.field == nil, self.screenFrame() != screenWas { self.place(reason: "target") }
                self.aim()
            }
        }
        aim()
    }

    private func aim() {
        guard let subject, let frame else { return }
        let perch = CGPoint(x: frame.midX, y: frame.midY)
        let gaze: CGVector
        switch subject.mood {
        case .done, .error: gaze = .zero
        case .working, .waiting, .needsYou:
            gaze = target?.frame.map { PerchGaze.toward($0, from: perch) } ?? PerchGaze.fallback(for: subject.mood)
        }
        if gaze != model.gaze { model.gaze = gaze }
    }

    // MARK: - On and off screen

    private func show() {
        orderOutWork?.cancel()
        orderOutWork = nil
        guard !relocating, !stopped else { return }
        if !model.presented {
            stats.shows += 1
            let reduce = Motion.reduceMotion
            // Nothing animates where nothing is drawn.
            model.animated = !reduce && drawsOnScreen && !hidden
            if drawsOnScreen, !hidden, let frame {
                panel.setFrame(Screen.cocoa(frame), display: false)
                panel.orderFrontRegardless()
            }
            withAnimation(reduce ? .linear(duration: 0.12) : Motion.curve(Motion.easeOut, 0.18)) { model.presented = true }
        } else if drawsOnScreen, !hidden, !panel.isVisible {
            panel.orderFrontRegardless()
        }
        if hidden || !drawsOnScreen { panel.orderOut(nil) }
        startGazeTimer()
    }

    private func leave() {
        gazeTimer?.invalidate()
        gazeTimer = nil
        blinkTimer?.invalidate()
        blinkTimer = nil
        // A hop in flight has already hidden the figure; nothing must bring it back.
        if relocating {
            hopWork?.cancel()
            hopWork = nil
            relocating = false
            panel.orderOut(nil)
        }
        guard model.presented else { return }
        stats.leaves += 1
        let reduce = Motion.reduceMotion
        withAnimation(reduce ? .linear(duration: 0.12) : Motion.curve(Motion.easeOut, 0.16)) { model.presented = false }
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.model.presented else { return }
                self.panel.orderOut(nil)
            }
        }
        orderOutWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: work)
    }

    /// The window a task acts in can move; the perch re-reads its frame every 2 s while it is on
    /// screen. One Accessibility read of one app's windows. Assumed often enough: a glance that
    /// lags a dragged window by 2 s reads as attention, not a fault.
    private func startGazeTimer() {
        if blinkTimer == nil {
            // The pebble blinks every 5 s while its eyes are open on something (IDENTITY.md).
            blinkTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.model.animated, self.model.presented else { return }
                    guard [.working, .waiting, .needsYou].contains(self.model.mood) else { return }
                    self.model.blinkTick &+= 1
                }
            }
        }
        guard gazeTimer == nil else { return }
        gazeTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.updateGaze(locate: true) }
        }
    }

    private func scheduleExpiry(now: Date) {
        expiryTimer?.invalidate()
        expiryTimer = nil
        guard let at = Perch.nextExpiry(center.records, now: now, acknowledgedAt: center.acknowledgedAt) else { return }
        expiryTimer = Timer.scheduledTimer(withTimeInterval: max(0.05, at.timeIntervalSince(now) + 0.05), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    // MARK: - The activity list

    func toggleList() {
        listOpen ? closeList() : openList()
    }

    /// `desk`: placed as the desk over the window in front even when the perch is on screen
    /// (the menu's Ask Caret); otherwise it hangs from the perch when there is one.
    func openList(desk: Bool = false) {
        listOpen = true
        defer { onListChanged?(true) }
        listIsDesk = desk
        center.acknowledge()
        renderList()
        anchorList(desk: desk)
        if drawsOnScreen { list.enter() }
        if clickMonitor == nil {
            // A click in another app closes the list; clicks in Caret's own panels do not reach
            // a global monitor.
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

    func closeList(exit: TimeInterval = 0.1) {
        guard listOpen else { return }
        listOpen = false
        // A card nobody can see takes no Tab, so it goes; a run goes on and the list still reports
        // it, and a half-typed request stays for the next opening.
        switch ask.phase {
        case .running, .idle: break
        case .asking, .proposed, .failed, .ended: ask.escape()
        }
        donePages = 1
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
        clickMonitor = nil
        list.exit(duration: exit)
        onListChanged?(false)
    }

    private func renderList() {
        // A new root view loses the field's keyboard focus; give it back if it had it.
        let fieldHadFocus = list.panel.isKeyWindow && list.panel.firstResponder is NSTextView
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

    /// The list grows away from the perch's corner, 6 pt from it. With no perch on screen (opened
    /// from the menu), it is the desk: under the menu bar of the screen holding the window in
    /// front, centered over that window (`DeskPlacement`, A18 bug 13).
    private func anchorList(desk: Bool? = nil) {
        if let desk { listIsDesk = desk }
        guard !listIsDesk, let perch = frame, model.presented, drawsOnScreen, !hidden, panel.isVisible else {
            let window = Self.frontWindow()
            let screens = NSScreen.screens.map { Screen.ax($0.visibleFrame) }
            let visible = DeskPlacement.screen(for: window, screens: screens, fallback: screenFrame())
            let p = DeskPlacement.topLeft(width: list.size.width, visible: visible, window: window)
            stats.listAnchor = window == nil ? "desk" : "desk.window"
            list.pin(.init(corner: .topLeft, point: NSPoint(x: p.x, y: Screen.cocoa(CGRect(origin: p, size: .zero)).maxY)))
            return
        }
        stats.listAnchor = "perch"
        let c = Screen.cocoa(perch)
        let anchor: HostedPanel.Anchor
        switch home ?? .bottomRight {
        case .bottomRight: anchor = .init(corner: .bottomRight, point: NSPoint(x: c.maxX, y: c.maxY + 6))
        case .bottomLeft: anchor = .init(corner: .bottomLeft, point: NSPoint(x: c.minX, y: c.maxY + 6))
        case .topRight: anchor = .init(corner: .topRight, point: NSPoint(x: c.maxX, y: c.minY - 6))
        case .topLeft: anchor = .init(corner: .topLeft, point: NSPoint(x: c.minX, y: c.minY - 6))
        }
        list.pin(anchor)
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

    func shutdown() {
        stopped = true
        hopWork?.cancel()
        orderOutWork?.cancel()
        expiryTimer?.invalidate()
        gazeTimer?.invalidate()
        blinkTimer?.invalidate()
        closeList()
        panel.orderOut(nil)
    }

    // MARK: - Debug socket

    struct DebugInfo: Codable, Equatable {
        var presented: Bool
        var onScreen: Bool
        var drawsOnScreen: Bool
        var hidden: Bool
        var subject: Perch.Subject?
        var figure: String?
        var gaze: [Double]
        var home: String?
        /// Global, top-left origin: x, y, width, height.
        var frame: [Double]?
        var targetWindow: [Double]?
        var avoid: [String: [Double]]
        var overlapsField: Bool?
        var overlapsCaret: Bool?
        var isKey: Bool
        /// The list is key and the ask field holds the keyboard (its field editor is first responder).
        var askEditing: Bool
        /// The window server's numbers for the perch and the list, for window-only screenshots.
        var windowNumber: Int
        var listWindowNumber: Int
        var listOpen: Bool
        var listOnScreen: Bool
        /// The list's frame while on screen, global top-left points.
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
    }

    func debugInfo() -> DebugInfo {
        func box(_ r: CGRect?) -> [Double]? { r.map { [$0.minX, $0.minY, $0.width, $0.height].map(Double.init) } }
        var avoid: [String: [Double]] = [:]
        if let f = box(field) { avoid["field"] = f }
        if let c = box(caret) { avoid["caret"] = c }
        let pause = center.pauseGate.snapshot()
        return DebugInfo(
            presented: model.presented, onScreen: panel.isVisible, drawsOnScreen: drawsOnScreen, hidden: hidden,
            subject: subject, figure: subject.map { $0.mood.figure.rawValue },
            gaze: [Double(model.gaze.dx), Double(model.gaze.dy)], home: home?.rawValue, frame: box(frame),
            targetWindow: box(target?.frame), avoid: avoid,
            overlapsField: choice?.overlapsField, overlapsCaret: choice?.overlapsCaret,
            isKey: panel.isKeyWindow || list.panel.isKeyWindow,
            askEditing: list.panel.isKeyWindow && list.panel.firstResponder is NSTextView,
            windowNumber: panel.windowNumber, listWindowNumber: list.panel.windowNumber, listOpen: listOpen, listOnScreen: list.panel.isVisible,
            listFrame: list.panel.isVisible ? box(Screen.ax(list.panel.frame)) : nil,
            rows: center.page(pages: donePages).rows, more: center.page(pages: donePages).more, donePages: donePages,
            incomplete: center.feed.incomplete, feedSeq: center.feed.seq, listed: center.feed.listed,
            pausable: Dictionary(uniqueKeysWithValues: pause.running.map { (String($0.key), $0.value.sorted()) }),
            activity: center.stats, stats: stats
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
