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
    private var stats = Stats()

    struct Stats: Codable, Equatable {
        var moves = 0
        var shows = 0
        var leaves = 0
        var lastMoveReason: String?
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
            locator.locate(pid: pid, title: subject.windowTitle) { [weak self] found in
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

    func openList() {
        listOpen = true
        center.acknowledge()
        renderList()
        anchorList()
        if drawsOnScreen { list.enter() }
        if clickMonitor == nil {
            // A click in another app closes the list; clicks in Caret's own panels do not reach
            // a global monitor.
            clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                MainActor.assumeIsolated { self?.closeList() }
            }
        }
    }

    func closeList() {
        guard listOpen else { return }
        listOpen = false
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
        clickMonitor = nil
        list.exit(duration: 0.1)
    }

    private func renderList() {
        let rows = center.rows()
        let view = ActivityListView(
            rows: rows, mood: subject?.mood, character: FigureSettings.shared.character,
            busy: center.busy, animated: !Motion.reduceMotion
        ) { [weak self] taskId, action in
            self?.center.control(taskId, action)
        }
        list.text = view.title
        list.setContent(view)
    }

    /// The list grows away from the perch's corner, 6 pt from it; with no perch on screen (opened
    /// from the menu), from the bottom-right home.
    private func anchorList() {
        let perch = frame ?? PerchPlacement.frame(.bottomRight, size: PerchModel.size, in: screenFrame())
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
        /// The window server's numbers for the perch and the list, for window-only screenshots.
        var windowNumber: Int
        var listWindowNumber: Int
        var listOpen: Bool
        var listOnScreen: Bool
        var rows: [ActivityRow]
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
            windowNumber: panel.windowNumber, listWindowNumber: list.panel.windowNumber, listOpen: listOpen, listOnScreen: list.panel.isVisible,
            rows: center.rows(), feedSeq: center.feed.seq, listed: center.feed.listed,
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

/// Finds the screen frame of the window a task acts in, by the app's pid and the window's title
/// (the helper's window ids are its own, so they do not name a window-server window). Falls back
/// to the app's main window, then its first. One Accessibility read per call, off the main thread.
final class WindowLocator: @unchecked Sendable {
    private let queue = DispatchQueue(label: "dev.caret.host.window-locator", qos: .utility)

    func locate(pid: Int32, title: String?, completion: @escaping @MainActor (CGRect?) -> Void) {
        queue.async {
            let frame = Self.frame(pid: pid, title: title)
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(frame) } }
        }
    }

    static func frame(pid: Int32, title: String?) -> CGRect? {
        let app = AXUIElementCreateApplication(pid)
        let windows = AXRead.elements(kAXWindowsAttribute, on: app)
        if let title, let match = windows.first(where: { AXRead.string(kAXTitleAttribute, on: $0) == title }) {
            return AXRead.frame(of: match)
        }
        if let main = AXRead.element(kAXMainWindowAttribute, on: app) { return AXRead.frame(of: main) }
        return windows.first.flatMap { AXRead.frame(of: $0) }
    }
}
