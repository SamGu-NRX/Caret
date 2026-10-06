// Act grants: which task may act in which window, and until when. The helper grants a task one window
// when an accepted offer starts it, and revokes the grant when the task ends. The reader asks this
// table right before every write, press and raise. Pure logic with no Accessibility calls, so it is
// tested on its own; both clocks are passed in.
import Foundation

public final class GrantTable: @unchecked Sendable {
    /// protocol.ts GRANT_MAX_MS: a grant lasts at most this long. Assumed, not tuned.
    public static let maxMs: Int64 = 120_000

    private struct Entry {
        let grant: ActGrant
        /// Monotonic milliseconds (`uptimeMs`) at which the grant ends: arrival plus its own length,
        /// which ActGrant's decoder keeps within maxMs. A wall clock set back cannot stretch it.
        let deadline: Int64
        /// Set at the first check that finds it over, so a wall clock set back cannot revive it.
        var ended = false
    }

    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    /// Calendar grants (B16), by task: when each ends on the monotonic clock and at its wall-clock expiry.
    private var calendar: [String: (expires: Int64, deadline: Int64, ended: Bool)] = [:]

    public init() {}

    public var count: Int {
        lock.lock(); defer { lock.unlock() }
        return entries.count + calendar.count
    }

    /// Stores a grant that arrived at `uptimeMs`, replacing the task's earlier one. Grants whose deadline
    /// passed over maxMs ago are dropped, so a helper that never revokes cannot grow the table; until then
    /// a check still says the grant expired.
    public func issue(_ g: ActGrant, uptimeMs: Int64) {
        lock.lock(); defer { lock.unlock() }
        entries = entries.filter { $0.value.deadline > uptimeMs - Self.maxMs }
        entries[g.taskId] = Entry(grant: g, deadline: uptimeMs + min(g.expires - g.at, Self.maxMs))
    }

    /// Stores a calendar grant that arrived at `uptimeMs`, as `issue` does an act grant.
    public func issueCalendar(_ g: CalendarGrant, uptimeMs: Int64) {
        lock.lock(); defer { lock.unlock() }
        calendar = calendar.filter { $0.value.deadline > uptimeMs - Self.maxMs }
        calendar[g.taskId] = (g.expires, uptimeMs + min(g.expires - g.at, Self.maxMs), false)
    }

    /// Nil when a live calendar grant covers `taskId`; otherwise the reason. Asked right before each calendar write.
    public func calendarRefusal(taskId: String, now: Int64, uptimeMs: Int64) -> String? {
        lock.lock(); defer { lock.unlock() }
        guard var e = calendar[taskId] else { return "no calendar grant for task \(taskId)" }
        if e.ended || now >= e.expires || uptimeMs >= e.deadline {
            e.ended = true
            calendar[taskId] = e
            return "the calendar grant for task \(taskId) has expired"
        }
        return nil
    }

    /// Ends the task's act grant and its calendar grant.
    public func revoke(taskId: String) {
        lock.lock(); defer { lock.unlock() }
        entries.removeValue(forKey: taskId)
        calendar.removeValue(forKey: taskId)
    }

    /// Ends every act grant for a process: it exited, or the reader dropped its worker (S1 audit #7). Its window
    /// ids already differ from any later process's with the same pid; this ends the grants too, at once.
    /// Returns how many ended.
    @discardableResult
    public func revoke(pid: Int) -> Int {
        lock.lock(); defer { lock.unlock() }
        let before = entries.count
        entries = entries.filter { $0.value.grant.pid != pid }
        return before - entries.count
    }

    /// Ends every act grant for one window of a process: the user's own input landed there (B22 review). Returns how many ended.
    @discardableResult
    public func revoke(pid: Int, windowId: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        let before = entries.count
        entries = entries.filter { $0.value.grant.pid != pid || $0.value.grant.windowId != windowId }
        return before - entries.count
    }

    /// Every grant came from one helper connection; when it closes they all end.
    public func clear() {
        lock.lock(); defer { lock.unlock() }
        entries.removeAll()
        calendar.removeAll()
    }

    /// Nil when a live grant for `taskId` covers this process and window. Otherwise the reason, worded for
    /// a verbResult's detail. A grant is over at its wall-clock `expires` (`now`, ms since the epoch) or at
    /// its monotonic deadline (`uptimeMs`), whichever comes first.
    public func refusal(taskId: String?, pid: Int, windowId: String, now: Int64, uptimeMs: Int64) -> String? {
        guard let taskId else { return "the command names no task, so no act grant covers it" }
        lock.lock(); defer { lock.unlock() }
        guard var e = entries[taskId] else { return "no act grant for task \(taskId)" }
        if e.ended || now >= e.grant.expires || uptimeMs >= e.deadline {
            e.ended = true
            entries[taskId] = e
            return "the act grant for task \(taskId) has expired"
        }
        if e.grant.pid != pid { return "the act grant for task \(taskId) covers process \(e.grant.pid), not \(pid)" }
        if e.grant.windowId != windowId { return "the act grant for task \(taskId) covers window \(e.grant.windowId), not \(windowId)" }
        return nil
    }
}
