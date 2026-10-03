import Testing
@testable import CaretScreenCore

/// The reader's act grants on their own, with the clock passed in.
@Suite struct GrantTableTests {
    let t0: Int64 = 1_790_000_000_000
    func grant(_ task: String = "task-1", pid: Int = 500, window: String = "500-1", for ms: Int64 = 30_000) -> ActGrant {
        ActGrant(taskId: task, pid: pid, windowId: window, at: t0, expires: t0 + ms)
    }

    @Test func allowsOnlyTheGrantedTaskProcessAndWindow() {
        let g = GrantTable()
        g.issue(grant(), receivedAt: t0)
        #expect(g.refusal(taskId: "task-1", pid: 500, windowId: "500-1", now: t0 + 1) == nil)
        #expect(g.refusal(taskId: "task-1", pid: 501, windowId: "500-1", now: t0 + 1) == "the act grant for task task-1 covers process 500, not 501")
        #expect(g.refusal(taskId: "task-1", pid: 500, windowId: "500-2", now: t0 + 1) == "the act grant for task task-1 covers window 500-1, not 500-2")
        #expect(g.refusal(taskId: "task-2", pid: 500, windowId: "500-1", now: t0 + 1) == "no act grant for task task-2")
        #expect(g.refusal(taskId: nil, pid: 500, windowId: "500-1", now: t0 + 1) == "the command names no task, so no act grant covers it")
    }

    @Test func endsAtItsExpiry() {
        let g = GrantTable()
        g.issue(grant(for: 1_000), receivedAt: t0)
        #expect(g.refusal(taskId: "task-1", pid: 500, windowId: "500-1", now: t0 + 999) == nil)
        #expect(g.refusal(taskId: "task-1", pid: 500, windowId: "500-1", now: t0 + 1_000) == "the act grant for task task-1 expired 0 ms ago")
    }

    @Test func endsNoLaterThanTheCapAfterItArrives() {
        let g = GrantTable()
        // A grant that arrives late ends at its own expiry, which is sooner than arrival plus the cap.
        g.issue(grant(for: GrantTable.maxMs), receivedAt: t0 + 50_000)
        #expect(g.refusal(taskId: "task-1", pid: 500, windowId: "500-1", now: t0 + GrantTable.maxMs - 1) == nil)
        #expect(g.refusal(taskId: "task-1", pid: 500, windowId: "500-1", now: t0 + GrantTable.maxMs) != nil)
        // One whose expiry is further off than the cap allows from its arrival (it arrived before `at`,
        // clock skew) ends at arrival plus the cap.
        g.issue(grant(for: GrantTable.maxMs), receivedAt: t0 - 10_000)
        #expect(g.refusal(taskId: "task-1", pid: 500, windowId: "500-1", now: t0 + GrantTable.maxMs - 10_000) != nil)
    }

    @Test func revokeAndClearEndGrants() {
        let g = GrantTable()
        g.issue(grant("a"), receivedAt: t0)
        g.issue(grant("b", window: "500-2"), receivedAt: t0)
        g.revoke(taskId: "a")
        #expect(g.refusal(taskId: "a", pid: 500, windowId: "500-1", now: t0 + 1) == "no act grant for task a")
        #expect(g.refusal(taskId: "b", pid: 500, windowId: "500-2", now: t0 + 1) == nil)
        g.clear()
        #expect(g.count == 0)
        #expect(g.refusal(taskId: "b", pid: 500, windowId: "500-2", now: t0 + 1) == "no act grant for task b")
    }

    @Test func aLaterGrantForTheSameTaskReplacesTheEarlier() {
        let g = GrantTable()
        g.issue(grant(window: "500-1"), receivedAt: t0)
        g.issue(grant(window: "500-3"), receivedAt: t0)
        #expect(g.count == 1)
        #expect(g.refusal(taskId: "task-1", pid: 500, windowId: "500-1", now: t0 + 1) != nil)
        #expect(g.refusal(taskId: "task-1", pid: 500, windowId: "500-3", now: t0 + 1) == nil)
    }

    @Test func dropsGrantsLongEndedWhenAnotherArrives() {
        let g = GrantTable()
        g.issue(grant("old", for: 1_000), receivedAt: t0)
        g.issue(grant("new"), receivedAt: t0 + 1_000 + GrantTable.maxMs)
        #expect(g.count == 1)
    }
}
