import CaretScreenCore
import CoreGraphics
import Foundation

/// How a change to the page task panel moves (emil-design-eng: keyboard-driven changes are instant; system
/// changes get the shortest motion that says what happened). `PageTaskView` reads Reduce Motion: every one
/// keeps opacity and drops the rise and the blur.
public enum PageTaskMotion: String, Codable, Sendable {
    /// The panel appears at the form: 180 ms ease-out, opacity and a 2 pt rise (UI moment 1).
    case enter
    /// A change a key made (Tab, Esc, ⌘Z): drawn at once, the figure included.
    case none
    /// A change the helper made (a row resolving, the ending): drawn at once; the figure may still gesture.
    case update
    /// A continuation's group fades in under its hairline, 160 ms (UI moment 3).
    case reveal
    /// The next page: the content crossfades with a 2 pt blur over 200 ms (UI moment 5).
    case crossfade
    /// The panel leaves after its time: a 220 ms fade. A key that put it away hides it at once (`none`).
    case exit
}

/// Where the panel goes, as the helper's page view gave it (global, top-left points).
public struct PageTaskAnchor: Equatable, Sendable {
    /// The first field the page's first segment writes.
    public var field: CGRect?
    /// The page's visible area.
    public var viewport: CGRect?

    public init(field: CGRect?, viewport: CGRect?) {
        self.field = field
        self.viewport = viewport
    }
}

public enum PageTaskSend: Equatable, Sendable {
    case accept(GoalAccept)
    case control(TaskControl)
}

public enum PageTaskCommand: Equatable, Sendable {
    case draw(PageTaskPanel, motion: PageTaskMotion, anchor: PageTaskAnchor)
    case hide(motion: PageTaskMotion)
    case send(PageTaskSend)
    case count(String)
    /// The panel's ⌘Z took the arbiter's one toast slot: whoever held it has lost it.
    case toastTaken
}

/// The page task panel's decisions (brief H11): which preview owns the browser's Tab, what each key sends,
/// when the panel shows, changes and leaves. A page goal from the desk's Ask starts it (`start`); later
/// segments, receipts, stops and ends come from the helper (`receive`). Keys reach it through the arbiter,
/// as every offer's do: the preview is a pop-up offer that owns Tab and Esc in the browser, the run is a
/// working line that Esc stops after 3 s, the ending is a toast whose ⌘Z undoes the page.
///
/// Like `FillMachine`, it decides and the host draws: plain values in, `PageTaskCommand` out, time from a
/// `SurfaceClock`. Main thread only.
public final class PageTaskMachine {
    public private(set) var task: PageTask?
    private let arbiter: OfferArbiter
    private let clock: SurfaceClock
    public var output: (PageTaskCommand) -> Void = { _ in }

    private var offerID: UInt64?
    private var statusID: UInt64?
    private var toastID: UInt64?
    private var timers: [String: SurfaceTimer] = [:]
    /// The browser went behind another app: nothing is drawn and the preview owns no key.
    private var hidden = false
    /// The ending's time ran out: the panel left, and the task rests, so what continues it (fields its writes
    /// revealed, the next page after the user's own Next) brings the panel back for the same task.
    private var resting = false
    private var publishTries = 0
    /// Esc reads as Stop on the running panel 3 s in, when the working line starts taking it.
    private var stoppable = false
    /// Why the last Tab on the panel sent nothing, for the debug state.
    public private(set) var lastHeld: String?

    /// An ending with ⌘Z stays this long. A guess, not measured: DIRECTION.md's toast is 5 s for one
    /// line, and this panel lists every field it wrote, which takes longer to read.
    public static let undoLifetime: Double = 8
    /// An ending with nothing to undo stays as an error line does (`FillMachine` errorLifetime).
    public static let endLifetime: Double = 6
    /// After the page is put back (DIRECTION.md 5.3, "Undone": it leaves after 2.5 s).
    public static let undoneLifetime: Double = 2.5
    /// Typing dismissed the ending's ⌘Z: the panel goes as a typed-away result does (DIRECTION.md 5.3: 80 ms).
    static let typedLeave: Double = 0.08
    /// How long a task rests after its panel left, for what continues it to bring it back: the memo's CARRY_MS
    /// (fast-browser.md, "Authority contract": the goal carries across the user's Next for 120 s).
    public static let carryWindow: Double = 120
    /// ⌘Z's answers stop being awaited after this long.
    public static let undoWait: Double = 6
    /// A publish the arbiter refused (an insertion running) is tried again this often, this many times.
    static let publishRetry: Double = 0.15
    static let publishTriesMax = 10

    public init(arbiter: OfferArbiter, clock: SurfaceClock) {
        self.arbiter = arbiter
        self.clock = clock
    }

    var nowMs: Int64 { Int64((clock.now.timeIntervalSince1970 * 1000).rounded()) }

    // MARK: - From the desk and the helper

    /// The desk's Ask came back as a page goal's preview: the panel takes it at the form. False when this is
    /// not a page's preview, or a page task is running (the desk then says so).
    @discardableResult
    public func start(_ m: GoalProgress) -> Bool {
        guard case .segment(let p) = m.event, let fresh = PageTask(preview: p, goalId: m.goalId), fresh.pid != nil else { return false }
        if let t = task {
            switch t.stage {
            case .running, .stopping: return false
            case .preview, .ended: clear(hide: false)
            }
        }
        task = fresh
        hidden = false
        output(.count("pageTask.started"))
        showPreview(.enter)
        return true
    }

    /// A goal message the helper published. Only one that continues the task on screen changes anything.
    public func receive(_ m: GoalProgress) {
        guard var t = task else { return }
        let wasEnded: Bool
        if case .ended = t.stage { wasEnded = true } else { wasEnded = false }
        let result = t.receive(m)
        switch result {
        case .ignored: return
        case .applied:
            task = t
            // The end is acted on once; a receipt that comes after it only redraws, and gives ⌘Z its toast when it
            // was the page's first verified write (review H11-3).
            if case .ended = t.stage, !wasEnded { ended() } else {
                if case .ended = t.stage, t.undo == .available, toastID == nil, !resting, let newest = t.tasks.last, let pid = t.pid {
                    let target = TargetIdentity(pid: pid, bundleID: t.app.bundleId, windowID: t.windowId, elementID: "pageTask", elementRevision: newest)
                    toastID = arbiter.showToast(UndoGrant.task(newest, target: target, createdAt: clock.now, lifetimeSeconds: Self.undoLifetime))
                    output(.toastTaken)
                }
                draw(.update)
            }
        case .continued, .nextPage:
            task = t
            output(.count(result == .nextPage ? "pageTask.nextPage" : "pageTask.continued"))
            endResult()
            // A task at rest comes back as the panel first came: its panel had left.
            let back = resting
            resting = false
            cancel("forget")
            cancel("undoWait")
            showPreview(back ? .enter : result == .nextPage ? .crossfade : .reveal)
        }
    }

    /// The task's own progress messages: the undo's answers.
    public func taskProgress(_ p: TaskProgress) {
        guard var t = task, p.phase == .undone, t.undone(taskId: p.taskId, restored: p.restored ?? 0) else { return }
        task = t
        if case .undone = t.undo {
            cancel("undoWait")
            draw(.update)
            leave(after: Self.undoneLifetime)
        } else {
            draw(.update)
        }
    }

    /// The helper refused this task's acceptance.
    public func helperError(_ e: HelperError) {
        guard var t = task, t.refused(e.message) else { return }
        task = t
        output(.count("pageTask.acceptRefused"))
        ended()
    }

    public func linkChanged(up: Bool) {
        guard !up, var t = task else { return }
        t.lostTouch()
        task = t
        ended()
    }

    // MARK: - Keys, through the arbiter

    /// Tab took the preview offer.
    public func claimed(_ claim: Claim) {
        guard let id = offerID, claim.offer.id == id, var t = task else { return }
        offerID = nil
        cancel("expire")
        switch t.tab(nowMs: nowMs) {
        case .accept(let accept):
            task = t
            lastHeld = nil
            output(.send(.accept(accept)))
            output(.count("pageTask.accepted"))
            if let pid = t.pid {
                statusID = arbiter.showStatus(StatusLine(pid: pid, kind: .working(startedAt: clock.now), offerKey: offerKey(t.current)))
            }
            stoppable = false
            timers["stoppable"] = clock.schedule(after: StatusLine.stoppableAfter, repeats: false) { [weak self] in
                guard let self, let t = self.task, case .running = t.stage else { return }
                self.stoppable = true
                self.draw(.update)
            }
            draw(.none)
        case .held(let why):
            task = t
            lastHeld = why
            output(.count("pageTask.tabHeld"))
            if case .ended = t.stage { ended() }
        }
    }

    /// The arbiter's current offer changed for a reason a key or its age gave. A preview that is no longer
    /// current was put away (Esc, typing, its age): the panel goes. A toast that was dismissed takes ⌘Z away.
    public func offerChanged(_ reason: OfferArbiter.PassReason) {
        guard let t = task else { return }
        let snapshot = arbiter.snapshot()
        if let id = offerID, snapshot.current?.id != id, case .preview = t.stage {
            offerID = nil
            putAway(byKey: reason == .dismissed || reason == .closed)
            return
        }
        if reason == .toastDismissed, let id = toastID, snapshot.toast?.id != id {
            toastID = nil
            if case .ended = t.stage, t.undo == .available { leave(after: Self.typedLeave) }
        }
        if reason == .statusDismissed, let id = statusID, snapshot.statusLine?.id != id {
            // Typing in the page took the working line; the run goes on until the helper says how it ended.
            statusID = nil
        }
    }

    /// Another surface took the arbiter's one toast slot: ⌘Z is no longer this panel's, so it stops saying so.
    public func toastChanged() {
        guard let id = toastID, arbiter.snapshot().toast?.id != id, var t = task else { return }
        toastID = nil
        if t.undo == .available { t.undo = .none }
        task = t
        draw(.update)
    }

    /// Esc closed an offer.
    public func offerClosed(_ id: UInt64) {
        guard id == offerID else { return }
        offerID = nil
        putAway(byKey: true)
    }

    /// Another offer replaced the preview: the user's attention moved to another app (`mayReplace` keeps
    /// every other producer off the browser while the preview shows).
    public func displaced(_ offer: Offer) {
        guard offer.id == offerID else { return }
        offerID = nil
        putAway(byKey: false)
    }

    /// Esc on the working line, 3 s in. True when the line was this panel's.
    @discardableResult
    public func stopWork(_ line: StatusLine) -> Bool {
        guard let id = statusID, line.id == id, var t = task else { return false }
        statusID = nil
        if case .stop(let control) = t.escape() {
            task = t
            output(.send(.control(control)))
            output(.count("pageTask.stopped"))
            draw(.none)
        }
        return true
    }

    /// Whether ⌘Z on a toast for `taskID` is this panel's.
    public func ownsTask(_ taskID: String) -> Bool { task?.owns(taskID) ?? false }

    /// ⌘Z took the toast: every task on this page that wrote is undone, newest first.
    public func undoStarted(_ grant: UndoGrant) {
        guard let id = toastID, grant.id == id, var t = task else { return }
        toastID = nil
        cancel("leave")
        let controls = t.undoAll()
        task = t
        guard !controls.isEmpty else { return }
        for c in controls { output(.send(.control(c))) }
        output(.count("pageTask.undo"))
        timers["undoWait"] = clock.schedule(after: Self.undoWait, repeats: false) { [weak self] in
            guard let self, var t = self.task, case .undoing = t.undo else { return }
            // No word came back that the page was restored: the panel says to check it.
            t.undo = .undone(restored: 0)
            self.task = t
            self.draw(.update)
            self.leave(after: Self.endLifetime)
        }
        draw(.none)
    }

    /// Another app came to the front: the panel hides, and a preview gives up its keys until the browser is back.
    public func appActivated(pid: Int32) {
        guard let t = task, let own = t.pid else { return }
        if pid != own {
            guard !hidden else { return }
            hidden = true
            if let id = offerID {
                arbiter.invalidate(offerID: id)
                offerID = nil
            }
            // A resting task has no panel to hide, but where the user is still counts (review H11-4).
            if !resting { output(.hide(motion: .none)) }
        } else if hidden {
            hidden = false
            guard !resting else { return }
            if case .preview = t.stage { showPreview(.enter) } else { draw(.enter) }
        }
    }

    // MARK: - The arbiter and drawing

    private func offerKey(_ g: PageTask.Group) -> String { "pageTask:\(g.goalId):\(g.segment)" }

    /// Publishes the newest group as the offer that owns Tab, arms its expiry, and draws.
    private func showPreview(_ motion: PageTaskMotion) {
        guard let t = task, case .preview = t.stage else { return }
        let remaining = Double(t.current.expires - nowMs) / 1000
        guard remaining > 0 else { return expire() }
        cancel("expire")
        timers["expire"] = clock.schedule(after: remaining, repeats: false) { [weak self] in self?.expire() }
        publishTries = 0
        publish()
        draw(motion)
        reveal()
    }

    /// The preview owns Tab only once it is drawn (review H11-1): it is published unshown, drawn, then revealed. A
    /// key that came between dismissed it, and the panel goes with it.
    private func reveal() {
        guard let id = offerID, !hidden else { return }
        if !arbiter.reveal(offerID: id) {
            offerID = nil
            putAway(byKey: true)
        }
    }

    private func publish() {
        guard let t = task, case .preview = t.stage, !hidden, let pid = t.pid else { return }
        let g = t.current
        let remaining = Double(g.expires - nowMs) / 1000
        let spec = PopupSpec(id: offerKey(g), figure: .offering, blocks: [
            PopupSpec.Block(.header(PopupSpec.Header(title: PopupSpec.Value(PageTaskCopy.title(t), ref: .derived(rule: "pageTask", from: []))))),
            PopupSpec.Block(.actions(PopupSpec.Actions(items: [PopupSpec.Action(id: "fill", label: PageTaskCopy.tabLabel(g), key: .tab)]))),
        ])
        let target = TargetIdentity(pid: pid, bundleID: t.app.bundleId, windowID: t.windowId, elementID: offerKey(g), elementRevision: g.digest)
        let offer = Offer(text: "", source: .helper, kind: .popup(PopupOffer(offerKey: offerKey(g), spec: spec, pageTask: true)),
                          target: target, fieldValue: "", caretUTF16: 0, createdAt: clock.now, maxAgeSeconds: max(remaining, 0.1))
        if let id = arbiter.publish(offer, shown: false) {
            offerID = id
            return
        }
        // An insertion is running, or the arbiter just consumed this state: try again shortly.
        publishTries += 1
        output(.count("pageTask.publishRefused"))
        guard publishTries < Self.publishTriesMax else { return }
        timers["publish"] = clock.schedule(after: Self.publishRetry, repeats: false) { [weak self] in
            self?.publish()
            self?.reveal()
        }
    }

    private func expire() {
        guard var t = task, case .preview = t.stage else { return }
        if let id = offerID {
            arbiter.invalidate(offerID: id)
            offerID = nil
        }
        _ = t.tab(nowMs: Int64.max)
        task = t
        output(.count("pageTask.expired"))
        ended()
    }

    /// The task ended: its working line goes, a toast holds ⌘Z when something was written, and the panel
    /// leaves after its time.
    private func ended() {
        guard let t = task else { return }
        cancel("stoppable")
        cancel("expire")
        if let id = statusID {
            arbiter.clearStatus(id: id)
            statusID = nil
        }
        if let id = offerID {
            arbiter.invalidate(offerID: id)
            offerID = nil
        }
        if t.undo == .available, let newest = t.tasks.last, let pid = t.pid {
            let target = TargetIdentity(pid: pid, bundleID: t.app.bundleId, windowID: t.windowId, elementID: "pageTask", elementRevision: newest)
            toastID = arbiter.showToast(UndoGrant.task(newest, target: target, createdAt: clock.now, lifetimeSeconds: Self.undoLifetime))
            output(.toastTaken)
            leave(after: Self.undoLifetime, rest: Self.continues(t))
        } else {
            leave(after: Self.endLifetime, rest: Self.continues(t))
        }
        draw(.update)
    }

    /// The ending's toast and leave timer, when a continuation takes the panel.
    private func endResult() {
        cancel("leave")
        if let id = toastID {
            arbiter.dismissToast(grantID: id)
            toastID = nil
        }
    }

    private func putAway(byKey: Bool) {
        output(.count("pageTask.putAway"))
        clear(hide: true, motion: byKey ? .none : .exit)
    }

    /// The panel leaves after `seconds`. With `rest`, the task stays for `carryWindow` without a panel or any key.
    private func leave(after seconds: Double, rest: Bool = false) {
        cancel("leave")
        timers["leave"] = clock.schedule(after: seconds, repeats: false) { [weak self] in
            guard let self else { return }
            guard rest else { return self.clear(hide: true, motion: .exit) }
            if let id = self.toastID { self.arbiter.dismissToast(grantID: id) }
            self.toastID = nil
            self.resting = true
            self.output(.hide(motion: .exit))
            self.timers["forget"] = self.clock.schedule(after: Self.carryWindow, repeats: false) { [weak self] in self?.clear(hide: false) }
        }
    }

    /// A task that ran and ended on its own terms may be continued: a reveal after it finished, a fresh plan
    /// after a stop, the next page after either. Not one that never ran.
    static func continues(_ t: PageTask) -> Bool {
        switch t.stage {
        case .ended(.finished), .ended(.stopped): return t.groups.contains(where: \.accepted)
        default: return false
        }
    }

    /// Ends everything this task holds in the arbiter and forgets it.
    private func clear(hide: Bool, motion: PageTaskMotion = .none) {
        for (_, timer) in timers { timer.cancel() }
        timers = [:]
        if let id = offerID { arbiter.invalidate(offerID: id) }
        if let id = statusID { arbiter.clearStatus(id: id) }
        if let id = toastID { arbiter.dismissToast(grantID: id) }
        offerID = nil
        statusID = nil
        toastID = nil
        task = nil
        stoppable = false
        resting = false
        if hide { output(.hide(motion: motion)) }
    }

    private func cancel(_ name: String) {
        timers.removeValue(forKey: name)?.cancel()
    }

    private func draw(_ motion: PageTaskMotion) {
        guard let t = task, !hidden, !resting else { return }
        let anchor = PageTaskAnchor(field: t.anchor.map(Self.rect), viewport: t.viewport.map(Self.rect))
        output(.draw(PageTaskPanel(task: t, stoppable: stoppable), motion: motion, anchor: anchor))
    }

    static func rect(_ f: Frame) -> CGRect { CGRect(x: f.x, y: f.y, width: f.width, height: f.height) }

    // MARK: - Debug

    public struct Status: Codable, Equatable, Sendable {
        public var stage: String
        public var goalId: String?
        public var groups: Int
        public var page: Int
        public var ownsTab: Bool
        public var hidden: Bool
        public var undo: String
        public var lastHeld: String?
    }

    public var status: Status {
        guard let t = task else { return Status(stage: "none", goalId: nil, groups: 0, page: 0, ownsTab: false, hidden: hidden, undo: "none", lastHeld: lastHeld) }
        let stage: String
        switch t.stage {
        case .preview: stage = "preview"
        case .running: stage = "running"
        case .stopping: stage = "stopping"
        case .ended(let e):
            switch e {
            case .finished(let end): stage = "ended:\(end.outcome.rawValue)"
            case .stopped(let s): stage = "ended:stopped:\(s.reason.rawValue)"
            case .notRun: stage = "ended:notRun"
            case .lostTouch: stage = "ended:lostTouch"
            }
        }
        let undo: String
        switch t.undo {
        case .none: undo = "none"
        case .available: undo = "available"
        case .undoing: undo = "undoing"
        case .undone(let n): undo = "undone:\(n)"
        }
        return Status(stage: stage, goalId: t.current.goalId, groups: t.groups.count, page: t.page, ownsTab: offerID != nil, hidden: hidden, undo: undo, lastHeld: lastHeld)
    }
}
