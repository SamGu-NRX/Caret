import CaretScreenCore

/// The accepted work the helper is running for this copy of Caret, by task id: an `offerAccept`'s offer id, a
/// `fillAll`'s task id, a `goalAccept`'s segment task. The hand-off to the login item stops this copy's helper, and the
/// next helper restores an interrupted task as stopped, so a fill would end half done; the hand-off waits while
/// anything here runs.
///
/// An accept counts from the moment it is written, because Done can be pressed before the helper's first progress. An
/// accept the helper never starts gets no progress at all (a refused `goalAccept` comes back as an error line), so an
/// accept with no progress counts for `answerWindow` only. Once progress arrives, the run counts until the helper
/// reports its end. Paused counts as running: the helper keeps a paused run, and a new helper would restore it as
/// stopped. A run the helper never ends keeps the hand-off waiting for the rest of the session; Caret keeps working in
/// this process, and the next launch registers the login item (`LoginItemPlan`).
public struct RunningWork: Equatable, Sendable {
    /// How long an accept with no progress yet counts as running, in seconds. No measurement behind it: the helper
    /// answers an accept with `started` or a refusal at once in every recorded run, and 30 s leaves a slow helper room.
    public static let answerWindow: Double = 30

    /// Runs the helper has reported progress for and not yet ended.
    public private(set) var running: Set<String> = []
    /// Accepts written with no progress yet, with the time each was written (seconds, any monotonic clock).
    public private(set) var unanswered: [String: Double] = [:]

    public init() {}

    /// Whether anything runs at `now` (the same clock as `accepted`).
    public func isEmpty(at now: Double) -> Bool {
        running.isEmpty && unanswered.values.allSatisfy { now - $0 >= Self.answerWindow }
    }

    /// An accept for `task` is about to be written to the helper. Recorded before the write: the helper's answer is
    /// read on another thread and can arrive before the writer returns.
    public mutating func accepted(_ task: String, at now: Double) {
        if !running.contains(task) { unanswered[task] = now }
    }

    /// The write recorded by `accepted` failed: nothing reached the helper.
    public mutating func unsent(_ task: String) {
        unanswered.removeValue(forKey: task)
    }

    public mutating func progress(_ progress: TaskProgress) {
        unanswered.removeValue(forKey: progress.taskId)
        switch progress.phase {
        case .started, .skipped, .acting, .verified, .paused: running.insert(progress.taskId)
        case .done, .stopped, .handoff, .undone: running.remove(progress.taskId)
        }
    }

    /// The connection to the helper dropped: it revokes every task this session accepted when it closes.
    public mutating func helperGone() {
        running.removeAll()
        unanswered.removeAll()
    }
}
