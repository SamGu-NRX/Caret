// Act grants: which task may act in which window, and until when. The helper grants a task one window
// when an accepted offer starts it, and revokes the grant when the task ends. The reader asks this
// table right before every write, press and raise. Pure logic with no Accessibility calls, so it is
// tested on its own; the clock is passed in.
import Foundation

public final class GrantTable: @unchecked Sendable {
    /// protocol.ts GRANT_MAX_MS: a grant ends at most this long after it arrives. Assumed, not tuned.
    public static let maxMs: Int64 = 120_000

    private struct Entry {
        let grant: ActGrant
        /// The grant's own expiry, or arrival plus maxMs if that is sooner.
        let until: Int64
    }

    private let lock = NSLock()
    private var entries: [String: Entry] = [:]

    public init() {}

    public var count: Int {
        lock.lock(); defer { lock.unlock() }
        return entries.count
    }

    /// Stores a grant, replacing the task's earlier one. Grants that ended over maxMs ago are dropped,
    /// so a helper that never revokes cannot grow the table; until then a check still says "expired".
    public func issue(_ g: ActGrant, receivedAt: Int64) {
        lock.lock(); defer { lock.unlock() }
        entries = entries.filter { $0.value.until > receivedAt - Self.maxMs }
        entries[g.taskId] = Entry(grant: g, until: min(g.expires, receivedAt + Self.maxMs))
    }

    public func revoke(taskId: String) {
        lock.lock(); defer { lock.unlock() }
        entries.removeValue(forKey: taskId)
    }

    /// Every grant came from one helper connection; when it closes they all end.
    public func clear() {
        lock.lock(); defer { lock.unlock() }
        entries.removeAll()
    }

    /// Nil when a live grant for `taskId` covers this process and window at `now`. Otherwise the reason,
    /// worded for a verbResult's detail.
    public func refusal(taskId: String?, pid: Int, windowId: String, now: Int64) -> String? {
        guard let taskId else { return "the command names no task, so no act grant covers it" }
        lock.lock(); defer { lock.unlock() }
        guard let e = entries[taskId] else { return "no act grant for task \(taskId)" }
        if now >= e.until { return "the act grant for task \(taskId) expired \(now - e.until) ms ago" }
        if e.grant.pid != pid { return "the act grant for task \(taskId) covers process \(e.grant.pid), not \(pid)" }
        if e.grant.windowId != windowId { return "the act grant for task \(taskId) covers window \(e.grant.windowId), not \(windowId)" }
        return nil
    }
}
