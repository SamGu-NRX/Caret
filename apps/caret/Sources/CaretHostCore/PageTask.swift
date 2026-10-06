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
/// - H14: Tab sends a file only when the user confirmed it in this preview: one they chose in the attach row's open
///   panel, or the saved file the row offered, confirmed with ⌘2 or a click. Tab alone never confirms a file. One
///   file per Tab, as the helper takes one (`GoalAccept.confirmedFile`).
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
        /// H14: an attach step's row; nil for every other kind.
        public var attach: Attach?
        /// L1: where the value came from, and the source's lines around it (only from a helper told `sourceExcerpts`).
        public var source: RowSource?
        public var excerpt: SourceExcerpt?

        /// H14: what an attach row offers and what the user confirmed in it.
        public struct Attach: Equatable, Sendable {
            /// The file control's name: "Resume".
            public var label: String
            /// The control's accept tokens; empty when it takes any file.
            public var accept: [String]
            /// What the helper offered: a chooser, or a file the user kept for this question.
            public var offered: GoalProgress.Step.File
            /// The file the user confirmed in this preview: one they chose, or the saved one after ⌘2 or a click.
            public var confirmed: AttachFile?
            /// Why the last file confirmed here was not taken, or that Tab needs a file first.
            public var problem: String?

            public init(label: String, accept: [String], offered: GoalProgress.Step.File, confirmed: AttachFile? = nil, problem: String? = nil) {
                self.label = label
                self.accept = accept
                self.offered = offered
                self.confirmed = confirmed
                self.problem = problem
            }

            /// The saved file the row offers, as the row shows it.
            public var savedFile: AttachFile? {
                guard case .saved(_, let path, let name, let edited) = offered else { return nil }
                return AttachFile(path: path, name: name, edited: edited)
            }
        }

        /// The user's own step: a hand-off. Caret presses nothing on a page and never marks it done.
        public var yours: Bool { kind == .handoff || kind == .press }

        /// The step is part of the run Tab starts: every write, and an attach row only with a file confirmed. An attach
        /// row with none is left to the user (runs.ts drops it from the run).
        public var runs: Bool { !yours && (kind != .attach || attach?.confirmed != nil) }

        public init(step: Int, kind: GoalProgress.Step.Kind, says: String, label: String? = nil, value: String? = nil, picked: Bool = false, state: State = .pending,
                    attach: Attach? = nil, source: RowSource? = nil, excerpt: SourceExcerpt? = nil) {
            self.step = step
            self.kind = kind
            self.says = says
            self.label = label
            self.value = value
            self.picked = picked
            self.state = state
            self.attach = attach
            self.source = source
            self.excerpt = excerpt
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
        /// L1: the fields among those it leaves with a reason the panel draws (a hatch or a dotted blank).
        public var left: [LeftField] = []
        /// Tab sent this group's acceptance. Never set back.
        public var accepted = false
        /// The executor task it runs in, from its first receipt.
        public var taskId: String?
        /// The file the last Tab sent with this group, so a refusal of that file can give the preview back.
        public var sentFile: GoalAccept.ConfirmedFile?

        /// Writes Caret makes in this group.
        public var writes: Int { rows.filter { $0.kind == .write }.count }
        /// The group's attach rows, in order.
        public var attachRows: [Row] { rows.filter { $0.kind == .attach } }
        /// The one file confirmed in this group, if any.
        public var confirmedFile: GoalAccept.ConfirmedFile? {
            rows.first { $0.attach?.confirmed != nil }.flatMap { r in r.attach?.confirmed.map { GoalAccept.ConfirmedFile(step: r.step, path: $0.path) } }
        }
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
        let files = Dictionary((p.page?.files ?? []).map { ($0.step, $0) }, uniquingKeysWith: { a, _ in a })
        let rows = p.steps.map { s -> Row in
            let r = s.kind == .write ? byStep[s.index] : nil
            var attach: Row.Attach?
            if s.kind == .attach, let offered = s.file {
                // A helper from before H14 names no file row: the step's own words stand for the control's name.
                let row = files[s.index]
                attach = Row.Attach(label: row?.label ?? Self.attachLabel(s, offered), accept: row?.accept ?? [], offered: offered)
            }
            return Row(step: s.index, kind: s.kind, says: s.says, label: r?.label, value: r?.value, picked: r?.picked ?? false, attach: attach, source: r?.source, excerpt: r?.excerpt)
        }
        var g = Group(goalId: goalId, segment: p.segment, reason: p.reason, digest: p.digest, expires: p.expires, rows: rows, withheld: p.warnings)
        g.left = p.page?.left ?? []
        return g
    }

    /// The control's name in an attach step's words ("Resume: a file you choose", "Resume: Resume.pdf"; lower.ts),
    /// for a page view with no file rows.
    static func attachLabel(_ s: GoalProgress.Step, _ offered: GoalProgress.Step.File) -> String {
        let tail: String
        switch offered {
        case .choose: tail = ": a file you choose"
        case .saved(_, _, let name, _): tail = ": \(name)"
        }
        return s.says.hasSuffix(tail) && s.says.count > tail.count ? String(s.says.dropLast(tail.count)) : s.says
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
        // A preview that only attaches runs nothing without a file (runs.ts): Tab waits for one, and says so.
        let file = groups[i].confirmedFile
        if file == nil, groups[i].writes == 0, let first = groups[i].rows.firstIndex(where: { $0.kind == .attach }) {
            groups[i].rows[first].attach?.problem = PageTaskCopy.chooseFirst
            return .held("no file was chosen")
        }
        groups[i].accepted = true
        groups[i].sentFile = file
        stage = .running
        markNextWriting(in: i, after: -1)
        return .accept(GoalAccept(goalId: groups[i].goalId, segment: groups[i].segment, digest: groups[i].digest, at: nowMs, confirmedFile: file))
    }

    // MARK: - Attach rows (H14)

    /// The user's file for attach row `step` of the waiting group: one they chose in the open panel, or the saved one
    /// they confirmed. Any other row's file in the group is let go: one file goes with one Tab. False when the group
    /// is not waiting or has no such row.
    @discardableResult
    public mutating func confirm(step: Int, file: AttachFile) -> Bool {
        guard case .preview = stage, !current.accepted, GoalFiles.isAbsolutePath(file.path) else { return false }
        let i = groups.count - 1
        guard let r = groups[i].rows.firstIndex(where: { $0.step == step && $0.kind == .attach && $0.attach != nil }) else { return false }
        for o in groups[i].rows.indices where groups[i].rows[o].kind == .attach {
            groups[i].rows[o].attach?.confirmed = nil
            groups[i].rows[o].attach?.problem = nil
        }
        groups[i].rows[r].attach?.confirmed = file
        return true
    }

    /// ⌘2 or a click on a row offering a saved file: the user's yes to that file for this Tab.
    @discardableResult
    public mutating func confirmSaved(step: Int) -> Bool {
        guard let file = current.rows.first(where: { $0.step == step && $0.kind == .attach })?.attach?.savedFile else { return false }
        return confirm(step: step, file: file)
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
        case .start, .crossWindow, .moreFields:
            // A later segment of this same goal (D2-06), or the next part of a long form (C2): it asks again once the
            // one before it ran.
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
        if let step = s.step, s.reason != .you, let i = groups[g].rows.firstIndex(where: { $0.step == step && $0.state == .pending && $0.runs }) {
            groups[g].rows[i].state = .failed
        }
        end(.stopped(s))
        return .applied
    }

    /// The row after `after` that the run writes next, marked as being written; any other writing row goes back.
    private mutating func markNextWriting(in g: Int, after: Int) {
        for r in groups[g].rows.indices where groups[g].rows[r].state == .writing { groups[g].rows[r].state = .pending }
        if let next = groups[g].rows.indices.first(where: { $0 > after && groups[g].rows[$0].runs && groups[g].rows[$0].state == .pending }) {
            groups[g].rows[next].state = .writing
        }
    }

    private mutating func end(_ e: Ending) {
        stage = .ended(e)
        undo = tasks.isEmpty ? .none : .available
    }

    public enum Refusal: Equatable, Sendable {
        /// The task ended: nothing ran.
        case ended
        /// H14: the helper would not take the file the user confirmed and keeps the preview waiting (runs.ts): the
        /// row says why and waits for another file and another Tab.
        case fileRefused
    }

    /// The helper refused this task's acceptance (an `error` naming `goalAccept`). It ends the task, since the
    /// helper never had what it shows or has stopped; earlier groups' writes stay undoable. A refusal of the file
    /// alone gives the preview back instead.
    public mutating func refused(_ message: String) -> Refusal? {
        let prefix = "goalAccept refused: "
        guard case .running = stage, current.taskId == nil, message.hasPrefix(prefix) else { return nil }
        let i = groups.count - 1
        for r in groups[i].rows.indices where groups[i].rows[r].state == .writing { groups[i].rows[r].state = .pending }
        let why = String(message.dropFirst(prefix.count))
        if let line = PageTaskCopy.fileRefusal(why, sent: groups[i].sentFile != nil) {
            groups[i].accepted = false
            stage = .preview
            let step = groups[i].sentFile?.step
            groups[i].sentFile = nil
            if let r = groups[i].rows.firstIndex(where: { $0.kind == .attach && ($0.step == step || step == nil) }) {
                groups[i].rows[r].attach?.confirmed = nil
                groups[i].rows[r].attach?.problem = line
            }
            return .fileRefused
        }
        end(.notRun(PageTaskCopy.acceptRefused(why)))
        return .ended
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
