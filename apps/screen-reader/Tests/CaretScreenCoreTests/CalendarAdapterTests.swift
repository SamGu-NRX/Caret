import Foundation
import Testing
@testable import CaretScreenCore

/// An in-memory calendar store with one synced calendar the adapter must never touch, and a log of every
/// call, so a test can show that a refusal reached nothing.
private final class FakeBackend: CalendarBackend, @unchecked Sendable {
    var access = true
    var local: String? = "local-1"
    var calls: [String] = []
    var calendars: [String: (title: String, source: String)] = ["icloud-cal": ("Caret Test", "icloud")]
    var events: [String: BackendEvent] = [:]
    /// Makes every read throw, as EventKit's store does once access goes between the adapter's check and the read.
    var readFails = false
    /// Called inside each read, as a revoke landing while the adapter looks something up.
    var duringRead: (() -> Void)?
    private var n = 0
    struct ReadError: Error, CustomStringConvertible { var description: String { "no full Calendar access" } }

    init() {
        events["synced-ev"] = BackendEvent(id: "synced-ev", calendarID: "icloud-cal", title: "Coffee with Dana", start: t("2026-10-08T15:00:00-05:00"), end: t("2026-10-08T15:30:00-05:00"))
    }

    func hasFullAccess() -> Bool { calls.append("access"); return access }
    func localSourceID() -> String? { calls.append("source"); return local }
    func createCalendar(title: String, sourceID: String) throws -> String {
        calls.append("create \(title) on \(sourceID)"); n += 1
        calendars["cal-\(n)"] = (title, sourceID)
        return "cal-\(n)"
    }
    func deleteCalendar(id: String) throws {
        calls.append("delete \(id)")
        calendars.removeValue(forKey: id)
        events = events.filter { $0.value.calendarID != id }
    }
    func events(calendarID: String, from: Date, to: Date) throws -> [BackendEvent] {
        calls.append("events \(calendarID)")
        duringRead?()
        if readFails { throw ReadError() }
        return events.values.filter { $0.calendarID == calendarID && $0.start < to && $0.end > from }
    }
    func saveEvent(calendarID: String, title: String, start: Date, end: Date) throws -> BackendEvent {
        calls.append("save \(calendarID)"); n += 1
        events["ev-\(n)"] = BackendEvent(id: "ev-\(n)", calendarID: calendarID, title: title, start: start, end: end)
        return events["ev-\(n)"]!
    }
    func event(id: String) throws -> BackendEvent? {
        calls.append("event \(id)")
        duringRead?()
        if readFails { throw ReadError() }
        return events[id]
    }
    func removeEvent(id: String, ifStill saved: BackendEvent) throws {
        calls.append("remove \(id)")
        // As EventKitBackend: the fresh read and the removal together, so an edit made after the adapter's checks stops it.
        duringRemove?()
        if let now = events[id], !saved.unchanged(in: now) { throw CalendarEventChanged() }
        events.removeValue(forKey: id)
    }
    /// Called inside a removal before its fresh read, as the user's edit landing during an undo.
    var duringRemove: (() -> Void)?
    func defaultCalendarID() -> String? { calls.append("default"); return nil }
    func isWritable(calendarID: String) -> Bool { calls.append("writable \(calendarID)"); return calendars[calendarID] != nil }
}

private func t(_ s: String) -> Date { CalendarTime.parse(s)! }
private let chicago = TimeZone(identifier: "America/Chicago")!
private let start = "2026-10-08T15:00:00-05:00", end = "2026-10-08T15:30:00-05:00"

@Suite struct CalendarAdapterTests {
    /// Greptile review on #13: undo never deletes an event the user changed after Caret added it, whatever they changed,
    /// and the check is the backend's fresh read inside the removal, so an edit during the undo counts too.
    @Test func undoLeavesAnEventTheUserChanged() throws {
        let edits: [(String, (inout EventState) -> Void)] = [
            ("notes", { $0.notes = "Bring the deposit" }),
            ("location", { $0.location = "Cafe Lumen" }),
            ("url", { $0.url = "https://meet.example.com/abc" }),
            ("alarms", { $0.alarms = ["offset -900.0"] }),
            ("attendees", { $0.attendees = ["mailto:dana@example.com"] }),
            ("all day", { $0.allDay = true }),
        ]
        for (what, edit) in edits {
            for during in [false, true] {
                let b = FakeBackend()
                let a = CalendarAdapter(backend: b, zone: chicago)
                guard case let .ok(added?) = a.perform(.calendarAdd(calendar: "Caret Test", title: "Coffee with Dana", start: start, end: end, taskId: "t1")) else { Issue.record("add failed"); return }
                let change = { var e = b.events[added.id]!; edit(&e.state); b.events[added.id] = e }
                if during { b.duringRemove = change } else { change() }
                #expect(a.perform(.calendarRemove(id: added.id, taskId: "t1")) == .refused(.changed, CalendarAdapter.changedByYou), "\(what), during: \(during)")
                #expect(b.events[added.id] != nil, "\(what) is left")
            }
        }
    }

    @Test func undoStillRemovesAnEventOnlyTheStoreTouched() {
        // A modification date the saved copy did not have is the store's, not the user's edit.
        let b = FakeBackend()
        let a = CalendarAdapter(backend: b, zone: chicago)
        guard case let .ok(added?) = a.perform(.calendarAdd(calendar: "Caret Test", title: "Coffee with Dana", start: start, end: end, taskId: "t1")) else { Issue.record("add failed"); return }
        b.events[added.id]!.state.lastModified = Date(timeIntervalSince1970: 1_791_000_000)
        #expect(a.perform(.calendarRemove(id: added.id, taskId: "t1")) == .ok(nil))
        #expect(b.events[added.id] == nil)
    }

    @Test func aChangedModificationDateLeavesTheEvent() {
        var saved = BackendEvent(id: "e", calendarID: "c", title: "T", start: t(start), end: t(end), state: EventState(lastModified: Date(timeIntervalSince1970: 1)))
        var now = saved
        now.state.lastModified = Date(timeIntervalSince1970: 2)
        #expect(!saved.unchanged(in: now))
        saved.state.lastModified = nil
        #expect(saved.unchanged(in: now))
    }

    @Test func addsToACalendarItCreatesOnTheLocalSourceFindsItAndUndoesIt() {
        let b = FakeBackend()
        let a = CalendarAdapter(backend: b, zone: chicago)
        #expect(a.perform(.calendarFind(calendar: "Caret Test", title: "Coffee with Dana", start: start, end: end)) == .ok(nil))
        guard case let .ok(added?) = a.perform(.calendarAdd(calendar: "Caret Test", title: "Coffee with Dana", start: start, end: end, taskId: "t1")) else { Issue.record("add failed"); return }
        #expect(added == CalendarEventRecord(id: added.id, calendar: "Caret Test", title: "Coffee with Dana", start: start, end: end))
        #expect(b.calendars[b.events[added.id]!.calendarID]?.source == "local-1")
        #expect(a.perform(.calendarFind(calendar: "Caret Test", title: "Coffee with Dana", start: start, end: end)) == .ok(added))
        #expect(a.perform(.calendarGet(id: added.id)) == .ok(added))
        #expect(a.perform(.calendarRemove(id: added.id, taskId: "t1")) == .ok(nil))
        #expect(a.perform(.calendarGet(id: added.id)) == .ok(nil))
        // The same event again is refused, so a second task never takes the first one's event as its own.
        guard case let .ok(again?) = a.perform(.calendarAdd(calendar: "Caret Test", title: "Coffee with Dana", start: start, end: end, taskId: "t2")) else { Issue.record("re-add failed"); return }
        #expect(a.perform(.calendarAdd(calendar: "Caret Test", title: "Coffee with Dana", start: start, end: end, taskId: "t3")) == .refused(.changed, "an identical event is already in the calendar; nothing was added"))
        #expect(b.events.values.filter { $0.title == "Coffee with Dana" && $0.calendarID != "icloud-cal" }.count == 1)
        // An id it added is trusted only while the event is still in its calendar.
        b.events[again.id]?.calendarID = "icloud-cal"
        #expect(a.perform(.calendarGet(id: again.id)) == .ok(nil))
        #expect(a.perform(.calendarRemove(id: again.id, taskId: "t2")) == .refused(.notAllowed, "the event is not one the reader added, in a calendar it created"))
        #expect(b.events[again.id] != nil)
        b.events.removeValue(forKey: again.id)
        // A second event goes into the same calendar, which was created once.
        _ = a.perform(.calendarAdd(calendar: "Caret Test", title: "Lunch", start: start, end: end, taskId: "t1"))
        #expect(b.calls.filter { $0.hasPrefix("create") } == ["create Caret Test on local-1"])
        #expect(a.ownedCalendars == ["Caret Test"])
    }

    @Test func neverSeesWritesOrRemovesInACalendarItDidNotCreate() {
        let b = FakeBackend()
        let a = CalendarAdapter(backend: b, zone: chicago)
        // The synced calendar has the same title and an identical event; the adapter finds neither.
        #expect(a.perform(.calendarFind(calendar: "Caret Test", title: "Coffee with Dana", start: start, end: end)) == .ok(nil))
        #expect(a.perform(.calendarGet(id: "synced-ev")) == .ok(nil))
        #expect(a.perform(.calendarRemove(id: "synced-ev", taskId: "t1")) == .refused(.notAllowed, "the event is not one the reader added, in a calendar it created"))
        #expect(a.perform(.calendarDispose(calendar: "Caret Test", taskId: "t1")) == .ok(nil))
        #expect(b.events["synced-ev"] != nil && b.calendars["icloud-cal"] != nil)
        // The foreign event's id is never even looked up: the adapter knows only ids it added.
        #expect(!b.calls.contains { $0.contains("icloud-cal") || $0.contains("synced-ev") || $0.hasPrefix("delete") })
    }

    @Test func withoutCalendarAccessEveryVerbIsBlockedTccAndNothingIsTouched() {
        let b = FakeBackend()
        b.access = false
        let a = CalendarAdapter(backend: b)
        for v in [ReaderVerb.calendarFind(calendar: "Caret Test", title: "x", start: start, end: end), .calendarAdd(calendar: "Caret Test", title: "x", start: start, end: end, taskId: "t1"),
                  .calendarGet(id: "synced-ev"), .calendarRemove(id: "synced-ev", taskId: "t1"), .calendarDispose(calendar: "Caret Test", taskId: "t1")] {
            #expect(a.perform(v) == .blocked(.tcc))
        }
        #expect(Set(b.calls) == ["access"])
    }

    @Test func withoutALocalSourceAnAddIsBlockedNoLocalSourceAndNothingIsCreated() {
        let b = FakeBackend()
        b.local = nil
        let a = CalendarAdapter(backend: b)
        #expect(a.perform(.calendarAdd(calendar: "Caret Test", title: "x", start: start, end: end, taskId: "t1")) == .blocked(.noLocalSource))
        #expect(!b.calls.contains { $0.hasPrefix("create") || $0.hasPrefix("save") })
        #expect(a.ownedCalendars.isEmpty)
    }

    @Test func disposeDeletesOnlyItsOwnCalendarsWithTheirEvents() {
        let b = FakeBackend()
        let a = CalendarAdapter(backend: b)
        _ = a.perform(.calendarAdd(calendar: "Caret Test", title: "x", start: start, end: end, taskId: "t1"))
        _ = a.perform(.calendarAdd(calendar: "Caret Test 2", title: "y", start: start, end: end, taskId: "t1"))
        #expect(a.perform(.calendarDispose(calendar: "Caret Test", taskId: "t1")) == .ok(nil))
        #expect(a.ownedCalendars == ["Caret Test 2"])
        #expect(a.disposeAll().isEmpty)
        #expect(a.ownedCalendars.isEmpty)
        #expect(b.calendars.keys.sorted() == ["icloud-cal"])
        #expect(b.events.keys.sorted() == ["synced-ev"])
    }

    // S1 audit #8: before B23 the grant was checked once, before the lookups, so a stop during them did not stop the save.
    @Test func asksAgainRightBeforeEachChangeSoAStopDuringALookupWritesNothing() {
        let b = FakeBackend()
        let a = CalendarAdapter(backend: b, zone: chicago)
        var revoked = false
        let allowed = { revoked ? "the calendar grant for task t1 was revoked" : nil }
        guard case let .ok(first?) = a.perform(.calendarAdd(calendar: "Caret Test", title: "Lunch", start: start, end: end, taskId: "t1"), allowed: allowed) else { Issue.record("add failed"); return }
        // The stop lands while the adapter looks for a duplicate: no save follows.
        b.duringRead = { revoked = true }
        #expect(a.perform(.calendarAdd(calendar: "Caret Test", title: "Coffee with Dana", start: start, end: end, taskId: "t1"), allowed: allowed) == .refused(.notAllowed, "the calendar grant for task t1 was revoked"))
        // And while it looks up the event to remove: no removal follows.
        revoked = false
        #expect(a.perform(.calendarRemove(id: first.id, taskId: "t1"), allowed: allowed) == .refused(.notAllowed, "the calendar grant for task t1 was revoked"))
        #expect(b.events[first.id] != nil)
        b.duringRead = nil
        // Creating a calendar is a change too, and so is deleting one.
        revoked = true
        #expect(a.perform(.calendarAdd(calendar: "Caret Other", title: "x", start: start, end: end, taskId: "t1"), allowed: allowed) == .refused(.notAllowed, "the calendar grant for task t1 was revoked"))
        #expect(a.perform(.calendarDispose(calendar: "Caret Test", taskId: "t1"), allowed: allowed) == .refused(.notAllowed, "the calendar grant for task t1 was revoked"))
        #expect(b.calls.filter { $0.hasPrefix("save") || $0.hasPrefix("create") || $0.hasPrefix("remove") || $0.hasPrefix("delete") } == ["create Caret Test on local-1", "save cal-1"])
    }

    // S1 audit #16: before B23 a read that failed answered "not there", which undo's last check counted as removed.
    @Test func aReadThatFailsIsAnErrorNeverAbsent() {
        let b = FakeBackend()
        let a = CalendarAdapter(backend: b, zone: chicago)
        guard case let .ok(added?) = a.perform(.calendarAdd(calendar: "Caret Test", title: "Lunch", start: start, end: end, taskId: "t1")) else { Issue.record("add failed"); return }
        b.readFails = true
        #expect(a.perform(.calendarGet(id: added.id)) == .refused(.axError, "cannot read the calendar: no full Calendar access"))
        #expect(a.perform(.calendarFind(calendar: "Caret Test", title: "Lunch", start: start, end: end)) == .refused(.axError, "cannot read the calendar: no full Calendar access"))
        #expect(a.perform(.calendarRemove(id: added.id, taskId: "t1")) == .refused(.axError, "cannot read the calendar: no full Calendar access"))
        // The failed reads forgot nothing: once the store reads again, the event is still the adapter's own.
        b.readFails = false
        #expect(a.perform(.calendarGet(id: added.id)) == .ok(added))
        // After a removal, the check that it is gone reads the store too: a failed read is an error there as well (B23 review).
        #expect(a.perform(.calendarRemove(id: added.id, taskId: "t1")) == .ok(nil))
        b.readFails = true
        #expect(a.perform(.calendarGet(id: added.id)) == .refused(.axError, "cannot read the calendar: no full Calendar access"))
        b.readFails = false
        #expect(a.perform(.calendarGet(id: added.id)) == .ok(nil))
        #expect(b.calls.filter { $0 == "event \(added.id)" }.count >= 3)
    }

    // CodeRabbit on PR #4: before B23 remove and dispose ignored their task.
    @Test func onlyTheTaskThatAddedAnEventRemovesItAndACalendarHoldingAnotherTasksEventStays() {
        let b = FakeBackend()
        let a = CalendarAdapter(backend: b, zone: chicago)
        guard case let .ok(added?) = a.perform(.calendarAdd(calendar: "Caret Test", title: "Lunch", start: start, end: end, taskId: "t1")) else { Issue.record("add failed"); return }
        #expect(a.perform(.calendarRemove(id: added.id, taskId: "t2")) == .refused(.notAllowed, "another task added this event; only that task removes it"))
        #expect(a.perform(.calendarDispose(calendar: "Caret Test", taskId: "t2")) == .refused(.notAllowed, "the calendar holds events other tasks added (t1); it is not deleted"))
        #expect(b.events[added.id] != nil && a.ownedCalendars == ["Caret Test"])
        #expect(a.perform(.calendarRemove(id: added.id, taskId: "t1")) == .ok(nil))
        #expect(a.perform(.calendarDispose(calendar: "Caret Test", taskId: "t2")) == .ok(nil))
        #expect(a.ownedCalendars.isEmpty)
    }

    @Test func refusesTimesItCannotRead() {
        let a = CalendarAdapter(backend: FakeBackend())
        #expect(a.perform(.calendarAdd(calendar: "Caret Test", title: "x", start: end, end: start, taskId: "t1")) == .refused(.changed, "start and end are not ISO 8601 times, or end is not after start"))
        #expect(a.perform(.walk(pid: 1, windowId: "1-1")) == .refused(.notAllowed, "not a calendar verb"))
    }
}
