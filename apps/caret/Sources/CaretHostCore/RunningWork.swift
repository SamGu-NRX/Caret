import CaretScreenCore

/// The accepted offers the helper is running for this copy of Caret, by offer id (a run's `TaskProgress.taskId`): each
/// from the moment its `offerAccept` is written until the helper reports an end. The hand-off to the login item stops
/// this copy's helper, and the next helper restores an interrupted task as stopped, so a fill would end half done; the
/// hand-off waits while anything here runs.
///
/// Counted from the accept, not from the first progress, because Done can be pressed between the two. Paused counts as
/// running: the helper keeps a paused run, and a new helper would restore it as stopped. A helper that never reports an
/// end keeps the hand-off waiting for the rest of the session; Caret keeps working in this process, and the next launch
/// registers the login item (`LoginItemPlan`).
public struct RunningWork: Equatable, Sendable {
    public private(set) var offers: Set<String> = []

    public init() {}

    public var isEmpty: Bool { offers.isEmpty }

    /// An `offerAccept` (or a `fillAll`, by its task id) for `offerId` is about to be written to the helper. Recorded
    /// before the write: the helper's answer is read on another thread and can arrive before the writer returns.
    public mutating func accepted(_ offerId: String) {
        offers.insert(offerId)
    }

    /// The write recorded by `accepted` failed: nothing reached the helper.
    public mutating func unsent(_ offerId: String) {
        offers.remove(offerId)
    }

    public mutating func progress(_ progress: TaskProgress) {
        switch progress.phase {
        case .started, .skipped, .acting, .verified, .paused: offers.insert(progress.taskId)
        case .done, .stopped, .handoff, .undone: offers.remove(progress.taskId)
        }
    }

    /// The connection to the helper dropped: it revokes every task this session accepted when it closes.
    public mutating func helperGone() {
        offers.removeAll()
    }
}
