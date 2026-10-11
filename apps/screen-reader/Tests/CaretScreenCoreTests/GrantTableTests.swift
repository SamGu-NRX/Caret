import Foundation
import Testing
@testable import CaretScreenCore

/// The reader's act grants on their own, with both clocks passed in.
@Suite struct GrantTableTests {
    let t0: Int64 = 1_790_000_000_000
    /// Uptime at the grant's arrival; unrelated to the wall clock on purpose.
    let u0: Int64 = 5_000
    func grant(_ task: String = "task-1", pid: Int = 500, window: String = "500-1", for ms: Int64 = 30_000) -> ActGrant {
        ActGrant(taskId: task, pid: pid, windowId: window, at: t0, expires: t0 + ms)
    }
    func check(_ g: GrantTable, _ task: String? = "task-1", pid: Int = 500, window: String = "500-1", now: Int64, up: Int64) -> String? {
        g.refusal(taskId: task, pid: pid, windowId: window, now: now, uptimeMs: up)
    }

    @Test func allowsOnlyTheGrantedTaskProcessAndWindow() {
        let g = GrantTable()
        g.issue(grant(), uptimeMs: u0)
        #expect(check(g, now: t0 + 1, up: u0 + 1) == nil)
        #expect(check(g, pid: 501, now: t0 + 1, up: u0 + 1) == "the act grant for task task-1 covers process 500, not 501")
        #expect(check(g, window: "500-2", now: t0 + 1, up: u0 + 1) == "the act grant for task task-1 covers window 500-1, not 500-2")
        #expect(check(g, "task-2", now: t0 + 1, up: u0 + 1) == "no act grant for task task-2")
        #expect(check(g, nil, now: t0 + 1, up: u0 + 1) == "the command names no task, so no act grant covers it")
    }

    @Test func endsAtItsWallClockExpiry() {
        let g = GrantTable()
        g.issue(grant(for: 1_000), uptimeMs: u0)
        #expect(check(g, now: t0 + 999, up: u0 + 1) == nil)
        #expect(check(g, now: t0 + 1_000, up: u0 + 1) == "the act grant for task task-1 has expired")
    }

    @Test func endsItsLengthAfterArrivalOnTheMonotonicClockWhateverTheWallClockSays() {
        let g = GrantTable()
        g.issue(grant(for: GrantTable.maxMs), uptimeMs: u0)
        // The wall clock was set back an hour: the grant still ends 120 s after it arrived.
        let back = t0 - 3_600_000
        #expect(check(g, now: back, up: u0 + GrantTable.maxMs - 1) == nil)
        #expect(check(g, now: back, up: u0 + GrantTable.maxMs) == "the act grant for task task-1 has expired")
    }

    @Test func staysEndedWhenAClockGoesBack() {
        let g = GrantTable()
        g.issue(grant(for: 1_000), uptimeMs: u0)
        #expect(check(g, now: t0 + 1_000, up: u0 + 1) != nil)
        #expect(check(g, now: t0 + 1, up: u0 + 1) == "the act grant for task task-1 has expired")
    }

    @Test func revokeAndClearEndGrants() {
        let g = GrantTable()
        g.issue(grant("a"), uptimeMs: u0)
        g.issue(grant("b", window: "500-2"), uptimeMs: u0)
        g.revoke(taskId: "a")
        #expect(check(g, "a", now: t0 + 1, up: u0 + 1) == "no act grant for task a")
        #expect(check(g, "b", window: "500-2", now: t0 + 1, up: u0 + 1) == nil)
        g.clear()
        #expect(g.count == 0)
        #expect(check(g, "b", window: "500-2", now: t0 + 1, up: u0 + 1) == "no act grant for task b")
    }

    @Test func aLaterGrantForTheSameTaskReplacesTheEarlier() {
        let g = GrantTable()
        g.issue(grant(window: "500-1"), uptimeMs: u0)
        g.issue(grant(window: "500-3"), uptimeMs: u0)
        #expect(g.count == 1)
        #expect(check(g, window: "500-1", now: t0 + 1, up: u0 + 1) != nil)
        #expect(check(g, window: "500-3", now: t0 + 1, up: u0 + 1) == nil)
    }

    @Test func dropsGrantsLongEndedWhenAnotherArrives() {
        let g = GrantTable()
        g.issue(grant("old", for: 1_000), uptimeMs: u0)
        g.issue(grant("new"), uptimeMs: u0 + 1_000 + GrantTable.maxMs)
        #expect(g.count == 1)
    }

    @Test func refusesGrantsTheHelperCouldNotHaveSent() {
        let base = #"{"type":"actGrant","v":1,"taskId":"t","pid":1,"windowId":"1-1","at":AT,"expires":EX}"#
        let line = { (at: String, ex: String) in Data(base.replacingOccurrences(of: "AT", with: at).replacingOccurrences(of: "EX", with: ex).utf8) }
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: line("-9223372036854775808", "0")) }
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: line("-5", "10")) }
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: line("0", "120001")) }
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: Data(#"{"type":"actRevoke","v":1,"taskId":"t","at":-1}"#.utf8)) }
        guard case .actGrant(let ok) = try? JSONDecoder().decode(Message.self, from: line("0", "120000")) else { Issue.record("a grant of exactly maxMs is refused"); return }
        #expect(ok.expires == GrantTable.maxMs)
    }

    @Test func calendarGrantsCoverOnlyTheirTaskEndWithTheRevokeAndExpireOnTheMonotonicClock() {
        let t = GrantTable()
        #expect(t.calendarRefusal(taskId: "t1", now: 1_000, uptimeMs: 10) == "no calendar grant for task t1")
        t.issueCalendar(CalendarGrant(taskId: "t1", at: 1_000, expires: 61_000), uptimeMs: 10)
        #expect(t.calendarRefusal(taskId: "t1", now: 2_000, uptimeMs: 20) == nil)
        #expect(t.calendarRefusal(taskId: "t2", now: 2_000, uptimeMs: 20) == "no calendar grant for task t2")
        // An act grant for the same task does not cover calendar writes, nor the other way round.
        #expect(t.refusal(taskId: "t1", pid: 1, windowId: "1-1", now: 2_000, uptimeMs: 20) == "no act grant for task t1")
        #expect(t.calendarRefusal(taskId: "t1", now: 2_000, uptimeMs: 60_011) == "the calendar grant for task t1 has expired")
        // Ended stays ended, even when the clock is read lower again.
        #expect(t.calendarRefusal(taskId: "t1", now: 2_000, uptimeMs: 30) == "the calendar grant for task t1 has expired")
        t.issueCalendar(CalendarGrant(taskId: "t3", at: 1_000, expires: 61_000), uptimeMs: 100)
        t.revoke(taskId: "t3")
        #expect(t.calendarRefusal(taskId: "t3", now: 2_000, uptimeMs: 110) == "no calendar grant for task t3")
        t.issueCalendar(CalendarGrant(taskId: "t4", at: 1_000, expires: 61_000), uptimeMs: 100)
        t.clear()
        #expect(t.calendarRefusal(taskId: "t4", now: 2_000, uptimeMs: 110) == "no calendar grant for task t4")
    }
}
