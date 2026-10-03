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
    private var n = 0

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
    func events(calendarID: String, from: Date, to: Date) -> [BackendEvent] {
        calls.append("events \(calendarID)")
        return events.values.filter { $0.calendarID == calendarID && $0.start < to && $0.end > from }
    }
    func saveEvent(calendarID: String, title: String, start: Date, end: Date) throws -> String {
        calls.append("save \(calendarID)"); n += 1
        events["ev-\(n)"] = BackendEvent(id: "ev-\(n)", calendarID: calendarID, title: title, start: start, end: end)
        return "ev-\(n)"
    }
    func event(id: String) -> BackendEvent? { calls.append("event \(id)"); return events[id] }
    func removeEvent(id: String) throws { calls.append("remove \(id)"); events.removeValue(forKey: id) }
}

private func t(_ s: String) -> Date { CalendarTime.parse(s)! }
private let chicago = TimeZone(identifier: "America/Chicago")!
private let start = "2026-10-08T15:00:00-05:00", end = "2026-10-08T15:30:00-05:00"

@Suite struct CalendarAdapterTests {
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
        // The same event again is the one already there, not a second copy.
        guard case let .ok(again?) = a.perform(.calendarAdd(calendar: "Caret Test", title: "Coffee with Dana", start: start, end: end, taskId: "t2")),
              case let .ok(twice?) = a.perform(.calendarAdd(calendar: "Caret Test", title: "Coffee with Dana", start: start, end: end, taskId: "t3")) else { Issue.record("re-add failed"); return }
        #expect(again.id == twice.id && b.events.values.filter { $0.title == "Coffee with Dana" && $0.calendarID != "icloud-cal" }.count == 1)
        _ = a.perform(.calendarRemove(id: again.id, taskId: "t2"))
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
        #expect(a.perform(.calendarRemove(id: "synced-ev", taskId: "t1")) == .refused(.notAllowed, "the event is not one the reader added"))
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

    @Test func refusesTimesItCannotRead() {
        let a = CalendarAdapter(backend: FakeBackend())
        #expect(a.perform(.calendarAdd(calendar: "Caret Test", title: "x", start: end, end: start, taskId: "t1")) == .refused(.changed, "start and end are not ISO 8601 times, or end is not after start"))
        #expect(a.perform(.walk(pid: 1, windowId: "1-1")) == .refused(.notAllowed, "not a calendar verb"))
    }
}
