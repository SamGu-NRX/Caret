import CaretScreenCore
import Foundation

/// One page task as the panel at the form holds it (brief H11; fast-browser.md, "Authority contract" and "UI
/// moments"): the groups the helper previewed on this page, each row's state, what Tab, Esc and ⌘Z send, and
/// how the task ended.
///
/// This is the accept path's authority boundary, so it is a plain value with no clock, screen or socket: every
/// method returns what to send. It follows H9's `GoalCard`:
/// - One Tab accepts one segment: the newest group previewed, once, under the digest that preview carried
///   (D2-06). Nothing else accepts a goal's steps.
/// - Nothing is accepted while the newest group is not waiting: running, stopping, ended, or past `expires`.
/// - A preview for another goal changes nothing unless it continues this one: the fields this goal's writes
///   revealed (`afterReveal`, naming this goal in `replaces`), the next page after the user's own Next
///   (`nextPage`, P3), or a fresh plan after a stop that named it (`freshPlan`).
public struct PageTask: Equatable, Sendable {
    public struct Row: Equatable, Sendable {
        public enum State: String, Codable, Sendable {
            case pending
            /// The step the run is on now: the next write after the last receipt.
            case writing
            case verified
            /// The executor found the field already holding the value ("already so").
            case already
            case failed
        }

        /// The step's index in its goal.
        public var step: Int
        public var kind: GoalProgress.Step.Kind
        /// The helper's words for the step: "Country: Canada", "Tick 'Do you have a valid driving license?'".
        public var says: String
        /// From the page view: the field's label and the value it takes, when the step reads as one.
        public var label: String?
        public var value: String?
        /// The value was chosen from a list the page offers.
        public var picked: Bool
        public var state: State

        /// The user's own step: a hand-off. Caret presses nothing on a page and never marks it done. An attach step
        /// (P3) is the user's too: this host declares no goalFiles until its file chooser exists (lead addendum 2).
        public var yours: Bool { kind == .handoff || kind == .press || kind == .attach }

        public init(step: Int, kind: GoalProgress.Step.Kind, says: String, label: String? = nil, value: String? = nil, picked: Bool = false, state: State = .pending) {
            self.step = step
            self.kind = kind
            self.says = says
            self.label = label
            self.value = value
            self.picked = picked
            self.state = state
        }
    }

    /// One previewed segment: the first on a page, or one that continues it.
    public struct Group: Equatable, Sendable {
        public var goalId: String
        public var segment: Int
        public var reason: GoalProgress.Preview.Reason
        public var digest: String
        public var expires: Int64
        public var rows: [Row]
        /// What the helper says the segment leaves to the user, in its words, before Tab.
        public var withheld: [String]
        /// Tab sent this group's acceptance. Never set back.
        public var accepted = false
        /// The executor task it runs in, from its first receipt.
        public var taskId: String?

        /// Writes Caret makes in this group.
        public var writes: Int { rows.filter { $0.kind == .write }.count }
    }

    public enum Stage: Equatable, Sendable {
        /// The newest group waits for Tab.
        case preview
        /// Tab went out for the newest group, and the helper runs it.
        case running
        /// Esc went out for the running group; the helper's stop says where it stopped.
        case stopping
        case ended(Ending)
    }

    public enum Ending: Equatable, Sendable {
        case finished(GoalProgress.End)
        case stopped(GoalProgress.Stop)
        /// The preview lapsed before Tab, or the helper refused the acceptance; nothing ran for it.
        case notRun(String)
        /// The helper's connection dropped while the task ran: nothing says how far it got.
        case lostTouch
    }

    public enum Undo: Equatable, Sendable {
        case none
        /// ⌘Z would undo every task on this page that wrote, newest first.
        case available
        case undoing(waiting: [String], restored: Int)
        case undone(restored: Int)
    }

    /// The page window and the browser the panel's keys arrive on.
    public let windowId: String
    public let app: AppRef
    /// Where the panel was first placed: the first field the page's first segment writes, else the page's top
    /// edge (both global, top-left points). The panel stays there across reveals and pages.
    public var anchor: Frame?
    public var viewport: Frame?
    /// The source line of the page's first segment, without "from".
    public var from: String
    /// Empty file inputs Caret leaves to the user.
    public var attach: [String]
    /// 1 for the page the task began on; one more for each page the user's Next brought (P3).
    public var page: Int = 1
    public var groups: [Group]
    public var stage: Stage = .preview
    /// Tasks whose writes ⌘Z undoes on this page, oldest first.
    public var tasks: [String] = []
    public var undo: Undo = .none

    /// A page task from the first preview of a page goal, or nil when the preview is not a page's.
    public init?(preview p: GoalProgress.Preview, goalId: String) {
        guard let view = p.page else { return nil }
        windowId = view.windowId
        app = view.app
        anchor = view.anchor
        viewport = view.viewport
        from = view.from
        attach = view.attach
        groups = [Self.group(p, goalId: goalId)]
    }

    static func group(_ p: GoalProgress.Preview, goalId: String) -> Group {
        let byStep = Dictionary((p.page?.rows ?? []).map { ($0.step, $0) }, uniquingKeysWith: { a, _ in a })
        let rows = p.steps.map { s -> Row in
            let r = s.kind == .write ? byStep[s.index] : nil
            return Row(step: s.index, kind: s.kind, says: s.says, label: r?.label, value: r?.value, picked: r?.picked ?? false)
        }
        return Group(goalId: goalId, segment: p.segment, reason: p.reason, digest: p.digest, expires: p.expires, rows: rows, withheld: p.warnings)
    }

    /// The group Tab is about: the newest previewed.
    public var current: Group { groups[groups.count - 1] }

    /// The browser's pid, for the arbiter; nil when the helper named something that is not a process.
    public var pid: Int32? { Int32(exactly: app.pid).flatMap { $0 > 0 ? $0 : nil } }

    /// The executor task the running group runs in: its first receipt's, else the one runs.ts names for it.
    public var runningTask: String { current.taskId ?? "\(current.goalId):s\(current.segment)" }

    // MARK: - Tab

    public enum TabResult: Equatable, Sendable {
        case accept(GoalAccept)
        /// Nothing goes out; the reason is for the debug state and tests.
        case held(String)
    }

    /// Tab: accept the newest group as previewed, once.
    public mutating func tab(nowMs: Int64) -> TabResult {
        switch stage {
        case .preview: break
        case .running, .stopping: return .held("a segment is running")
        case .ended: return .held("the task ended")
        }
        let i = groups.count - 1
        guard !groups[i].accepted else { return .held("this segment was accepted") }
        guard nowMs <= groups[i].expires else {
            stage = .ended(.notRun(PageTaskCopy.expired))
            return .held("the preview expired")
        }
        groups[i].accepted = true
        stage = .running
        markNextWriting(in: i, after: -1)
        return .accept(GoalAccept(goalId: groups[i].goalId, segment: groups[i].segment, digest: groups[i].digest, at: nowMs))
    }

    // MARK: - From the helper

    public enum Received: Equatable, Sendable {
        case applied
        case ignored
        /// A preview that continues this task: a reveal's or a fresh plan's group under a hairline.
        case continued
        /// The next page's preview (P3): the same panel, new content.
        case nextPage
    }

    public mutating func receive(_ m: GoalProgress) -> Received {
        if case .segment(let p) = m.event { return preview(p, goalId: m.goalId) }
        guard let g = groups.lastIndex(where: { $0.goalId == m.goalId }) else { return .ignored }
        switch m.event {
        case .segment: return .ignored
        case .step(let r): return step(r, group: g)
        case .stopped(let s): return stopped(s, group: g)
        case .finished(let e):
            guard g == groups.count - 1 else { return .ignored }
            switch stage {
            case .running, .stopping: break
            case .preview, .ended: return .ignored
            }
            for r in groups[g].rows.indices where groups[g].rows[r].state == .writing { groups[g].rows[r].state = .pending }
            end(.finished(e))
            return .applied
        }
    }

    private mutating func preview(_ p: GoalProgress.Preview, goalId: String) -> Received {
        let newest = current
        // A preview of the group already showing (the helper sends one preview per segment): nothing new.
        if goalId == newest.goalId, p.segment == newest.segment { return .ignored }
        guard let view = p.page, view.windowId == windowId else { return .ignored }
        switch p.reason {
        case .afterReveal:
            // The fields this goal's writes revealed: offered once the goal it replaces ended, as runs.ts does.
            guard p.replaces == newest.goalId, newest.accepted, case .ended(.finished) = stage, !undoStarted else { return .ignored }
        case .freshPlan:
            guard p.replaces == newest.goalId, case .ended(.stopped(let stop)) = stage, stop.freshPlan == goalId, !undoStarted else { return .ignored }
        case .nextPage:
            // The user's own Next carried the goal to a new document (P3). Whether P3 names it as this goal's next
            // segment or as a goal that replaces it, it continues only a task that ran.
            let continues = (goalId == newest.goalId && p.segment == newest.segment + 1) || p.replaces == newest.goalId
            // ⌘Z went out for this page: its undo is answered before anything replaces the page (review H11-6).
            guard continues, newest.accepted, !undoStarted else { return .ignored }
            switch stage {
            case .ended(.finished), .ended(.stopped): break
            default: return .ignored
            }
            groups = [Self.group(p, goalId: goalId)]
            from = view.from
            attach = view.attach
            page += 1
            // The page the undo would restore is gone.
            tasks = []
            undo = .none
            stage = .preview
            return .nextPage
        case .start, .crossWindow:
            // A later segment of this same goal (D2-06): it asks again once the one before it ran.
            guard goalId == newest.goalId, p.segment == newest.segment + 1, newest.accepted, stage == .running else { return .ignored }
            for r in groups[groups.count - 1].rows.indices where groups[groups.count - 1].rows[r].state == .writing {
                groups[groups.count - 1].rows[r].state = .pending
            }
        }
        groups.append(Self.group(p, goalId: goalId))
        for f in view.attach where !attach.contains(f) { attach.append(f) }
        stage = .preview
        return .continued
    }

    private mutating func step(_ r: GoalProgress.Receipt, group g: Int) -> Received {
        guard groups[g].accepted, groups[g].segment == r.segment else { return .ignored }
        groups[g].taskId = r.taskId
        guard let i = groups[g].rows.firstIndex(where: { $0.step == r.step }) else { return .applied }
        switch r.phase {
        case .verified:
            groups[g].rows[i].state = .verified
            if groups[g].rows[i].kind == .write, !tasks.contains(r.taskId) { tasks.append(r.taskId) }
            // A receipt that comes after the ending still wrote: ⌘Z takes it back (review H11-3).
            if groups[g].rows[i].kind == .write, case .ended = stage, undo == .none { undo = .available }
        case .skipped:
            groups[g].rows[i].state = .already
        case .handoff:
            break
        }
        if stage == .running, g == groups.count - 1 { markNextWriting(in: g, after: i) }
        return .applied
    }

    private mutating func stopped(_ s: GoalProgress.Stop, group g: Int) -> Received {
        switch stage {
        case .ended(.stopped), .ended(.finished): return .ignored
        default: break
        }
        for r in groups[g].rows.indices where groups[g].rows[r].state == .writing {
            groups[g].rows[r].state = s.reason == .you ? .pending : .failed
        }
        if let step = s.step, s.reason != .you, let i = groups[g].rows.firstIndex(where: { $0.step == step && $0.state == .pending && !$0.yours }) {
            groups[g].rows[i].state = .failed
        }
        end(.stopped(s))
        return .applied
    }

    /// The row after `after` that the run writes next, marked as being written; any other writing row goes back.
    private mutating func markNextWriting(in g: Int, after: Int) {
        for r in groups[g].rows.indices where groups[g].rows[r].state == .writing { groups[g].rows[r].state = .pending }
        if let next = groups[g].rows.indices.first(where: { $0 > after && !groups[g].rows[$0].yours && groups[g].rows[$0].state == .pending }) {
            groups[g].rows[next].state = .writing
        }
    }

    private mutating func end(_ e: Ending) {
        stage = .ended(e)
        undo = tasks.isEmpty ? .none : .available
    }

    /// The helper refused this task's acceptance (an `error` naming `goalAccept`). It ends the task, since the
    /// helper never had what it shows or has stopped; earlier groups' writes stay undoable.
    public mutating func refused(_ message: String) -> Bool {
        let prefix = "goalAccept refused: "
        guard case .running = stage, current.taskId == nil, message.hasPrefix(prefix) else { return false }
        for r in groups[groups.count - 1].rows.indices where groups[groups.count - 1].rows[r].state == .writing {
            groups[groups.count - 1].rows[r].state = .pending
        }
        end(.notRun(PageTaskCopy.acceptRefused(String(message.dropFirst(prefix.count)))))
        return true
    }

    /// The helper's connection dropped.
    public mutating func lostTouch() {
        switch stage {
        case .running, .stopping: end(.lostTouch)
        case .preview: end(.notRun(PageTaskCopy.helperGone))
        case .ended: undo = .none
        }
    }

    // MARK: - Esc

    public enum EscapeResult: Equatable, Sendable {
        /// Send a stop for the running task.
        case stop(TaskControl)
        /// The panel goes: a preview no one accepted, or an ending.
        case putAway
        /// Esc is still the panel's: a stop is on its way.
        case held
    }

    public mutating func escape() -> EscapeResult {
        switch stage {
        case .stopping: return .held
        case .running:
            stage = .stopping
            return .stop(TaskControl(taskId: runningTask, action: .stop))
        case .preview, .ended: return .putAway
        }
    }

    /// A reveal's preview the user put away: the task ends as the goal before it did, its undo kept.
    public mutating func declineContinuation(_ previous: Ending) {
        guard case .preview = stage, groups.count > 1 else { return }
        groups.removeLast()
        stage = .ended(previous)
        undo = tasks.isEmpty ? .none : .available
    }

    // MARK: - ⌘Z

    /// ⌘Z after the task ended: an undo for every task on this page that wrote, newest first.
    public mutating func undoAll() -> [TaskControl] {
        guard case .ended = stage, undo == .available else { return [] }
        let order = Array(tasks.reversed())
        undo = .undoing(waiting: order, restored: 0)
        return order.map { TaskControl(taskId: $0, action: .undo) }
    }

    /// One task's `undone` progress. True when it was one this task waited on.
    public mutating func undone(taskId: String, restored: Int) -> Bool {
        guard case .undoing(var waiting, let sum) = undo, let i = waiting.firstIndex(of: taskId) else { return false }
        waiting.remove(at: i)
        undo = waiting.isEmpty ? .undone(restored: sum + restored) : .undoing(waiting: waiting, restored: sum + restored)
        if waiting.isEmpty {
            for g in groups.indices {
                for r in groups[g].rows.indices where groups[g].rows[r].state == .verified { groups[g].rows[r].state = .pending }
            }
            tasks = []
        }
        return true
    }

    /// ⌘Z went out for this page: what its writes revealed or left is no longer there to continue.
    var undoStarted: Bool {
        switch undo {
        case .undoing, .undone: return true
        case .none, .available: return false
        }
    }

    /// Whether `taskId` is one this page's ⌘Z undoes or waits on.
    public func owns(_ taskId: String) -> Bool {
        if tasks.contains(taskId) || groups.contains(where: { $0.taskId == taskId }) { return true }
        if case .undoing(let waiting, _) = undo { return waiting.contains(taskId) }
        return false
    }
}
